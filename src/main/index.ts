import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { defaultWorkspaceRoot, ensureWorkspace, resolveAppPaths } from './paths'
import { SettingsStore } from './settings'
import { BrainCore } from './core'
import { AgentManager } from './agent/manager'
import { IntegrationRegistry } from './integrations/registry'
import { Curator } from './curator/curator'
import { UsageTracker } from './usage/usage'
import { ToolWindowManager } from './toolWindows'
import { ShortcutManager } from './shortcuts'
import { ToolPreviewer } from './toolPreview'
import { registerToolScheme, serveToolScheme } from './toolProtocol'
import { Broadcaster } from './broadcast'
import { appearance, useAppearanceFrom } from './appearance'
import { openSessionIds, registerIpc, unregisterIpc } from './ipc'
import { createLogger, initLogger, onLogEntry } from './logger'
import { Scheduler } from './tasks/scheduler'
import { AccountServers } from './agent/accountServers'
import { configureToastIdentity, Notifier } from './notify'
import { trafficLightPosition } from '@shared/window-chrome'

const log = createLogger('main')

let window: BrowserWindow | null = null
let core: BrainCore | null = null
let agent: AgentManager | null = null
let curator: Curator | null = null
let integrations: IntegrationRegistry | null = null
let usage: UsageTracker | null = null
let toolWindows: ToolWindowManager | null = null
let shortcuts: ShortcutManager | null = null
let previewer: ToolPreviewer | null = null
let scheduler: Scheduler | null = null
let accountServers: AccountServers | null = null
let notifier: Notifier | null = null
let broadcaster: Broadcaster | null = null
let shuttingDown = false

/**
 * A reveal that arrived before any window could hear it.
 *
 * Collected once by the renderer's bootstrap and then cleared. Only ever set when there
 * was no audience for the broadcast; setting it alongside a successful broadcast would
 * replay a stale reveal on the next launch.
 */
let pendingReveal: string | null = null

export function takePendingReveal(): string | null {
  const value = pendingReveal
  pendingReveal = null
  return value
}

// A second instance would open the same SQLite index and the same vault watcher.
// quit() is asynchronous, so `whenReady` would still fire and bootstrap would run
// anyway — the flag is what actually keeps the second process out.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
}

// Must happen before the app is ready: the scheme code tools are served on has to
// be privileged for a frame to load it.
registerToolScheme()

app.on('second-instance', () => {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
})

/** The title strip the renderer draws, and the hole the native controls sit in. */
const HEADER_HEIGHT = 38

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: appearance().background,
    // Native window controls drawn over our own title area, so the graph can run
    // edge to edge without reimplementing minimise/maximise/close.
    titleBarStyle: 'hidden',
    // Windows and Linux only — Electron ignores it on macOS, where `hidden` already
    // leaves the traffic lights floating over the content.
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: appearance().symbol,
      height: HEADER_HEIGHT
    },
    trafficLightPosition: trafficLightPosition(HEADER_HEIGHT),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // Nothing in this app should navigate away or open a native window; links go
  // to the user's browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl && url.startsWith(rendererUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

async function bootstrap(): Promise<void> {
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  const settings = new SettingsStore(settingsFile, defaultWorkspaceRoot())
  const paths = resolveAppPaths(settings.get().workspacePath)

  ensureWorkspace(paths)
  initLogger(paths.logFile)
  log.info(`Second Brain ${app.getVersion()} starting`)
  log.info(`workspace: ${paths.root}`)

  // Before any window: Windows reads the identity when a window first appears, and
  // Electron writes its shortcut from it.
  configureToastIdentity()

  core = new BrainCore(paths, settings)

  // Before any window is created: every one of them asks what theme the app is in,
  // and asking the operating system instead was why a light-mode app opened dark
  // tool windows and took dark preview screenshots.
  useAppearanceFrom(() => settings.get().appearance.theme)

  // Before the window, so the first frame a tool opens has somewhere to load from.
  serveToolScheme(core)

  window = createWindow()

  // Every window, not just the main one: a tool in its own window needs the same
  // agent events, document changes and questions, and queueing covers the gap
  // before a freshly opened window is listening.
  broadcaster = new Broadcaster()
  core.setBroadcast((channel, payload) => broadcaster!.send(channel, payload))

  // Every line reaches an open log window as it is written, so the user can watch
  // a run happen rather than reading about it afterwards.
  onLogEntry((entry) => broadcaster?.send('logs:line', entry))

  integrations = new IntegrationRegistry(core)
  await integrations.start()

  usage = new UsageTracker(core.kv)
  // Reading usage runs the CLI, so it happens in the background and announces
  // itself rather than making a window wait for it.
  usage.onChanged = (snapshot) => broadcaster?.send('usage:changed', snapshot)

  previewer = new ToolPreviewer()

  agent = new AgentManager(core, integrations, usage)
  agent.previewer = previewer
  await agent.start(app.getPath('userData'))

  curator = new Curator(core, agent)

  toolWindows = new ToolWindowManager()

  // Written straight through rather than debounced: `resized` already fires once
  // the drag has ended, and a narrow UPDATE does not touch the tool's document.
  toolWindows.onSizeChanged = (toolId, size) => core?.tools.setWindowSize(toolId, size)

  shortcuts = new ShortcutManager((toolId) => {
    const tool = core?.tools.get(toolId)
    if (!tool || !core) return

    core.recordActivity({
      kind: 'tool.summoned',
      actor: 'user',
      title: `Opened ${tool.name} by shortcut`,
      detail: { id: tool.id, hotkey: tool.hotkey }
    })

    if (tool.openInWindow) {
      toolWindows?.open({
        toolId: tool.id,
        title: tool.name,
        alwaysOnTop: tool.alwaysOnTop,
        // Pressing the key mid-sentence should land the cursor in the input.
        focusInput: true,
        size: {
          width: tool.windowWidth,
          height: tool.windowHeight,
          maximized: tool.windowMaximized
        }
      })
      return
    }

    // Otherwise bring the app forward and open the tool in the main area.
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
    core.broadcast('tools:activate', { toolId: tool.id, focusInput: true })
  })

  // One reader for the account's connectors, shared: it caches, and the check-in and the
  // integrations panel should not each pay for their own health check of every server.
  accountServers = new AccountServers()

  scheduler = new Scheduler(core, agent, accountServers)
  scheduler.onChanged = () => core?.broadcast('tasks:changed')

  // Which chats a window is showing. Retiring one the renderer has open would leave it
  // pointing at a deleted row, and the next message typed would land somewhere else.
  scheduler.openSessions = () => openSessionIds()

  // A run left mid-flight by a crash or a kill would read as "still working" for ever;
  // nothing else would ever close it.
  const stale = core.taskRuns.closeStale()
  if (stale > 0) log.info(`closed ${stale} run(s) left open by the last shutdown`)

  // A task the agent just created or edited needs its next-run time recomputed, or it
  // keeps the one belonging to the schedule it no longer has.
  agent.onTaskChanged = (taskId) => scheduler?.reschedule(taskId)

  // Told about replies, proactive runs and questions so it can decide whether the
  // user needs to hear about them. It brings the app forward itself, because a toast
  // that raises a window but does not show what it was about is worse than none.
  notifier = new Notifier(core, agent, (sessionId, inboxId) => {
    if (inboxId) core?.inbox.markRead(inboxId)

    // macOS keeps the app alive with no windows, so a click can arrive when there is
    // nothing to reveal into. Recreating the window is the difference between the click
    // working and doing nothing at all.
    if (!window || window.isDestroyed()) window = createWindow()
    else {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }

    if (!sessionId) return

    // A freshly created window has not finished loading, so a broadcast now would be
    // dropped. It is held for the renderer to collect on bootstrap instead — and held
    // *only* in that case, because a pending reveal that outlives its delivery would
    // yank the user into an old chat the next time the app started.
    if (broadcaster && broadcaster.audience() > 0) core?.broadcast('chat:reveal', { sessionId })
    else pendingReveal = sessionId
  })
  notifier.start()

  registerIpc({
    core,
    agent,
    curator,
    integrations,
    usage,
    toolWindows,
    shortcuts,
    previewer,
    scheduler,
    takePendingReveal,
    getWindow: () => window
  })

  shortcuts.sync(core.tools.list())

  // A tool the agent just built with a shortcut should work immediately.
  agent.onShortcutsChanged = () => {
    if (core && shortcuts) shortcuts.sync(core.tools.list())
  }

  // Indexing reads every note, so it happens after the window exists — the user
  // sees the shell immediately and the graph fills in.
  core.start()
  curator.start()
  // After core.start(): the first tick must not land while the index is still being
  // built, and seeding the check-in writes a row.
  scheduler.start()

  if (!agent.available) {
    log.warn('claude CLI not found; the agent will be unavailable until it is installed')
  }
}

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log.info('shutting down')

  try {
    unregisterIpc()
    // Global bindings outlive the window, so they must be released explicitly.
    shortcuts?.unregisterAll()
    toolWindows?.closeAll()
    curator?.stop()
    scheduler?.stop()
    notifier?.stop()
    agent?.stop()
    integrations?.stop()
    core?.shutdown()
  } catch (err) {
    log.error('error during shutdown', err)
  }
}

void app.whenReady().then(async () => {
  if (!isPrimaryInstance) return

  try {
    await bootstrap()
  } catch (err) {
    log.error('failed to start', err)
    const { dialog } = await import('electron')
    dialog.showErrorBox(
      'Second Brain could not start',
      err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err)
    )
    app.quit()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow()
  })
})

app.on('window-all-closed', () => {
  // Deliberately no teardown here.
  //
  // On macOS closing the last window does not quit the app — the Dock icon is meant
  // to bring it back, and `activate` below does exactly that. Shutting down from
  // here unregistered every IPC handler, stopped the agent and closed the database
  // while the app stayed running, so the window that came back was a shell talking
  // to nothing: no graph, no chat, no way out but Force Quit.
  //
  // Everywhere else, the last window closing does mean quit, and `before-quit` is
  // what tears down — so nothing is leaked by leaving it to that.
  if (process.platform === 'darwin') return
  app.quit()
})

app.on('before-quit', shutdown)

process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err)
})

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason)
})

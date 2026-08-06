import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { SavedTool } from '@shared/types'
import type { ApiChannel, ApiMap, ApiPayload, ApiResult } from '@shared/ipc'
import { API_CHANNELS } from '@shared/ipc'
import type { BrainCore } from './core'
import type { AgentManager } from './agent/manager'
import type { Curator } from './curator/curator'
import type { IntegrationRegistry } from './integrations/registry'
import type { UsageTracker } from './usage/usage'
import type { ToolWindowManager } from './toolWindows'
import { StaleToolWriteError } from './db/tools'
import type { ShortcutManager } from './shortcuts'
import type { ToolPreviewer } from './toolPreview'
import type { Scheduler } from './tasks/scheduler'
import { formatHotkey, normaliseHotkey } from '@shared/hotkey'
import { interpolate } from '@shared/bindings'
import { claudeAuthStatus, claudeVersion, resolveClaudeBinary, runClaude } from './agent/claude'
import { recordToolError } from './toolErrors'
import { clearLogTail, createLogger, logTail } from './logger'

const log = createLogger('ipc')

/**
 * `senderId` is the calling web contents. Tool windows share this channel table
 * with the main window, so anything that acts on "the window that asked" needs to
 * know which one that was.
 */
type Handlers = {
  [K in ApiChannel]: (payload: ApiPayload<K>, senderId: number) => ApiResult<K> | Promise<ApiResult<K>>
}

export interface IpcContext {
  core: BrainCore
  agent: AgentManager
  curator: Curator
  integrations: IntegrationRegistry
  usage: UsageTracker
  toolWindows: ToolWindowManager
  shortcuts: ShortcutManager
  previewer: ToolPreviewer
  scheduler: Scheduler
  /**
   * A reveal that arrived before any window could hear it, collected once.
   *
   * Passed in rather than imported: index.ts already imports registerIpc from here, so
   * reaching back the other way would be a require cycle in the CJS main bundle.
   */
  takePendingReveal: () => string | null
  takePendingToolReveal: () => string | null
  getWindow: () => BrowserWindow | null
}

/**
 * Chats a window has asked to open since launch.
 *
 * The main process has no other way to know what is on screen, and it needs to: the
 * scheduler retires old run chats, and deleting one the renderer is displaying leaves
 * it pointing at a deleted row — after which the next message the user types silently
 * lands in a different conversation. Bounded, because this only has to cover "recently",
 * and every entry is a string the user could reach again anyway.
 */
const OPENED_LIMIT = 24
const recentlyOpened: string[] = []

function rememberOpened(sessionId: string): void {
  const at = recentlyOpened.indexOf(sessionId)
  if (at >= 0) recentlyOpened.splice(at, 1)
  recentlyOpened.unshift(sessionId)
  if (recentlyOpened.length > OPENED_LIMIT) recentlyOpened.length = OPENED_LIMIT
}

/** Session ids a window has opened, newest first. */
export function openSessionIds(): string[] {
  return [...recentlyOpened]
}

export function registerIpc(ctx: IpcContext): void {
  const { core, agent, curator, integrations, scheduler } = ctx

  /**
   * A tool's own conversation, created on first use.
   *
   * Archived so it stays out of the main conversation list — it belongs to the
   * tool, not to the user's chat history.
   */
  const windowSizeOf = (tool: SavedTool): {
    width: number | null
    height: number | null
    maximized: boolean
  } => ({
    width: tool.windowWidth,
    height: tool.windowHeight,
    maximized: tool.windowMaximized
  })

  const newToolSession = (tool: SavedTool): string => {
    const stamp = new Date().toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
    const session = core.chat.createSession(`${tool.name} — ${stamp}`)
    core.chat.archiveSession(session.id, true)
    core.tools.setSession(tool.id, session.id)
    return session.id
  }

  /**
   * The chat a tool's *next* turn runs in — a fresh one, every time.
   *
   * One chat per tool held one Claude session id, and `send` resumes it, so run N replayed
   * runs 1..N-1: the context grew without limit and every press of a button cost more than
   * the last. The same fix the scheduler needed, for the same reason. A new chat has no
   * session id to resume, so the process starts clean.
   *
   * The tool still remembers its latest one, which is what a notification click and a
   * reopened tool window need in order to find the run that is going on now.
   */
  const runSession = (tool: SavedTool): string => newToolSession(tool)

  /** The chat a tool is *currently* attached to, without starting another. */
  const currentToolSession = (tool: SavedTool): string =>
    core.tools.ensureSession(tool.id, () => newToolSession(tool))

  // Probing the CLI spawns a process, so the result is cached for the session —
  // and awaited rather than run synchronously, because two CLI starts on the main
  // thread froze the whole app on the first request after launch.
  let cachedStatus: ApiResult<'agent:status'> | null = null
  let statusInFlight: Promise<ApiResult<'agent:status'>> | null = null

  const agentStatus = async (): Promise<ApiResult<'agent:status'>> => {
    if (cachedStatus) return { ...cachedStatus, model: core.settings.model }
    if (statusInFlight) return statusInFlight

    statusInFlight = readAgentStatus().finally(() => {
      statusInFlight = null
    })
    return statusInFlight
  }

  const readAgentStatus = async (): Promise<ApiResult<'agent:status'>> => {
    const binaryPath = resolveClaudeBinary()
    const [auth, version] = binaryPath
      ? await Promise.all([claudeAuthStatus(binaryPath), claudeVersion(binaryPath)])
      : [null, null]

    cachedStatus = {
      available: binaryPath !== null,
      binaryPath,
      version,
      model: core.settings.model,
      auth: auth
        ? {
            ...auth,
            // Anything other than an API key means usage comes out of the
            // signed-in plan rather than metered credits.
            onSubscription: auth.loggedIn && auth.authMethod !== 'apiKey'
          }
        : null
    }
    return cachedStatus
  }

  const budgetStatus = (): ApiResult<'agent:budget'> => {
    const budget = core.settings.budget
    const active = agent.capsActive()
    const spentToday = agent.spendToday()

    return {
      enabled: active,
      onSubscription: agent.onSubscription(),
      spentToday,
      dailyLimitUsd: budget.dailyLimitUsd,
      perTurnLimitUsd: budget.perTurnLimitUsd,
      remaining: agent.remainingToday(),
      blocked: active && spentToday >= budget.dailyLimitUsd
    }
  }

  // The account's own MCP connectors. Parsed from `claude mcp list` because the
  // CLI has no structured output for it, and cached because each call
  // health-checks every server.
  let cachedServers: { at: number; servers: ApiResult<'integrations:accountServers'> } | null = null

  let serversInFlight: Promise<ApiResult<'integrations:accountServers'>> | null = null

  const accountServers = async (): Promise<ApiResult<'integrations:accountServers'>> => {
    if (cachedServers && Date.now() - cachedServers.at < 120_000) return cachedServers.servers
    if (serversInFlight) return serversInFlight

    serversInFlight = readAccountServers().finally(() => {
      serversInFlight = null
    })
    return serversInFlight
  }

  const readAccountServers = async (): Promise<ApiResult<'integrations:accountServers'>> => {
    const binary = resolveClaudeBinary()
    if (!binary) return []

    // Health-checks every server, so it is slow — and it used to be slow on the
    // main thread, which meant opening the integrations panel froze the app.
    const { stdout: output } = await runClaude(binary, ['mcp', 'list'], { timeoutMs: 45_000 })

    const servers: ApiResult<'integrations:accountServers'> = []
    for (const line of output.split(/\r?\n/)) {
      // e.g. "claude.ai Slack: https://mcp.slack.com/mcp - ✓ Connected"
      const match = line.match(/^(.+?):\s+(\S.*?)\s+-\s+(.+)$/)
      if (!match) continue

      const [, name, target, rawStatus] = match
      const status = /connected/i.test(rawStatus)
        ? 'connected'
        : /auth/i.test(rawStatus)
          ? 'needs-auth'
          : /pending|approval/i.test(rawStatus)
            ? 'pending'
            : /fail|error/i.test(rawStatus)
              ? 'failed'
              : 'unknown'

      servers.push({ name: name.trim(), target: target.trim(), status })
    }

    cachedServers = { at: Date.now(), servers }
    return servers
  }

  const handlers: Handlers = {
    /* ------------------------------------------------------------- system */

    'agent:turn': ({ sessionId }) => agent.turnState(sessionId),
    'agent:budget': () => budgetStatus(),

    'usage:get': () => ctx.usage.snapshot(),

    /* ---------------------------------------------------- scheduled tasks */

    'tasks:list': () => core.tasks.list(),

    'tasks:save': ({ id, name, prompt, schedule, enabled, capability }) => {
      const task = core.tasks.save({
        ...(id ? { id } : {}),
        name: name.trim() || 'Untitled task',
        prompt,
        schedule,
        ...(enabled === undefined ? {} : { enabled }),
        ...(capability ? { capability } : {}),
        createdBy: 'user'
      })
      // Saving may have changed when it is next due, so the arming is redone rather
      // than left to the old next_run_at — a task edited from hourly to daily would
      // otherwise still fire within the hour.
      scheduler.reschedule(task.id)
      core.broadcast('tasks:changed')
      return core.tasks.get(task.id)!
    },

    'tasks:setEnabled': ({ id, enabled }) => {
      const task = core.tasks.get(id)
      if (!task) return null
      core.tasks.setEnabled(id, enabled, null)
      scheduler.reschedule(id)
      core.broadcast('tasks:changed')
      return core.tasks.get(id) ?? null
    },

    'tasks:remove': ({ id }) => {
      const task = core.tasks.get(id)
      // The check-in is seeded by the scheduler, so deleting it would only bring it
      // back on the next launch. Disabling is the honest way to turn it off.
      if (task?.kind === 'heartbeat') {
        core.tasks.setEnabled(id, false, null)
      } else {
        // The run history goes with the task. Leaving orphaned rows behind would keep
        // a deleted task's outcomes queryable for ever with nothing to attach them to.
        core.taskRuns.deleteForTask(id)
        core.tasks.delete(id)
      }
      core.broadcast('tasks:changed')
    },

    'tasks:runNow': async ({ id }) => {
      const result = await scheduler.runNow(id)
      core.broadcast('tasks:changed')
      return result
    },

    'tasks:openSession': ({ id }) => {
      const task = core.tasks.get(id)
      // Checked rather than trusted: a run chat can be deleted from the history list,
      // and `scheduled_tasks.session_id` is not cleared when that happens — returning a
      // dead id makes the button do nothing with no explanation.
      if (!task?.sessionId || !core.chat.getSession(task.sessionId)) return { sessionId: null }
      // Deliberately NOT un-archived. These chats are archived so the conversation list
      // stays the user's own conversations; with a chat per run, un-archiving on open
      // would fill that list with scheduled runs. Opening by id needs no un-archiving.
      return { sessionId: task.sessionId }
    },

    'tasks:runs': ({ id, limit }) => core.taskRuns.forTask(id, limit ?? 20),

    /* ------------------------------------------------------------- the inbox */

    'inbox:list': () => ({ entries: core.inbox.list(), unread: core.inbox.unreadCount() }),

    'inbox:read': ({ id }) => {
      core.inbox.markRead(id)
      core.broadcast('inbox:changed')
      return { unread: core.inbox.unreadCount() }
    },

    /* -------------------------------------------------------- saved tools */

    'tools:list': () => core.tools.list(),
    'tools:setPinned': ({ id, pinned }) => {
      core.tools.setPinned(id, pinned)
      core.broadcast('tools:changed')
    },
    'tools:remove': ({ id }) => {
      core.tools.remove(id)
      core.broadcast('tools:changed')
    },
    'tools:reorder': ({ ids }) => {
      core.tools.reorder(ids)
      core.broadcast('tools:changed')
    },
    'tools:render': ({ id, values }) => {
      const tool = core.tools.get(id)
      if (!tool) throw new Error('that tool no longer exists')
      core.tools.noteRun(id)
      return { prompt: core.tools.render(tool, values) }
    },

    'tools:get': ({ id }) => core.tools.get(id) ?? null,

    'tools:writeState': ({ id, state, rev }) => {
      try {
        const tool = core.tools.writeState(id, state, rev)
        core.broadcast('tools:stateChanged', { toolId: id, rev: tool.rev, note: null })
        return { tool, conflict: false }
      } catch (err) {
        if (err instanceof StaleToolWriteError) {
          // The agent wrote first. Hand back what is actually stored so the UI
          // can reconcile instead of fighting it.
          return { tool: core.tools.get(id)!, conflict: true }
        }
        throw err
      }
    },

    'tools:session': ({ id }) => {
      const tool = core.tools.get(id)
      if (!tool) throw new Error('that tool no longer exists')
      return { sessionId: currentToolSession(tool) }
    },

    'tools:ask': async ({ id, text }) => {
      const tool = core.tools.get(id)
      if (!tool) throw new Error('that tool no longer exists')

      const sessionId = runSession(tool)

      const context = [
        `You are working inside the user's "${tool.name}" tool (id ${tool.id}, kind ${tool.kind}).`,
        tool.instructions ? `Its standing instructions: ${tool.instructions}` : '',
        '',
        'To change what it shows, call get_tool_state then update_tool_state with the',
        'rev you read. The user edits the same document by hand at the same time, so',
        'always re-read before writing and never drop entries you did not mean to touch.',
        '',
        `Current document (rev ${tool.rev}):`,
        JSON.stringify(tool.state)
      ]
        .filter(Boolean)
        .join('\n')

      await agent.send(text, {
        sessionId,
        capability: 'curate',
        context,
        ...(tool.model ? { model: tool.model } : {}),
        ...(tool.effort ? { effort: tool.effort } : {})
      })
      return { sessionId }
    },

    'tools:runAction': async ({ id, actionId, inputs }, senderId) => {
      const tool = core.tools.get(id)
      if (!tool) throw new Error('that tool no longer exists')

      const action = tool.actions.find((candidate) => candidate.id === actionId)
      if (!action) throw new Error('that button no longer exists')

      // Fill the template. Whatever the caller passed wins — a code tool sends its
      // own values with brain.run, and a workbench sends its fields. Anything left
      // resolves against the document, which is how a canvas binds.
      const defaults: Record<string, unknown> = {}
      for (const field of tool.fields) defaults[field.name] = field.default ?? ''

      const prompt = interpolate(action.prompt, {
        ...defaults,
        ...(tool.state as Record<string, unknown>),
        ...inputs
      })

      const sessionId = runSession(tool)

      const context = [
        `You are running the "${action.label}" button inside the user's "${tool.name}" tool (id ${tool.id}, kind ${tool.kind}).`,
        tool.instructions ? `Standing instructions: ${tool.instructions}` : '',
        '',
        action.target === 'output'
          ? [
              'Answer with the result itself and nothing else — no preamble, no',
              'explanation, no offer of alternatives. What you reply is placed',
              'directly into the tool as the output the user reads, so it must be',
              'the finished thing. Do not call update_tool_state.'
            ].join(' ')
          : [
              'Change the tool to reflect this. Call get_tool_state, then',
              'update_tool_state with the rev you read. Keep the ids of anything',
              'that already existed. Then reply with one short line saying what',
              'you changed.'
            ].join(' '),
        '',
        `Current document (rev ${tool.rev}):`,
        JSON.stringify(tool.state)
      ]
        .filter(Boolean)
        .join('\n')

      core.tools.noteRun(id)
      // Logged because this is the path that used to fail silently in a tool
      // window: the run started, and nothing ever came back to the window.
      log.info(
        `tool run "${tool.name}" · ${action.label} → session ${sessionId.slice(-6)}, model ${tool.model ?? core.settings.model}, effort ${tool.effort ?? core.settings.effort}, from window ${senderId}`
      )
      await agent.send(prompt, {
        sessionId,
        capability: 'curate',
        context,
        // A tool can be pinned to a faster model or a bigger thinking budget than
        // the app's, because a button press and a weekly review are not the same job.
        ...(tool.model ? { model: tool.model } : {}),
        ...(tool.effort ? { effort: tool.effort } : {}),
        toolAction: {
          toolId: id,
          actionId,
          target: action.target,
          label: action.label,
          writeTo: action.writeTo
        }
      })

      return { sessionId }
    },

    'app:bootstrap': async () => ({
      budget: budgetStatus(),
      // Collected here, so a notification clicked while the app was closed still lands
      // on the right chat once the renderer is listening.
      pendingReveal: ctx.takePendingReveal(),
      pendingToolReveal: ctx.takePendingToolReveal(),
      workspace: {
        root: core.paths.root,
        vaultDir: core.paths.vaultDir,
        integrationsDir: core.paths.integrationsDir,
        dbPath: core.paths.dbPath,
        trashDir: core.paths.trashDir
      },
      settings: core.settings,
      stats: core.graph.stats(),
      agent: await agentStatus(),
      session: core.chat.currentSession(),
      secretsEncrypted: integrations.secretsAreEncrypted,
      webhookBaseUrl: integrations.webhookBaseUrl,
      appVersion: app.getVersion()
    }),

    'app:settings:get': () => core.settings,
    'app:settings:update': (patch) => core.updateSettings(patch),

    'app:openWorkspace': () => {
      void shell.openPath(core.paths.root)
    },

    'app:chooseWorkspace': async () => {
      const window = ctx.getWindow()
      const result = window
        ? await dialog.showOpenDialog(window, {
            title: 'Choose a workspace folder',
            defaultPath: core.paths.root,
            properties: ['openDirectory', 'createDirectory']
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })

      if (result.canceled || result.filePaths.length === 0) return null
      // Applied on next launch: swapping the vault under a live index would mean
      // tearing down the database, watcher and every open agent process.
      core.updateSettings({ workspacePath: result.filePaths[0] })
      return result.filePaths[0]
    },

    'app:reindex': () => core.reindex(),

    'app:userActivity': () => {
      curator.noteUserActivity()
    },

    'app:openExternal': ({ url }) => {
      // Only ever open real web links; never a local path or a custom scheme.
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('only http and https links can be opened')
      }
      void shell.openExternal(url)
    },

    /* -------------------------------------------------------- graph, notes */

    'graph:get': () => core.snapshot(),
    'graph:stats': () => core.graph.stats(),
    'graph:savePositions': ({ positions }) => {
      core.nodes.setPositions(positions)
    },
    'graph:neighborhood': ({ id, depth }) => core.graph.neighborhood(id, depth ?? 1),

    'node:get': ({ id }) => {
      const node = core.nodes.resolve(id)
      if (node) core.nodes.touch(node.id)
      return node ?? null
    },
    'node:edges': ({ id }) => core.edges.listFor(id),
    'node:search': ({ query, limit, includeVirtual }) =>
      core.search(query, { limit, includeVirtual }),
    'node:create': (input) => core.createNote({ ...input, actor: 'user' }),
    'node:update': ({ ref, ...patch }) => core.updateNote(ref, { ...patch, actor: 'user' }),
    'node:trash': ({ ref }) => core.trashNote(ref, 'user'),
    'node:setPinned': ({ id, pinned }) => {
      core.nodes.setPinned(id, pinned)
      core.markGraphDirty('pin')
    },
    'node:link': ({ from, to, kind, label }) =>
      core.linkNotes(from, to, kind ?? 'link', label ?? null, 'user'),
    'node:unlink': ({ from, to, kind }) => core.unlinkNotes(from, to, kind, 'user'),

    'node:reveal': ({ id }) => {
      const node = core.nodes.resolve(id)
      if (!node?.path) throw new Error('that node has no file on disk')
      shell.showItemInFolder(join(core.paths.vaultDir, node.path))
    },

    'node:recent': ({ limit }) => core.nodes.listRecent(limit ?? 20),

    /* ------------------------------------------------ activity, suggestions */

    'activity:list': ({ sinceHours, kinds, limit }) =>
      core.activity.list({
        since: sinceHours ? Date.now() - sinceHours * 3600_000 : undefined,
        kinds,
        limit: limit ?? 100
      }),
    'activity:daily': ({ days }) => core.activity.dailyCounts(days ?? 30),

    'suggestions:list': ({ status }) => core.suggestions.list(status ?? 'pending'),
    'suggestions:apply': ({ id }) => curator.applySuggestion(id),
    'suggestions:dismiss': ({ id }) => {
      curator.dismissSuggestion(id)
    },
    'curator:run': () => curator.runPass(true),

    /* --------------------------------------------------------------- chat */

    'chat:sessions': () => core.chat.listSessions(),
    'chat:session': ({ id }) => {
      // Remembered so the scheduler never retires a chat a window is showing.
      rememberOpened(id)
      // Opening a chat is reading it, however the user got here — the history list, the
      // Scheduled tab, a notification. Without this the unread badge keeps insisting
      // there is something to see after they have seen it.
      if (core.inbox.markSessionRead(id) > 0) core.broadcast('inbox:changed')
      return core.chat.getSession(id) ?? null
    },
    'chat:createSession': () => core.chat.createSession(),
    'chat:renameSession': ({ id, title }) => {
      core.chat.renameSession(id, title)
    },
    'chat:deleteSession': ({ id }) => {
      agent.interrupt(id)
      core.chat.deleteSession(id)
    },
    'chat:messages': ({ sessionId }) => core.chat.listMessages(sessionId),
    'chat:genui': ({ id }) => core.chat.getGenUi(id)?.spec ?? null,
    'chat:send': ({ text, ...options }) => agent.send(text, options),
    'chat:interrupt': ({ sessionId }) => {
      agent.interrupt(sessionId)
    },
    'chat:setCapability': ({ sessionId, capability }) => {
      agent.setCapability(sessionId, capability)
    },
    'chat:capability': ({ sessionId }) => agent.capabilityOf(sessionId),
    'agent:status': () => agentStatus(),

    /* --------------------------------------------- tool shortcuts, windows */

    'tools:setHotkey': ({ id, hotkey }) => {
      const tool = core.tools.get(id)
      if (!tool) return { ok: false, message: 'that tool no longer exists', tool: null }

      if (hotkey === null || hotkey.trim() === '') {
        core.tools.setHotkey(id, null)
        ctx.shortcuts.sync(core.tools.list())
        core.broadcast('tools:changed')
        return { ok: true, message: 'Shortcut cleared.', tool: core.tools.get(id)! }
      }

      const parsed = normaliseHotkey(hotkey)
      if (!parsed.ok || !parsed.accelerator) {
        return { ok: false, message: parsed.error ?? 'that is not a valid shortcut', tool }
      }

      const owner = core.tools.hotkeyOwner(parsed.accelerator, id)
      if (owner) {
        return {
          ok: false,
          message: `"${owner.name}" already uses ${formatHotkey(parsed.accelerator, process.platform)}.`,
          tool
        }
      }

      core.tools.setHotkey(id, parsed.accelerator)
      const states = ctx.shortcuts.sync(core.tools.list())
      core.broadcast('tools:changed')

      const state = states.find((entry) => entry.toolId === id)
      return {
        ok: true,
        message: state?.registered
          ? `${formatHotkey(parsed.accelerator, process.platform)} now opens ${tool.name}.`
          : `${formatHotkey(parsed.accelerator, process.platform)} is saved, but another application is holding it — pick a different combination.`,
        tool: core.tools.get(id)!
      }
    },

    'tools:setWindowPrefs': ({ id, openInWindow, alwaysOnTop }) => {
      core.tools.setWindowPrefs(id, { openInWindow, alwaysOnTop })
      core.broadcast('tools:changed')
      return core.tools.get(id) ?? null
    },

    // No need to restart anything: the next turn asks for these, and the agent
    // respawns the tool's process when they differ from what it was spawned with.
    'tools:setModelPrefs': ({ id, model, effort }) => {
      core.tools.setModelPrefs(id, { model, effort })
      core.broadcast('tools:changed')
      return core.tools.get(id) ?? null
    },

    'tools:shortcutStates': () => ctx.shortcuts.list(),

    'tools:reportError': ({ id, message, stack, where }) => {
      recordToolError(id, { message, stack, where, at: Date.now() })
      const tool = core.tools.get(id)
      log.warn(
        `tool code raised in "${tool?.name ?? id}": ${message}${where ? ` (${where})` : ''}`
      )
    },

    /* --------------------------------------------------------- diagnostics */

    'logs:tail': ({ limit }) => logTail(limit),
    'logs:clear': () => clearLogTail(),
    'logs:openWindow': () => ctx.toolWindows.openLog(),
    'logs:reveal': () => {
      void shell.showItemInFolder(core.paths.logFile)
    },

    /* -------------------------------------------------------- integrations */

    'integrations:list': () => integrations.listRecords(),
    'integrations:tools': () => integrations.listTools(),
    'integrations:presets': () => integrations.availablePresets(),
    'integrations:installPreset': ({ id }) => integrations.installPreset(id),
    'integrations:setEnabled': ({ id, enabled }) => integrations.setEnabled(id, enabled),
    'integrations:remove': ({ id }) => {
      integrations.remove(id)
    },
    'integrations:test': ({ id }) => integrations.test(id),
    'integrations:authorize': ({ id }) => integrations.authorize(id),
    'integrations:setSecret': ({ ref, value }) => {
      integrations.setSecret(ref, value)
    },
    'integrations:secretRefs': () => integrations.listSecretRefs(),
    'integrations:call': ({ id, tool, args }) => integrations.callTool(id, tool, args),

    'integrations:accountServers': () => accountServers(),

    'chat:answerQuestion': ({ id, answer }) => {
      agent.questions.answer(id, answer)
    },

    'window:openTool': (payload) => {
      // The size is read here rather than passed by the renderer: it is the tool's
      // own record, and the caller should not have to know about it.
      const tool = payload.toolId ? core.tools.get(payload.toolId) : undefined
      ctx.toolWindows.open({ ...payload, size: tool ? windowSizeOf(tool) : undefined })
    },
    'window:toggleAlwaysOnTop': (_payload, senderId) => ctx.toolWindows.toggleAlwaysOnTop(senderId),
    'window:isAlwaysOnTop': (_payload, senderId) => ctx.toolWindows.isAlwaysOnTop(senderId),
    'window:previewReady': (_payload, senderId) => {
      ctx.previewer.markReady(senderId)
    }
  }

  for (const channel of API_CHANNELS) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      try {
        const handler = handlers[channel] as (p: unknown, senderId: number) => unknown
        return await handler(payload, event.sender.id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn(`${channel} failed: ${message}`)
        // Rethrow so the renderer's promise rejects with a readable message
        // rather than Electron's default serialisation noise.
        throw new Error(message)
      }
    })
  }

  log.info(`registered ${API_CHANNELS.length} IPC channels`)
}

export function unregisterIpc(): void {
  for (const channel of API_CHANNELS) ipcMain.removeHandler(channel)
}

/** Type guard so a missing handler is caught at build time. */
export type { Handlers as IpcHandlers, ApiMap }

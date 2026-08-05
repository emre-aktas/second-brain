import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { MIN_TOOL_WINDOW } from './db/tools'
import { appearance } from './appearance'
import { createLogger } from './logger'
import { trafficLightPosition } from '@shared/window-chrome'

const log = createLogger('tool-windows')

/** The title strip a tool window draws, and the hole the native controls sit in. */
const TOOL_HEADER_HEIGHT = 36

export interface ToolWindowSize {
  width: number
  height: number
  maximized: boolean
}

/**
 * Standalone windows for generated interfaces.
 *
 * A kanban board or a dashboard the agent built is something to keep open beside
 * other work, not something to scroll back to in a transcript. Each one is a real
 * OS window that can be resized freely and pinned above everything else.
 *
 * They load the same renderer bundle with a hash route, so a tool window is just
 * the app rendering one spec — no second frontend to maintain.
 */
const LOG_KEY = 'log'

/** Long enough that a drag writes once, short enough to survive a hard exit. */
const RESIZE_SETTLE_MS = 400

export class ToolWindowManager {
  private windows = new Map<string, BrowserWindow>()

  /**
   * Called whenever a tool's window settles at a new size.
   *
   * A callback rather than a store reference so this class stays about windows;
   * the bootstrap wires it to the tool store.
   */
  onSizeChanged: ((toolId: string, size: ToolWindowSize) => void) | null = null

  /**
   * Persist the size once the user has stopped adjusting it.
   *
   * Three listeners, on purpose. `resized` is the clean signal but it does not
   * fire for every kind of resize — a programmatic or OS-driven one (a snap
   * layout, a display change) can skip it entirely. So `resize` is debounced as
   * well, which covers those without writing on every frame of a drag. And `close`
   * catches a window resized and shut immediately, which could otherwise beat the
   * debounce.
   */
  private rememberSize(win: BrowserWindow, toolId: string): void {
    let timer: NodeJS.Timeout | null = null

    const remember = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (win.isDestroyed() || win.isMinimized()) return
      // getNormalBounds is the size a maximised window would return to, so the
      // flag and the size stay independent.
      const bounds = win.getNormalBounds()
      this.onSizeChanged?.(toolId, {
        width: bounds.width,
        height: bounds.height,
        maximized: win.isMaximized()
      })
    }

    const rememberSoon = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(remember, RESIZE_SETTLE_MS)
      timer.unref?.()
    }

    win.on('resize', rememberSoon)
    win.on('resized', remember)
    win.on('maximize', remember)
    win.on('unmaximize', remember)
    win.on('close', remember)
    win.on('closed', () => {
      if (timer) clearTimeout(timer)
    })
  }

  open(input: {
    specId?: string
    toolId?: string
    title: string
    alwaysOnTop?: boolean
    /** Put the cursor in the tool's first input, for shortcut-summoned opens. */
    focusInput?: boolean
    /** How the user left it last time. Falls back to a sensible default. */
    size?: { width: number | null; height: number | null; maximized: boolean }
  }): void {
    const key = input.toolId ? `tool:${input.toolId}` : `spec:${input.specId}`
    const existing = this.windows.get(key)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      if (input.focusInput) existing.webContents.send('tools:focusInput', {})
      return
    }

    // A remembered size still has to fit the display it opens on — a window sized
    // on a 4K monitor must not open taller than a laptop screen.
    const workArea = screen.getPrimaryDisplay().workAreaSize
    const width = Math.min(input.size?.width ?? 1040, workArea.width)
    const height = Math.min(input.size?.height ?? 760, workArea.height)

    const win = new BrowserWindow({
      width: Math.max(MIN_TOOL_WINDOW.width, width),
      height: Math.max(MIN_TOOL_WINDOW.height, height),
      minWidth: MIN_TOOL_WINDOW.width,
      minHeight: MIN_TOOL_WINDOW.height,
      title: input.title,
      show: false,
      backgroundColor: appearance().background,
      alwaysOnTop: input.alwaysOnTop ?? false,
      titleBarStyle: 'hidden',
      // Windows and Linux only; macOS uses trafficLightPosition below.
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: appearance().symbol,
        height: TOOL_HEADER_HEIGHT
      },
      trafficLightPosition: trafficLightPosition(TOOL_HEADER_HEIGHT),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    if (input.size?.maximized) win.maximize()

    win.on('ready-to-show', () => win.show())
    win.on('closed', () => this.windows.delete(key))

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    if (input.toolId) this.rememberSize(win, input.toolId)

    const route = input.toolId
      ? `#/tool/${encodeURIComponent(input.toolId)}${input.focusInput ? '?focus=1' : ''}`
      : `#/spec/${encodeURIComponent(input.specId ?? '')}`
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']

    if (rendererUrl) {
      void win.loadURL(`${rendererUrl}${route}`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route.slice(1) })
    }

    this.windows.set(key, win)
    log.info(`opened tool window ${key}`)
  }

  /**
   * The log window.
   *
   * Its own window rather than a panel, because the whole point is to watch it
   * while working in something else — including while a tool in a third window
   * runs. Only one, and re-opening focuses it.
   */
  openLog(): void {
    const existing = this.windows.get(LOG_KEY)
    if (existing && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return
    }

    const win = new BrowserWindow({
      width: 900,
      height: 620,
      minWidth: 420,
      minHeight: 240,
      title: 'Log',
      show: false,
      backgroundColor: appearance().background,
      titleBarStyle: 'hidden',
      // Windows and Linux only; macOS uses trafficLightPosition below.
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: appearance().symbol,
        height: TOOL_HEADER_HEIGHT
      },
      trafficLightPosition: trafficLightPosition(TOOL_HEADER_HEIGHT),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    win.on('ready-to-show', () => win.show())
    win.on('closed', () => this.windows.delete(LOG_KEY))

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) void win.loadURL(`${rendererUrl}#/logs`)
    else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/logs' })

    this.windows.set(LOG_KEY, win)
    log.info('opened the log window')
  }

  /** Toggle pinning for the window that asked, identified by its web contents. */
  toggleAlwaysOnTop(webContentsId: number): boolean {
    for (const win of this.windows.values()) {
      if (win.isDestroyed() || win.webContents.id !== webContentsId) continue
      const next = !win.isAlwaysOnTop()
      win.setAlwaysOnTop(next)
      return next
    }
    return false
  }

  isAlwaysOnTop(webContentsId: number): boolean {
    for (const win of this.windows.values()) {
      if (win.isDestroyed() || win.webContents.id !== webContentsId) continue
      return win.isAlwaysOnTop()
    }
    return false
  }

  closeAll(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.close()
    }
    this.windows.clear()
  }
}

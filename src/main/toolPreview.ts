import { BrowserWindow } from 'electron'
import { appearance } from './appearance'
import { join } from 'node:path'
import { createLogger } from './logger'

const log = createLogger('tool-preview')

const READY_TIMEOUT_MS = 8000

/** Far enough out that no display arrangement can put it on screen. */
const OFFSCREEN = -32000

/**
 * Renders a tool offscreen and hands back a screenshot.
 *
 * Without this the agent writes a manifest and never sees the result — it cannot
 * tell that a column is too narrow, that a label wraps badly, or that four
 * buttons crowd the row. A hidden window renders the real component tree at a
 * known size, so what the agent looks at is what the user will see.
 *
 * A separate window rather than reusing an open one on purpose: the preview must
 * not depend on, or disturb, whatever the user is doing.
 *
 * It is parked outside every display and shown, rather than hidden. A hidden
 * window does not composite cross-origin subframes, and a code tool's interface
 * *is* such a frame — hiding it produced a screenshot of the app's chrome around
 * an empty rectangle, which is worse than no screenshot at all.
 */
export class ToolPreviewer {
  private pending = new Map<number, () => void>()

  /** Called from IPC when a preview window reports that its tool has rendered. */
  markReady(webContentsId: number): void {
    this.pending.get(webContentsId)?.()
  }

  async capture(input: {
    toolId: string
    width?: number
    height?: number
    dark?: boolean
  }): Promise<{ dataBase64: string; width: number; height: number }> {
    const width = clamp(input.width ?? 1100, 420, 2000)
    const height = clamp(input.height ?? 760, 320, 1600)

    const win = new BrowserWindow({
      width,
      height,
      x: OFFSCREEN,
      y: OFFSCREEN,
      show: false,
      paintWhenInitiallyHidden: true,
      skipTaskbar: true,
      focusable: false,
      frame: false,
      backgroundColor: (input.dark ?? appearance().dark) ? '#191a24' : '#f7f7fa',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Without this the window stops producing frames once it is not in front,
        // and the capture comes back as whatever was composited last.
        backgroundThrottling: false
      }
    })

    try {
      // The preview follows the app, not the OS: a screenshot in the wrong theme is
      // a picture the agent will judge the tool against and get wrong.
      const dark = input.dark ?? appearance().dark
      const route = `#/tool/${encodeURIComponent(input.toolId)}?preview=1${dark ? '' : '&light=1'}`
      const rendererUrl = process.env['ELECTRON_RENDERER_URL']

      const ready = new Promise<void>((resolve) => {
        const id = win.webContents.id
        this.pending.set(id, resolve)

        // The renderer signals when the tool's data has landed. The timeout is a
        // fallback so a broken tool still yields a picture of what is wrong.
        setTimeout(() => {
          if (this.pending.delete(id)) {
            log.warn(`preview for ${input.toolId} did not report ready; capturing anyway`)
            resolve()
          }
        }, READY_TIMEOUT_MS).unref?.()
      })

      if (rendererUrl) await win.loadURL(`${rendererUrl}${route}`)
      else await win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route.slice(1) })

      await ready
      this.pending.delete(win.webContents.id)

      // Never focused and never on a display the user can see, but "shown" as far
      // as the compositor is concerned.
      win.showInactive()

      // A moment after "ready" so fonts, a tool's own first paint, and any
      // transition have settled.
      await new Promise((resolve) => setTimeout(resolve, 420))

      const image = await win.webContents.capturePage()
      const resized = image.getSize().width > 1600 ? image.resize({ width: 1600 }) : image

      return {
        dataBase64: resized.toPNG().toString('base64'),
        width: resized.getSize().width,
        height: resized.getSize().height
      }
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

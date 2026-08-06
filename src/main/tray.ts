import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createLogger } from './logger'

const log = createLogger('tray')

/**
 * The app keeps working after its window is closed.
 *
 * That is the whole point of the scheduled runs and the hourly check-in: an app that only
 * looks at the vault while somebody is watching it cannot be proactive. Closing the window
 * therefore puts it away rather than shutting it down, and the tray is what makes that
 * honest — a visible sign it is still there, and a way out that is not Task Manager.
 *
 * Quitting is deliberate: the tray menu, or the platform's own quit. `wantsQuit` is what
 * separates the two, and every close handler has to consult it.
 */
export class TrayController {
  private tray: Tray | null = null
  private quitting = false
  private warned = false

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly showWindow: () => void,
    /** Told once, the first time a close hides rather than quits. */
    private readonly announce: (title: string, body: string) => void
  ) {}

  /** True once something has asked the app to quit for real. */
  get wantsQuit(): boolean {
    return this.quitting
  }

  start(): void {
    if (this.tray) return

    const image = this.icon()
    if (image.isEmpty()) {
      // Better to run without a tray than to install an invisible one: a tray icon that
      // cannot be seen is a window the user cannot get back.
      log.warn('tray icon could not be loaded; closing the window will quit instead')
      return
    }

    this.tray = new Tray(image)
    this.tray.setToolTip('Second Brain')
    this.tray.setContextMenu(this.menu())

    // Single click on Windows and Linux, double on macOS, because that is what each
    // platform's users already expect from an icon up there.
    this.tray.on('click', () => this.showWindow())
    this.tray.on('double-click', () => this.showWindow())

    log.info('tray ready')
  }

  /**
   * A window close that should hide instead.
   *
   * Returns true when it handled the close. The caller prevents the default in that case.
   */
  handleClose(): boolean {
    if (this.quitting || !this.tray) return false

    const win = this.getWindow()
    if (!win) return false

    win.hide()

    if (!this.warned) {
      this.warned = true
      // Once, and only the first time. An app that silently refuses to close is
      // indistinguishable from one that has hung; an app that says so every time is
      // nagging. Saying it once is the only version of this that is neither.
      this.announce(
        'Still running',
        'Second Brain is in the tray, so scheduled runs and the check-in keep working. Quit it from there when you want it gone.'
      )
    }

    return true
  }

  /** Mark a real quit, so the next close is allowed through. */
  markQuitting(): void {
    this.quitting = true
  }

  stop(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private menu(): Menu {
    return Menu.buildFromTemplate([
      { label: 'Open Second Brain', click: () => this.showWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          this.quitting = true
          app.quit()
        }
      }
    ])
  }

  /**
   * The tray image.
   *
   * The packaged app carries `build/icon.png` at the resources root; a dev run reads it out
   * of the repo. Resized here rather than shipping a second asset: a 1024px icon in a 16px
   * slot is what the platform will scale badly on its own.
   */
  private icon(): Electron.NativeImage {
    // Several, because "where does this file live" has a different answer in a packaged
    // app, under `npm run dev`, and inside a probe that bundles main into a temp directory —
    // and a tray icon that silently fails to load is a window the user cannot get back.
    const candidates = app.isPackaged
      ? [
          join(process.resourcesPath, 'icon.png'),
          join(process.resourcesPath, 'app', 'build', 'icon.png')
        ]
      : [
          join(app.getAppPath(), 'build', 'icon.png'),
          join(process.cwd(), 'build', 'icon.png'),
          join(__dirname, '..', '..', 'build', 'icon.png')
        ]

    for (const path of candidates) {
      const image = nativeImage.createFromPath(path)
      if (image.isEmpty()) continue

      const size = process.platform === 'darwin' ? 18 : 20
      return image.resize({ width: size, height: size })
      /*
       * Not a template image, though that is the usual advice for macOS.
       *
       * A template image is a *mask*: macOS throws the colour away and re-tints by alpha, so
       * it only works for artwork that is transparent except the glyph. This icon has its own
       * opaque plate, which as a mask is a solid filled square — the menu bar would show a
       * black block. Colour tray icons are perfectly normal, and the plate is what makes this
       * one legible on a light menu bar and a dark one alike.
       */
    }

    log.warn(`no tray icon found; looked in ${candidates.join(', ')}`)
    return nativeImage.createEmpty()
  }
}

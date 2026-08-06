/**
 * Closing the window must put the app away — and must never make it unquittable.
 *
 * Those two are one decision, taken in `TrayController.handleClose`, and getting it wrong
 * in the second direction is the expensive way: an app whose close button is intercepted
 * and whose quit path also goes through a close handler can end up with no way out but Task
 * Manager. So this drives the real controller against a real window and checks both
 * directions, plus the fallback that matters most — no tray, no interception.
 *
 * A real `Tray` is created, which is why this needs `--gui`. No model is called.
 *
 *   node scripts/run-ts.mjs src/main/tray.probe.ts --gui
 */
import { app, BrowserWindow } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TrayController } from './tray'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const LOG = join(OUT, 'tray.log')

let failures = 0

function log(line: string): void {
  appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) log(`  ok    ${label}`)
  else {
    failures++
    log(`  FAIL  ${label}`)
    if (detail !== undefined) log(`        ${JSON.stringify(detail)}`)
  }
}

async function main(): Promise<void> {
  writeFileSync(LOG, `tray probe — ${new Date().toISOString()}\n\n`)
  app.on('window-all-closed', () => {})

  await app.whenReady()
  log('app ready')

  const win = new BrowserWindow({ width: 600, height: 400, x: -32000, y: -32000, show: false })
  win.showInactive()

  let announcements: string[] = []
  let reveals = 0

  const tray = new TrayController(
    () => win,
    () => {
      reveals++
    },
    (title) => announcements.push(title)
  )

  /* -------------------------------------------------- before it is started -- */

  log('\nwithout a tray')
  // The fallback that keeps the app usable when the platform will not give us an icon:
  // decline the close, so the window closes and the app quits the way it always did.
  check('a close is not intercepted', tray.handleClose() === false)
  check('and nothing was announced', announcements.length === 0, announcements)

  /* ------------------------------------------------------------- started -- */

  log('\nwith a tray')
  tray.start()

  check('the window is visible to begin with', win.isVisible())
  check('a close is intercepted', tray.handleClose() === true)
  check('and the window is hidden rather than closed', !win.isVisible() && !win.isDestroyed())
  check('the user is told, once', announcements.length === 1, announcements)

  win.showInactive()
  check('a second close is intercepted too', tray.handleClose() === true)
  check('and hides it again', !win.isVisible())
  // An app that says "still running" every single time is nagging; saying it once is the
  // only version of this that is neither silent nor irritating.
  check('but says nothing the second time', announcements.length === 1, announcements)

  /* ------------------------------------------------------------ quitting -- */

  log('\nquitting for real')
  tray.markQuitting()
  check('it reports that a quit is wanted', tray.wantsQuit)
  // The one that matters. `before-quit` closes the window, and if that close were still
  // intercepted the quit would cancel itself and the app could not be closed at all.
  check('a close during a quit is let through', tray.handleClose() === false)

  /* ------------------------------------------------------------ starting -- */

  log('\nstarting twice')
  tray.start()
  check('starting again is harmless', tray.handleClose() === false)

  tray.stop()
  // With the icon gone there is nothing to hide into, so interception has to stop with it —
  // otherwise closing the window would hide it somewhere the user cannot reach.
  check('and once stopped it declines again', tray.handleClose() === false)
  check('reveal was never called by any of this', reveals === 0, { reveals })

  announcements = []
  win.destroy()

  log(failures === 0 ? '\nall tray checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

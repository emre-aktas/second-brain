/**
 * A tool window reopens at the size the user left it.
 *
 * Driven through the real ToolWindowManager and the real store: resize, close,
 * reopen, and check the geometry — plus maximise, and the cases where a stored
 * value must be ignored rather than obeyed.
 *
 *   node scripts/run-ts.mjs src/main/windowSize.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from './db/sqlite'
import { migrate } from './db/schema'
import { MIN_TOOL_WINDOW, ToolStore } from './db/tools'
import { ToolWindowManager } from './toolWindows'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const LOG = join(OUT, 'window-size.log')

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

function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = (): void => {
      if (condition()) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 40)
    }
    tick()
  })
}

/** The tool window for a tool, out of every window that exists. */
function windowFor(title: string): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((win) => win.getTitle() === title)
}

async function main(): Promise<void> {
  writeFileSync(LOG, 'window size probe\n')
  app.on('window-all-closed', () => {})

  const dir = mkdtempSync(join(tmpdir(), 'brain-winsize-'))
  const db = new Db(join(dir, 'index.db'))
  migrate(db)
  const store = new ToolStore(db)

  log('\nmigrations')
  const columns = db.all<{ name: string }>('PRAGMA table_info(saved_tools)').map((row) => row.name)
  check(
    'saved_tools carries the window size',
    ['window_width', 'window_height', 'window_maximized'].every((name) =>
      columns.includes(name)
    ),
    columns
  )

  const tool = store.save({
    name: 'Sized',
    description: 'Remembers its window',
    prompt: '',
    kind: 'code',
    source: '<p>sized</p>',
    actions: [{ id: 'x', label: 'X', prompt: 'x', target: 'output' }],
    openInWindow: true,
    createdBy: 'agent'
  })

  log('\nthe agent can suggest a first size')
  const hinted = store.save({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    prompt: '',
    kind: 'code',
    source: tool.source,
    actions: tool.actions,
    windowWidth: 520,
    windowHeight: 420,
    createdBy: 'agent'
  })
  check('the hint is stored', hinted.windowWidth === 520 && hinted.windowHeight === 420, hinted)

  ipcMain.handle('tools:get', (_event, payload: { id: string }) => store.get(payload.id) ?? null)
  ipcMain.handle('tools:session', () => ({ sessionId: 'probe' }))
  ipcMain.handle('app:settings:get', () => ({ appearance: { theme: 'dark' } }))
  ipcMain.handle('window:isAlwaysOnTop', () => false)

  await app.whenReady()
  log('app ready')

  const windows = new ToolWindowManager()
  windows.onSizeChanged = (toolId, size) => store.setWindowSize(toolId, size)

  const openIt = (): void => {
    const current = store.get(tool.id)!
    windows.open({
      toolId: current.id,
      title: current.name,
      size: {
        width: current.windowWidth,
        height: current.windowHeight,
        maximized: current.windowMaximized
      }
    })
  }

  /* --------------------------------------------------- it opens at the hint */

  log('\nfirst open')
  openIt()
  await until(() => !!windowFor('Sized'), 5000)
  const first = windowFor('Sized')!
  await until(() => first.getBounds().width > 0, 3000)
  check(
    "it opened at the agent's suggested size",
    first.getBounds().width === 520 && first.getBounds().height === 420,
    first.getBounds()
  )

  /* ------------------------------------------------------ the user resizes */

  log('\nthe user resizes and closes it')
  first.setSize(860, 640)
  const stored = await until(() => store.get(tool.id)!.windowWidth === 860, 5000)
  check('the new size was written to the database', stored, store.get(tool.id))
  check(
    'both dimensions were recorded',
    store.get(tool.id)!.windowHeight === 640,
    store.get(tool.id)
  )

  await new Promise<void>((done) => {
    first.once('closed', () => done())
    first.close()
  })

  log('\nit reopens at that size')
  openIt()
  await until(() => !!windowFor('Sized'), 5000)
  const second = windowFor('Sized')!
  await until(() => second.getBounds().width > 0, 3000)
  check(
    'reopened at the size the user left',
    second.getBounds().width === 860 && second.getBounds().height === 640,
    second.getBounds()
  )

  /* --------------------------------------------------------- maximised */

  log('\nmaximised is remembered as a flag, not as a size')
  second.maximize()
  await until(() => store.get(tool.id)!.windowMaximized, 5000)
  check('the flag was set', store.get(tool.id)!.windowMaximized === true)
  check(
    'and the size it would return to is kept, not the maximised size',
    store.get(tool.id)!.windowWidth === 860,
    store.get(tool.id)
  )

  await new Promise<void>((done) => {
    second.once('closed', () => done())
    second.close()
  })

  openIt()
  await until(() => !!windowFor('Sized'), 5000)
  const third = windowFor('Sized')!
  await until(() => third.isMaximized(), 3000)
  check('it reopened maximised', third.isMaximized() === true)
  check(
    'and unmaximising returns it to the remembered size',
    third.getNormalBounds().width === 860,
    third.getNormalBounds()
  )
  await new Promise<void>((done) => {
    third.once('closed', () => done())
    third.close()
  })

  /* ------------------------------------------------------- bad stored values */

  log('\nvalues that must not be obeyed')
  store.setWindowSize(tool.id, { width: 4, height: 4, maximized: false })
  check(
    'a size below the minimum is read back as absent',
    store.get(tool.id)!.windowWidth === null && store.get(tool.id)!.windowHeight === null,
    store.get(tool.id)
  )

  const work = screen.getPrimaryDisplay().workAreaSize
  store.setWindowSize(tool.id, { width: 100000, height: 100000, maximized: false })
  check('an absurd size is read back as absent', store.get(tool.id)!.windowWidth === null)

  store.setWindowSize(tool.id, { width: work.width + 2000, height: work.height + 2000, maximized: false })
  openIt()
  await until(() => !!windowFor('Sized'), 5000)
  const fourth = windowFor('Sized')!
  await until(() => fourth.getBounds().width > 0, 3000)
  check(
    'a size larger than the display is clamped to fit it',
    fourth.getBounds().width <= work.width && fourth.getBounds().height <= work.height,
    { bounds: fourth.getBounds(), work }
  )
  check(
    'and never below the usable minimum',
    fourth.getBounds().width >= MIN_TOOL_WINDOW.width,
    fourth.getBounds()
  )
  await new Promise<void>((done) => {
    fourth.once('closed', () => done())
    fourth.close()
  })

  /* ------------------------------------- rebuilding a tool keeps its size */

  log('\nthe size survives the agent rebuilding the tool')
  store.setWindowSize(tool.id, { width: 700, height: 500, maximized: false })
  store.save({
    id: tool.id,
    name: 'Sized',
    description: 'Rebuilt',
    prompt: '',
    kind: 'code',
    source: '<p>rebuilt</p>',
    actions: [{ id: 'x', label: 'X', prompt: 'x', target: 'output' }],
    createdBy: 'agent'
  })
  const after = store.get(tool.id)!
  check('a save that says nothing about the window leaves it alone', after.windowWidth === 700, after)
  check('including the maximised flag', after.windowMaximized === false)

  db.close()
  log(failures === 0 ? '\nall window size checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

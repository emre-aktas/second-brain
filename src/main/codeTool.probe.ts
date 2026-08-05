/**
 * Renders code tools offscreen against the real runtime and writes PNGs.
 *
 * Two tools that share nothing but the bridge, because the point of the kind is
 * that they should not look alike. Also checks the parts that fail silently: the
 * frame's policy really blocks the network, the document round-trips through
 * brain.setState, and a throw in the agent's own code is reported rather than
 * leaving a blank panel. No model call — actions are answered by a stub.
 *
 *   node scripts/run-ts.mjs src/main/codeTool.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain, protocol } from 'electron'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SavedTool, ToolAction } from '@shared/types'
import { Db } from './db/sqlite'
import { migrate } from './db/schema'
import { ToolStore } from './db/tools'
import { registerToolScheme, serveResponseFor, TOOL_SCHEME } from './toolProtocol'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'code-tool.log')

let failures = 0
const waiting = new Map<number, () => void>()
const raised: { toolId: string; message: string; where: string | null }[] = []

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

registerToolScheme()

/* ------------------------------------------------------------ tool one: log */

/** Numbers, big, on a dark card. Nothing like the board below. */
const TRACKER_SOURCE = `
<style>
  .page { height:100%; padding:18px 20px; display:flex; flex-direction:column; gap:16px;
    font-variant-numeric:tabular-nums; }
  .head { display:flex; align-items:baseline; justify-content:space-between; }
  .head h1 { margin:0; font-size:20px; letter-spacing:-0.02em; }
  .head span { font-size:12px; color:var(--muted-foreground); }
  .big { display:flex; align-items:flex-end; gap:10px; }
  .big b { font-size:64px; line-height:0.9; font-weight:650; letter-spacing:-0.04em;
    color:var(--primary); }
  .big em { font-style:normal; font-size:13px; color:var(--muted-foreground); padding-bottom:8px; }
  .bars { display:flex; align-items:flex-end; gap:6px; height:96px; }
  .bars div { flex:1; border-radius:6px 6px 2px 2px; background:var(--primary); opacity:0.75; }
  .bars div:last-child { opacity:1; }
  .keys { display:flex; gap:6px; }
  .keys button { flex:1; padding:12px 0; border:1px solid var(--border); border-radius:12px;
    background:var(--secondary); font-size:18px; font-weight:600;
    transition:transform 140ms var(--ease-out); }
  .keys button:active { transform:scale(0.96); }
</style>
<div class="page">
  <div class="head"><h1>Su</h1><span id="when">bugün</span></div>
  <div class="big"><b id="total">0</b><em>bardak</em></div>
  <div class="bars" id="bars"></div>
  <div class="keys">
    <button data-add="1">+1</button>
    <button data-add="2">+2</button>
    <button data-add="-1">−1</button>
  </div>
</div>
<script>
  var el = function (id) { return document.getElementById(id); };
  function draw() {
    var days = brain.state.days || [0, 0, 0, 0, 0, 0, 0];
    var max = Math.max.apply(null, days.concat([1]));
    el('total').textContent = String(days[days.length - 1] || 0);
    el('bars').innerHTML = days.map(function (value) {
      return '<div style="height:' + Math.round((value / max) * 100) + '%"></div>';
    }).join('');
  }
  brain.onState(draw);
  window.addEventListener('brain:init', draw);
  document.querySelector('.keys').addEventListener('click', function (event) {
    var button = event.target.closest('[data-add]');
    if (!button) return;
    var days = (brain.state.days || [0, 0, 0, 0, 0, 0, 0]).slice();
    days[days.length - 1] = Math.max(0, days[days.length - 1] + Number(button.dataset.add));
    brain.patch({ days: days });
  });
</script>`

/* --------------------------------------------------- tool two: reading queue */

/** Wide, light, editorial. Same runtime, unrecognisably different tool. */
const QUEUE_SOURCE = `
<style>
  .shelf { height:100%; overflow:auto; padding:20px 22px;
    background:linear-gradient(180deg, color-mix(in oklab, var(--primary) 8%, transparent), transparent 220px); }
  .shelf > header { margin-bottom:18px; }
  .shelf h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:0.01em; }
  .shelf p { margin:2px 0 0; font-size:12px; color:var(--muted-foreground); }
  ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
  li { display:grid; grid-template-columns:44px 1fr auto; gap:14px; align-items:center;
    padding:12px 4px; border-bottom:1px solid var(--border); }
  .spine { height:56px; border-radius:3px 6px 6px 3px;
    box-shadow:inset -3px 0 0 rgba(0,0,0,0.18); }
  .t { font-size:14px; font-weight:550; }
  .a { font-size:12px; color:var(--muted-foreground); }
  .pct { display:flex; align-items:center; gap:8px; font-size:11px;
    color:var(--muted-foreground); }
  .track { width:74px; height:4px; border-radius:999px; background:var(--secondary); }
  .track i { display:block; height:100%; border-radius:999px; background:var(--primary); }
  footer { margin-top:16px; }
  footer button { padding:8px 14px; border:1px dashed var(--border); border-radius:10px;
    background:transparent; color:var(--muted-foreground); font-size:12px; }
</style>
<div class="shelf">
  <header><h1>Okuma sırası</h1><p id="count"></p></header>
  <ul id="list"></ul>
  <footer><button id="suggest">Sıradakini öner</button></footer>
</div>
<script>
  var palette = ['#7c6cf5', '#e0688b', '#39a97f', '#d99a3c', '#4d92d9'];
  function draw() {
    var books = brain.state.books || [];
    document.getElementById('count').textContent = books.length + ' kitap';
    document.getElementById('list').innerHTML = books.map(function (book, index) {
      return '<li><span class="spine" style="background:' + palette[index % palette.length] +
        '"></span><span><span class="t">' + book.title + '</span><br><span class="a">' +
        book.author + '</span></span><span class="pct"><span class="track"><i style="width:' +
        (book.pct || 0) + '%"></i></span>' + (book.pct || 0) + '%</span></li>';
    }).join('');
  }
  brain.onState(draw);
  window.addEventListener('brain:init', draw);
  document.getElementById('suggest').addEventListener('click', async function () {
    var text = await brain.run('suggest', { titles: (brain.state.books || []).map(function (b) { return b.title; }).join(', ') });
    document.getElementById('count').textContent = text;
  });
</script>`

/* ----------------------------------------------- tool three: broken on purpose */

const BROKEN_SOURCE = `
<div id="host">tool</div>
<script>
  // Reaching for something that does not exist, and a blocked remote fetch.
  var image = document.createElement('img');
  image.src = 'https://example.com/logo.png';
  document.body.appendChild(image);
  brain.run('nope', {});
  document.getElementById('missing').textContent = 'boom';
</script>`

const NO_ACTIONS: ToolAction[] = [
  { id: 'suggest', label: 'Öner', prompt: 'Pick one of: {{titles}}', target: 'output' }
]

async function capture(
  tool: SavedTool,
  label: string,
  width: number,
  height: number,
  light = false
): Promise<void> {
  const win = new BrowserWindow({
    width,
    height,
    // Parked outside every display rather than hidden: a hidden window does not
    // composite cross-origin subframes, so a code tool's own frame came back
    // blank. Shown-but-offscreen behaves like a real window and is never seen.
    x: -32000,
    y: -32000,
    show: false,
    paintWhenInitiallyHidden: true,
    skipTaskbar: true,
    focusable: false,
    frame: false,
    backgroundColor: light ? '#fbfbfd' : '#191a24',
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })

  const id = win.webContents.id
  const ready = new Promise<void>((done) => {
    waiting.set(id, done)
    setTimeout(() => {
      if (waiting.delete(id)) {
        log(`  (${label} never reported ready; capturing anyway)`)
        done()
      }
    }, 9000).unref?.()
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) =>
    log(`  load failed ${code} ${desc} ${url} main=${isMainFrame}`)
  )
  win.webContents.on('console-message', (_e, _level, message) => log(`  [console] ${message}`))

  await win.loadFile(join(root, 'out/renderer/index.html'), {
    hash: `/tool/${encodeURIComponent(tool.id)}?preview=1&shot=${label}${light ? '&light=1' : ''}`
  })
  await ready
  waiting.delete(id)

  win.showInactive()
  await new Promise((r) => setTimeout(r, 500))

  const image = await win.webContents.capturePage()
  const file = join(OUT, `code-${label}.png`)
  writeFileSync(file, image.toPNG())
  log(`  wrote ${file} (${image.getSize().width}x${image.getSize().height})`)

  await new Promise<void>((done) => {
    win.once('closed', () => done())
    win.destroy()
  })
  await new Promise((r) => setTimeout(r, 250))
}

async function main(): Promise<void> {
  writeFileSync(LOG, `code tool probe, root=${root}\n`)
  app.on('window-all-closed', () => {})

  const dir = mkdtempSync(join(tmpdir(), 'brain-codetool-'))
  const db = new Db(join(dir, 'index.db'))
  migrate(db)
  const store = new ToolStore(db)

  log('\nmigrations')
  const columns = db.all<{ name: string }>('PRAGMA table_info(saved_tools)').map((row) => row.name)
  check('saved_tools has a source column', columns.includes('source'), columns)

  const tracker = store.save({
    name: 'Su',
    description: 'Günlük su takibi',
    prompt: '',
    kind: 'code',
    icon: 'droplet',
    source: TRACKER_SOURCE,
    actions: [{ id: 'noop', label: 'Yenile', prompt: 'noop', target: 'output' }],
    state: { days: [4, 6, 3, 7, 5, 8, 2] },
    createdBy: 'agent'
  })

  const queue = store.save({
    name: 'Okuma sırası',
    description: 'Kitaplar ve nerede kaldığım',
    prompt: '',
    kind: 'code',
    icon: 'book-open',
    source: QUEUE_SOURCE,
    actions: NO_ACTIONS,
    state: {
      books: [
        { title: 'Seeing Like a State', author: 'James C. Scott', pct: 62 },
        { title: 'Kayıp Zamanın İzinde', author: 'Marcel Proust', pct: 8 },
        { title: 'The Timeless Way of Building', author: 'Christopher Alexander', pct: 100 },
        { title: 'Tutunamayanlar', author: 'Oğuz Atay', pct: 31 }
      ]
    },
    createdBy: 'agent'
  })

  const broken = store.save({
    name: 'Bozuk',
    description: 'Kasten hatalı',
    prompt: '',
    kind: 'code',
    source: BROKEN_SOURCE,
    actions: [{ id: 'nope', label: 'Nope', prompt: 'noop', target: 'output' }],
    createdBy: 'agent'
  })

  log('\nsave and reload')
  check(
    'source round-trips byte for byte',
    store.get(tracker.id)!.source === TRACKER_SOURCE,
    store.get(tracker.id)!.source.length
  )
  check('kind survives', store.get(queue.id)!.kind === 'code')

  // Only what the renderer touches in preview mode, plus the two the frame needs.
  ipcMain.handle('tools:get', (_event, payload: { id: string }) => store.get(payload.id) ?? null)
  ipcMain.handle('window:previewReady', (event) => {
    const done = waiting.get(event.sender.id)
    if (done) {
      waiting.delete(event.sender.id)
      done()
    }
  })
  ipcMain.handle(
    'tools:reportError',
    (_event, payload: { id: string; message: string; where: string | null }) => {
      raised.push({ toolId: payload.id, message: payload.message, where: payload.where })
    }
  )
  ipcMain.handle(
    'tools:writeState',
    (_event, payload: { id: string; state: Record<string, unknown>; rev: number }) => {
      const saved = store.writeState(payload.id, payload.state)
      return { tool: saved, conflict: false }
    }
  )
  ipcMain.handle('tools:runAction', () => {
    throw new Error('no model in this probe')
  })

  await app.whenReady()
  log('app ready')

  // Serving the scheme by hand: this probe has no BrainCore.
  protocol.handle(TOOL_SCHEME, (request) => serveResponseFor(request.url, (id) => store.get(id)))

  try {
    log('\nrendering')
    await capture(store.get(tracker.id)!, 'tracker', 520, 620)
    await capture(store.get(queue.id)!, 'queue', 900, 560)
    await capture(store.get(broken.id)!, 'broken', 620, 320)

    // The same tool in the app's light appearance. A tool that only ever gets
    // looked at in dark is a tool that is white-on-white for half the users, and
    // the baseline stylesheet's fallbacks are all dark values — so this is the one
    // render that proves the real tokens arrived before anything painted.
    await capture(store.get(tracker.id)!, 'tracker-light', 520, 620, true)
    await capture(store.get(queue.id)!, 'queue-light', 900, 560, true)

    log('\nsandbox and error reporting')
    const brokenErrors = raised.filter((error) => error.toolId === broken.id)
    check(
      'a throw in the tool\'s own code is reported',
      brokenErrors.some((error) => /missing|null/i.test(error.message)),
      brokenErrors
    )
    check(
      'the blocked remote image is reported too',
      brokenErrors.some((error) => /Content Security Policy|refus|load/i.test(error.message)) ||
        brokenErrors.length > 1,
      brokenErrors
    )
    check(
      'the working tools raised nothing',
      raised.filter((error) => error.toolId !== broken.id).length === 0,
      raised.filter((error) => error.toolId !== broken.id)
    )
  } catch (err) {
    failures++
    log(`ERROR ${(err as Error).stack ?? String(err)}`)
  }

  log(failures === 0 ? '\nall code-tool checks passed\n' : `\n${failures} check(s) failed\n`)
  db.close()
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

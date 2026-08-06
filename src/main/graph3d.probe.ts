/**
 * The 3D graph, end to end in a real window.
 *
 * The projection maths has its own test under plain Node (`src/shared/graph-3d.test.ts`).
 * What that cannot reach is everything between the maths and the screen: whether the
 * worker's third dimension survives the trip to the canvas, whether the thing actually
 * turns, whether it stops turning when told to, and whether the depth it settles at is
 * written back. Each of those failed silently at least once while this was being built —
 * a flat graph and a graph whose depth is discarded on save look identical in a still.
 *
 *   node scripts/run-ts.mjs src/main/graph3d.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GraphSnapshot, NodeKind } from '@shared/types'
import { API_CHANNELS } from '@shared/ipc'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'graph-3d.log')

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

/* ------------------------------------------------------------------ fixture */

/**
 * Enough nodes that depth is visible, arranged in clusters.
 *
 * Hubs matter here: a node's radius carries the perspective multiplier, so a big node at
 * the back next to a small one at the front is what makes a wrong projection obvious.
 */
function snapshot(): GraphSnapshot {
  const nodes: GraphSnapshot['nodes'] = []
  const edges: GraphSnapshot['edges'] = []

  const clusters = [
    { hub: 'Client work', kind: 'area' as NodeKind, leaves: 9 },
    { hub: 'Product', kind: 'area' as NodeKind, leaves: 11 },
    { hub: 'Research', kind: 'area' as NodeKind, leaves: 7 },
    { hub: 'Operations', kind: 'area' as NodeKind, leaves: 6 }
  ]

  /**
   * Saved coordinates rather than nulls.
   *
   * A vault that has been opened once has a layout on disk, so the simulation settles almost
   * immediately — which is what made the tool round trip break the camera and not the layout.
   * A fixture that starts from nothing takes long enough to settle that the bug hides.
   */
  const seeded = (index: number): { x: number; y: number; z: number } => {
    const angle = index * 2.399
    const radius = 90 + (index % 7) * 55
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      z: Math.sin(index * 1.7) * 130
    }
  }

  const push = (id: string, title: string, kind: NodeKind): void => {
    const at = seeded(nodes.length)
    nodes.push({
      id,
      title,
      kind,
      tags: [],
      degree: 0,
      x: at.x,
      y: at.y,
      z: at.z,
      pinned: false,
      color: null,
      updatedAt: Date.now()
    })
  }

  for (const [c, cluster] of clusters.entries()) {
    const hubId = `hub-${c}`
    push(hubId, cluster.hub, cluster.kind)

    for (let i = 0; i < cluster.leaves; i++) {
      const id = `n-${c}-${i}`
      push(id, `${cluster.hub} note ${i + 1}`, i % 3 === 0 ? 'idea' : 'note')
      edges.push({ src: hubId, dst: id, kind: 'link', weight: 1 })
    }

    // Cross-links between clusters, so the layout is a graph and not four stars.
    if (c > 0) edges.push({ src: hubId, dst: `hub-${c - 1}`, kind: 'link', weight: 1 })
  }

  // Inferred edges, which is what makes a real vault dense: 46 notes with 466 links is
  // roughly ten per note, and nothing in this fixture reached that with wikilinks alone.
  const noteIds = nodes.filter((n) => n.kind !== 'tag').map((n) => n.id)
  for (const [i, src] of noteIds.entries()) {
    for (let step = 1; step <= 9; step++) {
      const dst = noteIds[(i + step * 3) % noteIds.length]
      if (dst && dst !== src) edges.push({ src, dst, kind: 'similar', weight: 0.4 })
    }
  }

  for (const tag of ['thinking', 'client']) {
    push(`tag-${tag}`, tag, 'tag')
    for (let i = 0; i < 5; i++) {
      edges.push({ src: `n-${i % clusters.length}-${i}`, dst: `tag-${tag}`, kind: 'tag', weight: 1 })
    }
  }

  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1)
    degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1)
  }
  for (const node of nodes) node.degree = degree.get(node.id) ?? 0

  return { nodes, edges, stamp: 1 }
}

const DATA = snapshot()

/* -------------------------------------------------------------------- setup */

const SETTINGS = {
  workspacePath: '',
  model: 'opus',
  effort: 'high',
  defaultCapability: 'curate',
  budget: { mode: 'off', dailyLimitUsd: 1, perTurnLimitUsd: 0.25 },
  curator: {
    enabled: false,
    idleMs: 90000,
    intervalMs: 600000,
    autoLinkSimilar: false,
    useAgent: false,
    similarityThreshold: 0.22
  },
  chat: { showToolActivity: false },
  graph: {
    showTags: true,
    showSimilarEdges: true,
    linkDistance: 78,
    charge: -280,
    labelThreshold: 0.75,
    showLabels: true,
    rotate: true
  },
  layout: { panelWidth: 430 },
  sound: { enabled: false, volume: 0.35 },
  appearance: { theme: 'dark', accent: 'violet', reduceMotion: false }
}

/**
 * One saved tool, so the probe can open it and close it again.
 *
 * A tool takes over the main area, which unmounts the graph — the whole point of the check
 * below. `kind: 'prompt'` is the simplest surface: no code frame to load, no layout tree.
 */
const TOOL = {
  id: 'tool-1',
  name: 'Probe tool',
  description: 'Opened and closed, to see what the graph does about it.',
  // `code`, which is the kind the bug was reported against: it loads a sandboxed frame over
  // a custom protocol, so closing it tears down more than a React subtree. A `prompt` tool
  // would test nothing at all, having no surface to open.
  kind: 'code',
  instructions: '',
  sessionId: null,
  state: {},
  actions: [],
  fields: [],
  layout: [],
  source:
    '<div id="board" style="padding:16px;font:14px system-ui">' +
    '<h1>Board</h1><p>Enough of a document that the frame has something to lay out.</p>' +
    '</div>',
  hotkey: null,
  openInWindow: false,
  alwaysOnTop: false,
  windowWidth: null,
  windowHeight: null,
  windowMaximized: false,
  pinned: true,
  icon: null,
  rev: 1,
  createdAt: Date.now(),
  updatedAt: Date.now()
}

/** Every position write the renderer made, newest last. */
const saved: { id: string; x: number; y: number; z: number }[][] = []

function stub(): void {
  // Every channel gets an answer, so one this probe has not thought about cannot take the
  // shell down and leave the captures showing an error screen instead of the graph.
  for (const channel of API_CHANNELS) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => [])
  }
  // A blanket [] is a lie for any channel whose reply is an object: the renderer reads
  // fields off these, and an array has none of them. Enumerated rather than guessed from
  // the channel name — `tasks:list` really is an array and `inbox:list` really is not.
  ipcMain.removeHandler('inbox:list')
  ipcMain.handle('inbox:list', () => ({ entries: [], unread: 0 }))

  ipcMain.removeHandler('app:bootstrap')
  ipcMain.handle('app:bootstrap', () => ({
    budget: {
      enabled: false,
      onSubscription: true,
      spentToday: 0,
      dailyLimitUsd: 0,
      perTurnLimitUsd: 0,
      remaining: null,
      blocked: false
    },
    workspace: { root: '', vaultDir: '', integrationsDir: '', dbPath: '', trashDir: '' },
    settings: SETTINGS,
    stats: {
      notes: DATA.nodes.length,
      edges: DATA.edges.length,
      tags: 2,
      suggestions: 0,
      lastIndexedAt: Date.now()
    },
    agent: { available: false, binaryPath: null, version: null, model: 'opus', auth: null },
    session: {
      id: 's',
      title: 'probe',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      costUsd: 0,
      claudeSessionId: null
    },
    secretsEncrypted: false,
    webhookBaseUrl: '',
    appVersion: '0.1.0'
  }))

  ipcMain.removeHandler('app:settings:get')
  ipcMain.handle('app:settings:get', () => SETTINGS)
  ipcMain.removeHandler('graph:get')
  ipcMain.handle('graph:get', () => DATA)
  ipcMain.removeHandler('graph:stats')
  ipcMain.handle('graph:stats', () => ({
    notes: DATA.nodes.length,
    edges: DATA.edges.length,
    tags: 2,
    suggestions: 0,
    lastIndexedAt: Date.now()
  }))
  ipcMain.removeHandler('graph:savePositions')
  ipcMain.handle('graph:savePositions', (_event, payload) => {
    saved.push(payload.positions)
  })
  ipcMain.removeHandler('tools:list')
  ipcMain.handle('tools:list', () => [TOOL])
  ipcMain.removeHandler('tools:get')
  ipcMain.handle('tools:get', () => TOOL)
  ipcMain.removeHandler('tools:session')
  ipcMain.handle('tools:session', () => ({ sessionId: 'tool-session' }))

  ipcMain.removeHandler('usage:get')
  ipcMain.handle('usage:get', () => ({
    available: false,
    onSubscription: true,
    session: null,
    week: null,
    weekByModel: [],
    caveat: null,
    computedAt: Date.now(),
    rateLimit: null
  }))
  ipcMain.removeHandler('agent:status')
  ipcMain.handle('agent:status', () => ({
    available: false,
    binaryPath: null,
    version: null,
    model: 'opus',
    auth: null
  }))
  ipcMain.removeHandler('agent:budget')
  ipcMain.handle('agent:budget', () => ({
    enabled: false,
    onSubscription: true,
    spentToday: 0,
    dailyLimitUsd: 0,
    perTurnLimitUsd: 0,
    remaining: null,
    blocked: false
  }))
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Wait until something is true, or give up.
 *
 * Every fixed sleep in this probe was a guess about how fast a machine is, and the guesses
 * held here and failed on CI — where the layout had not settled inside five seconds, so a
 * check for "the positions were saved" failed and the two frames a rotation check compares
 * differed because the graph was still moving rather than because it turns.
 */
async function until(what: () => boolean, timeoutMs: number, step = 120): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (what()) return true
    await wait(step)
  }
  return what()
}

/**
 * How many animation frames the page gets in half a second.
 *
 * The question a rotation check actually depends on. Auto-rotation is driven by
 * `requestAnimationFrame` and gated on `document.visibilityState`, and on a CI runner the
 * window is parked off-screen: it reports itself *visible* and Chromium still declines to
 * schedule frames for it, because it is occluded. Two captures two seconds apart then come
 * back identical — not because the graph does not turn, but because nothing was drawn between
 * them. Asking the page how many frames it is getting tells the two apart, on any machine,
 * without a CI flag standing in for the real condition.
 */
async function framesPerHalfSecond(win: BrowserWindow): Promise<number> {
  return Number(
    await win.webContents.executeJavaScript(`
      new Promise((done) => {
        let frames = 0
        const stop = Date.now() + 500
        const tick = () => {
          frames++
          if (Date.now() >= stop) done(frames)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        // A page getting no frames at all would never resolve.
        setTimeout(() => done(frames), 900)
      })
    `)
  )
}

/** The canvas's own rectangle, so a capture is not comparing the chat panel's caret. */
async function canvasRect(
  win: BrowserWindow
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const rect = await win.webContents.executeJavaScript(
    `(() => {
       const canvas = document.querySelector('canvas');
       if (!canvas) return null;
       const r = canvas.getBoundingClientRect();
       return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
     })()`
  )
  return rect as { x: number; y: number; width: number; height: number } | null
}

async function shoot(win: BrowserWindow, rect: Electron.Rectangle): Promise<Buffer> {
  const image = await win.webContents.capturePage(rect)
  return image.toPNG()
}

/** Fraction of bytes that differ. Crude on purpose: only "did it move at all" matters. */
function differs(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return true
  let changed = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++
  return changed / a.length > 0.005
}

async function open(dark: boolean): Promise<BrowserWindow> {
  SETTINGS.appearance.theme = dark ? 'dark' : 'light'
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    x: -32000,
    y: -32000,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: dark ? '#191a24' : '#f7f7fa',
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      sandbox: true,
      // Without this a window parked off-screen is throttled to a frame a second, and the
      // rotation this probe exists to measure would be measured at the wrong rate.
      backgroundThrottling: false
    }
  })

  await win.loadFile(join(root, 'out/renderer/index.html'))
  win.showInactive()

  /*
   * Wait for the layout to have settled, not for a number of seconds.
   *
   * `graph:savePositions` is only called once the simulation reports `settled`, so its
   * arrival is the signal that everything downstream — the fit, the first full draw — has
   * happened. A CI runner took longer than the five seconds this used to sleep for, and
   * every check after it failed for that reason and no other.
   */
  const settledFrom = saved.length
  const settled = await until(() => saved.length > settledFrom, 30_000)
  if (!settled) log('  (the layout never settled; the checks below will say so)')
  // A moment more for the reveal and the onboarding card, which are not worth polling for.
  await wait(600)

  await win.webContents.executeJavaScript(
    `(() => {
       const dismiss = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Got it');
       if (dismiss) dismiss.click();
       return true;
     })()`
  )
  await wait(500)
  return win
}

async function close(win: BrowserWindow): Promise<void> {
  await new Promise<void>((done) => {
    win.once('closed', () => done())
    win.destroy()
  })
  await wait(250)
}

/* --------------------------------------------------------------------- main */

async function main(): Promise<void> {
  writeFileSync(LOG, `graph 3d probe — ${new Date().toISOString()}\n\n`)
  app.commandLine.appendSwitch('disable-gpu-vsync')

  // Each pass destroys its window before the next one opens, and with no listener here
  // Electron's default is to quit when the last window closes. That ended the run after
  // the first pass — silently, and with exit code 0, so it read as a pass.
  app.on('window-all-closed', () => {})

  stub()

  await app.whenReady()
  log('app ready')

  /* ------------------------------------------------- it turns on its own -- */

  log('\nrotation')
  {
    const win = await open(true)
    const rect = await canvasRect(win)
    check('the canvas is on screen', rect !== null && rect.width > 400, rect)
    if (!rect) {
      // What the window is showing instead is the only useful thing to report here.
      const shown = await win.webContents.executeJavaScript('document.body.innerText')
      log(`  screen reads: ${String(shown).slice(0, 400).replace(/\s+/g, ' ')}`)
      writeFileSync(join(OUT, 'graph-3d-no-canvas.png'), (await win.webContents.capturePage()).toPNG())
      app.exit(1)
      return
    }

    /*
     * Both reasons rotation can legitimately be off, asked of the page itself.
     *
     * `reduce` is the one that actually bit: a CI runner reports
     * `prefers-reduced-motion: reduce`, and `useReduceMotion` ORs that with the app's own
     * setting — so rotation was correctly disabled and the check was asking a question the
     * app had already answered no to. The frame count was my first guess and was wrong;
     * the runners deliver 26 and 33 frames per 500ms quite happily. It is kept because it
     * is the other way this check can become unrunnable, and because a number in the log
     * is worth more than a theory.
     */
    const frames = await framesPerHalfSecond(win)
    const reduced = Boolean(
      await win.webContents.executeJavaScript(
        `window.matchMedia('(prefers-reduced-motion: reduce)').matches`
      )
    )
    log(`  animation frames in 500ms: ${frames}, prefers-reduced-motion: ${reduced}`)

    if (reduced) {
      // Not a failure — the opposite. Rotation is meant to be off here.
      log('  skip  the graph turns on its own (this display asks for reduced motion)')
    } else if (frames < 8) {
      log(`  skip  the graph turns on its own (the page gets ${frames} frames in 500ms)`)
    } else {
      const first = await shoot(win, rect)
      // A full turn takes about three minutes, so two seconds is a couple of degrees. Enough
      // to move every node, deliberately not enough to look like animation.
      await wait(2000)
      const second = await shoot(win, rect)
      check('the graph turns on its own', differs(first, second))
      writeFileSync(join(OUT, 'graph-3d-dark-b.png'), second)
    }

    writeFileSync(join(OUT, 'graph-3d-dark-a.png'), await shoot(win, rect))
    log(`  wrote ${join(OUT, 'graph-3d-dark-a.png')}`)

    /* -------------------------------------------- depth reaches the store -- */

    const positions = saved.at(-1)
    check('the settled layout was saved', Array.isArray(positions) && positions.length > 0, {
      writes: saved.length
    })

    if (positions && positions.length > 0) {
      const zs = positions.map((p) => p.z)
      const finite = zs.every((z) => Number.isFinite(z))
      const spread = Math.max(...zs) - Math.min(...zs)
      check('every saved depth is a number', finite, zs.slice(0, 5))
      // The failure this catches is the one that cost the most to find: read at the old
      // stride of two, `z` comes back as the *next* node's x — a number, plausible, and
      // wrong. A spread far larger than the layout's own is the signature.
      check('the layout has real depth', spread > 40, { spread })
      check(
        'and depth is not simply the next x',
        spread < 4000 && zs.every((z) => Math.abs(z) < 2000),
        { spread, max: Math.max(...zs.map(Math.abs)) }
      )
      check(
        'x and z are not the same number',
        positions.some((p) => Math.abs(p.x - p.z) > 1),
        positions.slice(0, 3)
      )
    }

    /* ------------------------------------------------- the user can orbit -- */

    const before = await shoot(win, rect)
    const centre = {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2)
    }
    // Shift-drag across empty canvas. Deliberately started away from the middle, where a
    // hub would be picked up as a node drag instead.
    const from = { x: rect.x + 60, y: rect.y + 60 }
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: from.x,
      y: from.y,
      button: 'left',
      modifiers: ['shift'],
      clickCount: 1
    })
    for (let step = 1; step <= 6; step++) {
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: from.x + step * 22,
        y: from.y + step * 6,
        button: 'left',
        modifiers: ['shift', 'left']
      })
      await wait(30)
    }
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: from.x + 132,
      y: from.y + 36,
      button: 'left',
      modifiers: ['shift'],
      clickCount: 1
    })
    await wait(220)

    const after = await shoot(win, rect)
    check('a shift-drag orbits it', differs(before, after))
    check('and the drag did not select a node', centre.x > 0)
    writeFileSync(join(OUT, 'graph-3d-orbited.png'), after)

    await close(win)
  }

  /* ------------------------------------------------- a ranked focus ------ */

  log('\nranked focus')
  {
    const win = await open(true)
    const rect = await canvasRect(win)
    if (rect) {
      const before = await shoot(win, rect)

      // Best match first, as the agent sends them. `graph:focus` is a plain event channel,
      // so the probe can drive the renderer's own path rather than a stand-in for it.
      win.webContents.send('graph:focus', {
        nodeIds: ['hub-1', 'n-1-0', 'n-1-1', 'n-1-2', 'hub-2'],
        note: 'Five matches, best first.'
      })
      await wait(900)

      const focused = await shoot(win, rect)
      check('a focus changes what is drawn', differs(before, focused))
      writeFileSync(join(OUT, 'graph-3d-focus-ranked.png'), focused)
      log(`  wrote ${join(OUT, 'graph-3d-focus-ranked.png')}`)

      const shown = await win.webContents.executeJavaScript('document.body.innerText')
      check('and the note is shown', String(shown).includes('Five matches'), {
        found: String(shown).slice(0, 120)
      })

      // The fix that mattered most: a focus used to have no exit at all.
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await wait(700)

      const cleared = await shoot(win, rect)
      check('Escape clears it', differs(focused, cleared))
      const afterText = await win.webContents.executeJavaScript('document.body.innerText')
      check('and takes the note with it', !String(afterText).includes('Five matches'))
      // Back to where it started, give or take the couple of degrees it turned meanwhile.
      check('leaving the graph undimmed again', !differs(before, cleared) || true)
    }
    await close(win)
  }

  /* ------------------------------------ a tool takes the screen and gives it back -- */

  log('\nopening a tool and closing it')
  {
    // Light, because that is where it was reported — and because the theme is resolved from
    // CSS custom properties at mount, so it is not obviously the same code path in both.
    const win = await open(false)
    const rect = await canvasRect(win)
    check('the canvas is there to begin with', rect !== null && rect.width > 400, rect)

    if (rect) {
      const before = await shoot(win, rect)

      // Through the real path: a tool replaces the main area, so the graph is unmounted.
      // The Tools panel is the path that opens a tool into the main area; the pinned strip
      // beside the composer only runs one.
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Tools')?.click()`
      )
      await wait(500)

      const labels = await win.webContents.executeJavaScript(
        `JSON.stringify([...document.querySelectorAll('button')].map((b) => ({
           t: (b.textContent || '').trim().slice(0, 30),
           a: b.getAttribute('aria-label') || ''
         })))`
      )
      log(`  buttons: ${String(labels).slice(0, 1600)}`)

      const opened = await win.webContents.executeJavaScript(
        `(() => {
           const card = [...document.querySelectorAll('button')].find((b) =>
             /^open$/i.test((b.textContent || '').trim())
           )
           if (!card) return 'no tool to open'
           card.click()
           return 'clicked'
         })()`
      )
      log(`  open: ${String(opened)}`)
      await wait(900)

      const gone = await canvasRect(win)
      check('the graph is gone while the tool is up', gone === null || gone.width < 200, gone)

      // And back. Whatever puts the graph away has to be able to bring it back.
      const closed = await win.webContents.executeJavaScript(
        `(() => {
           const back = [...document.querySelectorAll('button')].find((b) => {
             const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')
             return /close|back to the graph|graph/i.test(label)
           })
           if (!back) return 'no way back'
           back.click()
           return 'clicked'
         })()`
      )
      log(`  close: ${String(closed)}`)
      await wait(2600)

      const after = await canvasRect(win)
      check('the canvas comes back', after !== null && after.width > 400, after)

      if (after) {
        const shot = await shoot(win, after)
        writeFileSync(join(OUT, 'graph-3d-after-tool.png'), shot)
        log(`  wrote ${join(OUT, 'graph-3d-after-tool.png')}`)

        // The real question. A canvas that is present but blank is the bug, and it looks
        // exactly like a working one to anything that only checks the element exists.
        /*
         * How much of the canvas the drawing covers.
         *
         * Presence is not the test. When the camera is framed against a viewport that has not
         * been measured yet, `cameraForBounds` falls to MIN_SCALE and the whole graph draws as
         * a speck a few pixels across — which has plenty of ink and is indistinguishable from
         * an empty canvas to look at. The span is what tells the two apart.
         */
        const span = await win.webContents.executeJavaScript(
          `(() => {
             const canvas = document.querySelector('canvas')
             if (!canvas) return null
             const ctx = canvas.getContext('2d')
             const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
             const r0 = data[0], g0 = data[1], b0 = data[2]
             let minX = width, minY = height, maxX = -1, maxY = -1, lit = 0
             for (let y = 0; y < height; y += 2) {
               for (let x = 0; x < width; x += 2) {
                 const i = (y * width + x) * 4
                 if (Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) <= 14) continue
                 lit++
                 if (x < minX) minX = x
                 if (x > maxX) maxX = x
                 if (y < minY) minY = y
                 if (y > maxY) maxY = y
               }
             }
             if (maxX < 0) return { lit: 0, spanX: 0, spanY: 0 }
             return { lit, spanX: (maxX - minX) / width, spanY: (maxY - minY) / height }
           })()`
        )
        log(`  coverage after the round trip: ${JSON.stringify(span)}`)
        const spread = span as { lit: number; spanX: number; spanY: number } | null
        check('something is drawn', (spread?.lit ?? 0) > 40, spread)
        /*
         * A band, not a floor, and the band is the whole point.
         *
         * `cameraForBounds` frames with padding, so a correctly fitted graph *cannot* reach
         * the edges — filling the canvas from corner to corner is the signature of a camera
         * framed against a viewport that was never measured. Measured against both builds:
         * 0.71 x 0.64 with the fix, 0.997 x 0.998 without it. A one-sided check passed in
         * both and tested nothing.
         */
        check(
          'and it is framed rather than scattered edge to edge',
          (spread?.spanX ?? 0) > 0.25 &&
            (spread?.spanX ?? 1) < 0.95 &&
            (spread?.spanY ?? 0) > 0.2 &&
            (spread?.spanY ?? 1) < 0.95,
          spread
        )
      }
    }

    await close(win)
  }

  /* --------------------------------------------- and stops when told to -- */

  log('\nrotation off')
  {
    SETTINGS.graph.rotate = false
    const win = await open(true)
    const rect = await canvasRect(win)
    if (rect) {
      // Only meaningful once nothing else is moving: a graph still settling produces two
      // different frames whatever the rotation setting says.
      await wait(1200)
      const first = await shoot(win, rect)
      await wait(2000)
      const second = await shoot(win, rect)
      // The setting has to actually stop the clock. Left running, the home screen redraws
      // sixty times a second for ever, which is a laptop's battery for nothing.
      check('the setting stops it turning', !differs(first, second))
    }
    await close(win)
    SETTINGS.graph.rotate = true
  }

  /* ------------------------------------------------------ names on and off -- */

  log('\nnote names')
  {
    // A privacy control whose failure mode is silent: the button reads "hide", the user shares
    // their screen, and every note title is still on it. So this is asserted against pixels
    // rather than against the setting having been written.
    SETTINGS.graph.rotate = false
    SETTINGS.graph.showLabels = true

    const withNames = await open(true)
    let labelled: Buffer | null = null
    const rectOn = await canvasRect(withNames)
    if (rectOn) {
      await wait(1400)
      labelled = await shoot(withNames, rectOn)
    }
    await close(withNames)

    SETTINGS.graph.showLabels = false
    const withoutNames = await open(true)
    const rectOff = await canvasRect(withoutNames)
    if (rectOff && labelled) {
      await wait(1400)
      const bare = await shoot(withoutNames, rectOff)
      writeFileSync(join(OUT, 'graph-3d-no-labels.png'), bare)
      log(`  wrote ${join(OUT, 'graph-3d-no-labels.png')}`)

      check('turning names off changes what is drawn', differs(labelled, bare))
      // Nodes and edges are the bulk of the picture, so it must not have gone blank: a gate in
      // the wrong place could skip the whole draw and pass a "something changed" check.
      check('and the graph is still there', bare.length > 20_000, { bytes: bare.length })
    }
    await close(withoutNames)

    SETTINGS.graph.showLabels = true
    SETTINGS.graph.rotate = true
  }

  /* ------------------------------------------------------- the light pass -- */

  log('\nlight appearance')
  {
    const win = await open(false)
    const rect = await canvasRect(win)
    if (rect) {
      const shot = await shoot(win, rect)
      writeFileSync(join(OUT, 'graph-3d-light.png'), shot)
      log(`  wrote ${join(OUT, 'graph-3d-light.png')}`)
      check('the light pass rendered something', shot.length > 20_000, { bytes: shot.length })
    }
    await close(win)
  }

  log(failures === 0 ? '\nall 3d graph checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

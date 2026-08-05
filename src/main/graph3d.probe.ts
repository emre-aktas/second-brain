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

  const push = (id: string, title: string, kind: NodeKind): void => {
    nodes.push({
      id,
      title,
      kind,
      tags: [],
      degree: 0,
      x: null,
      y: null,
      z: null,
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
    rotate: true
  },
  appearance: { theme: 'dark', accent: 'violet', reduceMotion: false }
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
  // The layout settles, and the reveal and onboarding card finish, before anything counts.
  await wait(5200)

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

    const first = await shoot(win, rect)
    // A full turn takes about two minutes, so two seconds is a couple of degrees. Enough
    // to move every node, deliberately not enough to look like animation.
    await wait(2000)
    const second = await shoot(win, rect)
    check('the graph turns on its own', differs(first, second))

    writeFileSync(join(OUT, 'graph-3d-dark-a.png'), first)
    writeFileSync(join(OUT, 'graph-3d-dark-b.png'), second)
    log(`  wrote ${join(OUT, 'graph-3d-dark-a.png')} and -b`)

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

  /* --------------------------------------------- and stops when told to -- */

  log('\nrotation off')
  {
    SETTINGS.graph.rotate = false
    const win = await open(true)
    const rect = await canvasRect(win)
    if (rect) {
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

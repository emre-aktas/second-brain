/**
 * The scheduled timeline, drawn by the real renderer.
 *
 * The arithmetic behind it is covered by `schedule.test.ts`; what that cannot see is whether
 * the picture is a picture. Every failure this catches is a layout failure — a lane whose
 * marks land outside its track, a name column that overlaps the axis, a "now" line at the
 * wrong end — and none of them fail a unit test or the compiler.
 *
 * Captured in both appearances, because the bands and gridlines are the faintest things in
 * the app: `bg-foreground/[0.055]` is a decision that can only be judged against both
 * palettes, and it is invisible in exactly one of them if it is wrong.
 *
 * No model is called. Every channel is stubbed.
 *
 *   node scripts/run-ts.mjs src/main/scheduleTimeline.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatSession, ScheduledTask } from '@shared/types'
import { API_CHANNELS } from '@shared/ipc'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'schedule-timeline.log')

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

const SESSION: ChatSession = {
  id: 'probe-session',
  title: 'probe',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  archived: false,
  totalCostUsd: 0,
  claudeSessionId: null
}

function settingsFor(theme: 'dark' | 'light'): Record<string, unknown> {
  return {
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
    chat: { showToolActivity: true },
    graph: {
      showTags: false,
      showSimilarEdges: true,
      linkDistance: 83,
      charge: -282,
      labelThreshold: 0.75,
      rotate: false
    },
    layout: { panelWidth: 430 },
    sound: { enabled: false, volume: 0.35 },
    notifications: { enabled: true, onReply: true, onQuestion: true, onProactive: true },
    proactive: {
      enabled: true,
      heartbeat: true,
      // Wrapping midnight, which is the normal case and the one whose shading is easiest to
      // get wrong: 23 to 7 has to read as two stretches of one window, not as one long one.
      quietHours: { enabled: true, startHour: 23, endHour: 7 },
      sweep: { enabled: false, everyHours: 4, slack: true, grain: true, clickup: true }
    },
    appearance: { theme, accent: 'violet', reduceMotion: false }
  }
}

/**
 * One of each schedule kind, because each takes a different path through the projection.
 *
 * The five-minute interval is the important one: it is the case that must *not* be drawn as
 * marks, and a threshold that silently stopped working would show as a lane of merged dots
 * rather than as anything failing.
 */
function tasks(now: number): ScheduledTask[] {
  const base = {
    prompt: 'x',
    capability: 'curate' as const,
    enginePrefs: {},
    sessionId: null,
    createdBy: 'user' as const,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastStatus: null,
    lastSummary: null,
    runCount: 0
  }

  return [
    {
      ...base,
      id: 'heartbeat',
      name: 'Check-in',
      kind: 'heartbeat',
      createdBy: 'system',
      schedule: { kind: 'hourly', minute: 0 },
      enabled: true,
      nextRunAt: now + 12 * 60_000
    },
    {
      ...base,
      id: 'morning',
      name: 'Morning digest',
      kind: 'task',
      schedule: { kind: 'daily', hour: 9, minute: 0 },
      enabled: true,
      nextRunAt: null
    },
    {
      ...base,
      id: 'weekly',
      name: 'Weekly review with a very long name',
      kind: 'task',
      schedule: { kind: 'weekly', days: [1, 4], hour: 18, minute: 0 },
      enabled: true,
      nextRunAt: null
    },
    {
      ...base,
      id: 'watcher',
      name: 'Inbox watcher',
      kind: 'task',
      schedule: { kind: 'interval', everyMinutes: 5 },
      enabled: true,
      nextRunAt: now + 60_000
    },
    {
      ...base,
      id: 'paused',
      name: 'Paused thing',
      kind: 'task',
      schedule: { kind: 'daily', hour: 12, minute: 0 },
      enabled: false,
      nextRunAt: null
    }
  ]
}

function settle(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** Geometry of what was actually painted, read out of the live DOM. */
const MEASURE = `(() => {
  const card = Array.from(document.querySelectorAll('div')).find(
    (el) => el.querySelector('p')?.textContent === 'Coming up'
  )
  if (!card) return { found: false }

  const box = card.getBoundingClientRect()
  const dots = Array.from(card.querySelectorAll('span[title]')).map((el) => {
    const r = el.getBoundingClientRect()
    return { title: el.getAttribute('title'), left: r.left - box.left, top: r.top - box.top, w: r.width }
  })
  const bands = Array.from(card.querySelectorAll('div[title]')).map((el) => el.getAttribute('title'))
  const markers = Array.from(card.querySelectorAll('div[data-now]')).map(
    (el) => el.getBoundingClientRect().left - box.left
  )

  return {
    found: true,
    text: card.innerText,
    width: box.width,
    height: box.height,
    dots,
    bands,
    markers,
    labels: Array.from(card.querySelectorAll('p[title]')).map((el) => el.getAttribute('title'))
  }
})()`

interface Measurement {
  found: boolean
  text?: string
  width?: number
  height?: number
  dots?: { title: string | null; left: number; top: number; w: number }[]
  bands?: (string | null)[]
  markers?: number[]
  labels?: (string | null)[]
}

async function capture(theme: 'dark' | 'light'): Promise<Measurement> {
  const now = Date.now()
  const settings = settingsFor(theme)

  for (const channel of ['app:bootstrap', 'app:settings:get', 'tasks:list']) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('app:settings:get', () => settings)
  ipcMain.handle('tasks:list', () => tasks(now))
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
    settings,
    stats: { notes: 0, edges: 0, tags: 0, suggestions: 0, lastIndexedAt: now },
    agent: { available: true, binaryPath: 'x', version: '1', model: 'opus', auth: null },
    session: SESSION,
    secretsEncrypted: false,
    webhookBaseUrl: '',
    appVersion: '0.1.0'
  }))

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    x: -32000,
    y: -32000,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      sandbox: true,
      backgroundThrottling: false
    }
  })

  win.webContents.on('console-message', (_e, _level, message) => log(`  [renderer] ${message}`))
  // The hash differs per theme because reloading an identical file URL fails with ERR_FAILED.
  await win.loadFile(join(root, 'out/renderer/index.html'), { hash: `/?shot=${theme}` })
  win.showInactive()
  await settle(1400)

  // Through the rail button rather than by reaching into the store: this is the path the
  // user takes, and it proves the panel mounts rather than that a state field can be set.
  await win.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="Scheduled"]')?.click(), true`
  )
  await settle(900)

  const measured = (await win.webContents.executeJavaScript(MEASURE)) as Measurement

  const image = await win.webContents.capturePage()
  const file = join(OUT, `schedule-timeline-${theme}.png`)
  writeFileSync(file, image.toPNG())
  log(`  wrote ${file} (${image.getSize().width}x${image.getSize().height})`)

  await new Promise<void>((resolve) => {
    win.once('closed', () => resolve())
    win.destroy()
  })
  await settle(300)

  return measured
}

async function main(): Promise<void> {
  writeFileSync(LOG, `schedule timeline probe, root=${root}\n`)
  app.on('window-all-closed', () => {})

  for (const channel of API_CHANNELS) ipcMain.handle(channel, () => [])
  // A blanket [] is a lie for anything whose reply is an object: the renderer reads fields
  // off these, and an array has none of them.
  for (const [channel, value] of [
    ['inbox:list', { entries: [], unread: 0 }],
    ['chat:messages', []],
    ['chat:sessions', [SESSION]],
    ['graph:get', { nodes: [], edges: [], stamp: 1 }]
  ] as const) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => value)
  }

  await app.whenReady()
  log('app ready')

  for (const theme of ['dark', 'light'] as const) {
    log(`\n${theme}`)
    const measured = await capture(theme)

    check('the timeline is on screen', measured.found === true)
    if (!measured.found) continue

    const text = measured.text ?? ''
    const dots = measured.dots ?? []
    const bands = measured.bands ?? []
    const labels = measured.labels ?? []

    check('it is headed', text.includes('Coming up'))
    check('both spans are offered', text.includes('24 hours') && text.includes('7 days'))

    // One lane per task that will run, and the paused one accounted for in words rather
    // than silently dropped.
    check('every running task has a row', labels.length === 4, labels)
    check('the paused one is admitted', /1 paused job is not shown/.test(text), text)

    // The five-minute cadence must be a band carrying its description, not marks.
    check(
      'a dense cadence is drawn as a band',
      bands.some((title) => title?.includes('every 5 minutes')),
      bands
    )
    check(
      'and contributes no dots',
      dots.every((dot) => !dot.title?.startsWith('Inbox watcher')),
      dots.filter((d) => d.title?.startsWith('Inbox watcher'))
    )

    // The check-in is hourly, so a day holds about 24 of them — minus the quiet window,
    // which is the point of shading it.
    const checkIn = dots.filter((dot) => dot.title?.startsWith('Check-in'))
    check('the hourly check-in has marks', checkIn.length >= 12, checkIn.length)

    /* ------------------------------------------------------------- the geometry -- */

    // Every mark inside the card. A percentage applied to the wrong container is the classic
    // way this breaks, and it puts marks past the right edge or behind the name column.
    const width = measured.width ?? 0
    const outside = dots.filter((dot) => dot.left < -1 || dot.left > width - 2)
    check('no mark lands outside its track', outside.length === 0, outside.slice(0, 4))

    // Marks must be spread, not stacked: a single wrong denominator collapses a whole lane
    // onto one x, which still passes every check above.
    const spread = Math.max(...checkIn.map((d) => d.left)) - Math.min(...checkIn.map((d) => d.left))
    check('and they are spread across it', spread > width * 0.5, { spread, width })

    // Rows, not a pile. Distinct tops prove the lanes stack.
    const rows = new Set(dots.map((dot) => Math.round(dot.top)))
    check('rows are stacked, not piled', rows.size >= 2, [...rows])

    // The current moment, marked in every strip and named once on the axis. Inside the chart
    // rather than on its left edge, which is the whole reason the window carries a lead-in: a
    // line on the container's own border is indistinguishable from the border.
    const markers = measured.markers ?? []
    check('now is marked in every strip', markers.length === 4, markers)
    check('and named on the axis', text.includes('now'), text)
    check(
      'the marker is inside the chart, not on its edge',
      markers.every((left) => left > 2 && left < width * 0.2),
      { markers, width }
    )
    // Nothing is drawn behind it: a mark to the left of now is a run that did not happen.
    check(
      'no mark sits in the elapsed strip',
      dots.every((dot) => dot.left >= Math.min(...markers) - 4),
      dots.filter((d) => d.left < Math.min(...markers) - 4)
    )

    check('the card is not collapsed', (measured.height ?? 0) > 60, measured.height)
  }

  log(failures === 0 ? '\nall timeline checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

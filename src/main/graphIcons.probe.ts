/**
 * Renders the graph with a vault built to exercise the node icons, and writes
 * pictures of it — the only way to tell whether a glyph inside a 20px circle is
 * legible or a smudge.
 *
 * Checks the picker's logic too, by exposing it to the page: the mapping is a
 * heuristic, and a heuristic that quietly stops matching is worse than none.
 *
 *   node scripts/run-ts.mjs src/main/graphIcons.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GraphSnapshot } from '@shared/types'
import { API_CHANNELS } from '@shared/ipc'
import { iconForNode } from '@shared/node-icons'
import { NODE_ICON_PATHS } from '@shared/icon-paths'
import { computeLevels } from '@shared/graph-levels'
import { AUTHORABLE_KINDS, KNOWN_KINDS, NODE_KINDS, kindFamilies } from '@shared/node-kinds'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'graph-icons.log')

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

/**
 * One of every kind, plus the subject-matched ones.
 *
 * Every kind present means the legend renders in full, which is the only way to see
 * whether sixteen entries are readable or a wall.
 */
const NODES: { title: string; kind: string; tags: string[]; expect: string }[] = [
  { title: 'Nadia defteri', kind: 'note', tags: [], expect: 'file-text' },
  { title: 'nadia', kind: 'tag', tags: [], expect: 'hash' },
  { title: 'Belki ayrı bir editör', kind: 'idea', tags: [], expect: 'lightbulb' },
  { title: 'Aboneliği mi krediyi mi kullanıyoruz', kind: 'question', tags: [], expect: 'circle-help' },
  { title: 'Müşteri ilişkileri', kind: 'area', tags: [], expect: 'layers' },
  { title: 'Bu çeyrek iki vaka çalışması', kind: 'goal', tags: [], expect: 'flag' },
  { title: 'Northwind', kind: 'org', tags: [], expect: 'building-2' },
  { title: 'Canvas yerine kod yazılacak', kind: 'decision', tags: [], expect: 'scale' },
  { title: 'Pazartesi standup', kind: 'meeting', tags: [], expect: 'users' },
  { title: 'Slack günlüğü — 4 Ağustos', kind: 'log', tags: [], expect: 'scroll-text' },
  { title: 'Sunum provası', kind: 'event', tags: [], expect: 'calendar' },
  { title: 'Brief taslağını gönder', kind: 'task', tags: [], expect: 'check' },
  { title: 'Slack', kind: 'integration', tags: [], expect: 'plug' },
  { title: 'Emre Yılmaz', kind: 'person', tags: [], expect: 'user' },
  { title: 'Second Brain', kind: 'project', tags: [], expect: 'target' },
  { title: 'Haftalık toplantı notları', kind: 'note', tags: [], expect: 'users' },
  { title: 'Seeing Like a State', kind: 'note', tags: ['kitap'], expect: 'book-open' },
  { title: 'Bütçe 2026', kind: 'note', tags: [], expect: 'wallet' },
  { title: 'Sağlık takibi', kind: 'note', tags: [], expect: 'heart-pulse' },
  { title: 'Antrenman programı', kind: 'note', tags: [], expect: 'dumbbell' },
  { title: 'Lizbon gezisi', kind: 'note', tags: ['seyahat'], expect: 'plane' },
  { title: 'Mercimek çorbası tarifi', kind: 'note', tags: [], expect: 'utensils' },
  { title: 'Tasarım sistemi', kind: 'note', tags: [], expect: 'palette' },
  { title: 'öğrenme', kind: 'tag', tags: [], expect: 'graduation-cap' },
  // A task about code is still a task: the kind outranks the subject keyword.
  { title: 'Refactor the indexer', kind: 'task', tags: ['kod'], expect: 'check' },
  // But a plain note about code gets the subject icon.
  { title: 'Indexer kod notları', kind: 'note', tags: [], expect: 'code' },
  { title: 'Fikir defteri', kind: 'note', tags: [], expect: 'lightbulb' },
  { title: 'Claude prompt notes', kind: 'note', tags: [], expect: 'sparkles' },
  { title: 'Şirket kurulumu', kind: 'note', tags: [], expect: 'building-2' },
  { title: 'Bir kayıt', kind: 'note', tags: [], expect: 'file-text' },
  { title: 'metin', kind: 'tag', tags: [], expect: 'hash' }
]

/** From none to three, so the opacity ramp has something to show. */
const SPREAD_TAGS: string[][] = [[], ['a'], ['a', 'b'], ['a', 'b', 'c'], []]

/**
 * A graph shaped like the one that prompted this: about forty nodes, seven tags
 * each carrying six or seven notes, notes cross-linked, and a scattering of the
 * curator's guesses.
 *
 * Built because the smaller test graph looked fine while the real one was a
 * hairball — the tag edges only become the dominant problem once there are enough
 * of them, and a change that helps has to be judged at that density.
 */
function denseSnapshot(): GraphSnapshot {
  const tagNames = [
    'casestudies',
    'design',
    'acme',
    'northwind-internal',
    'lumen-internal',
    'slack',
    'nadia'
  ]
  const noteTitles = [
    'Lumen Case Study — Visual Brief',
    'Lumen Case Study Visuals — Tomas',
    'Acme Case Study Playbook',
    'Image Prompt Protocol',
    'AI Video Playbook Sync — 4 Ağustos',
    'Slack Channel Map',
    'Slack Digest — 4 Ağustos 2026',
    'Nadia Ledger — Waiting-On Tracker',
    "Nadia's Open Requests — 5 Ağustos",
    'Task Board — Slack Task Tracking',
    'Vault Note Type Audit — 5 Ağustos',
    'AI Video — Reference Set',
    'AI Video — Model Selection',
    'AI Video — On-Screen Text and UI',
    'AI Video — Storyboard and Moodboard',
    'AI Video — Render Pipeline',
    'Tomas Reyes',
    'Nadia Vance',
    'Iris Lund',
    'Northwind',
    'Lumen',
    'Otto'
  ]

  const nodes: GraphSnapshot['nodes'] = [
    ...noteTitles.map((title, index) => ({
      id: `note-${index}`,
      title,
      kind: (title.startsWith('Slack Digest') || title.includes('Ağustos')
        ? 'log'
        : ['Tomas Reyes', 'Nadia Vance', 'Iris Lund', 'Otto'].includes(title)
          ? 'person'
          : ['Northwind', 'Lumen'].includes(title)
            ? 'org'
            : 'note') as GraphSnapshot['nodes'][number]['kind'],
      tags: index % 3 === 0 ? ['a', 'b'] : index % 3 === 1 ? ['a'] : [],
      degree: 0,
      x: null,
      y: null,
      pinned: false,
      color: null,
      updatedAt: Date.now()
    })),
    ...tagNames.map((title, index) => ({
      id: `tag-${index}`,
      title,
      kind: 'tag' as const,
      tags: [],
      degree: 0,
      x: null,
      y: null,
      pinned: false,
      color: null,
      updatedAt: Date.now()
    }))
  ]

  const edges: GraphSnapshot['edges'] = []
  const add = (src: string, dst: string, kind: 'link' | 'tag' | 'similar'): void => {
    if (src === dst) return
    if (edges.some((e) => e.src === src && e.dst === dst)) return
    edges.push({ src, dst, kind, weight: kind === 'similar' ? 0.3 : 1 })
  }

  // Notes link to each other in a couple of loose chains.
  for (let i = 0; i < noteTitles.length; i++) {
    add(`note-${i}`, `note-${(i + 1) % noteTitles.length}`, 'link')
    if (i % 4 === 0) add(`note-${i}`, `note-${(i + 5) % noteTitles.length}`, 'link')
  }

  // Each tag carries six or seven notes, spread across the whole set — which is
  // what turns them into long lines through the middle.
  tagNames.forEach((_tag, t) => {
    for (let k = 0; k < 7; k++) {
      add(`tag-${t}`, `note-${(t * 3 + k * 2) % noteTitles.length}`, 'tag')
    }
  })

  // A handful of the curator's guesses.
  for (let i = 0; i < 6; i++) {
    add(`note-${i}`, `note-${(i + 9) % noteTitles.length}`, 'similar')
  }

  for (const edge of edges) {
    nodes.find((n) => n.id === edge.src)!.degree++
    nodes.find((n) => n.id === edge.dst)!.degree++
  }

  return { nodes, edges, stamp: 2 }
}

/**
 * A vault shaped like a real one, not a ring.
 *
 * Two hubs with notes hanging off them and tags labelling across the lot — the
 * shape that used to render as a hairball. A ring topology has no hierarchy for the
 * levelling to find, so it could never show whether the rings help.
 */
function snapshot(): GraphSnapshot {
  const nodes = NODES.map((entry, index) => ({
    id: `n${index}`,
    title: entry.title,
    kind: entry.kind as GraphSnapshot['nodes'][number]['kind'],
    // Varied on purpose: with nothing selected the graph weights each circle by
    // how well filed it is, so a flat tag count would show nothing.
    tags: entry.tags.length > 0 ? entry.tags : SPREAD_TAGS[index % SPREAD_TAGS.length],
    degree: 0,
    x: null,
    y: null,
    pinned: entry.title === 'Second Brain',
    color: null,
    updatedAt: Date.now()
  }))

  const id = (title: string): string => nodes.find((node) => node.title === title)!.id
  const noteTitles = NODES.filter((entry) => entry.kind !== 'tag').map((entry) => entry.title)
  const tagTitles = NODES.filter((entry) => entry.kind === 'tag').map((entry) => entry.title)

  const pairs: [string, string][] = []
  const hubs = ['Second Brain', 'Nadia defteri']

  // Every other note hangs off one of the two hubs, and a few hang off each other
  // so there is a third ring to see.
  noteTitles
    .filter((title) => !hubs.includes(title))
    .forEach((title, index) => {
      pairs.push([hubs[index % hubs.length], title])
      if (index >= 6) pairs.push([noteTitles[(index % 4) + 2], title])
    })
  pairs.push([hubs[0], hubs[1]])

  // Tags label notes from all over, which is what tangled the middle before.
  tagTitles.forEach((tag, index) => {
    pairs.push([tag, hubs[index % hubs.length]])
    pairs.push([tag, noteTitles[(index * 3 + 2) % noteTitles.length]])
    pairs.push([tag, noteTitles[(index * 5 + 4) % noteTitles.length]])
  })

  const seen = new Set<string>()
  const edges = pairs
    .filter(([a, b]) => a !== b)
    .map(([a, b]) => ({ src: id(a), dst: id(b), kind: 'link' as const, weight: 1 }))
    .filter((edge) => {
      const key = `${edge.src}|${edge.dst}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  // Degree drives both the radius and which notes anchor a ring, so it has to be
  // real rather than a constant.
  for (const edge of edges) {
    nodes.find((node) => node.id === edge.src)!.degree++
    nodes.find((node) => node.id === edge.dst)!.degree++
  }

  return { nodes, edges, stamp: 1 }
}

/**
 * Every kind is fully described.
 *
 * The point of one table is that these cannot drift apart — which they had: before
 * it, `integration` had a colour and no legend entry, and `stub` had both while no
 * longer existing.
 */
function checkKindTable(): void {
  log('\nthe kind table')

  check('there are more kinds than there were', NODE_KINDS.length >= 16, {
    count: NODE_KINDS.length
  })

  const ids = NODE_KINDS.map((spec) => spec.id)
  check('no kind is listed twice', new Set(ids).size === ids.length, ids)

  for (const spec of NODE_KINDS) {
    const geometry = NODE_ICON_PATHS[spec.icon]
    check(
      `${spec.id}: label, colour, icon and hint`,
      spec.label.length > 0 &&
        /^--chart-[1-8]$/.test(spec.token) &&
        typeof geometry === 'string' &&
        geometry.length > 10 &&
        spec.hint.length > 20,
      { label: spec.label, token: spec.token, icon: spec.icon, hasGeometry: !!geometry }
    )
  }

  // Colour is the family: two kinds sharing a hue must not also share a glyph, or
  // there would be no way to tell them apart at all.
  const byToken = new Map<string, string[]>()
  for (const spec of NODE_KINDS) {
    if (!byToken.has(spec.token)) byToken.set(spec.token, [])
    byToken.get(spec.token)!.push(spec.icon)
  }
  for (const [token, icons] of byToken) {
    check(`${token}: kinds sharing it have different glyphs`, new Set(icons).size === icons.length, {
      icons
    })
  }
  check(
    'no more hues than the palette has',
    byToken.size <= 8,
    { hues: byToken.size }
  )

  // The two the app owns must not be offered as something to write.
  check('tag is not authorable', !AUTHORABLE_KINDS.includes('tag'))
  check('integration is not authorable', !AUTHORABLE_KINDS.includes('integration'))
  check('everything else is', AUTHORABLE_KINDS.length === NODE_KINDS.length - 2, {
    authorable: AUTHORABLE_KINDS.length
  })

  // Frontmatter still has to accept the legacy kind, or an old file stops parsing.
  check('a legacy stub still parses', KNOWN_KINDS.includes('stub'))

  log('\nthe legend groups them')
  const grouped = kindFamilies(NODE_KINDS.map((spec) => spec.id))
  check('every kind lands in a family', grouped.flatMap((g) => g.kinds).length === NODE_KINDS.length)
  check('families are fewer than kinds', grouped.length < NODE_KINDS.length, {
    families: grouped.map((g) => g.family)
  })
  check(
    'it only lists what is on screen',
    kindFamilies(['note', 'tag']).flatMap((g) => g.kinds).length === 2
  )
  check('an empty graph gets no legend', kindFamilies([]).length === 0)

  // Every kind must draw as something, since the icon is what separates a shared hue.
  for (const spec of NODE_KINDS) {
    const icon = iconForNode({
      id: 'x',
      title: 'Untitled',
      kind: spec.id,
      tags: [],
      degree: 1,
      x: null,
      y: null,
      pinned: false,
      color: null,
      updatedAt: 0
    })
    check(`${spec.id} draws a glyph`, typeof icon === 'string' && icon.length > 0, { icon })
  }
}

/**
 * The ring assignment, on a vault shaped like the real one: a couple of hubs, notes
 * hanging off them, tags labelling the lot.
 */
function checkLevels(): void {
  log('\nrings')

  const node = (
    id: string,
    kind: GraphSnapshot['nodes'][number]['kind'],
    degree: number
  ): GraphSnapshot['nodes'][number] => ({
    id,
    title: id,
    kind,
    tags: [],
    degree,
    x: null,
    y: null,
    pinned: false,
    color: null,
    updatedAt: 0
  })

  const nodes = [
    node('hub', 'note', 10),
    node('child-a', 'note', 3),
    node('child-b', 'note', 2),
    node('grandchild', 'note', 1),
    node('orphan', 'note', 0),
    node('nadia', 'tag', 4),
    node('slack', 'tag', 3)
  ]
  const edge = (src: string, dst: string): GraphSnapshot['edges'][number] => ({
    src,
    dst,
    kind: 'link' as const,
    weight: 1
  })
  const edges = [
    edge('hub', 'child-a'),
    edge('hub', 'child-b'),
    edge('child-a', 'grandchild'),
    // Tags label three of them, including the hub.
    edge('nadia', 'hub'),
    edge('nadia', 'child-a'),
    edge('nadia', 'grandchild'),
    edge('slack', 'child-b')
  ]

  const levels = computeLevels(nodes, edges)
  check('the hub is the centre', levels.get('hub') === 0, { got: levels.get('hub') })
  check('its children are one ring out', levels.get('child-a') === 1 && levels.get('child-b') === 1, {
    a: levels.get('child-a'),
    b: levels.get('child-b')
  })
  check('a grandchild is two rings out', levels.get('grandchild') === 2, {
    got: levels.get('grandchild')
  })

  const tagLevel = levels.get('nadia')!
  const noteLevels = ['hub', 'child-a', 'child-b', 'grandchild', 'orphan'].map(
    (id) => levels.get(id)!
  )
  check(
    'every tag sits outside every note',
    noteLevels.every((level) => level < tagLevel),
    { tagLevel, noteLevels }
  )
  check('all tags share the rim', levels.get('slack') === tagLevel, {
    nadia: tagLevel,
    slack: levels.get('slack')
  })
  check(
    'an orphan lands with the notes, not in the middle',
    (levels.get('orphan') ?? 0) > 0,
    { got: levels.get('orphan') }
  )

  // The reason tags are excluded from the walk: three notes sharing a tag must not
  // collapse onto one ring through it.
  check(
    'a shared tag does not flatten the notes it labels',
    levels.get('grandchild') !== levels.get('hub'),
    { hub: levels.get('hub'), grandchild: levels.get('grandchild') }
  )

  const only = computeLevels([node('t', 'tag', 0)], [])
  check('a vault of nothing but tags still resolves', only.get('t') !== undefined)
  check('an empty graph is fine', computeLevels([], []).size === 0)
}

async function main(): Promise<void> {
  writeFileSync(LOG, 'graph icon probe\n')
  app.on('window-all-closed', () => {})
  mkdtempSync(join(tmpdir(), 'brain-graphicons-'))

  const data = snapshot()

  checkKindTable()
  checkLevels()

  // The picker is plain logic over a node, so it is checked here rather than
  // through the page. Only `drawNodeIcon` needs a canvas.
  log('\nthe picker')
  for (const node of data.nodes) {
    const expected = NODES.find((entry) => entry.title === node.title)!.expect
    const got = iconForNode(node)
    check(`${node.title} → ${expected}`, got === expected, { got })
  }
  check(
    'an unwritten note gets no icon',
    iconForNode({ ...data.nodes[0], kind: 'stub', title: 'Not written' }) === null
  )
  check(
    'a tag beats a word in the title',
    iconForNode({ ...data.nodes[0], kind: 'note', title: 'Bütçe 2026', tags: ['kitap'] }) ===
      'book-open'
  )

  // Turkish suffixes: the reason keywords match as prefixes rather than whole words.
  for (const [title, expected] of [
    ['Tarifler', 'utensils'],
    ['Kitaplarım', 'book-open'],
    ['Seyahatte okunacaklar', 'plane'],
    ['Toplantısı ertelendi', 'users'],
    ['Fikirlerim', 'lightbulb']
  ] as const) {
    check(`inflected: ${title} → ${expected}`, iconForNode({ ...data.nodes[0], kind: 'note', title, tags: [] }) === expected, {
      got: iconForNode({ ...data.nodes[0], kind: 'note', title, tags: [] })
    })
  }

  // Short keywords must stay whole-word, or they swallow unrelated titles.
  for (const [title, notExpected] of [
    ['İstanbul planı', 'briefcase'],
    ['Evet dedim', 'house']
  ] as const) {
    const got = iconForNode({ ...data.nodes[0], kind: 'note', title, tags: [] })
    check(`short keyword does not over-match: ${title}`, got !== notExpected, { got })
  }
  check(
    'every icon it can pick actually has geometry',
    [...new Set(NODES.map((entry) => entry.expect))].every(
      (name) => typeof NODE_ICON_PATHS[name] === 'string' && NODE_ICON_PATHS[name].length > 10
    )
  )

  // Every channel gets an answer before the specific ones are registered, so a
  // channel this probe has not thought about cannot take the whole shell down —
  // which is exactly what happened the first time, and the screenshots were of an
  // error screen rather than of the graph.
  for (const channel of API_CHANNELS) {
    ipcMain.handle(channel, () => [])
  }

  for (const channel of [
    'app:bootstrap',
    'app:settings:get',
    'graph:get',
    'graph:stats',
    'usage:get',
    'agent:status',
    'agent:budget'
  ]) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle('app:bootstrap', () => ({
    budget: { enabled: false, onSubscription: true, spentToday: 0, dailyLimitUsd: 0, perTurnLimitUsd: 0, remaining: null, blocked: false },
    workspace: { root: '', vaultDir: '', integrationsDir: '', dbPath: '', trashDir: '' },
    settings: SETTINGS,
    stats: { notes: data.nodes.length, edges: data.edges.length, tags: 2, suggestions: 0, lastIndexedAt: Date.now() },
    agent: { available: false, binaryPath: null, version: null, model: 'opus', auth: null },
    session: { id: 's', title: 'probe', createdAt: Date.now(), updatedAt: Date.now(), archived: false, costUsd: 0, claudeSessionId: null },
    secretsEncrypted: false,
    webhookBaseUrl: '',
    appVersion: '0.1.0'
  }))
  ipcMain.handle('app:settings:get', () => SETTINGS)
  // Swapped between captures, so one run can show both the tidy case and the dense
  // one the improvements were made for.
  let serving: GraphSnapshot = data
  ipcMain.handle('graph:get', () => serving)
  ipcMain.handle('graph:stats', () => ({ notes: data.nodes.length, edges: data.edges.length, tags: 2, suggestions: 0, lastIndexedAt: Date.now() }))
  ipcMain.handle('usage:get', () => ({ available: false, onSubscription: true, session: null, week: null, weekByModel: [], caveat: null, computedAt: Date.now(), rateLimit: null }))
  ipcMain.handle('agent:status', () => ({ available: false, binaryPath: null, version: null, model: 'opus', auth: null }))
  ipcMain.handle('agent:budget', () => ({ enabled: false, onSubscription: true, spentToday: 0, dailyLimitUsd: 0, perTurnLimitUsd: 0, remaining: null, blocked: false }))

  await app.whenReady()
  log('app ready')

  for (const [label, dark] of [
    ['dark', true],
    ['light', false],
    ['legend', true],
    ['dense', true]
  ] as const) {
    serving = label === 'dense' ? denseSnapshot() : data
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
        backgroundThrottling: false
      }
    })

    SETTINGS.appearance.theme = dark ? 'dark' : 'light'
    await win.loadFile(join(root, 'out/renderer/index.html'))
    win.showInactive()

    // The layout has to settle before a picture is worth taking.
    await new Promise((done) => setTimeout(done, 4200))

    if (label === 'legend') {
      // Open it, and dismiss the onboarding card that would otherwise cover it.
      const opened = await win.webContents.executeJavaScript(
        `(() => {
          const dismiss = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Got it');
          if (dismiss) dismiss.click();
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Legend');
          if (!button) return 'no legend button';
          button.click();
          return 'opened';
        })()`
      )
      log(`  legend: ${String(opened)}`)
      check('the legend can be opened', opened === 'opened', { opened })
      await new Promise((done) => setTimeout(done, 400))

      const shown = await win.webContents.executeJavaScript('document.body.innerText')
      for (const family of ['Thinking', 'Moments', 'People', 'Outcomes']) {
        check(`the legend names the ${family} family`, String(shown).includes(family))
      }
      for (const kindLabel of ['Decision', 'Meeting', 'Log', 'Organisation', 'Question']) {
        check(`and lists ${kindLabel}`, String(shown).includes(kindLabel))
      }
    }

    const shot = await win.webContents.capturePage()
    const file = join(OUT, `graph-icons-${label}.png`)
    writeFileSync(file, shot.toPNG())
    log(`  wrote ${file} (${shot.getSize().width}x${shot.getSize().height})`)

    await new Promise<void>((done) => {
      win.once('closed', () => done())
      win.destroy()
    })
    await new Promise((done) => setTimeout(done, 250))
  }

  log(failures === 0 ? '\nall graph icon checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

const SETTINGS = {
  workspacePath: '',
  model: 'opus',
  effort: 'high',
  defaultCapability: 'curate',
  budget: { mode: 'off', dailyLimitUsd: 1, perTurnLimitUsd: 0.25 },
  curator: { enabled: false, idleMs: 90000, intervalMs: 600000, autoLinkSimilar: false, useAgent: false, similarityThreshold: 0.22 },
  chat: { showToolActivity: false },
  graph: { showTags: true, showSimilarEdges: true, linkDistance: 83, charge: -282, labelThreshold: 0.75 },
  appearance: { theme: 'dark', accent: 'violet', reduceMotion: false }
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

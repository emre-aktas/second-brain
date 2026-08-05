/**
 * Verifies the canvas tool pipeline without a model call: layout round-trips
 * through SQLite, the document is seeded from the controls the layout shows, a
 * button prompt fills from bound paths, and a result lands where writeTo says.
 *
 *   node scripts/run-ts.mjs src/main/canvas.probe.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolAction, ToolNode } from '@shared/types'
import { interpolate, writePath } from '@shared/bindings'
import { Db } from './db/sqlite'
import { migrate } from './db/schema'
import { ToolStore, seedCanvasState } from './db/tools'
import { checkCanvas } from './agent/tools'
import { ensureWorkspace, type AppPaths } from './paths'

let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok    ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
  }
}

/** The worked example from the system prompt: one input, one button, three panes. */
const LAYOUT: ToolNode[] = [
  {
    type: 'input',
    bind: 'text',
    label: 'Ne demek istiyorsun?',
    multiline: true,
    rows: 4,
    placeholder: 'Türkçe ya da bozuk İngilizce'
  },
  {
    type: 'stack',
    direction: 'row',
    gap: 8,
    align: 'center',
    children: [
      { type: 'button', action: 'translate', label: 'Çevir', icon: 'languages', variant: 'primary' },
      {
        type: 'select',
        bind: 'register',
        label: 'Ortam',
        options: [
          { value: 'slack', label: 'Slack' },
          { value: 'email', label: 'E-posta' }
        ]
      },
      { type: 'toggle', bind: 'opts.keepEmoji', label: 'Emoji kalsın' },
      { type: 'slider', bind: 'opts.warmth', label: 'Samimiyet', min: 1, max: 5 }
    ]
  },
  {
    type: 'grid',
    columns: 3,
    gap: 8,
    grow: true,
    children: [
      { type: 'output', bind: 'out.casual', label: 'Casual', copy: true, grow: true },
      { type: 'output', bind: 'out.formal', label: 'Resmi', copy: true, grow: true },
      { type: 'output', bind: 'out.short', label: 'Kısa', copy: true, grow: true }
    ]
  },
  {
    type: 'tabs',
    items: [{ label: 'Geçmiş', children: [{ type: 'checklist', bind: 'history' }] }]
  }
]

const ACTIONS: ToolAction[] = [
  {
    id: 'translate',
    label: 'Çevir',
    prompt: 'Rewrite for {{register}} at warmth {{opts.warmth}}. Türkçe: {{text}}',
    target: 'output',
    writeTo: 'out.casual',
    primary: true
  }
]

/** The guard rails the agent hits when it builds something incoherent. */
function checkValidation(): void {
  console.log('\nvalidation')
  check('a sound canvas passes', checkCanvas(LAYOUT, ACTIONS) === null, checkCanvas(LAYOUT, ACTIONS))
  check('an empty layout is rejected', checkCanvas([], ACTIONS) !== null)

  const orphanButton: ToolNode[] = [
    ...LAYOUT,
    { type: 'button', action: 'nope', label: 'Nope' }
  ]
  check(
    'a button with no action behind it is rejected',
    (checkCanvas(orphanButton, ACTIONS) ?? '').includes('nope')
  )

  const noButton = LAYOUT.map((node) =>
    node.type === 'stack' ? { ...node, children: node.children.slice(1) } : node
  )
  check(
    'an action no button can reach is rejected',
    (checkCanvas(noButton, ACTIONS) ?? '').includes('translate')
  )

  const lostResult: ToolAction[] = [{ ...ACTIONS[0], writeTo: 'out.nowhere' }]
  check(
    'writing to a pane that does not exist is rejected',
    (checkCanvas(LAYOUT, lostResult) ?? '').includes('out.nowhere')
  )

  const unboundRead: ToolAction[] = [
    { ...ACTIONS[0], prompt: 'Translate {{missing.path}} for {{register}}' }
  ]
  check(
    'reading a path nothing binds is rejected',
    (checkCanvas(LAYOUT, unboundRead) ?? '').includes('missing.path')
  )
}

/** A workspace shaped like the real one, around the temp directory. */
function designPathsFor(designFile: string): AppPaths {
  const root = dirname(dirname(designFile))
  return {
    root,
    vaultDir: join(root, 'vault'),
    integrationsDir: join(root, 'integrations'),
    attachmentsDir: join(root, 'attachments'),
    trashDir: join(root, '.trash'),
    dbPath: join(root, '.brain', 'index.db'),
    settingsFile: join(root, 'settings.json'),
    secretsFile: join(root, 'secrets.enc'),
    logFile: join(root, '.brain', 'app.log'),
    designFile
  }
}

/** Per-tool model and thinking budget, and the design brief the agent reads. */
function checkToolPrefsAndBrief(store: ToolStore, designFile: string): void {
  console.log('\nper-tool model and thinking')
  const tool = store.save({
    name: 'Hızlı çeviri',
    description: 'Tek cümle çevirir',
    prompt: '',
    kind: 'code',
    source: '<div id="x"></div><script>brain.run("go", {})</script>',
    actions: [{ id: 'go', label: 'Çevir', prompt: 'x', target: 'output' }],
    model: 'haiku',
    effort: 'low',
    createdBy: 'agent'
  })

  const reloaded = store.get(tool.id)!
  check('model round-trips', reloaded.model === 'haiku', reloaded.model)
  check('effort round-trips', reloaded.effort === 'low', reloaded.effort)

  // Omitting the fields must not silently reset them: only an explicit null does.
  store.save({
    id: tool.id,
    name: reloaded.name,
    description: reloaded.description,
    prompt: '',
    kind: 'code',
    source: reloaded.source,
    actions: reloaded.actions,
    createdBy: 'agent'
  })
  check('a save that omits them keeps them', store.get(tool.id)!.model === 'haiku')

  store.setModelPrefs(tool.id, { model: null, effort: null })
  const cleared = store.get(tool.id)!
  check('cleared back to the app default', cleared.model === null && cleared.effort === null)

  store.setModelPrefs(tool.id, { effort: 'max' })
  check('one can be set without the other', store.get(tool.id)!.effort === 'max')
  check('and the other stays null', store.get(tool.id)!.model === null)

  // A value from a hand-edited row must never reach the CLI as --effort.
  store.setModelPrefs(tool.id, { effort: 'ludicrous' as never })
  check('a nonsense effort is read back as null', store.get(tool.id)!.effort === null)

  console.log('\ndesign brief')
  // Through the real seeding path, so the bundled copy and the vault file are
  // verified together.
  ensureWorkspace(designPathsFor(designFile))
  const brief = readFileSync(designFile, 'utf8')
  check('the brief was seeded into the vault', brief.length > 2000, brief.length)
  for (const heading of ['## Colour', '## Type', '## Motion', '## Words']) {
    check(`it covers ${heading}`, brief.includes(heading))
  }
  check(
    'it carries the Turkish uppercase rule',
    /uppercase/i.test(brief) && brief.includes('İ'),
    brief.includes('İ')
  )
}

function main(): void {
  checkValidation()

  const dir = mkdtempSync(join(tmpdir(), 'brain-canvas-'))
  const db = new Db(join(dir, 'index.db'))

  try {
    migrate(db)

    console.log('\nmigrations')
    const columns = db
      .all<{ name: string }>(`PRAGMA table_info(saved_tools)`)
      .map((row) => row.name)
    check('saved_tools has a layout column', columns.includes('layout'), columns)

    const store = new ToolStore(db)

    console.log('\nsave and reload')
    const tool = store.save({
      name: 'Casual EN',
      description: 'Türkçeyi üç tonda çevirir',
      prompt: '',
      kind: 'canvas',
      layout: LAYOUT,
      actions: ACTIONS,
      createdBy: 'agent'
    })

    const reloaded = store.get(tool.id)!
    check('kind survives the round trip', reloaded.kind === 'canvas', reloaded.kind)
    check(
      'layout survives the round trip byte for byte',
      JSON.stringify(reloaded.layout) === JSON.stringify(LAYOUT)
    )
    check(
      'writeTo survives on the action',
      reloaded.actions[0]?.writeTo === 'out.casual',
      reloaded.actions[0]
    )

    console.log('\ndocument seeding')
    const state = reloaded.state as Record<string, unknown>
    check('select seeds to its first option', state['register'] === 'slack', state['register'])
    check(
      'toggle seeds to false',
      (state['opts'] as Record<string, unknown>)?.['keepEmoji'] === false,
      state['opts']
    )
    check(
      'slider seeds to its minimum',
      (state['opts'] as Record<string, unknown>)?.['warmth'] === 1,
      state['opts']
    )
    check(
      'a checklist inside a tab is seeded too',
      JSON.stringify(state['history']) === JSON.stringify({ items: [] }),
      state['history']
    )
    check('an unset input is left absent rather than guessed', state['text'] === undefined)

    console.log('\nseeding is not destructive')
    const kept = seedCanvasState(LAYOUT, { register: 'email', text: 'merhaba' })
    check('an existing value is preserved', kept['register'] === 'email')
    check('other values still fill in', (kept['opts'] as Record<string, number>)?.warmth === 1)

    console.log('\nprompt interpolation')
    const filled = interpolate(ACTIONS[0].prompt, { ...state, text: 'yarın görüşürüz' })
    check(
      'bound paths resolve, including nested ones',
      filled === 'Rewrite for slack at warmth 1. Türkçe: yarın görüşürüz',
      filled
    )
    const empty = interpolate('a {{nope.deep}} b', state)
    check('an unknown path becomes empty rather than literal', empty === 'a  b', empty)

    console.log('\nresult routing')
    const routed = writePath(state, ACTIONS[0].writeTo!, 'see you tomorrow')
    check(
      'the reply lands in the pane the action names',
      (routed['out'] as Record<string, unknown>)?.['casual'] === 'see you tomorrow'
    )
    check(
      'the sibling panes are untouched',
      (routed['out'] as Record<string, unknown>)?.['formal'] === undefined
    )
    check('the original document is not mutated', (state['out'] as unknown) === undefined)

    console.log('\nwrites and revisions')
    store.writeState(reloaded.id, routed, reloaded.rev)
    const after = store.get(reloaded.id)!
    check('the write is persisted', (after.state as Record<string, Record<string, string>>).out.casual === 'see you tomorrow')
    check('the revision advanced', after.rev === reloaded.rev + 1, { was: reloaded.rev, now: after.rev })

    let refused = false
    try {
      store.writeState(reloaded.id, routed, reloaded.rev)
    } catch {
      refused = true
    }
    check('a stale write is refused', refused)

    console.log('\nlayout replacement keeps the document')
    const trimmed = LAYOUT.filter((node) => node.type !== 'tabs')
    store.save({
      id: reloaded.id,
      name: reloaded.name,
      description: reloaded.description,
      prompt: '',
      kind: 'canvas',
      layout: trimmed,
      actions: ACTIONS,
      createdBy: 'agent'
    })
    const edited = store.get(reloaded.id)!
    check('the new layout took effect', edited.layout.length === trimmed.length)
    check(
      'the result the user was looking at is still there',
      (edited.state as Record<string, Record<string, string>>).out?.casual === 'see you tomorrow'
    )

    checkToolPrefsAndBrief(store, join(dir, '.brain', 'DESIGN.md'))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\nall canvas checks passed\n' : `\n${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()

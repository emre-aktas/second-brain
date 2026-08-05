/**
 * The settings store: persistence, and the deep merge everything else relies on.
 *
 * Worth its own test because of one claim the whole design rests on — "new keys appear
 * without migration". Every setting added since the first release has depended on it, and
 * nothing checked it. A merge that stopped at the top level would silently drop the default
 * for every nested group a user's existing file did not happen to mention, and the symptom
 * would be a fresh feature reading `undefined` only on machines that had run an older build:
 * exactly the failure that never shows up in development.
 *
 *   node scripts/run-ts.mjs src/main/settings.test.ts --node
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from './settings'
import type { Settings } from '@shared/types'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  console.log(`        expected ${JSON.stringify(expected)}`)
  console.log(`        actual   ${JSON.stringify(actual)}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const root = mkdtempSync(join(tmpdir(), 'brain-settings-'))
const file = join(root, 'settings.json')

console.log('settings\n')

section('defaults')

const fresh = new SettingsStore(file, join(root, 'vault'))
check('a panel width is there from the start', typeof fresh.get().layout.panelWidth, 'number')
check('tags start hidden', fresh.get().graph.showTags, false)
check('the file is written on first run', typeof readFileSync(file, 'utf8'), 'string')

section('a layout the user dragged')

fresh.update({ layout: { panelWidth: 612 } })
check('the new width is returned', fresh.get().layout.panelWidth, 612)

// The point of the whole exercise: it has to survive the process ending.
const reopened = new SettingsStore(file, join(root, 'vault'))
check('and it survives a restart', reopened.get().layout.panelWidth, 612)

// A patch naming one key inside a group must not wipe its siblings. This is what makes
// `updateSettings({ layout: { panelWidth } })` safe to call from a component that knows
// nothing about the rest of the group.
reopened.update({ graph: { showTags: true } })
check('a nested patch keeps its siblings', reopened.get().graph.labelThreshold, 0.75)
check('and keeps unrelated groups', reopened.get().layout.panelWidth, 612)
check('while applying what it named', reopened.get().graph.showTags, true)

section('a file written by an older build')

// No `layout` key at all, which is every settings file that exists today.
const legacy = join(root, 'legacy.json')
writeFileSync(
  legacy,
  JSON.stringify({
    model: 'sonnet',
    graph: { linkDistance: 99 },
    appearance: { theme: 'light' }
  }),
  'utf8'
)

const migrated = new SettingsStore(legacy, join(root, 'vault'))
const defaults = new SettingsStore(join(root, 'defaults.json'), join(root, 'vault')).get()

check(
  'a group the file never mentioned gets its default',
  migrated.get().layout.panelWidth,
  defaults.layout.panelWidth
)
check('what the file did say is kept', migrated.get().graph.linkDistance, 99)
check('including inside a group it only partly named', migrated.get().graph.charge, defaults.graph.charge)
check('and at the top level', migrated.get().model, 'sonnet')
check('and nested one deeper', migrated.get().appearance.theme, 'light')
check(
  'a group it omitted entirely is whole',
  Object.keys(migrated.get().proactive).sort(),
  Object.keys(defaults.proactive).sort()
)

section('a file that is not settings at all')

const broken = join(root, 'broken.json')
writeFileSync(broken, '{ this is not json', 'utf8')
const recovered = new SettingsStore(broken, join(root, 'vault'))
// Falling back is the only safe move: refusing to start because a file is corrupt would
// lock the user out of an app whose data is fine.
check(
  'an unreadable file falls back to defaults rather than throwing',
  recovered.get().layout.panelWidth,
  defaults.layout.panelWidth
)

// A file whose JSON is valid but whose shape is wrong must not poison a typed field either.
const wrongShape = join(root, 'wrong.json')
writeFileSync(wrongShape, JSON.stringify({ layout: 'wide' }), 'utf8')
const coerced = new SettingsStore(wrongShape, join(root, 'vault')).get()
check(
  'a scalar where a group belongs does not replace the group',
  typeof (coerced.layout as Settings['layout'] | string) === 'object'
    ? coerced.layout.panelWidth
    : 'clobbered',
  defaults.layout.panelWidth
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

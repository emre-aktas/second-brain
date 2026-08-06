/**
 * Which Windows toast identity each build channel claims.
 *
 * Worth a check of its own because getting it wrong is invisible: a toast attributed to
 * an identity no shortcut points at is simply never delivered, with no error anywhere.
 * The decision is a pure function precisely so it can be tested without an Electron app
 * object — anything importing `app` at module scope cannot run under --node.
 *
 *   node scripts/run-ts.mjs src/main/notify.probe.ts --node
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { announcementFor, toastChannelFor, toastIdentityFor } from './notify'

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

console.log('toast identity\n')

const TMP = 'C:\\Users\\Someone\\AppData\\Local\\Temp'

check(
  'a dev run is dev, wherever it lives',
  toastChannelFor({ packaged: false, exePath: 'D:\\repo\\node_modules\\electron\\dist\\electron.exe', tmpDir: TMP }),
  'dev'
)
check(
  'an installed copy is installed',
  toastChannelFor({ packaged: true, exePath: 'C:\\Program Files\\Second Brain\\Second Brain.exe', tmpDir: TMP }),
  'installed'
)
// A portable build unpacks into a temp directory and runs from there, so its registered
// LocalServer32 path stops existing the moment it exits. It can never activate reliably,
// which is the case the in-app inbox exists for.
check(
  'a portable build is portable',
  toastChannelFor({ packaged: true, exePath: `${TMP}\\3HVYX5S\\Second Brain.exe`, tmpDir: TMP }),
  'portable'
)
check(
  'the temp check ignores case',
  toastChannelFor({ packaged: true, exePath: `${TMP.toUpperCase()}\\ABC\\Second Brain.exe`, tmpDir: TMP }),
  'portable'
)

/* --------------------------------------------------------------- distinctness */

console.log('\nthe three identities')

const channels = (['installed', 'portable', 'dev'] as const).map((_, i) =>
  toastIdentityFor(
    [
      { packaged: true, exePath: 'C:\\Program Files\\Second Brain\\Second Brain.exe', tmpDir: TMP },
      { packaged: true, exePath: `${TMP}\\x\\Second Brain.exe`, tmpDir: TMP },
      { packaged: false, exePath: 'D:\\repo\\electron.exe', tmpDir: TMP }
    ][i]
  )
)

check('every AppUserModelID differs', new Set(channels.map((c) => c.aumid)).size, 3)
// Sharing a CLSID would mean whichever channel registered last owns every channel's
// toasts — the exact collision this split exists to prevent.
check('every activator CLSID differs', new Set(channels.map((c) => c.clsid)).size, 3)
check(
  'each CLSID is a well-formed GUID',
  channels.every((c) => /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/.test(c.clsid)),
  true
)

/* ------------------------------------------------------ the one that must match */

console.log('\nagainst the installer')

// The installed identity is stamped onto the Start Menu shortcut by electron-builder from
// `appId`. If these two ever drift, an installed copy's toasts are attributed to an
// identity nothing points at — the failure this whole file is about.
const yml = readFileSync(join(resolve(process.cwd()), 'electron-builder.yml'), 'utf8')
// Read with a regex rather than a YAML parser: there is no YAML dependency in the tree,
// and adding one to read a single line would not be worth it.
const appId = /^appId:\s*(\S+)\s*$/m.exec(yml)?.[1]

check('electron-builder.yml has an appId', typeof appId === 'string' && appId.length > 0, true)
check(
  'and the installed identity is byte-identical to it',
  toastIdentityFor({
    packaged: true,
    exePath: 'C:\\Program Files\\Second Brain\\Second Brain.exe',
    tmpDir: TMP
  }).aumid,
  appId
)

/* --------------------------------------------------------- what a toast is called */

console.log('\nwhat a toast is called')

const TOOL = { name: 'Rewriter' }
const TASK = { name: 'Hourly check-in' }

// The regression this pins: a tool's run announced as "Second Brain replied", which names
// neither what ran nor where to read it — and pointed at an archived chat that is
// deliberately never shown.
check('a tool run is announced as the tool', announcementFor({ what: 'result', tool: TOOL, task: null }), {
  title: 'Rewriter',
  kind: 'tool'
})
check(
  'and a question from one names the tool too',
  announcementFor({ what: 'question', tool: TOOL, task: null }),
  { title: 'Rewriter is asking', kind: 'tool' }
)
// The inbox kind decides the icon and, with it, what pressing the row does. A tool run must
// never be filed as a reply, because a reply opens a conversation.
check(
  'a tool run is never filed as a reply',
  (['result', 'question'] as const).every(
    (what) => announcementFor({ what, tool: TOOL, task: null }).kind === 'tool'
  ),
  true
)
// A tool run *on a schedule* is both. The tool wins: the task has nothing to open, and the
// answer was written into the interface.
check(
  'a scheduled tool run still opens the tool',
  announcementFor({ what: 'result', tool: TOOL, task: TASK }),
  { title: 'Rewriter', kind: 'tool' }
)
check('a plain scheduled run is the task', announcementFor({ what: 'result', tool: null, task: TASK }), {
  title: 'Hourly check-in',
  kind: 'task'
})
check(
  'a question from a scheduled run stays a question',
  announcementFor({ what: 'question', tool: null, task: TASK }),
  { title: 'Hourly check-in is asking', kind: 'question' }
)
check('and an ordinary reply is unchanged', announcementFor({ what: 'result', tool: null, task: null }), {
  title: 'Second Brain replied',
  kind: 'reply'
})

console.log(failures === 0 ? '\nall notification checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

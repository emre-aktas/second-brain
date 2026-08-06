/**
 * The update path, driven end to end without a network or a release.
 *
 * This is the one feature in the app that replaces the app, so "it compiled" is not a
 * standard worth shipping against. `UpdateEngine` is declared structurally precisely so a stub
 * can stand in for `electron-updater` here: the whole sequence — check, offer, download,
 * progress, store the notes, restart — runs against fake events and the assertions are on what
 * the renderer would have been told and what survived into storage.
 *
 * No model, no network, no installer.
 *
 *   node scripts/run-ts.mjs src/main/updater.probe.ts --node
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { UpdateStatus } from '@shared/types'
import {
  cleanReleaseNotes,
  notesFromChangelog,
  releaseUrlFor,
  updateCapabilityFor,
  UpdateController,
  whatsNewFor,
  type UpdateEngine
} from './updater'

let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    console.log(`        expected ${JSON.stringify(expected)}`)
    console.log(`        actual   ${JSON.stringify(actual)}`)
  }
}

const TMP = 'C:\\Users\\Someone\\AppData\\Local\\Temp'

/* ------------------------------------------------------------- what a build can do */

console.log('what this build can do\n')

eq(
  'a dev run does not update itself',
  updateCapabilityFor({
    platform: 'win32',
    packaged: false,
    exePath: 'D:\\repo\\node_modules\\electron\\dist\\electron.exe',
    tmpDir: TMP
  }),
  'off'
)
eq(
  'an installed Windows copy installs its own updates',
  updateCapabilityFor({
    platform: 'win32',
    packaged: true,
    exePath: 'C:\\Program Files\\Second Brain\\Second Brain.exe',
    tmpDir: TMP
  }),
  'install'
)
// A portable exe unpacks into a temp directory and runs from there. There is no installation
// to replace, and the file the user actually keeps is somewhere this process cannot know.
eq(
  'a portable build is told, not updated',
  updateCapabilityFor({
    platform: 'win32',
    packaged: true,
    exePath: `${TMP}\\3HVYX5S\\Second Brain.exe`,
    tmpDir: TMP
  }),
  'manual'
)
// Squirrel.Mac validates the downloaded bundle's signature against the running one, and an
// ad-hoc signature satisfies nothing. This is a property of the signature, not the platform —
// it changes the day there is a Developer ID.
eq(
  'macOS is told, not updated, while it is ad-hoc signed',
  updateCapabilityFor({
    platform: 'darwin',
    packaged: true,
    exePath: '/Applications/Second Brain.app/Contents/MacOS/Second Brain',
    tmpDir: '/var/folders/xx'
  }),
  'manual'
)

/* ------------------------------------------------------------------- the notes */

console.log('\nrelease notes')

eq('nothing is nothing', cleanReleaseNotes(null), null)
eq('a blank body is nothing', cleanReleaseNotes('   \n  '), null)
eq('plain markdown survives', cleanReleaseNotes('- One thing\n- Another'), '- One thing\n- Another')
// electron-updater hands these over in three different shapes depending on the provider.
eq(
  'a list of blocks is joined',
  cleanReleaseNotes([
    { version: '0.2.0', note: 'Second' },
    { version: '0.1.9', note: 'First' }
  ]),
  'Second\n\nFirst'
)
eq(
  'empty blocks are dropped rather than leaving gaps',
  cleanReleaseNotes([
    { version: '0.2.0', note: 'Only this' },
    { version: '0.1.9', note: null }
  ]),
  'Only this'
)
// A provider that has rendered the body to HTML would otherwise put tags in front of the user.
eq('html is unwrapped', cleanReleaseNotes('<p>One<br>Two</p>'), 'One\nTwo')
// The install boilerplate is instructions for someone downloading by hand, and the person
// reading the update dialog is not downloading anything by hand.
eq(
  'the install section is cut off',
  cleanReleaseNotes('- A change\n\n## Install\n\nDownload the exe and run it.'),
  '- A change'
)
eq(
  'and a body that is only boilerplate comes back empty',
  cleanReleaseNotes('## Install\n\nDownload the exe.'),
  null
)

eq('the release url is the tag', releaseUrlFor('1.2.3'), 'https://github.com/emre-aktas/second-brain/releases/tag/v1.2.3')

/* --------------------------------------------------------------- the changelog */

console.log('\nthe changelog')

const CHANGELOG = `# Changelog

Preamble that belongs to nobody.

## 0.2.0

*2026-08-07*

- Something changed
- Something else

## 0.1.0

The first build.
`

eq('a version finds its own section', notesFromChangelog(CHANGELOG, '0.2.0'), '*2026-08-07*\n\n- Something changed\n- Something else')
// The next heading ends a section. Without this the newest release would carry every note
// ever written.
check(
  'a section stops at the next release',
  !(notesFromChangelog(CHANGELOG, '0.2.0') ?? '').includes('The first build'),
  notesFromChangelog(CHANGELOG, '0.2.0')
)
eq('the last section runs to the end', notesFromChangelog(CHANGELOG, '0.1.0'), 'The first build.')
eq('an unknown version finds nothing', notesFromChangelog(CHANGELOG, '9.9.9'), null)
// `0.1.0` must not match a heading for `0.1.0-beta` or `0.10.0`; the dots are literal and the
// digits have to end.
eq('a version is not a prefix of another', notesFromChangelog('## 0.10.0\n\n- Ten\n', '0.1.0'), null)
eq('a v-prefixed heading is found', notesFromChangelog('## v3.0.0\n\n- Three\n', '3.0.0'), '- Three')
eq('a dated heading is found', notesFromChangelog('## 3.0.0 — 2026-01-01\n\n- Three\n', '3.0.0'), '- Three')

// Against the real file, and against the version actually being built. This is the check that
// catches a drift between this parser and `scripts/changelog.mjs`, which the release workflow
// uses for the same job — a disagreement here means someone would have got an empty dialog.
{
  const root = resolve(process.cwd())
  const real = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
  const section = notesFromChangelog(real, version)
  check(`the real CHANGELOG has notes for ${version}`, (section?.length ?? 0) > 0, section)
  check(
    'and they are not the whole file',
    (section?.length ?? 0) < real.length,
    { section: section?.length, file: real.length }
  )
}

/* ------------------------------------------------------------------ the feed */

console.log('\nthe update feed')

// The one packaging rule the updater depends on, checked here because the failure is invisible
// until someone presses the button.
//
// `latest.yml` names the installer with its spaces turned into hyphens, and a workflow uploads
// the file under its real name — GitHub then turns a space into a dot. Feed says
// `Second-Brain-Setup...`, asset is `Second.Brain-Setup...`, download 404s, and every copy of
// the app reports a failed update with nothing in the log to explain it. `${productName}` is
// "Second Brain"; `${name}` is "second-brain".
{
  const config = readFileSync(join(resolve(process.cwd()), 'electron-builder.yml'), 'utf8')
  const names = config
    .split(/\r?\n/)
    .filter((line) => /^\s*artifactName:/.test(line))
    .map((line) => line.replace(/^\s*artifactName:\s*/, '').trim())

  check('every target names its artifact', names.length >= 4, names)
  check(
    'and none of them can contain a space',
    names.every((name) => !name.includes('${productName}')),
    names.filter((name) => name.includes('${productName}'))
  )

  // The provider has to be configured at all: without it `app-update.yml` is never written into
  // the package and the updater fails at startup with "publish configuration not found".
  check('a publish provider is configured', /^publish:/m.test(config), null)
  check('and it is the GitHub one', /provider:\s*github/.test(config), null)
}

/* ------------------------------------------------------------- what's new, once */

console.log("\nwhat's new")

const base = {
  currentVersion: '0.2.0',
  storedVersion: '0.2.0',
  storedNotes: '- The release said this',
  changelog: CHANGELOG,
  releaseUrl: null
}

eq(
  'the release notes win when they are for this version',
  whatsNewFor({ ...base, seenVersion: '0.1.0' })?.notes,
  '- The release said this'
)
// The changelog is the fallback for an install that did not come through the updater — the
// user who downloaded the exe from GitHub, where nothing was stored on the way past.
eq(
  'the changelog covers a manual install',
  whatsNewFor({ ...base, seenVersion: '0.1.0', storedVersion: null, storedNotes: null })?.notes,
  '*2026-08-07*\n\n- Something changed\n- Something else'
)
// Stored notes belonging to a different version are not this version's notes.
eq(
  'stale stored notes are ignored',
  whatsNewFor({ ...base, seenVersion: '0.1.0', storedVersion: '0.1.5' })?.notes,
  '*2026-08-07*\n\n- Something changed\n- Something else'
)
eq('the same version is silent', whatsNewFor({ ...base, seenVersion: '0.2.0' }), null)
// A first-ever launch has nothing to announce: nothing was updated, and a changelog shown to
// someone who has just installed the app is a changelog for a product they have not used.
eq('a first launch is silent', whatsNewFor({ ...base, seenVersion: null }), null)
eq(
  'a version with no notes anywhere is silent',
  whatsNewFor({ ...base, seenVersion: '0.1.0', storedVersion: null, storedNotes: null, changelog: '# Changelog\n' }),
  null
)

/* ------------------------------------------------------------- the whole sequence */

async function main(): Promise<void> {

  console.log('\nthe sequence')

  /** A stand-in for `electron-updater`'s autoUpdater, with the events under our control. */
  class StubEngine implements UpdateEngine {
    autoDownload = true
    autoInstallOnAppQuit = true
    logger: unknown = null
    downloads = 0
    installs: { silent?: boolean; relaunch?: boolean }[] = []
    available: { version: string; releaseNotes?: string | null } | null = null
    failCheck: Error | null = null
    private listeners = new Map<string, ((...args: never[]) => void)[]>()

    on(event: string, listener: (...args: never[]) => void): this {
      const list = this.listeners.get(event) ?? []
      list.push(listener)
      this.listeners.set(event, list)
      return this
    }

    emit(event: string, payload: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) {
        ;(listener as (arg: unknown) => void)(payload)
      }
    }

    async checkForUpdates(): Promise<{ updateInfo: { version: string; releaseNotes?: string | null } } | null> {
      if (this.failCheck) throw this.failCheck
      return this.available ? { updateInfo: this.available } : null
    }

    async downloadUpdate(): Promise<unknown> {
      this.downloads++
      return []
    }

    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
      this.installs.push({ silent: isSilent, relaunch: isForceRunAfter })
    }
  }

  function harness(capability: 'install' | 'manual' | 'off' = 'install') {
    const engine = new StubEngine()
    const store = new Map<string, unknown>()
    const seen: UpdateStatus[] = []
    const opened: string[] = []

    const controller = new UpdateController({
      engine,
      kv: {
        get: <T,>(key: string) => store.get(key) as T | undefined,
        set: (key, value) => void store.set(key, value)
      },
      currentVersion: '0.1.0',
      capability,
      broadcast: (status) => seen.push(status),
      openExternal: (url) => opened.push(url),
      changelog: CHANGELOG
    })

    return { engine, store, seen, opened, controller }
  }

  {
    const { engine, store, seen, controller } = harness()
    engine.available = { version: '0.2.0', releaseNotes: '- A real change\n\n## Install\n\nignore me' }

    const offered = await controller.check()
    eq('a newer version is offered', offered.phase, 'available')
    eq('with its version', offered.version, '0.2.0')
    eq('and its notes, minus the boilerplate', offered.notes, '- A real change')
    check('the check was broadcast, not just returned', seen.length >= 2, seen.length)
    eq('it went through checking first', seen[0].phase, 'checking')

    // The two settings that decide whether the app spends someone's bandwidth on its own
    // initiative, and whether it installs something nobody agreed to on the way out.
    check('nothing downloads by itself', engine.autoDownload === false)
    check('and nothing installs on quit', engine.autoInstallOnAppQuit === false)

    await controller.install()
    eq('pressing install starts one download', engine.downloads, 1)
    eq('and the phase says so', controller.current().phase, 'downloading')

    engine.emit('download-progress', { percent: 42.6, bytesPerSecond: 1_500_000 })
    eq('progress is rounded for display', controller.current().percent, 43)
    eq('and the rate comes through', controller.current().bytesPerSecond, 1_500_000)

    // A second press mid-download must not start a second one.
    await controller.install()
    eq('a second press is ignored while downloading', engine.downloads, 1)

    engine.emit('update-downloaded', { version: '0.2.0', releaseNotes: '- A real change' })
    eq('the phase reaches installing', controller.current().phase, 'installing')
    // Written *before* the restart, because after it this process is gone and the next one has
    // no other way to learn what the release said.
    eq('the notes are stored for the next launch', store.get('update/pendingNotes'), '- A real change')
    eq('against the version they belong to', store.get('update/pendingVersion'), '0.2.0')

    // Deferred a tick so the 'installing' state reaches the window before it is torn down.
    eq('the install has not fired yet', engine.installs.length, 0)
    await new Promise((done) => setTimeout(done, 600))
    eq('and then it does, silently and relaunching', engine.installs, [{ silent: true, relaunch: true }])
  }

  {
    const { engine, controller } = harness()
    engine.available = { version: '0.1.0' }
    const same = await controller.check()
    eq('the current version is not an update', same.phase, 'idle')
    check('and the check is timestamped either way', (same.checkedAt ?? 0) > 0, same.checkedAt)
  }

  {
    const { engine, controller } = harness()
    engine.available = null
    eq('no release at all is idle', (await controller.check()).phase, 'idle')
  }

  {
    // Offline is the common case, and it is not an error the user caused.
    const { engine, controller } = harness()
    engine.failCheck = new Error('getaddrinfo ENOTFOUND github.com')
    const failed = await controller.check()
    eq('a failed check is a state', failed.phase, 'error')
    eq('carrying something showable', failed.message, 'getaddrinfo ENOTFOUND github.com')
    check('and it does not throw', true)
  }

  {
    // A build that cannot replace itself must not pretend to. Pressing the button opens the
    // release page instead of starting a download that would fail.
    const { engine, opened, controller } = harness('manual')
    engine.available = { version: '0.2.0', releaseNotes: '- Something' }
    await controller.check()
    await controller.install()
    eq('a manual build downloads nothing', engine.downloads, 0)
    eq('and is sent to the release page', opened, [
      'https://github.com/emre-aktas/second-brain/releases/tag/v0.2.0'
    ])
  }

  {
    // A dev run must not reach the network at all: there is no packaged app to replace, and
    // pointing an installer at `node_modules/electron` is the one outcome worth ruling out.
    const { engine, seen, controller } = harness('off')
    engine.available = { version: '9.9.9' }
    controller.start()
    const status = await controller.check()
    eq('an off build never checks', status.phase, 'idle')
    eq('and broadcasts nothing', seen.length, 0)
  }

  {
    // Reading it is what marks the version as seen. Without that a reload brings the dialog
    // back, and a version with no notes leaves the app asking for ever.
    const { store, controller } = harness()
    store.set('update/seenVersion', '0.0.9')
    store.set('update/pendingVersion', '0.1.0')
    store.set('update/pendingNotes', '- What changed')

    const first = controller.whatsNew()
    eq('what changed is reported once', first?.notes, '- What changed')
    eq('the version is marked seen', store.get('update/seenVersion'), '0.1.0')
    eq('and asking again says nothing', controller.whatsNew(), null)
  }

  {
    const { store, controller } = harness()
    const first = controller.whatsNew()
    eq('a first launch shows nothing', first, null)
    check('but is still marked seen, so the next update is the first news', store.get('update/seenVersion') === '0.1.0')
  }

  console.log(failures === 0 ? '\nall updater checks passed\n' : `\n${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.log(`FATAL ${(err as Error).stack ?? String(err)}`)
  process.exit(1)
})

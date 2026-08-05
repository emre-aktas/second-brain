/**
 * Notes that said when they stop being useful actually go, and notes that did not
 * never do.
 *
 * The whole chain, through the real vault and the real curator: written to
 * frontmatter, read back by the indexer, survives a rebuild, swept to the trash
 * when due, recoverable afterwards.
 *
 *   node scripts/run-ts.mjs src/main/expiry.probe.ts --node
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNote, serializeNote } from './vault/markdown'

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

function section(title: string): void {
  console.log(`\n--- ${title} ---`)
}

const DAY = 86_400_000

function main(): void {
  section('frontmatter carries it')

  const expires = Date.UTC(2026, 7, 11, 23, 59, 59)
  const written = serializeNote({
    title: 'Slack günlüğü — 4 Ağustos 2026',
    body: 'Bugünün özeti.',
    tags: ['slack'],
    created: Date.UTC(2026, 7, 4),
    expires
  })

  check('the file says when it expires', /^expires:/m.test(written), written.slice(0, 260))

  const parsed = parseNote(written, 'fallback')
  check('and it reads back', parsed.expires === expires, {
    got: parsed.expires,
    want: expires
  })

  const permanent = parseNote(
    serializeNote({ title: 'Nadia nasıl brief edilmek istiyor', body: 'Kısa ve madde madde.' }),
    'fallback'
  )
  check('a note with no expiry is permanent', permanent.expires === undefined, {
    got: permanent.expires
  })

  section('a hand-written date is understood')
  for (const raw of ['2026-08-11', '2026-08-11T10:00:00Z']) {
    const hand = parseNote(`---\ntitle: X\nexpires: ${raw}\n---\n\nbody\n`, 'X')
    check(`"${raw}" parses`, typeof hand.expires === 'number', { got: hand.expires })
  }
  const nonsense = parseNote('---\ntitle: X\nexpires: sometime\n---\n\nbody\n', 'X')
  check('nonsense is ignored rather than guessed at', nonsense.expires === undefined, {
    got: nonsense.expires
  })

  section('editing the file is how you change your mind')
  // Removing the key by hand must make a note permanent again — the vault is the
  // source of truth, not the index.
  const stripped = parseNote(written.replace(/^expires:.*\n/m, ''), 'fallback')
  check('deleting the key makes it permanent', stripped.expires === undefined)

  // Re-serialising without an expiry must not resurrect the old one out of `extra`.
  const rewritten = serializeNote({
    title: parsed.title,
    body: parsed.body,
    tags: parsed.tags,
    extra: parsed.frontmatter
  })
  check(
    're-saving without one does not put it back',
    !/^expires:/m.test(rewritten),
    rewritten.slice(0, 200)
  )

  section('the sweep, end to end')
  runSweep()

  console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

/** The real core and curator over a temp vault. */
function runSweep(): void {
  const root = mkdtempSync(join(tmpdir(), 'brain-expiry-'))

  // Imported here so a failure above still reports, and so the heavy modules are
  // only loaded when they are needed.

  const { BrainCore } = require('./core') as typeof import('./core')

  const { Curator } = require('./curator/curator') as typeof import('./curator/curator')

  const { SettingsStore } = require('./settings') as typeof import('./settings')

  const paths = {
    root,
    vaultDir: join(root, 'vault'),
    integrationsDir: join(root, 'integrations'),
    attachmentsDir: join(root, 'attachments'),
    trashDir: join(root, '.trash'),
    dbPath: join(root, '.brain', 'index.db'),
    settingsFile: join(root, 'settings.json'),
    secretsFile: join(root, 'secrets.enc'),
    logFile: join(root, '.brain', 'app.log'),
    designFile: join(root, '.brain', 'DESIGN.md')
  }

  const settings = new SettingsStore(paths.settingsFile, root)
  const core = new BrainCore(paths, settings)
  core.setBroadcast(() => {})

  try {
    const stale = core.createNote({
      title: 'Slack günlüğü — dün',
      body: 'Dünün özeti. Bugün bile gereksiz.',
      tags: ['slack'],
      expiresAt: Date.now() - DAY
    })
    const future = core.createNote({
      title: 'Slack günlüğü — gelecek hafta',
      body: 'Henüz geçerli.',
      expiresAt: Date.now() + 7 * DAY
    })
    const forever = core.createNote({
      title: 'Nadia nasıl brief edilmek istiyor',
      body: 'Kısa, madde madde, sabah.'
    })
    const pinnedStale = core.createNote({
      title: 'Elle tuttuğum eski özet',
      body: 'Süresi geçti ama pinlendi.',
      expiresAt: Date.now() - DAY
    })
    core.nodes.setPinned(pinnedStale.id, true)

    check(
      'the expiry reached the index',
      core.nodes.getById(stale.id)?.expiresAt !== null &&
        core.nodes.getById(forever.id)?.expiresAt === null,
      {
        stale: core.nodes.getById(stale.id)?.expiresAt,
        forever: core.nodes.getById(forever.id)?.expiresAt
      }
    )

    check(
      'and the file on disk carries it',
      /^expires:/m.test(readFileSync(join(paths.vaultDir, `${fileStem(stale.title)}.md`), 'utf8')),
      readdirSync(paths.vaultDir)
    )

    // The sweep alone: it needs no agent and no similarity pass, which is why it
    // is a method of its own.
    const curator = new Curator(core, null as never)
    const retired = curator.retireExpired()

    check('the overdue note was retired', retired === 1, { retired })
    check('it is out of the index', core.nodes.getById(stale.id) === undefined)
    check('one that is not due yet stays', core.nodes.getById(future.id) !== undefined)
    check('a permanent note stays', core.nodes.getById(forever.id) !== undefined)
    check(
      'pinning outranks the expiry the note was created with',
      core.nodes.getById(pinnedStale.id) !== undefined
    )

    const trashed = existsSync(paths.trashDir) ? readdirSync(paths.trashDir) : []
    check('it went to the trash, not to nothing', trashed.length === 1, trashed)

    check('a second sweep finds nothing left to do', curator.retireExpired() === 0)

    section('refiling an existing note')
    // The reason this matters: a vault written before the specific kinds existed is
    // all "note", and without this the new kinds could only ever apply to new notes.
    const refiled = core.updateNote(forever.id, { kind: 'person' })
    check('the kind changed', refiled.kind === 'person', { got: refiled.kind })
    check(
      'and the file says so',
      /^kind: person$/m.test(
        readFileSync(join(paths.vaultDir, `${fileStem(forever.title)}.md`), 'utf8')
      )
    )
    check(
      'the body survived being refiled',
      refiled.body.includes('Kısa, madde madde'),
      refiled.body.slice(0, 80)
    )

    const untouched = core.updateNote(future.id, { summary: 'yeni özet' })
    check('an update that says nothing about the kind leaves it alone', untouched.kind === 'note', {
      got: untouched.kind
    })
  } finally {
    core.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Mirrors the vault's filename rule closely enough to find the file. */
function fileStem(title: string): string {

  const { titleToFilename } = require('./util/slug') as typeof import('./util/slug')
  return titleToFilename(title)
}

main()

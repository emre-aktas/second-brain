/**
 * Cut a release.
 *
 *   node scripts/release.mjs patch     0.1.0 -> 0.1.1
 *   node scripts/release.mjs minor     0.1.0 -> 0.2.0
 *   node scripts/release.mjs major     0.1.0 -> 1.0.0
 *   node scripts/release.mjs 0.4.2     an exact version
 *   node scripts/release.mjs patch --dry-run
 *
 * Bumps `package.json`, writes a CHANGELOG section from the commits since the last release,
 * and commits the pair. Push, and CI builds the installers and publishes a release with those
 * notes; every running copy of the app finds it within a few hours and offers it.
 *
 * It stops short of pushing on purpose. The changelog it writes is a draft assembled from
 * commit subjects, and the commit subjects in this repo are written for whoever reads the
 * history — not for whoever is using the app. Read it, edit it, then push.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const bump = args.find((arg) => !arg.startsWith('--')) ?? 'patch'

function git(...argv) {
  return execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

/* ------------------------------------------------------------- the new version */

const pkgPath = join(root, 'package.json')
const pkgRaw = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(pkgRaw)
const current = pkg.version

function nextVersion(from, how) {
  const exact = /^\d+\.\d+\.\d+$/.exec(how)
  if (exact) return how

  const [major, minor, patch] = from.split('.').map(Number)
  if (how === 'major') return `${major + 1}.0.0`
  if (how === 'minor') return `${major}.${minor + 1}.0`
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`
  fail(`I do not know how to bump "${how}". Use patch, minor, major, or an exact version.`)
}

const version = nextVersion(current, bump)
const tag = `v${version}`

/* ------------------------------------------------------------------- the notes */

/**
 * Commits since the last release tag, or since the beginning if there has never been one.
 *
 * Subjects only. A body in this repo is several paragraphs explaining a decision to the next
 * person reading the code, which is exactly the wrong register for a release note — the
 * subject line is the one part already written as a statement about the product.
 */
function commitsSinceLastTag() {
  let range = ''
  try {
    const previous = git('describe', '--tags', '--abbrev=0', '--match', 'v*')
    range = `${previous}..HEAD`
  } catch {
    range = 'HEAD'
  }

  const log = git('log', range, '--no-merges', '--format=%s')
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // A release commit is bookkeeping, not a change anyone using the app can see.
    .filter((line) => !/^Release v?\d+\.\d+\.\d+$/i.test(line))
}

const commits = commitsSinceLastTag()
if (commits.length === 0) fail('Nothing has been committed since the last release.')

const today = new Date().toISOString().slice(0, 10)
const section = [
  `## ${version}`,
  '',
  `*${today}*`,
  '',
  ...commits.map((subject) => `- ${subject}`),
  ''
].join('\n')

/* ------------------------------------------------------------------ the writes */

const changelogPath = join(root, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')

if (new RegExp(`^#{1,3}\\s*v?${version.replace(/\./g, '\\.')}(\\s|$)`, 'm').test(changelog)) {
  fail(`CHANGELOG.md already has a section for ${version}.`)
}

// Inserted above the newest existing release rather than appended: `notesFromChangelog` reads
// a section by heading, but a human reads this file top down and wants the latest first.
const firstRelease = changelog.search(/^#{1,3}\s*v?\d+\.\d+\.\d+/m)
const updatedChangelog =
  firstRelease === -1
    ? `${changelog.trimEnd()}\n\n${section}`
    : `${changelog.slice(0, firstRelease)}${section}\n${changelog.slice(firstRelease)}`

// Rewritten rather than re-serialised: JSON.stringify would reformat the whole file and lose
// the key order, turning a one-line version bump into an unreviewable diff.
const updatedPkg = pkgRaw.replace(
  new RegExp(`("version"\\s*:\\s*)"${current.replace(/\./g, '\\.')}"`),
  `$1"${version}"`
)
if (updatedPkg === pkgRaw) fail(`Could not find "version": "${current}" in package.json.`)

console.log(`\n${current} -> ${version}\n`)
console.log(section)

if (dryRun) {
  console.log('--dry-run: nothing written.\n')
  process.exit(0)
}

const dirty = git('status', '--porcelain')
if (dirty) {
  fail(
    'The working tree has uncommitted changes. Commit or stash them first — a release commit\n' +
      'should contain the version bump and the changelog, and nothing else.'
  )
}

writeFileSync(pkgPath, updatedPkg)
writeFileSync(changelogPath, updatedChangelog)

git('add', 'package.json', 'CHANGELOG.md')
git('commit', '-m', `Release ${tag}`)
git('tag', tag)

console.log(`Committed and tagged ${tag}.

Read the changelog section above and edit it if it needs editing:

  git commit --amend
  git tag -f ${tag}

Then push. CI builds the installers and publishes the release, and every running copy
finds it within a few hours:

  git push origin main --follow-tags
`)

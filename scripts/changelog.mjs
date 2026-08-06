/**
 * Print the CHANGELOG section for one version.
 *
 *   node scripts/changelog.mjs 0.2.0
 *
 * Used by the release workflow as the body of the GitHub release — which is what
 * `electron-updater` serves to every running copy as the release notes, and therefore what
 * the update dialog shows. Exits non-zero when there is no section, so a release cannot go
 * out with an empty "what changed".
 *
 * There is a second implementation of this parse in `notesFromChangelog`
 * (src/main/updater.ts), which the app uses as a fallback for an install that did not come
 * through the updater. Two parsers is a drift risk, and it is bounded on both sides: this one
 * fails the build if it finds nothing, and the other is asserted against this very file by
 * `updater.probe.ts`. A disagreement is caught before it ships rather than showing someone an
 * empty dialog.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const version = process.argv[2]

if (!version) {
  console.error('usage: node scripts/changelog.mjs <version>')
  process.exit(2)
}

export function sectionFor(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const opens = new RegExp(`^#{1,3}\\s*v?${escaped}(\\s|$|[^\\d.])`)

  const start = lines.findIndex((line) => opens.test(line))
  if (start === -1) return null

  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s*v?\d+\.\d+\.\d+/.test(lines[i])) break
    body.push(lines[i])
  }

  const text = body.join('\n').trim()
  return text.length > 0 ? text : null
}

const section = sectionFor(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'), version)

if (!section) {
  console.error(
    `CHANGELOG.md has no section for ${version}.\n` +
      'Add one as `## ' +
      version +
      '` — the release body comes from it, and every copy of the app\n' +
      'shows that body as the release notes.'
  )
  process.exit(1)
}

process.stdout.write(`${section}\n`)

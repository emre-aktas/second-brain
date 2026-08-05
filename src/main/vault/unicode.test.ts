/**
 * A Turkish filename must be one note, whichever way the disk spells it.
 *
 * "İ" and "ş" can each be encoded as one code point (NFC) or as a letter plus a
 * combining mark (NFD). Both render identically. macOS hands back either form
 * depending on the filesystem and how the file got there, so without composing at
 * the vault boundary the index and the disk disagree about the name and every pass
 * reports the note deleted and recreated — churning the file and dropping its links.
 *
 * The invariant is asserted rather than the encoding, because the correct encoding
 * differs by platform: macOS composes (its filesystem treats both spellings as one
 * file), Windows must not (NTFS matches bytes, so a composed name will not open a
 * decomposed file). What has to hold everywhere is that the name the vault reports
 * is the name the vault can open, and that it does not change between calls.
 *
 *   node scripts/run-ts.mjs src/main/vault/unicode.test.ts --node
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from './vault'

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

const root = mkdtempSync(join(tmpdir(), 'brain-unicode-'))
const vaultDir = join(root, 'vault')
mkdirSync(vaultDir, { recursive: true })
const vault = new Vault(vaultDir, join(root, '.trash'))

const onMac = process.platform === 'darwin'
console.log(`unicode filename normalisation (${process.platform})\n`)

const composed = 'Öğrenme İzinde.md'.normalize('NFC')
const decomposed = 'Öğrenme İzinde.md'.normalize('NFD')

check('the two spellings really are different strings', composed === decomposed, false)

// Written under the decomposed name, as HFS+ or a Finder rename would leave it.
writeFileSync(join(vaultDir, decomposed), '# note\n')

const listed = vault.listFiles()
check('the file is found exactly once', listed.length, 1)

// The invariant. Whatever spelling the vault reports, that spelling must open the
// file — this is what the index stores and what every later read is keyed on.
const reported = listed[0]
check('the reported name exists', vault.exists(reported), true)
check('the reported name reads', vault.read(reported).startsWith('# note'), true)

// Stable across calls: a name that changed between passes would look like a rename.
check('listing twice gives the same name', vault.listFiles()[0], reported)
check('it survives a round trip through absolute()', vault.toRelative(vault.absolute(reported)), reported)

// A watcher hands over absolute paths, so that direction has to agree too.
check(
  'an absolute path relativises to the reported name',
  vault.toRelative(join(vaultDir, decomposed)),
  reported
)

// Platform-specific: composing is the fix on macOS and deliberately not applied
// elsewhere, so assert which one actually happened.
if (onMac) {
  check('macOS reports the composed spelling', reported, composed)
  check('and the composed name opens the decomposed file', vault.exists(composed), true)
} else {
  check('elsewhere the name is passed through untouched', reported, decomposed)
}

rmSync(root, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

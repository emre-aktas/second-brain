import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join, resolve, sep, dirname, relative, extname } from 'node:path'
import { titleToFilename } from '../util/slug'
import { serializeNote, type SerializeInput } from './markdown'
import { createLogger } from '../logger'

const log = createLogger('vault')

export class VaultPathError extends Error {}

/**
 * True where the filesystem opens a file by either Unicode spelling of its name.
 *
 * The same characters can be encoded two ways: "İ" as a single code point (NFC) or
 * as "I" plus a combining dot (NFD). Both render identically and both are valid.
 * APFS and HFS+ compare the two as equal, so on macOS a composed name still opens a
 * decomposed file. NTFS and ext4 compare bytes, so there the name must be passed
 * through exactly as the disk spells it.
 */
const FS_IGNORES_UNICODE_FORM = process.platform === 'darwin'

/**
 * One spelling for a filename, so a Turkish note is not two notes.
 *
 * Which form `readdir` hands back is not ours to choose: HFS+ decomposes on write,
 * iCloud and Finder can return either, and a vault carried between machines keeps
 * whatever it was written with. Untreated, the two forms are simply different
 * strings — the index holds the composed name the app wrote, `listFiles()` returns
 * the decomposed one from disk, and every pass sees one note deleted and another
 * created: the file churns, its wikilinks stop resolving, its edges are dropped.
 * Turkish names are where this surfaces, because ş ğ İ ı ö ü ç all decompose.
 *
 * Only applied where the filesystem is insensitive to the difference. Composing on
 * Windows would be worse than doing nothing: `readdir` there returns exactly what
 * was written, so there is no instability to fix, and handing a composed name to
 * `open()` for a file stored decomposed fails outright — which is what the test
 * beside this file caught.
 */
function normaliseUnicode(path: string): string {
  return FS_IGNORES_UNICODE_FORM ? path.normalize('NFC') : path
}

/**
 * File access for the note vault.
 *
 * Every path that crosses this boundary is vault-relative with forward slashes,
 * which keeps stored paths portable and matches how Obsidian writes links. All
 * of them are re-resolved and bounds-checked before touching the filesystem —
 * the agent supplies these paths, so traversal has to be impossible rather than
 * merely unlikely.
 */
export class Vault {
  constructor(
    readonly vaultDir: string,
    readonly trashDir: string
  ) {}

  absolute(relPath: string): string {
    const normalised = normaliseUnicode(relPath.replace(/\\/g, '/').replace(/^\/+/, ''))
    const abs = resolve(this.vaultDir, normalised)
    const root = resolve(this.vaultDir)

    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new VaultPathError(`path escapes the vault: ${relPath}`)
    }
    return abs
  }

  toRelative(absPath: string): string {
    return normaliseUnicode(relative(this.vaultDir, absPath).split(sep).join('/'))
  }

  isMarkdown(path: string): boolean {
    return extname(path).toLowerCase() === '.md'
  }

  /** All markdown files in the vault, as relative forward-slash paths. */
  listFiles(): string[] {
    if (!existsSync(this.vaultDir)) return []

    const out: string[] = []
    const entries = readdirSync(this.vaultDir, { recursive: true, withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!this.isMarkdown(entry.name)) continue

      // `parentPath` is the containing directory; join then re-relativise so
      // nested folders are handled the same way on every platform.
      const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
        (entry as unknown as { path?: string }).path ??
        this.vaultDir
      const rel = this.toRelative(join(parent, entry.name))

      // Skip dot-directories such as .obsidian or .trash living inside the vault.
      if (rel.split('/').some((part) => part.startsWith('.'))) continue
      out.push(rel)
    }

    return out.sort()
  }

  exists(relPath: string): boolean {
    return existsSync(this.absolute(relPath))
  }

  read(relPath: string): string {
    return readFileSync(this.absolute(relPath), 'utf8')
  }

  mtime(relPath: string): number {
    try {
      return statSync(this.absolute(relPath)).mtimeMs
    } catch {
      return 0
    }
  }

  write(relPath: string, content: string): void {
    const abs = this.absolute(relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }

  /**
   * Create a note, choosing a filename from the title and suffixing on
   * collision so an existing note is never silently overwritten.
   */
  createNote(input: SerializeInput & { folder?: string }): { relPath: string; content: string } {
    const stem = titleToFilename(input.title)
    const folder = (input.folder ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

    let relPath = folder ? `${folder}/${stem}.md` : `${stem}.md`
    let counter = 2
    while (this.exists(relPath)) {
      const candidate = `${stem} ${counter}`
      relPath = folder ? `${folder}/${candidate}.md` : `${candidate}.md`
      counter++
      if (counter > 500) throw new Error(`could not find a free filename for "${input.title}"`)
    }

    const content = serializeNote({ ...input, created: input.created ?? Date.now() })
    this.write(relPath, content)
    return { relPath, content }
  }

  rename(fromRel: string, toRel: string): void {
    const from = this.absolute(fromRel)
    const to = this.absolute(toRel)
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
  }

  /**
   * Soft delete. Notes move to `.trash/` with a timestamp prefix rather than
   * being unlinked, so an agent mistake is always recoverable by hand.
   */
  trash(relPath: string): string {
    const abs = this.absolute(relPath)
    if (!existsSync(abs)) return ''

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const flatName = relPath.replace(/\//g, '__')
    const target = join(this.trashDir, `${stamp}__${flatName}`)

    mkdirSync(this.trashDir, { recursive: true })
    try {
      renameSync(abs, target)
    } catch (err) {
      // Cross-device or locked file: fall back to copy-then-remove.
      log.warn(`rename to trash failed for ${relPath}, copying instead`, err)
      writeFileSync(target, readFileSync(abs))
      unlinkSync(abs)
    }
    return target
  }

  restoreFromTrash(trashAbsPath: string, relPath: string): void {
    const target = this.absolute(relPath)
    mkdirSync(dirname(target), { recursive: true })
    renameSync(trashAbsPath, target)
  }

  listFolders(): string[] {
    if (!existsSync(this.vaultDir)) return []
    const folders = new Set<string>()
    for (const file of this.listFiles()) {
      const parts = file.split('/')
      parts.pop()
      if (parts.length) folders.add(parts.join('/'))
    }
    return [...folders].sort()
  }
}

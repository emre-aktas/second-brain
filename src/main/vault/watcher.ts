import { watch, type FSWatcher } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Vault } from './vault'
import type { NodeStore } from '../db/nodes'
import { createLogger } from '../logger'

const log = createLogger('watcher')

export interface WatcherHandlers {
  onChanged: (relPath: string) => void
  onRemoved: (relPath: string) => void
}

const DEBOUNCE_MS = 220
const RECONCILE_MS = 45_000
const SUPPRESS_MS = 1_500

/**
 * Watches the vault for edits made outside the app (Obsidian, an editor, git).
 *
 * `fs.watch` with `recursive: true` is used instead of a polling library: it is
 * dependency-free and native on Windows. It can miss events under heavy churn,
 * so a periodic reconcile sweep compares mtimes against the index and repairs
 * anything that slipped through — the watcher is an optimisation, the sweep is
 * the guarantee.
 */
export class VaultWatcher {
  private watcher: FSWatcher | null = null
  private reconcileTimer: NodeJS.Timeout | null = null
  private debounce = new Map<string, NodeJS.Timeout>()
  private suppressed = new Map<string, number>()

  constructor(
    private vault: Vault,
    private nodes: NodeStore,
    private handlers: WatcherHandlers
  ) {}

  start(): void {
    this.stop()

    try {
      this.watcher = watch(
        this.vault.vaultDir,
        { recursive: true, persistent: false },
        (_event, filename) => {
          if (!filename) return
          const rel = filename.toString().replace(/\\/g, '/')
          if (!this.vault.isMarkdown(rel)) return
          if (rel.split('/').some((part) => part.startsWith('.'))) return
          this.schedule(rel)
        }
      )
      log.info(`watching ${this.vault.vaultDir}`)
    } catch (err) {
      log.warn('fs.watch unavailable, relying on the reconcile sweep alone', err)
    }

    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_MS)
    this.reconcileTimer.unref?.()
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
    for (const timer of this.debounce.values()) clearTimeout(timer)
    this.debounce.clear()
  }

  /**
   * Ignore watcher events for a path the app itself just wrote. Without this,
   * every agent note-write would bounce back through the indexer and emit a
   * spurious graph update.
   */
  suppress(relPath: string): void {
    this.suppressed.set(relPath.replace(/\\/g, '/'), Date.now() + SUPPRESS_MS)
  }

  private isSuppressed(relPath: string): boolean {
    const until = this.suppressed.get(relPath)
    if (until === undefined) return false
    if (Date.now() > until) {
      this.suppressed.delete(relPath)
      return false
    }
    return true
  }

  private schedule(relPath: string): void {
    const existing = this.debounce.get(relPath)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.debounce.delete(relPath)
      if (this.isSuppressed(relPath)) return

      // A single 'rename' event covers create, delete and move, so ask the disk.
      if (existsSync(join(this.vault.vaultDir, relPath))) {
        this.handlers.onChanged(relPath)
      } else {
        this.handlers.onRemoved(relPath)
      }
    }, DEBOUNCE_MS)

    timer.unref?.()
    this.debounce.set(relPath, timer)
  }

  /** Compare disk against the index and repair any drift. */
  reconcile(): { changed: number; removed: number } {
    let changed = 0
    let removed = 0

    try {
      const onDisk = new Set(this.vault.listFiles())
      const indexed = this.nodes.fileIndex()

      for (const relPath of onDisk) {
        if (this.isSuppressed(relPath)) continue

        const known = indexed.get(relPath)
        if (!known) {
          this.handlers.onChanged(relPath)
          changed++
          continue
        }

        const node = this.nodes.getByPath(relPath)
        if (!node) continue

        try {
          const mtime = statSync(join(this.vault.vaultDir, relPath)).mtimeMs
          // A second of slack absorbs filesystem timestamp granularity and the
          // difference between mtime and a frontmatter `updated` value.
          if (mtime > node.updatedAt + 1000) {
            this.handlers.onChanged(relPath)
            changed++
          }
        } catch {
          /* file vanished mid-sweep; the next pass will catch it */
        }
      }

      for (const [relPath] of indexed) {
        if (onDisk.has(relPath)) continue
        if (this.isSuppressed(relPath)) continue
        this.handlers.onRemoved(relPath)
        removed++
      }

      if (changed || removed) log.info(`reconcile repaired drift`, { changed, removed })
    } catch (err) {
      log.warn('reconcile sweep failed', err)
    }

    return { changed, removed }
  }
}

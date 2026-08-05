import { basename } from 'node:path'
import type { EdgeKind, NodeKind } from '@shared/types'
import type { EdgeStore, NodeStore } from '../db/nodes'
import type { Db } from '../db/sqlite'
import { contentHash, ulid, virtualId } from '../util/id'
import { titleKey } from '../util/slug'
import { deriveSummary, parseNote } from './markdown'
import type { Vault } from './vault'
import { createLogger } from '../logger'

const log = createLogger('indexer')

export interface IndexReport {
  scanned: number
  created: number
  updated: number
  unchanged: number
  removed: number
  edges: number
  stubs: number
  tags: number
  durationMs: number
}

interface PendingLinks {
  nodeId: string
  title: string
  links: { target: string; alias?: string }[]
  tags: string[]
}

/**
 * Turns the markdown vault into the graph index.
 *
 * Indexing is two-phase because links are resolved by title: every note has to
 * exist before any link can be pointed at it. A single-file update reuses the
 * same phases against a one-item set.
 */
export class Indexer {
  constructor(
    private db: Db,
    private vault: Vault,
    private nodes: NodeStore,
    private edges: EdgeStore
  ) {}

  /** Rebuild the whole index from disk. Safe to run at any time. */
  fullReindex(): IndexReport {
    const started = Date.now()
    const report: IndexReport = {
      scanned: 0, created: 0, updated: 0, unchanged: 0, removed: 0,
      edges: 0, stubs: 0, tags: 0, durationMs: 0
    }

    const files = this.vault.listFiles()
    const knownFiles = this.nodes.fileIndex()
    const pending: PendingLinks[] = []

    this.db.transaction(() => {
      // Phase 1 — every file becomes a node so titles are resolvable.
      for (const relPath of files) {
        report.scanned++
        const known = knownFiles.get(relPath)
        const outcome = this.upsertFile(relPath, known?.contentHash ?? null)

        if (!known) report.created++
        else if (outcome.changed) report.updated++
        else report.unchanged++

        pending.push(outcome.pending)
        knownFiles.delete(relPath)
      }

      // Files indexed previously but gone from disk.
      for (const [relPath] of knownFiles) {
        this.nodes.removeByPath(relPath)
        report.removed++
      }

      // Phase 2 — resolve links and tags now that all titles exist.
      for (const item of pending) {
        const result = this.linkPass(item)
        report.edges += result.edges
        report.stubs += result.stubs
        report.tags += result.tags
      }

      this.nodes.pruneDanglingVirtuals()
    })

    report.durationMs = Date.now() - started
    log.info('full reindex complete', report)
    return report
  }

  /** Index or re-index a single file. Returns the node id, or null if skipped. */
  indexFile(relPath: string): { nodeId: string; changed: boolean } | null {
    if (!this.vault.isMarkdown(relPath) || !this.vault.exists(relPath)) return null

    return this.db.transaction(() => {
      const existing = this.nodes.getByPath(relPath)
      const outcome = this.upsertFile(relPath, existing?.contentHash ?? null)
      this.linkPass(outcome.pending)
      this.nodes.pruneDanglingVirtuals()
      return { nodeId: outcome.pending.nodeId, changed: outcome.changed }
    })
  }

  removeFile(relPath: string): string | null {
    return this.db.transaction(() => {
      const id = this.nodes.removeByPath(relPath) ?? null
      this.nodes.pruneDanglingVirtuals()
      return id
    })
  }

  handleRename(fromRel: string, toRel: string): void {
    this.db.transaction(() => {
      const node = this.nodes.getByPath(fromRel)
      if (!node) {
        this.indexFile(toRel)
        return
      }
      this.db.run('UPDATE nodes SET path = ? WHERE id = ?', [toRel, node.id])
      this.indexFile(toRel)
    })
  }

  /* ------------------------------------------------------------- internals */

  private upsertFile(
    relPath: string,
    previousHash: string | null
  ): { changed: boolean; pending: PendingLinks } {
    const raw = this.vault.read(relPath)
    const hash = contentHash(raw)
    const fallbackTitle = basename(relPath).replace(/\.md$/i, '')
    const parsed = parseNote(raw, fallbackTitle)

    const id = this.resolveNodeId(relPath, parsed.id, parsed.title)
    const changed = previousHash !== hash

    const summary = parsed.summary ?? deriveSummary(parsed.body)

    this.nodes.upsert({
      id,
      // A file always outranks the stub it may be replacing.
      kind: parsed.kind === 'stub' ? 'note' : parsed.kind,
      title: parsed.title,
      path: relPath,
      summary: summary || null,
      body: parsed.body,
      tags: parsed.tags,
      props: stripManaged(parsed.frontmatter),
      createdAt: parsed.created,
      // mtime() reports 0 when the stat fails, so fall through on falsy.
      updatedAt: parsed.updated || this.vault.mtime(relPath) || Date.now(),
      contentHash: hash,
      // The file decides: deleting the `expires` key in an editor makes a note
      // permanent again on the next index.
      expiresAt: parsed.expires ?? null
    })

    return {
      changed,
      pending: { nodeId: id, title: parsed.title, links: parsed.links, tags: parsed.tags }
    }
  }

  /**
   * Identity resolution, in priority order:
   *   1. the file's own frontmatter id, if it carries one
   *   2. the node already indexed at this path
   *   3. a stub created by a wikilink pointing at this title
   *
   * Case 3 is what makes a hollow "not written yet" node become the real note
   * while every link that pointed at it stays intact.
   */
  private resolveNodeId(relPath: string, frontmatterId: string | undefined, title: string): string {
    if (frontmatterId) return frontmatterId

    const byPath = this.nodes.getByPath(relPath)
    if (byPath) return byPath.id

    void title
    return ulid()
  }

  private linkPass(item: PendingLinks): { edges: number; stubs: number; tags: number } {
    const outgoing: { dst: string; kind: EdgeKind; weight: number; label: string | null }[] = []
    let stubs = 0
    let tags = 0

    for (const link of item.links) {
      const target = this.nodes.getByTitle(link.target)

      // A link to a note that does not exist produces no node and no edge. The
      // graph shows what exists; unwritten titles are noise on the canvas.
      if (!target || target.id === item.nodeId) continue

      outgoing.push({
        dst: target.id,
        kind: 'link',
        weight: 1,
        label: link.alias ?? null
      })
    }

    for (const tag of item.tags) {
      const tagId = virtualId('tag', tag)
      this.nodes.ensureVirtual('tag', tag, tagId)
      tags++
      outgoing.push({ dst: tagId, kind: 'tag', weight: 0.5, label: null })
    }

    // Only vault-derived edges are replaced; links added by the agent or the
    // curator have their own origin and survive re-indexing.
    this.edges.replaceFrom(item.nodeId, 'vault', outgoing)

    return { edges: outgoing.length, stubs, tags }
  }
}

const MANAGED_FRONTMATTER = new Set([
  'title', 'kind', 'tags', 'summary', 'created', 'updated', 'id', 'expires'
])

function stripManaged(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if (MANAGED_FRONTMATTER.has(key)) continue
    // Dates from YAML arrive as Date objects, which do not survive JSON cleanly.
    out[key] = value instanceof Date ? value.toISOString() : value
  }
  return out
}

export function isIndexableKind(kind: NodeKind): boolean {
  return kind !== 'tag' && kind !== 'stub'
}

import type { Db } from './sqlite'
import type {
  BrainNode,
  GraphEdgeLite,
  GraphNodeLite,
  GraphSnapshot,
  GraphStats,
  NeighborhoodResult,
  NodeKind
} from '@shared/types'
import { toEdge, toNode } from './nodes'

export interface SnapshotOptions {
  showTags?: boolean
  showStubs?: boolean
  showSimilarEdges?: boolean
  /** Hard cap so a huge vault cannot stall the renderer. */
  limit?: number
}

export class GraphStore {
  constructor(private db: Db) {}

  snapshot(opts: SnapshotOptions = {}): GraphSnapshot {
    const { showTags = true, showStubs = true, showSimilarEdges = true, limit = 6000 } = opts

    const excludedKinds: string[] = []
    if (!showTags) excludedKinds.push('tag')
    if (!showStubs) excludedKinds.push('stub')

    const kindFilter = excludedKinds.length
      ? `WHERE n.kind NOT IN (${excludedKinds.map(() => '?').join(', ')})`
      : ''

    // Degree drives node size and, when the cap bites, which nodes survive.
    const nodeRows = this.db.all<{
      id: string
      title: string
      kind: string
      tags: string
      x: number | null
      y: number | null
      z: number | null
      pinned: number
      color: string | null
      updated_at: number
      degree: number
    }>(
      `SELECT n.id, n.title, n.kind, n.tags, n.x, n.y, n.z, n.pinned, n.color, n.updated_at,
              (SELECT COUNT(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id) AS degree
       FROM nodes n
       ${kindFilter}
       -- A tag that only one note carries connects nothing, so it is noise on the
       -- canvas. It stays in the index and reappears the moment a second note
       -- picks it up.
       ${kindFilter ? 'AND' : 'WHERE'} (
         n.kind <> 'tag'
         OR (SELECT COUNT(*) FROM edges e WHERE e.dst = n.id OR e.src = n.id) > 1
       )
       ORDER BY degree DESC, n.updated_at DESC
       LIMIT ?`,
      [...excludedKinds, limit]
    )

    const nodes: GraphNodeLite[] = nodeRows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind as NodeKind,
      tags: safeTags(r.tags),
      degree: r.degree,
      x: r.x,
      y: r.y,
      z: r.z,
      pinned: r.pinned === 1,
      color: r.color,
      updatedAt: r.updated_at
    }))

    const present = new Set(nodes.map((n) => n.id))

    const edgeFilter = showSimilarEdges ? '' : "WHERE kind <> 'similar'"
    const edgeRows = this.db.all<{ src: string; dst: string; kind: string; weight: number }>(
      `SELECT src, dst, kind, weight FROM edges ${edgeFilter}`
    )

    const edges: GraphEdgeLite[] = []
    for (const r of edgeRows) {
      // Drop edges whose endpoints were filtered or capped out, otherwise the
      // force simulation would reference nodes it does not have.
      if (!present.has(r.src) || !present.has(r.dst)) continue
      edges.push({ src: r.src, dst: r.dst, kind: r.kind as GraphEdgeLite['kind'], weight: r.weight })
    }

    return { nodes, edges, stamp: Date.now() }
  }

  stats(): GraphStats {
    const counts = this.db.all<{ kind: string; c: number }>(
      'SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind'
    )
    const byKind = Object.fromEntries(counts.map((r) => [r.kind, r.c])) as Record<string, number>

    const nodeCount = this.db.pluck<number>('SELECT COUNT(*) FROM nodes') ?? 0
    const edgeCount = this.db.pluck<number>('SELECT COUNT(*) FROM edges') ?? 0
    const orphans =
      this.db.pluck<number>(
        `SELECT COUNT(*) FROM nodes n
         WHERE n.path IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = n.id OR e.dst = n.id)`
      ) ?? 0

    // "Notes" means everything backed by a file, whatever kind the frontmatter
    // declares — a note with `kind: project` is still a note the user wrote.
    const noteCount = this.db.pluck<number>('SELECT COUNT(*) FROM nodes WHERE path IS NOT NULL') ?? 0

    return {
      nodes: nodeCount,
      edges: edgeCount,
      notes: noteCount,
      tags: byKind['tag'] ?? 0,
      stubs: byKind['stub'] ?? 0,
      orphans,
      clusters: this.countClusters()
    }
  }

  /** Connected components, computed in memory — cheap at personal-vault scale. */
  countClusters(): number {
    const nodeIds = this.db.all<{ id: string }>('SELECT id FROM nodes').map((r) => r.id)
    const edges = this.db.all<{ src: string; dst: string }>('SELECT src, dst FROM edges')

    const adjacency = new Map<string, string[]>()
    for (const id of nodeIds) adjacency.set(id, [])
    for (const e of edges) {
      adjacency.get(e.src)?.push(e.dst)
      adjacency.get(e.dst)?.push(e.src)
    }

    const seen = new Set<string>()
    let clusters = 0

    for (const id of nodeIds) {
      if (seen.has(id)) continue
      clusters++
      const queue = [id]
      seen.add(id)
      while (queue.length) {
        const current = queue.pop()!
        for (const next of adjacency.get(current) ?? []) {
          if (seen.has(next)) continue
          seen.add(next)
          queue.push(next)
        }
      }
    }

    return clusters
  }

  neighborhood(id: string, depth = 1): NeighborhoodResult {
    const collected = new Set<string>([id])
    let frontier = [id]

    for (let d = 0; d < Math.max(0, Math.min(depth, 3)); d++) {
      if (frontier.length === 0) break
      const placeholders = frontier.map(() => '?').join(', ')
      const rows = this.db.all<{ src: string; dst: string }>(
        `SELECT src, dst FROM edges WHERE src IN (${placeholders}) OR dst IN (${placeholders})`,
        [...frontier, ...frontier]
      )
      const next: string[] = []
      for (const r of rows) {
        for (const candidate of [r.src, r.dst]) {
          if (collected.has(candidate)) continue
          collected.add(candidate)
          next.push(candidate)
        }
      }
      frontier = next
    }

    const ids = [...collected]
    if (ids.length === 0) return { center: id, nodes: [], edges: [] }

    const placeholders = ids.map(() => '?').join(', ')
    const nodes = this.db
      .all<never>(
        `SELECT n.*, (SELECT COUNT(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id) AS degree
         FROM nodes n WHERE n.id IN (${placeholders})`,
        ids
      )
      .map(toNode)

    const edges = this.db
      .all<never>(
        `SELECT * FROM edges WHERE src IN (${placeholders}) AND dst IN (${placeholders})`,
        [...ids, ...ids]
      )
      .map(toEdge)

    return { center: id, nodes, edges }
  }

  /** Best-connected notes — the entry points into the vault. */
  hubs(limit = 12): BrainNode[] {
    return this.db
      .all<never>(
        `SELECT n.*, (SELECT COUNT(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id) AS degree
         FROM nodes n
         WHERE n.path IS NOT NULL
         ORDER BY degree DESC, n.updated_at DESC
         LIMIT ?`,
        [limit]
      )
      .map(toNode)
  }

  /** Real notes with no relations at all — the curator's main work queue. */
  orphans(limit = 50): BrainNode[] {
    return this.db
      .all<never>(
        `SELECT n.*, 0 AS degree FROM nodes n
         WHERE n.path IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = n.id OR e.dst = n.id)
         ORDER BY n.updated_at DESC
         LIMIT ?`,
        [limit]
      )
      .map(toNode)
  }

  /** Notes referenced by a wikilink but never written. */
  stubs(limit = 50): BrainNode[] {
    return this.db
      .all<never>(
        `SELECT n.*, (SELECT COUNT(*) FROM edges e WHERE e.dst = n.id) AS degree
         FROM nodes n WHERE n.kind = 'stub'
         ORDER BY degree DESC LIMIT ?`,
        [limit]
      )
      .map(toNode)
  }

  /** Persisted layout positions, so the graph reopens where the user left it. */
  positions(): Map<string, { x: number; y: number; z: number }> {
    // z is not in the WHERE clause on purpose. It arrived in a later migration, so a
    // vault laid out before it has x and y and a null depth — requiring all three would
    // silently discard every one of those positions and re-settle the whole graph.
    const rows = this.db.all<{ id: string; x: number; y: number; z: number | null }>(
      'SELECT id, x, y, z FROM nodes WHERE x IS NOT NULL AND y IS NOT NULL'
    )
    return new Map(rows.map((r) => [r.id, { x: r.x, y: r.y, z: r.z ?? 0 }]))
  }
}

function safeTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

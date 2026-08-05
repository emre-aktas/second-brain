import type { Db, SqlValue } from './sqlite'
import type { BrainNode, BrainEdge, EdgeKind, EdgeOrigin, NodeKind } from '@shared/types'
import { edgeId, ulid } from '../util/id'
import { titleKey } from '../util/slug'

interface NodeRow {
  id: string
  kind: string
  title: string
  title_key: string
  path: string | null
  summary: string | null
  body: string
  tags: string
  props: string
  pinned: number
  x: number | null
  y: number | null
  color: string | null
  created_at: number
  updated_at: number
  accessed_at: number | null
  content_hash: string | null
  expires_at: number | null
  degree?: number
}

interface EdgeRow {
  id: string
  src: string
  dst: string
  kind: string
  weight: number
  label: string | null
  origin: string
  created_at: number
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function toNode(row: NodeRow): BrainNode {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    title: row.title,
    path: row.path,
    summary: row.summary,
    body: row.body,
    tags: parseJson<string[]>(row.tags, []),
    props: parseJson<Record<string, unknown>>(row.props, {}),
    pinned: row.pinned === 1,
    x: row.x,
    y: row.y,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    contentHash: row.content_hash,
    expiresAt: row.expires_at,
    degree: row.degree ?? 0
  }
}

export function toEdge(row: EdgeRow): BrainEdge {
  return {
    id: row.id,
    src: row.src,
    dst: row.dst,
    kind: row.kind as EdgeKind,
    weight: row.weight,
    label: row.label,
    origin: row.origin as EdgeOrigin,
    createdAt: row.created_at
  }
}

export interface NodeUpsert {
  id?: string
  kind: NodeKind
  title: string
  path?: string | null
  summary?: string | null
  body?: string
  tags?: string[]
  props?: Record<string, unknown>
  color?: string | null
  createdAt?: number
  updatedAt?: number
  contentHash?: string | null
  /** Null clears it, making the note permanent. Undefined leaves it as it was. */
  expiresAt?: number | null
}

export interface SearchHit {
  node: BrainNode
  score: number
  excerpt: string
}

export interface SearchOptions {
  limit?: number
  /** Restrict to specific kinds. Overrides `includeVirtual`. */
  kinds?: NodeKind[]
  /** Include tag and stub nodes, which are excluded by default. */
  includeVirtual?: boolean
}

/**
 * FTS5 stores diacritic-folded text rather than the original.
 *
 * `unicode61 remove_diacritics` only strips combining marks, so it never maps
 * Turkish dotless ı to i or ğ to g — searching "ogrenme" would miss "Öğrenme".
 * Folding both the indexed text and the query fixes that. Display text always
 * comes from `nodes`, so the folded index never reaches the UI.
 */
function foldForIndex(input: string): string {
  return titleKey(input)
}

/** Build a safe FTS5 MATCH expression with prefix matching on the last token. */
export function buildFtsQuery(input: string): string | null {
  const tokens = foldForIndex(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)

  if (tokens.length === 0) return null

  return tokens
    .map((token, i) => {
      const quoted = `"${token.replace(/"/g, '""')}"`
      return i === tokens.length - 1 ? `${quoted}*` : quoted
    })
    .join(' AND ')
}

const NODE_SELECT = `
  SELECT n.*, (
    SELECT COUNT(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id
  ) AS degree
  FROM nodes n
`

export class NodeStore {
  constructor(private db: Db) {}

  /* --------------------------------------------------------------- reads */

  getById(id: string): BrainNode | undefined {
    const row = this.db.get<NodeRow>(`${NODE_SELECT} WHERE n.id = ?`, [id])
    return row ? toNode(row) : undefined
  }

  getByPath(path: string): BrainNode | undefined {
    const row = this.db.get<NodeRow>(`${NODE_SELECT} WHERE n.path = ?`, [path])
    return row ? toNode(row) : undefined
  }

  /** Resolve a `[[wikilink]]` target by folded title. */
  getByTitle(title: string): BrainNode | undefined {
    const row = this.db.get<NodeRow>(
      `${NODE_SELECT} WHERE n.title_key = ? ORDER BY (n.kind = 'stub') ASC LIMIT 1`,
      [titleKey(title)]
    )
    return row ? toNode(row) : undefined
  }

  /** Accepts an id, a vault path or a title — what the agent tends to have. */
  resolve(ref: string): BrainNode | undefined {
    return this.getById(ref) ?? this.getByPath(ref) ?? this.getByTitle(ref)
  }

  listRecent(limit = 50): BrainNode[] {
    return this.db
      .all<NodeRow>(`${NODE_SELECT} ORDER BY n.updated_at DESC LIMIT ?`, [limit])
      .map(toNode)
  }

  listByKind(kind: NodeKind, limit = 500): BrainNode[] {
    return this.db
      .all<NodeRow>(`${NODE_SELECT} WHERE n.kind = ? ORDER BY n.updated_at DESC LIMIT ?`, [
        kind,
        limit
      ])
      .map(toNode)
  }

  listAll(): BrainNode[] {
    return this.db.all<NodeRow>(`${NODE_SELECT}`).map(toNode)
  }

  /** All indexed file paths with their hashes — drives incremental reindexing. */
  fileIndex(): Map<string, { id: string; contentHash: string | null }> {
    const rows = this.db.all<{ id: string; path: string; content_hash: string | null }>(
      'SELECT id, path, content_hash FROM nodes WHERE path IS NOT NULL'
    )
    return new Map(rows.map((r) => [r.path, { id: r.id, contentHash: r.content_hash }]))
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const { limit = 30, includeVirtual = false, kinds } = opts
    const match = buildFtsQuery(query)
    if (!match) return []

    // Tags and stubs are navigation aids, not content. A tag called "öğrenme"
    // otherwise outranks the note it describes, since its whole indexed text is
    // the query term.
    const conditions: string[] = []
    const filterParams: SqlValue[] = []

    if (kinds?.length) {
      conditions.push(`n.kind IN (${kinds.map(() => '?').join(', ')})`)
      filterParams.push(...kinds)
    } else if (!includeVirtual) {
      conditions.push("n.kind NOT IN ('tag', 'stub')")
    }

    const extraWhere = conditions.length ? `AND ${conditions.join(' AND ')}` : ''

    let rows: (NodeRow & { rank: number })[]
    try {
      rows = this.db.all<NodeRow & { rank: number }>(
        `SELECT n.*, (
           SELECT COUNT(*) FROM edges e WHERE e.src = n.id OR e.dst = n.id
         ) AS degree,
         bm25(nodes_fts, 8.0, 1.0, 3.0) AS rank
         FROM nodes_fts
         JOIN nodes n ON n.id = nodes_fts.node_id
         WHERE nodes_fts MATCH ? ${extraWhere}
         ORDER BY rank
         LIMIT ?`,
        [match, ...filterParams, limit]
      )
    } catch {
      // A malformed MATCH expression should degrade to a substring scan, never throw.
      const like = `%${query.trim()}%`
      rows = this.db
        .all<NodeRow>(
          `${NODE_SELECT} WHERE (n.title LIKE ? OR n.body LIKE ?) ${extraWhere}
           ORDER BY n.updated_at DESC LIMIT ?`,
          [like, like, ...filterParams, limit]
        )
        .map((r) => ({ ...r, rank: 0 }))
    }

    return rows.map((row) => ({
      node: toNode(row),
      // bm25 returns negative numbers where more negative is better.
      score: row.rank ? -row.rank : 0,
      excerpt: makeExcerpt(row.body, query)
    }))
  }

  countByKind(): Record<string, number> {
    const rows = this.db.all<{ kind: string; c: number }>(
      'SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind'
    )
    return Object.fromEntries(rows.map((r) => [r.kind, r.c]))
  }

  /* -------------------------------------------------------------- writes */

  upsert(input: NodeUpsert): BrainNode {
    const now = Date.now()
    const id = input.id ?? (input.path ? this.idForPath(input.path) : ulid())

    return this.db.transaction(() => {
      const existing = this.db.get<{ id: string; created_at: number }>(
        'SELECT id, created_at FROM nodes WHERE id = ?',
        [id]
      )

      const body = input.body ?? ''
      const tags = JSON.stringify(input.tags ?? [])
      const props = JSON.stringify(input.props ?? {})

      this.db.run(
        `INSERT INTO nodes (
           id, kind, title, title_key, path, summary, body, tags, props,
           pinned, color, created_at, updated_at, content_hash, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           title = excluded.title,
           title_key = excluded.title_key,
           path = excluded.path,
           summary = excluded.summary,
           body = excluded.body,
           tags = excluded.tags,
           props = excluded.props,
           color = COALESCE(excluded.color, nodes.color),
           updated_at = excluded.updated_at,
           content_hash = excluded.content_hash,
           expires_at = excluded.expires_at`,
        [
          id,
          input.kind,
          input.title,
          titleKey(input.title),
          input.path ?? null,
          input.summary ?? null,
          body,
          tags,
          props,
          input.color ?? null,
          existing?.created_at ?? input.createdAt ?? now,
          input.updatedAt ?? now,
          input.contentHash ?? null,
          input.expiresAt ?? null
        ]
      )

      this.syncFts(id, input.title, body, input.tags ?? [])
      return this.getById(id)!
    })
  }

  private syncFts(id: string, title: string, body: string, tags: string[]): void {
    this.db.run('DELETE FROM nodes_fts WHERE node_id = ?', [id])
    this.db.run('INSERT INTO nodes_fts (node_id, title, body, tags) VALUES (?, ?, ?, ?)', [
      id,
      foldForIndex(title),
      foldForIndex(body),
      foldForIndex(tags.join(' '))
    ])
  }

  /** Deterministic id from a vault path, so reindexing keeps node identity. */
  private idForPath(path: string): string {
    const existing = this.db.get<{ id: string }>('SELECT id FROM nodes WHERE path = ?', [path])
    return existing?.id ?? ulid()
  }

  setPosition(id: string, x: number | null, y: number | null): void {
    this.db.run('UPDATE nodes SET x = ?, y = ? WHERE id = ?', [x, y, id])
  }

  setPositions(positions: { id: string; x: number; y: number }[]): void {
    if (positions.length === 0) return
    this.db.transaction(() => {
      for (const p of positions) {
        this.db.run('UPDATE nodes SET x = ?, y = ? WHERE id = ?', [p.x, p.y, p.id])
      }
    })
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.run('UPDATE nodes SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id])
  }

  setSummary(id: string, summary: string | null): void {
    this.db.run('UPDATE nodes SET summary = ?, updated_at = ? WHERE id = ?', [
      summary,
      Date.now(),
      id
    ])
  }

  touch(id: string): void {
    this.db.run('UPDATE nodes SET accessed_at = ? WHERE id = ?', [Date.now(), id])
  }

  remove(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM nodes_fts WHERE node_id = ?', [id])
      this.db.run('DELETE FROM nodes WHERE id = ?', [id])
    })
  }

  removeByPath(path: string): string | undefined {
    const row = this.db.get<{ id: string }>('SELECT id FROM nodes WHERE path = ?', [path])
    if (!row) return undefined
    this.remove(row.id)
    return row.id
  }

  /**
   * Ensure a virtual node exists (tags, and the stubs that unresolved wikilinks
   * point at). Stubs are what make "notes you have not written yet" visible in
   * the graph, the way Obsidian shows them.
   */
  ensureVirtual(kind: NodeKind, title: string, id: string, color?: string): BrainNode {
    const existing = this.getById(id)
    if (existing) return existing
    return this.upsert({ id, kind, title, color: color ?? null, body: '' })
  }

  /** Virtual nodes with no remaining edges are noise; drop them. */
  pruneDanglingVirtuals(): number {
    const rows = this.db.all<{ id: string }>(
      `SELECT n.id FROM nodes n
       WHERE n.path IS NULL
         AND n.kind IN ('tag', 'stub')
         AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = n.id OR e.dst = n.id)`
    )
    for (const row of rows) this.remove(row.id)
    return rows.length
  }
}

export class EdgeStore {
  constructor(private db: Db) {}

  add(
    src: string,
    dst: string,
    kind: EdgeKind,
    opts: { weight?: number; label?: string | null; origin?: EdgeOrigin } = {}
  ): BrainEdge | undefined {
    if (src === dst) return undefined

    const id = edgeId(src, dst, kind)
    this.db.run(
      `INSERT INTO edges (id, src, dst, kind, weight, label, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(src, dst, kind) DO UPDATE SET
         weight = excluded.weight,
         label = COALESCE(excluded.label, edges.label)`,
      [
        id,
        src,
        dst,
        kind,
        opts.weight ?? 1,
        opts.label ?? null,
        opts.origin ?? 'vault',
        Date.now()
      ]
    )
    const row = this.db.get<EdgeRow>('SELECT * FROM edges WHERE id = ?', [id])
    return row ? toEdge(row) : undefined
  }

  remove(src: string, dst: string, kind?: EdgeKind): number {
    const res = kind
      ? this.db.run('DELETE FROM edges WHERE src = ? AND dst = ? AND kind = ?', [src, dst, kind])
      : this.db.run('DELETE FROM edges WHERE src = ? AND dst = ?', [src, dst])
    return res.changes
  }

  /**
   * Replace every edge that this source contributes from a given origin.
   * Reindexing a file must not clobber links the agent or curator added, so the
   * delete is scoped by origin as well as source.
   */
  replaceFrom(src: string, origin: EdgeOrigin, edges: Omit<BrainEdge, 'id' | 'createdAt' | 'src' | 'origin'>[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM edges WHERE src = ? AND origin = ?', [src, origin])
      for (const e of edges) {
        this.add(src, e.dst, e.kind, { weight: e.weight, label: e.label, origin })
      }
    })
  }

  listFor(id: string): BrainEdge[] {
    return this.db
      .all<EdgeRow>('SELECT * FROM edges WHERE src = ? OR dst = ?', [id, id])
      .map(toEdge)
  }

  outgoing(id: string): BrainEdge[] {
    return this.db.all<EdgeRow>('SELECT * FROM edges WHERE src = ?', [id]).map(toEdge)
  }

  incoming(id: string): BrainEdge[] {
    return this.db.all<EdgeRow>('SELECT * FROM edges WHERE dst = ?', [id]).map(toEdge)
  }

  exists(src: string, dst: string): boolean {
    const row = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM edges WHERE (src = ? AND dst = ?) OR (src = ? AND dst = ?)',
      [src, dst, dst, src]
    )
    return (row?.c ?? 0) > 0
  }
}

/** Short plain-text excerpt around the first query hit, for search results. */
function makeExcerpt(body: string, query: string, radius = 110): string {
  const clean = body
    .replace(/^---[\s\S]*?---\s*/, '')
    .replace(/[#*`>_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!clean) return ''

  const firstTerm = titleKey(query).split(' ')[0]
  const haystack = titleKey(clean)
  const at = firstTerm ? haystack.indexOf(firstTerm) : -1

  if (at < 0) return clean.slice(0, radius * 2).trim()

  const start = Math.max(0, at - radius)
  const end = Math.min(clean.length, at + radius)
  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`
}

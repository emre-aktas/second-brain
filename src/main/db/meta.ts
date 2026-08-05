import type { Db } from './sqlite'
import type {
  ActivityEntry,
  IntegrationHealth,
  IntegrationManifest,
  IntegrationRecord,
  Suggestion,
  SuggestionKind,
  SuggestionStatus
} from '@shared/types'
import { ulid } from '../util/id'

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/* -------------------------------------------------------------- activity */

export interface ActivityInput {
  kind: string
  actor: string
  title: string
  nodeId?: string | null
  detail?: Record<string, unknown> | null
}

export interface ActivityQuery {
  since?: number
  until?: number
  kinds?: string[]
  actors?: string[]
  nodeId?: string
  limit?: number
}

export class ActivityStore {
  constructor(private db: Db) {}

  add(input: ActivityInput): ActivityEntry {
    const ts = Date.now()
    const res = this.db.run(
      'INSERT INTO activity (ts, kind, actor, node_id, title, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [
        ts,
        input.kind,
        input.actor,
        input.nodeId ?? null,
        input.title,
        input.detail ? JSON.stringify(input.detail) : null
      ]
    )
    return {
      id: res.lastInsertRowid,
      ts,
      kind: input.kind,
      actor: input.actor,
      nodeId: input.nodeId ?? null,
      title: input.title,
      detail: input.detail ?? null
    }
  }

  list(query: ActivityQuery = {}): ActivityEntry[] {
    const where: string[] = []
    const params: (string | number)[] = []

    if (query.since !== undefined) {
      where.push('ts >= ?')
      params.push(query.since)
    }
    if (query.until !== undefined) {
      where.push('ts <= ?')
      params.push(query.until)
    }
    if (query.kinds?.length) {
      where.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`)
      params.push(...query.kinds)
    }
    if (query.actors?.length) {
      where.push(`actor IN (${query.actors.map(() => '?').join(', ')})`)
      params.push(...query.actors)
    }
    if (query.nodeId) {
      where.push('node_id = ?')
      params.push(query.nodeId)
    }

    params.push(query.limit ?? 100)

    const rows = this.db.all<{
      id: number
      ts: number
      kind: string
      actor: string
      node_id: string | null
      title: string
      detail: string | null
    }>(
      `SELECT * FROM activity
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ts DESC LIMIT ?`,
      params
    )

    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      actor: r.actor,
      nodeId: r.node_id,
      title: r.title,
      detail: parseJson<Record<string, unknown> | null>(r.detail, null)
    }))
  }

  /** Per-day counts for the activity heat strip. */
  dailyCounts(days = 30): { day: string; count: number }[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    return this.db.all<{ day: string; count: number }>(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS count
       FROM activity WHERE ts >= ?
       GROUP BY day ORDER BY day`,
      [since]
    )
  }

  prune(keepDays = 400): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    return this.db.run('DELETE FROM activity WHERE ts < ?', [cutoff]).changes
  }
}

/* ------------------------------------------------------------ suggestions */

export interface SuggestionInput {
  kind: SuggestionKind
  title: string
  rationale: string
  payload: Record<string, unknown>
  autoApplicable?: boolean
}

export class SuggestionStore {
  constructor(private db: Db) {}

  add(input: SuggestionInput): Suggestion {
    const id = ulid()
    const createdAt = Date.now()
    this.db.run(
      `INSERT INTO suggestions (id, kind, title, rationale, payload, status, auto_applicable, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        id,
        input.kind,
        input.title,
        input.rationale,
        JSON.stringify(input.payload),
        input.autoApplicable ? 1 : 0,
        createdAt
      ]
    )
    return {
      id,
      kind: input.kind,
      title: input.title,
      rationale: input.rationale,
      payload: input.payload,
      status: 'pending',
      createdAt,
      resolvedAt: null,
      autoApplicable: input.autoApplicable ?? false
    }
  }

  list(status: SuggestionStatus | 'all' = 'pending', limit = 100): Suggestion[] {
    const rows = this.db.all<{
      id: string
      kind: string
      title: string
      rationale: string
      payload: string
      status: string
      auto_applicable: number
      created_at: number
      resolved_at: number | null
    }>(
      status === 'all'
        ? 'SELECT * FROM suggestions ORDER BY created_at DESC LIMIT ?'
        : 'SELECT * FROM suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      status === 'all' ? [limit] : [status, limit]
    )

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as SuggestionKind,
      title: r.title,
      rationale: r.rationale,
      payload: parseJson<Record<string, unknown>>(r.payload, {}),
      status: r.status as SuggestionStatus,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      autoApplicable: r.auto_applicable === 1
    }))
  }

  get(id: string): Suggestion | undefined {
    return this.list('all', 1000).find((s) => s.id === id)
  }

  setStatus(id: string, status: SuggestionStatus): void {
    this.db.run('UPDATE suggestions SET status = ?, resolved_at = ? WHERE id = ?', [
      status,
      Date.now(),
      id
    ])
  }

  pendingCount(): number {
    return this.db.pluck<number>("SELECT COUNT(*) FROM suggestions WHERE status = 'pending'") ?? 0
  }

  /** Avoid proposing the same link twice, including ones already dismissed. */
  hasSimilarPending(kind: SuggestionKind, fingerprint: string): boolean {
    const row = this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM suggestions
       WHERE kind = ? AND json_extract(payload, '$.fingerprint') = ?`,
      [kind, fingerprint]
    )
    return (row?.c ?? 0) > 0
  }
}

/* ----------------------------------------------------------- integrations */

export class IntegrationStore {
  constructor(private db: Db) {}

  upsert(manifest: IntegrationManifest): IntegrationRecord {
    const now = Date.now()
    this.db.run(
      `INSERT INTO integrations (id, manifest, health, created_at, updated_at)
       VALUES (?, ?, 'unknown', ?, ?)
       ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, updated_at = excluded.updated_at`,
      [manifest.id, JSON.stringify(manifest), now, now]
    )
    return this.get(manifest.id)!
  }

  get(id: string): IntegrationRecord | undefined {
    const row = this.db.get<{
      id: string
      manifest: string
      health: string
      last_error: string | null
      last_checked_at: number | null
      tool_count: number
      created_at: number
      updated_at: number
    }>('SELECT * FROM integrations WHERE id = ?', [id])
    if (!row) return undefined

    return {
      manifest: JSON.parse(row.manifest) as IntegrationManifest,
      health: row.health as IntegrationHealth,
      lastError: row.last_error,
      lastCheckedAt: row.last_checked_at,
      toolCount: row.tool_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  list(): IntegrationRecord[] {
    const rows = this.db.all<{ id: string }>('SELECT id FROM integrations ORDER BY created_at')
    return rows.map((r) => this.get(r.id)!).filter(Boolean)
  }

  setHealth(id: string, health: IntegrationHealth, error?: string | null, toolCount?: number): void {
    this.db.run(
      `UPDATE integrations
       SET health = ?, last_error = ?, last_checked_at = ?, tool_count = COALESCE(?, tool_count)
       WHERE id = ?`,
      [health, error ?? null, Date.now(), toolCount ?? null, id]
    )
  }

  remove(id: string): void {
    this.db.run('DELETE FROM integrations WHERE id = ?', [id])
  }
}

/* ------------------------------------------------------------ agent memory */

/** Small durable scratchpad the agent controls via remember/recall. */
export class KvStore {
  constructor(private db: Db) {}

  set(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), Date.now()]
    )
  }

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', [key])
    if (!row) return undefined
    return parseJson<T | undefined>(row.v, undefined)
  }

  delete(key: string): void {
    this.db.run('DELETE FROM kv WHERE k = ?', [key])
  }

  keys(prefix?: string): string[] {
    const rows = prefix
      ? this.db.all<{ k: string }>('SELECT k FROM kv WHERE k LIKE ? ORDER BY k', [`${prefix}%`])
      : this.db.all<{ k: string }>('SELECT k FROM kv ORDER BY k')
    return rows.map((r) => r.k)
  }

  entries(prefix?: string): { key: string; value: unknown; updatedAt: number }[] {
    const rows = prefix
      ? this.db.all<{ k: string; v: string; updated_at: number }>(
          'SELECT * FROM kv WHERE k LIKE ? ORDER BY k',
          [`${prefix}%`]
        )
      : this.db.all<{ k: string; v: string; updated_at: number }>('SELECT * FROM kv ORDER BY k')
    return rows.map((r) => ({
      key: r.k,
      value: parseJson<unknown>(r.v, null),
      updatedAt: r.updated_at
    }))
  }
}

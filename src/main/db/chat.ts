import type { Db } from './sqlite'
import type { ChatBlock, ChatMessage, ChatMessageMeta, ChatSession } from '@shared/types'
import type { GenUiSpec, GenUiRecord } from '@shared/genui'
import { ulid } from '../util/id'

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export class ChatStore {
  constructor(private db: Db) {}

  /* ------------------------------------------------------------ sessions */

  createSession(title = 'New conversation'): ChatSession {
    const id = ulid()
    const now = Date.now()
    this.db.run(
      'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [id, title, now, now]
    )
    return {
      id,
      claudeSessionId: null,
      title,
      createdAt: now,
      updatedAt: now,
      archived: false,
      totalCostUsd: 0
    }
  }

  getSession(id: string): ChatSession | undefined {
    const row = this.db.get<{
      id: string
      claude_session_id: string | null
      title: string
      created_at: number
      updated_at: number
      archived: number
      total_cost_usd: number
    }>('SELECT * FROM sessions WHERE id = ?', [id])
    if (!row) return undefined

    return {
      id: row.id,
      claudeSessionId: row.claude_session_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: row.archived === 1,
      totalCostUsd: row.total_cost_usd
    }
  }

  listSessions(limit = 50, includeArchived = false): ChatSession[] {
    const rows = this.db.all<{ id: string }>(
      includeArchived
        ? 'SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?'
        : 'SELECT id FROM sessions WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?',
      [limit]
    )
    return rows.map((r) => this.getSession(r.id)!).filter(Boolean)
  }

  /** Most recent live session, or a fresh one — the app always opens into a chat. */
  currentSession(): ChatSession {
    return this.listSessions(1)[0] ?? this.createSession()
  }

  setClaudeSessionId(id: string, claudeSessionId: string): void {
    this.db.run('UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?', [
      claudeSessionId,
      Date.now(),
      id
    ])
  }

  renameSession(id: string, title: string): void {
    this.db.run('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', [
      title.slice(0, 120),
      Date.now(),
      id
    ])
  }

  addCost(id: string, usd: number): void {
    this.db.run(
      'UPDATE sessions SET total_cost_usd = total_cost_usd + ?, updated_at = ? WHERE id = ?',
      [usd, Date.now(), id]
    )
  }

  archiveSession(id: string, archived = true): void {
    this.db.run('UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?', [
      archived ? 1 : 0,
      Date.now(),
      id
    ])
  }

  deleteSession(id: string): void {
    // messages cascade via FK; genui rows are keyed loosely so clear them here.
    this.db.transaction(() => {
      this.db.run('DELETE FROM genui WHERE session_id = ?', [id])
      this.db.run('DELETE FROM sessions WHERE id = ?', [id])
    })
  }

  totalSpend(): number {
    return this.db.pluck<number>('SELECT COALESCE(SUM(total_cost_usd), 0) FROM sessions') ?? 0
  }

  /* ------------------------------------------------------------ messages */

  addMessage(message: Omit<ChatMessage, 'id'> & { id?: string }): ChatMessage {
    const id = message.id ?? ulid()
    this.db.run(
      'INSERT INTO messages (id, session_id, role, blocks, ts, meta) VALUES (?, ?, ?, ?, ?, ?)',
      [
        id,
        message.sessionId,
        message.role,
        JSON.stringify(message.blocks),
        message.ts,
        message.meta ? JSON.stringify(message.meta) : null
      ]
    )
    this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [message.ts, message.sessionId])
    return { ...message, id }
  }

  updateMessage(id: string, blocks: ChatBlock[], meta?: ChatMessageMeta): void {
    this.db.run('UPDATE messages SET blocks = ?, meta = COALESCE(?, meta) WHERE id = ?', [
      JSON.stringify(blocks),
      meta ? JSON.stringify(meta) : null,
      id
    ])
  }

  listMessages(sessionId: string, limit = 500): ChatMessage[] {
    const rows = this.db.all<{
      id: string
      session_id: string
      role: string
      blocks: string
      ts: number
      meta: string | null
    }>('SELECT * FROM messages WHERE session_id = ? ORDER BY ts ASC LIMIT ?', [sessionId, limit])

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role as ChatMessage['role'],
      blocks: parseJson<ChatBlock[]>(r.blocks, []),
      ts: r.ts,
      meta: parseJson<ChatMessageMeta | undefined>(r.meta, undefined)
    }))
  }

  messageCount(sessionId: string): number {
    return (
      this.db.pluck<number>('SELECT COUNT(*) FROM messages WHERE session_id = ?', [sessionId]) ?? 0
    )
  }

  /* --------------------------------------------------------------- genui */

  /**
   * Generated UI specs are stored separately from the message that produced
   * them: a spec can be large, is re-openable on its own, and the message only
   * needs to carry a reference.
   */
  addGenUi(spec: GenUiSpec, sessionId: string, messageId: string | null): GenUiRecord {
    const id = ulid()
    const createdAt = Date.now()
    this.db.run(
      'INSERT INTO genui (id, session_id, message_id, spec, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, sessionId, messageId, JSON.stringify(spec), createdAt]
    )
    return { id, sessionId, messageId, spec, createdAt }
  }

  getGenUi(id: string): GenUiRecord | undefined {
    const row = this.db.get<{
      id: string
      session_id: string
      message_id: string | null
      spec: string
      created_at: number
    }>('SELECT * FROM genui WHERE id = ?', [id])
    if (!row) return undefined

    const spec = parseJson<GenUiSpec | null>(row.spec, null)
    if (!spec) return undefined

    return {
      id: row.id,
      sessionId: row.session_id,
      messageId: row.message_id,
      spec,
      createdAt: row.created_at
    }
  }

  listGenUiForSession(sessionId: string): GenUiRecord[] {
    const rows = this.db.all<{ id: string }>(
      'SELECT id FROM genui WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId]
    )
    return rows.map((r) => this.getGenUi(r.id)!).filter(Boolean)
  }

  attachGenUiToMessage(genUiId: string, messageId: string): void {
    this.db.run('UPDATE genui SET message_id = ? WHERE id = ?', [messageId, genUiId])
  }
}

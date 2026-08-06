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

  /**
   * Mark a chat as a tool's plumbing.
   *
   * Permanent, unlike `saved_tools.session_id`, which only ever points at the latest run.
   * Two things depend on it: a notification about any run can find its tool, and none of
   * these chats is ever listed as a conversation.
   */
  attachTool(sessionId: string, toolId: string): void {
    this.db.run('UPDATE sessions SET tool_id = ? WHERE id = ?', [toolId, sessionId])
  }

  /** The tool this chat runs for, if it is a tool's rather than the user's. */
  toolIdFor(sessionId: string): string | null {
    return this.db.pluck<string>('SELECT tool_id FROM sessions WHERE id = ?', [sessionId]) ?? null
  }

  /**
   * The user's conversations.
   *
   * Tool runs are excluded even with `includeArchived`, and that is the point rather than a
   * side effect of them being archived: a tool's chat holds a generated prompt and the
   * agent's answer to it, which read as the app talking to itself. The interface the user
   * pressed a button in is where that work belongs, and it is the only place it appears.
   */
  listSessions(limit = 50, includeArchived = false): ChatSession[] {
    const rows = this.db.all<{ id: string }>(
      includeArchived
        ? 'SELECT id FROM sessions WHERE tool_id IS NULL ORDER BY updated_at DESC LIMIT ?'
        : 'SELECT id FROM sessions WHERE tool_id IS NULL AND archived = 0 ORDER BY updated_at DESC LIMIT ?',
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

  /**
   * Rewrite a message's blocks, and merge anything given for its meta.
   *
   * Merged, not replaced. `meta` is one JSON column, so writing a partial object over it
   * dropped every field the caller had not thought to repeat — the run header a tool or a
   * scheduled task had put there, or the model the turn used. `COALESCE(?, meta)` only
   * covers the case of passing nothing at all.
   *
   * Returns the stored message so the caller can hand the renderer the same thing the
   * database now holds, rather than a guess at it.
   */
  updateMessage(id: string, blocks: ChatBlock[], meta?: ChatMessageMeta): ChatMessage | null {
    const merged = meta
      ? { ...(this.readMeta(id) ?? {}), ...stripUndefined(meta) }
      : this.readMeta(id)

    this.db.run('UPDATE messages SET blocks = ?, meta = COALESCE(?, meta) WHERE id = ?', [
      JSON.stringify(blocks),
      meta ? JSON.stringify(merged) : null,
      id
    ])

    const row = this.db.get<{ session_id: string; role: string; ts: number }>(
      'SELECT session_id, role, ts FROM messages WHERE id = ?',
      [id]
    )
    if (!row) return null

    return {
      id,
      sessionId: row.session_id,
      role: row.role as ChatMessage['role'],
      blocks,
      ts: row.ts,
      ...(merged && Object.keys(merged).length > 0 ? { meta: merged } : {})
    }
  }

  private readMeta(id: string): ChatMessageMeta | null {
    const raw = this.db.pluck<string>('SELECT meta FROM messages WHERE id = ?', [id])
    if (!raw) return null
    try {
      return JSON.parse(raw) as ChatMessageMeta
    } catch {
      return null
    }
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

  /**
   * How many messages in this chat came from the user.
   *
   * Used to decide whether a scheduled run's chat is disposable. A run starts with one
   * injected user message, so anything above one means a person joined in — and a
   * conversation someone had is not a record to be swept up.
   */
  userMessageCount(sessionId: string): number {
    return (
      this.db.pluck<number>(
        "SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'user'",
        [sessionId]
      ) ?? 0
    )
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

/**
 * Drop keys whose value is `undefined`.
 *
 * Spreading `{ durationMs: undefined }` over a stored meta replaces a real duration with
 * nothing — the one shape of merge bug that looks like a write succeeding.
 */
function stripUndefined(meta: ChatMessageMeta): ChatMessageMeta {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) out[key] = value
  }
  return out as ChatMessageMeta
}

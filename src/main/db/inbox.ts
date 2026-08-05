import type { Db } from './sqlite'
import type { InboxEntry, InboxKind } from '@shared/types'
import { ulid } from '../util/id'

interface InboxRow {
  id: string
  session_id: string | null
  task_id: string | null
  kind: string
  title: string
  body: string
  created_at: number
  read_at: number | null
}

function hydrate(row: InboxRow): InboxEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    kind: (row.kind as InboxKind) ?? 'reply',
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at
  }
}

export interface AddInboxEntry {
  sessionId: string | null
  taskId?: string | null
  kind: InboxKind
  title: string
  body?: string
  /** Written already-read, for something the user was plainly looking at. */
  read?: boolean
}

/**
 * What the app wanted to tell the user while they were elsewhere.
 *
 * The reason this is a table and not a derivation from `sessions.updated_at`: the
 * judgement of what is worth surfacing already exists in the notifier — it knows a
 * reply from a scheduled run from a question, and it knows the check-in's deliberate
 * silence — and recomputing that from message timestamps would conflate "the agent
 * wrote something" with "this was worth interrupting for".
 */
export class InboxStore {
  constructor(private db: Db) {}

  add(entry: AddInboxEntry): InboxEntry {
    const id = ulid()
    const now = Date.now()
    this.db.run(
      `INSERT INTO inbox (id, session_id, task_id, kind, title, body, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.sessionId,
        entry.taskId ?? null,
        entry.kind,
        entry.title.slice(0, 200),
        (entry.body ?? '').slice(0, 1000),
        now,
        entry.read ? now : null
      ]
    )
    return this.get(id)!
  }

  get(id: string): InboxEntry | undefined {
    const row = this.db.get<InboxRow>('SELECT * FROM inbox WHERE id = ?', [id])
    return row ? hydrate(row) : undefined
  }

  /** Newest first. Unread and read together — the list is a history, not a queue. */
  list(limit = 50): InboxEntry[] {
    return this.db
      .all<InboxRow>('SELECT * FROM inbox ORDER BY created_at DESC LIMIT ?', [limit])
      .map(hydrate)
  }

  unreadCount(): number {
    return this.db.pluck<number>('SELECT COUNT(*) FROM inbox WHERE read_at IS NULL') ?? 0
  }

  /** One entry, or everything when `id` is absent. */
  markRead(id?: string): void {
    if (id) {
      this.db.run('UPDATE inbox SET read_at = ? WHERE id = ? AND read_at IS NULL', [Date.now(), id])
      return
    }
    this.db.run('UPDATE inbox SET read_at = ? WHERE read_at IS NULL', [Date.now()])
  }

  /**
   * Mark everything about one chat read.
   *
   * Called whenever a session becomes the one on screen, by any route — the history
   * list, the Scheduled tab, a notification click. Without this the badge keeps
   * claiming unread after the user has plainly read the thing.
   */
  markSessionRead(sessionId: string): number {
    const before = this.unreadCount()
    this.db.run('UPDATE inbox SET read_at = ? WHERE session_id = ? AND read_at IS NULL', [
      Date.now(),
      sessionId
    ])
    return before - this.unreadCount()
  }

  /** Keep the list finite. Read entries go first, oldest first. */
  prune(keep = 200): void {
    this.db.run(
      `DELETE FROM inbox WHERE id IN (
         SELECT id FROM inbox ORDER BY created_at DESC LIMIT -1 OFFSET ?
       )`,
      [keep]
    )
  }
}

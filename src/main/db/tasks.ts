import type { Db } from './sqlite'
import type {
  AgentCapability,
  EnginePrefs,
  ScheduledTask,
  TaskKind,
  TaskRun,
  TaskStatus
} from '@shared/types'
import { normaliseSchedule, type Schedule } from '@shared/schedule'
import { parseEnginePrefs } from './tools'
import { ulid } from '../util/id'

interface TaskRow {
  id: string
  name: string
  prompt: string
  kind: string
  schedule: string
  enabled: number
  capability: string
  engine_prefs: string | null
  session_id: string | null
  created_by: string
  created_at: number
  updated_at: number
  next_run_at: number | null
  last_run_at: number | null
  last_status: string | null
  last_summary: string | null
  run_count: number
}

export interface SaveTaskInput {
  id?: string
  name: string
  prompt?: string
  kind?: TaskKind
  schedule: unknown
  enabled?: boolean
  capability?: AgentCapability
  enginePrefs?: EnginePrefs
  createdBy?: 'user' | 'agent' | 'system'
  nextRunAt?: number | null
}

function hydrate(row: TaskRow): ScheduledTask {
  let schedule: Schedule
  try {
    schedule = normaliseSchedule(JSON.parse(row.schedule))
  } catch {
    // A row whose schedule will not parse must still produce a usable task rather
    // than throwing on every list: normalising an empty object gives hourly.
    schedule = normaliseSchedule(undefined)
  }

  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    kind: row.kind === 'heartbeat' ? 'heartbeat' : 'task',
    schedule,
    enabled: row.enabled === 1,
    capability: row.capability as AgentCapability,
    enginePrefs: parseEnginePrefs(row.engine_prefs),
    sessionId: row.session_id,
    createdBy: (row.created_by as ScheduledTask['createdBy']) ?? 'user',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: (row.last_status as TaskStatus | null) ?? null,
    lastSummary: row.last_summary,
    runCount: row.run_count
  }
}

/**
 * The scheduled tasks table.
 *
 * Deliberately dumb: it stores and reads rows, and every decision about *when*
 * something runs lives in the scheduler and in `@shared/schedule`. That split is what
 * lets the schedule arithmetic be tested under plain Node with no database.
 */
export class TaskStore {
  constructor(private db: Db) {}

  save(input: SaveTaskInput): ScheduledTask {
    const now = Date.now()
    const existing = input.id ? this.get(input.id) : undefined
    const id = existing?.id ?? ulid()
    const schedule = normaliseSchedule(input.schedule)

    this.db.run(
      `INSERT INTO scheduled_tasks
         (id, name, prompt, kind, schedule, enabled, capability, engine_prefs,
          session_id, created_by, created_at, updated_at, next_run_at,
          last_run_at, last_status, last_summary, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         prompt = excluded.prompt,
         kind = excluded.kind,
         schedule = excluded.schedule,
         enabled = excluded.enabled,
         capability = excluded.capability,
         engine_prefs = excluded.engine_prefs,
         updated_at = excluded.updated_at,
         next_run_at = excluded.next_run_at`,
      [
        id,
        input.name,
        input.prompt ?? existing?.prompt ?? '',
        input.kind ?? existing?.kind ?? 'task',
        JSON.stringify(schedule),
        (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
        input.capability ?? existing?.capability ?? 'curate',
        JSON.stringify(input.enginePrefs ?? existing?.enginePrefs ?? {}),
        existing?.sessionId ?? null,
        input.createdBy ?? existing?.createdBy ?? 'user',
        existing?.createdAt ?? now,
        now,
        input.nextRunAt !== undefined ? input.nextRunAt : (existing?.nextRunAt ?? null),
        existing?.lastRunAt ?? null,
        existing?.lastStatus ?? null,
        existing?.lastSummary ?? null,
        existing?.runCount ?? 0
      ]
    )

    return this.get(id)!
  }

  get(id: string): ScheduledTask | undefined {
    const row = this.db.get<TaskRow>('SELECT * FROM scheduled_tasks WHERE id = ?', [id])
    return row ? hydrate(row) : undefined
  }

  /** The one heartbeat row, if it has been seeded. */
  heartbeat(): ScheduledTask | undefined {
    const row = this.db.get<TaskRow>(
      "SELECT * FROM scheduled_tasks WHERE kind = 'heartbeat' LIMIT 1"
    )
    return row ? hydrate(row) : undefined
  }

  list(): ScheduledTask[] {
    // Heartbeat first, then soonest-due, then newest. The Scheduled tab reads top-down
    // and "what is the app about to do" is the question it exists to answer.
    const rows = this.db.all<TaskRow>(
      `SELECT * FROM scheduled_tasks
       ORDER BY kind = 'heartbeat' DESC,
                CASE WHEN enabled = 1 AND next_run_at IS NOT NULL THEN 0 ELSE 1 END,
                next_run_at ASC,
                created_at DESC`
    )
    return rows.map(hydrate)
  }

  /**
   * Enabled tasks that are due at or before `at`.
   *
   * Ordered by how overdue they are, so a backlog after the app was closed drains
   * oldest-first rather than in whatever order the table happens to hold.
   */
  due(at: number): ScheduledTask[] {
    const rows = this.db.all<TaskRow>(
      `SELECT * FROM scheduled_tasks
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
      [at]
    )
    return rows.map(hydrate)
  }

  setEnabled(id: string, enabled: boolean, nextRunAt: number | null): void {
    this.db.run(
      'UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, nextRunAt, Date.now(), id]
    )
  }

  setNextRun(id: string, nextRunAt: number | null): void {
    this.db.run('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?', [nextRunAt, id])
  }

  setSession(id: string, sessionId: string): void {
    this.db.run('UPDATE scheduled_tasks SET session_id = ? WHERE id = ?', [sessionId, id])
  }

  /**
   * Record the outcome of a run.
   *
   * `run_count` only counts turns that actually happened. A skipped run is not work
   * done, and counting it would make a task that has never had anything to do look
   * as busy as one doing something every hour.
   */
  recordRun(
    id: string,
    status: TaskStatus,
    summary: string,
    nextRunAt: number | null
  ): void {
    this.db.run(
      `UPDATE scheduled_tasks
       SET last_run_at = ?, last_status = ?, last_summary = ?, next_run_at = ?,
           run_count = run_count + ?, updated_at = ?
       WHERE id = ?`,
      [Date.now(), status, summary.slice(0, 2000), nextRunAt, status === 'skipped' ? 0 : 1, Date.now(), id]
    )
  }

  delete(id: string): void {
    this.db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id])
  }

  /** Tasks whose chat is this session, so a chat can name the task that owns it. */
  bySession(sessionId: string): ScheduledTask | undefined {
    const row = this.db.get<TaskRow>('SELECT * FROM scheduled_tasks WHERE session_id = ?', [
      sessionId
    ])
    return row ? hydrate(row) : undefined
  }
}

interface TaskRunRow {
  id: string
  task_id: string
  session_id: string | null
  status: string
  summary: string
  started_at: number
  finished_at: number | null
}

function hydrateRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    status: row.status === 'ok' || row.status === 'error' ? row.status : 'running',
    summary: row.summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}

/**
 * The history of what a scheduled task has actually done.
 *
 * Separate from the task row because a task has one schedule and many runs, and the
 * Scheduled tab's whole job is to make the second visible. The task row keeps only the
 * most recent outcome, which is what the collapsed line needs.
 */
export class TaskRunStore {
  constructor(private db: Db) {}

  /** Open a run. Called before the turn, so a crash leaves a visible 'running' row. */
  start(taskId: string, sessionId: string | null): TaskRun {
    const id = ulid()
    this.db.run(
      `INSERT INTO task_runs (id, task_id, session_id, status, summary, started_at)
       VALUES (?, ?, ?, 'running', '', ?)`,
      [id, taskId, sessionId, Date.now()]
    )
    return this.get(id)!
  }

  finish(id: string, status: 'ok' | 'error', summary: string): void {
    this.db.run(
      'UPDATE task_runs SET status = ?, summary = ?, finished_at = ? WHERE id = ?',
      [status, summary.slice(0, 2000), Date.now(), id]
    )
  }

  get(id: string): TaskRun | undefined {
    const row = this.db.get<TaskRunRow>('SELECT * FROM task_runs WHERE id = ?', [id])
    return row ? hydrateRun(row) : undefined
  }

  /** Newest first, which is the order the panel reads them in. */
  forTask(taskId: string, limit = 20): TaskRun[] {
    return this.db
      .all<TaskRunRow>(
        'SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?',
        [taskId, limit]
      )
      .map(hydrateRun)
  }

  bySession(sessionId: string): TaskRun | undefined {
    const row = this.db.get<TaskRunRow>('SELECT * FROM task_runs WHERE session_id = ?', [sessionId])
    return row ? hydrateRun(row) : undefined
  }

  /**
   * A run left 'running' by a crash or a kill.
   *
   * Called at startup: nothing else would ever close these, and a row stuck on
   * 'running' for ever reads as "still working" in the panel.
   */
  closeStale(): number {
    const stale = this.db.all<TaskRunRow>("SELECT * FROM task_runs WHERE status = 'running'")
    for (const row of stale) {
      this.finish(row.id, 'error', 'The app closed before this run finished.')
    }
    return stale.length
  }

  /**
   * Which run chats are safe to delete, oldest first past `keep`.
   *
   * Two things are never offered up. A chat the user replied in is theirs, not a
   * disposable record — the panel's whole point is that a run is openable, so a run
   * they answered is a conversation. And a session currently on screen must survive,
   * or the renderer is left pointing at a deleted row and the next message the user
   * types silently lands in a different chat.
   */
  trimmable(taskId: string, keep: number, isProtected: (sessionId: string) => boolean): string[] {
    const rows = this.db.all<TaskRunRow>(
      `SELECT * FROM task_runs
       WHERE task_id = ? AND session_id IS NOT NULL AND status <> 'running'
       ORDER BY started_at DESC`,
      [taskId]
    )
    return rows
      .slice(keep)
      .map((row) => row.session_id!)
      .filter((sessionId) => !isProtected(sessionId))
  }

  /** Forget the chat, keep the outcome. */
  clearSession(sessionId: string): void {
    this.db.run('UPDATE task_runs SET session_id = NULL WHERE session_id = ?', [sessionId])
  }

  deleteForTask(taskId: string): void {
    this.db.run('DELETE FROM task_runs WHERE task_id = ?', [taskId])
  }
}

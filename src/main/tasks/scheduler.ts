import type { BrainCore } from '../core'
import type { AgentManager } from '../agent/manager'
import type { ScheduledTask, TaskRunResult, TaskStatus } from '@shared/types'
import { describeSchedule, inQuietHours, nextRun } from '@shared/schedule'
import { createLogger } from '../logger'
import { buildHeartbeat, dueSweepSources, type HeartbeatBrief } from './heartbeat'
import type { AccountServers } from '../agent/accountServers'

const log = createLogger('tasks')

/**
 * How often the clock is checked.
 *
 * A coarse tick rather than one timer per task, and rather than a single timer armed
 * to the exact next due moment. A desktop app sleeps: a long `setTimeout` does not
 * fire on time across suspend, and the system clock can jump. Asking "what is
 * overdue?" every half minute is correct across all of that, and costs a query
 * against an indexed column.
 */
const TICK_MS = 30_000

/** Runs the app's own work on a clock. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null

  /**
   * The run in flight.
   *
   * Runs are strictly serial. Two at once would be two CLI processes competing for
   * the same vault, and their turns would interleave in the activity log with no way
   * to tell which did what — and on a subscription, two concurrent turns is twice the
   * spend for work nobody is waiting on.
   */
  private running: Promise<void> | null = null

  /** Fires whenever a task's stored state changes, so the Scheduled tab can refresh. */
  onChanged: (() => void) | null = null

  /**
   * The sessions a window currently has on screen.
   *
   * Set by the app. Retiring a chat the renderer is displaying would leave it pointing
   * at a deleted row, and the next message the user typed would silently land in a
   * different conversation.
   */
  openSessions: (() => string[]) | null = null

  constructor(
    private core: BrainCore,
    private agent: AgentManager,
    private servers: AccountServers
  ) {}

  start(): void {
    if (this.timer) return

    this.seedHeartbeat()
    this.armAll()

    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    log.info('scheduler armed')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /* ------------------------------------------------------------------ setup */

  /**
   * Make sure the built-in check-in exists.
   *
   * Seeded rather than hardcoded so it appears in the Scheduled tab like everything else
   * — the user can see it, disable it, or change when it runs. Its prompt is empty on
   * purpose: what it asks depends on what the pre-check found.
   */
  private seedHeartbeat(): void {
    if (this.core.tasks.heartbeat()) return

    this.core.tasks.save({
      name: 'Hourly check-in',
      kind: 'heartbeat',
      prompt: '',
      schedule: { kind: 'hourly', minute: 0 },
      capability: 'curate',
      createdBy: 'system'
    })
    log.info('seeded the hourly check-in')
  }

  /**
   * Give every enabled task a next-run time.
   *
   * Anything already overdue keeps its overdue time rather than being pushed forward,
   * so a task that should have run while the app was closed runs once, shortly after
   * launch. It does not run once per hour missed: `recordRun` computes the following
   * time from *now*, which collapses a backlog of any length into a single catch-up.
   */
  private armAll(): void {
    const quiet = this.core.settings.proactive.quietHours
    const now = Date.now()

    for (const task of this.core.tasks.list()) {
      if (!task.enabled) {
        if (task.nextRunAt !== null) this.core.tasks.setNextRun(task.id, null)
        continue
      }
      if (task.nextRunAt !== null) continue
      this.core.tasks.setNextRun(task.id, nextRun(task.schedule, now, quiet))
    }
  }

  /** Re-arm a task after its enabled flag or schedule changed. */
  reschedule(taskId: string): void {
    const task = this.core.tasks.get(taskId)
    if (!task) return

    const next = task.enabled
      ? nextRun(task.schedule, Date.now(), this.core.settings.proactive.quietHours)
      : null
    this.core.tasks.setNextRun(task.id, next)
    this.onChanged?.()
  }

  /* ------------------------------------------------------------------- tick */

  private async tick(): Promise<void> {
    if (this.running) return

    const settings = this.core.settings
    // The master switch covers the user's own tasks too. Someone who turns this off
    // is saying "do not start work on your own", and honouring that only for the
    // app's unprompted work would be a lie of omission.
    if (!settings.proactive.enabled) return

    const now = Date.now()
    if (inQuietHours(now, settings.proactive.quietHours)) return

    const due = this.core.tasks.due(now)
    if (due.length === 0) return

    // One per tick. The next is picked up thirty seconds later, which keeps a backlog
    // draining without ever having two turns in flight.
    const task = due.find((candidate) => candidate.kind !== 'heartbeat' || settings.proactive.heartbeat)
    if (!task) return

    this.running = this.run(task)
      .then(() => undefined)
      .catch((err) => log.error(`task "${task.name}" failed outright`, err))
      .finally(() => {
        this.running = null
      })
  }

  /* -------------------------------------------------------------------- run */

  /** Run one task now, whatever its schedule says. Used by the Scheduled tab's button. */
  async runNow(taskId: string): Promise<TaskRunResult> {
    const task = this.core.tasks.get(taskId)
    if (!task) throw new Error(`no task with id ${taskId}`)

    // Waits for whatever is running rather than refusing: the user pressed a button,
    // and "try again in a moment" is a worse answer than a short delay.
    if (this.running) await this.running.catch(() => undefined)

    let result: TaskRunResult = { taskId, status: 'error', summary: 'did not run', sessionId: null }
    this.running = this.run(task, true)
      .then((outcome) => {
        result = outcome
      })
      .finally(() => {
        this.running = null
      })
    await this.running
    return result
  }

  /**
   * External sources due a look, filtered to what the account has connected.
   *
   * Enumeration is cached for ten minutes inside AccountServers, so this is usually free;
   * when it is not, it is seconds against every server the account owns, which is why it
   * happens before the turn rather than inside the prompt.
   */
  private async sweepable(): Promise<string[]> {
    const everyHours = this.core.settings.proactive.sweep.everyHours
    if (!this.core.settings.proactive.sweep.enabled) return []

    try {
      const connected = await this.servers.connected()
      const names = connected.map((server) => server.name.toLowerCase())
      return dueSweepSources(
        this.core,
        (needle) => names.some((name) => name.includes(needle)),
        everyHours
      )
    } catch (err) {
      // A connector reading that fails is not a reason to skip the vault half.
      log.warn(`could not read the account connectors: ${String(err)}`)
      return []
    }
  }

  private async run(task: ScheduledTask, manual = false): Promise<TaskRunResult> {
    const quiet = this.core.settings.proactive.quietHours
    const finish = (status: TaskStatus, summary: string, sessionId: string | null): TaskRunResult => {
      this.core.tasks.recordRun(task.id, status, summary, nextRun(task.schedule, Date.now(), quiet))
      this.onChanged?.()
      return { taskId: task.id, status, summary, sessionId }
    }

    if (!this.agent.available) {
      return finish('skipped', 'The agent is not available — is the claude CLI installed?', null)
    }

    // The daily cap is the real guard on spend, and unattended work is exactly what
    // it exists for: a scheduled run must never be the thing that exhausts an
    // allowance the user wanted for their own conversation.
    const remaining = this.agent.remainingToday()
    if (remaining !== null && remaining <= 0) {
      return finish('skipped', "Today's budget is used up.", null)
    }

    let prompt = task.prompt
    let brief: HeartbeatBrief | null = null

    if (task.kind === 'heartbeat') {
      // Which external sources are due, and only ones the account actually has. Read
      // before the turn because it can take seconds against a couple of dozen servers,
      // and a manual run is not granted a free sweep — pressing the button would
      // otherwise consume the next scheduled one.
      const connected = manual ? [] : await this.sweepable()

      brief = buildHeartbeat(this.core, connected)
      // The whole reason the default is on. An hour in which nothing changed asks the
      // model nothing and costs nothing.
      if (!brief.worthAsking && !manual) {
        // Committed on a skip too, or the same unchanged notes look new every hour.
        brief.commit()
        return finish('skipped', brief.reason, null)
      }
      prompt = brief.prompt
    }

    if (!prompt.trim()) {
      return finish('error', 'This task has no prompt, so there is nothing to run.', null)
    }

    // A fresh chat for every run, which is the fix for the real problem: one chat per
    // task held one Claude session id, and `send` resumes it (manager.ts), so run N
    // replayed runs 1..N-1 and the context grew without limit. A new chat has no
    // session id to resume, so the process starts clean every time.
    const sessionId = this.sessionForRun(task)
    const runRow = this.core.taskRuns.start(task.id, sessionId)

    log.info(`running "${task.name}"${manual ? ' (by hand)' : ''} in session ${sessionId.slice(-6)}`)

    try {
      await this.agent.send(prompt, {
        sessionId,
        capability: task.capability,
        // Marks the injected prompt as machine-written so the chat renders the run
        // rather than showing these instructions as if the user had typed them.
        taskRun: { taskId: task.id, taskName: task.name, runId: runRow.id },
        // Nobody is watching, so it may read the outside world but not write to it.
        unattended: true,
        ...(task.model ? { model: task.model } : {}),
        ...(task.effort ? { effort: task.effort } : {})
      })

      const reply = await this.agent.awaitTurn(sessionId)
      const summary = reply.trim().slice(0, 2000) || 'Nothing to report.'

      // After the turn, not before. A check-in that writes a note makes that note
      // "changed" for the next check-in, which would then have something to report, which
      // would write another note — a self-sustaining hourly turn. Advancing the watermark
      // past the moment the pre-check looked closes that loop.
      brief?.commit()
      this.core.taskRuns.finish(runRow.id, 'ok', summary)
      this.retire(task.id, sessionId)

      this.core.recordActivity({
        kind: 'task.ran',
        actor: 'agent',
        title: `${task.name} ran`,
        detail: { taskId: task.id, sessionId, schedule: describeSchedule(task.schedule) }
      })

      return finish('ok', summary, sessionId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`task "${task.name}" did not finish: ${message}`)
      // Also on failure. A turn that errored still examined the vault, and replaying the
      // same brief every hour would spend more, not less.
      brief?.commit()
      this.core.taskRuns.finish(runRow.id, 'error', message)

      // Deliberately conditional. `awaitTurn` rejects on any error event, and one of
      // those is emitted mid-turn when the CLI reports a rate limit and then carries
      // on retrying — killing the process there would abort a turn that was going to
      // succeed. Only a process that has actually stopped working gets cleaned up,
      // and `interrupt` is used rather than a bare stop because it also releases any
      // question the turn was blocked on, which would otherwise hang for its full
      // four-minute timeout and then resolve into a dead child.
      if (!this.agent.isBusy(sessionId)) this.agent.interrupt(sessionId)

      return finish('error', message, sessionId)
    }
  }

  /**
   * A chat for one run.
   *
   * Archived from the moment it exists, so a run never appears in the recent
   * conversations list — the Scheduled tab is the door to these. `scheduled_tasks
   * .session_id` still tracks the newest run's chat, which is what the panel's
   * collapsed line opens.
   */
  private sessionForRun(task: ScheduledTask): string {
    const stamp = new Date().toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
    const session = this.core.chat.createSession(`${task.name} — ${stamp}`)
    this.core.chat.archiveSession(session.id, true)
    this.core.tasks.setSession(task.id, session.id)
    return session.id
  }

  /**
   * How many of a task's run chats are kept.
   *
   * Generous on purpose: the hourly check-in would burn through a smaller number in a
   * day, and the point of keeping them is that a run is openable weeks later. Only the
   * chats go — the run's outcome stays in `task_runs` for ever, so the history list
   * never develops holes.
   */
  private static readonly KEEP_RUN_CHATS = 40

  private retire(taskId: string, justUsed: string): void {
    const openElsewhere = new Set(this.openSessions?.() ?? [])
    const doomed = this.core.taskRuns.trimmable(taskId, Scheduler.KEEP_RUN_CHATS, (sessionId) => {
      if (sessionId === justUsed || openElsewhere.has(sessionId)) return true
      // A run the user replied in is a conversation, not a disposable record.
      return this.core.chat.userMessageCount(sessionId) > 1
    })

    for (const sessionId of doomed) {
      try {
        this.agent.interrupt(sessionId)
        this.core.taskRuns.clearSession(sessionId)
        this.core.chat.deleteSession(sessionId)
      } catch (err) {
        log.warn(`could not retire the chat for an old run: ${String(err)}`)
      }
    }
    if (doomed.length > 0) log.info(`retired ${doomed.length} old run chat(s)`)
  }
}

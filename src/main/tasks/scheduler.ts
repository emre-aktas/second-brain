import type { BrainCore } from '../core'
import type { AgentManager } from '../agent/manager'
import type { ScheduledTask, TaskRunResult, TaskStatus } from '@shared/types'
import { describeSchedule, inQuietHours, nextRun } from '@shared/schedule'
import { createLogger } from '../logger'
import { buildHeartbeat, type HeartbeatBrief } from './heartbeat'

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

  /** Fires whenever a task's stored state changes, so the Tasks tab can refresh. */
  onChanged: (() => void) | null = null

  constructor(
    private core: BrainCore,
    private agent: AgentManager
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
   * Seeded rather than hardcoded so it appears in the Tasks tab like everything else
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

  /** Run one task now, whatever its schedule says. Used by the Tasks tab's button. */
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
      brief = buildHeartbeat(this.core)
      // The whole reason the default is on. An hour in which nothing changed asks
      // the model nothing and costs nothing.
      if (!brief.worthAsking && !manual) {
        return finish('skipped', brief.reason, null)
      }
      prompt = brief.prompt
    }

    if (!prompt.trim()) {
      return finish('error', 'This task has no prompt, so there is nothing to run.', null)
    }

    // Its own chat, created on first run. A scheduled run must never appear in the
    // middle of the conversation the user is having, and keeping one thread per task
    // makes its history readable as a series — successive digests in one place.
    const sessionId = this.sessionFor(task)

    log.info(`running "${task.name}"${manual ? ' (by hand)' : ''} in session ${sessionId.slice(-6)}`)

    try {
      await this.agent.send(prompt, {
        sessionId,
        capability: task.capability,
        ...(task.model ? { model: task.model } : {}),
        ...(task.effort ? { effort: task.effort } : {})
      })

      const reply = await this.agent.awaitTurn(sessionId)
      const summary = reply.trim().slice(0, 2000) || 'Nothing to report.'

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
      return finish('error', message, sessionId)
    }
  }

  private sessionFor(task: ScheduledTask): string {
    if (task.sessionId && this.core.chat.getSession(task.sessionId)) return task.sessionId

    const session = this.core.chat.createSession(task.name)
    // Archived so it stays out of the recent-conversations list until it has
    // something to say; the Tasks tab is where these are found from.
    this.core.chat.archiveSession(session.id, true)
    this.core.tasks.setSession(task.id, session.id)
    return session.id
  }
}

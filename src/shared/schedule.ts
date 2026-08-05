/**
 * When a scheduled task should next run.
 *
 * A structured schedule rather than a cron string, for two reasons. The agent
 * creates most of these from a sentence the user typed ("every hour, scan Slack"),
 * and it is far easier to get a small tagged union right than a five-field
 * expression — a wrong cron string fails silently at the wrong time of day. And the
 * Tasks tab has to *show* the schedule; "every hour at :00" reads, `0 * * * *` does
 * not.
 *
 * Everything here is local time, because "9am" means the user's 9am. Pure and
 * dependency-free so it can be tested under plain Node.
 */

export type Schedule =
  /** Every N minutes, counted from the last run. */
  | { kind: 'interval'; everyMinutes: number }
  /** Once an hour, at a given minute past. */
  | { kind: 'hourly'; minute: number }
  /** Once a day, at a given local time. */
  | { kind: 'daily'; hour: number; minute: number }
  /** On chosen weekdays, at a given local time. 0 is Sunday. */
  | { kind: 'weekly'; days: number[]; hour: number; minute: number }

/**
 * Hours when nothing should run.
 *
 * Wraps midnight when `startHour > endHour`, which is the normal case — 23 to 7 is
 * one window, not two. A task that comes due inside it is deferred to the end of the
 * window rather than skipped, because "compile what happened overnight" is still
 * wanted at 07:00; it just should not have woken anyone at 03:00.
 */
export interface QuietHours {
  enabled: boolean
  startHour: number
  endHour: number
}

const MINUTE = 60_000

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Coerce anything into a usable schedule.
 *
 * The agent writes these, and a task with a nonsensical schedule is worse than one
 * with a boring schedule: it either never fires or fires constantly. Every field is
 * clamped, and anything unrecognisable becomes hourly.
 */
export function normaliseSchedule(input: unknown): Schedule {
  const raw = (input ?? {}) as Record<string, unknown>

  switch (raw['kind']) {
    case 'interval':
      // Floored at 5 minutes. Each run is a model turn, and a one-minute loop would
      // empty a subscription by lunchtime.
      return { kind: 'interval', everyMinutes: clampInt(raw['everyMinutes'], 5, 60 * 24 * 7, 60) }

    case 'daily':
      return {
        kind: 'daily',
        hour: clampInt(raw['hour'], 0, 23, 9),
        minute: clampInt(raw['minute'], 0, 59, 0)
      }

    case 'weekly': {
      const days = Array.isArray(raw['days'])
        ? [...new Set(raw['days'].map((d) => clampInt(d, 0, 6, 1)))].sort((a, b) => a - b)
        : [1]
      return {
        kind: 'weekly',
        days: days.length > 0 ? days : [1],
        hour: clampInt(raw['hour'], 0, 23, 9),
        minute: clampInt(raw['minute'], 0, 59, 0)
      }
    }

    case 'hourly':
    default:
      return { kind: 'hourly', minute: clampInt(raw['minute'], 0, 59, 0) }
  }
}

/** True when `time` falls inside the quiet window. */
export function inQuietHours(time: number, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false
  if (quiet.startHour === quiet.endHour) return false

  const hour = new Date(time).getHours()
  return quiet.startHour < quiet.endHour
    ? hour >= quiet.startHour && hour < quiet.endHour
    : hour >= quiet.startHour || hour < quiet.endHour
}

/** The moment the quiet window containing `time` ends. */
function quietEnds(time: number, quiet: QuietHours): number {
  const end = new Date(time)
  end.setMinutes(0, 0, 0)

  // Walk forward to the first hour outside the window. At most 24 steps, and it
  // sidesteps every wrap-around and daylight-saving edge that arithmetic on the
  // hour number would get wrong.
  for (let i = 0; i < 25; i++) {
    end.setHours(end.getHours() + 1)
    if (!inQuietHours(end.getTime(), quiet)) return end.getTime()
  }
  return time
}

/**
 * The next time this schedule is due, strictly after `after`.
 *
 * `after` is the last run for an interval schedule, and simply "now" for the
 * wall-clock kinds — an hourly task is due at the top of the hour whether or not it
 * ran last hour, which is what makes a missed run catch up once instead of drifting.
 */
export function nextRun(
  schedule: Schedule,
  after: number,
  quiet: QuietHours = { enabled: false, startHour: 0, endHour: 0 }
): number {
  const candidate = rawNextRun(schedule, after)
  return inQuietHours(candidate, quiet) ? quietEnds(candidate, quiet) : candidate
}

function rawNextRun(schedule: Schedule, after: number): number {
  switch (schedule.kind) {
    case 'interval':
      return after + schedule.everyMinutes * MINUTE

    case 'hourly': {
      const next = new Date(after)
      next.setMinutes(schedule.minute, 0, 0)
      if (next.getTime() <= after) next.setHours(next.getHours() + 1)
      return next.getTime()
    }

    case 'daily': {
      const next = new Date(after)
      next.setHours(schedule.hour, schedule.minute, 0, 0)
      if (next.getTime() <= after) next.setDate(next.getDate() + 1)
      return next.getTime()
    }

    case 'weekly': {
      const next = new Date(after)
      next.setHours(schedule.hour, schedule.minute, 0, 0)
      // At most 8 hops: seven days plus the case where today's time has passed.
      for (let i = 0; i < 8; i++) {
        if (next.getTime() > after && schedule.days.includes(next.getDay())) {
          return next.getTime()
        }
        next.setDate(next.getDate() + 1)
      }
      return next.getTime()
    }
  }
}

/** The schedule in words, for the Tasks tab and for the agent to read back. */
export function describeSchedule(schedule: Schedule): string {
  const at = (hour: number, minute: number): string =>
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

  switch (schedule.kind) {
    case 'interval': {
      const { everyMinutes } = schedule
      if (everyMinutes % (60 * 24) === 0) {
        const days = everyMinutes / (60 * 24)
        return days === 1 ? 'every day' : `every ${days} days`
      }
      if (everyMinutes % 60 === 0) {
        const hours = everyMinutes / 60
        return hours === 1 ? 'every hour' : `every ${hours} hours`
      }
      return `every ${everyMinutes} minutes`
    }

    case 'hourly':
      return schedule.minute === 0 ? 'every hour, on the hour' : `every hour at :${String(schedule.minute).padStart(2, '0')}`

    case 'daily':
      return `every day at ${at(schedule.hour, schedule.minute)}`

    case 'weekly': {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const which =
        schedule.days.length === 7
          ? 'every day'
          : schedule.days.length === 5 && schedule.days.every((d) => d >= 1 && d <= 5)
            ? 'on weekdays'
            : `on ${schedule.days.map((d) => names[d]).join(', ')}`
      return `${which} at ${at(schedule.hour, schedule.minute)}`
    }
  }
}

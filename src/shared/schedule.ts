/**
 * When a scheduled task should next run.
 *
 * A structured schedule rather than a cron string, for two reasons. The agent
 * creates most of these from a sentence the user typed ("every hour, scan Slack"),
 * and it is far easier to get a small tagged union right than a five-field
 * expression — a wrong cron string fails silently at the wrong time of day. And the
 * Scheduled tab has to *show* the schedule; "every hour at :00" reads, `0 * * * *` does
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

/** The schedule in words, for the Scheduled tab and for the agent to read back. */
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

/* ------------------------------------------------------------------ projection */

/**
 * How much of the window is already behind the reader.
 *
 * A window that begins exactly at now puts the current moment on the container's own left
 * edge, where a marker for it is indistinguishable from a border. A little elapsed time in
 * front of it is what makes the line read as a position in the day rather than as the frame
 * around one — and it costs a twenty-fourth of the axis.
 *
 * The day view gets an hour; the week view gets whatever of today has already passed, because
 * a week's worth of marks starting mid-Thursday with no Thursday morning to sit after reads as
 * though the week begins now.
 */
const LEAD_IN_MINUTES = 60

/**
 * The window a timeline covers.
 *
 * It was floored to the hour or the day, so the ticks were round numbers and most of the first
 * unit was elapsed time nobody asked for. It was then started exactly at now, which fixed that
 * and made the current moment unmarkable. This is the third answer and it keeps both halves: a
 * short lead-in so the "now" line has somewhere to be, and `axisTicks` placing the labels on
 * the round boundaries *inside* the window rather than at its start.
 */
export function timelineWindow(now: number, span: '24h' | '7d'): { from: number; until: number } {
  if (span === '24h') {
    const from = now - LEAD_IN_MINUTES * MINUTE
    return { from, until: from + 24 * 60 * MINUTE }
  }

  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  // Stepped by date, not `+ 7 * 24h`: across a DST change the latter is off by an hour, and
  // every day boundary inside the window slides with it.
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return { from: start.getTime(), until: end.getTime() }
}

/**
 * Where to label a timeline, in round units, inside the window.
 *
 * Round because "18:00" is a time the reader already knows the position of and "14:37 + 6h"
 * is arithmetic. Inside because the window starts at an arbitrary moment: the first boundary
 * is the next one *after* it, so no label sits on the left edge, where it would claim to mark
 * a time that is really just "now".
 */
export function axisTicks(from: number, until: number, span: '24h' | '7d'): number[] {
  const ticks: number[] = []
  const cursor = new Date(from)

  if (span === '24h') {
    // The next multiple of six hours. Four labels across a day is what a sidebar fits — at
    // this width three-hour spacing has neighbours touching, and two labels overlapping is
    // worse than one label missing.
    cursor.setMinutes(0, 0, 0)
    cursor.setHours(cursor.getHours() + (6 - (cursor.getHours() % 6)))
    while (cursor.getTime() < until) {
      ticks.push(cursor.getTime())
      cursor.setHours(cursor.getHours() + 6)
    }
    return ticks
  }

  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() + 1)
  while (cursor.getTime() < until) {
    ticks.push(cursor.getTime())
    cursor.setDate(cursor.getDate() + 1)
  }
  return ticks
}

/**
 * Every time a schedule comes due inside a window.
 *
 * `nextRun` answers "when is the one after this", and a timeline needs the series. Written
 * here rather than in the component because it is the same arithmetic the scheduler runs,
 * and a timeline that disagrees with the scheduler is worse than no timeline: the user would
 * be reading a promise the app has no intention of keeping.
 *
 * `firstAt` is the scheduler's own answer for the next run, and it is used verbatim when it
 * falls in the window. Recomputing it here would show a different first mark than the row
 * above it says — the two must agree, and only one of them is authoritative.
 */
export function upcomingRuns(input: {
  schedule: Schedule
  from: number
  until: number
  firstAt?: number | null
  quiet?: QuietHours
  /** A ceiling on marks, so a five-minute cadence over a week cannot stall a render. */
  limit?: number
}): { times: number[]; truncated: boolean } {
  const quiet = input.quiet ?? { enabled: false, startHour: 0, endHour: 0 }
  const limit = input.limit ?? 400
  const times: number[] = []

  let cursor = input.from
  if (input.firstAt != null && input.firstAt >= input.from && input.firstAt < input.until) {
    times.push(input.firstAt)
    cursor = input.firstAt
  }

  while (times.length < limit) {
    const next = nextRun(input.schedule, cursor, quiet)
    // Guarded because this is a render loop and the alternative is a hung window. A
    // schedule that fails to advance — a zero interval, a quiet window that swallows its
    // own end — would otherwise spin here for ever.
    if (!Number.isFinite(next) || next <= cursor) break
    cursor = next
    if (next >= input.until) break
    times.push(next)
  }

  return { times, truncated: times.length >= limit }
}

/**
 * The stretches inside a window when nothing will run.
 *
 * Drawn behind the marks because it answers the question the gaps raise: a task that says
 * "every hour" with a six-hour hole in it looks broken until you can see the hole is the
 * quiet window. Returned as spans rather than tested per pixel so the component does no
 * arithmetic of its own.
 */
export function quietSpans(
  from: number,
  until: number,
  quiet: QuietHours
): { start: number; end: number }[] {
  if (!quiet.enabled || quiet.startHour === quiet.endHour) return []

  const spans: { start: number; end: number }[] = []
  // Walked hour by hour and merged, which handles the window that wraps midnight without a
  // second code path — 23 to 7 is one span, and the arithmetic that gets that wrong is the
  // arithmetic every implementation of this gets wrong.
  const cursor = new Date(from)
  cursor.setMinutes(0, 0, 0)

  for (let time = cursor.getTime(); time < until; time += 60 * MINUTE) {
    if (!inQuietHours(time, quiet)) continue
    const start = Math.max(from, time)
    const end = Math.min(until, time + 60 * MINUTE)
    const last = spans[spans.length - 1]
    if (last && last.end >= start) last.end = end
    else spans.push({ start, end })
  }

  return spans
}

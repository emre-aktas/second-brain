/**
 * Schedule arithmetic. Every case here is one a task would actually hit.
 *
 *   node scripts/run-ts.mjs src/shared/schedule.test.ts --node
 */
import {
  axisTicks,
  describeSchedule,
  inQuietHours,
  nextRun,
  normaliseSchedule,
  quietSpans,
  timelineWindow,
  upcomingRuns,
  type QuietHours,
  type Schedule
} from './schedule'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  console.log(`        expected ${JSON.stringify(expected)}`)
  console.log(`        actual   ${JSON.stringify(actual)}`)
}

/** A local-time literal, so the expectations read as the times a user would say. */
function at(text: string): number {
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/)
  if (!m) throw new Error(`bad time: ${text}`)
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    0,
    0
  ).getTime()
}

function show(time: number): string {
  const d = new Date(time)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const noQuiet: QuietHours = { enabled: false, startHour: 0, endHour: 0 }

console.log('schedule\n')

/* ------------------------------------------------------------- normalising */

check('unknown kind becomes hourly', normaliseSchedule({ kind: 'nope' }), {
  kind: 'hourly',
  minute: 0
})
check('undefined becomes hourly', normaliseSchedule(undefined), { kind: 'hourly', minute: 0 })

// The floor that matters: each run is a model turn, so a one-minute loop would empty
// a subscription before anyone noticed.
check('interval is floored at 5 minutes', normaliseSchedule({ kind: 'interval', everyMinutes: 1 }), {
  kind: 'interval',
  everyMinutes: 5
})
check(
  'a nonsense interval falls back to an hour',
  normaliseSchedule({ kind: 'interval', everyMinutes: 'soon' }),
  { kind: 'interval', everyMinutes: 60 }
)
check('an out-of-range hour is clamped', normaliseSchedule({ kind: 'daily', hour: 99 }), {
  kind: 'daily',
  hour: 23,
  minute: 0
})
check(
  'weekly days are deduped and sorted',
  normaliseSchedule({ kind: 'weekly', days: [5, 1, 5], hour: 9, minute: 30 }),
  { kind: 'weekly', days: [1, 5], hour: 9, minute: 30 }
)
check('weekly with no days defaults to Monday', normaliseSchedule({ kind: 'weekly', days: [] }), {
  kind: 'weekly',
  days: [1],
  hour: 9,
  minute: 0
})

/* ------------------------------------------------------------------- hourly */

console.log('\nhourly')
check(
  'mid-hour goes to the next top of the hour',
  show(nextRun({ kind: 'hourly', minute: 0 }, at('2026-08-05 14:23'), noQuiet)),
  '2026-08-05 15:00'
)
check(
  'exactly on the hour goes to the next one, never the same instant',
  show(nextRun({ kind: 'hourly', minute: 0 }, at('2026-08-05 14:00'), noQuiet)),
  '2026-08-05 15:00'
)
check(
  'a minute offset is respected',
  show(nextRun({ kind: 'hourly', minute: 30 }, at('2026-08-05 14:05'), noQuiet)),
  '2026-08-05 14:30'
)
check(
  'and rolls the hour when it has passed',
  show(nextRun({ kind: 'hourly', minute: 30 }, at('2026-08-05 14:45'), noQuiet)),
  '2026-08-05 15:30'
)
check(
  'crosses midnight',
  show(nextRun({ kind: 'hourly', minute: 0 }, at('2026-08-05 23:10'), noQuiet)),
  '2026-08-06 00:00'
)

/* -------------------------------------------------------------------- daily */

console.log('\ndaily and weekly')
check(
  'before the time today, it is today',
  show(nextRun({ kind: 'daily', hour: 9, minute: 0 }, at('2026-08-05 07:00'), noQuiet)),
  '2026-08-05 09:00'
)
check(
  'after the time today, it is tomorrow',
  show(nextRun({ kind: 'daily', hour: 9, minute: 0 }, at('2026-08-05 10:00'), noQuiet)),
  '2026-08-06 09:00'
)
check(
  'crosses a month boundary',
  show(nextRun({ kind: 'daily', hour: 8, minute: 0 }, at('2026-08-31 09:00'), noQuiet)),
  '2026-09-01 08:00'
)

// 2026-08-05 is a Wednesday.
const weekdays: Schedule = { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
check(
  'a weekday schedule on a Wednesday morning fires the same day',
  show(nextRun(weekdays, at('2026-08-05 07:00'), noQuiet)),
  '2026-08-05 09:00'
)
check(
  'and on Friday afternoon skips the weekend',
  show(nextRun(weekdays, at('2026-08-07 12:00'), noQuiet)),
  '2026-08-10 09:00'
)
check(
  'a Sunday-only schedule waits for Sunday',
  show(nextRun({ kind: 'weekly', days: [0], hour: 10, minute: 0 }, at('2026-08-05 12:00'), noQuiet)),
  '2026-08-09 10:00'
)

/* --------------------------------------------------------------- interval */

console.log('\ninterval')
check(
  'counts forward from the last run',
  show(nextRun({ kind: 'interval', everyMinutes: 90 }, at('2026-08-05 14:00'), noQuiet)),
  '2026-08-05 15:30'
)

/* ------------------------------------------------------------ quiet hours */

console.log('\nquiet hours')
const overnight: QuietHours = { enabled: true, startHour: 23, endHour: 7 }

// A window that wraps midnight is one window, not two — the bug a naive
// start <= hour < end comparison would introduce.
check('01:00 is inside 23-07', inQuietHours(at('2026-08-05 01:00'), overnight), true)
check('23:30 is inside 23-07', inQuietHours(at('2026-08-05 23:30'), overnight), true)
check('12:00 is outside 23-07', inQuietHours(at('2026-08-05 12:00'), overnight), false)
check('07:00 is outside 23-07', inQuietHours(at('2026-08-05 07:00'), overnight), false)
check('disabled is never quiet', inQuietHours(at('2026-08-05 03:00'), { ...overnight, enabled: false }), false)

// Deferred to the end of the window rather than skipped: "what happened overnight"
// is still wanted at 07:00, it just should not have woken anyone at 03:00.
check(
  'a 03:00 run is deferred to the end of the window',
  show(nextRun({ kind: 'hourly', minute: 0 }, at('2026-08-05 02:10'), overnight)),
  '2026-08-05 07:00'
)
check(
  'a 23:00 run is pushed to the far side of the window, next morning',
  show(nextRun({ kind: 'hourly', minute: 0 }, at('2026-08-05 22:40'), overnight)),
  '2026-08-06 07:00'
)
check(
  'a daily 03:00 task lands at 07:00',
  show(nextRun({ kind: 'daily', hour: 3, minute: 0 }, at('2026-08-05 12:00'), overnight)),
  '2026-08-06 07:00'
)
check(
  'a run outside the window is untouched',
  show(nextRun({ kind: 'hourly', minute: 0 }, at('2026-08-05 14:23'), overnight)),
  '2026-08-05 15:00'
)

/* ----------------------------------------------------------------- wording */

console.log('\nwording')
check('hourly on the hour', describeSchedule({ kind: 'hourly', minute: 0 }), 'every hour, on the hour')
check('hourly at :15', describeSchedule({ kind: 'hourly', minute: 15 }), 'every hour at :15')
check('interval of one hour', describeSchedule({ kind: 'interval', everyMinutes: 60 }), 'every hour')
check('interval of three hours', describeSchedule({ kind: 'interval', everyMinutes: 180 }), 'every 3 hours')
check('interval of 45 minutes', describeSchedule({ kind: 'interval', everyMinutes: 45 }), 'every 45 minutes')
check('interval of a day', describeSchedule({ kind: 'interval', everyMinutes: 1440 }), 'every day')
check('daily', describeSchedule({ kind: 'daily', hour: 9, minute: 5 }), 'every day at 09:05')
check('weekdays', describeSchedule(weekdays), 'on weekdays at 09:00')
check(
  'named days',
  describeSchedule({ kind: 'weekly', days: [1, 4], hour: 18, minute: 0 }),
  'on Mon, Thu at 18:00'
)
check(
  'all seven days',
  describeSchedule({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], hour: 8, minute: 0 }),
  'every day at 08:00'
)

/* -------------------------------------------------------------- the timeline */

console.log('\nthe window a timeline covers')
{
  const NOW = at('2026-08-06 14:37')

  // A short lead-in, so the "now" marker has somewhere to be. Started exactly at now, the
  // present sits on the container's own left edge, where a line for it is indistinguishable
  // from a border.
  const window24 = timelineWindow(NOW, '24h')
  check('24h starts an hour back', show(window24.from), '2026-08-06 13:37')
  check('and still covers a day', (window24.until - window24.from) / 3_600_000, 24)
  check('so now is inside it', window24.from < NOW && NOW < window24.until, true)

  const window7 = timelineWindow(NOW, '7d')
  // A week's lead-in is the part of today that has passed: a week of marks starting
  // mid-Thursday with no Thursday morning behind them reads as though the week begins now.
  check('7d starts at midnight today', show(window7.from), '2026-08-06 00:00')
  // Stepped by date rather than by 7×24h, so a DST change inside the window cannot slide
  // every day boundary in it by an hour.
  check('and ends on a day boundary', show(window7.until), '2026-08-13 00:00')

  // Round labels inside an unaligned window. The first is the next boundary *after* the
  // start, so no label sits on the left edge claiming to mark a time that is really "now".
  check(
    'a day is labelled every six hours',
    axisTicks(window24.from, window24.until, '24h').map(show),
    ['2026-08-06 18:00', '2026-08-07 00:00', '2026-08-07 06:00', '2026-08-07 12:00']
  )
  check(
    'a week is labelled once a day',
    axisTicks(window7.from, window7.until, '7d').map(show),
    [
      '2026-08-07 00:00',
      '2026-08-08 00:00',
      '2026-08-09 00:00',
      '2026-08-10 00:00',
      '2026-08-11 00:00',
      '2026-08-12 00:00'
    ]
  )
  // Starting exactly on a boundary, the first tick is the next one — not a label at 0%.
  check(
    'a tick never lands on the window start',
    axisTicks(at('2026-08-06 18:00'), at('2026-08-07 18:00'), '24h').map(show)[0],
    '2026-08-07 00:00'
  )
}

console.log('\nprojecting a series')
{
  const from = at('2026-08-06 14:00')
  const until = at('2026-08-07 14:00')

  const hourly = upcomingRuns({ schedule: { kind: 'hourly', minute: 30 }, from, until })
  check('an hourly task lands 24 times in a day', hourly.times.length, 24)
  check('the first is the next :30', show(hourly.times[0]), '2026-08-06 14:30')
  check('the last is inside the window', hourly.times[hourly.times.length - 1] < until, true)

  const daily = upcomingRuns({ schedule: { kind: 'daily', hour: 9, minute: 0 }, from, until })
  check('a daily task lands once', daily.times.map(show), ['2026-08-07 09:00'])

  // The scheduler's own answer wins for the first mark. Recomputing it here would draw a
  // first dot that disagrees with the "next run" line on the card above it, and only one of
  // the two can be right.
  const pinned = upcomingRuns({
    schedule: { kind: 'hourly', minute: 30 },
    from,
    until,
    firstAt: at('2026-08-06 14:05')
  })
  check("the scheduler's next run is used verbatim", show(pinned.times[0]), '2026-08-06 14:05')
  check('and the series continues from it', show(pinned.times[1]), '2026-08-06 14:30')

  // A run already behind us is not drawn: `nextRunAt` can be in the past for a task that
  // was due while the app was closed, and a mark to the left of *now* reads as history.
  const stale = upcomingRuns({
    schedule: { kind: 'hourly', minute: 30 },
    from,
    until,
    firstAt: at('2026-08-06 09:15')
  })
  check('a missed run is not drawn in the future', show(stale.times[0]), '2026-08-06 14:30')

  // The ceiling exists because this runs during a render. Five minutes over seven days is
  // two thousand marks, and the component draws a band instead once it sees `truncated`.
  const dense = upcomingRuns({
    schedule: { kind: 'interval', everyMinutes: 5 },
    from,
    until,
    limit: 40
  })
  check('a dense cadence is capped', dense.times.length, 40)
  check('and says so', dense.truncated, true)
  check('a sparse one does not', daily.truncated, false)

  // The guard that keeps a render loop from hanging. `normaliseSchedule` floors an interval
  // at 5 minutes, so this shape can only arrive from a hand-edited file — which is exactly
  // where it would arrive from.
  const degenerate = upcomingRuns({
    schedule: { kind: 'interval', everyMinutes: 0 },
    from,
    until
  })
  check('a zero interval terminates', degenerate.times.length, 0)
}

console.log('\nquiet stretches')
{
  const from = at('2026-08-06 00:00')
  const until = at('2026-08-07 00:00')
  // 23 to 7 is one window that wraps midnight, not two — the arithmetic every
  // implementation of this gets wrong, and the reason it is one merged sweep here.
  const spans = quietSpans(from, until, { enabled: true, startHour: 23, endHour: 7 })
  check(
    'a wrapping window is two stretches inside one day',
    spans.map((s) => `${show(s.start)} → ${show(s.end)}`),
    ['2026-08-06 00:00 → 2026-08-06 07:00', '2026-08-06 23:00 → 2026-08-07 00:00']
  )
  check('none of it leaves the window', spans.every((s) => s.start >= from && s.end <= until), true)

  const plain = quietSpans(from, until, { enabled: true, startHour: 1, endHour: 5 })
  check(
    'a same-day window is one stretch',
    plain.map((s) => `${show(s.start)} → ${show(s.end)}`),
    ['2026-08-06 01:00 → 2026-08-06 05:00']
  )
  check('disabled quiet hours shade nothing', quietSpans(from, until, { enabled: false, startHour: 1, endHour: 5 }), [])
  // Equal bounds mean "no quiet window", not "the whole day": `inQuietHours` reads that as
  // an empty range, and shading everything would claim nothing ever runs.
  check('an empty range shades nothing', quietSpans(from, until, { enabled: true, startHour: 3, endHour: 3 }), [])
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

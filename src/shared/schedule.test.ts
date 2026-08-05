/**
 * Schedule arithmetic. Every case here is one a task would actually hit.
 *
 *   node scripts/run-ts.mjs src/shared/schedule.test.ts --node
 */
import {
  describeSchedule,
  inQuietHours,
  nextRun,
  normaliseSchedule,
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

import { useEffect, useMemo, useState } from 'react'
import type { ScheduledTask } from '@shared/types'
import {
  axisTicks,
  describeSchedule,
  quietSpans,
  timelineWindow,
  upcomingRuns,
  type QuietHours
} from '@shared/schedule'
import { cn, formatRelativeTime } from '@/lib/utils'

/**
 * What is coming up, on one axis.
 *
 * The cards below answer "what is scheduled" one at a time, each stating its own next run as
 * a phrase. That is right for a single task and wrong for reading a day: six of them in a
 * column is a sorting problem the reader has to do in their head, and it hides the thing a
 * shared axis makes obvious — what lands on top of what.
 *
 * The layout matters more than it looks. This began as a Gantt: names in a column on the
 * left, tracks to the right of them. In a sidebar that column takes a quarter of the width
 * and still truncates every name to "Inbox wat…", which is a caption that has to be hovered
 * to be read, in exchange for shortening the only axis on screen. So the name sits *above*
 * its track instead. Each row is then a full-width sparkline with a legible heading, and the
 * axis keeps every pixel of the panel.
 *
 * Everything drawn comes from `upcomingRuns`, the same arithmetic the scheduler runs. A
 * timeline computing its own would eventually disagree with what the app does, and a picture
 * promising a run the scheduler will not make is worse than no picture.
 */

/**
 * Past this many marks a row stops being dots and becomes a band.
 *
 * A five-minute cadence is 288 marks in a day. Drawn individually they merge into a grey bar
 * that says less than the words "every 5 minutes" do — and it is the loudest thing on the
 * chart while being the least interesting. Past the threshold the row is a quiet band and the
 * cadence is written in its heading, where every other row states its next run.
 */
const DOT_LIMIT = 40

export function ScheduleTimeline({
  tasks,
  paused,
  quiet
}: {
  /** Only the ones that will actually run. Filtered by the caller, which owns that rule. */
  tasks: ScheduledTask[]
  /** How many are switched off, so the picture can admit what it is not showing. */
  paused: number
  quiet: QuietHours | undefined
}): React.JSX.Element | null {
  const [span, setSpan] = useState<'24h' | '7d'>('24h')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Half a minute. The marker moves about a thirtieth of a percent in that time on the
    // narrower window, so anything faster is a repaint nobody can see — and this panel stays
    // on screen for as long as the user leaves it there.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const quietEnabled = quiet?.enabled ?? false
  const quietStart = quiet?.startHour ?? 0
  const quietEnd = quiet?.endHour ?? 0

  const model = useMemo(() => {
    const hours: QuietHours = { enabled: quietEnabled, startHour: quietStart, endHour: quietEnd }
    const { from, until } = timelineWindow(now, span)

    const rows = tasks
      .map((task) => {
        const { times, truncated } = upcomingRuns({
          schedule: task.schedule,
          // The axis starts a little before now; the *projection* starts at now. Handing it
          // `from` would draw a run that was due while the app was closed as though it were
          // still coming, in the strip of elapsed time to the left of the marker.
          from: now,
          until,
          firstAt: task.nextRunAt,
          quiet: hours,
          limit: DOT_LIMIT + 1
        })
        return { task, times, dense: truncated || times.length > DOT_LIMIT }
      })
      // Soonest first, so reading down the rows is reading the order things happen. A row
      // with nothing due sinks to the bottom rather than being dropped: "this is on and
      // nothing is coming" is an answer, and a missing row looks like a bug.
      .sort((a, b) => (a.times[0] ?? Infinity) - (b.times[0] ?? Infinity))

    return {
      from,
      width: until - from,
      rows,
      quiet: quietSpans(from, until, hours),
      ticks: axisTicks(from, until, span).map((time) => ({ time, label: labelFor(time, span) }))
    }
  }, [tasks, span, now, quietEnabled, quietStart, quietEnd])

  // Nothing to place. The panel's own empty state already covers an empty schedule, and a
  // bare axis under it would be furniture.
  if (model.rows.length === 0) return null

  /** A time as a percentage across the full width. */
  const at = (time: number): string => `${((time - model.from) / model.width) * 100}%`

  return (
    <div className="rounded-lg border border-border bg-card px-3 pb-3 pt-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11.5px] font-medium text-foreground">Coming up</p>
        <div className="flex items-center gap-0.5 rounded-md bg-secondary/40 p-0.5">
          {(['24h', '7d'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSpan(option)}
              aria-pressed={span === option}
              className={cn(
                'rounded px-1.5 py-[3px] text-[10px] transition-colors duration-150 active:scale-[0.96]',
                span === option
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {option === '24h' ? '24 hours' : '7 days'}
            </button>
          ))}
        </div>
      </div>

      {/* One axis, above everything it labels. */}
      <div className="relative mt-2.5 h-3">
        {model.ticks.map((tick) => (
          <span
            key={tick.time}
            className="absolute top-0 -translate-x-1/2 text-[9.5px] leading-none tabular-nums text-muted-foreground"
            style={{ left: at(tick.time) }}
          >
            {tick.label}
          </span>
        ))}
        {/*
          Now, named as well as drawn. The line through the strips below says where; this says
          what it is, once, instead of leaving an unexplained accent line on the chart.
        */}
        <span
          className="absolute top-0 -translate-x-1/2 text-[9.5px] font-medium leading-none text-primary"
          style={{ left: at(now) }}
        >
          now
        </span>
      </div>

      <div className="relative mt-1.5">
        <div className="relative flex flex-col gap-2">
          {model.rows.map(({ task, times, dense }) => (
            <Row
              key={task.id}
              task={task}
              times={times}
              dense={dense}
              from={model.from}
              width={model.width}
              quiet={model.quiet}
              ticks={model.ticks}
              now={now}
            />
          ))}
        </div>
      </div>

      {paused > 0 && (
        <p className="mt-2.5 text-[10px] text-muted-foreground">
          {paused === 1 ? '1 paused job is not shown' : `${paused} paused jobs are not shown`}
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- one row */

function Row({
  task,
  times,
  dense,
  from,
  width,
  quiet,
  ticks,
  now
}: {
  task: ScheduledTask
  times: number[]
  dense: boolean
  from: number
  width: number
  /**
   * Shading and gridlines are drawn *inside* each track rather than once behind the block.
   *
   * Behind the block they crossed the row headings, which turned a faint background into a
   * grey rectangle sitting on top of four task names. Confined to the strips, the same two
   * layers read as what they are — the shape of the day the marks sit on.
   */
  quiet: { start: number; end: number }[]
  ticks: { time: number }[]
  now: number
}): React.JSX.Element {
  // The check-in is the app's own and always present. It takes the accent so the jobs the
  // user set up read as a set against it.
  const built = task.kind === 'heartbeat'

  // The right-hand end of the heading answers the question the row is being read for. The
  // cadence for a band, because "in 1m" for something that runs every five minutes is a true
  // answer to a question nobody asked.
  const trailing = dense
    ? describeSchedule(task.schedule)
    : times.length > 0
      ? formatRelativeTime(times[0])
      : 'nothing due'

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-[10.5px] leading-none text-muted-foreground" title={task.name}>
          {task.name}
        </p>
        {/* The answer the row is being read for, so it is the stronger of the two. */}
        <p className="shrink-0 text-[10px] leading-none tabular-nums text-foreground/75">
          {trailing}
        </p>
      </div>

      <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-[3px] bg-secondary/25">
        {quiet.map((band) => (
          <div
            key={band.start}
            aria-hidden
            className="absolute inset-y-0 bg-foreground/[0.05] dark:bg-foreground/[0.08]"
            style={{
              left: `${((band.start - from) / width) * 100}%`,
              width: `${((band.end - band.start) / width) * 100}%`
            }}
          />
        ))}

        {/* The opening boundary is left out: the strip's own edge already delimits it. */}
        {ticks.map((tick) => (
          <div
            key={tick.time}
            aria-hidden
            className="absolute inset-y-0 w-px bg-border/70"
            style={{ left: `${((tick.time - from) / width) * 100}%` }}
          />
        ))}

        {/*
          The elapsed sliver, then the line. Dimming what is behind the marker is what makes
          the marker mean "the present" rather than "a gridline in the accent colour".
        */}
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 bg-background/60"
          style={{ width: `${((now - from) / width) * 100}%` }}
        />
        <div
          aria-hidden
          data-now
          className="absolute inset-y-0 w-px bg-primary"
          style={{ left: `${((now - from) / width) * 100}%` }}
        />

        {dense ? (
          /*
            A hatch rather than a fill. At this cadence the marks *are* a band, and a solid
            one reads as the most important row on the chart; the stripes say "continuously"
            without shouting it.
          */
          <div
            className={cn(
              'absolute inset-y-[3px] left-0 right-0 rounded-full',
              built ? 'bg-primary/25' : 'bg-chart-2/25'
            )}
            title={`${task.name} — ${describeSchedule(task.schedule)}`}
          />
        ) : (
          times.map((time, index) => (
            <span
              key={time}
              title={`${task.name} — ${formatMark(time)}`}
              className={cn(
                'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full',
                // The next one answers "what happens next", so it is the only mark at full
                // strength, ringed in the card's own background so it stays legible where it
                // overlaps a gridline. The rest are the same event, later.
                index === 0
                  ? cn('size-[7px] ring-2 ring-card', built ? 'bg-primary' : 'bg-chart-2')
                  : cn('size-[5px]', built ? 'bg-primary/55' : 'bg-chart-2/55')
              )}
              style={{ left: `${((time - from) / width) * 100}%` }}
            />
          ))
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ the axis */

/**
 * What a gridline is called.
 *
 * Where they go is `axisTicks`, in the shared module, because the window and its labels have
 * to agree about what a boundary is — and because that arithmetic is worth a test. This is
 * only the wording, and it is the user's locale's wording, not ours.
 */
function labelFor(time: number, span: '24h' | '7d'): string {
  const when = new Date(time)
  return span === '24h'
    ? when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleDateString(undefined, { weekday: 'short' })
}

/** A mark's time in the user's own locale, with the day when it is not today. */
function formatMark(time: number): string {
  const when = new Date(time)
  const today = new Date()
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()

  const clock = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return clock

  const day = when.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day}, ${clock}`
}

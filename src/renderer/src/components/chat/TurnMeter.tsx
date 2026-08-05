/**
 * How long a turn took and how many tokens it spent.
 *
 * Two forms of the same readout. `LiveTurnMeter` ticks while the agent is working;
 * `TurnMeter` is the record left on the finished answer. Both are deliberately the quietest
 * thing in the transcript — the numbers are for when you go looking, not for while you read.
 *
 * The live one is a leaf that owns its own interval and nothing else. That is the whole
 * point of it being a separate file: the transcript re-renders on every text delta anyway,
 * but during a long tool call nothing re-renders at all, so the clock needs a heartbeat of
 * its own — and putting that heartbeat in `ChatPanel` would repaint the entire conversation
 * twice a second for the sake of one changing digit.
 */
import { useEffect, useState } from 'react'
import { activeChat, useApp } from '@/store/app'
import { cn } from '@/lib/utils'

/**
 * A duration, at the precision a person actually reads.
 *
 * Sub-second turns are reported in tenths because "0s" reads as a failure to measure. Past
 * a minute the seconds still matter — the difference between 1m 04s and 1m 58s is the
 * difference between two kinds of wait — so they are kept rather than rounded away.
 */
export function formatDuration(ms: number): string {
  if (ms < 950) return `${(ms / 1000).toFixed(1)}s`

  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`

  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * A token count, abbreviated.
 *
 * Thousands from 10k up, so the number stops changing width once it is large — a figure
 * that grows a digit mid-turn makes the line beside it jump.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${Math.round(tokens / 1000)}k`
}

const LINE = 'text-[10.5px] leading-none tabular-nums text-muted-foreground/70'

/**
 * The live meter, for the turn in progress.
 *
 * Reads three scalars from the store and derives everything else. Deriving rather than
 * accumulating is what makes switching chats mid-turn and coming back show the right
 * number instead of restarting from zero.
 */
export function LiveTurnMeter({ className }: { className?: string }): React.JSX.Element | null {
  const startedAt = useApp((s) => activeChat(s).turnStartedAt)
  const inputTokens = useApp((s) => activeChat(s).liveInputTokens)
  const outputTokens = useApp((s) => activeChat(s).liveOutputTokens)

  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt === null) return

    // Twice a second, so the displayed whole second is never more than a moment late. A
    // one-second interval drifts against the turn's own start and the digit visibly
    // stalls or skips.
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [startedAt])

  if (startedAt === null) return null

  const elapsed = Math.max(0, now - startedAt)

  return (
    <p className={cn(LINE, className)}>
      {formatDuration(elapsed)}
      {outputTokens > 0 && (
        <>
          {' · '}
          {formatTokens(inputTokens + outputTokens)} tokens
        </>
      )}
    </p>
  )
}

/**
 * The record on a finished answer.
 *
 * Renders nothing at all when there is nothing to say — a message written before this
 * existed has no duration, and a zero there would be a lie rather than a gap.
 */
export function TurnMeter({
  durationMs,
  inputTokens,
  outputTokens,
  className
}: {
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  className?: string
}): React.JSX.Element | null {
  const tokens =
    inputTokens === undefined && outputTokens === undefined
      ? null
      : (inputTokens ?? 0) + (outputTokens ?? 0)

  if (!durationMs && !tokens) return null

  return (
    <p className={cn(LINE, className)}>
      {durationMs ? formatDuration(durationMs) : null}
      {durationMs && tokens ? ' · ' : null}
      {tokens ? `${formatTokens(tokens)} tokens` : null}
    </p>
  )
}

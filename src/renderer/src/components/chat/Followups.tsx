/**
 * The two things this app can do that a chat cannot, offered at the end of a turn.
 *
 * Save the work as a reusable tool, or put it on a schedule. Only the agent knows whether
 * either applies to what just happened, so it decides — and it offers rather than does:
 * pressing one sends a message, which keeps the cost and the consent in the same place.
 *
 * Deliberately a small line of buttons and not a card. This appears under an answer the user
 * is still reading, and something that competes with the answer for attention would make
 * every turn feel like it ends in an upsell.
 */
import { CalendarClock, Wand2 } from 'lucide-react'
import type { TurnFollowups } from '@shared/types'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * What pressing a chip says.
 *
 * Composed here rather than by the model. The agent supplies what it learned — a name, a
 * cadence, a reason — and the app phrases the instruction, so the wording of a request the
 * app has to understand is not left to whatever the model felt like writing that turn.
 */
export function followupPrompt(kind: 'tool' | 'schedule', followups: TurnFollowups): string {
  if (kind === 'tool' && followups.tool) {
    return `Build what you just did as a saved tool called "${followups.tool.name}". Work out the inputs and the buttons from the turn above; ask me only if something is genuinely ambiguous.`
  }
  if (kind === 'schedule' && followups.schedule) {
    return `Put what you just did on a schedule: "${followups.schedule.name}", ${followups.schedule.when}. Write the task's prompt yourself from the turn above.`
  }
  return ''
}

const CHIP = [
  'inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/60',
  'px-2.5 py-1 text-[11.5px] text-muted-foreground',
  'transition-[color,background-color,border-color,transform] duration-150 ease-[var(--ease-out)]',
  'hover:border-primary/40 hover:bg-accent hover:text-foreground active:scale-[0.97]',
  'disabled:cursor-not-allowed disabled:opacity-50'
].join(' ')

export function Followups({
  followups,
  disabled,
  onChoose,
  className
}: {
  followups: TurnFollowups | undefined
  /** A turn is already running; a second one would queue behind it. */
  disabled?: boolean
  onChoose: (prompt: string) => void
  className?: string
}): React.JSX.Element | null {
  if (!followups || (!followups.tool && !followups.schedule)) return null

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {followups.tool && (
        <Tooltip content={followups.tool.why || 'Save this as a tool you can run again'}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChoose(followupPrompt('tool', followups))}
            className={CHIP}
          >
            <Wand2 className="size-3" />
            Make this a tool
          </button>
        </Tooltip>
      )}

      {followups.schedule && (
        <Tooltip
          content={followups.schedule.why || `Run this ${followups.schedule.when}`}
        >
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChoose(followupPrompt('schedule', followups))}
            className={CHIP}
          >
            <CalendarClock className="size-3" />
            {/* The cadence is on the button, not hidden in the tooltip: "Schedule this" alone
                asks the user to accept a decision they cannot see. */}
            Run it {followups.schedule.when}
          </button>
        </Tooltip>
      )}
    </div>
  )
}

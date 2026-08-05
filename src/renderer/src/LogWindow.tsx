import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Check, Copy, FolderOpen, Pause, Play, Trash2 } from 'lucide-react'
import type { LogLine } from '@shared/ipc'
import type { AgentEvent } from '@shared/types'
import { api, onEvent } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { controlsGap } from '@/lib/chrome'

/**
 * The log, live.
 *
 * Its own window so it can be watched while working in another one — which is the
 * only way to see a tool run go wrong in a third window. Two streams are merged
 * here: what the main process logs, and the agent events as the renderer receives
 * them. That second stream matters more than it sounds: the class of bug this was
 * built for was events being produced correctly and never delivered, which looks
 * identical to "nothing happened" unless you can see both ends.
 */

const LEVEL_STYLE: Record<LogLine['level'], string> = {
  debug: 'text-muted-foreground/70',
  info: 'text-foreground',
  warn: 'text-warning',
  error: 'text-destructive'
}

const LEVEL_ORDER: Record<LogLine['level'], number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function LogWindow(): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])
  const [query, setQuery] = useState('')
  const [minLevel, setMinLevel] = useState<LogLine['level']>('debug')
  const [following, setFollowing] = useState(true)
  const [copied, setCopied] = useState(false)
  const nextSeq = useRef(-1)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.getSettings().then((settings) => {
      document.documentElement.classList.toggle('dark', settings.appearance.theme !== 'light')
    })
    return onEvent('settings:changed', (settings) => {
      document.documentElement.classList.toggle('dark', settings.appearance.theme !== 'light')
    })
  }, [])

  const append = useCallback((line: LogLine) => {
    setLines((current) => {
      // Bounded, or a long session eventually stalls the window it is meant to
      // help debug.
      const next = current.length > 4000 ? current.slice(-3000) : current.slice()
      next.push(line)
      return next
    })
  }, [])

  useEffect(() => {
    void api.logTail().then((tail) => {
      setLines(tail)
      nextSeq.current = tail.length > 0 ? tail[tail.length - 1].seq : 0
    })

    const offLine = onEvent('logs:line', (line) => {
      // The tail and the live stream overlap by however long the fetch took.
      if (line.seq <= nextSeq.current) return
      nextSeq.current = line.seq
      append(line)
    })

    // Agent events as this window receives them. If the main process logs a result
    // and no line shows up here, delivery is the problem, not the agent.
    const offAgent = onEvent('agent:event', (raw) => {
      const event = raw as AgentEvent
      if (event.type === 'delta') return
      append({
        seq: -Date.now(),
        ts: Date.now(),
        level: event.type === 'error' ? 'error' : 'debug',
        scope: 'renderer:agent',
        message: describe(event)
      })
    })

    return () => {
      offLine()
      offAgent()
    }
  }, [append])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return lines.filter((line) => {
      if (LEVEL_ORDER[line.level] < LEVEL_ORDER[minLevel]) return false
      if (!needle) return true
      return (
        line.scope.toLowerCase().includes(needle) ||
        line.message.toLowerCase().includes(needle) ||
        (line.extra?.toLowerCase().includes(needle) ?? false)
      )
    })
  }, [lines, query, minLevel])

  useEffect(() => {
    if (following) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [shown, following])

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-background">
        <header
        className="app-drag flex h-9 shrink-0 items-center gap-2 border-b border-border px-3"
        style={controlsGap()}
      >
          <span className="shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground">
            Log
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
            {shown.length === lines.length
              ? `${lines.length}`
              : `${shown.length} of ${lines.length}`}
          </span>

          <div className="app-no-drag flex min-w-0 flex-1 items-center gap-1.5">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter — try “tool”, “agent”, “error”"
              className="h-6 min-w-0 flex-1 text-[12px]"
            />

            <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-secondary/70 p-0.5">
              {(['debug', 'info', 'warn', 'error'] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setMinLevel(level)}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[11px] transition-colors duration-150',
                    minLevel === level
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {level}
                </button>
              ))}
            </div>

            <IconButton
              label={following ? 'Stop following' : 'Follow new lines'}
              onClick={() => setFollowing((value) => !value)}
              active={following}
            >
              {following ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </IconButton>

            <IconButton
              label="Jump to the end"
              onClick={() => {
                setFollowing(true)
                bottomRef.current?.scrollIntoView({ block: 'end' })
              }}
            >
              <ArrowDownToLine className="size-3.5" />
            </IconButton>

            <IconButton
              label={copied ? 'Copied' : 'Copy what is shown'}
              onClick={() => {
                void navigator.clipboard.writeText(shown.map(format).join('\n'))
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              }}
            >
              {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </IconButton>

            <IconButton label="Show the log file" onClick={() => void api.revealLogFile()}>
              <FolderOpen className="size-3.5" />
            </IconButton>

            <IconButton
              label="Clear"
              onClick={() => {
                void api.clearLogs()
                setLines([])
              }}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.55]">
          {shown.length === 0 ? (
            <p className="pt-6 text-center font-sans text-[13px] text-muted-foreground">
              {lines.length === 0
                ? 'Nothing logged yet. Run something and it will appear here as it happens.'
                : 'Nothing matches that filter.'}
            </p>
          ) : (
            shown.map((line) => (
              <div key={`${line.seq}-${line.ts}`} className="flex gap-2 selectable">
                <span className="shrink-0 tabular-nums text-muted-foreground/50">
                  {clock(line.ts)}
                </span>
                <span className="w-28 shrink-0 truncate text-muted-foreground/80">
                  {line.scope}
                </span>
                <span className={cn('min-w-0 whitespace-pre-wrap', LEVEL_STYLE[line.level])}>
                  {line.message}
                  {line.extra && (
                    <span className="text-muted-foreground/70"> {line.extra}</span>
                  )}
                </span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </TooltipProvider>
  )
}

function IconButton({
  label,
  onClick,
  active,
  children
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md',
          'transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-90',
          active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function clock(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function format(line: LogLine): string {
  return `${new Date(line.ts).toISOString()} ${line.level.toUpperCase()} [${line.scope}] ${line.message}${line.extra ? ` ${line.extra}` : ''}`
}

/** One readable line per agent event, short enough to scan a whole turn. */
function describe(event: AgentEvent): string {
  const session = event.sessionId.slice(-6)
  switch (event.type) {
    case 'state':
      return `${session} state=${event.state}${event.detail ? ` (${event.detail})` : ''}`
    case 'tool-start':
      return `${session} tool-start ${event.name}`
    case 'tool-end':
      return `${session} tool-end ${event.id} ${event.status} ${event.result.length} chars`
    case 'result':
      return `${session} result ${event.isError ? 'ERROR' : 'ok'} turns=${event.numTurns} ${event.durationMs}ms text=${event.text ? `${event.text.length} chars` : 'none'}`
    case 'error':
      return `${session} error ${event.message}`
    case 'message':
      return `${session} message ${event.message.role}`
    case 'session':
      return `${session} session claude=${event.claudeSessionId.slice(-6)} tools=${event.tools?.length ?? 0}`
    default:
      return `${session} ${event.type}`
  }
}

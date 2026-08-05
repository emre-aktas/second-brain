import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CalendarClock,
  Check,
  ChevronRight,
  Loader2,
  MessageSquare,
  Moon,
  Pause,
  Play,
  Plus,
  Trash2,
  Zap
} from 'lucide-react'
import type { ScheduledTask, TaskRun } from '@shared/types'
import { describeSchedule, type Schedule } from '@shared/schedule'
import { api, errorMessage, onEvent } from '@/lib/api'
import { useApp } from '@/store/app'
import { cn, formatRelativeTime } from '@/lib/utils'
import { NativeSelect, Spinner } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/sonner'

/**
 * Everything the app does on its own clock.
 *
 * A tab rather than a settings page because an app that acts unprompted has to be
 * legible: every scheduled job is here with what it will do, when it goes next, and every
 * time it has run — each of those openable as its own conversation. One switch at the top
 * stops all of it, including the jobs the user set up themselves, because someone who
 * turns this off is saying "do not start work on your own" and honouring that for only
 * half of it would be a lie of omission.
 */
export function ScheduledPanel(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)

  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)

  const refresh = useCallback(async () => setTasks(await api.listTasks()), [])

  useEffect(() => {
    void refresh()
    return onEvent('tasks:changed', () => void refresh())
  }, [refresh])

  const proactive = settings?.proactive
  const enabled = proactive?.enabled ?? false

  const runNow = async (task: ScheduledTask): Promise<void> => {
    setBusyId(task.id)
    try {
      const result = await api.runTaskNow(task.id)
      if (result.status === 'error') toast.error(task.name, { description: result.summary })
      else if (result.status === 'skipped') toast(task.name, { description: result.summary })
      else toast.success(task.name, { description: result.summary.slice(0, 160) })
    } catch (err) {
      toast.error('Could not run it', { description: errorMessage(err) })
    } finally {
      setBusyId(null)
      void refresh()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold text-foreground">Scheduled</h2>
        <Tooltip content="Schedule something">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Schedule something"
            aria-expanded={composing}
            onClick={() => setComposing((value) => !value)}
          >
            <Plus className="size-4" />
          </Button>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2.5 px-3 py-3">
          <MasterSwitch
            enabled={enabled}
            heartbeat={proactive?.heartbeat ?? false}
            quiet={proactive?.quietHours}
            onChange={updateSettings}
          />

          {composing && (
            <Composer
              onCancel={() => setComposing(false)}
              onSaved={() => {
                setComposing(false)
                void refresh()
              }}
            />
          )}

          {tasks.length === 0 && !composing && (
            <p className="px-1 py-6 text-center text-[12.5px] leading-relaxed text-muted-foreground text-pretty">
              Nothing scheduled yet. Ask in the conversation — &ldquo;every morning,
              summarise what changed yesterday&rdquo; — or add one here.
            </p>
          )}

          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              held={!enabled || (task.kind === 'heartbeat' && !(proactive?.heartbeat ?? false))}
              busy={busyId === task.id}
              onRunNow={() => void runNow(task)}
              onToggle={() => void api.setTaskEnabled(task.id, !task.enabled).then(refresh)}
              onDelete={() => void api.removeTask(task.id).then(refresh)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

/* ------------------------------------------------------------ the master switch */

function MasterSwitch({
  enabled,
  heartbeat,
  quiet,
  onChange
}: {
  enabled: boolean
  heartbeat: boolean
  quiet: { enabled: boolean; startHour: number; endHour: number } | undefined
  onChange: (patch: Parameters<ReturnType<typeof useApp.getState>['updateSettings']>[0]) => Promise<void>
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5 transition-colors duration-150',
        enabled ? 'border-primary/30 bg-primary/8' : 'border-border bg-secondary/30'
      )}
    >
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => void onChange({ proactive: { enabled: event.target.checked } })}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-foreground">Work on its own</span>
          <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
            {enabled
              ? 'Scheduled jobs run, and the check-in looks in from time to time. Each run gets its own conversation.'
              : 'Nothing runs on a schedule — including the jobs below. The app only acts when you ask it to.'}
          </span>
        </span>
      </label>

      {enabled && quiet && (
        <div className="mt-2.5 flex flex-col gap-2 border-t border-border/60 pt-2.5">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
            <input
              type="checkbox"
              checked={heartbeat}
              onChange={(event) => void onChange({ proactive: { heartbeat: event.target.checked } })}
              className="size-3.5 accent-primary"
            />
            Check in unprompted
          </label>

          <label className="flex cursor-pointer flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
            <input
              type="checkbox"
              checked={quiet.enabled}
              onChange={(event) =>
                void onChange({ proactive: { quietHours: { enabled: event.target.checked } } })
              }
              className="size-3.5 accent-primary"
            />
            <Moon className="size-3" />
            Stay quiet between
            <HourPicker
              value={quiet.startHour}
              onChange={(startHour) => void onChange({ proactive: { quietHours: { startHour } } })}
            />
            and
            <HourPicker
              value={quiet.endHour}
              onChange={(endHour) => void onChange({ proactive: { quietHours: { endHour } } })}
            />
          </label>
        </div>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- one job */

function TaskCard({
  task,
  held,
  busy,
  onRunNow,
  onToggle,
  onDelete
}: {
  task: ScheduledTask
  /** A switch above this one is off, so nothing will run whatever this card says. */
  held: boolean
  busy: boolean
  onRunNow: () => void
  onToggle: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const builtIn = task.kind === 'heartbeat'
  const inert = held || !task.enabled

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card transition-opacity duration-150',
        inert && 'opacity-60'
      )}
    >
      <div className="flex items-start justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            {builtIn ? (
              <Zap className="size-3.5 shrink-0 text-primary" />
            ) : (
              <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{task.name}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {describeSchedule(task.schedule)}
            {task.createdBy === 'agent' && ' · set up by the agent'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip content={busy ? 'Running…' : 'Run it now'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Run ${task.name} now`}
              disabled={busy}
              onClick={onRunNow}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            </Button>
          </Tooltip>

          <Tooltip content={task.enabled ? 'Pause' : 'Resume'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={task.enabled ? `Pause ${task.name}` : `Resume ${task.name}`}
              aria-pressed={!task.enabled}
              onClick={onToggle}
            >
              {task.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </Button>
          </Tooltip>

          {/*
            The check-in is seeded on every launch, so a delete would only bring it back.
            Offering one that silently does not stick is worse than not offering it —
            pausing is the honest control.
          */}
          {!builtIn && (
            <Tooltip content="Delete">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${task.name}`}
                onClick={onDelete}
                className="text-muted-foreground/60 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      {task.prompt && (
        <p className="line-clamp-2 px-3 pb-2 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
          {task.prompt}
        </p>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} the run history for ${task.name}`}
        className={cn(
          'flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-1.5',
          'text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground'
        )}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 transition-transform duration-150 ease-[var(--ease-out)]',
            open && 'rotate-90'
          )}
        />
        <NextRun task={task} held={held} />
        <span className="ml-auto flex items-center gap-1">
          <LastOutcome task={task} />
        </span>
      </button>

      {open && <RunHistory taskId={task.id} />}
    </div>
  )
}

function NextRun({ task, held }: { task: ScheduledTask; held: boolean }): React.JSX.Element {
  if (held) return <span>held — working on its own is off</span>
  if (!task.enabled) return <span>paused</span>
  if (task.nextRunAt) return <span>next {formatRelativeTime(task.nextRunAt)}</span>
  return <span>not scheduled</span>
}

/**
 * How the last run went.
 *
 * `skipped` reads as an ordinary outcome rather than a warning, because for the check-in
 * it is the *expected* one: most of the time nothing has changed, and the design depends
 * on that costing nothing.
 */
function LastOutcome({ task }: { task: ScheduledTask }): React.JSX.Element | null {
  if (!task.lastStatus) return <span className="text-muted-foreground">never run</span>

  if (task.lastStatus === 'error') {
    return (
      <span className="flex items-center gap-1 text-destructive">
        <AlertCircle className="size-3" />
        failed
      </span>
    )
  }

  if (task.lastStatus === 'skipped') {
    return <span className="text-muted-foreground">nothing to do</span>
  }

  return (
    <span className="flex items-center gap-1 text-success">
      <Check className="size-3" />
      {task.runCount} run{task.runCount === 1 ? '' : 's'}
    </span>
  )
}

/* ------------------------------------------------------------- run history */

function RunHistory({ taskId }: { taskId: string }): React.JSX.Element {
  const switchSession = useApp((s) => s.switchSession)
  const setPanel = useApp((s) => s.setPanel)
  const [runs, setRuns] = useState<TaskRun[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.taskRuns(taskId).then((list) => {
      if (!cancelled) setRuns(list)
    })
    return () => {
      cancelled = true
    }
  }, [taskId])

  if (runs === null) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
        <Spinner className="size-3" />
        loading
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <p className="px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
        No runs yet. A run that finds nothing worth saying is not recorded here — that is
        the usual outcome for the check-in, and it costs nothing.
      </p>
    )
  }

  const open = async (run: TaskRun): Promise<void> => {
    if (!run.sessionId) return
    await switchSession(run.sessionId)
    setPanel('chat')
  }

  return (
    <ul className="flex flex-col border-t border-border/60">
      {runs.map((run) => {
        const gone = run.sessionId === null
        return (
          <li key={run.id}>
            <button
              type="button"
              disabled={gone}
              onClick={() => void open(run)}
              aria-label={
                gone
                  ? `${formatRelativeTime(run.startedAt)} — that conversation has been cleared`
                  : `Open the run from ${formatRelativeTime(run.startedAt)}`
              }
              className={cn(
                'flex w-full items-start gap-2 px-3 py-2 text-left',
                'transition-[background-color,transform] duration-150 ease-[var(--ease-out)]',
                gone ? 'cursor-default' : 'active:scale-[0.99] hover:bg-accent/50'
              )}
            >
              <RunIcon run={run} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[11.5px] text-foreground">
                    {formatRelativeTime(run.startedAt)}
                  </span>
                  {!gone && <MessageSquare className="size-3 shrink-0 text-muted-foreground" />}
                </span>
                {/*
                  The summary is what makes a failed run readable at all: the run's chat
                  holds the injected prompt and nothing else when the turn never produced
                  a reply, so without this the row would open to an empty conversation.
                */}
                {run.summary && (
                  <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground text-pretty">
                    {run.summary}
                  </span>
                )}
                {gone && (
                  <span className="mt-0.5 block text-[10.5px] text-muted-foreground">
                    that conversation has been cleared
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function RunIcon({ run }: { run: TaskRun }): React.JSX.Element {
  if (run.status === 'running') return <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-primary" />
  if (run.status === 'error') return <AlertCircle className="mt-0.5 size-3 shrink-0 text-destructive" />
  return <Check className="mt-0.5 size-3 shrink-0 text-success" />
}

/* -------------------------------------------------------------- adding one */

const HOURS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${String(hour).padStart(2, '0')}:00`
}))

function HourPicker({
  value,
  onChange
}: {
  value: number
  onChange: (hour: number) => void
}): React.JSX.Element {
  return (
    <NativeSelect
      aria-label="Hour"
      value={String(value)}
      onChange={(next) => onChange(Number(next))}
      options={HOURS}
      className="h-6 py-0 text-[11px]"
    />
  )
}

/**
 * Adding a job by hand.
 *
 * Deliberately small: the expected way to make one is to ask for it in the conversation,
 * where the agent writes a far better prompt than a text box invites. This exists so the
 * feature is not agent-only.
 */
function Composer({
  onCancel,
  onSaved
}: {
  onCancel: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<Schedule['kind']>('daily')
  const [hour, setHour] = useState(9)
  const [saving, setSaving] = useState(false)

  const schedule = (): Schedule =>
    kind === 'hourly'
      ? { kind: 'hourly', minute: 0 }
      : kind === 'weekly'
        ? { kind: 'weekly', days: [1, 2, 3, 4, 5], hour, minute: 0 }
        : { kind: 'daily', hour, minute: 0 }

  const save = async (): Promise<void> => {
    if (!name.trim() || !prompt.trim()) return
    setSaving(true)
    try {
      await api.saveTask({ name: name.trim(), prompt: prompt.trim(), schedule: schedule() })
      onSaved()
    } catch (err) {
      toast.error('Could not save it', { description: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name — e.g. Morning summary"
        className="h-8 text-[13px]"
        autoFocus
      />

      <Textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={3}
        placeholder="What should it do every time it runs? Say what to do when there is nothing to report, too."
        className="mt-2 min-h-16 text-[12.5px]"
      />

      <div className="mt-2 flex items-center gap-1.5">
        <NativeSelect
          aria-label="How often"
          value={kind}
          onChange={(next) => setKind(next as Schedule['kind'])}
          options={[
            { value: 'hourly', label: 'Every hour' },
            { value: 'daily', label: 'Every day' },
            { value: 'weekly', label: 'Weekdays' }
          ]}
          className="h-7 text-[12px]"
        />
        {kind !== 'hourly' && <HourPicker value={hour} onChange={setHour} />}

        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={!name.trim() || !prompt.trim() || saving}
            onClick={() => void save()}
          >
            {saving ? <Spinner className="size-3" /> : 'Add'}
          </Button>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground text-pretty">
        Asking in the conversation usually writes a better prompt than this box does.
      </p>
    </div>
  )
}

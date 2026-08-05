import { useEffect, useState } from 'react'
import { AlertCircle, CalendarClock, Check, Loader2, Pause, Play, Plus, Trash2, Zap } from 'lucide-react'
import type { ScheduledTask } from '@shared/types'
import { describeSchedule, type Schedule } from '@shared/schedule'
import { api, errorMessage, onEvent } from '@/lib/api'
import { useApp } from '@/store/app'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Badge, NativeSelect, Spinner } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/sonner'

/**
 * Everything the app does on its own clock.
 *
 * The reason this is a tab and not a settings sub-page: an app that acts unprompted has
 * to be legible. Every scheduled run is listed here with what it will do, when it goes
 * next, and how the last one went — and one switch at the top stops all of it. Nothing
 * the agent sets up is hidden from this list.
 */
export function TasksPanel(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const switchSession = useApp((s) => s.switchSession)
  const setPanel = useApp((s) => s.setPanel)

  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)

  const refresh = async (): Promise<void> => setTasks(await api.listTasks())

  useEffect(() => {
    void refresh()
    return onEvent('tasks:changed', () => void refresh())
  }, [])

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

  const open = async (task: ScheduledTask): Promise<void> => {
    const { sessionId } = await api.openTaskSession(task.id)
    if (!sessionId) {
      toast('Nothing to show yet', { description: 'This task has not run, so it has no chat.' })
      return
    }
    await switchSession(sessionId)
    setPanel('chat')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold text-foreground">Tasks</h2>
        <Tooltip content="Add a task">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add a task"
            onClick={() => setComposing((value) => !value)}
          >
            <Plus className="size-4" />
          </Button>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-3 py-3">
          {/*
            The master switch, first and unmissable. Being checked on by software is not
            everyone's idea of help, and someone who wants it off should not have to go
            looking — so it sits above the list it governs rather than in Settings.
          */}
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
                onChange={(event) =>
                  void updateSettings({ proactive: { enabled: event.target.checked } })
                }
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground">
                  Work on its own
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
                  {enabled
                    ? 'Scheduled tasks run, and the app checks in once an hour to see whether anything is worth raising.'
                    : 'Nothing runs on a schedule — including the tasks below. The app only acts when you ask it to.'}
                </span>
              </span>
            </label>

            {enabled && proactive && (
              <div className="mt-2.5 flex flex-col gap-2 border-t border-border/60 pt-2.5">
                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={proactive.heartbeat}
                    onChange={(event) =>
                      void updateSettings({ proactive: { heartbeat: event.target.checked } })
                    }
                    className="size-3.5 accent-primary"
                  />
                  Check in hourly, unprompted
                </label>

                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={proactive.quietHours.enabled}
                    onChange={(event) =>
                      void updateSettings({
                        proactive: { quietHours: { enabled: event.target.checked } }
                      })
                    }
                    className="size-3.5 accent-primary"
                  />
                  Stay quiet between
                  <HourPicker
                    value={proactive.quietHours.startHour}
                    onChange={(startHour) =>
                      void updateSettings({ proactive: { quietHours: { startHour } } })
                    }
                  />
                  and
                  <HourPicker
                    value={proactive.quietHours.endHour}
                    onChange={(endHour) =>
                      void updateSettings({ proactive: { quietHours: { endHour } } })
                    }
                  />
                </label>
              </div>
            )}
          </div>

          {composing && (
            <TaskComposer
              onCancel={() => setComposing(false)}
              onSaved={() => {
                setComposing(false)
                void refresh()
              }}
            />
          )}

          {tasks.length === 0 && !composing && (
            <p className="px-1 py-4 text-center text-[12.5px] leading-relaxed text-muted-foreground text-pretty">
              Nothing scheduled yet. Ask in the conversation — &ldquo;every morning, summarise
              what changed yesterday&rdquo; — or add one here.
            </p>
          )}

          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              paused={!enabled}
              busy={busyId === task.id}
              onRunNow={() => void runNow(task)}
              onOpen={() => void open(task)}
              onToggle={() => {
                void api.setTaskEnabled(task.id, !task.enabled).then(refresh)
              }}
              onDelete={() => {
                void api.removeTask(task.id).then(refresh)
              }}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

/* ------------------------------------------------------------------ one task */

function TaskRow({
  task,
  paused,
  busy,
  onRunNow,
  onOpen,
  onToggle,
  onDelete
}: {
  task: ScheduledTask
  /** True when the master switch is off, so nothing will run whatever this says. */
  paused: boolean
  busy: boolean
  onRunNow: () => void
  onOpen: () => void
  onToggle: () => void
  onDelete: () => void
}): React.JSX.Element {
  const built_in = task.kind === 'heartbeat'
  const inert = paused || !task.enabled

  return (
    <div
      className={cn(
        'group rounded-lg border border-border bg-card px-3 py-2.5 transition-opacity duration-150',
        inert && 'opacity-60'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            {built_in ? (
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
            The check-in is seeded on every launch, so deleting it would only bring it
            back. Offering a delete that silently does not stick is worse than not
            offering one — pausing is the honest control.
          */}
          {!built_in && (
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
        <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
          {task.prompt}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
        {paused ? (
          <span className="text-muted-foreground">held — working on its own is off</span>
        ) : task.enabled && task.nextRunAt ? (
          <span className="text-muted-foreground">
            next {formatRelativeTime(task.nextRunAt)}
          </span>
        ) : (
          <span className="text-muted-foreground">paused</span>
        )}

        {task.lastStatus && <LastRun task={task} onOpen={onOpen} />}
      </div>
    </div>
  )
}

/**
 * How the last run went.
 *
 * `skipped` deliberately reads as a normal outcome rather than a warning, because for
 * the hourly check-in it is the *expected* one: most hours nothing has changed, and
 * the whole design depends on that costing nothing.
 */
function LastRun({ task, onOpen }: { task: ScheduledTask; onOpen: () => void }): React.JSX.Element {
  const tone =
    task.lastStatus === 'error'
      ? 'text-destructive'
      : task.lastStatus === 'skipped'
        ? 'text-muted-foreground'
        : 'text-success'

  const Icon = task.lastStatus === 'error' ? AlertCircle : Check

  return (
    <Tooltip content={task.lastSummary ?? 'No detail recorded.'}>
      <button
        type="button"
        onClick={onOpen}
        className={cn('flex items-center gap-1 rounded hover:underline', tone)}
      >
        {task.lastStatus !== 'skipped' && <Icon className="size-3" />}
        {task.lastStatus === 'skipped'
          ? 'nothing to do last time'
          : task.lastStatus === 'error'
            ? 'failed last time'
            : `ran ${task.lastRunAt ? formatRelativeTime(task.lastRunAt) : ''}`}
      </button>
    </Tooltip>
  )
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
 * Adding a task by hand.
 *
 * Deliberately small: the expected way to make one of these is to ask for it in the
 * conversation, where the agent writes a far better prompt than a text box invites.
 * This exists so the feature is not agent-only.
 */
function TaskComposer({
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
          <Button size="xs" disabled={!name.trim() || !prompt.trim() || saving} onClick={() => void save()}>
            {saving ? <Spinner className="size-3" /> : 'Add'}
          </Button>
        </div>
      </div>

      <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        <Badge>tip</Badge>
        Asking in the conversation usually writes a better prompt than this box does.
      </p>
    </div>
  )
}

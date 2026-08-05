import { useCallback, useEffect, useRef, useState } from 'react'
import { NodeProse } from '@/components/NodeProse'
import {
  ArrowLeft,
  Check,
  Copy,
  MessageSquare,
  PanelRightClose,
  ScrollText,
  Send,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import type { PendingQuestion } from '@shared/ipc'
import type {
  AgentEvent,
  ChecklistState,
  KanbanState,
  NotepadState,
  SavedTool,
  TableState,
  WorkbenchState
} from '@shared/types'
import { api, errorMessage, onEvent } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Spinner } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { friendlyToolLabel } from '@/lib/tool-labels'
import { toolIcon } from '@/components/panels/ToolsPanel'
import {
  ChecklistSurface,
  KanbanSurface,
  NotepadSurface,
  TableSurface
} from './surfaces'
import { CanvasSurface } from './CanvasSurface'
import { CodeSurface } from './CodeSurface'
import { QuestionCard } from '@/components/chat/QuestionCard'

/** What to call the running action while it has not named a step yet. */
function runLabel(tool: SavedTool, actionId: string): string {
  return tool.actions.find((action) => action.id === actionId)?.label ?? 'Working'
}

/**
 * How long a run may go without any sign of life before the tool gives up on it.
 *
 * Longer than the agent's own limits on purpose — `ask_user` waits four minutes and
 * an MCP tool call gets five — because a turn that is legitimately waiting must not
 * be declared dead. Every event re-arms it, so this only ever trips on real silence.
 */
const SILENCE_BACKSTOP_MS = 6 * 60_000

interface PendingRun {
  actionId: string
  startedAt: number
  /** The reply as it streams in, so a tool can show it arriving. */
  streamed: string
  resolve: (text: string) => void
  reject: (error: Error) => void
}

/** A run waiting for its turn, so several presses queue instead of failing. */
interface QueuedRun {
  actionId: string
  inputs: Record<string, string>
  resolve: (text: string) => void
  reject: (error: Error) => void
}

/**
 * Progress for the action currently running, for a tool that draws its own state.
 *
 * `delta` is the one that matters most: without the reply arriving as it is written,
 * pressing a button means staring at a spinner for however long the model takes,
 * with no way to tell a slow answer from a dead one. Everything else here exists so
 * a tool can say something true while it waits — which step, how long, and a way out.
 */
export interface RunProgress {
  actionId: string
  status: 'start' | 'step' | 'delta' | 'ask' | 'done' | 'error'
  /** The current step's name, e.g. "Searching your notes". */
  step?: string
  /** On `delta`, everything written so far. On `done`, the final reply. */
  text?: string
  /** Milliseconds since the button was pressed. */
  elapsedMs?: number
  message?: string
  /**
   * On `ask`, the question the agent is blocked on. The run continues; nothing
   * settles until it is answered, and the host also draws it, so a tool that
   * ignores this is still usable.
   */
  question?: { id: string; question: string; options: string[]; allowFreeText: boolean }
}

/**
 * A tool, running inside the app.
 *
 * It fills the main area — the same space the graph occupies — because a board or
 * a table needs room, and because a tool is part of this application rather than
 * something launched beside it.
 *
 * Being agentic here means the buttons: each one runs the agent for a single job
 * against the tool's inputs and document. The conversation on the right is for
 * changing the tool itself, and it stays collapsed until asked for.
 */
export function ToolView({
  toolId,
  onClose,
  autoFocusInput,
  preview,
  closeLabel = 'Back to the graph'
}: {
  toolId: string
  onClose: () => void
  /**
   * What closing does, in words. In a popped-out window it closes the window, and
   * calling that "back to the graph" describes something that will not happen.
   */
  closeLabel?: string
  /** True when a global shortcut opened this, so the cursor lands in the input. */
  autoFocusInput?: boolean
  /** Rendering for a screenshot: no chrome, and report when the tool has landed. */
  preview?: boolean
}): React.JSX.Element {
  const [tool, setTool] = useState<SavedTool | null>(null)
  // The revision a queued write has to check against is the one current when it
  // actually runs, not the one captured when it was requested.
  const toolRef = useRef<SavedTool | null>(null)
  toolRef.current = tool

  const writeSeqRef = useRef(0)
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const [missing, setMissing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [runningAction, setRunningAction] = useState<string | null>(null)
  /**
   * The session this tool's turns run in.
   *
   * Resolved on mount rather than learned from the reply to a run, because a fast
   * turn can finish before that reply crosses the IPC boundary — and an event that
   * arrives before we know the id gets filtered out as belonging to nobody. That
   * was one of two reasons a button could spin forever.
   */
  const activeSessionRef = useRef<string | null>(null)
  /**
   * The same id as state, because a question raised by this tool's turn has to be
   * filtered for and drawn — and a ref does not re-render.
   */
  const [sessionId, setSessionId] = useState<string | null>(null)

  /**
   * Questions the agent is blocked on in this tool's session.
   *
   * Subscribed here rather than read from the store, because a popped-out tool is a
   * separate document with no store in it — and because chat filters questions to
   * the *current* session, which a tool's archived session never is. Between those
   * two, a tool that called ask_user waited on an answer nobody had been asked for
   * until the six-minute backstop gave up.
   */
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const runTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Resolved when the running action's reply arrives, so `brain.run` can await it. */
  const pendingRunRef = useRef<PendingRun | null>(null)
  /**
   * Runs waiting behind the current one.
   *
   * Turns on a session have to be serial — two would race on the same document and
   * their replies would arrive interleaved with no way to tell them apart. But
   * rejecting the second press was the wrong way to enforce that: the documented
   * API says calls queue, `Promise.all` over two actions is the obvious way to fill
   * two panes, and a tool that throws when the user presses twice is just broken.
   * So they queue here and run in order.
   */
  const queueRef = useRef<QueuedRun[]>([])
  /** Subscribers for run progress — a code tool draws its own spinner. */
  const runListenersRef = useRef(new Set<(event: RunProgress) => void>())

  const emitRun = useCallback((event: RunProgress) => {
    const pending = pendingRunRef.current
    const withTiming: RunProgress =
      pending && event.elapsedMs === undefined
        ? { ...event, elapsedMs: Math.round(performance.now() - pending.startedAt) }
        : event
    for (const listener of runListenersRef.current) listener(withTiming)
  }, [])

  /** Claims the pending run so exactly one of the finish paths settles it. */
  const takePendingRun = useCallback((): PendingRun | null => {
    const pending = pendingRunRef.current
    pendingRunRef.current = null
    return pending
  }, [])

  useEffect(() => {
    const off = [
      onEvent('chat:question', (question) => {
        if (question.sessionId !== activeSessionRef.current) return
        setQuestions((current) => [...current, question])
        const running = pendingRunRef.current
        if (running) {
          emitRun({
            actionId: running.actionId,
            status: 'ask',
            question: {
              id: question.id,
              question: question.question,
              options: question.options,
              allowFreeText: question.allowFreeText
            }
          })
        }
      }),
      onEvent('chat:questionResolved', ({ id }) => {
        setQuestions((current) => current.filter((question) => question.id !== id))
      })
    ]
    return () => off.forEach((stop) => stop())
  }, [emitRun])

  const answerQuestion = useCallback((id: string, answer: string) => {
    // Cleared straight away: the card must not sit there looking unanswered while
    // the round trip completes.
    setQuestions((current) => current.filter((question) => question.id !== id))
    void api.answerQuestion(id, answer)
  }, [])

  /**
   * Forward references, because these call each other in a cycle: a settled run
   * drains the queue, which starts an action, which arms the backstop, which
   * abandons a run, which drains the queue.
   */
  const abandonRunRef = useRef<((reason: string) => void) | null>(null)
  const startActionRef = useRef<
    ((actionId: string, inputs: Record<string, string>) => Promise<string>) | null
  >(null)

  /**
   * Arm the "this never came back" backstop, and re-arm it on every sign of life.
   *
   * A fixed clock from the press was wrong twice over: it was shorter than the
   * agent's own timeouts, so a turn legitimately waiting on `ask_user` (four
   * minutes) or a slow connector was declared dead while it was still working; and
   * progress did not reset it, so a turn that had been streaming for three minutes
   * got killed mid-sentence. Now only genuine silence trips it.
   */
  const armBackstop = useCallback(() => {
    if (runTimeoutRef.current) clearTimeout(runTimeoutRef.current)
    runTimeoutRef.current = setTimeout(() => {
      const message = 'Nothing has come back for a while. The tool is free again.'
      abandonRunRef.current?.(message)
      setNote(message)
    }, SILENCE_BACKSTOP_MS)
  }, [])

  /**
   * Start the next queued run, if any.
   *
   * Called from every path that settles a run, so a queue can never be stranded by
   * the way the current one happened to end.
   */
  const drainQueue = useCallback(() => {
    const next = queueRef.current.shift()
    if (!next) return
    void startActionRef.current?.(next.actionId, next.inputs).then(next.resolve, next.reject)
  }, [])

  const subscribeRun = useCallback((listener: (event: RunProgress) => void) => {
    runListenersRef.current.add(listener)
    return () => runListenersRef.current.delete(listener)
  }, [])

  const finishAction = useCallback(() => {
    setRunningAction(null)
    if (runTimeoutRef.current) {
      clearTimeout(runTimeoutRef.current)
      runTimeoutRef.current = null
    }
  }, [])

  // One listener for the whole view, watching the session the action actually
  // runs in, plus a backstop so a lost event can never strand the button.
  useEffect(() => {
    return onEvent('agent:event', (raw) => {
      const event = raw as AgentEvent
      if (!activeSessionRef.current || event.sessionId !== activeSessionRef.current) return

      // Any event at all is a sign of life, so the silence clock starts over.
      if (pendingRunRef.current) armBackstop()

      if (event.type === 'tool-start') {
        const step = friendlyToolLabel(event.name)
        setActiveStep(step)
        const running = pendingRunRef.current
        if (running) emitRun({ actionId: running.actionId, status: 'step', step })
      }

      // The reply as it is written. This is the difference between a tool that
      // looks frozen for twenty seconds and one you can read while it thinks.
      if (event.type === 'delta' && event.kind === 'text') {
        const running = pendingRunRef.current
        if (running) {
          running.streamed += event.text
          emitRun({ actionId: running.actionId, status: 'delta', text: running.streamed })
        }
      }

      if (event.type === 'result' || event.type === 'error') {
        setActiveStep(null)
        finishAction()
        if (event.type === 'error') setNote(event.message)

        const pending = takePendingRun()
        if (pending) {
          // Elapsed has to be read before the pending run is gone — emitRun can no
          // longer derive it, and a `done` that reports 0ms is a lie a tool will
          // happily show the user.
          const elapsedMs = Math.round(performance.now() - pending.startedAt)

          if (event.type === 'result') {
            const text = (event.text ?? '').trim() || pending.streamed.trim()
            emitRun({ actionId: pending.actionId, status: 'done', text, elapsedMs })
            pending.resolve(text)
          } else {
            emitRun({
              actionId: pending.actionId,
              status: 'error',
              message: event.message,
              elapsedMs
            })
            pending.reject(new Error(event.message))
          }
          drainQueue()
        }
      }
    })
  }, [finishAction, emitRun, takePendingRun, armBackstop, drainQueue])

  const [activeStep, setActiveStep] = useState<string | null>(null)

  /**
   * Seconds the current run has been going.
   *
   * Ticked in the host rather than left to the tool, so the answer to "did it
   * freeze?" is on screen even when the tool itself shows nothing.
   */
  const [runSeconds, setRunSeconds] = useState(0)
  useEffect(() => {
    if (!runningAction) {
      setRunSeconds(0)
      return
    }
    const started = Date.now()
    const timer = setInterval(() => setRunSeconds(Math.floor((Date.now() - started) / 1000)), 500)
    return () => clearInterval(timer)
  }, [runningAction])

  /** Give up on the current run and free the tool, without killing the agent. */
  const abandonRun = useCallback(
    (reason: string) => {
      const pending = takePendingRun()
      finishAction()
      setActiveStep(null)
      if (pending) {
        emitRun({
          actionId: pending.actionId,
          status: 'error',
          message: reason,
          elapsedMs: Math.round(performance.now() - pending.startedAt)
        })
        pending.reject(new Error(reason))
      }
      drainQueue()
    },
    [takePendingRun, finishAction, emitRun, drainQueue]
  )

  abandonRunRef.current = abandonRun

  /**
   * The frame that started the current run has been replaced, so nothing is left to
   * receive its answer. The agent keeps going — it may be mid-write — but the tool
   * is freed, because otherwise every button stays disabled behind a document that
   * no longer exists.
   */
  const releaseFrameRun = useCallback(() => {
    if (!pendingRunRef.current) return
    abandonRun('The tool was rebuilt while that was running. Press it again.')
  }, [abandonRun])

  const stopRun = useCallback(async () => {
    const sessionId = activeSessionRef.current
    abandonRun('Stopped.')
    setNote(null)
    if (sessionId) {
      try {
        await api.interrupt(sessionId)
      } catch {
        /* the process may already be gone; the tool is free either way */
      }
    }
  }, [abandonRun])

  /**
   * Start an action, or queue it behind the one already going, and resolve with the
   * agent's reply.
   *
   * Serial on purpose — two turns on one session would race on the same document —
   * but queued rather than refused, because "press the button twice" and
   * `Promise.all([run(a), run(b)])` are both things a reasonable tool does, and both
   * used to throw.
   */
  const beginAction = (actionId: string, inputs: Record<string, string>): Promise<string> => {
    if (pendingRunRef.current) {
      // Bounded: a tool with a bug in a loop must not queue thousands of turns.
      if (queueRef.current.length >= 8) {
        return Promise.reject(
          new Error('Too many runs are already waiting in this tool. Let them finish.')
        )
      }
      return new Promise<string>((resolve, reject) => {
        queueRef.current.push({ actionId, inputs, resolve, reject })
      })
    }
    return startAction(actionId, inputs)
  }

  const startAction = async (
    actionId: string,
    inputs: Record<string, string>
  ): Promise<string> => {
    setRunningAction(actionId)
    setActiveStep(null)

    const reply = new Promise<string>((resolve, reject) => {
      pendingRunRef.current = {
        actionId,
        startedAt: performance.now(),
        streamed: '',
        resolve,
        reject
      }
    })
    // After the pending run exists, so it carries an elapsed time from the start.
    emitRun({ actionId, status: 'start' })

    armBackstop()

    try {
      const { sessionId } = await api.runToolAction(toolId, actionId, inputs)
      activeSessionRef.current = sessionId
      setSessionId(sessionId)
    } catch (err) {
      const pending = takePendingRun()
      setNote(errorMessage(err))
      finishAction()
      if (pending) {
        emitRun({ actionId, status: 'error', message: errorMessage(err) })
        pending.reject(err instanceof Error ? err : new Error(String(err)))
      }
      drainQueue()
    }

    return reply
  }

  startActionRef.current = startAction

  const load = useCallback(async () => {
    const loaded = await api.getTool(toolId)
    if (!loaded) setMissing(true)
    else setTool(loaded)
  }, [toolId])

  // Before anything can be run, so no result can arrive unattributed.
  useEffect(() => {
    let cancelled = false
    void api
      .toolSession(toolId)
      .then(({ sessionId }) => {
        if (cancelled) return
        activeSessionRef.current = sessionId
        setSessionId(sessionId)
      })
      .catch(() => {
        /* the tool may have been deleted; `missing` covers that */
      })
    return () => {
      cancelled = true
    }
  }, [toolId])

  useEffect(() => {
    void load()
    return onEvent('tools:stateChanged', (payload) => {
      if (payload.toolId !== toolId) return
      setNote(payload.note)
      void load()
    })
  }, [toolId, load])

  /**
   * A code tool's interface is a frame that loads separately, so "the data landed"
   * is not the same as "there is something to photograph". It reports in itself.
   */
  const [surfaceReady, setSurfaceReady] = useState(false)
  const onSurfaceReady = useCallback(() => setSurfaceReady(true), [])

  // Tell the capturing process the tool has rendered, so the screenshot is not
  // taken of a spinner.
  useEffect(() => {
    if (!preview) return
    if (!tool && !missing) return
    if (tool?.kind === 'code' && !surfaceReady) return
    const frame = requestAnimationFrame(() => void api.previewReady())
    return () => cancelAnimationFrame(frame)
  }, [preview, tool, missing, surfaceReady])

  /**
   * Persist an edit.
   *
   * A rejected write means the agent wrote first. Rather than surfacing that as a
   * conflict the user has to think about, the edit is replayed on top of whatever
   * is now stored — their change is what they just did, so it should win over a
   * stale revision number.
   *
   * Writes are serialised, and one that a newer write has already superseded is
   * dropped instead of sent. Every write carries the whole document, so two
   * keystrokes in flight together are not two changes to merge but two snapshots of
   * which only the last is true. Left to race they could land out of order: the
   * newer snapshot stored first, the older one losing the revision check, retrying
   * against the revision the newer one produced, and winning — putting back a
   * character the user had just deleted.
   */
  const write = (state: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const seq = ++writeSeqRef.current
    const run = writeChainRef.current.then(async () => {
      const current = toolRef.current
      if (!current) return state
      // Superseded while queued: the newer snapshot includes this one's content, so
      // sending this would be a round trip whose only effect is to undo it.
      if (seq !== writeSeqRef.current) return state

      setTool({ ...current, state })

      const result = await api.writeToolState(toolId, state, current.rev)
      if (!result.conflict) {
        setTool(result.tool)
        return result.tool.state as Record<string, unknown>
      }

      const retry = await api.writeToolState(toolId, state, result.tool.rev)
      setTool(retry.tool)
      if (retry.conflict) {
        setNote(
          'That change could not be saved — the agent is still writing. Try again in a moment.'
        )
      }
      return retry.tool.state as Record<string, unknown>
    })

    // The chain must survive a failed write, or every later edit is rejected too.
    writeChainRef.current = run.catch(() => undefined)
    return run
  }

  if (missing) {
    return (
      <div className="grid h-full place-items-center px-8">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">This tool no longer exists.</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={onClose}>
            {closeLabel}
          </Button>
        </div>
      </div>
    )
  }

  if (!tool) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  const Icon = toolIcon(tool.icon)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {!preview && (
          <Tooltip content={closeLabel}>
            <Button variant="ghost" size="icon-sm" aria-label={closeLabel} onClick={onClose}>
              <ArrowLeft className="size-4" />
            </Button>
          </Tooltip>
        )}

        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
          <Icon className="size-3.5" />
        </span>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[13px] font-semibold text-foreground">{tool.name}</h1>
          <p className="truncate text-[11px] text-muted-foreground">{tool.description}</p>
        </div>

        {/* One honest place that says whether the agent is working in this tool, and
            one way out of it. Without this a tool that lost its result event just
            looked broken, with nothing to click. */}
        {runningAction && !preview && (
          <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-secondary/60 pl-2 pr-0.5 py-0.5">
            <Spinner className="size-3 text-primary" />
            <span className="max-w-40 truncate text-[11px] text-muted-foreground">
              {activeStep ?? runLabel(tool, runningAction)}
            </span>
            {/* Past a few seconds the elapsed time is the thing that answers "is it
                stuck?" — and it shows even for a tool that draws no progress of its
                own, which is every kanban and every canvas. */}
            {runSeconds >= 3 && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                {runSeconds}s
              </span>
            )}
            <Tooltip content="Stop this run">
              <button
                type="button"
                aria-label="Stop this run"
                onClick={() => void stopRun()}
                className="grid size-5 place-items-center rounded-full text-muted-foreground transition-[color,transform] duration-150 hover:text-destructive active:scale-90"
              >
                <Square className="size-2.5 fill-current" />
              </button>
            </Tooltip>
          </div>
        )}

        {!preview && (
          <Tooltip content="Open the log">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open the log"
              onClick={() => void api.openLogWindow()}
            >
              <ScrollText className="size-4" />
            </Button>
          </Tooltip>
        )}

        {!preview && (
          <Tooltip content={chatOpen ? 'Hide' : 'Change this tool'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Change this tool"
              aria-pressed={chatOpen}
              onClick={() => setChatOpen((value) => !value)}
              className={cn(chatOpen && 'text-foreground')}
            >
              {chatOpen ? (
                <PanelRightClose className="size-4" />
              ) : (
                <MessageSquare className="size-4" />
              )}
            </Button>
          </Tooltip>
        )}
      </header>

      {note && (
        <p className="shrink-0 border-b border-primary/20 bg-primary/8 px-3 py-1.5 text-[11px] text-primary">
          {note}
        </p>
      )}

      {/*
        Above the surface, not inside it: the agent is waiting on this and the run
        cannot finish until it is answered, so it has to be the thing that catches
        the eye — and it must appear whether or not the tool chose to draw it.
      */}
      {questions.length > 0 && (
        <div className="shrink-0 space-y-1.5 border-b border-border px-3 py-2">
          {questions.map((question) => (
            <QuestionCard key={question.id} question={question} onAnswer={answerQuestion} />
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tool.kind === 'code' ? (
            <CodeSurface
              tool={tool}
              onWrite={write}
              onRun={beginAction}
              onCancel={stopRun}
              onAnswer={async (id, answer) => answerQuestion(id, answer)}
              onFix={() => setChatOpen(true)}
              subscribeRun={subscribeRun}
              onSurfaceReady={onSurfaceReady}
              onFrameReplaced={releaseFrameRun}
            />
          ) : tool.kind === 'canvas' ? (
            <>
              <CanvasSurface
                layout={tool.layout}
                state={tool.state as Record<string, unknown>}
                onChange={(next) => void write(next)}
                onAction={(actionId) => void beginAction(actionId, {})}
                runningAction={runningAction}
              />
              {activeStep && (
                <p className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                  {activeStep}…
                </p>
              )}
            </>
          ) : tool.kind === 'workbench' ? (
            <WorkbenchSurface
              tool={tool}
              autoFocusInput={autoFocusInput}
              runningAction={runningAction}
              activeStep={activeStep}
              onRun={async (actionId, inputs) => {
                // Inputs live in the document so they survive closing the tool.
                await write({ ...(tool.state as Record<string, unknown>), inputs })
                await beginAction(actionId, inputs)
              }}
              onInputsChange={(inputs) =>
                void write({ ...(tool.state as Record<string, unknown>), inputs })
              }
            />
          ) : (
            <>
              {tool.actions.length > 0 && (
                <ActionBar
                  tool={tool}
                  running={runningAction}
                  activeStep={activeStep}
                  onRun={(actionId) => void beginAction(actionId, {})}
                />
              )}

              <div className="min-h-0 flex-1 overflow-auto p-3">
                {tool.kind === 'kanban' && (
                  <KanbanSurface
                    state={tool.state as KanbanState}
                    onChange={(next) => void write(next as unknown as Record<string, unknown>)}
                  />
                )}
                {tool.kind === 'table' && (
                  <TableSurface
                    state={tool.state as TableState}
                    onChange={(next) => void write(next as unknown as Record<string, unknown>)}
                  />
                )}
                {tool.kind === 'checklist' && (
                  <ChecklistSurface
                    state={tool.state as ChecklistState}
                    onChange={(next) => void write(next as unknown as Record<string, unknown>)}
                  />
                )}
                {tool.kind === 'notepad' && (
                  <NotepadSurface
                    state={tool.state as NotepadState}
                    onChange={(next) => void write(next as unknown as Record<string, unknown>)}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {chatOpen && (
          <ToolChat
            tool={tool}
            sessionRef={activeSessionRef}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- action bar */

function ActionBar({
  tool,
  running,
  activeStep,
  onRun
}: {
  tool: SavedTool
  running: string | null
  activeStep: string | null
  onRun: (actionId: string) => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
      {tool.actions.map((action) => {
        const ActionIcon = toolIcon(action.icon ?? null)
        const isRunning = running === action.id

        return (
          <Tooltip key={action.id} content={action.hint ?? action.prompt.slice(0, 120)}>
            <Button
              size="sm"
              variant={action.primary ? 'default' : 'outline'}
              disabled={running !== null}
              onClick={() => onRun(action.id)}
            >
              {isRunning ? <Spinner className="size-3.5" /> : <ActionIcon className="size-3.5" />}
              {action.label}
            </Button>
          </Tooltip>
        )
      })}

      {activeStep && <span className="ml-1 text-[11px] text-muted-foreground">{activeStep}…</span>}
    </div>
  )
}

/* -------------------------------------------------------------- workbench */

function WorkbenchSurface({
  tool,
  autoFocusInput,
  runningAction,
  activeStep,
  onRun,
  onInputsChange
}: {
  tool: SavedTool
  autoFocusInput?: boolean
  runningAction: string | null
  activeStep: string | null
  onRun: (actionId: string, inputs: Record<string, string>) => void
  onInputsChange: (inputs: Record<string, string>) => void
}): React.JSX.Element {
  const state = tool.state as WorkbenchState
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = {}
    for (const field of tool.fields) {
      seeded[field.name] = state.inputs?.[field.name] ?? field.default ?? ''
    }
    return seeded
  })
  const [copied, setCopied] = useState(false)
  const firstInputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  /**
   * A run is going and the pane still holds the previous answer.
   *
   * Keeping the old text is right — it is what the new one will be compared against
   * — but presenting it as the result of the button just pressed is not, and a pane
   * that already had content otherwise showed no sign of activity at all.
   */
  const stale = runningAction !== null && !!state.output

  // Summoned by shortcut: put the cursor where the user is about to type, and
  // select what is there so they can just start.
  useEffect(() => {
    if (!autoFocusInput) return
    const element = firstInputRef.current
    if (!element) return
    element.focus()
    element.select()
  }, [autoFocusInput])

  useEffect(() => {
    return onEvent('tools:focusInput', () => {
      firstInputRef.current?.focus()
      firstInputRef.current?.select()
    })
  }, [])

  const setField = (name: string, value: string): void => {
    const next = { ...inputs, [name]: value }
    setInputs(next)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      {tool.fields.map((field, index) => (
        <div key={field.name}>
          <label
            htmlFor={`field-${field.name}`}
            className="mb-1 block text-[11px] font-medium tracking-wide text-muted-foreground"
          >
            {field.label}
          </label>
          {field.multiline ? (
            <Textarea
              id={`field-${field.name}`}
              ref={index === 0 ? (firstInputRef as React.Ref<HTMLTextAreaElement>) : undefined}
              value={inputs[field.name] ?? ''}
              placeholder={field.placeholder}
              onChange={(event) => setField(field.name, event.target.value)}
              onBlur={() => onInputsChange(inputs)}
              className="min-h-28 text-[13.5px]"
            />
          ) : (
            <Input
              id={`field-${field.name}`}
              ref={index === 0 ? (firstInputRef as React.Ref<HTMLInputElement>) : undefined}
              value={inputs[field.name] ?? ''}
              placeholder={field.placeholder}
              onChange={(event) => setField(field.name, event.target.value)}
              onBlur={() => onInputsChange(inputs)}
              className="text-[13.5px]"
            />
          )}
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-1.5">
        {tool.actions.map((action) => {
          const ActionIcon = toolIcon(action.icon ?? null)
          const isRunning = runningAction === action.id

          return (
            <Button
              key={action.id}
              size="sm"
              variant={action.primary ? 'default' : 'outline'}
              disabled={runningAction !== null}
              onClick={() => onRun(action.id, inputs)}
            >
              {isRunning ? <Spinner className="size-3.5" /> : <ActionIcon className="size-3.5" />}
              {action.label}
            </Button>
          )
        })}
        {activeStep && <span className="text-[11px] text-muted-foreground">{activeStep}…</span>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
            {state.lastAction ? `Output · ${state.lastAction}` : 'Output'}
          </span>
          {state.output && !stale && (
            <Tooltip content="Copy">
              <button
                type="button"
                aria-label="Copy output"
                onClick={() => {
                  void navigator.clipboard.writeText(state.output)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1400)
                }}
                className="grid size-6 place-items-center rounded text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-90"
              >
                {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              </button>
            </Tooltip>
          )}
        </div>

        <div className="min-h-32 flex-1 overflow-auto rounded-md border border-border bg-secondary/25 px-3 py-2.5">
          {stale && (
            <p className="mb-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
              <Spinner className="size-3.5" />
              Working — showing the previous answer
            </p>
          )}
          {runningAction && !state.output ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" />
              Working…
            </p>
          ) : state.output ? (
            <div
              className={cn(
                'genui-prose selectable text-[13.5px] leading-relaxed text-foreground',
                'transition-opacity duration-200 ease-[var(--ease-out)]',
                stale && 'opacity-45'
              )}
            >
              <NodeProse>{state.output}</NodeProse>
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Fill in the field above and pick a button.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- tool chat */

/**
 * For changing the tool, not for using it.
 *
 * The buttons are how the tool gets used; this is where you say "add a formal
 * option" or "drop the tags column". Collapsed by default so it never looks like
 * the main way in.
 */
function ToolChat({
  tool,
  sessionRef,
  onClose
}: {
  tool: SavedTool
  /** Shared with the view, so the session is known before anything is sent. */
  sessionRef: React.MutableRefObject<string | null>
  onClose: () => void
}): React.JSX.Element {
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const streamingRef = useRef('')

  useEffect(() => {
    return onEvent('agent:event', (raw) => {
      const event = raw as AgentEvent
      if (!sessionRef.current || event.sessionId !== sessionRef.current) return

      if (event.type === 'delta' && event.kind === 'text') {
        streamingRef.current += event.text
        setMessages((current) => {
          const next = [...current]
          if (next.length > 0 && next[next.length - 1].role === 'assistant') {
            next[next.length - 1] = { role: 'assistant', text: streamingRef.current }
          } else {
            next.push({ role: 'assistant', text: streamingRef.current })
          }
          return next
        })
      }
      if (event.type === 'result') {
        setBusy(false)
        streamingRef.current = ''
      }
      if (event.type === 'error') {
        setBusy(false)
        setMessages((current) => [...current, { role: 'assistant', text: event.message }])
      }
    })
  }, [sessionRef])

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || busy) return

    setDraft('')
    setMessages((current) => [...current, { role: 'user', text }])
    streamingRef.current = ''
    setBusy(true)

    try {
      const { sessionId } = await api.askTool(tool.id, text)
      sessionRef.current = sessionId
    } catch (err) {
      setBusy(false)
      setMessages((current) => [...current, { role: 'assistant', text: errorMessage(err) }])
    }
  }

  return (
    <aside className="flex w-72 min-w-0 shrink-0 flex-col border-l border-border bg-sidebar">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Change this tool
        </span>
        <button
          type="button"
          aria-label="Hide"
          onClick={onClose}
          className="text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !busy && (
          <p className="text-[12px] leading-relaxed text-muted-foreground text-pretty">
            Ask for changes to the tool itself — “add a formal option”, “drop the
            tags column”, “also pull from ClickUp”. Use the buttons above to
            actually run it.
          </p>
        )}

        <div className="flex flex-col gap-3">
          {messages.map((message, index) =>
            message.role === 'user' ? (
              <p
                key={index}
                className="self-end rounded-lg rounded-br-sm bg-primary/12 px-2.5 py-1.5 text-[12.5px] text-foreground selectable"
              >
                {message.text}
              </p>
            ) : (
              <div
                key={index}
                className="genui-prose selectable text-[12.5px] leading-relaxed text-foreground"
              >
                <NodeProse>{message.text}</NodeProse>
              </div>
            )
          )}
          {busy && (
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Spinner className="size-3" />
              Working…
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <div className="relative">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
            rows={2}
            placeholder="Change something about this tool…"
            className="min-h-16 pr-10 text-[12.5px]"
          />
          <Button
            size="icon-sm"
            aria-label="Send"
            disabled={!draft.trim() || busy}
            onClick={() => void submit()}
            className="absolute bottom-1.5 right-1.5"
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      </div>
    </aside>
  )
}

export { Sparkles }

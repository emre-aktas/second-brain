import { useCallback, useEffect, useRef, useState } from 'react'
import type { SavedTool } from '@shared/types'
import { api, errorMessage } from '@/lib/api'
import { Spinner } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import type { RunProgress } from './ToolView'

/**
 * Hosts a tool whose interface the agent wrote.
 *
 * A layout tree, however many node types it grows, can only ever produce
 * variations on one house style — every tool ends up looking like the same
 * product. So the agent writes the interface itself, and this is the foundation
 * underneath it: a sandboxed frame, the tool's document, and a way to run the
 * agent from a button.
 *
 * The frame is sandboxed without `allow-same-origin`, served from its own scheme
 * with a policy that permits no network at all. It cannot touch this document, the
 * filesystem, or IPC. The entire surface it gets is the four messages below, which
 * is why arbitrary agent-written code is safe to run here.
 */

/** The tokens a tool can use to look like part of the app. */
const THEME_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'info',
  'info-foreground',
  'border',
  'input',
  'ring',
  'radius',
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-xl',
  'font-sans',
  'font-mono',
  'ease-out',
  'ease-in-out',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8'
]

function readTheme(): { theme: Record<string, string>; dark: boolean } {
  const computed = getComputedStyle(document.documentElement)
  const theme: Record<string, string> = {}
  for (const token of THEME_TOKENS) {
    const value = computed.getPropertyValue(`--${token}`).trim()
    if (value) theme[`--${token}`] = value
  }
  return { theme, dark: document.documentElement.classList.contains('dark') }
}

export interface CodeSurfaceProps {
  tool: SavedTool
  /** Persist the document. Resolves with what was stored. */
  onWrite: (state: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** Run an action; resolves with the agent's reply. */
  onRun: (actionId: string, inputs: Record<string, string>) => Promise<string>
  /** Progress subscription for whichever action is running. */
  subscribeRun: (listener: (event: RunProgress) => void) => () => void
  /** Stop whatever is running, from a button the tool drew itself. */
  onCancel: () => Promise<void>
  /** Answer a question the agent asked mid-run, from the tool's own prompt. */
  onAnswer: (questionId: string, answer: string) => Promise<void>
  /** Open the tool's conversation with the failure in hand, so it can be fixed. */
  onFix: () => void
  /** The frame has its document and has drawn — a screenshot will show the tool. */
  onSurfaceReady?: () => void
  /**
   * The document was replaced, so anything the old one was waiting on is orphaned.
   * The host uses this to release a run the vanished frame had claimed.
   */
  onFrameReplaced?: () => void
}

export function CodeSurface({
  tool,
  onWrite,
  onRun,
  onCancel,
  onAnswer,
  onFix,
  subscribeRun,
  onSurfaceReady,
  onFrameReplaced
}: CodeSurfaceProps): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [broken, setBroken] = useState<string | null>(null)

  // Kept in a ref so the message handler never closes over a stale document: the
  // frame may ask to save at any moment, including mid-agent-write.
  const stateRef = useRef<Record<string, unknown>>(tool.state as Record<string, unknown>)
  stateRef.current = tool.state as Record<string, unknown>

  /**
   * Which generation of the frame is live.
   *
   * A reply must never reach a document that has since been replaced: the ids the
   * old frame handed out mean nothing to the new one, and a stale `reply` there
   * resolves the wrong promise. Every message carries the generation it belongs to
   * and the bridge drops anything that is not its own.
   */
  const genRef = useRef(0)

  const send = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ ...message, gen: genRef.current }, '*')
  }, [])

  /** True once this generation of the frame has been handed its document. */
  const initSentRef = useRef(false)

  const sendInit = useCallback(
    (force = false) => {
      // `ready` from the bridge and the frame's `load` both mean "the document
      // exists", and which arrives first is not fixed. Sending init twice made a
      // tool run its setup twice, which for anything that appended to state on
      // first render produced doubled content.
      if (initSentRef.current && !force) return
      initSentRef.current = true
      const { theme, dark } = readTheme()
      send({
        host: 'init',
        state: stateRef.current,
        theme,
        dark,
        tool: { id: tool.id, name: tool.name, description: tool.description }
      })
    },
    [send, tool.id, tool.name, tool.description]
  )

  /**
   * The document is pushed as soon as the frame's document exists, without waiting
   * to be asked. The bridge is installed before the tool's own code, so it is
   * always listening by then — and a tool whose script throws on its first line
   * still gets a chance to have been given its data.
   */
  const onFrameLoad = useCallback(() => {
    sendInit()
    setReady(true)
    onSurfaceReady?.()
  }, [sendInit, onSurfaceReady])

  // A new revision of the source is a different document, so the frame reloads;
  // a document change is pushed into the running frame instead, which is what
  // lets the agent rewrite a board while the user is looking at it.
  const [reloadKey, setReloadKey] = useState(0)
  const sourceRef = useRef(tool.source)
  useEffect(() => {
    if (sourceRef.current === tool.source) return
    sourceRef.current = tool.source
    setReady(false)
    setBroken(null)
    initSentRef.current = false
    genRef.current += 1
    // Whatever the old document was waiting on will never be answered, so the run
    // it claimed has to be released or the tool is stuck behind a frame that is
    // already gone.
    onFrameReplaced?.()
    setReloadKey((key) => key + 1)
  }, [tool.source, onFrameReplaced])

  useEffect(() => {
    if (ready) send({ host: 'state', state: tool.state })
  }, [ready, tool.state, send])

  useEffect(() => {
    return subscribeRun((event) => send({ host: 'run', ...event }))
  }, [subscribeRun, send])

  // The app's theme can change while a tool is open.
  useEffect(() => {
    if (!ready) return
    const observer = new MutationObserver(() => {
      const { theme, dark } = readTheme()
      send({ host: 'state', state: stateRef.current, theme, dark })
    })
    observer.observe(document.documentElement, { attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [ready, send])

  useEffect(() => {
    const onMessage = async (event: MessageEvent): Promise<void> => {
      // Only this frame's own window may speak, and only the shapes below.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return
      const data = event.data as
        | { brain: 'ready' }
        | { brain: 'error'; message: string; stack: string | null; where: string | null }
        | { brain: 'setState'; id: string; payload: { state: Record<string, unknown> } }
        | {
            brain: 'run'
            id: string
            payload: { actionId: string; inputs: Record<string, string> }
          }
        | { brain: 'cancel'; id: string }
        | { brain: 'answer'; id: string; payload: { id: string; answer: string } }
        | { brain: 'copy'; id: string; payload: { text: string } }
      if (!data || typeof data !== 'object' || typeof data.brain !== 'string') return

      // The generation this request belongs to. A reply must carry it rather than
      // whatever is current when the work finishes: if the document was replaced
      // meanwhile, the new frame drops it instead of matching it to its own
      // identically-numbered request.
      const gen = genRef.current
      const reply = (message: Record<string, unknown>): void =>
        frameRef.current?.contentWindow?.postMessage({ ...message, gen }, '*')

      if (data.brain === 'ready') {
        sendInit()
        setReady(true)
        return
      }

      if (data.brain === 'error') {
        // Reported so the agent can read it back from inspect_tool and fix its
        // own code, rather than being told "it does not work".
        void api.reportToolError(tool.id, data.message, data.stack ?? null, data.where ?? null)
        // A failure before the interface drew means there is nothing on screen.
        if (!ready) setBroken(data.message)
        return
      }

      if (data.brain === 'setState') {
        try {
          const stored = await onWrite(data.payload.state)
          reply({ host: 'reply', id: data.id, result: stored })
        } catch (err) {
          reply({ host: 'reply', id: data.id, error: errorMessage(err) })
        }
        return
      }

      if (data.brain === 'run') {
        try {
          const text = await onRun(data.payload.actionId, data.payload.inputs)
          reply({ host: 'reply', id: data.id, result: text })
        } catch (err) {
          reply({ host: 'reply', id: data.id, error: errorMessage(err) })
        }
        return
      }

      if (data.brain === 'cancel') {
        await onCancel()
        reply({ host: 'reply', id: data.id, result: true })
        return
      }

      if (data.brain === 'answer') {
        try {
          await onAnswer(data.payload.id, data.payload.answer)
          reply({ host: 'reply', id: data.id, result: true })
        } catch (err) {
          reply({ host: 'reply', id: data.id, error: errorMessage(err) })
        }
        return
      }

      // The frame cannot reach the clipboard itself — an opaque origin is refused by
      // the Clipboard API — so the host does it on its behalf.
      if (data.brain === 'copy') {
        try {
          await navigator.clipboard.writeText(data.payload.text)
          reply({ host: 'reply', id: data.id, result: true })
        } catch (err) {
          reply({ host: 'reply', id: data.id, error: errorMessage(err) })
        }
      }
    }


    const listener = (event: MessageEvent): void => void onMessage(event)
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [tool.id, onWrite, onRun, onCancel, onAnswer, send, sendInit, ready])

  // A tool with no interface yet has nothing to wait for, so a screenshot of that
  // state is fair game rather than something to time out on.
  const empty = !tool.source.trim()
  useEffect(() => {
    if (empty) onSurfaceReady?.()
  }, [empty, onSurfaceReady])

  if (empty) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-8">
        <p className="max-w-sm text-center text-[13px] leading-relaxed text-muted-foreground text-pretty">
          This tool has no interface yet. Ask for what you want it to look like in the
          panel on the right.
        </p>
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <iframe
        key={reloadKey}
        ref={frameRef}
        title={tool.name}
        // No allow-same-origin: the frame lands on an opaque origin, so it has no
        // storage and no way to reach this document.
        sandbox="allow-scripts"
        src={`brain-tool://tool/${encodeURIComponent(tool.id)}?v=${reloadKey}`}
        onLoad={onFrameLoad}
        className="size-full border-0 bg-transparent"
      />

      {!ready && !broken && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Spinner className="text-muted-foreground" />
        </div>
      )}

      {/*
        A tool whose code threw before drawing shows nothing, so this banner was the
        whole interface — and it said only what had gone wrong. Reloading is worth an
        attempt (a transient failure is real), and the agent has already been sent the
        error, so asking it to fix the tool is the actual way out.
      */}
      {broken && (
        <div className="absolute inset-x-0 bottom-0 border-t border-destructive/30 bg-destructive/10 px-3 py-2">
          <p className="text-[12px] leading-relaxed text-destructive text-pretty">
            This tool&rsquo;s code failed to run: {broken}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setBroken(null)
                setReady(false)
                initSentRef.current = false
                genRef.current += 1
                onFrameReplaced?.()
                setReloadKey((key) => key + 1)
              }}
            >
              Try again
            </Button>
            <Button size="xs" variant="ghost" onClick={onFix}>
              Ask the agent to fix it
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Pin, PinOff, ScrollText, Send } from 'lucide-react'
import type { GenUiSpec } from '@shared/genui'
import type {
  AgentEvent,
  ChecklistState,
  GraphNodeLite,
  KanbanState,
  NotepadState,
  SavedTool,
  TableState
} from '@shared/types'
import { api, errorMessage, onEvent } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Spinner } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { TooltipProvider, Tooltip } from '@/components/ui/tooltip'
import { GenUi } from '@/components/genui/GenUiRenderer'
import { ToolView } from '@/components/tools/ToolView'
import { controlsGap } from '@/lib/chrome'

/**
 * A tool in its own window.
 *
 * Two things live here and they share one document: the surface the user edits by
 * hand, and an agent that edits the same thing on request. Neither is a mode — the
 * user can drag a card while the agent is mid-rewrite, and the revision check
 * keeps whoever read stale data from clobbering the other.
 *
 * The agent's conversation belongs to this tool, not to the main chat, which is
 * the point: asking "pull today's tasks in from Slack" happens here, next to the
 * board it changes.
 */
export function ToolWindow({
  toolId,
  specId,
  focusInput,
  preview
}: {
  toolId?: string
  specId?: string
  focusInput?: boolean
  /** Offscreen render for a screenshot: no window chrome. */
  preview?: boolean
}): React.JSX.Element {
  if (preview && toolId) {
    return (
      <TooltipProvider>
        <div className="h-full bg-background">
          <ToolView toolId={toolId} preview onClose={() => {}} />
        </div>
      </TooltipProvider>
    )
  }

  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    void api.isAlwaysOnTop().then(setPinned)

    // A tool window is a separate document, so it does not inherit the class the
    // main window's store sets — without this it always renders dark.
    void api.getSettings().then((settings) => {
      document.documentElement.classList.toggle('dark', settings.appearance.theme !== 'light')
    })

    return onEvent('settings:changed', (settings) => {
      document.documentElement.classList.toggle('dark', settings.appearance.theme !== 'light')
    })
  }, [])

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-background">
        <Chrome pinned={pinned} onTogglePin={async () => setPinned(await api.toggleAlwaysOnTop())}>
          {toolId ? (
            // Same component the main window uses, so a popped-out tool behaves
            // identically rather than being a second implementation.
            <ToolView
              toolId={toolId}
              autoFocusInput={focusInput}
              closeLabel="Close this window"
              onClose={() => window.close()}
            />
          ) : specId ? (
            <SpecView specId={specId} />
          ) : null}
        </Chrome>
      </div>
    </TooltipProvider>
  )
}

function Chrome({
  pinned,
  onTogglePin,
  children
}: {
  pinned: boolean
  onTogglePin: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <header
        className="app-drag flex h-9 shrink-0 items-center justify-end gap-0.5 border-b border-border px-3"
        style={controlsGap()}
      >
        <Tooltip content="Open the log">
          <button
            type="button"
            aria-label="Open the log"
            onClick={() => void api.openLogWindow()}
            className={cn(
              'app-no-drag grid size-7 place-items-center rounded-md text-muted-foreground',
              'transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]',
              'hover:bg-accent hover:text-foreground'
            )}
          >
            <ScrollText className="size-4" />
          </button>
        </Tooltip>

        <Tooltip content={pinned ? 'Stop keeping on top' : 'Keep on top of other windows'}>
          <button
            type="button"
            aria-label="Keep on top"
            aria-pressed={pinned}
            onClick={onTogglePin}
            className={cn(
              'app-no-drag grid size-7 place-items-center rounded-md',
              'transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]',
              pinned
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {pinned ? <Pin className="size-4" /> : <PinOff className="size-4" />}
          </button>
        </Tooltip>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </>
  )
}
/* ------------------------------------------------- read-only generated view */

function SpecView({ specId }: { specId: string }): React.JSX.Element {
  const [spec, setSpec] = useState<GenUiSpec | null>(null)
  const [nodes, setNodes] = useState<GraphNodeLite[]>([])
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    void (async () => {
      const [loaded, graph] = await Promise.all([api.getGenUi(specId), api.getGraph()])
      if (!loaded) setMissing(true)
      setSpec(loaded)
      setNodes(graph.nodes)
    })()
  }, [specId])

  if (missing) {
    return (
      <div className="grid h-full place-items-center px-8">
        <p className="text-sm text-muted-foreground">This interface is no longer available.</p>
      </div>
    )
  }

  if (!spec) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-4">
      <GenUi spec={spec} nodes={nodes} onOpenNode={() => {}} onFocusNodes={() => {}} />
    </div>
  )
}

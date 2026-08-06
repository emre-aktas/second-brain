import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  CalendarClock,
  FileText,
  MessageSquare,
  Plug,
  ScrollText,
  Search,
  Settings,
  Wand2,
  X,
  type LucideIcon
} from 'lucide-react'
import type { UsageBucketDto } from '@shared/ipc'
import { activeChat, useApp, type Panel } from '@/store/app'
import { api, onEvent } from '@/lib/api'
import { useReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { GraphCanvas } from '@/components/graph/GraphCanvas'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { NotePanel } from '@/components/panels/NotePanel'
import { ActivityPanel, SettingsPanel } from '@/components/panels/SidePanels'
import { ScheduledPanel } from '@/components/panels/ScheduledPanel'
import { ToolsPanel } from '@/components/panels/ToolsPanel'
import { ToolView } from '@/components/tools/ToolView'
import { CommandPalette } from '@/components/CommandPalette'
import { Spinner } from '@/components/ui/base'
import { Toaster, toast } from '@/components/ui/sonner'
import { TooltipProvider, Tooltip } from '@/components/ui/tooltip'
import { controlsGap, isMac, modifierLabel } from '@/lib/chrome'

const MIN_PANEL = 340
// Deliberately generous: a generated interface can be a kanban board or a wide
// table, and clamping the panel to a "reading width" fights that.
const MAX_PANEL = 1600

/**
 * A panel width this window can actually accommodate.
 *
 * Leaves a sliver of graph visible rather than letting the panel eat the window. Shared by
 * the drag and by the restore, because they have to agree: a bound applied only while
 * dragging is a bound a saved value walks straight past.
 */
function clampPanel(width: number): number {
  const ceiling = Math.max(MIN_PANEL, Math.min(MAX_PANEL, window.innerWidth - 160))
  return Math.min(ceiling, Math.max(MIN_PANEL, width))
}

export function App(): React.JSX.Element {
  const ready = useApp((s) => s.ready)
  const init = useApp((s) => s.init)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    void init().catch((err: unknown) => {
      setFailure(err instanceof Error ? err.message : String(err))
    })
  }, [init])

  if (failure) {
    return (
      <div className="grid h-full place-items-center px-8">
        <div className="max-w-md text-center">
          <p className="text-sm font-medium text-destructive">Second Brain could not start</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground text-pretty">{failure}</p>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  return (
    <TooltipProvider>
      <Shell />
      <CommandPalette />
      <Toaster />
    </TooltipProvider>
  )
}

function Shell(): React.JSX.Element {
  const graph = useApp((s) => s.graph)
  const stats = useApp((s) => s.stats)
  const settings = useApp((s) => s.settings)
  const panel = useApp((s) => s.panel)
  const setPanel = useApp((s) => s.setPanel)
  const selectedNodeId = useApp((s) => s.selectedNodeId)
  const selectNode = useApp((s) => s.selectNode)
  const clearFocus = useApp((s) => s.clearFocus)
  const openNode = useApp((s) => s.openNode)
  const focusRequest = useApp((s) => s.focusRequest)
  const pulses = useApp((s) => s.pulses)
  const suggestions = useApp((s) => s.suggestions)
  const agentState = useApp((s) => activeChat(s).agentState)
  const agentAuth = useApp((s) => s.bootstrap?.agent.auth ?? null)
  const budget = useApp((s) => s.budget)
  const usage = useApp((s) => s.usage)
  const focusNodes = useApp((s) => s.focusNodes)
  const sendMessage = useApp((s) => s.sendMessage)
  const openToolId = useApp((s) => s.openToolId)
  const closeTool = useApp((s) => s.closeTool)

  // The windows move on their own, so the readout is nudged on a slow tick even
  // when no turn is running. The tick only asks; the answer arrives on
  // `usage:changed` once the background read finishes, so nothing here waits.
  useEffect(() => {
    const nudge = (): void => void useApp.getState().refreshUsage()
    const timer = setInterval(nudge, 120_000)
    const off = onEvent('usage:changed', (snapshot) => useApp.setState({ usage: snapshot }))
    return () => {
      clearInterval(timer)
      off()
    }
  }, [])

  const updateSettings = useApp((s) => s.updateSettings)
  const savedPanelWidth = useApp((s) => s.settings?.layout?.panelWidth)

  const [panelWidth, setPanelWidth] = useState(430)
  /**
   * Whether the saved width has been applied.
   *
   * Once, and only once. Committing a resize broadcasts the new settings back to every
   * window, including this one — so an effect that simply followed `savedPanelWidth` would
   * receive its own write and fight the next drag with a value one commit stale.
   */
  const hydratedWidthRef = useRef(false)
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const reduceMotion = useReduceMotion()

  // Idle detection for the curator lives in the main process, so the renderer
  // just reports that a human is present. Throttled to once every 20s.
  useEffect(() => {
    let last = 0
    const report = (): void => {
      const now = Date.now()
      if (now - last < 20_000) return
      last = now
      void api.reportUserActivity()
    }

    report()
    for (const event of ['pointerdown', 'keydown', 'wheel'] as const) {
      window.addEventListener(event, report, { passive: true })
    }
    return () => {
      for (const event of ['pointerdown', 'keydown', 'wheel'] as const) {
        window.removeEventListener(event, report)
      }
    }
  }, [])

  /**
   * Escape backs out one level of attention.
   *
   * The agent's focus first, then the selection — one press per level, so a focus that
   * arrived while the user was reading does not also cost them their selected note. This is
   * the keyboard half of the same fix as the empty-canvas click; without it the only way
   * out of a focus was a gesture nobody would guess at.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return

      // Not while something is typing or a dialog owns the key.
      const active = document.activeElement
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      if (typing) return

      if (useApp.getState().focusRequest) {
        useApp.getState().clearFocus()
        return
      }
      if (useApp.getState().selectedNodeId) useApp.getState().selectNode(null)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // The width the user last dragged it to, restored on launch.
  useEffect(() => {
    if (hydratedWidthRef.current || savedPanelWidth === undefined) return
    hydratedWidthRef.current = true
    // Clamped against *this* window. A width saved on a wide monitor, restored on a laptop,
    // would otherwise open with the panel covering the graph entirely — which is the
    // failure that persisting a layout introduces if nothing bounds it on the way back in.
    setPanelWidth(clampPanel(savedPanelWidth))
  }, [savedPanelWidth])

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    resizeRef.current = { startX: event.clientX, startWidth: panelWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = resizeRef.current
    if (!state) return
    setPanelWidth(clampPanel(state.startWidth - (event.clientX - state.startX)))
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    resizeRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)

    // On release, not on every pointer move. Each commit is an IPC round trip, a
    // synchronous write of the whole settings file and a broadcast to every window; one
    // drag across the screen would be dozens of them.
    if (panelWidth !== savedPanelWidth) {
      void updateSettings({ layout: { panelWidth } })
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* The native window controls are overlaid on this strip — on the right on
          Windows, on the left on macOS, which is why both ends are padded from the
          same shared constant rather than a hardcoded margin. */}
      <header className="app-drag flex h-[38px] shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2" style={isMac() ? controlsGap() : undefined}>
          <span className="text-[12px] font-semibold tracking-tight text-foreground">Second Brain</span>
          {stats && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {stats.notes} notes · {stats.edges} links
            </span>
          )}
        </div>
        <div
          className="app-no-drag flex items-center gap-1.5"
          style={isMac() ? undefined : controlsGap()}
        >
          <button
            type="button"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}
            className="flex items-center gap-1.5 rounded-md border border-border/70 bg-secondary/50 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-secondary"
          >
            Search
            <span className="font-sans">{modifierLabel()} K</span>
          </button>

          <Tooltip content="Open the log">
            <button
              type="button"
              aria-label="Open the log"
              onClick={() => void api.openLogWindow()}
              className={cn(
                'grid size-6 place-items-center rounded-md text-muted-foreground',
                'transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-90',
                'hover:bg-accent hover:text-foreground'
              )}
            >
              <ScrollText className="size-3.5" />
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          {/* A tool takes the main area rather than opening beside the app: it is
              part of this application, and a board needs the room. */}
          {openToolId ? (
            <ToolView toolId={openToolId} onClose={closeTool} />
          ) : (
            <>
          <GraphCanvas
            snapshot={graph}
            selectedId={selectedNodeId}
            onSelect={(id) => {
              selectNode(id)
              // A click on empty canvas means "I am done looking at that". It cleared the
              // selection and left the agent's focus in place, which is what kept the
              // graph dimmed with no way back.
              if (id === null) clearFocus()
            }}
            onOpen={openNode}
            onPositionsSettled={(positions) => void api.savePositions(positions).catch(() => undefined)}
            focusRequest={focusRequest}
            pulses={pulses}
            onNodeAction={(action, node) => {
              switch (action) {
                case 'neighbourhood':
                  void api
                    .getNeighborhood(node.id, 1)
                    .then((hood) => focusNodes(hood.nodes.map((n) => n.id), node.title))
                    .catch(() => focusNodes([node.id], node.title))
                  break
                case 'ask':
                  setPanel('chat')
                  void sendMessage(
                    `Tell me about "${node.title}" (${node.id}) — what it connects to, what is missing, and anything worth acting on.`
                  )
                  break
                case 'link':
                  setPanel('chat')
                  void sendMessage(
                    `I want to connect "${node.title}" (${node.id}) to something. Suggest the best candidates from my vault with your reasoning, then link the one you are most confident about.`
                  )
                  break
                case 'pin':
                case 'unpin':
                  void api.setPinned(node.id, action === 'pin').catch(() => undefined)
                  break
                case 'reveal':
                  void api.revealNote(node.id).catch(() => undefined)
                  break
                case 'trash':
                  void api
                    .trashNote(node.id)
                    .then(() => toast.success(`"${node.title}" moved to trash`))
                    .catch((err: unknown) =>
                      toast.error('Could not move it', { description: String(err) })
                    )
                  break
              }
            }}
            settings={{
              linkDistance: settings?.graph.linkDistance ?? 70,
              charge: settings?.graph.charge ?? -260,
              labelThreshold: settings?.graph.labelThreshold ?? 0.75,
              rotate: settings?.graph.rotate ?? true
            }}
            reduceMotion={reduceMotion}
            agentBusy={agentState !== 'idle' && agentState !== 'error'}
          />

          {focusRequest?.note && (
            // Bottom-left, beside the other caption the agent writes, because top-left is
            // where the first-run hint and the legend live and this was covering them.
            <div className="absolute bottom-14 left-4 flex max-w-md items-start gap-2 rounded-md border border-primary/25 bg-card/90 px-3 py-2 shadow-sm backdrop-blur-sm">
              <p className="text-[12.5px] leading-relaxed text-foreground text-pretty">
                {focusRequest.note}
              </p>
              <button
                type="button"
                onClick={clearFocus}
                aria-label="Stop focusing"
                className="-mr-1 mt-px grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors duration-150 ease-[var(--ease-out)] hover:bg-accent hover:text-foreground active:scale-[0.96]"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          <ProbeCaption />
            </>
          )}
        </main>

        <div
          onPointerDown={startResize}
          onPointerMove={onResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className="w-1 shrink-0 cursor-col-resize bg-border transition-colors duration-150 hover:bg-primary/40"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
        />

        <aside
          className="flex min-h-0 shrink-0 flex-col border-l border-border bg-sidebar"
          style={{ width: panelWidth }}
        >
          <PanelRail panel={panel} onChange={setPanel} suggestionCount={suggestions.length} />
          <div className="min-h-0 flex-1">
            {panel === 'chat' && <ChatPanel />}
            {panel === 'note' && <NotePanel />}
            {panel === 'tools' && <ToolsPanel />}
            {panel === 'tasks' && <ScheduledPanel />}
            {panel === 'activity' && <ActivityPanel />}
            {panel === 'settings' && <SettingsPanel />}
          </div>
        </aside>
      </div>

      <footer className="flex h-[26px] shrink-0 items-center justify-between border-t border-border px-3 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                'size-1.5 rounded-full',
                agentState === 'idle' && 'bg-muted-foreground/50',
                (agentState === 'thinking' || agentState === 'starting') && 'bg-primary',
                agentState === 'working' && 'bg-info',
                agentState === 'error' && 'bg-destructive'
              )}
              aria-hidden="true"
            />
            {agentState === 'idle' ? 'Ready' : agentState === 'working' ? 'Using tools' : agentState}
          </span>
          {stats && stats.orphans > 0 && (
            <button
              type="button"
              onClick={() => setPanel('activity')}
              className="transition-colors duration-150 hover:text-foreground"
            >
              {stats.orphans} unconnected
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Deliberately no cost figure: usage comes out of the signed-in Claude
              plan, and showing an equivalent dollar amount reads as a charge. */}
          {usage?.rateLimit && Date.now() - usage.rateLimit.at < 6 * 3600_000 && (
            <span className="text-destructive">
              Limit hit
              {usage.rateLimit.resetsAt
                ? ` · resets ${new Date(usage.rateLimit.resetsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </span>
          )}

          {usage?.available && (
            <Tooltip content={usage.caveat ?? 'Plan usage, as reported by Claude Code.'}>
              <span className="cursor-default tabular-nums">
                {usage.session && <UsageReadout label="5h" bucket={usage.session} />}
                {usage.session && usage.week && ' · '}
                {usage.week && <UsageReadout label="week" bucket={usage.week} />}
              </span>
            </Tooltip>
          )}

          {budget?.enabled && (
            <span className={cn('tabular-nums', budget.blocked && 'text-destructive')}>
              {budget.blocked
                ? 'Daily cap reached'
                : `cap ${Math.round((budget.spentToday / Math.max(0.01, budget.dailyLimitUsd)) * 100)}%`}
            </span>
          )}
          {agentAuth?.onSubscription && agentAuth.subscriptionType && (
            <span className="capitalize">{agentAuth.subscriptionType} plan</span>
          )}
          {settings?.curator.enabled && <span>Curating in background</span>}
        </div>
      </footer>
    </div>
  )
}

const PANELS: { id: Panel; label: string; Icon: LucideIcon }[] = [
  { id: 'chat', label: 'Conversation', Icon: MessageSquare },
  { id: 'note', label: 'Note', Icon: FileText },
  { id: 'tools', label: 'Tools', Icon: Wand2 },
  { id: 'tasks', label: 'Scheduled', Icon: CalendarClock },
  { id: 'activity', label: 'Activity', Icon: Activity },
  { id: 'settings', label: 'Settings', Icon: Settings }
]

/** One usage window as a percentage of the plan, with the reset time on hover. */
/**
 * What the agent is looking for, while it is looking.
 *
 * Lives with the sweep rather than in the transcript: the point of lighting up the
 * nodes is that the search is happening in front of you, and a search you can watch
 * without knowing the query is just flashing lights.
 */
function ProbeCaption(): React.JSX.Element | null {
  const probeLabel = useApp((s) => s.probeLabel)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!probeLabel) return
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 2600)
    return () => clearTimeout(timer)
  }, [probeLabel])

  if (!probeLabel || !visible) return null

  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-4 left-4 flex items-center gap-2 rounded-full',
        'border border-primary/25 bg-card/90 px-3 py-1 shadow-sm backdrop-blur-sm',
        'animate-in fade-in slide-in-from-bottom-1 duration-200 ease-[var(--ease-out)]'
      )}
    >
      <Search className="size-3 text-primary" />
      <span className="text-[11.5px] text-muted-foreground">
        Looking for <span className="text-foreground">{probeLabel.text}</span>
      </span>
    </div>
  )
}

function UsageReadout({ label, bucket }: { label: string; bucket: UsageBucketDto }): React.JSX.Element {
  return (
    <span
      title={bucket.resetsAt ? `resets ${bucket.resetsAt}` : undefined}
      className={cn(
        bucket.percent >= 90 && 'text-destructive',
        bucket.percent >= 70 && bucket.percent < 90 && 'text-warning'
      )}
    >
      {label} {Math.round(bucket.percent)}%
    </span>
  )
}

function PanelRail({
  panel,
  onChange,
  suggestionCount
}: {
  panel: Panel
  onChange: (panel: Panel) => void
  suggestionCount: number
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1.5">
      {PANELS.map((entry) => (
        <Tooltip key={entry.id} content={entry.label}>
          <button
            type="button"
            aria-label={entry.label}
            aria-current={panel === entry.id}
            onClick={() => onChange(entry.id)}
            className={cn(
              'relative grid size-7 place-items-center rounded-md',
              'transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]',
              panel === entry.id
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            <entry.Icon className="size-4" />
            {entry.id === 'activity' && suggestionCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-[14px] text-primary-foreground">
                {suggestionCount > 9 ? '9+' : suggestionCount}
              </span>
            )}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

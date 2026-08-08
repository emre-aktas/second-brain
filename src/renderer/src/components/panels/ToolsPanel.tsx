import { useEffect, useState } from 'react'
import {
  BarChart3,
  Bell,
  Bookmark,
  Brain,
  Calendar,
  CheckSquare,
  ClipboardList,
  Clock,
  Code,
  ExternalLink,
  FileText,
  Filter,
  Globe,
  Image,
  Inbox,
  Settings2,
  Languages,
  Lightbulb,
  Link2,
  Mail,
  MessageSquare,
  Mic,
  Network,
  Newspaper,
  NotebookPen,
  Pin,
  PinOff,
  Play,
  Presentation,
  RefreshCw,
  Search,
  Send,
  Share2,
  Sparkles,
  Table,
  Tags,
  Target,
  Trash2,
  TrendingUp,
  Users,
  Video,
  Wand2,
  X,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { AgentEffort, SavedTool } from '@shared/types'
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '@shared/types'
import type { EngineState, ModelInfo } from '@shared/engines'
import { api, errorMessage } from '@/lib/api'
import { useApp } from '@/store/app'
import { cn, formatRelativeTime } from '@/lib/utils'
import { formatHotkey } from '@shared/hotkey'
import {
  Badge,
  Card,
  EmptyState,
  Kbd,
  Label,
  NativeSelect,
  Spinner,
  Switch
} from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/sonner'

/**
 * Icons a saved tool may use.
 *
 * A curated map rather than a namespace import of lucide: importing the whole set
 * to resolve a name dynamically costs close to a megabyte in the bundle, and this
 * covers what the agent actually reaches for. Anything unrecognised falls back.
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  wand: Wand2,
  sparkles: Sparkles,
  image: Image,
  video: Video,
  mic: Mic,
  mail: Mail,
  send: Send,
  inbox: Inbox,
  calendar: Calendar,
  clock: Clock,
  search: Search,
  filter: Filter,
  globe: Globe,
  link: Link2,
  network: Network,
  brain: Brain,
  note: NotebookPen,
  file: FileText,
  bookmark: Bookmark,
  tags: Tags,
  table: Table,
  chart: BarChart3,
  trending: TrendingUp,
  target: Target,
  checklist: CheckSquare,
  clipboard: ClipboardList,
  code: Code,
  message: MessageSquare,
  users: Users,
  bell: Bell,
  refresh: RefreshCw,
  share: Share2,
  news: Newspaper,
  presentation: Presentation,
  idea: Lightbulb,
  lightbulb: Lightbulb,
  zap: Zap
}

/** Resolve an agent-supplied icon name, falling back rather than crashing. */
export function toolIcon(name: string | null): LucideIcon {
  if (!name) return Wand2

  const key = name.toLowerCase().replace(/[^a-z]/g, '')
  if (TOOL_ICONS[key]) return TOOL_ICONS[key]

  // Tolerate near-misses like "image-generation" or "calendar_event".
  const partial = Object.keys(TOOL_ICONS).find((candidate) => key.includes(candidate))
  return partial ? TOOL_ICONS[partial] : Wand2
}

export const TOOL_ICON_NAMES = Object.keys(TOOL_ICONS)

export function ToolsPanel(): React.JSX.Element {
  const tools = useApp((s) => s.tools)
  const refreshTools = useApp((s) => s.refreshTools)
  const runTool = useApp((s) => s.runTool)
  const [loading, setLoading] = useState(tools.length === 0)
  const [running, setRunning] = useState<SavedTool | null>(null)

  useEffect(() => {
    void refreshTools().finally(() => setLoading(false))
  }, [refreshTools])

  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold text-foreground">Tools</h2>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-3 py-3">
          {tools.length === 0 ? (
            <EmptyState
              title="No tools yet"
              description="When the agent works something out that you are likely to want again, it saves it here as a one-click tool. You can also just ask it to make one."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    useApp.getState().setPanel('chat')
                    void useApp
                      .getState()
                      .sendMessage(
                        'Look at what I have been doing and suggest two or three reusable tools worth saving. Save the ones I agree to.'
                      )
                  }}
                >
                  <Sparkles className="size-3.5" />
                  Suggest some
                </Button>
              }
            />
          ) : (
            tools.map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                onRun={() => {
                  if (tool.params.length === 0) void runTool(tool, {})
                  else setRunning(tool)
                }}
                onTogglePin={() => void api.setToolPinned(tool.id, !tool.pinned).then(refreshTools)}
                onRemove={() =>
                  void api
                    .removeTool(tool.id)
                    .then(refreshTools)
                    .then(() => toast.success(`Removed "${tool.name}"`))
                }
              />
            ))
          )}
        </div>
      </ScrollArea>

      {running && (
        <ToolRunDialog
          tool={running}
          onClose={() => setRunning(null)}
          onRun={(values) => {
            void runTool(running, values)
            setRunning(null)
          }}
        />
      )}
    </div>
  )
}

function ToolCard({
  tool,
  onRun,
  onTogglePin,
  onRemove
}: {
  tool: SavedTool
  onRun: () => void
  onTogglePin: () => void
  onRemove: () => void
}): React.JSX.Element {
  const Icon = toolIcon(tool.icon)
  const interactive = tool.kind !== 'prompt'
  // "kanban" or "checklist" tells the user what they are opening; "code", "canvas"
  // and "workbench" are our words for how it was built, and say nothing useful.
  const kindLabel = ['prompt', 'code', 'canvas', 'workbench'].includes(tool.kind)
    ? null
    : tool.kind
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <Card className="bg-card/60 px-2.5 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
          <Icon className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            <span className="truncate">{tool.name}</span>
            {kindLabel && (
              <Badge tone="accent" className="shrink-0 px-1.5 py-0 text-[10px]">
                {kindLabel}
              </Badge>
            )}
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground text-pretty">
            {tool.description}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/80">
            {tool.hotkey && (
              <Kbd className="h-4 px-1 text-[10px]">{formatHotkey(tool.hotkey, window.brain.platform)}</Kbd>
            )}
            <span>
              {tool.runCount > 0
                ? `run ${tool.runCount}× · last ${formatRelativeTime(tool.lastRunAt ?? tool.updatedAt)}`
                : 'never run'}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {/*
            A gear, because the panel behind it is settings.

            It was a keyboard, from when a shortcut was the only thing in there. It has held the
            window options for a while and now holds the model and thinking level too — an icon
            that names one row of a panel sends people looking for the rest elsewhere.
          */}
          {interactive && (
            <Tooltip content="Tool settings">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Tool settings"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((value) => !value)}
                className={cn(settingsOpen && 'text-foreground')}
              >
                <Settings2 className="size-3.5" />
              </Button>
            </Tooltip>
          )}
          <Tooltip content={tool.pinned ? 'Unpin' : 'Pin to the composer'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tool.pinned ? 'Unpin' : 'Pin'}
              onClick={onTogglePin}
              className={cn(tool.pinned && 'text-primary')}
            >
              {tool.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </Button>
          </Tooltip>
          <Tooltip content="Remove">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove"
              onClick={onRemove}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </Tooltip>
        </div>
      </div>

      {settingsOpen && interactive && (
        <ToolShortcutSettings tool={tool} onChanged={() => useApp.getState().refreshTools()} />
      )}

      <div className="mt-2 flex gap-1.5">
        {/* An interactive tool opens as an application; a prompt tool either
            reopens what it last produced or runs to make a new one. */}
        {interactive ? (
          <>
            {/* Opens in the main area. The separate window is a deliberate
                secondary choice, not the way tools normally work. */}
            <Button
              size="xs"
              className="flex-1"
              onClick={() => {
                // Honour the tool's own preference; the icon beside it is the
                // one-off override.
                if (tool.openInWindow) {
                  void api.openToolWindow(tool.id, tool.name, tool.alwaysOnTop)
                } else {
                  useApp.getState().openTool(tool.id)
                }
              }}
            >
              <Play className="size-3" />
              Open
            </Button>
            <Tooltip
              content={tool.openInWindow ? 'Open in the main area' : 'Open in a separate window'}
            >
              <Button
                size="xs"
                variant="ghost"
                aria-label="Open the other way"
                onClick={() => {
                  if (tool.openInWindow) useApp.getState().openTool(tool.id)
                  else void api.openToolWindow(tool.id, tool.name, tool.alwaysOnTop)
                }}
              >
                <ExternalLink className="size-3" />
              </Button>
            </Tooltip>
          </>
        ) : (
          <>
            {tool.lastSpecId && (
              <Button
                size="xs"
                className="flex-1"
                onClick={() => void api.openSpecWindow(tool.lastSpecId!, tool.name)}
              >
                <ExternalLink className="size-3" />
                Open
              </Button>
            )}
            <Button
              size="xs"
              variant={tool.lastSpecId ? 'outline' : 'secondary'}
              className="flex-1"
              onClick={onRun}
            >
              <Play className="size-3" />
              {tool.lastSpecId ? 'Refresh' : 'Run'}
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}

/**
 * Shortcut and window options for one tool.
 *
 * Captures the key combination by listening for the actual keypress rather than
 * asking the user to type "Ctrl+Shift+T" — that is the only way to get this right
 * without them guessing the syntax.
 */
function ToolShortcutSettings({
  tool,
  onChanged
}: {
  tool: SavedTool
  onChanged: () => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const onKeyDown = async (event: React.KeyboardEvent): Promise<void> => {
    event.preventDefault()

    if (event.key === 'Escape') {
      setCapturing(false)
      return
    }

    // Modifiers alone are not a shortcut; wait for the real key.
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return

    const parts: string[] = []
    if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key)

    setCapturing(false)
    const result = await api.setToolHotkey(tool.id, parts.join('+'))
    setMessage(result.message)
    onChanged()
  }

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">Global shortcut</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onKeyDown={(event) => void onKeyDown(event)}
            onClick={() => {
              setCapturing(true)
              setMessage(null)
            }}
            onBlur={() => setCapturing(false)}
            className={cn(
              'rounded-md border px-2 py-0.5 text-[11px] transition-colors duration-150',
              capturing
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-input text-foreground hover:border-ring/60'
            )}
          >
            {capturing
              ? 'Press keys…'
              : tool.hotkey
                ? formatHotkey(tool.hotkey, window.brain.platform)
                : 'Set'}
          </button>

          {tool.hotkey && (
            <button
              type="button"
              aria-label="Clear shortcut"
              onClick={async () => {
                const result = await api.setToolHotkey(tool.id, null)
                setMessage(result.message)
                onChanged()
              }}
              className="text-muted-foreground/60 transition-colors duration-150 hover:text-destructive"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">Open in its own window</span>
        <Switch
          checked={tool.openInWindow}
          onCheckedChange={async (openInWindow) => {
            await api.setToolWindowPrefs({ id: tool.id, openInWindow })
            onChanged()
          }}
        />
      </div>

      {tool.openInWindow && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">Keep above other apps</span>
          <Switch
            checked={tool.alwaysOnTop}
            onCheckedChange={async (alwaysOnTop) => {
              await api.setToolWindowPrefs({ id: tool.id, alwaysOnTop })
              onChanged()
            }}
          />
        </div>
      )}

      {/*
        A tool's jobs are not the app's jobs: a phrase rewriter wants the fastest model on the
        smallest budget so a press feels instant, a weekly review wants the opposite.

        Offered in the *selected engine's* vocabulary, because that is the only vocabulary the
        choice can be made in. It used to be a fixed list of four Claude names and five Claude
        tiers whatever the engine was — so on Codex it offered "Opus 5", and the manager, quite
        correctly, threw the answer away rather than send a name Codex has never heard of. The
        setting was visible, settable, and inert.
      */}
      <ToolEnginePrefs tool={tool} onChanged={onChanged} />

      {message && (
        <p className="text-[11px] leading-relaxed text-muted-foreground text-pretty">{message}</p>
      )}
    </div>
  )
}


/**
 * This tool's model and thinking level, in the terms of whatever engine is running.
 *
 * Reads the same two sources the Engine tab does — the selected provider and its catalogue — so
 * there is one answer to "what can I choose" rather than two that drift. The stored value is
 * keyed by provider, so switching engine shows that engine's choice and leaves the others alone;
 * switching back finds the old one.
 *
 * Codex publishes its thinking levels per model and those are used verbatim (they include levels
 * the app's own union does not have); everyone else gets the app's five, which `reasoningPatch`
 * knows how to say in each provider's dialect.
 */
function ToolEnginePrefs({
  tool,
  onChanged
}: {
  tool: SavedTool
  onChanged: () => void
}): React.JSX.Element {
  const [engine, setEngine] = useState<EngineState | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [configured, setConfigured] = useState<{ model: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const state = await api.engineState()
        if (cancelled) return
        setEngine(state)

        // The Claude CLI publishes no catalogue; its four names are the app's own short list.
        if (state.capabilities.engine === 'claude-cli') return
        const result = await api.engineModels(state.selectedProviderId)
        if (cancelled) return
        setModels(result.models)
        setConfigured(result.configured ?? null)
      } catch {
        // A provider that cannot be reached leaves the pickers on "app default", which is the
        // honest state: nothing can be chosen from a list that did not arrive.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!engine) return <></>

  const providerId = engine.selectedProviderId
  const claude = engine.capabilities.engine === 'claude-cli'
  const current = tool.enginePrefs[providerId] ?? {}

  const modelOptions = claude
    ? MODEL_OPTIONS.map((option) => ({ value: option.id, label: option.label }))
    : models.map((model) => ({ value: model.id, label: model.label }))

  /*
   * Codex's levels belong to the model, and the model may be the one in the user's own config.
   *
   * A tool that follows the app's model still has a model — whatever Codex is set to — so its
   * levels are the ones to offer. Without resolving that, choosing "app default" for the model
   * would leave the thinking picker empty for the commonest case.
   */
  const codexModel = current.model || configured?.model || ''
  const levels = models.find((model) => model.id === codexModel)?.reasoningLevels ?? []
  const effortOptions =
    engine.capabilities.engine === 'codex-cli'
      ? levels.map((level: { effort: string }) => ({ value: level.effort, label: level.effort }))
      : EFFORT_OPTIONS.map((option) => ({ value: option.id, label: option.label }))

  const save = async (prefs: { model?: string | null; effort?: string | null }): Promise<void> => {
    await api.setToolModelPrefs({ id: tool.id, ...prefs })
    onChanged()
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          Model
          {/* Named, so it is obvious the choice belongs to this engine and not to all of them. */}
          <span className="ml-1 opacity-60">on {engine.capabilities.providerId}</span>
        </span>
        <NativeSelect
          aria-label="Model for this tool"
          value={current.model ?? ''}
          onChange={(value) => void save({ model: value === '' ? null : value })}
          options={[{ value: '', label: 'App default' }, ...modelOptions]}
        />
      </div>

      {/*
        Hidden rather than shown empty when the engine publishes no levels for the chosen model,
        because an empty picker reads as a broken control rather than as an absent capability.
      */}
      {effortOptions.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">Thinking</span>
          <NativeSelect
            aria-label="Thinking budget for this tool"
            value={current.effort ?? ''}
            onChange={(value) => void save({ effort: value === '' ? null : value })}
            options={[{ value: '', label: 'App default' }, ...effortOptions]}
          />
        </div>
      )}
    </>
  )
}

function ToolRunDialog({
  tool,
  onClose,
  onRun
}: {
  tool: SavedTool
  onClose: () => void
  onRun: (values: Record<string, string>) => void
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(tool.params.map((param) => [param.name, param.default ?? '']))
  )

  const missing = tool.params.filter((param) => param.required && !values[param.name]?.trim())

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{tool.name}</DialogTitle>
          <DialogDescription>{tool.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {tool.params.map((param) => (
            <div key={param.name}>
              <Label htmlFor={param.name} className="text-[12px] text-muted-foreground">
                {param.label}
                {param.required && <span className="text-destructive"> *</span>}
              </Label>
              <div className="mt-1">
                {param.multiline ? (
                  <Textarea
                    id={param.name}
                    value={values[param.name] ?? ''}
                    placeholder={param.placeholder}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [param.name]: event.target.value }))
                    }
                    className="min-h-24 text-[13px]"
                  />
                ) : (
                  <Input
                    id={param.name}
                    value={values[param.name] ?? ''}
                    placeholder={param.placeholder}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [param.name]: event.target.value }))
                    }
                    className="text-[13px]"
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={missing.length > 0} onClick={() => onRun(values)}>
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Pinned tools, sitting above the composer for one-click reuse. */
export function PinnedToolStrip(): React.JSX.Element | null {
  const tools = useApp((s) => s.tools)
  const runTool = useApp((s) => s.runTool)
  const [running, setRunning] = useState<SavedTool | null>(null)

  const pinned = tools.filter((tool) => tool.pinned)
  if (pinned.length === 0) return null

  return (
    <>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {pinned.map((tool) => {
          const Icon = toolIcon(tool.icon)
          return (
            <Tooltip key={tool.id} content={tool.description}>
              <button
                type="button"
                onClick={() => {
                  // Interactive tools open in place; a prompt tool reopens its last
                  // result, and only a first run costs a turn.
                  if (tool.kind !== 'prompt') {
                    if (tool.openInWindow) {
                      void api.openToolWindow(tool.id, tool.name, tool.alwaysOnTop)
                    } else {
                      useApp.getState().openTool(tool.id)
                    }
                  } else if (tool.lastSpecId) void api.openSpecWindow(tool.lastSpecId, tool.name)
                  else if (tool.params.length === 0) void runTool(tool, {})
                  else setRunning(tool)
                }}
                className="flex items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[12px] text-foreground transition-[background-color,transform] duration-150 ease-[var(--ease-out)] hover:bg-accent active:scale-[0.96]"
              >
                <Icon className="size-3.5 text-muted-foreground" />
                {tool.name}
              </button>
            </Tooltip>
          )
        })}
      </div>

      {running && (
        <ToolRunDialog
          tool={running}
          onClose={() => setRunning(null)}
          onRun={(values) => {
            void runTool(running, values)
            setRunning(null)
          }}
        />
      )}
    </>
  )
}

export { errorMessage }

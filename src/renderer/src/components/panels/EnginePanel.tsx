import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Cpu,
  ExternalLink,
  KeyRound,
  Loader2,
  Minus,
  Repeat,
  Search,
  Sparkles,
  Wallet
} from 'lucide-react'
import type { EngineState, ModelInfo, ProviderState } from '@shared/engines'
import { api, errorMessage } from '@/lib/api'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Badge, Card, Label, Spinner } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from '@/components/ui/sonner'
import { ClaudeEngineDetails } from '@/components/panels/SidePanels'

/**
 * Choosing what runs the agent.
 *
 * Its own tab rather than a section of Settings, because the choice has more parts than a
 * setting does — a provider, a credential, a model out of several hundred, a base URL for the
 * ones that need it — and because it is the one screen where getting it wrong means the app
 * does nothing at all. Settings is where you adjust something that already works.
 *
 * Laid out as steps for the same reason an installer is: the questions have an order, each one
 * narrows the next, and asking all of them at once produces a form where every field is
 * disabled until some other field is filled in. Pick a provider, give it a key, choose a model,
 * check it works. The step you are on is the only one on screen.
 *
 * What is *not* here matters as much: nothing about the vault, the chat history, the saved
 * tools or the schedule. Changing engine changes who answers and nothing else, and the panel
 * says so, because "will this wipe my notes" is the first thing anyone sensible would wonder.
 */

type Step = 'provider' | 'credential' | 'model' | 'done'

function priceLabel(model: ModelInfo): string | null {
  if (model.promptPrice === null && model.completionPrice === null) return null
  if (model.promptPrice === 0 && model.completionPrice === 0) return 'free'
  const fmt = (n: number | null): string => (n === null ? '?' : n < 1 ? n.toFixed(2) : n.toFixed(0))
  return `$${fmt(model.promptPrice)} in · $${fmt(model.completionPrice)} out per 1M`
}

export function EnginePanel(): React.JSX.Element {
  const [state, setState] = useState<EngineState | null>(null)
  const [step, setStep] = useState<Step>('done')
  /** The provider being set up, which is not yet the selected one. */
  const [draftId, setDraftId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await api.engineState())
    } catch (err) {
      toast.error('Could not read the engine settings', { description: errorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!state) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  const selected = state.providers.find((entry) => entry.selected)
  const draft = draftId ? state.providers.find((entry) => entry.provider.id === draftId) : null

  const begin = async (providerId: string): Promise<void> => {
    const entry = state.providers.find((p) => p.provider.id === providerId)
    if (!entry) return

    /*
     * A CLI has nothing to ask, so choosing it *is* the whole flow.
     *
     * This used to open a setup with no steps in it and never switch anything, which read as
     * the button being dead — Codex could be clicked and nothing happened. There is no
     * credential to collect and no catalogue to browse: the binary is signed in already, so the
     * only honest response to the click is to select it.
     */
    if (entry.provider.engine !== 'openai-compatible') {
      if (!entry.installed) {
        toast.error(`${entry.provider.label} is not installed on this machine`, {
          description: entry.provider.keyUrl ? `Install it from ${entry.provider.keyUrl}` : undefined
        })
        return
      }
      setBusy(true)
      try {
        setState(await api.selectEngine(providerId))
        setStep('done')
        toast.success(`${entry.provider.label} is now running the agent`)
      } catch (err) {
        toast.error('Could not switch', { description: errorMessage(err) })
      } finally {
        setBusy(false)
      }
      return
    }

    setDraftId(providerId)
    // Skip a step with nothing to ask: a provider whose key is already stored goes straight to
    // the model.
    setStep(entry.provider.needsKey && !entry.configured ? 'credential' : 'model')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <Cpu className="size-3.5" />
          Engine
        </h2>
        {step !== 'done' && (
          <Button size="xs" variant="ghost" onClick={() => { setStep('done'); setDraftId(null) }}>
            <ArrowLeft className="size-3" />
            Back
          </Button>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-3 py-3">
          {step === 'done' && (
            <Overview
              onChangeEngine={() => setStep('provider')}
              state={state}
              selected={selected ?? null}
              busy={busy}
              onRefresh={() => void refresh()}
              onRetest={async () => {
                if (!selected) return
                setBusy(true)
                try {
                  const result = await api.testEngine(
                    selected.provider.id,
                    selected.model || undefined
                  )
                  if (result.ok) toast.success(result.message)
                  else toast.error('That did not work', { description: result.message })
                } finally {
                  setBusy(false)
                }
              }}
            />
          )}

          {step === 'provider' && (
            <ProviderStep
              state={state}
              busy={busy}
              onPick={(id) => void begin(id)}
            />
          )}

          {step === 'credential' && draft && (
            <CredentialStep
              entry={draft}
              onSaved={async () => {
                await refresh()
                setStep('model')
              }}
            />
          )}

          {step === 'model' && draft && (
            <ModelStep
              entry={draft}
              onChosen={async (model) => {
                setBusy(true)
                try {
                  setState(await api.selectEngine(draft.provider.id, model))
                  toast.success(`${draft.provider.label} is now running the agent`)
                  setStep('done')
                  setDraftId(null)
                } catch (err) {
                  toast.error('Could not switch', { description: errorMessage(err) })
                } finally {
                  setBusy(false)
                }
              }}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

/* ---------------------------------------------------------------- overview */

function Overview({
  state,
  selected,
  busy,
  onChangeEngine,
  onRetest,
  onRefresh
}: {
  state: EngineState
  selected: ProviderState | null
  busy: boolean
  onChangeEngine: () => void
  onRetest: () => void
  onRefresh: () => void
}): React.JSX.Element {
  const ready = !state.blocked

  return (
    <>
      {/*
        The status card answers the three questions this tab exists for — what is running, on
        which model, and can it answer right now — and puts the two actions next to the answer.
        It used to be a label, a model and a Test button, which said nothing about whether the
        engine worked and left "can it run" to be discovered by sending a message.
      */}
      <Card className="bg-card/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] text-muted-foreground">Running the agent</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[15px] font-semibold text-foreground">
              {selected?.provider.label ?? 'Nothing selected'}
              {selected?.provider.metered && (
                <Badge tone="outline" className="px-1.5 py-0 text-[10px] text-warning">
                  billed per token
                </Badge>
              )}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-[11px]">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  ready ? 'bg-success' : 'bg-destructive'
                )}
              />
              <span className={ready ? 'text-muted-foreground' : 'text-destructive'}>
                {ready ? 'Ready' : 'Needs setup'}
              </span>
              {selected?.model && (
                <span className="truncate font-mono text-muted-foreground">· {selected.model}</span>
              )}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="xs" variant="outline" onClick={onRetest} disabled={busy}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              Test
            </Button>
            <Button size="xs" onClick={onChangeEngine}>
              <Repeat className="size-3" />
              Change
            </Button>
          </div>
        </div>

        {state.blocked && (
          <p className="mt-2.5 flex items-start gap-1.5 rounded border border-destructive/25 bg-destructive/8 px-2 py-1.5 text-[11px] leading-snug text-destructive">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            {state.blocked}
          </p>
        )}
      </Card>

      {/*
        What this engine can do, as a grid rather than a paragraph.

        Every cell is derived from the engine's declared capabilities, so a new provider is
        described accurately without anyone writing a description for it — and the absences are
        shown beside the presences rather than as a list of caveats, because "no built-in shell"
        only means something next to "yes, tools".
      */}
      {selected && (
        <div>
          <SectionLabel>What it can do</SectionLabel>
          <div className="mt-1.5 grid grid-cols-2 gap-1">
            <Capability on={state.capabilities.toolCalling} label="Reads and writes notes" />
            <Capability on={state.capabilities.reasoning} label="Extended thinking" />
            <Capability on={state.capabilities.streamsText} label="Answers stream in" />
            <Capability on={state.capabilities.builtInTools} label="Own shell and file tools" />
            <Capability on={state.capabilities.accountConnectors} label="Your MCP connectors" />
            <Capability on={state.capabilities.usageWindows} label="Plan usage windows" />
          </div>
          {/*
            The one absence that is a real loss rather than a difference, said in words. Without
            tool calling the agent cannot touch a single note, so it is not a missing feature —
            it is the app not working.
          */}
          {!state.capabilities.toolCalling && (
            <p className="mt-1.5 text-[11px] leading-snug text-warning text-pretty">
              This model cannot call tools, so the agent cannot read or write your notes with it.
            </p>
          )}
        </div>
      )}

      {selected?.provider.id === 'claude-cli' && <ClaudeEngineDetails />}

      {/*
        And the same for Codex. Selecting it used to be the entire interaction — one click, a
        toast, and a tab with nothing on it — which is why it read as unconfigurable and then
        failed at the first turn with a model name it had never heard of.
      */}
      {selected?.provider.id === 'codex-cli' && (
        <CodexEngineDetails
          model={selected.model}
          effort={state.effort}
          onSaved={onRefresh}
        />
      )}

    </>
  )
}

/** A section heading, matching the ones the rest of the app's panels use. */
function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  )
}

/** One capability, present or absent. Absent is drawn, not omitted — that is the comparison. */
function Capability({ on, label }: { on: boolean; label: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded border px-1.5 py-1 text-[11px] leading-snug',
        on
          ? 'border-border/60 bg-secondary/20 text-foreground'
          : 'border-border/40 bg-transparent text-muted-foreground/70'
      )}
    >
      {on ? (
        <Check className="size-3 shrink-0 text-primary" />
      ) : (
        <Minus className="size-3 shrink-0 opacity-60" />
      )}
      <span className="min-w-0 text-pretty">{label}</span>
    </span>
  )
}

/* --------------------------------------------------------- choosing one */

/**
 * The provider list, reached deliberately.
 *
 * It used to sit permanently at the bottom of the tab, under every provider-specific setting and
 * three paragraphs about spend caps — so the one thing this tab is named for was the one thing
 * below the fold. Behind a button it is one press away and the default view stays about the
 * engine you already have.
 */
function ProviderStep({
  state,
  busy,
  onPick
}: {
  state: EngineState
  busy: boolean
  onPick: (providerId: string) => void
}): React.JSX.Element {
  return (
    <>
      {/*
        Said before the list, not after it: "will I lose my notes" is the question standing
        between someone and the button they are looking at.
      */}
      <p className="rounded-md border border-border/60 bg-secondary/20 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
        Switching only changes who answers. Your notes, conversations, saved tools and scheduled
        jobs stay exactly as they are — the history is this app’s, not the provider’s, so a chat
        started on one engine carries on with another.
      </p>

      <div className="flex flex-col gap-1.5">
        {state.providers.map((entry) => (
          <button
            key={entry.provider.id}
            type="button"
            disabled={busy}
            onClick={() => onPick(entry.provider.id)}
            className={cn(
              'rounded-md border px-2.5 py-2 text-left transition-colors duration-150 active:scale-[0.96] disabled:opacity-60',
              entry.selected
                ? 'border-primary/40 bg-primary/[0.06]'
                : 'border-border/70 bg-secondary/20 hover:border-border'
            )}
          >
            <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
              {entry.provider.label}
              {entry.selected && <Check className="size-3 text-primary" />}
              {!entry.installed && (
                <Badge tone="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                  not installed
                </Badge>
              )}
              {entry.provider.needsKey && !entry.configured && entry.installed && (
                <Badge tone="outline" className="px-1.5 py-0 text-[10px] text-warning">
                  needs a key
                </Badge>
              )}
              {entry.provider.metered && (
                <Badge tone="outline" className="px-1.5 py-0 text-[10px] text-warning">
                  per token
                </Badge>
              )}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground text-pretty">
              {entry.provider.blurb}
            </p>
          </button>
        ))}
      </div>
    </>
  )
}

/* ------------------------------------------------------------ codex */

/**
 * Codex's own models and its own thinking levels, read from Codex.
 *
 * The list is not written here. `codex debug models` renders the CLI's catalogue — the same one
 * the Codex app's picker shows — and every model in it carries the reasoning levels *it* accepts,
 * which genuinely differ: the flagship publishes six, up to a level called `ultra`, while an
 * older one stops at `xhigh`. One list for the provider would offer levels that fail on half its
 * models, and a list hardcoded in this repo would have been wrong the day after it was written.
 *
 * Blank stays a first-class choice for both fields, and it is the honest default: it omits the
 * flag, so Codex uses the model and effort from the user's own configuration. This app agreeing
 * with the CLI is better than this app quietly overriding it.
 */
function CodexEngineDetails({
  model,
  effort,
  onSaved
}: {
  model: string
  effort: string
  onSaved: () => void
}): React.JSX.Element {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .engineModels('codex-cli')
      .then((result) => {
        if (cancelled) return
        setModels(result.models)
        setError(result.error)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const chosen = models?.find((m) => m.id === model) ?? null
  // With no model chosen there is no published level list to offer, because which levels exist
  // is a property of the model. Saying so is better than offering a guess that gets rejected.
  const levels = chosen?.reasoningLevels ?? []

  const save = async (next: { model?: string; effort?: string }): Promise<void> => {
    setSaving(true)
    try {
      await api.selectEngine(
        'codex-cli',
        next.model ?? model,
        undefined,
        // Changing the model can invalidate the level: `ultra` exists on the flagship and on
        // nothing else, so a switch clears it rather than sending one that will be refused.
        next.effort ?? (next.model !== undefined && next.model !== model ? '' : effort)
      )
      onSaved()
    } catch (err) {
      toast.error('Could not save', { description: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="bg-card/60 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        Codex settings
        {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </p>

      <Label className="mt-2 block text-[11px] text-muted-foreground">Model</Label>
      {models === null && !error && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Reading the catalogue from Codex…
        </p>
      )}
      {error && (
        <p className="mt-1 flex items-start gap-1.5 rounded border border-destructive/25 bg-destructive/8 px-2 py-1.5 text-[11px] leading-snug text-destructive">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          {error}
        </p>
      )}

      {models !== null && models.length > 0 && (
        <div className="mt-1 flex flex-col gap-1">
          <CodexChoice
            label="Your Codex default"
            hint="Whatever the model is set to in Codex itself"
            active={!model}
            onClick={() => void save({ model: '' })}
          />
          {models.map((entry) => (
            <CodexChoice
              key={entry.id}
              label={entry.label}
              hint={entry.description || entry.id}
              mono={entry.id}
              active={entry.id === model}
              onClick={() => void save({ model: entry.id })}
            />
          ))}
        </div>
      )}

      {/*
        Shown only once a model is chosen, because the levels belong to the model. Under "your
        Codex default" the effort is the one in the user's config too — offering a picker there
        would mean overriding half of a pair the user set as a pair.
      */}
      {levels.length > 0 && (
        <>
          <Label className="mt-3 block text-[11px] text-muted-foreground">Thinking</Label>
          {/*
            A row of chips rather than a column of cards. The levels are one short ordered scale
            — six of them on the flagship — and stacked as full-width rows with their
            descriptions they were taller than the model list they belong to. The description
            follows the selection instead, because only one of them is true at a time.
          */}
          <div className="mt-1 flex flex-wrap gap-1">
            <CodexLevel
              label={chosen?.defaultReasoning ? `default · ${chosen.defaultReasoning}` : 'default'}
              active={!effort}
              onClick={() => void save({ effort: '' })}
            />
            {levels.map((level) => (
              <CodexLevel
                key={level.effort}
                label={level.effort}
                active={level.effort === effort}
                onClick={() => void save({ effort: level.effort })}
              />
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground text-pretty">
            {levels.find((level) => level.effort === effort)?.description ??
              'Whatever Codex is set to use for this model.'}
          </p>
        </>
      )}

      <p className="mt-2.5 border-t border-border/60 pt-2 text-[11px] leading-snug text-muted-foreground text-pretty">
        Codex runs in its own sandbox with your vault as the working directory. It can read and
        write notes and run commands there, and nothing outside it. Read-only chats get a
        read-only sandbox.
      </p>
    </Card>
  )
}

/** One thinking level. A chip, because the scale is short and ordered. */
function CodexLevel({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded border px-2 py-1 text-[11px] transition-colors duration-150 active:scale-[0.96]',
        active
          ? 'border-primary/40 bg-primary/[0.08] text-foreground'
          : 'border-border/60 bg-secondary/20 text-muted-foreground hover:border-border hover:text-foreground'
      )}
    >
      {label}
    </button>
  )
}

/** One row of a Codex list. Deliberately not a `<select>`: the descriptions are the whole point. */
function CodexChoice({
  label,
  hint,
  mono,
  active,
  onClick
}: {
  label: string
  hint?: string
  mono?: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-1.5 text-left transition-colors duration-150 active:scale-[0.96]',
        active
          ? 'border-primary/40 bg-primary/[0.06]'
          : 'border-border/60 bg-secondary/20 hover:border-border'
      )}
    >
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
        {label}
        {active && <Check className="size-3 text-primary" />}
      </span>
      {mono && <span className="mt-0.5 block font-mono text-[10.5px] text-muted-foreground">{mono}</span>}
      {hint && (
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground text-pretty">
          {hint}
        </span>
      )}
    </button>
  )
}

/* --------------------------------------------------------------- the steps */

function CredentialStep({
  entry,
  onSaved
}: {
  entry: ProviderState
  onSaved: () => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(entry.baseUrl)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      // The base URL first: the key is verified against it, so saving them the other way round
      // would test the old endpoint.
      if (baseUrl !== entry.baseUrl) await api.selectEngine(entry.provider.id, undefined, baseUrl)
      if (key.trim()) await api.setEngineKey(entry.provider.id, key)

      const result = await api.testEngine(entry.provider.id)
      if (!result.ok) {
        toast.error('That key did not work', { description: result.message })
        return
      }
      toast.success(result.message)
      setKey('')
      onSaved()
    } catch (err) {
      toast.error('Could not save it', { description: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="bg-card/60 px-3 py-3">
      <p className="text-[11px] text-muted-foreground">Step 1 of 2</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
        <KeyRound className="size-3.5" />
        Connect {entry.provider.label}
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
        {entry.provider.blurb}
      </p>

      {entry.provider.id === 'custom' && (
        <div className="mt-3">
          <Label htmlFor="engine-base" className="text-[11px] text-foreground/90">
            Base URL
          </Label>
          <Input
            id="engine-base"
            value={baseUrl}
            placeholder="https://gateway.example.com/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
            className="mt-1 h-8 text-[12px]"
          />
          <p className="mt-1 text-[10.5px] text-muted-foreground">
            The address that answers <span className="font-mono">/chat/completions</span> and{' '}
            <span className="font-mono">/models</span>.
          </p>
        </div>
      )}

      <div className="mt-3">
        <Label htmlFor="engine-key" className="text-[11px] text-foreground/90">
          API key
        </Label>
        {entry.provider.keyUrl && (
          <p className="mb-1 text-[11px] text-muted-foreground">
            Get one at{' '}
            <button
              type="button"
              onClick={() => void api.openExternal(entry.provider.keyUrl as string)}
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              {entry.provider.keyUrl}
            </button>
          </p>
        )}
        <div className="flex gap-1.5">
          <Input
            id="engine-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={entry.configured ? 'A key is already stored — paste to replace' : 'Paste the key'}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void save()
              }
            }}
            className="h-8 text-[12px]"
          />
          <Button size="sm" onClick={() => void save()} disabled={busy || (!key.trim() && !entry.configured)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save and test
          </Button>
        </div>
        <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground text-pretty">
          Kept in the same encrypted store as your integration credentials — never in a settings
          file, never shown to the agent, and stripped out of anything it or the log ever sees.
        </p>
      </div>
    </Card>
  )
}

function ModelStep({
  entry,
  onChosen
}: {
  entry: ProviderState
  onChosen: (model: string) => void
}): React.JSX.Element {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = useCallback(
    async (force: boolean): Promise<void> => {
      setModels(null)
      const result = await api.engineModels(entry.provider.id, force)
      setModels(result.models)
      setError(result.error)
    },
    [entry.provider.id]
  )

  useEffect(() => {
    void load(false)
  }, [load])

  const shown = useMemo(() => {
    if (!models) return []
    const needle = query.trim().toLowerCase()
    const matched = needle
      ? models.filter(
          (model) =>
            model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle)
        )
      : models
    // A model that cannot call tools cannot touch the vault, so the ones that can come first
    // rather than being hidden — hiding them would leave a user hunting for a model they can
    // see on the provider's own site.
    return [...matched].sort((a, b) => Number(b.supportsTools) - Number(a.supportsTools)).slice(0, 120)
  }, [models, query])

  return (
    <Card className="bg-card/60 px-3 py-3">
      <p className="text-[11px] text-muted-foreground">Step 2 of 2</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
        <Sparkles className="size-3.5" />
        Choose a model
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
        Read from {entry.provider.label} just now, so this is what it offers today rather than a
        list this app remembers.
      </p>

      <div className="mt-2.5 flex gap-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            placeholder="Filter models"
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 pl-7 text-[12px]"
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => void load(true)}>
          Refresh
        </Button>
      </div>

      {error && (
        <p className="mt-2 rounded border border-destructive/25 bg-destructive/8 px-2 py-1.5 text-[11px] leading-snug text-destructive">
          {error}
        </p>
      )}

      {models === null ? (
        <div className="grid place-items-center py-8">
          <Spinner className="text-muted-foreground" />
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {shown.length === 0 && (
            <p className="py-4 text-center text-[12px] text-muted-foreground">
              Nothing matched.
            </p>
          )}
          {shown.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => onChosen(model.id)}
              className={cn(
                'rounded-md border border-border/70 bg-secondary/20 px-2.5 py-1.5 text-left',
                'transition-colors duration-150 hover:border-border active:scale-[0.99]',
                model.id === entry.model && 'border-primary/40 bg-primary/[0.06]'
              )}
            >
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                <span className="truncate">{model.label}</span>
                {!model.supportsTools && (
                  <Badge tone="outline" className="shrink-0 px-1 py-0 text-[9.5px] text-warning">
                    no tools
                  </Badge>
                )}
                {model.supportsReasoning && (
                  <Badge tone="outline" className="shrink-0 px-1 py-0 text-[9.5px] text-muted-foreground">
                    thinks
                  </Badge>
                )}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 break-all font-mono text-[10px] text-muted-foreground">
                <span>{model.id}</span>
                {model.contextLength && (
                  <span className="font-sans">
                    {Math.round(model.contextLength / 1000)}k context
                  </span>
                )}
                {priceLabel(model) && (
                  <span className="flex items-center gap-1 font-sans">
                    <Wallet className="size-2.5" />
                    {priceLabel(model)}
                  </span>
                )}
              </p>
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

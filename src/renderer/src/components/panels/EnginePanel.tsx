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
  PlugZap,
  Repeat,
  Copy,
  Download,
  LogIn,
  Search,
  Server,
  Sparkles,
  Wallet,
  Wrench
} from 'lucide-react'
import type { CliStatus, EngineState, ModelInfo, ProviderState } from '@shared/engines'
import type { ApiResult } from '@shared/ipc'
import type { AgentEffort } from '@shared/types'
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

/**
 * The setup steps, and the fact that not every provider needs all of them.
 *
 * They were numbered by hand — "Step 1 of 2", "Step 2 of 2" — against a flow that already skipped
 * a step when a key was stored, so a returning user opened the wizard on "Step 2 of 2" with no
 * step 1 anywhere. The plan is computed from the provider instead, and the numbering reads off
 * the plan, so a two-step provider and a four-step one are each described correctly.
 */
type StepId = 'provider' | 'install' | 'signin' | 'endpoint' | 'credential' | 'model' | 'verify'
type Step = StepId | 'done'

/** What the end-to-end check reported, in the shape the main process sends it. */
type VerifyResult = ApiResult<'engine:verify'>

/**
 * The app's own thinking ladder, for the providers that do not publish one.
 *
 * Codex enumerates its levels per model and those are used verbatim; everyone else takes the
 * app's five, which `reasoningPatch` already knows how to say in each provider's dialect —
 * OpenAI's `reasoning_effort`, OpenRouter's object, DeepSeek's two fields, Anthropic's token
 * budget. All of that machinery existed and nothing offered to set it.
 */
const EFFORT_TIERS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const EFFORT_BLURBS: Record<string, string> = {
  low: 'Barely thinks. Fastest and cheapest — fine for lookups and small edits.',
  medium: 'A moderate amount of thinking before answering.',
  high: 'Thinks properly. The usual choice for real work.',
  xhigh: 'Thinks harder, and takes noticeably longer.',
  max: 'As much thinking as the model will do. Slow, and on a metered provider it shows.'
}

const STEP_TITLES: Record<StepId, string> = {
  provider: 'Choose a provider',
  install: 'Install it',
  signin: 'Sign in',
  endpoint: 'Point at the endpoint',
  credential: 'Connect it',
  model: 'Choose a model',
  verify: 'Check it works'
}

/**
 * Which steps this provider actually has.
 *
 * `provider` is excluded: picking one is what starts the plan rather than part of it. A CLI
 * engine is signed in already and publishes no catalogue we ask about here, so its whole setup is
 * the check — which is the step that matters most for Codex, whose most common failure is a
 * session that expired without saying so.
 */
function planFor(entry: ProviderState): StepId[] {
  /*
   * A CLI is a program on the machine, so its setup is: get it, sign in to it, check it.
   *
   * This used to be `['verify']` alone, on the assumption that anyone choosing Codex already had
   * Codex. Someone who does not got a toast — "Codex is not installed on this machine" — and
   * nothing else: a problem named, no way through, and a search engine as the next step. The
   * steps are always in the plan even when they are already satisfied, because the numbering is
   * about the shape of the job rather than about how much of it happens to be done.
   */
  if (entry.provider.engine !== 'openai-compatible') return ['install', 'signin', 'verify']

  const steps: StepId[] = []
  // Asked first for the providers whose address is the whole configuration, and offered as an
  // override for the rest — a company gateway in front of OpenAI is a normal thing to have.
  if (entry.provider.id === 'custom' || entry.provider.local) steps.push('endpoint')
  if (entry.provider.needsKey) steps.push('credential')
  steps.push('model', 'verify')
  return steps
}

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
  /**
   * The model chosen during setup, held here rather than written straight to settings.
   *
   * Choosing used to switch the engine on the spot, which meant the only way to find out whether
   * a model worked was to already be running on it. The choice is remembered, the check runs
   * against it, and the switch happens once — after it has been shown to answer.
   */
  const [draftModel, setDraftModel] = useState('')
  /**
   * What the CLI looks like right now, re-asked after every step someone completes.
   *
   * Held here rather than inside the steps so that pressing "I have installed it" on one step
   * and landing on the next does not re-run the lookup from scratch — and so that `begin` and
   * the steps agree about what they are looking at.
   */
  const [cli, setCli] = useState<CliStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)

  /** Look again, forgetting the cached binary path — see `engine:cliStatus`. */
  const recheckCli = useCallback(
    async (providerId: string, advanceWhenReady?: (status: CliStatus) => void): Promise<void> => {
      setChecking(true)
      try {
        const status = await api.cliStatus(providerId, true)
        setCli(status)
        advanceWhenReady?.(status)
      } catch (err) {
        toast.error('Could not check', { description: errorMessage(err) })
      } finally {
        setChecking(false)
      }
    },
    []
  )

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
  const plan = draft ? planFor(draft) : []

  const leave = (): void => {
    setStep('done')
    setDraftId(null)
    setDraftModel('')
    setCli(null)
  }

  /** The next step in the plan, skipping anything this provider has already satisfied. */
  const advance = (from: StepId, entry: ProviderState): void => {
    const steps = planFor(entry)
    const next = steps[steps.indexOf(from) + 1]
    setStep(next ?? 'done')
    if (!next) leave()
  }

  /**
   * Start setting a provider up, optionally at a named step.
   *
   * The step argument is what makes the overview's controls work: the selected engine's key,
   * endpoint and model are each one press away from the card that shows them, rather than
   * reachable only by walking the whole wizard again. Before it, an engine that was selected but
   * incomplete was a dead end — the tab said "Choose a model for DeepSeek first" and offered
   * nowhere to choose one.
   */
  const begin = (providerId: string, at?: StepId): void => {
    const entry = state.providers.find((p) => p.provider.id === providerId)
    if (!entry) return

    setDraftId(providerId)
    setDraftModel(entry.model)

    if (at) {
      setStep(at)
      return
    }

    const steps = planFor(entry)

    /*
     * A CLI's entry step is decided from live state, not from the cached panel read.
     *
     * `engine:state` answers "is the binary there" cheaply, but not "is it signed in" — that
     * costs a spawn, and putting it in the read every surface makes would charge the whole app
     * for a question only this screen asks. So the CLI path asks once, here, at the moment
     * someone chooses the provider.
     */
    if (entry.provider.engine !== 'openai-compatible') {
      setStep('install')
      void api
        .cliStatus(providerId)
        .then((status) => {
          setCli(status)
          // Skipped only forward: someone who has it and is signed in lands on the check, and
          // the steps behind stay reachable through Back.
          if (!status.installed) setStep('install')
          else if (status.signedIn === false) setStep('signin')
          else setStep('verify')
        })
        .catch(() => setStep('install'))
      return
    }

    /*
     * The first step that still has something to ask.
     *
     * A key already in the vault and a base URL already stored are questions with answers, so
     * they are skipped — but the *numbering* now comes from the plan rather than from a literal,
     * which is what made a returning user land on "Step 2 of 2" with no step 1 in existence.
     */
    const first =
      steps.find((id) => {
        /*
         * A local server keeps its address step even though it ships with a default.
         *
         * The default port is right on a standard install, so skipping it looks like a kindness
         * — but the overwhelmingly likely failure for Ollama or LM Studio is that the server is
         * not running or is on another port, and skipped, the first the user hears of it is an
         * empty model list that explains nothing. One press with the default already filled in
         * is cheaper than that, and it is where the sentence about starting the server belongs.
         */
        if (id === 'endpoint') return entry.provider.local || !entry.baseUrl
        if (id === 'credential') return !entry.configured
        return true
      }) ?? 'verify'
    setStep(first)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <Cpu className="size-3.5" />
          Engine
        </h2>
        {step !== 'done' && (
          <Button size="xs" variant="ghost" onClick={leave}>
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
              onFix={(at) => {
                if (selected) begin(selected.provider.id, at)
              }}
              state={state}
              selected={selected ?? null}
              busy={busy}
              onRefresh={() => void refresh()}
              /*
               * The honest check, not the cheap one.
               *
               * This button used to read the model list, which for the question it is next to —
               * "is the engine that is running going to work" — answers almost nothing: an
               * expired Codex session, a key with no completions quota and a model that ignores
               * tools all pass it. It runs a small turn now, which is the same check the last
               * step of setup runs, so pressing it means the same thing in both places.
               */
              onRetest={async () => {
                if (!selected) return
                setBusy(true)
                try {
                  const result = await api.verifyEngine(
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

          {step === 'provider' && <ProviderStep state={state} busy={busy} onPick={begin} />}

          {draft && step !== 'done' && step !== 'provider' && (
            <>
              <StepHeading plan={plan} current={step} label={draft.provider.label} />

              {step === 'install' && (
                <InstallStep
                  entry={draft}
                  status={cli}
                  checking={checking}
                  onRecheck={() =>
                    void recheckCli(draft.provider.id, (status) => {
                      // Straight on when it is there. Someone who has just installed something
                      // does not want to be told it worked and then press Continue as well.
                      if (status.installed) setStep(status.signedIn === true ? 'verify' : 'signin')
                    })
                  }
                  onSkip={() => setStep(cli?.signedIn === true ? 'verify' : 'signin')}
                />
              )}

              {step === 'signin' && (
                <SignInStep
                  entry={draft}
                  status={cli}
                  checking={checking}
                  onRecheck={() =>
                    void recheckCli(draft.provider.id, (status) => {
                      if (status.signedIn === true) setStep('verify')
                    })
                  }
                  onSkip={() => setStep('verify')}
                />
              )}

              {step === 'endpoint' && (
                <EndpointStep
                  entry={draft}
                  onSaved={async () => {
                    await refresh()
                    advance('endpoint', draft)
                  }}
                />
              )}

              {step === 'credential' && (
                <CredentialStep
                  entry={draft}
                  onSaved={async () => {
                    await refresh()
                    advance('credential', draft)
                  }}
                />
              )}

              {step === 'model' && (
                <ModelStep
                  entry={draft}
                  chosen={draftModel}
                  onChosen={async (model) => {
                    setDraftModel(model)
                    try {
                      // Stored, not switched. The check that follows runs against this model on
                      // a provider the user is not yet running, which is the whole point of
                      // doing it before the switch rather than after.
                      setState(await api.configureEngine(draft.provider.id, model))
                    } catch (err) {
                      // The choice is still held in `draftModel`, so the flow carries on and the
                      // check runs against it — a failed write here must not strand someone on a
                      // list they have already finished with.
                      toast.error('Could not save that choice', { description: errorMessage(err) })
                    }
                    advance('model', draft)
                  }}
                />
              )}

              {step === 'verify' && (
                <VerifyStep
                  entry={draft}
                  model={draftModel || draft.model}
                  busy={busy}
                  onUse={async () => {
                    setBusy(true)
                    try {
                      setState(
                        await api.selectEngine(
                          draft.provider.id,
                          draftModel || draft.model || undefined
                        )
                      )
                      toast.success(`${draft.provider.label} is now running the agent`)
                      leave()
                    } catch (err) {
                      toast.error('Could not switch', { description: errorMessage(err) })
                    } finally {
                      setBusy(false)
                    }
                  }}
                />
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

/**
 * Where you are in the setup, and how much of it is left.
 *
 * A count and a row of ticks rather than a wizard chrome: the panel is a sidebar, the plans are
 * two to four steps long, and the only two questions worth answering here are "which step is
 * this" and "how many more". The numbers come off the plan, so a provider that needs no key is
 * not described as having skipped one.
 */
function StepHeading({
  plan,
  current,
  label
}: {
  plan: StepId[]
  current: Step
  label: string
}): React.JSX.Element {
  const at = plan.indexOf(current as StepId)
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">
        {label} · step {at + 1} of {plan.length}
      </p>
      <p className="mt-1 flex items-center gap-1">
        {plan.map((id, index) => (
          <span
            key={id}
            title={STEP_TITLES[id]}
            className={cn(
              'h-0.5 flex-1 rounded-full transition-colors duration-150',
              index < at ? 'bg-primary/50' : index === at ? 'bg-primary' : 'bg-border'
            )}
          />
        ))}
      </p>
    </div>
  )
}

/* --------------------------------------------------------- getting a CLI installed */

/** The platform the app is running on, as the install routes name it. */
function currentPlatform(): 'win32' | 'darwin' | 'linux' {
  const platform = window.brain.platform
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux'
}

/**
 * One command, with the terminal to run it in and a button that copies it.
 *
 * Copy rather than "let us run it": the app spawning a shell that pipes a script off the
 * internet would be doing something the user cannot see, on their machine, with their
 * permissions. Handing them the exact line and naming the terminal is the same help without the
 * part where they have to take our word for it.
 */
function CommandBlock({ shell, command }: { shell: string; command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('Could not copy it — select the text and copy it by hand')
    }
  }

  return (
    <div className="mt-1.5 rounded-md border border-border/70 bg-secondary/20">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-2 py-1">
        <span className="text-[10.5px] text-muted-foreground">Paste this into {shell}</span>
        <Button size="xs" variant="ghost" onClick={() => void copy()}>
          {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {/* Selectable and wrapping: a command that needs a horizontal scrollbar to read is a
          command someone will copy half of. */}
      <p className="select-text break-all px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground">
        {command}
      </p>
    </div>
  )
}

/**
 * Get the program onto the machine.
 *
 * The step that did not exist. Choosing Codex without having Codex produced a toast naming the
 * problem and nothing else, which for someone who has never opened a terminal is where the app
 * ended. Every command here is quoted from the vendor's own current documentation, and the
 * recommended route on each platform is the one with no prerequisite — npm needs Node, Homebrew
 * needs Homebrew, and meeting a second problem before the first is solved is how people give up.
 */
function InstallStep({
  entry,
  status,
  checking,
  onRecheck,
  onSkip
}: {
  entry: ProviderState
  status: CliStatus | null
  checking: boolean
  onRecheck: () => void
  onSkip: () => void
}): React.JSX.Element {
  const setup = entry.provider.setup
  const platform = currentPlatform()
  const routes = (setup?.install ?? []).filter((route) => route.platforms.includes(platform))
  const [chosen, setChosen] = useState(routes[0]?.id ?? '')
  /**
   * Whether the user has pressed the button yet.
   *
   * The panel already looked once, on the way in — but "still not finding it" in front of
   * someone who has not yet been asked to do anything reads as an error rather than as the
   * result of their attempt. It belongs to the second look, not the first.
   */
  const [tried, setTried] = useState(false)
  const route = routes.find((option) => option.id === chosen) ?? routes[0]

  if (!setup) return <></>

  return (
    <Card className="bg-card/60 px-3 py-3">
      <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
        <Download className="size-3.5" />
        Install {entry.provider.label}
      </p>

      {status?.installed ? (
        <>
          <p className="mt-1.5 flex items-start gap-1.5 rounded border border-success/25 bg-success/8 px-2 py-1.5 text-[11px] leading-snug text-foreground">
            <Check className="mt-px size-3 shrink-0 text-success" />
            Already on this computer{status.version ? ` — ${status.version}` : ''}.
          </p>
          {status.path && (
            <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
              {status.path}
            </p>
          )}
          <Button size="sm" className="mt-2.5" onClick={onSkip}>
            Continue
          </Button>
        </>
      ) : (
        <>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
            {entry.provider.label} is a separate program that runs on your computer — this app
            drives it. You install it once and it stays.
          </p>

          {/*
            More than one way in, because the right one depends on what someone already has. The
            first needs nothing else installed first, which is why it leads.
          */}
          {routes.length > 1 && (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {routes.map((option, index) => (
                <CodexLevel
                  key={option.id}
                  label={index === 0 ? `${option.label} · easiest` : option.label}
                  active={option.id === (route?.id ?? '')}
                  onClick={() => setChosen(option.id)}
                />
              ))}
            </div>
          )}

          {route && (
            <>
              <CommandBlock shell={route.shell} command={route.command} />
              {route.hint && (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground text-pretty">
                  {route.hint}
                </p>
              )}
            </>
          )}

          <p className="mt-2 text-[11px] leading-snug text-muted-foreground text-pretty">
            When it finishes, come back here and press the button below. If you would rather read
            the official instructions first,{' '}
            <button
              type="button"
              onClick={() => void api.openExternal(setup.downloadUrl)}
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              they are here
            </button>
            .
          </p>

          <div className="mt-2.5 flex items-center gap-1.5">
            <Button
              size="sm"
              onClick={() => {
                setTried(true)
                onRecheck()
              }}
              disabled={checking}
            >
              {checking ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Repeat className="size-3.5" />
              )}
              {checking ? 'Looking…' : 'I have installed it'}
            </Button>
          </div>

          {/*
            Said only after a look that found nothing — before that it is a warning about
            something that has not happened yet.
          */}
          {tried && status && !status.installed && !checking && (
            <p className="mt-2 flex items-start gap-1.5 rounded border border-warning/30 bg-warning/8 px-2 py-1.5 text-[11px] leading-snug text-warning text-pretty">
              <AlertTriangle className="mt-px size-3 shrink-0" />
              {/* One flex item, not three. The icon and the sentence are the children here, so a
                  bare <span> inside the sentence would be laid out beside it rather than in it. */}
              <span>
                Still not finding it. If the install has just finished, close your terminal and
                open a new one — and if that does not help, run{' '}
                <span className="font-mono">{setup.verifyCommand}</span> there to see what it
                says.
              </span>
            </p>
          )}
        </>
      )}
    </Card>
  )
}

/**
 * Sign the CLI in to an account.
 *
 * Its own step because it is a separate failure with a separate fix — and because for Codex it is
 * the one that comes back: the ChatGPT session expires and says so only when a turn fails, in a
 * sentence about refresh tokens that means nothing to anyone. Whoever reads this screen once
 * knows where to return to.
 */
function SignInStep({
  entry,
  status,
  checking,
  onRecheck,
  onSkip
}: {
  entry: ProviderState
  status: CliStatus | null
  checking: boolean
  onRecheck: () => void
  onSkip: () => void
}): React.JSX.Element {
  const setup = entry.provider.setup
  if (!setup) return <></>

  const signedIn = status?.signedIn === true

  return (
    <Card className="bg-card/60 px-3 py-3">
      <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
        <LogIn className="size-3.5" />
        Sign {entry.provider.label} in
      </p>

      {signedIn ? (
        <p className="mt-1.5 flex items-start gap-1.5 rounded border border-success/25 bg-success/8 px-2 py-1.5 text-[11px] leading-snug text-foreground">
          <Check className="mt-px size-3 shrink-0 text-success" />
          Signed in{status?.account ? ` — ${status.account}` : ''}.
        </p>
      ) : (
        <>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
            {setup.signIn.blurb}
          </p>
          <CommandBlock shell="a terminal" command={setup.signIn.command} />
          {setup.account && (
            <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground text-pretty">
              {setup.account}
            </p>
          )}
        </>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        {!signedIn && (
          <Button size="sm" variant="outline" onClick={onRecheck} disabled={checking}>
            {checking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Repeat className="size-3.5" />
            )}
            {checking ? 'Looking…' : 'I have signed in'}
          </Button>
        )}
        <Button size="sm" onClick={onSkip}>
          Continue
        </Button>
      </div>

      {/*
        The honest reading of a positive from `codex login status`, which prints "Logged in using
        ChatGPT" even with a spent refresh token. A no is a fact; a yes is a hope, and the small
        turn on the next step is what settles it.
      */}
      {status?.installed && status.signedIn === null && !signedIn && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground text-pretty">
          {entry.provider.label} does not report this reliably, so the check on the next step is
          what will actually tell you.
        </p>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ verify */

/**
 * The last step: does this engine actually hold a turn.
 *
 * The one question the setup flow could not previously answer. Everything before it is a
 * necessary condition — a reachable endpoint, an accepted key, a model that exists — and all
 * three can be satisfied by a setup that fails on the user's first real question: a key with no
 * completions quota lists models happily, a model that cannot call tools looks identical in the
 * picker, and a Codex install whose session expired publishes its catalogue from disk. So this
 * sends one small message and reports what came back.
 *
 * Not run on arrival. On a metered provider it costs a fraction of a cent, and nothing in this
 * app spends someone's money without being asked — so the button says what it will do first.
 *
 * Failing does not block the switch. The user may know something the check does not (a provider
 * having a bad ten minutes, a model that answers fine but ignores a toy tool), and a setup flow
 * that refuses to finish on the strength of one request would be a worse mistake than the one it
 * is guarding against.
 */
function VerifyStep({
  entry,
  model,
  busy,
  onUse
}: {
  entry: ProviderState
  model: string
  busy: boolean
  onUse: () => void
}): React.JSX.Element {
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [running, setRunning] = useState(false)

  const run = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    try {
      setResult(await api.verifyEngine(entry.provider.id, model || undefined))
    } catch (err) {
      setResult({
        ok: false,
        message: errorMessage(err),
        reached: false,
        answered: false,
        calledTool: false,
        tokens: null
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card className="bg-card/60 px-3 py-3">
      <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
        <PlugZap className="size-3.5" />
        {STEP_TITLES.verify}
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
        Sends one short message{model ? ' to ' : ''}
        {model && <span className="font-mono text-foreground/80">{model}</span>} and asks it to
        call a harmless tool. That is the only way to find out whether the agent will be able to
        use your notes — a key that lists models can still be out of credit, and a model that
        looks right can ignore tools entirely.
        {entry.provider.metered && ' It costs a fraction of a cent.'}
      </p>

      <div className="mt-2.5 flex items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={running}>
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
          {running ? 'Checking…' : result ? 'Check again' : 'Run the check'}
        </Button>
        <Button size="sm" onClick={onUse} disabled={busy || running}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Use {entry.provider.label}
        </Button>
      </div>

      {running && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {entry.provider.engine === 'codex-cli'
            ? 'Codex takes a few seconds to start a turn.'
            : 'Waiting on the provider…'}
        </p>
      )}

      {result && (
        <div className="mt-2.5">
          {/*
            Three lights rather than one verdict, because the middle outcome is the common one
            and it is the one worth naming: an engine that answers but will not call a tool is
            not broken, it is limited, and the difference decides whether the agent can touch a
            single note.
          */}
          <div className="flex flex-col gap-1">
            <Capability on={result.reached} label={`Reached ${entry.provider.label}`} />
            <Capability on={result.answered} label="The model answered" />
            <Capability on={result.calledTool} label="It called a tool, so it can use your notes" />
          </div>
          <p
            className={cn(
              'mt-1.5 flex items-start gap-1.5 rounded border px-2 py-1.5 text-[11px] leading-snug text-pretty',
              result.ok
                ? 'border-success/25 bg-success/8 text-foreground'
                : 'border-warning/30 bg-warning/8 text-warning'
            )}
          >
            {result.ok ? (
              <Check className="mt-px size-3 shrink-0 text-success" />
            ) : (
              <AlertTriangle className="mt-px size-3 shrink-0" />
            )}
            {result.message}
          </p>
          {!result.ok && (
            <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground text-pretty">
              You can still switch to it — this is one request, and a provider having a bad
              minute is not the same as a setup that will not work.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

/* ---------------------------------------------------------------- overview */

function Overview({
  state,
  selected,
  busy,
  onChangeEngine,
  onFix,
  onRetest,
  onRefresh
}: {
  state: EngineState
  selected: ProviderState | null
  busy: boolean
  onChangeEngine: () => void
  onFix: (at: StepId) => void
  onRetest: () => void
  onRefresh: () => void
}): React.JSX.Element {
  const ready = !state.blocked

  /**
   * The step that would clear what is blocking, from the sentence that describes it.
   *
   * Read off `engineReadiness`'s own order rather than recomputed, so the button goes where the
   * message points. Without it "Choose a model for DeepSeek first" was a statement with no verb:
   * the tab named the missing thing and offered nowhere to supply it, and the only route was to
   * guess that Change → the same provider would reopen the wizard.
   */
  const blockedAt: StepId = !selected
    ? 'provider'
    : /base URL/i.test(state.blocked ?? '')
      ? 'endpoint'
      : /API key/i.test(state.blocked ?? '')
        ? 'credential'
        : /model/i.test(state.blocked ?? '')
          ? 'model'
          : 'verify'

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
              {busy ? <Loader2 className="size-3 animate-spin" /> : <PlugZap className="size-3" />}
              Check
            </Button>
            <Button size="xs" onClick={onChangeEngine}>
              <Repeat className="size-3" />
              Change
            </Button>
          </div>
        </div>

        {state.blocked && (
          <div className="mt-2.5 rounded border border-destructive/25 bg-destructive/8 px-2 py-1.5">
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive">
              <AlertTriangle className="mt-px size-3 shrink-0" />
              {state.blocked}
            </p>
            {/*
              The thing that was missing, and the reason this whole tab could dead-end: the
              message named what was wrong and there was no control anywhere that would fix it.
            */}
            <Button size="xs" className="mt-1.5" onClick={() => onFix(blockedAt)}>
              <Wrench className="size-3" />
              {blockedAt === 'credential'
                ? 'Add the key'
                : blockedAt === 'model'
                  ? 'Choose a model'
                  : blockedAt === 'endpoint'
                    ? 'Set the address'
                    : 'Set it up'}
            </Button>
          </div>
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

          {/*
            The caveats in words, under the grid rather than instead of it.

            `capabilityNotes` has been computed and sent to this panel all along and nothing ever
            rendered it — so the sentences explaining *why* an absence matters (a replayed
            conversation costing more each turn, the spend caps waking up on a metered provider)
            existed, were tested, and were invisible. The grid says what is missing; these say
            what missing it means.
          */}
          {state.notes.length > 0 && (
            <details className="group mt-2">
              <summary className="cursor-pointer list-none text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground">
                What this choice costs you
                <span className="ml-1 opacity-60 group-open:hidden">·  {state.notes.length}</span>
              </summary>
              <ul className="mt-1.5 flex flex-col gap-1">
                {state.notes.map((note) => (
                  <li
                    key={note}
                    className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground text-pretty"
                  >
                    <Minus className="mt-0.5 size-3 shrink-0 opacity-60" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </details>
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

      {/*
        And the same for an API provider, which had nothing at all.

        Codex got a settings card and the CLI got its own panel, while a provider with a key, an
        endpoint and four hundred models to choose between got a label. So after setup there was
        no way to swap the model, rotate the key or correct the address — the wizard was the only
        route to any of them, and reaching it meant re-picking the provider you were already on.
      */}
      {selected && selected.provider.engine === 'openai-compatible' && (
        <ApiEngineDetails
          entry={selected}
          effort={state.effort}
          reasoning={state.capabilities.reasoning}
          onEdit={onFix}
          onRefresh={onRefresh}
        />
      )}
    </>
  )
}

/**
 * The selected API provider's three settings, each one press from where it is shown.
 *
 * Deliberately not a form. Every one of these has a step in the setup flow that already asks for
 * it properly — with the catalogue, with the key test, with the explanation of where a key is
 * kept — so these are routes into those steps rather than a second, worse copy of them.
 */
function ApiEngineDetails({
  entry,
  effort,
  reasoning,
  onEdit,
  onRefresh
}: {
  entry: ProviderState
  /** The level in force for this provider, in the app's own vocabulary. */
  effort: string
  /** The chosen model can be asked to think at all. Hidden rather than offered uselessly. */
  reasoning: boolean
  onEdit: (at: StepId) => void
  onRefresh: () => void
}): React.JSX.Element {
  const [clearing, setClearing] = useState(false)

  const saveEffort = async (next: string): Promise<void> => {
    try {
      await api.configureEngine(entry.provider.id, undefined, undefined, next)
      onRefresh()
    } catch (err) {
      toast.error('Could not save that', { description: errorMessage(err) })
    }
  }

  const forget = async (): Promise<void> => {
    setClearing(true)
    try {
      await api.clearEngineKey(entry.provider.id)
      toast.success(`The ${entry.provider.label} key has been removed`)
      onRefresh()
    } catch (err) {
      toast.error('Could not remove it', { description: errorMessage(err) })
    } finally {
      setClearing(false)
    }
  }

  return (
    <Card className="bg-card/60 px-3 py-2.5">
      <p className="text-[11px] font-medium text-foreground">{entry.provider.label} settings</p>

      <div className="mt-2 flex flex-col gap-1.5">
        <SettingRow
          label="Model"
          value={entry.model || 'none chosen'}
          missing={!entry.model}
          action="Change"
          onAction={() => onEdit('model')}
        />

        {/*
          Thinking, which this card had no row for at all.

          `settings.engine.efforts` has existed all along, `effortFor` reads it on every turn and
          `reasoningPatch` knows four wire formats for it — and no surface anywhere offered to
          set it, so every API engine ran at whatever the provider's default was. Codex got a
          picker because its levels are published per model; the providers whose levels are the
          app's own five got nothing, which is the wrong way round.
        */}
        {reasoning && (
          <div className="flex items-start gap-2">
            <span className="w-16 shrink-0 pt-1 text-[11px] text-muted-foreground">Thinking</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-1">
                <CodexLevel
                  label="provider default"
                  active={!effort}
                  onClick={() => void saveEffort('')}
                />
                {EFFORT_TIERS.map((tier) => (
                  <CodexLevel
                    key={tier}
                    label={tier}
                    active={tier === effort}
                    onClick={() => void saveEffort(tier)}
                  />
                ))}
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground text-pretty">
                {EFFORT_BLURBS[effort] ?? 'Whatever this provider does when it is not told.'}
              </p>
            </div>
          </div>
        )}

        {entry.provider.needsKey && (
          <SettingRow
            label="API key"
            value={entry.configured ? 'stored' : 'not set'}
            missing={!entry.configured}
            action={entry.configured ? 'Replace' : 'Add'}
            onAction={() => onEdit('credential')}
            extra={
              entry.configured ? (
                <Button size="xs" variant="ghost" onClick={() => void forget()} disabled={clearing}>
                  Remove
                </Button>
              ) : null
            }
          />
        )}

        <SettingRow
          label="Address"
          value={entry.baseUrl || 'not set'}
          missing={!entry.baseUrl}
          action="Edit"
          onAction={() => onEdit('endpoint')}
        />
      </div>

      {entry.provider.local && (
        <p className="mt-2.5 border-t border-border/60 pt-2 text-[11px] leading-snug text-muted-foreground text-pretty">
          {entry.provider.label} runs on this machine, so nothing leaves it and nothing is billed —
          but it has to be running before the app can reach it, and a local model has to be good at
          tool calling for the agent to be able to use your notes.
        </p>
      )}
    </Card>
  )
}

/** One setting: what it is, what it is set to, and the one press that changes it. */
function SettingRow({
  label,
  value,
  missing,
  action,
  onAction,
  extra
}: {
  label: string
  value: string
  missing?: boolean
  action: string
  onAction: () => void
  extra?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-[11px]',
          missing ? 'text-warning' : 'text-foreground/80'
        )}
        title={value}
      >
        {value}
      </span>
      {extra}
      <Button size="xs" variant="outline" onClick={onAction}>
        {action}
      </Button>
    </div>
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
              {/*
                A local server is reported as installed because there is no binary to look for —
                but "installed" and "running" are different questions for it, and the empty model
                list you get for the second one explains nothing on its own.
              */}
              {entry.provider.local && (
                <Badge tone="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                  must be running
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
  /** What the user's own `~/.codex/config.toml` is set to, so "default" can mean something. */
  const [configured, setConfigured] = useState<{ model: string | null; effort: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .engineModels('codex-cli')
      .then((result) => {
        if (cancelled) return
        setModels(result.models)
        setError(result.error)
        setConfigured(result.configured ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  /*
   * The model whose levels are the ones to show.
   *
   * Which levels exist is a property of the model, so with nothing chosen here there was nothing
   * to offer — and "Your Codex default" is the *default* selection, which meant the thinking
   * picker was invisible until a model was picked. It is not unknown, though: the user's own
   * `config.toml` names it, so the default resolves to a real model and brings its levels with
   * it. `codexConfigDefaults` was written for exactly this and only the probe was reading it.
   */
  const chosen =
    models?.find((m) => m.id === (model || configured?.model || '')) ?? null
  const levels = chosen?.reasoningLevels ?? []
  const usingConfigDefault = !model

  const save = async (next: { model?: string; effort?: string }): Promise<void> => {
    setSaving(true)
    try {
      // Configure, not select: Codex is already the running engine when this card is on screen,
      // and re-selecting it would restart every live runtime to change a preference.
      await api.configureEngine(
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
            hint={
              configured?.model
                ? `Codex itself is set to ${configured.model}`
                : 'Whatever the model is set to in Codex itself'
            }
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
              label={
                usingConfigDefault && configured?.effort
                  ? `your config · ${configured.effort}`
                  : chosen?.defaultReasoning
                    ? `default · ${chosen.defaultReasoning}`
                    : 'default'
              }
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

      {/*
        This used to promise a sandbox, and that promise is no longer true — so it says what is
        actually the case. `codex exec` cancels every tool call unless it is launched with the
        flag that also removes the sandbox, so the choice was an engine that cannot read a note
        or an engine that is not confined. Saying which one was chosen is the least this owes.
      */}
      <p className="mt-2.5 border-t border-border/60 pt-2 text-[11px] leading-snug text-warning text-pretty">
        Codex is not sandboxed here. Its own shell and file tools can reach anywhere on this
        computer while a turn is running, not just your vault — its CLI cancels every tool call
        unless the sandbox is off, so that is the trade. What it does to your notes still follows
        the chat’s permission setting.
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

/**
 * Where the models live, for the providers whose address is a real question.
 *
 * Its own step now rather than a field tucked inside the credential card, for two reasons. It is
 * the *first* question for `custom` and the *only* one for a local server, so burying it under a
 * heading about keys asked the second question first. And saving it used to go through
 * `selectEngine`, which switched the running agent to a half-configured provider as a side
 * effect of a keystroke — the flow now stores as it goes and switches once, at the end.
 */
function EndpointStep({
  entry,
  onSaved
}: {
  entry: ProviderState
  onSaved: () => void
}): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState(entry.baseUrl || entry.provider.baseUrl)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (!baseUrl.trim()) return
    setBusy(true)
    try {
      await api.configureEngine(entry.provider.id, undefined, baseUrl.trim())
      onSaved()
    } catch (err) {
      toast.error('Could not save it', { description: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="bg-card/60 px-3 py-3">
      <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
        <Server className="size-3.5" />
        {STEP_TITLES.endpoint}
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
        {entry.provider.blurb}
      </p>

      <div className="mt-3">
        <Label htmlFor="engine-base" className="text-[11px] text-foreground/90">
          Base URL
        </Label>
        <div className="mt-1 flex gap-1.5">
          <Input
            id="engine-base"
            value={baseUrl}
            placeholder="https://gateway.example.com/v1"
            spellCheck={false}
            onChange={(event) => setBaseUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void save()
              }
            }}
            className="h-8 text-[12px]"
          />
          <Button size="sm" onClick={() => void save()} disabled={busy || !baseUrl.trim()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Continue
          </Button>
        </div>
        <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground text-pretty">
          The address that answers <span className="font-mono">/chat/completions</span> and{' '}
          <span className="font-mono">/models</span> — usually ending in{' '}
          <span className="font-mono">/v1</span>.
          {entry.provider.local && (
            <>
              {' '}
              {entry.provider.label} has to be running on this machine before the app can reach it.
            </>
          )}
        </p>
      </div>
    </Card>
  )
}

function CredentialStep({
  entry,
  onSaved
}: {
  entry: ProviderState
  onSaved: () => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      if (key.trim()) await api.setEngineKey(entry.provider.id, key)

      /*
       * The cheap check, which is the right one *here*.
       *
       * Reading the model list is authenticated and costs no tokens, so it answers exactly the
       * question this step asks — is the key good. Whether the engine can actually hold a turn
       * is a different question, and it gets its own step at the end rather than being guessed
       * at from a 200 on a list endpoint.
       */
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
      <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
        <KeyRound className="size-3.5" />
        Connect {entry.provider.label}
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
        {entry.provider.blurb}
      </p>

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
  chosen,
  onChosen
}: {
  entry: ProviderState
  chosen: string
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
      <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
        <Sparkles className="size-3.5" />
        {STEP_TITLES.model}
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
                // 0.96 like every other pressable in the app; 0.99 is feedback the eye cannot
                // see, which reads as unimplemented rather than as restraint.
                'transition-colors duration-150 hover:border-border active:scale-[0.96]',
                model.id === chosen && 'border-primary/40 bg-primary/[0.06]'
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

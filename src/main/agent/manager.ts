import type {
  AgentCapability,
  AgentEffort,
  AgentEvent,
  AgentTurnOptions,
  ChatBlock,
  ChatImage,
  ChatMessage,
  EnginePrefs,
  TurnFollowups
} from '@shared/types'
import type { TurnState } from '@shared/ipc'
import { providerById } from '@shared/engines'
import type { GenUiSpec } from '@shared/genui'
import { writePath } from '@shared/bindings'
import type { BrainCore } from '../core'
import { ulid } from '../util/id'
import {
  ClaudeProcess,
  claudeAuthStatus,
  resolveClaudeBinary,
  type ClaudeStreamEvent,
  type ContentBlock
} from './claude'
import { buildSystemPrompt, deniedBrainTools } from './prompt'
import { ToolHost } from './toolhost'
import { buildBrainTools, type IntegrationBridge } from './tools'
import type { AgentEngine } from './engine'
import {
  capabilitiesFor,
  createEngine,
  effortFor,
  engineReadiness,
  modelFor
} from './engines/factory'
import type { UsageTracker } from '../usage/usage'
import { QuestionBroker } from './questions'
import type { ToolPreviewer } from '../toolPreview'
import { createLogger } from '../logger'

const log = createLogger('agent')

const IDLE_SHUTDOWN_MS = 15 * 60_000

/** Whoever is answering, by the name the user chose them under. */
function engineLabel(providerId: string): string {
  return providerById(providerId)?.label ?? providerId
}

/**
 * How much of a conversation is replayed to an engine that cannot resume.
 *
 * Enough for the thread to make sense, bounded because every turn pays for all of it again.
 * The vault is the memory that matters and the agent can search it; the chat is context, not
 * the record.
 */
const MAX_REPLAYED_TURNS = 40

interface Runtime {
  sessionId: string
  proc: AgentEngine
  capability: AgentCapability
  /** What this process was spawned with. Both are fixed at spawn, so a turn that
   *  wants different ones needs a fresh process. */
  model: string
  effort: string
  /** Claude's own id for the last assistant message we opened. */
  lastAssistantMessageId: string | null
  /** Our message id keyed by Claude's message id. */
  messageIds: Map<string, string>
  /** Where each tool_use block lives, so its result can be filled in later. */
  toolLocations: Map<string, { messageId: string; blockIndex: number }>
  blocks: Map<string, ChatBlock[]>
  streamingMessageId: string | null
  streamedText: string
  /** The turn's token total, for the message's own record once it finishes. */
  turnInputTokens: number
  turnOutputTokens: number
  /** When the current turn began, so the finished message can carry its duration. */
  turnStartedAt: number | null
  /** What the agent offered as a next step, if it offered anything. */
  followups: TurnFollowups | null
  lastActivity: number
  /** Set for the duration of a turn started by running a saved tool. */
  activeToolRun: { toolId: string } | null
  /** Set while a tool's button is running, so its result lands in the right place. */
  activeAction: NonNullable<AgentTurnOptions['toolAction']> | null
  /** Fixed at spawn, like model and capability, because the denylist is. */
  unattended: boolean
}

/**
 * Owns the lifetime of agent conversations.
 *
 * One `claude` process is kept alive per chat session so context stays warm
 * between turns. Stream events are folded into persisted ChatMessages here, and
 * every state change is broadcast so the renderer can show the turn as it
 * happens rather than after it finishes.
 */
export class AgentManager {
  private runtimes = new Map<string, Runtime>()
  readonly toolHost = new ToolHost()
  readonly questions: QuestionBroker
  /** Set by the bootstrap so a tool the agent creates gets its shortcut bound. */
  onShortcutsChanged: (() => void) | null = null
  /** Set by the app so the scheduler can re-arm a task the agent just changed. */
  onTaskChanged: ((taskId: string) => void) | null = null
  /** Set by the bootstrap; lets the agent see a rendering of what it built. */
  previewer: ToolPreviewer | null = null
  /**
   * Reads an engine's API key out of the secret vault.
   *
   * Injected rather than imported: the vault belongs to the integration registry, and reaching
   * for it from here would be a require cycle in the CJS main bundle. Keys live in the vault
   * and never in settings.json, which also means the redactor already covers them.
   */
  secretReader: ((ref: string) => string | undefined) | null = null
  private binary: string | null = null
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private core: BrainCore,
    private integrations: IntegrationBridge,
    private usage: UsageTracker
  ) {
    this.questions = new QuestionBroker((channel, payload) => core.broadcast(channel, payload))
  }

  async start(userDataDir: string): Promise<void> {
    this.binary = resolveClaudeBinary()

    this.toolHost.registerAll(
      buildBrainTools({
        core: this.core,
        integrations: this.integrations,
        emitGenUi: (spec, sessionId) => this.handleGenUi(spec, sessionId),
        suggestFollowups: (followups, sessionId) => {
          // Held on the runtime rather than written straight to the message: the turn's own
          // message is not finalised yet, and the `result` handler already makes exactly one
          // meta write. Two writers to one JSON column is how a partial write loses a field.
          const runtime = sessionId ? this.runtimes.get(sessionId) : undefined
          if (runtime) runtime.followups = followups
        },
        focusGraph: (nodeIds, opts) =>
          this.core.broadcast('graph:focus', { nodeIds, note: opts.note ?? null, depth: opts.depth ?? 0 }),
        focusIntegration: (integrationId) =>
          this.core.broadcast('integrations:focus', { integrationId }),
        probeGraph: (nodeIds, label) => {
          if (nodeIds.length === 0) return
          // Capped: a search that returns fifty nodes should read as a sweep, not
          // as the whole graph flashing at once.
          this.core.broadcast('graph:probe', { nodeIds: nodeIds.slice(0, 24), label })
        },
        askUser: (input) =>
          this.questions.ask({
            sessionId: input.sessionId ?? this.core.chat.currentSession().id,
            question: input.question,
            options: input.options,
            allowFreeText: input.allowFreeText
          }),
        syncShortcuts: () => this.onShortcutsChanged?.(),
        rescheduleTask: (taskId) => this.onTaskChanged?.(taskId),
        previewTool: (input) => {
          if (!this.previewer) throw new Error('previews are unavailable')
          return this.previewer.capture(input)
        }
      })
    )

    await this.toolHost.start(userDataDir)

    // In the background: the app must not wait on a CLI probe to finish starting.
    void this.resolveSubscription()

    this.idleTimer = setInterval(() => this.reapIdle(), 60_000)
    this.idleTimer.unref?.()
  }

  stop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    for (const runtime of this.runtimes.values()) runtime.proc.stop()
    this.runtimes.clear()
    this.toolHost.stop()
  }

  /**
   * Whether a turn could run at all.
   *
   * Asked of the *selected* engine rather than of the Claude binary. The app used to be able to
   * assume those were the same question; reporting "no agent" because the Claude CLI is absent,
   * while a perfectly configured OpenRouter key sits in the vault, would be the first thing to
   * break for someone who never installed it.
   */
  get available(): boolean {
    return this.readiness().ok
  }

  /** Why a turn cannot run, in a sentence the user can act on. */
  readiness(): { ok: boolean; reason: string | null } {
    return engineReadiness({
      settings: this.core.settings,
      secret: (ref) => this.secretReader?.(ref),
      model: modelFor(this.core.settings, this.core.settings.engine.providerId)
    })
  }

  /**
   * The model this turn runs on.
   *
   * `settings.model` is the *Claude* model name and always has been — "opus", "sonnet". Handing
   * that to DeepSeek is exactly what happened on the first real switch: a 400 saying the
   * supported names are deepseek-v4-pro or deepseek-v4-flash, "but you passed opus".
   *
   * So the engine's own choice wins, and an override is only honoured for the CLI engines. A
   * model pinned on a saved tool or a scheduled task is a *Claude* model name — it was chosen
   * when that was the only engine — and it means nothing to an API provider. Ignoring it there
   * keeps the tool working rather than failing with a name the provider has never heard of.
   */
  private resolveModel(prefs?: EnginePrefs | null): string {
    const providerId = this.core.settings.engine.providerId
    const configured = modelFor(this.core.settings, providerId)
    /*
     * A tool's or a task's own model, for *this* engine.
     *
     * The override used to be one value holding a Claude name, so it could only be honoured on
     * Claude — on any other engine a tool's carefully chosen fast model was discarded and the
     * turn ran on whatever the provider was set to globally. The setting existed, the panel
     * offered it, and it silently did nothing. Keyed by provider, it means what it says on every
     * engine, and a tool set up before a switch keeps its old choice for when you switch back.
     */
    const override = prefs?.[providerId]?.model

    /*
     * `settings.model` is the *Claude* model name — "opus", "sonnet" — and it is not a fallback
     * for anything else. Treating it as one is what sent `opus` to DeepSeek and got back "the
     * supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed opus".
     * The empty string is the honest answer for a provider with nothing chosen, and readiness
     * turns that into a sentence rather than a request.
     */
    if (providerId === 'claude-cli') return override || configured || this.core.settings.model
    return override || configured
  }

  /**
   * How hard to think, in the selected engine's own vocabulary.
   *
   * The same shape as `resolveModel` and for the same reason: the app's `AgentEffort` tiers are
   * the *Claude CLI's* tiers, and handing "high" to a provider that publishes its own set is the
   * model-name bug again in a second field. Codex enumerates six levels for its flagship —
   * including `ultra`, which this app's union does not have — and an empty answer means "use the
   * level in your own Codex config", which is always accepted.
   *
   * A per-tool or per-task effort is a Claude tier, chosen when that was the only engine, so it
   * is honoured only there.
   */
  private resolveEffort(prefs?: EnginePrefs | null): string {
    const providerId = this.core.settings.engine.providerId
    // Same shape and same reason as the model above: a level belongs to an engine's own ladder,
    // so it is stored under the engine it was chosen for.
    const override = prefs?.[providerId]?.effort
    if (providerId === 'claude-cli') return override || this.core.settings.effort
    return override || effortFor(this.core.settings, providerId)
  }

  /**
   * The conversation so far, for an engine that cannot resume one.
   *
   * Text only, and capped. A provider with no server-side session is sent the history on every
   * turn, so this is the whole cost model of that engine — and an unbounded replay of a chat
   * that has been running for a month is a bill rather than a feature. Tool calls and their
   * results are deliberately left out: they are the *middle* of previous turns, they are by far
   * the bulkiest part of a transcript, and the conclusions the agent drew from them are already
   * in the text it wrote.
   */
  private historyFor(sessionId: string): { role: 'user' | 'assistant'; text: string }[] {
    const messages = this.core.chat.listMessages(sessionId)
    const out: { role: 'user' | 'assistant'; text: string }[] = []

    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue
      const text = message.blocks
        .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) out.push({ role: message.role, text })
    }

    return out.slice(-MAX_REPLAYED_TURNS)
  }

  /* ---------------------------------------------------------------- turns */

  /** Key for today's accumulated usage, so the cap resets at local midnight. */
  private todayKey(): string {
    const now = new Date()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `budget/${now.getFullYear()}-${month}-${day}`
  }

  spendToday(): number {
    return this.core.kv.get<number>(this.todayKey()) ?? 0
  }

  /**
   * Whether spend caps apply right now.
   *
   * On a subscription there is no per-token charge for a cap to protect against,
   * so 'auto' stands down and the usage panel shows real rate-limit windows
   * instead. Caps exist for the metered-API-key case.
   */
  capsActive(): boolean {
    const mode = this.core.settings.budget.mode
    if (mode === 'off') return false
    if (mode === 'always') return true
    return !this.onSubscription()
  }

  private subscriptionCache: boolean | null = null

  /**
   * Resolved once at startup rather than on demand.
   *
   * Reading it means running the CLI, and doing that lazily inside a synchronous
   * getter meant the first turn — or the first footer refresh — blocked the whole
   * main process while a process started.
   */
  private async resolveSubscription(): Promise<void> {
    if (!this.binary) {
      this.subscriptionCache = false
      return
    }
    const auth = await claudeAuthStatus(this.binary)
    this.subscriptionCache = auth ? auth.loggedIn && auth.authMethod !== 'apiKey' : false
  }

  /**
   * Whether usage comes out of the signed-in plan rather than metered credits.
   *
   * Until the probe lands this answers "yes", which is the safe direction: caps
   * only exist to guard metered spend, and assuming otherwise could refuse a turn
   * on a subscription that has nothing to cap.
   */
  onSubscription(): boolean {
    return this.subscriptionCache ?? true
  }

  /** Remaining allowance, or null when no cap applies. */
  remainingToday(): number | null {
    if (!this.capsActive()) return null
    return Math.max(0, this.core.settings.budget.dailyLimitUsd - this.spendToday())
  }

  private recordSpend(usd: number): void {
    if (usd <= 0) return
    const key = this.todayKey()
    this.core.kv.set(key, (this.core.kv.get<number>(key) ?? 0) + usd)
  }

  async send(text: string, options: AgentTurnOptions = {}): Promise<{ sessionId: string }> {
    const ready = this.readiness()
    if (!ready.ok) throw new Error(ready.reason ?? 'No model engine is configured.')

    // Checked before anything is spawned, so an exhausted budget costs nothing.
    const budget = this.core.settings.budget
    if (this.capsActive()) {
      const spent = this.spendToday()
      if (spent >= budget.dailyLimitUsd) {
        throw new Error(
          `Today's usage cap has been reached (${spent.toFixed(2)} of ${budget.dailyLimitUsd.toFixed(2)}). Raise the limit in Settings to continue, or wait until tomorrow.`
        )
      }
    }

    const session = options.sessionId
      ? (this.core.chat.getSession(options.sessionId) ?? this.core.chat.currentSession())
      : this.core.chat.currentSession()

    /*
     * Whether this turn belongs to a tool is a property of the chat, not of the call site.
     *
     * Derived rather than trusted, because forgetting to pass it is invisible and expensive:
     * without it the generated prompt renders as a message the user wrote, the chat gets
     * renamed to its first eighty characters, and the notification says "Second Brain
     * replied" — three symptoms of one omission, which is exactly what happened. An explicit
     * `toolRun` still wins, since it carries the values the run was given.
     */
    const owningToolId = this.core.chat.toolIdFor(session.id)
    const owningTool = owningToolId ? this.core.tools.get(owningToolId) : undefined
    const toolRun =
      options.toolRun ??
      (owningTool
        ? { toolId: owningTool.id, toolName: owningTool.name, icon: owningTool.icon, values: {} }
        : undefined)

    const capability = options.capability ?? this.core.settings.defaultCapability
    const runtime = this.ensureRuntime(
      session.id,
      capability,
      this.resolveModel(options.enginePrefs),
      this.resolveEffort(options.enginePrefs),
      options.unattended === true
    )

    // Persist the user's turn before anything can fail downstream.
    const attached = options.images ?? []
    const userBlocks: ChatBlock[] = [
      ...attached.map((image) => ({
        type: 'image' as const,
        mediaType: image.mediaType,
        dataBase64: image.dataBase64,
        name: image.name
      })),
      { type: 'text' as const, text }
    ]

    const userMessage = this.core.chat.addMessage({
      sessionId: session.id,
      role: 'user',
      blocks: userBlocks,
      ts: Date.now(),
      ...(toolRun ? { meta: { toolRun } } : {}),
      ...(options.taskRun ? { meta: { taskRun: options.taskRun } } : {})
    })
    this.emit({ type: 'message', sessionId: session.id, message: userMessage })

    // First real message names the conversation — when the user wrote it.
    //
    // A generated prompt must not. Both a scheduled run's chat and a tool run's are already
    // named after what they run and when, and renaming either to the first eighty characters
    // of the injected instructions is how every check-in came to be titled "This is your
    // hourly check-in. Nobody asked…".
    if (!options.taskRun && !toolRun && this.core.chat.messageCount(session.id) === 1) {
      this.core.chat.renameSession(session.id, text.slice(0, 80).replace(/\s+/g, ' ').trim())
    }

    const payload = options.context ? `<context>\n${options.context}\n</context>\n\n${text}` : text

    runtime.lastActivity = Date.now()
    runtime.activeToolRun = toolRun ? { toolId: toolRun.toolId } : null
    runtime.activeAction = options.toolAction ?? null
    // Stamped here rather than in the renderer: a scheduled run has no renderer watching
    // it, and the duration it records has to be the turn's, not the moment a window
    // happened to notice.
    runtime.turnStartedAt = Date.now()
    runtime.turnInputTokens = 0
    runtime.turnOutputTokens = 0
    runtime.followups = null
    this.emit({ type: 'state', sessionId: session.id, state: 'thinking' })
    // Zero it on screen too, so the previous answer's total is not what the user watches
    // for the second or two before the first usage frame arrives.
    this.emit({ type: 'usage', sessionId: session.id, inputTokens: 0, outputTokens: 0 })
    runtime.proc.send(
      payload,
      attached.map((image) => ({ mediaType: image.mediaType, dataBase64: image.dataBase64 }))
    )

    return { sessionId: session.id }
  }

  interrupt(sessionId: string): void {
    // Release any question this turn was waiting on, or its promise never settles.
    this.questions.cancelSession(sessionId)

    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    runtime.proc.stop()
    this.runtimes.delete(sessionId)
    this.emit({ type: 'state', sessionId, state: 'idle', detail: 'stopped' })
  }

  /** Restart a session's process at a different capability tier. */
  setCapability(sessionId: string, capability: AgentCapability): void {
    const runtime = this.runtimes.get(sessionId)
    if (runtime && runtime.capability !== capability) {
      runtime.proc.stop()
      this.runtimes.delete(sessionId)
    }
    this.ensureRuntime(
      sessionId,
      capability,
      this.resolveModel(),
      this.resolveEffort(),
      // Changing tier is something the user did, so the replacement is attended.
      false
    )
  }

  /**
   * Whether a turn is still in flight for this session.
   *
   * The scheduler needs it to tell two things apart that both surface as an `error`
   * event: a process that has died, and one that reported a rate limit and is still
   * retrying. Killing the second aborts a turn that was going to succeed.
   */
  /**
   * What a session is doing, for a view that has just been opened onto it.
   *
   * Everything here already lives on the runtime; nothing new is tracked for it. The point
   * is only that the renderer can *ask*, rather than being told once and having to remember.
   */
  turnState(sessionId: string): TurnState {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime || !runtime.proc.isBusy) return { busy: false, startedAt: null, action: null }

    return {
      busy: true,
      startedAt: runtime.turnStartedAt,
      action: runtime.activeAction
        ? { toolId: runtime.activeAction.toolId, label: runtime.activeAction.label }
        : null
    }
  }

  isBusy(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.proc.isBusy ?? false
  }

  capabilityOf(sessionId: string): AgentCapability {
    return this.runtimes.get(sessionId)?.capability ?? this.core.settings.defaultCapability
  }

  /* -------------------------------------------------------------- runtime */

  private perTurnCeiling(): number | null {
    const budget = this.core.settings.budget
    if (!this.capsActive()) return null

    const remaining = Math.max(0, budget.dailyLimitUsd - this.spendToday())
    const perTurn = budget.perTurnLimitUsd > 0 ? budget.perTurnLimitUsd : remaining
    return Math.max(0.01, Math.min(perTurn, remaining))
  }

  private ensureRuntime(
    sessionId: string,
    capability: AgentCapability,
    model: string,
    effort: string,
    unattended: boolean
  ): Runtime {
    const existing = this.runtimes.get(sessionId)
    if (
      existing?.proc.alive &&
      existing.capability === capability &&
      existing.model === model &&
      existing.effort === effort &&
      // Part of the process's identity, not of the turn: the denylist is passed at spawn,
      // so reusing an attended process for an unattended run would hand a background turn
      // the tools it is not allowed to have.
      existing.unattended === unattended
    ) {
      return existing
    }
    if (existing) {
      // The conversation is not lost: the new process resumes Claude's session id,
      // so switching a tool to a different model keeps its history.
      existing.proc.stop()
      this.runtimes.delete(sessionId)
    }

    const session = this.core.chat.getSession(sessionId)
    const systemPrompt = buildSystemPrompt({
      workspaceRoot: this.core.paths.root,
      vaultDir: this.core.paths.vaultDir,
      integrationsDir: this.core.paths.integrationsDir,
      capability,
      stats: this.core.graph.stats(),
      engine: capabilitiesFor({
        providerId: this.core.settings.engine.providerId,
        model
      })
    })

    /*
     * Whichever engine the user chose.
     *
     * The factory returns the same `ClaudeProcess` this line used to construct when the setting
     * says so, which is why nothing below here changed: the manager's 1000 lines of message
     * assembly, tool blocks, usage metering and generated UI consume one event union and have
     * never known who produced it.
     */
    const proc = createEngine(
      {
        settings: this.core.settings,
        secret: (ref) => this.secretReader?.(ref),
        model
      },
      {
        cwd: this.core.paths.root,
        model,
        capability,
        // The CLI engines carry this in the MCP bridge's environment; an API engine calls the
        // tool host directly and has to be told, or `ask_user`, `render_ui` and
        // `suggest_followups` all succeed and do nothing.
        sessionId,
        appendSystemPrompt: systemPrompt,
        mcpConfig: this.buildMcpConfig(sessionId, capability),
        // Only when it belongs to this engine. A Codex thread id handed to Claude as something
        // to resume fails inside a turn the user is waiting on, and switching engine mid-chat
        // is exactly when that would happen.
        resumeSessionId: this.core.chat.resumableFor(
          sessionId,
          this.core.settings.engine.providerId
        ),
        // Never let one turn exceed either the per-turn cap or what is left of
        // today's allowance, whichever is smaller.
        maxBudgetUsd: this.perTurnCeiling(),
        // A scheduled run is unattended, which widens what it may not do.
        unattended,
        effort,
        // Where an API engine finds the brain tools. The CLI engines reach the same host
        // through the MCP bridge instead, and ignore this.
        toolEndpoint: this.toolHost.url
          ? { url: this.toolHost.url, token: this.toolHost.token }
          : null,
        // Replayed for an engine with nothing to resume, which is what lets a conversation
        // survive a change of engine: the history is the app's, not the provider's.
        history: this.historyFor(sessionId)
      },
      // `proc` is referenced before the constructor returns, but only from the
      // callback, which cannot fire until the child has spawned.
      (event) => this.onEvent(sessionId, event, proc)
    )

    const runtime: Runtime = {
      sessionId,
      proc,
      capability,
      model,
      effort,
      unattended,
      lastAssistantMessageId: null,
      messageIds: new Map(),
      toolLocations: new Map(),
      blocks: new Map(),
      streamingMessageId: null,
      streamedText: '',
      turnInputTokens: 0,
      turnOutputTokens: 0,
      turnStartedAt: null,
      followups: null,
      lastActivity: Date.now(),
      activeToolRun: null,
      activeAction: null
    }

    this.runtimes.set(sessionId, runtime)
    proc.start()
    return runtime
  }

  /**
   * The brain tools plus every enabled MCP integration. MCP servers are handed
   * straight to Claude Code rather than proxied through us — it already knows how
   * to speak both transports, and a passthrough keeps their tool schemas intact.
   */
  private buildMcpConfig(
    sessionId: string,
    capability: AgentCapability
  ): Record<string, unknown> {
    if (!this.toolHost.bridgePath) {
      throw new Error('tool host is not started')
    }

    const servers: Record<string, unknown> = {
      brain: {
        command: process.execPath,
        args: [this.toolHost.bridgePath],
        env: {
          // Runs the Electron binary as a plain Node runtime, so the bridge works
          // on a machine with no Node installed.
          ELECTRON_RUN_AS_NODE: '1',
          BRAIN_URL: this.toolHost.url,
          BRAIN_TOKEN: this.toolHost.token,
          BRAIN_SESSION_ID: sessionId,
          /*
           * The capability tier, enforced at the bridge as well as at the spawn.
           *
           * Claude is also given `--disallowedTools`, but Codex has no equivalent flag — so a
           * read-only Codex chat had a dutifully read-only *sandbox* and full write access to
           * the vault through the brain tools. The gate belongs here because this is the one
           * place every CLI engine's tool calls pass through.
           */
          BRAIN_DENY: deniedBrainTools(capability).join(',')
        }
      }
    }

    for (const record of this.core.integrations.list()) {
      if (!record.manifest.enabled) continue
      const manifest = record.manifest

      if (manifest.kind === 'mcp-stdio') {
        servers[safeServerName(manifest.id)] = {
          command: manifest.command,
          args: manifest.args,
          env: manifest.env ?? {},
          ...(manifest.cwd ? { cwd: manifest.cwd } : {})
        }
      } else if (manifest.kind === 'mcp-http') {
        servers[safeServerName(manifest.id)] = {
          type: 'http',
          url: manifest.url,
          headers: manifest.headers ?? {}
        }
      }
      // rest / script / webhook integrations are exposed through the brain
      // server's call_integration tool instead.
    }

    return { mcpServers: servers }
  }

  private reapIdle(): void {
    const now = Date.now()
    for (const [sessionId, runtime] of this.runtimes) {
      if (runtime.proc.isBusy) continue
      if (now - runtime.lastActivity < IDLE_SHUTDOWN_MS) continue
      log.info(`reclaiming idle agent process for session ${sessionId}`)
      runtime.proc.stop()
      this.runtimes.delete(sessionId)
    }
  }

  /* --------------------------------------------------------------- events */

  /**
   * Main-process observers of agent events.
   *
   * `emit` used to broadcast to windows and nothing else, which meant nothing inside
   * main could tell when a turn finished — the scheduler cannot record the outcome of
   * a run it started, and the notifier cannot know a reply has landed. Both need to
   * watch the same stream the renderer sees, so it forks here rather than each of
   * them reaching into the runtime map and guessing.
   */
  private observers = new Set<(event: AgentEvent) => void>()

  onAgentEvent(listener: (event: AgentEvent) => void): () => void {
    this.observers.add(listener)
    return () => this.observers.delete(listener)
  }

  private emit(event: AgentEvent): void {
    // The result of a turn is the event a tool is waiting on, so it is worth a
    // line: "produced but not delivered" and "never produced" look identical from
    // the outside, and the log window is where they get told apart.
    if (event.type === 'result' || event.type === 'error') {
      log.info(
        `${event.type} for session ${event.sessionId.slice(-6)}${
          event.type === 'result' ? ` (${event.text ? `${event.text.length} chars` : 'no text'})` : ` — ${event.message}`
        }`
      )
    }
    this.core.broadcast('agent:event', event)

    // After the broadcast, and each one isolated: an observer that throws must not
    // stop the windows from having been told, nor take the next observer down with it.
    for (const observer of this.observers) {
      try {
        observer(event)
      } catch (err) {
        log.warn('an agent event observer threw', err)
      }
    }
  }

  /**
   * Wait for the turn running in `sessionId` to settle.
   *
   * Resolves with the reply on success and rejects on error, so a caller that started
   * a turn can record what came of it. The timeout is a backstop rather than a limit:
   * a turn that legitimately waits on `ask_user` gets four minutes from the CLI, and a
   * scheduled run that stalls has to release its slot or the scheduler wedges.
   */
  awaitTurn(sessionId: string, timeoutMs = 15 * 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      let done = false

      const settle = (fn: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        off()
        fn()
      }

      const timer = setTimeout(
        () => settle(() => reject(new Error('the turn produced nothing for fifteen minutes'))),
        timeoutMs
      )

      const off = this.onAgentEvent((event) => {
        if (event.sessionId !== sessionId) return
        if (event.type === 'result') settle(() => resolve(event.text ?? ''))
        else if (event.type === 'error') settle(() => reject(new Error(event.message)))
      })
    })
  }

  private onEvent(sessionId: string, event: ClaudeStreamEvent, proc: AgentEngine): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    // A process that has been replaced still has events in flight. They belong to
    // a turn nobody is waiting on any more, and acting on them corrupts the live
    // one's message ids — except `exit`, which the case below handles itself.
    if (runtime.proc !== proc && event.type !== 'exit') return
    runtime.lastActivity = Date.now()

    switch (event.type) {
      case 'init': {
        if (event.claudeSessionId) {
          this.core.chat.setEngineSession(
            sessionId,
            event.claudeSessionId,
            this.core.settings.engine.providerId
          )
        }
        this.emit({
          type: 'session',
          sessionId,
          claudeSessionId: event.claudeSessionId,
          model: event.model,
          tools: event.tools
        })
        break
      }

      case 'text-delta': {
        if (!runtime.streamingMessageId) {
          runtime.streamingMessageId = ulid()
          runtime.streamedText = ''
        }
        runtime.streamedText += event.text
        this.emit({
          type: 'delta',
          sessionId,
          messageId: runtime.streamingMessageId,
          kind: 'text',
          text: event.text
        })
        break
      }

      case 'usage': {
        // Straight through. The renderer already re-renders on every text delta, so this
        // rides a path that is paid for — and it does no work here beyond two assignments,
        // which is what keeps a live counter off the critical path of the agent's turn.
        runtime.turnInputTokens = event.inputTokens
        runtime.turnOutputTokens = event.outputTokens
        this.emit({
          type: 'usage',
          sessionId,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens
        })
        break
      }

      case 'thinking-delta': {
        if (!runtime.streamingMessageId) runtime.streamingMessageId = ulid()
        this.emit({
          type: 'delta',
          sessionId,
          messageId: runtime.streamingMessageId,
          kind: 'thinking',
          text: event.text
        })
        break
      }

      case 'assistant': {
        this.finalizeAssistant(runtime, event.blocks, event.messageId)
        break
      }

      case 'tool-result': {
        const location = runtime.toolLocations.get(event.toolUseId)
        if (location) {
          const blocks = runtime.blocks.get(location.messageId)
          const block = blocks?.[location.blockIndex]
          if (blocks && block && block.type === 'tool') {
            block.status = event.isError ? 'error' : 'ok'
            block.result = truncate(event.content, 4000)
            this.core.chat.updateMessage(location.messageId, blocks)
          }
        }
        this.emit({
          type: 'tool-end',
          sessionId,
          id: event.toolUseId,
          status: event.isError ? 'error' : 'ok',
          result: truncate(event.content, 4000)
        })
        break
      }

      case 'result': {
        // A button whose result is text writes it straight into the tool's output
        // pane, so the user sees the finished thing rather than a chat reply.
        const action = runtime.activeAction
        if (action?.target === 'output' && event.text?.trim()) {
          try {
            const tool = this.core.tools.get(action.toolId)
            if (tool) {
              // A canvas action names where its result goes, so several results can
              // sit side by side; the fixed kinds use the single output pane.
              const path = action.writeTo ?? 'output'
              const state = writePath(
                tool.state as Record<string, unknown>,
                path,
                event.text.trim()
              )
              state['lastAction'] = action.label
              const updated = this.core.tools.writeState(action.toolId, state)
              this.core.broadcast('tools:stateChanged', {
                toolId: action.toolId,
                rev: updated.rev,
                note: null
              })
            }
          } catch (err) {
            log.warn('could not write the action result into the tool', err)
          }
        }
        runtime.activeAction = null

        if (event.costUsd > 0) {
          this.core.chat.addCost(sessionId, event.costUsd)
          this.recordSpend(event.costUsd)
        }

        // Any text that streamed without a matching assistant frame still needs
        // to be persisted, or the turn would vanish on reload.
        if (runtime.streamingMessageId && runtime.streamedText.trim()) {
          this.persistMessage(runtime, runtime.streamingMessageId, [
            { type: 'text', text: runtime.streamedText }
          ])
        }
        // What the turn cost, on the message it produced. `durationMs` has been a declared
        // field on ChatMessageMeta all along and nothing ever wrote it.
        if (runtime.lastAssistantMessageId) {
          const ours = runtime.messageIds.get(runtime.lastAssistantMessageId)
          const blocks = ours ? runtime.blocks.get(ours) : undefined
          if (ours && blocks) {
            // Stored *and* re-emitted. The renderer holds its own copy of the transcript,
            // so a write that only reaches SQLite is invisible until the session is
            // reloaded — which is why the finished turn showed no duration at all. The
            // same trap as `render_ui`, and for the same reason.
            const updated = this.core.chat.updateMessage(ours, blocks, {
              durationMs:
                event.durationMs > 0
                  ? event.durationMs
                  : runtime.turnStartedAt
                    ? Date.now() - runtime.turnStartedAt
                    : undefined,
              numTurns: event.numTurns,
              ...(runtime.turnOutputTokens > 0
                ? {
                    inputTokens: runtime.turnInputTokens,
                    outputTokens: runtime.turnOutputTokens
                  }
                : {}),
              ...(runtime.followups ? { followups: runtime.followups } : {})
            })

            if (updated) {
              this.emit({ type: 'message', sessionId, message: updated, supersedes: null })
            }
          }
        }

        runtime.streamingMessageId = null
        runtime.streamedText = ''
        runtime.turnStartedAt = null
        runtime.followups = null

        this.core.recordActivity({
          kind: 'agent.turn',
          actor: 'agent',
          title: event.text ? truncate(event.text.replace(/\s+/g, ' '), 90) : 'Completed a turn',
          detail: { costUsd: event.costUsd, durationMs: event.durationMs, turns: event.numTurns }
        })

        // The CLI stopped itself on the per-process ceiling. Say so plainly
        // rather than letting the turn look like it simply ended.
        if (event.subtype === 'error_max_budget_usd') {
          this.emit({
            type: 'error',
            sessionId,
            message:
              'The turn was stopped by the per-turn spend ceiling. Raise it in Settings if the task genuinely needs more steps.'
          })
        }

        /*
         * A turn that failed has to say so.
         *
         * The Claude CLI writes an assistant message before almost any failure, so the error was
         * always visible as text in the transcript. An API engine that is refused at the first
         * request writes nothing at all — which left the user's own message on screen, the
         * composer apparently still working, and the reason for it only in the log. The state
         * did go idle; there was simply nothing to see.
         */
        if (event.isError && !runtime.lastAssistantMessageId) {
          this.emit({
            type: 'error',
            sessionId,
            message: event.text?.trim() || 'The turn failed before the model answered.'
          })
        }

        this.emit({
          type: 'result',
          sessionId,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          numTurns: event.numTurns,
          isError: event.isError,
          text: event.text
        })
        this.emit({ type: 'state', sessionId, state: 'idle' })
        break
      }

      case 'stderr': {
        // A rate limit is the one failure the user needs told about immediately,
        // since it explains why nothing is happening and when it will resume.
        if (/rate.?limit|usage limit|429|too many requests|quota/i.test(event.text)) {
          this.usage.noteRateLimit(event.text)
          this.emit({
            type: 'error',
            sessionId,
            // Named after whichever engine said it. "Claude reported a usage limit" in front of
            // someone running DeepSeek names the wrong provider and sends them to check the
            // wrong account.
            message: `${engineLabel(this.core.settings.engine.providerId)} reported a usage limit: ${event.text.slice(0, 200)}`
          })
          break
        }

        // The CLI writes progress chatter here too; only surface real failures.
        if (/error|fatal|unauthorized|not found|invalid/i.test(event.text)) {
          log.warn(`${this.core.settings.engine.providerId}: ${event.text.slice(0, 300)}`)
        }
        break
      }

      case 'exit': {
        // Only the session's *current* process may end its session.
        //
        // Killing a process is synchronous but its exit is not, so a replaced child
        // reports one a few milliseconds later — by which time the map already holds
        // the replacement. Deleting by session id therefore removed the live runtime,
        // and every event from the process actually doing the work was then dropped
        // by the `if (!runtime) return` guard above: the turn ran, was billed, and
        // never came back. On Windows the killed child also reports code 1, so it
        // announced a crash that had not happened.
        if (runtime.proc !== proc) {
          log.debug(`ignoring exit from a replaced process for session ${sessionId.slice(-6)}`)
          break
        }

        this.runtimes.delete(sessionId)

        if (!proc.stopped && event.code !== 0 && event.code !== null) {
          this.emit({
            type: 'error',
            sessionId,
            message: `The agent process exited unexpectedly (code ${event.code}).`
          })
        }

        // A turn cut off by the process dying has to settle, or whatever is waiting
        // on it waits forever. The renderer treats an error as a settled run.
        if (event.wasBusy && !proc.stopped) {
          this.emit({
            type: 'error',
            sessionId,
            message: 'The agent stopped before it finished. Try that again.'
          })
        }

        this.emit({ type: 'state', sessionId, state: 'idle' })
        break
      }

      case 'parse-error': {
        log.warn(`unparseable line from claude: ${event.line}`)
        break
      }
    }
  }

  /** Convert a complete assistant frame into a persisted ChatMessage. */
  private finalizeAssistant(
    runtime: Runtime,
    contentBlocks: ContentBlock[],
    claudeMessageId: string | null
  ): void {
    const messageId =
      (claudeMessageId ? runtime.messageIds.get(claudeMessageId) : null) ??
      runtime.streamingMessageId ??
      ulid()

    if (claudeMessageId) runtime.messageIds.set(claudeMessageId, messageId)

    const blocks: ChatBlock[] = []

    for (const block of contentBlocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        blocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        blocks.push({ type: 'thinking', text: block.thinking })
      } else if (block.type === 'tool_use' && block.id && block.name) {
        const index = blocks.length
        blocks.push({
          type: 'tool',
          id: block.id,
          name: block.name,
          input: block.input,
          status: 'running',
          meta: { brainTool: block.name.startsWith('mcp__brain__') }
        })
        runtime.toolLocations.set(block.id, { messageId, blockIndex: index })

        this.emit({
          type: 'tool-start',
          sessionId: runtime.sessionId,
          messageId,
          id: block.id,
          name: block.name,
          input: block.input
        })
      }
    }

    if (blocks.length === 0) return

    // Text streamed into a buffer that is not the one being saved has been folded
    // into this frame, so the buffer has to be named as replaced — otherwise it
    // stays on screen beside the saved copy.
    const orphaned =
      runtime.streamingMessageId && runtime.streamingMessageId !== messageId
        ? runtime.streamingMessageId
        : null
    if (orphaned) {
      log.debug(`message ${messageId.slice(-6)} supersedes buffer ${orphaned.slice(-6)}`)
    }

    this.persistMessage(runtime, messageId, blocks, orphaned)

    runtime.lastAssistantMessageId = messageId
    runtime.streamingMessageId = null
    runtime.streamedText = ''

    const hasToolCall = blocks.some((b) => b.type === 'tool')
    this.emit({
      type: 'state',
      sessionId: runtime.sessionId,
      state: hasToolCall ? 'working' : 'thinking'
    })
  }

  private persistMessage(
    runtime: Runtime,
    messageId: string,
    blocks: ChatBlock[],
    supersedes: string | null = null
  ): void {
    const existing = runtime.blocks.has(messageId)
    runtime.blocks.set(messageId, blocks)

    if (existing) {
      this.core.chat.updateMessage(messageId, blocks)
    } else {
      this.core.chat.addMessage({
        id: messageId,
        sessionId: runtime.sessionId,
        role: 'assistant',
        blocks,
        ts: Date.now()
      })
    }

    this.emit({
      type: 'message',
      sessionId: runtime.sessionId,
      supersedes,
      message: {
        id: messageId,
        sessionId: runtime.sessionId,
        role: 'assistant',
        blocks,
        ts: Date.now()
      }
    })
  }

  /**
   * Store a rendered spec and attach it to the message whose render_ui call
   * produced it, so it appears inline at the right point in the conversation.
   */
  private handleGenUi(spec: GenUiSpec, sessionId: string | null): string {
    const targetSession = sessionId ?? this.core.chat.currentSession().id
    const runtime = this.runtimes.get(targetSession)
    const messageId = runtime?.lastAssistantMessageId ?? null

    const record = this.core.chat.addGenUi(spec, targetSession, messageId)

    // Remember it against the tool that produced it, so the Tools panel can
    // reopen the interface directly instead of spending a turn rebuilding it.
    if (runtime?.activeToolRun) {
      this.core.tools.setLastSpec(runtime.activeToolRun.toolId, record.id)
      this.core.broadcast('tools:changed')
    }

    if (runtime && messageId) {
      const blocks = runtime.blocks.get(messageId)
      if (blocks) {
        blocks.push({ type: 'genui', specId: record.id })
        this.core.chat.updateMessage(messageId, blocks)

        // The renderer holds its own copy of the message, so appending a block
        // to the stored version is not enough — without re-emitting, the spec is
        // saved and never shown, which reads as "built an interface" with
        // nothing appearing.
        this.emit({
          type: 'message',
          sessionId: targetSession,
          message: {
            id: messageId,
            sessionId: targetSession,
            role: 'assistant',
            blocks,
            ts: Date.now()
          }
        })
      }
    }

    this.core.broadcast('genui:new', {
      sessionId: targetSession,
      messageId,
      specId: record.id,
      spec
    })

    return record.id
  }
}

/** MCP server keys must be simple identifiers. */
function safeServerName(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return clean.length ? clean : 'integration'
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text
}

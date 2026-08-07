import type { AgentEffort } from './types'

/**
 * Which model runs the agent, and what that choice costs you in capability.
 *
 * The app was built on one engine — the `claude` CLI on the user's own subscription — and the
 * whole of it, chat, tools, scheduler, notifications, graph focus, consumes a single event
 * union. So a second engine is not a rewrite: it is another producer of `AgentEvent`. What it
 * *is* is a promise that has to be kept honestly, because the engines differ in ways the user
 * will notice, and an interface that hides the difference is an interface that lies.
 *
 * Three families, and the gap between them is the point of `EngineCapabilities`:
 *
 * - **CLI engines** (`claude`, `codex`) are whole agents. They bring their own file and shell
 *   tools, their own agentic loop, and their own server-side session to resume. We spawn them
 *   and translate their frames.
 * - **API engines** speak the OpenAI chat-completions dialect, which is the lingua franca:
 *   OpenRouter, DeepSeek, OpenAI, Groq, Together, and anything local (Ollama, LM Studio) all
 *   answer the same three endpoints. One adapter covers all of them, and the *loop* is ours —
 *   we hold the history, we call the tools, we decide when the turn is over.
 * - **Nothing else.** A provider that does not speak this dialect is a provider we do not
 *   support, and saying so is better than a half-adapter that fails on tool calls.
 *
 * Nothing here is a model list. Model lists go stale in weeks — DeepSeek's line moved to v4
 * while this was being written — so the catalogue is fetched from the provider at runtime and
 * this file only knows *where to ask*.
 */

/* ------------------------------------------------------------------- engines */

export type EngineId = 'claude-cli' | 'codex-cli' | 'openai-compatible'

/**
 * How a provider wants "think harder" expressed.
 *
 * Genuinely four different wire formats for one idea, which is why this is a tagged dialect
 * rather than a boolean. Getting it wrong does not error — the parameter is ignored and the
 * model simply does not think, which is the most expensive kind of silent failure.
 */
export type ReasoningDialect =
  /** OpenAI and most of its imitators: a top-level `reasoning_effort` string. */
  | 'reasoning_effort'
  /** OpenRouter's unified object: `reasoning: { effort }`, normalised across every provider. */
  | 'openrouter'
  /** DeepSeek: `thinking: { type: 'enabled' }` alongside `reasoning_effort`. */
  | 'deepseek'
  /** Anthropic-shaped: `thinking: { type: 'enabled', budget_tokens }`. */
  | 'anthropic'
  /** The model has no reasoning control; sending one is noise. */
  | 'none'

export interface EngineProvider {
  id: string
  label: string
  /** What it is, in one line, for the setup step. */
  blurb: string
  engine: EngineId
  /** Base URL for the OpenAI-compatible endpoints. Empty for CLI engines. */
  baseUrl: string
  /** Vault ref for the key. Empty when the provider needs none (local servers). */
  secretRef: string
  /** Where the user gets a key. Shown as a link. */
  keyUrl?: string
  needsKey: boolean
  reasoning: ReasoningDialect
  /**
   * Extra headers the provider wants.
   *
   * OpenRouter asks for these for attribution and they are harmless everywhere else; sending
   * them is cheaper than a per-provider branch.
   */
  headers?: Record<string, string>
  /** True when the provider bills per token, so the app's spend caps have to wake up. */
  metered: boolean
}

/**
 * The providers offered in the setup flow.
 *
 * A starting point, not a limit: `custom` takes any base URL, which is what makes a local
 * Ollama, a company gateway, or a provider that launched last week work without a release.
 */
export const ENGINE_PROVIDERS: EngineProvider[] = [
  {
    id: 'claude-cli',
    label: 'Claude Code',
    blurb:
      'Your own Claude subscription, through the CLI you already signed in to. Brings its own file and shell tools, and every MCP connector on your account.',
    engine: 'claude-cli',
    baseUrl: '',
    secretRef: '',
    needsKey: false,
    reasoning: 'anthropic',
    metered: false
  },
  {
    id: 'codex-cli',
    label: 'Codex',
    blurb:
      "OpenAI's Codex CLI, on the account it is signed in to. Also a whole agent: its own sandboxed shell, its own file edits, and its own MCP servers.",
    engine: 'codex-cli',
    baseUrl: '',
    secretRef: '',
    needsKey: false,
    keyUrl: 'https://developers.openai.com/codex/cli',
    reasoning: 'reasoning_effort',
    metered: false
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    blurb:
      'One key, several hundred models from every major lab. The widest choice, and the only one that normalises reasoning across providers.',
    engine: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    secretRef: 'engine.openrouter.key',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
    reasoning: 'openrouter',
    headers: {
      'HTTP-Referer': 'https://github.com/emre-aktas/second-brain',
      'X-Title': 'Second Brain'
    },
    metered: true
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    blurb: 'DeepSeek direct. Cheap, strong at reasoning, and thinking is a request parameter.',
    engine: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    secretRef: 'engine.deepseek.key',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    needsKey: true,
    reasoning: 'deepseek',
    metered: true
  },
  {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'The OpenAI API directly, billed to your OpenAI account.',
    engine: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    secretRef: 'engine.openai.key',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    reasoning: 'reasoning_effort',
    metered: true
  },
  {
    id: 'groq',
    label: 'Groq',
    blurb: 'Open models at very high speed.',
    engine: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    secretRef: 'engine.groq.key',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
    reasoning: 'reasoning_effort',
    metered: true
  },
  {
    id: 'together',
    label: 'Together',
    blurb: 'A broad catalogue of open-weight models.',
    engine: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    secretRef: 'engine.together.key',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    needsKey: true,
    reasoning: 'none',
    metered: true
  },
  {
    id: 'ollama',
    label: 'Ollama',
    blurb:
      'A model running on this machine. Nothing leaves the computer and nothing is billed — but a local model has to be good at tool calling for the agent to work.',
    engine: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    secretRef: '',
    needsKey: false,
    reasoning: 'none',
    metered: false
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    blurb: 'The local server LM Studio exposes, on this machine.',
    engine: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    secretRef: '',
    needsKey: false,
    reasoning: 'none',
    metered: false
  },
  {
    id: 'custom',
    label: 'Anything OpenAI-compatible',
    blurb:
      'Any endpoint that answers /chat/completions and /models — a company gateway, a provider that launched last week, a proxy of your own.',
    engine: 'openai-compatible',
    baseUrl: '',
    secretRef: 'engine.custom.key',
    needsKey: true,
    reasoning: 'reasoning_effort',
    metered: true
  }
]

export function providerById(id: string): EngineProvider | undefined {
  return ENGINE_PROVIDERS.find((provider) => provider.id === id)
}

/* -------------------------------------------------------------- capabilities */

/**
 * What the chosen engine can actually do.
 *
 * Declared by the engine and read by everything else, because the alternative is every surface
 * guessing. The effort selector, the usage windows in the footer, the spend caps and the
 * warning about MCP connectors are all downstream of this object — and each of them was
 * previously written on the assumption that the answer was always "Claude CLI, yes".
 */
export interface EngineCapabilities {
  engine: EngineId
  providerId: string
  /** Model ids come from the provider at runtime; this is what it settled on. */
  model: string
  /** The engine brings its own file and shell tools. False for a raw API model. */
  builtInTools: boolean
  /** The provider keeps the conversation, so a turn can resume by id rather than by replay. */
  serverSideSessions: boolean
  /** Text arrives token by token. Codex reports a message only when it is finished. */
  streamsText: boolean
  /** A thinking budget can be asked for at all. */
  reasoning: boolean
  /** The model can be given tools. Without this the agent cannot touch the vault. */
  toolCalling: boolean
  /** The user's own MCP connectors (Gmail, Slack…) are reachable. CLI engines only. */
  accountConnectors: boolean
  /** Real money per token, so the budget caps apply and the footer shows spend. */
  metered: boolean
  /** Plan usage windows can be read. `claude -p /usage` only. */
  usageWindows: boolean
}

/**
 * What is missing, in words, for a user looking at the choice.
 *
 * Kept here rather than in the panel so the agent's own prompt can be told the same thing: an
 * agent that does not know it has no shell will keep offering to run commands.
 */
export function capabilityNotes(capabilities: EngineCapabilities): string[] {
  const notes: string[] = []

  if (!capabilities.toolCalling) {
    notes.push(
      'This model does not support tool calling, so the agent cannot read or write your notes. It can only talk.'
    )
  }
  if (!capabilities.builtInTools) {
    notes.push(
      'No file or shell access: the agent works through the vault tools only, and cannot run commands or edit files outside your notes.'
    )
  }
  if (!capabilities.accountConnectors) {
    notes.push(
      'Your account’s own MCP connectors (Gmail, Slack, Calendar…) are not available here — those come with the Claude CLI. Integrations you set up in this app still work.'
    )
  }
  if (!capabilities.serverSideSessions) {
    notes.push(
      'The conversation is replayed to the provider on every turn, so a long chat costs more each time than it did with a resumable session.'
    )
  }
  if (capabilities.metered) {
    notes.push(
      'This provider bills per token to your own account, so the app’s spend caps are enforced while it is selected.'
    )
  }
  if (!capabilities.usageWindows) {
    notes.push('Plan usage windows are not reported by this provider.')
  }

  return notes
}

/* ---------------------------------------------------------------- reasoning */

/**
 * The app's five effort levels as the chosen provider wants them.
 *
 * The app keeps one vocabulary — `low` to `max`, already stored on saved tools and scheduled
 * tasks — and each dialect maps it down. That is what lets the engine change without touching
 * a single tool or task: the effort a tool was saved with still means something afterwards.
 *
 * Returned as a patch to merge into the request body, so a dialect that wants two fields can
 * ask for two and `none` can ask for nothing.
 */
export function reasoningPatch(
  dialect: ReasoningDialect,
  effort: AgentEffort
): Record<string, unknown> {
  // OpenAI's scale tops out at 'high'; the app's two extra levels are ambition, not a wire
  // value, so they clamp rather than being sent through and rejected.
  const openaiEffort =
    effort === 'max' || effort === 'xhigh' ? 'high' : effort === 'low' ? 'low' : effort

  switch (dialect) {
    case 'reasoning_effort':
      return { reasoning_effort: openaiEffort }

    case 'openrouter':
      // OpenRouter accepts the full ladder including `xhigh` and `max`, and normalises it per
      // provider — a token budget for Anthropic, a thinking level for Gemini.
      return { reasoning: { effort } }

    case 'deepseek':
      return { thinking: { type: 'enabled' }, reasoning_effort: openaiEffort }

    case 'anthropic':
      return { thinking: { type: 'enabled', budget_tokens: budgetFor(effort) } }

    case 'none':
      return {}
  }
}

/** A thinking budget in tokens, for the dialects that want a number rather than a word. */
export function budgetFor(effort: AgentEffort): number {
  switch (effort) {
    case 'low':
      return 2_048
    case 'medium':
      return 8_192
    case 'high':
      return 16_384
    case 'xhigh':
      return 32_768
    case 'max':
      return 64_000
  }
}

/* ------------------------------------------------------------------- models */

/**
 * One model, as the provider describes itself.
 *
 * Fetched, never hardcoded. OpenRouter alone lists several hundred and the set changes weekly;
 * a list compiled by hand is wrong by the next release and wrong in the way that matters most,
 * because a model id that no longer exists fails at the first turn rather than at startup.
 */
export interface ModelInfo {
  id: string
  label: string
  /** Tokens, when the provider says. */
  contextLength: number | null
  /** USD per million prompt/completion tokens, when the provider says. */
  promptPrice: number | null
  completionPrice: number | null
  /** The provider says this model accepts tools. Without it the agent is only a chat. */
  supportsTools: boolean
  /** The provider says this model can be asked to think. */
  supportsReasoning: boolean
  description?: string
  /**
   * The thinking levels this particular model accepts, when the provider enumerates them.
   *
   * Per model rather than per provider, because they genuinely differ: on Codex today
   * `gpt-5.6-sol` goes up to `ultra` and `gpt-5.5` stops at `xhigh`, so one list for the
   * provider would offer a level that fails on half its models. Empty means the app's own
   * `AgentEffort` tiers apply, which is the case for every OpenAI-compatible provider.
   */
  reasoningLevels?: { effort: string; description: string }[]
  /** The provider's own default level, used when the user has not picked one. */
  defaultReasoning?: string | null
}

/* --------------------------------------------------------------- the panel */

/** One provider as the setup screen needs it: what it is, and where the user has got to. */
export interface ProviderState {
  provider: EngineProvider
  /** The binary or endpoint is actually there. */
  installed: boolean
  /** A key is stored for it, or it needs none. */
  configured: boolean
  /** The model chosen for this provider, if any. */
  model: string
  /** Overridden base URL, when the user set one. */
  baseUrl: string
  /** True for the one currently running the agent. */
  selected: boolean
}

/** Everything the Engine tab draws from, in one read. */
export interface EngineState {
  providers: ProviderState[]
  selectedProviderId: string
  capabilities: EngineCapabilities
  /** The thinking level in force for the selected provider, in that provider's words. */
  effort: string
  /** Why a turn cannot run right now, or null. */
  blocked: string | null
  /** What is given up by this choice, in words. */
  notes: string[]
}

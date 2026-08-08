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

/**
 * How a provider has to be *asked* for token counts on a streamed answer.
 *
 * Every one of them reports usage on a non-streamed call and none of them reports it on a
 * streamed one unless told to, which is the whole reason this exists: the turn meter read zero
 * against every real provider while reading correctly against a fake one that volunteered the
 * numbers. And zero is not a visible failure — it looks like a turn that was simply cheap.
 *
 * Two spellings, because OpenAI put the flag in `stream_options` and OpenRouter put it in a
 * top-level `usage` object. Sending the wrong one is not an error anywhere; it is just ignored.
 */
export type UsageDialect = 'stream_options' | 'openrouter' | 'none'

/**
 * Which field caps the answer's length.
 *
 * `max_tokens` was the field for years and is now *rejected outright* by OpenAI's current
 * models — "Unsupported parameter: 'max_tokens' is not supported with this model. Use
 * 'max_completion_tokens' instead" — so the one parameter meant to protect the user's spend was
 * what made every OpenAI turn fail before it started. Most other providers still take the old
 * name and some take neither, which is why this is declared per provider and why `request`
 * drops it and retries when a provider complains about it by name.
 */
export type MaxTokensField = 'max_tokens' | 'max_completion_tokens'

/**
 * One way of getting a CLI onto the machine.
 *
 * Several per platform, because the right answer depends on what someone already has: a person
 * with Homebrew wants one line, a person who has never opened a terminal wants the installer that
 * asks for nothing. Ordered, and the first for a platform is the one to recommend.
 */
export interface CliInstallRoute {
  id: string
  label: string
  platforms: ('win32' | 'darwin' | 'linux')[]
  /** Which terminal to open, named the way the operating system names it. */
  shell: string
  command: string
  /** Why you would pick this one over the others. */
  hint?: string
}

/**
 * How someone who has never used a terminal gets this engine working.
 *
 * The app used to answer "Codex is not installed on this machine" with a toast and stop, which
 * is a dead end dressed as an error: it names a problem, offers no way through, and leaves a
 * beginner to search for install instructions themselves and hope they find the current ones.
 * Every command here is quoted from the vendor's own documentation rather than remembered.
 */
export interface CliSetup {
  /** For someone who would rather click than type. */
  downloadUrl: string
  /** Ordered; the first that matches the platform is the recommended one. */
  install: CliInstallRoute[]
  /** What to run once it is installed, and what happens when you do. */
  signIn: { command: string; blurb: string }
  /** What the account has to be, where that is a real constraint. */
  account?: string
  /** How to confirm it landed, for the person whose terminal said nothing useful. */
  verifyCommand: string
}

/**
 * Where someone is in getting a CLI engine working, as three separate questions.
 *
 * Separate because they have three different fixes. The panel used to ask only the first and
 * answer a no with a toast — "Codex is not installed on this machine" — which names a problem
 * and offers no way through it.
 */
export interface CliStatus {
  providerId: string
  installed: boolean
  path: string | null
  version: string | null
  /**
   * Signed in — and null when that genuinely cannot be known.
   *
   * Codex is the null case and it matters: `codex login status` answers "Logged in using
   * ChatGPT" while the refresh token is spent, so a *positive* from it means nothing. A negative
   * is still trustworthy. "No" is a fact, "yes" is a hope, and the small turn at the end of
   * setup is what settles it.
   */
  signedIn: boolean | null
  /** What the CLI said about the account, when it said anything useful. */
  account: string | null
}

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
  /** Install and sign-in instructions, for the engines that are a program on the machine. */
  setup?: CliSetup
  reasoning: ReasoningDialect
  /** How to ask for token counts while streaming. Absent means `stream_options`. */
  usage?: UsageDialect
  /** Which field caps the answer. Absent means `max_tokens`. */
  maxTokens?: MaxTokensField
  /**
   * A local server, so "is it installed" is "is it answering".
   *
   * The panel reported every API provider as installed, which for a model running on this
   * machine is a claim about a process that may not be running — and the only symptom was a
   * model list that came back empty with no clue as to why.
   */
  local?: boolean
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
    /*
     * Quoted from code.claude.com/docs/en/setup, not remembered.
     *
     * The native installer leads because it is the only route with no prerequisite — npm needs
     * Node 22, Homebrew needs Homebrew, and a beginner who has neither meets a second problem
     * before the first one is solved.
     */
    setup: {
      downloadUrl: 'https://code.claude.com/docs/en/setup',
      verifyCommand: 'claude --version',
      account: 'Claude Code needs a Pro, Max, Team or Enterprise plan. The free Claude.ai plan does not include it.',
      signIn: {
        command: 'claude',
        blurb:
          'Starts Claude Code and opens your browser to sign in. Once it says you are logged in you can close the terminal.'
      },
      install: [
        {
          id: 'native-win',
          label: 'Windows installer',
          platforms: ['win32'],
          shell: 'PowerShell',
          command: 'irm https://claude.ai/install.ps1 | iex',
          hint: 'Nothing else needed. Open the Start menu, type PowerShell, and paste this in.'
        },
        {
          id: 'native-unix',
          label: 'Installer script',
          platforms: ['darwin', 'linux'],
          shell: 'Terminal',
          command: 'curl -fsSL https://claude.ai/install.sh | bash',
          hint: 'Nothing else needed, and it keeps itself up to date afterwards.'
        },
        {
          id: 'brew',
          label: 'Homebrew',
          platforms: ['darwin', 'linux'],
          shell: 'Terminal',
          command: 'brew install --cask claude-code',
          hint: 'If you already use Homebrew. You will have to upgrade it yourself.'
        },
        {
          id: 'winget',
          label: 'WinGet',
          platforms: ['win32'],
          shell: 'PowerShell',
          command: 'winget install Anthropic.ClaudeCode',
          hint: 'If you already use WinGet. You will have to upgrade it yourself.'
        },
        {
          id: 'npm',
          label: 'npm',
          platforms: ['win32', 'darwin', 'linux'],
          shell: 'Terminal',
          command: 'npm install -g @anthropic-ai/claude-code',
          hint: 'Needs Node.js 22 or later. Do not put sudo in front of it.'
        }
      ]
    },
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
    setup: {
      downloadUrl: 'https://developers.openai.com/codex/cli',
      verifyCommand: 'codex --version',
      account: 'Signs in with your ChatGPT account.',
      signIn: {
        command: 'codex login',
        blurb:
          'Opens your browser to sign in with ChatGPT. This is also what to run when Codex stops working later — the session expires and says so only when a turn fails.'
      },
      install: [
        {
          id: 'winget',
          label: 'Windows installer',
          platforms: ['win32'],
          shell: 'PowerShell',
          command: 'winget install OpenAI.Codex',
          hint: 'Nothing else needed. Open the Start menu, type PowerShell, and paste this in.'
        },
        {
          id: 'native-unix',
          label: 'Installer script',
          platforms: ['darwin', 'linux'],
          shell: 'Terminal',
          command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
          hint: 'Nothing else needed.'
        },
        {
          id: 'npm',
          label: 'npm',
          platforms: ['win32', 'darwin', 'linux'],
          shell: 'Terminal',
          command: 'npm install -g @openai/codex',
          hint: 'Needs Node.js 16 or later. Do not put sudo in front of it.'
        }
      ]
    },
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
    usage: 'openrouter',
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
    // Its current models reject `max_tokens` outright. This one line is the difference between
    // the OpenAI provider working and every turn on it failing with a 400 about a parameter the
    // user never chose to send.
    maxTokens: 'max_completion_tokens',
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
    maxTokens: 'max_completion_tokens',
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
    local: true,
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
    local: true,
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
  /**
   * The engine's own shell and file tools are confined to the workspace.
   *
   * False for Codex, and not by choice: `codex exec` cancels every MCP tool call unless it is
   * launched with `--dangerously-bypass-approvals-and-sandbox`, which removes the sandbox along
   * with the approval prompt, and `-c sandbox_mode` cannot put it back. So the honest choice was
   * an engine that cannot read a note or an engine that is not confined — and the second, said
   * out loud, beats the first said quietly.
   */
  sandboxed: boolean
  /**
   * What the brain's tools are *called* in front of this engine.
   *
   * `mcp__brain__` for the Claude CLI, which namespaces MCP tools that way, and empty for the
   * other two: Codex calls them by their bare names and an API engine is handed the bare names
   * by us. The prompt hardcoded the Claude spelling and told every engine that "everything you
   * do runs through the mcp__brain__* tools" — a sentence that, on Codex, names a set of tools
   * it cannot see. It still found `search_notes`, because a search tool is recognisable from its
   * description alone; what it did not do was the thing the prompt has to *push* it into, like
   * answering through `render_ui` instead of prose. An instruction to call a tool that is not in
   * the list is an instruction the model has every reason to skip.
   */
  toolPrefix: string
  /**
   * Tools can arrive on demand rather than all at once, and there is a way to ask for them.
   *
   * Claude Code only. The prompt told every engine that a missing tool could be loaded with a
   * `ToolSearch` call — a mechanism the other two do not have — which is worse than useless: it
   * implies the tool list on screen may be incomplete and offers a remedy that does nothing.
   */
  deferredTools: boolean
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
  if (capabilities.builtInTools && !capabilities.sandboxed) {
    // Said first among the shell-related notes, because it is the one that is a decision rather
    // than a difference: this engine can reach the whole machine while a turn is running.
    notes.push(
      'Not sandboxed: this engine can run commands and edit files anywhere on this computer, not just in your vault. Its CLI cancels every tool call unless the sandbox is turned off, so that is the trade it comes with.'
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

/**
 * Ask for token counts on a streamed answer, in the provider's spelling.
 *
 * A patch like `reasoningPatch`, and for the same reason: two wire formats for one idea, neither
 * of which errors when it is the wrong one. Nothing here is optional in practice — without it a
 * streamed turn reports no usage at all, and the turn meter, the daily spend total and the
 * per-turn cost readout are all downstream of numbers that never arrive.
 */
export function usagePatch(dialect: UsageDialect | undefined): Record<string, unknown> {
  switch (dialect ?? 'stream_options') {
    case 'stream_options':
      return { stream_options: { include_usage: true } }
    case 'openrouter':
      return { usage: { include: true } }
    case 'none':
      return {}
  }
}

/**
 * What a turn cost, from its token counts and the model's published prices.
 *
 * The chat-completions response does not price the call — only OpenRouter will, and only if
 * asked — so this is the app's own arithmetic against the catalogue. It matters more than it
 * looks: `costUsd` is what the daily spend cap counts, so while this returned zero the panel's
 * promise that "the app's spend caps are enforced while it is selected" was false for every
 * metered provider. Null when the provider publishes no price, which is honest — a cap cannot
 * be enforced against a number nobody has.
 */
export function costOf(
  usage: { inputTokens: number; outputTokens: number },
  prices: { promptPrice: number | null; completionPrice: number | null }
): number | null {
  if (prices.promptPrice === null && prices.completionPrice === null) return null
  // Prices are per million tokens, which is how every provider quotes them and how the picker
  // shows them.
  const input = ((prices.promptPrice ?? 0) * usage.inputTokens) / 1_000_000
  const output = ((prices.completionPrice ?? 0) * usage.outputTokens) / 1_000_000
  return input + output
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

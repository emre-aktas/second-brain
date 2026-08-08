import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EngineCapabilities, ModelInfo } from '@shared/engines'
import { providerById } from '@shared/engines'
import type { Settings } from '@shared/types'
import { ClaudeProcess, resolveClaudeBinary } from '../claude'
import type { AgentEngine, EngineEventSink, EngineOptions } from '../engine'
import { ApiEngine } from './openai'
import { CodexEngine } from './codex'
import { cachedModel, fetchModels } from './catalogue'
import { codexModels, codexConfigDefaults } from './codexCatalogue'
import { createLogger } from '../../logger'

const log = createLogger('engine:factory')

/**
 * Choosing the engine, and saying what it can do.
 *
 * One place, because the alternative is every caller deciding for itself and the three engines
 * drifting apart in what they claim. `capabilitiesFor` is the whole of the app's knowledge
 * about the differences, and everything downstream — the effort selector, the usage windows,
 * the spend caps, the warning about connectors, the agent's own prompt — reads it rather than
 * assuming the answer is "Claude CLI, yes".
 */

/** Where the Codex CLI lives, if it does. Cached, like `resolveClaudeBinary`. */
let codexBinary: string | null | undefined

export function resolveCodexBinary(): string | null {
  if (codexBinary !== undefined) return codexBinary

  const onWindows = process.platform === 'win32'

  /*
   * PATH first, like `resolveClaudeBinary`, and null when it is genuinely absent.
   *
   * This used to fall back to the bare name `codex` on the theory that PATH would sort it out —
   * which meant it never returned null, so `installed` was always true and readiness could never
   * say "not installed". A machine without the CLI got a spawn ENOENT inside a turn instead of a
   * sentence before it.
   */
  const fromPath = (): string | null => {
    try {
      const probe = spawnSync(onWindows ? 'where' : 'which', ['codex'], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true
      })
      const first = probe.stdout?.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      return first && existsSync(first) ? first : null
    } catch {
      return null
    }
  }

  const candidates = onWindows
    ? [
        join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        join(process.env['APPDATA'] ?? '', 'npm', 'codex.cmd')
      ]
    : [
        '/usr/local/bin/codex',
        '/opt/homebrew/bin/codex',
        join(homedir(), '.local', 'bin', 'codex')
      ]

  codexBinary = fromPath() ?? candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
  if (codexBinary) log.info(`using codex at ${codexBinary}`)
  else log.warn('codex CLI not found')

  return codexBinary
}

/** Reset for a probe, and for a user who installs the CLI without restarting the app. */
export function forgetCodexBinary(): void {
  codexBinary = undefined
}

/* ------------------------------------------------------------- capabilities */

/**
 * What the selected engine can do, given the model it settled on.
 *
 * `model` is passed in rather than read from settings because a saved tool and a scheduled task
 * can each pin their own, and the capabilities of a turn are the capabilities of *that* model —
 * a provider whose flagship reasons and whose cheap model does not is the normal case, not the
 * exception.
 */
export function capabilitiesFor(input: {
  providerId: string
  model: string
  /** From the provider's own catalogue, when it has been read. */
  info?: ModelInfo | null
}): EngineCapabilities {
  const provider = providerById(input.providerId) ?? providerById('claude-cli')!
  const cli = provider.engine !== 'openai-compatible'

  return {
    engine: provider.engine,
    providerId: provider.id,
    model: input.model,
    // A CLI is a whole agent and brings its own shell and file tools. An API model has only
    // what we hand it, which is the brain's tools and nothing else.
    builtInTools: cli,
    // Both CLIs keep the conversation and can resume it by id. An API provider keeps nothing,
    // so the app replays its own history — which is also why switching engines mid-chat works.
    serverSideSessions: cli,
    // Codex reports `agent_message` on completion rather than token by token.
    streamsText: provider.engine !== 'codex-cli',
    reasoning:
      provider.reasoning !== 'none' && (input.info ? input.info.supportsReasoning : true),
    // The one capability whose absence breaks the app rather than reducing it: without tool
    // calling the agent cannot read or write a single note.
    toolCalling: input.info ? input.info.supportsTools : true,
    // The user's own MCP connectors are configured against the CLI's account, not ours.
    accountConnectors: cli,
    /*
     * Only Claude's CLI is confined.
     *
     * Codex has to be launched with `--dangerously-bypass-approvals-and-sandbox` or it cancels
     * every MCP tool call, and that flag takes the sandbox with the prompt. An API engine has no
     * shell to confine at all, so the question does not arise — `builtInTools` is what
     * distinguishes those two cases, and `capabilityNotes` only raises this where both are true.
     */
    sandboxed: provider.engine === 'claude-cli',
    /*
     * Only Claude namespaces the brain's tools, and only Claude can fetch one on demand.
     *
     * Both were written into the prompt as facts about the world rather than about one engine,
     * so Codex and every API model were told to call `mcp__brain__render_ui` — a name that does
     * not exist for them — and to load a missing tool with `ToolSearch`, which they do not have.
     */
    toolPrefix: provider.engine === 'claude-cli' ? 'mcp__brain__' : '',
    deferredTools: provider.engine === 'claude-cli',
    metered: provider.metered,
    // `claude -p /usage` is the only source for plan windows, and it only knows about Claude.
    usageWindows: provider.engine === 'claude-cli'
  }
}

/* ------------------------------------------------------------------ making */

export interface EngineFactoryDeps {
  settings: Settings
  /** Reads a key out of the vault. Never the settings file. */
  secret: (ref: string) => string | undefined
  /** The model this particular turn should use, after tool and task overrides. */
  model: string
}

/** The base URL in force for a provider, after any override the user set. */
export function baseUrlFor(settings: Settings, providerId: string): string {
  const provider = providerById(providerId)
  return settings.engine.baseUrls[providerId] || provider?.baseUrl || ''
}

/** The model in force for a provider, or empty when the user has not chosen one yet. */
export function modelFor(settings: Settings, providerId: string): string {
  return settings.engine.models[providerId] ?? ''
}

/**
 * How hard the selected engine should think, in that engine's own words.
 *
 * Claude keeps reading `settings.effort`, because that is the vocabulary its CLI takes and the
 * setting people have already tuned. Every other provider gets its own entry, and empty is a
 * real answer: for Codex it means "the level in your own config", which is both correct and the
 * one value that cannot be rejected.
 */
export function effortFor(settings: Settings, providerId: string): string {
  if (providerId === 'claude-cli') return settings.effort
  return settings.engine.efforts[providerId] ?? ''
}

/**
 * Whether the selected engine could run a turn right now, and why not.
 *
 * Asked before a turn is attempted, so an unconfigured engine produces a sentence the user can
 * act on rather than a spawn failure or a 401 halfway through an answer they were waiting for.
 */
export function engineReadiness(deps: EngineFactoryDeps): { ok: boolean; reason: string | null } {
  const providerId = deps.settings.engine.providerId
  const provider = providerById(providerId)
  if (!provider) return { ok: false, reason: `Unknown engine "${providerId}".` }

  if (provider.engine === 'claude-cli') {
    return resolveClaudeBinary()
      ? { ok: true, reason: null }
      : { ok: false, reason: 'The Claude CLI could not be found. Install Claude Code and sign in.' }
  }

  if (provider.engine === 'codex-cli') {
    if (!resolveCodexBinary()) {
      return { ok: false, reason: 'The Codex CLI could not be found. Install it and sign in.' }
    }
    /*
     * No model is not a blocker here, unlike an API provider: an empty `-m` is omitted, and
     * Codex then uses the model in its own config — which is a real, working answer rather
     * than a missing one.
     */
    return { ok: true, reason: null }
  }

  const baseUrl = baseUrlFor(deps.settings, providerId)
  if (!baseUrl) return { ok: false, reason: `${provider.label} needs a base URL.` }
  if (provider.needsKey && !deps.secret(provider.secretRef)) {
    return { ok: false, reason: `${provider.label} needs an API key. Add it in the Engine tab.` }
  }
  if (!deps.model) return { ok: false, reason: `Choose a model for ${provider.label} first.` }

  return { ok: true, reason: null }
}

/**
 * Build the engine for one conversation.
 *
 * The Claude branch returns the class that has been doing this all along, unchanged — which is
 * the point of shaping the interface around it. A regression in the engine everyone is actually
 * using would be the worst possible cost of adding two more.
 */
export function createEngine(
  deps: EngineFactoryDeps,
  options: EngineOptions,
  onEvent: EngineEventSink
): AgentEngine {
  const providerId = deps.settings.engine.providerId
  const provider = providerById(providerId) ?? providerById('claude-cli')!

  /*
   * What the provider said about this model, when the catalogue has already been read.
   *
   * Consulted, never fetched: this runs mid-turn and synchronously, so a turn must not wait on a
   * model list. Two things depend on it and both degrade to the old behaviour without it — the
   * capabilities fall back to optimistic, and the turn's cost falls back to unknown. It was
   * omitted entirely before, which meant a model the catalogue had explicitly marked as unable to
   * call tools was still described to the agent as if it could.
   */
  const info =
    provider.engine === 'openai-compatible'
      ? cachedModel(baseUrlFor(deps.settings, provider.id), deps.model)
      : null

  const capabilities = capabilitiesFor({ providerId: provider.id, model: deps.model, info })

  if (provider.engine === 'claude-cli') {
    const binary = resolveClaudeBinary()
    if (!binary) throw new Error('The Claude CLI could not be found.')
    return new ClaudeProcess(
      {
        binary,
        cwd: options.cwd,
        model: options.model,
        capability: options.capability,
        appendSystemPrompt: options.appendSystemPrompt,
        mcpConfig: options.mcpConfig,
        resumeSessionId: options.resumeSessionId ?? null,
        maxBudgetUsd: options.maxBudgetUsd ?? null,
        effort: options.effort ?? null,
        unattended: options.unattended
      },
      onEvent
    )
  }

  if (provider.engine === 'codex-cli') {
    const codex = resolveCodexBinary()
    if (!codex) throw new Error('The Codex CLI could not be found.')
    return new CodexEngine(codex, options, capabilities, onEvent)
  }

  const baseUrl = baseUrlFor(deps.settings, provider.id)
  const apiKey = provider.secretRef ? (deps.secret(provider.secretRef) ?? null) : null
  return new ApiEngine({ provider, baseUrl, apiKey, capabilities, info }, options, onEvent)
}

/**
 * The model list for a provider, with its key from the vault.
 *
 * Here rather than in the panel because the key must not cross into the renderer to be used —
 * the renderer asks for models, the main process holds the credential.
 */
export async function modelsFor(
  settings: Settings,
  providerId: string,
  secret: (ref: string) => string | undefined,
  force = false
): Promise<{
  models: ModelInfo[]
  error: string | null
  configured?: { model: string | null; effort: string | null }
}> {
  const provider = providerById(providerId)
  if (!provider) return { models: [], error: `unknown provider "${providerId}"` }

  if (provider.engine === 'codex-cli') {
    /*
     * Codex publishes its catalogue locally, so it is read rather than guessed.
     *
     * `codex debug models` renders the same list the Codex app's own picker shows, each model
     * with the reasoning levels it actually accepts. That is why this is not a hardcoded array:
     * the answer here today includes a level called `ultra` on a model called `gpt-5.6-sol`,
     * and any list written into this repo would have been wrong the day after it was written.
     */
    const binary = resolveCodexBinary()
    if (!binary) return { models: [], error: 'The Codex CLI could not be found.' }
    // The user's own `config.toml` alongside the catalogue: "use your Codex default" is a real
    // choice, and without knowing which model that resolves to there is no level list to offer
    // for it. `codexConfigDefaults` existed for this and nothing was reading it.
    return { ...(await codexModels(binary, force)), configured: codexConfigDefaults() }
  }

  if (provider.engine !== 'openai-compatible') {
    // The Claude CLI publishes no catalogue; its models are the app's own short list.
    return { models: [], error: null }
  }

  const result = await fetchModels({
    baseUrl: baseUrlFor(settings, providerId),
    apiKey: provider.secretRef ? (secret(provider.secretRef) ?? null) : null,
    headers: provider.headers,
    force
  })
  return { models: result.models, error: result.error }
}

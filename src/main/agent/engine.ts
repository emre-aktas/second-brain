import type { AgentCapability } from '@shared/types'
import type { EngineCapabilities } from '@shared/engines'
import type { ClaudeStreamEvent } from './claude'

/**
 * The seam every model engine sits behind.
 *
 * Deliberately shaped around what `ClaudeProcess` already exposed, so the engine that has been
 * running all along satisfies it without a line of change. That is not laziness — it is the
 * cheapest possible proof that the interface is the right one: an abstraction extracted from a
 * working implementation fits it by construction, where one designed in the abstract usually
 * turns out to want something the real thing cannot give.
 *
 * Everything above this line — message assembly, tool blocks, the usage meter, generated UI,
 * followups, the scheduler, notifications — consumes `ClaudeStreamEvent` and knows nothing
 * about who produced it. So adding an engine is adding a producer, not a rewrite. `manager.ts`
 * is 1060 lines and none of them had to change to support a second one.
 *
 * The name `ClaudeStreamEvent` is kept because renaming it would touch that whole file for no
 * behavioural gain, and its shape was already engine-neutral: a session id, deltas, assistant
 * blocks, tool results, a final result. The one field that *was* Claude-specific — the session
 * id — is renamed at the storage boundary instead, where a Codex thread id sitting in a column
 * called `claude_session_id` would have been a lie a reader could act on.
 */
export interface AgentEngine {
  /** The provider's own id for this conversation, once it has one. */
  readonly engineSessionId: string | null
  readonly alive: boolean
  readonly isBusy: boolean
  /** True when a stop was deliberate, so an exit is not announced as a crash. */
  readonly stopped: boolean
  /** What this engine can and cannot do, for every surface that has to adapt. */
  readonly capabilities: EngineCapabilities

  start(): void
  send(text: string, images?: { mediaType: string; dataBase64: string }[]): void
  interrupt(): void
  stop(): void
}

/**
 * What an engine needs in order to run one conversation.
 *
 * The union of what the three engines want, rather than a per-engine shape, because the
 * manager builds exactly one of these and should not have to know which engine it is feeding.
 * An engine ignores what does not apply to it — `mcpConfig` means nothing to an API model, and
 * `toolHost` means nothing to a CLI that already has the MCP bridge.
 */
export interface EngineOptions {
  cwd: string
  model: string
  capability: AgentCapability
  appendSystemPrompt: string
  /** Full `--mcp-config` payload. Used by the CLI engines to reach the brain tools. */
  mcpConfig: Record<string, unknown>
  /** Resume an existing conversation, for the engines that keep one. */
  resumeSessionId?: string | null
  maxBudgetUsd?: number | null
  effort?: string | null
  unattended: boolean
  /**
   * Where an API engine finds the brain tools.
   *
   * The tool host is already a plain local JSON-RPC server with a bearer token — the MCP
   * bridge is only a thin proxy over it — so an engine that runs its own agentic loop calls
   * the same endpoint the CLI reaches through MCP. One tool implementation, three engines.
   */
  toolEndpoint?: { url: string; token: string } | null
  /** The chat so far, for an engine with no server-side session to resume. */
  history?: { role: 'user' | 'assistant'; text: string }[]
}

export type EngineEventSink = (event: ClaudeStreamEvent) => void

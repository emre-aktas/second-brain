import type { EngineCapabilities, EngineProvider } from '@shared/engines'
import { reasoningPatch } from '@shared/engines'
import type { AgentEffort } from '@shared/types'
import type { ClaudeStreamEvent, ContentBlock } from '../claude'
import type { AgentEngine, EngineEventSink, EngineOptions } from '../engine'
import { createLogger } from '../../logger'

const log = createLogger('engine:api')

/**
 * Any model that speaks the OpenAI chat-completions dialect.
 *
 * One adapter for OpenRouter, DeepSeek, OpenAI, Groq, Together, Ollama, LM Studio and whatever
 * launches next month, because they all answer the same two endpoints. The provider is data —
 * a base URL, a key, a reasoning dialect — not a code path.
 *
 * The difference from the CLI engines is that **the agentic loop is ours**. A CLI is a whole
 * agent: it decides to call a tool, calls it, reads the result and carries on. An API model
 * only ever answers one question — "given this conversation and these tools, what next" — and
 * something has to keep asking. That something is `run` below, and it is the only genuinely
 * new machinery in this file; everything else is translation.
 *
 * The tools it offers are the brain's own, fetched from the tool host. That host has been a
 * plain local JSON-RPC server all along, with MCP as a thin proxy over it, so this engine
 * reaches exactly the same tools the CLI does without MCP being involved at all.
 *
 * No SDK. Node's `fetch` and thirty lines of SSE parsing do the whole job, and the app's build
 * deliberately has no native toolchain and no ESM-only dependencies in `dependencies` — a
 * provider SDK would be the largest new liability in the tree for the least new capability.
 */

/** A hard stop on the loop. A model that keeps calling tools would otherwise never finish. */
const MAX_STEPS = 24

/** Per-request ceiling, so one runaway answer cannot spend the whole budget. */
const MAX_OUTPUT_TOKENS = 8_192

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ApiEngineConfig {
  provider: EngineProvider
  /** Overrides the provider's own, for `custom` and for a self-hosted gateway. */
  baseUrl: string
  apiKey: string | null
  capabilities: EngineCapabilities
}

export class ApiEngine implements AgentEngine {
  private history: ChatMessage[] = []
  private tools: ToolDefinition[] = []
  private controller: AbortController | null = null
  private running = false
  private stoppedValue = false
  private startedValue = false
  /** Banked across the turn's several requests, which is what the user is watching. */
  private turnInput = 0
  private turnOutput = 0

  constructor(
    private readonly config: ApiEngineConfig,
    private readonly options: EngineOptions,
    private readonly onEvent: EngineEventSink
  ) {}

  /**
   * No server-side conversation to point at.
   *
   * A provider that keeps no session has no id to resume, so this stays null and the manager
   * falls back to replaying the chat — which is why `serverSideSessions` is declared false
   * rather than left for a reader to infer from a null.
   */
  get engineSessionId(): string | null {
    return null
  }

  get alive(): boolean {
    return this.startedValue && !this.stoppedValue
  }

  get isBusy(): boolean {
    return this.running
  }

  get stopped(): boolean {
    return this.stoppedValue
  }

  get capabilities(): EngineCapabilities {
    return this.config.capabilities
  }

  start(): void {
    this.startedValue = true
    this.history = [{ role: 'system', content: this.options.appendSystemPrompt }]

    // Replayed, because there is nothing to resume. The manager hands over the chat so far, and
    // this is the whole of what makes switching engines mid-conversation work: the history is
    // the app's, not the provider's.
    for (const turn of this.options.history ?? []) {
      this.history.push({ role: turn.role, content: turn.text })
    }

    this.onEvent({
      type: 'init',
      claudeSessionId: '',
      model: this.config.capabilities.model,
      tools: []
    })
  }

  send(text: string, images: { mediaType: string; dataBase64: string }[] = []): void {
    if (images.length > 0) {
      // Images would need the content-part array form, and the providers disagree about it
      // more than they agree. Said rather than dropped silently.
      log.warn(`${images.length} image(s) dropped: this engine sends text only`)
    }
    this.history.push({ role: 'user', content: text })
    void this.run()
  }

  interrupt(): void {
    this.controller?.abort()
  }

  stop(): void {
    this.stoppedValue = true
    this.controller?.abort()
  }

  /* --------------------------------------------------------------- the loop */

  /**
   * Ask, act, ask again, until the model stops asking for tools.
   *
   * The shape every agentic API loop has, and the two things that make it survivable are the
   * step ceiling and the fact that a tool failure comes back as a *result* rather than as an
   * exception: a model that called a tool wrongly can read the error and correct itself, where
   * a thrown error ends the turn with nothing to show for it.
   */
  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    this.turnInput = 0
    this.turnOutput = 0

    const started = Date.now()
    let steps = 0
    let lastText = ''

    try {
      if (this.tools.length === 0) this.tools = await this.loadTools()

      while (steps < MAX_STEPS) {
        steps++
        const answer = await this.request()

        if (answer.text) {
          lastText = answer.text
          this.onEvent({
            type: 'assistant',
            messageId: answer.id,
            blocks: [{ type: 'text', text: answer.text } as ContentBlock]
          })
        }

        if (answer.toolCalls.length === 0) {
          this.finish(false, started, steps, lastText)
          return
        }

        // The assistant's own turn has to go back in the history with its tool calls attached,
        // or the provider rejects the tool results that follow as unsolicited.
        this.history.push({
          role: 'assistant',
          content: answer.text || null,
          tool_calls: answer.toolCalls
        })

        for (const call of answer.toolCalls) {
          const result = await this.callTool(call)
          this.history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.content
          })
        }
      }

      // Out of steps. Reported as a finished turn carrying what was said, because the
      // alternative — an error — throws away work the user can still use.
      log.warn(`stopped after ${MAX_STEPS} steps; the model kept calling tools`)
      this.finish(false, started, steps, lastText || 'I stopped after too many steps.')
    } catch (err) {
      if (this.stoppedValue || (err as Error)?.name === 'AbortError') {
        this.finish(false, started, steps, lastText)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`request failed: ${message}`)
      this.onEvent({ type: 'stderr', text: message })
      this.finish(true, started, steps, message)
    } finally {
      this.running = false
    }
  }

  private finish(isError: boolean, started: number, steps: number, text: string): void {
    this.onEvent({
      type: 'result',
      isError,
      // The provider does not price the call in the response. Spend is tracked from token
      // counts against the model's own rates instead, which is why `metered` matters.
      costUsd: 0,
      durationMs: Date.now() - started,
      numTurns: steps,
      text,
      subtype: isError ? 'error' : 'success'
    })
  }

  /* ------------------------------------------------------------- one request */

  private async request(): Promise<{ id: string; text: string; toolCalls: ToolCall[] }> {
    const body: Record<string, unknown> = {
      model: this.config.capabilities.model,
      messages: this.history,
      stream: true,
      max_tokens: MAX_OUTPUT_TOKENS
    }

    if (this.tools.length > 0) {
      body['tools'] = this.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      }))
    }

    // Only when the model says it can. Sending a reasoning parameter to a model without it is
    // a 400 on some providers and silently ignored on others, and the second is worse.
    if (this.config.capabilities.reasoning && this.options.effort) {
      Object.assign(
        body,
        reasoningPatch(this.config.provider.reasoning, this.options.effort as AgentEffort)
      )
    }

    this.controller = new AbortController()

    const res = await fetch(`${this.trimmedBase()}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: this.controller.signal
    })

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 500)}` : ''}`)
    }

    return await this.readStream(res.body)
  }

  private trimmedBase(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.config.provider.headers
    }
    if (this.config.apiKey) headers['authorization'] = `Bearer ${this.config.apiKey}`
    return headers
  }

  /**
   * Server-sent events into one answer.
   *
   * Tool call arguments arrive in fragments across many chunks and are assembled by *index*,
   * not by id — the id is only present on the first fragment of each call, and keying on it
   * would start a new call for every chunk after the first.
   */
  private async readStream(
    stream: ReadableStream<Uint8Array>
  ): Promise<{ id: string; text: string; toolCalls: ToolCall[] }> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()

    let buffer = ''
    let text = ''
    let id = ''
    const calls = new Map<number, ToolCall>()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // The last element is whatever arrived without its newline yet.
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue

        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue

        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(payload) as Record<string, unknown>
        } catch {
          // A keep-alive comment or a partial frame. Skipping is right: a malformed chunk
          // must not end a turn that is otherwise working.
          continue
        }

        if (typeof frame['id'] === 'string' && !id) id = frame['id']

        const usage = frame['usage'] as { prompt_tokens?: number; completion_tokens?: number } | undefined
        if (usage) {
          // Assigned, not added: providers send a running total for the message in flight, so
          // adding on every frame multiplies it by the number of frames.
          this.turnInput = usage.prompt_tokens ?? this.turnInput
          this.turnOutput = usage.completion_tokens ?? this.turnOutput
          this.onEvent({
            type: 'usage',
            inputTokens: this.turnInput,
            outputTokens: this.turnOutput
          })
        }

        const choice = (frame['choices'] as { delta?: Record<string, unknown> }[] | undefined)?.[0]
        const delta = choice?.delta
        if (!delta) continue

        if (typeof delta['content'] === 'string' && delta['content']) {
          text += delta['content']
          this.onEvent({ type: 'text-delta', text: delta['content'] })
        }

        // Reasoning comes back under two names depending on the provider — OpenRouter's
        // `reasoning`, DeepSeek's `reasoning_content` — and both are the same idea.
        const thinking =
          (typeof delta['reasoning'] === 'string' ? delta['reasoning'] : null) ??
          (typeof delta['reasoning_content'] === 'string' ? delta['reasoning_content'] : null)
        if (thinking) this.onEvent({ type: 'thinking-delta', text: thinking })

        for (const fragment of (delta['tool_calls'] as
          | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
          | undefined) ?? []) {
          const index = fragment.index ?? 0
          const existing = calls.get(index) ?? {
            id: fragment.id ?? `call_${index}`,
            type: 'function' as const,
            function: { name: '', arguments: '' }
          }
          if (fragment.id) existing.id = fragment.id
          if (fragment.function?.name) existing.function.name = fragment.function.name
          if (fragment.function?.arguments) existing.function.arguments += fragment.function.arguments
          calls.set(index, existing)
        }
      }
    }

    return { id: id || `msg_${Date.now()}`, text, toolCalls: [...calls.values()] }
  }

  /* ------------------------------------------------------------------ tools */

  private async loadTools(): Promise<ToolDefinition[]> {
    const endpoint = this.options.toolEndpoint
    if (!endpoint) {
      log.warn('no tool endpoint: this engine will run without access to the vault')
      return []
    }

    try {
      const res = await fetch(`${endpoint.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ op: 'list' })
      })
      const body = (await res.json()) as { tools?: ToolDefinition[] }
      const tools = body.tools ?? []
      log.info(`${tools.length} brain tool(s) offered to ${this.config.capabilities.model}`)
      return tools
    } catch (err) {
      log.warn('could not read the tool list; continuing without tools', err)
      return []
    }
  }

  /**
   * Run one tool call and report it the way the rest of the app already understands.
   *
   * `tool-result` carries the same shape the CLI produces, so the transcript, the activity
   * feed and the graph's live wiring all light up for an API engine exactly as they do for
   * the CLI — without any of them knowing an engine changed.
   */
  private async callTool(call: ToolCall): Promise<{ content: string; isError: boolean }> {
    const endpoint = this.options.toolEndpoint
    let args: Record<string, unknown> = {}
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
    } catch {
      const message = `arguments were not valid JSON: ${call.function.arguments.slice(0, 200)}`
      this.onEvent({ type: 'tool-result', toolUseId: call.id, content: message, isError: true })
      return { content: message, isError: true }
    }

    this.onEvent({
      type: 'assistant',
      messageId: null,
      blocks: [
        { type: 'tool_use', id: call.id, name: call.function.name, input: args } as ContentBlock
      ]
    })

    if (!endpoint) {
      const message = 'no tools are available to this engine'
      this.onEvent({ type: 'tool-result', toolUseId: call.id, content: message, isError: true })
      return { content: message, isError: true }
    }

    try {
      const res = await fetch(`${endpoint.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ op: 'call', name: call.function.name, args })
      })
      const body = (await res.json()) as { content?: string; isError?: boolean }
      const content = body.content ?? ''
      const isError = body.isError === true
      this.onEvent({ type: 'tool-result', toolUseId: call.id, content, isError })
      return { content, isError }
    } catch (err) {
      // Back as a result, not as a throw: the model can read this and try something else.
      const message = `tool call failed: ${err instanceof Error ? err.message : String(err)}`
      this.onEvent({ type: 'tool-result', toolUseId: call.id, content: message, isError: true })
      return { content: message, isError: true }
    }
  }
}

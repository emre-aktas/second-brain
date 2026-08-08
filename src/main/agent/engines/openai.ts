import type { EngineCapabilities, EngineProvider, ModelInfo } from '@shared/engines'
import { costOf, reasoningPatch, usagePatch } from '@shared/engines'
import type { AgentEffort } from '@shared/types'
import type { ClaudeStreamEvent, ContentBlock } from '../claude'
import type { AgentEngine, EngineEventSink, EngineOptions } from '../engine'
import { deniedBrainTools } from '../prompt'
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

/**
 * Per-request ceiling, so one runaway answer cannot spend the whole budget.
 *
 * Generous on purpose. On a reasoning model the cap covers the thinking as well as the answer,
 * so the old 8k could be spent entirely on reasoning and return an empty message — a turn that
 * cost real money and produced nothing, with no error anywhere to explain it. A ceiling exists
 * to stop a runaway, not to shape an answer, and at this height only a runaway meets it.
 */
const MAX_OUTPUT_TOKENS = 32_768

/**
 * Parameters that are ours rather than the user's, and can therefore be dropped.
 *
 * Providers disagree about all four and the disagreement surfaces as a 400 naming the field —
 * which is recoverable, because none of them changes the *answer*: a ceiling, a usage flag and a
 * thinking level. `custom` points anywhere and new models reject old spellings on their own
 * schedule, so declaring the dialect per provider gets it right for the ones we know and this
 * gets it right for the ones we do not. The user's prompt is never retried away.
 */
const OPTIONAL_PARAMS = [
  'max_tokens',
  'max_completion_tokens',
  'stream_options',
  'reasoning_effort',
  'reasoning',
  'thinking'
]

/** A content part, for the providers that take images. Plain text stays a plain string. */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
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

/** What one tool call produced. Images are separated out because the wire has nowhere for them. */
interface ToolOutcome {
  content: string
  isError: boolean
  images: { data: string; mimeType: string }[]
}

export interface ApiEngineConfig {
  provider: EngineProvider
  /** Overrides the provider's own, for `custom` and for a self-hosted gateway. */
  baseUrl: string
  apiKey: string | null
  capabilities: EngineCapabilities
  /**
   * What the catalogue says about this model, when it has been read.
   *
   * Carried for its prices, which are the only way a turn on a metered provider can be costed
   * at all — the chat-completions response does not price the call. Null is normal and means
   * the spend is reported as unknown rather than as zero.
   */
  info?: ModelInfo | null
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
  /**
   * Parameters this provider has rejected by name, so they are not sent again.
   *
   * Per instance rather than per request: having learnt that a model will not take
   * `max_completion_tokens`, sending it on every subsequent request would mean paying for the
   * discovery once per turn for the life of the conversation.
   */
  private refused = new Set<string>()
  /**
   * A turn asked for while one was running.
   *
   * Dropped silently before, which is the worst of the three options: the manager has already
   * persisted the user's message and put the chat into `thinking`, so a dropped send leaves a
   * conversation that never answers and never errors. Queued, it answers late; that is a
   * visible, ordinary delay.
   */
  private queued: { text: string; images: { mediaType: string; dataBase64: string }[] } | null = null

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
    if (this.running) {
      // One deep, and the newer one wins. Two turns queued behind a slow one is a person
      // pressing send twice, not two questions.
      this.queued = { text, images }
      log.info('a turn is running; the next one is queued')
      return
    }
    this.history.push({ role: 'user', content: this.userContent(text, images) })
    void this.run()
  }

  /**
   * The user's turn, as text or as content parts.
   *
   * A plain string whenever there are no images, because that is what every provider accepts
   * and the array form is what the strict ones are fussy about. Images were dropped with a log
   * line before — but the composer takes screenshots and pastes, so "the model ignored my
   * screenshot" was a working feature quietly not working, and the data-URI content part is
   * what OpenAI, OpenRouter and every vision-capable server in between actually read.
   */
  private userContent(
    text: string,
    images: { mediaType: string; dataBase64: string }[]
  ): string | ContentPart[] {
    if (images.length === 0) return text
    return [
      { type: 'text', text },
      ...images.map(
        (image): ContentPart => ({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` }
        })
      )
    ]
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
          /*
           * An answer with nothing in it is a failure, and it has to be said.
           *
           * Two ways to get here and both were reported as a successful empty message: the
           * ceiling was reached before the model wrote anything — which a reasoning model can
           * do by thinking through the whole allowance — or the provider streamed a stop with
           * no content. Either way the user sees a blank reply, having been charged, with
           * nothing to act on. `finish_reason` is what tells them apart.
           */
          if (!lastText.trim()) {
            const why =
              answer.finishReason === 'length'
                ? `The model used its entire ${MAX_OUTPUT_TOKENS.toLocaleString()}-token allowance without finishing an answer. A model that thinks less, or a shorter question, will get through.`
                : answer.finishReason === 'content_filter'
                  ? 'The provider filtered the answer before it reached this app.'
                  : `${this.config.capabilities.model} returned an empty answer.`
            log.warn(`empty answer (finish_reason: ${answer.finishReason ?? 'none'})`)
            this.finish(true, started, steps, why)
            return
          }
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

        /*
         * Every tool result first, then any pictures they produced.
         *
         * The order is load-bearing. A provider validates that each `tool_calls` entry is
         * answered by a `tool` message before anything else follows, so a user message slipped
         * in between them is a 400 on the *next* request — and the `tool` role carries text
         * only, which is why an image has to become a user message at all.
         */
        const pictures: { data: string; mimeType: string }[] = []
        for (const call of answer.toolCalls) {
          const result = await this.callTool(call)
          this.history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.content
          })
          pictures.push(...result.images)
        }

        if (pictures.length > 0) {
          // The tool that returns images is the one that renders an interface the agent just
          // wrote, so this is the difference between it looking at its own work and describing
          // it blind.
          this.history.push({
            role: 'user',
            content: [
              { type: 'text', text: `(${pictures.length} image(s) returned by the tools above)` },
              ...pictures.map(
                (image): ContentPart => ({
                  type: 'image_url',
                  image_url: { url: `data:${image.mimeType};base64,${image.data}` }
                })
              )
            ]
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
      // A turn that arrived while this one was working. Started here rather than in `send`
      // because this is the only point at which the loop is genuinely free.
      const next = this.queued
      if (next && !this.stoppedValue) {
        this.queued = null
        this.history.push({ role: 'user', content: this.userContent(next.text, next.images) })
        void this.run()
      }
    }
  }

  private finish(isError: boolean, started: number, steps: number, text: string): void {
    this.onEvent({
      type: 'result',
      isError,
      /*
       * Priced here, from tokens, because the provider does not price it in the response.
       *
       * This was hardcoded to zero, and zero is what the daily spend cap counts — so the cap
       * that the Engine tab promises is "enforced while this provider is selected" could never
       * be reached no matter how much was spent. Unknown prices still yield zero, but now that
       * means "the catalogue published no price" rather than "no arithmetic was attempted".
       */
      costUsd:
        costOf(
          { inputTokens: this.turnInput, outputTokens: this.turnOutput },
          {
            promptPrice: this.config.info?.promptPrice ?? null,
            completionPrice: this.config.info?.completionPrice ?? null
          }
        ) ?? 0,
      durationMs: Date.now() - started,
      numTurns: steps,
      text,
      subtype: isError ? 'error' : 'success'
    })
  }

  /* ------------------------------------------------------------- one request */

  /** The request body, minus anything this provider has already rejected by name. */
  private buildBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.capabilities.model,
      messages: this.history,
      stream: true,
      // OpenAI's current models reject `max_tokens` and want `max_completion_tokens`; most
      // others still want the old name. Declared per provider rather than guessed.
      [this.config.provider.maxTokens ?? 'max_tokens']: MAX_OUTPUT_TOKENS
    }

    /*
     * Ask for the token counts, in this provider's spelling.
     *
     * Nothing reports usage on a streamed response unless asked, so without this every turn on
     * every real provider reported zero tokens — the turn meter, the cost readout and the daily
     * spend total all read from numbers that never arrived. The fake provider in the probe
     * volunteered them, which is exactly why the gap survived being tested.
     */
    Object.assign(body, usagePatch(this.config.provider.usage))

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

    for (const name of this.refused) delete body[name]
    return body
  }

  private async request(): Promise<{
    id: string
    text: string
    toolCalls: ToolCall[]
    finishReason: string | null
  }> {
    const attempt = async (): Promise<Response> => {
      this.controller = new AbortController()
      return await fetch(`${this.trimmedBase()}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildBody()),
        signal: this.controller.signal
      })
    }

    let res = await attempt()

    if (!res.ok) {
      const detail = await res.text().catch(() => '')

      /*
       * A 400 that names a parameter we chose to send, dropped and retried once.
       *
       * Only the parameters in `OPTIONAL_PARAMS` qualify, and none of them changes the answer —
       * a length ceiling, a usage flag, a thinking level. The alternative is what happened
       * before: the whole turn died on a field the user never chose, with a message about
       * `max_tokens` in front of someone who had only asked a question. `custom` can point at
       * anything and new models retire old spellings on their own schedule, so being able to
       * learn one is worth more than being right about all of them in advance.
       */
      const offender =
        res.status === 400 || res.status === 422
          ? OPTIONAL_PARAMS.find(
              (name) => !this.refused.has(name) && detail.includes(name) && name in this.buildBody()
            )
          : undefined

      if (offender) {
        log.warn(`${this.config.provider.label} rejected "${offender}"; retrying without it`)
        this.refused.add(offender)
        res = await attempt()
      }

      if (!res.ok) {
        const body = res.bodyUsed ? detail : await res.text().catch(() => detail)
        throw new Error(
          `HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`
        )
      }
    }

    if (!res.body) throw new Error(`${this.config.provider.label} sent no response body.`)
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
  ): Promise<{ id: string; text: string; toolCalls: ToolCall[]; finishReason: string | null }> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()

    let buffer = ''
    let text = ''
    let id = ''
    let finishReason: string | null = null
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

        const usage = frame['usage'] as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined
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

        const choice = (
          frame['choices'] as
            | { delta?: Record<string, unknown>; finish_reason?: string | null }[]
            | undefined
        )?.[0]
        // Why the model stopped, which is the only thing that distinguishes "it had nothing to
        // say" from "it ran out of room mid-sentence". Both arrive as an empty answer.
        if (choice?.finish_reason) finishReason = choice.finish_reason

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

    return { id: id || `msg_${Date.now()}`, text, toolCalls: [...calls.values()], finishReason }
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

      /*
       * The capability tier, enforced.
       *
       * The CLI engines get theirs at spawn through `--disallowedTools`; this engine builds its
       * own tool list and so had no tier at all — a read-only chat was offered `trash_note` and
       * would have used it, which is the app's central promise about that tier being simply
       * absent on two of its three engines. Withheld rather than refused on call, so the model
       * never spends a step finding out.
       */
      const denied = new Set(deniedBrainTools(this.options.capability))
      const all = body.tools ?? []
      const tools = all.filter((tool) => !denied.has(tool.name))

      if (tools.length < all.length) {
        log.info(`${all.length - tools.length} tool(s) withheld at ${this.options.capability}`)
      }
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
  private async callTool(call: ToolCall): Promise<ToolOutcome> {
    const endpoint = this.options.toolEndpoint
    let args: Record<string, unknown> = {}
    try {
      args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
    } catch {
      const message = `arguments were not valid JSON: ${call.function.arguments.slice(0, 200)}`
      this.onEvent({ type: 'tool-result', toolUseId: call.id, content: message, isError: true })
      return { content: message, isError: true, images: [] }
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
      return { content: message, isError: true, images: [] }
    }

    try {
      const res = await fetch(`${endpoint.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
        /*
         * The session goes with the call, exactly as the MCP bridge sends it.
         *
         * Three tools are about the conversation rather than the vault and all three read it off
         * here: `ask_user`, `render_ui` and `suggest_followups`. Without it they succeeded and
         * did nothing — a question addressed to no session is filtered out of chat and the turn
         * waits on it until the backstop, an interface is rendered into no transcript, and an
         * offer is attached to no reply. Nothing failed, which is why it went unnoticed.
         */
        body: JSON.stringify({
          op: 'call',
          name: call.function.name,
          args,
          sessionId: this.options.sessionId
        })
      })
      const body = (await res.json()) as {
        content?: string
        isError?: boolean
        images?: { data: string; mimeType: string }[]
      }
      const content = body.content ?? ''
      const isError = body.isError === true
      this.onEvent({ type: 'tool-result', toolUseId: call.id, content, isError })

      return { content, isError, images: body.images ?? [] }
    } catch (err) {
      // Back as a result, not as a throw: the model can read this and try something else.
      const message = `tool call failed: ${err instanceof Error ? err.message : String(err)}`
      this.onEvent({ type: 'tool-result', toolUseId: call.id, content: message, isError: true })
      return { content: message, isError: true, images: [] }
    }
  }
}

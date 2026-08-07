import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentCapability } from '@shared/types'
import type { EngineCapabilities } from '@shared/engines'
import type { ClaudeStreamEvent, ContentBlock } from '../claude'
import type { AgentEngine, EngineEventSink, EngineOptions } from '../engine'
import { killTree } from '../../util/kill'
import { createLogger } from '../../logger'

const log = createLogger('engine:codex')

/**
 * OpenAI's Codex CLI as an engine.
 *
 * The closest thing to the Claude CLI in this app: a whole agent with its own sandboxed shell,
 * its own file edits and its own MCP client, driven non-interactively and emitting JSONL. So
 * the work here is translation, not orchestration — `codex exec --json` produces a documented
 * event stream and this maps it onto the events the rest of the app already consumes.
 *
 * Two structural differences from the Claude engine, and both matter:
 *
 * **A process per turn, not per conversation.** `claude` is spawned once and fed turns over
 * stdin; `codex exec` runs one turn and exits. Continuity comes from `codex exec resume
 * <thread_id>` instead, with the id taken from the `thread.started` event of the first run. So
 * `alive` here means "configured", not "a process is up".
 *
 * **Text arrives whole.** Codex reports `agent_message` on completion rather than token by
 * token, so nothing streams into the transcript mid-answer. That is declared as
 * `streamsText: false` rather than hidden: the turn header's elapsed counter is what keeps a
 * long answer from reading as a hang, and it is already there for exactly this reason.
 *
 * The brain's tools reach it through the same MCP bridge the Claude engine uses, injected with
 * `-c mcp_servers.<name>=...` per invocation. Per invocation deliberately: writing to
 * `~/.codex/config.toml` would change the user's own Codex setup outside this app, which is
 * not ours to touch.
 */
/**
 * A failure the user can act on, where Codex gives one they cannot.
 *
 * An expired ChatGPT session is by far the most common way this engine fails, and Codex
 * reports it as "your refresh token was already used" — true, and useless to anyone who did
 * not write an OAuth client. Worse, `codex login status` still answers "Logged in using
 * ChatGPT" in this state, so there is no cheaper check that would catch it: the failing turn
 * is the only honest signal, which makes translating it the whole of the fix.
 */
function explainFailure(message: string): string {
  const auth = /refresh token|sign in again|401|unauthorized|token_expired/i.test(message)
  if (!auth) return message
  return `Codex is not signed in. Run \`codex login\` in a terminal, then try again. (${message})`
}

export class CodexEngine implements AgentEngine {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private threadId: string | null = null
  private stoppedValue = false
  private busy = false
  private startedValue = false
  /** Ids of tool-ish items already announced, so `completed` can close the right one. */
  private openItems = new Set<string>()

  constructor(
    private readonly binary: string,
    private readonly options: EngineOptions,
    private readonly capabilitiesValue: EngineCapabilities,
    private readonly onEvent: EngineEventSink
  ) {}

  get engineSessionId(): string | null {
    return this.threadId
  }

  get alive(): boolean {
    return this.startedValue && !this.stoppedValue
  }

  get isBusy(): boolean {
    return this.busy
  }

  get stopped(): boolean {
    return this.stoppedValue
  }

  get capabilities(): EngineCapabilities {
    return this.capabilitiesValue
  }

  start(): void {
    this.startedValue = true
    this.threadId = this.options.resumeSessionId ?? null
    // Nothing is spawned yet — there is no long-lived process to start. Announced anyway so
    // the manager's `init` handling is identical across engines.
    this.onEvent({
      type: 'init',
      claudeSessionId: this.threadId ?? '',
      model: this.capabilitiesValue.model,
      tools: []
    })
  }

  /**
   * How much the sandboxed shell is allowed to do.
   *
   * Mapped from the app's own capability tiers, and deliberately never
   * `--dangerously-bypass-approvals-and-sandbox`. The vault is the working directory, so
   * `workspace-write` is exactly the reach the agent is supposed to have: it can edit notes and
   * run commands inside the sandbox, and cannot touch the rest of the disk. Bypassing would
   * hand an unattended scheduled run full access to the machine to gain nothing.
   */
  private sandboxFor(capability: AgentCapability): string {
    return capability === 'read-only' ? 'read-only' : 'workspace-write'
  }

  private buildArgs(prompt: string): string[] {
    const args = ['exec', '--json', '--skip-git-repo-check']

    // Resuming keeps the thread; the first turn creates one.
    if (this.threadId) args.push('resume', this.threadId)

    /*
     * Only when the user actually chose one.
     *
     * Codex has no catalogue endpoint to read, so there is no list to pick from and no safe
     * default this app could invent — a guessed model name fails at the first turn. Omitting
     * the flag hands the decision to the CLI's own configuration, which is where the user
     * already set it up. Passing a stale `settings.model` instead is what sent `opus` here.
     */
    if (this.capabilitiesValue.model) args.push('-m', this.capabilitiesValue.model)
    args.push('-s', this.sandboxFor(this.options.capability))
    args.push('-C', this.options.cwd)

    /*
     * The brain's tools, injected per invocation as TOML.
     *
     * `-c` takes a dotted path whose value is parsed as TOML, which is the only way to add an
     * MCP server for one run without editing the user's own config file.
     */
    const servers = (this.options.mcpConfig['mcpServers'] ?? {}) as Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string> }
    >
    for (const [name, server] of Object.entries(servers)) {
      if (!server.command) continue
      const parts = [`command=${JSON.stringify(server.command)}`]
      if (server.args?.length) parts.push(`args=[${server.args.map((a) => JSON.stringify(a)).join(',')}]`)
      if (server.env && Object.keys(server.env).length > 0) {
        const env = Object.entries(server.env)
          .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
          .join(',')
        parts.push(`env={${env}}`)
      }
      args.push('-c', `mcp_servers.${name}={${parts.join(',')}}`)
    }

    /*
     * Only when the user picked one, and always a level this model published.
     *
     * Left empty, Codex uses `model_reasoning_effort` from the user's own config — which is
     * what they set in the Codex app, so the two agree by default instead of this app
     * quietly overriding it with a tier borrowed from a different provider.
     */
    if (this.options.effort) {
      args.push('-c', `model_reasoning_effort=${JSON.stringify(this.options.effort)}`)
    }

    args.push(prompt)
    return args
  }

  send(text: string, images: { mediaType: string; dataBase64: string }[] = []): void {
    if (images.length > 0) log.warn(`${images.length} image(s) dropped: codex exec takes text`)
    if (this.busy) {
      log.warn('a turn is already running; ignoring')
      return
    }

    this.busy = true
    this.buffer = ''
    this.openItems.clear()

    const args = this.buildArgs(text)
    log.info(`codex exec (${this.capabilitiesValue.model}, ${this.sandboxFor(this.options.capability)})`)

    const child = spawn(this.binary, args, {
      cwd: this.options.cwd,
      env: { ...process.env },
      windowsHide: true,
      // POSIX children lead their own group so a negative-pid signal reaches the whole tree.
      detached: process.platform !== 'win32'
    })
    this.child = child

    /*
     * Close stdin at once, or the turn never starts.
     *
     * `codex exec` takes its prompt from stdin when stdin is a pipe, and the default stdio
     * for a spawn is a pipe — so an open, silent stdin is read as "the prompt is still
     * coming" and it waits. The observed symptom is exact: it prints "Reading additional
     * input from stdin..." and the turn sits there, which from the app is indistinguishable
     * from a hang. Ending the stream is what makes the prompt argument the whole prompt.
     */
    child.stdin.end()

    const started = Date.now()
    let lastText = ''
    let inputTokens = 0
    let outputTokens = 0
    let failed = false

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          // Not every line is an event — a warning on stdout would otherwise end the turn.
          continue
        }

        const result = this.handleFrame(frame)
        if (result.text) lastText = result.text
        if (result.inputTokens !== undefined) inputTokens = result.inputTokens
        if (result.outputTokens !== undefined) outputTokens = result.outputTokens
        if (result.failed) failed = true
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.onEvent({ type: 'stderr', text: chunk })
    })

    child.on('error', (err) => {
      this.busy = false
      this.onEvent({ type: 'stderr', text: err.message })
      this.onEvent({
        type: 'result',
        isError: true,
        costUsd: 0,
        durationMs: Date.now() - started,
        numTurns: 1,
        text: err.message,
        subtype: 'error'
      })
    })

    child.on('close', (code) => {
      this.busy = false
      this.child = null

      if (inputTokens || outputTokens) {
        this.onEvent({ type: 'usage', inputTokens, outputTokens })
      }

      // A deliberate stop is not a failure. Windows reports code 1 for a killed child, so
      // without this every interrupt would be announced as a crash.
      const isError = !this.stoppedValue && (failed || (code !== 0 && code !== null))
      this.onEvent({
        type: 'result',
        isError,
        // Codex bills the account it is signed in to and reports no price.
        costUsd: 0,
        durationMs: Date.now() - started,
        numTurns: 1,
        text: lastText,
        subtype: isError ? 'error' : 'success'
      })
    })
  }

  /**
   * One JSONL frame, translated.
   *
   * The item lifecycle is `item.started` → `item.updated` → `item.completed`, but only some
   * item types get all three: `agent_message` and `reasoning` are completed-only, which is why
   * text cannot stream here.
   */
  private handleFrame(frame: Record<string, unknown>): {
    text?: string
    inputTokens?: number
    outputTokens?: number
    failed?: boolean
  } {
    const type = String(frame['type'] ?? '')

    if (type === 'thread.started') {
      const id = typeof frame['thread_id'] === 'string' ? frame['thread_id'] : null
      if (id) {
        this.threadId = id
        this.onEvent({
          type: 'init',
          claudeSessionId: id,
          model: this.capabilitiesValue.model,
          tools: []
        })
      }
      return {}
    }

    if (type === 'turn.failed') {
      const error = frame['error'] as { message?: string } | undefined
      const message = explainFailure(error?.message ?? '')
      if (message) this.onEvent({ type: 'stderr', text: message })
      return { failed: true, text: message }
    }

    if (type === 'turn.completed') {
      const usage = frame['usage'] as
        | { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
        | undefined
      if (!usage) return {}
      // Cached input is still input the request carried, and it is what the footer's totals
      // count, so it is added rather than dropped.
      return {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0
      }
    }

    if (type === 'error') {
      const message = typeof frame['message'] === 'string' ? frame['message'] : ''
      // Stream-level notices, including non-fatal reconnects, arrive under this type. Logged
      // rather than failed: ending a turn on a reconnect notice would be a self-inflicted bug.
      if (message) this.onEvent({ type: 'stderr', text: message })
      return {}
    }

    if (!type.startsWith('item.')) return {}

    const item = frame['item'] as Record<string, unknown> | undefined
    if (!item) return {}

    /*
     * Read under either name.
     *
     * The exec JSONL is not covered by the schema `codex app-server generate-ts` emits, and
     * the binary carries both spellings for different structs, so which one names a thread
     * item cannot be settled without a successful live turn. Accepting both costs one
     * expression; being wrong costs the agent's entire answer, silently.
     */
    const itemType = String(item['type'] ?? item['item_type'] ?? '')
    const itemId = String(item['id'] ?? '')
    const completed = type === 'item.completed'

    switch (itemType) {
      case 'agent_message': {
        if (!completed) return {}
        const text = typeof item['text'] === 'string' ? item['text'] : ''
        if (text) {
          this.onEvent({
            type: 'assistant',
            messageId: itemId || null,
            blocks: [{ type: 'text', text } as ContentBlock]
          })
        }
        return { text }
      }

      case 'reasoning': {
        if (!completed) return {}
        const text = typeof item['text'] === 'string' ? item['text'] : ''
        if (text) this.onEvent({ type: 'thinking-delta', text })
        return {}
      }

      case 'command_execution':
        return this.toolItem(itemId, completed, 'shell', {
          command: item['command'],
          exit_code: item['exit_code']
        }, String(item['aggregated_output'] ?? ''), item['exit_code'] !== 0 && completed)

      case 'mcp_tool_call':
        return this.toolItem(
          itemId,
          completed,
          `${String(item['server'] ?? 'mcp')}.${String(item['tool'] ?? '')}`,
          (item['arguments'] as Record<string, unknown>) ?? {},
          typeof item['result'] === 'string' ? item['result'] : JSON.stringify(item['result'] ?? ''),
          Boolean(item['error'])
        )

      case 'file_change':
        return this.toolItem(
          itemId,
          completed,
          'edit',
          { changes: item['changes'] },
          JSON.stringify(item['changes'] ?? []),
          false
        )

      case 'web_search':
        return this.toolItem(itemId, completed, 'web_search', { query: item['query'] }, '', false)

      default:
        return {}
    }
  }

  /**
   * A Codex item that behaves like a tool call, as a tool call.
   *
   * Emitted as an `assistant` block with a `tool_use` on start and a `tool-result` on
   * completion, which is the shape the transcript, the activity feed and the graph's live
   * wiring already read — so a Codex turn lights the app up exactly as a Claude turn does.
   */
  private toolItem(
    id: string,
    completed: boolean,
    name: string,
    input: unknown,
    result: string,
    isError: boolean
  ): { text?: string } {
    if (!completed) {
      if (id && !this.openItems.has(id)) {
        this.openItems.add(id)
        this.onEvent({
          type: 'assistant',
          messageId: null,
          blocks: [{ type: 'tool_use', id, name, input } as ContentBlock]
        })
      }
      return {}
    }

    // Completed without ever being announced — the completed-only item types land here.
    if (id && !this.openItems.has(id)) {
      this.openItems.add(id)
      this.onEvent({
        type: 'assistant',
        messageId: null,
        blocks: [{ type: 'tool_use', id, name, input } as ContentBlock]
      })
    }

    this.onEvent({
      type: 'tool-result',
      toolUseId: id,
      content: result.slice(0, 24_000),
      isError
    })
    return {}
  }

  interrupt(): void {
    if (this.child) void killTree(this.child)
  }

  stop(): void {
    this.stoppedValue = true
    if (this.child) void killTree(this.child)
    this.child = null
  }
}

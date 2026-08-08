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

/**
 * A value for `-c`, in a form Codex will hand back unchanged.
 *
 * `-c` values are parsed as TOML, and a Windows path in a TOML *basic* string does not survive
 * the trip: `codex mcp get` reads back `C:\tmp\brain-mcp.mjs` as `C:<TAB>mp<BS>rain-mcp.mjs`,
 * because the escapes are processed twice. `JSON.stringify` produces exactly that basic string,
 * so every path this app injected — the Electron binary, the bridge script, an integration's
 * command — arrived mangled, the brain MCP server could not start, and Codex ran with no access
 * to the vault at all. It answered like a stock assistant because that is what it was.
 *
 * A TOML *literal* string does no escape processing in either pass, so it round-trips exactly.
 * Its one limitation is that it cannot contain a single quote — there is no escape for one — so
 * a value that does falls back to a basic string escaped twice, which the same experiment shows
 * arrives intact. `codex.probe.ts` round-trips a path through the real CLI rather than trusting
 * either theory.
 */
function tomlValue(value: string): string {
  // Control characters have no literal-string representation either; a newline in a path or an
  // env value is pathological, but it must not silently produce a broken config.
  if (!value.includes("'") && !/[\u0000-\u001f]/.test(value)) return `'${value}'`
  return JSON.stringify(JSON.stringify(value).slice(1, -1))
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
  /** The app's instructions have gone in. Once per instance — see `promptFor`. */
  private sentInstructions = false

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
   * What still bounds a Codex turn, now that the sandbox does not.
   *
   * Kept as a named thing rather than deleted, because the tier is not meaningless here — it is
   * enforced, just somewhere else. `BRAIN_DENY` runs in our own MCP bridge, so `read-only`
   * genuinely withholds every tool that writes to the vault. What it cannot reach is Codex's own
   * shell and file tools, which the bypass flag frees along with the approval prompt. Reported
   * rather than implied: this is what the log line says, and what the Engine tab says.
   */
  private reachFor(capability: AgentCapability): string {
    return capability === 'read-only' ? 'brain tools read-only, shell unsandboxed' : 'unsandboxed'
  }

  private buildArgs(): string[] {
    const args = ['exec']

    /*
     * `resume` is a subcommand, and it does not take the flags `exec` does.
     *
     * This is the whole of the second-turn bug, and it was invisible from inside the app: a
     * first turn worked, and every turn after it died instantly with `error: unexpected
     * argument '-s' found` and a clap usage dump — so a Codex conversation was exactly one
     * message long, and the message the user got back was the CLI's help text. `codex exec
     * resume --help` lists neither `-s/--sandbox` nor `-C/--cd`; both belong to `exec` alone.
     *
     * `-c` *is* accepted by both, and `sandbox_mode` is the config key behind `-s`, so the
     * sandbox is set that way on every invocation rather than two ways on two paths. The
     * working directory needs no flag at all: the spawn below already runs in it.
     *
     * `--json` and `--skip-git-repo-check` are declared on both, and go after the subcommand so
     * that whether the parent's copies propagate is not something this depends on.
     */
    if (this.threadId) args.push('resume', this.threadId)
    args.push('--json', '--skip-git-repo-check')

    /*
     * The flag whose name is a warning, and the only thing that makes Codex work here at all.
     *
     * `codex exec` cancels *every* MCP tool call. Not ours, not sometimes: the server starts, the
     * tools are listed, the model asks for one, and the call comes back
     * `{"error":{"message":"user cancelled MCP tool call"}}` without ever reaching the bridge.
     * Nobody cancelled anything — exec is non-interactive, an MCP call raises an approval
     * request, there is nobody to answer it, and the denial is reported as a cancellation. It is
     * a known upstream limitation (openai/codex#16685, #24135) and there is no config key for
     * it: `approval_policy` in all five of its values, project `trust_level`, and every
     * `mcp_servers.*` and `tools.*` field this version accepts were each tried against the real
     * CLI and each still cancelled.
     *
     * So the choice is this flag or an engine that cannot read a single note, and the second is
     * not a choice. What it costs is real and is not hidden: it removes the sandbox as well as
     * the prompt, and `-c sandbox_mode` cannot put it back — a turn run with both wrote a file
     * outside its working directory, which is how that was established rather than assumed.
     * `EngineCapabilities.sandboxed` is false for this engine because of it, the Engine tab says
     * so in the capability grid and again in words on the Codex card, and `capabilityNotes`
     * repeats it. The app's own tier gating still holds, because `BRAIN_DENY` is enforced in our
     * bridge rather than by Codex — but that bounds the *brain tools*, not Codex's own shell.
     *
     * `sandbox_mode` is deliberately no longer sent. It was ignored under this flag, and a
     * parameter that looks like it is bounding something while doing nothing is worse than an
     * absent one.
     */
    args.push('--dangerously-bypass-approvals-and-sandbox')

    /*
     * Only when the user actually chose one.
     *
     * Codex has no catalogue endpoint to read, so there is no list to pick from and no safe
     * default this app could invent — a guessed model name fails at the first turn. Omitting
     * the flag hands the decision to the CLI's own configuration, which is where the user
     * already set it up. Passing a stale `settings.model` instead is what sent `opus` here.
     */
    if (this.capabilitiesValue.model) args.push('-m', this.capabilitiesValue.model)

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
      const parts = [`command=${tomlValue(server.command)}`]
      if (server.args?.length) parts.push(`args=[${server.args.map(tomlValue).join(',')}]`)
      if (server.env && Object.keys(server.env).length > 0) {
        const env = Object.entries(server.env)
          .map(([key, value]) => `${tomlValue(key)}=${tomlValue(value)}`)
          .join(',')
        parts.push(`env={${env}}`)
      }
      /*
       * Room to start, because it is not starting alone.
       *
       * Codex merges the servers we inject with the ones in the user's own `config.toml`, and a
       * real machine has several — this one launches pencil, godot, node_repl, figma and notion
       * alongside the brain. A server that misses the default window is dropped silently, and a
       * dropped brain server is indistinguishable from the tools being withheld. The user's own
       * heavy entries already carry `startup_timeout_sec = 120` for the same reason; this is the
       * cheap end of that insurance, and the bridge is a plain node script that normally starts
       * in well under a second.
       */
      parts.push('startup_timeout_sec=30')
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
      args.push('-c', `model_reasoning_effort=${tomlValue(this.options.effort)}`)
    }

    /*
     * The prompt goes in on stdin, not in argv.
     *
     * `codex exec -` reads the prompt from stdin, which is the documented way and here the only
     * possible one: the system prompt alone is around 30,000 characters and Windows caps an
     * entire command line at 32,767 — with the MCP config, the model, the sandbox and the user's
     * own message also on that line. As an argument it would work in testing and fail on a real
     * vault, which is the worst way for a limit to be discovered.
     *
     * This does not weaken the rule that stdin must be closed. It was never "leave stdin alone";
     * it was "an open, silent stdin is read as a prompt still arriving". Writing the prompt and
     * then ending the stream says the opposite, unambiguously.
     */
    args.push('-')
    return args
  }

  /**
   * What actually goes to Codex: the app's instructions, then the turn.
   *
   * Codex was never given `appendSystemPrompt` at all. The manager built it — who the agent is,
   * what the vault contains, which tools exist, what this capability tier forbids — and this
   * engine dropped it on the floor, so Codex answered "who am I?" like a stock assistant while
   * Claude answered it from ninety-six notes. That was not a difference between the models.
   *
   * There is no `--append-system-prompt` here and no config key for one (`instructions`,
   * `user_instructions`, `base_instructions` and `experimental_instructions_file` are all
   * rejected by this version), so the instructions ride in the prompt of the first turn an engine
   * instance runs. Once per instance rather than once per thread: a capability change builds a
   * new engine on the same thread, and a tier the agent has not been told about is the one that
   * matters most.
   */
  private promptFor(text: string): string {
    if (this.sentInstructions || !this.options.appendSystemPrompt) return text
    this.sentInstructions = true
    return [
      '<instructions>',
      this.options.appendSystemPrompt,
      '</instructions>',
      '',
      text
    ].join('\n')
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

    const args = this.buildArgs()
    log.info(`codex exec (${this.capabilitiesValue.model || 'your codex default'}, ${this.reachFor(this.options.capability)})`)

    const child = spawn(this.binary, args, {
      cwd: this.options.cwd,
      env: { ...process.env },
      windowsHide: true,
      // POSIX children lead their own group so a negative-pid signal reaches the whole tree.
      detached: process.platform !== 'win32'
    })
    this.child = child

    /*
     * The prompt, then the end of the stream — and the end is not optional.
     *
     * `codex exec` reads its prompt from stdin, and a stdin left open is read as "the prompt is
     * still coming": it prints "Reading additional input from stdin..." and waits, which from
     * the app is indistinguishable from a hang. Writing the whole prompt and then ending says
     * the opposite unambiguously, and it is what lets a 30,000-character system prompt through
     * a command line Windows caps at 32,767.
     */
    child.stdin.end(this.promptFor(text))

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

      case 'mcp_tool_call': {
        /*
         * The reason a tool call failed, kept rather than thrown away.
         *
         * A failed call carries `result: null` and `error: {message}`, and this used to read
         * only `result` — so `JSON.stringify(null ?? '')` produced the string `""` and the
         * transcript showed eight red rows whose entire content was two quote marks. The one
         * fact that would have explained all of them, "user cancelled MCP tool call", was on
         * the frame the whole time and never left this function.
         */
        const failure = item['error'] as { message?: string } | null | undefined
        const raw = item['result']
        const text = failure?.message
          ? failure.message
          : typeof raw === 'string'
            ? raw
            : raw == null
              ? ''
              : JSON.stringify(raw)

        return this.toolItem(
          itemId,
          completed,
          `${String(item['server'] ?? 'mcp')}.${String(item['tool'] ?? '')}`,
          (item['arguments'] as Record<string, unknown>) ?? {},
          text,
          Boolean(failure)
        )
      }

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

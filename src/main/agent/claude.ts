import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentCapability } from '@shared/types'
import { deniedToolsFor, deniedToolsForUnattended } from './prompt'
import { createLogger } from '../logger'

const log = createLogger('claude')

/* ------------------------------------------------------- binary resolution */

let cachedBinary: string | null | undefined

/**
 * Find the `claude` executable.
 *
 * A packaged app launched from Explorer does not always inherit the shell PATH
 * that installed the CLI, so PATH is only the first guess — the well-known
 * install locations are checked too before giving up.
 */
export function resolveClaudeBinary(override?: string): string | null {
  if (override && existsSync(override)) return override
  if (cachedBinary !== undefined) return cachedBinary

  const onWindows = process.platform === 'win32'

  const fromPath = (): string | null => {
    try {
      const probe = spawnSync(onWindows ? 'where' : 'which', ['claude'], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true
      })
      const first = probe.stdout?.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
      return first && existsSync(first) ? first : null
    } catch {
      return null
    }
  }

  const candidates = onWindows
    ? [
        join(homedir(), '.local', 'bin', 'claude.exe'),
        join(homedir(), '.local', 'bin', 'claude'),
        join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'claude', 'claude.exe'),
        join(process.env['APPDATA'] ?? '', 'npm', 'claude.cmd')
      ]
    : [
        join(homedir(), '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude'
      ]

  cachedBinary = fromPath() ?? candidates.find((c) => c && existsSync(c)) ?? null
  if (cachedBinary) log.info(`using claude at ${cachedBinary}`)
  else log.error('claude CLI not found')

  return cachedBinary
}

/**
 * Run the CLI and collect its output without blocking.
 *
 * Every one of these used to be `spawnSync`, on the main process's only thread.
 * Starting the CLI takes the better part of a second, and while it ran the whole
 * app was frozen: no IPC answered, no agent events processed, windows unable to
 * repaint. Usage refreshed on a 90-second timer, so it froze roughly that often —
 * which is exactly what an occasional, brief hang looks like.
 */
export function runClaude(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (stdout: string, code: number | null): void => {
      if (settled) return
      settled = true
      resolve({ stdout, code })
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(binary, args, {
        windowsHide: true,
        env: opts.env ?? process.env
      }) as ChildProcessWithoutNullStreams
    } catch (err) {
      log.warn(`could not start ${binary} ${args.join(' ')}`, err)
      return finish('', null)
    }

    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    // Drained and ignored: an unread pipe eventually blocks the child.
    child.stderr?.resume()

    const timer = setTimeout(() => {
      child.kill()
      finish(out, null)
    }, opts.timeoutMs ?? 20_000)
    timer.unref?.()

    child.on('error', (err) => {
      clearTimeout(timer)
      log.warn(`${binary} ${args[0] ?? ''} failed`, err)
      finish('', null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(out, code)
    })
  })
}

export async function claudeVersion(binary: string): Promise<string | null> {
  const { stdout } = await runClaude(binary, ['--version'], { timeoutMs: 10_000 })
  return stdout.trim() || null
}

export interface ClaudeAuth {
  loggedIn: boolean
  /** "claude.ai" for a subscription login, "apiKey" when billed per token. */
  authMethod: string | null
  email: string | null
  organisation: string | null
  subscriptionType: string | null
}

export async function claudeAuthStatus(binary: string): Promise<ClaudeAuth | null> {
  const { stdout } = await runClaude(binary, ['auth', 'status'], {
    timeoutMs: 15_000,
    env: subscriptionEnv(process.env)
  })

  try {
    const parsed = JSON.parse(stdout || '{}') as Record<string, unknown>

    return {
      loggedIn: parsed['loggedIn'] === true,
      authMethod: typeof parsed['authMethod'] === 'string' ? parsed['authMethod'] : null,
      email: typeof parsed['email'] === 'string' ? parsed['email'] : null,
      organisation: typeof parsed['orgName'] === 'string' ? parsed['orgName'] : null,
      subscriptionType:
        typeof parsed['subscriptionType'] === 'string' ? parsed['subscriptionType'] : null
    }
  } catch {
    return null
  }
}

/**
 * Variables that would redirect the CLI away from the user's own Claude login.
 *
 * The app is meant to run on the subscription the user already signed in to, so
 * these are stripped rather than forwarded. Otherwise an API key or a custom
 * endpoint present in whatever shell launched the app would silently take over
 * and start billing per token.
 */
const AUTH_OVERRIDE_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'AWS_BEARER_TOKEN_BEDROCK'
] as const

export function subscriptionEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of AUTH_OVERRIDE_VARS) delete env[key]
  return env
}

/* ------------------------------------------------------------------ events */

export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export type ClaudeStreamEvent =
  | {
      type: 'init'
      claudeSessionId: string
      model?: string
      tools?: string[]
      mcpServers?: { name: string; status: string }[]
    }
  | { type: 'text-delta'; text: string }
  /**
   * Tokens spent by the turn so far.
   *
   * Emitted as the CLI reports them, which is often enough to watch tick. Cumulative for
   * the whole turn, not for one request: a turn that uses tools is several requests and the
   * user is watching one answer.
   */
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'thinking-delta'; text: string }
  | { type: 'assistant'; blocks: ContentBlock[]; messageId: string | null }
  | { type: 'tool-result'; toolUseId: string; content: string; isError: boolean }
  | {
      type: 'result'
      isError: boolean
      costUsd: number
      durationMs: number
      numTurns: number
      text: string | null
      subtype: string
    }
  | { type: 'stderr'; text: string }
  | {
      type: 'exit'
      code: number | null
      signal: string | null
      /** A turn was still in flight — something is waiting on an answer that never came. */
      wasBusy: boolean
    }
  | { type: 'parse-error'; line: string }

export interface ClaudeProcessOptions {
  binary: string
  cwd: string
  model: string
  capability: AgentCapability
  appendSystemPrompt: string
  /** Full --mcp-config payload: { mcpServers: { … } }. */
  mcpConfig: Record<string, unknown>
  /** Resume an existing conversation across app restarts. */
  resumeSessionId?: string | null
  /** Hard per-process ceiling; the CLI aborts the turn when it is reached. */
  maxBudgetUsd?: number | null
  /** Thinking budget: low | medium | high | xhigh | max. */
  effort?: string | null
  /**
   * True for a scheduled run, which nobody is watching.
   *
   * Widens the denylist: bypassPermissions pre-approves every tool call, so without this a
   * background check-in reading Slack could also post to it.
   */
  unattended?: boolean
  extraEnv?: Record<string, string>
  /** Appended verbatim; used for diagnostics such as --debug mcp. */
  extraArgs?: string[]
}

/**
 * Drives one long-lived `claude` process in streaming mode.
 *
 * Streaming input keeps a single process per conversation, so context stays warm
 * across turns instead of paying a cold start each time. Output is
 * newline-delimited JSON, buffered here because a single assistant message can
 * exceed one chunk.
 */
export class ClaudeProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private claudeSessionIdValue: string | null = null
  private closed = false
  /** True between sending a turn and receiving its result. */
  private busy = false

  constructor(
    private options: ClaudeProcessOptions,
    private onEvent: (event: ClaudeStreamEvent) => void
  ) {}

  get claudeSessionId(): string | null {
    return this.claudeSessionIdValue
  }

  get alive(): boolean {
    return this.child !== null && !this.closed
  }

  get isBusy(): boolean {
    return this.busy
  }

  private buildArgs(): string[] {
    const { model, capability, appendSystemPrompt, mcpConfig, resumeSessionId } = this.options

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      // stream-json output in print mode requires verbose.
      '--verbose',
      '--model', model,
      // Nothing can answer a permission prompt in this mode, so requests are
      // pre-approved and the capability boundary is drawn by --disallowedTools
      // below instead.
      '--permission-mode', 'bypassPermissions',
      '--append-system-prompt', appendSystemPrompt,
      '--mcp-config', JSON.stringify(mcpConfig)
      // Deliberately NOT --strict-mcp-config: the user's Claude account already
      // has its connectors set up (Gmail, Calendar, Drive, Slack, ClickUp and so
      // on), and excluding them would mean asking them to reconnect everything
      // here. Our own brain server is merged in alongside them.
    ]

    if (this.options.effort) args.push('--effort', this.options.effort)

    const denied = this.options.unattended
      ? deniedToolsForUnattended(capability)
      : deniedToolsFor(capability)
    if (denied.length > 0) args.push('--disallowedTools', denied.join(','))

    // Enforced by the CLI itself, so a runaway turn stops even if the app is
    // not watching.
    const budget = this.options.maxBudgetUsd
    if (budget && budget > 0) args.push('--max-budget-usd', String(budget))

    if (resumeSessionId) args.push('--resume', resumeSessionId)
    if (this.options.extraArgs?.length) args.push(...this.options.extraArgs)

    return args
  }

  start(): void {
    if (this.child) return

    const args = this.buildArgs()
    log.info(`spawning claude (${this.options.capability}, ${this.options.model})`)

    this.child = spawn(this.options.binary, args, {
      cwd: this.options.cwd,
      windowsHide: true,
      env: {
        // Stripped of every Anthropic auth/endpoint override, so the CLI always
        // resolves the user's own signed-in account.
        ...subscriptionEnv(process.env),
        ...this.options.extraEnv,
        // Keep the CLI's own output machine-readable and colour-free.
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        CLAUDE_CODE_ENTRYPOINT: 'second-brain',
        // The ask_user tool deliberately blocks while a question sits in the
        // chat, so the per-tool ceiling has to outlast a person deciding.
        MCP_TOOL_TIMEOUT: '300000',
        MCP_TIMEOUT: '30000'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))

    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) {
        log.debug(`claude stderr: ${text.slice(0, 500)}`)
        this.onEvent({ type: 'stderr', text })
      }
    })

    this.child.on('error', (err) => {
      log.error('claude process error', err)
      this.onEvent({ type: 'stderr', text: err.message })
      this.closed = true
      this.busy = false
    })

    this.child.on('close', (code, signal) => {
      log.info(`claude exited (code ${code}, signal ${signal})`)
      // Read before clearing: whether a turn was in flight is the difference
      // between an idle process going away and one that died owing an answer.
      const wasBusy = this.busy
      this.closed = true
      this.busy = false
      this.child = null
      this.onEvent({ type: 'exit', code, signal, wasBusy })
    })
  }

  /** Queue a user turn. The process stays alive for the next one. */
  send(text: string, images: { mediaType: string; dataBase64: string }[] = []): void {
    if (!this.child) this.start()
    if (!this.child) throw new Error('claude process could not be started')

    // Images come first: the model reads them as context for the text that
    // follows, which is how a "what is wrong with this?" turn should be framed.
    const content: unknown[] = images.map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 }
    }))
    if (text.trim() || content.length === 0) content.push({ type: 'text', text })

    const payload = { type: 'user', message: { role: 'user', content } }

    this.busy = true
    // A new turn starts from zero. Not reset, the counter would carry the previous answer's
    // total and only ever climb for the life of the process.
    this.turnInput = 0
    this.turnOutput = 0
    this.liveInput = 0
    this.liveOutput = 0
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  /** Ask the current turn to stop. */
  interrupt(): void {
    if (!this.child) return
    // No interrupt frame exists for streaming stdin, so end the turn by closing
    // the process; the manager will start a fresh one and resume the session.
    this.stop()
  }

  /**
   * True once this process was deliberately killed.
   *
   * `kill()` is synchronous but `close` is not, so a stopped child still reports an
   * exit a few milliseconds later. Without knowing the kill was intentional, that
   * exit read as a crash: on Windows a killed child reports code 1, which surfaced
   * as "The agent process exited unexpectedly" and dropped the session to idle —
   * while the replacement process was mid-turn.
   */
  get stopped(): boolean {
    return this.stoppedDeliberately
  }

  private stoppedDeliberately = false

  stop(): void {
    this.stoppedDeliberately = true
    if (!this.child) return
    this.closed = true
    try {
      this.child.stdin.end()
    } catch {
      /* already gone */
    }
    this.child.kill()
    this.child = null
    this.busy = false
  }

  /* ------------------------------------------------------------- parsing */

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk

    let newlineAt: number
    while ((newlineAt = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineAt).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineAt + 1)
      if (line) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.onEvent({ type: 'parse-error', line: line.slice(0, 400) })
      return
    }

    const type = message['type']

    if (type === 'system' && message['subtype'] === 'init') {
      const sessionId = message['session_id']
      if (typeof sessionId === 'string') this.claudeSessionIdValue = sessionId

      this.onEvent({
        type: 'init',
        claudeSessionId: typeof sessionId === 'string' ? sessionId : '',
        model: typeof message['model'] === 'string' ? message['model'] : undefined,
        tools: Array.isArray(message['tools']) ? (message['tools'] as string[]) : undefined,
        mcpServers: Array.isArray(message['mcp_servers'])
          ? (message['mcp_servers'] as { name: string; status: string }[])
          : undefined
      })
      return
    }

    if (type === 'stream_event') {
      this.handleStreamEvent(message['event'] as Record<string, unknown> | undefined)
      return
    }

    if (type === 'assistant') {
      const inner = message['message'] as Record<string, unknown> | undefined
      const blocks = Array.isArray(inner?.['content']) ? (inner!['content'] as ContentBlock[]) : []
      this.onEvent({
        type: 'assistant',
        blocks,
        messageId: typeof inner?.['id'] === 'string' ? (inner!['id'] as string) : null
      })
      return
    }

    if (type === 'user') {
      const inner = message['message'] as Record<string, unknown> | undefined
      const blocks = Array.isArray(inner?.['content']) ? (inner!['content'] as ContentBlock[]) : []
      for (const block of blocks) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        this.onEvent({
          type: 'tool-result',
          toolUseId: block.tool_use_id,
          content: flattenToolResult(block.content),
          isError: block.is_error === true
        })
      }
      return
    }

    if (type === 'result') {
      this.busy = false
      const sessionId = message['session_id']
      if (typeof sessionId === 'string') this.claudeSessionIdValue = sessionId

      this.onEvent({
        type: 'result',
        subtype: typeof message['subtype'] === 'string' ? (message['subtype'] as string) : 'unknown',
        isError: message['is_error'] === true,
        costUsd: typeof message['total_cost_usd'] === 'number' ? (message['total_cost_usd'] as number) : 0,
        durationMs: typeof message['duration_ms'] === 'number' ? (message['duration_ms'] as number) : 0,
        numTurns: typeof message['num_turns'] === 'number' ? (message['num_turns'] as number) : 0,
        text: typeof message['result'] === 'string' ? (message['result'] as string) : null
      })
    }
  }

  /**
   * Token totals for the turn.
   *
   * Four numbers rather than two because a turn is a *sequence* of requests — every tool
   * call ends one and begins another — and only the request in flight is still changing.
   * `turn*` is what finished requests spent; `live*` is the current one. Adding the live
   * figure into the total on every delta instead would multiply it by the number of deltas,
   * which is the shape of mistake that makes a counter look plausible and read ten times
   * high.
   */
  private turnInput = 0
  private turnOutput = 0
  private liveInput = 0
  private liveOutput = 0

  private emitUsage(): void {
    this.onEvent({
      type: 'usage',
      inputTokens: this.turnInput + this.liveInput,
      outputTokens: this.turnOutput + this.liveOutput
    })
  }

  private handleStreamEvent(event: Record<string, unknown> | undefined): void {
    if (!event) return

    // A new request within the turn. Bank what the last one spent before reading this one:
    // `message_start` carries the input side, which is final from the outset because the
    // prompt is already known — most of it charged as a cache read.
    if (event['type'] === 'message_start') {
      this.turnInput += this.liveInput
      this.turnOutput += this.liveOutput

      const inner = event['message'] as Record<string, unknown> | undefined
      const usage = inner?.['usage'] as Record<string, unknown> | undefined
      const number = (key: string): number =>
        typeof usage?.[key] === 'number' ? (usage[key] as number) : 0

      // Cache reads and writes are counted. They are tokens the request actually carried,
      // and leaving them out reports a two-hundred-token turn for one that moved a hundred
      // thousand — which is the number the footer's usage windows are built from.
      this.liveInput =
        number('input_tokens') + number('cache_read_input_tokens') + number('cache_creation_input_tokens')
      this.liveOutput = number('output_tokens')
      this.emitUsage()
      return
    }

    // The live one. `usage.output_tokens` here is the running total for *this* message, so
    // it is assigned, never added.
    if (event['type'] === 'message_delta') {
      const usage = event['usage'] as Record<string, unknown> | undefined
      if (typeof usage?.['output_tokens'] === 'number') {
        this.liveOutput = usage['output_tokens'] as number
        this.emitUsage()
      }
      return
    }

    if (event['type'] === 'content_block_delta') {
      const delta = event['delta'] as Record<string, unknown> | undefined
      if (!delta) return

      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        this.onEvent({ type: 'text-delta', text: delta['text'] })
        return
      }
      if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
        this.onEvent({ type: 'thinking-delta', text: delta['thinking'] })
      }
    }
  }
}

/** Tool results arrive as a string or as content blocks; normalise to text. */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content)

  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        const record = part as Record<string, unknown>
        if (typeof record['text'] === 'string') return record['text']
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

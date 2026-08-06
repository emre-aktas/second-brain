import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { DETACH_CHILDREN, killTree } from '../util/kill'
import { createLogger } from '../logger'

const log = createLogger('mcp-client')

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  text: string
  isError: boolean
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'second-brain', version: '0.1.0' }

/**
 * Minimal MCP client used by the app itself.
 *
 * The agent talks to MCP integrations through Claude Code's own client, which is
 * handed the server definitions directly. This client exists for what the app
 * needs independently: testing a connection the user just added, listing a
 * server's tools for the integrations screen, and letting non-agent code (the
 * curator) call a tool. Only the handful of methods needed for that are
 * implemented.
 */
export abstract class McpClient {
  protected nextId = 1
  protected pending = new Map<number, Pending>()
  protected initialized = false

  abstract connect(): Promise<void>
  abstract close(): void
  protected abstract deliver(payload: unknown): void

  protected request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })

      try {
        this.deliver({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  protected notify(method: string, params?: unknown): void {
    this.deliver({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  protected handleMessage(raw: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    const id = message['id']
    if (typeof id !== 'number') return // notification or request from server; ignored

    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)

    if (message['error']) {
      const error = message['error'] as { message?: string; code?: number }
      pending.reject(new Error(error.message ?? `MCP error ${error.code ?? 'unknown'}`))
      return
    }
    pending.resolve(message['result'])
  }

  protected async handshake(): Promise<void> {
    if (this.initialized) return
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    })
    this.notify('notifications/initialized')
    this.initialized = true
  }

  async listTools(): Promise<McpTool[]> {
    await this.handshake()
    const result = await this.request<{ tools?: McpTool[] }>('tools/list')
    return (result?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} }
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.handshake()
    const result = await this.request<{
      content?: { type: string; text?: string }[]
      isError?: boolean
    }>('tools/call', { name, arguments: args }, 120_000)

    const text = (result?.content ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')

    return { text, isError: result?.isError === true }
  }
}

export class McpStdioClient extends McpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>,
    private cwd?: string
  ) {
    super()
  }

  async connect(): Promise<void> {
    if (this.child) return

    this.child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      ...(this.cwd ? { cwd: this.cwd } : {}),
      windowsHide: true,
      // An MCP server is usually `npx something`: a node process that spawns another one.
      // Killing only what we spawned leaves the real server running.
      detached: DETACH_CHILDREN,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let at: number
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).trim()
        this.buffer = this.buffer.slice(at + 1)
        if (line) this.handleMessage(line)
      }
    })

    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) log.debug(`${this.command} stderr: ${text.slice(0, 300)}`)
    })

    this.child.on('close', (code) => {
      this.child = null
      this.initialized = false
      // Fail everything still in flight, or callers would hang forever.
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`the MCP server exited (code ${code})`))
        this.pending.delete(id)
      }
    })

    this.child.on('error', (err) => {
      log.warn(`could not start ${this.command}`, err)
    })

    await this.handshake()
  }

  protected deliver(payload: unknown): void {
    if (!this.child) throw new Error('the MCP server is not running')
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  close(): void {
    killTree(this.child)
    this.child = null
    this.initialized = false
  }
}

export class McpHttpClient extends McpClient {
  private sessionId: string | null = null

  constructor(
    private url: string,
    private headers: Record<string, string> = {}
  ) {
    super()
  }

  async connect(): Promise<void> {
    await this.handshake()
  }

  /**
   * Streamable HTTP is request/response per call, so requests are issued
   * directly here rather than written to a stream. A server may answer with
   * either JSON or an SSE frame; both are accepted.
   */
  protected override request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++
    const body = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }

    return (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()

      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
            ...this.headers
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })

        const returnedSession = res.headers.get('mcp-session-id')
        if (returnedSession) this.sessionId = returnedSession

        const text = await res.text()
        if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`)
        if (!text.trim()) return undefined as T

        const payload = parseJsonOrSse(text)
        if (payload?.['error']) {
          const error = payload['error'] as { message?: string }
          throw new Error(error.message ?? 'MCP error')
        }
        return payload?.['result'] as T
      } finally {
        clearTimeout(timer)
      }
    })()
  }

  protected deliver(): void {
    // Unused: request() performs its own transport.
  }

  protected override notify(method: string, params?: unknown): void {
    void fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.headers
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
    }).catch(() => {
      /* notifications are fire-and-forget */
    })
  }

  close(): void {
    this.sessionId = null
    this.initialized = false
  }
}

/** Accept either a plain JSON body or an SSE frame carrying one. */
function parseJsonOrSse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return null
    }
  }

  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      return JSON.parse(data) as Record<string, unknown>
    } catch {
      /* keep scanning */
    }
  }
  return null
}

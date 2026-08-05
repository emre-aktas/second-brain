import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger'
import { BRIDGE_SCRIPT_SOURCE } from './bridge-script'

const log = createLogger('toolhost')

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Marks tools that change state, so the UI can badge them. */
  mutating?: boolean
}

export interface ToolResult {
  content: string
  isError?: boolean
  /**
   * Images returned alongside the text, as base64. This is what lets the agent
   * look at a tool it just built instead of reasoning about it blind.
   */
  images?: { data: string; mimeType: string }[]
}

export interface ToolCallContext {
  /** Chat session the calling agent belongs to, when known. */
  sessionId: string | null
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCallContext
) => Promise<ToolResult> | ToolResult

export interface RegisteredTool extends ToolDefinition {
  handler: ToolHandler
}

/**
 * Bridges the spawned `claude` process to the application's own capabilities.
 *
 * The agent reaches these tools through a generated stdio MCP server rather than
 * an HTTP MCP endpoint: stdio is the most universally supported transport, and
 * it keeps the wire format we have to get exactly right down to newline-delimited
 * JSON-RPC. Everything past the bridge is this plain localhost JSON API, which
 * we own end to end.
 *
 * The listener binds to 127.0.0.1 on an ephemeral port and requires a per-run
 * bearer token, so nothing outside this app can reach it.
 */
export class ToolHost {
  private server: Server | null = null
  private tools = new Map<string, RegisteredTool>()
  readonly token = randomBytes(32).toString('hex')
  private portValue = 0
  private bridgePathValue = ''

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: RegisteredTool[]): void {
    for (const tool of tools) this.register(tool)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, inputSchema, mutating }) => ({
      name,
      description,
      inputSchema,
      mutating
    }))
  }

  get port(): number {
    return this.portValue
  }

  get bridgePath(): string {
    return this.bridgePathValue
  }

  get url(): string {
    return `http://127.0.0.1:${this.portValue}`
  }

  /**
   * Write the bridge script into userData. Generating it at runtime keeps the
   * packaged build free of extra resource plumbing, and a deleted or stale
   * bridge repairs itself on the next launch.
   */
  writeBridge(userDataDir: string): string {
    const dir = join(userDataDir, 'bridge')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'brain-mcp.mjs')
    writeFileSync(file, BRIDGE_SCRIPT_SOURCE, 'utf8')
    this.bridgePathValue = file
    return file
  }

  async start(userDataDir: string): Promise<void> {
    this.writeBridge(userDataDir)

    await new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => void this.handle(req, res))
      this.server.on('error', reject)
      // Port 0 lets the OS pick; loopback-only so it is unreachable off-machine.
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server?.address()
        this.portValue = typeof address === 'object' && address ? address.port : 0
        log.info(`tool host listening on ${this.url} with ${this.tools.size} tools`)
        resolve()
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store'
      })
      res.end(payload)
    }

    try {
      const auth = req.headers['authorization']
      if (auth !== `Bearer ${this.token}`) {
        send(401, { error: 'unauthorized' })
        return
      }

      if (req.method !== 'POST' || !req.url?.startsWith('/rpc')) {
        send(404, { error: 'not found' })
        return
      }

      const body = await readBody(req)
      const request = JSON.parse(body) as {
        op?: string
        name?: string
        args?: Record<string, unknown>
        sessionId?: string | null
      }

      if (request.op === 'list') {
        send(200, { tools: this.list() })
        return
      }

      if (request.op === 'call') {
        const tool = this.tools.get(request.name ?? '')
        if (!tool) {
          send(200, { content: `Unknown tool: ${request.name}`, isError: true })
          return
        }

        const ctx: ToolCallContext = { sessionId: request.sessionId ?? null }
        try {
          const result = await tool.handler(request.args ?? {}, ctx)
          send(200, result)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn(`tool ${tool.name} failed`, err)
          // Errors go back as tool results, not transport failures, so the agent
          // can read the message and correct itself.
          send(200, { content: `Tool error: ${message}`, isError: true })
        }
        return
      }

      send(400, { error: 'unknown op' })
    } catch (err) {
      log.error('tool host request failed', err)
      send(500, { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

const MAX_BODY_BYTES = 8 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

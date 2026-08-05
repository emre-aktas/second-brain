import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  IntegrationHealth,
  IntegrationManifest,
  IntegrationRecord,
  IntegrationTool
} from '@shared/types'
import type { BrainCore } from '../core'
import type { IntegrationBridge } from '../agent/tools'
import { SecretVault } from './secrets'
import { OAuthManager } from './oauth'
import { McpHttpClient, McpStdioClient, type McpClient } from './mcp-client'
import { RestAdapter, ScriptAdapter, type AdapterResult } from './adapters'
import { validateManifest } from './validate'
import { INTEGRATION_PRESETS } from './presets'
import { createLogger } from '../logger'

const log = createLogger('integrations')

const TOOL_CACHE_TTL_MS = 60_000

interface CachedTools {
  tools: IntegrationTool[]
  at: number
}

/**
 * Owns every connected tool.
 *
 * Five kinds are supported. MCP servers (stdio or HTTP) cover anything that
 * already speaks the protocol. `rest` covers services that do not — including
 * Gmail, via OAuth2 — and is purely declarative, which is what lets the agent
 * add an integration without writing or running any code. `script` is the escape
 * hatch when an API needs real logic, and `webhook` turns inbound payloads into
 * notes.
 */
export class IntegrationRegistry implements IntegrationBridge {
  readonly secrets: SecretVault
  readonly oauth: OAuthManager
  private mcpClients = new Map<string, McpClient>()
  private toolCache = new Map<string, CachedTools>()
  private webhookServer: Server | null = null
  private webhookPort = 0

  constructor(private core: BrainCore) {
    this.secrets = new SecretVault(core.paths.secretsFile)
    this.oauth = new OAuthManager(this.secrets)
  }

  async start(): Promise<void> {
    mkdirSync(this.core.paths.integrationsDir, { recursive: true })
    await this.startWebhookServer()

    const records = this.core.integrations.list()
    log.info(`${records.length} integration(s) registered, ${records.filter((r) => r.manifest.enabled).length} enabled`)
  }

  stop(): void {
    for (const client of this.mcpClients.values()) client.close()
    this.mcpClients.clear()
    this.webhookServer?.close()
    this.webhookServer = null
  }

  /* --------------------------------------------------------------- records */

  listRecords(): IntegrationRecord[] {
    return this.core.integrations.list()
  }

  get webhookBaseUrl(): string {
    return this.webhookPort ? `http://127.0.0.1:${this.webhookPort}/hooks` : ''
  }

  get secretsAreEncrypted(): boolean {
    return this.secrets.secure
  }

  availablePresets(): { id: string; name: string; description: string; icon?: string }[] {
    const installed = new Set(this.listRecords().map((r) => r.manifest.id))
    return INTEGRATION_PRESETS.filter((p) => !installed.has(p.manifest.id)).map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      description: p.manifest.description,
      icon: p.manifest.icon
    }))
  }

  installPreset(presetId: string): IntegrationRecord {
    const preset = INTEGRATION_PRESETS.find((p) => p.manifest.id === presetId)
    if (!preset) throw new Error(`unknown preset "${presetId}"`)

    // Presets arrive disabled: most need a credential before they can work.
    const record = this.core.integrations.upsert({ ...preset.manifest, enabled: false })
    this.core.recordActivity({
      kind: 'integration.added',
      actor: 'user',
      title: `Added ${preset.manifest.name}`,
      detail: { id: preset.manifest.id, source: 'preset' }
    })
    this.core.broadcast('integrations:changed')
    return record
  }

  setEnabled(id: string, enabled: boolean): IntegrationRecord {
    const record = this.core.integrations.get(id)
    if (!record) throw new Error(`no integration "${id}"`)

    this.core.integrations.upsert({ ...record.manifest, enabled })
    this.invalidate(id)
    this.core.recordActivity({
      kind: enabled ? 'integration.enabled' : 'integration.disabled',
      actor: 'user',
      title: `${enabled ? 'Enabled' : 'Disabled'} ${record.manifest.name}`,
      detail: { id }
    })
    this.core.broadcast('integrations:changed')
    return this.core.integrations.get(id)!
  }

  remove(id: string): void {
    const record = this.core.integrations.get(id)
    this.invalidate(id)
    this.core.integrations.remove(id)
    // Drop credentials with the integration, so nothing lingers after removal.
    this.secrets.deleteByPrefix(`${id}.`)

    if (record) {
      this.core.recordActivity({
        kind: 'integration.removed',
        actor: 'user',
        title: `Removed ${record.manifest.name}`,
        detail: { id }
      })
    }
    this.core.broadcast('integrations:changed')
  }

  setSecret(ref: string, value: string): void {
    this.secrets.set(ref, value)
    // A newly supplied credential can change health, so drop cached tools.
    this.toolCache.clear()
    this.core.broadcast('integrations:changed')
  }

  listSecretRefs(): { ref: string; encrypted: boolean; updatedAt: number }[] {
    return this.secrets.refs()
  }

  /* ---------------------------------------------------------------- oauth */

  async authorize(id: string): Promise<{ ok: boolean; message: string }> {
    const record = this.core.integrations.get(id)
    if (!record) return { ok: false, message: `no integration "${id}"` }
    if (record.manifest.kind !== 'rest' || record.manifest.auth.type !== 'oauth2') {
      return { ok: false, message: `${record.manifest.name} does not use OAuth` }
    }

    try {
      await this.oauth.authorize(id, record.manifest.auth)
      this.core.integrations.setHealth(id, 'ok', null)
      this.core.recordActivity({
        kind: 'integration.authorized',
        actor: 'user',
        title: `Connected ${record.manifest.name}`,
        detail: { id }
      })
      this.core.broadcast('integrations:changed')
      return { ok: true, message: `Connected ${record.manifest.name}.` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.core.integrations.setHealth(id, 'needs-auth', message)
      this.core.broadcast('integrations:changed')
      return { ok: false, message }
    }
  }

  /* ---------------------------------------------------------------- tools */

  async listTools(): Promise<IntegrationTool[]> {
    const out: IntegrationTool[] = []

    for (const record of this.listRecords()) {
      if (!record.manifest.enabled) continue
      try {
        out.push(...(await this.toolsFor(record)))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.core.integrations.setHealth(record.manifest.id, 'error', message)
        log.warn(`could not list tools for ${record.manifest.id}`, err)
      }
    }

    return out
  }

  private async toolsFor(record: IntegrationRecord): Promise<IntegrationTool[]> {
    const id = record.manifest.id
    const cached = this.toolCache.get(id)
    if (cached && Date.now() - cached.at < TOOL_CACHE_TTL_MS) return cached.tools

    const manifest = record.manifest
    let tools: IntegrationTool[] = []

    const wrap = (
      name: string,
      description: string,
      inputSchema: Record<string, unknown>,
      mutating: boolean
    ): IntegrationTool => ({
      integrationId: id,
      integrationName: manifest.name,
      name,
      qualifiedName: `${id}.${name}`,
      description,
      inputSchema,
      mutating
    })

    switch (manifest.kind) {
      case 'mcp-stdio':
      case 'mcp-http': {
        const client = await this.mcpClient(record)
        const listed = await client.listTools()
        // An MCP server does not say which of its tools have side effects, so
        // assume they might until the user knows otherwise.
        tools = listed.map((t) => wrap(t.name, t.description, t.inputSchema, true))
        break
      }
      case 'rest': {
        tools = new RestAdapter(manifest, this.secrets, this.oauth)
          .tools()
          .map((t) => wrap(t.name, t.description, t.inputSchema, t.mutating ?? false))
        break
      }
      case 'script': {
        tools = new ScriptAdapter(manifest, this.core.paths.integrationsDir, this.secrets)
          .tools()
          .map((t) => wrap(t.name, t.description, t.inputSchema, t.mutating ?? true))
        break
      }
      case 'webhook': {
        // Inbound only — nothing for the agent to call.
        tools = []
        break
      }
    }

    this.toolCache.set(id, { tools, at: Date.now() })
    this.core.integrations.setHealth(id, 'ok', null, tools.length)
    return tools
  }

  private async mcpClient(record: IntegrationRecord): Promise<McpClient> {
    const id = record.manifest.id
    const existing = this.mcpClients.get(id)
    if (existing) return existing

    let client: McpClient
    if (record.manifest.kind === 'mcp-stdio') {
      const env: Record<string, string> = { ...record.manifest.env }
      for (const [name, ref] of Object.entries(record.manifest.secretEnv ?? {})) {
        const value = this.secrets.get(ref)
        if (value) env[name] = value
      }
      client = new McpStdioClient(
        record.manifest.command,
        record.manifest.args,
        env,
        record.manifest.cwd
      )
    } else if (record.manifest.kind === 'mcp-http') {
      const headers: Record<string, string> = { ...record.manifest.headers }
      for (const [name, ref] of Object.entries(record.manifest.secretHeaders ?? {})) {
        const value = this.secrets.get(ref)
        if (value) headers[name] = value
      }
      client = new McpHttpClient(record.manifest.url, headers)
    } else {
      throw new Error(`${id} is not an MCP integration`)
    }

    await client.connect()
    this.mcpClients.set(id, client)
    return client
  }

  async callTool(
    integrationId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<AdapterResult> {
    const record = this.core.integrations.get(integrationId)
    if (!record) {
      return { content: `no integration "${integrationId}"`, isError: true }
    }
    if (!record.manifest.enabled) {
      return {
        content: `${record.manifest.name} is disabled. Ask the user to enable it in Integrations first.`,
        isError: true
      }
    }

    // Accept "integration.tool" as well as the bare tool name.
    const toolName = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool

    const started = Date.now()
    let result: AdapterResult

    try {
      switch (record.manifest.kind) {
        case 'mcp-stdio':
        case 'mcp-http': {
          const client = await this.mcpClient(record)
          const called = await client.callTool(toolName, args)
          result = { content: called.text, isError: called.isError }
          break
        }
        case 'rest':
          result = await new RestAdapter(record.manifest, this.secrets, this.oauth).call(toolName, args)
          break
        case 'script':
          result = await new ScriptAdapter(
            record.manifest,
            this.core.paths.integrationsDir,
            this.secrets
          ).call(toolName, args)
          break
        case 'webhook':
          result = {
            content: `${record.manifest.name} only receives data; it has nothing to call.`,
            isError: true
          }
          break
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.core.integrations.setHealth(integrationId, 'error', message)
      result = { content: `${integrationId}.${toolName} failed: ${message}`, isError: true }
    }

    this.core.recordActivity({
      kind: 'integration.call',
      actor: `integration:${integrationId}`,
      title: `${record.manifest.name} → ${toolName}`,
      detail: { tool: toolName, ok: !result.isError, durationMs: Date.now() - started }
    })

    return result
  }

  /* ------------------------------------------------------------- register */

  async register(input: unknown): Promise<{ ok: boolean; message: string; needsApproval: boolean }> {
    const validation = validateManifest(input)

    if (!validation.ok || !validation.manifest) {
      return {
        ok: false,
        needsApproval: false,
        message: [
          'The manifest did not validate. Fix these and call register_integration again:',
          ...validation.errors.map((e) => `  - ${e}`)
        ].join('\n')
      }
    }

    const manifest = validation.manifest
    const existing = this.core.integrations.get(manifest.id)

    // Always saved disabled: connecting a tool is the user's decision, not the
    // agent's, and a credential is usually still needed.
    this.core.integrations.upsert({ ...manifest, enabled: false })
    mkdirSync(join(this.core.paths.integrationsDir, manifest.id), { recursive: true })
    this.invalidate(manifest.id)

    const missingSecrets = (manifest.requiredSecrets ?? []).filter((s) => !this.secrets.has(s.ref))

    this.core.recordActivity({
      kind: 'integration.proposed',
      actor: 'agent',
      title: `${existing ? 'Updated' : 'Proposed'} integration: ${manifest.name}`,
      detail: { id: manifest.id, kind: manifest.kind }
    })

    const suggestion = this.core.suggestions.add({
      kind: 'integration',
      title: `${existing ? 'Update' : 'Connect'} ${manifest.name}`,
      rationale: manifest.description,
      payload: { integrationId: manifest.id, kind: manifest.kind, warnings: validation.warnings },
      autoApplicable: false
    })
    this.core.broadcast('suggestion:new', suggestion)
    this.core.broadcast('integrations:changed')

    const lines = [
      `Saved "${manifest.name}" (${manifest.kind}) as a pending integration. It is disabled until the user approves it in the Integrations panel.`
    ]
    if (validation.warnings.length) {
      lines.push('', 'The user will be shown these notes:', ...validation.warnings.map((w) => `  - ${w}`))
    }
    if (missingSecrets.length) {
      lines.push(
        '',
        'Still needed before it can work:',
        ...missingSecrets.map((s) => `  - ${s.label} (${s.ref})${s.hint ? ` — ${s.hint}` : ''}`),
        '',
        'Tell the user exactly where to obtain each of these.'
      )
    }

    return { ok: true, needsApproval: true, message: lines.join('\n') }
  }

  async test(integrationId: string): Promise<{ ok: boolean; message: string }> {
    const record = this.core.integrations.get(integrationId)
    if (!record) return { ok: false, message: `no integration "${integrationId}"` }

    try {
      this.invalidate(integrationId)
      const tools = await this.toolsFor(record)

      const health: IntegrationHealth = tools.length > 0 || record.manifest.kind === 'webhook' ? 'ok' : 'error'
      this.core.integrations.setHealth(integrationId, health, null, tools.length)
      this.core.broadcast('integrations:changed')

      if (record.manifest.kind === 'webhook') {
        return {
          ok: true,
          message: `${record.manifest.name} is listening at ${this.webhookBaseUrl}/${record.manifest.path}`
        }
      }

      return {
        ok: tools.length > 0,
        message:
          tools.length > 0
            ? `${record.manifest.name} responded with ${tools.length} operation(s): ${tools.map((t) => t.name).join(', ')}`
            : `${record.manifest.name} connected but exposed no operations.`
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const needsAuth = /secret|token|auth|credential|401|403/i.test(message)
      this.core.integrations.setHealth(integrationId, needsAuth ? 'needs-auth' : 'error', message)
      this.core.broadcast('integrations:changed')
      return { ok: false, message }
    }
  }

  private invalidate(id: string): void {
    this.toolCache.delete(id)
    this.mcpClients.get(id)?.close()
    this.mcpClients.delete(id)
  }

  /* -------------------------------------------------------------- webhooks */

  private async startWebhookServer(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.webhookServer = createServer((req, res) => {
        void this.handleWebhook(req, res)
      })

      this.webhookServer.on('error', (err) => {
        log.warn('webhook listener failed to start', err)
        resolve()
      })

      // Loopback only: this is for local senders and tunnels the user sets up
      // themselves, never a port opened to the network.
      this.webhookServer.listen(0, '127.0.0.1', () => {
        const address = this.webhookServer?.address()
        this.webhookPort = typeof address === 'object' && address ? address.port : 0
        log.info(`webhook listener on ${this.webhookBaseUrl}`)
        resolve()
      })
    })
  }

  private async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = url.pathname.match(/^\/hooks\/([a-z0-9-]+)$/)

    if (!match || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
      return
    }

    const hookPath = match[1]
    const record = this.listRecords().find(
      (r) => r.manifest.kind === 'webhook' && r.manifest.enabled && r.manifest.path === hookPath
    )

    if (!record || record.manifest.kind !== 'webhook') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no such hook"}')
      return
    }

    if (record.manifest.secretRef) {
      const expected = this.secrets.get(record.manifest.secretRef)
      const provided = req.headers['x-webhook-secret']
      if (!expected || provided !== expected) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
        return
      }
    }

    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > 2 * 1024 * 1024) throw new Error('payload too large')
        chunks.push(chunk as Buffer)
      }

      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const capture = record.manifest.capture

      const title =
        pick(payload, capture.titleField) ??
        `${record.manifest.name} · ${new Date().toLocaleString()}`
      const body = pick(payload, capture.bodyField) ?? '```json\n' + JSON.stringify(payload, null, 2) + '\n```'

      const node = this.core.createNote({
        title: String(title).slice(0, 160),
        body: String(body),
        tags: capture.tags ?? [record.manifest.id],
        kind: capture.kind ?? 'source',
        actor: `integration:${record.manifest.id}`
      })

      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ ok: true, nodeId: node.id })
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`webhook ${hookPath} failed`, err)
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }))
    }
  }
}

function pick(payload: Record<string, unknown>, path: string | undefined): string | undefined {
  if (!path) return undefined
  let current: unknown = payload
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current === undefined || current === null ? undefined : String(current)
}

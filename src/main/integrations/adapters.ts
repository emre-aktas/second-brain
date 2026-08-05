import { spawn } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import type {
  AuthSpec,
  IntegrationToolSpec,
  ParamSpec,
  RestManifest,
  RestOperation,
  ScriptManifest
} from '@shared/types'
import type { SecretVault } from './secrets'
import type { OAuthManager } from './oauth'
import { createLogger } from '../logger'

const log = createLogger('adapters')

export interface AdapterResult {
  content: string
  isError?: boolean
}

const MAX_RESULT_CHARS = 24_000

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated, ${text.length} chars total]`
    : text
}

function paramsToSchema(params: ParamSpec[] | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const param of params ?? []) {
    properties[param.name] = {
      type: param.type,
      ...(param.description ? { description: param.description } : {}),
      ...(param.default !== undefined ? { default: param.default } : {})
    }
    if (param.required) required.push(param.name)
  }

  return { properties, required }
}

/* -------------------------------------------------------------------- REST */

/**
 * Declarative HTTP adapter.
 *
 * A manifest describes a base URL, an auth scheme and a list of operations; each
 * operation becomes a callable tool. This is the path for services with no MCP
 * server — Gmail and most SaaS APIs — and it is what the agent writes when it
 * builds an integration itself, since it needs no code execution at all.
 */
export class RestAdapter {
  constructor(
    private manifest: RestManifest,
    private secrets: SecretVault,
    private oauth: OAuthManager
  ) {}

  tools(): IntegrationToolSpec[] {
    return this.manifest.operations.map((op) => {
      const pathSchema = paramsToSchema(op.pathParams)
      const querySchema = paramsToSchema(op.query)
      const bodySchema = paramsToSchema(op.bodyParams)

      const properties: Record<string, unknown> = {
        ...(pathSchema.properties as Record<string, unknown>),
        ...(querySchema.properties as Record<string, unknown>),
        ...(bodySchema.properties as Record<string, unknown>)
      }
      if (op.rawBody) {
        properties['body'] = { type: 'object', description: 'Raw JSON request body.' }
      }

      return {
        name: op.name,
        description: op.description,
        mutating: op.mutating ?? op.method !== 'GET',
        inputSchema: {
          type: 'object',
          properties,
          required: [
            ...(pathSchema.required as string[]),
            ...(querySchema.required as string[]),
            ...(bodySchema.required as string[])
          ]
        }
      }
    })
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<AdapterResult> {
    const op = this.manifest.operations.find((o) => o.name === toolName)
    if (!op) {
      return {
        content: `"${toolName}" is not an operation of ${this.manifest.name}. Available: ${this.manifest.operations.map((o) => o.name).join(', ')}`,
        isError: true
      }
    }

    try {
      const { url, init } = await this.buildRequest(op, args)
      const res = await fetch(url, init)
      const text = await res.text()

      if (!res.ok) {
        return {
          content: `${op.name} failed with HTTP ${res.status} ${res.statusText}\n${text.slice(0, 2000)}`,
          isError: true
        }
      }

      return { content: truncate(this.shapeResponse(op, text)) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`REST call ${this.manifest.id}.${toolName} failed`, err)
      return { content: `${op.name} failed: ${message}`, isError: true }
    }
  }

  private async buildRequest(
    op: RestOperation,
    args: Record<string, unknown>
  ): Promise<{ url: string; init: RequestInit }> {
    let path = op.path
    for (const param of op.pathParams ?? []) {
      const value = args[param.name] ?? param.default
      if (value === undefined && param.required) {
        throw new Error(`"${param.name}" is required`)
      }
      path = path.replace(`{${param.name}}`, encodeURIComponent(String(value ?? '')))
    }

    const url = new URL(
      path.replace(/^\//, ''),
      this.manifest.baseUrl.endsWith('/') ? this.manifest.baseUrl : `${this.manifest.baseUrl}/`
    )

    for (const param of op.query ?? []) {
      const value = args[param.name] ?? param.default
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(param.name, String(value))
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.manifest.defaultHeaders
    }

    let body: string | undefined
    if (op.method !== 'GET' && op.method !== 'DELETE') {
      if (op.rawBody && args['body'] && typeof args['body'] === 'object') {
        body = JSON.stringify(args['body'])
      } else if (op.bodyParams?.length) {
        const payload: Record<string, unknown> = {}
        for (const param of op.bodyParams) {
          const value = args[param.name] ?? param.default
          if (value !== undefined) payload[param.name] = value
        }
        body = JSON.stringify(payload)
      }
      if (body) headers['content-type'] = 'application/json'
    }

    await this.applyAuth(this.manifest.auth, headers, url)

    return { url: url.toString(), init: { method: op.method, headers, body } }
  }

  private async applyAuth(
    auth: AuthSpec,
    headers: Record<string, string>,
    url: URL
  ): Promise<void> {
    switch (auth.type) {
      case 'none':
        return

      case 'apiKey': {
        const key = this.requireSecret(auth.secretRef)
        if (auth.in === 'header') headers[auth.name] = key
        else url.searchParams.set(auth.name, key)
        return
      }

      case 'bearer': {
        headers['authorization'] = `Bearer ${this.requireSecret(auth.secretRef)}`
        return
      }

      case 'basic': {
        const credentials = this.requireSecret(auth.secretRef)
        headers['authorization'] = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`
        return
      }

      case 'oauth2': {
        // Refreshes transparently when the stored token is close to expiry.
        headers['authorization'] = `Bearer ${await this.oauth.accessToken(auth)}`
        return
      }
    }
  }

  private requireSecret(ref: string): string {
    const value = this.secrets.get(ref)
    if (!value) {
      throw new Error(`the secret "${ref}" is not set — add it in the integration's settings`)
    }
    return value
  }

  /** Pull out the useful part of a response so the agent is not handed noise. */
  private shapeResponse(op: RestOperation, text: string): string {
    if (!op.resultPath) return text

    try {
      let current: unknown = JSON.parse(text)
      for (const segment of op.resultPath.split('.')) {
        if (current === null || typeof current !== 'object') return text
        current = (current as Record<string, unknown>)[segment]
      }
      return current === undefined ? text : JSON.stringify(current, null, 2)
    } catch {
      return text
    }
  }
}

/* ------------------------------------------------------------------ script */

/**
 * Runs a Node script the agent authored.
 *
 * One process per call, receiving `{ tool, args }` on stdin and answering with
 * JSON on stdout. A short-lived process means a hung or crashed integration
 * cannot leak state into the next call, and the Electron binary supplies the
 * runtime so nothing needs Node installed.
 */
export class ScriptAdapter {
  constructor(
    private manifest: ScriptManifest,
    private integrationsDir: string,
    private secrets: SecretVault
  ) {}

  tools(): IntegrationToolSpec[] {
    return this.manifest.tools
  }

  private entryPath(): string {
    const dir = resolve(this.integrationsDir, this.manifest.id)
    const entry = resolve(dir, this.manifest.entry)

    // The manifest is agent-authored, so confine the entry point to the
    // integration's own folder.
    if (entry !== dir && !entry.startsWith(dir + sep)) {
      throw new Error(`the entry point must live inside ${dir}`)
    }
    if (!existsSync(entry)) {
      throw new Error(`the script ${this.manifest.entry} does not exist yet`)
    }
    return entry
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<AdapterResult> {
    if (!this.manifest.tools.some((t) => t.name === toolName)) {
      return { content: `"${toolName}" is not declared by ${this.manifest.name}`, isError: true }
    }

    let entry: string
    try {
      entry = this.entryPath()
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }

    const env: Record<string, string> = {
      ...this.manifest.env,
      ELECTRON_RUN_AS_NODE: '1'
    }
    for (const [name, ref] of Object.entries(this.manifest.secretEnv ?? {})) {
      const value = this.secrets.get(ref)
      if (value) env[name] = value
    }

    return await new Promise<AdapterResult>((settle) => {
      const child = spawn(process.execPath, [entry], {
        cwd: join(this.integrationsDir, this.manifest.id),
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      let done = false

      const finish = (result: AdapterResult): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        settle(result)
      }

      const timer = setTimeout(
        () => finish({ content: `${toolName} timed out after 60s`, isError: true }),
        60_000
      )
      timer.unref?.()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c: string) => {
        stdout += c
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (c: string) => {
        stderr += c
      })

      child.on('error', (err) =>
        finish({ content: `could not run the script: ${err.message}`, isError: true })
      )

      child.on('close', (code) => {
        if (code !== 0) {
          finish({
            content: `the script exited with code ${code}\n${stderr.slice(0, 2000) || stdout.slice(0, 2000)}`,
            isError: true
          })
          return
        }

        const trimmed = stdout.trim()
        if (!trimmed) {
          finish({ content: 'the script produced no output', isError: true })
          return
        }

        try {
          const parsed = JSON.parse(trimmed) as { content?: unknown; error?: unknown }
          if (parsed.error) {
            finish({ content: String(parsed.error), isError: true })
            return
          }
          const content =
            typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed, null, 2)
          finish({ content: truncate(content) })
        } catch {
          // A script that just prints text is still useful.
          finish({ content: truncate(trimmed) })
        }
      })

      child.stdin.write(`${JSON.stringify({ tool: toolName, args })}\n`)
      child.stdin.end()
    })
  }
}

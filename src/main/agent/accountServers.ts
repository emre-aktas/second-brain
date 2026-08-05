import type { AccountServerDto } from '@shared/ipc'
import { resolveClaudeBinary, runClaude } from './claude'
import { createLogger } from '../logger'

const log = createLogger('connectors')

/**
 * How long a reading stays good.
 *
 * Long, because the command is expensive: it health-checks every server the account has,
 * and with a couple of dozen of them that is seconds of real work. Connectors do not come
 * and go minute to minute, so a stale answer costs nothing and a fresh one costs a lot.
 */
const CACHE_MS = 10 * 60_000

/**
 * Which MCP connectors the signed-in Claude account actually has.
 *
 * The app cannot enumerate these from anything it owns: they belong to the user's Claude
 * account, not to this application, and `--strict-mcp-config` is deliberately not passed
 * so the agent gets them alongside the app's own tools. `claude mcp list` is the only
 * source, and it has no structured output — hence the parse.
 *
 * Lifted out of the IPC layer because the hourly check-in needs it too: naming a source
 * the user has not connected is how an unprompted turn wastes itself producing an apology.
 */
export class AccountServers {
  private cached: { at: number; servers: AccountServerDto[] } | null = null
  private inFlight: Promise<AccountServerDto[]> | null = null

  /** Every server, cached. */
  async all(): Promise<AccountServerDto[]> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.servers
    if (this.inFlight) return this.inFlight

    this.inFlight = this.read().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Only the ones that would actually answer a tool call. */
  async connected(): Promise<AccountServerDto[]> {
    return (await this.all()).filter((server) => server.status === 'connected')
  }

  /**
   * Whether a named connector is usable, matched loosely on the server's name.
   *
   * Loosely because the name is whatever the account calls it — "claude.ai Slack",
   * "Slack", "slack-workspace" — and an exact match would silently answer no.
   */
  async has(needle: string): Promise<boolean> {
    const wanted = needle.toLowerCase()
    return (await this.connected()).some((server) => server.name.toLowerCase().includes(wanted))
  }

  /** Drop the cache, e.g. after the user has connected something. */
  forget(): void {
    this.cached = null
  }

  private async read(): Promise<AccountServerDto[]> {
    const binary = resolveClaudeBinary()
    if (!binary) return []

    // Never on the main thread synchronously: this used to freeze the app for as long as
    // the health checks took.
    const { stdout: output } = await runClaude(binary, ['mcp', 'list'], { timeoutMs: 45_000 })

    const servers: AccountServerDto[] = []
    for (const line of output.split(/\r?\n/)) {
      // e.g. "claude.ai Slack: https://mcp.slack.com/mcp - ✓ Connected"
      const match = line.match(/^(.+?):\s+(\S.*?)\s+-\s+(.+)$/)
      if (!match) continue

      const [, name, target, rawStatus] = match
      const status = /connected/i.test(rawStatus)
        ? 'connected'
        : /auth/i.test(rawStatus)
          ? 'needs-auth'
          : /pending|approval/i.test(rawStatus)
            ? 'pending'
            : /fail|error/i.test(rawStatus)
              ? 'failed'
              : 'unknown'

      servers.push({ name: name.trim(), target: target.trim(), status })
    }

    this.cached = { at: Date.now(), servers }
    log.info(`${servers.length} account connector(s), ${servers.filter((s) => s.status === 'connected').length} connected`)
    return servers
  }
}

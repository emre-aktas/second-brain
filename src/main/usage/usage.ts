import type { KvStore } from '../db/meta'
import { resolveClaudeBinary, runClaude, subscriptionEnv } from '../agent/claude'
import { createLogger } from '../logger'

const log = createLogger('usage')

/**
 * Real plan usage, read from the CLI's own `/usage` command.
 *
 * An earlier version reconstructed windows by summing tokens out of session
 * transcripts. That worked but reported raw token counts, which mean nothing to a
 * person, and it could not know the plan's ceiling. `claude -p /usage` answers
 * locally with the actual percentages and reset times, costs no model tokens, and
 * is the same source the CLI shows interactively — so it is used instead.
 */

export interface UsageBucket {
  percent: number
  /** Human-readable reset time exactly as the CLI phrases it. */
  resetsAt: string | null
}

export interface UsageSnapshot {
  available: boolean
  onSubscription: boolean
  /** The rolling 5-hour window the CLI calls "session". */
  session: UsageBucket | null
  week: UsageBucket | null
  weekByModel: { model: string; percent: number }[]
  /** The CLI's own caveat about what its numbers cover. */
  caveat: string | null
  computedAt: number
  rateLimit: { message: string; at: number; resetsAt: number | null } | null
}

const KV_RATELIMIT = 'usage/rateLimit'
const CACHE_MS = 90_000

export class UsageTracker {
  private cached: UsageSnapshot | null = null
  private lastRun = 0

  constructor(private kv: KvStore) {}

  /** Record that the CLI reported a limit, so the UI can say so immediately. */
  noteRateLimit(message: string): void {
    const isoMatch = message.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/)
    let resetsAt: number | null = null
    if (isoMatch) {
      const parsed = Date.parse(isoMatch[0])
      if (!Number.isNaN(parsed)) resetsAt = parsed
    }

    this.kv.set(KV_RATELIMIT, { message: message.slice(0, 400), at: Date.now(), resetsAt })
    this.cached = null
  }

  clearRateLimit(): void {
    this.kv.delete(KV_RATELIMIT)
    this.cached = null
  }

  /**
   * Never blocks.
   *
   * Reading usage means running the CLI, which takes about a second — and this used
   * to happen on the main process's only thread, freezing every window for that
   * long, every 90 seconds. So the caller gets whatever is known now, and a stale
   * value triggers a background refresh that announces itself when it lands.
   */
  snapshot(force = false): UsageSnapshot {
    const stale = !this.cached || Date.now() - this.lastRun >= CACHE_MS
    if (force || stale) void this.refresh()

    const known = this.cached ?? {
      available: false,
      onSubscription: false,
      session: null,
      week: null,
      weekByModel: [],
      caveat: null,
      computedAt: 0,
      rateLimit: null
    }
    return { ...known, rateLimit: this.storedRateLimit() }
  }

  /** Set by the bootstrap so a finished refresh reaches the windows. */
  onChanged: ((snapshot: UsageSnapshot) => void) | null = null

  private refreshing: Promise<void> | null = null

  private refresh(): Promise<void> {
    // One at a time: several windows asking at once must not spawn several CLIs.
    if (this.refreshing) return this.refreshing

    this.lastRun = Date.now()
    this.refreshing = this.read()
      .then((next) => {
        this.cached = next
        this.onChanged?.({ ...next, rateLimit: this.storedRateLimit() })
      })
      .catch((err) => {
        log.warn('usage refresh failed', err)
      })
      .finally(() => {
        this.refreshing = null
      })

    return this.refreshing
  }

  private storedRateLimit(): UsageSnapshot['rateLimit'] {
    return this.kv.get<UsageSnapshot['rateLimit']>(KV_RATELIMIT) ?? null
  }

  private async read(): Promise<UsageSnapshot> {
    const empty: UsageSnapshot = {
      available: false,
      onSubscription: false,
      session: null,
      week: null,
      weekByModel: [],
      caveat: null,
      computedAt: Date.now(),
      rateLimit: null
    }

    const binary = resolveClaudeBinary()
    if (!binary) return empty

    const { stdout: output } = await runClaude(
      binary,
      ['--print', '/usage', '--output-format', 'text'],
      {
        timeoutMs: 20_000,
        // Same environment discipline as a real turn, so this reports the account
        // the agent actually runs as.
        env: subscriptionEnv(process.env)
      }
    )

    if (!output.trim()) return empty
    return { ...parseUsage(output), computedAt: Date.now(), rateLimit: null }
  }
}

/** Percentage lines look like: `Current session: 37% used · resets Aug 4, 8:39pm (Europe/Istanbul)` */
export function parseUsage(output: string): Omit<UsageSnapshot, 'computedAt' | 'rateLimit'> {
  const bucket = (label: string): UsageBucket | null => {
    const pattern = new RegExp(
      `${label}:\\s*(\\d+(?:\\.\\d+)?)%\\s*used(?:\\s*[·-]\\s*resets\\s*([^\\n(]+))?`,
      'i'
    )
    const match = output.match(pattern)
    if (!match) return null

    return {
      percent: Number(match[1]),
      resetsAt: match[2] ? match[2].trim().replace(/\s+/g, ' ') : null
    }
  }

  const weekByModel: { model: string; percent: number }[] = []
  const perModel = output.matchAll(/Current week \(([^)]+)\):\s*(\d+(?:\.\d+)?)%\s*used/gi)
  for (const match of perModel) {
    const model = match[1].trim()
    if (/^all models$/i.test(model)) continue
    weekByModel.push({ model, percent: Number(match[2]) })
  }

  const caveatMatch = output.match(/^Approximate,[^\n]*/im)

  return {
    available: /\d+%\s*used/i.test(output),
    onSubscription: /using your subscription/i.test(output),
    session: bucket('Current session'),
    week: bucket('Current week \\(all models\\)'),
    weekByModel,
    caveat: caveatMatch ? caveatMatch[0].trim() : null
  }
}

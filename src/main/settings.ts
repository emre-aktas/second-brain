import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings } from '@shared/types'
import { createLogger } from './logger'

const log = createLogger('settings')

export function defaultSettings(workspacePath: string): Settings {
  return {
    workspacePath,
    model: 'sonnet',
    effort: 'medium',
    defaultCapability: 'curate',
    budget: {
      // 'auto' enforces caps only when the CLI is billing metered API credits.
      // On a subscription there is nothing per-token to cap, so caps would only
      // get in the way.
      mode: 'auto',
      dailyLimitUsd: 5,
      perTurnLimitUsd: 1
    },
    curator: {
      enabled: true,
      idleMs: 90_000,
      intervalMs: 10 * 60_000,
      autoLinkSimilar: true,
      // Off by default: the deterministic half of curation costs nothing, while
      // an agent pass runs unattended and is the easiest way to spend without
      // noticing. Opt in explicitly.
      useAgent: false,
      similarityThreshold: 0.22
    },
    chat: {
      showToolActivity: false
    },
    graph: {
      showTags: true,
      showSimilarEdges: true,
      linkDistance: 70,
      charge: -260,
      labelThreshold: 0.75
    },
    appearance: {
      theme: 'dark',
      accent: 'violet',
      reduceMotion: false
    }
  }
}

/** Deep-merge stored settings over defaults so new keys appear without migration. */
function merge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch === undefined ? base : (patch as T)) ?? base
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return patch as T
  }

  const out = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(key in out)) continue // ignore unknown keys rather than trusting them
    out[key] = merge(out[key], value)
  }
  return out as T
}

export class SettingsStore {
  private current: Settings
  private readonly file: string

  constructor(file: string, fallbackWorkspace: string) {
    this.file = file
    this.current = defaultSettings(fallbackWorkspace)

    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
        this.current = merge(this.current, raw)
      } catch (err) {
        log.warn('settings file unreadable, falling back to defaults', err)
      }
    } else {
      this.persist()
    }
  }

  get(): Settings {
    return this.current
  }

  /** Shallow-per-section patch; returns the merged result. */
  update(patch: Partial<Settings>): Settings {
    this.current = merge(this.current, patch)
    this.persist()
    return this.current
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.current, null, 2)}\n`, 'utf8')
    } catch (err) {
      log.error('could not write settings', err)
    }
  }
}

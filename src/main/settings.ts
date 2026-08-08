import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DeepPartial, Settings } from '@shared/types'
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
    engine: {
      // The engine the app was built on, and the only one that needs no setup: the user has
      // already signed the CLI in, it brings its own tools, and it spends nothing extra.
      providerId: 'claude-cli',
      models: {},
      baseUrls: {},
      efforts: {}
    },
    graph: {
      // Off. A tag sits on the rim with edges crossing the whole canvas, so on a vault
      // with any history the tags are most of what a first look at the graph shows —
      // and they are the one kind of node the user never wrote.
      showTags: false,
      showSimilarEdges: true,
      linkDistance: 70,
      charge: -260,
      labelThreshold: 0.75,
      // On. Names are what makes a graph a graph rather than a diagram of dots — this exists to
      // be turned *off* for a moment, not to be lived without.
      showLabels: true,
      rotate: true
    },
    layout: {
      panelWidth: 430
    },
    sound: {
      // On, quietly. It fires when an answer arrives while the user is looking at the app,
      // which is information they want and which the desktop notifier deliberately stays
      // silent for — so off by default would leave that moment with no cue at all.
      enabled: true,
      volume: 0.35
    },
    appearance: {
      theme: 'dark',
      accent: 'violet',
      reduceMotion: false
    },
    proactive: {
      // On, because an app that only ever reacts is not a second brain. What keeps
      // this honest is the heartbeat's pre-check: an hour in which nothing changed
      // costs nothing, so the default is cheap rather than merely defensible.
      enabled: true,
      heartbeat: true,
      quietHours: {
        // Overnight by default. A digest of what happened at 03:00 is still wanted
        // at 07:00; it is the 03:00 notification nobody asked for.
        enabled: true,
        startHour: 23,
        endHour: 7
      },
      sweep: {
        // On, but at a quarter of the check-in's rate. This is the one part of
        // proactivity that costs a turn every time it runs — the vault gate is free when
        // nothing changed, a sweep never is — so its interval is its budget.
        enabled: true,
        slack: true,
        grain: true,
        clickup: true,
        everyHours: 4
      }
    },
    notifications: {
      enabled: true,
      onReply: true,
      onProactive: true,
      onQuestion: true
    }
  }
}

/**
 * Deep-merge stored settings over defaults so new keys appear without migration.
 *
 * The defaults define the *shape*; the stored file only supplies values. That asymmetry is
 * the load-bearing part: this file is plain JSON in the user's own workspace, so it can be
 * hand-edited, half-written by a crash, or left behind by a build that structured something
 * differently. A patch that disagrees about the shape is discarded rather than trusted,
 * because a `Settings` whose `layout` is the string "wide" satisfies no reader in the app —
 * the type says it is an object and every call site believes it.
 */
/**
 * Settings that are dictionaries rather than groups, by path.
 *
 * `merge` drops keys the defaults do not declare, which is right for every fixed-shape group in
 * `Settings` and exactly wrong for these three: they are keyed by *provider id*, they all start
 * `{}`, and so every key in them is by definition one the defaults never declared. The result was
 * that a chosen model was silently discarded for every provider — the log line said it had been
 * saved, because it was printed from the patch, and the panel then showed "none chosen". Two
 * separate reports, one line of code.
 *
 * A list rather than a heuristic. "The base group is empty, so accept anything" would also accept
 * junk into a group that merely happens to have no defaults yet, and the whole point of the rule
 * is that a settings file can be hand-edited or left behind by a build that structured something
 * differently.
 */
const OPEN_MAPS = new Set(['engine.models', 'engine.baseUrls', 'engine.efforts'])

function merge<T>(base: T, patch: unknown, path = ''): T {
  const baseIsGroup = base !== null && typeof base === 'object' && !Array.isArray(base)

  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    // A scalar or an array cannot stand in for a group of settings. Keep the default.
    if (baseIsGroup) return base
    return (patch === undefined ? base : (patch as T)) ?? base
  }
  if (!baseIsGroup) {
    // And a group cannot stand in for a scalar either — same argument, other direction.
    return base === undefined ? (patch as T) : base
  }

  const open = OPEN_MAPS.has(path)
  const out = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    // Unknown keys are ignored rather than trusted — except in a dictionary, where every key is
    // unknown by construction and the values are strings whatever the key.
    if (!(key in out)) {
      if (!open || typeof value !== 'string') continue
      out[key] = value
      continue
    }
    out[key] = merge(out[key], value, path ? `${path}.${key}` : key)
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

  /**
   * Patch any depth; returns the merged result.
   *
   * `merge` below has always walked nested objects, so a patch naming one key inside
   * `proactive` was already correct — the signature just did not say so, which forced
   * callers to restate sibling keys they had no business touching.
   */
  update(patch: DeepPartial<Settings>): Settings {
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

import type { ModelInfo } from '@shared/engines'
import { createLogger } from '../../logger'

const log = createLogger('engine:models')

/**
 * What models a provider has, asked at the moment of asking.
 *
 * Never a hardcoded list. Every provider's line moves on its own schedule — DeepSeek's went to
 * v4 while this was being written, OpenRouter carries four hundred models and gains several a
 * week — and a list compiled by hand is not merely stale, it fails in the worst possible place:
 * a model id that no longer exists is accepted by the settings screen and rejected by the first
 * turn, hours later, with a 404 the user has no way to interpret.
 *
 * Every OpenAI-compatible provider answers `GET /models`. The richer ones say considerably more
 * than the id — OpenRouter reports context length, price, and a `supported_parameters` list
 * naming `tools` and `reasoning` — and that is the difference between a model picker and a
 * model picker that can tell you the model you chose cannot call tools and therefore cannot
 * touch your notes.
 */

/** Long enough that a settings screen is not a source of traffic; short enough to stay true. */
const CACHE_MS = 6 * 60 * 60 * 1000

interface CacheEntry {
  at: number
  models: ModelInfo[]
}

const cache = new Map<string, CacheEntry>()

function priceOf(value: unknown): number | null {
  // Providers quote per-token prices as strings, often "0" for a free model. Per million is
  // what a human reads, so the conversion happens once, here.
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n * 1_000_000 : null
}

/**
 * One provider's model list, normalised.
 *
 * The shape varies: OpenAI answers `{data:[{id}]}` and little else, OpenRouter answers the same
 * envelope with a dozen fields inside. Both are read through the same optional-chaining path so
 * a provider that reports nothing extra still produces a usable list — an id alone is enough to
 * run a model, and the missing fields are shown as unknown rather than invented.
 */
export async function fetchModels(input: {
  baseUrl: string
  apiKey: string | null
  headers?: Record<string, string>
  force?: boolean
}): Promise<{ models: ModelInfo[]; cached: boolean; error: string | null }> {
  const base = input.baseUrl.replace(/\/+$/, '')
  const hit = cache.get(base)

  if (!input.force && hit && Date.now() - hit.at < CACHE_MS) {
    return { models: hit.models, cached: true, error: null }
  }

  try {
    const headers: Record<string, string> = { accept: 'application/json', ...input.headers }
    if (input.apiKey) headers['authorization'] = `Bearer ${input.apiKey}`

    const res = await fetch(`${base}/models`, { headers })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
    }

    const body = (await res.json()) as { data?: unknown[]; models?: unknown[] }
    // `data` is the OpenAI envelope; `models` is what a couple of local servers use.
    const raw = (body.data ?? body.models ?? []) as Record<string, unknown>[]
    const models = raw.map(normalise).filter((model) => model.id.length > 0)

    // Sorted by name so the picker is scannable. Providers return them in creation order,
    // which for four hundred models is no order at all.
    models.sort((a, b) => a.label.localeCompare(b.label))

    cache.set(base, { at: Date.now(), models })
    log.info(`${models.length} model(s) from ${base}`)
    return { models, cached: false, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`could not read models from ${base}: ${message}`)
    // The stale list beats nothing: a provider that is briefly unreachable should not empty the
    // picker and make the user think their setup broke.
    if (hit) return { models: hit.models, cached: true, error: message }
    return { models: [], cached: false, error: message }
  }
}

function normalise(raw: Record<string, unknown>): ModelInfo {
  const id = String(raw['id'] ?? raw['name'] ?? '')
  const pricing = (raw['pricing'] ?? {}) as Record<string, unknown>
  const supported = (raw['supported_parameters'] ?? []) as unknown

  const params = Array.isArray(supported) ? supported.map(String) : []

  return {
    id,
    label: typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : id,
    contextLength:
      typeof raw['context_length'] === 'number'
        ? raw['context_length']
        : typeof raw['context_window'] === 'number'
          ? raw['context_window']
          : null,
    promptPrice: priceOf(pricing['prompt']),
    completionPrice: priceOf(pricing['completion']),
    /*
     * Optimistic when the provider says nothing.
     *
     * Only OpenRouter reports `supported_parameters`. Treating silence as "no tools" would
     * make every model on OpenAI, Groq and every local server look incapable, which is both
     * wrong and the exact thing that would send a user back to the Claude engine convinced
     * this feature is broken. Where the provider *does* speak, it is believed.
     */
    supportsTools: params.length === 0 ? true : params.includes('tools'),
    supportsReasoning:
      params.length === 0
        ? // A useful heuristic for the providers that stay silent, and no more than that:
          // these are the families that have shipped reasoning controls.
          /(^|\/)(o[134]|gpt-5|claude|gemini|deepseek|qwen|grok|magistral|glm)/i.test(id)
        : params.includes('reasoning') || params.includes('reasoning_effort'),
    description: typeof raw['description'] === 'string' ? raw['description'].slice(0, 400) : undefined
  }
}

/** Drop a provider's cached list, so "refresh" in the panel means what it says. */
export function forgetModels(baseUrl: string): void {
  cache.delete(baseUrl.replace(/\/+$/, ''))
}

/**
 * One model out of whatever has already been fetched, synchronously.
 *
 * Building an engine is synchronous — the manager is mid-turn by the time it happens — so the
 * catalogue can only be *consulted*, never awaited, here. That is why this reads the cache and
 * answers null rather than fetching: a turn must not wait on a provider's model list, and the
 * two things this answer feeds both degrade gracefully without it. Capabilities fall back to
 * optimistic, which is the existing behaviour, and cost falls back to unknown.
 *
 * The cache is warm in practice, because choosing a model in the panel is what fills it.
 */
export function cachedModel(baseUrl: string, id: string): ModelInfo | null {
  const hit = cache.get(baseUrl.replace(/\/+$/, ''))
  return hit?.models.find((model) => model.id === id) ?? null
}

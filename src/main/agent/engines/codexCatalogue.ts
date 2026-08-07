import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelInfo } from '@shared/engines'
import { createLogger } from '../../logger'

const log = createLogger('engine:codex-catalogue')

/**
 * Which models Codex can run, asked of Codex.
 *
 * `codex debug models` renders the CLI's own catalogue as JSON — the same list the picker in the
 * Codex app shows, with each model's supported reasoning levels attached. Reading it is the only
 * version of this that stays true: the answer on this machine today is `gpt-5.6-sol` with six
 * reasoning levels up to `ultra`, which no list written into this repo would have contained, and
 * a hardcoded one goes stale the week OpenAI ships the next model. It also needs no network and
 * no account — the catalogue is local, which is why it still works when the CLI's session has
 * expired.
 *
 * `visibility: 'hide'` models are dropped. They are in the catalogue for compatibility with
 * threads that already use them, not to be chosen; the Codex app does not offer them either.
 */

interface RawLevel {
  effort?: string
  description?: string
}

interface RawModel {
  slug?: string
  display_name?: string
  description?: string
  visibility?: string
  supported_in_api?: boolean
  priority?: number
  default_reasoning_level?: string
  supported_reasoning_levels?: RawLevel[]
}

/** Cached, because the catalogue is a 300KB JSON render and a spawn, and it changes on update. */
let cache: { at: number; models: ModelInfo[] } | null = null
const TTL_MS = 6 * 60 * 60 * 1000

export function forgetCodexCatalogue(): void {
  cache = null
}

/**
 * Run `codex debug models` and parse it.
 *
 * Spawned rather than `spawnSync`: this is the main process, and the render is large enough that
 * a synchronous read would freeze every window for the duration — the exact fault the rest of the
 * app is built to avoid.
 */
export async function codexModels(binary: string, force = false): Promise<{
  models: ModelInfo[]
  error: string | null
}> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return { models: cache.models, error: null }
  }

  try {
    const raw = await run(binary, ['debug', 'models'])
    const parsed = JSON.parse(raw) as { models?: RawModel[] }
    const models = (parsed.models ?? [])
      .filter((model) => model.slug && model.visibility !== 'hide')
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map(toModelInfo)

    if (models.length === 0) return { models: [], error: 'Codex reported no models.' }

    cache = { at: Date.now(), models }
    log.info(`${models.length} codex models`)
    return { models, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`could not read the codex catalogue: ${message}`)
    return { models: [], error: message }
  }
}

function toModelInfo(model: RawModel): ModelInfo {
  const levels = (model.supported_reasoning_levels ?? [])
    .filter((level): level is { effort: string; description?: string } => Boolean(level.effort))
    .map((level) => ({ effort: level.effort, description: level.description ?? '' }))

  return {
    id: model.slug ?? '',
    label: model.display_name || (model.slug ?? ''),
    // Codex bills the signed-in ChatGPT plan and publishes neither a price nor a context window
    // here. Inventing either would be worse than the blank the panel already handles.
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    // It is an agent CLI; tools are the entire point.
    supportsTools: true,
    supportsReasoning: levels.length > 0,
    description: model.description ?? '',
    reasoningLevels: levels,
    defaultReasoning: model.default_reasoning_level ?? null
  }
}

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      detached: process.platform !== 'win32'
    })

    let out = ''
    let err = ''
    // The catalogue is written to stdout; the CLI's own logging goes to stderr and is only
    // interesting if this fails.
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      err += chunk
    })

    // Nothing is expected on stdin, and an open pipe is how `codex exec` was made to hang.
    child.stdin.end()

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out)
      else reject(new Error(err.trim().split('\n').pop() || `codex debug models exited ${code}`))
    })

    // A catalogue render that has not finished in fifteen seconds is not going to.
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill()
        reject(new Error('codex debug models timed out'))
      }
    }, 15_000)
  })
}

/**
 * What the user's own Codex is set to, read from its config.
 *
 * Shown as the starting point in the panel, so the app agrees with the CLI rather than quietly
 * overriding it. Parsed with two regexes instead of a TOML dependency: only two scalar keys are
 * wanted, both are written at the top level by the Codex app itself, and adding a parser to
 * `dependencies` would mean finding one that is still CJS.
 */
export function codexConfigDefaults(): { model: string | null; effort: string | null } {
  const home = process.env['CODEX_HOME'] || join(homedir(), '.codex')
  try {
    const text = readFileSync(join(home, 'config.toml'), 'utf8')
    // Anchored to the line start so a key inside a `[mcp_servers.x]` table cannot match, and
    // stopping at the first table header for the same reason.
    const top = text.split(/^\s*\[/m)[0] ?? ''
    const model = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(top)?.[1] ?? null
    const effort = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(top)?.[1] ?? null
    return { model, effort }
  } catch {
    // No config at all is the normal state of a fresh install, not a fault.
    return { model: null, effort: null }
  }
}

import { spawn } from 'node:child_process'
import type { EngineProvider } from '@shared/engines'
import { providerById } from '@shared/engines'
import { createLogger } from '../../logger'

const log = createLogger('engine:verify')

/**
 * Does this engine actually answer, and can it actually call a tool.
 *
 * The distinction from `engine:test` is the whole reason this exists. That test reads the model
 * list — authenticated, free, and *silent about everything that matters*: a key with no
 * completions quota lists models, a model that cannot call tools lists fine, a Codex install
 * whose ChatGPT session expired publishes its catalogue from disk and looks perfectly healthy.
 * Every one of those passes the test and then fails on the user's first real question, which is
 * the worst possible place to find out.
 *
 * So this is a turn. A very small one — a fixed prompt, one trivial tool, a low ceiling — and it
 * is opt-in for exactly that reason: on a metered provider it costs a fraction of a cent, and
 * nothing in this app spends the user's money on its own initiative. What it buys is the one
 * question the setup flow could not previously answer: *will this work*.
 *
 * The tool it offers is deliberately not a brain tool. `ping` takes one string and does nothing,
 * so a model that calls it has proven the tool-calling path end to end without being given the
 * chance to touch a note during what the user was told is a test.
 */

export interface VerifyResult {
  ok: boolean
  /** One sentence, in the user's terms. */
  message: string
  /** What it managed, so the panel can show a partial pass as a partial pass. */
  reached: boolean
  answered: boolean
  calledTool: boolean
  /** Tokens the check cost, when the provider says. */
  tokens: number | null
}

const PROMPT =
  'Call the ping tool exactly once with the word "ready", then reply with the single word OK.'

const PING_TOOL = {
  type: 'function' as const,
  function: {
    name: 'ping',
    description: 'Confirms the tool-calling path works. Takes one word and does nothing with it.',
    parameters: {
      type: 'object',
      properties: { word: { type: 'string' } },
      required: ['word']
    }
  }
}

/**
 * One non-streamed request, which is the cheapest complete proof.
 *
 * Non-streamed on purpose: usage comes back without having to be asked for, there is no SSE to
 * parse, and the finish reason is a field rather than a frame. None of that is what the app does
 * in a real turn — but this is checking the *provider*, and the streaming path has its own probe.
 */
async function verifyApi(
  provider: EngineProvider,
  baseUrl: string,
  apiKey: string | null,
  model: string,
  offerTools: boolean
): Promise<VerifyResult> {
  const base = baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...provider.headers
  }
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: PROMPT }],
    // The same per-provider spelling a real turn uses, so a provider that rejects one of them
    // is caught here rather than on the user's first question.
    [provider.maxTokens ?? 'max_tokens']: 512
  }
  if (offerTools) body['tools'] = [PING_TOOL]

  const failed = (message: string, reached: boolean): VerifyResult => ({
    ok: false,
    message,
    reached,
    answered: false,
    calledTool: false,
    tokens: null
  })

  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // Long enough for a slow reasoning model, short enough that a wrong host does not hang the
      // panel. A local server that is not running fails in milliseconds either way.
      signal: AbortSignal.timeout(90_000)
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // The single most common failure for a local provider, and the one the panel used to report
    // as an empty model list with no explanation.
    const hint = provider.local
      ? ` Is ${provider.label} running? It has to be started before this app can reach it.`
      : ''
    return failed(`Could not reach ${base}. ${detail}.${hint}`, false)
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    const explained =
      res.status === 401 || res.status === 403
        ? `${provider.label} rejected the key.`
        : res.status === 404
          ? `${base} answered, but not with a chat-completions endpoint. Check the base URL — it usually ends in /v1.`
          : res.status === 429
            ? `${provider.label} says you are out of quota or being rate limited.`
            : `${provider.label} answered HTTP ${res.status}.`
    return failed(`${explained}${detail ? ` — ${detail}` : ''}`, true)
  }

  const payload = (await res.json().catch(() => null)) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: { function?: { name?: string } }[] }
      finish_reason?: string
    }[]
    usage?: { total_tokens?: number }
  } | null

  const choice = payload?.choices?.[0]
  if (!choice) return failed(`${provider.label} answered, but with no completion in it.`, true)

  const text = (choice.message?.content ?? '').trim()
  const calls = choice.message?.tool_calls ?? []
  const calledTool = calls.some((call) => call.function?.name === 'ping')
  const tokens = payload?.usage?.total_tokens ?? null

  // A model that called the tool and said nothing has done the harder half. Both halves are
  // reported, because "it talks but cannot use your notes" and "it works" must not read alike.
  const answered = text.length > 0 || calledTool

  if (!answered) {
    return {
      ok: false,
      message:
        choice.finish_reason === 'length'
          ? `${model} used its whole allowance without answering. It may be thinking more than this check allows for; it will probably still work in a real conversation.`
          : `${model} returned an empty answer.`,
      reached: true,
      answered: false,
      calledTool: false,
      tokens
    }
  }

  if (offerTools && !calledTool) {
    return {
      ok: false,
      message: `${model} answered, but ignored the tool it was asked to call. It can talk, but the agent probably cannot use it to read or write your notes — try a model that advertises tool calling.`,
      reached: true,
      answered: true,
      calledTool: false,
      tokens
    }
  }

  return {
    ok: true,
    message: offerTools
      ? `${model} answered and called a tool. The agent can read and write your notes with it.${tokens ? ` This check cost ${tokens} tokens.` : ''}`
      : `${model} answered.${tokens ? ` This check cost ${tokens} tokens.` : ''}`,
    reached: true,
    answered: true,
    calledTool,
    tokens
  }
}

/**
 * One real Codex turn, because nothing cheaper tells the truth.
 *
 * `codex login status` answers "Logged in using ChatGPT" while the refresh token is spent, and
 * `codex debug models` reads a file the installer shipped — so both pass on a machine that cannot
 * run a single turn. The failing turn is the only honest signal there is, which is precisely why
 * the setup flow should be the one to provoke it rather than the user's first real question.
 */
function verifyCodex(binary: string, model: string): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const args = ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"']
    if (model) args.push('-m', model)
    args.push('Reply with the single word OK and nothing else.')

    const child = spawn(binary, args, {
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    // `codex exec` reads stdin when stdin is a pipe, and a spawn's default stdio is a pipe.
    child.stdin.end()

    let out = ''
    let failure = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {
      // Codex writes the same auth failure to stderr dozens of times over. The JSONL frames say
      // it once, so those are what this reads.
    })

    const done = (result: VerifyResult): void => resolve(result)

    child.on('error', (err) =>
      done({
        ok: false,
        message: `Could not run Codex: ${err.message}`,
        reached: false,
        answered: false,
        calledTool: false,
        tokens: null
      })
    )

    child.on('close', () => {
      let answered = ''
      let tokens: number | null = null

      for (const line of out.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }
        const type = String(frame['type'] ?? '')
        if (type === 'turn.failed') {
          const error = frame['error'] as { message?: string } | undefined
          failure = error?.message ?? failure
        }
        if (type === 'turn.completed') {
          const usage = frame['usage'] as { input_tokens?: number; output_tokens?: number } | undefined
          tokens = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0) || null
        }
        if (type === 'item.completed') {
          const item = frame['item'] as Record<string, unknown> | undefined
          const itemType = String(item?.['type'] ?? item?.['item_type'] ?? '')
          if (itemType === 'agent_message' && typeof item?.['text'] === 'string') {
            answered = item['text']
          }
        }
      }

      if (failure) {
        // The same translation the engine does, because a user reading "your refresh token was
        // already used" during setup has been told nothing they can act on.
        const auth = /refresh token|sign in again|401|unauthorized|token_expired/i.test(failure)
        done({
          ok: false,
          message: auth
            ? `Codex is signed out. Run \`codex login\` in a terminal, then check again. (${failure})`
            : failure,
          reached: true,
          answered: false,
          calledTool: false,
          tokens
        })
        return
      }

      if (!answered) {
        done({
          ok: false,
          message: 'Codex ran but said nothing. Try `codex exec "hello"` in a terminal to see why.',
          reached: true,
          answered: false,
          calledTool: false,
          tokens
        })
        return
      }

      done({
        ok: true,
        message: `Codex answered "${answered.trim().slice(0, 40)}".${tokens ? ` This check cost ${tokens} tokens.` : ''}`,
        reached: true,
        answered: true,
        // Codex is a whole agent; its tools are its own and are not in question here.
        calledTool: true,
        tokens
      })
    })

    // A turn that has not finished in two minutes is not going to inside a setup screen.
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill()
        done({
          ok: false,
          message: 'Codex did not answer within two minutes.',
          reached: true,
          answered: false,
          calledTool: false,
          tokens: null
        })
      }
    }, 120_000)
  })
}

export interface VerifyDeps {
  providerId: string
  model: string
  baseUrl: string
  apiKey: string | null
  /** The provider says this model takes tools. Withheld from the check when it says otherwise. */
  supportsTools: boolean
  claudeBinary: string | null
  codexBinary: string | null
}

export async function verifyEngine(deps: VerifyDeps): Promise<VerifyResult> {
  const provider = providerById(deps.providerId)
  const nothing = { reached: false, answered: false, calledTool: false, tokens: null }
  if (!provider) return { ok: false, message: `Unknown engine "${deps.providerId}".`, ...nothing }

  if (provider.engine === 'claude-cli') {
    /*
     * Not run as a turn, alone among the three.
     *
     * The Claude CLI is the engine everyone is already using, its auth is reported honestly by
     * `claude` itself, and the app has a live readout of its plan usage windows — so provoking a
     * turn here would spend from the subscription this file exists to protect to learn something
     * already on screen.
     */
    return deps.claudeBinary
      ? {
          ok: true,
          message: `Claude Code is installed and signed in. Its usage windows are in the footer.`,
          reached: true,
          answered: true,
          calledTool: true,
          tokens: null
        }
      : { ok: false, message: 'The Claude CLI is not on this machine.', ...nothing }
  }

  if (provider.engine === 'codex-cli') {
    if (!deps.codexBinary) {
      return { ok: false, message: 'The Codex CLI is not on this machine.', ...nothing }
    }
    log.info('verifying codex with one small turn')
    return await verifyCodex(deps.codexBinary, deps.model)
  }

  if (!deps.baseUrl) return { ok: false, message: `${provider.label} needs a base URL.`, ...nothing }
  if (!deps.model) return { ok: false, message: `Choose a model for ${provider.label} first.`, ...nothing }
  if (provider.needsKey && !deps.apiKey) {
    return { ok: false, message: `${provider.label} needs an API key.`, ...nothing }
  }

  log.info(`verifying ${provider.id} with one small request to ${deps.model}`)
  return await verifyApi(provider, deps.baseUrl, deps.apiKey, deps.model, deps.supportsTools)
}

/**
 * The engine layer: the choice, the dialects, and the loop.
 *
 * The loop is the only genuinely new machinery in this feature. A CLI engine is a whole agent —
 * it decides to call a tool, calls it, reads the result and carries on — while an API model only
 * ever answers "given this conversation and these tools, what next". Something has to keep
 * asking, and that something is `ApiEngine.run`. So it is driven here against a fake provider
 * and a fake tool host, over a real socket, with the assertions on the events the rest of the
 * app would have received.
 *
 * No model, no key, no external network. Both servers are started by this file.
 *
 *   node scripts/run-ts.mjs src/main/engines.probe.ts --node
 */
import { createServer, type Server } from 'node:http'
import type { EngineCapabilities } from '@shared/engines'
import { ENGINE_PROVIDERS, capabilityNotes, providerById, reasoningPatch } from '@shared/engines'
import type { ClaudeStreamEvent } from './agent/claude'
import { capabilitiesFor } from './agent/engines/factory'
import { ApiEngine } from './agent/engines/openai'

let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    console.log(`        expected ${JSON.stringify(expected)}`)
    console.log(`        actual   ${JSON.stringify(actual)}`)
  }
}

/* ------------------------------------------------------- the reasoning dialects */

console.log('reasoning dialects\n')

// Four wire formats for one idea. Getting one wrong does not error — the parameter is ignored
// and the model simply does not think, which is the most expensive kind of silent failure.
eq('openai takes a top-level string', reasoningPatch('reasoning_effort', 'high'), {
  reasoning_effort: 'high'
})
// OpenAI's ladder stops at 'high'; the app's two extra rungs are ambition, not a wire value.
eq('and the app’s extra levels clamp to it', reasoningPatch('reasoning_effort', 'max'), {
  reasoning_effort: 'high'
})
// OpenRouter accepts the whole ladder and normalises it per provider, so nothing is clamped.
eq('openrouter passes the full ladder through', reasoningPatch('openrouter', 'xhigh'), {
  reasoning: { effort: 'xhigh' }
})
eq('deepseek wants both fields', reasoningPatch('deepseek', 'medium'), {
  thinking: { type: 'enabled' },
  reasoning_effort: 'medium'
})
{
  const patch = reasoningPatch('anthropic', 'max') as { thinking?: { budget_tokens?: number } }
  check('anthropic wants a token budget', (patch.thinking?.budget_tokens ?? 0) > 10_000, patch)
}
eq('and a model with no control is sent nothing', reasoningPatch('none', 'high'), {})

/* ------------------------------------------------------------- the catalogue */

console.log('\nthe provider catalogue')

check('every provider has an id and a label', ENGINE_PROVIDERS.every((p) => p.id && p.label))
check(
  'every metered provider needs a key',
  ENGINE_PROVIDERS.filter((p) => p.metered).every((p) => p.needsKey && p.secretRef)
)
// A local server is not billed and needs no credential; treating it as metered would wake the
// spend caps for a model running on the user's own machine.
check(
  'local providers are neither metered nor keyed',
  ['ollama', 'lmstudio'].every((id) => {
    const provider = providerById(id)
    return provider !== undefined && !provider.metered && !provider.needsKey
  })
)
check(
  'every API provider has a base URL, except the one that asks for it',
  ENGINE_PROVIDERS.filter((p) => p.engine === 'openai-compatible' && p.id !== 'custom').every(
    (p) => p.baseUrl.startsWith('http')
  )
)

/* ----------------------------------------------------------- what an engine is */

console.log('\ncapabilities')

{
  const claude = capabilitiesFor({ providerId: 'claude-cli', model: 'opus' })
  check('the CLI brings its own tools', claude.builtInTools)
  check('and the account’s connectors', claude.accountConnectors)
  check('and can resume a session', claude.serverSideSessions)
  check('and is not metered', !claude.metered)
  check('and is the only source of usage windows', claude.usageWindows)

  const codex = capabilitiesFor({ providerId: 'codex-cli', model: 'gpt-5' })
  check('codex also brings its own tools', codex.builtInTools)
  // `agent_message` is reported on completion, not token by token. Declared rather than hidden,
  // because a transcript that fills in one go looks broken if nothing said it would.
  check('but does not stream text', !codex.streamsText)
  check('and has no usage windows', !codex.usageWindows)

  const api = capabilitiesFor({ providerId: 'openrouter', model: 'x/y' })
  check('an API engine has no shell', !api.builtInTools)
  check('no account connectors', !api.accountConnectors)
  check('nothing to resume', !api.serverSideSessions)
  check('and is metered', api.metered)

  // The provider is believed when it speaks. A model that does not advertise tools cannot
  // touch the vault, and that has to reach the user before they choose it.
  const toolless = capabilitiesFor({
    providerId: 'openrouter',
    model: 'x/y',
    info: {
      id: 'x/y',
      label: 'x',
      contextLength: null,
      promptPrice: null,
      completionPrice: null,
      supportsTools: false,
      supportsReasoning: false
    }
  })
  check('a model without tool calling is reported so', !toolless.toolCalling)

  const notes = capabilityNotes(toolless)
  check('and the notes lead with it', /cannot read or write your notes/i.test(notes[0] ?? ''), notes)
  check('a CLI engine has fewer caveats', capabilityNotes(capabilitiesFor({ providerId: 'claude-cli', model: 'opus' })).length < notes.length)
}

/* ------------------------------------------------------------------ the loop */

interface Fake {
  server: Server
  url: string
  /** Every chat-completions body the engine sent, in order. */
  requests: Record<string, unknown>[]
}

/**
 * A provider that answers with a scripted sequence of SSE streams.
 *
 * One entry per request the engine makes, so a tool-calling turn — ask, act, ask again — is
 * expressed as two entries and the loop's behaviour is what decides whether both are consumed.
 */
async function fakeProvider(scripts: string[][]): Promise<Fake> {
  const requests: Record<string, unknown>[] = []
  let index = 0

  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake/model', name: 'Fake' }] }))
      return
    }

    let body = ''
    req.on('data', (chunk) => (body += String(chunk)))
    req.on('end', () => {
      requests.push(JSON.parse(body || '{}') as Record<string, unknown>)
      const script = scripts[Math.min(index++, scripts.length - 1)]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of script) res.write(`data: ${frame}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, url: `http://127.0.0.1:${port}`, requests }
}

/** A tool host that offers one tool and records what was called. */
async function fakeTools(): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += String(chunk)))
    req.on('end', () => {
      const request = JSON.parse(body || '{}') as { op?: string; name?: string }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (request.op === 'list') {
        res.end(
          JSON.stringify({
            tools: [
              {
                name: 'search_notes',
                description: 'Search the vault.',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
              }
            ]
          })
        )
        return
      }
      calls.push(request.name ?? '')
      res.end(JSON.stringify({ content: 'one note found: "Kickoff"', isError: false }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, url: `http://127.0.0.1:${port}`, calls }
}

function capabilities(): EngineCapabilities {
  return capabilitiesFor({ providerId: 'openrouter', model: 'fake/model' })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function main(): Promise<void> {
  console.log('\nthe agentic loop')

  const tools = await fakeTools()

  /* --------------------------------------------- a turn that calls a tool -- */

  {
    // First response: the model asks for a tool, with the arguments split across chunks the
    // way a real stream delivers them. Second: it answers.
    const provider = await fakeProvider([
      [
        JSON.stringify({
          id: 'req1',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'search_notes', arguments: '{"qu' } }
                ]
              }
            }
          ]
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"kickoff"}' } }] } }]
        })
      ],
      [
        JSON.stringify({ id: 'req2', choices: [{ delta: { reasoning: 'weighing it up' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'You have one note about the kickoff.' } }] }),
        JSON.stringify({ usage: { prompt_tokens: 120, completion_tokens: 42 } })
      ]
    ])

    const events: ClaudeStreamEvent[] = []
    const engine = new ApiEngine(
      {
        provider: providerById('openrouter')!,
        baseUrl: provider.url,
        apiKey: 'sk-test',
        capabilities: capabilities()
      },
      {
        cwd: '.',
        model: 'fake/model',
        capability: 'curate',
        appendSystemPrompt: 'You are Second Brain.',
        mcpConfig: {},
        unattended: false,
        effort: 'high',
        toolEndpoint: { url: tools.url, token: 'tok' },
        history: [{ role: 'user', text: 'earlier question' }]
      },
      (event) => events.push(event)
    )

    engine.start()
    engine.send('what do I have about the kickoff?')

    // The loop is asynchronous all the way down; waiting for the result event is what says the
    // turn is over, rather than a fixed sleep that would be flaky under load.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (events.some((event) => event.type === 'result')) {
          clearInterval(timer)
          resolve()
        }
      }, 25)
    })

    const types = events.map((event) => event.type)
    check('the turn announced itself', types[0] === 'init', types)
    check('the tool was called', tools.calls.includes('search_notes'), tools.calls)
    eq('exactly once', tools.calls.filter((name) => name === 'search_notes').length, 1)

    // Arguments arrive in fragments and are assembled by index, not by id — the id is only on
    // the first fragment, so keying on it would start a new call for every chunk after it.
    const toolUse = events.find(
      (event) => event.type === 'assistant' && event.blocks[0]?.type === 'tool_use'
    )
    check('the call was reported to the app', toolUse !== undefined)
    if (toolUse && toolUse.type === 'assistant') {
      eq('with its assembled arguments', toolUse.blocks[0].input, { query: 'kickoff' })
    }

    check('its result came back', types.includes('tool-result'), types)
    check('thinking was forwarded', types.includes('thinking-delta'), types)
    check('and the text streamed', types.includes('text-delta'), types)

    const result = events.find((event) => event.type === 'result')
    if (result && result.type === 'result') {
      check('the turn succeeded', !result.isError, result)
      eq('carrying the final text', result.text, 'You have one note about the kickoff.')
      // Two requests: the tool call and the answer. One would mean the loop never went round.
      eq('and reporting both requests', result.numTurns, 2)
    }

    const usage = events.find((event) => event.type === 'usage')
    if (usage && usage.type === 'usage') {
      // Assigned, never added: providers send a running total for the message in flight, so
      // adding on every frame multiplies it by the number of frames.
      eq('usage is the provider’s own figure', [usage.inputTokens, usage.outputTokens], [120, 42])
    }

    /* ------------------------------------------------- what was actually sent -- */

    const first = provider.requests[0]
    check('the system prompt led the messages', Array.isArray(first['messages']), first['messages'])
    const messages = first['messages'] as { role: string; content: string }[]
    eq('with the system prompt first', messages[0].role, 'system')
    // The history is replayed because this provider keeps no session. That is the whole of what
    // makes switching engines mid-conversation work.
    check('the earlier turn was replayed', messages.some((m) => m.content === 'earlier question'), messages)
    check('and the new question sent', messages.some((m) => m.content?.includes('kickoff')), messages)
    check('the brain tools were offered', Array.isArray(first['tools']), first['tools'])
    eq('reasoning used the provider’s dialect', first['reasoning'], { effort: 'high' })

    // The second request has to carry the assistant's own tool_calls and then the tool result,
    // or the provider rejects the result as unsolicited.
    const second = provider.requests[1]
    const followUp = second['messages'] as { role: string; tool_call_id?: string }[]
    check('the assistant turn was kept', followUp.some((m) => m.role === 'assistant'), followUp)
    check('and the tool result attached to its call', followUp.some((m) => m.tool_call_id === 'call_1'), followUp)

    await close(provider.server)
  }

  /* ------------------------------------------------------ a provider that fails */

  {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid api key' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const events: ClaudeStreamEvent[] = []
    const engine = new ApiEngine(
      {
        provider: providerById('openrouter')!,
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-wrong',
        capabilities: capabilities()
      },
      {
        cwd: '.',
        model: 'fake/model',
        capability: 'curate',
        appendSystemPrompt: '',
        mcpConfig: {},
        unattended: false,
        toolEndpoint: null
      },
      (event) => events.push(event)
    )

    engine.start()
    engine.send('hello')

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (events.some((event) => event.type === 'result')) {
          clearInterval(timer)
          resolve()
        }
      }, 25)
    })

    const result = events.find((event) => event.type === 'result')
    check('a rejected key ends the turn as an error', result?.type === 'result' && result.isError)
    // The status has to survive into the message, or the user is told "it failed" and nothing
    // that would let them work out it was the key.
    check(
      'and says what the provider answered',
      result?.type === 'result' && /401/.test(result.text ?? ''),
      result
    )
    check('the failure was logged to stderr too', events.some((e) => e.type === 'stderr'))

    await close(server)
  }

  await close(tools.server)

  console.log(failures === 0 ? '\nall engine checks passed\n' : `\n${failures} check(s) failed\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main().catch((err) => {
  console.log(`FATAL ${(err as Error).stack ?? String(err)}`)
  process.exitCode = 1
})

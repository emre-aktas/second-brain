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
import {
  ENGINE_PROVIDERS,
  capabilityNotes,
  costOf,
  providerById,
  reasoningPatch,
  usagePatch
} from '@shared/engines'
import type { ClaudeStreamEvent } from './agent/claude'
import type { EngineOptions } from './agent/engine'
import { capabilitiesFor } from './agent/engines/factory'
import { ApiEngine } from './agent/engines/openai'
import { verifyEngine, type VerifyResult } from './agent/engines/verify'

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

// The same shape of problem one field over, and the same kind of silent failure: a streamed
// response reports no usage unless it is asked to, and the wrong spelling is simply ignored.
eq('usage is asked for OpenAI’s way by default', usagePatch(undefined), {
  stream_options: { include_usage: true }
})
eq('and OpenRouter’s way when it says so', usagePatch('openrouter'), { usage: { include: true } })

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

interface FakeTools {
  server: Server
  url: string
  calls: string[]
  /** Every `op: 'call'` body in full, so the session id it carried can be asserted. */
  bodies: { op?: string; name?: string; sessionId?: string | null }[]
  /** The tool list the engine was last handed, after its own capability filtering. */
  offered: string[]
}

/**
 * A tool host that offers a read tool and a write tool, and records everything.
 *
 * Two tools rather than one because the capability tier is now enforced on this side of the
 * wire: an API engine builds its own tool list, so `read-only` has to be visible as the write
 * tool being *absent* from what the model was offered.
 */
async function fakeTools(): Promise<FakeTools> {
  const calls: string[] = []
  const bodies: FakeTools['bodies'] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += String(chunk)))
    req.on('end', () => {
      const request = JSON.parse(body || '{}') as {
        op?: string
        name?: string
        sessionId?: string | null
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (request.op === 'list') {
        res.end(
          JSON.stringify({
            tools: [
              {
                name: 'search_notes',
                description: 'Search the vault.',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
              },
              {
                name: 'trash_note',
                description: 'Move a note to the trash.',
                inputSchema: { type: 'object', properties: { ref: { type: 'string' } } },
                mutating: true
              }
            ]
          })
        )
        return
      }
      bodies.push(request)
      calls.push(request.name ?? '')
      res.end(JSON.stringify({ content: 'one note found: "Kickoff"', isError: false }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, url: `http://127.0.0.1:${port}`, calls, bodies, offered: [] }
}

function capabilities(providerId = 'openrouter'): EngineCapabilities {
  return capabilitiesFor({ providerId, model: 'fake/model' })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** Everything an engine needs, with only the parts a given check cares about spelled out. */
function optionsFor(patch: Partial<EngineOptions> = {}): EngineOptions {
  return {
    cwd: '.',
    model: 'fake/model',
    capability: 'curate',
    sessionId: 'chat-7',
    appendSystemPrompt: 'You are Second Brain.',
    mcpConfig: {},
    unattended: false,
    ...patch
  }
}

/** Resolved when the engine reports a result, which is the only honest signal a turn is over. */
function settled(events: ClaudeStreamEvent[], count = 1): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (events.filter((event) => event.type === 'result').length >= count) {
        clearInterval(timer)
        resolve()
      }
    }, 25)
  })
}

/** A stream that says one thing and stops, which is most of what a fake provider needs. */
function says(text: string, extra: Record<string, unknown> = {}): string[] {
  return [
    JSON.stringify({ id: 'r', choices: [{ delta: { content: text }, finish_reason: 'stop' }] }),
    JSON.stringify({ usage: { prompt_tokens: 1_000, completion_tokens: 500 }, ...extra })
  ]
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
      optionsFor({
        effort: 'high',
        toolEndpoint: { url: tools.url, token: 'tok' },
        history: [{ role: 'user', text: 'earlier question' }]
      }),
      (event) => events.push(event)
    )

    engine.start()
    engine.send('what do I have about the kickoff?')

    // The loop is asynchronous all the way down; waiting for the result event is what says the
    // turn is over, rather than a fixed sleep that would be flaky under load.
    await settled(events)

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

    /*
     * The token counts have to be *asked for*, in this provider's own spelling.
     *
     * Nothing reports usage on a streamed response unless told to, so without this every real
     * provider reported zero and the turn meter, the cost readout and the daily spend total all
     * read from a number that never arrived. This probe's fake provider volunteered it, which is
     * precisely how the gap survived being tested.
     */
    eq('usage was asked for, OpenRouter’s way', first['usage'], { include: true })
    check('and not OpenAI’s way, on this provider', first['stream_options'] === undefined, first['stream_options'])
    // OpenRouter still takes the old spelling of the ceiling; OpenAI's current models do not.
    check('the answer is capped', typeof first['max_tokens'] === 'number', first['max_tokens'])

    /*
     * The session id goes with every tool call.
     *
     * `ask_user`, `render_ui` and `suggest_followups` all read it off the call, and it was not
     * being sent — so on an API engine a question was addressed to no conversation (filtered out
     * of chat, turn waiting until the backstop), an interface was rendered into no transcript and
     * a followup was attached to no reply. Three visible features, none of which errored.
     */
    eq('the tool call carried the session', tools.bodies[0]?.sessionId, 'chat-7')

    // The second request has to carry the assistant's own tool_calls and then the tool result,
    // or the provider rejects the result as unsolicited.
    const second = provider.requests[1]
    const followUp = second['messages'] as { role: string; tool_call_id?: string }[]
    check('the assistant turn was kept', followUp.some((m) => m.role === 'assistant'), followUp)
    check('and the tool result attached to its call', followUp.some((m) => m.tool_call_id === 'call_1'), followUp)

    await close(provider.server)
  }

  /* ------------------------------------------------- the tier, on this side of the wire */

  console.log('\nthe capability tier')

  {
    const provider = await fakeProvider([says('Nothing to delete.')])
    const events: ClaudeStreamEvent[] = []
    const engine = new ApiEngine(
      {
        provider: providerById('openrouter')!,
        baseUrl: provider.url,
        apiKey: 'sk-test',
        capabilities: capabilities()
      },
      optionsFor({ capability: 'read-only', toolEndpoint: { url: tools.url, token: 'tok' } }),
      (event) => events.push(event)
    )

    engine.start()
    engine.send('delete my kickoff note')
    await settled(events)

    /*
     * A read-only chat must not be *offered* a tool that writes.
     *
     * The CLI engines get their tier at spawn through `--disallowedTools`; this engine builds its
     * own tool list and therefore had no tier at all — `read-only` was enforced on one of three
     * engines while the panel described it as a property of the app. Withheld rather than refused
     * on call, so the model never spends a step discovering it is forbidden.
     */
    const offered = (
      (provider.requests[0]?.['tools'] as { function?: { name?: string } }[] | undefined) ?? []
    ).map((tool) => tool.function?.name)
    check('the read tool is offered', offered.includes('search_notes'), offered)
    check('the write tool is not', !offered.includes('trash_note'), offered)

    await close(provider.server)
  }

  /* ----------------------------------------------- the parameters providers disagree about */

  console.log('\nprovider parameters')

  {
    // OpenAI's current models reject `max_tokens` outright, which made every turn on the OpenAI
    // provider fail on a parameter the user never chose to send.
    const provider = await fakeProvider([says('Hello.')])
    const events: ClaudeStreamEvent[] = []
    const engine = new ApiEngine(
      {
        provider: providerById('openai')!,
        baseUrl: provider.url,
        apiKey: 'sk-test',
        capabilities: capabilities('openai')
      },
      optionsFor({ toolEndpoint: null }),
      (event) => events.push(event)
    )
    engine.start()
    engine.send('hello')
    await settled(events)

    const body = provider.requests[0] ?? {}
    check('OpenAI is sent max_completion_tokens', typeof body['max_completion_tokens'] === 'number', body['max_completion_tokens'])
    check('and never max_tokens', body['max_tokens'] === undefined, body['max_tokens'])
    eq('usage is asked for OpenAI’s way', body['stream_options'], { include_usage: true })

    await close(provider.server)
  }

  {
    /*
     * A provider that refuses a parameter, learnt from and retried.
     *
     * `custom` points anywhere and new models retire old spellings on their own schedule, so
     * being able to learn one refusal is worth more than being right about every provider in
     * advance. Only parameters that are ours qualify — a ceiling, a usage flag, a thinking level
     * — because none of them changes the answer. The user's prompt is never retried away.
     */
    const requests: Record<string, unknown>[] = []
    let first = true
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += String(chunk)))
      req.on('end', () => {
        requests.push(JSON.parse(body || '{}') as Record<string, unknown>)
        if (first) {
          first = false
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." }
            })
          )
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const frame of says('Recovered.')) res.write(`data: ${frame}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const events: ClaudeStreamEvent[] = []
    const engine = new ApiEngine(
      {
        provider: providerById('custom')!,
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        capabilities: capabilities('custom')
      },
      optionsFor({ toolEndpoint: null }),
      (event) => events.push(event)
    )
    engine.start()
    engine.send('hello')
    await settled(events)

    check('the rejected parameter was sent once', requests[0]?.['max_tokens'] !== undefined, requests[0])
    check('dropped on the retry', requests[1] !== undefined && requests[1]['max_tokens'] === undefined, requests[1])
    const result = events.find((event) => event.type === 'result')
    check(
      'and the turn succeeded rather than dying on a field the user never chose',
      result?.type === 'result' && !result.isError && result.text === 'Recovered.',
      result
    )

    await close(server)
  }

  /* -------------------------------------------------------- an answer with nothing in it */

  console.log('\nan empty answer')

  {
    /*
     * Reported as a failure with a reason, not as a successful blank message.
     *
     * A reasoning model can spend the entire ceiling on thinking and return no content — a turn
     * that cost real money and produced nothing, previously shown as an empty reply with no
     * error anywhere. `finish_reason` is the only thing that distinguishes it from a model that
     * had nothing to say.
     */
    const provider = await fakeProvider([
      [JSON.stringify({ id: 'r', choices: [{ delta: {}, finish_reason: 'length' }] })]
    ])
    const events: ClaudeStreamEvent[] = []
    const engine = new ApiEngine(
      {
        provider: providerById('openrouter')!,
        baseUrl: provider.url,
        apiKey: 'sk-test',
        capabilities: capabilities()
      },
      optionsFor({ toolEndpoint: null }),
      (event) => events.push(event)
    )
    engine.start()
    engine.send('think about everything')
    await settled(events)

    const result = events.find((event) => event.type === 'result')
    check('an empty answer is an error', result?.type === 'result' && result.isError, result)
    check(
      'and says it ran out of room',
      result?.type === 'result' && /allowance/i.test(result.text ?? ''),
      result?.type === 'result' ? result.text : result
    )

    await close(provider.server)
  }

  /* ---------------------------------------------------------------- what a turn cost */

  console.log('\nspend')

  {
    /*
     * Priced from the catalogue, because the response does not price the call.
     *
     * `costUsd` was hardcoded to zero, and zero is what the daily cap counts — so the cap the
     * Engine tab promises is "enforced while this provider is selected" could never be reached
     * however much was spent. 1000 prompt tokens at $3/M and 500 completion at $15/M is
     * 0.003 + 0.0075.
     */
    const provider = await fakeProvider([says('Costed.')])
    const events: ClaudeStreamEvent[] = []
    const engine = new ApiEngine(
      {
        provider: providerById('openrouter')!,
        baseUrl: provider.url,
        apiKey: 'sk-test',
        capabilities: capabilities(),
        info: {
          id: 'fake/model',
          label: 'Fake',
          contextLength: null,
          promptPrice: 3,
          completionPrice: 15,
          supportsTools: true,
          supportsReasoning: false
        }
      },
      optionsFor({ toolEndpoint: null }),
      (event) => events.push(event)
    )
    engine.start()
    engine.send('hello')
    await settled(events)

    const result = events.find((event) => event.type === 'result')
    check(
      'a metered turn reports what it cost',
      result?.type === 'result' && Math.abs(result.costUsd - 0.0105) < 1e-9,
      result?.type === 'result' ? result.costUsd : result
    )

    await close(provider.server)
  }

  {
    // No published price is reported as unknown, not invented. `costOf` answers null and the
    // event carries zero — which now means "nobody publishes a price" rather than "no arithmetic
    // was attempted".
    eq('an unpriced model costs nothing knowable', costOf({ inputTokens: 10, outputTokens: 10 }, { promptPrice: null, completionPrice: null }), null)
  }

  /* ------------------------------------------------------------------ images, and a queue */

  console.log('\nimages and overlapping turns')

  {
    const provider = await fakeProvider([says('I can see it.'), says('And the second one.')])
    const events: ClaudeStreamEvent[] = []
    const engine = new ApiEngine(
      {
        provider: providerById('openrouter')!,
        baseUrl: provider.url,
        apiKey: 'sk-test',
        capabilities: capabilities()
      },
      optionsFor({ toolEndpoint: null }),
      (event) => events.push(event)
    )
    engine.start()

    // Dropped with a log line before. The composer takes screenshots and pastes, so "the model
    // ignored my screenshot" was a working feature quietly not working.
    engine.send('what is in this?', [{ mediaType: 'image/png', dataBase64: 'AAAA' }])
    // And a second turn while the first is still running: silently discarded before, which left
    // the chat in `thinking` for ever because the manager had already persisted the message.
    engine.send('and now this?')

    await settled(events, 2)

    const parts = (provider.requests[0]?.['messages'] as { role: string; content: unknown }[])
      .filter((message) => Array.isArray(message.content))
      .flatMap((message) => message.content as { type: string }[])
    check('the image was sent as a content part', parts.some((part) => part.type === 'image_url'), parts)
    check('alongside the text', parts.some((part) => part.type === 'text'), parts)

    eq('the queued turn ran too', events.filter((event) => event.type === 'result').length, 2)
    check(
      'and it was the second question',
      ((provider.requests[1]?.['messages'] as { content: unknown }[]) ?? []).some(
        (message) => message.content === 'and now this?'
      ),
      provider.requests[1]?.['messages']
    )

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
      optionsFor({ appendSystemPrompt: '', toolEndpoint: null }),
      (event) => events.push(event)
    )

    engine.start()
    engine.send('hello')

    await settled(events)

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

  /* ------------------------------------------------------------ the setup check */

  console.log('\nthe end-to-end check')

  {
    /*
     * The three outcomes the setup step draws as three lights, each produced for real.
     *
     * The middle one is why it is three lights and not a verdict: a model that answers but will
     * not call a tool is not broken, it is limited, and the difference decides whether the agent
     * can touch a single note. Reporting it as a plain failure would send someone to check their
     * key; reporting it as a pass would leave them with an agent that can only talk.
     */
    const completion = (message: Record<string, unknown>): string =>
      JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { total_tokens: 42 } })

    let reply = completion({ content: 'OK' })
    let status = 200
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status === 200 ? reply : JSON.stringify({ error: { message: 'no' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const url = `http://127.0.0.1:${port}/v1`

    const run = (supportsTools: boolean): Promise<VerifyResult> =>
      verifyEngine({
        providerId: 'openrouter',
        model: 'fake/model',
        baseUrl: url,
        apiKey: 'sk-test',
        supportsTools,
        claudeBinary: null,
        codexBinary: null
      })

    // Answers, but ignores the tool it was asked to call.
    const talksOnly = await run(true)
    check('a model that ignores tools does not pass', !talksOnly.ok, talksOnly)
    check('but it is credited with answering', talksOnly.answered && !talksOnly.calledTool, talksOnly)
    check(
      'and told what that costs them',
      /cannot use it to read or write your notes/i.test(talksOnly.message),
      talksOnly.message
    )

    // Answers and calls the tool: the whole path, proven.
    reply = completion({
      content: 'OK',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }]
    })
    const works = await run(true)
    check('a model that calls the tool passes', works.ok, works)
    check('with all three lights on', works.reached && works.answered && works.calledTool, works)
    check('and reports what the check cost', works.tokens === 42, works.tokens)

    // A key the provider refuses, named as a key problem rather than as "it failed".
    status = 401
    const rejected = await run(true)
    check('a rejected key is reported as one', !rejected.ok && /rejected the key/i.test(rejected.message), rejected)
    check('and it is known to have been reached', rejected.reached, rejected)

    // Nothing listening at all, which for a local server is the everyday case.
    const unreachable = await verifyEngine({
      providerId: 'ollama',
      model: 'llama',
      // Port 1 is reserved and nothing binds it, so this fails at connect rather than on a status.
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: null,
      supportsTools: true,
      claudeBinary: null,
      codexBinary: null
    })
    check('an unreachable endpoint never claims to have been reached', !unreachable.reached, unreachable)
    check(
      'and a local server is asked whether it is running',
      /is Ollama running/i.test(unreachable.message),
      unreachable.message
    )

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

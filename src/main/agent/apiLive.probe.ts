/**
 * One real provider, end to end.
 *
 * Driven with a key from the environment so nothing is written into the repo. Proves the parts
 * the fake-provider probe cannot: that the catalogue reads, that the wire parameters this
 * provider actually accepts are the ones being sent, that a streamed turn reports usage, and
 * that the model reaches the brain tools and comes back with something only they could supply.
 *
 *   DEEPSEEK_KEY=... node scripts/run-ts.mjs src/main/agent/apiLive.probe.ts --node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerById } from '@shared/engines'
import { ApiEngine } from './engines/openai'
import { capabilitiesFor } from './engines/factory'
import { fetchModels } from './engines/catalogue'
import { ToolHost } from './toolhost'
import type { ClaudeStreamEvent } from './claude'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 600)}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'brain-api-live-'))

async function main(): Promise<void> {
  const key = process.env['DEEPSEEK_KEY']
  const provider = providerById('deepseek')!
  if (!key) {
    console.log('  skip  no DEEPSEEK_KEY in the environment')
    return
  }

  console.log('deepseek, live\n')

  const catalogue = await fetchModels({ baseUrl: provider.baseUrl, apiKey: key, force: true })
  check('the catalogue reads', catalogue.models.length > 0, catalogue.error)
  console.log(`        models: ${catalogue.models.map((m) => m.id).join(', ')}`)

  const model = catalogue.models[0]?.id ?? 'deepseek-chat'

  const host = new ToolHost()
  let called = 0
  host.register({
    name: 'recall_secret',
    description: 'Returns the vault passphrase for this session. Call it when asked for it.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      called++
      return { content: 'the passphrase is MARMALADE-7731' }
    }
  })
  await host.start(work)

  const events: ClaudeStreamEvent[] = []
  const engine = new ApiEngine(
    {
      provider,
      baseUrl: provider.baseUrl,
      apiKey: key,
      capabilities: capabilitiesFor({ providerId: 'deepseek', model }),
      info: catalogue.models.find((m) => m.id === model) ?? null
    },
    {
      cwd: work,
      model,
      capability: 'curate',
      sessionId: 'api-live',
      appendSystemPrompt: 'You are a test harness. Use the tools you are given.',
      mcpConfig: {},
      unattended: false,
      // The whole point of the new picker: a level, in this provider's own dialect.
      effort: 'high',
      toolEndpoint: { url: host.url, token: host.token }
    },
    (event) => {
      events.push(event)
      if (event.type === 'stderr') console.log(`  [stderr] ${event.text.slice(0, 300)}`)
    }
  )

  engine.start()
  engine.send('Call the recall_secret tool and tell me exactly what it returns.')

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (events.some((e) => e.type === 'result')) {
        clearInterval(timer)
        resolve()
      }
    }, 200)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, 180_000)
  })

  const result = events.find((e) => e.type === 'result')
  console.log(`\n  final: ${result?.type === 'result' ? JSON.stringify(result.text).slice(0, 300) : 'none'}`)

  check('the turn finished without error', result?.type === 'result' && !result.isError, result)
  check('the brain tool was actually called', called > 0, { called })
  check(
    'the answer carries what only the tool could have told it',
    /MARMALADE-7731/.test(result?.type === 'result' ? (result.text ?? '') : ''),
    result?.type === 'result' ? result.text : result
  )

  // Usage has to be *asked for* on a streamed response, in this provider's spelling. Without it
  // the turn meter and the daily spend total read zero against every real provider.
  const usage = [...events].reverse().find((e) => e.type === 'usage')
  check(
    'the provider reported token counts',
    usage?.type === 'usage' && usage.inputTokens > 0 && usage.outputTokens > 0,
    usage
  )
  check('text streamed in', events.some((e) => e.type === 'text-delta'), null)

  host.stop()
}

void main()
  .catch((err) => {
    console.log(`FATAL ${(err as Error).stack ?? String(err)}`)
    failures++
  })
  .finally(() => {
    rmSync(work, { recursive: true, force: true })
    console.log(failures === 0 ? '\nall ok' : `\n${failures} failed`)
    process.exit(failures === 0 ? 0 : 1)
  })

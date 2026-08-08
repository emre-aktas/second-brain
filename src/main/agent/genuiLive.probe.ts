/**
 * Does the engine actually answer *through the interface*, rather than in prose.
 *
 * `render_ui` is the one instruction the prompt has to actively push a model into: reading is
 * self-evident from a tool's description, but "do not describe this table, build it" is a habit
 * the prompt installs. So it is the first thing to stop working when the prompt describes tools
 * the engine cannot see — which is exactly what "mcp__brain__*" did on Codex and on every API
 * model, and the symptom was a correct answer in plain paragraphs.
 *
 * Runs the real system prompt against the real engine with the real tool host.
 *
 *   ENGINE=codex node scripts/run-ts.mjs src/main/agent/genuiLive.probe.ts --node
 *   ENGINE=deepseek DEEPSEEK_KEY=... node scripts/run-ts.mjs src/main/agent/genuiLive.probe.ts --node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerById } from '@shared/engines'
import { CodexEngine } from './engines/codex'
import { ApiEngine } from './engines/openai'
import { capabilitiesFor, resolveCodexBinary } from './engines/factory'
import { fetchModels } from './engines/catalogue'
import { buildSystemPrompt } from './prompt'
import { ToolHost } from './toolhost'
import type { AgentEngine } from './engine'
import type { ClaudeStreamEvent } from './claude'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 500)}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'brain-genui-'))

async function main(): Promise<void> {
  const which = process.env['ENGINE'] ?? 'codex'
  const providerId = which === 'codex' ? 'codex-cli' : 'deepseek'
  console.log(`generated UI, live (${providerId})\n`)

  const host = new ToolHost()
  const calls: string[] = []
  host.register({
    name: 'search_notes',
    description: 'Search the vault for notes matching a query.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    handler: (args) => {
      calls.push('search_notes')
      void args
      return {
        content: JSON.stringify([
          { id: 'n1', title: 'Reka', open: 4, done: 11 },
          { id: 'n2', title: 'WasteLogics', open: 7, done: 3 },
          { id: 'n3', title: 'Goodspeed case study', open: 2, done: 9 }
        ])
      }
    }
  })
  host.register({
    name: 'render_ui',
    description:
      'Render a live interface beside your reply instead of describing data in prose. Pass a spec object matching the Generated UI schema in your instructions.',
    inputSchema: { type: 'object', properties: { spec: { type: 'object' } } },
    handler: () => {
      calls.push('render_ui')
      return { content: 'Rendered. It is now visible to the user — do not repeat its contents.' }
    }
  })
  await host.start(work)

  const capabilities = capabilitiesFor({
    providerId,
    model: which === 'codex' ? '' : 'deepseek-v4-flash'
  })

  const systemPrompt = buildSystemPrompt({
    workspaceRoot: work,
    vaultDir: join(work, 'vault'),
    integrationsDir: join(work, 'integrations'),
    capability: 'curate',
    stats: { nodes: 3, edges: 2, notes: 3, tags: 1, stubs: 0, orphans: 0, clusters: 1 },
    engine: capabilities
  })
  console.log(`  system prompt: ${systemPrompt.length} chars`)
  // The whole point of the fix: the names in the prompt are the names the engine uses.
  check(
    'the prompt names the tools the way this engine does',
    capabilities.toolPrefix
      ? systemPrompt.includes('mcp__brain__render_ui')
      : systemPrompt.includes('render_ui') && !systemPrompt.includes('mcp__brain__render_ui'),
    capabilities.toolPrefix
  )
  check(
    'and only mentions ToolSearch where it exists',
    capabilities.deferredTools === systemPrompt.includes('ToolSearch call'),
    capabilities.deferredTools
  )

  const options = {
    cwd: work,
    model: capabilities.model,
    capability: 'curate' as const,
    sessionId: 'genui-probe',
    appendSystemPrompt: systemPrompt,
    mcpConfig: {
      mcpServers: {
        brain: {
          command: process.execPath,
          args: [host.bridgePath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            BRAIN_URL: host.url,
            BRAIN_TOKEN: host.token,
            BRAIN_SESSION_ID: 'genui-probe',
            BRAIN_DENY: ''
          }
        }
      }
    },
    resumeSessionId: null,
    maxBudgetUsd: null,
    effort: null,
    unattended: false,
    toolEndpoint: { url: host.url, token: host.token }
  }

  const events: ClaudeStreamEvent[] = []
  const sink = (event: ClaudeStreamEvent): void => {
    events.push(event)
    if (event.type === 'assistant') {
      for (const block of event.blocks) {
        if (block.type === 'tool_use') console.log(`  [tool] ${block.name}`)
      }
    }
  }

  let engine: AgentEngine
  if (which === 'codex') {
    const binary = resolveCodexBinary()
    if (!binary) {
      console.log('  skip  codex is not installed')
      return
    }
    engine = new CodexEngine(binary, options, capabilities, sink)
  } else {
    const key = process.env['DEEPSEEK_KEY']
    if (!key) {
      console.log('  skip  no DEEPSEEK_KEY')
      return
    }
    const provider = providerById('deepseek')!
    const catalogue = await fetchModels({ baseUrl: provider.baseUrl, apiKey: key, force: false })
    engine = new ApiEngine(
      {
        provider,
        baseUrl: provider.baseUrl,
        apiKey: key,
        capabilities,
        info: catalogue.models.find((m) => m.id === capabilities.model) ?? null
      },
      options,
      sink
    )
  }

  engine.start()
    /*
   * Deliberately vague, because that is where it broke.
   *
   * "Search my notes for X" leaves the model nothing to decide; "ben kimim?" makes it choose
   * whether to look at all — and that is the turn in which it announced the tools were withheld
   * rather than trying one. A probe that only asks the easy question passes while the reported
   * behaviour stands.
   */
  engine.send(process.env['ASK'] || 'ben kimim?')

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
    }, 240_000)
  })

  const result = events.find((e) => e.type === 'result')
  console.log(`\n  final: ${result?.type === 'result' ? JSON.stringify(result.text).slice(0, 220) : 'none'}`)
  console.log(`  tools called: ${calls.join(', ') || '(none)'}`)

  /*
   * Always: it looked.
   *
   * This is the regression guard. An earlier version of the prompt told the engine that a tool
   * missing from its list was withheld by the permission tier — which, on a client that shows
   * the tools under a namespace, handed the model a ready-made excuse: it announced that
   * `search_notes` and `recall` were closed to it, in a chat whose tier allowed both, without
   * having called either. A refusal is a finding; an assumption is not.
   */
  check('it searched the vault rather than declaring the tools unavailable', calls.includes('search_notes'), calls)

  /*
   * And, when the answer has a shape, it built one.
   *
   * Only asserted for the question that has structure in it. "Who am I?" is legitimately a
   * paragraph, and demanding an interface for it would be testing the probe's opinion rather
   * than the app's rule — which is about numbers, comparisons, sequences and lists.
   */
  if (process.env['EXPECT_UI']) {
    check('and answered through the interface rather than in prose', calls.includes('render_ui'), calls)
  }

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

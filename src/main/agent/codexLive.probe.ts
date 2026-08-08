/**
 * Codex, end to end, against the real CLI and the real tool host.
 *
 * The only check that can answer the question the stub probe cannot: does Codex *actually reach
 * the brain tools*. `codex.probe.ts` proves the arguments are well-formed and that the paths
 * survive Codex's own config parser; it cannot prove that the MCP server starts, that the tools
 * appear, or that a call comes back with anything in it. Every one of those failed silently at
 * some point, and each looked from the app like the model declining to use its tools.
 *
 * This spends one small turn on the signed-in ChatGPT account, which is why it is not in the
 * default suite — the same reason `agent.probe.ts` is not.
 *
 *   node scripts/run-ts.mjs src/main/agent/codexLive.probe.ts --node
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexEngine } from './engines/codex'
import { capabilitiesFor, resolveCodexBinary } from './engines/factory'
import { ToolHost } from './toolhost'
import type { ClaudeStreamEvent } from './claude'

let failures = 0

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 800)}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'brain-codex-live-'))

async function main(): Promise<void> {
  console.log('codex, live\n')

  const binary = resolveCodexBinary()
  if (!binary) {
    console.log('  skip  codex is not installed')
    return
  }

  /*
   * A tool host with one unmistakable tool.
   *
   * `recall_secret` returns a value the model cannot possibly know, so a reply containing it is
   * proof the whole chain worked — MCP server started, tools listed, call made, result read —
   * rather than proof the model said something agreeable.
   */
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
  console.log(`  tool host: ${host.url}`)

  const events: ClaudeStreamEvent[] = []
  const engine = new CodexEngine(
    binary,
    {
      cwd: work,
      model: '',
      capability: 'curate',
      sessionId: 'live-probe',
      appendSystemPrompt:
        'You are a test harness. Answer only using the tools you have been given.',
      mcpConfig: {
        mcpServers: {
          brain: {
            command: process.execPath,
            args: [host.bridgePath],
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              BRAIN_URL: host.url,
              BRAIN_TOKEN: host.token,
              BRAIN_SESSION_ID: 'live-probe',
              BRAIN_DENY: '',
              BRAIN_BRIDGE_LOG: join(work, 'bridge.log')
            }
          }
        }
      },
      resumeSessionId: null,
      maxBudgetUsd: null,
      effort: null,
      unattended: false
    },
    capabilitiesFor({ providerId: 'codex-cli', model: '' }),
    (event) => {
      events.push(event)
      if (event.type === 'stderr') console.log(`  [stderr] ${event.text.trim().slice(0, 300)}`)
      if (event.type === 'assistant') {
        for (const block of event.blocks) {
          if (block.type === 'tool_use') console.log(`  [tool]   ${block.name}`)
        }
      }
      if (event.type === 'tool-result') {
        console.log(`  [result] error=${event.isError} ${JSON.stringify(event.content).slice(0, 400)}`)
      }
    }
  )

  engine.start()
  engine.send('Call the recall_secret tool and tell me exactly what it returns.')

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (events.some((event) => event.type === 'result')) {
        clearInterval(timer)
        resolve()
      }
    }, 200)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, 180_000)
  })

  const result = events.find((event) => event.type === 'result')
  console.log(`\n  final: ${result?.type === 'result' ? JSON.stringify(result.text).slice(0, 400) : 'none'}`)

  check('the turn finished', result?.type === 'result', result)
  check('it did not fail', result?.type === 'result' && !result.isError, result)
  // The whole point: the MCP server started and the tool ran in this process.
  check('the brain tool was actually called', called > 0, { called })
  const toolResults = events.filter((event) => event.type === 'tool-result')
  check('and its result came back non-empty', toolResults.some((event) => event.type === 'tool-result' && event.content.length > 2), toolResults)
  check(
    'the answer carries what only the tool could have told it',
    /MARMALADE-7731/.test(result?.type === 'result' ? (result.text ?? '') : ''),
    result?.type === 'result' ? result.text : result
  )

  try {
    console.log('\n--- bridge log ---')
    console.log(readFileSync(join(work, 'bridge.log'), 'utf8').slice(-2500))
  } catch {
    console.log('  (no bridge log: the MCP server never started)')
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

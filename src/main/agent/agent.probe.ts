/**
 * End-to-end probe for the agent bridge.
 *
 * Validates, in one shot: the claude CLI flag set, bidirectional stream-json,
 * the generated stdio MCP bridge, the MCP handshake, tool listing, a real tool
 * call round trip, and our event parsing.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolHost } from './toolhost'
import { ClaudeProcess, claudeVersion, resolveClaudeBinary, type ClaudeStreamEvent } from './claude'

const seen = {
  init: false,
  mcpStatusAtInit: 'n/a',
  brainToolsAdvertised: 0,
  toolListCalled: false,
  toolCalled: false,
  toolResultReceived: false,
  magicEchoed: false,
  textStreamed: false,
  result: false
}

const MAGIC = 'PROBE-7X4K9'
const workDir = mkdtempSync(join(tmpdir(), 'brain-agent-probe-'))
const bridgeLog = join(workDir, 'bridge.log')

const binary = resolveClaudeBinary()
if (!binary) {
  console.error('FAIL: claude CLI not found')
  process.exit(1)
}
console.log(`claude binary : ${binary}`)
console.log(`claude version: ${claudeVersion(binary)}`)

const host = new ToolHost()

host.register({
  name: 'get_probe_token',
  description:
    'Returns the secret probe token for this session. The token is not knowable any other way.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    seen.toolCalled = true
    return { content: `The probe token is ${MAGIC}` }
  }
})

host.register({
  name: 'count_notes',
  description: 'Returns how many notes exist in the vault.',
  inputSchema: {
    type: 'object',
    properties: { kind: { type: 'string', description: 'Optional kind filter.' } }
  },
  handler: () => ({ content: 'There are 42 notes.' })
})

// Wrap list() so we can prove the bridge really performed tools/list.
const originalList = host.list.bind(host)
host.list = () => {
  seen.toolListCalled = true
  return originalList()
}

let streamedText = ''
let proc: ClaudeProcess

/**
 * Built only after host.start() has run, because that is what writes the bridge
 * and populates host.bridgePath. Constructing the config earlier hands claude an
 * empty command path and the spawn fails silently.
 */
function buildMcpConfig(): Record<string, unknown> {
  if (!host.bridgePath) throw new Error('bridge path is empty — host.start() has not run yet')

  return {
    mcpServers: {
      brain: {
        command: process.execPath,
        args: [host.bridgePath],
        env: {
          // Lets the Electron binary act as a plain Node runtime, so the bridge
          // works in a packaged app with no Node installed.
          ELECTRON_RUN_AS_NODE: '1',
          BRAIN_URL: host.url,
          BRAIN_TOKEN: host.token,
          BRAIN_SESSION_ID: 'probe-session',
          BRAIN_BRIDGE_LOG: bridgeLog
        }
      }
    }
  }
}

function handleEvent(): (event: ClaudeStreamEvent) => void {
  return (event: ClaudeStreamEvent) => {
    switch (event.type) {
      case 'init': {
        seen.init = true
        const brain = event.mcpServers?.find((s) => s.name === 'brain')
        seen.mcpStatusAtInit = brain?.status ?? 'absent'
        seen.brainToolsAdvertised = (event.tools ?? []).filter((t) => t.startsWith('mcp__brain__')).length
        console.log(`\n[init] session=${event.claudeSessionId} model=${event.model}`)
        console.log(`[init] mcp servers: ${JSON.stringify(event.mcpServers)}`)
        console.log(`[init] brain tools advertised: ${seen.brainToolsAdvertised}`)
        break
      }
      case 'text-delta':
        seen.textStreamed = true
        streamedText += event.text
        break
      case 'assistant': {
        for (const block of event.blocks) {
          if (block.type === 'tool_use') {
            console.log(`[tool_use] ${block.name} ${JSON.stringify(block.input)}`)
          }
        }
        break
      }
      case 'tool-result':
        seen.toolResultReceived = true
        console.log(`[tool_result] isError=${event.isError} ${event.content.slice(0, 120)}`)
        break
      case 'result':
        seen.result = true
        seen.magicEchoed = (event.text ?? '').includes(MAGIC) || streamedText.includes(MAGIC)
        console.log(`\n[result] subtype=${event.subtype} isError=${event.isError}`)
        console.log(`[result] cost=$${event.costUsd} duration=${event.durationMs}ms turns=${event.numTurns}`)
        console.log(`[result] text: ${event.text}`)
        finish()
        break
      case 'stderr':
        if (!/^\s*$/.test(event.text)) {
          const limit = process.env['PROBE_DEBUG'] ? 4000 : 300
          console.error(`[stderr] ${event.text.slice(0, limit)}`)
        }
        break
      case 'parse-error':
        console.error(`[parse-error] ${event.line}`)
        break
      case 'exit':
        console.log(`[exit] code=${event.code} signal=${event.signal}`)
        break
    }
  }
}

let finished = false
function finish(): void {
  if (finished) return
  finished = true

  proc?.stop()
  host.stop()

  // MCP servers are still connecting when `init` is emitted, so the status and
  // tool count reported there are informational only — what matters is whether
  // the tools reached the model by the time it needed them.
  console.log(
    `\n[info] at init: mcp status="${seen.mcpStatusAtInit}" brain tools advertised=${seen.brainToolsAdvertised}`
  )

  console.log('\n--- checks ---')
  const checks: [string, boolean][] = [
    ['init event received', seen.init],
    ['bridge performed tools/list', seen.toolListCalled],
    ['model invoked a brain tool', seen.toolCalled],
    ['tool result travelled back', seen.toolResultReceived],
    ['tool output reached the answer', seen.magicEchoed],
    ['text streamed incrementally', seen.textStreamed],
    ['result event received', seen.result]
  ]

  let failures = 0
  for (const [label, pass] of checks) {
    if (!pass) failures++
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`)
  }

  console.log('\n--- bridge log ---')
  try {
    console.log(readFileSync(bridgeLog, 'utf8').trim() || '(empty)')
  } catch {
    console.log('(no bridge log — the bridge process was never started)')
  }

  // The bridge child may still hold the directory open; cleanup is best-effort.
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* the OS will reclaim it from temp */
  }
  console.log(failures === 0 ? '\nPROBE PASS' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

const timeout = setTimeout(() => {
  console.error('\nTIMEOUT after 180s')
  finish()
}, 180_000)
timeout.unref()

async function main(): Promise<void> {
  await host.start(workDir)
  console.log(`tool host     : ${host.url}`)
  console.log(`bridge script : ${host.bridgePath}`)

  proc = new ClaudeProcess(
    {
      binary: binary!,
      cwd: workDir,
      model: 'sonnet',
      capability: 'read-only',
      appendSystemPrompt:
        'You are running inside an automated probe. Use the mcp__brain__* tools when asked. Answer in one short sentence.',
      mcpConfig: buildMcpConfig(),
      extraArgs: []
    },
    handleEvent()
  )

  proc.start()
  proc.send(
    'Call the get_probe_token tool and tell me the exact token it returns. Then call count_notes and tell me the number.'
  )
}

void main().catch((err) => {
  console.error('probe setup failed', err)
  process.exit(1)
})

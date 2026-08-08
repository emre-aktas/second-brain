/**
 * Isolates the generated stdio MCP bridge from Claude Code: drives it directly
 * with JSON-RPC frames so a failure here is unambiguously ours.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolHost } from './toolhost'

const workDir = mkdtempSync(join(tmpdir(), 'brain-bridge-probe-'))
const host = new ToolHost()

host.register({
  name: 'echo_probe',
  description: 'Echoes the value back.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value']
  },
  handler: (args) => ({ content: `echo:${String(args['value'])}` })
})

host.register({
  name: 'always_fails',
  description: 'Returns an error result.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => {
    throw new Error('intentional failure')
  }
})

const responses = new Map<number, unknown>()
let notificationsSeen = 0

async function main(): Promise<void> {
  await host.start(workDir)
  console.log(`tool host : ${host.url}`)
  console.log(`bridge    : ${host.bridgePath}`)
  console.log(`runtime   : ${process.execPath}`)

  const child = spawn(process.execPath, [host.bridgePath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BRAIN_URL: host.url,
      BRAIN_TOKEN: host.token,
      BRAIN_SESSION_ID: 'bridge-probe',
      // The capability tier, as the manager passes it. Claude also gets `--disallowedTools`, but
      // Codex has no equivalent flag — so without this gate a read-only Codex chat had a
      // read-only sandbox and full write access to the vault through the brain tools.
      BRAIN_DENY: 'always_fails',
      BRAIN_BRIDGE_DEBUG: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => process.stderr.write(`[bridge stderr] ${chunk}`))

  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
        if (msg.id !== undefined) responses.set(msg.id, msg.result ?? { error: msg.error })
        else notificationsSeen++
        console.log(`<- ${line.slice(0, 300)}`)
      } catch {
        console.log(`<- (unparseable) ${line.slice(0, 200)}`)
      }
    }
  })

  const write = (obj: unknown): void => {
    const line = JSON.stringify(obj)
    console.log(`-> ${line.slice(0, 200)}`)
    child.stdin.write(`${line}\n`)
  }

  const waitFor = async (id: number, ms = 15000): Promise<unknown> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (responses.has(id)) return responses.get(id)
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out waiting for response ${id}`)
  }

  write({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1.0.0' }
    }
  })
  const init = (await waitFor(1)) as { protocolVersion?: string; capabilities?: unknown; serverInfo?: unknown }

  write({ jsonrpc: '2.0', method: 'notifications/initialized' })

  write({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = (await waitFor(2)) as { tools?: { name: string }[] }

  write({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'echo_probe', arguments: { value: 'hello-bridge' } }
  })
  const call = (await waitFor(3)) as { content?: { type: string; text: string }[]; isError?: boolean }

  write({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'always_fails', arguments: {} } })
  const denied = (await waitFor(4)) as { content?: { type: string; text: string }[]; isError?: boolean }

  write({ jsonrpc: '2.0', id: 5, method: 'ping' })
  const ping = await waitFor(5)

  write({ jsonrpc: '2.0', id: 6, method: 'nonsense/method' })
  const unknown = (await waitFor(6)) as { error?: { code: number } }

  const checks: [string, boolean][] = [
    ['initialize echoes the protocol version', init?.protocolVersion === '2025-06-18'],
    ['initialize advertises serverInfo', !!init?.serverInfo],
    ['tools/list withholds what the tier denies', (tools?.tools?.length ?? 0) === 1],
    ['tool names are unprefixed', tools?.tools?.some((t) => t.name === 'echo_probe') === true],
    ['tools/call round trips', call?.content?.[0]?.text === 'echo:hello-bridge'],
    ['successful call is not flagged as error', call?.isError === false],
    // Refused as well as hidden: a model that learned the name elsewhere must not get through by
    // asking for it directly.
    ['a denied tool is refused when asked for by name', denied?.isError === true],
    ['and told why, so it can say what it would have changed', (denied?.content?.[0]?.text ?? '').includes('read-only')],
    ['ping answered', !!ping],
    ['unknown method returns -32601', (unknown as { error?: { code: number } })?.error?.code === -32601],
    ['notifications produced no response frames', notificationsSeen === 0]
  ]

  let failures = 0
  console.log('\n--- checks ---')
  for (const [label, pass] of checks) {
    if (!pass) failures++
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`)
  }

  child.kill()
  host.stop()
  console.log(failures === 0 ? '\nBRIDGE PASS' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('bridge probe failed', err)
  process.exit(1)
})

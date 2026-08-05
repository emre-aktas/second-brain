/**
 * Finds which flag/command combination actually causes Claude Code to spawn our
 * stdio MCP server. Success is detected by the bridge creating its log file, so
 * no model turn is needed and the probe costs no tokens.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolHost } from './toolhost'
import { resolveClaudeBinary } from './claude'

const binary = resolveClaudeBinary()
if (!binary) {
  console.error('claude CLI not found')
  process.exit(1)
}

const workDir = mkdtempSync(join(tmpdir(), 'brain-spawn-probe-'))
const host = new ToolHost()

let listHits = 0
host.register({
  name: 'probe_alpha',
  description: 'Probe tool.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => ({ content: 'alpha' })
})
const originalList = host.list.bind(host)
host.list = () => {
  listHits++
  return originalList()
}

interface Case {
  label: string
  command: string
  partialMessages: boolean
  strict: boolean
  disallowed: string[]
}

function buildCases(): Case[] {
  const electron = process.execPath
  return [
    { label: 'electron + partial + strict', command: electron, partialMessages: true, strict: true, disallowed: [] },
    { label: 'electron + NO partial + strict', command: electron, partialMessages: false, strict: true, disallowed: [] },
    { label: 'electron + partial + NO strict', command: electron, partialMessages: true, strict: false, disallowed: [] },
    { label: 'node + partial + strict', command: 'node', partialMessages: true, strict: true, disallowed: [] },
    {
      label: 'electron + partial + strict + disallowed',
      command: electron,
      partialMessages: true,
      strict: true,
      disallowed: ['Bash', 'Write', 'Edit', 'mcp__brain__create_note']
    }
  ]
}

interface Outcome {
  label: string
  bridgeStarted: boolean
  framesSeen: string[]
  listHits: number
  mcpStatusAtInit: string
  sawInit: boolean
  stderrHint: string
}

function runCase(testCase: Case, index: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const logFile = join(workDir, `bridge-${index}.log`)
    const startingHits = listHits

    const mcpConfig = {
      mcpServers: {
        brain: {
          command: testCase.command,
          args: [host.bridgePath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            BRAIN_URL: host.url,
            BRAIN_TOKEN: host.token,
            BRAIN_SESSION_ID: `spawn-probe-${index}`,
            BRAIN_BRIDGE_LOG: logFile
          }
        }
      }
    }

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--model', 'sonnet',
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', JSON.stringify(mcpConfig)
    ]
    if (testCase.partialMessages) args.push('--include-partial-messages')
    if (testCase.strict) args.push('--strict-mcp-config')
    if (testCase.disallowed.length) args.push('--disallowedTools', testCase.disallowed.join(','))

    const child = spawn(binary!, args, {
      cwd: workDir,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let sawInit = false
    let mcpStatusAtInit = 'n/a'
    let stderrText = ''
    let buffer = ''
    let settled = false

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      stderrText += c
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          if (msg['type'] === 'system' && msg['subtype'] === 'init') {
            sawInit = true
            const servers = Array.isArray(msg['mcp_servers'])
              ? (msg['mcp_servers'] as { name: string; status: string }[])
              : []
            mcpStatusAtInit = servers.find((s) => s.name === 'brain')?.status ?? 'absent'
          }
        } catch {
          /* ignore */
        }
      }
    })

    const done = (): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(cap)
      try {
        child.kill()
      } catch {
        /* ignore */
      }

      let frames: string[] = []
      if (existsSync(logFile)) {
        frames = readFileSync(logFile, 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.includes('<-'))
          .map((l) => l.slice(l.indexOf('<-')))
      }

      resolve({
        label: testCase.label,
        bridgeStarted: existsSync(logFile),
        framesSeen: frames,
        listHits: listHits - startingHits,
        mcpStatusAtInit,
        sawInit,
        stderrHint: stderrText.split(/\r?\n/).find((l) => /error/i.test(l))?.slice(0, 160) ?? ''
      })
    }

    // Poll for the bridge's log file: the moment it exists, the spawn worked.
    const poll = setInterval(() => {
      if (existsSync(logFile) && listHits > startingHits) done()
    }, 250)

    const cap = setTimeout(done, 30_000)

    // A trivial prompt is needed to get past startup into a session.
    child.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })}\n`
    )
  })
}

async function main(): Promise<void> {
  await host.start(workDir)
  console.log(`tool host : ${host.url}`)
  console.log(`bridge    : ${host.bridgePath}`)
  console.log(`electron  : ${process.execPath}\n`)

  const cases = buildCases()
  const outcomes: Outcome[] = []

  for (let i = 0; i < cases.length; i++) {
    process.stdout.write(`${cases[i].label} … `)
    const outcome = await runCase(cases[i], i)
    outcomes.push(outcome)
    console.log(
      `bridgeStarted=${outcome.bridgeStarted} listHits=${outcome.listHits} mcpAtInit=${outcome.mcpStatusAtInit} frames=${outcome.framesSeen.length}${outcome.stderrHint ? ` err="${outcome.stderrHint}"` : ''}`
    )
  }

  console.log('\n--- summary ---')
  for (const o of outcomes) {
    console.log(`${(o.bridgeStarted && o.listHits > 0 ? 'SPAWNS' : 'no spawn').padEnd(9)} ${o.label}`)
    if (o.framesSeen.length) console.log(`          frames: ${o.framesSeen.join(' ')}`)
  }

  host.stop()
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  process.exit(0)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * Diagnoses why the MCP server does not reach "connected": runs the CLI with
 * MCP debug logging, records every hit on our tool host, and compares a runtime
 * path containing spaces against a space-free copy.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ToolHost } from './toolhost'
import { resolveClaudeBinary } from './claude'

const binary = resolveClaudeBinary()
if (!binary) {
  console.error('claude CLI not found')
  process.exit(1)
}

const workDir = mkdtempSync(join(tmpdir(), 'brain-mcpdebug-'))

let rpcHits = 0
const host = new ToolHost()
host.register({
  name: 'probe_alpha',
  description: 'First probe tool.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => ({ content: 'alpha' })
})
const originalList = host.list.bind(host)
host.list = () => {
  rpcHits++
  console.log(`   >>> tool host received tools/list (hit #${rpcHits})`)
  return originalList()
}

interface Attempt {
  label: string
  command: string
  args: string[]
}

function runAttempt(attempt: Attempt, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const mcpConfig = {
      mcpServers: {
        brain: {
          command: attempt.command,
          args: attempt.args,
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            BRAIN_URL: host.url,
            BRAIN_TOKEN: host.token,
            BRAIN_SESSION_ID: 'mcpdebug',
            BRAIN_BRIDGE_DEBUG: '1'
          }
        }
      }
    }

    console.log(`\n=== ${attempt.label} ===`)
    console.log(`command: ${attempt.command}`)
    console.log(`args:    ${JSON.stringify(attempt.args)}`)

    const child = spawn(
      binary!,
      [
        '--print',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--verbose',
        '--model', 'sonnet',
        '--permission-mode', 'bypassPermissions',
        '--mcp-config', JSON.stringify(mcpConfig),
        '--strict-mcp-config',
        '--debug', 'mcp'
      ],
      {
        cwd: workDir,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (/mcp|brain|bridge|spawn|ENOENT|error/i.test(trimmed)) {
          console.log(`   [stderr] ${trimmed.slice(0, 400)}`)
        }
      }
    })

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
          const msg = JSON.parse(line) as Record<string, unknown>
          if (msg['type'] === 'system' && msg['subtype'] === 'init') {
            const tools = Array.isArray(msg['tools']) ? (msg['tools'] as string[]) : []
            console.log(`   [init] mcp_servers=${JSON.stringify(msg['mcp_servers'])}`)
            console.log(`   [init] brain tools=${tools.filter((t) => t.startsWith('mcp__brain')).length}`)
          }
        } catch {
          /* ignore */
        }
      }
    })

    child.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Say OK.' }] } })}\n`
    )

    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve()
    }, waitMs)
  })
}

async function main(): Promise<void> {
  await host.start(workDir)
  console.log(`tool host: ${host.url}`)
  console.log(`bridge:    ${host.bridgePath}`)
  console.log(`execPath:  ${process.execPath}`)
  console.log(`execPath has spaces: ${/\s/.test(process.execPath)}`)

  // Attempt 1: the real runtime path, which here contains a double space.
  await runAttempt(
    { label: 'electron execPath (has spaces)', command: process.execPath, args: [host.bridgePath] },
    25_000
  )
  const afterFirst = rpcHits

  // Attempt 2: same runtime copied to a space-free location.
  const cleanDir = join(tmpdir(), 'brain-clean-runtime')
  mkdirSync(cleanDir, { recursive: true })
  const cleanExe = join(cleanDir, 'electron.exe')
  if (!existsSync(cleanExe)) {
    console.log('\ncopying electron runtime to a space-free path…')
    cpSync(dirname(process.execPath), cleanDir, { recursive: true })
  }
  await runAttempt(
    { label: 'electron copied to space-free path', command: cleanExe, args: [host.bridgePath] },
    25_000
  )
  const afterSecond = rpcHits

  // Attempt 3: plain `node` from PATH, if available — isolates the runtime itself.
  await runAttempt({ label: 'plain node from PATH', command: 'node', args: [host.bridgePath] }, 25_000)
  const afterThird = rpcHits

  console.log('\n--- results ---')
  console.log(`spaced execPath  -> tools/list hits: ${afterFirst}`)
  console.log(`space-free copy   -> tools/list hits: ${afterSecond - afterFirst}`)
  console.log(`node from PATH    -> tools/list hits: ${afterThird - afterSecond}`)

  host.stop()
  process.exit(0)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})

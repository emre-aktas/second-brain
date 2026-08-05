/**
 * Determines which claude CLI flag combination lets MCP tools reach the model.
 *
 * Only the `init` frame is read, which the CLI emits before any model call, so
 * this costs no tokens.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolHost } from './toolhost'
import { resolveClaudeBinary } from './claude'

const workDir = mkdtempSync(join(tmpdir(), 'brain-flags-probe-'))
const binary = resolveClaudeBinary()
if (!binary) {
  console.error('claude CLI not found')
  process.exit(1)
}

const host = new ToolHost()
host.register({
  name: 'probe_alpha',
  description: 'First probe tool.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => ({ content: 'alpha' })
})
host.register({
  name: 'probe_beta',
  description: 'Second probe tool.',
  inputSchema: { type: 'object', properties: {} },
  handler: () => ({ content: 'beta' })
})

const BUILTINS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']

interface Variant {
  label: string
  extraArgs: string[]
}

const VARIANTS: Variant[] = [
  { label: 'no tool restriction', extraArgs: [] },
  { label: '--tools <builtins only>', extraArgs: ['--tools', BUILTINS.join(',')] },
  {
    label: '--tools <builtins + mcp__brain>',
    extraArgs: ['--tools', [...BUILTINS, 'mcp__brain'].join(',')]
  },
  {
    label: '--tools <builtins + explicit mcp names>',
    extraArgs: [
      '--tools',
      [...BUILTINS, 'mcp__brain__probe_alpha', 'mcp__brain__probe_beta'].join(',')
    ]
  },
  {
    label: '--allowedTools <builtins> (no --tools)',
    extraArgs: ['--allowedTools', BUILTINS.join(',')]
  },
  {
    label: '--disallowedTools Bash,Write,Edit (no --tools)',
    extraArgs: ['--disallowedTools', 'Bash,Write,Edit,NotebookEdit']
  }
]

interface Outcome {
  label: string
  mcpStatus: string
  brainTools: number
  totalTools: number
  builtinsPresent: string[]
  error?: string
}

function runVariant(variant: Variant, mcpConfig: unknown): Promise<Outcome> {
  return new Promise((resolve) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', 'sonnet',
      '--permission-mode', 'bypassPermissions',
      '--mcp-config', JSON.stringify(mcpConfig),
      '--strict-mcp-config',
      ...variant.extraArgs
    ]

    const child = spawn(binary!, args, {
      cwd: workDir,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let buffer = ''
    let settled = false
    let stderr = ''

    const done = (outcome: Outcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve(outcome)
    }

    const timer = setTimeout(
      () =>
        done({
          label: variant.label,
          mcpStatus: 'timeout',
          brainTools: 0,
          totalTools: 0,
          builtinsPresent: [],
          error: stderr.slice(0, 300) || 'no init within 45s'
        }),
      45_000
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      stderr += c
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
          if (msg['type'] !== 'system' || msg['subtype'] !== 'init') continue

          const tools = Array.isArray(msg['tools']) ? (msg['tools'] as string[]) : []
          const servers = Array.isArray(msg['mcp_servers'])
            ? (msg['mcp_servers'] as { name: string; status: string }[])
            : []

          done({
            label: variant.label,
            mcpStatus: servers.find((s) => s.name === 'brain')?.status ?? 'absent',
            brainTools: tools.filter((t) => t.startsWith('mcp__brain')).length,
            totalTools: tools.length,
            builtinsPresent: BUILTINS.filter((b) => tools.includes(b))
          })
        } catch {
          /* not our frame */
        }
      }
    })

    child.on('error', (err) =>
      done({
        label: variant.label,
        mcpStatus: 'spawn-error',
        brainTools: 0,
        totalTools: 0,
        builtinsPresent: [],
        error: err.message
      })
    )

    // Streaming input mode waits for stdin; a prompt is needed to reach init.
    child.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })}\n`
    )
  })
}

async function main(): Promise<void> {
  await host.start(workDir)

  const mcpConfig = {
    mcpServers: {
      brain: {
        command: process.execPath,
        args: [host.bridgePath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          BRAIN_URL: host.url,
          BRAIN_TOKEN: host.token,
          BRAIN_SESSION_ID: 'flags-probe'
        }
      }
    }
  }

  console.log(`\n2 probe tools registered at ${host.url}\n`)
  const results: Outcome[] = []

  for (const variant of VARIANTS) {
    process.stdout.write(`running: ${variant.label} … `)
    const outcome = await runVariant(variant, mcpConfig)
    results.push(outcome)
    console.log(
      `mcp=${outcome.mcpStatus} brainTools=${outcome.brainTools} totalTools=${outcome.totalTools} builtins=[${outcome.builtinsPresent.join(',')}]${outcome.error ? ` err=${outcome.error}` : ''}`
    )
  }

  console.log('\n--- summary ---')
  for (const r of results) {
    const verdict = r.brainTools >= 2 ? 'WORKS' : 'no mcp tools'
    console.log(`${verdict.padEnd(13)} ${r.label}`)
  }

  const working = results.filter((r) => r.brainTools >= 2)
  console.log(
    working.length > 0
      ? `\nUse: ${working.map((w) => w.label).join(' | ')}`
      : '\nNo variant exposed MCP tools — investigate the mcp config shape itself.'
  )

  host.stop()
  process.exit(0)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * Killing a child must kill its children.
 *
 * `child.kill()` signals one process, and every process this app spawns has children of its
 * own: the CLI runs MCP servers, an MCP server is usually `npx` running node, a script
 * integration is node running whatever the manifest said. That was survivable while quitting
 * the app meant the OS reaped everything — and stopped being survivable the moment the
 * window could close without the app quitting, because then nothing reaped anything and a
 * session of opening and closing left a row of orphans behind.
 *
 * So this builds the exact shape that was leaking — a parent that spawns a grandchild, both
 * writing heartbeats to disk — kills the parent through `killTree`, and then watches the
 * grandchild's file to see whether it is really gone. A file that keeps changing is a
 * process that is still running.
 *
 *   node scripts/run-ts.mjs src/main/kill.probe.ts --node
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DETACH_CHILDREN, killTree } from './util/kill'

let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}`)
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
  }
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

const dir = mkdtempSync(join(tmpdir(), 'brain-kill-'))
const parentBeat = join(dir, 'parent.txt')
const childBeat = join(dir, 'child.txt')

/** Writes its own heartbeat for as long as it lives. Nothing else. */
const beater = join(dir, 'beater.js')
writeFileSync(
  beater,
  `const fs = require('fs')
const target = process.argv[2]
setInterval(() => fs.writeFileSync(target, String(Date.now())), 100)
`,
  'utf8'
)

/** Spawns a grandchild, then beats too — the shape the CLI and every MCP server have. */
const parent = join(dir, 'parent.js')
writeFileSync(
  parent,
  `const { spawn } = require('child_process')
const fs = require('fs')
spawn(process.execPath, [${JSON.stringify(beater)}, ${JSON.stringify(childBeat)}], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'ignore'
})
setInterval(() => fs.writeFileSync(${JSON.stringify(parentBeat)}, String(Date.now())), 100)
`,
  'utf8'
)

/** How long since a heartbeat file last changed. Infinity when it never appeared. */
function silentFor(path: string): number {
  if (!existsSync(path)) return Infinity
  return Date.now() - statSync(path).mtimeMs
}

async function main(): Promise<void> {
  console.log('killing a process tree\n')

  // Electron's binary run as plain node, which is what a script integration does too.
  const child = spawn(process.execPath, [parent], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: DETACH_CHILDREN,
    windowsHide: true,
    stdio: 'ignore'
  })

  // Both alive before anything is proved about killing them.
  let waited = 0
  while (waited < 8000 && (!existsSync(parentBeat) || !existsSync(childBeat))) {
    await wait(100)
    waited += 100
  }

  check('the parent started', existsSync(parentBeat))
  check('and it spawned a grandchild', existsSync(childBeat))
  if (!existsSync(childBeat)) {
    console.log(`\n${failures} FAILURE(S) — the fixture never got going, so nothing was tested`)
    process.exit(1)
  }

  check('both are beating', silentFor(parentBeat) < 1000 && silentFor(childBeat) < 1000, {
    parent: silentFor(parentBeat),
    child: silentFor(childBeat)
  })

  /* ------------------------------------------------------------------ kill */

  killTree(child)

  // Long enough for `taskkill` to be spawned, run and take the tree apart. This is the one
  // place a generous wait is right: the alternative is a flaky check on a real OS operation.
  await wait(2500)

  const beforeParent = readFileSync(parentBeat, 'utf8')
  const beforeChild = readFileSync(childBeat, 'utf8')
  await wait(1200)

  check('the parent stopped', readFileSync(parentBeat, 'utf8') === beforeParent, {
    silentFor: silentFor(parentBeat)
  })
  // The one that was leaking. A grandchild still writing here is a node process that
  // outlived the app, which is exactly what the user saw in Task Manager.
  check('and so did the grandchild', readFileSync(childBeat, 'utf8') === beforeChild, {
    silentFor: silentFor(childBeat)
  })

  /* ------------------------------------------------------------- the edges */

  console.log('\nnothing to kill')
  // Teardown calls this on whatever it has, which is often nothing. Throwing there would
  // abort a shutdown partway through and leave the rest of the app running.
  killTree(null)
  killTree(undefined)
  killTree({ pid: undefined } as never)
  check('killing nothing is not an error', true)

  // And twice, because both `stop()` and `before-quit` can reach the same child.
  killTree(child)
  check('killing an already-dead tree is not an error', true)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.log(`FATAL ${(err as Error).stack ?? String(err)}`)
  process.exit(1)
})

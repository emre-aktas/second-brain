/**
 * The process lifecycle: a deliberate stop must not look like a crash, and a
 * process that dies owing an answer must say so.
 *
 * This is the plumbing behind "sometimes a tool button spins forever". Killing a
 * child is synchronous; its `close` is not, so a replaced process reports an exit a
 * few milliseconds later — and on Windows a killed child reports code 1. Read
 * naively, that exit said "the agent crashed" about a process the app had just
 * retired on purpose, and it arrived after the replacement was already in the map.
 *
 * Driven by a stub script standing in for the CLI, so nothing here touches a model
 * and it costs no usage.
 *
 *   node scripts/run-ts.mjs src/main/agent/lifecycle.probe.ts --node
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeProcess, type ClaudeStreamEvent } from './claude'

let failures = 0

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
}

const work = mkdtempSync(join(tmpdir(), 'brain-lifecycle-'))

/**
 * A stand-in for the CLI: reads stream-json on stdin and stays alive, so the
 * process can be stopped mid-turn the way a real one is.
 */
const stub = join(work, 'stub-claude.js')
writeFileSync(
  stub,
  [
    "process.stdin.setEncoding('utf8')",
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\\n')",
    // Reads and never answers: exactly the shape of a turn in flight.
    "process.stdin.on('data', () => {})",
    'setInterval(() => {}, 1000)'
  ].join('\n')
)

/** A CLI that dies the moment a turn is handed to it. */
const crasher = join(work, 'crasher-claude.js')
writeFileSync(
  crasher,
  [
    "process.stdin.setEncoding('utf8')",
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }) + '\\n')",
    "process.stdin.on('data', () => process.exit(7))",
    'setInterval(() => {}, 1000)'
  ].join('\n')
)

function make(onEvent: (event: ClaudeStreamEvent) => void): ClaudeProcess {
  return new ClaudeProcess(
    {
      binary: process.execPath,
      cwd: work,
      model: 'sonnet',
      capability: 'read-only',
      appendSystemPrompt: '',
      mcpConfig: { mcpServers: {} },
      extraArgs: [],
      // The stub is the script; every real flag after it is ignored by it.
      extraEnv: {}
    },
    onEvent
  )
}

/** Wait for the next event of a given type, or resolve null on timeout. */
function nextEvent(
  events: ClaudeStreamEvent[],
  type: ClaudeStreamEvent['type'],
  ms = 4000
): Promise<ClaudeStreamEvent | null> {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      const found = events.find((event) => event.type === type)
      if (found) {
        clearInterval(tick)
        resolve(found)
        return
      }
      if (Date.now() - started > ms) {
        clearInterval(tick)
        resolve(null)
      }
    }, 25)
  })
}

async function main(): Promise<void> {
  console.log('process lifecycle probe\n')

  /* ------------------------------------------- a deliberate stop, mid-turn */

  console.log('stopping a busy process')
  const events: ClaudeStreamEvent[] = []
  const proc = make((event) => events.push(event))

  // `binary` is the node executable, so the script has to be argv[0]. extraArgs are
  // appended after the CLI's own flags, which node would read as its own — so the
  // whole argument list is replaced instead. Shadowing the prototype method with an
  // own property is the only seam, and it keeps the spawn, the stream parsing and
  // the close handling under test rather than stubbed.
  ;(proc as unknown as { buildArgs: () => string[] }).buildArgs = () => [stub]

  proc.send('hello')
  await new Promise((r) => setTimeout(r, 900))

  check('the process reports itself busy while a turn is in flight', proc.isBusy)
  check('it is not marked stopped before anyone stops it', !proc.stopped)

  proc.stop()
  check('stop() marks it stopped straight away', proc.stopped)

  const exit = await nextEvent(events, 'exit')
  check('the kill produces an exit event', exit !== null, exit)
  if (exit && exit.type === 'exit') {
    // The whole point: the flag survives the kill, so the manager can tell this
    // exit apart from a crash and stay quiet about it. Without it the manager
    // announced "the agent process exited unexpectedly (code 1)" — Windows reports 1
    // for a killed child — about a process the app had retired on purpose.
    check('the exit is still recognisable as deliberate', proc.stopped)
  }

  /* -------------------------------------------- a process that dies on its own */

  console.log('\na process that dies mid-turn')
  const dyingEvents: ClaudeStreamEvent[] = []
  const dying = make((event) => dyingEvents.push(event))
  ;(dying as unknown as { buildArgs: () => string[] }).buildArgs = () => [crasher]

  dying.send('hello')
  const crashExit = await nextEvent(dyingEvents, 'exit')
  check('the death is reported as an exit', crashExit !== null, crashExit)
  if (crashExit && crashExit.type === 'exit') {
    check('it is not marked as a deliberate stop', !dying.stopped)
    // This is what the manager needs: the turn was owed an answer, so it has to
    // settle the run rather than going quietly idle and leaving the tool spinning.
    check('it reports that a turn was in flight', crashExit.wasBusy === true, crashExit)
    check('a non-zero code comes through', crashExit.code === 7, crashExit)
  }

  /* --------------------------------------- an idle process going away quietly */

  console.log('\nstopping an idle process')
  const idleEvents: ClaudeStreamEvent[] = []
  const idle = make((event) => idleEvents.push(event))
  ;(idle as unknown as { buildArgs: () => string[] }).buildArgs = () => [stub]

  idle.start()
  await new Promise((r) => setTimeout(r, 700))
  check('an idle process is not busy', !idle.isBusy)

  idle.stop()
  const idleExit = await nextEvent(idleEvents, 'exit')
  check('it exits', idleExit !== null)
  if (idleExit && idleExit.type === 'exit') {
    // wasBusy false is what tells the manager there is nothing to settle: emitting
    // an error here would put a failure in front of the user for a process that was
    // simply reclaimed after going idle.
    check('nothing was owed, so wasBusy is false', idleExit.wasBusy === false, idleExit)
  }

  rmSync(work, { recursive: true, force: true })

  console.log(
    failures === 0 ? '\nall lifecycle checks passed' : `\n${failures} lifecycle check(s) failed`
  )
  process.exit(failures === 0 ? 0 : 1)
}

void main()

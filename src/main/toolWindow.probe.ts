/**
 * The regression test for the bug that made tools look broken in their own window.
 *
 * `core.broadcast` targeted only the main window, so a tool opened as a separate
 * window never received `agent:event`, `tools:stateChanged` or `chat:question`.
 * The run started, the agent worked, and the window sat there spinning. This drives
 * a real tool window through a real run and asserts what arrives where.
 *
 * No model: the agent is stubbed at the IPC boundary, and the events a real turn
 * would emit are replayed through the same Broadcaster the app uses. What is under
 * test is delivery and the renderer's handling of it, which is where the bug was.
 *
 *   node scripts/run-ts.mjs src/main/toolWindow.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain, protocol } from 'electron'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentEvent } from '@shared/types'
import { Db } from './db/sqlite'
import { migrate } from './db/schema'
import { ToolStore } from './db/tools'
import { Broadcaster } from './broadcast'
import { registerToolScheme, serveResponseFor, TOOL_SCHEME } from './toolProtocol'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'tool-window.log')

let failures = 0

function log(line: string): void {
  appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) log(`  ok    ${label}`)
  else {
    failures++
    log(`  FAIL  ${label}`)
    if (detail !== undefined) log(`        ${JSON.stringify(detail)}`)
  }
}

registerToolScheme()

const SESSION = 'session-under-test'

/**
 * A tool that records what it is told into its own document.
 *
 * Read back from the store rather than from the frame's DOM: the frame is
 * sandboxed onto an opaque origin, so the parent cannot reach into it — which is
 * exactly the property that makes running the agent's code safe. Persisting the
 * trace goes through the same host bridge as any real save, so the path is the
 * one under test rather than a back door.
 */
const SOURCE = `
<style>body { padding: 12px; font-size: 13px; }</style>
<h3>reporter</h3>
<div id="trace"></div>
<script>
  var trace = [];
  var record = function (entry, extra) {
    trace.push(entry);
    document.getElementById('trace').textContent = trace.join('\\n');
    brain.patch(Object.assign({ trace: trace.slice() }, extra || {}));
  };

  brain.onRun(function (event) {
    if (event.status === 'delta') return; // recorded by onText below
    record('run:' + event.status + (event.step ? ':' + event.step : ''));
  });

  brain.onState(function (state) {
    if (state.fromAgent && trace.indexOf('state:' + state.fromAgent) === -1) {
      record('state:' + state.fromAgent);
    }
  });

  // Fires itself, because a click cannot be synthesised from outside the sandbox.
  window.addEventListener('brain:init', async function () {
    if (trace.length) return;
    record('init');
    try {
      // onText is the whole point: without it a press is followed by silence for
      // however long the model takes.
      var reply = await brain.run('go', { note: 'hello' }, {
        onText: function (soFar) { record('text:' + soFar); },
        onStep: function (step) { record('step:' + step); }
      });
      record('resolved:' + reply + '|elapsed:' + (brain.elapsedMs > 0 ? 'yes' : 'no'), { settled: true });
    } catch (err) {
      record('rejected:' + err.message, { settled: true });
    }
  });
</script>`

async function main(): Promise<void> {
  writeFileSync(LOG, `tool window probe, root=${root}\n`)
  app.on('window-all-closed', () => {})

  const dir = mkdtempSync(join(tmpdir(), 'brain-toolwindow-'))
  const db = new Db(join(dir, 'index.db'))
  migrate(db)
  const store = new ToolStore(db)

  const tool = store.save({
    name: 'Reporter',
    description: 'Reports what it receives',
    prompt: '',
    kind: 'code',
    source: SOURCE,
    actions: [{ id: 'go', label: 'Run', prompt: 'echo {{note}}', target: 'output' }],
    openInWindow: true,
    createdBy: 'agent'
  })
  store.ensureSession(tool.id, () => SESSION)

  const broadcaster = new Broadcaster()
  const runStarted: { promptSeen: string }[] = []

  ipcMain.handle('tools:get', (_event, payload: { id: string }) => store.get(payload.id) ?? null)
  ipcMain.handle('tools:session', () => ({ sessionId: SESSION }))
  ipcMain.handle('app:settings:get', () => ({ appearance: { theme: 'dark' } }))
  // A handful of realistic lines, so the picture below shows the window in use
  // rather than empty.
  ipcMain.handle('logs:tail', () => [
    { seq: 1, ts: Date.now() - 5200, level: 'info', scope: 'main', message: 'Second Brain 0.1.0 starting' },
    { seq: 2, ts: Date.now() - 5100, level: 'info', scope: 'db:schema', message: 'schema at version 9' },
    { seq: 3, ts: Date.now() - 4800, level: 'info', scope: 'toolhost', message: 'tool host listening on http://127.0.0.1:54684 with 32 tools' },
    { seq: 4, ts: Date.now() - 3000, level: 'info', scope: 'tool-windows', message: 'opened tool window tool:01KZ75KKY9' },
    { seq: 5, ts: Date.now() - 2400, level: 'info', scope: 'ipc', message: 'tool run "Reporter" · Run → session under, model opus, effort high, from window 3' },
    { seq: 6, ts: Date.now() - 900, level: 'warn', scope: 'ipc', message: 'tool code raised in "Bozuk": Cannot set properties of null (setting \'textContent\')' },
    { seq: 7, ts: Date.now() - 400, level: 'info', scope: 'agent', message: 'result for session r-test (7 chars)' }
  ])
  ipcMain.handle('window:isAlwaysOnTop', () => false)
  ipcMain.handle('window:previewReady', () => {})
  ipcMain.handle('tools:reportError', (_event, payload: { message: string }) =>
    log(`  [tool error] ${payload.message}`)
  )
  ipcMain.handle(
    'tools:writeState',
    (_event, payload: { id: string; state: Record<string, unknown>; rev: number }) => {
      const saved = store.writeState(payload.id, payload.state)
      broadcaster.send('tools:stateChanged', { toolId: payload.id, rev: saved.rev, note: null })
      return { tool: saved, conflict: false }
    }
  )

  // The agent, stubbed: it accepts the run and returns the session id, exactly as
  // the real handler does. The turn's events are replayed separately below.
  ipcMain.handle(
    'tools:runAction',
    (_event, payload: { id: string; actionId: string; inputs: Record<string, string> }) => {
      const action = store.get(payload.id)!.actions.find((a) => a.id === payload.actionId)!
      runStarted.push({ promptSeen: action.prompt.replace('{{note}}', payload.inputs.note ?? '') })
      return { sessionId: SESSION }
    }
  )

  await app.whenReady()
  protocol.handle(TOOL_SCHEME, (request) => serveResponseFor(request.url, (id) => store.get(id)))
  log('app ready')

  /* --------------------------------------------------------------- windows */

  // A second window on purpose: the bug was that only the first one was ever
  // targeted, so a single-window probe would have passed against the broken code.
  // The log window doubles as the observer for delivery to a non-tool window.
  const logWin = new BrowserWindow({
    width: 700,
    height: 420,
    x: -32000,
    y: -32000,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      sandbox: true,
      backgroundThrottling: false
    }
  })
  await logWin.loadFile(join(root, 'out/renderer/index.html'), { hash: '/logs' })
  logWin.showInactive()

  const toolWin = new BrowserWindow({
    width: 720,
    height: 520,
    x: -32000,
    y: -32000,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      sandbox: true,
      backgroundThrottling: false
    }
  })
  await toolWin.loadFile(join(root, 'out/renderer/index.html'), {
    hash: `/tool/${encodeURIComponent(tool.id)}`
  })
  toolWin.showInactive()

  log('\nwindows')
  check('there is more than one window', broadcaster.audience() >= 2, broadcaster.audience())

  /* ------------------------------------------- a run started inside the tool */

  log('\na run started from a tool in its own window')
  await until(() => runStarted.length === 1, 6000)
  check('the run reached the main process', runStarted.length === 1, runStarted)
  check(
    'the prompt was filled from the values the tool passed to brain.run',
    runStarted[0]?.promptSeen === 'echo hello',
    runStarted
  )
  // Polled, not read once: the tool records its trace through brain.setState, and
  // those writes are serialised in the host — so the entry lands a round trip after
  // the main process sees the run, not in the same tick.
  await until(async () => (await trace(store, tool.id)).includes('run:start'), 6000)
  const started = await trace(store, tool.id)
  log(`  trace so far: ${JSON.stringify(started)}`)
  check('the tool was told its run started', started.includes('run:start'), started)

  // The events a real turn emits, through the app's own broadcaster.
  broadcaster.send('agent:event', {
    type: 'tool-start',
    sessionId: SESSION,
    messageId: 'm1',
    id: 't1',
    name: 'mcp__brain__search_notes',
    input: {}
  } satisfies AgentEvent)
  await until(async () => (await trace(store, tool.id)).some((l) => l.startsWith('run:step')), 3000)
  check(
    'a step reached the tool window',
    (await trace(store, tool.id)).some((l) => l.startsWith('run:step'))
  )

  // The reply, written a piece at a time — exactly how a real turn arrives.
  log('\nthe reply arrives as it is written')
  for (const piece of ['mer', 'ha', 'ba']) {
    broadcaster.send('agent:event', {
      type: 'delta',
      sessionId: SESSION,
      messageId: 'm1',
      kind: 'text',
      text: piece
    } satisfies AgentEvent)
    await new Promise((done) => setTimeout(done, 120))
  }

  const streamed = await trace(store, tool.id)
  log(`  streamed: ${JSON.stringify(streamed.filter((l) => l.startsWith('text:')))}`)
  check(
    'the tool saw the reply arriving, not just the finished one',
    streamed.includes('text:mer') && streamed.includes('text:merha'),
    streamed.filter((l) => l.startsWith('text:'))
  )
  check(
    'each delta carries everything so far, not just the new piece',
    streamed.includes('text:merhaba'),
    streamed.filter((l) => l.startsWith('text:'))
  )

  broadcaster.send('agent:event', {
    type: 'result',
    sessionId: SESSION,
    costUsd: 0,
    durationMs: 12,
    numTurns: 1,
    isError: false,
    text: 'merhaba'
  } satisfies AgentEvent)
  await until(async () => (await trace(store, tool.id)).some((l) => l.startsWith('resolved:')), 4000)
  check(
    'and it knows how long it took',
    (await trace(store, tool.id)).some((l) => l.includes('|elapsed:yes')),
    (await trace(store, tool.id)).filter((l) => l.startsWith('resolved:'))
  )

  const afterResult = await trace(store, tool.id)
  log(`  trace: ${JSON.stringify(afterResult)}`)
  check('the result reached the tool window', afterResult.includes('run:done'))
  check(
    'brain.run resolved with the reply text',
    afterResult.some((l) => l.startsWith('resolved:merhaba'))
  )
  check(
    'the tool settled rather than spinning',
    (store.get(tool.id)!.state as Record<string, unknown>)['settled'] === true
  )

  /* ------------------------------- the agent writing while the window is open */

  log('\nthe agent rewrites the document under an open tool window')
  const current = store.get(tool.id)!
  store.writeState(tool.id, {
    ...(current.state as Record<string, unknown>),
    fromAgent: 'written-by-agent'
  })
  broadcaster.send('tools:stateChanged', {
    toolId: tool.id,
    rev: store.get(tool.id)!.rev,
    note: null
  })
  await until(async () => (await trace(store, tool.id)).includes('state:written-by-agent'), 4000)
  check(
    "the tool window saw the agent's write",
    (await trace(store, tool.id)).includes('state:written-by-agent')
  )

  /* ---------------------------------------------- delivery to other windows */

  log('\nthe same events reach a window that is not the tool')
  const logText = await logWin.webContents.executeJavaScript('document.body.innerText')
  check('the log window received the result event', /result ok/.test(String(logText)),
    String(logText).slice(0, 300))
  check(
    'and the step before it',
    /tool-start/.test(String(logText)),
    String(logText).slice(0, 300)
  )

  // A picture of the log window, because it is an interface too.
  const shot = await logWin.webContents.capturePage()
  const file = join(OUT, 'log-window.png')
  writeFileSync(file, shot.toPNG())
  log(`  wrote ${file}`)

  db.close()
  log(failures === 0 ? '\nall tool window checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

/** What the tool recorded, read from the store it saved into. */
async function trace(store: ToolStore, toolId: string): Promise<string[]> {
  const state = store.get(toolId)?.state as Record<string, unknown> | undefined
  const value = state?.['trace']
  return Array.isArray(value) ? (value as string[]) : []
}

/** Polls rather than sleeping a fixed amount, so the probe is neither slow nor flaky. */
async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((done) => setTimeout(done, 50))
  }
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

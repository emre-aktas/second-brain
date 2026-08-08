/**
 * The regression test for the same paragraph appearing twice mid-turn.
 *
 * Claude can send two frames for one message. The first is saved under the id the
 * streaming buffer had; text that streams in between is buffered under a *new* id;
 * then the second frame lands on the original id. The renderer only cleared a
 * buffer whose id matched the saved message, so the orphaned buffer kept rendering
 * beside the saved copy — one paragraph, twice.
 *
 * This replays that exact sequence into the real chat panel and counts what is on
 * screen. Also drives the search sweep, since both live on the same event stream.
 *
 *   node scripts/run-ts.mjs src/main/chatStream.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentEvent, ChatMessage, ChatSession } from '@shared/types'
import { API_CHANNELS } from '@shared/ipc'
import { Broadcaster } from './broadcast'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'chat-stream.log')

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

const SESSION_ID = 'probe-session'
const FIRST = 'Tasarım brief’ini okudum.'
const SECOND = 'Mevcut iki araca benzemeyecek bir şey kuruyorum.'

const SESSION: ChatSession = {
  id: SESSION_ID,
  title: 'probe',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  archived: false,
  totalCostUsd: 0,
  claudeSessionId: null
}

const SETTINGS = {
  workspacePath: '',
  model: 'opus',
  effort: 'high',
  defaultCapability: 'curate',
  budget: { mode: 'off', dailyLimitUsd: 1, perTurnLimitUsd: 0.25 },
  curator: { enabled: false, idleMs: 90000, intervalMs: 600000, autoLinkSimilar: false, useAgent: false, similarityThreshold: 0.22 },
  chat: { showToolActivity: true },
  graph: { showTags: true, showSimilarEdges: true, linkDistance: 83, charge: -282, labelThreshold: 0.75, rotate: false },
  layout: { panelWidth: 430 },
  sound: { enabled: false, volume: 0.35 },
  appearance: { theme: 'dark', accent: 'violet', reduceMotion: false }
}

function assistantMessage(id: string, text: string): ChatMessage {
  return {
    id,
    sessionId: SESSION_ID,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    ts: Date.now()
  }
}

/** How many times a string occurs in the rendered transcript. */
async function occurrences(win: BrowserWindow, needle: string): Promise<number> {
  const script = `(() => {
    const text = document.body.innerText || '';
    const needle = ${JSON.stringify(needle)};
    let count = 0, from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      count++; from = at + needle.length;
    }
    return count;
  })()`
  return Number(await win.webContents.executeJavaScript(script))
}

function settle(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function main(): Promise<void> {
  writeFileSync(LOG, 'chat stream probe\n')
  app.on('window-all-closed', () => {})

  for (const channel of API_CHANNELS) ipcMain.handle(channel, () => [])
  // A blanket [] is a lie for anything whose reply is an object; the renderer reads
  // fields off these, and an array has none of them.
  ipcMain.removeHandler('inbox:list')
  ipcMain.handle('inbox:list', () => ({ entries: [], unread: 0 }))
  for (const channel of ['app:bootstrap', 'app:settings:get', 'chat:messages', 'chat:sessions', 'graph:get']) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle('app:bootstrap', () => ({
    budget: { enabled: false, onSubscription: true, spentToday: 0, dailyLimitUsd: 0, perTurnLimitUsd: 0, remaining: null, blocked: false },
    workspace: { root: '', vaultDir: '', integrationsDir: '', dbPath: '', trashDir: '' },
    settings: SETTINGS,
    stats: { notes: 0, edges: 0, tags: 0, suggestions: 0, lastIndexedAt: Date.now() },
    /*
     * No Claude CLI on this machine, deliberately.
     *
     * The chat used to gate its composer on exactly this flag — `resolveClaudeBinary() !== null` —
     * so a user running DeepSeek was told "The Claude CLI was not found" and could not type. The
     * engine state below is the answer it should have been reading.
     */
    agent: { available: false, binaryPath: null, version: null, model: 'opus', auth: null },
    session: SESSION,
    secretsEncrypted: false,
    webhookBaseUrl: '',
    appVersion: '0.1.0'
  }))
  ipcMain.handle('app:settings:get', () => SETTINGS)
  ipcMain.handle('chat:messages', () => [])
  ipcMain.handle('chat:sessions', () => [SESSION])
  ipcMain.handle('graph:get', () => ({ nodes: [], edges: [], stamp: 1 }))

  /** DeepSeek, configured and ready — `blocked: null` is the whole assertion. */
  const readyEngine = {
    providers: [],
    selectedProviderId: 'deepseek',
    capabilities: {
      engine: 'openai-compatible',
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      builtInTools: false,
      serverSideSessions: false,
      streamsText: true,
      reasoning: true,
      toolCalling: true,
      accountConnectors: false,
      sandboxed: false,
      toolPrefix: '',
      deferredTools: false,
      metered: true,
      usageWindows: false
    },
    effort: '',
    blocked: null,
    notes: []
  }
  ipcMain.removeHandler('engine:state')
  ipcMain.handle('engine:state', () => readyEngine)

  await app.whenReady()
  log('app ready')

  const broadcaster = new Broadcaster()
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
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
  await win.loadFile(join(root, 'out/renderer/index.html'))
  win.showInactive()
  await settle(1200)

  const send = (event: AgentEvent): void => broadcaster.send('agent:event', event)

  /* ------------------------------------------- the sequence that duplicated */

  log('\ntwo frames for one message, with text streamed in between')

  // Frame one: text streams under buffer A, then is saved under A.
  send({ type: 'delta', sessionId: SESSION_ID, messageId: 'A', kind: 'text', text: FIRST })
  await settle(200)
  check('the streamed text is on screen once', (await occurrences(win, FIRST)) === 1, {
    count: await occurrences(win, FIRST)
  })

  send({ type: 'message', sessionId: SESSION_ID, message: assistantMessage('A', FIRST) })
  await settle(250)
  check('still once after it is saved', (await occurrences(win, FIRST)) === 1, {
    count: await occurrences(win, FIRST)
  })

  // More text arrives, buffered under a *new* id, because the first frame closed A.
  send({ type: 'delta', sessionId: SESSION_ID, messageId: 'B', kind: 'text', text: SECOND })
  await settle(200)
  check('the second part streams in', (await occurrences(win, SECOND)) === 1, {
    count: await occurrences(win, SECOND)
  })

  // The second frame lands on A, carrying both parts, and names B as replaced.
  send({
    type: 'message',
    sessionId: SESSION_ID,
    supersedes: 'B',
    message: assistantMessage('A', `${FIRST} ${SECOND}`)
  })
  await settle(400)

  const firstCount = await occurrences(win, FIRST)
  const secondCount = await occurrences(win, SECOND)
  log(`  counts: first=${firstCount} second=${secondCount}`)
  check('the first part appears exactly once', firstCount === 1, { firstCount })
  check('the second part appears exactly once — not beside its own buffer', secondCount === 1, {
    secondCount
  })

  /* --------------------------------------------------- the search sweep */

  log('\nthe search sweep')
  broadcaster.send('graph:probe', { nodeIds: ['n1', 'n2', 'n3'], label: 'omlet' })
  await settle(350)
  const caption = await occurrences(win, 'Looking for')
  check('the caption says what it is looking for', caption === 1, { caption })
  check('and names the query', (await occurrences(win, 'omlet')) >= 1)

  await settle(2600)
  check('the caption clears itself', (await occurrences(win, 'Looking for')) === 0)

  /* --------------------------------------------- one question, one card -- */

  log('\na question that arrives twice')

  const QUESTION = 'That thread — draft a reply?'
  const ask = {
    id: 'q1',
    sessionId: SESSION_ID,
    question: QUESTION,
    options: ['Yes', 'Only that one', 'Not now'],
    allowFreeText: true,
    askedAt: Date.now()
  }

  // Twice, deliberately. The event is broadcast to every window and a popped-out tool
  // subscribes on its own account, so the renderer really does see repeats — and appended
  // blindly the user got the same card twice, with answering one leaving the other behind.
  broadcaster.send('chat:question', ask)
  broadcaster.send('chat:question', ask)
  await settle(400)

  const cards = await occurrences(win, QUESTION)
  check('a repeated question renders once', cards === 1, { cards })

  broadcaster.send('chat:questionResolved', { id: 'q1' })
  await settle(300)
  check('and answering it clears the card', (await occurrences(win, QUESTION)) === 0)

  /* ------------------------------------------------ the input grows ------ */

  log('\nthe composer')

  /**
   * Type into the real field, through React.
   *
   * A controlled textarea ignores a plain `element.value = ...` — React's own value tracker
   * sees no change and the state never updates, so the field would snap back on the next
   * render and the measurement would be of nothing. Going through the prototype's setter is
   * what makes the synthetic input event indistinguishable from a keystroke.
   */
  const typeAndMeasure = async (text: string): Promise<number> =>
    Number(
      await win.webContents.executeJavaScript(
        `(() => {
           const el = document.querySelector('textarea');
           if (!el) return -1;
           const setter = Object.getOwnPropertyDescriptor(
             HTMLTextAreaElement.prototype,
             'value'
           ).set;
           setter.call(el, ${JSON.stringify(text)});
           el.dispatchEvent(new Event('input', { bubbles: true }));
           return el.getBoundingClientRect().height;
         })()`
      )
    )

  const empty = await typeAndMeasure('')
  // The field itself, which is bare now — the surface around it owns the border and the
  // padding, so this is one line of text and nothing else. The upper bound is what fails if
  // the placeholder ever grows long enough to wrap again: a wrapping placeholder counts
  // towards `scrollHeight` and holds an empty field open at two lines.
  check('the composer starts as one line', empty > 18 && empty < 34, { empty })

  const threeLines = await typeAndMeasure('one\ntwo\nthree')
  check('and grows with the content', threeLines > empty + 20, { empty, threeLines })

  // Back to one line. Growing without shrinking is the usual half-implementation: the field
  // reaches the height of the longest thing ever typed into it and stays there.
  const shrunk = await typeAndMeasure('one')
  check('and shrinks again when the text is deleted', shrunk <= empty + 2, { empty, shrunk })

  const tall = await typeAndMeasure(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))
  check('it stops at the ceiling rather than eating the chat', tall <= 244, { tall })
  check('and the ceiling is taller than three lines', tall > threeLines, { threeLines, tall })

  const overflow = await win.webContents.executeJavaScript(
    `getComputedStyle(document.querySelector('textarea')).overflowY`
  )
  check('past the ceiling it scrolls inside itself', String(overflow) === 'auto', { overflow })

  await typeAndMeasure('')

  const shot = await win.webContents.capturePage()
  writeFileSync(join(OUT, 'chat-stream.png'), shot.toPNG())
  log(`  wrote ${join(OUT, 'chat-stream.png')}`)

  /* ------------------------------------------- a working engine that is not Claude */

  {
    const shot = (await win.webContents.executeJavaScript(
      `(() => {
        const textarea = document.querySelector('textarea')
        return {
          text: document.body.innerText,
          disabled: textarea ? textarea.disabled : null,
          placeholder: textarea ? textarea.getAttribute('placeholder') : null
        }
      })()`
    )) as { text: string; disabled: boolean | null; placeholder: string | null }

    /*
     * With DeepSeek selected and ready, nothing about Claude belongs on this screen.
     *
     * The chat gated its composer on `bootstrap.agent.available`, which is
     * `resolveClaudeBinary() !== null` — a fact about one engine deciding for all of them. So the
     * banner named the wrong engine in every clause, and the composer refused to accept a message
     * from someone whose engine was configured, verified and working.
     */
    check(
      'no Claude install warning when another engine is ready',
      !/Claude CLI was not found/i.test(shot.text),
      shot.text.slice(0, 300)
    )
    check('and the composer accepts typing', shot.disabled === false, shot)
    check(
      'with its normal placeholder rather than an install instruction',
      !/Install Claude Code/i.test(shot.placeholder ?? ''),
      shot.placeholder
    )
  }

  /* ------------------------------------------------- and an engine that is not ready */

  {
    ipcMain.removeHandler('engine:state')
    ipcMain.handle('engine:state', () => ({
      ...readyEngine,
      blocked: 'Choose a model for DeepSeek first.'
    }))
    // Broadcast the way a real switch arrives, which is what the panel listens for.
    broadcaster.send('settings:changed', SETTINGS)
    await settle(800)

    const shot = (await win.webContents.executeJavaScript(
      `(() => {
        const textarea = document.querySelector('textarea')
        return {
          text: document.body.innerText,
          disabled: textarea ? textarea.disabled : null,
          buttons: Array.from(document.querySelectorAll('button')).map((el) => el.innerText.trim()).filter(Boolean)
        }
      })()`
    )) as { text: string; disabled: boolean | null; buttons: string[] }

    // The engine's own sentence, not a paragraph about a different engine.
    check(
      'a blocked engine says what is actually wrong',
      /Choose a model for DeepSeek first/i.test(shot.text),
      shot.text.slice(0, 400)
    )
    check('and stops the composer', shot.disabled === true, shot)
    // Naming a problem with no route to it is the thing this change is about.
    check(
      'and offers the way to fix it',
      shot.buttons.some((label) => /Open the Engine tab/i.test(label)),
      shot.buttons
    )
  }


  log(failures === 0 ? '\nall chat stream checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

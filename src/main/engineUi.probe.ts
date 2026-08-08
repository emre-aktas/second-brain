/**
 * The Engine tab, drawn by the real renderer.
 *
 * The check that matters is the first one, and it exists because this app has already shipped a
 * panel that nothing mounted: `IntegrationsPanel` was written, exported and unreachable, because
 * the rail had no entry and `App.tsx` had no branch. Nothing failed to compile and no test
 * noticed. So this clicks the rail by its accessible name and looks for the screen.
 *
 * The rest is the setup flow: the provider list, and the step-by-step that starts when one is
 * chosen. No model, no key, no network — every channel is stubbed.
 *
 * The Codex pass is the second half, and it is here because "I select Codex but I cannot see its
 * settings" was a real report: choosing a CLI provider selected it immediately and left a tab
 * with nothing on it, so there was no surface on which to pick a model — and the app went on
 * sending the Claude model name to it. The assertions are that the card exists, that it offers
 * the models Codex publishes, and that the thinking levels shown belong to the chosen model.
 *
 *   node scripts/run-ts.mjs src/main/engineUi.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatSession } from '@shared/types'
import type { EngineState } from '@shared/engines'
import { ENGINE_PROVIDERS, capabilityNotes } from '@shared/engines'
import { API_CHANNELS } from '@shared/ipc'
import { capabilitiesFor } from './agent/engines/factory'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'engine-ui.log')

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

const SESSION: ChatSession = {
  id: 'probe-session',
  title: 'probe',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  archived: false,
  totalCostUsd: 0,
  claudeSessionId: null
}

/** The state as it looks on a machine that has only ever used the Claude CLI. */
function stateFor(selectedId: string): EngineState {
  const capabilities = capabilitiesFor({ providerId: selectedId, model: 'opus' })
  return {
    providers: ENGINE_PROVIDERS.map((provider) => ({
      provider,
      installed: true,
      configured: !provider.needsKey,
      model: provider.id === selectedId ? 'opus' : '',
      baseUrl: provider.baseUrl,
      selected: provider.id === selectedId
    })),
    selectedProviderId: selectedId,
    capabilities,
    effort: '',
    blocked: null,
    notes: capabilityNotes(capabilities)
  }
}

/**
 * Two models with *different* level sets, as the real catalogue has.
 *
 * The difference is the point: the levels are a property of the model, so a picker that showed
 * one list for the provider would offer `ultra` on a model that rejects it.
 */
const CODEX_MODELS = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    supportsTools: true,
    supportsReasoning: true,
    description: 'Latest frontier agentic coding model.',
    reasoningLevels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' }
    ],
    defaultReasoning: 'low'
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    supportsTools: true,
    supportsReasoning: true,
    description: 'Previous generation.',
    reasoningLevels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' }
    ],
    defaultReasoning: 'medium'
  }
]

/** One model, so the setup flow can be walked all the way to its last step. */
const GENERIC_MODEL = {
  id: 'llama-3.3-70b',
  label: 'Llama 3.3 70B',
  contextLength: 131072,
  promptPrice: 0,
  completionPrice: 0,
  supportsTools: true,
  supportsReasoning: false
}

const SETTINGS = {
  workspacePath: '',
  engine: { providerId: 'claude-cli', models: {}, baseUrls: {} },
  model: 'opus',
  effort: 'high',
  defaultCapability: 'curate',
  budget: { mode: 'off', dailyLimitUsd: 1, perTurnLimitUsd: 0.25 },
  curator: {
    enabled: false,
    idleMs: 90000,
    intervalMs: 600000,
    autoLinkSimilar: false,
    useAgent: false,
    similarityThreshold: 0.22
  },
  chat: { showToolActivity: true },
  graph: {
    showTags: false,
    showSimilarEdges: true,
    linkDistance: 83,
    charge: -282,
    labelThreshold: 0.75,
    showLabels: true,
    rotate: false
  },
  layout: { panelWidth: 430 },
  sound: { enabled: false, volume: 0.35 },
  notifications: { enabled: true, onReply: true, onQuestion: true, onProactive: true },
  proactive: {
    enabled: false,
    heartbeat: false,
    quietHours: { enabled: false, startHour: 23, endHour: 7 },
    sweep: { enabled: false, everyHours: 4, slack: true, grain: true, clickup: true }
  },
  appearance: { theme: 'dark', accent: 'violet', reduceMotion: false }
}

/**
 * DeepSeek selected, with a key stored and no model — the reported dead end.
 *
 * The tab said "Choose a model for DeepSeek first" and offered nowhere to choose one: an API
 * provider got a label where Codex got a settings card and the Claude CLI got its own panel, so
 * the key, the address and the model were all unreachable once setup had been left. The only
 * route back was to guess that Change → the provider you are already on reopens the wizard.
 */
function blockedApiState(): EngineState {
  const base = stateFor('deepseek')
  return {
    ...base,
    providers: base.providers.map((entry) =>
      entry.provider.id === 'deepseek'
        ? { ...entry, model: '', configured: true, selected: true }
        : { ...entry, selected: false }
    ),
    selectedProviderId: 'deepseek',
    capabilities: capabilitiesFor({ providerId: 'deepseek', model: '' }),
    blocked: 'Choose a model for DeepSeek first.'
  }
}

/** Codex selected, with a model chosen — the state in which the levels can be shown. */
function codexState(): EngineState {
  const base = stateFor('codex-cli')
  return {
    ...base,
    providers: base.providers.map((entry) =>
      entry.provider.id === 'codex-cli' ? { ...entry, model: 'gpt-5.6-sol' } : entry
    ),
    capabilities: capabilitiesFor({ providerId: 'codex-cli', model: 'gpt-5.6-sol' }),
    effort: 'ultra'
  }
}

const MEASURE = `(() => {
  const heading = Array.from(document.querySelectorAll('h2')).find(
    (el) => el.textContent?.trim() === 'Engine'
  )
  if (!heading) return { mounted: false, body: document.body.innerText.slice(0, 300) }
  const panel = heading.closest('div.flex.h-full') ?? document.body
  return {
    mounted: true,
    text: panel.innerText,
    buttons: Array.from(panel.querySelectorAll('button')).map((el) => el.innerText.trim()).filter(Boolean),
    inputs: Array.from(panel.querySelectorAll('input')).map((el) => el.getAttribute('type'))
  }
})()`

interface Shot {
  mounted: boolean
  body?: string
  text?: string
  buttons?: string[]
  inputs?: (string | null)[]
}

function settle(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function main(): Promise<void> {
  writeFileSync(LOG, `engine ui probe, root=${root}\n`)
  app.on('window-all-closed', () => {})

  for (const channel of API_CHANNELS) ipcMain.handle(channel, () => [])
  for (const [channel, value] of [
    ['inbox:list', { entries: [], unread: 0 }],
    ['chat:messages', []],
    ['chat:sessions', [SESSION]],
    ['graph:get', { nodes: [], edges: [], stamp: 1 }],
    ['update:status', null],
    ['update:whatsNew', null],
    ['app:settings:get', SETTINGS],
    ['engine:state', stateFor('claude-cli')],
    // A machine with neither CLI on it, which is the state the flow had no answer for.
    [
      'engine:cliStatus',
      { providerId: 'codex-cli', installed: false, path: null, version: null, signedIn: null, account: null }
    ],
    ['engine:models', { models: [GENERIC_MODEL], error: null }],
    // Storing a setting must not switch the engine, so setup can configure as it goes and select
    // once at the end. Answered with the same state, which is what the panel does with it.
    ['engine:configure', stateFor('claude-cli')],
    // The end-to-end check, failing — because a failing check is the state worth drawing: it has
    // to report what it managed and still let the user go ahead.
    [
      'engine:verify',
      {
        ok: false,
        message: 'Could not reach http://127.0.0.1:11434/v1. fetch failed. Is Ollama running?',
        reached: false,
        answered: false,
        calledTool: false,
        tokens: null
      }
    ]
  ] as const) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => value)
  }

  ipcMain.removeHandler('app:bootstrap')
  ipcMain.handle('app:bootstrap', () => ({
    pendingReveal: null,
    pendingToolReveal: null,
    budget: {
      enabled: false,
      onSubscription: true,
      spentToday: 0,
      dailyLimitUsd: 0,
      perTurnLimitUsd: 0,
      remaining: null,
      blocked: false
    },
    workspace: { root: '', vaultDir: '', integrationsDir: '', dbPath: '', trashDir: '' },
    settings: SETTINGS,
    stats: { notes: 0, edges: 0, tags: 0, suggestions: 0, lastIndexedAt: Date.now() },
    agent: { available: true, binaryPath: 'x', version: '1', model: 'opus', auth: null },
    session: SESSION,
    secretsEncrypted: true,
    webhookBaseUrl: '',
    appVersion: '0.3.0'
  }))

  await app.whenReady()
  log('app ready')

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
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

  win.webContents.on('console-message', (_e, _level, message) => log(`  [renderer] ${message}`))
  await win.loadFile(join(root, 'out/renderer/index.html'), { hash: '/?shot=engine' })
  win.showInactive()
  await settle(1400)

  await win.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="Engine"]')?.click(), true`
  )
  await settle(800)

  const shot = (await win.webContents.executeJavaScript(MEASURE)) as Shot

  const image = await win.webContents.capturePage()
  writeFileSync(join(OUT, 'engine-tab.png'), image.toPNG())
  log(`  wrote ${join(OUT, 'engine-tab.png')}`)

  /* --------------------------------------------------------------- the tab */

  check('the rail reaches an Engine tab', shot.mounted, shot.body)

  if (shot.mounted) {
    const text = shot.text ?? ''
    check('it names what is running the agent', /Running the agent/i.test(text), text.slice(0, 200))
    check('and the provider', text.includes('Claude Code'), text.slice(0, 200))

    // Whether it can answer at all, on the card rather than discovered by sending a message.
    check('it says whether the engine is ready', /Ready|Needs setup/.test(text), text.slice(0, 300))

    /*
     * The capability grid. This is the app telling the user what the chosen engine can do, which
     * is the whole reason capabilities are declared rather than assumed — and it is drawn as
     * presences *and* absences, because "no built-in shell" only means something beside "yes,
     * tools".
     */
    check('it says what the engine can do', /What it can do/i.test(text), text.slice(0, 400))
    for (const label of ['Reads and writes notes', 'Extended thinking', 'Your MCP connectors']) {
      check(`the grid names "${label}"`, text.includes(label), text.slice(0, 600))
    }

    check(
      'there is a way to change engine',
      (shot.buttons ?? []).some((b) => /Change/i.test(b)),
      shot.buttons
    )

    // A key must never be on screen without being asked for.
    check(
      'no credential field before one is needed',
      (shot.inputs ?? []).every((type) => type !== 'password'),
      shot.inputs
    )
  }

  /* -------------------------------------------------- the step-by-step setup */

  log('\nchoosing a provider')
  {
    // Change is the only way to the list now, so this also proves the route exists.
    await win.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll('button')).find((el) =>
          el.innerText.trim() === 'Change'
        )
        target?.click()
        return true
      })()`
    )
    await settle(500)

    const list = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    const listText = list.text ?? ''
    for (const label of ['Codex', 'OpenRouter', 'DeepSeek', 'OpenAI', 'Ollama']) {
      check(`${label} is offered`, listText.includes(label), label)
    }
    check(
      'and anything else that speaks the dialect',
      /OpenAI-compatible/i.test(listText),
      listText.slice(0, 400)
    )
    // The promise that makes switching safe to try, said where the switch is made.
    check(
      'it promises the vault and history survive a switch',
      /Switching only changes who answers/i.test(listText),
      listText.slice(0, 400)
    )
    check(
      'and names what is kept',
      /notes, conversations, saved tools and scheduled jobs/i.test(listText),
      listText.slice(0, 400)
    )

    // OpenRouter needs a key, so picking it has to open the credential step rather than
    // switching the engine underneath the user.
    await win.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll('button')).find((el) =>
          el.innerText.startsWith('OpenRouter')
        )
        target?.click()
        return true
      })()`
    )
    await settle(600)

    const step = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    const text = step.text ?? ''
    /*
     * The numbering comes off the plan now, not off a literal.
     *
     * It used to be written into each card — "Step 1 of 2", "Step 2 of 2" — against a flow that
     * already skipped a step when a key was stored, so a returning user opened on "step 2 of 2"
     * with no step 1 in existence. OpenRouter's plan is key, model, check: three.
     */
    check('the setup starts at step 1', /step 1 of 3/i.test(text), text.slice(0, 300))
    check('and says which provider it is setting up', /OpenRouter · step/i.test(text), text.slice(0, 300))
    check('asking for the key', /Connect OpenRouter/i.test(text), text.slice(0, 300))
    check('now there is a masked field', (step.inputs ?? []).includes('password'), step.inputs)
    check(
      'and it says where the key is kept',
      /never in a settings file|never shown to the agent/i.test(text),
      text
    )
    check(
      'saving also tests',
      (step.buttons ?? []).some((b) => /Save and test/i.test(b)),
      step.buttons
    )
    check('there is a way back', (step.buttons ?? []).some((b) => /Back/i.test(b)), step.buttons)

    writeFileSync(
      join(OUT, 'engine-setup.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    log(`  wrote ${join(OUT, 'engine-setup.png')}`)
  }

  /* ------------------------------------------------------- a plan of a different length */

  log('\na provider whose setup is a different shape')
  {
    /*
     * A local server has no key and no address anyone can guess, so its plan is endpoint, model,
     * check — a different first step and a different length from OpenRouter's. Hardcoded
     * numbering could not have described both, which is the bug this replaced.
     */
    await win.webContents.executeJavaScript(
      `(() => {
        const back = Array.from(document.querySelectorAll('button')).find((el) => el.innerText.trim() === 'Back')
        back?.click()
        return true
      })()`
    )
    await settle(300)
    await win.webContents.executeJavaScript(
      `(() => {
        const change = Array.from(document.querySelectorAll('button')).find((el) => el.innerText.trim() === 'Change')
        change?.click()
        return true
      })()`
    )
    await settle(400)
    await win.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll('button')).find((el) =>
          el.innerText.startsWith('Ollama')
        )
        target?.click()
        return true
      })()`
    )
    await settle(600)

    const local = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    const text = local.text ?? ''
    check('a keyless provider is not asked for a key', !(local.inputs ?? []).includes('password'), local.inputs)
    check('it starts on the address instead', /Point at the endpoint/i.test(text), text.slice(0, 300))
    check('and its plan has its own length', /step 1 of 3/i.test(text), text.slice(0, 300))
    // "Installed" is meaningless for a server that has to be started; the empty model list you
    // get otherwise explains nothing on its own.
    check('it says the server has to be running', /has to be running/i.test(text), text.slice(0, 500))

    // And the last step is the one the flow never had: does it actually hold a turn.
    await win.webContents.executeJavaScript(
      `(() => {
        const go = Array.from(document.querySelectorAll('button')).find((el) => el.innerText.trim() === 'Continue')
        go?.click()
        return true
      })()`
    )
    await settle(700)
    const model = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    check('then the model', /step 2 of 3/i.test(model.text ?? ''), (model.text ?? '').slice(0, 300))

    /* ------------------------------------------------------------- the last step */

    await win.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll('button')).find((el) =>
          el.innerText.includes('Llama 3.3 70B')
        )
        target?.click()
        return true
      })()`
    )
    await settle(700)

    const verify = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    const verifyText = verify.text ?? ''
    /*
     * The step the flow never had.
     *
     * Everything before it is a necessary condition that a broken setup can satisfy: a key with
     * no completions quota lists models, a model that ignores tools looks identical in the
     * picker, and a Codex install whose session expired publishes its catalogue from disk. The
     * flow used to end at "a model was chosen" and leave the real answer to the user's first
     * question.
     */
    check('the flow ends on a real check', /step 3 of 3/i.test(verifyText), verifyText.slice(0, 400))
    check('which says what it will do first', /Sends one short message/i.test(verifyText), verifyText.slice(0, 500))
    check(
      'and does not run on arrival',
      (verify.buttons ?? []).some((b) => /Run the check/i.test(b)),
      verify.buttons
    )

    await win.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll('button')).find((el) =>
          el.innerText.trim() === 'Run the check'
        )
        target?.click()
        return true
      })()`
    )
    await settle(800)

    const checked = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    const checkedText = checked.text ?? ''
    // Three lights rather than one verdict: "answers but will not call a tool" is the common
    // middle outcome and it decides whether the agent can touch a single note.
    check('a failure reports how far it got', /Reached Ollama/i.test(checkedText), checkedText.slice(0, 600))
    check('and names the tool question separately', /can use your notes/i.test(checkedText), checkedText.slice(0, 600))
    check('the reason is shown', /Is Ollama running/i.test(checkedText), checkedText.slice(0, 700))
    // The check is advice, not a gate. A provider having a bad minute must not be able to trap
    // someone in a setup screen.
    check(
      'and it still lets you go ahead',
      (checked.buttons ?? []).some((b) => /Use Ollama/i.test(b)),
      checked.buttons
    )

    writeFileSync(join(OUT, 'engine-verify.png'), (await win.webContents.capturePage()).toPNG())
    log(`  wrote ${join(OUT, 'engine-verify.png')}`)
  }

  /* ------------------------------------------- installing a CLI from nothing */

  log('\ninstalling a CLI that is not there')
  {
    /*
     * The whole flow for someone who has never used a terminal.
     *
     * Choosing Codex without having Codex used to produce a toast — "Codex is not installed on
     * this machine" — and stop. A problem named, no way through it, and a search engine as the
     * next step. This walks the replacement: install, sign in, check.
     */
    await win.webContents.executeJavaScript(
      `(() => {
        const back = Array.from(document.querySelectorAll('button')).find((el) => el.innerText.trim() === 'Back')
        back?.click()
        return true
      })()`
    )
    await settle(300)
    await win.webContents.executeJavaScript(
      `(() => {
        const change = Array.from(document.querySelectorAll('button')).find((el) => el.innerText.trim() === 'Change')
        change?.click()
        return true
      })()`
    )
    await settle(400)
    await win.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll('button')).find((el) =>
          el.innerText.startsWith('Codex')
        )
        target?.click()
        return true
      })()`
    )
    await settle(800)

    const install = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    const text = install.text ?? ''

    check('choosing an absent CLI opens a step, not a dead end', /Install Codex/i.test(text), text.slice(0, 400))
    check('and its plan is three steps', /Codex · step 1 of 3/i.test(text), text.slice(0, 200))
    check(
      'it says what the thing even is',
      /separate program that runs on your computer/i.test(text),
      text.slice(0, 500)
    )

    /*
     * A command, for the platform this app is running on, that can be copied.
     *
     * Quoted from the vendor's own documentation rather than remembered — a wrong install
     * command is precisely the dead end this step exists to remove.
     */
    check('there is a command to run', /winget install OpenAI.Codex|codex\/install\.sh|@openai\/codex/.test(text), text.slice(0, 700))
    check('it names the terminal to paste it into', /Paste this into/i.test(text), text.slice(0, 700))
    check(
      'and it can be copied rather than retyped',
      (install.buttons ?? []).some((label) => /Copy/i.test(label)),
      install.buttons
    )
    // The button that makes the flow work at all: the binary path is cached, so without a
    // deliberate re-look someone is told it is still missing until they restart the app.
    check(
      'there is a way to say it is done',
      (install.buttons ?? []).some((label) => /I have installed it/i.test(label)),
      install.buttons
    )
    /*
     * And no failure is reported before anyone has tried anything.
     *
     * The panel looked once on the way in, so the "still not finding it" advice is true from the
     * first frame — and in front of someone who has not yet been asked to do anything it reads
     * as an error rather than as the result of their attempt.
     */
    check('and nothing is reported as failing yet', !/Still not finding it/i.test(text), text.slice(0, 700))

    writeFileSync(join(OUT, 'engine-install.png'), (await win.webContents.capturePage()).toPNG())
    log(`  wrote ${join(OUT, 'engine-install.png')}`)

    /* --------------------------------------------------- and then signing in */

    ipcMain.removeHandler('engine:cliStatus')
    ipcMain.handle('engine:cliStatus', () => ({
      providerId: 'codex-cli',
      installed: true,
      path: 'C:/codex.exe',
      version: 'codex-cli 0.147.0',
      /*
       * Unknown, which is Codex's real answer and the interesting one.
       *
       * `codex login status` prints "Logged in using ChatGPT" even with a spent refresh token, so
       * a positive from it is worthless. The app reads a negative as fact and everything else as
       * unknown — and says so, rather than showing a green tick it cannot stand behind.
       */
      signedIn: null,
      account: null
    }))

    await win.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll('button')).find((el) =>
          el.innerText.includes('I have installed it')
        )
        target?.click()
        return true
      })()`
    )
    await settle(900)

    const signin = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    const signinText = signin.text ?? ''
    check('finding it moves straight on rather than congratulating you', /Sign Codex in/i.test(signinText), signinText.slice(0, 300))
    check('it is step 2', /step 2 of 3/i.test(signinText), signinText.slice(0, 200))
    check('with the sign-in command', /codex login/.test(signinText), signinText.slice(0, 600))
    check(
      'and says what running it does',
      /Opens your browser/i.test(signinText),
      signinText.slice(0, 600)
    )
    /*
     * The honesty that matters most for Codex: it reports being logged in while its refresh
     * token is spent, so a positive from it cannot be trusted and the screen says so.
     */
    check(
      'it warns that the next step is the real answer',
      /does not report this reliably/i.test(signinText),
      signinText.slice(0, 800)
    )

    writeFileSync(join(OUT, 'engine-signin.png'), (await win.webContents.capturePage()).toPNG())
    log(`  wrote ${join(OUT, 'engine-signin.png')}`)

    await win.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll('button')).find((el) => el.innerText.trim() === 'Continue')
        target?.click()
        return true
      })()`
    )
    await settle(700)
    const last = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    check('and it ends on the real check', /step 3 of 3/i.test(last.text ?? ''), (last.text ?? '').slice(0, 300))
  }

  /* --------------------------------------------- an engine that cannot run yet */

  log('\na selected engine that is not finished')

  ipcMain.removeHandler('engine:state')
  ipcMain.handle('engine:state', () => blockedApiState())

  // Left and returned to, which is what unmounts the panel and drops any wizard step it was
  // on. The Settings fallback matters: without it the rail click can miss and the panel stays
  // exactly where the previous section left it, which reads as every assertion below failing.
  await win.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="Graph"]')?.click()
     || document.querySelector('button[aria-label="Settings"]')?.click(), true`
  )
  await settle(400)
  await win.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="Engine"]')?.click(), true`
  )
  await settle(900)

  {
    const blocked = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    const text = blocked.text ?? ''
    check('it still says what is wrong', /Choose a model for DeepSeek/i.test(text), text.slice(0, 400))
    /*
     * And now offers to fix it. This is the whole report: the message named the missing thing
     * and nothing on the screen could supply it.
     */
    check(
      'and offers a way to fix it',
      (blocked.buttons ?? []).some((b) => /Choose a model/i.test(b)),
      blocked.buttons
    )
    // The settings an API provider has, which previously appeared nowhere at all.
    check('the key is shown as stored', /API key\s*stored/i.test(text), text.slice(0, 600))
    check('the address is shown', /api\.deepseek\.com/i.test(text), text.slice(0, 600))
    check(
      'and the key can be replaced or removed without the wizard',
      (blocked.buttons ?? []).some((b) => /Replace/i.test(b)) &&
        (blocked.buttons ?? []).some((b) => /Remove/i.test(b)),
      blocked.buttons
    )

    /*
     * Thinking, which no API provider had a control for anywhere.
     *
     * `settings.engine.efforts` has existed all along, `effortFor` reads it on every turn and
     * `reasoningPatch` knows four wire dialects for it — and nothing offered to set it, so every
     * API engine ran at whatever the provider does when it is not told. Codex got a picker
     * because its levels are published per model; the providers whose levels are the app's own
     * five got nothing, which is the wrong way round.
     */
    check('there is a thinking control', /Thinking/i.test(text), text.slice(0, 800))
    for (const tier of ['low', 'high', 'max']) {
      check(`the ${tier} tier is offered`, (blocked.buttons ?? []).includes(tier), blocked.buttons)
    }
    check(
      'and letting the provider decide stays a choice',
      (blocked.buttons ?? []).some((b) => /provider default/i.test(b)),
      blocked.buttons
    )

    writeFileSync(join(OUT, 'engine-blocked.png'), (await win.webContents.capturePage()).toPNG())
    log(`  wrote ${join(OUT, 'engine-blocked.png')}`)

    // Pressing it must land on the step that clears the block, not at the top of the wizard.
    await win.webContents.executeJavaScript(
      `(() => {
        const target = Array.from(document.querySelectorAll('button')).find((el) =>
          el.innerText.trim() === 'Choose a model'
        )
        target?.click()
        return true
      })()`
    )
    await settle(700)
    const landed = (await win.webContents.executeJavaScript(MEASURE)) as Shot
    check(
      'the fix lands on the step that clears it',
      /Choose a model/i.test(landed.text ?? '') && /DeepSeek · step/i.test(landed.text ?? ''),
      (landed.text ?? '').slice(0, 300)
    )

  }

  /* -------------------------------------------------------------- codex */

  ipcMain.removeHandler('engine:state')
  ipcMain.handle('engine:state', () => codexState())
  ipcMain.removeHandler('engine:models')
  ipcMain.handle('engine:models', () => ({ models: CODEX_MODELS, error: null }))

  // Left and returned to, because that is how a user reaches it: the panel reads its state on
  // mount, and a state swapped underneath a mounted panel would prove nothing about the path.
  await win.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="Graph"]')?.click()
     || document.querySelector('button[aria-label="Settings"]')?.click(), true`
  )
  await settle(300)
  await win.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="Engine"]')?.click(), true`
  )
  await settle(900)

  const codex = (await win.webContents.executeJavaScript(MEASURE)) as Shot
  const codexImage = await win.webContents.capturePage()
  writeFileSync(join(OUT, 'engine-tab-codex.png'), codexImage.toPNG())
  log(`  wrote ${join(OUT, 'engine-tab-codex.png')}`)

  const codexText = codex.text ?? ''
  check('choosing Codex shows a Codex card', /Codex/.test(codexText), codexText.slice(0, 200))
  check(
    'it offers the models Codex publishes',
    codexText.includes('GPT-5.6-Sol') && codexText.includes('GPT-5.5'),
    codexText.slice(0, 400)
  )
  check(
    'and "use your own Codex default" stays a choice',
    /Your Codex default/i.test(codexText),
    codexText.slice(0, 400)
  )
  check(
    'the thinking levels are the chosen model\'s own',
    codexText.includes('ultra'),
    codexText.slice(0, 600)
  )
  check(
    'a level the chosen model does not publish is not offered',
    !/\bxhigh\b/.test(codexText),
    codexText.slice(0, 600)
  )
  /*
   * And it says the sandbox is gone, because it is.
   *
   * The card used to promise "Codex runs in its own sandbox … and nothing outside it". That
   * stopped being true the moment the engine had to be launched with the flag that makes tool
   * calls work at all, and a stale reassurance is worse than none.
   */
  check(
    'the sandbox situation is stated, not promised away',
    /not sandboxed/i.test(codexText),
    codexText.slice(0, 900)
  )
  check(
    'and the reason is given rather than left as a scare',
    /cancels every tool call/i.test(codexText),
    codexText.slice(0, 900)
  )

  await new Promise<void>((resolve) => {
    win.once('closed', () => resolve())
    win.destroy()
  })

  log(failures === 0 ? '\nall engine ui checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

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
    ['engine:models', { models: [], error: null }]
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
    check('the setup starts at step 1', /Step 1 of 2/i.test(text), text.slice(0, 300))
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
  check(
    'the sandbox is explained',
    /sandbox/i.test(codexText),
    codexText.slice(0, 600)
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

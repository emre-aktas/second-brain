/**
 * A tool's model and thinking level, drawn in the terms of the engine that is running.
 *
 * The setting has existed for a long time and until now it was a fixed list of four Claude names
 * and five Claude tiers, whatever the engine was — so on Codex it offered "Opus 5", and the
 * manager quite correctly discarded the answer rather than send a model name Codex has never
 * heard of. Visible, settable, inert. That is a shape of bug this app has produced more than once
 * and it is invisible to every check that does not actually look at the screen.
 *
 * So this mounts the real Tools panel with Codex selected and a stubbed Codex catalogue, opens a
 * tool's settings, and reads what the pickers offer.
 *
 *   node scripts/run-ts.mjs src/main/toolPrefs.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatSession, SavedTool } from '@shared/types'
import type { EngineState } from '@shared/engines'
import { ENGINE_PROVIDERS, capabilityNotes } from '@shared/engines'
import { API_CHANNELS } from '@shared/ipc'
import { capabilitiesFor } from './agent/engines/factory'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'tool-prefs.log')

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

/** A code tool, because the settings panel is offered for interactive kinds. */
const TOOL: SavedTool = {
  id: 'tool-1',
  name: 'Hızlı çeviri',
  description: 'Tek cümle çevirir',
  kind: 'code',
  instructions: '',
  sessionId: null,
  state: {},
  actions: [{ id: 'go', label: 'Çevir', prompt: 'x', target: 'output' }],
  fields: [],
  layout: [],
  source: '<div>x</div>',
  hotkey: null,
  openInWindow: false,
  alwaysOnTop: false,
  windowWidth: null,
  windowHeight: null,
  windowMaximized: false,
  // Already pinned to a Codex model and a Codex-only level, which is the thing that could not be
  // expressed at all before: `ultra` is not in the app's own `AgentEffort` union.
  enginePrefs: { 'codex-cli': { model: 'gpt-5.6-sol', effort: 'ultra' } },
  rev: 0,
  icon: null,
  prompt: '',
  params: [],
  pinned: false,
  sortOrder: 0,
  createdBy: 'agent',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  runCount: 0,
  lastRunAt: null,
  lastSpecId: null
}

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
      { effort: 'low', description: 'Fast' },
      { effort: 'high', description: 'Deeper' },
      { effort: 'ultra', description: 'Maximum' }
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
    reasoningLevels: [{ effort: 'low', description: 'Fast' }],
    defaultReasoning: 'low'
  }
]

function codexState(): EngineState {
  const capabilities = capabilitiesFor({ providerId: 'codex-cli', model: 'gpt-5.6-sol' })
  return {
    providers: ENGINE_PROVIDERS.map((provider) => ({
      provider,
      installed: true,
      configured: !provider.needsKey,
      model: provider.id === 'codex-cli' ? 'gpt-5.6-sol' : '',
      baseUrl: provider.baseUrl,
      selected: provider.id === 'codex-cli'
    })),
    selectedProviderId: 'codex-cli',
    capabilities,
    effort: '',
    blocked: null,
    notes: capabilityNotes(capabilities)
  }
}

const SETTINGS = {
  workspacePath: '',
  engine: { providerId: 'codex-cli', models: { 'codex-cli': 'gpt-5.6-sol' }, baseUrls: {}, efforts: {} },
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

/** Every option in every select on the panel, which is what "what can I choose" means. */
const MEASURE = `(() => {
  const heading = Array.from(document.querySelectorAll('h2')).find(
    (el) => el.textContent?.trim() === 'Tools'
  )
  if (!heading) return { mounted: false, body: document.body.innerText.slice(0, 300) }
  const panel = heading.closest('div.flex.h-full') ?? document.body
  return {
    mounted: true,
    text: panel.innerText,
    buttons: Array.from(panel.querySelectorAll('button')).map((el) => el.getAttribute('aria-label') || el.innerText.trim()).filter(Boolean),
    selects: Array.from(panel.querySelectorAll('select')).map((el) => ({
      label: el.getAttribute('aria-label'),
      value: el.value,
      options: Array.from(el.options).map((option) => option.textContent)
    }))
  }
})()`

interface Shot {
  mounted: boolean
  body?: string
  text?: string
  buttons?: string[]
  selects?: { label: string | null; value: string; options: (string | null)[] }[]
}

function settle(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function main(): Promise<void> {
  writeFileSync(LOG, `tool prefs probe, root=${root}\n`)
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
    ['tools:list', [TOOL]],
    ['tools:shortcutStates', []],
    ['engine:state', codexState()],
    ['engine:models', { models: CODEX_MODELS, error: null, configured: { model: 'gpt-5.6-sol', effort: 'max' } }]
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
    stats: { nodes: 0, edges: 0, notes: 0, tags: 0, stubs: 0, orphans: 0, clusters: 0 },
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
  await win.loadFile(join(root, 'out/renderer/index.html'), { hash: '/?shot=tools' })
  win.showInactive()
  await settle(1400)

  await win.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="Tools"]')?.click(), true`
  )
  await settle(700)

  const listed = (await win.webContents.executeJavaScript(MEASURE)) as Shot
  check('the rail reaches the Tools tab', listed.mounted, listed.body)
  check('the tool is listed', (listed.text ?? '').includes('Hızlı çeviri'), (listed.text ?? '').slice(0, 200))

  /*
   * A gear, not a keyboard.
   *
   * The panel behind it started life holding only a shortcut and now holds the window options,
   * the model and the thinking level — an icon that names one row of a panel sends people
   * looking for the rest of it somewhere else.
   */
  check(
    'the settings button is named for the panel, not for one row of it',
    (listed.buttons ?? []).includes('Tool settings'),
    listed.buttons
  )

  await win.webContents.executeJavaScript(
    `(() => {
      const target = Array.from(document.querySelectorAll('button')).find(
        (el) => el.getAttribute('aria-label') === 'Tool settings'
      )
      target?.click()
      return true
    })()`
  )
  await settle(700)

  const open = (await win.webContents.executeJavaScript(MEASURE)) as Shot
  const model = open.selects?.find((select) => select.label === 'Model for this tool')
  const effort = open.selects?.find((select) => select.label === 'Thinking budget for this tool')

  writeFileSync(join(OUT, 'tool-prefs.png'), (await win.webContents.capturePage()).toPNG())
  log(`  wrote ${join(OUT, 'tool-prefs.png')}`)

  check('the settings panel opens', model !== undefined, open.selects)

  /*
   * The engine's own catalogue, not the app's four Claude names.
   *
   * This is the whole check. The list used to be `MODEL_OPTIONS` regardless of engine, so a user
   * on Codex was offered Opus and Sonnet and the manager threw the answer away.
   */
  check(
    'the models are the ones this engine publishes',
    (model?.options ?? []).some((option) => option?.includes('GPT-5.6-Sol')),
    model?.options
  )
  check(
    'and not the app’s Claude names',
    !(model?.options ?? []).some((option) => option?.includes('Opus')),
    model?.options
  )
  // Following the app is still a first-class choice, and the honest default for most tools.
  check(
    'app default remains a choice',
    (model?.options ?? []).some((option) => option?.includes('App default')),
    model?.options
  )
  check('the stored choice is shown as selected', model?.value === 'gpt-5.6-sol', model?.value)

  /*
   * And the thinking levels belong to the model, not to the app.
   *
   * `ultra` exists on this Codex model and in no other vocabulary — it is not in the app's own
   * `AgentEffort` union, which is exactly why the old fixed list could not express it.
   */
  check(
    'the thinking levels are the engine’s own',
    (effort?.options ?? []).some((option) => option?.includes('ultra')),
    effort?.options
  )
  check(
    'a level this model does not publish is not offered',
    !(effort?.options ?? []).some((option) => option?.includes('xhigh')),
    effort?.options
  )
  check('the stored level is shown as selected', effort?.value === 'ultra', effort?.value)

  await new Promise<void>((resolve) => {
    win.once('closed', () => resolve())
    win.destroy()
  })

  log(failures === 0 ? '\nall tool prefs checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

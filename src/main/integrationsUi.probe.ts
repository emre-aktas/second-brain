/**
 * The approval surface, drawn by the real renderer.
 *
 * `integrations.probe.ts` proves the data is right; this proves there is a screen. The bug it
 * guards against is not a wrong pixel — it is the panel not being there at all. `Panel` has
 * always included `'integrations'` and `IntegrationsPanel` has always been exported, but the rail
 * had no entry for it and `App.tsx` had no branch that rendered it, so an integration the agent
 * registered had nowhere to be approved. Nothing failed to compile and no test noticed.
 *
 * So the first check is the one that matters most: click the rail, and see the card.
 *
 * No model, no network. Every channel is stubbed.
 *
 *   node scripts/run-ts.mjs src/main/integrationsUi.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatSession, IntegrationSummary } from '@shared/types'
import { API_CHANNELS } from '@shared/ipc'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'integrations-ui.log')

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

/** The integration from the report, exactly as `describeAll` would present it. */
const PENDING: IntegrationSummary = {
  id: 'figma-rest',
  name: 'Figma (read-only)',
  description: 'Reads Figma files, nodes and comments.',
  kind: 'rest',
  status: 'pending',
  createdBy: 'agent',
  health: 'unknown',
  lastError: null,
  baseUrl: 'https://api.figma.com',
  operations: [
    { name: 'get_file', description: 'One file.', method: 'GET', path: '/v1/files/{file_key}', mutating: false },
    { name: 'get_nodes', description: 'Nodes.', method: 'GET', path: '/v1/files/{file_key}/nodes', mutating: false },
    { name: 'get_comments', description: 'Comments.', method: 'GET', path: '/v1/files/{file_key}/comments', mutating: false }
  ],
  secrets: [
    {
      ref: 'figma_pat',
      label: 'Figma personal access token',
      hint: 'figma.com → Settings → Personal access tokens',
      isSet: false,
      encrypted: false,
      updatedAt: null,
      expiresAt: null,
      expired: false,
      borrowedFrom: null
    }
  ],
  missingSecrets: ['figma_pat'],
  ready: false,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now()
}

/** The same integration once the credential is in and past the date the user gave it. */
const EXPIRED: IntegrationSummary = {
  ...PENDING,
  status: 'enabled',
  health: 'ok',
  ready: true,
  missingSecrets: [],
  secrets: [
    {
      ...PENDING.secrets[0],
      isSet: true,
      encrypted: true,
      updatedAt: Date.now() - 8 * 24 * 3600_000,
      expiresAt: Date.now() - 24 * 3600_000,
      expired: true
    }
  ]
}

function settingsFor(theme: 'dark' | 'light'): Record<string, unknown> {
  return {
    workspacePath: '',
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
    appearance: { theme, accent: 'violet', reduceMotion: false }
  }
}

function settle(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** What the panel actually put on screen. */
const MEASURE = `(() => {
  const heading = Array.from(document.querySelectorAll('h2')).find(
    (el) => el.textContent === 'Integrations'
  )
  if (!heading) return { mounted: false, body: document.body.innerText.slice(0, 300) }

  const panel = heading.closest('div.flex.h-full') ?? document.body
  const inputs = Array.from(panel.querySelectorAll('input')).map((el) => ({
    type: el.getAttribute('type'),
    id: el.getAttribute('id'),
    placeholder: el.getAttribute('placeholder')
  }))

  return {
    mounted: true,
    text: panel.innerText,
    inputs,
    buttons: Array.from(panel.querySelectorAll('button')).map((el) => el.innerText.trim()).filter(Boolean),
    switches: Array.from(panel.querySelectorAll('[role="switch"]')).map((el) => ({
      checked: el.getAttribute('aria-checked'),
      disabled: el.hasAttribute('disabled') || el.getAttribute('data-disabled') !== null
    }))
  }
})()`

interface Shot {
  mounted: boolean
  body?: string
  text?: string
  inputs?: { type: string | null; id: string | null; placeholder: string | null }[]
  buttons?: string[]
  switches?: { checked: string | null; disabled: boolean }[]
}

async function capture(
  label: string,
  theme: 'dark' | 'light',
  summaries: IntegrationSummary[]
): Promise<Shot> {
  const settings = settingsFor(theme)

  for (const channel of ['app:bootstrap', 'app:settings:get', 'integrations:summaries']) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('app:settings:get', () => settings)
  ipcMain.handle('integrations:summaries', () => summaries)
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
    settings,
    stats: { notes: 0, edges: 0, tags: 0, suggestions: 0, lastIndexedAt: Date.now() },
    agent: { available: true, binaryPath: 'x', version: '1', model: 'opus', auth: null },
    session: SESSION,
    // False on purpose in one pass, so the "local key" warning is exercised too.
    secretsEncrypted: theme === 'light',
    webhookBaseUrl: '',
    appVersion: '0.2.0'
  }))

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
  await win.loadFile(join(root, 'out/renderer/index.html'), { hash: `/?shot=${label}` })
  win.showInactive()
  await settle(1400)

  // Through the rail button, which is the check: the entry has to exist and it has to render the
  // panel. Reaching into the store instead would prove a state field can be set and nothing else.
  await win.webContents.executeJavaScript(
    `document.querySelector('button[aria-label="Integrations"]')?.click(), true`
  )
  await settle(900)

  const shot = (await win.webContents.executeJavaScript(MEASURE)) as Shot

  const image = await win.webContents.capturePage()
  const file = join(OUT, `integrations-${label}.png`)
  writeFileSync(file, image.toPNG())
  log(`  wrote ${file}`)

  await new Promise<void>((resolve) => {
    win.once('closed', () => resolve())
    win.destroy()
  })
  await settle(300)

  return shot
}

async function main(): Promise<void> {
  writeFileSync(LOG, `integrations ui probe, root=${root}\n`)
  app.on('window-all-closed', () => {})

  for (const channel of API_CHANNELS) ipcMain.handle(channel, () => [])
  for (const [channel, value] of [
    ['inbox:list', { entries: [], unread: 0 }],
    ['chat:messages', []],
    ['chat:sessions', [SESSION]],
    ['graph:get', { nodes: [], edges: [], stamp: 1 }],
    ['update:status', null],
    ['update:whatsNew', null]
  ] as const) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => value)
  }

  await app.whenReady()
  log('app ready')

  /* --------------------------------------------- the panel exists and shows the card */

  log('\na pending integration (dark)')
  {
    const shot = await capture('pending-dark', 'dark', [PENDING])

    // The bug: there was no Integrations panel in the running app.
    check('the rail reaches an Integrations panel', shot.mounted, shot.body)
    if (shot.mounted) {
      const text = shot.text ?? ''
      check('the integration is on screen', text.includes('Figma (read-only)'), text.slice(0, 300))
      check('it says what it is waiting for', /needs a credential/i.test(text), text)
      check('and who built it', /built by the agent/i.test(text), text)
      check('the header counts what is waiting', /1 waiting on you/i.test(text), text)

      // What it will be allowed to call, before approving — with method and path.
      check('the operation list is headed', /What it will be allowed to call/i.test(text), text)
      check('every path is shown', text.includes('/v1/files/{file_key}/comments'), text)
      check('with its method', text.includes('GET'), text)
      check('and the base URL', text.includes('https://api.figma.com'), text)

      // The masked field, open without a click: this is the row whose whole point is to ask.
      const masked = (shot.inputs ?? []).filter((input) => input.type === 'password')
      check('a masked input is present', masked.length === 1, shot.inputs)
      check('bound to the declared ref', masked[0]?.id === 'figma_pat', masked)
      check('the label is the manifest label', text.includes('Figma personal access token'), text)
      check('the hint is shown', /Personal access tokens/i.test(text), text)

      // Optional expiry, because a 7-day token that dies silently is the real failure mode.
      const dates = (shot.inputs ?? []).filter((input) => input.type === 'date')
      check('an expiry field is offered', dates.length === 1, shot.inputs)

      // Enable is gated until every ref has a value.
      const gate = shot.switches?.[0]
      check('the enable switch is off', gate?.checked === 'false', shot.switches)
      check('and disabled until the credential is in', gate?.disabled === true, shot.switches)

      const buttons = shot.buttons ?? []
      // One press for the whole intention. Save-then-find-the-test-button-then-find-the-switch
      // is three decisions for one act, and the middle one is the step people skip.
      check('saving also tests', buttons.some((b) => /Save and test/i.test(b)), buttons)
      check('and a test stands alone too', buttons.some((b) => /Test connection/i.test(b)), buttons)
      // Never rendered by default — it has to be asked for.
      check('nothing is revealed by default', !buttons.some((b) => /^Hide$/i.test(b)), buttons)
    }
  }

  /* ------------------------------------------------ a set, expired credential (light) */

  log('\na credential past its expiry (light)')
  {
    const shot = await capture('expired-light', 'light', [EXPIRED])

    check('the panel is there in light too', shot.mounted, shot.body)
    if (shot.mounted) {
      const text = shot.text ?? ''
      check('the expiry warning is shown', /passed the expiry you set/i.test(text), text)
      check('the credential reads as set', /set /i.test(text), text)
      check('and says where it is kept', /OS keychain/i.test(text), text)

      const buttons = shot.buttons ?? []
      check('reveal is offered behind a press', buttons.some((b) => /Reveal/i.test(b)), buttons)
      check('rotate is offered', buttons.some((b) => /Rotate/i.test(b)), buttons)
      check('delete is offered', buttons.some((b) => /Delete/i.test(b)), buttons)
      // No masked field: the value is in, and replacing it is behind Rotate.
      check(
        'no input is shown until rotate is pressed',
        (shot.inputs ?? []).every((input) => input.type !== 'password'),
        shot.inputs
      )

      const gate = shot.switches?.[0]
      check('a ready integration can be switched', gate?.disabled === false, shot.switches)
      check('and reads as enabled', gate?.checked === 'true', shot.switches)
    }
  }

  log(failures === 0 ? '\nall integrations ui checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

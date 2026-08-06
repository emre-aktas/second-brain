/**
 * The two update surfaces, drawn by the real renderer.
 *
 * `updater.probe.ts` proves the sequence; this proves there is something on screen at the end
 * of it. Both of these are dialogs a user sees rarely and at a moment when the app is about to
 * restart itself, which is the worst possible time to discover that the notes render as raw
 * markdown or that the button is missing.
 *
 * Two captures. The offer in dark, the "what's new" in light — one surface each, both palettes
 * exercised, and no window opened that is not asserted on.
 *
 * No model, no network. Every channel is stubbed.
 *
 *   node scripts/run-ts.mjs src/main/updateUi.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatSession, UpdateStatus, WhatsNew } from '@shared/types'
import { API_CHANNELS } from '@shared/ipc'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
const root = resolve(process.cwd())
const LOG = join(OUT, 'update-ui.log')

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

const NOTES = [
  '- The schedule is on an axis now, so you can see what runs when',
  '- Nodes grow with how connected they are',
  '',
  'A second paragraph, to prove the markdown is rendered rather than printed.'
].join('\n')

const OFFERED: UpdateStatus = {
  phase: 'available',
  capability: 'install',
  currentVersion: '0.1.0',
  version: '0.2.0',
  notes: NOTES,
  releaseUrl: 'https://github.com/emre-aktas/second-brain/releases/tag/v0.2.0',
  percent: 0,
  bytesPerSecond: 0,
  checkedAt: Date.now(),
  message: null
}

const QUIET: UpdateStatus = { ...OFFERED, phase: 'idle', version: null, notes: null }

const WHATS_NEW: WhatsNew = {
  version: '0.2.0',
  notes: NOTES,
  releaseUrl: 'https://github.com/emre-aktas/second-brain/releases/tag/v0.2.0'
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

/** Whatever dialog is open, read out of the live DOM. */
const MEASURE = `(() => {
  const dialog = document.querySelector('[role="dialog"]')
  if (!dialog) return { open: false, footer: document.body.innerText.slice(0, 400) }
  const box = dialog.getBoundingClientRect()
  return {
    open: true,
    text: dialog.innerText,
    width: box.width,
    height: box.height,
    buttons: Array.from(dialog.querySelectorAll('button')).map((el) => el.innerText.trim()).filter(Boolean),
    // The notes must arrive as elements, not as a paragraph of asterisks and dashes.
    listItems: dialog.querySelectorAll('li').length,
    paragraphs: dialog.querySelectorAll('p').length
  }
})()`

interface Shot {
  open: boolean
  text?: string
  footer?: string
  width?: number
  height?: number
  buttons?: string[]
  listItems?: number
  paragraphs?: number
}

async function capture(
  label: string,
  theme: 'dark' | 'light',
  status: UpdateStatus,
  whatsNew: WhatsNew | null
): Promise<Shot> {
  const settings = settingsFor(theme)

  for (const channel of ['app:bootstrap', 'app:settings:get', 'update:status', 'update:whatsNew']) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('app:settings:get', () => settings)
  ipcMain.handle('update:status', () => status)
  ipcMain.handle('update:whatsNew', () => whatsNew)
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
    secretsEncrypted: false,
    webhookBaseUrl: '',
    appVersion: '0.1.0'
  }))

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
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
  // The hash differs per capture because reloading an identical file URL fails with ERR_FAILED.
  await win.loadFile(join(root, 'out/renderer/index.html'), { hash: `/?shot=${label}` })
  win.showInactive()
  // Long enough for the dialog's own enter transition to finish, or the capture catches it
  // mid-scale and every measurement is of a frame nobody sees.
  await settle(1800)

  const shot = (await win.webContents.executeJavaScript(MEASURE)) as Shot

  const image = await win.webContents.capturePage()
  const file = join(OUT, `update-${label}.png`)
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
  writeFileSync(LOG, `update ui probe, root=${root}\n`)
  app.on('window-all-closed', () => {})

  for (const channel of API_CHANNELS) ipcMain.handle(channel, () => [])
  // A blanket [] is a lie for anything whose reply is an object: the renderer reads fields off
  // these, and an array has none of them.
  for (const [channel, value] of [
    ['inbox:list', { entries: [], unread: 0 }],
    ['chat:messages', []],
    ['chat:sessions', [SESSION]],
    ['graph:get', { nodes: [], edges: [], stamp: 1 }]
  ] as const) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => value)
  }

  await app.whenReady()
  log('app ready')

  /* ------------------------------------------------------------------ the offer */

  log('\nthe offer (dark)')
  {
    const shot = await capture('offer-dark', 'dark', OFFERED, null)

    // It opens itself. Waiting for someone to notice a marker in the footer is how an update
    // sits uninstalled for weeks, which defeats the whole feature.
    check('the offer opens on its own', shot.open, shot.footer)
    if (shot.open) {
      const text = shot.text ?? ''
      check('it names the new version', text.includes('0.2.0'), text)
      check('and the one being replaced', text.includes('0.1.0'), text)
      // Rendered markdown, not printed markdown. Two bullets and a paragraph.
      check('the notes are rendered', (shot.listItems ?? 0) >= 2, shot.listItems)
      check('including the prose', (shot.paragraphs ?? 0) >= 1, shot.paragraphs)
      check('the notes are not raw', !text.includes('- The schedule is on an axis'), text.slice(0, 200))

      const buttons = shot.buttons ?? []
      check(
        'one button does the whole job',
        buttons.some((b) => /download and install/i.test(b)),
        buttons
      )
      check('and there is a way out', buttons.some((b) => /later/i.test(b)), buttons)
      // English, because the app is in English — no localised strings anywhere in this path.
      check('nothing is localised', !/[şğıçöü]/i.test(text), text)

      check('the sheet has real size', (shot.width ?? 0) > 380 && (shot.height ?? 0) > 180, {
        width: shot.width,
        height: shot.height
      })
    }
  }

  /* -------------------------------------------------------------- what's new */

  log("\nwhat's new (light)")
  {
    const shot = await capture('whatsnew-light', 'light', QUIET, WHATS_NEW)

    check('what changed is shown after the restart', shot.open, shot.footer)
    if (shot.open) {
      const text = shot.text ?? ''
      check('it is headed as new', /what.s new/i.test(text), text)
      check('it names the version now running', text.includes('0.2.0'), text)
      check('the notes are rendered here too', (shot.listItems ?? 0) >= 2, shot.listItems)
      check(
        'and it can be dismissed',
        (shot.buttons ?? []).some((b) => /got it/i.test(b)),
        shot.buttons
      )
      check('nothing is localised', !/[şğıçöü]/i.test(text), text)
    }
  }

  log(failures === 0 ? '\nall update ui checks passed\n' : `\n${failures} check(s) failed\n`)
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

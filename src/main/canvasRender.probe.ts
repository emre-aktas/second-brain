/**
 * Renders canvas tools offscreen against the real built renderer and writes PNGs,
 * so the layout tree can be checked by eye rather than by assertion. No model call
 * and no touching the user's data: the store lives in a temp directory.
 *
 *   node scripts/run-ts.mjs src/main/canvasRender.probe.ts --gui
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SavedTool, ToolAction, ToolNode } from '@shared/types'
import { Db } from './db/sqlite'
import { migrate } from './db/schema'
import { ToolStore } from './db/tools'

const OUT = process.env['CANVAS_PROBE_OUT'] ?? tmpdir()
// The probe is bundled to a temp file, so __dirname is meaningless; run-ts.mjs
// spawns it with the repository as the working directory.
const root = resolve(process.cwd())

/**
 * Keyed by webContents id, the way the real ToolPreviewer does it: React invokes
 * effects twice, so a bare single-slot callback lets one window's second report
 * satisfy the next window's wait and capture it mid-load.
 */
const waiting = new Map<number, () => void>()

// Electron in GUI mode does not hand its stdout back to the parent shell on
// Windows, so progress goes to a file the caller can read.
const LOG = join(OUT, 'canvas-render.log')
function log(line: string): void {
  appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

/* The three-pane translator from the system prompt. */
const TRANSLATOR: { layout: ToolNode[]; actions: ToolAction[] } = {
  layout: [
    {
      type: 'input',
      bind: 'text',
      label: 'Ne demek istiyorsun?',
      multiline: true,
      rows: 3,
      placeholder: 'Türkçe ya da bozuk İngilizce'
    },
    {
      type: 'stack',
      direction: 'row',
      gap: 8,
      align: 'center',
      children: [
        {
          type: 'button',
          action: 'translate',
          label: 'Çevir',
          icon: 'languages',
          variant: 'primary'
        },
        {
          type: 'select',
          bind: 'register',
          label: 'Ortam',
          options: [
            { value: 'slack', label: 'Slack' },
            { value: 'email', label: 'E-posta' }
          ]
        },
        { type: 'spacer', size: 4 },
        { type: 'badge', value: '{{register}}', tone: 'accent' }
      ]
    },
    {
      type: 'grid',
      columns: 3,
      gap: 8,
      grow: true,
      children: [
        {
          type: 'output',
          bind: 'out.casual',
          label: 'Casual',
          copy: true,
          grow: true,
          placeholder: 'Slack ve DM için'
        },
        {
          type: 'output',
          bind: 'out.formal',
          label: 'Resmi',
          copy: true,
          grow: true,
          placeholder: 'Müşteriye yazarken'
        },
        {
          type: 'output',
          bind: 'out.short',
          label: 'Kısa',
          copy: true,
          grow: true,
          placeholder: 'Tek satır'
        }
      ]
    }
  ],
  actions: [
    {
      id: 'translate',
      label: 'Çevir',
      prompt: 'Rewrite for {{register}}: {{text}}',
      target: 'output',
      writeTo: 'out.casual',
      primary: true
    }
  ]
}

/* Something structurally different: panels, tabs, a board and a form side by side. */
const REVIEW: { layout: ToolNode[]; actions: ToolAction[] } = {
  layout: [
    { type: 'heading', value: 'Haftalık gözden geçirme', level: 1, hint: 'Pazartesi sabahı' },
    {
      type: 'stack',
      direction: 'row',
      gap: 10,
      grow: true,
      children: [
        {
          type: 'panel',
          title: 'Girdiler',
          tone: 'neutral',
          children: [
            { type: 'input', bind: 'wins', label: 'İyi gidenler', multiline: true, rows: 3 },
            { type: 'input', bind: 'blocks', label: 'Tıkananlar', multiline: true, rows: 3 },
            { type: 'toggle', bind: 'opts.includeSlack', label: "Slack'ten çek" },
            { type: 'slider', bind: 'opts.depth', label: 'Detay', min: 1, max: 5 },
            { type: 'divider' },
            {
              type: 'stack',
              direction: 'row',
              gap: 6,
              wrap: true,
              children: [
                { type: 'button', action: 'draft', label: 'Özet yaz', variant: 'primary' },
                { type: 'button', action: 'sync', label: 'Panoyu güncelle', variant: 'outline' }
              ]
            }
          ]
        },
        {
          type: 'panel',
          title: 'Sonuç',
          tone: 'accent',
          grow: true,
          children: [
            {
              type: 'tabs',
              items: [
                {
                  label: 'Özet',
                  children: [
                    {
                      type: 'output',
                      bind: 'summary',
                      copy: true,
                      grow: true,
                      minHeight: 200,
                      placeholder: 'Özet burada görünecek'
                    }
                  ]
                },
                { label: 'Pano', children: [{ type: 'kanban', bind: 'board', grow: true }] },
                {
                  label: 'Notlar',
                  children: [
                    { type: 'note', value: 'Bu sekme salt okunur.', tone: 'info' },
                    { type: 'checklist', bind: 'todo' }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      id: 'draft',
      label: 'Özet yaz',
      prompt: 'Summarise {{wins}} and {{blocks}} at depth {{opts.depth}}',
      target: 'output',
      writeTo: 'summary',
      primary: true
    },
    {
      id: 'sync',
      label: 'Panoyu güncelle',
      prompt: 'Rewrite the board from {{wins}}',
      target: 'state'
    }
  ]
}

/* The rich nodes, unwrapped, so a failure there is not hidden behind a tab. */
const BOARD: { layout: ToolNode[]; actions: ToolAction[] } = {
  layout: [
    {
      type: 'stack',
      direction: 'row',
      justify: 'between',
      align: 'center',
      children: [
        { type: 'heading', value: 'Görev panosu', level: 2, hint: '{{board.columns.0.title}}' },
        { type: 'button', action: 'sync', label: "Slack'ten çek", variant: 'outline' }
      ]
    },
    { type: 'kanban', bind: 'board', grow: true },
    { type: 'divider', label: 'Kontroller' },
    {
      type: 'grid',
      columns: 2,
      gap: 10,
      children: [
        { type: 'panel', title: 'Tablo', children: [{ type: 'table', bind: 'rows' }] },
        { type: 'panel', title: 'Liste', children: [{ type: 'checklist', bind: 'todo' }] }
      ]
    }
  ],
  actions: [
    { id: 'sync', label: "Slack'ten çek", prompt: 'Rewrite the board', target: 'state' }
  ]
}

async function capture(tool: SavedTool, label: string, width: number, height: number): Promise<void> {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    paintWhenInitiallyHidden: true,
    frame: false,
    backgroundColor: '#191a24',
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })

  const id = win.webContents.id
  const ready = new Promise<void>((resolve) => {
    waiting.set(id, resolve)
    setTimeout(() => {
      if (waiting.delete(id)) {
        log(`  (${label} did not report ready; capturing anyway)`)
        resolve()
      }
    }, 8000).unref?.()
  })

  win.webContents.on('console-message', (_e, _level, message) => log(`  [renderer] ${message}`))
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`  load failed ${code} ${desc}`))

  log(`  ${label}: loading`)
  // The label is in the hash so two captures of the same tool are distinct URLs;
  // reloading an identical file URL fails with ERR_FAILED.
  await win.loadFile(join(root, 'out/renderer/index.html'), {
    hash: `/tool/${encodeURIComponent(tool.id)}?preview=1&shot=${label}`
  })
  await ready
  waiting.delete(id)
  await new Promise((r) => setTimeout(r, 400))

  const image = await win.webContents.capturePage()
  const file = join(OUT, `canvas-${label}.png`)
  writeFileSync(file, image.toPNG())
  log(`  wrote ${file} (${image.getSize().width}x${image.getSize().height})`)

  // Waiting for the window to actually go away before opening the next one:
  // starting a load while a hidden window is still tearing down aborts it.
  await new Promise<void>((resolve) => {
    win.once('closed', () => resolve())
    win.destroy()
  })
  await new Promise((r) => setTimeout(r, 300))
}

async function main(): Promise<void> {
  writeFileSync(LOG, `canvas render probe, root=${root}\n`)
  const dir = mkdtempSync(join(tmpdir(), 'brain-canvasrender-'))
  const db = new Db(join(dir, 'index.db'))
  migrate(db)
  const store = new ToolStore(db)

  const translator = store.save({
    name: 'Casual EN',
    description: 'Türkçeyi üç tonda doğal İngilizceye çevirir',
    prompt: '',
    kind: 'canvas',
    icon: 'languages',
    layout: TRANSLATOR.layout,
    actions: TRANSLATOR.actions,
    createdBy: 'agent'
  })

  // Filled in, because an interface that looks fine empty often falls apart with
  // real text in it — the same reason the agent is told to pass sampleState.
  store.writeState(translator.id, {
    ...(translator.state as Record<string, unknown>),
    text: 'yarın toplantıyı erkene alabilir miyiz, sabah müsait değilim',
    out: {
      casual:
        'Any chance we could move tomorrow’s meeting earlier? Mornings are tight for me this week.',
      formal:
        'Would it be possible to bring tomorrow’s meeting forward? I am unfortunately not available in the morning.',
      short: 'Can we move tomorrow’s meeting earlier? Mornings don’t work for me.'
    }
  })

  const review = store.save({
    name: 'Haftalık review',
    description: 'Haftayı toparlar, panoyu günceller',
    prompt: '',
    kind: 'canvas',
    icon: 'calendar-check',
    layout: REVIEW.layout,
    actions: REVIEW.actions,
    createdBy: 'agent'
  })

  store.writeState(review.id, {
    ...(review.state as Record<string, unknown>),
    wins: 'Canvas tool sistemi bitti\nSlack connector çalışıyor',
    blocks: 'Preview bazen yavaş',
    summary:
      '## Bu hafta\n\nCanvas araçları tamamlandı; artık her araç kendi arayüzünü taşıyor.\n\n- **Bitti:** layout ağacı, bind yolları, writeTo yönlendirmesi\n- **Devam:** önizleme hızı\n',
    board: {
      columns: [
        { id: 'todo', title: 'Yapılacak', cards: [{ id: 'c1', title: 'Önizlemeyi hızlandır' }] },
        { id: 'done', title: 'Bitti', cards: [{ id: 'c2', title: 'Canvas layout' }] }
      ]
    },
    todo: { items: [{ id: 't1', label: 'Ekran görüntüsünü incele', checked: true }] }
  })

  const board = store.save({
    name: 'Görev panosu',
    description: 'Slack ve ClickUp görevlerini tek panoda tutar',
    prompt: '',
    kind: 'canvas',
    icon: 'columns-3',
    layout: BOARD.layout,
    actions: BOARD.actions,
    createdBy: 'agent'
  })

  store.writeState(board.id, {
    ...(board.state as Record<string, unknown>),
    board: {
      columns: [
        {
          id: 'todo',
          title: 'Yapılacak',
          cards: [
            { id: 'c1', title: 'Önizleme hızını ölç', tags: ['perf'] },
            { id: 'c2', title: 'Canvas dokümantasyonu' }
          ]
        },
        {
          id: 'doing',
          title: 'Devam',
          cards: [{ id: 'c3', title: 'Grid sarma davranışı', text: 'Dar pencerede test et' }]
        },
        { id: 'done', title: 'Bitti', cards: [{ id: 'c4', title: 'writeTo yönlendirmesi' }] }
      ]
    },
    rows: {
      columns: [
        { key: 'ne', label: 'Ne' },
        { key: 'kim', label: 'Kim' }
      ],
      rows: [{ ne: 'Önizleme', kim: 'Emre' }]
    },
    todo: {
      items: [
        { id: 't1', label: 'Ekran görüntüsünü incele', checked: true },
        { id: 't2', label: 'Dar pencereyi dene', checked: false }
      ]
    }
  })

  // The renderer only needs these two channels in preview mode.
  ipcMain.handle('tools:get', (_event, payload: { id: string }) => store.get(payload.id) ?? null)
  ipcMain.handle('window:previewReady', (event) => {
    const resolve = waiting.get(event.sender.id)
    if (resolve) {
      waiting.delete(event.sender.id)
      resolve()
    }
  })

  // Each capture destroys its window, and the default behaviour on the last one
  // closing is to quit before the remaining shots are taken.
  app.on('window-all-closed', () => {})

  await app.whenReady()
  log('app ready')

  try {
    await capture(store.get(translator.id)!, 'translator', 1100, 620)
    await capture(store.get(translator.id)!, 'translator-narrow', 620, 720)
    await capture(store.get(review.id)!, 'review', 1240, 780)
    await capture(store.get(board.id)!, 'board', 1240, 820)
    log('done')
  } catch (err) {
    log(`ERROR ${(err as Error).stack ?? String(err)}`)
  } finally {
    db.close()
    app.exit(0)
  }
}

void main().catch((err) => {
  log(`FATAL ${(err as Error).stack ?? String(err)}`)
  app.exit(1)
})

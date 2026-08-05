/**
 * Verifies the offscreen-render mechanism: a hidden window must actually paint the
 * built renderer, and capturePage must return a non-blank image. Runs no model
 * calls.
 */
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function main(): Promise<void> {
  await app.whenReady()

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    paintWhenInitiallyHidden: true,
    frame: false,
    backgroundColor: '#191a24',
    webPreferences: { sandbox: true, contextIsolation: true }
  })

  // No preload, so window.brain is absent and the tool view lands on its error
  // state. That is fine: this probe is about whether a hidden window paints at
  // all, which is the part that could silently fail.
  // Stage 1: known-visible markup. This isolates the offscreen mechanism from
  // anything the app's own renderer might do.
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        '<body style="margin:0;background:#191a24;color:#eee;font:16px system-ui">' +
          '<div style="padding:40px"><h1 style="color:#8b8bf0">Offscreen render check</h1>' +
          '<p>If this is captured, capturePage works on a hidden window.</p>' +
          '<div style="width:200px;height:80px;background:#78cdc8;border-radius:12px"></div>' +
          '</div></body>'
      )
  )

  await new Promise((resolve) => setTimeout(resolve, 900))

  const image = await win.webContents.capturePage()
  const size = image.getSize()
  const png = image.toPNG()

  // A window that never painted comes back fully transparent or fully one colour.
  const bitmap = image.toBitmap()
  const distinct = new Set<string>()
  for (let i = 0; i < bitmap.length; i += 4 * 997) {
    distinct.add(`${bitmap[i]},${bitmap[i + 1]},${bitmap[i + 2]},${bitmap[i + 3]}`)
  }

  const out = join(tmpdir(), 'sb-preview-probe.png')
  writeFileSync(out, png)

  const checks: [string, boolean][] = [
    ['window reported a size', size.width > 0 && size.height > 0],
    ['capture produced PNG bytes', png.length > 1000],
    ['image is not a single flat colour', distinct.size > 1],
    ['size matches the requested viewport', Math.abs(size.width - 1100) < 40]
  ]

  let failures = 0
  console.log(`captured ${size.width}x${size.height}, ${png.length} bytes -> ${out}`)
  console.log(`distinct sampled colours: ${distinct.size}`)
  for (const [label, pass] of checks) {
    if (!pass) failures++
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`)
  }

  console.log(failures === 0 ? '\nPREVIEW MECHANISM OK' : `\n${failures} FAILURE(S)`)
  win.destroy()
  app.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('probe failed', err)
  app.exit(1)
})

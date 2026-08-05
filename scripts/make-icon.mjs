/**
 * Generates the app icon: a small node-and-edge glyph.
 *
 * Writes three files:
 *   build/icon.png      1024x1024, full bleed — Windows and Linux
 *   build/icon-mac.png  1024x1024 on Apple's grid — the macOS .icns is derived from it
 *   build/icon.ico      a 256x256 entry, for the Windows installer and executable
 *
 * 1024 because anything smaller gives the Dock and Finder a blurred upscale, and
 * electron-builder refuses to derive an .icns from under 512 at all.
 *
 * This replaces `make-icon.ps1`, which drew the same glyph with System.Drawing and
 * therefore only ran on Windows — so the icon could not be regenerated on the
 * machine that builds the macOS artifact. The drawing happens on a canvas in an
 * offscreen Electron window instead, which runs anywhere Electron does.
 *
 *   node scripts/make-icon.mjs
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outDir = join(root, 'build')

/** The glyph, in a 0..1 space so it can be drawn at any size. */
const PLATE = { radius: 52 / 256, fill: 'rgb(24, 25, 36)' }

const NODES = [
  { x: 128 / 256, y: 92 / 256, r: 27 / 256, c: [150, 145, 245] },
  { x: 64 / 256, y: 170 / 256, r: 19 / 256, c: [120, 205, 200] },
  { x: 192 / 256, y: 168 / 256, r: 21 / 256, c: [130, 215, 165] },
  { x: 132 / 256, y: 205 / 256, r: 13 / 256, c: [225, 190, 120] }
]

const EDGES = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3]
]

/**
 * Apple's macOS app icon grid.
 *
 * macOS does *not* mask an app icon the way iOS does — the artwork provides its own
 * shape, and the system only adds a drop shadow. In a 1024 canvas the rounded body
 * is 824 centred, which leaves room for that shadow. A full-bleed square icon is
 * therefore not "simpler", it is visibly larger than every other icon in the Dock.
 */
const MAC_GRID = { body: 824 / 1024, radius: 185.4 / 824 }

/**
 * Draws the glyph at `size` and hands back the canvas as a data URL.
 *
 * `inset` true lays it out on Apple's grid; false fills the canvas, which is what
 * Windows and Linux want.
 */
function drawScript(size, inset) {
  return `
    (() => {
      const size = ${size}
      const inset = ${inset ? 'true' : 'false'}
      const grid = ${JSON.stringify(MAC_GRID)}
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')

      const plate = ${JSON.stringify(PLATE)}
      const nodes = ${JSON.stringify(NODES)}
      const edges = ${JSON.stringify(EDGES)}

      // The plate's box, and a scale that maps the glyph's 0..1 space onto it.
      const box = inset ? size * grid.body : size
      const origin = (size - box) / 2
      const s = (v) => v * box
      const px = (v) => origin + v * box
      const cornerRadius = inset ? box * grid.radius : s(plate.radius)

      ctx.fillStyle = plate.fill
      ctx.beginPath()
      ctx.roundRect(origin, origin, box, box, cornerRadius)
      ctx.fill()

      ctx.strokeStyle = 'rgba(170, 170, 210, 0.47)'
      ctx.lineWidth = s(7 / 256)
      ctx.lineCap = 'round'
      for (const [a, b] of edges) {
        ctx.beginPath()
        ctx.moveTo(px(nodes[a].x), px(nodes[a].y))
        ctx.lineTo(px(nodes[b].x), px(nodes[b].y))
        ctx.stroke()
      }

      // Clipped to the plate so a halo cannot bleed past its rounded corner, which
      // at icon sizes reads as a smudge rather than a glow.
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(origin, origin, box, box, cornerRadius)
      ctx.clip()

      for (const node of nodes) {
        const [r, g, b] = node.c
        // A faint halo, so the nodes read as glowing against the dark plate rather
        // than as flat dots.
        ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.18)'
        ctx.beginPath()
        ctx.arc(px(node.x), px(node.y), s(node.r) * 2, 0, Math.PI * 2)
        ctx.fill()

        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')'
        ctx.beginPath()
        ctx.arc(px(node.x), px(node.y), s(node.r), 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.restore()

      return canvas.toDataURL('image/png')
    })()
  `
}

/**
 * An ICO container holding one PNG.
 *
 * PNG-in-ICO rather than a bitmap because electron-builder wants a 256x256 entry,
 * and 256 is the size an ICO header cannot express as a byte — it is written as 0.
 */
function ico(png) {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // one image
  header.writeUInt8(0, 6) // width, 0 means 256
  header.writeUInt8(0, 7) // height, 0 means 256
  header.writeUInt8(0, 8) // palette entries
  header.writeUInt8(0, 9) // reserved
  header.writeUInt16LE(1, 10) // colour planes
  header.writeUInt16LE(32, 12) // bits per pixel
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18) // payload offset
  return Buffer.concat([header, png])
}

async function render(win, size, inset = false) {
  const dataUrl = await win.webContents.executeJavaScript(drawScript(size, inset))
  return Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64')
}

async function main() {
  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { offscreen: true }
  })
  // A blank document is all that is needed; the canvas is never attached to it.
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8">')

  mkdirSync(outDir, { recursive: true })

  const large = await render(win, 1024)
  writeFileSync(join(outDir, 'icon.png'), large)
  console.log(`wrote ${join(outDir, 'icon.png')} (1024x1024 full bleed, ${large.length} bytes)`)

  const mac = await render(win, 1024, true)
  writeFileSync(join(outDir, 'icon-mac.png'), mac)
  console.log(`wrote ${join(outDir, 'icon-mac.png')} (1024x1024 on Apple's grid, ${mac.length} bytes)`)

  const small = await render(win, 256)
  const container = ico(small)
  writeFileSync(join(outDir, 'icon.ico'), container)
  console.log(`wrote ${join(outDir, 'icon.ico')} (256x256, ${container.length} bytes)`)

  win.destroy()
  app.exit(0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})

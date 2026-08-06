/**
 * Builds the app's icon files from the artwork.
 *
 * Writes three files:
 *   build/icon.png      1024x1024, full bleed — Windows and Linux
 *   build/icon-mac.png  1024x1024 on Apple's grid — the macOS .icns is derived from it
 *   build/icon.ico      16 through 256, for the taskbar, Alt+Tab, the installer and the exe
 *
 * The source is `build/Second-Brain Icon.png`, drawn by hand. This script does not design
 * anything: it resizes, lays the artwork out on each platform's grid, and packs the ICO. An
 * earlier version drew a glyph in code, which meant the icon could only ever be as good as
 * something expressible in fifty lines of canvas calls.
 *
 * 1024 because anything smaller gives the Dock and Finder a blurred upscale, and
 * electron-builder refuses to derive an .icns from under 512 at all.
 *
 * The work happens on a canvas in an offscreen Electron window, which runs anywhere Electron
 * does — an earlier `make-icon.ps1` used System.Drawing and so could not be run on the
 * machine that builds the macOS artifact.
 *
 * It also writes the two badged variants the unread indicator uses:
 *   build/icon-unread.png  the app icon with a dot, for the window and taskbar
 *   build/tray-unread.png  the same for the tray, where the dot has to survive 20px
 *
 *   npm run icons
 *   ICON_PREVIEW=1 npm run icons   # also writes every size side by side, at 4x
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outDir = join(root, 'build')
const SOURCE = join(outDir, 'Second-Brain Icon.png')

/**
 * Apple's macOS app icon grid.
 *
 * macOS does *not* mask an app icon the way iOS does — the artwork provides its own shape,
 * and the system only adds a drop shadow. In a 1024 canvas the rounded body is 824 centred,
 * which leaves room for that shadow. A full-bleed square icon is therefore not "simpler", it
 * is visibly larger than every other icon in the Dock.
 */
const MAC_BODY = 824 / 1024

/**
 * Below this, the artwork is laid out again rather than merely scaled.
 *
 * The margin inside the plate is right at 1024 and wrong at 16. There the brain lands on a
 * handful of pixels in the middle of a mostly empty square and the icon reads as a pale tile
 * — the shape stops carrying and only the plate is left. Cropping into the source is the
 * obvious fix and the wrong one: it eats the plate's rounded corner, so the small end of the
 * ladder would be square while the large end is not.
 *
 * So the small sizes get the plate redrawn at full size with the glyph placed on it larger.
 * The same design, re-proportioned for a size its proportions were not drawn for, which is
 * what an icon ladder is for. At and above this size the artwork is used exactly as authored.
 */
const REDRAW_BELOW = 64

/** How much of the plate the glyph fills when it is laid out again. */
const GLYPH_FILL = 0.76

/**
 * The unread dot.
 *
 * Drawn into the artwork rather than handed to the platform, because the platform's own
 * overlay goes bottom-right on Windows and is not placeable — and a badge on an app icon
 * belongs top-right, where every other application puts it.
 *
 * Two sizes, because the two places it appears shrink it by wildly different amounts: the
 * window icon is seen at 32–48px, the tray at 20. A dot proportioned for the first is a
 * smudge at the second, so the tray gets its own, larger.
 *
 * The ring is not decoration. The artwork is blue on near-white, so a blue dot laid straight
 * on it can land on a blue stroke and vanish; a ring in the plate's own colour guarantees the
 * dot has an edge whatever is underneath.
 */
const BADGE = {
  /**
   * Centre, as a fraction of the plate.
   *
   * Held in from the corner rather than tucked into it: the plate is rounded, so a dot placed
   * at 0.78 had its ring painting over the transparent corner and the icon read as having a
   * square corner on that side.
   */
  x: 0.742,
  y: 0.258,
  /** A clear blue, and deliberately more saturated than the artwork's own. */
  fill: 'rgb(37, 99, 235)',
  /** Small enough to be a badge. The first attempt covered a third of the icon. */
  radius: { icon: 0.105, tray: 0.17 },
  /** Ring width as a fraction of the dot's radius. */
  ring: 0.3
}

/** Installed once on the page, then called for every size. */
const DRAW_FUNCTION = `
  window.__loadSource = (dataUrl) =>
    new Promise((done, fail) => {
      const image = new Image()
      image.onload = () => {
        window.__source = image
        window.__measured = window.__measure(image)
        const m = window.__measured
        done(
          image.width + 'x' + image.height +
            ', glyph ' + m.glyph.w + 'x' + m.glyph.h +
            ', plate ' + m.plate +
            ', radius ' + m.radius
        )
      }
      image.onerror = () => fail(new Error('the source artwork could not be decoded'))
      image.src = dataUrl
    })

  /*
   * Find the glyph's box, the plate's colour and the plate's corner radius.
   *
   * Measured rather than declared, so the numbers cannot drift from the artwork: replacing
   * the PNG with a differently proportioned one needs no edit here.
   */
  window.__measure = (image) => {
    const probe = document.createElement('canvas')
    probe.width = image.width
    probe.height = image.height
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data

    const at = (x, y) => {
      const i = (y * image.width + x) * 4
      return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
    }

    // The plate's colour, taken from a point well inside it and away from the glyph.
    const plateAt = at(Math.round(image.width * 0.08), Math.round(image.height * 0.5))
    const plate = 'rgb(' + plateAt[0] + ',' + plateAt[1] + ',' + plateAt[2] + ')'

    // Anything far enough from the plate colour is glyph. A generous threshold: the glyph's
    // palest tint is still well clear of a near-white plate, and being strict here would clip
    // the antialiased edge and leave the box a pixel or two tight.
    const isGlyph = (x, y) => {
      const p = at(x, y)
      if (p[3] < 24) return false
      return (
        Math.abs(p[0] - plateAt[0]) + Math.abs(p[1] - plateAt[1]) + Math.abs(p[2] - plateAt[2]) > 26
      )
    }

    let minX = image.width
    let minY = image.height
    let maxX = -1
    let maxY = -1
    // Every second pixel. A box measured to within two pixels of a 1200px source is exact
    // enough for anything drawn from it, and this quarters the work.
    for (let y = 0; y < image.height; y += 2) {
      for (let x = 0; x < image.width; x += 2) {
        if (!isGlyph(x, y)) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }

    // The corner radius, found by walking along the top edge until the plate begins. Used so
    // a redrawn plate keeps the shape the artwork has rather than a guessed one.
    let radius = 0
    for (let x = 0; x < image.width / 2; x++) {
      if (at(x, 1)[3] > 24) {
        radius = x
        break
      }
    }

    return {
      plate,
      radius,
      glyph: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
    }
  }

  window.__drawIcon = (size, inset, redraw, badge) => {
    const source = window.__source
    const measured = window.__measured
    if (!source || !measured) throw new Error('the source artwork has not been loaded')

    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    // The downscale is most of the job, so it is worth asking for the good one.
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    // How much of the canvas the plate occupies, and where it starts.
    const scale = inset ? MAC_BODY_FRACTION : 1
    const box = size * scale
    const origin = (size - box) / 2

    const badgeSpec = ${JSON.stringify(BADGE)}

    /** The unread dot, over whatever has already been drawn. */
    const drawBadge = () => {
      if (!badge) return

      // Clipped to the plate, so nothing can reach past a rounded corner even if the badge
      // geometry is later moved outward. The belt to the braces above.
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(origin, origin, box, box, (measured.radius / source.width) * box)
      ctx.clip()

      const radius = box * badgeSpec.radius[badge]
      const cx = origin + box * badgeSpec.x
      const cy = origin + box * badgeSpec.y

      // The ring first, in the plate's own colour, so the dot reads as sitting on top of the
      // icon rather than being part of the drawing underneath it.
      ctx.fillStyle = measured.plate
      ctx.beginPath()
      ctx.arc(cx, cy, radius * (1 + badgeSpec.ring), 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = badgeSpec.fill
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    if (!redraw) {
      ctx.drawImage(source, origin, origin, box, box)
      drawBadge()
      return canvas.toDataURL('image/png')
    }

    // The plate, at the artwork's own colour and corner radius.
    ctx.fillStyle = measured.plate
    ctx.beginPath()
    ctx.roundRect(origin, origin, box, box, (measured.radius / source.width) * box)
    ctx.fill()

    // The glyph, larger, and centred on *its own* box rather than on the canvas — the brain
    // is drawn a little right of centre, and centring the canvas would inherit that offset at
    // exactly the sizes where a few pixels are the whole picture.
    const glyph = measured.glyph
    const fill = box * GLYPH_FILL_FRACTION
    const factor = Math.min(fill / glyph.w, fill / glyph.h)
    const width = glyph.w * factor
    const height = glyph.h * factor

    ctx.drawImage(
      source,
      glyph.x,
      glyph.y,
      glyph.w,
      glyph.h,
      origin + (box - width) / 2,
      origin + (box - height) / 2,
      width,
      height
    )

    drawBadge()
    return canvas.toDataURL('image/png')
  }
  true
`
  .replace('MAC_BODY_FRACTION', String(MAC_BODY))
  .replace('GLYPH_FILL_FRACTION', String(GLYPH_FILL))

/**
 * An ICO container holding several PNGs.
 *
 * Several rather than one, because Windows picks a different entry for the taskbar, Alt+Tab,
 * the title bar and the desktop — given only a 256 it downscales, and its downscale is
 * muddier than a version drawn for the size. 256 is the size an ICO header cannot express as
 * a byte, and is written as 0.
 */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = 6 + directory.length

  for (const [index, { size, png }] of images.entries()) {
    const at = index * 16
    directory.writeUInt8(size >= 256 ? 0 : size, at)
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
    directory.writeUInt8(0, at + 2) // palette entries
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += png.length
  }

  return Buffer.concat([header, directory, ...images.map((image) => image.png)])
}

const decode = (dataUrl) =>
  Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64')

/** Laid out again only where the artwork's own proportions stop working. See REDRAW_BELOW. */
const redrawAt = (size) => size < REDRAW_BELOW

async function render(win, size, inset = false, badge = null) {
  return decode(
    await win.webContents.executeJavaScript(
      `window.__drawIcon(${size}, ${inset}, ${redrawAt(size)}, ${JSON.stringify(badge)})`
    )
  )
}

/**
 * Every size on one canvas at 4x, unsmoothed.
 *
 * For the eye rather than for the build. An icon judged at 1024 is not judged at all — the
 * sizes it has to survive are the ones nobody looks at while making it.
 */
async function preview(win, sizes) {
  const script = `
    (async () => {
      const sizes = ${JSON.stringify(sizes)}
      const redraw = ${JSON.stringify(sizes.map(redrawAt))}
      const zoom = 4
      const gap = 20
      const width = sizes.reduce((sum, size) => sum + size * zoom + gap, gap)
      const height = Math.max(...sizes) * zoom + gap * 2

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      // A mid grey, because an icon has to hold up on a light taskbar and on a dark one.
      ctx.fillStyle = '#8b8b93'
      ctx.fillRect(0, 0, width, height)
      ctx.imageSmoothingEnabled = false

      let x = gap
      for (const [index, size] of sizes.entries()) {
        const image = new Image()
        image.src = window.__drawIcon(size, false, redraw[index], null)
        await image.decode()
        ctx.drawImage(image, x, gap, size * zoom, size * zoom)
        x += size * zoom + gap
      }

      return canvas.toDataURL('image/png')
    })()
  `
  return decode(await win.webContents.executeJavaScript(script))
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
  await win.webContents.executeJavaScript(DRAW_FUNCTION)

  const artwork = `data:image/png;base64,${readFileSync(SOURCE).toString('base64')}`
  const dimensions = await win.webContents.executeJavaScript(
    `window.__loadSource(${JSON.stringify(artwork)})`
  )
  console.log(`read ${SOURCE} (${dimensions})`)

  mkdirSync(outDir, { recursive: true })

  const large = await render(win, 1024)
  writeFileSync(join(outDir, 'icon.png'), large)
  console.log(`wrote ${join(outDir, 'icon.png')} (1024x1024 full bleed, ${large.length} bytes)`)

  const mac = await render(win, 1024, true)
  writeFileSync(join(outDir, 'icon-mac.png'), mac)
  console.log(`wrote ${join(outDir, 'icon-mac.png')} (1024x1024 on Apple's grid, ${mac.length} bytes)`)

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const entries = []
  for (const size of sizes) entries.push({ size, png: await render(win, size) })

  const container = ico(entries)
  writeFileSync(join(outDir, 'icon.ico'), container)
  console.log(`wrote ${join(outDir, 'icon.ico')} (${sizes.join(', ')}, ${container.length} bytes)`)

  /*
   * The badged variants.
   *
   * 512 for the window icon, which Windows scales to 32 or 48; 256 for the tray, which the
   * tray controller resizes to 20. Each is drawn at a size close to where it will be used so
   * the downscale has little to do.
   */
  const unread = await render(win, 512, false, 'icon')
  writeFileSync(join(outDir, 'icon-unread.png'), unread)
  console.log(`wrote ${join(outDir, 'icon-unread.png')} (512, badged, ${unread.length} bytes)`)

  const trayUnread = await render(win, 256, false, 'tray')
  writeFileSync(join(outDir, 'tray-unread.png'), trayUnread)
  console.log(`wrote ${join(outDir, 'tray-unread.png')} (256, badged, ${trayUnread.length} bytes)`)

  if (process.env['ICON_PREVIEW']) {
    const path = join(outDir, 'icon-preview.png')
    writeFileSync(path, await preview(win, sizes))
    console.log(`wrote ${path} (every size side by side, 4x)`)
  }

  win.destroy()
  app.exit(0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})

/**
 * Generates the graph's node icons from the installed lucide-react.
 *
 *   node scripts/gen-node-icons.mjs
 *
 * Why generate instead of importing: the icon data lives in `__iconNode` inside
 * lucide's per-icon modules, which is an internal shape, and a namespace import of
 * lucide costs about a megabyte of bundle. Copying the paths by hand would drift.
 * So a curated list is read at build time and written out as plain path data —
 * same reasoning as TOOL_ICONS, one step further because canvas needs geometry
 * rather than components.
 *
 * Every primitive is flattened to a single `d` string so the renderer can hold one
 * cached Path2D per icon and stroke it in one call.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The icons the graph can show. Keep this list short: each one must be legible at 20px. */
const ICONS = [
  // by node kind
  'file-text', 'hash', 'user', 'target', 'check', 'calendar', 'link', 'plug',
  'building-2', 'users', 'scroll-text', 'scale', 'circle-help', 'layers', 'flag',
  // by subject
  'lightbulb', 'book-open', 'code', 'wallet', 'heart-pulse', 'plane', 'music',
  'film', 'utensils', 'users', 'palette', 'graduation-cap', 'briefcase', 'house',
  'message-square', 'mail', 'map-pin', 'flask-conical', 'dumbbell', 'sprout',
  'gamepad-2', 'camera', 'car', 'gift', 'scale', 'shield', 'wrench', 'sparkles',
  'trending-up', 'clock', 'bookmark', 'quote', 'globe', 'building-2', 'leaf'
]

const number = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Everything lucide uses, as a path. */
function toPath(tag, attrs) {
  switch (tag) {
    case 'path':
      return attrs.d ?? ''

    case 'circle': {
      const cx = number(attrs.cx)
      const cy = number(attrs.cy)
      const r = number(attrs.r)
      // Two half arcs: a full circle cannot be one arc command.
      return `M${cx - r},${cy}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`
    }

    case 'ellipse': {
      const cx = number(attrs.cx)
      const cy = number(attrs.cy)
      const rx = number(attrs.rx)
      const ry = number(attrs.ry)
      return `M${cx - rx},${cy}a${rx},${ry} 0 1,0 ${rx * 2},0a${rx},${ry} 0 1,0 ${-rx * 2},0`
    }

    case 'line':
      return `M${number(attrs.x1)},${number(attrs.y1)}L${number(attrs.x2)},${number(attrs.y2)}`

    case 'polyline':
    case 'polygon': {
      const points = String(attrs.points ?? '')
        .trim()
        .split(/\s+/)
        .join(' ')
      if (!points) return ''
      const parts = points.split(' ')
      const head = `M${parts[0]}`
      const tail = parts.slice(1).map((p) => `L${p}`).join('')
      return `${head}${tail}${tag === 'polygon' ? 'Z' : ''}`
    }

    case 'rect': {
      const x = number(attrs.x)
      const y = number(attrs.y)
      const w = number(attrs.width)
      const h = number(attrs.height)
      const r = Math.min(number(attrs.rx ?? attrs.ry), w / 2, h / 2)
      if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`
      return (
        `M${x + r},${y}h${w - r * 2}a${r},${r} 0 0 1 ${r},${r}` +
        `v${h - r * 2}a${r},${r} 0 0 1 ${-r},${r}` +
        `h${-(w - r * 2)}a${r},${r} 0 0 1 ${-r},${-r}` +
        `v${-(h - r * 2)}a${r},${r} 0 0 1 ${r},${-r}Z`
      )
    }

    default:
      return ''
  }
}

/** Pull the `__iconNode` array out of one icon module without executing it. */
function readIconNode(name, aliasHops = 0) {
  const file = resolve(root, 'node_modules/lucide-react/dist/esm/icons', `${name}.mjs`)
  if (!existsSync(file)) throw new Error(`no such lucide icon: ${name}`)

  const source = readFileSync(file, 'utf8')

  // Some names are aliases that only re-export another icon — `circle-help` is
  // `circle-question-mark`. Follow the alias rather than making the caller know.
  const alias = source.match(/export\s*\{\s*default\s*\}\s*from\s*'\.\/([\w-]+)\.mjs'/)
  if (alias && !source.includes('const __iconNode')) {
    if (aliasHops > 4) throw new Error(`alias loop starting at ${name}.mjs`)
    return readIconNode(alias[1], aliasHops + 1)
  }

  const start = source.indexOf('const __iconNode = [')
  if (start === -1) throw new Error(`could not find __iconNode in ${name}.mjs`)
  const open = source.indexOf('[', start)

  // Bracket matching rather than a delimiter: a one-primitive icon is emitted on a
  // single line, so there is no `\n];` to find.
  let depth = 0
  let close = -1
  let inString = null
  for (let i = open; i < source.length; i++) {
    const char = source[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === inString) inString = null
      continue
    }
    if (char === '"' || char === "'") inString = char
    else if (char === '[') depth++
    else if (char === ']') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) throw new Error(`could not find the end of __iconNode in ${name}.mjs`)

  const body = source.slice(open, close + 1)
  // The literal is JSON-compatible apart from unquoted keys and trailing commas.
  const json = body
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[\]}])/g, '$1')

  return JSON.parse(json)
}

/**
 * Make a subpath safe to concatenate after another one.
 *
 * The first moveto of a path is absolute whatever its case — `m19 8` and `M19 8` land in the
 * same place at the start of a `d`. They stop landing in the same place the moment that path
 * is appended to another, because then the `m` is relative to wherever the previous one
 * ended. That is what put a pan of the `scale` glyph outside the 24-unit box: `M12 3v18` ends
 * at (12,21), so the following `m19 8` moved to (31,29) and the icon drew over the edge of
 * its node.
 *
 * The fix is to restore the origin the segment was written against, *not* to uppercase the
 * moveto. Coordinates that follow a moveto are implicit linetos of the same case, so
 * `m19 8 3 8` means "move to (19,8), then line 3 across and 8 down" while `M19 8 3 8` means
 * "move to (19,8), then line to (3,8)" — a different picture, and the reason the first
 * attempt at this produced a glyph reaching to x = -3.
 *
 * A bare `M0 0` draws nothing: the very next command is another moveto.
 */
function anchorSegment(d, name) {
  const trimmed = d.trim()
  if (trimmed.startsWith('M')) return trimmed
  if (trimmed.startsWith('m')) return `M0 0${trimmed}`
  throw new Error(`${name}: a subpath starts with something other than a moveto: ${trimmed.slice(0, 24)}`)
}

/**
 * Rough extent of a path, in its own units.
 *
 * Walks the commands tracking the current point, which is the only way to know where a
 * relative command actually lands. Arcs contribute their endpoint rather than their bulge,
 * so this is an approximation — deliberately, because it exists to catch a glyph that has
 * escaped its box by miles, not to measure one that grazes the edge.
 */
function extentOf(d) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0

  const see = (px, py) => {
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }

  for (const [, letter, argText] of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
    const args = (argText.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number)
    const relative = letter === letter.toLowerCase() && letter !== 'Z' && letter !== 'z'

    switch (letter.toUpperCase()) {
      case 'M':
      case 'L':
      case 'T':
        for (let i = 0; i + 1 < args.length; i += 2) {
          x = relative ? x + args[i] : args[i]
          y = relative ? y + args[i + 1] : args[i + 1]
          if (letter.toUpperCase() === 'M' && i === 0) {
            startX = x
            startY = y
          }
          see(x, y)
        }
        break

      case 'H':
        for (const value of args) {
          x = relative ? x + value : value
          see(x, y)
        }
        break

      case 'V':
        for (const value of args) {
          y = relative ? y + value : value
          see(x, y)
        }
        break

      // Control points are included: a curve stays inside their hull, so bounding them
      // bounds the curve too.
      case 'C':
        for (let i = 0; i + 5 < args.length; i += 6) {
          for (const [dx, dy] of [[args[i], args[i + 1]], [args[i + 2], args[i + 3]], [args[i + 4], args[i + 5]]]) {
            see(relative ? x + dx : dx, relative ? y + dy : dy)
          }
          x = relative ? x + args[i + 4] : args[i + 4]
          y = relative ? y + args[i + 5] : args[i + 5]
        }
        break

      case 'S':
      case 'Q':
        for (let i = 0; i + 3 < args.length; i += 4) {
          for (const [dx, dy] of [[args[i], args[i + 1]], [args[i + 2], args[i + 3]]]) {
            see(relative ? x + dx : dx, relative ? y + dy : dy)
          }
          x = relative ? x + args[i + 2] : args[i + 2]
          y = relative ? y + args[i + 3] : args[i + 3]
        }
        break

      case 'A':
        for (let i = 0; i + 6 < args.length; i += 7) {
          x = relative ? x + args[i + 5] : args[i + 5]
          y = relative ? y + args[i + 6] : args[i + 6]
          see(x, y)
        }
        break

      case 'Z':
        x = startX
        y = startY
        break

      default:
        break
    }
  }

  return { minX, minY, maxX, maxY }
}

// Deduped: the list is grouped by purpose for readability, and the same icon can
// legitimately serve two of them.
const entries = [...new Set(ICONS)].map((name) => {
  const node = readIconNode(name)
  const d = node
    .map(([tag, attrs]) => toPath(tag, attrs))
    .filter(Boolean)
    .map((segment) => anchorSegment(segment, name))
    .join('')
  if (!d) throw new Error(`${name} produced no geometry`)

  // The renderer centres a glyph on lucide's 24-unit box and scales it to fit a circle, so a
  // glyph that leaves the box draws outside its node. A little slack for arc bulge and for
  // icons that genuinely touch the edge; anything beyond that is a flattening bug, and it
  // should fail the build rather than be discovered on screen.
  const box = extentOf(d)
  if (box.minX < -1.5 || box.minY < -1.5 || box.maxX > 25.5 || box.maxY > 25.5) {
    throw new Error(
      `${name} does not fit lucide's 24-unit box: ` +
        `x ${box.minX}..${box.maxX}, y ${box.minY}..${box.maxY}`
    )
  }

  return [name, d]
})

const out = `/* Generated by scripts/gen-node-icons.mjs from lucide-react. Do not edit.
 *
 * Each entry is one lucide icon flattened to a single path, in lucide's own 24x24
 * box with a 2-unit stroke. The renderer builds one Path2D per entry and strokes
 * it scaled into a node's circle.
 */

export const NODE_ICON_PATHS: Record<string, string> = {
${entries.map(([name, d]) => `  '${name}': '${d.replace(/'/g, "\\'")}'`).join(',\n')}
}

export type NodeIconName = keyof typeof NODE_ICON_PATHS
`

// In shared rather than the renderer: the picker that chooses a name lives there
// too, and verification scripts run under Node with no DOM types available.
const target = resolve(root, 'src/shared/icon-paths.ts')
writeFileSync(target, out, 'utf8')
console.log(`wrote ${entries.length} icons to ${target}`)

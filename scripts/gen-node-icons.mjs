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

// Deduped: the list is grouped by purpose for readability, and the same icon can
// legitimately serve two of them.
const entries = [...new Set(ICONS)].map((name) => {
  const node = readIconNode(name)
  const d = node
    .map(([tag, attrs]) => toPath(tag, attrs))
    .filter(Boolean)
    .join('')
  if (!d) throw new Error(`${name} produced no geometry`)
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

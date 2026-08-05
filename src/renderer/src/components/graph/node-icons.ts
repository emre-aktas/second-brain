import { NODE_ICON_PATHS } from '@shared/icon-paths'

/**
 * Drawing a node's icon onto the canvas.
 *
 * Which icon a node gets is domain logic and lives in `@shared/node-icons`; this is
 * only the geometry, which is the half that needs a canvas.
 */

const paths = new Map<string, Path2D | null>()

function pathFor(name: string): Path2D | null {
  const cached = paths.get(name)
  if (cached !== undefined) return cached

  const d = NODE_ICON_PATHS[name]
  let built: Path2D | null = null
  if (d) {
    try {
      built = new Path2D(d)
    } catch {
      built = null
    }
  }
  paths.set(name, built)
  return built
}

/**
 * Below this the glyph is a smudge, so the circle is left plain.
 *
 * Deliberately just under the radius a well-connected node has at the default
 * fitted zoom, which is about 8.6px: the icons have to be there on the screen the
 * user opens onto, or they are decoration for people who already zoomed in.
 */
export const MIN_ICON_RADIUS = 8.4

/**
 * Stroke an icon centred in a node's circle.
 *
 * Lucide draws in a 24-unit box with a 2-unit stroke, so the whole glyph is scaled
 * to fit the circle and the line width is divided back out — otherwise the stroke
 * would grow with the zoom and fill in.
 */
export function drawNodeIcon(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
  radius: number,
  color: string
): void {
  const path = pathFor(name)
  if (!path) return

  // 1.28 rather than sqrt(2): a glyph inscribed exactly in the circle touches the
  // edge and reads as cramped.
  const size = radius * 1.28
  const scale = size / 24

  // A constant width on screen, divided back out of the scale. Lucide's own 2 units
  // would grow with the zoom and fill in the detail of a busy glyph; thinner on a
  // small circle is what keeps a dumbbell from reading as a blob.
  const strokePx = radius >= 15 ? 1.75 : 1.45

  ctx.save()
  ctx.translate(x - size / 2, y - size / 2)
  ctx.scale(scale, scale)
  ctx.strokeStyle = color
  ctx.lineWidth = strokePx / scale
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke(path)
  ctx.restore()
}

export interface Camera {
  /** World coordinate at the centre of the viewport. */
  x: number
  y: number
  scale: number
}

export interface Viewport {
  width: number
  height: number
}

export const MIN_SCALE = 0.06
export const MAX_SCALE = 4.5

export function worldToScreen(
  camera: Camera,
  viewport: Viewport,
  wx: number,
  wy: number
): { x: number; y: number } {
  return {
    x: (wx - camera.x) * camera.scale + viewport.width / 2,
    y: (wy - camera.y) * camera.scale + viewport.height / 2
  }
}

export function screenToWorld(
  camera: Camera,
  viewport: Viewport,
  sx: number,
  sy: number
): { x: number; y: number } {
  return {
    x: (sx - viewport.width / 2) / camera.scale + camera.x,
    y: (sy - viewport.height / 2) / camera.scale + camera.y
  }
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Zoom about a fixed screen point, so the content under the cursor stays put. */
export function zoomAt(
  camera: Camera,
  viewport: Viewport,
  sx: number,
  sy: number,
  factor: number
): Camera {
  const nextScale = clampScale(camera.scale * factor)
  if (nextScale === camera.scale) return camera

  const before = screenToWorld(camera, viewport, sx, sy)
  const after = screenToWorld({ ...camera, scale: nextScale }, viewport, sx, sy)

  return {
    scale: nextScale,
    x: camera.x + (before.x - after.x),
    y: camera.y + (before.y - after.y)
  }
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function boundsOf(points: { x: number; y: number }[]): Bounds | null {
  if (points.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }

  return { minX, minY, maxX, maxY }
}

/** Camera that frames `bounds` with padding, capped so a single node is not zoomed absurdly. */
export function cameraForBounds(
  bounds: Bounds,
  viewport: Viewport,
  padding = 96,
  maxScale = 1.6
): Camera {
  const width = Math.max(1, bounds.maxX - bounds.minX)
  const height = Math.max(1, bounds.maxY - bounds.minY)

  const scale = clampScale(
    Math.min(
      maxScale,
      (viewport.width - padding * 2) / width,
      (viewport.height - padding * 2) / height
    )
  )

  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    scale
  }
}

/**
 * Camera tween.
 *
 * Movement across the screen uses ease-in-out — it accelerates and decelerates
 * the way a physical camera would. Enter/exit easing would feel wrong here
 * because nothing is appearing; the viewpoint is travelling.
 */
export class CameraTween {
  private from: Camera | null = null
  private to: Camera | null = null
  private startedAt = 0
  private duration = 0

  start(from: Camera, to: Camera, duration = 420): void {
    this.from = { ...from }
    this.to = { ...to }
    this.startedAt = performance.now()
    this.duration = duration
  }

  cancel(): void {
    this.from = null
    this.to = null
  }

  get active(): boolean {
    return this.from !== null && this.to !== null
  }

  /** Next camera, or null when no tween is running. */
  sample(now: number): Camera | null {
    if (!this.from || !this.to) return null

    const t = this.duration <= 0 ? 1 : Math.min(1, (now - this.startedAt) / this.duration)
    const eased = easeInOutCubic(t)

    const camera: Camera = {
      x: this.from.x + (this.to.x - this.from.x) * eased,
      y: this.from.y + (this.to.y - this.from.y) * eased,
      // Interpolate zoom logarithmically, otherwise a large scale change appears
      // to rush at the start and crawl at the end.
      scale: Math.exp(Math.log(this.from.scale) + (Math.log(this.to.scale) - Math.log(this.from.scale)) * eased)
    }

    if (t >= 1) this.cancel()
    return camera
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

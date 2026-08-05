/**
 * Turning a graph laid out in three dimensions into something a 2D canvas can draw.
 *
 * Deliberately a projection rather than a renderer. The existing canvas already knows how
 * to draw this graph — batched edge passes with curved bundles, a Path2D icon cache,
 * label placement that rejects overlaps, prominence and pulses — and every one of those
 * works in screen space, so it survives a change of projection untouched. Handing the
 * whole thing to WebGL would have thrown all of it away, and hit a wall the moment it met
 * the theme: colours arrive as `oklch(...)` strings, which canvas-2d accepts and
 * `THREE.Color` cannot parse.
 *
 * So this file is small on purpose: rotate a point about the graph's centre, apply a weak
 * perspective, and hand back something the existing camera can place on screen.
 *
 * No canvas, no DOM, no React — so it can be tested under plain Node.
 */

export interface Orbit {
  /** Rotation about the vertical axis, in radians. Unbounded; wraps naturally. */
  yaw: number
  /** Tilt, in radians. Clamped, because past vertical the scene turns inside out. */
  pitch: number
}

/**
 * Default distance from the eye to the graph's centre, in world units.
 *
 * A fallback. Callers that know how big their graph is should pass a focal length derived
 * from it — see `focalFor`. Fixed, this constant cannot be right for both a twenty-note
 * vault and a two-thousand-note one: the same absolute distance is a strong perspective
 * on a small graph and no perspective at all on a large one, and the first version of
 * this file shipped a graph that was mathematically three-dimensional and looked flat.
 */
export const FOCAL = 1100

/**
 * Focal length for a graph of a given size.
 *
 * Taken from the *largest* half-extent across all three axes, not the depth extent, and
 * that is the whole point: the depth extent changes as the graph turns — at a quarter
 * turn what was width is depth — so a focal length derived from it would breathe in and
 * out once per revolution, which reads as the graph inflating rather than rotating.
 *
 * The multiplier sets how strong the effect is. Below about 2 the near side distorts into
 * a funnel; above about 4 it stops being a depth cue at all.
 */
export function focalFor(halfSpan: number): number {
  return Math.max(600, halfSpan * 2.6)
}

/** Past this the scene inverts, and a graph seen from directly above is unreadable. */
export const MAX_PITCH = 1.15

/** Where the camera rests: a slight tilt reads as depth without hiding anything. */
export const RESTING_PITCH = 0.28

/**
 * Bounds on the perspective multiplier.
 *
 * Without them a node at or beyond the focal plane divides by zero or flips sign, and one
 * far behind the camera collapses to a point at the origin — both of which are visible as
 * a node teleporting rather than as a smooth failure.
 */
export const K_MIN = 0.35
export const K_MAX = 2.2

export interface Projected {
  /** World-plane coordinates to hand to `worldToScreen`. */
  x: number
  y: number
  /** Rotated depth. Positive is nearer the viewer. */
  depth: number
  /** The perspective multiplier at this depth, for scaling radius and stroke. */
  k: number
}

export function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch))
}

/**
 * Rotate a point about `origin` and apply the perspective.
 *
 * Yaw first, about the vertical axis, then pitch. Two rotations rather than a full matrix
 * because that is all an orbit needs — the camera never rolls — and the arithmetic being
 * this short is why the hot path can afford to run it per node per frame.
 */
export function project(
  point: { x: number; y: number; z: number },
  origin: { x: number; y: number; z: number },
  orbit: Orbit,
  focal: number = FOCAL
): Projected {
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  const dz = point.z - origin.z

  const cy = Math.cos(orbit.yaw)
  const sy = Math.sin(orbit.yaw)

  // About the vertical axis: x and z turn, y is untouched.
  const rx = cy * dx + sy * dz
  const rzYaw = -sy * dx + cy * dz

  const cp = Math.cos(orbit.pitch)
  const sp = Math.sin(orbit.pitch)

  // Then tilt: y and the yawed depth turn.
  const ry = cp * dy - sp * rzYaw
  const rz = sp * dy + cp * rzYaw

  const k = Math.min(K_MAX, Math.max(K_MIN, focal / Math.max(1, focal - rz)))

  return { x: origin.x + rx * k, y: origin.y + ry * k, depth: rz, k }
}

/**
 * A screen-space drag turned back into a move in the view plane.
 *
 * Needed because dragging a node has to move it where the pointer went, not where the
 * unrotated axes point. Solved under the constraint that the node stays on its own view
 * plane — the alternative is asking the user to reason in three dimensions with a mouse.
 */
export function unprojectDelta(
  viewX: number,
  viewY: number,
  orbit: Orbit
): { x: number; y: number; z: number } {
  const cy = Math.cos(orbit.yaw)
  const sy = Math.sin(orbit.yaw)
  const cp = Math.cos(orbit.pitch)
  const sp = Math.sin(orbit.pitch)

  // Solve the forward rotation for a world delta whose rotated depth is zero.
  //
  //   rz = sp·dy + cp·rzYaw = 0        →  rzYaw = −(sp/cp)·dy
  //   ry = cp·dy − sp·rzYaw = dy/cp    →  dy    = ry·cp
  //
  // cp is never zero: pitch is clamped well inside a quarter turn.
  const dy = viewY * cp
  const rzYaw = -sp * viewY

  // Then the inverse yaw, which is just the transpose — a rotation is orthogonal.
  return {
    x: cy * viewX - sy * rzYaw,
    y: dy,
    z: sy * viewX + cy * rzYaw
  }
}

/**
 * How much a node at this depth fades.
 *
 * Depth alone is not enough of a cue on a dark background — parallax reads as motion, not
 * as distance — so the far side of the graph is dimmed as well as smaller.
 */
export function depthFade(depth: number, halfDepth: number): number {
  // A flat graph, a single node, or a tags-only graph all give a zero span. Dividing by it
  // yields NaN, and `ctx.globalAlpha = NaN` is *ignored* by the canvas spec — leaving
  // whatever alpha was set last, so the draw silently inherits a stale value.
  if (halfDepth <= 0) return 1

  const t = Math.min(1, Math.max(-1, depth / halfDepth))
  // 1 at the front, about 0.45 at the back.
  return 0.72 + t * 0.28
}

/**
 * Seed depth for a node, from its id.
 *
 * A deterministic scatter rather than a random one, so the same graph opens looking the
 * same. Only a seed: the simulation moves z from here like any other coordinate.
 */
export function seedDepth(id: string, amplitude: number): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  // >>> 0 first: the multiply leaves a signed 32-bit value.
  const unit = ((hash >>> 0) % 10_000) / 10_000
  return (unit * 2 - 1) * amplitude
}

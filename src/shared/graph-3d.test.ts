/**
 * The projection maths. Every case here is one the renderer depends on being exact.
 *
 *   node scripts/run-ts.mjs src/shared/graph-3d.test.ts --node
 */
import {
  clampPitch,
  depthFade,
  FOCAL,
  focalFor,
  K_MAX,
  K_MIN,
  MAX_PITCH,
  project,
  seedDepth,
  unprojectDelta,
  type Orbit
} from './graph-3d'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  console.log(`        expected ${JSON.stringify(expected)}`)
  console.log(`        actual   ${JSON.stringify(actual)}`)
}

function near(label: string, actual: number, expected: number, tolerance = 1e-9): void {
  const ok = Math.abs(actual - expected) <= tolerance
  if (ok) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  console.log(`        expected ${expected} ± ${tolerance}`)
  console.log(`        actual   ${actual}`)
}

const ORIGIN = { x: 0, y: 0, z: 0 }
const FLAT: Orbit = { yaw: 0, pitch: 0 }

console.log('graph projection\n')

/* ------------------------------------------------------------------ identity */

const flat = project({ x: 100, y: -40, z: 0 }, ORIGIN, FLAT)
near('unrotated, a point on the mid-plane keeps its x', flat.x, 100)
near('and its y', flat.y, -40)
near('its depth is zero', flat.depth, 0)
near('and the perspective is exactly 1', flat.k, 1)

/* ------------------------------------------------------------------- depth */

console.log('\ndepth')

const near_ = project({ x: 100, y: 0, z: 400 }, ORIGIN, FLAT)
const far = project({ x: 100, y: 0, z: -400 }, ORIGIN, FLAT)
check('a nearer node magnifies', near_.k > 1, true)
check('a farther one shrinks', far.k < 1, true)
check('and their depths carry the sign', [near_.depth, far.depth], [400, -400])
check('nearer is farther from centre on screen', Math.abs(near_.x) > Math.abs(far.x), true)

// Nothing may invert or explode, however far out a node has drifted.
const absurdlyNear = project({ x: 10, y: 0, z: FOCAL * 4 }, ORIGIN, FLAT)
const absurdlyFar = project({ x: 10, y: 0, z: -FOCAL * 40 }, ORIGIN, FLAT)
check('an extreme near node is clamped', absurdlyNear.k, K_MAX)
check('an extreme far node is clamped', absurdlyFar.k, K_MIN)
check('so a node can never flip sign', absurdlyNear.x > 0 && absurdlyFar.x > 0, true)
// At exactly the focal plane the naive divide is by zero.
check(
  'a node at the focal plane does not divide by zero',
  Number.isFinite(project({ x: 1, y: 0, z: FOCAL }, ORIGIN, FLAT).k),
  true
)

/* --------------------------------------------------------- focal length */

console.log('\nfocal length')

check('a big graph gets a long focal length', focalFor(1000) > focalFor(200), true)
check('and it is proportional', focalFor(1000), 2600)
// The floor matters: a graph of three notes has almost no extent, and a focal length that
// shrank with it would put the eye inside the graph.
check('a tiny graph is floored', focalFor(1), 600)
check('and so is an empty one', focalFor(0), 600)

// A node at the edge of its graph, under two graph sizes: the *relative* perspective has
// to come out the same, which is the entire reason the focal length is not a constant.
// Both sizes are above the floor on purpose — below it the whole point is that scaling
// stops, so scale invariance is not claimed there.
const smallGraph = project({ x: 0, y: 0, z: 400 }, ORIGIN, FLAT, focalFor(400))
const bigGraph = project({ x: 0, y: 0, z: 1000 }, ORIGIN, FLAT, focalFor(1000))
near('a graph reads the same at any size', smallGraph.k, bigGraph.k, 1e-9)
// And below the floor it deliberately does not: a three-note graph is not magnified into
// a funnel just because it is small.
check(
  'below the floor the perspective is weaker, not equal',
  project({ x: 0, y: 0, z: 100 }, ORIGIN, FLAT, focalFor(100)).k < smallGraph.k,
  true
)

check(
  'an explicit focal length overrides the default',
  project({ x: 0, y: 0, z: 200 }, ORIGIN, FLAT, 400).k >
    project({ x: 0, y: 0, z: 200 }, ORIGIN, FLAT, 4000).k,
  true
)

/* ------------------------------------------------------------------- yaw */

console.log('\nrotation')

// A quarter turn moves the x axis onto the depth axis.
const quarter = project({ x: 100, y: 0, z: 0 }, ORIGIN, { yaw: Math.PI / 2, pitch: 0 })
near('a quarter turn puts an x offset edge-on', quarter.x, 0, 1e-6)
near('and its depth becomes negative x', quarter.depth, -100, 1e-6)

// The pivot really is the origin, not the world's zero.
const offset = project({ x: 50, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }, { yaw: 1.2, pitch: 0.5 })
near('a node at the pivot does not move', offset.x, 50, 1e-9)
near('nor vertically', offset.y, 0, 1e-9)
near('and sits at zero depth', offset.depth, 0, 1e-9)

// A full turn is the identity.
const full = project({ x: 70, y: 20, z: -30 }, ORIGIN, { yaw: Math.PI * 2, pitch: 0 })
near('a full turn returns x', full.x, project({ x: 70, y: 20, z: -30 }, ORIGIN, FLAT).x, 1e-6)

/* ------------------------------------------------------------------- pitch */

console.log('\npitch')

check('pitch is clamped up', clampPitch(99), MAX_PITCH)
check('and down', clampPitch(-99), -MAX_PITCH)
check('a resting pitch passes through', clampPitch(0.3), 0.3)

// Tilting lifts a node that is behind the centre.
const tilted = project({ x: 0, y: 0, z: 200 }, ORIGIN, { yaw: 0, pitch: 0.4 })
check('tilting moves depth into y', Math.abs(tilted.y) > 0, true)

/* ------------------------------------------------------- dragging a node */

console.log('\nunprojecting a drag')

// The claim: a screen-plane delta, put through unprojectDelta and then rotated forward
// again, comes back as the same delta. Taken from the origin, where the perspective
// multiplier is exactly 1 — `project` is not linear in the delta away from it, so a
// round-trip through the full projection only holds here.
for (const orbit of [
  FLAT,
  { yaw: 0.9, pitch: 0 },
  { yaw: 0, pitch: 0.6 },
  { yaw: -2.3, pitch: -0.45 },
  { yaw: Math.PI, pitch: MAX_PITCH }
] as Orbit[]) {
  const wanted = { x: 37, y: -19 }
  const world = unprojectDelta(wanted.x, wanted.y, orbit)
  const back = project(world, ORIGIN, orbit)
  const label = `yaw ${orbit.yaw.toFixed(2)} pitch ${orbit.pitch.toFixed(2)}`
  near(`a drag round-trips in x (${label})`, back.x, wanted.x, 1e-6)
  near(`and in y (${label})`, back.y, wanted.y, 1e-6)
  // The whole point of the constraint: the node stays on its own view plane.
  near(`without changing depth (${label})`, back.depth, 0, 1e-6)
}

check(
  'unrotated, a drag is the identity',
  unprojectDelta(10, -5, FLAT),
  { x: 10, y: -5, z: 0 }
)

/* -------------------------------------------------------------- depth fade */

console.log('\nfading by depth')

near('the nearest node is fully opaque', depthFade(100, 100), 1)
near('the farthest is dimmed', depthFade(-100, 100), 0.44)
near('the middle sits between', depthFade(0, 100), 0.72)
// A flat graph, one node, or a tags-only graph all give a zero span. NaN here would be
// silently ignored by the canvas and inherit whatever alpha was set last.
check('a zero span does not produce NaN', depthFade(0, 0), 1)
check('nor a negative one', depthFade(50, -10), 1)
check('and depth beyond the span is clamped', depthFade(9999, 100), 1)

/* --------------------------------------------------------------- seeding */

console.log('\nseeded depth')

check('the same id always seeds the same depth', seedDepth('abc', 300), seedDepth('abc', 300))
check('different ids differ', seedDepth('abc', 300) !== seedDepth('abd', 300), true)
check(
  'it stays inside the amplitude',
  [seedDepth('one', 300), seedDepth('two', 300), seedDepth('three', 300)].every(
    (z) => z >= -300 && z <= 300
  ),
  true
)
check('a zero amplitude keeps everything flat', seedDepth('abc', 0), 0)
// An id long enough to overflow the hash must still land in range, not NaN.
check(
  'a long id is still in range',
  Math.abs(seedDepth('x'.repeat(500), 100)) <= 100,
  true
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Node size against link count.
 *
 * The claim being tested is not "bigger is bigger" — the expression it replaced satisfied
 * that and was still wrong in both directions. It is that the *area* a node covers is
 * proportional to how connected it is, and that hubs stay distinguishable from each other.
 * Both of the old bugs pass a one-sided "does it grow" assertion, which is why the checks
 * here are ratios and a monotonicity sweep.
 *
 *   node scripts/run-ts.mjs src/shared/node-size.test.ts --node
 */
import { radiusForDegree } from './node-size'

let failures = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
}

function near(label: string, actual: number, expected: number, tolerance: number): void {
  check(label, Math.abs(actual - expected) <= tolerance, { actual, expected, tolerance })
}

const area = (degree: number): number => Math.PI * radiusForDegree(degree) ** 2

/* ------------------------------------------------------------------ the proportion -- */

console.log('\narea tracks the link count')
{
  // Four times the links, four times the area. The old expression added a flat 4px to the
  // radius, which is what pulled this down to 2.07 — a node with four links looked barely
  // twice the node of one with a single link.
  const oneLink = area(1) - area(0)
  const fourLinks = area(4) - area(0)
  near('four links cover four times what one does', fourLinks / oneLink, 4, 0.001)

  const sixteen = area(16) - area(0)
  near('and sixteen cover sixteen times', sixteen / oneLink, 16, 0.001)

  // Radius therefore grows with the square root, not linearly. Stated separately because
  // this is the property every reader gets backwards.
  near('radius grows as the square root', radiusForDegree(36) - 0, Math.sqrt(4.5 ** 2 + 36 * 16), 1e-9)
}

/* --------------------------------------------------------------------- the hubs -- */

console.log('\nhubs stay distinguishable')
{
  // The old `min(14, …)` ceiling made every one of these identical, which threw away the
  // one thing a graph is for: seeing which nodes hold the vault together.
  const sizes = [20, 40, 60, 100, 200, 300].map(radiusForDegree)
  for (let i = 1; i < sizes.length; i++) {
    check(
      `${[20, 40, 60, 100, 200, 300][i]} links is bigger than ${[20, 40, 60, 100, 200, 300][i - 1]}`,
      sizes[i] > sizes[i - 1] + 0.5,
      { previous: sizes[i - 1], current: sizes[i] }
    )
  }

  // And the taper is real: past the knee it must grow *more slowly* than proportionally, or
  // a tag with three hundred edges is drawn wider than its neighbourhood is apart.
  const proportional = Math.sqrt(4.5 ** 2 + 300 * 16)
  check('a 300-link hub is tapered, not proportional', radiusForDegree(300) < proportional * 0.7, {
    tapered: radiusForDegree(300),
    proportional
  })
  check('and never exceeds the backstop', radiusForDegree(100_000) <= 46, radiusForDegree(100_000))
}

/* ------------------------------------------------------------------ monotonicity -- */

console.log('\nno step goes backwards')
{
  // Across the knee especially: a piecewise curve is where a discontinuity hides, and a node
  // that got *smaller* on gaining a link would read as the graph glitching.
  let worst: { degree: number; drop: number } | null = null
  let previous = radiusForDegree(0)
  for (let degree = 1; degree <= 500; degree++) {
    const current = radiusForDegree(degree)
    if (current < previous) worst = { degree, drop: previous - current }
    previous = current
  }
  check('every additional link makes a node bigger or equal', worst === null, worst)

  // Continuous at the knee, from both sides.
  near('the curve does not jump at the knee', radiusForDegree(41), radiusForDegree(40), 0.35)
}

/* -------------------------------------------------------------------- the floor -- */

console.log('\nthe small end')
{
  check('an unconnected node is still a target', radiusForDegree(0) >= 4, radiusForDegree(0))
  // Both of these reach this function in real code: `degree` is a SQL COUNT on one path and
  // an optional field on another. A NaN radius propagates into the layout, the hit test and
  // every arc drawn — as a blank canvas with nothing logged.
  check('a negative degree is treated as none', radiusForDegree(-5) === radiusForDegree(0))
  check('and NaN is too', radiusForDegree(Number.NaN) === radiusForDegree(0), {
    nan: radiusForDegree(Number.NaN)
  })
}

console.log(failures === 0 ? '\nall node-size checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)

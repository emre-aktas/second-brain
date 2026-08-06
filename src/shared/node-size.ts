/**
 * How big a node is drawn, from how connected it is.
 *
 * One copy, imported by the canvas and by the physics worker. It was two identical
 * expressions in two files, which is two answers waiting to disagree: the worker's radius is
 * what `forceCollide` reserves and the canvas's is what gets painted, so a drift between them
 * shows up as nodes overlapping or as gaps nothing fills, with nothing failing to compile.
 *
 * **Area tracks the link count, not radius.** That is the whole point and it is not the same
 * thing: doubling a radius quadruples what the eye reads, so a node with four links drawn at
 * twice the radius of a one-link node looks four times as important rather than four times as
 * connected. Radius therefore grows with the *square root* of the degree — the old expression
 * had the square root but added a constant 4px on top of it, and that constant is what broke
 * the proportion: four times the links came out at barely twice the area.
 *
 * The other half of the old formula was a hard `min(14, …)` ceiling, which meant every node
 * past twenty links was painted at exactly the same size. In a vault the hubs are the whole
 * point of looking at a graph, and that clamp is precisely where it threw the information
 * away.
 */

/** An isolated node. Small, but never a dot: it still has to be findable and clickable. */
const MIN_RADIUS = 4.5

/**
 * How much area one link is worth, as the radius of a circle of that area.
 *
 * Set so a typical note — a handful of links — lands close to where it used to, and the
 * change is felt at the top of the range rather than as the whole graph shrinking.
 */
const AREA_PER_LINK = 4

/**
 * Where proportional growth gives way to a gentler curve.
 *
 * Strict proportionality is right through the range almost every node lives in, and wrong
 * past it: a tag with three hundred edges would be drawn as a disc wider than the notes
 * around it are apart, hiding the neighbourhood it is meant to explain. Past the knee the
 * exponent halves, so a 300-link hub is still visibly bigger than a 60-link one — the
 * distinction the old clamp destroyed — without swallowing the canvas.
 */
const KNEE_LINKS = 40
const TAPER = 0.25

/** A backstop, not the shape. Nothing in a real vault should reach it. */
const MAX_RADIUS = 46

export function radiusForDegree(degree: number): number {
  // Guarded rather than trusted: `degree` is a COUNT from SQL on one path and a possibly
  // absent field on another, and a NaN here propagates into the layout, the hit test and
  // every arc the canvas draws — as an empty screen with nothing logged.
  const links = Number.isFinite(degree) ? Math.max(0, degree) : 0

  const proportional = (count: number): number =>
    Math.sqrt(MIN_RADIUS * MIN_RADIUS + count * AREA_PER_LINK * AREA_PER_LINK)

  if (links <= KNEE_LINKS) return proportional(links)

  const knee = proportional(KNEE_LINKS)
  return Math.min(MAX_RADIUS, knee * Math.pow(links / KNEE_LINKS, TAPER))
}

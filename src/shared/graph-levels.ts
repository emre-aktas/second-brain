import type { GraphEdgeLite, GraphNodeLite } from './types'

/**
 * How far out each node belongs, in rings.
 *
 * A flat force layout puts everything at one radius: notes, the notes they belong
 * to, and every tag, all tangled together. Reading it means reading every label.
 * Rings give the graph a spine — the things other things hang off sit in the
 * middle, what belongs to them sits outside them, and tags form the rim.
 *
 * "Belongs to" is not a field anyone fills in; it is read off the graph. The
 * best-connected notes are the anchors, and a note is placed one ring outside the
 * anchor it is closest to. So a handful of notes about the same subject end up
 * arranged around the note — or the tag — they have in common, which is what makes
 * a cluster look like a cluster.
 */

/** Tags always sit outside every note, however connected they are. */
const TAG_MARGIN = 1

export interface LevelOptions {
  /** Degree at or above which a note anchors its own group. */
  anchorDegree?: number
  /** Rings past this collapse, so one long chain cannot flatten the rest. */
  maxLevel?: number
}

export function computeLevels(
  nodes: GraphNodeLite[],
  edges: GraphEdgeLite[],
  options: LevelOptions = {}
): Map<string, number> {
  const maxLevel = options.maxLevel ?? 4
  const levels = new Map<string, number>()
  if (nodes.length === 0) return levels

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const isTag = (id: string): boolean => byId.get(id)?.kind === 'tag'

  // Adjacency over real relationships only. A tag is a label on a note, not a step
  // between two notes, so paths are not allowed to run through one — otherwise
  // everything that shares a common tag would collapse onto the same ring.
  const neighbours = new Map<string, string[]>()
  for (const edge of edges) {
    if (!byId.has(edge.src) || !byId.has(edge.dst)) continue
    if (isTag(edge.src) || isTag(edge.dst)) continue
    if (!neighbours.has(edge.src)) neighbours.set(edge.src, [])
    if (!neighbours.has(edge.dst)) neighbours.set(edge.dst, [])
    neighbours.get(edge.src)!.push(edge.dst)
    neighbours.get(edge.dst)!.push(edge.src)
  }

  const notes = nodes.filter((node) => node.kind !== 'tag')
  if (notes.length === 0) {
    for (const node of nodes) levels.set(node.id, TAG_MARGIN)
    return levels
  }

  // The anchors: the notes other notes hang off. A threshold rather than a fixed
  // count, so a small vault gets one centre and a large one gets several — but
  // always at least the single best-connected note, or nothing would be level 0.
  const sorted = [...notes].sort((a, b) => b.degree - a.degree)
  const anchorDegree = options.anchorDegree ?? Math.max(3, Math.round(sorted[0].degree * 0.6))
  const anchors = sorted.filter((node) => node.degree >= anchorDegree)
  if (anchors.length === 0) anchors.push(sorted[0])

  // Breadth-first from every anchor at once, so each note lands on the ring for the
  // nearest anchor rather than for whichever was processed first.
  const queue: string[] = []
  for (const anchor of anchors) {
    levels.set(anchor.id, 0)
    queue.push(anchor.id)
  }

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]
    const level = levels.get(id) ?? 0
    for (const next of neighbours.get(id) ?? []) {
      if (levels.has(next)) continue
      levels.set(next, Math.min(maxLevel, level + 1))
      queue.push(next)
    }
  }

  // Anything the walk never reached — an orphan, or a note only ever tagged — sits
  // where the notes end rather than in the middle by default.
  const deepest = Math.max(0, ...[...levels.values()])
  for (const node of notes) {
    if (!levels.has(node.id)) levels.set(node.id, Math.min(maxLevel, Math.max(1, deepest)))
  }

  // Tags on the rim, one ring past the furthest note, so they read as labels around
  // the outside and their edges point inward.
  const noteDepth = Math.max(0, ...notes.map((node) => levels.get(node.id) ?? 0))
  const tagLevel = Math.min(maxLevel + TAG_MARGIN, noteDepth + TAG_MARGIN)
  for (const node of nodes) {
    if (node.kind === 'tag') levels.set(node.id, tagLevel)
  }

  return levels
}

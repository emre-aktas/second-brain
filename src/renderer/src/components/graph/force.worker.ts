/// <reference lib="webworker" />

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force'

/**
 * The graph's physics, off the main thread.
 *
 * The simulation is the most expensive thing this app does continuously, and it
 * has to keep running while the user pans, hovers and types. Running it in a
 * worker means a heavy layout pass can never drop a frame of interaction — the
 * main thread only ever draws the latest positions it has been handed.
 */

interface SimNode extends SimulationNodeDatum {
  id: string
  degree: number
  pinned: boolean
  level: number
  isTag: boolean
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  weight: number
}

export interface WorkerNodeInput {
  id: string
  x: number | null
  y: number | null
  degree: number
  pinned: boolean
  /**
   * How deep this node sits in the hierarchy read off the graph.
   *
   * 0 anchors a group; 1 hangs off an anchor; tags are deeper than every note.
   * Used to set how tightly each relationship pulls, so a note sits close to the
   * note it belongs to and a tag orbits well outside the notes it labels. Without
   * it every link pulls equally and the result is a hairball with tags threaded
   * through the middle of it.
   */
  level: number
  /** Tags orbit their notes rather than sitting among them. */
  isTag: boolean
}

export interface WorkerEdgeInput {
  src: string
  dst: string
  weight: number
}

export interface ForceSettings {
  linkDistance: number
  charge: number
  /** Gap between rings. 0 turns levelling off and restores a plain force layout. */
  levelGap?: number
}

export type WorkerRequest =
  | {
      type: 'init'
      nodes: WorkerNodeInput[]
      edges: WorkerEdgeInput[]
      settings: ForceSettings
      width: number
      height: number
    }
  | {
      /**
       * Apply a diff without rebuilding. This is what lets the graph absorb
       * notes the agent creates mid-conversation: existing nodes keep their
       * positions and the layout nudges rather than restarting.
       */
      type: 'update'
      addNodes: WorkerNodeInput[]
      removeNodeIds: string[]
      addEdges: WorkerEdgeInput[]
      removeEdges: WorkerEdgeInput[]
    }
  | { type: 'settings'; settings: ForceSettings }
  | { type: 'drag'; id: string; x: number; y: number }
  | { type: 'release'; id: string; pin: boolean }
  | { type: 'reheat'; alpha?: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'stop' }

export type WorkerResponse =
  | { type: 'ready'; ids: string[] }
  | { type: 'tick'; positions: Float32Array; alpha: number }
  | { type: 'settled'; positions: Float32Array }

let simulation: Simulation<SimNode, SimLink> | null = null
let nodes: SimNode[] = []
let links: SimLink[] = []
let nodeIndex = new Map<string, SimNode>()
let ids: string[] = []
let currentSettings: ForceSettings = { linkDistance: 70, charge: -260 }
let loop: ReturnType<typeof setTimeout> | null = null
let width = 1200
let height = 800

const SETTLE_ALPHA = 0.004
const FRAME_MS = 16

function snapshot(): Float32Array {
  const out = new Float32Array(nodes.length * 2)
  for (let i = 0; i < nodes.length; i++) {
    out[i * 2] = nodes[i].x ?? 0
    out[i * 2 + 1] = nodes[i].y ?? 0
  }
  return out
}

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer ?? [])
}

function stopLoop(): void {
  if (loop) clearTimeout(loop)
  loop = null
}

function runLoop(): void {
  stopLoop()

  const step = (): void => {
    if (!simulation) return

    simulation.tick()
    const alpha = simulation.alpha()
    const positions = snapshot()

    // The buffer is transferred rather than copied, so a large graph does not
    // pay a structured-clone cost every frame.
    post({ type: 'tick', positions, alpha }, [positions.buffer])

    if (alpha < SETTLE_ALPHA) {
      // Settled: stop burning CPU. The graph stays still until something
      // meaningful happens, rather than drifting forever in the background.
      const final = snapshot()
      post({ type: 'settled', positions: final }, [final.buffer])
      stopLoop()
      return
    }

    loop = setTimeout(step, FRAME_MS)
  }

  loop = setTimeout(step, FRAME_MS)
}

function edgeKey(edge: WorkerEdgeInput): string {
  return `${edge.src}|${edge.dst}`
}

/** Wide enough that the first ring is not a knot around the centre. */
const DEFAULT_LEVEL_GAP = 190

function ringRadius(level: number, settings: ForceSettings): number {
  const gap = settings.levelGap ?? DEFAULT_LEVEL_GAP
  if (gap === 0) return 0
  // The first step out is larger than the rest: level 0 holds the hubs, which are
  // big and push hard, so their children need room before the rings tighten up.
  return level === 0 ? 0 : gap * (0.85 + level * 0.75)
}

/**
 * How far apart a relationship wants its two ends.
 *
 * This is where the hierarchy actually comes from. Concentric rings around one
 * origin do not work once there is more than one anchor — they all want the centre
 * and end up shoving each other off it. Distance per relationship does work: a note
 * is pulled tight to the note it belongs to, so groups form around their own
 * anchors wherever they happen to sit, and a tag is pushed far out, so it orbits
 * the notes it labels instead of sitting among them.
 */
function linkDistanceFor(link: SimLink, settings: ForceSettings): number {
  const source = link.source as SimNode
  const target = link.target as SimNode
  const base = settings.linkDistance * (1.6 - Math.min(1, link.weight))
  if ((settings.levelGap ?? DEFAULT_LEVEL_GAP) === 0) return base

  // A tag is a label on a note, not a step between notes. Held at arm's length so
  // it reads as annotation around the outside.
  if (source.isTag || target.isTag) return base * 2.5

  // Deeper relationships tighten, which is what makes a group look like a group
  // rather than an evenly spaced mesh.
  const depth = Math.min(3, Math.max(source.level, target.level))
  return base * (1 - depth * 0.16)
}

function build(
  nodeInput: WorkerNodeInput[],
  edgeInput: WorkerEdgeInput[],
  settings: ForceSettings
): void {
  currentSettings = settings
  const index = new Map<string, SimNode>()

  nodes = nodeInput.map((input) => {
    // Seed unplaced nodes on a ring rather than at the origin: starting every
    // new node at the same point makes the first frames explode outward. Seeding
    // at roughly the right ring also means the first frames already look sorted
    // instead of settling into place from a tangle.
    const angle = Math.random() * Math.PI * 2
    const radius = ringRadius(input.level, settings) * (0.85 + Math.random() * 0.3)

    const node: SimNode = {
      id: input.id,
      degree: input.degree,
      pinned: input.pinned,
      level: input.level,
      isTag: input.isTag,
      x: input.x ?? Math.cos(angle) * radius,
      y: input.y ?? Math.sin(angle) * radius,
      ...(input.pinned && input.x !== null && input.y !== null
        ? { fx: input.x, fy: input.y }
        : {})
    }
    index.set(node.id, node)
    return node
  })

  ids = nodes.map((n) => n.id)
  nodeIndex = index

  links = []
  for (const edge of edgeInput) {
    const source = index.get(edge.src)
    const target = index.get(edge.dst)
    if (!source || !target) continue
    links.push({ source, target, weight: edge.weight })
  }

  simulation = forceSimulation<SimNode, SimLink>(nodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        // Weak links sit further out, so a "similar" edge reads as looser than a
        // wikilink the user actually wrote — then adjusted by depth and by whether
        // a tag is involved, which is what produces the grouping.
        .distance((link) => linkDistanceFor(link, settings))
        .strength((link) => {
          const source = link.source as SimNode
          const target = link.target as SimNode
          const base = 0.06 + Math.min(0.55, link.weight * 0.35)
          // A tag pulls loosely: it should be held outside its notes, not dragged
          // into the middle of them by having three of them.
          return source.isTag || target.isTag ? base * 0.45 : base
        })
    )
    .force(
      'charge',
      forceManyBody<SimNode>()
        // Hubs push harder, which opens up space around the parts of the graph
        // that carry the most meaning.
        .strength((d) => settings.charge * (1 + Math.min(2.2, d.degree / 9)))
        .distanceMax(900)
    )
    .force('collide', forceCollide<SimNode>((d) => radiusFor(d.degree) + 5).iterations(2))
    .force('center', forceCenter(0, 0).strength(0.03))
    // Only tags are placed by radius, and gently: it takes the whole set of them
    // out past the notes without deciding where any individual one goes. Notes are
    // arranged by their relationships alone — several anchors cannot all sit at one
    // origin, which is why concentric rings for everything does not work.
    .force(
      'rim',
      forceRadial<SimNode>((d) => ringRadius(d.level, settings), 0, 0).strength((d) =>
        (settings.levelGap ?? DEFAULT_LEVEL_GAP) === 0 || !d.isTag ? 0 : 0.14
      )
    )
    // A gentle pull toward the axes keeps disconnected clusters from drifting
    // off to infinity, which is the usual failure mode of a sparse graph.
    .force('x', forceX(0).strength(0.014))
    .force('y', forceY(0).strength(0.014))
    .alpha(1)
    .alphaDecay(0.0228)
    .velocityDecay(0.36)
    .stop()

  post({ type: 'ready', ids })
  runLoop()
}

function radiusFor(degree: number): number {
  return 4 + Math.min(14, Math.sqrt(degree) * 3.1)
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const message = event.data

  switch (message.type) {
    case 'init': {
      width = message.width
      height = message.height
      build(message.nodes, message.edges, message.settings)
      break
    }

    case 'update': {
      if (!simulation) return

      if (message.removeNodeIds.length > 0) {
        const gone = new Set(message.removeNodeIds)
        nodes = nodes.filter((node) => !gone.has(node.id))
        links = links.filter(
          (link) => !gone.has((link.source as SimNode).id) && !gone.has((link.target as SimNode).id)
        )
        for (const id of gone) nodeIndex.delete(id)
      }

      for (const input of message.addNodes) {
        if (nodeIndex.has(input.id)) continue

        // Spawn next to something it connects to, so a new note appears beside
        // its context instead of flying in from the edge of the canvas.
        const anchor = message.addEdges
          .map((edge) =>
            edge.src === input.id
              ? nodeIndex.get(edge.dst)
              : edge.dst === input.id
                ? nodeIndex.get(edge.src)
                : undefined
          )
          .find((candidate): candidate is SimNode => candidate !== undefined)

        const angle = Math.random() * Math.PI * 2
        const spread = anchor ? 34 : 200
        const originX = anchor?.x ?? 0
        const originY = anchor?.y ?? 0

        const node: SimNode = {
          id: input.id,
          degree: input.degree,
          pinned: input.pinned,
          level: input.level,
          isTag: input.isTag,
          x: input.x ?? originX + Math.cos(angle) * spread,
          y: input.y ?? originY + Math.sin(angle) * spread
        }

        nodes.push(node)
        nodeIndex.set(node.id, node)
      }

      if (message.removeEdges.length > 0) {
        const dropped = new Set(message.removeEdges.map(edgeKey))
        links = links.filter(
          (link) => !dropped.has(`${(link.source as SimNode).id}|${(link.target as SimNode).id}`)
        )
      }

      for (const edge of message.addEdges) {
        const source = nodeIndex.get(edge.src)
        const target = nodeIndex.get(edge.dst)
        if (!source || !target) continue
        links.push({ source, target, weight: edge.weight })
      }

      // Degrees changed, so the charge force needs the fresh counts.
      const degrees = new Map<string, number>()
      for (const link of links) {
        const a = (link.source as SimNode).id
        const b = (link.target as SimNode).id
        degrees.set(a, (degrees.get(a) ?? 0) + 1)
        degrees.set(b, (degrees.get(b) ?? 0) + 1)
      }
      for (const node of nodes) node.degree = degrees.get(node.id) ?? 0

      ids = nodes.map((n) => n.id)
      simulation.nodes(nodes)

      const linkForce = simulation.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>>
      linkForce.links(links)

      const collide = simulation.force('collide') as ReturnType<typeof forceCollide<SimNode>>
      collide?.radius((d: SimNode) => radiusFor(d.degree) + 5)

      post({ type: 'ready', ids })
      // A nudge, not a relaunch: enough to make room for what arrived.
      simulation.alpha(Math.max(simulation.alpha(), 0.3))
      runLoop()
      break
    }

    case 'settings': {
      if (!simulation) return
      const link = simulation.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined
      link?.distance((l: SimLink) => message.settings.linkDistance * (1.6 - Math.min(1, l.weight)))

      const charge = simulation.force('charge') as ReturnType<typeof forceManyBody<SimNode>> | undefined
      charge?.strength((d: SimNode) => message.settings.charge * (1 + Math.min(2.2, d.degree / 9)))

      simulation.alpha(0.4)
      runLoop()
      break
    }

    case 'drag': {
      const node = nodes.find((n) => n.id === message.id)
      if (!node || !simulation) return
      node.fx = message.x
      node.fy = message.y
      // Keep the simulation warm but not hot: the dragged node should push its
      // neighbours around without the whole graph relaunching.
      simulation.alpha(Math.max(simulation.alpha(), 0.22))
      runLoop()
      break
    }

    case 'release': {
      const node = nodes.find((n) => n.id === message.id)
      if (!node) return
      if (message.pin) {
        node.pinned = true
      } else {
        node.pinned = false
        delete node.fx
        delete node.fy
      }
      simulation?.alpha(Math.max(simulation.alpha(), 0.14))
      runLoop()
      break
    }

    case 'reheat': {
      simulation?.alpha(message.alpha ?? 0.5)
      runLoop()
      break
    }

    case 'resize': {
      width = message.width
      height = message.height
      break
    }

    case 'stop': {
      stopLoop()
      simulation?.stop()
      simulation = null
      nodes = []
      ids = []
      break
    }
  }
}

export {}

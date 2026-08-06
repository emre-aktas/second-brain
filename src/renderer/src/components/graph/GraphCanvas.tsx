import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import type { GraphSnapshot, NodeKind } from '@shared/types'
import { api } from '@/lib/api'
import {
  CameraTween,
  boundsOf,
  cameraForBounds,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Camera
} from './camera'
import { radiusForDegree } from '@shared/node-size'
import { readGraphTheme, type GraphTheme } from './theme'
import {
  clampPitch,
  depthFade,
  focalFor,
  project,
  RESTING_PITCH,
  unprojectDelta
} from '@shared/graph-3d'
import { iconForNode } from '@shared/node-icons'
import { computeLevels } from '@shared/graph-levels'
import { drawNodeIcon, MIN_ICON_RADIUS } from './node-icons'
import type {
  ForceSettings,
  WorkerEdgeInput,
  WorkerNodeInput,
  WorkerRequest,
  WorkerResponse
} from './force.worker'
import ForceWorker from './force.worker?worker'
import { GraphContextMenu, GraphHint, GraphKindsPresent, GraphLegend } from './GraphOverlays'

export interface FocusRequest {
  ids: string[]
  note: string | null
  /** Changing this re-triggers the focus even for the same ids. */
  stamp: number
}

export interface GraphCanvasProps {
  snapshot: GraphSnapshot
  selectedId: string | null
  onSelect: (id: string | null) => void
  onOpen: (id: string) => void
  onHover?: (id: string | null) => void
  onPositionsSettled?: (positions: { id: string; x: number; y: number; z: number }[]) => void
  focusRequest: FocusRequest | null
  /**
   * Node ids to pulse once. `change` was written; `probe` was read by the agent,
   * and `at` may be in the future so a sweep arrives one node at a time.
   */
  pulses: { id: string; at: number; kind: 'change' | 'probe' }[]
  /** Right-click menu actions the shell handles (ask, link, reveal, trash…). */
  onNodeAction?: (action: string, node: GraphSnapshot['nodes'][number]) => void
  settings: ForceSettings & { labelThreshold: number; rotate: boolean }
  reduceMotion: boolean
  /**
   * The agent is mid-turn.
   *
   * A single boolean, and that is the design: the user's complaint was that the app makes
   * the agent's progress feel slow, so the signal driving this had to be something that
   * changes twice a turn rather than something recomputed per event. Everything the
   * animation needs beyond it is already on the canvas.
   */
  agentBusy?: boolean
}

const PULSE_MS = 900

/**
 * How faint an untagged node gets when nothing is selected.
 *
 * Well above invisible: the point is a hierarchy of attention, not hiding half the
 * vault. Anything the user has not filed yet still has to be findable.
 */
const MIN_NODE_ALPHA = 0.42
const MAX_LABELS = 140
const HUB_LABEL_DEGREE = 8

/**
 * Radians per second the graph turns on its own.
 *
 * A full revolution takes a little over three minutes. Slow enough that it reads as drift
 * rather than as animation — the graph is the home screen, and something that visibly
 * spins is unusable to sit in front of. Fast enough that the parallax is doing the work of
 * saying "this has depth", which a still perspective projection does not manage on its own.
 *
 * Divided by the zoom below, so the number here is the speed at the default scale and the
 * effective rate is slower whenever the user is looking closely.
 */
const ROTATE_RATE = 0.034

/** Radians of orbit per pixel dragged. A little under a right angle across 250px. */
const ORBIT_PER_PIXEL = 0.006

/** Floats per node in the projected cache: view x, view y, perspective k, depth. */
const VIEW_STRIDE = 4

/**
 * The travelling dash on a live edge.
 *
 * Length and gap in screen pixels, and speed in pixels per second. Slow enough to read as
 * something moving *along* the wire rather than as a flicker — below about 40px/s the eye
 * loses the direction, above about 120 it stops looking deliberate.
 */
const LIVE_DASH: [number, number] = [5, 11]
const LIVE_DASH_SPEED = 62

/**
 * How many nodes may be marked as "being examined" at once.
 *
 * A search can return twenty matches, and twenty lit nodes with every edge between them
 * animating is not an answer to "which one is it looking at" — it is the same "something,
 * somewhere" the whole-canvas version gave. The ids arrive in rank order, so this keeps the
 * best matches.
 */
const MAX_LIVE_NODES = 6

/**
 * Weight of the *last* node in a ranked focus, as a fraction of the first.
 *
 * Not much lower. The floor has to stay clearly above the dimming applied to everything
 * outside the focus (0.2), or the tail of a result set reads as "not in the answer" rather
 * than as "in the answer, less so" — which would be a worse lie than treating them equally.
 */
const FOCUS_FLOOR = 0.55

/** What a focused node's neighbours inherit. Context, not answer. */
const FOCUS_NEIGHBOUR = 0.62

export function GraphCanvas({
  snapshot,
  selectedId,
  onSelect,
  onOpen,
  onHover,
  onPositionsSettled,
  focusRequest,
  pulses,
  onNodeAction,
  settings,
  reduceMotion,
  agentBusy = false
}: GraphCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const workerRef = useRef<Worker | null>(null)

  const posRef = useRef<Float32Array>(new Float32Array(0))
  const idsRef = useRef<string[]>([])
  const indexRef = useRef<Map<string, number>>(new Map())

  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 0.9, yaw: 0, pitch: RESTING_PITCH })

  /**
   * Where every node landed on screen this frame — view x, view y, perspective, depth.
   *
   * Rebuilt once per frame and read by the draw, the hit test and the two framing paths,
   * because projecting a node is not free and all four want the same answer. Held as a
   * flat Float32Array rather than objects for the same reason the worker's positions are:
   * this is the one array in the app that is walked several times per frame.
   */
  const viewRef = useRef<Float32Array>(new Float32Array(0))
  /**
   * How many entries of `viewRef` are real.
   *
   * Not `idsRef.current.length`: ids arrive in the worker's `ready` message and coordinates
   * in `tick`, so for a frame or two after a snapshot change there are more ids than there
   * are positions. Reading past the end of the coordinate array yields zeros, which draws
   * the whole tail of the graph stacked on the origin.
   */
  const viewCountRef = useRef(0)
  /** Half the depth span this frame, for fading the far side. */
  const halfDepthRef = useRef(0)
  /** What the orbit turns about: the centre of the graph, not the world's zero. */
  const pivotRef = useRef({ x: 0, y: 0, z: 0 })
  const orbitRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)
  /**
   * Whether the window is actually on screen.
   *
   * Visibility, not focus. Auto-rotation is a continuous redraw, and running it for a
   * minimised window is spending a GPU for nobody — but a window the user can see while
   * they work in another app is not that case, and stopping a *decorative* drift the
   * moment they click away makes the app look like it has died rather than idled.
   *
   * A ref and not state: it is read inside the render loop, and re-rendering the whole
   * canvas component to deliver it would be the expensive way to say "stop drawing".
   */
  const visibleRef = useRef(true)
  const lastFrameRef = useRef(0)
  /** Node indices sorted back-to-front, reused between frames. */
  const orderRef = useRef<Int32Array>(new Int32Array(0))
  /**
   * The nodes the agent is looking at *right now*.
   *
   * Replaced by each new read, not accumulated across the turn. Unioned, it grew until it
   * touched nearly every edge in the graph and the whole canvas animated — which told the
   * user that something was happening and nothing about where.
   *
   * It does persist between reads rather than expiring with the pulse that set it: a pulse
   * lasts under a second and reading a note takes several, so an expiring marker would
   * leave "Reading a note…" on screen with nothing on the graph to say which note. So the
   * rule is last-read-wins, held until the next read or the end of the turn.
   */
  const liveIdsRef = useRef<Set<string>>(new Set())
  /**
   * The camera to come back to when the agent has finished, and whether it is still ours.
   *
   * Leaning in on what is being read is only welcome if the graph goes back afterwards —
   * otherwise a conversation slowly walks the view somewhere the user never chose. And it is
   * abandoned the moment they touch the view themselves: overruling a deliberate pan to
   * restore a position the app picked would be the rudest thing here.
   */
  const autoFrameRef = useRef<{ restore: Camera; ours: boolean } | null>(null)
  const tweenRef = useRef(new CameraTween())
  const viewportRef = useRef({ width: 1, height: 1 })
  const dprRef = useRef(1)

  const hoverRef = useRef<string | null>(null)
  /**
   * A node being dragged, and what it looked like when the drag began.
   *
   * The start state is recorded rather than recomputed because the move is applied as a
   * delta from it. Following the pointer's absolute world position instead would only be
   * correct with an unrotated camera — under an orbit, the pointer's position on the view
   * plane and the node's own coordinates are in different frames.
   */
  const dragRef = useRef<{
    id: string
    moved: boolean
    origin: { x: number; y: number; z: number }
    pointer: { x: number; y: number }
    k: number
  } | null>(null)
  const panRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null)
  const themeRef = useRef<GraphTheme>(readGraphTheme())
  const needsDrawRef = useRef(true)
  const hasFramedRef = useRef(false)
  /** What the worker currently holds, for diffing the next snapshot against. */
  const previousRef = useRef<{ nodeIds: Set<string>; edgeKeys: Set<string> } | null>(null)
  /** Pending check that the layout ever arrived. See the recovery in the snapshot effect. */
  const recoverTimerRef = useRef<number | null>(null)
  /** Set once a recovery has been attempted, so it cannot become a loop. */
  const recoveredRef = useRef(false)

  const [hoverLabel, setHoverLabel] = useState<{ id: string; x: number; y: number } | null>(null)
  const [isEmpty, setIsEmpty] = useState(snapshot.nodes.length === 0)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)

  const kindsPresent = useMemo(() => GraphKindsPresent(snapshot.nodes), [snapshot.nodes])

  /* --------------------------------------------------------------- indexes */

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphSnapshot['nodes'][number]>()
    for (const node of snapshot.nodes) map.set(node.id, node)
    return map
  }, [snapshot])

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const edge of snapshot.edges) {
      let from = map.get(edge.src)
      if (!from) map.set(edge.src, (from = new Set()))
      from.add(edge.dst)

      let to = map.get(edge.dst)
      if (!to) map.set(edge.dst, (to = new Set()))
      to.add(edge.src)
    }
    return map
  }, [snapshot])

  /**
   * The focused ids that are actually in the graph.
   *
   * Unfiltered, a focus on a note that has since been trashed — or on one the snapshot
   * capped out — dimmed every node and highlighted none, leaving the graph uniformly grey
   * with nothing to look at and no camera move to explain it. Filtered, a wholly stale
   * focus is simply nothing.
   */
  const focusRanked = useMemo(
    () => (focusRequest?.ids ?? []).filter((id) => nodeById.has(id)),
    [focusRequest, nodeById]
  )
  const focusIds = useMemo(() => new Set(focusRanked), [focusRanked])

  /* ---------------------------------------------------------------- worker */

  useEffect(() => {
    const worker = new ForceWorker()
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data

      if (message.type === 'ready') {
        idsRef.current = message.ids
        indexRef.current = new Map(message.ids.map((id, i) => [id, i]))
        return
      }

      posRef.current = message.positions3
      needsDrawRef.current = true

      if (message.type === 'settled') {
        // Frame the graph the first time it settles, so the user never lands on
        // an off-screen or absurdly zoomed view.
        if (!hasFramedRef.current && idsRef.current.length > 0) {
          hasFramedRef.current = true
          fitToContent(false)
        }

        if (onPositionsSettled) {
          // Stride 3. This is the site that would have silently corrupted the vault: read
          // at the old stride, node i's depth is persisted as node i+1's y, and it goes
          // straight to SQLite. Renaming the field is what made it a compile error.
          const out: { id: string; x: number; y: number; z: number }[] = []
          for (let i = 0; i < idsRef.current.length; i++) {
            out.push({
              id: idsRef.current[i],
              x: message.positions3[i * 3],
              y: message.positions3[i * 3 + 1],
              z: message.positions3[i * 3 + 2]
            })
          }
          onPositionsSettled(out)
        }
      }
    }

    return () => {
      worker.postMessage({ type: 'stop' } satisfies WorkerRequest)
      worker.terminate()
      workerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Which ring each node belongs on.
   *
   * Recomputed with the snapshot rather than per frame: it is a walk over the whole
   * graph, and it only changes when the graph does.
   */
  const levels = useMemo(
    () => computeLevels(snapshot.nodes, snapshot.edges),
    [snapshot.nodes, snapshot.edges]
  )

  /**
   * Baseline opacity per node, from how well tagged it is.
   *
   * With nothing selected the graph used to be flat: every circle at full strength,
   * so the eye had nowhere to start. Filing is the user's own signal about what
   * matters — a note they bothered to tag three ways is more load-bearing than one
   * they dropped in untagged — so it sets the weight. The untagged stay visible,
   * just quieter.
   *
   * Tag nodes are exempt: they are the labels doing the sorting, not things being
   * sorted, and fading them would undo the point.
   */
  const prominence = useMemo(() => {
    const notes = snapshot.nodes.filter((node) => node.kind !== 'tag')
    const counts = notes.map((node) => node.tags.length)
    const most = Math.max(0, ...counts)
    const map = new Map<string, number>()

    // Nothing tagged yet, or everything tagged the same: no signal, so no fading.
    if (most === 0) return map

    for (const node of notes) {
      map.set(node.id, MIN_NODE_ALPHA + (1 - MIN_NODE_ALPHA) * (node.tags.length / most))
    }
    return map
  }, [snapshot.nodes])

  // Feed the simulation whenever the graph itself changes. Small changes are sent
  // as a diff so the layout is not thrown away — this is what makes notes the
  // agent creates during a conversation appear without the graph jumping.
  useEffect(() => {
    const worker = workerRef.current
    if (!worker) return

    // Before anything is posted: `init` carries the viewport, and the fit that follows the
    // first settle is computed from it.
    measureViewport()

    setIsEmpty(snapshot.nodes.length === 0)
    if (snapshot.nodes.length === 0) {
      posRef.current = new Float32Array(0)
      idsRef.current = []
      previousRef.current = null
      needsDrawRef.current = true
      return
    }

    const toNodeInput = (node: GraphSnapshot['nodes'][number]): WorkerNodeInput => ({
      id: node.id,
      x: node.x,
      y: node.y,
      degree: node.degree,
      pinned: node.pinned,
      level: levels.get(node.id) ?? 1,
      isTag: node.kind === 'tag',
      z: node.z
    })
    const toEdgeInput = (edge: GraphSnapshot['edges'][number]): WorkerEdgeInput => ({
      src: edge.src,
      dst: edge.dst,
      weight: edge.weight
    })

    const previous = previousRef.current
    const nextNodeIds = new Set(snapshot.nodes.map((n) => n.id))
    const nextEdgeKeys = new Map(snapshot.edges.map((e) => [`${e.src}|${e.dst}`, e]))

    const diff = previous
      ? {
          addNodes: snapshot.nodes.filter((n) => !previous.nodeIds.has(n.id)).map(toNodeInput),
          removeNodeIds: [...previous.nodeIds].filter((id) => !nextNodeIds.has(id)),
          addEdges: [...nextEdgeKeys.entries()]
            .filter(([key]) => !previous.edgeKeys.has(key))
            .map(([, edge]) => toEdgeInput(edge)),
          removeEdges: [...previous.edgeKeys]
            .filter((key) => !nextEdgeKeys.has(key))
            .map((key) => {
              const [src, dst] = key.split('|')
              return { src, dst, weight: 1 }
            })
        }
      : null

    // Past a certain churn a diff is more disruptive than a clean rebuild, and a
    // first load has nothing to preserve.
    const churn = diff ? diff.addNodes.length + diff.removeNodeIds.length : Infinity
    const useDiff =
      diff !== null && churn > 0 && churn <= Math.max(24, snapshot.nodes.length * 0.3)

    /** The whole graph, from scratch. Shared with the recovery below. */
    const postInit = (): void => {
      const target = workerRef.current
      if (!target) return
      target.postMessage({
        type: 'init',
        nodes: snapshot.nodes.map(toNodeInput),
        edges: snapshot.edges.map(toEdgeInput),
        settings: { linkDistance: settings.linkDistance, charge: settings.charge },
        // Read at call time, not captured: a recovery two seconds later should use the size
        // the window has then.
        width: viewportRef.current.width,
        height: viewportRef.current.height
      } satisfies WorkerRequest)
    }

    if (useDiff && diff) {
      worker.postMessage({ type: 'update', ...diff } satisfies WorkerRequest)
    } else if (churn > 0 || !previous) {
      hasFramedRef.current = previous !== null ? hasFramedRef.current : false
      postInit()
    } else if (diff && (diff.addEdges.length > 0 || diff.removeEdges.length > 0)) {
      // Only relations moved; nudge the layout without touching node identity.
      worker.postMessage({
        type: 'update',
        addNodes: [],
        removeNodeIds: [],
        addEdges: diff.addEdges,
        removeEdges: diff.removeEdges
      } satisfies WorkerRequest)
    }

    previousRef.current = { nodeIds: nextNodeIds, edgeKeys: new Set(nextEdgeKeys.keys()) }

    /*
     * A graph that never hears back asks again, once.
     *
     * The symptom this exists for is a canvas that paints its background and nothing else:
     * the snapshot has nodes, the worker was sent them, and no positions ever arrived — so
     * `viewCountRef` stays 0, the draw returns immediately, and it does so for ever. That is
     * what "the graph disappeared after closing a tool" looked like, and it could not be
     * reproduced here, so this is a recovery rather than a diagnosis: whatever stopped the
     * first `init` from landing, sending it again is cheap and fixes the visible problem.
     *
     * Once, and it reports itself. A silent retry would paper over the fault instead of
     * leaving a record that it happened — and the record is what a next attempt at the root
     * cause will start from.
     */
    if (recoverTimerRef.current !== null) window.clearTimeout(recoverTimerRef.current)
    recoverTimerRef.current = window.setTimeout(() => {
      recoverTimerRef.current = null
      if (recoveredRef.current || viewCountRef.current > 0 || snapshot.nodes.length === 0) return
      recoveredRef.current = true

      void api
        .reportRendererError({
          kind: 'graph',
          message: `no layout arrived for ${snapshot.nodes.length} nodes; re-initialising`,
          stack: null,
          where: 'GraphCanvas'
        })
        .catch(() => undefined)

      previousRef.current = null
      hasFramedRef.current = false
      postInit()
    }, 2500)

    return () => {
      if (recoverTimerRef.current === null) return
      window.clearTimeout(recoverTimerRef.current)
      recoverTimerRef.current = null
    }
    // Only the graph shape should reach the simulation here; force tuning is separate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot])

  useEffect(() => {
    workerRef.current?.postMessage({
      type: 'settings',
      settings: { linkDistance: settings.linkDistance, charge: settings.charge }
    } satisfies WorkerRequest)
  }, [settings.linkDistance, settings.charge])

  /* ------------------------------------------------------------ theme sync */

  useEffect(() => {
    const observer = new MutationObserver(() => {
      themeRef.current = readGraphTheme()
      needsDrawRef.current = true
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  /* ------------------------------------------------------------- measuring */

  /**
   * Read the container's real size into `viewportRef`.
   *
   * Callable rather than only done by the ResizeObserver, because effects run in the order
   * they are declared and the observer's is not the first — so on any mount where the graph
   * snapshot is *already* available, the layout was fed and the camera framed against a
   * viewport of 1x1. On first launch that never happened, since the snapshot arrives from
   * bootstrap a moment later; it happened every time the graph was remounted, which is what
   * closing a tool does.
   *
   * A viewport of nothing makes `cameraForBounds` fall to MIN_SCALE, and a graph at 0.06
   * scale is a speck that reads as an empty canvas.
   */
  const measureViewport = useCallback((): { width: number; height: number } => {
    const container = containerRef.current
    if (!container) return viewportRef.current

    const rect = container.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      viewportRef.current = { width: rect.width, height: rect.height }
    }
    return viewportRef.current
  }, [])

  /* -------------------------------------------------------- window visibility */

  useEffect(() => {
    const onChange = (): void => {
      const visible = document.visibilityState === 'visible'
      visibleRef.current = visible
      if (visible) {
        // The elapsed clock has to be discarded, not resumed: the gap since the last frame
        // is however long the window was away, and applied as rotation that is a jump.
        lastFrameRef.current = 0
        needsDrawRef.current = true
      }
    }

    onChange()
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  /* ------------------------------------------------------------ projection */

  /**
   * Project every node at the current orbit into `viewRef`.
   *
   * Also fixes the pivot and the depth span for this frame. Both are measured from the
   * layout rather than assumed: `forceCenter` keeps the graph near the world origin, but
   * a user who has dragged and pinned a corner of it has moved the centre, and orbiting
   * about a point the graph is not actually around looks like the whole thing is swinging
   * on a rope.
   */
  const projectAll = useCallback((): Float32Array => {
    const positions = posRef.current
    const ids = idsRef.current
    const count = Math.min(ids.length, Math.floor(positions.length / 3))
    viewCountRef.current = count

    let view = viewRef.current
    if (view.length !== count * VIEW_STRIDE) {
      view = new Float32Array(count * VIEW_STRIDE)
      viewRef.current = view
    }
    if (count === 0) {
      halfDepthRef.current = 0
      return view
    }

    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity

    for (let i = 0; i < count; i++) {
      const x = positions[i * 3]
      const y = positions[i * 3 + 1]
      const z = positions[i * 3 + 2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }

    const pivot = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2
    }
    pivotRef.current = pivot

    // Perspective proportional to the graph, so a new vault of twelve notes and a mature
    // one of two thousand read with the same amount of depth. Measured across all three
    // axes rather than depth alone: see `focalFor`.
    const focal = focalFor(
      Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2
    )

    const orbit = cameraRef.current
    let halfDepth = 0

    for (let i = 0; i < count; i++) {
      const projected = project(
        { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] },
        pivot,
        orbit,
        focal
      )
      view[i * VIEW_STRIDE] = projected.x
      view[i * VIEW_STRIDE + 1] = projected.y
      view[i * VIEW_STRIDE + 2] = projected.k
      view[i * VIEW_STRIDE + 3] = projected.depth
      const absolute = Math.abs(projected.depth)
      if (absolute > halfDepth) halfDepth = absolute
    }

    halfDepthRef.current = halfDepth
    return view
  }, [])

  /* ---------------------------------------------------------------- camera */

  const fitToContent = useCallback(
    (animate = true) => {
      // Measured here rather than trusted: this runs on the worker's first `settled`, which
      // on a vault with saved positions arrives almost immediately — possibly before the
      // ResizeObserver has said anything.
      measureViewport()
      // Framed from the *projection*, not the layout: what has to fit on screen is what
      // the current orbit puts there. Framing the raw coordinates would leave a graph
      // seen edge-on floating in the middle of an empty viewport.
      const view = projectAll()
      const count = viewCountRef.current
      if (count === 0) return

      const points: { x: number; y: number }[] = []
      for (let i = 0; i < count; i++) {
        points.push({ x: view[i * VIEW_STRIDE], y: view[i * VIEW_STRIDE + 1] })
      }

      const bounds = boundsOf(points)
      if (!bounds) return

      const target = cameraForBounds(bounds, viewportRef.current, cameraRef.current)
      if (animate && !reduceMotion) tweenRef.current.start(cameraRef.current, target)
      else cameraRef.current = target
      needsDrawRef.current = true
    },
    [measureViewport, projectAll, reduceMotion]
  )

  /**
   * Bring a handful of nodes into view.
   *
   * Shared by the agent's explicit focus and by the automatic framing below, because they
   * are the same operation with different reasons — and two copies of the projection,
   * bounds and tween dance would drift.
   *
   * Returns the camera it started from, so a caller that means to undo itself later can
   * keep it. Null when there was nothing on screen to frame.
   */
  const frameIds = useCallback(
    (ids: Iterable<string>, opts: { padding: number; maxScale: number; ms: number }): Camera | null => {
      measureViewport()
      const view = projectAll()
      const count = viewCountRef.current
      const points: { x: number; y: number }[] = []
      for (const id of ids) {
        const index = indexRef.current.get(id)
        if (index === undefined || index >= count) continue
        points.push({ x: view[index * VIEW_STRIDE], y: view[index * VIEW_STRIDE + 1] })
      }

      const bounds = boundsOf(points)
      if (!bounds) return null

      const from = { ...cameraRef.current }
      const target = cameraForBounds(
        bounds,
        viewportRef.current,
        cameraRef.current,
        opts.padding,
        opts.maxScale
      )
      if (reduceMotion) cameraRef.current = target
      else tweenRef.current.start(cameraRef.current, target, opts.ms)
      needsDrawRef.current = true
      return from
    },
    [measureViewport, projectAll, reduceMotion]
  )

  // Focus request from the agent or the UI.
  useEffect(() => {
    if (!focusRequest || focusRequest.ids.length === 0) return
    frameIds(focusRequest.ids, { padding: 140, maxScale: 1.5, ms: 520 })
  }, [focusRequest, frameIds])

  /* ------------------------------------------------------ the live wiring */

  useEffect(() => {
    if (!agentBusy) {
      // Ending the turn is the only thing that empties this. Doing it here rather than on
      // a timer means the wiring goes quiet at exactly the moment the answer lands.
      if (liveIdsRef.current.size > 0) {
        liveIdsRef.current = new Set()
        needsDrawRef.current = true
      }
      return
    }

    // Only when there is a new read to show. An empty `pulses` means the last one has
    // faded, not that the agent has moved on — so the previous marker stays.
    const fresh = pulses.length > 0 ? pulses.map((pulse) => pulse.id) : [...focusIds]
    if (fresh.length === 0) return

    const next = new Set(fresh.slice(0, MAX_LIVE_NODES))
    const previous = liveIdsRef.current
    const same = next.size === previous.size && [...next].every((id) => previous.has(id))
    if (same) return

    liveIdsRef.current = next
    needsDrawRef.current = true

    // Lean in on what it is reading. Under reduced motion this does not happen at all: the
    // marker and the wiring already say where the work is, and a camera that travels is the
    // one part of this that is movement rather than information.
    if (reduceMotion) return

    if (!autoFrameRef.current) autoFrameRef.current = { restore: { ...cameraRef.current }, ours: true }
    if (!autoFrameRef.current.ours) return

    // Generous padding and a modest ceiling on the zoom: the point is to make the node
    // legible, not to fill the canvas with it and lose the neighbourhood that explains it.
    frameIds(next, { padding: 200, maxScale: 1.35, ms: 620 })
  }, [agentBusy, pulses, focusIds, reduceMotion, frameIds])

  // And back out when the turn is over.
  useEffect(() => {
    if (agentBusy) return
    const framed = autoFrameRef.current
    autoFrameRef.current = null
    if (!framed || !framed.ours || reduceMotion) return

    // Slower coming back than going in. Arriving is a cut to what matters; leaving is the
    // view being handed back, and being handed something quickly feels like losing it.
    tweenRef.current.start(cameraRef.current, framed.restore, 760)
    needsDrawRef.current = true
  }, [agentBusy, reduceMotion])

  /* ------------------------------------------------------------- resize */

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const resize = (): void => {
      const rect = container.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)

      measureViewport()
      dprRef.current = dpr

      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`

      workerRef.current?.postMessage({
        type: 'resize',
        width: rect.width,
        height: rect.height
      } satisfies WorkerRequest)

      needsDrawRef.current = true
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [measureViewport])

  /* --------------------------------------------------------- hit testing */

  const hitTest = useCallback(
    (sx: number, sy: number): string | null => {
      // The frame's own projection, not a fresh one: the click has to hit what the user
      // can see, and re-projecting here at a slightly later orbit would put the target a
      // fraction of a degree away from where it was drawn.
      const view = viewRef.current
      const count = viewCountRef.current
      const camera = cameraRef.current
      const viewport = viewportRef.current
      const world = screenToWorld(camera, viewport, sx, sy)

      // Generous in screen space so small nodes stay clickable when zoomed out.
      const slack = 6 / camera.scale
      let best: string | null = null
      let bestDepth = -Infinity

      for (let i = 0; i < count; i++) {
        const id = idsRef.current[i]
        const node = nodeById.get(id)
        if (!node) continue

        const k = view[i * VIEW_STRIDE + 2]
        const dx = view[i * VIEW_STRIDE] - world.x
        const dy = view[i * VIEW_STRIDE + 1] - world.y
        const distance = Math.sqrt(dx * dx + dy * dy)
        const radius = radiusForDegree(node.degree) * k + slack

        // Front-most wins, not nearest-centre. Where two nodes overlap, the one on top is
        // the one the user is pointing at — picking by distance would sometimes hand back
        // a node hidden behind the one under the cursor.
        if (distance <= radius && view[i * VIEW_STRIDE + 3] > bestDepth) {
          best = id
          bestDepth = view[i * VIEW_STRIDE + 3]
        }
      }

      return best
    },
    [nodeById]
  )

  /* ---------------------------------------------------------------- draw */

  useEffect(() => {
    let frame = 0

    const render = (): void => {
      frame = requestAnimationFrame(render)

      const now = performance.now()
      // Not while the user has hold of the view. Auto-rotation was gated on the gestures
      // and the tween was not, so a focus arriving mid-drag yanked the camera out from
      // under the pointer.
      const gesturing = Boolean(orbitRef.current || dragRef.current || panRef.current)
      const tweened = gesturing ? null : tweenRef.current.sample(now)
      if (tweened) {
        cameraRef.current = tweened
        needsDrawRef.current = true
      }

      // Elapsed rather than per-frame, so the graph turns at the same speed on a 60Hz
      // panel and a 144Hz one. Clamped because a tab that was in the background hands
      // back a gap of seconds, and that would arrive as a jump.
      const elapsed = lastFrameRef.current === 0 ? 0 : Math.min(0.05, (now - lastFrameRef.current) / 1000)
      lastFrameRef.current = now

      const turning =
        settings.rotate &&
        !reduceMotion &&
        visibleRef.current &&
        // Anything the user is doing with a pointer owns the view until they let go.
        !orbitRef.current &&
        !dragRef.current &&
        !panRef.current &&
        !tweenRef.current.active

      if (turning && elapsed > 0) {
        const camera = cameraRef.current
        // Slowed as the view zooms in. The rate is angular, so at 3x the same radians per
        // second sweep three times as much across the screen — held constant, zooming in
        // to read a cluster turns the graph into something moving too fast to read.
        const rate = ROTATE_RATE / Math.max(1, camera.scale)
        cameraRef.current = {
          ...camera,
          // Wrapped: this runs for as long as the app is open, and an angle that grows
          // without bound loses precision in the trig long before the day is out.
          yaw: (camera.yaw + rate * elapsed) % (Math.PI * 2)
        }
        needsDrawRef.current = true
      }

      // `at` can be in the future: a staggered sweep schedules its tail ahead of
      // time, and the loop has to stay awake until the last one has finished.
      const hasLivePulse = !reduceMotion && pulses.some((pulse) => now < pulse.at + PULSE_MS)
      // A travelling dash is only travelling if the frames keep coming. Bounded by the
      // turn, which is the whole reason this is gated on a boolean and not left on.
      const hasLiveWiring = !reduceMotion && agentBusy && liveIdsRef.current.size > 0
      if (!needsDrawRef.current && !hasLivePulse && !hasLiveWiring) return
      needsDrawRef.current = false

      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return

      const theme = themeRef.current
      const camera = cameraRef.current
      const viewport = viewportRef.current
      const dpr = dprRef.current
      const positions = posRef.current

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, viewport.width, viewport.height)
      ctx.fillStyle = theme.background
      ctx.fillRect(0, 0, viewport.width, viewport.height)

      if (positions.length === 0) return

      const view = projectAll()
      const count = viewCountRef.current
      const halfDepth = halfDepthRef.current
      if (count === 0) return

      // What the user is currently attending to: hover, selection, or an
      // agent-driven focus. Everything outside it is dimmed rather than hidden,
      // so context stays visible.
      /**
       * How much of the user's attention each node has, 0 to 1.
       *
       * A map rather than a set, because a focus is *ranked*: the agent sends its matches
       * best-first, and answering "these seven notes" by drawing all seven identically
       * throws away the one thing it knew that the user did not. The best match is at full
       * strength and the rest fall away behind it, so the ordering is visible instead of
       * being something the user has to read out of the chat.
       */
      const attention = new Map<string, number>()
      const raise = (id: string, weight: number): void => {
        const current = attention.get(id)
        if (current === undefined || weight > current) attention.set(id, weight)
      }

      const primary = hoverRef.current ?? selectedId
      if (primary) {
        // Hover and selection are not ranked — the user is pointing at one thing.
        raise(primary, 1)
        for (const neighbour of adjacency.get(primary) ?? []) raise(neighbour, FOCUS_NEIGHBOUR)
      }

      // Linear from 1 down to FOCUS_FLOOR across the ranking. A single result gets the full
      // weight rather than the floor, which is why the divisor guards against zero.
      const span = Math.max(1, focusRanked.length - 1)
      for (const [rank, id] of focusRanked.entries()) {
        const weight = 1 - (rank / span) * (1 - FOCUS_FLOOR)
        raise(id, weight)
        if (focusRanked.length <= 12) {
          for (const neighbour of adjacency.get(id) ?? []) raise(neighbour, weight * FOCUS_NEIGHBOUR)
        }
      }

      const dimming = attention.size > 0

      const index = indexRef.current
      /** Where a node is on screen, with the perspective and depth it was projected at. */
      const screenOf = (id: string): { x: number; y: number; k: number; depth: number } | null => {
        const i = index.get(id)
        if (i === undefined || i >= count) return null
        const point = worldToScreen(camera, viewport, view[i * VIEW_STRIDE], view[i * VIEW_STRIDE + 1])
        return {
          x: point.x,
          y: point.y,
          k: view[i * VIEW_STRIDE + 2],
          depth: view[i * VIEW_STRIDE + 3]
        }
      }

      /* --------------------------------------------------------- edges ---- */

      /**
       * Which edges are worth drawing when nothing is selected.
       *
       * A tag's edges are the worst offenders in a dense graph: the tag sits on the
       * rim and its notes are spread through the middle, so every one of them is a
       * long line across the whole canvas — and it says nothing the tag's own
       * presence does not already say. Twenty of those are most of the mess. They
       * come back the moment the tag, or a note carrying it, is what you are looking
       * at, which is when the answer to "what is in this tag" actually matters.
       */
      const isTagEdge = (edge: GraphSnapshot['edges'][number]): boolean =>
        nodeById.get(edge.src)?.kind === 'tag' || nodeById.get(edge.dst)?.kind === 'tag'

      /**
       * One batched pass per style.
       *
       * Curved rather than straight: two clusters joined by several edges draw as a
       * single solid mass when the lines are parallel, and a slight bow separates
       * them. The offset is derived from the endpoints so it never flickers between
       * frames, and it scales with length so short edges stay effectively straight.
       */
      const drawEdgePass = (
        include: (edge: GraphSnapshot['edges'][number], inAttention: boolean) => boolean,
        style: { color: string; width: number; alpha: number; dash?: number[] },
        band?: 'far' | 'near'
      ): void => {
        ctx.beginPath()
        let any = false

        for (const edge of snapshot.edges) {
          const inAttention = attention.has(edge.src) && attention.has(edge.dst)
          if (!include(edge, inAttention)) continue

          const from = screenOf(edge.src)
          const to = screenOf(edge.dst)
          if (!from || !to) continue

          // A pass is one stroke with one alpha, which is what makes it cheap and also
          // why depth cannot be per-edge here. Two passes over the same predicate, split
          // at the mid-plane, buys most of the cue for one extra stroke: without it the
          // wiring at the back is as loud as the wiring in front and the depth the nodes
          // are working to convey is contradicted by the lines between them.
          if (band && (from.depth + to.depth >= 0) !== (band === 'near')) continue

          // Cheap offscreen cull: skip when both ends are well outside.
          if (
            (from.x < -200 && to.x < -200) ||
            (from.x > viewport.width + 200 && to.x > viewport.width + 200) ||
            (from.y < -200 && to.y < -200) ||
            (from.y > viewport.height + 200 && to.y > viewport.height + 200)
          ) {
            continue
          }

          any = true
          const dx = to.x - from.x
          const dy = to.y - from.y
          const length = Math.hypot(dx, dy)

          if (length < 24) {
            ctx.moveTo(from.x, from.y)
            ctx.lineTo(to.x, to.y)
            continue
          }

          // Perpendicular offset at the midpoint, capped so a very long edge does
          // not swing out into unrelated parts of the graph.
          const bow = Math.min(26, length * 0.075)
          ctx.moveTo(from.x, from.y)
          ctx.quadraticCurveTo(
            (from.x + to.x) / 2 - (dy / length) * bow,
            (from.y + to.y) / 2 + (dx / length) * bow,
            to.x,
            to.y
          )
        }

        if (!any) return
        if (style.dash) ctx.setLineDash(style.dash)
        ctx.strokeStyle = style.color
        ctx.lineWidth = style.width
        ctx.globalAlpha = style.alpha
        ctx.stroke()
        if (style.dash) ctx.setLineDash([])
      }

      // Written links, the load-bearing ones. Far half first, so the near half draws over
      // it — the same back-to-front order the nodes are drawn in.
      for (const band of ['far', 'near'] as const) {
        drawEdgePass(
          (edge, inAttention) =>
            !isTagEdge(edge) && edge.kind !== 'similar' && (dimming ? !inAttention : true),
          {
            color: theme.edge,
            // Nothing below 1.0 CSS px. At devicePixelRatio 1 a 0.85px stroke is spread
            // across two pixel rows by antialiasing and loses roughly a further sixth of
            // its weight on top of the band multiplier — so the far band was being dimmed
            // twice, once on purpose. The depth cue is carried entirely in alpha now.
            width: band === 'near' ? 1.15 : 1,
            alpha: (dimming ? 0.1 : 0.44) * (band === 'near' ? 1.15 : 0.46)
          },
          band
        )
      }

      // The curator's guesses, dashed so they read as inferred rather than written.
      drawEdgePass(
        (edge, inAttention) =>
          edge.kind === 'similar' && !isTagEdge(edge) && (dimming ? !inAttention : true),
        { color: theme.edge, width: 1, alpha: dimming ? 0.06 : 0.24, dash: [2, 4] }
      )

      /**
       * The agent's own wiring, while it is working.
       *
       * Drawn after the resting passes so it reads as something added on top rather than a
       * different kind of link, and offset over time so the dashes travel from one end to
       * the other — the thing the user asked for: the lines move while the connection is
       * in progress. It costs one extra stroke over a subset of the edges, and nothing at
       * all when the agent is idle.
       *
       * The dash offset is derived from the clock rather than accumulated, so a dropped
       * frame changes nothing and there is no state to reset.
       */
      if (agentBusy && liveIdsRef.current.size > 0) {
        const live = liveIdsRef.current
        const offset = reduceMotion ? 0 : -((now / 1000) * LIVE_DASH_SPEED) % (LIVE_DASH[0] + LIVE_DASH[1])
        ctx.lineDashOffset = offset
        drawEdgePass(
          (edge) => live.has(edge.src) || live.has(edge.dst),
          { color: theme.halo, width: 1.5, alpha: 0.62, dash: LIVE_DASH }
        )
        ctx.lineDashOffset = 0
      }

      /**
       * Tag membership: a whisper at rest, and properly drawn when relevant.
       *
       * Hiding these outright was cleaner but wrong — a tag with no visible edge at
       * all reads as an orphan, and the graph looked like it had lost half its
       * relationships. Barely-there dashes say "this is attached to things" without
       * putting twenty long lines through the middle.
       */
      drawEdgePass(
        (edge) =>
          isTagEdge(edge) &&
          (dimming ? attention.has(edge.src) || attention.has(edge.dst) : true),
        dimming
          ? { color: theme.edgeStrong, width: 1, alpha: 0.4, dash: [1, 3] }
          : { color: theme.edge, width: 1, alpha: 0.085, dash: [1, 5] }
      )

      // Everything inside the current attention, over the top.
      if (dimming) {
        drawEdgePass((_edge, inAttention) => inAttention, {
          color: theme.edgeStrong,
          width: 1.4,
          alpha: 0.75
        })
      }

      ctx.globalAlpha = 1

      /* ------------------------------- pulses, behind the nodes ------- */

      // Nodes the agent is reading right now, so they can be brightened and their
      // names forced on below — a search is only satisfying to watch if you can
      // read what it found.
      const probing = new Map<string, number>()

      if (!reduceMotion) {
        for (const pulse of pulses) {
          const elapsed = now - pulse.at
          // Negative while a staggered pulse waits its turn.
          if (elapsed < 0 || elapsed > PULSE_MS) continue

          const point = screenOf(pulse.id)
          if (!point) continue

          const node = nodeById.get(pulse.id)
          const base = radiusForDegree(node?.degree ?? 1) * camera.scale * point.k
          const t = elapsed / PULSE_MS
          // ease-out so the ring leaves fast and fades, reading as an emission
          // rather than a throb.
          const eased = 1 - Math.pow(1 - t, 3)

          if (pulse.kind === 'probe') {
            // A read looks inward rather than outward: a soft glow that swells and
            // fades under the node, plus a ring that arrives instead of leaving.
            // An edit throws a ring off; being looked at should feel like being lit.
            const strength = Math.sin(Math.PI * t)
            probing.set(pulse.id, Math.max(probing.get(pulse.id) ?? 0, strength))

            ctx.beginPath()
            ctx.arc(point.x, point.y, base + 6 + (1 - eased) * 16, 0, Math.PI * 2)
            ctx.fillStyle = theme.halo
            ctx.globalAlpha = 0.16 * strength
            ctx.fill()

            ctx.beginPath()
            ctx.arc(point.x, point.y, base + 3 + (1 - eased) * 20, 0, Math.PI * 2)
            ctx.strokeStyle = theme.halo
            ctx.lineWidth = 1.6
            ctx.globalAlpha = 0.7 * strength
            ctx.stroke()
            continue
          }

          ctx.beginPath()
          ctx.arc(point.x, point.y, base + eased * 34, 0, Math.PI * 2)
          ctx.strokeStyle = theme.halo
          ctx.lineWidth = 2 * (1 - eased) + 0.4
          ctx.globalAlpha = 0.55 * (1 - eased)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }

      /* ----------------------------------------------- nodes ----------- */

      const labelCandidates: {
        id: string
        x: number
        y: number
        degree: number
        radius: number
        depth: number
        fade: number
      }[] = []

      // Back to front, so a node in front of another covers it rather than being covered
      // by it. The order array is reused across frames: this sorts every node every frame
      // and allocating it each time would be the graph's largest source of garbage.
      let order = orderRef.current
      if (order.length !== count) {
        order = new Int32Array(count)
        orderRef.current = order
      }
      for (let i = 0; i < count; i++) order[i] = i
      order.sort((a, b) => view[a * VIEW_STRIDE + 3] - view[b * VIEW_STRIDE + 3])

      for (let pass = 0; pass < count; pass++) {
        const i = order[pass]
        const id = idsRef.current[i]
        const node = nodeById.get(id)
        if (!node) continue

        const k = view[i * VIEW_STRIDE + 2]
        const point = worldToScreen(camera, viewport, view[i * VIEW_STRIDE], view[i * VIEW_STRIDE + 1])
        const radius = radiusForDegree(node.degree) * camera.scale * k

        if (
          point.x < -radius - 40 ||
          point.x > viewport.width + radius + 40 ||
          point.y < -radius - 40 ||
          point.y > viewport.height + radius + 40
        ) {
          continue
        }

        const lit = probing.get(id) ?? 0
        // The node the agent is working on, for as long as it is working on it — this is
        // what the 900ms pulse could not do on its own.
        const examining = agentBusy && liveIdsRef.current.has(id)
        // Being read counts as attention, so a searched node keeps full opacity
        // even while an unrelated focus is dimming everything else.
        const weight = attention.get(id)
        const inAttention = weight !== undefined || lit > 0 || examining

        // Depth is dimmed as well as shrunk, because on a dark background parallax on its
        // own reads as movement rather than as distance.
        //
        // Attention cancels it outright rather than softening it. Clamped instead, the best
        // match in an answer still came out at 85% for the crime of being at the back —
        // which makes the one node the user was told to look at fainter than a node they
        // were not, and leaves nothing on the canvas at full strength to anchor the rest.
        const fade =
          inAttention || id === selectedId ? 1 : depthFade(view[i * VIEW_STRIDE + 3], halfDepth)

        // With nothing selected, weight by how well tagged it is; with something selected,
        // that reading is replaced by the ranking — the best match at full strength, less
        // for each one behind it, and a flat 0.2 for everything outside the answer.
        //
        // Being read, or selected, outranks the ranking: whatever the agent is on *now* is
        // the answer to "where is it working", and a rank-four node it happens to be reading
        // is not the place to be subtle about that.
        const focusAlpha =
          lit > 0 || examining || id === selectedId ? 1 : (weight ?? 0.2)
        const alpha = (dimming ? focusAlpha : (prominence.get(id) ?? 1)) * fade
        ctx.globalAlpha = alpha

        const color = theme.kinds[node.kind as NodeKind] ?? theme.kinds.note

        if (node.kind === 'stub') {
          // Hollow: this is a note the user referenced but has not written. The
          // shape says "not yet" without needing a legend.
          ctx.beginPath()
          ctx.arc(point.x, point.y, Math.max(2.5, radius), 0, Math.PI * 2)
          ctx.strokeStyle = color
          ctx.lineWidth = 1.4
          ctx.setLineDash([3, 3])
          ctx.stroke()
          ctx.setLineDash([])
        } else {
          if (lit > 0) {
            // Lifted while it is being read: a slightly larger, brighter disc, so
            // the eye lands on it before the ring has finished.
            ctx.beginPath()
            ctx.arc(point.x, point.y, Math.max(1.6, radius) + lit * 2.4, 0, Math.PI * 2)
            ctx.fillStyle = theme.halo
            ctx.globalAlpha = 0.3 * lit
            ctx.fill()
            ctx.globalAlpha = 1
          }

          if (node.degree >= HUB_LABEL_DEGREE) {
            // Soft halo on hubs gives the graph depth and draws the eye to the
            // places worth starting from.
            ctx.beginPath()
            ctx.arc(point.x, point.y, radius * 2.4, 0, Math.PI * 2)
            ctx.fillStyle = color
            ctx.globalAlpha = alpha * 0.1
            ctx.fill()
            ctx.globalAlpha = alpha
          }

          ctx.beginPath()
          ctx.arc(point.x, point.y, Math.max(1.6, radius), 0, Math.PI * 2)
          ctx.fillStyle = node.color ?? color
          ctx.fill()

          // What the node *is*, before its label has been read. Only once the
          // circle is big enough to hold a legible glyph; below that the disc is
          // cleaner than a smudge.
          if (radius >= MIN_ICON_RADIUS) {
            const icon = iconForNode(node)
            if (icon) {
              drawNodeIcon(ctx, icon, point.x, point.y, radius, theme.background)
            }
          }

          if (node.pinned) {
            ctx.beginPath()
            ctx.arc(point.x, point.y, Math.max(1.6, radius) + 2.5, 0, Math.PI * 2)
            ctx.strokeStyle = theme.label
            ctx.lineWidth = 1
            ctx.globalAlpha = alpha * 0.5
            ctx.stroke()
            ctx.globalAlpha = alpha
          }
        }

        if (examining) {
          // A ring that breathes, so it reads as ongoing rather than as a static badge.
          // The frames are already coming — the wiring animation is keeping the loop
          // awake — so the sine costs nothing that is not already being spent.
          const breath = reduceMotion ? 0.7 : 0.55 + 0.25 * Math.sin(now / 380)
          ctx.beginPath()
          ctx.arc(point.x, point.y, Math.max(1.6, radius) + 4.5, 0, Math.PI * 2)
          ctx.strokeStyle = theme.halo
          ctx.lineWidth = 1.6
          ctx.globalAlpha = breath
          ctx.stroke()
          ctx.globalAlpha = alpha
        }

        if (id === selectedId) {
          ctx.beginPath()
          ctx.arc(point.x, point.y, Math.max(1.6, radius) + 5, 0, Math.PI * 2)
          ctx.strokeStyle = theme.selection
          ctx.lineWidth = 2
          ctx.stroke()
        }

        const shouldLabel =
          inAttention || camera.scale >= settings.labelThreshold || node.degree >= HUB_LABEL_DEGREE
        if (shouldLabel) {
          labelCandidates.push({
            id,
            x: point.x,
            y: point.y,
            // A node being read outranks a hub for the label budget: the whole
            // point is to be able to read what was found.
            // Rank beats connectivity for the label budget: the point of a ranked answer
            // is being able to read the best match's name first.
            degree:
              lit > 0 || examining
                ? node.degree + 1000
                : weight !== undefined
                  ? node.degree + Math.round(weight * 500)
                  : node.degree,
            radius,
            depth: view[i * VIEW_STRIDE + 3],
            fade
          })
        }
      }

      ctx.globalAlpha = 1

      /* ---------------------------------------------- labels ----------- */

      // Text is the most expensive thing on the canvas, so the best-connected
      // nodes win when there are more candidates than the budget allows. Depth breaks the
      // tie: placement is first-come and a collision drops the later label, so without
      // this a node at the back could silently take the name off one in front of it.
      labelCandidates.sort((a, b) => b.degree - a.degree || b.depth - a.depth)
      const labels =
        labelCandidates.length > MAX_LABELS ? labelCandidates.slice(0, MAX_LABELS) : labelCandidates

      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'

      /**
       * Placed labels, so a later one can be dropped rather than written over an
       * earlier one.
       *
       * Two overlapping labels are worse than one label: neither can be read, and
       * the graph looks broken. So they are placed in importance order — what is
       * being read first, then hubs — and anything that would collide is skipped.
       * The node itself is still drawn, so nothing disappears; only its name waits
       * until there is room, which is what zooming in gives you.
       */
      const placed: { left: number; right: number; top: number; bottom: number }[] = []
      const fits = (box: (typeof placed)[number]): boolean =>
        !placed.some(
          (other) =>
            box.left < other.right &&
            box.right > other.left &&
            box.top < other.bottom &&
            box.bottom > other.top
        )

      for (const label of labels) {
        const node = nodeById.get(label.id)
        if (!node) continue

        const lit = probing.get(label.id) ?? 0
        const weight = attention.get(label.id)
        const inAttention = weight !== undefined || lit > 0
        const isHub = node.degree >= HUB_LABEL_DEGREE

        // Hubs are named a size larger: at a glance the graph then has headings
        // rather than forty equal captions.
        ctx.font = isHub
          ? '600 12.5px InterVariable, Inter, system-ui, sans-serif'
          : '500 11.5px InterVariable, Inter, system-ui, sans-serif'

        const text = node.title.length > 34 ? `${node.title.slice(0, 33)}…` : node.title
        const width = ctx.measureText(text).width
        const height = isHub ? 15 : 14
        const top = label.y + label.radius + 5
        const box = {
          left: label.x - width / 2 - 2,
          right: label.x + width / 2 + 2,
          top,
          bottom: top + height
        }

        // What is being read, and what is selected, are never dropped — those are
        // the two cases where the name is the whole point. The node under examination is
        // the same case: an unnamed ring says the agent is busy somewhere, which is the
        // question rather than the answer.
        const mustShow =
          lit > 0 || label.id === selectedId || (agentBusy && liveIdsRef.current.has(label.id))
        if (!mustShow && !fits(box)) continue
        placed.push(box)

        // Labels follow their node, or the two read as unrelated — depth included. A far
        // node drawn small and dim with a full-strength name under it was the single thing
        // most fighting the depth cue: the text is the loudest mark on the canvas, so at
        // equal weight the names flattened the graph back out.
        ctx.globalAlpha =
          (dimming
            ? lit > 0 || label.id === selectedId
              ? 1
              : (weight ?? 0.25)
            : (prominence.get(label.id) ?? 1)) * label.fade
        ctx.fillStyle =
          lit > 0 ? theme.halo : inAttention || label.id === selectedId ? theme.label : theme.labelMuted

        ctx.fillText(text, label.x, top)
      }

      ctx.globalAlpha = 1
    }

    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [
    snapshot,
    nodeById,
    adjacency,
    selectedId,
    focusIds,
    focusRequest,
    pulses,
    prominence,
    projectAll,
    reduceMotion,
    settings.labelThreshold,
    settings.rotate
  ])

  /* --------------------------------------------------------- interaction */

  const localPoint = (event: React.PointerEvent | React.MouseEvent | React.WheelEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const point = localPoint(event)

    canvasRef.current?.setPointerCapture(event.pointerId)
    tweenRef.current.cancel()
    // Theirs now. Not just for this gesture: a restore that fought a pan the user had just
    // made would undo a deliberate act to reinstate an automatic one.
    if (autoFrameRef.current) autoFrameRef.current.ours = false

    // Shift, or the middle button, takes over the orbit. Both are additive: the left
    // button on its own still means what it always meant, so nothing a user already knows
    // how to do changes, and turning it by hand is something they find rather than
    // something they have to learn before they can pan.
    if (event.shiftKey || event.button === 1) {
      orbitRef.current = {
        x: point.x,
        y: point.y,
        yaw: cameraRef.current.yaw,
        pitch: cameraRef.current.pitch
      }
      return
    }

    const hit = hitTest(point.x, point.y)

    if (hit) {
      const i = indexRef.current.get(hit)
      const positions = posRef.current
      const view = viewRef.current
      const inRange = i !== undefined && i < viewCountRef.current
      dragRef.current = {
        id: hit,
        moved: false,
        origin: inRange
          ? {
              x: positions[i! * 3],
              y: positions[i! * 3 + 1],
              z: positions[i! * 3 + 2]
            }
          : { x: 0, y: 0, z: 0 },
        pointer: screenToWorld(cameraRef.current, viewportRef.current, point.x, point.y),
        k: inRange ? view[i! * 4 + 2] : 1
      }
    } else {
      panRef.current = {
        x: point.x,
        y: point.y,
        camX: cameraRef.current.x,
        camY: cameraRef.current.y
      }
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const point = localPoint(event)

    if (orbitRef.current) {
      const start = orbitRef.current
      cameraRef.current = {
        ...cameraRef.current,
        yaw: start.yaw + (point.x - start.x) * ORBIT_PER_PIXEL,
        // Inverted, so dragging down tips the top of the graph towards the viewer — the
        // direction the surface under the cursor appears to move with the pointer.
        pitch: clampPitch(start.pitch - (point.y - start.y) * ORBIT_PER_PIXEL)
      }
      needsDrawRef.current = true
      return
    }

    if (dragRef.current) {
      const drag = dragRef.current
      drag.moved = true

      const world = screenToWorld(cameraRef.current, viewportRef.current, point.x, point.y)
      // Divided by the perspective the node was picked up at, because the view-plane delta
      // the pointer travelled is the world delta *magnified* by it. The constraint that
      // the node stays at its own depth is what keeps k constant for the whole drag.
      const delta = unprojectDelta(
        (world.x - drag.pointer.x) / (drag.k || 1),
        (world.y - drag.pointer.y) / (drag.k || 1),
        cameraRef.current
      )

      workerRef.current?.postMessage({
        type: 'drag',
        id: drag.id,
        x: drag.origin.x + delta.x,
        y: drag.origin.y + delta.y,
        z: drag.origin.z + delta.z
      } satisfies WorkerRequest)
      return
    }

    if (panRef.current) {
      const scale = cameraRef.current.scale
      cameraRef.current = {
        ...cameraRef.current,
        x: panRef.current.camX - (point.x - panRef.current.x) / scale,
        y: panRef.current.camY - (point.y - panRef.current.y) / scale
      }
      needsDrawRef.current = true
      return
    }

    const hit = hitTest(point.x, point.y)
    if (hit !== hoverRef.current) {
      hoverRef.current = hit
      needsDrawRef.current = true
      onHover?.(hit)
      setHoverLabel(hit ? { id: hit, x: point.x, y: point.y } : null)
    } else if (hit && hoverLabel) {
      setHoverLabel({ id: hit, x: point.x, y: point.y })
    }
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    canvasRef.current?.releasePointerCapture(event.pointerId)

    if (orbitRef.current) {
      // Left where the user put it, and the slow turn picks up from there. Snapping back
      // to the resting angle would make orbiting feel like it had been undone.
      orbitRef.current = null
      lastFrameRef.current = 0
      return
    }

    if (dragRef.current) {
      const { id, moved } = dragRef.current
      dragRef.current = null

      // A drag parks the node where the user put it; a click just selects.
      workerRef.current?.postMessage({ type: 'release', id, pin: moved } satisfies WorkerRequest)
      if (!moved) onSelect(id)
      return
    }

    if (panRef.current) {
      const start = panRef.current
      panRef.current = null
      const point = localPoint(event)
      const travelled = Math.hypot(point.x - start.x, point.y - start.y)
      // Treat a stationary release on empty space as "deselect".
      if (travelled < 3) onSelect(null)
    }
  }

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    event.preventDefault()
    const point = localPoint(event)
    tweenRef.current.cancel()
    if (autoFrameRef.current) autoFrameRef.current.ours = false

    const factor = Math.pow(0.998, event.deltaY)
    cameraRef.current = zoomAt(cameraRef.current, viewportRef.current, point.x, point.y, factor)
    needsDrawRef.current = true
  }

  const handleDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const point = localPoint(event)
    const hit = hitTest(point.x, point.y)
    if (hit) {
      onOpen(hit)
      return
    }
    fitToContent()
  }

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    event.preventDefault()
    const point = localPoint(event)
    const hit = hitTest(point.x, point.y)
    if (!hit) {
      setMenu(null)
      return
    }

    onSelect(hit)
    setMenu({ x: point.x, y: point.y, id: hit })
  }

  const hovered = hoverLabel ? nodeById.get(hoverLabel.id) : null
  const menuNode = menu ? nodeById.get(menu.id) : null

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        style={{ cursor: dragRef.current ? 'grabbing' : hoverRef.current ? 'pointer' : 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />

      {hovered && hovered.tags.length > 0 && (
        <div
          className="pointer-events-none absolute z-10 max-w-64 rounded-md border border-border/70 bg-popover/95 px-2.5 py-1.5 text-xs shadow-lg backdrop-blur-sm"
          style={{
            // Offset from the cursor so the card never sits under the pointer.
            left: Math.min(hoverLabel!.x + 14, viewportRef.current.width - 260),
            top: Math.min(hoverLabel!.y + 14, viewportRef.current.height - 80)
          }}
        >
          <p className="truncate font-medium text-popover-foreground">{hovered.title}</p>
          <p className="mt-0.5 truncate text-muted-foreground">
            {hovered.tags.map((tag) => `#${tag}`).join(' ')}
          </p>
        </div>
      )}

      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="max-w-sm text-center">
            <p className="text-sm font-medium text-foreground">Nothing here yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Write a note, or ask the agent to start one. Every note becomes a node.
            </p>
          </div>
        </div>
      )}

      {!isEmpty && <GraphHint nodeCount={snapshot.nodes.length} />}
      {!isEmpty && <GraphLegend kinds={kindsPresent} />}

      {menu && menuNode && (
        <GraphContextMenu
          x={menu.x}
          y={menu.y}
          node={menuNode}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            switch (action) {
              case 'open':
                onOpen(menuNode.id)
                break
              case 'neighbourhood':
                onNodeAction?.('neighbourhood', menuNode)
                break
              case 'pin':
              case 'unpin':
                workerRef.current?.postMessage({
                  type: 'release',
                  id: menuNode.id,
                  pin: action === 'pin'
                } satisfies WorkerRequest)
                onNodeAction?.(action, menuNode)
                break
              default:
                onNodeAction?.(action, menuNode)
            }
          }}
        />
      )}

      <GraphControls onFit={() => fitToContent()} onZoom={(factor) => {
        tweenRef.current.cancel()
        cameraRef.current = zoomAt(
          cameraRef.current,
          viewportRef.current,
          viewportRef.current.width / 2,
          viewportRef.current.height / 2,
          factor
        )
        needsDrawRef.current = true
      }} />
    </div>
  )
}

function GraphControls({
  onFit,
  onZoom
}: {
  onFit: () => void
  onZoom: (factor: number) => void
}): React.JSX.Element {
  return (
    <div className="absolute bottom-4 right-4 flex flex-col gap-1 rounded-lg border border-border/60 bg-card/80 p-1 shadow-sm backdrop-blur-sm">
      <ControlButton label="Zoom in" onClick={() => onZoom(1.3)}>
        <Plus className="size-4" />
      </ControlButton>
      <ControlButton label="Zoom out" onClick={() => onZoom(1 / 1.3)}>
        <Minus className="size-4" />
      </ControlButton>
      <ControlButton label="Fit to view" onClick={onFit}>
        <Maximize className="size-4" />
      </ControlButton>
    </div>
  )
}

function ControlButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-[transform,color,background-color] duration-150 ease-[var(--ease-out)] hover:bg-accent hover:text-accent-foreground active:scale-[0.96]"
    >
      {children}
    </button>
  )
}

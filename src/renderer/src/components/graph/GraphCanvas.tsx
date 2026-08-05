import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import type { GraphSnapshot, NodeKind } from '@shared/types'
import {
  CameraTween,
  boundsOf,
  cameraForBounds,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Camera
} from './camera'
import { radiusForDegree, readGraphTheme, type GraphTheme } from './theme'
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
  onPositionsSettled?: (positions: { id: string; x: number; y: number }[]) => void
  focusRequest: FocusRequest | null
  /**
   * Node ids to pulse once. `change` was written; `probe` was read by the agent,
   * and `at` may be in the future so a sweep arrives one node at a time.
   */
  pulses: { id: string; at: number; kind: 'change' | 'probe' }[]
  /** Right-click menu actions the shell handles (ask, link, reveal, trash…). */
  onNodeAction?: (action: string, node: GraphSnapshot['nodes'][number]) => void
  settings: ForceSettings & { labelThreshold: number }
  reduceMotion: boolean
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
  reduceMotion
}: GraphCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const workerRef = useRef<Worker | null>(null)

  const positionsRef = useRef<Float32Array>(new Float32Array(0))
  const idsRef = useRef<string[]>([])
  const indexRef = useRef<Map<string, number>>(new Map())

  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 0.9 })
  const tweenRef = useRef(new CameraTween())
  const viewportRef = useRef({ width: 1, height: 1 })
  const dprRef = useRef(1)

  const hoverRef = useRef<string | null>(null)
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null)
  const panRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null)
  const themeRef = useRef<GraphTheme>(readGraphTheme())
  const needsDrawRef = useRef(true)
  const hasFramedRef = useRef(false)
  /** What the worker currently holds, for diffing the next snapshot against. */
  const previousRef = useRef<{ nodeIds: Set<string>; edgeKeys: Set<string> } | null>(null)

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

  const focusIds = useMemo(() => new Set(focusRequest?.ids ?? []), [focusRequest])

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

      positionsRef.current = message.positions
      needsDrawRef.current = true

      if (message.type === 'settled') {
        // Frame the graph the first time it settles, so the user never lands on
        // an off-screen or absurdly zoomed view.
        if (!hasFramedRef.current && idsRef.current.length > 0) {
          hasFramedRef.current = true
          fitToContent(false)
        }

        if (onPositionsSettled) {
          const out: { id: string; x: number; y: number }[] = []
          for (let i = 0; i < idsRef.current.length; i++) {
            out.push({
              id: idsRef.current[i],
              x: message.positions[i * 2],
              y: message.positions[i * 2 + 1]
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

    setIsEmpty(snapshot.nodes.length === 0)
    if (snapshot.nodes.length === 0) {
      positionsRef.current = new Float32Array(0)
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
      isTag: node.kind === 'tag'
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

    if (useDiff && diff) {
      worker.postMessage({ type: 'update', ...diff } satisfies WorkerRequest)
    } else if (churn > 0 || !previous) {
      hasFramedRef.current = previous !== null ? hasFramedRef.current : false
      worker.postMessage({
        type: 'init',
        nodes: snapshot.nodes.map(toNodeInput),
        edges: snapshot.edges.map(toEdgeInput),
        settings: { linkDistance: settings.linkDistance, charge: settings.charge },
        width: viewportRef.current.width,
        height: viewportRef.current.height
      } satisfies WorkerRequest)
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

  /* ---------------------------------------------------------------- camera */

  const fitToContent = useCallback((animate = true) => {
    const positions = positionsRef.current
    if (positions.length === 0) return

    const points: { x: number; y: number }[] = []
    for (let i = 0; i < positions.length; i += 2) {
      points.push({ x: positions[i], y: positions[i + 1] })
    }

    const bounds = boundsOf(points)
    if (!bounds) return

    const target = cameraForBounds(bounds, viewportRef.current)
    if (animate && !reduceMotion) tweenRef.current.start(cameraRef.current, target)
    else cameraRef.current = target
    needsDrawRef.current = true
  }, [reduceMotion])

  // Focus request from the agent or the UI.
  useEffect(() => {
    if (!focusRequest || focusRequest.ids.length === 0) return

    const positions = positionsRef.current
    const points: { x: number; y: number }[] = []
    for (const id of focusRequest.ids) {
      const index = indexRef.current.get(id)
      if (index === undefined) continue
      points.push({ x: positions[index * 2], y: positions[index * 2 + 1] })
    }

    const bounds = boundsOf(points)
    if (!bounds) return

    const target = cameraForBounds(bounds, viewportRef.current, 140, 1.5)
    if (reduceMotion) cameraRef.current = target
    else tweenRef.current.start(cameraRef.current, target, 520)
    needsDrawRef.current = true
  }, [focusRequest, reduceMotion])

  /* ------------------------------------------------------------- resize */

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const resize = (): void => {
      const rect = container.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)

      viewportRef.current = { width: rect.width, height: rect.height }
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
  }, [])

  /* --------------------------------------------------------- hit testing */

  const hitTest = useCallback(
    (sx: number, sy: number): string | null => {
      const positions = positionsRef.current
      const camera = cameraRef.current
      const viewport = viewportRef.current
      const world = screenToWorld(camera, viewport, sx, sy)

      // Generous in screen space so small nodes stay clickable when zoomed out.
      const slack = 6 / camera.scale
      let best: string | null = null
      let bestDistance = Infinity

      for (let i = 0; i < idsRef.current.length; i++) {
        const id = idsRef.current[i]
        const node = nodeById.get(id)
        if (!node) continue

        const dx = positions[i * 2] - world.x
        const dy = positions[i * 2 + 1] - world.y
        const distance = Math.sqrt(dx * dx + dy * dy)
        const radius = radiusForDegree(node.degree) + slack

        if (distance <= radius && distance < bestDistance) {
          best = id
          bestDistance = distance
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
      const tweened = tweenRef.current.sample(now)
      if (tweened) {
        cameraRef.current = tweened
        needsDrawRef.current = true
      }

      // `at` can be in the future: a staggered sweep schedules its tail ahead of
      // time, and the loop has to stay awake until the last one has finished.
      const hasLivePulse = !reduceMotion && pulses.some((pulse) => now < pulse.at + PULSE_MS)
      if (!needsDrawRef.current && !hasLivePulse) return
      needsDrawRef.current = false

      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return

      const theme = themeRef.current
      const camera = cameraRef.current
      const viewport = viewportRef.current
      const dpr = dprRef.current
      const positions = positionsRef.current

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, viewport.width, viewport.height)
      ctx.fillStyle = theme.background
      ctx.fillRect(0, 0, viewport.width, viewport.height)

      if (positions.length === 0) return

      // What the user is currently attending to: hover, selection, or an
      // agent-driven focus. Everything outside it is dimmed rather than hidden,
      // so context stays visible.
      const attention = new Set<string>()
      const primary = hoverRef.current ?? selectedId
      if (primary) {
        attention.add(primary)
        for (const neighbour of adjacency.get(primary) ?? []) attention.add(neighbour)
      }
      for (const id of focusIds) {
        attention.add(id)
        if (focusRequest && focusRequest.ids.length <= 12) {
          for (const neighbour of adjacency.get(id) ?? []) attention.add(neighbour)
        }
      }
      const dimming = attention.size > 0

      const index = indexRef.current
      const screenOf = (id: string): { x: number; y: number } | null => {
        const i = index.get(id)
        if (i === undefined) return null
        return worldToScreen(camera, viewport, positions[i * 2], positions[i * 2 + 1])
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
        style: { color: string; width: number; alpha: number; dash?: number[] }
      ): void => {
        ctx.beginPath()
        let any = false

        for (const edge of snapshot.edges) {
          const inAttention = attention.has(edge.src) && attention.has(edge.dst)
          if (!include(edge, inAttention)) continue

          const from = screenOf(edge.src)
          const to = screenOf(edge.dst)
          if (!from || !to) continue

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

      // Written links, the load-bearing ones.
      drawEdgePass(
        (edge, inAttention) =>
          !isTagEdge(edge) &&
          edge.kind !== 'similar' &&
          (dimming ? !inAttention : true),
        { color: theme.edge, width: 1, alpha: dimming ? 0.1 : 0.34 }
      )

      // The curator's guesses, dashed so they read as inferred rather than written.
      drawEdgePass(
        (edge, inAttention) =>
          edge.kind === 'similar' && !isTagEdge(edge) && (dimming ? !inAttention : true),
        { color: theme.edge, width: 1, alpha: dimming ? 0.06 : 0.2, dash: [2, 4] }
      )

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
          : { color: theme.edge, width: 1, alpha: 0.07, dash: [1, 5] }
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
          const base = radiusForDegree(node?.degree ?? 1) * camera.scale
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

      const labelCandidates: { id: string; x: number; y: number; degree: number; radius: number }[] = []

      for (let i = 0; i < idsRef.current.length; i++) {
        const id = idsRef.current[i]
        const node = nodeById.get(id)
        if (!node) continue

        const point = worldToScreen(camera, viewport, positions[i * 2], positions[i * 2 + 1])
        const radius = radiusForDegree(node.degree) * camera.scale

        if (
          point.x < -radius - 40 ||
          point.x > viewport.width + radius + 40 ||
          point.y < -radius - 40 ||
          point.y > viewport.height + radius + 40
        ) {
          continue
        }

        const lit = probing.get(id) ?? 0
        // Being read counts as attention, so a searched node keeps full opacity
        // even while an unrelated focus is dimming everything else.
        const inAttention = attention.has(id) || lit > 0
        // With nothing selected, weight by how well tagged it is; with something
        // selected, that reading is replaced by the harder in-or-out dimming.
        ctx.globalAlpha = dimming
          ? inAttention
            ? 1
            : 0.2
          : (prominence.get(id) ?? 1)

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
            ctx.globalAlpha = (dimming && !inAttention ? 0.2 : 1) * 0.1
            ctx.fill()
            ctx.globalAlpha = dimming && !inAttention ? 0.2 : 1
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
            ctx.globalAlpha = (dimming && !inAttention ? 0.2 : 1) * 0.5
            ctx.stroke()
            ctx.globalAlpha = dimming && !inAttention ? 0.2 : 1
          }
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
            degree: lit > 0 ? node.degree + 1000 : node.degree,
            radius
          })
        }
      }

      ctx.globalAlpha = 1

      /* ---------------------------------------------- labels ----------- */

      // Text is the most expensive thing on the canvas, so the best-connected
      // nodes win when there are more candidates than the budget allows.
      labelCandidates.sort((a, b) => b.degree - a.degree)
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
        const inAttention = attention.has(label.id) || lit > 0
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
        // the two cases where the name is the whole point.
        const mustShow = lit > 0 || label.id === selectedId
        if (!mustShow && !fits(box)) continue
        placed.push(box)

        // Labels follow their node, or the two read as unrelated.
        ctx.globalAlpha = dimming
          ? inAttention
            ? 1
            : 0.25
          : (prominence.get(label.id) ?? 1)
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
    reduceMotion,
    settings.labelThreshold
  ])

  /* --------------------------------------------------------- interaction */

  const localPoint = (event: React.PointerEvent | React.MouseEvent | React.WheelEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const point = localPoint(event)
    const hit = hitTest(point.x, point.y)

    canvasRef.current?.setPointerCapture(event.pointerId)
    tweenRef.current.cancel()

    if (hit) {
      dragRef.current = { id: hit, moved: false }
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

    if (dragRef.current) {
      dragRef.current.moved = true
      const world = screenToWorld(cameraRef.current, viewportRef.current, point.x, point.y)
      workerRef.current?.postMessage({
        type: 'drag',
        id: dragRef.current.id,
        x: world.x,
        y: world.y
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
      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-[transform,color,background-color] duration-150 ease-[var(--ease-out)] hover:bg-accent hover:text-accent-foreground active:scale-[0.94]"
    >
      {children}
    </button>
  )
}

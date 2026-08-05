/**
 * Types for `d3-force-3d`, which ships none.
 *
 * The package is `d3-force` with a third dimension: the same force names, the same node
 * and link mutation, plus `forceZ` and a dimension count as the second argument to
 * `forceSimulation`. So rather than restate the whole API, this re-exports `d3-force`'s
 * own types and narrows only what actually differs — which also means a `d3-force`
 * upgrade keeps these honest instead of letting them drift.
 *
 * Written by hand because `@types/d3-force-3d` does not exist on npm.
 */
declare module 'd3-force-3d' {
  import type {
    Force,
    ForceCenter,
    ForceCollide,
    ForceLink,
    ForceManyBody,
    ForceRadial,
    ForceX,
    ForceY,
    Simulation,
    SimulationLinkDatum,
    SimulationNodeDatum
  } from 'd3-force'

  /** A node laid out in three dimensions. `z` is absent until the first tick. */
  export interface SimulationNodeDatum3D extends SimulationNodeDatum {
    z?: number | undefined
    vz?: number | undefined
  }

  /**
   * `numDimensions` is the whole reason this package exists: 1, 2 or 3. It defaults to
   * 2, which would silently give a flat layout — so always pass it.
   */
  export function forceSimulation<
    NodeDatum extends SimulationNodeDatum3D,
    LinkDatum extends SimulationLinkDatum<NodeDatum> | undefined = undefined
  >(nodes?: NodeDatum[], numDimensions?: number): Simulation<NodeDatum, LinkDatum>

  export function forceCenter<NodeDatum extends SimulationNodeDatum3D>(
    x?: number,
    y?: number,
    z?: number
  ): ForceCenter<NodeDatum>

  export function forceManyBody<
    NodeDatum extends SimulationNodeDatum3D
  >(): ForceManyBody<NodeDatum>

  export function forceLink<
    NodeDatum extends SimulationNodeDatum3D,
    LinkDatum extends SimulationLinkDatum<NodeDatum>
  >(links?: LinkDatum[]): ForceLink<NodeDatum, LinkDatum>

  export function forceCollide<
    NodeDatum extends SimulationNodeDatum3D
  >(radius?: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)): ForceCollide<NodeDatum>

  export function forceRadial<NodeDatum extends SimulationNodeDatum3D>(
    radius: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number),
    x?: number,
    y?: number,
    z?: number
  ): ForceRadial<NodeDatum>

  export function forceX<NodeDatum extends SimulationNodeDatum3D>(
    x?: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)
  ): ForceX<NodeDatum>

  export function forceY<NodeDatum extends SimulationNodeDatum3D>(
    y?: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)
  ): ForceY<NodeDatum>

  /** The one force `d3-force` has no equivalent of. */
  export interface ForceZ<NodeDatum extends SimulationNodeDatum3D> extends Force<NodeDatum, undefined> {
    strength(): (node: NodeDatum, i: number, nodes: NodeDatum[]) => number
    strength(strength: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)): this
    z(): (node: NodeDatum, i: number, nodes: NodeDatum[]) => number
    z(z: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)): this
  }

  export function forceZ<NodeDatum extends SimulationNodeDatum3D>(
    z?: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)
  ): ForceZ<NodeDatum>
}

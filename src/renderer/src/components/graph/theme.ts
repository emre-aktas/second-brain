import type { NodeKind } from '@shared/types'
import { NODE_KINDS } from '@shared/node-kinds'

/**
 * Canvas cannot read `var(--token)`, so the design tokens are resolved to
 * concrete colour strings once and re-read when the theme changes. Alpha is
 * applied with `globalAlpha` rather than baked into the colour, which keeps this
 * working regardless of whether the token is oklch, hex or anything else.
 */

export interface GraphTheme {
  background: string
  edge: string
  edgeStrong: string
  label: string
  labelMuted: string
  halo: string
  selection: string
  kinds: Record<NodeKind, string>
  /** True when the resolved background is dark, used to pick blend modes. */
  dark: boolean
}

/**
 * Derived from the kind table, so a new kind cannot arrive without a colour.
 *
 * Stubs are drawn as outlines rather than filled, so theirs is only a stroke; they
 * are not in the table because nothing creates them any more.
 */
const KIND_TOKENS: Record<NodeKind, string> = {
  ...(Object.fromEntries(NODE_KINDS.map((spec) => [spec.id, spec.token])) as Record<
    NodeKind,
    string
  >),
  stub: '--muted-foreground'
}

function readVar(styles: CSSStyleDeclaration, token: string, fallback: string): string {
  const value = styles.getPropertyValue(token).trim()
  return value || fallback
}

export function readGraphTheme(): GraphTheme {
  const styles = getComputedStyle(document.documentElement)
  const dark = document.documentElement.classList.contains('dark')

  const kinds = Object.fromEntries(
    Object.entries(KIND_TOKENS).map(([kind, token]) => [
      kind,
      readVar(styles, token, dark ? '#8b8bf0' : '#5b5bd6')
    ])
  ) as Record<NodeKind, string>

  return {
    background: readVar(styles, '--graph-bg', dark ? '#14141c' : '#f8f8fb'),
    edge: readVar(styles, '--graph-edge', dark ? '#4a4a5a' : '#b8b8c4'),
    edgeStrong: readVar(styles, '--graph-edge-strong', dark ? '#8b8bf0' : '#5b5bd6'),
    label: readVar(styles, '--graph-label', dark ? '#c4c4d0' : '#4a4a54'),
    labelMuted: readVar(styles, '--muted-foreground', dark ? '#8a8a98' : '#6a6a76'),
    halo: readVar(styles, '--graph-halo', dark ? '#8b8bf0' : '#5b5bd6'),
    selection: readVar(styles, '--ring', dark ? '#8b8bf0' : '#5b5bd6'),
    kinds,
    dark
  }
}

/** Verify the browser can actually paint a resolved token colour. */
export function canvasSupportsColor(color: string): boolean {
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.fillStyle = '#000000'
    ctx.fillStyle = color
    // A rejected colour leaves fillStyle at the previous value.
    return ctx.fillStyle !== '#000000'
  } catch {
    return false
  }
}

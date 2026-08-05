/**
 * Dot-path access into a tool's document.
 *
 * A canvas tool has no fixed shape: the agent decides what the document holds and
 * binds each element of the interface to a path in it. The renderer reads and
 * writes those paths, the main process fills action prompts from them, and results
 * are written back to them — so all three sides share these functions rather than
 * each carrying its own slightly different traversal.
 */

export function readPath(state: Record<string, unknown>, path: string): unknown {
  let current: unknown = state
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Immutable set, creating intermediate objects as needed. */
export function writePath(
  state: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const segments = path.split('.')
  const root: Record<string, unknown> = { ...state }

  let cursor = root
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]
    const next = cursor[key]
    cursor[key] = next && typeof next === 'object' && !Array.isArray(next) ? { ...next } : {}
    cursor = cursor[key] as Record<string, unknown>
  }

  cursor[segments[segments.length - 1]] = value
  return root
}

export const asText = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value)

/** The placeholder form used in labels, titles and action prompts. */
export const PLACEHOLDER = /\{\{([a-zA-Z0-9_.-]+)\}\}/g

/** Substitutes {{path}} from the document. Unknown paths become empty strings. */
export function interpolate(template: string, state: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => asText(readPath(state, path)))
}

/** Every path a template reads, in order of first appearance. */
export function placeholderPaths(template: string): string[] {
  const found: string[] = []
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!found.includes(match[1])) found.push(match[1])
  }
  return found
}

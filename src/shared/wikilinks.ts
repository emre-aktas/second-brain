import type { Root, PhrasingContent, Text } from 'mdast'

/**
 * Where a wikilink points, before anything has been resolved.
 *
 * Not a real URL: the renderer intercepts it in its own `a` component and never lets
 * the browser see it. The scheme is unusual on purpose, so nothing else can mistake it
 * for a link to follow.
 */
export const NODE_LINK_PREFIX = '#node/'

/** The target of a wikilink, or null if this href is an ordinary link. */
export function wikiLinkTarget(href: string | undefined): string | null {
  if (!href || !href.startsWith(NODE_LINK_PREFIX)) return null
  const raw = href.slice(NODE_LINK_PREFIX.length)
  try {
    return decodeURIComponent(raw) || null
  } catch {
    // A malformed escape is still a title someone typed; better a lookup that fails
    // than a link that throws while rendering the transcript.
    return raw || null
  }
}

const WIKILINK = /\[\[([^\][|]+?)(?:\|([^\][]+?))?\]\]/g

/**
 * Turn `[[Note title]]` in prose into a link the renderer can open.
 *
 * Done as a remark plugin over the parsed tree rather than as a string rewrite before
 * parsing, which is what makes it safe. Working on `text` nodes means:
 *
 * - Code is untouched for free. Fenced blocks and inline code parse to `code` and
 *   `inlineCode` nodes, which this never visits — no fence-skipping regex to keep in
 *   step with the three fence styles the vault parser knows about.
 * - No escaping to get wrong. A title containing `)`, `*` or a backslash would break a
 *   hand-built `[label](url)` string; here the label and the destination are separate
 *   fields of a node, so there is nothing to escape.
 * - An existing link's text is left alone, because `[[…]]` inside one is already inside
 *   a `link` node's children and replacing it would nest links.
 *
 * The app has promised this for a while — the Generated UI schema and the agent's own
 * system prompt both say wikilinks in prose become node links — and nothing in the
 * renderer had ever implemented it.
 */
export function remarkWikiLinks() {
  return (tree: Root): void => {
    visit(tree)
  }
}

/** Depth-first, replacing text children in place. */
function visit(node: { children?: unknown[]; type?: string }): void {
  const children = node.children as PhrasingContent[] | undefined
  if (!Array.isArray(children)) return

  // Never inside a link: the result would be a link within a link.
  if (node.type === 'link' || node.type === 'linkReference') return

  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'text') {
      const replacement = split(child)
      if (replacement) {
        children.splice(i, 1, ...replacement)
        // Skip what was just inserted; none of it needs visiting again.
        i += replacement.length - 1
      }
      continue
    }
    visit(child as { children?: unknown[]; type?: string })
  }
}

/** One text node into a run of text and link nodes, or null when there is no link. */
function split(node: Text): PhrasingContent[] | null {
  const value = node.value
  WIKILINK.lastIndex = 0
  if (!WIKILINK.test(value)) return null
  WIKILINK.lastIndex = 0

  const out: PhrasingContent[] = []
  let at = 0

  for (let match = WIKILINK.exec(value); match !== null; match = WIKILINK.exec(value)) {
    const [whole, target, alias] = match
    const title = target.trim()
    if (!title) continue

    if (match.index > at) out.push({ type: 'text', value: value.slice(at, match.index) })

    out.push({
      type: 'link',
      url: `${NODE_LINK_PREFIX}${encodeURIComponent(title)}`,
      // `[[Title|what to show]]`, the same alias syntax the vault's own parser accepts.
      children: [{ type: 'text', value: (alias ?? target).trim() }]
    })

    at = match.index + whole.length
  }

  if (at < value.length) out.push({ type: 'text', value: value.slice(at) })
  return out.length > 0 ? out : null
}

import { useCallback } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { NODE_LINK_PREFIX, remarkWikiLinks, wikiLinkTarget } from '@/lib/wikilinks'

const PLUGINS = [remarkGfm, remarkWikiLinks]

/**
 * Agent prose, with `[[Wikilinks]]` as links that open the note.
 *
 * One component for every surface that renders what the agent wrote, because there are
 * seven of them and a wikilink should behave the same in all seven. Resolution happens
 * on click, through `node:get`, which resolves an id, a path or a title in the main
 * process — including the fold that makes Turkish titles match and the tie-break that
 * prefers a written note over an unwritten stub. Doing it there rather than against the
 * graph snapshot in the renderer means there is one implementation of "which note is
 * this?" instead of two that can disagree.
 *
 * `onOpenNode` is optional. A popped-out tool window renders the same markdown with no
 * store behind it, and there a wikilink is just text.
 */
export function NodeProse({
  children,
  className,
  onOpenNode,
  inline = false
}: {
  children: string
  className?: string
  onOpenNode?: (id: string) => void
  /** Strip block structure, for a single line inside a card. */
  inline?: boolean
}): React.JSX.Element {
  const open = useCallback(
    async (title: string) => {
      if (!onOpenNode) return
      const node = await api.getNode(title)
      // A link to a note nobody has written yet is a real thing in this app — it shows
      // up as a hollow node in the graph — so a miss is not an error worth shouting
      // about. It simply does not go anywhere yet.
      if (node) onOpenNode(node.id)
    },
    [onOpenNode]
  )

  const components = {
    a: ({
      href,
      children: label,
      ...rest
    }: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.JSX.Element => {
      const target = wikiLinkTarget(href)
      if (target === null) {
        // An ordinary link. `will-navigate` in main sends these to the real browser.
        return (
          <a href={href} {...rest}>
            {label}
          </a>
        )
      }

      if (!onOpenNode) return <span>{label}</span>

      return (
        <button
          type="button"
          onClick={() => void open(target)}
          title={`Open “${target}”`}
          className={cn(
            'inline text-left font-medium text-primary underline decoration-primary/30',
            'underline-offset-2 transition-colors duration-150 hover:decoration-primary'
          )}
        >
          {label}
        </button>
      )
    }
  }

  if (inline) {
    return (
      <Markdown
        remarkPlugins={PLUGINS}
        components={components}
        allowedElements={['p', 'em', 'strong', 'code', 'a', 'del', 'span', 'button']}
        unwrapDisallowed
      >
        {children}
      </Markdown>
    )
  }

  return (
    <div className={className}>
      <Markdown remarkPlugins={PLUGINS} components={components}>
        {children}
      </Markdown>
    </div>
  )
}

export { NODE_LINK_PREFIX }

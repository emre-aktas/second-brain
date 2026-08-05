import { useEffect, useRef, useState } from 'react'
import {
  Building2,
  Calendar,
  Check,
  CircleHelp,
  Ellipsis,
  ExternalLink,
  FileText,
  Flag,
  FolderOpen,
  Hash,
  Layers,
  Lightbulb,
  Link,
  Link2,
  MessageCircleQuestion,
  Pin,
  PinOff,
  Plug,
  Scale,
  Scan,
  ScrollText,
  Target,
  Trash2,
  User,
  Users,
  type LucideIcon
} from 'lucide-react'
import type { GraphNodeLite, NodeKind } from '@shared/types'
import { kindFamilies } from '@shared/node-kinds'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/base'
import { Tooltip } from '@/components/ui/tooltip'
import { modifierLabel } from '@/lib/chrome'

/**
 * The legend's own icons.
 *
 * A curated map for the same reason `TOOL_ICONS` is one: resolving a lucide name
 * dynamically means importing the whole set, which costs about a megabyte. The
 * canvas draws from generated path data; this is React, so it needs components.
 */
const KIND_ICONS: Partial<Record<NodeKind, LucideIcon>> = {
  note: FileText,
  idea: Lightbulb,
  question: CircleHelp,
  source: Link,
  tag: Hash,
  area: Layers,
  project: Target,
  goal: Flag,
  person: User,
  org: Building2,
  task: Check,
  decision: Scale,
  event: Calendar,
  meeting: Users,
  log: ScrollText,
  integration: Plug
}

/**
 * The things that make the canvas usable rather than merely pretty: what the
 * colours mean, what you can do to a node, and — the first time — what the screen
 * is for at all.
 */

/**
 * What the circles mean.
 *
 * Grouped by colour family rather than listed flat: with sixteen kinds a flat list
 * is a wall nobody reads, and the grouping is the actual rule — colour tells you the
 * family, the glyph tells you which kind. Only kinds present in the graph are shown,
 * so an empty vault does not open onto a taxonomy lesson.
 */
export function GraphLegend({ kinds }: { kinds: NodeKind[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const families = kindFamilies(kinds)
  if (families.length === 0) return null

  return (
    <div className="absolute bottom-4 left-4">
      {open ? (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-border/60 bg-card/85 p-2.5 shadow-sm backdrop-blur-sm">
          <div className="mb-2 flex items-center justify-between gap-4">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              Legend
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              Hide
            </button>
          </div>

          {/* Two columns once it would otherwise run down half the canvas. With
              every kind present that is 16 entries, and a legend that hides the
              graph is not helping. */}
          <div
            className={cn(
              'gap-x-5 gap-y-2',
              families.flatMap((group) => group.kinds).length > 8
                ? 'columns-2 [&>div]:break-inside-avoid'
                : 'flex flex-col'
            )}
          >
            {families.map((group) => (
              <div key={group.family} className="mb-2">
                <p className="mb-1 text-[10.5px] tracking-wide text-muted-foreground/70">
                  {group.family}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {group.kinds.map((spec) => {
                    const Icon = KIND_ICONS[spec.id]
                    return (
                      <li key={spec.id}>
                        <Tooltip content={spec.hint}>
                          <span className="flex items-center gap-1.5 text-[12px] text-foreground">
                            <span
                              className="grid size-4 shrink-0 place-items-center rounded-full"
                              style={{ background: `var(${spec.token})` }}
                              aria-hidden="true"
                            >
                              {Icon && (
                                <Icon
                                  className="size-2.5"
                                  style={{ color: 'var(--graph-bg)' }}
                                  strokeWidth={2.4}
                                />
                              )}
                            </span>
                            {spec.label}
                          </span>
                        </Tooltip>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>

          <p className="mt-2 max-w-56 border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground text-pretty">
            Colour is the family, the glyph is the kind. Bigger circles are better
            connected, fainter ones are less filed. Drag a node to park it;
            double-click to open it.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-border/60 bg-card/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm transition-[background-color,color] duration-150 hover:text-foreground"
        >
          Legend
        </button>
      )}
    </div>
  )
}

/* ---------------------------------------------------------- context menu */

export interface GraphMenuAction {
  id: string
  label: string
  icon: React.ReactNode
  destructive?: boolean
}

export function GraphContextMenu({
  x,
  y,
  node,
  onAction,
  onClose
}: {
  x: number
  y: number
  node: GraphNodeLite
  onAction: (action: string) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const isNote = node.kind !== 'tag'

  const actions: GraphMenuAction[] = [
    { id: 'open', label: 'Open', icon: <ExternalLink /> },
    { id: 'neighbourhood', label: 'Focus its connections', icon: <Scan /> },
    { id: 'ask', label: 'Ask the agent about this', icon: <MessageCircleQuestion /> },
    { id: 'link', label: 'Connect to…', icon: <Link2 /> },
    node.pinned
      ? { id: 'unpin', label: 'Unpin from position', icon: <PinOff /> }
      : { id: 'pin', label: 'Pin in place', icon: <Pin /> },
    ...(isNote
      ? [
          { id: 'reveal', label: 'Show the file', icon: <FolderOpen /> },
          { id: 'trash', label: 'Move to trash', icon: <Trash2 />, destructive: true }
        ]
      : [])
  ]

  return (
    <div
      ref={ref}
      role="menu"
      // Clamped so the menu never opens off the edge of the canvas.
      style={{ left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 260) }}
      className="absolute z-30 w-56 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-xl"
    >
      <p className="truncate px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
        {node.title}
      </p>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          onClick={() => {
            onAction(action.id)
            onClose()
          }}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]',
            'transition-colors duration-150',
            action.destructive
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-foreground hover:bg-accent hover:text-accent-foreground',
            '[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'
          )}
        >
          {action.icon}
          {action.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------- first run */

const HINT_KEY = 'second-brain.graph-hint-dismissed'

export function GraphHint({ nodeCount }: { nodeCount: number }): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(HINT_KEY) === '1')

  // Only worth showing once there is something on screen to point at.
  if (dismissed || nodeCount === 0) return null

  return (
    <div className="absolute left-4 top-4 max-w-sm rounded-lg border border-border/70 bg-card/90 p-3 shadow-sm backdrop-blur-sm">
      <p className="text-[13px] font-semibold text-foreground">This is your brain</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground text-pretty">
        Every note is a circle; every connection is a line. Nothing here needs
        arranging — it lays itself out.
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-[12px] text-muted-foreground">
        <li>
          <span className="text-foreground">Click</span> a node to select it,{' '}
          <span className="text-foreground">double-click</span> to open it
        </li>
        <li>
          <span className="text-foreground">Right-click</span> for actions
        </li>
        <li>
          <span className="text-foreground">Drag</span> to park a node, scroll to zoom
        </li>
        <li>
          <Kbd>{modifierLabel()}</Kbd> <Kbd>K</Kbd> to search, or just ask the agent on the right
        </li>
      </ul>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(HINT_KEY, '1')
          setDismissed(true)
        }}
        className="mt-2.5 text-[11px] font-medium text-primary transition-opacity duration-150 hover:opacity-80"
      >
        Got it
      </button>
    </div>
  )
}

export function GraphKindsPresent(nodes: GraphNodeLite[]): NodeKind[] {
  const kinds = new Set<NodeKind>()
  for (const node of nodes) kinds.add(node.kind)
  return [...kinds]
}

export { Ellipsis }

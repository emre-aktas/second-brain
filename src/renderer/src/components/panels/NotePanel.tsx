import { useEffect, useState } from 'react'
import { NodeProse } from '@/components/NodeProse'
import { ArrowLeft, ArrowRight, Crosshair, FolderOpen, Hourglass } from 'lucide-react'
import type { BrainEdge, BrainNode, GraphNodeLite } from '@shared/types'
import { api, errorMessage } from '@/lib/api'
import { useApp } from '@/store/app'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Badge, EmptyState, Separator, Spinner } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { toast } from '@/components/ui/sonner'
import { modifierLabel } from '@/lib/chrome'

export function NotePanel(): React.JSX.Element {
  const selectedId = useApp((s) => s.selectedNodeId)
  const openNode = useApp((s) => s.openNode)
  const goBackNode = useApp((s) => s.goBackNode)
  const trail = useApp((s) => s.nodeTrail)
  const cameFrom = useApp((s) => {
    const previous = s.nodeTrail.at(-1)
    if (!previous) return null
    return s.graph.nodes.find((candidate) => candidate.id === previous)?.title ?? null
  })
  const focusNodes = useApp((s) => s.focusNodes)
  const refreshGraph = useApp((s) => s.refreshGraph)
  const graphNodes = useApp((s) => s.graph.nodes)

  const [node, setNode] = useState<BrainNode | null>(null)
  const [edges, setEdges] = useState<BrainEdge[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!selectedId) {
      setNode(null)
      setEdges([])
      return
    }

    let cancelled = false
    setLoading(true)
    setEditing(false)

    void (async () => {
      try {
        const [loaded, loadedEdges] = await Promise.all([
          api.getNode(selectedId),
          api.getNodeEdges(selectedId)
        ])
        if (cancelled) return
        setNode(loaded)
        setEdges(loadedEdges)
        setDraft(loaded?.body ?? '')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedId])

  if (!selectedId) {
    return (
      <EmptyState
        title="No note selected"
        description={`Click a node in the graph, or search with ${modifierLabel()}+K.`}
      />
    )
  }

  if (loading && !node) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  if (!node) {
    return <EmptyState title="That note no longer exists" />
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const updated = await api.updateNote({ ref: node.id, body: draft, mode: 'replace' })
      setNode(updated)
      setEditing(false)
      await refreshGraph()
      toast.success('Saved')
    } catch (err) {
      toast.error('Could not save', { description: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const related = edges
    .map((edge) => {
      const otherId = edge.src === node.id ? edge.dst : edge.src
      return { edge, other: graphNodes.find((candidate) => candidate.id === otherId) }
    })
    .filter((entry): entry is { edge: BrainEdge; other: GraphNodeLite } => entry.other !== undefined)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          {trail.length > 0 && (
            // Named, not a bare arrow. "Back" tells you a direction; "Back to the brief"
            // tells you where you will land, which is the question after three links.
            <Tooltip content={cameFrom ? `Back to ${cameFrom}` : 'Back'}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={cameFrom ? `Back to ${cameFrom}` : 'Back'}
                className="-ml-1 mt-px shrink-0"
                onClick={goBackNode}
              >
                <ArrowLeft className="size-4" />
              </Button>
            </Tooltip>
          )}

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">{node.title}</h2>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Badge tone="outline" className="px-1.5 py-0">
                {node.kind}
              </Badge>
              <span>{formatRelativeTime(node.updatedAt)}</span>
              <span className="tabular-nums">{node.degree} links</span>
              {/* Said out loud, because a note quietly scheduled to disappear is
                  the sort of surprise that costs trust. Pinning it cancels it. */}
              {node.expiresAt !== null && (
                <Tooltip
                  content={
                    node.pinned
                      ? 'This was temporary, but pinning keeps it.'
                      : 'Moves to the trash then. Pin it to keep it.'
                  }
                >
                  <span
                    className={cn(
                      'inline-flex items-center gap-1',
                      node.pinned
                        ? 'text-muted-foreground line-through'
                        : node.expiresAt <= Date.now()
                          ? 'text-warning'
                          : 'text-muted-foreground'
                    )}
                  >
                    <Hourglass className="size-3" />
                    {node.expiresAt <= Date.now()
                      ? 'due to be retired'
                      : `keeps until ${new Date(node.expiresAt).toLocaleDateString()}`}
                  </span>
                </Tooltip>
              )}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Tooltip content="Centre the graph here">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Focus in graph"
                onClick={() => focusNodes([node.id], node.title)}
              >
                <Crosshair className="size-4" />
              </Button>
            </Tooltip>

            {node.path && (
              <Tooltip content="Show the file on disk">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reveal file"
                  onClick={() => void api.revealNote(node.id).catch(() => undefined)}
                >
                  <FolderOpen className="size-4" />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>

        {node.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {node.tags.map((tag) => (
              <Badge key={tag} tone="outline">
                #{tag}
              </Badge>
            ))}
          </div>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 py-3">
          {editing ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-72 font-mono text-[12.5px]"
                spellCheck
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void save()} disabled={saving}>
                  {saving ? <Spinner className="size-3.5" /> : null}
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(node.body)
                    setEditing(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : node.path ? (
            <>
              <div className="genui-prose selectable text-[13.5px] leading-relaxed text-foreground">
                <NodeProse onOpenNode={openNode}>
                  {node.body || '*This note is empty.*'}
                </NodeProse>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setDraft(node.body)
                  setEditing(true)
                }}
              >
                Edit
              </Button>
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground text-pretty">
              {node.kind === 'stub'
                ? 'Nothing has been written here yet. Something links to this title, so it shows in the graph as a hollow node — ask the agent to write it, or create it yourself.'
                : `This is a ${node.kind}, not a file. It exists to connect the notes below.`}
            </p>
          )}

          {related.length > 0 && (
            <>
              <Separator className="my-4" />
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Connected
              </h3>
              <ul className="flex flex-col gap-1">
                {related.map(({ edge, other }) => (
                  <li key={edge.id}>
                    <button
                      type="button"
                      onClick={() => openNode(other.id)}
                      className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-[background-color,transform] duration-150 ease-[var(--ease-out)] hover:bg-accent active:scale-[0.96]"
                    >
                      {edge.src === node.id ? (
                        <ArrowRight className="mt-1 size-3 shrink-0 text-muted-foreground/70" />
                      ) : (
                        <ArrowLeft className="mt-1 size-3 shrink-0 text-muted-foreground/70" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {other.title}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{edge.kind}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

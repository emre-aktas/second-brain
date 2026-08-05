import { FileText, Plus, Trash2, Pencil } from 'lucide-react'
import type { ChatBlock } from '@shared/types'
import { cn } from '@/lib/utils'

/** The brain tools that leave a note the user might want to open. */
const WRITING_TOOLS: Record<string, 'created' | 'changed' | 'trashed'> = {
  mcp__brain__create_note: 'created',
  mcp__brain__update_note: 'changed',
  mcp__brain__trash_note: 'trashed'
}

interface Touched {
  id: string
  title: string
  what: 'created' | 'changed' | 'trashed'
}

/**
 * Notes this turn wrote, as something clickable.
 *
 * Derived from the turn's own tool calls rather than from anything the agent chose to
 * say. That is the whole point: the model is unreliable about mentioning what it did, and
 * `create_note` already hands back the new note's id and title in its result — which the
 * renderer already has, because tool results are persisted on the turn. So this works
 * without the agent cooperating at all.
 *
 * Anything the agent *did* name in prose is dropped, because a wikilink in the reply is
 * already a link now. Otherwise a well-behaved turn reports itself twice: once in the
 * sentence, once again in a strip underneath it.
 */
export function touchedNotes(blocks: ChatBlock[], saidIn: string): Touched[] {
  const spoken = new Set(
    // Every [[Title]] the agent wrote in this turn, folded loosely — this only has to be
    // good enough to notice that a title was mentioned, not to resolve it.
    [...saidIn.matchAll(/\[\[([^\][|]+?)(?:\|[^\][]+?)?\]\]/g)].map((m) =>
      m[1].trim().toLocaleLowerCase()
    )
  )

  const byId = new Map<string, Touched>()

  for (const block of blocks) {
    if (block.type !== 'tool' || block.status !== 'ok' || !block.result) continue
    const what = WRITING_TOOLS[block.name]
    if (!what) continue

    // `describeNode` in the tool host writes these as "id: …" and "title: …" lines.
    const id = /^id:\s*(\S+)$/m.exec(block.result)?.[1]
    const title = /^title:\s*(.+)$/m.exec(block.result)?.[1]?.trim()
    if (!id || !title) continue
    if (spoken.has(title.toLocaleLowerCase())) continue

    // A note created and then edited in one turn reads as created.
    const existing = byId.get(id)
    if (existing && existing.what === 'created') continue
    byId.set(id, { id, title, what })
  }

  return [...byId.values()]
}

const LABEL: Record<Touched['what'], string> = {
  created: 'new',
  changed: 'updated',
  trashed: 'trashed'
}

const ICON: Record<Touched['what'], typeof FileText> = {
  created: Plus,
  changed: Pencil,
  trashed: Trash2
}

export function TouchedNotes({
  notes,
  onOpenNode
}: {
  notes: Touched[]
  onOpenNode: (id: string) => void
}): React.JSX.Element | null {
  if (notes.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {notes.map((note) => {
        const Icon = ICON[note.what]
        const gone = note.what === 'trashed'
        return (
          <button
            key={`${note.id}-${note.what}`}
            type="button"
            // Trashed notes still resolve — they move to .trash rather than being
            // deleted — so this stays clickable rather than becoming dead text.
            onClick={() => onOpenNode(note.id)}
            aria-label={`Open ${note.title} (${LABEL[note.what]})`}
            className={cn(
              'group flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1',
              'text-[11.5px] transition-[background-color,border-color,transform] duration-150',
              'ease-[var(--ease-out)] active:scale-[0.97]',
              gone
                ? 'border-border bg-secondary/30 text-muted-foreground hover:border-destructive/40'
                : 'border-primary/25 bg-primary/8 text-foreground hover:border-primary/50'
            )}
          >
            <Icon className={cn('size-3 shrink-0', gone ? 'text-muted-foreground' : 'text-primary')} />
            <span className={cn('truncate', gone && 'line-through')}>{note.title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{LABEL[note.what]}</span>
          </button>
        )
      })}
    </div>
  )
}

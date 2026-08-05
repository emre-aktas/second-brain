import { useEffect, useRef, useState } from 'react'
import { GripVertical, Plus, Trash2, X } from 'lucide-react'
import type {
  ChecklistState,
  KanbanCard,
  KanbanState,
  NotepadState,
  TableState
} from '@shared/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'

/**
 * Editable surfaces for interactive tools.
 *
 * Every change goes straight through `onChange`, which persists the whole
 * document. The agent writes the same document, so these are genuinely two hands
 * on one thing rather than a read-only view with an edit mode.
 *
 * Ids are preserved across edits on purpose: the agent is told to keep them, so a
 * card the user moved does not get recreated somewhere else when the agent
 * rewrites the board.
 */

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

/* ------------------------------------------------------------------ kanban */

export function KanbanSurface({
  state,
  onChange
}: {
  state: KanbanState
  onChange: (next: KanbanState) => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState<{ cardId: string; fromColumn: string } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const columns = state.columns ?? []

  const update = (mutate: (draft: KanbanState) => void): void => {
    const draft: KanbanState = JSON.parse(JSON.stringify(state))
    mutate(draft)
    onChange(draft)
  }

  const moveCard = (cardId: string, fromColumnId: string, toColumnId: string, toIndex?: number): void => {
    if (fromColumnId === toColumnId && toIndex === undefined) return

    update((draft) => {
      const from = draft.columns.find((column) => column.id === fromColumnId)
      const to = draft.columns.find((column) => column.id === toColumnId)
      if (!from || !to) return

      const index = from.cards.findIndex((card) => card.id === cardId)
      if (index < 0) return

      const [card] = from.cards.splice(index, 1)
      to.cards.splice(toIndex ?? to.cards.length, 0, card)
    })
  }

  return (
    <div className="flex h-full gap-3 overflow-x-auto pb-2">
      {columns.map((column) => (
        <div
          key={column.id}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => {
            if (dragging) moveCard(dragging.cardId, dragging.fromColumn, column.id)
            setDragging(null)
          }}
          className={cn(
            'flex min-h-0 w-72 shrink-0 flex-col rounded-lg border border-border bg-secondary/25',
            dragging && dragging.fromColumn !== column.id && 'border-primary/40 bg-primary/5'
          )}
        >
          <div className="flex items-center gap-2 px-2.5 py-2">
            <input
              value={column.title}
              onChange={(event) =>
                update((draft) => {
                  const target = draft.columns.find((c) => c.id === column.id)
                  if (target) target.title = event.target.value
                })
              }
              // Not uppercased: CSS uppercasing turns Turkish "Bitti" into
              // "BITTI", losing the dotted İ.
              className="min-w-0 flex-1 rounded bg-transparent px-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground focus-visible:text-foreground focus-visible:outline-offset-1"
            />
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {column.cards.length}
            </span>
            <button
              type="button"
              aria-label={`Delete ${column.title}`}
              onClick={() =>
                update((draft) => {
                  draft.columns = draft.columns.filter((c) => c.id !== column.id)
                })
              }
              className="text-muted-foreground/60 transition-colors duration-150 hover:text-destructive"
            >
              <X className="size-3" />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
            {column.cards.map((card, cardIndex) => (
              <div
                key={card.id}
                draggable
                onDragStart={() => setDragging({ cardId: card.id, fromColumn: column.id })}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.stopPropagation()
                  if (dragging) moveCard(dragging.cardId, dragging.fromColumn, column.id, cardIndex)
                  setDragging(null)
                }}
                className={cn(
                  'group rounded-md border border-border bg-card px-2 py-1.5',
                  'transition-[border-color,opacity] duration-150',
                  dragging?.cardId === card.id && 'opacity-40'
                )}
              >
                <div className="flex items-start gap-1.5">
                  <GripVertical className="mt-0.5 size-3 shrink-0 cursor-grab text-muted-foreground/40" />

                  <div className="min-w-0 flex-1">
                    {editing === card.id ? (
                      <CardEditor
                        card={card}
                        onDone={(next) => {
                          update((draft) => {
                            const target = draft.columns
                              .find((c) => c.id === column.id)
                              ?.cards.find((c) => c.id === card.id)
                            if (target) Object.assign(target, next)
                          })
                          setEditing(null)
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEditing(card.id)}
                        className="block w-full text-left"
                      >
                        <p className="text-[13px] font-medium leading-snug text-foreground">
                          {card.title}
                        </p>
                        {card.text && (
                          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                            {card.text}
                          </p>
                        )}
                        {card.tags && card.tags.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {card.tags.map((tag) => (
                              <Badge key={tag} tone="outline" className="px-1.5 py-0 text-[10px]">
                                {tag}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    aria-label="Delete card"
                    onClick={() =>
                      update((draft) => {
                        const target = draft.columns.find((c) => c.id === column.id)
                        if (target) target.cards = target.cards.filter((c) => c.id !== card.id)
                      })
                    }
                    className="shrink-0 text-muted-foreground/50 opacity-0 transition-[opacity,color] duration-150 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={() =>
                update((draft) => {
                  const target = draft.columns.find((c) => c.id === column.id)
                  target?.cards.push({ id: newId('card'), title: 'New card' })
                })
              }
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-3" />
              Add card
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() =>
          update((draft) => {
            draft.columns.push({ id: newId('col'), title: 'New column', cards: [] })
          })
        }
        className="h-9 w-40 shrink-0 rounded-lg border border-dashed border-border text-[12px] text-muted-foreground transition-colors duration-150 hover:border-primary/40 hover:text-foreground"
      >
        <Plus className="mr-1 inline size-3" />
        Add column
      </button>
    </div>
  )
}

function CardEditor({
  card,
  onDone,
  onCancel
}: {
  card: KanbanCard
  onDone: (next: Partial<KanbanCard>) => void
  onCancel: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState(card.title)
  const [text, setText] = useState(card.text ?? '')

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onDone({ title, text: text || undefined })
          if (event.key === 'Escape') onCancel()
        }}
        className="h-7 text-[13px]"
      />
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Detail…"
        className="min-h-14 text-[12px]"
      />
      <div className="flex gap-1">
        <Button size="xs" onClick={() => onDone({ title, text: text || undefined })}>
          Save
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- table */

export function TableSurface({
  state,
  onChange
}: {
  state: TableState
  onChange: (next: TableState) => void
}): React.JSX.Element {
  const columns = state.columns ?? []
  const rows = state.rows ?? []

  const update = (mutate: (draft: TableState) => void): void => {
    const draft: TableState = JSON.parse(JSON.stringify(state))
    mutate(draft)
    onChange(draft)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              {columns.map((column) => (
                <th key={column.key} className="px-2 py-1.5 text-left font-medium">
                  <input
                    value={column.label}
                    onChange={(event) =>
                      update((draft) => {
                        const target = draft.columns.find((c) => c.key === column.key)
                        if (target) target.label = event.target.value
                      })
                    }
                    className="w-full rounded bg-transparent px-0.5 text-[12px] font-medium text-muted-foreground focus-visible:text-foreground focus-visible:outline-offset-1"
                  />
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="group border-b border-border/50 last:border-0">
                {columns.map((column) => (
                  <td key={column.key} className="px-2 py-1">
                    <input
                      value={row[column.key] ?? ''}
                      onChange={(event) =>
                        update((draft) => {
                          draft.rows[rowIndex] = {
                            ...draft.rows[rowIndex],
                            [column.key]: event.target.value
                          }
                        })
                      }
                      className="w-full rounded bg-transparent px-0.5 py-0.5 text-[13px] text-foreground focus-visible:bg-accent/40 focus-visible:outline-offset-1"
                    />
                  </td>
                ))}
                <td className="px-1">
                  <button
                    type="button"
                    aria-label="Delete row"
                    onClick={() =>
                      update((draft) => {
                        draft.rows.splice(rowIndex, 1)
                      })
                    }
                    className="text-muted-foreground/50 opacity-0 transition-[opacity,color] duration-150 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-1.5">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            update((draft) => {
              draft.rows.push(Object.fromEntries(draft.columns.map((c) => [c.key, ''])))
            })
          }
        >
          <Plus className="size-3" />
          Row
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            update((draft) => {
              const key = newId('col')
              draft.columns.push({ key, label: 'New column' })
              draft.rows = draft.rows.map((row) => ({ ...row, [key]: '' }))
            })
          }
        >
          <Plus className="size-3" />
          Column
        </Button>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- checklist */

export function ChecklistSurface({
  state,
  onChange
}: {
  state: ChecklistState
  onChange: (next: ChecklistState) => void
}): React.JSX.Element {
  const items = state.items ?? []

  const update = (mutate: (draft: ChecklistState) => void): void => {
    const draft: ChecklistState = JSON.parse(JSON.stringify(state))
    mutate(draft)
    onChange(draft)
  }

  // The caret follows "Add item" into the row it created, so typing continues where
  // the user is looking rather than needing a click to find the new field.
  const lastItemRef = useRef<HTMLInputElement>(null)
  const focusLastRef = useRef(false)
  useEffect(() => {
    if (!focusLastRef.current) return
    focusLastRef.current = false
    lastItemRef.current?.focus()
  }, [items.length])

  return (
    <div className="flex flex-col gap-1">
      {items.map((item, index) => (
        <div key={item.id} className="group flex items-start gap-2 rounded-md px-1 py-1">
          <button
            type="button"
            role="checkbox"
            aria-checked={item.checked}
            aria-label={item.label.trim() || `Item ${index + 1}`}
            onClick={() =>
              update((draft) => {
                draft.items[index].checked = !draft.items[index].checked
              })
            }
            className={cn(
              'mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[9px] transition-colors duration-150',
              item.checked
                ? 'border-success/45 bg-success/15 text-success'
                : 'border-border bg-secondary hover:border-primary/40'
            )}
          >
            {item.checked ? '✓' : ''}
          </button>

          <input
            value={item.label}
            onChange={(event) =>
              update((draft) => {
                draft.items[index].label = event.target.value
              })
            }
            ref={index === items.length - 1 ? lastItemRef : undefined}
            placeholder="New item"
            aria-label={`Item ${index + 1}`}
            className={cn(
              'min-w-0 flex-1 rounded bg-transparent px-0.5 text-[13px] placeholder:text-muted-foreground/50 focus-visible:outline-offset-1',
              item.checked ? 'text-muted-foreground line-through' : 'text-foreground'
            )}
          />

          <button
            type="button"
            aria-label="Delete item"
            onClick={() =>
              update((draft) => {
                draft.items.splice(index, 1)
              })
            }
            className="shrink-0 text-muted-foreground/50 opacity-0 transition-[opacity,color] duration-150 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => {
          focusLastRef.current = true
          update((draft) => {
            draft.items.push({ id: newId('item'), label: '', checked: false })
          })
        }}
        className="flex items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-[12px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <Plus className="size-3" />
        Add item
      </button>
    </div>
  )
}

/* ----------------------------------------------------------------- notepad */

export function NotepadSurface({
  state,
  onChange
}: {
  state: NotepadState
  onChange: (next: NotepadState) => void
}): React.JSX.Element {
  return (
    <Textarea
      value={state.text ?? ''}
      onChange={(event) => onChange({ text: event.target.value })}
      placeholder="Anything you like. The agent can read and edit this too."
      className="min-h-full flex-1 resize-none font-sans text-[13.5px] leading-relaxed"
    />
  )
}

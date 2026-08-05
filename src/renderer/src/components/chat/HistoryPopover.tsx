import { useEffect, useRef, useState } from 'react'
import { History, Trash2, Wand2 } from 'lucide-react'
import { useApp } from '@/store/app'
import { api } from '@/lib/api'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Spinner } from '@/components/ui/base'

/**
 * Past conversations.
 *
 * Starting a new conversation used to look like losing the old one — sessions were
 * always persisted, but nothing in the UI reached them. This is that missing door.
 */
export function HistoryPopover(): React.JSX.Element {
  const sessions = useApp((s) => s.sessions)
  const current = useApp((s) => s.session)
  const switchSession = useApp((s) => s.switchSession)
  // Which conversations are mid-turn. Switching away no longer stops one, so the list
  // has to say which are still working — otherwise leaving a chat and coming back
  // looks identical to it having quietly died.
  const runningSessionIds = useApp((s) => s.runningSessionIds)
  const refreshSessions = useApp((s) => s.refreshSessions)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    void refreshSessions()

    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, refreshSessions])

  return (
    <div ref={ref} className="relative">
      <Tooltip content="Past conversations">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Past conversations"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <History className="size-4" />
        </Button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 top-9 z-40 w-80 overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
          <p className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Conversations
          </p>

          <div className="max-h-80 overflow-y-auto p-1">
            {sessions.length === 0 && (
              <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">
                Nothing yet.
              </p>
            )}

            {sessions.map((session) => (
              <div
                key={session.id}
                className={cn(
                  'group flex items-center gap-1 rounded-md',
                  session.id === current?.id && 'bg-accent'
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    void switchSession(session.id)
                    setOpen(false)
                  }}
                  className="min-w-0 flex-1 px-2 py-1.5 text-left"
                >
                  <p className="flex items-center gap-1.5 text-[13px] text-foreground">
                    <span className="truncate">{session.title}</span>
                    {runningSessionIds.includes(session.id) && (
                      <Spinner className="size-3 shrink-0 text-primary" />
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {runningSessionIds.includes(session.id)
                      ? 'working…'
                      : formatRelativeTime(session.updatedAt)}
                  </p>
                </button>

                <Tooltip content="Delete">
                  <button
                    type="button"
                    aria-label={`Delete ${session.title}`}
                    onClick={async () => {
                      await api.deleteSession(session.id)
                      await refreshSessions()
                      // Deleting what you are reading has to land somewhere.
                      if (session.id === current?.id) {
                        const remaining = useApp.getState().sessions
                        if (remaining.length > 0) await switchSession(remaining[0].id)
                        else await useApp.getState().newSession()
                      }
                    }}
                    className="mr-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-[opacity,color] duration-150 hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export { Wand2 }

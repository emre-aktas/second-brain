import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Bell, CalendarClock, HelpCircle, MessageSquare } from 'lucide-react'
import type { InboxEntry, InboxKind } from '@shared/types'
import { api, onEvent } from '@/lib/api'
import { useApp } from '@/store/app'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'

const ICON: Record<InboxKind, typeof Bell> = {
  reply: MessageSquare,
  task: CalendarClock,
  question: HelpCircle
}

/**
 * What the app tried to tell you while you were away.
 *
 * This is not a nicety on top of desktop notifications — it is the reliable half. A
 * Windows toast is delivered to an identity registered in the shell, and when no
 * shortcut carrying that identity points at the running executable the click is never
 * delivered to the app at all. That is the normal state for a dev run and permanent for
 * a portable build. So every notification is recorded here first and the toast is
 * best-effort on top: the badge is the door that always works.
 */
export function InboxPopover(): React.JSX.Element {
  const switchSession = useApp((s) => s.switchSession)
  const setPanel = useApp((s) => s.setPanel)

  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<InboxEntry[]>([])
  const [unread, setUnread] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const refresh = async (): Promise<void> => {
    const { entries: list, unread: count } = await api.listInbox()
    setEntries(list)
    setUnread(count)
  }

  useEffect(() => {
    void refresh()
    return onEvent('inbox:changed', () => void refresh())
  }, [])

  // Click-away, matching how the history popover behaves.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const openEntry = async (entry: InboxEntry): Promise<void> => {
    await api.readInbox(entry.id)
    setOpen(false)
    if (!entry.sessionId) return
    await switchSession(entry.sessionId)
    setPanel('chat')
  }

  return (
    <div className="relative" ref={boxRef}>
      <Tooltip content={unread > 0 ? `${unread} unread` : 'Nothing waiting'}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn('relative', open && 'text-foreground')}
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-[14px] text-primary-foreground">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 top-8 z-50 w-80 rounded-lg border border-border bg-popover p-1 shadow-xl">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              Inbox
            </span>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void api.readInbox().then(refresh)}
                className="text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {entries.length === 0 && (
              <p className="px-2 py-4 text-center text-[12px] leading-relaxed text-muted-foreground text-pretty">
                Nothing here. This fills up when the app has something to say while you
                are elsewhere.
              </p>
            )}

            {entries.map((entry) => {
              const Icon = ICON[entry.kind] ?? Bell
              const isUnread = entry.readAt === null
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => void openEntry(entry)}
                  aria-label={`${entry.title} — ${formatRelativeTime(entry.createdAt)}${isUnread ? ', unread' : ''}`}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left',
                    'transition-[background-color,transform] duration-150 ease-[var(--ease-out)]',
                    'active:scale-[0.99] hover:bg-accent/60',
                    isUnread && 'bg-primary/6'
                  )}
                >
                  <Icon
                    className={cn(
                      'mt-0.5 size-3.5 shrink-0',
                      isUnread ? 'text-primary' : 'text-muted-foreground'
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={cn(
                          'truncate text-[12.5px]',
                          isUnread ? 'font-medium text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        {entry.title}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-muted-foreground">
                        {formatRelativeTime(entry.createdAt)}
                      </span>
                    </span>
                    {entry.body && (
                      <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-relaxed text-muted-foreground text-pretty">
                        {entry.body}
                      </span>
                    )}
                    {!entry.sessionId && (
                      <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-muted-foreground">
                        <AlertCircle className="size-2.5" />
                        that chat has since been cleared
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

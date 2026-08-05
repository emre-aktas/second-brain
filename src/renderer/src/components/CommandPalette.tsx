import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  FileText,
  FolderOpen,
  MessageSquare,
  Plug,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Wand2
} from 'lucide-react'
import type { SearchHitDto } from '@shared/ipc'
import { api } from '@/lib/api'
import { useApp, type Panel } from '@/store/app'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInputRow,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/base'

/**
 * Opens on Ctrl+K and does not animate. It is reached by keyboard many times a
 * day, and any transition on the way in reads as latency.
 */
export function CommandPalette(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHitDto[]>([])

  const openNode = useApp((s) => s.openNode)
  const focusNodes = useApp((s) => s.focusNodes)
  const setPanel = useApp((s) => s.setPanel)
  const newSession = useApp((s) => s.newSession)
  const recentNodes = useApp((s) => s.graph.nodes)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Debounced so typing does not fire a full-text query per keystroke.
  useEffect(() => {
    if (!open) return
    const term = query.trim()
    if (term.length < 2) {
      setHits([])
      return
    }

    const timer = setTimeout(() => {
      void api.search(term, 12).then(setHits).catch(() => setHits([]))
    }, 110)
    return () => clearTimeout(timer)
  }, [query, open])

  const fallback = useMemo(
    () =>
      [...recentNodes]
        .filter((node) => node.kind !== 'tag')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 7),
    [recentNodes]
  )

  const close = (): void => {
    setOpen(false)
    setQuery('')
    setHits([])
  }

  const go = (panel: Panel): void => {
    setPanel(panel)
    close()
  }

  return (
    <CommandDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      {/* cmdk filters by default; results are already ranked server-side. */}
      <Command shouldFilter={false} loop>
        <CommandInputRow value={query} onValueChange={setQuery} placeholder="Search notes or jump to…" />
        <CommandList>
          <CommandEmpty className="py-8 text-center text-sm text-muted-foreground">
            Nothing matched “{query}”.
          </CommandEmpty>

          {hits.length > 0 && (
            <CommandGroup heading="Notes">
              {hits.map((hit) => (
                <CommandItem
                  key={hit.node.id}
                  value={hit.node.id}
                  onSelect={() => {
                    openNode(hit.node.id)
                    focusNodes([hit.node.id], hit.node.title)
                    close()
                  }}
                >
                  <NoteIcon />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{hit.node.title}</span>
                    {hit.excerpt && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {hit.excerpt}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {hits.length === 0 && query.trim().length < 2 && fallback.length > 0 && (
            <CommandGroup heading="Recent">
              {fallback.map((node) => (
                <CommandItem
                  key={node.id}
                  value={node.id}
                  onSelect={() => {
                    openNode(node.id)
                    focusNodes([node.id], node.title)
                    close()
                  }}
                >
                  <NoteIcon />
                  <span className="truncate">{node.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {query.trim().length < 2 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Go to">
                <CommandItem value="panel-chat" onSelect={() => go('chat')}>
                  <ChatIcon />
                  Conversation
                </CommandItem>
                <CommandItem value="panel-tools" onSelect={() => go('tools')}>
                  <ToolsIcon />
                  Tools
                </CommandItem>
                <CommandItem value="panel-activity" onSelect={() => go('activity')}>
                  <ActivityIcon />
                  Activity and suggestions
                </CommandItem>
                <CommandItem value="panel-integrations" onSelect={() => go('integrations')}>
                  <PlugIcon />
                  Integrations
                </CommandItem>
                <CommandItem value="panel-settings" onSelect={() => go('settings')}>
                  <GearIcon />
                  Settings
                </CommandItem>
              </CommandGroup>

              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem
                  value="new-conversation"
                  onSelect={() => {
                    void newSession()
                    setPanel('chat')
                    close()
                  }}
                >
                  <PlusIcon />
                  New conversation
                </CommandItem>
                <CommandItem
                  value="reindex"
                  onSelect={() => {
                    void api.reindex()
                    close()
                  }}
                >
                  <RefreshIcon />
                  Reindex the vault
                </CommandItem>
                <CommandItem
                  value="open-folder"
                  onSelect={() => {
                    void api.openWorkspace()
                    close()
                  }}
                >
                  <FolderIcon />
                  Open the vault folder
                </CommandItem>
                <CommandItem
                  value="curate"
                  onSelect={() => {
                    void api.runCurator()
                    setPanel('activity')
                    close()
                  }}
                >
                  <SparkIcon />
                  Look for new connections
                </CommandItem>
              </CommandGroup>
            </>
          )}
        </CommandList>

        <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </Command>
    </CommandDialog>
  )
}

/* Icons come from lucide so stroke weight and optical size stay consistent with
 * the rest of the app rather than drifting per hand-drawn path. */
const NoteIcon = FileText
const ChatIcon = MessageSquare
const ActivityIcon = Activity
const PlugIcon = Plug
const GearIcon = Settings
const PlusIcon = Plus
const RefreshIcon = RefreshCw
const FolderIcon = FolderOpen
const SparkIcon = Sparkles
const ToolsIcon = Wand2

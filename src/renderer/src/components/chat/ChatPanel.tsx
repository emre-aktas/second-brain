import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NodeProse } from '@/components/NodeProse'
import { CalendarClock, ChevronRight, Eye, EyeOff, Plus } from 'lucide-react'
import { friendlyToolLabel } from '@/lib/tool-labels'
import { toolIcon } from '@/components/panels/ToolsPanel'
import type { AgentCapability, ChatBlock, ChatImage, ChatMessage } from '@shared/types'
import { activeChat, useApp } from '@/store/app'
import { cn } from '@/lib/utils'
import { Badge, Separator, Spinner } from '@/components/ui/base'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { GenUi } from '@/components/genui/GenUiRenderer'
import { PinnedToolStrip } from '@/components/panels/ToolsPanel'
import { HistoryPopover } from './HistoryPopover'
import { InboxPopover } from './InboxPopover'
import { AttachButton, AttachmentStrip, readImageFiles } from './Attachments'
import { QuestionCard } from './QuestionCard'
import { TouchedNotes, touchedNotes } from './TouchedNotes'
import { LiveTurnMeter, TurnMeter } from './TurnMeter'

const CAPABILITY_LABEL: Record<AgentCapability, string> = {
  'read-only': 'Read only',
  curate: 'Can edit notes',
  build: 'Can write code'
}

const CAPABILITY_HINT: Record<AgentCapability, string> = {
  'read-only': 'Reads and presents, but changes nothing.',
  curate: 'Creates, edits and links notes. The normal mode.',
  build: 'Adds shell and file access so it can build integrations. Only turn this on when you mean it.'
}

export function ChatPanel(): React.JSX.Element {
  // Selected per field from the active conversation's slice rather than from the top
  // level: several chats can be mid-turn, and this panel shows exactly one of them.
  const messages = useApp((s) => activeChat(s).messages)
  const streaming = useApp((s) => activeChat(s).streaming)
  const agentState = useApp((s) => activeChat(s).agentState)
  const activeStep = useApp((s) => activeChat(s).activeStep)
  const allQuestions = useApp((s) => s.questions)
  const answerQuestion = useApp((s) => s.answerQuestion)
  const showActivity = useApp((s) => s.settings?.chat.showToolActivity ?? false)
  const updateSettings = useApp((s) => s.updateSettings)
  const capability = useApp((s) => s.capability)
  const genui = useApp((s) => s.genui)
  const nodes = useApp((s) => s.graph.nodes)
  const session = useApp((s) => s.session)
  const agentAvailable = useApp((s) => s.bootstrap?.agent.available ?? false)

  const sendMessage = useApp((s) => s.sendMessage)
  const interrupt = useApp((s) => s.interrupt)
  const setCapability = useApp((s) => s.setCapability)
  const openNode = useApp((s) => s.openNode)
  const focusNodes = useApp((s) => s.focusNodes)
  const newSession = useApp((s) => s.newSession)

  const questions = allQuestions.filter((question) => question.sessionId === session?.id)

  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ChatImage[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pinnedToBottomRef = useRef(true)
  const busy = agentState !== 'idle' && agentState !== 'error'

  // Keep the newest content in view, but stop fighting the user the moment they
  // scroll up to read something.
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !pinnedToBottomRef.current) return
    viewport.scrollTop = viewport.scrollHeight
  }, [messages, streaming])

  const handleScroll = (): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    pinnedToBottomRef.current = distance < 80
  }

  const submit = (): void => {
    if ((!draft.trim() && attachments.length === 0) || busy) return
    void sendMessage(draft, attachments.length > 0 ? { images: attachments } : undefined)
    setDraft('')
    setAttachments([])
    setAttachError(null)
    pinnedToBottomRef.current = true
  }

  const addFiles = async (files: File[]): Promise<void> => {
    const { images, error } = await readImageFiles(files, attachments.length)
    if (images.length > 0) setAttachments((current) => [...current, ...images])
    setAttachError(error)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[13px] font-semibold text-foreground">
            {session?.title ?? 'Conversation'}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content={showActivity ? 'Hide the agent’s steps' : 'Show the agent’s steps'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle agent steps"
              aria-pressed={showActivity}
              onClick={() =>
                void updateSettings({ chat: { showToolActivity: !showActivity } })
              }
              className={cn(showActivity && 'text-foreground')}
            >
              {showActivity ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
            </Button>
          </Tooltip>
          <InboxPopover />
          <HistoryPopover />
          <CapabilityPicker value={capability} onChange={(next) => void setCapability(next)} />
          <Tooltip content="New conversation">
            <Button variant="ghost" size="icon-sm" onClick={() => void newSession()} aria-label="New conversation">
              <Plus className="size-4" />
            </Button>
          </Tooltip>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef} onViewportScroll={handleScroll}>
        <div className="flex flex-col gap-5 px-3 py-4">
          {messages.length === 0 && !streaming && <ChatIntro available={agentAvailable} />}

          {groupIntoTurns(messages).map((turn, index) => (
            <TurnView
              key={turn.userMessage?.id ?? turn.assistantMessages[0]?.id ?? index}
              turn={turn}
              genui={genui}
              nodes={nodes}
              showActivity={showActivity}
              onOpenNode={openNode}
              onFocusNodes={focusNodes}
            />
          ))}

          {streaming && (streaming.text || streaming.thinking) && (
            <div className="flex flex-col gap-2">
              {showActivity && streaming.thinking && !streaming.text && (
                <p className="text-[13px] italic text-muted-foreground">{tail(streaming.thinking)}</p>
              )}
              {streaming.text && (
                <NodeProse
                  className="genui-prose selectable text-[13.5px] leading-relaxed text-foreground"
                  onOpenNode={openNode}
                >
                  {streaming.text}
                </NodeProse>
              )}
            </div>
          )}

          {questions.map((question) => (
            <QuestionCard key={question.id} question={question} onAnswer={answerQuestion} />
          ))}

          {busy && questions.length === 0 && !streaming?.text && (
            <ProgressLine state={agentState} step={activeStep} />
          )}

          {/* Under whatever the turn is currently showing — the progress line before any
              text arrives, the streaming reply after. One place, so the numbers do not
              appear to move house halfway through the answer. */}
          {busy && questions.length === 0 && <LiveTurnMeter className="px-0.5" />}
        </div>
      </ScrollArea>

      <div
        className="border-t border-border p-3"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          setDragging(false)
          void addFiles([...event.dataTransfer.files])
        }}
      >
        <PinnedToolStrip />
        <AttachmentStrip
          images={attachments}
          onRemove={(index) => setAttachments((current) => current.filter((_, i) => i !== index))}
        />

        {attachError && (
          <p className="mb-1.5 text-[11px] text-destructive">{attachError}</p>
        )}

        <div className={cn('relative rounded-md', dragging && 'ring-2 ring-primary/50')}>
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(event) => {
              // Pasting a screenshot is the common case and should need no thought.
              const files = [...event.clipboardData.files]
              if (files.length === 0) return
              event.preventDefault()
              void addFiles(files)
            }}
            rows={3}
            placeholder={
              agentAvailable
                ? dragging
                  ? 'Drop the image here'
                  : 'Ask your brain anything — paste an image too'
                : 'Install Claude Code to enable the agent'
            }
            disabled={!agentAvailable}
            className="pr-24"
          />
          <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
            <AttachButton onFiles={(files) => void addFiles(files)} disabled={!agentAvailable} />
            {busy ? (
              <Button size="sm" variant="secondary" onClick={interrupt}>
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={submit}
                disabled={(!draft.trim() && attachments.length === 0) || !agentAvailable}
              >
                Send
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {CAPABILITY_HINT[capability]}
        </p>
      </div>
    </div>
  )
}

function CapabilityPicker({
  value,
  onChange
}: {
  value: AgentCapability
  onChange: (value: AgentCapability) => void
}): React.JSX.Element {
  const order: AgentCapability[] = ['read-only', 'curate', 'build']

  return (
    <Tooltip content={CAPABILITY_HINT[value]}>
      <button
        type="button"
        onClick={() => onChange(order[(order.indexOf(value) + 1) % order.length])}
        className={cn(
          'rounded-full border px-2 py-0.5 text-[11px] font-medium',
          'transition-[background-color,border-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]',
          value === 'build'
            ? 'border-warning/40 bg-warning/12 text-warning'
            : value === 'read-only'
              ? 'border-border bg-secondary text-muted-foreground'
              : 'border-primary/30 bg-primary/10 text-primary'
        )}
      >
        {CAPABILITY_LABEL[value]}
      </button>
    </Tooltip>
  )
}

function ChatIntro({ available }: { available: boolean }): React.JSX.Element {
  if (!available) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/8 px-3.5 py-3">
        <p className="text-[13px] font-medium text-warning">The Claude CLI was not found</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground text-pretty">
          The agent runs your local Claude Code install, so nothing is sent through a separate API
          key. Install it and make sure <code className="font-mono text-[12px]">claude</code> is on
          your PATH, then restart.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[13px] leading-relaxed text-muted-foreground text-pretty">
        Ask about anything in your vault. It searches your own notes before answering, and replies
        with a live interface when that reads better than prose.
      </p>
      <div className="flex flex-col gap-1">
        {[
          'What have I been working on this week?',
          'Find notes that should be linked but are not',
          'Summarise everything I know about this topic'
        ].map((example) => (
          <Suggestion key={example} text={example} />
        ))}
      </div>
    </div>
  )
}

function Suggestion({ text }: { text: string }): React.JSX.Element {
  const sendMessage = useApp((s) => s.sendMessage)

  return (
    <button
      type="button"
      onClick={() => void sendMessage(text)}
      className="rounded-md border border-border/70 bg-secondary/25 px-2.5 py-1.5 text-left text-[13px] text-muted-foreground transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] hover:bg-accent hover:text-accent-foreground active:scale-[0.99]"
    >
      {text}
    </button>
  )
}

/**
 * The one thing shown while a turn runs when activity is hidden. It names the
 * current step so the wait is legible, without turning the transcript into a log.
 */
function ProgressLine({ state, step }: { state: string; step: string | null }): React.JSX.Element {
  const label = step ?? (state === 'working' ? 'Working' : 'Thinking')

  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Spinner className="size-3.5" />
      <span>{label}…</span>
    </div>
  )
}

/**
 * One exchange: the user's message plus everything the agent produced before the
 * user spoke again.
 *
 * The CLI emits a separate assistant message per tool call, so a single turn
 * arrives as many messages. Rendering each one on its own produced a stack of
 * identical "1 step" boxes; grouping them means one collapsed summary for the
 * whole turn, which is what a turn actually is from the user's side.
 */
interface Turn {
  userMessage: ChatMessage | null
  assistantMessages: ChatMessage[]
}

function groupIntoTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ userMessage: message, assistantMessages: [] })
      continue
    }
    // An assistant message with no preceding user message (a resumed or
    // background session) still needs somewhere to live.
    if (turns.length === 0) turns.push({ userMessage: null, assistantMessages: [] })
    turns[turns.length - 1].assistantMessages.push(message)
  }

  return turns
}

function TurnView({
  turn,
  genui,
  nodes,
  showActivity,
  onOpenNode,
  onFocusNodes
}: {
  turn: Turn
  genui: Record<string, import('@shared/genui').GenUiSpec>
  nodes: import('@shared/types').GraphNodeLite[]
  showActivity: boolean
  onOpenNode: (id: string) => void
  onFocusNodes: (ids: string[], note?: string | null) => void
}): React.JSX.Element {
  const toolRun = turn.userMessage?.meta?.toolRun ?? null
  const taskRun = turn.userMessage?.meta?.taskRun ?? null
  // Either kind of generated prompt is hidden; only one can be set.
  const generated = toolRun !== null || taskRun !== null

  // Flatten the turn, keeping block order across messages.
  const allBlocks = turn.assistantMessages.flatMap((message) => message.blocks)

  const stepBlocks = allBlocks.filter(
    (block) => block.type === 'tool' || block.type === 'thinking'
  )

  // Notes this turn wrote, taken from its tool results rather than from what the agent
  // remembered to say — and minus anything it already linked in prose.
  const said = allBlocks
    .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
  const touched = touchedNotes(allBlocks, said)
  const visibleBlocks = showActivity
    ? allBlocks
    : allBlocks.filter((block) => block.type === 'text' || block.type === 'genui')

  return (
    <div className="flex flex-col gap-4">
      {turn.userMessage && toolRun && <ToolRunHeader run={toolRun} />}
      {turn.userMessage && taskRun && <TaskRunHeader run={taskRun} />}

      {turn.userMessage && !generated && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg rounded-br-sm bg-primary/12 px-3 py-2">
            {(() => {
              const attached = turn.userMessage.blocks.filter(
                (block): block is Extract<ChatBlock, { type: 'image' }> => block.type === 'image'
              )
              const said = turn.userMessage.blocks
                .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
                .map((block) => block.text)
                .join('\n')

              return (
                <>
                  {attached.length > 0 && (
                    <div className="mb-1.5 flex flex-wrap gap-1.5">
                      {attached.map((image, index) => (
                        <img
                          key={index}
                          src={`data:${image.mediaType};base64,${image.dataBase64}`}
                          alt={image.name ?? 'Attached image'}
                          className="max-h-40 rounded-md border border-border/60 object-contain"
                        />
                      ))}
                    </div>
                  )}
                  {said.trim() && (
                    <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground selectable">
                      {said}
                    </p>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      )}

      {(visibleBlocks.length > 0 || stepBlocks.length > 0) && (
        <div
          className={cn(
            'flex flex-col gap-2.5',
            // A tool run gets its own framed surface so its output reads as
            // something the tool produced, not as a chat reply.
            generated && 'rounded-lg border border-border bg-card/40 px-3 py-3'
          )}
        >
          {!showActivity && stepBlocks.length > 0 && <StepSummary blocks={stepBlocks} />}


          {visibleBlocks.map((block, index) => {
            switch (block.type) {
              case 'text':
                return (
                  <div
                    key={index}
                    className="genui-prose selectable text-[13.5px] leading-relaxed text-foreground"
                  >
                    <NodeProse onOpenNode={onOpenNode}>{block.text}</NodeProse>
                  </div>
                )

              case 'thinking':
                return <ThinkingBlock key={index} text={block.text} />

              case 'tool':
                return <ToolBlock key={index} block={block} />

              case 'genui': {
                const spec = genui[block.specId]
                if (!spec) {
                  return (
                    <div key={index} className="text-[12px] text-muted-foreground">
                      Loading interface…
                    </div>
                  )
                }
                return (
                  <GenUi
                    key={index}
                    spec={spec}
                    specId={block.specId}
                    nodes={nodes}
                    onOpenNode={onOpenNode}
                    onFocusNodes={onFocusNodes}
                  />
                )
              }

              default:
                return null
            }
          })}

          <TouchedNotes notes={touched} onOpenNode={onOpenNode} />

          {/* Last, and the quietest line in the turn. Taken from the final assistant
              message because that is the one the `result` frame stamps — a turn with
              several messages has one duration, not one per message. */}
          {(() => {
            const meta = turn.assistantMessages.at(-1)?.meta
            return (
              <TurnMeter
                durationMs={meta?.durationMs}
                inputTokens={meta?.inputTokens}
                outputTokens={meta?.outputTokens}
                className="mt-0.5"
              />
            )
          })()}
        </div>
      )}
    </div>
  )
}

/**
 * Header for a turn a saved tool started. Shows the tool and the inputs it ran
 * with, so the transcript reads as "this tool produced this" rather than as a
 * long prompt the user apparently typed.
 */
function ToolRunHeader({
  run
}: {
  run: NonNullable<ChatMessage['meta']>['toolRun']
}): React.JSX.Element | null {
  if (!run) return null

  const Icon = toolIcon(run.icon)
  const supplied = Object.entries(run.values).filter(([, value]) => value.trim().length > 0)

  return (
    <div className="flex items-center gap-2">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
        <Icon className="size-3.5" />
      </span>
      <span className="text-[12px] font-medium text-foreground">{run.toolName}</span>
      {supplied.length > 0 && (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {supplied.map(([key, value]) => `${key}: ${value}`).join(' · ')}
        </span>
      )}
    </div>
  )
}

/**
 * A scheduled run, in place of the instructions that started it.
 *
 * The prompt behind one of these is generated and often hundreds of words — the hourly
 * check-in's is a briefing with a list of notes in it. Rendering that as a user message
 * shows someone their own app talking to itself, so the transcript says which task ran
 * and when, and the report is the reply below.
 */
function TaskRunHeader({
  run
}: {
  run: NonNullable<ChatMessage['meta']>['taskRun']
}): React.JSX.Element | null {
  if (!run) return null

  return (
    <div className="flex items-center gap-2">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
        <CalendarClock className="size-3.5" />
      </span>
      <span className="text-[12px] font-medium text-foreground">{run.taskName}</span>
      <span className="text-[11px] text-muted-foreground">ran on its own</span>
    </div>
  )
}

/**
 * A question the agent asked mid-turn. It is still waiting, so this is the one
 * thing in the transcript that needs an answer to move on.
 */
/** Collapsed record of what the agent did, for when activity is hidden. */
function StepSummary({ blocks }: { blocks: ChatBlock[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const tools = blocks.filter((b): b is Extract<ChatBlock, { type: 'tool' }> => b.type === 'tool')
  const failed = tools.filter((t) => t.status === 'error').length

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            'size-3 transition-transform duration-200 ease-[var(--ease-out)]',
            open && 'rotate-90'
          )}
        />
        {tools.length} step{tools.length === 1 ? '' : 's'}
        {failed > 0 && <span className="text-destructive">· {failed} failed</span>}
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-1 border-l border-border pl-2.5">
          {blocks.map((block, index) =>
            block.type === 'tool' ? (
              <ToolBlock key={index} block={block} />
            ) : block.type === 'thinking' ? (
              <ThinkingBlock key={index} text={block.text} />
            ) : null
          )}
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        {open ? 'Hide reasoning' : 'Show reasoning'}
      </button>
      {open && (
        <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-2.5 text-[12.5px] italic leading-relaxed text-muted-foreground selectable">
          {text}
        </p>
      )}
    </div>
  )
}

function ToolBlock({
  block
}: {
  block: Extract<ChatBlock, { type: 'tool' }>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const label = friendlyToolLabel(block.name)

  return (
    <div className="rounded-md border border-border/60 bg-secondary/25">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {block.status === 'running' ? (
          <Spinner className="size-3 text-muted-foreground" />
        ) : (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              block.status === 'error' ? 'bg-destructive' : 'bg-success'
            )}
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{label}</span>
        {block.status === 'error' && <Badge tone="danger">failed</Badge>}
      </button>

      {open && (
        <div className="border-t border-border/60 px-2.5 py-2">
          <pre className="selectable max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
            {JSON.stringify(block.input, null, 2)}
            {block.result ? `\n\n→ ${block.result}` : ''}
          </pre>
        </div>
      )}
    </div>
  )
}

/** Show the end of streaming reasoning, which is where the useful part is. */
function tail(text: string, limit = 180): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text
}

export { Separator }

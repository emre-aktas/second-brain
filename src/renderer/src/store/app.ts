import { create } from 'zustand'
import type { EngineState } from '@shared/engines'
import type {
  DeepPartial,
  ActivityEntry,
  AgentCapability,
  AgentEvent,
  AgentState,
  AgentTurnOptions,
  ChatMessage,
  ChatSession,
  GraphSnapshot,
  GraphStats,
  SavedTool,
  Settings,
  Suggestion
} from '@shared/types'
import type { GenUiSpec } from '@shared/genui'
import type {
  BootstrapPayload,
  BudgetStatus,
  PendingQuestion,
  UsageSnapshotDto
} from '@shared/ipc'
import { api, errorMessage, onEvent } from '@/lib/api'
import { friendlyToolLabel } from '@/lib/tool-labels'
import { toast } from '@/components/ui/sonner'
import { configureSound, cue } from '@/lib/sound'

export type Panel =
  | 'chat'
  | 'note'
  | 'tools'
  | 'tasks'
  | 'activity'
  | 'integrations'
  | 'engine'
  | 'settings'

/** Text streaming in for a message that has not been finalised yet. */
interface StreamingMessage {
  id: string
  text: string
  thinking: string
}

interface AppState {
  ready: boolean
  bootstrap: BootstrapPayload | null
  /**
   * The selected engine, and whether it can run a turn.
   *
   * In the store rather than in one component because two surfaces need the same answer and one
   * of them was getting it from the wrong place: the chat gated its composer on
   * `bootstrap.agent.available`, which is `resolveClaudeBinary() !== null` — a fact about Claude
   * standing in for a fact about the engine. With DeepSeek selected and working, the chat still
   * said "The Claude CLI was not found" and refused to accept a message.
   */
  engine: EngineState | null
  settings: Settings | null

  graph: GraphSnapshot
  /** Notes visited before this one, oldest first. Bounded; see NODE_TRAIL_LIMIT. */
  nodeTrail: string[]
  stats: GraphStats | null
  /**
   * Nodes to pulse once. `change` is something that was written; `probe` is
   * something the agent just read while working, staggered so a search reads as a
   * sweep through the graph rather than a simultaneous flash.
   */
  pulses: { id: string; at: number; kind: 'change' | 'probe' }[]
  focusRequest: { ids: string[]; note: string | null; stamp: number } | null
  /** What the agent is currently looking for, shown while the sweep is alive. */
  probeLabel: { text: string; at: number } | null

  selectedNodeId: string | null
  panel: Panel
  /** Tool filling the main area, in place of the graph. Null means the graph. */
  openToolId: string | null

  session: ChatSession | null
  sessions: ChatSession[]
  /**
   * Every conversation this window knows about, keyed by session id.
   *
   * Keyed rather than flat because a turn does not stop when you look away. The main
   * process keeps one CLI per session and happily runs several at once — it was the
   * renderer that dropped every event whose session was not the one on screen, so
   * switching chats looked exactly like cancelling one. Now a background turn keeps
   * streaming into its own entry and is waiting, finished, when you come back.
   */
  chats: Record<string, ChatRuntime>
  /**
   * Sessions with a turn in flight.
   *
   * Held as an array rather than derived on render so the value is referentially
   * stable: the history list subscribes to it, and a fresh array on every text delta
   * of a streaming reply would re-render the whole list.
   */
  runningSessionIds: string[]
  capability: AgentCapability
  /** Rendered interfaces by spec id. */
  genui: Record<string, GenUiSpec>
  lastTurnCost: number | null
  budget: BudgetStatus | null
  usage: UsageSnapshotDto | null

  activity: ActivityEntry[]
  suggestions: Suggestion[]
  tools: SavedTool[]
  /** Questions the agent is waiting on, keyed by id. */
  questions: PendingQuestion[]

  init: () => Promise<void>
  refreshGraph: () => Promise<void>
  refreshSuggestions: () => Promise<void>
  refreshActivity: () => Promise<void>
  refreshSessions: () => Promise<void>
  refreshBudget: () => Promise<void>
  refreshUsage: () => Promise<void>
  refreshTools: () => Promise<void>
  runTool: (tool: SavedTool, values: Record<string, string>) => Promise<void>
  answerQuestion: (id: string, answer: string) => Promise<void>

  setPanel: (panel: Panel) => void
  setEngine: (engine: EngineState | null) => void
  openTool: (toolId: string) => void
  closeTool: () => void
  selectNode: (id: string | null) => void
  openNode: (id: string) => void
  /**
   * Back to the note this one was opened from.
   *
   * Following a wikilink is the main way to move around a vault, and following one had no
   * inverse — the note you came from was gone unless you remembered its name.
   */
  goBackNode: () => void
  focusNodes: (ids: string[], note?: string | null) => void
  /** Stop attending to whatever the agent pointed at. */
  clearFocus: () => void

  sendMessage: (text: string, extra?: Partial<AgentTurnOptions>) => Promise<void>
  interrupt: () => void
  newSession: () => Promise<void>
  switchSession: (id: string) => Promise<void>
  setCapability: (capability: AgentCapability) => Promise<void>

  applySuggestion: (id: string) => Promise<void>
  dismissSuggestion: (id: string) => Promise<void>
  updateSettings: (patch: DeepPartial<Settings>) => Promise<void>
}

/**
 * Update one conversation's slice, creating it if this is the first we have heard of it.
 *
 * Every agent event goes through here rather than writing top-level fields, which is
 * what makes a background turn keep running: the event is filed under its own session
 * and only the chat on screen reads from the one being displayed.
 */
function patchChat(
  chats: Record<string, ChatRuntime>,
  sessionId: string,
  patch: Partial<ChatRuntime> | ((current: ChatRuntime) => Partial<ChatRuntime>)
): Record<string, ChatRuntime> {
  const current = chats[sessionId] ?? EMPTY_CHAT
  const next = typeof patch === 'function' ? patch(current) : patch
  return { ...chats, [sessionId]: { ...current, ...next } }
}

/**
 * The ids of chats with a turn in flight, reusing the previous array when unchanged.
 *
 * The identity matters: this is subscribed to by the conversation list, and a new
 * array on every text delta would re-render it dozens of times a second.
 */
function runningIds(chats: Record<string, ChatRuntime>, previous: string[]): string[] {
  const next = Object.entries(chats)
    .filter(([, chat]) => chat.agentState !== 'idle')
    .map(([id]) => id)
    .sort()

  if (next.length === previous.length && next.every((id, i) => id === previous[i])) return previous
  return next
}

/** One conversation's live state. */
export interface ChatRuntime {
  messages: ChatMessage[]
  streaming: StreamingMessage | null
  agentState: AgentState
  /** Friendly label for whatever the agent is doing in this chat right now. */
  activeStep: string | null
  /**
   * When the running turn started, or null when nothing is running.
   *
   * On the chat rather than in the component that displays it, for two reasons: a
   * component captures the moment it mounted, so switching away and back would restart the
   * clock at zero; and a turn can be running in a chat that is not on screen.
   */
  turnStartedAt: number | null
  /**
   * Tokens the running turn has spent so far. Flat scalars, deliberately: `activeChat`
   * hands back a fresh object on every patch, so only field-level selectors keep the rest
   * of the app from re-rendering, and a selector can only compare a number by identity.
   */
  liveInputTokens: number
  liveOutputTokens: number
}

/**
 * Shared so an absent chat selects the same object every time.
 *
 * A fresh `{ messages: [] }` per call would be a new reference on every render, and
 * every component selecting from it would re-render forever.
 */
const EMPTY_CHAT: ChatRuntime = {
  messages: [],
  streaming: null,
  agentState: 'idle',
  activeStep: null,
  turnStartedAt: null,
  liveInputTokens: 0,
  liveOutputTokens: 0
}

/** The conversation on screen. */
export function activeChat(state: AppState): ChatRuntime {
  return (state.session && state.chats[state.session.id]) || EMPTY_CHAT
}

/**
 * How far back the note trail remembers.
 *
 * Deep enough to retrace a session's wandering, shallow enough that it is not a second copy
 * of the vault's history sitting in memory for the life of the window.
 */
const NODE_TRAIL_LIMIT = 40

const PULSE_RETENTION_MS = 1200

/** Gap between one node lighting up and the next, when a search returns several. */
const PROBE_STEP_MS = 70
/** The whole sweep, however many nodes came back. */
const PROBE_SWEEP_MS = 900

/**
 * Drops pulses that have finished, including ones still waiting their turn.
 *
 * A staggered pulse is scheduled in the future, so "old" is measured against when
 * it will fire rather than when it was queued — otherwise the tail of a long sweep
 * would be swept away before it ever appeared.
 */
function livePulses(
  pulses: { id: string; at: number; kind: 'change' | 'probe' }[]
): { id: string; at: number; kind: 'change' | 'probe' }[] {
  const now = performance.now()
  return pulses.filter((pulse) => pulse.at + PULSE_RETENTION_MS > now)
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  bootstrap: null,
  engine: null,
  settings: null,

  graph: { nodes: [], edges: [], stamp: 0 },
  nodeTrail: [],
  stats: null,
  pulses: [],
  focusRequest: null,
  probeLabel: null,

  selectedNodeId: null,
  panel: 'chat',
  openToolId: null,

  session: null,
  sessions: [],
  chats: {},
  runningSessionIds: [],
  capability: 'curate',
  genui: {},
  lastTurnCost: null,
  budget: null,
  usage: null,

  activity: [],
  suggestions: [],
  tools: [],
  questions: [],

  async init() {
    const bootstrap = await api.bootstrap()

    set({
      bootstrap,
      settings: bootstrap.settings,
      stats: bootstrap.stats,
      session: bootstrap.session,
      capability: bootstrap.settings.defaultCapability,
      budget: bootstrap.budget,
      ready: true
    })

    document.documentElement.classList.toggle('dark', bootstrap.settings.appearance.theme !== 'light')

    await Promise.all([
      get().refreshGraph(),
      get().refreshSessions(),
      get().refreshSuggestions(),
      get().refreshActivity(),
      get().refreshUsage(),
      get().refreshTools()
    ])

    const messages = await api.getMessages(bootstrap.session.id)
    set((current) => ({
      chats: patchChat(current.chats, bootstrap.session.id, { messages })
    }))
    await hydrateGenUi(messages, set)

    configureSound(bootstrap.settings.sound)

    wireEvents(set, get)

    // A notification clicked while the app was closed. Done after wireEvents so the
    // chat is already listening for the turn's events by the time it opens.
    if (bootstrap.pendingToolReveal) {
      // A tool's run, so the tool opens rather than the archived chat behind it. Checked
      // first: the two are mutually exclusive in main, and preferring the chat would show
      // the plumbing to somebody who pressed a button in an interface.
      set({ panel: 'tools', openToolId: bootstrap.pendingToolReveal })
    } else if (bootstrap.pendingReveal) {
      await get().switchSession(bootstrap.pendingReveal)
      set({ panel: 'chat', openToolId: null })
    }
  },

  async refreshGraph() {
    const [graph, stats] = await Promise.all([api.getGraph(), api.getStats()])
    set({ graph, stats })
  },

  async refreshSuggestions() {
    set({ suggestions: await api.getSuggestions('pending') })
  },

  async refreshActivity() {
    set({ activity: await api.getActivity({ limit: 120 }) })
  },

  async refreshSessions() {
    set({ sessions: await api.listSessions() })
  },

  async refreshBudget() {
    set({ budget: await api.budgetStatus() })
  },

  async refreshTools() {
    set({ tools: await api.listTools() })
  },

  /**
   * Running a saved tool is just a normal turn with the template filled in —
   * there is no second execution path, so anything the agent can do in chat a
   * tool can do too.
   */
  async runTool(tool, values) {
    try {
      const { prompt } = await api.renderTool(tool.id, values)
      set({ panel: 'chat', openToolId: null })
      // Tagged as a tool run so the chat shows it as an invocation with its own
      // output surface rather than as a prompt the user typed.
      await get().sendMessage(prompt, {
        toolRun: { toolId: tool.id, toolName: tool.name, icon: tool.icon, values }
      })
      await get().refreshTools()
    } catch (err) {
      toast.error(`Could not run "${tool.name}"`, { description: errorMessage(err) })
    }
  },

  async answerQuestion(id, answer) {
    // Cleared locally straight away: the card should not sit there looking
    // unanswered while the round trip completes.
    set((state) => ({ questions: state.questions.filter((question) => question.id !== id) }))
    await api.answerQuestion(id, answer)
  },

  async refreshUsage() {
    try {
      set({ usage: await api.usage() })
    } catch {
      // Reconstructing usage reads other files on disk; a failure there should
      // never take the app down with it.
    }
  },

  setPanel: (panel) => set({ panel }),

  setEngine: (engine) => set({ engine }),

  openTool: (toolId) => set({ openToolId: toolId }),
  closeTool: () => set({ openToolId: null }),

  selectNode: (id) => set({ selectedNodeId: id }),

  openNode: (id) =>
    set((state) => ({
      selectedNodeId: id,
      panel: 'note',
      // Only a real move is remembered. Opening the note already open would otherwise fill
      // the trail with the same id, and Back would appear to do nothing several times over.
      nodeTrail:
        state.selectedNodeId && state.selectedNodeId !== id
          ? [...state.nodeTrail, state.selectedNodeId].slice(-NODE_TRAIL_LIMIT)
          : state.nodeTrail
    })),

  goBackNode: () =>
    set((state) => {
      // Popped until something still in the graph turns up. A note followed and then trashed
      // leaves an id behind, and going back to a note that no longer exists would show an
      // empty panel with no way to explain itself.
      const present = new Set(state.graph.nodes.map((node) => node.id))
      const trail = [...state.nodeTrail]
      while (trail.length > 0) {
        const previous = trail.pop()
        if (previous && present.has(previous)) {
          return { nodeTrail: trail, selectedNodeId: previous, panel: 'note' as const }
        }
      }
      return { nodeTrail: trail }
    }),

  focusNodes: (ids, note = null) =>
    set({ focusRequest: { ids, note, stamp: Date.now() } }),

  /**
   * The way out of a focus.
   *
   * There was none. `focusRequest` was write-only, and since a focus puts every node
   * outside it at a fifth of its opacity, the whole graph stayed washed out for the rest
   * of the session — the state the user described as not being able to get back to
   * unselected. Bound to clicking empty canvas and to Escape.
   */
  clearFocus: () => set({ focusRequest: null, probeLabel: null }),

  async sendMessage(text, extra) {
    const trimmed = text.trim()
    // An image on its own is a valid turn — "what is wrong with this?" needs no words.
    if (!trimmed && (extra?.images?.length ?? 0) === 0) return
    const state = get()
    if (!state.session) return
    if (!state.bootstrap?.agent.available) {
      toast.error('Claude CLI not found', {
        description: 'Install Claude Code and make sure `claude` is on your PATH.'
      })
      return
    }

    // Checked here as well as in the main process, so the user gets a clear
    // message instead of a rejected call.
    if (state.budget?.blocked) {
      toast.error("Today's usage cap has been reached", {
        description: `${state.budget.spentToday.toFixed(2)} of ${state.budget.dailyLimitUsd.toFixed(2)} used. Raise the cap in Settings to continue.`
      })
      return
    }

    // The note the user has open is context the agent should assume, so it goes
    // along with the turn rather than making them restate it.
    const openNode =
      state.panel === 'note' && state.selectedNodeId
        ? state.graph.nodes.find((n) => n.id === state.selectedNodeId)
        : null

    set((current) => ({
      chats: patchChat(current.chats, state.session!.id, { agentState: 'starting' }),
      runningSessionIds: runningIds(
        patchChat(current.chats, state.session!.id, { agentState: 'starting' }),
        current.runningSessionIds
      ),
      lastTurnCost: null
    }))

    try {
      await api.send({
        text: trimmed,
        sessionId: state.session.id,
        capability: state.capability,
        images: extra?.images,
        context: openNode ? `The user currently has "${openNode.title}" (${openNode.id}) open.` : undefined,
        ...extra
      })
    } catch (err) {
      set((current) => ({
        chats: patchChat(current.chats, state.session!.id, { agentState: 'error' })
      }))
      toast.error('The agent could not start', { description: errorMessage(err) })
    }
  },

  interrupt() {
    const session = get().session
    if (!session) return
    void api.interrupt(session.id)
    // Only this conversation. Anything running elsewhere is someone else's turn.
    set((current) => {
      const chats = patchChat(current.chats, session.id, { agentState: 'idle', streaming: null })
      return { chats, runningSessionIds: runningIds(chats, current.runningSessionIds) }
    })
  },

  async newSession() {
    const session = await api.createSession()
    // The other conversations are left exactly as they are, including any mid-turn.
    set((current) => ({
      session,
      chats: patchChat(current.chats, session.id, EMPTY_CHAT),
      lastTurnCost: null
    }))
    await get().refreshSessions()
  },

  async switchSession(id) {
    const session = await api.getSession(id)
    if (!session) return

    const capability = await api.getCapability(id)
    const known = get().chats[id]

    // A chat already in flight keeps everything it has — its messages, its streamed
    // text so far, and the fact that it is still working. Re-reading it from disk
    // would replace a live turn with the last saved state and lose the stream.
    if (known && known.agentState !== 'idle') {
      set({ session, capability })
      return
    }

    const messages = await api.getMessages(id)
    set((current) => ({
      session,
      capability,
      chats: patchChat(current.chats, id, {
        messages,
        streaming: null,
        agentState: 'idle',
        activeStep: null
      })
    }))
    await hydrateGenUi(messages, set)
  },

  async setCapability(capability) {
    const session = get().session
    if (!session) return
    await api.setCapability({ sessionId: session.id, capability })
    set({ capability })
  },

  async applySuggestion(id) {
    const result = await api.applySuggestion(id)
    if (!result.ok) {
      toast.error('Could not apply', { description: result.message })
      return
    }
    await Promise.all([get().refreshSuggestions(), get().refreshGraph()])
  },

  async dismissSuggestion(id) {
    await api.dismissSuggestion(id)
    await get().refreshSuggestions()
  },

  async updateSettings(patch) {
    const settings = await api.updateSettings(patch)
    set({ settings })
    configureSound(settings.sound)
    if (patch.appearance?.theme) {
      document.documentElement.classList.toggle('dark', patch.appearance.theme !== 'light')
    }
  }
}))

/* ------------------------------------------------------------------ helpers */

type Setter = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void

/** Load the specs referenced by any genui blocks in a message list. */
async function hydrateGenUi(messages: ChatMessage[], set: Setter): Promise<void> {
  const ids = messages.flatMap((message) =>
    message.blocks.filter((block) => block.type === 'genui').map((block) => block.specId)
  )
  if (ids.length === 0) return

  const entries = await Promise.all(
    ids.map(async (id) => [id, await api.getGenUi(id)] as const)
  )

  set((state) => ({
    genui: {
      ...state.genui,
      ...Object.fromEntries(entries.filter((entry): entry is [string, GenUiSpec] => entry[1] !== null))
    }
  }))
}

/** Cleared and re-armed by each probe, so only the newest caption is on a clock. */
let probeCaptionTimer: ReturnType<typeof setTimeout> | null = null

function wireEvents(set: Setter, get: () => AppState): void {
  onEvent('graph:changed', () => {
    void get().refreshGraph()
  })

  onEvent('node:changed', ({ id }) => {
    set((state) => ({
      // Trim old pulses here rather than on a timer, so nothing keeps the
      // render loop awake once the graph has gone quiet.
      pulses: [...livePulses(state.pulses), { id, at: performance.now(), kind: 'change' }]
    }))
  })

  /**
   * The agent read these, so the graph shows it.
   *
   * Staggered by rank: the best match lights first and the rest follow, which is
   * what makes it read as looking through the graph rather than as a result set
   * appearing. The whole sweep is kept short enough that it never gets in the way
   * of the answer arriving.
   */
  onEvent('graph:probe', ({ nodeIds, label }) => {
    // The caption outlives the sweep it describes by design — long enough to read — but it
    // had no expiry at all, so "Looking for <last week's query>" reappeared whenever the
    // graph area was remounted, and an unlabelled probe ran under the previous one's
    // caption. Held here rather than in the component because the component can be
    // unmounted mid-sweep and would take its timer with it.
    if (probeCaptionTimer !== null) clearTimeout(probeCaptionTimer)
    probeCaptionTimer = setTimeout(() => {
      probeCaptionTimer = null
      set({ probeLabel: null })
    }, PROBE_SWEEP_MS + 2600)

    const now = performance.now()
    const step = Math.min(PROBE_STEP_MS, PROBE_SWEEP_MS / Math.max(1, nodeIds.length))

    set((state) => ({
      pulses: [
        ...livePulses(state.pulses),
        ...nodeIds.map((id, rank) => ({ id, at: now + rank * step, kind: 'probe' as const }))
      ],
      probeLabel: label ? { text: label, at: Date.now() } : state.probeLabel
    }))
  })

  onEvent('graph:focus', ({ nodeIds, note }) => {
    set({ focusRequest: { ids: nodeIds, note, stamp: Date.now() } })
  })

  onEvent('activity:new', (entry) => {
    set((state) => ({ activity: [entry, ...state.activity].slice(0, 200) }))
  })

  onEvent('suggestion:new', (suggestion) => {
    set((state) => ({ suggestions: [suggestion, ...state.suggestions] }))
  })

  onEvent('suggestions:changed', () => {
    void get().refreshSuggestions()
  })

  onEvent('settings:changed', (settings) => {
    set({ settings })
    // The volume and the on/off live inside cuelume, so they have to be pushed rather than
    // read at play time — otherwise turning sound off in one window leaves it on in another.
    configureSound(settings.sound)
  })

  onEvent('tools:changed', () => {
    void get().refreshTools()
  })

  onEvent('tools:activate', ({ toolId }) => {
    // Summoned by its global shortcut. The tool decides whether it lives in a
    // window; if it does, the main process opened it and this never fires.
    set({ openToolId: toolId })
  })

  onEvent('chat:reveal', ({ sessionId }) => {
    // A notification was clicked. The chat may belong to a scheduled run, which is
    // archived and so absent from the recent list — that is deliberate and it stays
    // that way: switchSession opens a session by id and does not need it listed.
    void (async () => {
      await get().switchSession(sessionId)
      await get().refreshSessions()
      set({ panel: 'chat', openToolId: null })
    })()
  })

  onEvent('chat:question', (question) => {
    cue('question')
    set((state) => {
      // Keyed by id, because the same question can arrive twice: the event is broadcast to
      // every window, and a tool's popped-out window subscribes to it on its own account as
      // well. Appended blindly, the user saw the same question card twice with the same
      // buttons — and answering one left the other on screen.
      if (state.questions.some((existing) => existing.id === question.id)) return state
      return { questions: [...state.questions, question] }
    })
  })

  onEvent('chat:questionResolved', ({ id }) => {
    set((state) => ({ questions: state.questions.filter((question) => question.id !== id) }))
  })

  onEvent('genui:new', ({ specId, spec }) => {
    set((state) => ({ genui: { ...state.genui, [specId]: spec } }))
  })

  onEvent('curator:pass', (report) => {
    if (report.linksAdded > 0 || report.suggestionsCreated > 0) {
      void get().refreshSuggestions()
    }
  })

  onEvent('agent:event', (raw) => {
    const event = raw as AgentEvent
    // Deliberately not filtered by the session on screen. Filtering here is what made
    // switching chats look like cancelling one: the turn kept running in the main
    // process while every event about it was thrown away.
    const id = event.sessionId
    const isActive = get().session?.id === id

    /** File a change under this event's own conversation. */
    const patch = (
      change: Partial<ChatRuntime> | ((current: ChatRuntime) => Partial<ChatRuntime>)
    ): void =>
      set((current) => {
        const chats = patchChat(current.chats, id, change)
        return { chats, runningSessionIds: runningIds(chats, current.runningSessionIds) }
      })

    switch (event.type) {
      case 'state':
        patch((chat) => ({
          agentState: event.state,
          // A turn that began without a `usage` frame yet still needs a start time — and a
          // scheduled run reaches the renderer only through this event, never through
          // `sendMessage`. Left null, its meter would show nothing at all.
          turnStartedAt:
            event.state === 'idle' ? null : (chat.turnStartedAt ?? Date.now())
        }))
        break

      case 'usage':
        patch({ liveInputTokens: event.inputTokens, liveOutputTokens: event.outputTokens })
        break

      case 'delta': {
        patch((chat) => {
          const streaming: StreamingMessage =
            chat.streaming?.id === event.messageId
              ? { ...chat.streaming }
              : { id: event.messageId, text: '', thinking: '' }

          if (event.kind === 'text') streaming.text += event.text
          else streaming.thinking += event.text

          return { streaming }
        })
        break
      }

      case 'message': {
        patch((chat) => {
          const existing = chat.messages.findIndex((m) => m.id === event.message.id)
          const messages =
            existing >= 0
              ? chat.messages.map((m, i) => (i === existing ? event.message : m))
              : [...chat.messages, event.message]

          // A finalised message clears the buffer it came from — either the one
          // with its id, or the one it explicitly says it replaced. Without the
          // second case a buffer whose text had already been folded into the saved
          // message kept rendering next to it, showing the same paragraph twice.
          const superseded =
            chat.streaming !== null &&
            (chat.streaming.id === event.message.id || chat.streaming.id === event.supersedes)

          return { messages, streaming: superseded ? null : chat.streaming }
        })
        break
      }

      case 'tool-start': {
        patch({ activeStep: friendlyToolLabel(event.name) })
        break
      }

      case 'tool-end': {
        patch((chat) => ({
          messages: chat.messages.map((message) => ({
            ...message,
            blocks: message.blocks.map((block) =>
              block.type === 'tool' && block.id === event.id
                ? { ...block, status: event.status, result: event.result }
                : block
            )
          }))
        }))
        break
      }

      case 'result': {
        patch({
          agentState: 'idle',
          streaming: null,
          activeStep: null,
          turnStartedAt: null,
          liveInputTokens: 0,
          liveOutputTokens: 0
        })
        // Cost is a property of the turn the user is watching, not of every turn in
        // flight — a background task finishing must not relabel what this one spent.
        if (isActive) {
          set({ lastTurnCost: event.costUsd })
          // Only the chat on screen, and only with focus — `cue` enforces the second. A
          // background task finishing must not chirp about a conversation the user cannot see.
          cue(event.isError ? 'error' : 'reply')
        }
        void get().refreshSessions()
        // Keep the readouts honest immediately after every turn.
        void get().refreshBudget()
        void get().refreshUsage()
        break
      }

      case 'error': {
        patch({
          agentState: 'error',
          streaming: null,
          turnStartedAt: null,
          liveInputTokens: 0,
          liveOutputTokens: 0
        })
        // Only for the chat being looked at. A toast about a scheduled run that
        // failed at 3am, surfaced over whatever the user is doing now, is noise —
        // the Scheduled tab records it as the task's last outcome instead.
        if (isActive) {
          toast.error('The agent hit a problem', { description: event.message })
          cue('error')
        }
        break
      }
    }
  })
}

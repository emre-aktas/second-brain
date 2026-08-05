import { create } from 'zustand'
import type {
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

export type Panel = 'chat' | 'note' | 'tools' | 'activity' | 'integrations' | 'settings'

/** Text streaming in for a message that has not been finalised yet. */
interface StreamingMessage {
  id: string
  text: string
  thinking: string
}

interface AppState {
  ready: boolean
  bootstrap: BootstrapPayload | null
  settings: Settings | null

  graph: GraphSnapshot
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
  messages: ChatMessage[]
  streaming: StreamingMessage | null
  agentState: AgentState
  /** Friendly label for whatever the agent is doing right now. */
  activeStep: string | null
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
  openTool: (toolId: string) => void
  closeTool: () => void
  selectNode: (id: string | null) => void
  openNode: (id: string) => void
  focusNodes: (ids: string[], note?: string | null) => void

  sendMessage: (text: string, extra?: Partial<AgentTurnOptions>) => Promise<void>
  interrupt: () => void
  newSession: () => Promise<void>
  switchSession: (id: string) => Promise<void>
  setCapability: (capability: AgentCapability) => Promise<void>

  applySuggestion: (id: string) => Promise<void>
  dismissSuggestion: (id: string) => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
}

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
  settings: null,

  graph: { nodes: [], edges: [], stamp: 0 },
  stats: null,
  pulses: [],
  focusRequest: null,
  probeLabel: null,

  selectedNodeId: null,
  panel: 'chat',
  openToolId: null,

  session: null,
  sessions: [],
  messages: [],
  streaming: null,
  agentState: 'idle',
  activeStep: null,
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
    set({ messages })
    await hydrateGenUi(messages, set)

    wireEvents(set, get)
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

  openTool: (toolId) => set({ openToolId: toolId }),
  closeTool: () => set({ openToolId: null }),

  selectNode: (id) => set({ selectedNodeId: id }),

  openNode: (id) => set({ selectedNodeId: id, panel: 'note' }),

  focusNodes: (ids, note = null) =>
    set({ focusRequest: { ids, note, stamp: Date.now() } }),

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

    set({ agentState: 'starting', lastTurnCost: null })

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
      set({ agentState: 'error' })
      toast.error('The agent could not start', { description: errorMessage(err) })
    }
  },

  interrupt() {
    const session = get().session
    if (!session) return
    void api.interrupt(session.id)
    set({ agentState: 'idle', streaming: null })
  },

  async newSession() {
    const session = await api.createSession()
    set({ session, messages: [], streaming: null, agentState: 'idle', lastTurnCost: null })
    await get().refreshSessions()
  },

  async switchSession(id) {
    const session = await api.getSession(id)
    if (!session) return
    const messages = await api.getMessages(id)
    const capability = await api.getCapability(id)
    set({ session, messages, streaming: null, agentState: 'idle', capability })
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

  onEvent('settings:changed', (settings) => set({ settings }))

  onEvent('tools:changed', () => {
    void get().refreshTools()
  })

  onEvent('tools:activate', ({ toolId }) => {
    // Summoned by its global shortcut. The tool decides whether it lives in a
    // window; if it does, the main process opened it and this never fires.
    set({ openToolId: toolId })
  })

  onEvent('chat:question', (question) => {
    set((state) => ({ questions: [...state.questions, question] }))
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
    const state = get()
    if (!state.session || event.sessionId !== state.session.id) return

    switch (event.type) {
      case 'state':
        set({ agentState: event.state })
        break

      case 'delta': {
        set((current) => {
          const streaming: StreamingMessage =
            current.streaming?.id === event.messageId
              ? { ...current.streaming }
              : { id: event.messageId, text: '', thinking: '' }

          if (event.kind === 'text') streaming.text += event.text
          else streaming.thinking += event.text

          return { streaming }
        })
        break
      }

      case 'message': {
        set((current) => {
          const existing = current.messages.findIndex((m) => m.id === event.message.id)
          const messages =
            existing >= 0
              ? current.messages.map((m, i) => (i === existing ? event.message : m))
              : [...current.messages, event.message]

          // A finalised message clears the buffer it came from — either the one
          // with its id, or the one it explicitly says it replaced. Without the
          // second case a buffer whose text had already been folded into the saved
          // message kept rendering next to it, showing the same paragraph twice.
          const superseded =
            current.streaming !== null &&
            (current.streaming.id === event.message.id ||
              current.streaming.id === event.supersedes)

          return { messages, streaming: superseded ? null : current.streaming }
        })
        break
      }

      case 'tool-start': {
        set({ activeStep: friendlyToolLabel(event.name) })
        break
      }

      case 'tool-end': {
        set((current) => ({
          messages: current.messages.map((message) => ({
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
        set({ agentState: 'idle', streaming: null, activeStep: null, lastTurnCost: event.costUsd })
        void get().refreshSessions()
        // Keep the readouts honest immediately after every turn.
        void get().refreshBudget()
        void get().refreshUsage()
        break
      }

      case 'error': {
        set({ agentState: 'error', streaming: null })
        toast.error('The agent hit a problem', { description: event.message })
        break
      }
    }
  })
}

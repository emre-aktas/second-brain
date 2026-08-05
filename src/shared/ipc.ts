import type {
  ActivityEntry,
  AgentCapability,
  AgentEffort,
  AgentTurnOptions,
  BrainEdge,
  BrainNode,
  ChatMessage,
  ChatSession,
  EdgeKind,
  GraphSnapshot,
  GraphStats,
  IntegrationRecord,
  IntegrationTool,
  NeighborhoodResult,
  NodeKind,
  DeepPartial,
  SavedTool,
  InboxEntry,
  ScheduledTask,
  TaskRun,
  TaskRunResult,
  Settings,
  Suggestion,
  WorkspaceInfo
} from './types'
import type { GenUiSpec } from './genui'

/**
 * The single source of truth for the main/renderer boundary.
 *
 * `ApiMap` is consumed by both sides: the main process builds a handler table
 * keyed by these channels, and the renderer builds its client from the same
 * types. Adding a channel without implementing it, or calling one with the wrong
 * payload, is a compile error rather than a runtime surprise.
 */

export interface SearchHitDto {
  node: BrainNode
  score: number
  excerpt: string
}

export interface IndexReportDto {
  scanned: number
  created: number
  updated: number
  unchanged: number
  removed: number
  edges: number
  stubs: number
  tags: number
  durationMs: number
}

export interface AgentStatus {
  available: boolean
  binaryPath: string | null
  version: string | null
  model: string
  /** Which account the CLI is signed in as, so the user can see what is paying. */
  auth: {
    loggedIn: boolean
    authMethod: string | null
    email: string | null
    organisation: string | null
    subscriptionType: string | null
    /** True when running on a Claude subscription rather than metered API credits. */
    onSubscription: boolean
  } | null
}

export interface ToolShortcutStateDto {
  toolId: string
  accelerator: string
  /** False when another application already owns the combination. */
  registered: boolean
}

export interface AccountServerDto {
  name: string
  target: string
  status: 'connected' | 'needs-auth' | 'pending' | 'failed' | 'unknown'
}

/** A question the agent asked, waiting on the user inside a running turn. */
export interface PendingQuestion {
  id: string
  sessionId: string
  question: string
  options: string[]
  allowFreeText: boolean
  askedAt: number
}

export interface UsageBucketDto {
  percent: number
  /** Reset time exactly as the CLI phrases it, e.g. "Aug 4, 8:39pm". */
  resetsAt: string | null
}

export interface UsageSnapshotDto {
  available: boolean
  onSubscription: boolean
  /** The rolling 5-hour window. */
  session: UsageBucketDto | null
  week: UsageBucketDto | null
  weekByModel: { model: string; percent: number }[]
  caveat: string | null
  computedAt: number
  rateLimit: { message: string; at: number; resetsAt: number | null } | null
}

export interface BudgetStatus {
  /** True when caps are actually being enforced right now. */
  enabled: boolean
  /** True when the CLI is on a Claude plan rather than metered API credits. */
  onSubscription: boolean
  spentToday: number
  dailyLimitUsd: number
  perTurnLimitUsd: number
  /** Null when no cap is configured. */
  remaining: number | null
  blocked: boolean
}

export interface BootstrapPayload {
  /**
   * A chat to open immediately, from a notification clicked before any window existed.
   * Cleared as it is read, so it cannot replay on a later launch.
   */
  pendingReveal: string | null
  budget: BudgetStatus
  workspace: WorkspaceInfo
  settings: Settings
  stats: GraphStats
  agent: AgentStatus
  session: ChatSession
  secretsEncrypted: boolean
  webhookBaseUrl: string
  appVersion: string
}

export interface CreateNoteDto {
  title: string
  body: string
  tags?: string[]
  kind?: NodeKind
  folder?: string
}

export interface UpdateNoteDto {
  ref: string
  body?: string
  title?: string
  tags?: string[]
  summary?: string | null
  mode?: 'replace' | 'append' | 'prepend'
}

export interface CuratorReportDto {
  ranAt: number
  durationMs: number
  notesConsidered: number
  linksAdded: number
  suggestionsCreated: number
  /** Notes that reached their stated expiry and were moved to the trash. */
  expiredRemoved: number
  agentAsked: boolean
  skippedReason?: string
}

export interface PresetDto {
  id: string
  name: string
  description: string
  icon?: string
}

export interface SecretRefDto {
  ref: string
  encrypted: boolean
  updatedAt: number
}

export interface ApiMap {
  /* system */
  'app:bootstrap': (payload: void) => BootstrapPayload
  'app:settings:get': (payload: void) => Settings
  'app:settings:update': (payload: DeepPartial<Settings>) => Settings
  'app:openWorkspace': (payload: void) => void
  'app:chooseWorkspace': (payload: void) => string | null
  'app:reindex': (payload: void) => IndexReportDto
  'app:userActivity': (payload: void) => void
  'app:openExternal': (payload: { url: string }) => void

  /* graph and notes */
  'graph:get': (payload: void) => GraphSnapshot
  'graph:stats': (payload: void) => GraphStats
  'graph:savePositions': (payload: {
    positions: { id: string; x: number; y: number; z: number }[]
  }) => void
  'graph:neighborhood': (payload: { id: string; depth?: number }) => NeighborhoodResult
  'node:get': (payload: { id: string }) => BrainNode | null
  'node:edges': (payload: { id: string }) => BrainEdge[]
  'node:search': (payload: { query: string; limit?: number; includeVirtual?: boolean }) => SearchHitDto[]
  'node:create': (payload: CreateNoteDto) => BrainNode
  'node:update': (payload: UpdateNoteDto) => BrainNode
  'node:trash': (payload: { ref: string }) => { id: string; trashPath: string }
  'node:setPinned': (payload: { id: string; pinned: boolean }) => void
  'node:link': (payload: { from: string; to: string; kind?: EdgeKind; label?: string }) => BrainEdge
  'node:unlink': (payload: { from: string; to: string; kind?: EdgeKind }) => number
  'node:reveal': (payload: { id: string }) => void
  'node:recent': (payload: { limit?: number }) => BrainNode[]

  /* activity and suggestions */
  'activity:list': (payload: {
    sinceHours?: number
    kinds?: string[]
    limit?: number
  }) => ActivityEntry[]
  'activity:daily': (payload: { days?: number }) => { day: string; count: number }[]
  'suggestions:list': (payload: { status?: 'pending' | 'all' }) => Suggestion[]
  'suggestions:apply': (payload: { id: string }) => { ok: boolean; message: string }
  'suggestions:dismiss': (payload: { id: string }) => void
  'curator:run': (payload: void) => CuratorReportDto

  /* chat */
  'chat:sessions': (payload: void) => ChatSession[]
  'chat:session': (payload: { id: string }) => ChatSession | null
  'chat:createSession': (payload: void) => ChatSession
  'chat:renameSession': (payload: { id: string; title: string }) => void
  'chat:deleteSession': (payload: { id: string }) => void
  'chat:messages': (payload: { sessionId: string }) => ChatMessage[]
  'chat:genui': (payload: { id: string }) => GenUiSpec | null
  'chat:send': (payload: { text: string } & AgentTurnOptions) => { sessionId: string }
  'chat:interrupt': (payload: { sessionId: string }) => void
  'chat:setCapability': (payload: { sessionId: string; capability: AgentCapability }) => void
  'chat:capability': (payload: { sessionId: string }) => AgentCapability
  'agent:status': (payload: void) => AgentStatus
  'agent:budget': (payload: void) => BudgetStatus
  'usage:get': (payload: void) => UsageSnapshotDto

  /* saved tools */
  /* ------------------------------------------------------- scheduled tasks */

  'tasks:list': (payload: void) => ScheduledTask[]
  'tasks:save': (payload: {
    id?: string
    name: string
    prompt: string
    schedule: unknown
    enabled?: boolean
    capability?: AgentCapability
  }) => ScheduledTask
  'tasks:setEnabled': (payload: { id: string; enabled: boolean }) => ScheduledTask | null
  'tasks:remove': (payload: { id: string }) => void
  /** Run it now regardless of its schedule. Resolves once the turn has settled. */
  'tasks:runNow': (payload: { id: string }) => TaskRunResult
  /** The chat a task's newest run wrote into, so the Scheduled tab can open it. */
  'tasks:openSession': (payload: { id: string }) => { sessionId: string | null }
  /** A task's run history, newest first. */
  'tasks:runs': (payload: { id: string; limit?: number }) => TaskRun[]

  /* ---------------------------------------------------------------- the inbox */

  'inbox:list': (payload: void) => { entries: InboxEntry[]; unread: number }
  /** One entry, or everything when `id` is absent. */
  'inbox:read': (payload: { id?: string }) => { unread: number }

  'tools:list': (payload: void) => SavedTool[]
  'tools:setPinned': (payload: { id: string; pinned: boolean }) => void
  'tools:remove': (payload: { id: string }) => void
  'tools:reorder': (payload: { ids: string[] }) => void
  'tools:render': (payload: { id: string; values: Record<string, string> }) => { prompt: string }
  'tools:get': (payload: { id: string }) => SavedTool | null
  /** User-side write. Rejected if `rev` is stale, same as the agent's path. */
  'tools:writeState': (payload: {
    id: string
    state: Record<string, unknown>
    rev: number
  }) => { tool: SavedTool; conflict: boolean }
  /**
   * The id of the tool's conversation, creating it if this is the first time.
   *
   * Called before running anything so the window knows which session to listen on.
   * Learning it from the reply to `tools:runAction` was a race: a fast turn could
   * finish before that reply crossed the IPC boundary, and the result event was
   * then filtered out as belonging to nobody.
   */
  'tools:session': (payload: { id: string }) => { sessionId: string }
  /** Send a turn into the tool's own conversation, with its state as context. */
  'tools:ask': (payload: { id: string; text: string }) => { sessionId: string }
  /** Click a button inside a tool. Runs the agent for that one job. */
  'tools:runAction': (payload: {
    id: string
    actionId: string
    inputs: Record<string, string>
  }) => { sessionId: string }
  /** Assign or clear a tool's global shortcut. */
  'tools:setHotkey': (payload: { id: string; hotkey: string | null }) => {
    ok: boolean
    message: string
    tool: SavedTool | null
  }
  'tools:setWindowPrefs': (payload: {
    id: string
    openInWindow?: boolean
    alwaysOnTop?: boolean
  }) => SavedTool | null
  /** Model and thinking budget for this tool's turns. Null means the app's setting. */
  'tools:setModelPrefs': (payload: {
    id: string
    model?: string | null
    effort?: AgentEffort | null
  }) => SavedTool | null
  'tools:shortcutStates': (payload: void) => ToolShortcutStateDto[]
  /**
   * A runtime failure inside a code tool's own JavaScript.
   *
   * Kept so the agent can read its mistakes back from inspect_tool and fix them,
   * instead of the user having to describe a blank panel.
   */
  'tools:reportError': (payload: {
    id: string
    message: string
    stack: string | null
    where: string | null
  }) => void

  /* diagnostics */
  /** Everything logged so far, for the log window to render on open. */
  'logs:tail': (payload: { limit?: number }) => LogLine[]
  'logs:clear': (payload: void) => void
  'logs:openWindow': (payload: void) => void
  /** Absolute path of the log file on disk, so it can be opened or shared. */
  'logs:reveal': (payload: void) => void

  /* integrations */
  'integrations:list': (payload: void) => IntegrationRecord[]
  'integrations:tools': (payload: void) => IntegrationTool[]
  'integrations:presets': (payload: void) => PresetDto[]
  'integrations:installPreset': (payload: { id: string }) => IntegrationRecord
  'integrations:setEnabled': (payload: { id: string; enabled: boolean }) => IntegrationRecord
  'integrations:remove': (payload: { id: string }) => void
  'integrations:test': (payload: { id: string }) => { ok: boolean; message: string }
  'integrations:authorize': (payload: { id: string }) => { ok: boolean; message: string }
  'integrations:setSecret': (payload: { ref: string; value: string }) => void
  'integrations:secretRefs': (payload: void) => SecretRefDto[]
  'integrations:call': (payload: {
    id: string
    tool: string
    args: Record<string, unknown>
  }) => { content: string; isError?: boolean }
  /** MCP servers configured on the user's Claude account, read-only. */
  'integrations:accountServers': (payload: void) => AccountServerDto[]

  /** Answer a question the agent asked mid-turn. */
  'chat:answerQuestion': (payload: { id: string; answer: string }) => void

  /* tool windows */
  'window:openTool': (payload: {
    /** One of these: an interactive tool, or a read-only generated view. */
    toolId?: string
    specId?: string
    title: string
    alwaysOnTop?: boolean
  }) => void
  'window:toggleAlwaysOnTop': (payload: void) => boolean
  'window:isAlwaysOnTop': (payload: void) => boolean
  /** A preview window reporting that its tool has finished rendering. */
  'window:previewReady': (payload: void) => void
}

export type ApiChannel = keyof ApiMap
export type ApiPayload<K extends ApiChannel> = Parameters<ApiMap[K]>[0]
export type ApiResult<K extends ApiChannel> = ReturnType<ApiMap[K]>

/** Every invokable channel. The preload bridge rejects anything not listed. */
export const API_CHANNELS: ApiChannel[] = [
  'app:bootstrap',
  'app:settings:get',
  'app:settings:update',
  'app:openWorkspace',
  'app:chooseWorkspace',
  'app:reindex',
  'app:userActivity',
  'app:openExternal',
  'graph:get',
  'graph:stats',
  'graph:savePositions',
  'graph:neighborhood',
  'node:get',
  'node:edges',
  'node:search',
  'node:create',
  'node:update',
  'node:trash',
  'node:setPinned',
  'node:link',
  'node:unlink',
  'node:reveal',
  'node:recent',
  'activity:list',
  'activity:daily',
  'suggestions:list',
  'suggestions:apply',
  'suggestions:dismiss',
  'curator:run',
  'chat:sessions',
  'chat:session',
  'chat:createSession',
  'chat:renameSession',
  'chat:deleteSession',
  'chat:messages',
  'chat:genui',
  'chat:send',
  'chat:interrupt',
  'chat:setCapability',
  'chat:capability',
  'agent:status',
  'agent:budget',
  'usage:get',
  'tasks:list',
  'tasks:save',
  'tasks:setEnabled',
  'tasks:remove',
  'tasks:runNow',
  'tasks:openSession',
  'tasks:runs',
  'inbox:list',
  'inbox:read',
  'tools:list',
  'tools:setPinned',
  'tools:remove',
  'tools:reorder',
  'tools:render',
  'tools:get',
  'tools:writeState',
  'tools:session',
  'tools:ask',
  'tools:runAction',
  'tools:setHotkey',
  'tools:setWindowPrefs',
  'tools:setModelPrefs',
  'tools:shortcutStates',
  'tools:reportError',
  'logs:tail',
  'logs:clear',
  'logs:openWindow',
  'logs:reveal',
  'integrations:list',
  'integrations:tools',
  'integrations:presets',
  'integrations:installPreset',
  'integrations:setEnabled',
  'integrations:remove',
  'integrations:test',
  'integrations:authorize',
  'integrations:setSecret',
  'integrations:secretRefs',
  'integrations:call',
  'integrations:accountServers',
  'chat:answerQuestion',
  'window:openTool',
  'window:toggleAlwaysOnTop',
  'window:isAlwaysOnTop',
  'window:previewReady'
]

/* --------------------------------------------------- main -> renderer events */

export interface EventMap {
  'graph:changed': { reason: string }
  'graph:focus': { nodeIds: string[]; note: string | null; depth: number }
  'node:changed': { id: string; reason: string }
  'activity:new': ActivityEntry
  'suggestion:new': Suggestion
  'suggestions:changed': void
  'settings:changed': Settings
  'integrations:changed': void
  'tools:changed': void
  /** Something landed in the inbox, or was read. */
  'inbox:changed': void
  /** A scheduled task was created, edited, or has just run. */
  'tasks:changed': void
  /**
   * Bring a conversation to the front.
   *
   * Sent when a notification is clicked. The chat may be a task's own, which is
   * archived and therefore not in the recent list — so the renderer has to be told
   * which one rather than being left to guess from what is newest.
   */
  'chat:reveal': { sessionId: string }
  'tools:stateChanged': { toolId: string; rev: number; note: string | null }
  /** A global shortcut fired: open this tool and focus its input. */
  'tools:activate': { toolId: string; focusInput: boolean }
  'tools:focusInput': Record<string, never>
  'chat:question': PendingQuestion
  'chat:questionResolved': { id: string; answer: string }
  'curator:pass': CuratorReportDto
  'genui:new': {
    sessionId: string
    messageId: string | null
    specId: string
    spec: GenUiSpec
  }
  'agent:event': unknown
  /** One line, as it is written. The log window appends these live. */
  'logs:line': LogLine
  /** A background usage read finished. Sent instead of making the caller wait. */
  'usage:changed': UsageSnapshotDto
  /**
   * The agent just read these nodes, in the order it got them back.
   *
   * Distinct from `graph:focus`: that is the agent saying "look here" and moves the
   * camera. This is the graph showing its own work — what was touched while a
   * question was being answered — and it never moves anything.
   */
  'graph:probe': { nodeIds: string[]; label: string | null }
}

export type EventChannel = keyof EventMap

export const EVENT_CHANNELS: EventChannel[] = [
  'graph:changed',
  'graph:focus',
  'node:changed',
  'activity:new',
  'suggestion:new',
  'suggestions:changed',
  'settings:changed',
  'integrations:changed',
  'tools:changed',
  'tasks:changed',
  'inbox:changed',
  'chat:reveal',
  'tools:stateChanged',
  'tools:activate',
  'tools:focusInput',
  'chat:question',
  'chat:questionResolved',
  'curator:pass',
  'genui:new',
  'agent:event',
  'logs:line',
  'usage:changed',
  'graph:probe'
]

/**
 * A log line, flattened for the renderer.
 *
 * Mirrors `LogEntry` in the main process rather than importing it, so the shared
 * layer stays free of main-only modules.
 */
export interface LogLine {
  seq: number
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  extra?: string
}

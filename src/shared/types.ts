import type { Schedule } from './schedule'

/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 * Keep this file free of runtime imports so it can be pulled into any context.
 */

/* ------------------------------------------------------------------ graph */

/**
 * What a node is.
 *
 * The label, colour, icon and guidance for each live in `node-kinds.ts` — one table
 * rather than four lists that drift. `stub` is legacy: migration 2 stopped creating
 * them, and it is kept only so an old row still parses.
 */
export type NodeKind =
  | 'note'
  | 'idea'
  | 'question'
  | 'source'
  | 'tag'
  | 'area'
  | 'project'
  | 'goal'
  | 'person'
  | 'org'
  | 'task'
  | 'decision'
  | 'event'
  | 'meeting'
  | 'log'
  | 'integration'
  | 'stub'

export type EdgeKind = 'link' | 'tag' | 'mention' | 'similar' | 'derived' | 'temporal'

export type EdgeOrigin = 'vault' | 'agent' | 'curator' | 'integration' | 'user'

export interface BrainNode {
  id: string
  kind: NodeKind
  title: string
  /** Vault-relative path, or null for virtual nodes (tags, stubs, entities). */
  path: string | null
  summary: string | null
  body: string
  tags: string[]
  props: Record<string, unknown>
  pinned: boolean
  x: number | null
  y: number | null
  color: string | null
  createdAt: number
  updatedAt: number
  accessedAt: number | null
  contentHash: string | null
  degree: number
  /**
   * When this note stops being worth keeping, or null if it is permanent.
   *
   * Decided when the note is written, because that is the only moment anyone knows:
   * a Slack digest for one Tuesday is landfill by the next, while a note about how
   * someone likes to be briefed is worth keeping forever. Without the distinction
   * the vault silently fills with dated snapshots and the graph gets harder to read
   * every week.
   */
  expiresAt: number | null
}

export interface BrainEdge {
  id: string
  src: string
  dst: string
  kind: EdgeKind
  weight: number
  label: string | null
  origin: EdgeOrigin
  createdAt: number
}

/** Compact node shape sent to the graph renderer — keep it small, there can be thousands. */
export interface GraphNodeLite {
  id: string
  title: string
  kind: NodeKind
  tags: string[]
  degree: number
  x: number | null
  y: number | null
  pinned: boolean
  color: string | null
  updatedAt: number
}

export interface GraphEdgeLite {
  src: string
  dst: string
  kind: EdgeKind
  weight: number
}

export interface GraphSnapshot {
  nodes: GraphNodeLite[]
  edges: GraphEdgeLite[]
  stamp: number
}

export interface GraphStats {
  nodes: number
  edges: number
  notes: number
  tags: number
  stubs: number
  orphans: number
  clusters: number
}

export interface NeighborhoodResult {
  center: string
  nodes: BrainNode[]
  edges: BrainEdge[]
}

/* --------------------------------------------------------------- activity */

export interface ActivityEntry {
  id: number
  ts: number
  kind: string
  actor: string
  nodeId: string | null
  title: string
  detail: Record<string, unknown> | null
}

export type SuggestionKind =
  | 'link'
  | 'merge'
  | 'tag'
  | 'summary'
  | 'split'
  | 'orphan'
  | 'integration'
  | 'note'

export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'applied'

export interface Suggestion {
  id: string
  kind: SuggestionKind
  title: string
  rationale: string
  payload: Record<string, unknown>
  status: SuggestionStatus
  createdAt: number
  resolvedAt: number | null
  /** True when the curator can apply it without asking. */
  autoApplicable: boolean
}

/* ------------------------------------------------------------------- chat */

export interface ToolBlockMeta {
  /** Set when the tool call came from one of our own brain tools. */
  brainTool?: boolean
  integrationId?: string
}

/** An image the user attached to a turn. */
export interface ChatImage {
  mediaType: string
  dataBase64: string
  name?: string
}

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string; name?: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool'
      id: string
      name: string
      input: unknown
      status: 'running' | 'ok' | 'error'
      result?: string
      meta?: ToolBlockMeta
    }
  | { type: 'genui'; specId: string }

export interface ChatMessageMeta {
  costUsd?: number
  durationMs?: number
  model?: string
  numTurns?: number
  isError?: boolean
  /**
   * Set when this turn was started by running a saved tool rather than typed.
   * The chat renders it as a tool invocation with its own output surface instead
   * of showing the generated prompt as if the user had written it.
   */
  toolRun?: {
    toolId: string
    toolName: string
    icon: string | null
    values: Record<string, string>
  }
  /**
   * Set when the scheduler started this turn.
   *
   * Same purpose as `toolRun` and for the same reason: the prompt is generated, often
   * hundreds of words of instructions, and rendering it as a user message shows the
   * user their own app talking to itself. The chat renders a run header instead.
   */
  taskRun?: {
    taskId: string
    taskName: string
    runId: string
  }
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  blocks: ChatBlock[]
  ts: number
  meta?: ChatMessageMeta
}

export interface ChatSession {
  id: string
  claudeSessionId: string | null
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  totalCostUsd: number
}

/** Capability tier a session runs with — controls which built-in claude tools are allowed. */
export type AgentCapability = 'read-only' | 'curate' | 'build'

export interface AgentTurnOptions {
  sessionId?: string
  capability?: AgentCapability
  /** Overrides the app's setting for this turn. A tool can carry its own. */
  model?: string
  effort?: AgentEffort
  /** Hidden context appended to the user's message (e.g. the node they had open). */
  context?: string
  /** Present when a saved tool started this turn. */
  toolRun?: ChatMessageMeta['toolRun']
  /** Present when the scheduler started this turn. */
  taskRun?: ChatMessageMeta['taskRun']
  /** Images to send with this turn. */
  images?: ChatImage[]
  /** Present when a button inside a tool started this turn. */
  toolAction?: {
    toolId: string
    actionId: string
    target: 'output' | 'state'
    label: string
    /** Dot path an `output` action writes to. */
    writeTo?: string
  }
}

export type AgentState = 'idle' | 'starting' | 'thinking' | 'working' | 'error'

export type AgentEvent =
  | { type: 'session'; sessionId: string; claudeSessionId: string; model?: string; tools?: string[] }
  | { type: 'state'; sessionId: string; state: AgentState; detail?: string }
  | { type: 'delta'; sessionId: string; messageId: string; kind: 'text' | 'thinking'; text: string }
  | {
      type: 'message'
      sessionId: string
      message: ChatMessage
      /**
       * A streaming buffer this message replaces, when it is not the one with the
       * same id.
       *
       * Claude can send two frames for one message. The second lands on the id the
       * first was stored under, while text streamed in between is buffered under a
       * new one — so "the finalised message supersedes the buffer with its id" was
       * not enough, and the buffered copy stayed on screen next to the saved one.
       * That is what showed the same paragraph twice mid-turn.
       */
      supersedes?: string | null
    }
  | {
      type: 'tool-start'
      sessionId: string
      messageId: string
      id: string
      name: string
      input: unknown
    }
  | {
      type: 'tool-end'
      sessionId: string
      id: string
      status: 'ok' | 'error'
      result: string
    }
  | {
      type: 'result'
      sessionId: string
      costUsd: number
      durationMs: number
      numTurns: number
      isError: boolean
      /**
       * The turn's final reply. Carried so a tool that ran an action can use it
       * directly — a code tool awaits brain.run and decides itself where the
       * answer goes.
       */
      text: string | null
    }
  | { type: 'error'; sessionId: string; message: string }

/* ----------------------------------------------------------- integrations */

export type IntegrationKind = 'mcp-stdio' | 'mcp-http' | 'rest' | 'script' | 'webhook'

export type AuthSpec =
  | { type: 'none' }
  | { type: 'apiKey'; in: 'header' | 'query'; name: string; secretRef: string }
  | { type: 'bearer'; secretRef: string }
  | { type: 'basic'; secretRef: string }
  | {
      type: 'oauth2'
      authUrl: string
      tokenUrl: string
      clientIdRef: string
      clientSecretRef?: string
      scopes: string[]
      pkce: boolean
      /** Extra params appended to the authorize URL, e.g. access_type=offline for Google. */
      authParams?: Record<string, string>
      /** Where the resulting token bundle is stored in the secret vault. */
      tokenRef: string
    }

export interface ParamSpec {
  name: string
  description?: string
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  default?: string | number | boolean
}

export interface RestOperation {
  name: string
  description: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Supports {placeholders} filled from pathParams. */
  path: string
  pathParams?: ParamSpec[]
  query?: ParamSpec[]
  /** Free-form JSON body; described to the agent as a JSON object argument. */
  bodyParams?: ParamSpec[]
  rawBody?: boolean
  /** Dot path into the response to return, e.g. "messages". */
  resultPath?: string
  /** Marks the operation as having outside-world effects (sending mail, posting). */
  mutating?: boolean
}

export interface IntegrationToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutating?: boolean
}

interface IntegrationCommon {
  id: string
  name: string
  description: string
  icon?: string
  enabled: boolean
  createdBy: 'user' | 'agent' | 'preset'
  version?: string
  /** Secret vault keys this integration expects the user to fill in. */
  requiredSecrets?: { ref: string; label: string; hint?: string }[]
}

export interface McpStdioManifest extends IntegrationCommon {
  kind: 'mcp-stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  /** env keys whose values come from the secret vault: { ENV_NAME: secretRef }. */
  secretEnv?: Record<string, string>
  cwd?: string
}

export interface McpHttpManifest extends IntegrationCommon {
  kind: 'mcp-http'
  url: string
  headers?: Record<string, string>
  /** header name -> secretRef, merged into headers at call time. */
  secretHeaders?: Record<string, string>
}

export interface RestManifest extends IntegrationCommon {
  kind: 'rest'
  baseUrl: string
  auth: AuthSpec
  defaultHeaders?: Record<string, string>
  operations: RestOperation[]
}

export interface ScriptManifest extends IntegrationCommon {
  kind: 'script'
  /** Path relative to the integration's own folder. */
  entry: string
  tools: IntegrationToolSpec[]
  env?: Record<string, string>
  secretEnv?: Record<string, string>
}

export interface WebhookManifest extends IntegrationCommon {
  kind: 'webhook'
  /** Mounted at http://127.0.0.1:<port>/hooks/<path>. */
  path: string
  secretRef?: string
  /** How an inbound payload becomes a note. */
  capture: {
    titleField?: string
    bodyField?: string
    tags?: string[]
    kind?: NodeKind
  }
}

export type IntegrationManifest =
  | McpStdioManifest
  | McpHttpManifest
  | RestManifest
  | ScriptManifest
  | WebhookManifest

export type IntegrationHealth = 'unknown' | 'ok' | 'error' | 'needs-auth' | 'disabled'

export interface IntegrationRecord {
  manifest: IntegrationManifest
  health: IntegrationHealth
  lastError: string | null
  lastCheckedAt: number | null
  toolCount: number
  createdAt: number
  updatedAt: number
}

export interface IntegrationTool {
  integrationId: string
  integrationName: string
  name: string
  qualifiedName: string
  description: string
  inputSchema: Record<string, unknown>
  mutating: boolean
}

/* ------------------------------------------------------------ saved tools */

export interface SavedToolParam {
  name: string
  label: string
  placeholder?: string
  required?: boolean
  /** Prefilled value, so a tool can be one click when the default usually fits. */
  default?: string
  multiline?: boolean
}

/**
 * A repeated task turned into something reusable.
 *
 * The agent writes these: after doing something fiddly once, it can capture the
 * working prompt as a named tool with the variable parts pulled out as
 * parameters. Running one just sends the filled-in prompt as a normal turn, so
 * there is no second execution path to keep working.
 */
/**
 * What kind of surface a tool presents.
 *
 * `prompt` is the original one-shot kind: run it, read the generated view.
 * The others are stateful applications the user edits directly, with the agent
 * working on the same document.
 */
export type ToolKind =
  | 'prompt'
  | 'code'
  | 'canvas'
  | 'kanban'
  | 'table'
  | 'checklist'
  | 'notepad'
  | 'workbench'

/**
 * A node in a tool's layout.
 *
 * `canvas` tools are laid out with these instead of a fixed template, which is
 * what makes a tool genuinely open-ended: the agent chooses the shape of the
 * document *and* the interface over it. Anything that reads or writes uses `bind`,
 * a dot path into the tool's state — so a text field, an output panel and a board
 * are all just views onto the same document.
 */
export type ToolNode =
  /* layout */
  | {
      type: 'stack'
      direction?: 'row' | 'col'
      gap?: number
      wrap?: boolean
      align?: 'start' | 'center' | 'end' | 'stretch'
      justify?: 'start' | 'center' | 'end' | 'between'
      grow?: boolean
      scroll?: boolean
      children: ToolNode[]
    }
  | {
      type: 'grid'
      columns: number
      gap?: number
      grow?: boolean
      /** Cells wrap to another row rather than shrink past this. Default 240. */
      minItemWidth?: number
      children: ToolNode[]
    }
  | {
      type: 'panel'
      title?: string
      tone?: GenUiToneName
      grow?: boolean
      scroll?: boolean
      children: ToolNode[]
    }
  | { type: 'tabs'; grow?: boolean; items: { label: string; children: ToolNode[] }[] }
  | { type: 'divider'; label?: string }
  | { type: 'spacer'; size?: number }

  /* static content — {{path}} in a value is substituted from state */
  | { type: 'text'; value: string; muted?: boolean; size?: 'sm' | 'md' | 'lg' }
  | { type: 'heading'; value: string; level?: 1 | 2 | 3; hint?: string }
  | { type: 'badge'; value: string; tone?: GenUiToneName }
  | { type: 'note'; value: string; tone?: GenUiToneName }

  /* inputs, bound to state */
  | {
      type: 'input'
      bind: string
      label?: string
      placeholder?: string
      multiline?: boolean
      rows?: number
      grow?: boolean
    }
  | { type: 'select'; bind: string; label?: string; options: { value: string; label: string }[] }
  | { type: 'toggle'; bind: string; label?: string }
  | { type: 'slider'; bind: string; label?: string; min?: number; max?: number; step?: number }

  /* actions */
  | {
      type: 'button'
      action: string
      label: string
      icon?: string
      variant?: 'primary' | 'outline' | 'ghost'
      grow?: boolean
    }

  /* outputs */
  | {
      type: 'output'
      bind: string
      label?: string
      /** Show a copy button for just this block. */
      copy?: boolean
      markdown?: boolean
      grow?: boolean
      placeholder?: string
      minHeight?: number
    }

  /* the rich surfaces, embeddable anywhere in a canvas */
  | { type: 'kanban'; bind: string; grow?: boolean }
  | { type: 'table'; bind: string; grow?: boolean }
  | { type: 'checklist'; bind: string; grow?: boolean }

export type GenUiToneName = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

/**
 * A button inside a tool that runs the agent.
 *
 * This is what makes a tool agentic rather than just a form: the user clicks
 * "Casual English" and the agent does that one job against the tool's inputs and
 * document. No typing, no conversation.
 */
export interface ToolAction {
  id: string
  label: string
  icon?: string
  /** Prompt template. {{field}} pulls from inputs; the document is supplied too. */
  prompt: string
  /**
   * `output` writes the agent's reply into the output pane and touches nothing
   * else. `state` lets it rewrite the document instead.
   */
  target: 'output' | 'state'
  /**
   * Where an `output` action's reply lands, as a dot path into state. Defaults to
   * `output`. This is how one canvas shows several results side by side.
   */
  writeTo?: string
  primary?: boolean
  /** Short hint shown under the button. */
  hint?: string
}

/** An input on a workbench tool. */
export interface ToolField {
  name: string
  label: string
  placeholder?: string
  multiline?: boolean
  default?: string
}

export interface WorkbenchState {
  inputs: Record<string, string>
  output: string
  /** Which action produced the current output. */
  lastAction?: string
}

export interface KanbanCard {
  id: string
  title: string
  text?: string
  tags?: string[]
  nodeId?: string
}

export interface KanbanColumn {
  id: string
  title: string
  cards: KanbanCard[]
}

export interface KanbanState {
  columns: KanbanColumn[]
}

export interface TableColumnDef {
  key: string
  label: string
  width?: string
}

export interface TableState {
  columns: TableColumnDef[]
  rows: Record<string, string>[]
}

export interface ChecklistState {
  items: { id: string; label: string; checked: boolean; text?: string }[]
}

export interface NotepadState {
  text: string
}

export type ToolState =
  | KanbanState
  | TableState
  | ChecklistState
  | NotepadState
  | WorkbenchState
  | Record<string, unknown>

export interface SavedTool {
  id: string
  name: string
  description: string
  kind: ToolKind
  /** Standing guidance for the agent that lives inside this tool. */
  instructions: string
  /** The tool's own conversation, so its chat is separate from the main one. */
  sessionId: string | null
  state: ToolState
  /** Buttons that run the agent. Present on any kind. */
  actions: ToolAction[]
  /** Inputs, for workbench tools. */
  fields: ToolField[]
  /** Layout, for canvas tools. Empty for the fixed kinds. */
  layout: ToolNode[]
  /**
   * The interface itself, for `code` tools: HTML with inline CSS and JavaScript,
   * written by the agent and run in a sandboxed frame. This is the open-ended
   * path — a layout tree, however wide its vocabulary, still makes every tool
   * look like the same product.
   */
  source: string
  /** Electron accelerator that opens this tool from anywhere, or null. */
  hotkey: string | null
  /** Open in its own window rather than in the main area. */
  openInWindow: boolean
  /** Keep that window above other applications. */
  alwaysOnTop: boolean
  /**
   * How big its own window was left, so it reopens the way it was.
   *
   * The size a maximised window would return to, not the maximised size — with
   * `windowMaximized` carrying that separately. Null until it has been opened.
   */
  windowWidth: number | null
  windowHeight: number | null
  windowMaximized: boolean
  /**
   * Model and thinking budget for this tool's own turns, or null for the app's.
   *
   * Set per tool because the jobs differ: a phrase rewriter wants the fastest
   * model at low effort so a button press feels instant, while a weekly review
   * wants the opposite and can afford to take its time.
   */
  model: string | null
  effort: AgentEffort | null
  /** Bumped on every write; a write against a stale rev is rejected. */
  rev: number
  /** A lucide icon name. Falls back to a generic one when unknown. */
  icon: string | null
  /** Prompt template; {{param}} placeholders are filled from params. */
  prompt: string
  params: SavedToolParam[]
  pinned: boolean
  sortOrder: number
  createdBy: 'agent' | 'user'
  runCount: number
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
  /** The interface this tool last produced, reopenable without a new turn. */
  lastSpecId: string | null
}

/* --------------------------------------------------------------- settings */

/** Thinking budget passed to the CLI as --effort. */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelOption {
  id: string
  label: string
  hint: string
}

/** Offered in the model picker. Aliases resolve to the latest of each family. */
export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'opus', label: 'Opus 5', hint: 'Deepest reasoning, slowest' },
  { id: 'sonnet', label: 'Sonnet 5', hint: 'The balanced default' },
  { id: 'fable', label: 'Fable 5', hint: 'Tuned for writing' },
  { id: 'haiku', label: 'Haiku 4.5', hint: 'Fastest, cheapest' }
]

export const EFFORT_OPTIONS: { id: AgentEffort; label: string; hint: string }[] = [
  { id: 'low', label: 'Low', hint: 'Answers straight away' },
  { id: 'medium', label: 'Medium', hint: 'Thinks briefly' },
  { id: 'high', label: 'High', hint: 'Thinks before answering' },
  { id: 'xhigh', label: 'Extra high', hint: 'For genuinely hard problems' },
  { id: 'max', label: 'Max', hint: 'No limit on thinking' }
]

export interface Settings {
  workspacePath: string
  model: string
  effort: AgentEffort
  /** Capability tier used for normal chat turns. */
  defaultCapability: AgentCapability
  /**
   * Hard spend ceilings enforced by the app, on top of whatever the signed-in
   * plan allows. The definitive control over credit spend is the organisation's
   * billing settings; this is the layer the app itself can guarantee.
   */
  budget: {
    /**
     * 'auto' applies caps only when the CLI is billing metered API credits —
     * on a subscription there is no per-token charge to cap. 'always' enforces
     * them regardless, 'off' never does.
     */
    mode: 'auto' | 'always' | 'off'
    /** Refuse to start a turn once today's reported usage reaches this. */
    dailyLimitUsd: number
    /** Passed to the CLI as --max-budget-usd, which aborts the turn itself. */
    perTurnLimitUsd: number
  }
  curator: {
    enabled: boolean
    /** Milliseconds of user inactivity before a pass may start. */
    idleMs: number
    /** Minimum gap between passes. */
    intervalMs: number
    /** Let the curator add low-confidence "similar" edges without asking. */
    autoLinkSimilar: boolean
    /** Ask the agent to propose tags/summaries for changed notes. */
    useAgent: boolean
    similarityThreshold: number
  }
  chat: {
    /**
     * Show every tool call and reasoning block inline. Off by default: the
     * interesting output is the answer, and a wall of internal steps buries it.
     * When off, a single progress line stands in for the whole turn and each
     * message keeps an expandable step count.
     */
    showToolActivity: boolean
  }
  graph: {
    showTags: boolean
    showSimilarEdges: boolean
    linkDistance: number
    charge: number
    labelThreshold: number
  }
  appearance: {
    theme: 'dark' | 'light' | 'system'
    accent: string
    reduceMotion: boolean
  }
  /**
   * Work the app starts on its own.
   *
   * One switch over the whole thing, because being checked on by software is not
   * everyone's idea of help — off means no scheduled task runs at all, including
   * the user's own, and the Scheduled tab says so rather than quietly doing nothing.
   */
  proactive: {
    enabled: boolean
    /**
     * The hourly check-in. Separate from `enabled` so the user can keep their own
     * scheduled tasks while turning off the app's unprompted ones.
     */
    heartbeat: boolean
    /** Nothing runs inside this window; a task that comes due waits for the end. */
    quietHours: {
      enabled: boolean
      startHour: number
      endHour: number
    }
  }
  notifications: {
    enabled: boolean
    /** When a reply lands and no window of this app has focus. */
    onReply: boolean
    /** When something the app started on its own has something to say. */
    onProactive: boolean
    /** When the agent is blocked on a question. */
    onQuestion: boolean
  }
}

/* --------------------------------------------------------- scheduled tasks */

export type TaskKind = 'task' | 'heartbeat'
export type TaskStatus = 'ok' | 'error' | 'skipped'

/**
 * Something the app does on its own clock.
 *
 * Two flavours. An ordinary `task` carries a prompt the user (or the agent, on the
 * user's behalf) wrote — "every hour, scan Slack and compile what is new". The single
 * `heartbeat` is the app checking in with itself, and is the one that has to earn its
 * turn: it runs a deterministic pre-check first and spends nothing when nothing has
 * changed.
 */
export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  kind: TaskKind
  schedule: Schedule
  enabled: boolean
  capability: AgentCapability
  model: string | null
  effort: AgentEffort | null
  /** The task's own chat, created on first run so a run never interrupts the user. */
  sessionId: string | null
  createdBy: 'user' | 'agent' | 'system'
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: TaskStatus | null
  lastSummary: string | null
  runCount: number
}

/**
 * One time a scheduled task ran.
 *
 * `status` deliberately has no 'skipped': a skip means the pre-check decided not to
 * spend a turn, so nothing ran and there is nothing to record. Widening it would
 * invite exactly that mistake.
 */
export interface TaskRun {
  id: string
  taskId: string
  /** The run's own chat, or null once that chat has been deleted. */
  sessionId: string | null
  status: 'running' | 'ok' | 'error'
  summary: string
  startedAt: number
  finishedAt: number | null
}

export interface TaskRunResult {
  taskId: string
  status: TaskStatus
  summary: string
  sessionId: string | null
}

/**
 * A patch for a nested settings object.
 *
 * `Partial<Settings>` was too narrow to be true: the main process deep-merges a patch
 * over the current settings, so `{ proactive: { enabled: false } }` has always been
 * valid — but the type demanded every sibling key, which meant a caller changing one
 * checkbox had to restate the other four and risk clobbering one.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

export interface WorkspaceInfo {
  root: string
  vaultDir: string
  integrationsDir: string
  dbPath: string
  trashDir: string
}

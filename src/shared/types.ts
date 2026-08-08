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
  /** Depth. Null until the layout has settled once. */
  z: number | null
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

/**
 * What the agent thinks the user might want next.
 *
 * Offered rather than done. Two things this app can do that a chat cannot — save the work as
 * a reusable tool, or put it on a schedule — and the agent is the only party that knows
 * whether either applies to what just happened. Clicking one sends a message; nothing is
 * created behind the user's back.
 */
export interface TurnFollowups {
  /** The work is worth repeating on demand. */
  tool?: { name: string; why: string }
  /** The work is worth repeating on a clock. */
  schedule?: { name: string; when: string; why: string }
}

export interface ChatMessageMeta {
  costUsd?: number
  durationMs?: number
  /**
   * Tokens the turn spent, input and output.
   *
   * Input includes cache reads and writes, because they are tokens the request carried and
   * they are what the footer's usage windows count. Absent on messages written before this
   * existed, which the reader has to treat as "unknown" rather than as zero.
   */
  inputTokens?: number
  outputTokens?: number
  model?: string
  numTurns?: number
  isError?: boolean
  followups?: TurnFollowups
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
  /**
   * Overrides the app's model and thinking level for this turn, per engine.
   *
   * A saved tool or a scheduled task carries its own; the manager picks the entry belonging to
   * whichever engine is running. One flat `model` here meant a Claude name, so on any other
   * engine the override had to be discarded — which is why the whole map travels instead.
   */
  enginePrefs?: EnginePrefs
  /** Hidden context appended to the user's message (e.g. the node they had open). */
  context?: string
  /** Present when a saved tool started this turn. */
  toolRun?: ChatMessageMeta['toolRun']
  /** Present when the scheduler started this turn. */
  taskRun?: ChatMessageMeta['taskRun']
  /**
   * Nobody is watching this turn.
   *
   * Denies the connector tools that would speak to someone on the user's behalf. The CLI
   * runs with permissions pre-approved because there is no one to answer a prompt, so a
   * background run that can read Slack could otherwise post to it.
   */
  unattended?: boolean
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
  /** Running token total for the turn, as the CLI reports it. Cheap and frequent. */
  | { type: 'usage'; sessionId: string; inputTokens: number; outputTokens: number }
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

/**
 * A per-engine model and thinking level, for the things that can pin their own.
 *
 * Keyed by provider id. Empty means "whatever the app is set to", which is the
 * default and the right one for most tools — the override exists for the few
 * whose job has a different shape from the rest of the app's.
 */
export interface EnginePrefs {
  [providerId: string]: { model?: string; effort?: string }
}

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
   * Model and thinking level for this tool's own turns, per engine.
   *
   * Set per tool because the jobs differ: a phrase rewriter wants the fastest
   * model at low effort so a button press feels instant, while a weekly review
   * wants the opposite and can afford to take its time.
   *
   * Per *engine* because a model name belongs to one provider. This was a single
   * pair of fields holding a Claude name — "opus", "high" — so on any other engine
   * the manager had to discard it, and a tool's carefully chosen fast model quietly
   * became whatever that provider was set to globally. Keyed by provider id like
   * `Settings.engine.models`, a tool set up on Codex keeps its Codex choice and
   * finds its Claude one again on the way back.
   */
  enginePrefs: EnginePrefs
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
  /**
   * Which model engine runs the agent.
   *
   * `model` and `effort` above stay where they are and keep meaning what they meant — the app
   * has one vocabulary for "which model" and "how hard to think", and each engine maps it to
   * its own. That is what lets the engine change without touching a saved tool or a scheduled
   * task: both already carry a model and an effort, and both still mean something afterwards.
   *
   * Nothing about the vault, the chat history, the tools or the schedule lives here. Changing
   * engine changes who answers, and nothing else.
   */
  engine: {
    /** A provider id from `ENGINE_PROVIDERS`, or one the user added. */
    providerId: string
    /** Per provider, so switching back and forth does not lose the model you had chosen. */
    models: Record<string, string>
    /** Overrides the provider's own, for `custom` and for a self-hosted gateway. */
    baseUrls: Record<string, string>
    /**
     * How hard to think, per provider, as that provider names it.
     *
     * A plain string rather than `AgentEffort` because the tiers are not universal: Codex
     * publishes six for its flagship, including `ultra`, which the app's own union does not
     * have and should not grow — it is Codex's vocabulary, not the app's. Empty means "use
     * whatever the engine defaults to", which for Codex is the level in its own config.
     */
    efforts: Record<string, string>
  }
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
    /**
     * Whether node names are drawn at all.
     *
     * A privacy control, not a display preference: the graph is the home screen, so a share, a
     * screenshot or somebody walking past shows every note title at once. Purely a draw
     * parameter — the titles are still in the snapshot, so this hides them from the room rather
     * than from the process, which is exactly what it is for.
     */
    showLabels: boolean
    /** Whether the graph turns on its own. Off leaves the orbit entirely to the user. */
    rotate: boolean
  }
  appearance: {
    theme: 'dark' | 'light' | 'system'
    accent: string
    reduceMotion: boolean
  }
  /**
   * Where the user has put things.
   *
   * Separate from `appearance` because it is not a preference the user chose from a list —
   * it is the shape they dragged the window into, and it should come back the way they left
   * it without being something they have to think of as a setting.
   */
  layout: {
    /** Width of the right-hand panel, in CSS pixels. */
    panelWidth: number
  }
  /**
   * Interaction sounds.
   *
   * Three events only, and only while the window has focus — see `lib/sound.ts` for why
   * that complement is the whole design rather than an optimisation.
   */
  sound: {
    enabled: boolean
    /** 0 to 1. Low by default: this is a cue, not an announcement. */
    volume: number
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
    /**
     * Looking outside the vault — Slack, Grain — during the check-in.
     *
     * On a much longer interval than the vault check, and that is the whole design. A
     * changed note is free to notice, so the hourly gate can answer "nothing" and cost
     * nothing; asking the model to read Slack answers "maybe" every time, so how often it
     * happens *is* what it costs. Only connectors the account actually has are ever named.
     */
    sweep: {
      enabled: boolean
      slack: boolean
      grain: boolean
      clickup: boolean
      /** Hours between sweeps. Four means four turns a day at most from this. */
      everyHours: number
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
  /** Model and thinking level for this task's runs, per engine. See `EnginePrefs`. */
  enginePrefs: EnginePrefs
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

export type InboxKind = 'reply' | 'task' | 'question' | 'tool'

/**
 * One thing the app wanted to tell the user while they were away.
 *
 * Exists because a desktop notification is not a reliable channel — on Windows the click
 * is delivered through a COM registration that a dev run or a portable build may not
 * have — so the toast is an accelerator and this list is the door that always works.
 */
export interface InboxEntry {
  id: string
  /** The chat to open, or null once that chat has been retired. */
  sessionId: string | null
  taskId: string | null
  kind: InboxKind
  title: string
  body: string
  createdAt: number
  readAt: number | null
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

/* ------------------------------------------------------------------- updates */

/**
 * Where this build can get an update from, and whether it can install one itself.
 *
 * Not every packaged copy can. A portable Windows build unpacks itself into a temp
 * directory and runs from there, so there is no installation for an installer to replace;
 * and the macOS build is ad-hoc signed, which Squirrel.Mac refuses to update because it
 * validates the downloaded bundle's signature against the running one and an ad-hoc
 * signature satisfies nothing. Both of those can still be *told* about a new version,
 * which is worth far more than silence — hence 'manual' rather than 'off'.
 *
 * 'off' is a development run: there is no packaged app to replace.
 */
export type UpdateCapability = 'install' | 'manual' | 'off'

/**
 * Deliberately without a 'ready' state.
 *
 * A downloaded-but-not-installed update is a state this app never sits in: the press that
 * starts the download is the press that agreed to the restart, so `installing` follows
 * `downloading` directly. A phase nothing can produce is a branch in every reader that can
 * never be right or wrong.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'error'

/**
 * Everything the renderer needs to draw the update surface, in one object.
 *
 * One object rather than a handful of fields because the phases are exclusive and a
 * renderer holding `downloading` alongside a stale `available` has to decide which it
 * believes. Broadcast whole on every change.
 */
export interface UpdateStatus {
  phase: UpdatePhase
  capability: UpdateCapability
  /** The version running now. */
  currentVersion: string
  /** The version on offer, when there is one. */
  version: string | null
  /** The release's own notes, markdown, as written for the release. */
  notes: string | null
  /** Where a human can read about it, for the builds that cannot install it themselves. */
  releaseUrl: string | null
  /** 0–100 while downloading. */
  percent: number
  /** Bytes per second, so a slow connection reads as slow rather than as stuck. */
  bytesPerSecond: number
  /** When the last check finished, successful or not. */
  checkedAt: number | null
  /** Set in the 'error' phase. Plain enough to show. */
  message: string | null
}

/**
 * What changed in the version now running, shown once after an update installs.
 *
 * Written before the app restarts to install, and read on the way back up — which is why
 * it is stored rather than fetched: the notes belong to the update the user just accepted,
 * and refetching them would depend on the network being there a second time.
 */
export interface WhatsNew {
  version: string
  notes: string
  releaseUrl: string | null
}

/* -------------------------------------------------------------- integrations */

/**
 * Where an integration stands, as one word.
 *
 * Derived rather than stored: `enabled` plus whether every declared secret has a value is
 * the whole of it, and a fourth state kept in the database could disagree with those two.
 *
 * `pending` is the state that had no name and therefore no surface. An integration the agent
 * registered is saved disabled with secrets still to supply — the design intends the user to
 * approve it — and with nothing calling it pending, it was reported by `list_integrations` as
 * not existing at all.
 */
export type IntegrationStatus = 'pending' | 'disabled' | 'enabled'

/**
 * What is known about one declared secret, without its value.
 *
 * This is the shape that crosses into agent-visible space and into the renderer. There is no
 * variant of it that carries the value: the renderer never needs one to draw a masked field,
 * and the agent must never have one at all.
 */
export interface SecretState {
  ref: string
  label: string
  hint?: string
  isSet: boolean
  /** True when the OS keychain protected it, rather than the fallback cipher. */
  encrypted: boolean
  updatedAt: number | null
  /** Optional, set by the user for a short-lived token. */
  expiresAt: number | null
  /** Past its stated expiry. Computed here so every reader agrees on "expired". */
  expired: boolean
  /**
   * Set for a *different* integration than the one asking about it.
   *
   * Refs are one flat namespace, so a manifest can declare a ref the user already filled in
   * elsewhere — and it then reads as ready to enable without its author ever having asked for a
   * credential. That is a legitimate case (two integrations against one service) and also the
   * shape of a credential being borrowed by something the user did not vet, so it is reported
   * rather than assumed either way.
   */
  borrowedFrom: string | null
}

/** One thing an integration can be asked to do, as the user needs to see it before approving. */
export interface IntegrationOperationSummary {
  name: string
  description: string
  /** Present for `rest`; absent for kinds whose operations are not HTTP. */
  method?: string
  path?: string
  /** True for anything with outside-world effects. */
  mutating: boolean
}

/**
 * An integration as both the panel and `list_integrations` need it.
 *
 * One shape for both on purpose. They were two different reads of the same records — the panel
 * took every record and the agent's list took only the enabled ones — which is how an
 * integration could be simultaneously present and reported as non-existent.
 */
export interface IntegrationSummary {
  id: string
  name: string
  description: string
  kind: IntegrationKind
  status: IntegrationStatus
  createdBy: 'user' | 'agent' | 'preset'
  health: IntegrationHealth
  lastError: string | null
  /** For `rest`, so the user can see what it will be allowed to reach. */
  baseUrl: string | null
  operations: IntegrationOperationSummary[]
  secrets: SecretState[]
  /** Refs still without a value. Empty means the integration is ready to be enabled. */
  missingSecrets: string[]
  /** True when every declared secret has a value. Enabling is gated on this. */
  ready: boolean
  createdAt: number
  updatedAt: number
}

/** One recorded call, for the audit trail. Never carries a secret value. */
export interface IntegrationAuditEntry {
  id: number
  ts: number
  integrationId: string
  integrationName: string
  operation: string
  /** Which vault refs the call used. Refs, never values. */
  secretRefs: string[]
  ok: boolean
  /** HTTP status for a `rest` call, null for the other kinds. */
  httpStatus: number | null
  durationMs: number
}

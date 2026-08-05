import type { Db } from './sqlite'
import type {
  AgentEffort,
  SavedTool,
  SavedToolParam,
  ToolAction,
  ToolField,
  ToolKind,
  ToolNode,
  ToolState
} from '@shared/types'
import { readPath, writePath } from '@shared/bindings'
import { ulid } from '../util/id'

interface ToolRow {
  id: string
  name: string
  description: string
  icon: string | null
  prompt: string
  params: string
  pinned: number
  sort_order: number
  created_by: string
  run_count: number
  last_run_at: number | null
  created_at: number
  updated_at: number
  last_spec_id: string | null
  kind: string
  instructions: string
  session_id: string | null
  state: string
  rev: number
  actions: string
  fields: string
  hotkey: string | null
  open_in_window: number
  always_on_top: number
  layout: string
  source: string
  model: string | null
  effort: string | null
  window_width: number | null
  window_height: number | null
  window_maximized: number
}

/** Below this a tool window is not usable, so a bad stored value is ignored. */
export const MIN_TOOL_WINDOW = { width: 380, height: 280 }
const MAX_TOOL_WINDOW = { width: 8000, height: 6000 }

function readSize(value: number | null, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded >= min && rounded <= max ? rounded : null
}

const EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const TOOL_KINDS: ToolKind[] = [
  'prompt',
  'code',
  'canvas',
  'kanban',
  'table',
  'checklist',
  'notepad',
  'workbench'
]

/** Empty document for a kind, so a new tool opens usable rather than blank-broken. */
export function emptyStateFor(kind: ToolKind): ToolState {
  switch (kind) {
    case 'kanban':
      return {
        columns: [
          { id: 'todo', title: 'To do', cards: [] },
          { id: 'doing', title: 'In progress', cards: [] },
          { id: 'done', title: 'Done', cards: [] }
        ]
      }
    case 'table':
      return { columns: [{ key: 'item', label: 'Item' }], rows: [] }
    case 'checklist':
      return { items: [] }
    case 'notepad':
      return { text: '' }
    case 'workbench':
      return { inputs: {}, output: '' }
    default:
      return {}
  }
}

/**
 * Fills in the values a canvas's controls already display.
 *
 * A select renders its first option and a slider its minimum whether or not the
 * document says so; without this, a button reading `{{tone}}` would receive an
 * empty string while the user is looking at "Casual". Only missing paths are
 * written, so re-saving a tool never disturbs work in progress.
 */
export function seedCanvasState(
  layout: ToolNode[],
  state: Record<string, unknown>
): Record<string, unknown> {
  let seeded = state

  const fill = (path: string, value: unknown): void => {
    if (readPath(seeded, path) === undefined) seeded = writePath(seeded, path, value)
  }

  const visit = (nodes: ToolNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'select') fill(node.bind, node.options[0]?.value ?? '')
      if (node.type === 'toggle') fill(node.bind, false)
      if (node.type === 'slider') fill(node.bind, node.min ?? 0)
      if (node.type === 'kanban') fill(node.bind, { columns: [] })
      if (node.type === 'table') fill(node.bind, { columns: [], rows: [] })
      if (node.type === 'checklist') fill(node.bind, { items: [] })

      if ('children' in node && Array.isArray(node.children)) visit(node.children as ToolNode[])
      if (node.type === 'tabs') for (const item of node.items) visit(item.children)
    }
  }
  visit(layout)

  return seeded
}

function toTool(row: ToolRow): SavedTool {
  let params: SavedToolParam[] = []
  try {
    const parsed = JSON.parse(row.params)
    if (Array.isArray(parsed)) params = parsed as SavedToolParam[]
  } catch {
    /* a malformed param list should not hide the tool */
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    prompt: row.prompt,
    params,
    pinned: row.pinned === 1,
    sortOrder: row.sort_order,
    createdBy: row.created_by === 'user' ? 'user' : 'agent',
    runCount: row.run_count,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSpecId: row.last_spec_id,
    kind: (TOOL_KINDS as string[]).includes(row.kind) ? (row.kind as ToolKind) : 'prompt',
    instructions: row.instructions ?? '',
    sessionId: row.session_id,
    state: parseState(row.state),
    rev: row.rev ?? 0,
    actions: parseArray<ToolAction>(row.actions),
    fields: parseArray<ToolField>(row.fields),
    hotkey: row.hotkey ?? null,
    openInWindow: row.open_in_window === 1,
    alwaysOnTop: row.always_on_top === 1,
    layout: parseArray<ToolNode>(row.layout),
    source: row.source ?? '',
    model: row.model,
    // A value from an older build, or a hand-edited row, must not reach the CLI.
    effort: (EFFORTS as string[]).includes(row.effort ?? '')
      ? (row.effort as AgentEffort)
      : null,
    // Nonsense stored here would open a window too small to use, so it is dropped
    // rather than clamped — falling back to the default size is the honest result.
    windowWidth: readSize(row.window_width, MIN_TOOL_WINDOW.width, MAX_TOOL_WINDOW.width),
    windowHeight: readSize(row.window_height, MIN_TOOL_WINDOW.height, MAX_TOOL_WINDOW.height),
    windowMaximized: row.window_maximized === 1
  }
}

function parseArray<T>(raw: string | null): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function parseState(raw: string | null): ToolState {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as ToolState) : {}
  } catch {
    return {}
  }
}

export interface SaveToolInput {
  id?: string
  name: string
  description: string
  prompt: string
  icon?: string | null
  params?: SavedToolParam[]
  pinned?: boolean
  createdBy?: 'agent' | 'user'
  kind?: ToolKind
  instructions?: string
  state?: ToolState
  actions?: ToolAction[]
  fields?: ToolField[]
  hotkey?: string | null
  openInWindow?: boolean
  alwaysOnTop?: boolean
  layout?: ToolNode[]
  source?: string
  model?: string | null
  effort?: AgentEffort | null
  windowWidth?: number | null
  windowHeight?: number | null
}

export class StaleToolWriteError extends Error {
  constructor(readonly currentRev: number) {
    super(`the tool was changed by someone else (now at revision ${currentRev})`)
  }
}

export class ToolStore {
  constructor(private db: Db) {}

  /** Create or replace by id, or by name when no id is given. */
  save(input: SaveToolInput): SavedTool {
    const now = Date.now()
    const existing = input.id
      ? this.get(input.id)
      : this.list().find((tool) => tool.name.toLowerCase() === input.name.toLowerCase())

    const id = existing?.id ?? ulid()

    const kind = input.kind ?? existing?.kind ?? 'prompt'
    const layout = input.layout ?? existing?.layout ?? []
    // Seeding only on creation: re-saving a tool must not wipe the document the
    // user has been working in.
    let state = input.state ?? existing?.state ?? emptyStateFor(kind)
    // A changed layout can introduce controls the document has no value for yet.
    if (kind === 'canvas') state = seedCanvasState(layout, state as Record<string, unknown>)

    this.db.run(
      `INSERT INTO saved_tools
         (id, name, description, icon, prompt, params, pinned, sort_order, created_by,
          created_at, updated_at, kind, instructions, state, rev, actions, fields,
          hotkey, open_in_window, always_on_top, layout, source, model, effort,
          window_width, window_height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         icon = excluded.icon,
         prompt = excluded.prompt,
         params = excluded.params,
         pinned = excluded.pinned,
         updated_at = excluded.updated_at,
         kind = excluded.kind,
         instructions = excluded.instructions,
         state = excluded.state,
         actions = excluded.actions,
         fields = excluded.fields,
         hotkey = excluded.hotkey,
         open_in_window = excluded.open_in_window,
         always_on_top = excluded.always_on_top,
         layout = excluded.layout,
         source = excluded.source,
         model = excluded.model,
         effort = excluded.effort,
         window_width = excluded.window_width,
         window_height = excluded.window_height`,
      [
        id,
        input.name.slice(0, 60),
        input.description.slice(0, 300),
        input.icon ?? null,
        input.prompt,
        JSON.stringify(input.params ?? []),
        (input.pinned ?? existing?.pinned) ? 1 : 0,
        existing?.sortOrder ?? now,
        input.createdBy ?? existing?.createdBy ?? 'agent',
        existing?.createdAt ?? now,
        now,
        kind,
        input.instructions ?? existing?.instructions ?? '',
        JSON.stringify(state),
        existing?.rev ?? 0,
        JSON.stringify(input.actions ?? existing?.actions ?? []),
        JSON.stringify(input.fields ?? existing?.fields ?? []),
        input.hotkey !== undefined ? input.hotkey : (existing?.hotkey ?? null),
        (input.openInWindow ?? existing?.openInWindow) ? 1 : 0,
        (input.alwaysOnTop ?? existing?.alwaysOnTop) ? 1 : 0,
        JSON.stringify(layout),
        input.source ?? existing?.source ?? '',
        input.model !== undefined ? input.model : (existing?.model ?? null),
        input.effort !== undefined ? input.effort : (existing?.effort ?? null),
        // Never reset by a plain re-save: the size is the user's, and rebuilding a
        // tool's interface should not move its window back to the default.
        input.windowWidth !== undefined ? input.windowWidth : (existing?.windowWidth ?? null),
        input.windowHeight !== undefined ? input.windowHeight : (existing?.windowHeight ?? null)
      ]
    )

    return this.get(id)!
  }

  /**
   * Replace a tool's document.
   *
   * `expectedRev` makes this safe while the user drags a card and the agent
   * rewrites the board at the same time: whoever read stale data is told to
   * re-read rather than overwriting the other's work.
   */
  writeState(id: string, state: ToolState, expectedRev?: number): SavedTool {
    return this.db.transaction(() => {
      const current = this.get(id)
      if (!current) throw new Error(`no tool with id ${id}`)

      if (expectedRev !== undefined && expectedRev !== current.rev) {
        throw new StaleToolWriteError(current.rev)
      }

      this.db.run('UPDATE saved_tools SET state = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [
        JSON.stringify(state),
        Date.now(),
        id
      ])

      return this.get(id)!
    })
  }

  ensureSession(id: string, createSession: () => string): string {
    const tool = this.get(id)
    if (!tool) throw new Error(`no tool with id ${id}`)
    if (tool.sessionId) return tool.sessionId

    const sessionId = createSession()
    this.db.run('UPDATE saved_tools SET session_id = ? WHERE id = ?', [sessionId, id])
    return sessionId
  }

  get(id: string): SavedTool | undefined {
    const row = this.db.get<ToolRow>('SELECT * FROM saved_tools WHERE id = ?', [id])
    return row ? toTool(row) : undefined
  }

  byName(name: string): SavedTool | undefined {
    const row = this.db.get<ToolRow>('SELECT * FROM saved_tools WHERE name = ? COLLATE NOCASE', [name])
    return row ? toTool(row) : undefined
  }

  list(): SavedTool[] {
    return this.db
      .all<ToolRow>(
        'SELECT * FROM saved_tools ORDER BY pinned DESC, sort_order ASC, created_at ASC'
      )
      .map(toTool)
  }

  pinned(): SavedTool[] {
    return this.list().filter((tool) => tool.pinned)
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.run('UPDATE saved_tools SET pinned = ?, updated_at = ? WHERE id = ?', [
      pinned ? 1 : 0,
      Date.now(),
      id
    ])
  }

  /** Persist a new order for the pinned strip. */
  reorder(ids: string[]): void {
    this.db.transaction(() => {
      ids.forEach((id, index) => {
        this.db.run('UPDATE saved_tools SET sort_order = ? WHERE id = ?', [index, id])
      })
    })
  }

  remove(id: string): void {
    this.db.run('DELETE FROM saved_tools WHERE id = ?', [id])
  }

  setWindowPrefs(id: string, prefs: { openInWindow?: boolean; alwaysOnTop?: boolean }): void {
    if (prefs.openInWindow !== undefined) {
      this.db.run('UPDATE saved_tools SET open_in_window = ? WHERE id = ?', [
        prefs.openInWindow ? 1 : 0,
        id
      ])
    }
    if (prefs.alwaysOnTop !== undefined) {
      this.db.run('UPDATE saved_tools SET always_on_top = ? WHERE id = ?', [
        prefs.alwaysOnTop ? 1 : 0,
        id
      ])
    }
  }

  setHotkey(id: string, accelerator: string | null): void {
    this.db.run('UPDATE saved_tools SET hotkey = ? WHERE id = ?', [accelerator, id])
  }

  /**
   * Remember how the user left this tool's window.
   *
   * Written on every resize, so it is deliberately a narrow UPDATE rather than a
   * `save()` — it must not touch the tool's revision or its document.
   */
  setWindowSize(id: string, size: { width: number; height: number; maximized: boolean }): void {
    this.db.run(
      'UPDATE saved_tools SET window_width = ?, window_height = ?, window_maximized = ? WHERE id = ?',
      [
        Math.round(size.width),
        Math.round(size.height),
        size.maximized ? 1 : 0,
        id
      ]
    )
  }

  /** Null for either means "follow the app's setting". */
  setModelPrefs(id: string, prefs: { model?: string | null; effort?: AgentEffort | null }): void {
    if (prefs.model !== undefined) {
      this.db.run('UPDATE saved_tools SET model = ? WHERE id = ?', [prefs.model, id])
    }
    if (prefs.effort !== undefined) {
      this.db.run('UPDATE saved_tools SET effort = ? WHERE id = ?', [prefs.effort, id])
    }
  }

  /** Another tool already holding this accelerator, if any. */
  hotkeyOwner(accelerator: string, exceptId?: string): SavedTool | undefined {
    return this.list().find((tool) => tool.hotkey === accelerator && tool.id !== exceptId)
  }

  setLastSpec(id: string, specId: string): void {
    this.db.run('UPDATE saved_tools SET last_spec_id = ? WHERE id = ?', [specId, id])
  }

  noteRun(id: string): void {
    this.db.run(
      'UPDATE saved_tools SET run_count = run_count + 1, last_run_at = ? WHERE id = ?',
      [Date.now(), id]
    )
  }

  /**
   * Fill a template. Unsupplied optional parameters collapse to nothing rather
   * than leaving a literal {{placeholder}} in the prompt.
   */
  render(tool: SavedTool, values: Record<string, string>): string {
    let out = tool.prompt
    for (const param of tool.params) {
      const value = values[param.name] ?? param.default ?? ''
      out = out.replaceAll(`{{${param.name}}}`, value)
    }
    return out.replace(/\{\{[a-zA-Z0-9_-]+\}\}/g, '').trim()
  }
}

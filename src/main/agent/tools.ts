import type { TurnFollowups,
  BrainNode,
  EdgeKind,
  IntegrationManifest,
  IntegrationSummary,
  NodeKind,
  SavedTool,
  SuggestionKind,
  ToolAction,
  ToolField,
  ToolKind,
  ToolNode
} from '@shared/types'
import { readFileSync } from 'node:fs'
import { validateGenUiSpec, type GenUiSpec } from '@shared/genui'
import { placeholderPaths } from '@shared/bindings'
import { AUTHORABLE_KINDS, NODE_KINDS } from '@shared/node-kinds'
// Bundled rather than read from disk: it documents the runtime, so it has to ship in
// lockstep with the runtime it describes and get reviewed like the code it documents.
import TOOL_API_REFERENCE from '../../../TOOL_API.md?raw'
import { describeSchedule } from '@shared/schedule'
import type { BrainCore } from '../core'
import { StaleToolWriteError } from '../db/tools'
import { clearToolErrors, readToolErrors } from '../toolErrors'
import { formatHotkey, normaliseHotkey } from '@shared/hotkey'
import type { RegisteredTool, ToolResult } from './toolhost'

/** Implemented by the integration layer; declared here to avoid a cycle. */
export interface IntegrationBridge {
  listTools(): Promise<
    { integrationId: string; integrationName: string; qualifiedName: string; description: string; mutating: boolean }[]
  >
  /**
   * Every integration, including the ones that cannot be called yet.
   *
   * Separate from `listTools` on purpose, and both are needed: `listTools` answers "what can I
   * invoke right now" and is correctly empty for a disabled integration, while this answers
   * "what exists". Reporting only the first is what made a registered integration invisible.
   */
  describeAll(): IntegrationSummary[]
  callTool(integrationId: string, tool: string, args: Record<string, unknown>): Promise<ToolResult>
  register(manifest: unknown): Promise<{ ok: boolean; message: string; needsApproval: boolean }>
  test(integrationId: string): Promise<{ ok: boolean; message: string }>
  /** One live authenticated request. See `probe` in the registry. */
  probe(integrationId: string): Promise<{ ok: boolean; message: string; httpStatus: number | null }>
  setEnabled(integrationId: string, enabled: boolean): unknown
  deleteSecret(ref: string): void
  setSecretExpiry(ref: string, expiresAt: number | null): void
  remove(integrationId: string): void
}

export interface ToolDeps {
  core: BrainCore
  /** Persist a validated spec and push it into the conversation. Returns its id. */
  emitGenUi: (spec: GenUiSpec, sessionId: string | null) => string
  /** Drive the main graph canvas. */
  focusGraph: (nodeIds: string[], opts: { note?: string; depth?: number }) => void
  /**
   * Open the Integrations panel at one integration.
   *
   * The agent's answer to the one field it must never fill: it cannot write a credential, so it
   * puts the user in front of the box instead and says what goes in it.
   */
  focusIntegration: (integrationId: string) => void
  /** Offer the user a next step. Attached to the turn's message when it finishes. */
  suggestFollowups: (followups: TurnFollowups, sessionId: string | null) => void
  /**
   * Show that these nodes were just read, in the order they came back.
   *
   * Not the same as focusGraph: this moves nothing and decides nothing, it only
   * lets the graph show its own work while a question is being answered. Called
   * from the reading tools, so it happens without the agent having to think about
   * it — the point is that looking things up is visible, not that it is announced.
   */
  probeGraph: (nodeIds: string[], label: string | null) => void
  /** Put a question in the chat and wait; resolves to '' if nobody answers. */
  askUser: (input: {
    sessionId: string | null
    question: string
    options: string[]
    allowFreeText: boolean
  }) => Promise<string>
  integrations: IntegrationBridge
  /** Rebind global shortcuts after a tool changes. */
  syncShortcuts: () => void
  /**
   * Recompute when a scheduled task is next due.
   *
   * Called after the agent creates or edits one, because the stored next-run time
   * belongs to the old schedule — a task moved from hourly to weekly would otherwise
   * still fire within the hour.
   */
  rescheduleTask: (taskId: string) => void
  /** Render a tool offscreen and return a PNG, so the agent can look at it. */
  previewTool: (input: {
    toolId: string
    width?: number
    height?: number
  }) => Promise<{ dataBase64: string; width: number; height: number }>
}

/* ------------------------------------------------------------- formatting */

function ok(content: string): ToolResult {
  return { content }
}

function fail(content: string): ToolResult {
  return { content, isError: true }
}

function describeNode(node: BrainNode, opts: { body?: boolean; maxBody?: number } = {}): string {
  const lines = [
    `id: ${node.id}`,
    `title: ${node.title}`,
    `kind: ${node.kind}`,
    node.path ? `path: ${node.path}` : 'path: (virtual node, no file)',
    node.tags.length ? `tags: ${node.tags.join(', ')}` : 'tags: none',
    `links: ${node.degree}`,
    `updated: ${new Date(node.updatedAt).toISOString()}`
  ]
  if (node.summary) lines.push(`summary: ${node.summary}`)

  if (opts.body && node.body) {
    const max = opts.maxBody ?? 6000
    const body = node.body.length > max ? `${node.body.slice(0, max)}\n…[truncated]` : node.body
    lines.push('', '--- body ---', body)
  }
  return lines.join('\n')
}

function listNodes(nodes: BrainNode[], label: string): string {
  if (nodes.length === 0) return `${label}: none`
  return [
    `${label} (${nodes.length}):`,
    ...nodes.map((n) => `  - [${n.id}] ${n.title}${n.tags.length ? ` #${n.tags.join(' #')}` : ''} (${n.degree} links)`)
  ].join('\n')
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function strArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((v) => v.trim()).filter(Boolean)
  }
  return undefined
}

const REF_DESC = 'A note id, its vault path, or its exact title.'

/**
 * What each kind is for, generated from the one table that defines them.
 *
 * Written out rather than left to the enum because the kind is what makes the graph
 * readable at a glance — a meeting, a decision and a daily log are three different
 * shapes of thing, and filing all three as "note" throws that away. "note" is the
 * honest answer only when none of the others fit.
 */
const KIND_GUIDANCE = [
  'What this is. Defaults to note, but reach for a specific kind — it decides the colour and the glyph the user sees, so it is the difference between a readable graph and a field of identical circles.',
  ...NODE_KINDS.filter((spec) => AUTHORABLE_KINDS.includes(spec.id)).map(
    (spec) => `  ${spec.id} — ${spec.hint}`
  )
].join('\n')

/**
 * Days from now, as a timestamp. Undefined means permanent.
 *
 * Rounded to the end of that day rather than the exact hour: a note that says it
 * lasts a week should not vanish mid-morning on the seventh day.
 */
function expiryFromDays(days: number | undefined): number | null {
  if (days === undefined || !Number.isFinite(days) || days <= 0) return null
  const when = new Date(Date.now() + days * 86_400_000)
  when.setHours(23, 59, 59, 999)
  return when.getTime()
}

function readFields(raw: unknown): ToolField[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      name: String(entry['name'] ?? '').trim(),
      label: String(entry['label'] ?? entry['name'] ?? '').trim(),
      placeholder: typeof entry['placeholder'] === 'string' ? entry['placeholder'] : undefined,
      multiline: entry['multiline'] === true,
      default: typeof entry['default'] === 'string' ? entry['default'] : undefined
    }))
    .filter((field) => field.name.length > 0)
}

function readActions(raw: unknown): ToolAction[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry, index) => ({
      id: String(entry['id'] ?? `action-${index + 1}`).trim(),
      label: String(entry['label'] ?? '').trim(),
      prompt: String(entry['prompt'] ?? ''),
      target: entry['target'] === 'state' ? ('state' as const) : ('output' as const),
      icon: typeof entry['icon'] === 'string' ? entry['icon'] : undefined,
      hint: typeof entry['hint'] === 'string' ? entry['hint'] : undefined,
      primary: entry['primary'] === true,
      writeTo:
        typeof entry['writeTo'] === 'string' && entry['writeTo'].trim().length > 0
          ? entry['writeTo'].trim()
          : undefined
    }))
    .filter((action) => action.label.length > 0 && action.prompt.trim().length > 0)
}

function readLayout(raw: unknown): ToolNode[] {
  return Array.isArray(raw) ? (raw as ToolNode[]) : []
}

/** Walks a layout tree, including tab panes. */
function walkLayout(nodes: ToolNode[], visit: (node: ToolNode) => void): void {
  for (const node of nodes) {
    visit(node)
    if ('children' in node && Array.isArray(node.children)) {
      walkLayout(node.children as ToolNode[], visit)
    }
    if (node.type === 'tabs') for (const item of node.items) walkLayout(item.children, visit)
  }
}

/**
 * Checks a canvas hangs together before it reaches the user: no button without an
 * action behind it, and no action writing somewhere nothing displays.
 */
export function checkCanvas(layout: ToolNode[], actions: ToolAction[]): string | null {
  if (layout.length === 0) {
    return 'A canvas needs a layout — that is the whole point of the kind.'
  }

  const buttons = new Set<string>()
  const binds = new Set<string>()
  const outputs = new Set<string>()
  walkLayout(layout, (node) => {
    if (node.type === 'button') buttons.add(node.action)
    if ('bind' in node && typeof node.bind === 'string') binds.add(node.bind)
    if (node.type === 'output') outputs.add(node.bind)
  })

  const declared = new Set(actions.map((action) => action.id))
  const orphans = [...buttons].filter((id) => !declared.has(id))
  if (orphans.length > 0) {
    return `The layout has buttons for actions that do not exist: ${orphans.join(', ')}. Add them to actions, or change the button ids.`
  }

  const unreachable = actions.filter((action) => !buttons.has(action.id))
  if (unreachable.length > 0) {
    return `These actions have no button in the layout, so nothing can run them: ${unreachable.map((action) => action.id).join(', ')}. Add a button node for each.`
  }

  const lost = actions.filter(
    (action) => action.target === 'output' && action.writeTo && !outputs.has(action.writeTo)
  )
  if (lost.length > 0) {
    return `These actions write to a place the layout never shows: ${lost.map((action) => `${action.id} → ${action.writeTo}`).join(', ')}. Add an output node bound to each path.`
  }

  // Placeholders resolve against the document, so anything a button interpolates
  // must be bound by something on screen — otherwise it is always empty.
  const missing = new Set<string>()
  for (const action of actions) {
    for (const path of placeholderPaths(action.prompt)) {
      if (!binds.has(path)) missing.add(path)
    }
  }
  if (missing.size > 0) {
    return `These button prompts read paths nothing writes to: ${[...missing].join(', ')}. Bind an input to each, or change the prompts.`
  }

  return null
}

/**
 * What can be checked about hand-written code without running it.
 *
 * Not much, deliberately — the real check is preview_tool, which runs it and hands
 * back both a picture and whatever it threw. These catch the mistakes that would
 * otherwise look like a working tool: a document with no interface, markup that
 * will not load, and actions nothing can reach.
 */
export function checkCode(source: string, actions: ToolAction[]): string | null {
  const trimmed = source.trim()
  if (trimmed.length === 0) {
    return 'A code tool needs source — that is the interface. Write the HTML, CSS and JavaScript for it.'
  }

  if (/<\/?(?:html|head|body)\b/i.test(trimmed)) {
    return 'Do not include <html>, <head> or <body> — your source is the body. Put styles in a <style> tag and behaviour in a <script> tag.'
  }

  // Anything fetched over the network is blocked by the frame's policy, so it
  // would silently render as nothing.
  const remote = trimmed.match(/(?:src|href)\s*=\s*["']?(https?:|\/\/)/i)
  if (remote) {
    return `Nothing can be loaded over the network in a tool (${remote[1]}…). Inline the CSS and JavaScript, use inline SVG for icons, and data: URIs for images.`
  }

  const unreachable = actions.filter((action) => !source.includes(action.id))
  if (unreachable.length > 0) {
    return `These actions are never called from the source, so nothing can run them: ${unreachable.map((action) => action.id).join(', ')}. Call brain.run('<id>', {…}) from the interface, or drop the action.`
  }

  return null
}

/** Placeholders in a workbench prompt must name a declared field. */
export function checkFieldRefs(fields: ToolField[], actions: ToolAction[]): string | null {
  const declared = new Set(fields.map((field) => field.name))
  const missing = new Set<string>()
  for (const action of actions) {
    for (const match of action.prompt.matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)) {
      if (!declared.has(match[1])) missing.add(match[1])
    }
  }
  return missing.size > 0
    ? `These action prompts reference inputs that do not exist: ${[...missing].join(', ')}. Add them to fields and call this again.`
    : null
}

/* ------------------------------------------------------------------ tools */

export function buildBrainTools(deps: ToolDeps): RegisteredTool[] {
  const { core } = deps

  return [
    /* ------------------------------------------------------------- reading */
    {
      name: 'search_notes',
      description:
        'Full-text search across the vault. Diacritics and Turkish characters are folded, so "ogrenme" matches "Öğrenme". Returns ranked notes with excerpts. Use this before answering anything about what the user already knows.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms.' },
          limit: { type: 'number', description: 'Max results (default 15).' },
          includeVirtual: {
            type: 'boolean',
            description: 'Include tag and stub nodes, which are excluded by default.'
          }
        },
        required: ['query']
      },
      handler: (args) => {
        const query = str(args, 'query')
        if (!query) return fail('query is required')

        const hits = core.search(query, {
          limit: num(args, 'limit') ?? 15,
          includeVirtual: args['includeVirtual'] === true
        })
        if (hits.length === 0) return ok(`No notes match "${query}".`)

        deps.probeGraph(
          hits.map((hit) => hit.node.id),
          query
        )

        return ok(
          [
            `${hits.length} result(s) for "${query}":`,
            ...hits.map(
              (h, i) =>
                `${i + 1}. [${h.node.id}] ${h.node.title}${h.node.path ? ` — ${h.node.path}` : ''}\n   ${h.excerpt || '(no excerpt)'}`
            )
          ].join('\n')
        )
      }
    },
    {
      name: 'get_note',
      description: 'Read one note in full, including its body and metadata.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string', description: REF_DESC } },
        required: ['ref']
      },
      handler: (args) => {
        const ref = str(args, 'ref')
        if (!ref) return fail('ref is required')

        const node = core.nodes.resolve(ref)
        if (!node) return fail(`No note matches "${ref}". Try search_notes first.`)

        core.nodes.touch(node.id)
        deps.probeGraph([node.id], node.title)
        const edges = core.edges.listFor(node.id)
        const related = edges
          .map((e) => {
            const otherId = e.src === node.id ? e.dst : e.src
            const other = core.nodes.getById(otherId)
            if (!other) return null
            const direction = e.src === node.id ? '→' : '←'
            return `  ${direction} [${other.id}] ${other.title} (${e.kind})`
          })
          .filter(Boolean)

        return ok(
          [
            describeNode(node, { body: true }),
            '',
            related.length ? `--- relations ---\n${related.join('\n')}` : '--- relations ---\n  none'
          ].join('\n')
        )
      }
    },
    {
      name: 'list_recent_notes',
      description: 'The most recently updated notes. Good for "what have I been working on".',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Default 20.' } }
      },
      handler: (args) => {
        const recent = core.nodes.listRecent(num(args, 'limit') ?? 20)
        deps.probeGraph(
          recent.map((node) => node.id),
          'recent'
        )
        return ok(listNodes(recent, 'Recent notes'))
      }
    },
    {
      name: 'graph_overview',
      description:
        'Structural summary of the whole brain: counts, best-connected hubs, orphaned notes, and unwritten stubs. Start here when the user asks a broad question about their knowledge.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const stats = core.graph.stats()
        return ok(
          [
            '--- graph ---',
            `nodes: ${stats.nodes} (notes ${stats.notes}, tags ${stats.tags}, unwritten stubs ${stats.stubs})`,
            `edges: ${stats.edges}`,
            `disconnected clusters: ${stats.clusters}`,
            `orphaned notes: ${stats.orphans}`,
            '',
            listNodes(core.graph.hubs(10), 'Hubs'),
            '',
            listNodes(core.graph.orphans(10), 'Orphans'),
            '',
            listNodes(core.graph.stubs(10), 'Unwritten (referenced but missing)')
          ].join('\n')
        )
      }
    },
    {
      name: 'graph_neighborhood',
      description: 'Everything within N hops of a note. Use it to understand context around a topic.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: REF_DESC },
          depth: { type: 'number', description: '1-3, default 1.' }
        },
        required: ['ref']
      },
      handler: (args) => {
        const ref = str(args, 'ref')
        if (!ref) return fail('ref is required')
        const node = core.nodes.resolve(ref)
        if (!node) return fail(`No note matches "${ref}".`)

        const hood = core.graph.neighborhood(node.id, num(args, 'depth') ?? 1)
        // The centre first, so the ripple spreads outward from it.
        deps.probeGraph(
          [node.id, ...hood.nodes.map((n) => n.id).filter((id) => id !== node.id)],
          `around ${node.title}`
        )

        const edgeLines = hood.edges.map((e) => {
          const from = hood.nodes.find((n) => n.id === e.src)?.title ?? e.src
          const to = hood.nodes.find((n) => n.id === e.dst)?.title ?? e.dst
          return `  ${from} --${e.kind}--> ${to}`
        })

        return ok(
          [
            `Neighborhood of "${node.title}" (${hood.nodes.length} nodes, ${hood.edges.length} edges):`,
            listNodes(hood.nodes, 'Nodes'),
            '',
            edgeLines.length ? `Edges:\n${edgeLines.join('\n')}` : 'Edges: none'
          ].join('\n')
        )
      }
    },

    /* ------------------------------------------------------------- writing */
    {
      name: 'create_note',
      description:
        'Create a new markdown note in the vault. Put [[Wikilinks]] directly in the body to connect it to other notes — those links live in the file and survive re-indexing, which graph-only links do not. Decide `expiresInDays` as you write it: a dated snapshot is landfill within a week, and a vault that never forgets anything gets harder to read every day.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title; also becomes the filename.' },
          body: { type: 'string', description: 'Markdown body. Use [[Wikilinks]] and #tags.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags without the leading #.' },
          kind: {
            type: 'string',
            enum: AUTHORABLE_KINDS,
            description: KIND_GUIDANCE
          },
          folder: { type: 'string', description: 'Optional vault subfolder.' },
          summary: { type: 'string', description: 'One-line summary; derived from the body if omitted.' },
          expiresInDays: {
            type: 'number',
            description: [
              'How many days this note stays useful. Omit for permanent, which is the default — most notes are.',
              'Set it when the note is a snapshot of a moment rather than something learned: a daily digest, a meeting log, "today\'s open threads", a status dump. 7 for a daily summary, 30 for a monthly one, 90 for a quarterly review.',
              'Never set it on something durable: a person\'s preferences, how a process works, a decision and why, a reference. Those are the point of the vault.',
              'When it passes, the note moves to the trash — recoverable, not deleted. Pinning it overrides this.'
            ].join(' ')
          }
        },
        required: ['title', 'body']
      },
      mutating: true,
      handler: (args) => {
        const title = str(args, 'title')
        const body = args['body']
        if (!title) return fail('title is required')
        if (typeof body !== 'string') return fail('body is required')

        const node = core.createNote({
          title,
          body,
          tags: strArray(args, 'tags') ?? [],
          kind: (str(args, 'kind') as NodeKind | undefined) ?? 'note',
          folder: str(args, 'folder'),
          summary: str(args, 'summary') ?? null,
          expiresAt: expiryFromDays(num(args, 'expiresInDays')),
          actor: 'agent'
        })

        return ok(
          `Created note.${node.expiresAt ? ` Expires ${new Date(node.expiresAt).toDateString()}.` : ''}\n${describeNode(node)}`
        )
      }
    },
    {
      name: 'update_note',
      description:
        'Change an existing note. Use mode "append" to add to the end without rewriting, which is the safest option when adding to the user\'s own writing. Renaming via title also renames the file. `kind` refiles it, which is how a vault written before the specific kinds existed gets sorted out.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: REF_DESC },
          body: { type: 'string', description: 'New or additional markdown.' },
          mode: {
            type: 'string',
            enum: ['replace', 'append', 'prepend'],
            description: 'How body is applied. Default replace.'
          },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          kind: {
            type: 'string',
            enum: AUTHORABLE_KINDS,
            description: `Refile it as something more specific. ${KIND_GUIDANCE}`
          },
          summary: { type: 'string' },
          expiresInDays: {
            type: 'number',
            description:
              'Reset how long this note stays useful, counted from now. Pass 0 to make it permanent — use that when a note you first treated as a snapshot turns out to be worth keeping.'
          }
        },
        required: ['ref']
      },
      mutating: true,
      handler: (args) => {
        const ref = str(args, 'ref')
        if (!ref) return fail('ref is required')

        const node = core.updateNote(ref, {
          body: typeof args['body'] === 'string' ? (args['body'] as string) : undefined,
          title: str(args, 'title'),
          tags: strArray(args, 'tags'),
          summary: str(args, 'summary'),
          ...(str(args, 'kind') ? { kind: str(args, 'kind') as NodeKind } : {}),
          // 0 is how the caller says "permanent"; omitting it leaves the note's own
          // expiry untouched.
          ...(args['expiresInDays'] !== undefined
            ? { expiresAt: expiryFromDays(num(args, 'expiresInDays')) }
            : {}),
          mode: (str(args, 'mode') as 'replace' | 'append' | 'prepend' | undefined) ?? 'replace',
          actor: 'agent'
        })

        return ok(`Updated note.\n${describeNode(node)}`)
      }
    },
    {
      name: 'trash_note',
      description:
        'Move a note to the vault trash folder. This is reversible — the file is kept, not deleted. Confirm with the user before removing anything they wrote.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string', description: REF_DESC } },
        required: ['ref']
      },
      mutating: true,
      handler: (args) => {
        const ref = str(args, 'ref')
        if (!ref) return fail('ref is required')
        const result = core.trashNote(ref, 'agent')
        return ok(`Moved to trash (recoverable at ${result.trashPath}).`)
      }
    },
    {
      name: 'link_notes',
      description:
        'Create a graph edge between two nodes without editing either file. Use this for relationships you inferred; use a [[Wikilink]] in the body when the connection belongs in the writing itself.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: REF_DESC },
          to: { type: 'string', description: REF_DESC },
          kind: {
            type: 'string',
            enum: ['link', 'mention', 'similar', 'derived', 'temporal'],
            description: 'Relationship type. Default derived.'
          },
          label: { type: 'string', description: 'Short description of the relationship.' }
        },
        required: ['from', 'to']
      },
      mutating: true,
      handler: (args) => {
        const from = str(args, 'from')
        const to = str(args, 'to')
        if (!from || !to) return fail('from and to are required')

        const edge = core.linkNotes(
          from,
          to,
          (str(args, 'kind') as EdgeKind | undefined) ?? 'derived',
          str(args, 'label') ?? null,
          'agent'
        )
        return ok(`Linked (${edge.kind}${edge.label ? `: ${edge.label}` : ''}).`)
      }
    },
    {
      name: 'unlink_notes',
      description: 'Remove a graph edge between two nodes.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: REF_DESC },
          to: { type: 'string', description: REF_DESC },
          kind: { type: 'string', description: 'Only remove this edge kind; omit to remove all.' }
        },
        required: ['from', 'to']
      },
      mutating: true,
      handler: (args) => {
        const from = str(args, 'from')
        const to = str(args, 'to')
        if (!from || !to) return fail('from and to are required')

        const removed = core.unlinkNotes(from, to, str(args, 'kind') as EdgeKind | undefined, 'agent')
        return ok(removed > 0 ? `Removed ${removed} edge(s).` : 'No matching edge existed.')
      }
    },

    /* ---------------------------------------------------------------- ui */
    {
      name: 'suggest_followups',
      description:
        'Offer the user one or two next steps at the end of your turn: saving this work as a reusable tool, and/or putting it on a schedule. Call it only when the work you just did is genuinely repeatable — a shape of request the user will make again, or a check worth running on a clock. Do not call it out of habit, do not offer both when only one fits, and never offer a schedule for something that only made sense once. The user sees a small button; nothing is created unless they press it.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'object',
            description:
              'Offer to save this as a tool. { name: what to call it, why: one short line on when they would use it }',
            properties: {
              name: { type: 'string' },
              why: { type: 'string' }
            },
            required: ['name', 'why']
          },
          schedule: {
            type: 'object',
            description:
              'Offer to run this on a schedule. { name, when: plain English like "every weekday at 9am", why: one short line }',
            properties: {
              name: { type: 'string' },
              when: { type: 'string' },
              why: { type: 'string' }
            },
            required: ['name', 'when', 'why']
          }
        }
      },
      handler: (args, ctx) => {
        const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

        const rawTool = args['tool'] as Record<string, unknown> | undefined
        const rawSchedule = args['schedule'] as Record<string, unknown> | undefined

        const followups: TurnFollowups = {}
        if (rawTool && text(rawTool['name'])) {
          followups.tool = { name: text(rawTool['name']), why: text(rawTool['why']) }
        }
        if (rawSchedule && text(rawSchedule['name']) && text(rawSchedule['when'])) {
          followups.schedule = {
            name: text(rawSchedule['name']),
            when: text(rawSchedule['when']),
            why: text(rawSchedule['why'])
          }
        }

        if (!followups.tool && !followups.schedule) {
          return fail(
            'Give at least one of `tool` or `schedule`, and a name for whichever you give.'
          )
        }

        deps.suggestFollowups(followups, ctx.sessionId)
        return ok(
          'Offered. It appears under your reply when the turn ends, so say nothing more about it.'
        )
      }
    },
    {
      name: 'render_ui',
      description:
        'Render a live interface beside your reply instead of describing data in prose. Strongly preferred whenever the answer contains numbers, comparisons, sequences, structure, or more than about three related items. Pass a spec object matching the Generated UI schema in your instructions. If it fails validation you get the exact paths back — fix and retry.',
      inputSchema: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description:
              'Generated UI spec: { title?, subtitle?, blocks: [...] }. See the Generated UI section of your instructions for every block type.'
          }
        },
        required: ['spec']
      },
      handler: (args, ctx) => {
        const raw = args['spec']
        if (!raw || typeof raw !== 'object') {
          return fail('spec must be an object shaped { title?, subtitle?, blocks: [...] }')
        }

        const validation = validateGenUiSpec(raw)
        if (!validation.ok || !validation.spec) {
          return fail(
            [
              'The spec did not validate. Fix these and call render_ui again:',
              ...(validation.errors ?? []).map((e) => `  - ${e}`)
            ].join('\n')
          )
        }

        const id = deps.emitGenUi(validation.spec, ctx.sessionId)
        const blockTypes = validation.spec.blocks.map((b) => b.type).join(', ')
        return ok(
          `Rendered (${validation.spec.blocks.length} blocks: ${blockTypes}) as ${id}. It is now visible to the user — do not repeat its contents in prose, just add what the interface cannot say.`
        )
      }
    },
    {
      name: 'focus_graph',
      description:
        'Move the main knowledge graph to a set of nodes: highlight them, dim everything else, and ease the camera in. Use it to show the user where in their brain you are working.',
      inputSchema: {
        type: 'object',
        properties: {
          refs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Node ids, paths or titles to focus.'
          },
          note: { type: 'string', description: 'Short caption shown over the graph.' },
          depth: { type: 'number', description: 'Also include neighbours within N hops (0-2).' }
        },
        required: ['refs']
      },
      handler: (args) => {
        const refs = strArray(args, 'refs')
        if (!refs?.length) return fail('refs must be a non-empty array')

        const resolved = refs.map((ref) => core.nodes.resolve(ref)).filter((n): n is BrainNode => !!n)
        if (resolved.length === 0) return fail(`None of those refs matched a node: ${refs.join(', ')}`)

        deps.focusGraph(resolved.map((n) => n.id), {
          note: str(args, 'note'),
          depth: num(args, 'depth') ?? 0
        })

        const missing = refs.length - resolved.length
        return ok(
          `Focused the graph on ${resolved.length} node(s)${missing > 0 ? ` (${missing} ref(s) did not resolve)` : ''}.`
        )
      }
    },

    /* ------------------------------------------------------------- memory */
    {
      name: 'remember',
      description:
        'Store a small durable fact about the user or your own working context, outside any single conversation. Use slash-namespaced keys like "user/timezone" or "focus/current-project". For anything the user would want to read or edit, write a note instead.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { description: 'Any JSON value.' }
        },
        required: ['key', 'value']
      },
      mutating: true,
      handler: (args) => {
        const key = str(args, 'key')
        if (!key) return fail('key is required')
        core.kv.set(key, args['value'])
        return ok(`Remembered "${key}".`)
      }
    },
    {
      name: 'recall',
      description: 'Read back stored facts by exact key, or list everything under a key prefix.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Exact key.' },
          prefix: { type: 'string', description: 'List all keys starting with this.' }
        }
      },
      handler: (args) => {
        const key = str(args, 'key')
        if (key) {
          const value = core.kv.get(key)
          return ok(value === undefined ? `Nothing stored under "${key}".` : `${key} = ${JSON.stringify(value)}`)
        }

        const entries = core.kv.entries(str(args, 'prefix'))
        if (entries.length === 0) return ok('Nothing stored yet.')
        return ok(entries.map((e) => `${e.key} = ${JSON.stringify(e.value)}`).join('\n'))
      }
    },

    /* ----------------------------------------------------------- activity */
    {
      name: 'list_activity',
      description:
        'The activity log: notes created and edited, links added, agent turns, integration calls. Use it for "what did I do this week" style questions.',
      inputSchema: {
        type: 'object',
        properties: {
          sinceHours: { type: 'number', description: 'Look back this many hours.' },
          kinds: { type: 'array', items: { type: 'string' }, description: 'Filter by activity kind.' },
          limit: { type: 'number', description: 'Default 60.' }
        }
      },
      handler: (args) => {
        const sinceHours = num(args, 'sinceHours')
        const entries = core.activity.list({
          since: sinceHours ? Date.now() - sinceHours * 3600_000 : undefined,
          kinds: strArray(args, 'kinds'),
          limit: num(args, 'limit') ?? 60
        })

        if (entries.length === 0) return ok('No activity in that window.')
        return ok(
          entries
            .map((e) => `${new Date(e.ts).toISOString()} [${e.actor}] ${e.kind}: ${e.title}`)
            .join('\n')
        )
      }
    },
    {
      name: 'log_activity',
      description:
        'Record something you did that is worth remembering in the timeline, when no other tool already covers it.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'Dotted kind, e.g. "agent.research".' },
          title: { type: 'string' },
          detail: { type: 'object', description: 'Optional structured detail.' }
        },
        required: ['kind', 'title']
      },
      mutating: true,
      handler: (args) => {
        const kind = str(args, 'kind')
        const title = str(args, 'title')
        if (!kind || !title) return fail('kind and title are required')

        core.recordActivity({
          kind,
          title,
          actor: 'agent',
          detail: (args['detail'] as Record<string, unknown> | undefined) ?? null
        })
        return ok('Logged.')
      }
    },
    {
      name: 'suggest',
      description:
        'Leave a suggestion card for the user to accept or dismiss later, instead of acting now. Use this for structural changes you are not certain about: merging notes, splitting one up, or a link you only suspect.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['link', 'merge', 'tag', 'summary', 'split', 'orphan', 'note', 'integration']
          },
          title: { type: 'string', description: 'What you are proposing, in one line.' },
          rationale: { type: 'string', description: 'Why. The user sees this.' },
          payload: { type: 'object', description: 'Machine-readable detail, e.g. { from, to }.' }
        },
        required: ['kind', 'title', 'rationale']
      },
      mutating: true,
      handler: (args) => {
        const kind = str(args, 'kind') as SuggestionKind | undefined
        const title = str(args, 'title')
        const rationale = str(args, 'rationale')
        if (!kind || !title || !rationale) return fail('kind, title and rationale are required')

        const suggestion = core.suggestions.add({
          kind,
          title,
          rationale,
          payload: (args['payload'] as Record<string, unknown> | undefined) ?? {}
        })
        core.broadcast('suggestion:new', suggestion)
        return ok(`Suggestion queued for review (${suggestion.id}).`)
      }
    },

    /* ------------------------------------------------------------ asking */
    {
      name: 'ask_user',
      description:
        'Ask the user something and wait for their answer without ending your turn. Use it when a short question would make your answer materially better: which of two readings they meant, which project something belongs to, whether to include something. Offer options when the choice is closed — they become buttons. Do not use it for things you can look up, and do not ask more than one question before doing some work; if the answer comes back empty they did not reply, so state a reasonable assumption and carry on.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One clear question, no preamble.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to 6 short choices, rendered as buttons.'
          },
          allowFreeText: {
            type: 'boolean',
            description: 'Let them type instead of picking. Default true.'
          }
        },
        required: ['question']
      },
      handler: async (args, ctx) => {
        const question = str(args, 'question')
        if (!question) return fail('question is required')

        const answer = await deps.askUser({
          sessionId: ctx.sessionId,
          question,
          options: strArray(args, 'options') ?? [],
          allowFreeText: args['allowFreeText'] !== false
        })

        if (!answer) {
          return ok(
            'No answer — the user did not reply. Do not ask again. Pick the most reasonable interpretation, say which assumption you made in one clause, and continue.'
          )
        }
        return ok(`The user answered: ${answer}`)
      }
    },

    /* ------------------------------------------------------- saved tools */
    {
      name: 'save_tool',
      description:
        'Turn something you just worked out into a reusable tool for the user. Give it a name, a one-line description, and the prompt that did the job — with the parts that change replaced by {{placeholders}} declared in params. It appears in their Tools panel and can be run with one click. Offer this whenever you notice a task the user is likely to repeat, or one that took you several steps to get right. Saving a tool the second time you do something is usually right.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short imperative name, e.g. "Weekly review".' },
          description: { type: 'string', description: 'One line on what it does.' },
          prompt: {
            type: 'string',
            description:
              'The prompt to run, with {{placeholders}} for the variable parts. Write it as an instruction to yourself, not to the user.'
          },
          params: {
            type: 'array',
            description: 'One entry per {{placeholder}} in the prompt.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Matches the {{placeholder}}.' },
                label: { type: 'string', description: 'Shown next to the input.' },
                placeholder: { type: 'string' },
                default: { type: 'string' },
                required: { type: 'boolean' },
                multiline: { type: 'boolean' }
              },
              required: ['name', 'label']
            }
          },
          icon: {
            type: 'string',
            description:
              'Optional icon. One of: wand, sparkles, image, video, mic, mail, send, inbox, calendar, clock, search, filter, globe, link, network, brain, note, file, bookmark, tags, table, chart, trending, target, checklist, clipboard, code, message, users, bell, refresh, share, news, presentation, idea, zap.'
          },
          pinned: { type: 'boolean', description: 'Pin it to the top of the composer.' }
        },
        required: ['name', 'description', 'prompt']
      },
      mutating: true,
      handler: (args) => {
        const name = str(args, 'name')
        const description = str(args, 'description')
        const prompt = args['prompt']

        if (!name || !description || typeof prompt !== 'string' || !prompt.trim()) {
          return fail('name, description and prompt are all required')
        }

        const rawParams = Array.isArray(args['params']) ? args['params'] : []
        const params = rawParams
          .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
          .map((p) => ({
            name: String(p['name'] ?? '').trim(),
            label: String(p['label'] ?? p['name'] ?? '').trim(),
            placeholder: typeof p['placeholder'] === 'string' ? p['placeholder'] : undefined,
            default: typeof p['default'] === 'string' ? p['default'] : undefined,
            required: p['required'] === true,
            multiline: p['multiline'] === true
          }))
          .filter((p) => p.name.length > 0)

        // A placeholder with no declared param can never be filled in, so catch
        // it here rather than shipping a broken tool.
        const declared = new Set(params.map((p) => p.name))
        const referenced = [...prompt.matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)].map((m) => m[1])
        const missing = [...new Set(referenced)].filter((ref) => !declared.has(ref))
        if (missing.length > 0) {
          return fail(
            `The prompt references {{${missing.join('}}, {{')}}} but params does not declare ${missing.length === 1 ? 'it' : 'them'}. Add ${missing.length === 1 ? 'an entry' : 'entries'} to params and call save_tool again.`
          )
        }

        const tool = core.tools.save({
          name,
          description,
          prompt,
          params,
          icon: str(args, 'icon') ?? null,
          pinned: args['pinned'] === true,
          createdBy: 'agent'
        })

        core.recordActivity({
          kind: 'tool.saved',
          actor: 'agent',
          title: `Saved a tool: ${tool.name}`,
          detail: { id: tool.id, params: params.length }
        })
        core.broadcast('tools:changed')

        return ok(
          `Saved "${tool.name}" to the user's Tools panel${tool.pinned ? ' and pinned it' : ''}. Tell them it is there and what it does.`
        )
      }
    },
    {
      name: 'create_scheduled_task',
      description:
        'Set up work the app will do on its own clock — "every hour, scan Slack and compile what is new", "every weekday at 9, summarise what changed yesterday". Use this the moment the user asks for something recurring; do not offer to remind them yourself, because you are not running between turns. Each task keeps its own chat, so a run never appears in the middle of this conversation. The user can see, pause and delete every one of these in the Scheduled tab.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Two to four words, how it will appear in the Scheduled tab. E.g. "Slack digest".'
          },
          prompt: {
            type: 'string',
            description:
              'What you will be asked, every time it runs. Write it for a future you with no memory of this conversation: state the job, where to look, and what to produce. Say what to do when there is nothing to report, or you will produce noise on a quiet day.'
          },
          schedule: {
            type: 'object',
            description:
              'One of: {kind:"hourly", minute} - {kind:"daily", hour, minute} - {kind:"weekly", days:[0-6, 0 is Sunday], hour, minute} - {kind:"interval", everyMinutes}. Local time. Prefer hourly or daily; an interval under 5 minutes is refused, because every run spends the usage on the user own subscription.'
          },
          capability: {
            type: 'string',
            enum: ['read-only', 'curate', 'build'],
            description:
              'Default "curate". Use "read-only" for something that only reports, which is the safer choice for anything unattended.'
          }
        },
        required: ['name', 'prompt', 'schedule']
      },
      mutating: true,
      handler: (args) => {
        const name = str(args, 'name')
        const prompt = str(args, 'prompt')
        if (!name || !prompt) return fail('name and prompt are required')

        const capability = str(args, 'capability')
        const task = core.tasks.save({
          name,
          prompt,
          schedule: args['schedule'],
          capability:
            capability === 'read-only' || capability === 'build' || capability === 'curate'
              ? capability
              : 'curate',
          createdBy: 'agent'
        })

        deps.rescheduleTask(task.id)

        core.recordActivity({
          kind: 'task.created',
          actor: 'agent',
          title: `Scheduled "${task.name}"`,
          detail: { taskId: task.id, schedule: describeSchedule(task.schedule) }
        })
        core.broadcast('tasks:changed')

        const fresh = core.tasks.get(task.id)!
        return ok(
          `"${fresh.name}" will run ${describeSchedule(fresh.schedule)}${
            fresh.nextRunAt ? `, next at ${new Date(fresh.nextRunAt).toLocaleString()}` : ''
          }. It writes into its own chat. Tell them it is set up, in one line, and that the Scheduled tab is where to pause it.`
        )
      }
    },
    {
      name: 'list_scheduled_tasks',
      description:
        'Everything the app runs on its own clock, with when each is next due and how the last run went. Read this before creating a task, so you extend an existing one instead of adding a second that does the same job.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const tasks = core.tasks.list()
        if (tasks.length === 0) return ok('No scheduled tasks yet.')

        const proactive = core.settings.proactive
        const lines = tasks.map((task) => {
          const when = task.enabled
            ? task.nextRunAt
              ? `next ${new Date(task.nextRunAt).toLocaleString()}`
              : 'not scheduled'
            : 'paused'
          const last =
            task.lastStatus === null
              ? 'never run'
              : `last ${task.lastStatus}${task.lastSummary ? `: ${task.lastSummary.slice(0, 120)}` : ''}`
          return `- [${task.id}] "${task.name}" — ${describeSchedule(task.schedule)}, ${when}. ${last}`
        })

        return ok(
          [
            proactive.enabled
              ? 'Proactive work is on.'
              : 'Proactive work is OFF, so none of these will run until the user turns it back on in the Scheduled tab.',
            ...lines
          ].join('\n')
        )
      }
    },
    {
      name: 'update_scheduled_task',
      description:
        'Change a task: its name, its prompt, when it runs, or whether it is paused. Prefer this over creating a second task for a job that already exists.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          name: { type: 'string' },
          prompt: { type: 'string' },
          schedule: { type: 'object', description: 'Same shape as create_scheduled_task.' },
          enabled: { type: 'boolean', description: 'False pauses it without deleting it.' }
        },
        required: ['taskId']
      },
      mutating: true,
      handler: (args) => {
        const taskId = str(args, 'taskId')
        if (!taskId) return fail('taskId is required')

        const task = core.tasks.get(taskId)
        if (!task) return fail(`no task with id ${taskId}`)

        const enabled = args['enabled']
        const updated = core.tasks.save({
          id: taskId,
          name: str(args, 'name') ?? task.name,
          prompt: str(args, 'prompt') ?? task.prompt,
          schedule: args['schedule'] !== undefined ? args['schedule'] : task.schedule,
          ...(typeof enabled === 'boolean' ? { enabled } : {})
        })

        deps.rescheduleTask(updated.id)
        core.broadcast('tasks:changed')

        const fresh = core.tasks.get(updated.id)!
        return ok(
          `"${fresh.name}" now runs ${describeSchedule(fresh.schedule)}${fresh.enabled ? '' : ' (paused)'}.`
        )
      }
    },
    {
      name: 'delete_scheduled_task',
      description:
        'Remove a scheduled task. Ask first unless the user plainly asked for it gone — this deletes work they set up, and pausing it with update_scheduled_task is usually what they meant.',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId']
      },
      mutating: true,
      handler: (args) => {
        const taskId = str(args, 'taskId')
        if (!taskId) return fail('taskId is required')

        const task = core.tasks.get(taskId)
        if (!task) return fail(`no task with id ${taskId}`)

        // The check-in is seeded on launch, so deleting it only brings it back.
        if (task.kind === 'heartbeat') {
          core.tasks.setEnabled(taskId, false, null)
          core.broadcast('tasks:changed')
          return ok('The hourly check-in cannot be deleted, so it is paused instead.')
        }

        core.tasks.delete(taskId)
        core.broadcast('tasks:changed')
        return ok(`Deleted "${task.name}".`)
      }
    },
    {
      name: 'design_principles',
      description:
        "This app's design brief: how it looks and moves, which tokens mean what, the type scale, the motion rules, and the traps. Read it before you build or restyle any interface — a tool, a generated view, anything the user looks at. It is a file the user owns and edits, so it is the current answer rather than what you remember. Cheap to call; call it every time.",
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        try {
          const brief = readFileSync(core.paths.designFile, 'utf8')
          return ok(brief)
        } catch (err) {
          return fail(
            `The design brief could not be read from ${core.paths.designFile}: ${(err as Error).message}`
          )
        }
      }
    },
    {
      name: 'tool_api',
      description:
        "The tool runtime reference: every window.brain member, how to stream a reply as it arrives, how to cancel one, how the document persists, what the frame can and cannot do, the classes and elements that come already themed, and the patterns worth copying. Read it before building or changing a code tool — it is the difference between a tool that works and one that silently cannot do what you assumed. Cheap to call.",
      inputSchema: { type: 'object', properties: {} },
      handler: () => ok(TOOL_API_REFERENCE)
    },
    {
      name: 'create_interactive_tool',
      description:
        'Build the user a panel inside this app that they work in. Use kind "code" and write the interface yourself: `source` is HTML with its own <style> and <script>, run in a sandboxed frame with `window.brain` for the tool\'s document and its actions. This is the default and it is what makes two tools look nothing alike — you choose the layout, the type, the colours, the interactions, the animation. A translator and a task board should not resemble each other, and with a fixed vocabulary they always will. The other kinds exist only for when the user explicitly wants a plain one: "kanban", "table", "checklist", "notepad", "workbench" for one input and one output, "canvas" for a declarative tree. Whatever the kind, `actions` is what makes it agentic: each is one job you run when the interface asks. Without actions a tool is just a form. Prefer this over render_ui whenever the user will want to do something with what you produced rather than only read it. Always preview_tool afterwards, read any runtime errors it reports, and fix what you see.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: 'One line.' },
          kind: {
            type: 'string',
            enum: ['code', 'canvas', 'workbench', 'kanban', 'table', 'checklist', 'notepad']
          },
          source: {
            type: 'string',
            description: [
              'For kind "code": the interface. HTML for the body, with your own <style> and <script>. No <html>, <head> or <body> tags, and no external files — the frame has no network, so everything is inline and images are data: URIs. Fonts are the system stack; inline SVG for icons.',
              'window.brain is your only connection to the app:',
              '  brain.state — the tool\'s document, any shape you want. Replaced on every change; never mutate it in place.',
              '  brain.setState(next) — persist the whole document. Returns a promise of what was stored.',
              '  brain.patch(partial) — shallow merge over the current document.',
              '  brain.run(actionId, inputs, handlers) — run one of your actions and resolve with the agent\'s reply as text. Values in inputs fill {{name}} in that action\'s prompt. handlers is { onText, onStep, onAsk }. Calls queue rather than fail, so two presses both work.',
              '  brain.cancel() — stop the running action. brain.copy(text) — put text on the clipboard (navigator.clipboard is refused in the sandbox, so use this). brain.answer(questionId, text) — unblock a run that asked something.',
              '  brain.running — the running action id or null. brain.elapsedMs — how long it has been going. Past about eight seconds, say so.',
              '  brain.onState(fn) — the document changed, including when the agent rewrote it while the user watched.',
              '  brain.onRun(fn) — progress: { actionId, status: start|step|delta|ask|done|error, step, text, elapsedMs, message, question }. status delta carries the reply as it is written — streaming it is the difference between a tool that looks frozen and one you can read while it thinks. Draw your own loading state from this.',
              '  brain.tool — { id, name, description }. brain.theme / brain.dark — the app\'s tokens, also set as CSS variables on :root (--background, --foreground, --primary, --border, --muted-foreground, --radius, --ease-out and so on).',
              'The body is transparent over the app\'s background and fills the panel; give your root element height:100% if you want to own the whole area. Use the tokens to sit inside the app, or your own palette when the tool deserves its own character — that choice is yours to make per tool.'
            ].join('\n')
          },
          layout: {
            type: 'array',
            description:
              'For kind "canvas": the interface, as a tree. Every element that reads or writes uses "bind", a dot path into the document — so both the document and the interface are yours to shape. Layout: stack {direction row|col, gap, grow, scroll, wrap, align start|center|end|stretch, justify start|center|end|between, children}, grid {columns 1-6, gap, grow, minItemWidth, children} — cells wrap to another row when the window is too narrow for `columns` of at least minItemWidth (default 240), panel {title, tone, grow, scroll, children}, tabs {items:[{label, children}]}, divider {label}, spacer {size}. Content: heading {value, level 1-3, hint}, text {value, muted, size sm|md|lg}, badge {value, tone}, note {value, tone}. Inputs: input {bind, label, placeholder, multiline, rows, grow}, select {bind, label, options:[{value,label}]}, toggle {bind, label}, slider {bind, label, min, max, step}. Actions: button {action, label, icon, variant primary|outline|ghost, grow}. Results: output {bind, label, markdown, grow, placeholder, minHeight, copy} — it has a copy button whenever it holds something, so pass copy:false only to remove it. Rich: kanban {bind}, table {bind}, checklist {bind}. Tones: neutral, info, success, warning, danger, accent. Any string may contain {{path}} to show a value from the document. Use grow:true down the chain you want to fill the height, and give a stack or grid grow:true so its children can share it.'
          },
          fields: {
            type: 'array',
            description:
              'Inputs, for a workbench. Usually one multiline field is enough. Referenced from action prompts as {{name}}.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                label: { type: 'string' },
                placeholder: { type: 'string' },
                multiline: { type: 'boolean' },
                default: { type: 'string' }
              },
              required: ['name', 'label']
            }
          },
          actions: {
            type: 'array',
            description:
              'Buttons that run you. Each needs a short label and the prompt to run. On a workbench use {{field}}; on a canvas use {{path}} to read anything the layout binds. target "output" puts your reply in a result pane; target "state" lets you rewrite the document instead (use that for "sync from Slack" on a board). Two to five buttons is right.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string', description: 'Two or three words.' },
                prompt: { type: 'string' },
                target: { type: 'string', enum: ['output', 'state'] },
                writeTo: {
                  type: 'string',
                  description:
                    'On a canvas with target "output": the dot path to put the reply in. Must match an output node\'s bind, so several buttons can fill different panes. Defaults to "output".'
                },
                icon: { type: 'string' },
                hint: { type: 'string' },
                primary: { type: 'boolean' }
              },
              required: ['id', 'label', 'prompt', 'target']
            }
          },
          instructions: {
            type: 'string',
            description:
              'Standing guidance for you, every time this tool is used: what it is for, where its data comes from, how to keep it tidy.'
          },
          state: {
            type: 'object',
            description:
              'Initial document. kanban: { columns: [{ id, title, cards: [{ id, title, text?, tags?, nodeId? }] }] }. table: { columns: [{ key, label }], rows: [{ ... }] }. checklist: { items: [{ id, label, checked, text? }] }. notepad: { text }.'
          },
          icon: { type: 'string', description: 'Icon name, see save_tool.' },
          pinned: { type: 'boolean' },
          hotkey: {
            type: 'string',
            description:
              'Global shortcut that opens this tool from any application, e.g. "Ctrl+Shift+T". Offer one for tools the user will reach for while working in something else — a translator or a scratchpad. Needs at least one modifier. Ask before claiming a common combination.'
          },
          openInWindow: {
            type: 'boolean',
            description:
              'Open in its own window instead of the main area. Right for a small tool used beside other work; wrong for a wide board.'
          },
          alwaysOnTop: {
            type: 'boolean',
            description:
              'Keep that window above other applications. Only with openInWindow, and only when the user has asked for it.'
          },
          windowWidth: {
            type: 'number',
            description:
              'With openInWindow: the size it first opens at, in pixels. 380 or more. After that the user resizes it and that size is remembered instead, so this is only the starting point — but get it close, because opening a one-field tool at 1040 wide looks wrong. Roughly 480 for a small input-and-result tool, 900 or more for a board.'
          },
          windowHeight: {
            type: 'number',
            description: 'With openInWindow: the height it first opens at. 280 or more.'
          },
          model: {
            type: 'string',
            enum: ['opus', 'sonnet', 'fable', 'haiku'],
            description:
              "The model this tool's own buttons run on. Omit to follow the app's setting. Pick per job, not by habit: haiku or sonnet for a rewrite or a lookup, where waiting is the whole cost; fable when the output is prose the user will send; opus for judgement, planning and anything multi-step. A button that takes ten seconds to fix a sentence is a worse tool than one that takes two."
          },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max'],
            description:
              "The thinking budget for this tool's turns. Omit to follow the app's setting. Low for mechanical work — translate, reformat, extract. High and above only when the tool genuinely has to reason, like a weekly review or a plan."
          }
        },
        required: ['name', 'description', 'kind']
      },
      mutating: true,
      handler: (args) => {
        const name = str(args, 'name')
        const description = str(args, 'description')
        const kind = str(args, 'kind') as ToolKind | undefined
        const allowed = ['code', 'canvas', 'workbench', 'kanban', 'table', 'checklist', 'notepad']

        if (!name || !description || !kind) {
          return fail('name, description and kind are required')
        }
        if (!allowed.includes(kind)) {
          return fail(`kind must be one of ${allowed.join(', ')}`)
        }

        // `save()` without an id matches on name, so creating a tool that already
        // exists overwrote it — the user's interface replaced by a new one with no
        // warning and no undo. Creating is creating; changing an existing tool is
        // what update_interactive_tool is for, and it takes an id.
        const clash = core.tools.list().find((t) => t.name.toLowerCase() === name.toLowerCase())
        if (clash) {
          return fail(
            `"${clash.name}" already exists (id ${clash.id}). Read it with inspect_tool and change it with update_interactive_tool, or pick a different name — do not recreate it, that would throw away what is there.`
          )
        }

        const fields = readFields(args['fields'])
        const actions = readActions(args['actions'])
        const layout = readLayout(args['layout'])
        const source = str(args, 'source') ?? ''

        if (actions.length === 0) {
          return fail(
            'A tool with no actions is just a form. Give it the two or three jobs that make it useful — for a translator that is things like "Casual English" and "Fix grammar" — then call this again.'
          )
        }

        const problem =
          kind === 'code'
            ? checkCode(source, actions)
            : kind === 'canvas'
              ? checkCanvas(layout, actions)
              : checkFieldRefs(fields, actions)
        if (problem) return fail(problem)

        // A malformed accelerator is reported rather than silently dropped, so the
        // agent can offer the user a valid one instead.
        let hotkey: string | null = null
        let hotkeyNote = ''
        const requested = str(args, 'hotkey')
        if (requested) {
          const parsed = normaliseHotkey(requested)
          if (!parsed.ok || !parsed.accelerator) {
            return fail(`The shortcut "${requested}" is not usable: ${parsed.error}`)
          }
          const owner = core.tools.hotkeyOwner(parsed.accelerator)
          if (owner) {
            return fail(
              `${formatHotkey(parsed.accelerator, process.platform)} is already used by "${owner.name}". Pick another or ask the user which they prefer.`
            )
          }
          hotkey = parsed.accelerator
          hotkeyNote = ` ${formatHotkey(parsed.accelerator, process.platform)} opens it from anywhere.`
        }

        const state = args['state']
        const tool = core.tools.save({
          name,
          description,
          hotkey,
          openInWindow: args['openInWindow'] === true,
          alwaysOnTop: args['alwaysOnTop'] === true,
          // An interactive tool has no prompt to send; its instructions and actions
          // carry the context instead.
          prompt: '',
          kind,
          instructions: str(args, 'instructions') ?? '',
          state: state && typeof state === 'object' ? (state as Record<string, unknown>) : undefined,
          fields,
          actions,
          layout,
          source,
          model: str(args, 'model') ?? null,
          effort: (str(args, 'effort') as SavedTool['effort']) ?? null,
          windowWidth: num(args, 'windowWidth') ?? null,
          windowHeight: num(args, 'windowHeight') ?? null,
          icon: str(args, 'icon') ?? null,
          pinned: args['pinned'] === true,
          createdBy: 'agent'
        })

        core.recordActivity({
          kind: 'tool.created',
          actor: 'agent',
          title: `Built a ${kind} tool: ${tool.name}`,
          detail: { id: tool.id, kind }
        })
        core.broadcast('tools:changed')

        deps.syncShortcuts()

        return ok(
          `Created "${tool.name}" as a ${kind} with ${actions.length} button(s): ${actions.map((a) => a.label).join(', ')}.${hotkeyNote} It opens from the Tools panel. Tell them it exists and what the buttons do, in one or two lines.`
        )
      }
    },
    {
      name: 'preview_tool',
      description:
        'Look at a tool as the user will see it. Returns a screenshot of it rendered at real size. Use it immediately after building or changing one, then judge it the way you would judge any interface: are the buttons readable, do labels wrap badly, is a column too narrow, is anything crowded or empty. Fix what you see with update_tool_definition and preview again. Do not tell the user a tool is ready before you have looked at it.',
      inputSchema: {
        type: 'object',
        properties: {
          toolId: { type: 'string' },
          width: { type: 'number', description: 'Viewport width, 420-2000. Default 1100.' },
          height: { type: 'number', description: 'Viewport height, 320-1600. Default 760.' },
          sampleOutput: {
            type: 'string',
            description:
              'For a workbench: pretend the tool produced this, so you can see how a real result lays out. Not saved.'
          },
          sampleInputs: {
            type: 'object',
            description: 'For a workbench: fill the inputs with these while previewing. Not saved.'
          },
          sampleState: {
            type: 'object',
            description:
              'For a code or canvas tool: a document to render with, merged over the real one. Fill it the way it will look in use — an interface that looks fine blank often falls apart with real content in it. Not saved.'
          }
        },
        required: ['toolId']
      },
      handler: async (args) => {
        const toolId = str(args, 'toolId')
        if (!toolId) return fail('toolId is required')

        const tool = core.tools.get(toolId)
        if (!tool) return fail(`no tool with id ${toolId}`)
        if (tool.kind === 'prompt') {
          return fail('a prompt tool has no interface to look at; only interactive tools do')
        }

        // Sample content is written, captured, then rolled back — the preview must
        // not leave anything behind in the user's document.
        const sampleOutput = str(args, 'sampleOutput')
        const sampleInputs = args['sampleInputs']
        const sampleState = args['sampleState']
        const original = tool.state
        /** The revision the sample write produced, or null if no sample was written. */
        let sampleRev: number | null = null

        try {
          const hasSample =
            !!sampleOutput ||
            (!!sampleInputs && typeof sampleInputs === 'object') ||
            (!!sampleState && typeof sampleState === 'object')

          if (hasSample) {
            const draft: Record<string, unknown> = { ...(original as Record<string, unknown>) }
            if (sampleState && typeof sampleState === 'object') {
              Object.assign(draft, sampleState as Record<string, unknown>)
            }
            if (sampleOutput) draft['output'] = sampleOutput
            if (sampleInputs && typeof sampleInputs === 'object') {
              draft['inputs'] = { ...(draft['inputs'] as object), ...(sampleInputs as object) }
            }
            sampleRev = core.tools.writeState(toolId, draft, tool.rev).rev
          }

          // Failures from before this render would be misleading; what matters is
          // what the code did just now.
          if (tool.kind === 'code') clearToolErrors(toolId)

          const shot = await deps.previewTool({
            toolId,
            width: num(args, 'width'),
            height: num(args, 'height')
          })

          const raised = readToolErrors(toolId)

          return {
            content: [
              `Screenshot of "${tool.name}" (${tool.kind}) at ${shot.width}x${shot.height}.`,
              `${tool.actions.length} action(s): ${tool.actions.map((a) => a.label).join(', ')}`,
              tool.fields.length ? `${tool.fields.length} input(s): ${tool.fields.map((f) => f.label).join(', ')}` : '',
              raised.length > 0
                ? [
                    '',
                    `Your code raised ${raised.length} error(s) while rendering. Fix these first — what you see above is a tool that is already broken:`,
                    ...raised.map(
                      (error) =>
                        `  - ${error.message}${error.where ? ` (${error.where})` : ''}${error.stack ? `\n    ${error.stack.split('\n')[0]}` : ''}`
                    )
                  ].join('\n')
                : '',
              '',
              'Look at it and fix anything that reads badly before telling the user it is done.'
            ]
              .filter(Boolean)
              .join('\n'),
            images: [{ data: shot.dataBase64, mimeType: 'image/png' }]
          }
        } finally {
          if (sampleRev !== null) {
            try {
              // Only roll back if the sample is still what is stored. A tool that
              // saved during the screenshot — or a user typing in the open window —
              // has moved the document on, and restoring blind would silently
              // delete their work to undo a preview.
              const restored = core.tools.writeState(
                toolId,
                original as Record<string, unknown>,
                sampleRev
              )
              core.broadcast('tools:stateChanged', {
                toolId,
                rev: restored.rev,
                note: null
              })
            } catch {
              /* someone wrote after the sample; their version wins */
            }
          }
        }
      }
    },
    {
      name: 'inspect_tool',
      description:
        "The full definition of a tool — its kind, inputs, buttons and each button's prompt with placeholders resolved — plus any problems found. Read this before changing a tool so you edit what is there rather than replacing it.",
      inputSchema: {
        type: 'object',
        properties: { toolId: { type: 'string' } },
        required: ['toolId']
      },
      handler: (args) => {
        const toolId = str(args, 'toolId')
        if (!toolId) return fail('toolId is required')

        const tool = core.tools.get(toolId)
        if (!tool) return fail(`no tool with id ${toolId}`)

        const problems: string[] = []
        if (tool.actions.length === 0) problems.push('no buttons, so there is nothing to run')
        if (tool.kind === 'workbench' && tool.fields.length === 0) {
          problems.push('a workbench with no inputs has nothing to work on')
        }
        if (tool.actions.length > 5) {
          problems.push(`${tool.actions.length} buttons is more than a row reads comfortably`)
        }

        for (const action of tool.actions) {
          if (action.label.length > 18) {
            problems.push(`the label "${action.label}" is long enough to crowd the row`)
          }
        }

        const structural =
          tool.kind === 'code'
            ? checkCode(tool.source, tool.actions)
            : tool.kind === 'canvas'
              ? checkCanvas(tool.layout, tool.actions)
              : checkFieldRefs(tool.fields, tool.actions)
        if (structural) problems.push(structural)

        for (const error of readToolErrors(toolId)) {
          problems.push(
            `its code raised: ${error.message}${error.where ? ` (${error.where})` : ''}`
          )
        }

        return ok(
          [
            `name: ${tool.name}`,
            `kind: ${tool.kind}`,
            `description: ${tool.description}`,
            tool.icon ? `icon: ${tool.icon}` : 'icon: (default)',
            tool.hotkey ? `shortcut: ${tool.hotkey}` : 'shortcut: none',
            `opens in its own window: ${tool.openInWindow}`,
            `always on top: ${tool.alwaysOnTop}`,
            tool.instructions ? `instructions: ${tool.instructions}` : 'instructions: (none)',
            '',
            '--- inputs ---',
            tool.fields.length
              ? tool.fields
                  .map(
                    (field) =>
                      `  ${field.name} (${field.multiline ? 'multiline' : 'single line'}) "${field.label}"${field.placeholder ? ` placeholder: ${field.placeholder}` : ''}`
                  )
                  .join('\n')
              : '  none',
            '',
            '--- buttons ---',
            tool.actions.length
              ? tool.actions
                  .map(
                    (action) =>
                      `  [${action.id}] "${action.label}" -> ${action.target}${action.writeTo ? ` ${action.writeTo}` : ''}${action.primary ? ' (primary)' : ''}\n      ${action.prompt}`
                  )
                  .join('\n')
              : '  none',
            '',
            ...(tool.kind === 'canvas'
              ? ['--- layout ---', JSON.stringify(tool.layout, null, 2), '']
              : []),
            ...(tool.kind === 'code' ? ['--- source ---', tool.source, ''] : []),
            '--- problems ---',
            problems.length ? problems.map((problem) => `  - ${problem}`).join('\n') : '  none found'
          ].join('\n')
        )
      }
    },
    {
      name: 'update_tool_definition',
      description:
        'Change a tool without rebuilding it. Pass only what you are changing; everything else is left alone. Use it to fix what you saw in a preview — a shorter label, an extra button, a clearer placeholder, a wider column. The document the user has been working in is untouched unless you pass state.',
      inputSchema: {
        type: 'object',
        properties: {
          toolId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          instructions: { type: 'string' },
          icon: { type: 'string' },
          fields: { type: 'array', items: { type: 'object' } },
          actions: { type: 'array', items: { type: 'object' } },
          source: {
            type: 'string',
            description:
              'For a code tool: the replacement interface, whole — send the complete source, not a fragment or a diff. The document the user has been working in survives. Omit to leave the interface alone.'
          },
          layout: {
            type: 'array',
            description:
              'For a canvas: the replacement layout tree, whole. Same shape as create_interactive_tool. Omit to leave the interface alone.'
          },
          hotkey: { type: 'string', description: 'Pass an empty string to clear it.' },
          openInWindow: { type: 'boolean' },
          alwaysOnTop: { type: 'boolean' },
          pinned: { type: 'boolean' },
          model: {
            type: 'string',
            enum: ['opus', 'sonnet', 'fable', 'haiku', ''],
            description: "Empty string clears it, so the tool follows the app's setting."
          },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max', ''],
            description: "Empty string clears it, so the tool follows the app's setting."
          }
        },
        required: ['toolId']
      },
      mutating: true,
      handler: (args) => {
        const toolId = str(args, 'toolId')
        if (!toolId) return fail('toolId is required')

        const tool = core.tools.get(toolId)
        if (!tool) return fail(`no tool with id ${toolId}`)

        const fields = args['fields'] !== undefined ? readFields(args['fields']) : tool.fields
        const actions = args['actions'] !== undefined ? readActions(args['actions']) : tool.actions
        const layout = args['layout'] !== undefined ? readLayout(args['layout']) : tool.layout
        const source = str(args, 'source') ?? tool.source

        const problem =
          tool.kind === 'code'
            ? checkCode(source, actions)
            : tool.kind === 'canvas'
              ? checkCanvas(layout, actions)
              : checkFieldRefs(fields, actions)
        if (problem) return fail(problem)

        let hotkey = tool.hotkey
        const requestedHotkey = args['hotkey']
        if (typeof requestedHotkey === 'string') {
          if (requestedHotkey.trim() === '') {
            hotkey = null
          } else {
            const parsed = normaliseHotkey(requestedHotkey)
            if (!parsed.ok || !parsed.accelerator) {
              return fail(`The shortcut "${requestedHotkey}" is not usable: ${parsed.error}`)
            }
            const owner = core.tools.hotkeyOwner(parsed.accelerator, toolId)
            if (owner) {
              return fail(`${formatHotkey(parsed.accelerator, process.platform)} is already used by "${owner.name}".`)
            }
            hotkey = parsed.accelerator
          }
        }

        // Old failures belong to old code; keeping them would have the agent
        // chasing a bug it just fixed.
        if (source !== tool.source) clearToolErrors(toolId)

        const updated = core.tools.save({
          id: toolId,
          name: str(args, 'name') ?? tool.name,
          description: str(args, 'description') ?? tool.description,
          prompt: tool.prompt,
          kind: tool.kind,
          instructions: str(args, 'instructions') ?? tool.instructions,
          icon: str(args, 'icon') ?? tool.icon,
          fields,
          actions,
          layout,
          source,
          // An empty string is how the caller says "back to the app's setting",
          // which is different from omitting the field entirely.
          ...(args['model'] !== undefined ? { model: str(args, 'model') ?? null } : {}),
          ...(args['effort'] !== undefined
            ? { effort: (str(args, 'effort') as SavedTool['effort']) ?? null }
            : {}),
          hotkey,
          openInWindow:
            args['openInWindow'] !== undefined ? args['openInWindow'] === true : tool.openInWindow,
          alwaysOnTop:
            args['alwaysOnTop'] !== undefined ? args['alwaysOnTop'] === true : tool.alwaysOnTop,
          pinned: args['pinned'] !== undefined ? args['pinned'] === true : tool.pinned,
          createdBy: tool.createdBy
        })

        deps.syncShortcuts()
        core.broadcast('tools:changed')
        core.broadcast('tools:stateChanged', { toolId, rev: updated.rev, note: null })

        return ok(
          `Updated "${updated.name}". Preview it again to check the change landed the way you meant.`
        )
      }
    },
    {
      name: 'get_tool_state',
      description:
        "Read an interactive tool's current document, including its revision. Always read before you write — the user edits the same document, so what you last saw may be out of date.",
      inputSchema: {
        type: 'object',
        properties: { toolId: { type: 'string' } },
        required: ['toolId']
      },
      handler: (args) => {
        const toolId = str(args, 'toolId')
        if (!toolId) return fail('toolId is required')

        const tool = core.tools.get(toolId)
        if (!tool) return fail(`no tool with id ${toolId}`)

        return ok(
          [
            `tool: ${tool.name} (${tool.kind})`,
            `rev: ${tool.rev}`,
            tool.instructions ? `instructions: ${tool.instructions}` : '',
            '',
            JSON.stringify(tool.state, null, 2)
          ]
            .filter(Boolean)
            .join('\n')
        )
      }
    },
    {
      name: 'update_tool_state',
      description:
        "Replace an interactive tool's document. Pass the rev you read from get_tool_state; if the user changed something in between, the write is refused and you re-read rather than overwriting their work. Send the whole document, not a fragment. Preserve ids of things that already existed so the user's view does not jump.",
      inputSchema: {
        type: 'object',
        properties: {
          toolId: { type: 'string' },
          state: { type: 'object', description: 'The complete new document.' },
          rev: { type: 'number', description: 'The revision you read.' },
          note: {
            type: 'string',
            description: 'One line on what you changed, shown to the user in the tool.'
          }
        },
        required: ['toolId', 'state']
      },
      mutating: true,
      handler: (args) => {
        const toolId = str(args, 'toolId')
        const state = args['state']
        if (!toolId) return fail('toolId is required')
        if (!state || typeof state !== 'object') return fail('state must be the complete document')

        try {
          const updated = core.tools.writeState(
            toolId,
            state as Record<string, unknown>,
            num(args, 'rev')
          )
          core.broadcast('tools:stateChanged', {
            toolId,
            rev: updated.rev,
            note: str(args, 'note') ?? null
          })
          core.broadcast('tools:changed')

          return ok(`Updated "${updated.name}" (now revision ${updated.rev}).`)
        } catch (err) {
          if (err instanceof StaleToolWriteError) {
            return fail(
              `The user changed this tool while you were working (it is now at revision ${err.currentRev}). Call get_tool_state again, merge your change into what is there now, and retry.`
            )
          }
          throw err
        }
      }
    },
    {
      name: 'list_saved_tools',
      description:
        'The reusable tools already saved. Check before saving a new one so you update an existing tool rather than creating a near-duplicate.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const tools = core.tools.list()
        if (tools.length === 0) return ok('No saved tools yet.')

        return ok(
          tools
            .map(
              (tool) =>
                `- [${tool.id}] ${tool.name}${tool.pinned ? ' (pinned)' : ''} — ${tool.description}` +
                (tool.params.length ? `\n    params: ${tool.params.map((p) => p.name).join(', ')}` : '') +
                `\n    run ${tool.runCount} time(s)`
            )
            .join('\n')
        )
      }
    },
    {
      name: 'delete_saved_tool',
      description: 'Remove a saved tool the user no longer wants.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      },
      mutating: true,
      handler: (args) => {
        const id = str(args, 'id')
        if (!id) return fail('id is required')

        const tool = core.tools.get(id)
        if (!tool) return fail(`no saved tool with id ${id}`)

        core.tools.remove(id)
        core.broadcast('tools:changed')
        return ok(`Removed "${tool.name}".`)
      }
    },

    /* ------------------------------------------------------- integrations */
    {
      name: 'list_integrations',
      description:
        'Every connected tool and the callable operations it exposes. Check here before telling the user something cannot be done.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        /*
         * Two lists, because there are two states worth knowing about and only one of them is
         * callable.
         *
         * This used to report the callable ones alone, which meant an integration the agent had
         * just registered — saved disabled by design, waiting on a credential only the user can
         * supply — came back as "No integrations are connected yet". The agent would then either
         * register it a second time or tell the user the thing was impossible, while the record
         * sat in storage passing its own tests. Being unable to call something is not a reason to
         * deny it exists.
         */
        const [tools, summaries] = await Promise.all([
          deps.integrations.listTools(),
          Promise.resolve(deps.integrations.describeAll())
        ])

        if (summaries.length === 0) {
          return ok(
            'No integrations are registered yet. You can build one: see register_integration.'
          )
        }

        const sections: string[] = []

        /* ------------------------------------------------------------- callable */

        if (tools.length > 0) {
          const grouped = new Map<string, string[]>()
          for (const tool of tools) {
            const list = grouped.get(tool.integrationName) ?? []
            list.push(
              `    ${tool.qualifiedName}${tool.mutating ? ' [changes data]' : ''} — ${tool.description}`
            )
            grouped.set(tool.integrationName, list)
          }
          sections.push(
            'Connected and callable:',
            [...grouped.entries()].map(([name, lines]) => `  ${name}:\n${lines.join('\n')}`).join('\n')
          )
        }

        /* -------------------------------------------------------- not callable yet */

        const waiting = summaries.filter((summary) => summary.status !== 'enabled')
        if (waiting.length > 0) {
          const lines = waiting.map((summary) => {
            const bits = [
              `  ${summary.name} (${summary.id}) — ${summary.kind}, ${summary.status}, added by ${summary.createdBy}`
            ]
            if (summary.baseUrl) bits.push(`    base URL: ${summary.baseUrl}`)
            if (summary.operations.length > 0) {
              bits.push(
                `    ${summary.operations.length} operation(s): ${summary.operations
                  .map((op) => op.name)
                  .join(', ')}`
              )
            }
            // The refs, so the agent can tell the user precisely what to go and fetch. Refs and
            // labels only — there is no path by which this tool sees a value.
            if (summary.missingSecrets.length > 0) {
              bits.push(`    still needs: ${summary.missingSecrets.join(', ')}`)
            }
            const expired = summary.secrets.filter((secret) => secret.expired).map((s) => s.ref)
            if (expired.length > 0) {
              bits.push(`    past its stated expiry: ${expired.join(', ')}`)
            }
            return bits.join('\n')
          })

          sections.push(
            'Registered but not callable — the user has to act on these in the Integrations panel:',
            lines.join('\n'),
            'Do not try to call these, and do not register them again. Tell the user what to supply and where to get it.'
          )
        }

        return ok(sections.join('\n\n'))
      }
    },
    {
      name: 'call_integration',
      description:
        'Invoke an operation on a connected integration. Get exact names from list_integrations first. Anything marked [changes data] — sending mail, posting, creating records — needs the user to agree in the conversation before you call it.',
      inputSchema: {
        type: 'object',
        properties: {
          integrationId: { type: 'string' },
          tool: { type: 'string', description: 'Operation name within that integration.' },
          args: { type: 'object', description: 'Arguments for the operation.' }
        },
        required: ['integrationId', 'tool']
      },
      mutating: true,
      handler: async (args) => {
        const integrationId = str(args, 'integrationId')
        const tool = str(args, 'tool')
        if (!integrationId || !tool) return fail('integrationId and tool are required')

        return await deps.integrations.callTool(
          integrationId,
          tool,
          (args['args'] as Record<string, unknown> | undefined) ?? {}
        )
      }
    },
    {
      name: 'register_integration',
      description:
        'Connect a new tool by writing its manifest yourself. Kinds: "mcp-stdio" and "mcp-http" for anything with an MCP server; "rest" for a plain HTTP API with none/apiKey/bearer/basic/oauth2 auth (this is how Gmail and similar services connect); "script" for a Node script you author in the integrations folder; "webhook" to capture inbound payloads as notes. Secrets are never written into the manifest — declare requiredSecrets and the user fills them in. The integration is saved disabled and shown to the user for approval.',
      inputSchema: {
        type: 'object',
        properties: {
          manifest: {
            type: 'object',
            description:
              'Full integration manifest: { id, name, description, kind, enabled, createdBy: "agent", ...kind-specific fields }.'
          }
        },
        required: ['manifest']
      },
      mutating: true,
      handler: async (args) => {
        const manifest = args['manifest']
        if (!manifest || typeof manifest !== 'object') return fail('manifest must be an object')

        const result = await deps.integrations.register(manifest as IntegrationManifest)
        return result.ok ? ok(result.message) : fail(result.message)
      }
    },
    {
      name: 'test_integration',
      description:
        'Make one real authenticated request to an integration and report what the service said, including the HTTP status. Use this to confirm a credential actually works after the user has entered it.',
      inputSchema: {
        type: 'object',
        properties: { integrationId: { type: 'string' } },
        required: ['integrationId']
      },
      handler: async (args) => {
        const id = str(args, 'integrationId')
        if (!id) return fail('integrationId is required')
        /*
         * `probe`, not `test`.
         *
         * `test` enumerates the manifest's own operations and, for a REST integration, never
         * leaves the machine — so it reported success for a Figma integration with no token at
         * all. An agent told "it connects" by something that never connected will tell the user
         * the same thing.
         */
        const result = await deps.integrations.probe(id)
        return result.ok ? ok(result.message) : fail(result.message)
      }
    },
    {
      name: 'manage_integration',
      description:
        [
          'Change an integration on the user\'s behalf: turn it off, forget a credential, record',
          'or clear an expiry date, remove it, or open the Integrations panel at it so the user',
          'can paste something.',
          '',
          'Two things are deliberately not here. You cannot write a credential value — that is',
          'the user\'s to enter, and there is no tool for it anywhere. And you cannot *enable* an',
          'integration: enabling is what makes it callable by you, so it needs a human press.',
          'Use open_panel to put the user in front of the right card, and say what to paste.'
        ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          integrationId: { type: 'string' },
          action: {
            type: 'string',
            enum: ['disable', 'forget_secret', 'set_expiry', 'clear_expiry', 'remove', 'open_panel'],
            description: 'What to do.'
          },
          secretRef: {
            type: 'string',
            description: 'Required for forget_secret, set_expiry and clear_expiry.'
          },
          expiresAt: {
            type: 'string',
            description: 'ISO date for set_expiry, e.g. 2026-08-20. Read as the end of that day.'
          }
        },
        required: ['integrationId', 'action']
      },
      mutating: true,
      handler: async (args) => {
        const id = str(args, 'integrationId')
        const action = str(args, 'action')
        if (!id || !action) return fail('integrationId and action are required')

        const summary = deps.integrations.describeAll().find((entry) => entry.id === id)
        if (!summary) return fail(`no integration "${id}"`)

        const ref = str(args, 'secretRef')
        const declared = new Set(summary.secrets.map((secret) => secret.ref))

        switch (action) {
          case 'disable':
            deps.integrations.setEnabled(id, false)
            return ok(`${summary.name} is off. Nothing will call it until the user turns it back on.`)

          case 'forget_secret': {
            if (!ref) return fail('secretRef is required for forget_secret')
            if (!declared.has(ref)) {
              return fail(`${summary.name} does not declare "${ref}". It declares: ${[...declared].join(', ') || 'nothing'}`)
            }
            deps.integrations.deleteSecret(ref)
            return ok(
              `Forgot "${ref}". ${summary.name} is back to pending, so it can no longer be called until the user enters it again.`
            )
          }

          case 'set_expiry': {
            if (!ref) return fail('secretRef is required for set_expiry')
            if (!declared.has(ref)) return fail(`${summary.name} does not declare "${ref}"`)
            const raw = str(args, 'expiresAt')
            if (!raw) return fail('expiresAt is required for set_expiry')
            const parsed = new Date(raw)
            if (Number.isNaN(parsed.getTime())) return fail(`"${raw}" is not a date I can read`)
            // End of the stated day, so a 7-day token is not reported dead from its own morning.
            parsed.setHours(23, 59, 59, 999)
            deps.integrations.setSecretExpiry(ref, parsed.getTime())
            return ok(`"${ref}" is recorded as expiring ${parsed.toDateString()}. The panel warns once it passes.`)
          }

          case 'clear_expiry': {
            if (!ref) return fail('secretRef is required for clear_expiry')
            if (!declared.has(ref)) return fail(`${summary.name} does not declare "${ref}"`)
            deps.integrations.setSecretExpiry(ref, null)
            return ok(`"${ref}" no longer has an expiry date.`)
          }

          case 'remove':
            deps.integrations.remove(id)
            return ok(`Removed ${summary.name}, along with the credentials belonging to it.`)

          case 'open_panel':
            deps.focusIntegration(id)
            return ok(
              [
                `Opened the Integrations panel at ${summary.name}.`,
                summary.missingSecrets.length > 0
                  ? `It is waiting for: ${summary.secrets
                      .filter((secret) => !secret.isSet)
                      .map((secret) => `${secret.label} (${secret.ref})`)
                      .join(', ')}. Tell the user exactly where to get each one.`
                  : 'Everything it needs is already there.'
              ].join(' ')
            )

          default:
            return fail(`unknown action "${action}"`)
        }
      }
    }
  ]
}

/** Tool names available at each capability tier. */
export const READ_ONLY_TOOLS = [
  'search_notes',
  'get_note',
  'list_recent_notes',
  'graph_overview',
  'graph_neighborhood',
  'render_ui',
  'focus_graph',
  'recall',
  'list_activity',
  'list_integrations',
  'suggest'
]

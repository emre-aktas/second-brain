import type {
  DeepPartial,
  ActivityEntry,
  BrainEdge,
  BrainNode,
  EdgeKind,
  EdgeOrigin,
  GraphSnapshot,
  NodeKind,
  Settings
} from '@shared/types'
import { Db } from './db/sqlite'
import { migrate } from './db/schema'
import { EdgeStore, NodeStore, type SearchHit, type SearchOptions } from './db/nodes'
import { GraphStore } from './db/graph'
import {
  ActivityStore,
  IntegrationAuditStore,
  IntegrationStore,
  KvStore,
  SuggestionStore,
  type ActivityInput
} from './db/meta'
import { ChatStore } from './db/chat'
import { TaskRunStore, TaskStore } from './db/tasks'
import { InboxStore } from './db/inbox'
import { ToolStore } from './db/tools'
import { Vault } from './vault/vault'
import { Indexer } from './vault/indexer'
import { VaultWatcher } from './vault/watcher'
import { deriveSummary, parseNote, serializeNote } from './vault/markdown'
import type { AppPaths } from './paths'
import type { SettingsStore } from './settings'
import { createLogger } from './logger'

const log = createLogger('core')

export type BroadcastFn = (channel: string, payload?: unknown) => void

export interface CreateNoteInput {
  title: string
  body: string
  tags?: string[]
  kind?: NodeKind
  folder?: string
  summary?: string | null
  actor?: string
  /** When this note stops being worth keeping. Null or absent means permanent. */
  expiresAt?: number | null
}

export interface UpdateNoteInput {
  body?: string
  title?: string
  kind?: NodeKind
  tags?: string[]
  summary?: string | null
  mode?: 'replace' | 'append' | 'prepend'
  actor?: string
  /** Undefined leaves it alone; null makes the note permanent. */
  expiresAt?: number | null
}

/**
 * The single place that knows how to mutate the brain.
 *
 * IPC handlers and the agent's tools both go through here, so a note created by
 * the user and one created by the agent follow exactly the same path: write the
 * markdown file, re-index it, record activity, notify the renderer.
 */
export class BrainCore {
  readonly db: Db
  readonly nodes: NodeStore
  readonly edges: EdgeStore
  readonly graph: GraphStore
  readonly activity: ActivityStore
  readonly suggestions: SuggestionStore
  readonly integrations: IntegrationStore
  readonly integrationAudit: IntegrationAuditStore
  readonly kv: KvStore
  readonly chat: ChatStore
  readonly tools: ToolStore
  readonly tasks: TaskStore
  readonly taskRuns: TaskRunStore
  readonly inbox: InboxStore
  readonly vault: Vault
  readonly indexer: Indexer
  readonly watcher: VaultWatcher

  private broadcastFn: BroadcastFn = () => {}
  /** Coalesces bursts of graph mutations into one renderer notification. */
  private graphDirtyTimer: NodeJS.Timeout | null = null

  constructor(
    readonly paths: AppPaths,
    private settingsStore: SettingsStore
  ) {
    this.db = new Db(paths.dbPath)
    migrate(this.db)

    this.nodes = new NodeStore(this.db)
    this.edges = new EdgeStore(this.db)
    this.graph = new GraphStore(this.db)
    this.activity = new ActivityStore(this.db)
    this.suggestions = new SuggestionStore(this.db)
    this.integrations = new IntegrationStore(this.db)
    this.integrationAudit = new IntegrationAuditStore(this.db)
    this.kv = new KvStore(this.db)
    this.chat = new ChatStore(this.db)
    this.tools = new ToolStore(this.db)
    this.tasks = new TaskStore(this.db)
    this.taskRuns = new TaskRunStore(this.db)
    this.inbox = new InboxStore(this.db)

    this.vault = new Vault(paths.vaultDir, paths.trashDir)
    this.indexer = new Indexer(this.db, this.vault, this.nodes, this.edges)

    this.watcher = new VaultWatcher(this.vault, this.nodes, {
      onChanged: (relPath) => this.onExternalChange(relPath),
      onRemoved: (relPath) => this.onExternalRemove(relPath)
    })
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcastFn = fn
  }

  get settings(): Settings {
    return this.settingsStore.get()
  }

  updateSettings(patch: DeepPartial<Settings>): Settings {
    const next = this.settingsStore.update(patch)
    this.broadcastFn('settings:changed', next)

    // Two of the graph settings are *query* parameters, not draw parameters: whether tags
    // and inferred edges are in the snapshot at all is decided in SQL (`db/graph.ts`).
    // Broadcasting the new settings therefore changed nothing on screen — the renderer
    // held a snapshot built under the old ones, and the toggle appeared to do nothing
    // until an unrelated edit happened to invalidate it. Done here rather than in the
    // renderer so every window agrees, including a popped-out tool.
    const graph = patch.graph
    if (graph && ('showTags' in graph || 'showSimilarEdges' in graph)) {
      this.markGraphDirty('settings')
    }

    return next
  }

  /* ------------------------------------------------------------- lifecycle */

  start(): void {
    const report = this.indexer.fullReindex()
    this.activity.add({
      kind: 'app.indexed',
      actor: 'system',
      title: `Indexed ${report.scanned} notes`,
      detail: { ...report }
    })
    this.watcher.start()
  }

  shutdown(): void {
    this.watcher.stop()
    if (this.graphDirtyTimer) clearTimeout(this.graphDirtyTimer)
    this.db.optimize()
    this.db.close()
  }

  /* ---------------------------------------------------------- broadcasting */

  broadcast(channel: string, payload?: unknown): void {
    this.broadcastFn(channel, payload)
  }

  /**
   * Mark the graph as changed. Debounced because a reindex or a curator pass can
   * touch hundreds of nodes, and the renderer only needs one refresh.
   */
  markGraphDirty(reason: string): void {
    if (this.graphDirtyTimer) return
    this.graphDirtyTimer = setTimeout(() => {
      this.graphDirtyTimer = null
      this.broadcastFn('graph:changed', { reason })
    }, 120)
    this.graphDirtyTimer.unref?.()
  }

  recordActivity(input: ActivityInput): ActivityEntry {
    const entry = this.activity.add(input)
    this.broadcastFn('activity:new', entry)
    return entry
  }

  /* ------------------------------------------------------------ graph reads */

  snapshot(): GraphSnapshot {
    const { showTags, showSimilarEdges } = this.settings.graph
    return this.graph.snapshot({ showTags, showSimilarEdges })
  }

  search(query: string, opts?: SearchOptions): SearchHit[] {
    return this.nodes.search(query, opts)
  }

  /* ----------------------------------------------------------- note writes */

  createNote(input: CreateNoteInput): BrainNode {
    const summary = input.summary ?? deriveSummary(input.body) ?? null

    const { relPath } = this.vault.createNote({
      title: input.title,
      body: input.body,
      kind: input.kind ?? 'note',
      tags: input.tags ?? [],
      summary,
      created: Date.now(),
      // Into the file's own frontmatter, so it is visible and editable outside the
      // app and survives the index being rebuilt.
      expires: input.expiresAt ?? null
    })

    this.watcher.suppress(relPath)
    const indexed = this.indexer.indexFile(relPath)
    const node = indexed ? this.nodes.getById(indexed.nodeId) : this.nodes.getByPath(relPath)
    if (!node) throw new Error(`note was written to ${relPath} but could not be indexed`)

    this.recordActivity({
      kind: 'note.created',
      actor: input.actor ?? 'user',
      title: input.title,
      nodeId: node.id,
      detail: { path: relPath, tags: node.tags }
    })
    this.markGraphDirty('note.created')
    this.broadcastFn('node:changed', { id: node.id, reason: 'created' })

    return node
  }

  updateNote(ref: string, patch: UpdateNoteInput): BrainNode {
    const node = this.nodes.resolve(ref)
    if (!node) throw new Error(`no note matches "${ref}"`)
    if (!node.path) throw new Error(`"${node.title}" is a ${node.kind}, not an editable note`)

    const raw = this.vault.read(node.path)
    const parsed = parseNote(raw, node.title)

    const mode = patch.mode ?? 'replace'
    let body = parsed.body
    if (patch.body !== undefined) {
      if (mode === 'append') body = `${parsed.body.trimEnd()}\n\n${patch.body.trim()}\n`
      else if (mode === 'prepend') body = `${patch.body.trim()}\n\n${parsed.body.trimStart()}`
      else body = patch.body
    }

    const title = patch.title ?? parsed.title
    const tags = patch.tags ?? parsed.frontmatter['tags']
    const summary =
      patch.summary !== undefined ? patch.summary : (parsed.summary ?? deriveSummary(body))

    // Undefined leaves the note's own expiry alone; null clears it, which is how
    // "keep this permanently" is said.
    const expires =
      patch.expiresAt !== undefined ? patch.expiresAt : (parsed.expires ?? null)

    const content = serializeNote({
      title,
      body,
      // Refiling has to be possible, or the specific kinds only ever apply to notes
      // written after they existed.
      kind: patch.kind ?? parsed.kind,
      tags: Array.isArray(tags) ? (tags as string[]) : (parsed.tags ?? []),
      summary,
      created: parsed.created ?? node.createdAt,
      updated: Date.now(),
      expires,
      extra: parsed.frontmatter
    })

    // A title change should follow through to the filename, since links resolve
    // by title and the vault is meant to stay readable outside the app.
    let path = node.path
    if (patch.title && patch.title !== parsed.title) {
      const renamed = this.renameNoteFile(node, patch.title)
      path = renamed ?? node.path
    }

    this.vault.write(path, content)
    this.watcher.suppress(path)
    this.indexer.indexFile(path)

    const updated = this.nodes.getByPath(path)
    if (!updated) throw new Error(`could not re-index ${path} after update`)

    this.recordActivity({
      kind: 'note.updated',
      actor: patch.actor ?? 'user',
      title: updated.title,
      nodeId: updated.id,
      detail: { path, mode }
    })
    this.markGraphDirty('note.updated')
    this.broadcastFn('node:changed', { id: updated.id, reason: 'updated' })

    return updated
  }

  private renameNoteFile(node: BrainNode, newTitle: string): string | null {
    if (!node.path) return null

    const folder = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''
    const stem = newTitle.replace(/[<>:"/\\|?*]/g, '-').trim() || 'Untitled'
    let candidate = folder ? `${folder}/${stem}.md` : `${stem}.md`

    if (candidate === node.path) return node.path

    let counter = 2
    while (this.vault.exists(candidate)) {
      candidate = folder ? `${folder}/${stem} ${counter}.md` : `${stem} ${counter}.md`
      counter++
      if (counter > 100) return node.path
    }

    try {
      this.vault.rename(node.path, candidate)
      this.watcher.suppress(node.path)
      this.watcher.suppress(candidate)
      this.db.run('UPDATE nodes SET path = ? WHERE id = ?', [candidate, node.id])
      return candidate
    } catch (err) {
      log.warn(`could not rename ${node.path} to ${candidate}`, err)
      return node.path
    }
  }

  /** Soft delete: the file moves to .trash so any mistake stays recoverable. */
  trashNote(ref: string, actor = 'user'): { id: string; trashPath: string } {
    const node = this.nodes.resolve(ref)
    if (!node) throw new Error(`no note matches "${ref}"`)
    if (!node.path) throw new Error(`"${node.title}" is a ${node.kind} and has no file to remove`)

    const trashPath = this.vault.trash(node.path)
    this.watcher.suppress(node.path)
    this.indexer.removeFile(node.path)

    this.recordActivity({
      kind: 'note.trashed',
      actor,
      title: node.title,
      nodeId: node.id,
      detail: { path: node.path, trashPath }
    })
    this.markGraphDirty('note.trashed')

    return { id: node.id, trashPath }
  }

  linkNotes(
    fromRef: string,
    toRef: string,
    kind: EdgeKind = 'derived',
    label?: string | null,
    origin: EdgeOrigin = 'agent',
    weight = 1
  ): BrainEdge {
    const from = this.nodes.resolve(fromRef)
    const to = this.nodes.resolve(toRef)
    if (!from) throw new Error(`no node matches "${fromRef}"`)
    if (!to) throw new Error(`no node matches "${toRef}"`)
    if (from.id === to.id) throw new Error('a node cannot link to itself')

    const edge = this.edges.add(from.id, to.id, kind, { label, origin, weight })
    if (!edge) throw new Error('could not create the link')

    this.recordActivity({
      kind: 'edge.added',
      actor: origin === 'agent' ? 'agent' : origin,
      title: `${from.title} → ${to.title}`,
      nodeId: from.id,
      detail: { to: to.id, kind, label }
    })
    this.markGraphDirty('edge.added')

    return edge
  }

  unlinkNotes(fromRef: string, toRef: string, kind?: EdgeKind, actor = 'user'): number {
    const from = this.nodes.resolve(fromRef)
    const to = this.nodes.resolve(toRef)
    if (!from || !to) throw new Error('both endpoints must exist')

    const removed = this.edges.remove(from.id, to.id, kind)
    if (removed > 0) {
      this.recordActivity({
        kind: 'edge.removed',
        actor,
        title: `${from.title} ⇸ ${to.title}`,
        nodeId: from.id,
        detail: { to: to.id, kind: kind ?? 'any' }
      })
      this.markGraphDirty('edge.removed')
    }
    return removed
  }

  reindex(): ReturnType<Indexer['fullReindex']> {
    const report = this.indexer.fullReindex()
    this.markGraphDirty('reindex')
    return report
  }

  /* -------------------------------------------------- external file changes */

  private onExternalChange(relPath: string): void {
    try {
      const result = this.indexer.indexFile(relPath)
      if (!result) return

      const node = this.nodes.getById(result.nodeId)
      if (result.changed && node) {
        this.recordActivity({
          kind: 'note.updated',
          actor: 'external',
          title: node.title,
          nodeId: node.id,
          detail: { path: relPath, source: 'filesystem' }
        })
        this.broadcastFn('node:changed', { id: node.id, reason: 'external' })
      }
      this.markGraphDirty('external.change')
    } catch (err) {
      log.warn(`could not index external change to ${relPath}`, err)
    }
  }

  private onExternalRemove(relPath: string): void {
    try {
      const id = this.indexer.removeFile(relPath)
      if (id) {
        this.recordActivity({
          kind: 'note.removed',
          actor: 'external',
          title: relPath,
          nodeId: id,
          detail: { path: relPath, source: 'filesystem' }
        })
      }
      this.markGraphDirty('external.remove')
    } catch (err) {
      log.warn(`could not remove index entry for ${relPath}`, err)
    }
  }
}

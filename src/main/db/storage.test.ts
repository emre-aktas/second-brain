import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from './sqlite'
import { migrate } from './schema'
import { InboxStore } from './inbox'
import { EdgeStore, NodeStore } from './nodes'
import { GraphStore } from './graph'
import { ActivityStore, KvStore, SuggestionStore } from './meta'
import { ChatStore } from './chat'
import { Vault } from '../vault/vault'
import { Indexer } from '../vault/indexer'

let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     got      ${a}\n     expected ${e}`}`)
}
function section(name: string): void {
  console.log(`\n--- ${name} ---`)
}

const root = mkdtempSync(join(tmpdir(), 'brain-storage-'))
const vaultDir = join(root, 'vault')
const trashDir = join(root, '.trash')
mkdirSync(vaultDir, { recursive: true })
mkdirSync(trashDir, { recursive: true })

function writeNote(name: string, content: string): void {
  writeFileSync(join(vaultDir, `${name}.md`), content, 'utf8')
}

writeNote(
  'Knowledge Graph',
  `---
title: Knowledge Graph
tags: [graph, physics]
---

The main screen. Uses a force simulation and links to [[Force Layout]] plus
[[Not Written Yet]]. Tagged #ui inline.
`
)

writeNote(
  'Force Layout',
  `---
title: Force Layout
tags: [physics]
---

Verlet-ish integration, charge and link forces. Related to [[Knowledge Graph]].
`
)

writeNote(
  'Ogrenme Gunlugu',
  `---
title: Öğrenme Günlüğü
tags: [öğrenme]
---

Bugün çalışma ışığı üzerine notlar. Grafik fiziği hakkında düşündüm.
`
)

writeNote('Orphan Note', `---\ntitle: Orphan Note\n---\n\nNothing links here and it links nowhere.\n`)

const db = new Db(join(root, '.brain', 'index.db'))
migrate(db)

const nodes = new NodeStore(db)
const edges = new EdgeStore(db)
const graph = new GraphStore(db)
const vault = new Vault(vaultDir, trashDir)
const indexer = new Indexer(db, vault, nodes, edges)

section('full reindex')
const report = indexer.fullReindex()
check('scanned 4 files', report.scanned, 4)
check('created 4 nodes', report.created, 4)
check('removed nothing', report.removed, 0)
console.log('   report:', report)

section('nodes and titles')
const kg = nodes.getByPath('Knowledge Graph.md')
check('kg indexed', kg?.title, 'Knowledge Graph')
check('kg tags include inline', kg?.tags.sort(), ['graph', 'physics', 'ui'])
check('kg summary derived', (kg?.summary ?? '').startsWith('The main screen'), true)
check('turkish title from frontmatter', nodes.getByPath('Ogrenme Gunlugu.md')?.title, 'Öğrenme Günlüğü')

section('wikilink resolution')
const forceLayout = nodes.getByTitle('Force Layout')
check('resolved by title', !!forceLayout, true)
const kgOut = edges.outgoing(kg!.id)
check('kg -> force layout edge exists', kgOut.some((e) => e.dst === forceLayout!.id && e.kind === 'link'), true)
check('bidirectional link recorded from both files', edges.outgoing(forceLayout!.id).some((e) => e.dst === kg!.id), true)

// Stub nodes were dropped in migration 2: a wikilink to a note that does not
// exist yet used to create a placeholder, which filled the graph with things the
// user never wrote. The link is simply not recorded until the note exists.
section('links to unwritten notes')
check('no placeholder node created', nodes.getByTitle('Not Written Yet'), undefined)
check(
  'nothing dangling out of kg',
  edges.outgoing(kg!.id).every((edge) => nodes.getById(edge.dst) !== undefined),
  true
)

section('tag nodes')
const tagNodes = nodes.listByKind('tag').map((n) => n.title).sort()
check('tag nodes created', tagNodes, ['graph', 'physics', 'ui', 'öğrenme'])

section('agent-origin edges survive reindex')
const orphan = nodes.getByPath('Orphan Note.md')!
edges.add(orphan.id, kg!.id, 'derived', { origin: 'agent', weight: 0.8, label: 'agent hunch' })
indexer.fullReindex()
check(
  'agent edge still present after reindex',
  edges.outgoing(orphan.id).some((e) => e.dst === kg!.id && e.origin === 'agent'),
  true
)
check(
  'vault edges not duplicated',
  edges.outgoing(kg!.id).filter((e) => e.dst === forceLayout!.id).length,
  1
)

section('writing the missing note connects the waiting link')
writeNote('Not Written Yet', `---\ntitle: Not Written Yet\n---\n\nNow it exists.\n`)
indexer.indexFile('Not Written Yet.md')
// The note that linked to it has to be reindexed for the edge to appear — that is
// what the curator's pass and the vault watcher do in the running app.
indexer.indexFile('Knowledge Graph.md')
const nowReal = nodes.getByTitle('Not Written Yet')
check('the note exists as a note', nowReal?.kind, 'note')
check('has a path', nowReal?.path, 'Not Written Yet.md')
check('the link is now recorded', edges.incoming(nowReal!.id).some((e) => e.src === kg!.id), true)
check('no duplicate node for the title', db.pluck<number>("SELECT COUNT(*) FROM nodes WHERE title_key = 'not written yet'"), 1)

section('search, including Turkish folding')
check('ascii search hits', nodes.search('force simulation').length > 0, true)
const turkishHits = nodes.search('ogrenme')
check('folded query matches Öğrenme', turkishHits.some((h) => h.node.title === 'Öğrenme Günlüğü'), true)
const accentedHits = nodes.search('çalışma')
check('accented query matches too', accentedHits.some((h) => h.node.title === 'Öğrenme Günlüğü'), true)
check('tag nodes excluded by default', turkishHits.every((h) => h.node.kind !== 'tag'), true)
check('top hit is the note, not its tag', turkishHits[0]?.node.title, 'Öğrenme Günlüğü')
check('excerpt produced', turkishHits[0]!.excerpt.length > 0, true)
check('virtual nodes can be opted back in', nodes.search('ogrenme', { includeVirtual: true }).some((h) => h.node.kind === 'tag'), true)
check('kind filter honoured', nodes.search('ogrenme', { kinds: ['tag'] }).every((h) => h.node.kind === 'tag'), true)
check('nonsense query returns nothing', nodes.search('zzzzqqqq').length, 0)
check('empty query is safe', nodes.search('   ').length, 0)
check('fts special chars are safe', Array.isArray(nodes.search('a"b OR (c*')), true)

section('graph snapshot')
const snap = graph.snapshot()
check('snapshot has nodes', snap.nodes.length > 0, true)
const ids = new Set(snap.nodes.map((n) => n.id))
check('every edge endpoint is present', snap.edges.every((e) => ids.has(e.src) && ids.has(e.dst)), true)
const noTags = graph.snapshot({ showTags: false })
check('tags can be filtered out', noTags.nodes.some((n) => n.kind === 'tag'), false)
check('filtered snapshot drops dangling edges', noTags.edges.every((e) => new Set(noTags.nodes.map((n) => n.id)).has(e.dst)), true)

section('graph stats and queries')
const stats = graph.stats()
console.log('   stats:', stats)
check('notes counted', stats.notes >= 5, true)
check('clusters computed', stats.clusters >= 1, true)
const hood = graph.neighborhood(kg!.id, 1)
check('neighborhood includes centre', hood.nodes.some((n) => n.id === kg!.id), true)
check('neighborhood includes neighbour', hood.nodes.some((n) => n.id === forceLayout!.id), true)
check('hubs returns notes', graph.hubs(5).length > 0, true)

section('positions persist')
nodes.setPositions([{ id: kg!.id, x: 12.5, y: -30 }])
check('position saved', graph.positions().get(kg!.id), { x: 12.5, y: -30 })

section('file removal')
indexer.removeFile('Orphan Note.md')
check('node gone', nodes.getByPath('Orphan Note.md'), undefined)
check('its edges cascaded', db.pluck<number>('SELECT COUNT(*) FROM edges WHERE src = ?', [orphan.id]), 0)
check('fts row cleaned', db.pluck<number>('SELECT COUNT(*) FROM nodes_fts WHERE node_id = ?', [orphan.id]), 0)

section('vault trash is recoverable')
const trashed = vault.trash('Force Layout.md')
check('trash path returned', trashed.length > 0, true)
check('file removed from vault', vault.exists('Force Layout.md'), false)

section('vault path traversal is blocked')
let blocked = false
try {
  vault.absolute('../../etc/passwd')
} catch {
  blocked = true
}
check('traversal rejected', blocked, true)
let blocked2 = false
try {
  vault.absolute('..\\..\\windows\\system32\\config')
} catch {
  blocked2 = true
}
check('windows-style traversal rejected', blocked2, true)
check('normal nested path allowed', vault.absolute('folder/note.md').endsWith('note.md'), true)

section('createNote collision handling')
const first = vault.createNote({ title: 'Duplicate Title', body: 'one' })
const second = vault.createNote({ title: 'Duplicate Title', body: 'two' })
check('first filename', first.relPath, 'Duplicate Title.md')
check('second gets a suffix', second.relPath, 'Duplicate Title 2.md')
const illegal = vault.createNote({ title: 'Q3: revenue/costs', body: 'x' })
check('illegal chars sanitised in filename', illegal.relPath, 'Q3- revenue-costs.md')

section('transactions roll back')
const before = db.pluck<number>('SELECT COUNT(*) FROM nodes')
try {
  db.transaction(() => {
    nodes.upsert({ kind: 'note', title: 'Doomed', body: '' })
    throw new Error('boom')
  })
} catch {
  /* expected */
}
check('rolled back', db.pluck<number>('SELECT COUNT(*) FROM nodes'), before)

section('nested transactions use savepoints')
const nestedBefore = db.pluck<number>('SELECT COUNT(*) FROM nodes')
db.transaction(() => {
  nodes.upsert({ kind: 'note', title: 'Outer', body: '' })
  try {
    db.transaction(() => {
      nodes.upsert({ kind: 'note', title: 'Inner', body: '' })
      throw new Error('inner boom')
    })
  } catch {
    /* inner rolled back, outer continues */
  }
})
check('outer committed, inner discarded', db.pluck<number>('SELECT COUNT(*) FROM nodes'), (nestedBefore ?? 0) + 1)
check('inner row absent', nodes.getByTitle('Inner'), undefined)
check('outer row present', nodes.getByTitle('Outer')?.title, 'Outer')

section('activity, suggestions, kv')
const activity = new ActivityStore(db)
activity.add({ kind: 'note.created', actor: 'user', title: 'Created a note', nodeId: kg!.id })
activity.add({ kind: 'agent.turn', actor: 'agent', title: 'Answered a question', detail: { cost: 0.01 } })
check('activity listed newest first', activity.list({ limit: 5 })[0]?.kind, 'agent.turn')
check('activity filter by kind', activity.list({ kinds: ['note.created'] }).length, 1)
check('activity detail round trip', activity.list({ kinds: ['agent.turn'] })[0]?.detail, { cost: 0.01 })
check('daily counts', activity.dailyCounts(7).length >= 1, true)

const suggestions = new SuggestionStore(db)
const sug = suggestions.add({
  kind: 'link',
  title: 'Link Orphan Note to Knowledge Graph',
  rationale: 'They share rare terms',
  payload: { fingerprint: 'a|b' },
  autoApplicable: true
})
check('pending count', suggestions.pendingCount(), 1)
check('fingerprint dedupe works', suggestions.hasSimilarPending('link', 'a|b'), true)
check('unknown fingerprint', suggestions.hasSimilarPending('link', 'zzz'), false)
suggestions.setStatus(sug.id, 'applied')
check('status updated', suggestions.pendingCount(), 0)

const kv = new KvStore(db)
kv.set('agent/focus', { topic: 'graph', depth: 2 })
check('kv round trip', kv.get('agent/focus'), { topic: 'graph', depth: 2 })
check('kv keys by prefix', kv.keys('agent/'), ['agent/focus'])
check('kv missing key', kv.get('nope'), undefined)

section('chat sessions, messages, genui')
const chat = new ChatStore(db)
const session = chat.createSession('Test conversation')
chat.addMessage({ sessionId: session.id, role: 'user', blocks: [{ type: 'text', text: 'hi' }], ts: Date.now() })
const spec = { title: 'Weekly', blocks: [{ type: 'text' as const, text: 'body' }] }
const rec = chat.addGenUi(spec, session.id, null)
const assistantMsg = chat.addMessage({
  sessionId: session.id,
  role: 'assistant',
  blocks: [{ type: 'text', text: 'here you go' }, { type: 'genui', specId: rec.id }],
  ts: Date.now(),
  meta: { costUsd: 0.02, model: 'sonnet' }
})
chat.attachGenUiToMessage(rec.id, assistantMsg.id)
check('messages listed in order', chat.listMessages(session.id).map((m) => m.role), ['user', 'assistant'])
check('message meta round trip', chat.listMessages(session.id)[1]?.meta?.costUsd, 0.02)
check('genui retrievable', chat.getGenUi(rec.id)?.spec.title, 'Weekly')
check('genui linked to message', chat.listGenUiForSession(session.id).length, 1)
chat.addCost(session.id, 0.02)
check('session cost accumulates', chat.getSession(session.id)?.totalCostUsd, 0.02)
chat.setClaudeSessionId(session.id, 'claude-abc')
check('claude session id stored', chat.getSession(session.id)?.claudeSessionId, 'claude-abc')
check('total spend', chat.totalSpend(), 0.02)

section('reopen from disk')
/* ------------------------------------------------------------------- inbox */

// The reliable half of notifications. A Windows toast is delivered to a shell identity
// and the click can be lost entirely, so this list is what makes "you were away"
// recoverable — which means it has to survive a restart and it has to count correctly.

console.log('\ninbox')

const inbox = new InboxStore(db)
const inboxSession = chat.createSession('a chat with something to say')

check('an empty inbox has nothing unread', inbox.unreadCount(), 0)

const firstEntry = inbox.add({
  sessionId: inboxSession.id,
  kind: 'reply',
  title: 'Second Brain replied',
  body: 'found three things'
})
check('an entry is stored', inbox.get(firstEntry.id)?.title, 'Second Brain replied')
check('and starts unread', inbox.get(firstEntry.id)?.readAt, null)
check('so the count sees it', inbox.unreadCount(), 1)

// Something the user was plainly looking at must not add to the badge.
const seen = inbox.add({
  sessionId: inboxSession.id,
  kind: 'question',
  title: 'The agent is asking',
  read: true
})
check('an already-seen entry is stored read', inbox.get(seen.id)?.readAt !== null, true)
check('and does not add to the count', inbox.unreadCount(), 1)

check('the list is newest first', inbox.list()[0]?.id, seen.id)

inbox.markRead(firstEntry.id)
check('marking one read clears it', inbox.unreadCount(), 0)

// Reaching the chat any other way is also reading it — the badge must not keep
// insisting after the user has read the thing.
const other = chat.createSession('another')
inbox.add({ sessionId: other.id, kind: 'task', title: 'Slack digest' })
inbox.add({ sessionId: other.id, kind: 'task', title: 'Slack digest again' })
check('two waiting on one chat', inbox.unreadCount(), 2)
check('opening that chat clears both', inbox.markSessionRead(other.id), 2)
check('and the count agrees', inbox.unreadCount(), 0)
check('a session with nothing waiting clears nothing', inbox.markSessionRead(other.id), 0)

inbox.add({ sessionId: null, kind: 'reply', title: 'a chat that has since gone' })
check('an entry can outlive its chat', inbox.list()[0]?.sessionId, null)

// markRead with no id is "all", which is what the popover's button uses.
inbox.add({ sessionId: inboxSession.id, kind: 'reply', title: 'one' })
inbox.add({ sessionId: inboxSession.id, kind: 'reply', title: 'two' })
check('several unread', inbox.unreadCount() >= 2, true)
inbox.markRead()
check('mark all read clears everything', inbox.unreadCount(), 0)

// Bounded, or the list grows for ever.
for (let i = 0; i < 30; i++) inbox.add({ sessionId: null, kind: 'reply', title: `bulk ${i}` })
inbox.prune(10)
check('pruning keeps the newest', inbox.list(100).length, 10)
check('and keeps the newest ones', inbox.list(1)[0]?.title, 'bulk 29')

db.close()
const db2 = new Db(join(root, '.brain', 'index.db'))
const nodes2 = new NodeStore(db2)
check('data survived close/reopen', nodes2.getByTitle('Knowledge Graph')?.title, 'Knowledge Graph')
check('fts survived', nodes2.search('force').length > 0, true)
db2.close()

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

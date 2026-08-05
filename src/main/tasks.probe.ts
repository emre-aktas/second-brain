/**
 * The scheduled-task machinery, without a model.
 *
 * Covers the parts that would silently misbehave: the check-in seeding itself once,
 * catch-up collapsing a backlog into a single run instead of one per hour missed,
 * the heartbeat pre-check refusing to spend a turn on an unchanged vault, and the
 * master switch actually stopping everything rather than only the app's own work.
 *
 * The agent is a stub, so nothing here costs usage.
 *
 *   node scripts/run-ts.mjs src/main/tasks.probe.ts --node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from './db/sqlite'
import { migrate } from './db/schema'
import { TaskRunStore, TaskStore } from './db/tasks'
import { NodeStore } from './db/nodes'
import { ChatStore } from './db/chat'
import { KvStore, SuggestionStore } from './db/meta'
import { buildHeartbeat } from './tasks/heartbeat'
import { nextRun } from '@shared/schedule'

let failures = 0

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
}

const work = mkdtempSync(join(tmpdir(), 'brain-tasks-'))
const db = new Db(join(work, 'index.db'))
migrate(db)
const tasks = new TaskStore(db)

const HOUR = 60 * 60_000

console.log('scheduled tasks\n')

/* ------------------------------------------------------------------ storage */

console.log('storage')

const slack = tasks.save({
  name: 'Slack digest',
  prompt: 'Scan Slack and compile what is new.',
  schedule: { kind: 'hourly', minute: 0 },
  createdBy: 'agent'
})

check('a task is stored', tasks.get(slack.id)?.name === 'Slack digest')
check('its schedule round-trips', tasks.get(slack.id)?.schedule.kind === 'hourly', tasks.get(slack.id)?.schedule)
check('it is enabled by default', tasks.get(slack.id)?.enabled === true)
check('and starts with no next run', tasks.get(slack.id)?.nextRunAt === null)

// A garbage schedule must still produce a usable task rather than throwing on
// every list — the agent writes these.
db.run('UPDATE scheduled_tasks SET schedule = ? WHERE id = ?', ['not json', slack.id])
check('an unparseable schedule falls back rather than throwing', tasks.get(slack.id)?.schedule.kind === 'hourly')
tasks.save({ id: slack.id, name: 'Slack digest', schedule: { kind: 'hourly', minute: 0 } })

/* -------------------------------------------------------------- the due query */

console.log('\nwhat is due')

const now = Date.now()
tasks.setNextRun(slack.id, now - HOUR)
check('an overdue task is due', tasks.due(now).some((t) => t.id === slack.id))

tasks.setNextRun(slack.id, now + HOUR)
check('a future task is not', tasks.due(now).length === 0)

tasks.setNextRun(slack.id, now - HOUR)
tasks.setEnabled(slack.id, false, null)
check('a paused task is never due', tasks.due(now).length === 0)
check('and pausing clears its next run', tasks.get(slack.id)?.nextRunAt === null)
tasks.setEnabled(slack.id, true, now - HOUR)

/* --------------------------------------------------------------- catch-up */

console.log('\ncatching up after the app was closed')

// Closed for a day, with an hourly task. The next time is computed from *now*, not
// from the stale overdue time — otherwise a day offline means twenty-four turns the
// moment the app opens, which on a subscription is a real bill for nothing.
const dayAgo = now - 24 * HOUR
tasks.setNextRun(slack.id, dayAgo)
check('the task is due exactly once, not once per hour missed', tasks.due(now).length === 1)

tasks.recordRun(slack.id, 'ok', 'did the thing', nextRun({ kind: 'hourly', minute: 0 }, Date.now()))
const after = tasks.get(slack.id)!
check('after running, the next time is in the future', (after.nextRunAt ?? 0) > Date.now(), after.nextRunAt)
check('and it is within the hour', (after.nextRunAt ?? 0) - Date.now() <= HOUR)
check('nothing is due any more', tasks.due(Date.now()).length === 0)

/* ------------------------------------------------------------- run counting */

console.log('\nrun bookkeeping')

const before = tasks.get(slack.id)!.runCount
tasks.recordRun(slack.id, 'skipped', 'Nothing changed since the last check-in.', Date.now() + HOUR)
check('a skipped run does not count as work done', tasks.get(slack.id)!.runCount === before, {
  before,
  now: tasks.get(slack.id)!.runCount
})
check('but it is still recorded as the last outcome', tasks.get(slack.id)!.lastStatus === 'skipped')

tasks.recordRun(slack.id, 'ok', 'done', Date.now() + HOUR)
check('a real run does count', tasks.get(slack.id)!.runCount === before + 1)

const long = 'x'.repeat(5000)
tasks.recordRun(slack.id, 'ok', long, Date.now() + HOUR)
check('a huge summary is truncated rather than stored whole', (tasks.get(slack.id)!.lastSummary ?? '').length <= 2000)

/* ------------------------------------------------------------- the heartbeat */

console.log('\nthe check-in row')

const beat = tasks.save({
  name: 'Hourly check-in',
  kind: 'heartbeat',
  prompt: '',
  schedule: { kind: 'hourly', minute: 0 },
  createdBy: 'system'
})
check('it is found by kind', tasks.heartbeat()?.id === beat.id)
check('it sorts first, so the Scheduled tab leads with it', tasks.list()[0]?.kind === 'heartbeat')

// Seeding is guarded on heartbeat() being absent, so a second launch must not add
// another. This asserts the guard's premise: there is exactly one to find.
const beats = tasks.list().filter((t) => t.kind === 'heartbeat')
check('there is exactly one', beats.length === 1, beats.length)

/* ----------------------------------------------------------------- sessions */

console.log('\nsessions')

tasks.setSession(slack.id, 'session-abc')
check('a task remembers its chat', tasks.get(slack.id)?.sessionId === 'session-abc')
check('and can be found by it', tasks.bySession('session-abc')?.id === slack.id)
check('an unknown session finds nothing', tasks.bySession('nope') === undefined)

// Editing must not drop the session: the task's chat is its history, and a save that
// cleared it would strand every digest already written there.
tasks.save({ id: slack.id, name: 'Slack digest v2', schedule: { kind: 'daily', hour: 9, minute: 0 } })
check('editing a task keeps its chat', tasks.get(slack.id)?.sessionId === 'session-abc')
check('and applies the new schedule', tasks.get(slack.id)?.schedule.kind === 'daily')

/* -------------------------------------------------------------- deleting */

console.log('\ndeleting')
const doomed = tasks.save({ name: 'Temp', prompt: 'x', schedule: { kind: 'hourly', minute: 0 } })
tasks.delete(doomed.id)
check('a deleted task is gone', tasks.get(doomed.id) === undefined)
check('and the others survive', tasks.get(slack.id) !== undefined)

/* ------------------------------------------------------ the heartbeat gate */

// The pre-check is the whole reason the hourly check-in can be on by default: it
// decides, for free, whether a model turn is worth spending. Getting this wrong in
// either direction is expensive — always-ask burns a subscription on an idle vault,
// never-ask makes the feature a lie.

console.log('\nthe check-in pre-check')

const nodes = new NodeStore(db)
const kv = new KvStore(db)
const suggestions = new SuggestionStore(db)

// buildHeartbeat only reaches for these four, so a stand-in is honest here and keeps
// the probe free of a whole BrainCore.
const fakeCore = { nodes, kv, suggestions } as unknown as Parameters<typeof buildHeartbeat>[0]

// An empty vault has nothing to say.
check('an empty vault is not worth asking about', buildHeartbeat(fakeCore).worthAsking === false)

nodes.upsert({ kind: 'note', title: 'Bir not', path: 'bir-not.md', body: 'gövde' })

// lastSeen was advanced by the call above, so this note counts as new.
const first = buildHeartbeat(fakeCore)
check('a new note is worth asking about', first.worthAsking === true, first.reason)
check('and the brief names it', first.prompt.includes('Bir not'))
check('and says what changed', first.reason.includes('changed'), first.reason)

// The key assertion. Called again with nothing new, it must not spend a turn — and
// this only holds because lastSeen is advanced even on a skip. Left un-advanced, the
// same unchanged note would look new at every check-in for the rest of the day.
const second = buildHeartbeat(fakeCore)
check('asked again with nothing new, it declines', second.worthAsking === false, second.reason)
check('and says why, for the Scheduled tab', second.reason.length > 0)

// A note past its expiry is worth raising even though nothing changed.
nodes.upsert({
  kind: 'log',
  title: 'Eski günlük',
  path: 'eski.md',
  body: 'x',
  expiresAt: Date.now() - 60_000
})
const third = buildHeartbeat(fakeCore)
check('an expired note is worth raising', third.worthAsking === true, third.reason)

// The one that matters most for spend. An expired note is a standing condition, not
// an event: without comparing against what was last found, this would fire every hour
// for ever over something the user has already seen and chosen to leave.
const quiet = buildHeartbeat(fakeCore)
check('the same finding is not raised twice', quiet.worthAsking === false, quiet.reason)
check('and it says so, rather than claiming nothing changed', quiet.reason.includes('new'), quiet.reason)

const sabit = nodes.upsert({
  kind: 'log',
  title: 'Sabit',
  path: 'sabit.md',
  body: 'x',
  expiresAt: Date.now() - 60_000
})
// Pinning is its own operation, not part of upsert — a pinned note is deliberately
// permanent, so its passed expiry must never be raised.
nodes.setPinned(sabit.id, true)
// The write itself counts as a change, so the claim is checked on the settled pass.
buildHeartbeat(fakeCore)
const pinnedPass = buildHeartbeat(fakeCore)
check('a pinned note past its expiry is left alone', pinnedPass.worthAsking === false, pinnedPass.reason)

// A waiting suggestion is a standing reason to speak up.
suggestions.add({
  kind: 'link',
  title: 'Bunlar bağlanmalı',
  rationale: 'iki not aynı konudan bahsediyor',
  payload: {}
})
const withSuggestion = buildHeartbeat(fakeCore)
check('a pending suggestion is worth raising', withSuggestion.worthAsking === true, withSuggestion.reason)
check('and it is counted in the reason', withSuggestion.reason.includes('suggestion'), withSuggestion.reason)

// The instruction that keeps a quiet hour quiet. Without it the model narrates every
// hour and the notifier has nothing to suppress.
check(
  'the brief tells it how to say nothing',
  withSuggestion.prompt.includes('Nothing to report.')
)

/* ------------------------------------------------------- runs get their own chat */

// The point of the whole change: one chat per task meant that chat held one Claude
// session id, and every run resumed it, so run N replayed runs 1..N-1. These assert the
// property that makes a fresh chat fix it — a new session has no id to resume.

console.log('\nper-run chats')

const chat = new ChatStore(db)
const runs = new TaskRunStore(db)

const runA = chat.createSession('Slack digest — Aug 5, 09:00')
const runB = chat.createSession('Slack digest — Aug 5, 10:00')
check('two runs are two different chats', runA.id !== runB.id)
check('a fresh chat has nothing to resume', runA.claudeSessionId === null && runB.claudeSessionId === null)

// What the old design did: one chat carrying a Claude session id forward.
chat.setClaudeSessionId(runA.id, 'claude-session-1')
check('a chat that has run once does carry one', chat.getSession(runA.id)?.claudeSessionId === 'claude-session-1')
check('and the next run, being a new chat, still does not', chat.getSession(runB.id)?.claudeSessionId === null)

const rA = runs.start(slack.id, runA.id)
const rB = runs.start(slack.id, runB.id)
check('a run starts as running', runs.get(rA.id)?.status === 'running')
check('and is not counted as finished', runs.get(rA.id)?.finishedAt === null)

runs.finish(rA.id, 'ok', 'found three things')
check('finishing records the outcome', runs.get(rA.id)?.status === 'ok')
check('and the summary', runs.get(rA.id)?.summary === 'found three things')
check('and stamps a finish time', (runs.get(rA.id)?.finishedAt ?? 0) > 0)

const history = runs.forTask(slack.id)
check('history is newest first', history[0]?.id === rB.id, history.map((r) => r.id))
check('and holds both runs', history.length === 2)
check('a run is findable by its chat', runs.bySession(runA.id)?.id === rA.id)

// A crash leaves 'running' rows that nothing else would ever close.
const closed = runs.closeStale()
check('a stale run is closed at startup', closed === 1, closed)
check('and reads as an error rather than as still working', runs.get(rB.id)?.status === 'error')

/* --------------------------------------------------------------- retiring chats */

console.log('\nretiring old run chats')

// Nothing is offered up under the keep count.
check('nothing is trimmable while under the limit', runs.trimmable(slack.id, 40, () => false).length === 0)

// Above it, the oldest go — but never one the user replied in, and never one a window
// has open. Both of those were the reviewer's catch: a run someone answered is a
// conversation, and deleting the open one misroutes the next message they type.
const trimmable = runs.trimmable(slack.id, 1, () => false)
check('above the limit, the oldest is offered up', trimmable.length === 1 && trimmable[0] === runA.id, trimmable)
check('a protected chat is spared', runs.trimmable(slack.id, 1, (id) => id === runA.id).length === 0)

// The outcome outlives the chat.
runs.clearSession(runA.id)
check('clearing the chat keeps the run', runs.get(rA.id)?.status === 'ok')
check('and forgets only the chat', runs.get(rA.id)?.sessionId === null)
check('so history never develops holes', runs.forTask(slack.id).length === 2)

// A user reply is what makes a chat worth keeping.
chat.addMessage({ sessionId: runB.id, role: 'user', blocks: [{ type: 'text', text: 'hi' }], ts: Date.now() })
check('one user message is the injected prompt alone', chat.userMessageCount(runB.id) === 1)
chat.addMessage({ sessionId: runB.id, role: 'user', blocks: [{ type: 'text', text: 'and again' }], ts: Date.now() })
check('two means a person joined in', chat.userMessageCount(runB.id) === 2)

runs.deleteForTask(slack.id)
check('deleting a task takes its history', runs.forTask(slack.id).length === 0)

db.close()
rmSync(work, { recursive: true, force: true })

console.log(failures === 0 ? '\nall task checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

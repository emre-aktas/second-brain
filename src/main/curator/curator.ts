import { createHash } from 'node:crypto'
import type { BrainCore } from '../core'
import type { AgentManager } from '../agent/manager'
import { SimilarityIndex, findNearDuplicateTitles } from './similarity'
import { createLogger } from '../logger'

const log = createLogger('curator')

export interface CuratorPassReport {
  ranAt: number
  durationMs: number
  notesConsidered: number
  linksAdded: number
  suggestionsCreated: number
  /** Notes whose stated expiry has passed, moved to the trash. */
  expiredRemoved: number
  agentAsked: boolean
  skippedReason?: string
}

const CHECK_INTERVAL_MS = 30_000
const MAX_AUTO_LINKS_PER_PASS = 12
const MAX_SUGGESTIONS_PER_PASS = 8

/**
 * The part of the brain that works while nobody is watching.
 *
 * Runs when the user has been idle for a while, so it never competes with them
 * for the machine, and it only ever does two categories of thing: add weak
 * "similar" edges, which are cheap to ignore and trivially reversible, or leave a
 * suggestion card. Anything structural — merging, splitting, deleting — is
 * proposed, never performed.
 */
export class Curator {
  private timer: NodeJS.Timeout | null = null
  private lastUserActivity = Date.now()
  private lastPassAt = 0
  private running = false
  private lastReport: CuratorPassReport | null = null
  private agentAskedAt = 0

  constructor(
    private core: BrainCore,
    private agent: AgentManager
  ) {}

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS)
    this.timer.unref?.()
    log.info('curator armed')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Called whenever the user interacts, to push the idle window forward. */
  noteUserActivity(): void {
    this.lastUserActivity = Date.now()
  }

  get report(): CuratorPassReport | null {
    return this.lastReport
  }

  get idleMs(): number {
    return Date.now() - this.lastUserActivity
  }

  private async tick(): Promise<void> {
    const settings = this.core.settings.curator
    if (!settings.enabled || this.running) return

    if (this.idleMs < settings.idleMs) return
    if (Date.now() - this.lastPassAt < settings.intervalMs) return

    await this.runPass()
  }

  /** Run a pass now, regardless of idle state. */
  async runPass(force = false): Promise<CuratorPassReport> {
    if (this.running) {
      return (
        this.lastReport ?? {
          ranAt: Date.now(),
          durationMs: 0,
          notesConsidered: 0,
          linksAdded: 0,
          suggestionsCreated: 0,
          expiredRemoved: 0,
          agentAsked: false,
          skippedReason: 'a pass is already running'
        }
      )
    }

    this.running = true
    const started = Date.now()
    const settings = this.core.settings.curator

    const report: CuratorPassReport = {
      ranAt: started,
      durationMs: 0,
      notesConsidered: 0,
      linksAdded: 0,
      suggestionsCreated: 0,
      expiredRemoved: 0,
      agentAsked: false
    }

    try {
      // First, before anything reads the vault: a note that said it would stop
      // being useful and has is not worth linking, suggesting about, or drawing.
      report.expiredRemoved = this.retireExpired()

      const notes = this.core.nodes
        .listAll()
        .filter((node) => node.path !== null && node.body.trim().length > 0)

      report.notesConsidered = notes.length

      if (notes.length < 3) {
        report.skippedReason = 'not enough notes yet'
        return this.finish(report, started)
      }

      const index = new SimilarityIndex(
        notes.map((n) => ({ id: n.id, title: n.title, body: n.body }))
      )

      let suggestionBudget = MAX_SUGGESTIONS_PER_PASS

      /* --- related-but-unlinked notes ------------------------------------ */

      const pairs = index.findPairs(settings.similarityThreshold)
      let autoLinkBudget = MAX_AUTO_LINKS_PER_PASS

      for (const pair of pairs) {
        if (this.core.edges.exists(pair.a, pair.b)) continue

        const a = this.core.nodes.getById(pair.a)
        const b = this.core.nodes.getById(pair.b)
        if (!a || !b) continue

        const fingerprint = fingerprintOf('link', pair.a, pair.b)
        if (this.core.suggestions.hasSimilarPending('link', fingerprint)) continue

        // A strong overlap is safe to wire up directly as a weak edge; a weaker
        // one is a guess and belongs in front of the user.
        const confident = pair.score >= settings.similarityThreshold * 1.8

        if (settings.autoLinkSimilar && confident && autoLinkBudget > 0) {
          this.core.edges.add(pair.a, pair.b, 'similar', {
            origin: 'curator',
            weight: Math.min(1, pair.score * 2),
            label: pair.sharedTerms.slice(0, 3).join(', ')
          })
          autoLinkBudget--
          report.linksAdded++
          continue
        }

        if (suggestionBudget <= 0) continue
        this.core.suggestions.add({
          kind: 'link',
          title: `Connect "${a.title}" and "${b.title}"`,
          rationale: `They share distinctive vocabulary — ${pair.sharedTerms.join(', ')} — but nothing links them.`,
          payload: { from: pair.a, to: pair.b, score: Number(pair.score.toFixed(3)), fingerprint },
          autoApplicable: true
        })
        suggestionBudget--
        report.suggestionsCreated++
      }

      /* --- near-duplicate titles ----------------------------------------- */

      for (const duplicate of findNearDuplicateTitles(notes)) {
        if (suggestionBudget <= 0) break

        const fingerprint = fingerprintOf('merge', duplicate.a, duplicate.b)
        if (this.core.suggestions.hasSimilarPending('merge', fingerprint)) continue

        const a = this.core.nodes.getById(duplicate.a)
        const b = this.core.nodes.getById(duplicate.b)
        if (!a || !b) continue

        this.core.suggestions.add({
          kind: 'merge',
          title: `"${a.title}" and "${b.title}" look like the same note`,
          rationale: 'Their titles differ only by punctuation or a trailing number.',
          payload: { from: duplicate.a, to: duplicate.b, fingerprint },
          autoApplicable: false
        })
        suggestionBudget--
        report.suggestionsCreated++
      }

      /* --- orphans ------------------------------------------------------- */

      for (const orphan of this.core.graph.orphans(5)) {
        if (suggestionBudget <= 0) break

        const fingerprint = fingerprintOf('orphan', orphan.id, '')
        if (this.core.suggestions.hasSimilarPending('orphan', fingerprint)) continue

        const neighbours = index.neighbours(orphan.id, 3).filter((n) => n.score > 0.08)
        if (neighbours.length === 0) continue

        const names = neighbours
          .map((n) => this.core.nodes.getById(n.b)?.title)
          .filter(Boolean)
          .join(', ')

        this.core.suggestions.add({
          kind: 'orphan',
          title: `"${orphan.title}" is not connected to anything`,
          rationale: `The closest notes by content are ${names}. Linking it would make it findable.`,
          payload: {
            from: orphan.id,
            candidates: neighbours.map((n) => n.b),
            fingerprint
          },
          autoApplicable: false
        })
        suggestionBudget--
        report.suggestionsCreated++
      }

      /* --- ask the agent about what changed ------------------------------ */

      if (settings.useAgent && this.agent.available) {
        report.agentAsked = await this.maybeAskAgent()
      }

      if (report.linksAdded > 0) {
        this.core.markGraphDirty('curator')
      }
      if (report.linksAdded > 0 || report.suggestionsCreated > 0) {
        this.core.recordActivity({
          kind: 'curator.pass',
          actor: 'curator',
          title:
            report.linksAdded > 0 && report.suggestionsCreated > 0
              ? `Added ${report.linksAdded} connection(s) and left ${report.suggestionsCreated} suggestion(s)`
              : report.linksAdded > 0
                ? `Added ${report.linksAdded} connection(s)`
                : `Left ${report.suggestionsCreated} suggestion(s)`,
          detail: { ...report }
        })
        this.core.broadcast('suggestions:changed')
      }

      return this.finish(report, started)
    } catch (err) {
      log.error('curator pass failed', err)
      report.skippedReason = err instanceof Error ? err.message : String(err)
      return this.finish(report, started)
    } finally {
      this.running = false
      if (!force) this.lastPassAt = Date.now()
    }
  }

  /**
   * Retire notes whose stated expiry has passed.
   *
   * To the trash, never deleted: the file moves to `.trash/` and can be dragged
   * back. That is the difference between the app tidying up after itself and the
   * app losing the user's work — and the reason this is allowed to act on its own
   * while everything else structural is only ever suggested. The note said when it
   * would stop being useful, so honouring that is not a judgement call.
   *
   * Pinned notes are never touched: pinning is the user saying they want it, and
   * that outranks whatever the note was created with.
   *
   * Public because it stands alone — it needs no similarity index, no agent, and no
   * idle window, so it can be run and verified on its own.
   */
  retireExpired(): number {
    const now = Date.now()
    const expired = this.core.nodes
      .listAll()
      .filter((node) => node.expiresAt !== null && node.expiresAt <= now && !node.pinned)

    let removed = 0
    for (const node of expired) {
      try {
        this.core.trashNote(node.id, 'curator')
        removed++
        log.info(`retired "${node.title}" — expired ${new Date(node.expiresAt!).toISOString()}`)
      } catch (err) {
        log.warn(`could not retire "${node.title}"`, err)
      }
    }

    return removed
  }

  private finish(report: CuratorPassReport, started: number): CuratorPassReport {
    report.durationMs = Date.now() - started
    this.lastReport = report
    this.core.broadcast('curator:pass', report)
    log.info('pass complete', report)
    return report
  }

  /**
   * Hand the agent the notes that changed since last time and let it tag,
   * summarise and link them. Runs in its own archived session so it never
   * appears in the user's conversation list, and at most once an hour so an
   * always-on background agent cannot quietly run up cost.
   */
  private async maybeAskAgent(): Promise<boolean> {
    if (Date.now() - this.agentAskedAt < 60 * 60_000) return false

    // An unattended pass must never be what exhausts the day's allowance, so it
    // stands down well before the cap rather than at it.
    const remaining = this.agent.remainingToday()
    if (remaining !== null && remaining < this.core.settings.budget.perTurnLimitUsd * 2) {
      log.info('skipping the agent pass: too little of today\'s budget left')
      return false
    }

    const lastSeen = this.core.kv.get<number>('curator/lastAgentPassAt') ?? 0
    const changed = this.core.nodes
      .listRecent(40)
      .filter((n) => n.path !== null && n.updatedAt > lastSeen)
      .slice(0, 8)

    const needsWork = changed.filter((n) => !n.summary || n.tags.length === 0 || n.degree === 0)
    if (needsWork.length === 0) return false

    const sessionId = this.curatorSessionId()
    const list = needsWork.map((n) => `- [${n.id}] "${n.title}" (${n.degree} links, ${n.tags.length} tags)`).join('\n')

    try {
      await this.agent.send(
        [
          'A background pass is running. These notes changed recently and look under-connected:',
          '',
          list,
          '',
          'For each one: read it, then improve it where there is a clear improvement to make —',
          'give it a one-line summary if it has none, add tags that match the vocabulary already',
          'used elsewhere in the vault, and link it to related notes. Where you are not confident,',
          'use suggest instead of changing anything.',
          '',
          'Do not call render_ui or focus_graph — nobody is watching this run. Keep it short and',
          'stop when you are done.'
        ].join('\n'),
        { sessionId, capability: 'curate' }
      )

      this.agentAskedAt = Date.now()
      this.core.kv.set('curator/lastAgentPassAt', Date.now())
      return true
    } catch (err) {
      log.warn('could not hand the pass to the agent', err)
      return false
    }
  }

  private curatorSessionId(): string {
    const stored = this.core.kv.get<string>('curator/sessionId')
    if (stored && this.core.chat.getSession(stored)) return stored

    const session = this.core.chat.createSession('Background curation')
    // Archived so it stays out of the conversation list.
    this.core.chat.archiveSession(session.id, true)
    this.core.kv.set('curator/sessionId', session.id)
    return session.id
  }

  /* ----------------------------------------------------- applying results */

  /** Apply a suggestion the user accepted. */
  applySuggestion(id: string): { ok: boolean; message: string } {
    const suggestion = this.core.suggestions.get(id)
    if (!suggestion) return { ok: false, message: 'that suggestion no longer exists' }
    if (suggestion.status !== 'pending') return { ok: false, message: 'it was already resolved' }

    try {
      switch (suggestion.kind) {
        case 'link': {
          const from = String(suggestion.payload['from'] ?? '')
          const to = String(suggestion.payload['to'] ?? '')
          this.core.linkNotes(from, to, 'similar', 'accepted suggestion', 'curator')
          break
        }
        case 'orphan': {
          const from = String(suggestion.payload['from'] ?? '')
          const candidates = Array.isArray(suggestion.payload['candidates'])
            ? (suggestion.payload['candidates'] as string[])
            : []
          if (candidates.length === 0) throw new Error('no candidates were recorded')
          this.core.linkNotes(from, candidates[0], 'similar', 'accepted suggestion', 'curator')
          break
        }
        case 'merge':
        case 'split':
        case 'integration':
          // These need judgement the user has to make in the relevant screen;
          // accepting here only records the decision.
          return {
            ok: false,
            message: 'open this one to act on it — it is not something to apply blindly'
          }
        default: {
          this.core.suggestions.setStatus(id, 'accepted')
          return { ok: true, message: 'marked as accepted' }
        }
      }

      this.core.suggestions.setStatus(id, 'applied')
      this.core.broadcast('suggestions:changed')
      return { ok: true, message: 'applied' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  dismissSuggestion(id: string): void {
    this.core.suggestions.setStatus(id, 'dismissed')
    this.core.broadcast('suggestions:changed')
  }
}

function fingerprintOf(kind: string, a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a]
  return createHash('sha1').update(`${kind}:${x}:${y}`).digest('hex').slice(0, 20)
}

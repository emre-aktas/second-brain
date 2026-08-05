import type { BrainCore } from '../core'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

/** The key holding the moment the last check-in looked at the vault. */
const LAST_SEEN_KEY = 'heartbeat/lastSeenAt'

/**
 * The key holding what the last check-in found.
 *
 * Needed because most of what the pre-check looks at is a *standing* condition, not an
 * event. A note past its expiry is still past its expiry an hour later, so counting it
 * as a reason to speak would make the check-in fire every hour, for ever, over
 * something the user has already seen and chosen to leave — which is precisely the
 * runaway the pre-check exists to prevent. Comparing against the previous finding is
 * what turns "this is true" into "this is new".
 */
const LAST_SIGNATURE_KEY = 'heartbeat/lastSignature'

export interface HeartbeatBrief {
  /** False when the pre-check found nothing, so no turn is spent. */
  worthAsking: boolean
  /** Why not, for the Scheduled tab. Shown as the last result of a skipped run. */
  reason: string
  /** What to ask the agent, when there is something to ask about. */
  prompt: string
}

/**
 * Decide whether the hourly check-in has anything to check in about.
 *
 * This function is the reason the check-in can be on by default. Asking a model
 * "anything worth surfacing?" every hour is twenty-four turns a day out of the user's
 * own subscription, most of them against a vault that has not changed since the last
 * one — and this app's standing rule is that background work does not spend casually.
 *
 * So the question is answered here first, deterministically and for free: has anything
 * actually happened? Only when the answer is yes does a turn get spent, and the brief
 * it produces already contains what changed, so the model does not have to go looking.
 */
export function buildHeartbeat(core: BrainCore): HeartbeatBrief {
  const now = Date.now()
  const lastSeen = core.kv.get<number>(LAST_SEEN_KEY) ?? 0

  // Advanced whether or not a turn is spent. Left un-advanced on a skip, the same
  // unchanged notes would be "new" at every check-in for the rest of the day.
  core.kv.set(LAST_SEEN_KEY, now)

  const recent = core.nodes.listRecent(60)

  const changed = recent.filter((node) => node.path !== null && node.updatedAt > lastSeen)

  // Notes that said when they stop being useful, and are nearly there. This is the
  // single most second-brain-ish thing the app knows and nothing else surfaces it.
  const expiringSoon = recent.filter(
    (node) =>
      node.expiresAt !== null &&
      node.expiresAt > now &&
      node.expiresAt - now < 2 * DAY &&
      !node.pinned
  )

  const overdue = recent.filter(
    (node) => node.expiresAt !== null && node.expiresAt <= now && !node.pinned
  )

  // Still unconnected and unsummarised: the notes most likely to be lost. Taken from
  // the whole recent set rather than from `changed`, because being stranded is a state
  // and not an event — a note left dangling three days ago is still dangling, and
  // filtering by "changed since last hour" would make it flicker in and out of view.
  // Only notes old enough that the user has plainly moved on: flagging something
  // written four minutes ago is nagging, not help.
  const stranded = recent.filter(
    (node) =>
      node.path !== null && node.degree === 0 && !node.summary && now - node.updatedAt > HOUR
  )

  const pendingSuggestions = core.suggestions.pendingCount()

  const signals: string[] = []
  if (changed.length > 0) signals.push(`${changed.length} note(s) changed`)
  if (overdue.length > 0) signals.push(`${overdue.length} past its expiry`)
  if (expiringSoon.length > 0) signals.push(`${expiringSoon.length} expiring soon`)
  if (stranded.length > 0) signals.push(`${stranded.length} unconnected`)
  if (pendingSuggestions > 0) signals.push(`${pendingSuggestions} suggestion(s) waiting`)

  if (signals.length === 0) {
    core.kv.set(LAST_SIGNATURE_KEY, '')
    return {
      worthAsking: false,
      reason: 'Nothing changed since the last check-in.',
      prompt: ''
    }
  }

  /**
   * The standing conditions, as a comparable string.
   *
   * Identities rather than counts, so one expired note being replaced by a different
   * one still reads as new. `changed` is deliberately *not* in here: it is already
   * filtered by "since we last looked", so it is an event — something that happened —
   * and it can speak for itself. Everything in this signature is a state that stays
   * true until something is done about it.
   */
  const standing = JSON.stringify({
    overdue: overdue.map((n) => n.id).sort(),
    expiring: expiringSoon.map((n) => n.id).sort(),
    stranded: stranded.map((n) => n.id).sort(),
    suggestions: pendingSuggestions
  })

  const previous = core.kv.get<string>(LAST_SIGNATURE_KEY) ?? ''
  core.kv.set(LAST_SIGNATURE_KEY, standing)

  // Ask when something actually happened, or when the standing picture has moved.
  // Without the second half, a note past its expiry would be raised every hour for
  // ever; without the first, an edit would be missed whenever nothing else had moved.
  if (changed.length === 0 && standing === previous) {
    return {
      worthAsking: false,
      reason: 'Nothing new since the last check-in.',
      prompt: ''
    }
  }

  const list = (label: string, nodes: typeof recent): string[] =>
    nodes.length === 0
      ? []
      : [
          '',
          `${label}:`,
          ...nodes
            .slice(0, 8)
            .map(
              (node) =>
                `- [${node.id}] "${node.title}"${node.degree === 0 ? ' (no links)' : ''}${
                  node.summary ? '' : ' (no summary)'
                }`
            )
        ]

  const prompt = [
    'This is your hourly check-in. Nobody asked for it, so the bar for saying anything',
    'is high: the user should be glad you spoke, not merely informed.',
    '',
    `Since you last looked: ${signals.join(', ')}.`,
    ...list('Changed', changed.slice(0, 8)),
    ...list('Past its expiry', overdue),
    ...list('Expiring within two days', expiringSoon),
    ...list('Written but unconnected', stranded),
    '',
    'Decide for yourself whether any of it is worth raising. If it is, say the useful',
    'thing in a couple of sentences — a connection nobody has drawn, a note that is',
    'about to disappear and probably should not, a pattern across what changed. Use a',
    'generated interface if it reads better than prose.',
    '',
    'If you have a real question for the user, ask it with ask_user — this is your own',
    'chat, so asking here interrupts nothing.',
    '',
    'If none of it is worth their attention, reply with exactly "Nothing to report."',
    'and stop. That is a good outcome, not a failure, and it is the right answer most',
    'of the time.'
  ].join('\n')

  return { worthAsking: true, reason: signals.join(', '), prompt }
}

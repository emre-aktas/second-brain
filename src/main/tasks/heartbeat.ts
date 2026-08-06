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

/** The key holding when the connector sweep last actually ran. */
const LAST_SWEPT_KEY = 'heartbeat/lastSweptAt'

export interface HeartbeatBrief {
  /** False when the pre-check found nothing, so no turn is spent. */
  worthAsking: boolean
  /** Why not, for the Scheduled tab. Shown as the last result of a skipped run. */
  reason: string
  /** What to ask the agent, when there is something to ask about. */
  prompt: string
  /**
   * Connectors this brief asked the agent to look at, if any.
   *
   * Empty when the sweep was not due or nothing is connected — in which case the prompt
   * never mentions an external source at all, so a missing connector cannot turn into a
   * turn spent explaining that it is missing.
   */
  swept: string[]
  /**
   * Applied by the scheduler once the turn has settled.
   *
   * The watermarks must not advance before the turn, and this is not a style preference:
   * a check-in that writes a note makes that note "changed" for the *next* check-in, which
   * would then have something to report, which would write another note. Advancing after
   * the turn — past the moment the run started — closes the loop.
   */
  commit: () => void
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
/**
 * A list of names as English.
 *
 * `join(' and ')` was fine while there were two sources and produced "Slack and Grain and
 * ClickUp" the moment there were three. The prompt is prose the model reads; a sentence that
 * reads as though it were assembled by a loop invites being skimmed like one.
 */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function buildHeartbeat(
  core: BrainCore,
  sweepSources: string[] = [],
  /**
   * Build a prompt even when the pre-check finds nothing.
   *
   * Set when the user pressed "run now". The gates below exist to stop the *schedule*
   * spending a turn on an unchanged vault; they are not an answer to somebody who has
   * deliberately asked. Without this the brief came back with an empty prompt and the
   * scheduler reported the run as failed — which is what pressing the button on a quiet
   * vault did.
   */
  force = false
): HeartbeatBrief {
  const now = Date.now()
  const lastSeen = core.kv.get<number>(LAST_SEEN_KEY) ?? 0

  const recent = core.nodes.listRecent(60)

  const changed = recent.filter((node) => node.path !== null && node.updatedAt > lastSeen)

  // Notes that said when they stop being useful, and are nearly there. This is the
  // single most second-brain-ish thing the app knows and nothing else surfaces it.
  const expiringSoon = recent.filter(
    (node) =>
      node.expiresAt !== null &&
      node.expiresAt > now &&
      node.expiresAt - now < 2 * DAY &&
      !node.pinned &&
      // Not notes that were born temporary. A daily digest given a week to live is
      // *meant* to expire, so raising it five days later is the check-in nagging about
      // its own housekeeping — and it would do so for every digest, for ever.
      !(node.expiresAt - node.createdAt <= 8 * DAY)
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

  /**
   * Advance the watermarks. Called by the scheduler once the turn has settled.
   *
   * Declared here rather than earlier because it closes over `standing`, and reading that
   * before its initialiser is a temporal-dead-zone crash that no typecheck would catch.
   */
  const commit = (): void => {
    // To `now`, the moment the pre-check looked — not to the time the turn finished.
    // Anything the user edited *during* the turn stays newer than the watermark and is
    // reported next time, rather than being silently stepped over.
    core.kv.set(LAST_SEEN_KEY, now)
    core.kv.set(LAST_SIGNATURE_KEY, standing)
    if (sweepSources.length > 0) core.kv.set(LAST_SWEPT_KEY, now)
  }

  if (!force && signals.length === 0 && sweepSources.length === 0) {
    return {
      worthAsking: false,
      reason: 'Nothing changed since the last check-in.',
      prompt: '',
      swept: [],
      commit
    }
  }

  const previous = core.kv.get<string>(LAST_SIGNATURE_KEY) ?? ''

  // Ask when something actually happened, when the standing picture has moved, or when a
  // connector sweep is due. Without the second, a note past its expiry would be raised
  // every hour for ever; without the first, an edit would be missed whenever nothing else
  // had moved; without the third, a quiet vault would mean Slack is never looked at.
  if (!force && changed.length === 0 && standing === previous && sweepSources.length === 0) {
    return {
      worthAsking: false,
      reason: 'Nothing new since the last check-in.',
      prompt: '',
      swept: [],
      commit
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

  const sweep =
    sweepSources.length === 0
      ? []
      : [
          '',
          `Also look at ${listOf(sweepSources)}. These are connected right now, so`,
          'the tools are there. Read what has arrived since you last checked and decide',
          'whether any of it is something the user needs from you — a decision waiting on',
          'them, a thread that has gone quiet on their side, something worth writing down',
          'as a note so it is not lost in a channel.',
          '',
          'Do not summarise for the sake of summarising. Nobody asked for a digest of',
          'their own messages, and reading a channel is not itself news.'
        ]

  const prompt = [
    'This is your check-in. Nobody asked for it, so the bar for saying anything is high:',
    'the user should be glad you spoke, not merely informed.',
    '',
    signals.length > 0
      ? `Since you last looked: ${signals.join(', ')}.`
      : 'Nothing has changed in the vault since you last looked.',
    ...list('Changed', changed.slice(0, 8)),
    ...list('Past its expiry', overdue),
    ...list('Expiring within two days', expiringSoon),
    ...list('Written but unconnected', stranded),
    ...sweep,
    '',
    'Decide for yourself whether any of it is worth raising. If it is, present it with a',
    'generated interface — render_ui — rather than as prose: a short report reads far',
    'better than a paragraph, and this is a report. Mention notes as [[Wikilinks]] so the',
    'user can open them from what you write.',
    '',
    'If you have a real question for the user, ask it with ask_user — this is your own',
    'chat, so asking here interrupts nothing. But report first and ask second, in that',
    'order: nobody asked you to speak, so a turn that is only a question asks them to',
    'approve something they cannot see. They do not know what you read or what you',
    'concluded, and "shall I do it?" with nothing above it cannot be answered.',
    '',
    'If none of it is worth their attention, reply with exactly these three words and',
    'nothing else: Nothing to report. No trailing explanation, no "Nothing to report —',
    'Slack was quiet": the app matches that phrase exactly to stay silent, and anything',
    'appended to it becomes a desktop notification. Replying it is a good outcome, not a',
    'failure, and it is the right answer most of the time.'
  ].join('\n')

  const parts = [
    ...signals,
    ...(sweepSources.length > 0 ? [`swept ${sweepSources.join(', ')}`] : [])
  ]
  // A forced run can legitimately reach here with nothing to say for itself. Falling
  // through to the old `swept ${...}` branch produced the summary "swept " — a stray
  // fragment shown in the panel as the reason the run happened.
  const reason =
    parts.length > 0 ? parts.join(', ') : 'Nothing had changed; checked because you asked.'

  return { worthAsking: true, reason, prompt, swept: sweepSources, commit }
}

/**
 * Which external sources are due a look.
 *
 * Separate from the vault check and much less often, because they are the half that costs
 * something: a changed note is free to notice, whereas asking the model to read Slack is a
 * turn every time. The vault gate can stay hourly precisely because most hours it answers
 * "nothing"; a connector sweep answers "maybe" every time, so its frequency *is* its cost.
 *
 * Returns display names, and only for connectors the account actually has — naming a
 * source the user has not connected buys a turn spent explaining that it is missing.
 */
export function dueSweepSources(
  core: BrainCore,
  connected: (needle: string) => boolean,
  everyHours: number
): string[] {
  const settings = core.settings.proactive
  if (!settings.sweep.enabled) return []

  const last = core.kv.get<number>(LAST_SWEPT_KEY) ?? 0
  if (Date.now() - last < Math.max(1, everyHours) * HOUR) return []

  const wanted: string[] = []
  if (settings.sweep.slack && connected('slack')) wanted.push('Slack')
  if (settings.sweep.grain && connected('grain')) wanted.push('Grain')
  if (settings.sweep.clickup && connected('clickup')) wanted.push('ClickUp')
  return wanted
}

/** Exported for the probe: the watermark the sweep is scheduled from. */
export const HEARTBEAT_SWEPT_KEY = LAST_SWEPT_KEY

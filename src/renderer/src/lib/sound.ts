import { play, setEnabled, setVolume, type SoundName } from 'cuelume'

/**
 * The three moments this app makes a sound, and nothing else.
 *
 * The rule that decided the list: a cue heard two hundred times a day is not feedback, it is
 * a noise the user learns to resent. So no hover, no click, no keystroke, no panel change —
 * every one of those is something the user *did*, and they already know they did it. What is
 * worth a sound is something that happened without them: an answer arriving, a question they
 * have to settle, a failure.
 *
 * They are also deliberately the same three events the desktop notifier cares about, because
 * "is this worth interrupting for" is a question that should have one answer in this app
 * rather than two that can disagree.
 *
 * The complement matters as much as the list. A sound plays only when the window has focus —
 * which is exactly when the notifier stays quiet, since a toast for something already on
 * screen is noise. Unfocused, the operating system plays its own sound with its own toast.
 * Between the two, every event is announced once and never twice.
 */
export type Cue = 'reply' | 'question' | 'error'

/**
 * Which of cuelume's seventeen recipes each cue uses.
 *
 * `arrival` for a reply: soft, low, over before it registers as a sound. `chime` for a
 * question, because that one is a request for the user's attention and has to survive being
 * half-ignored. `error` speaks for itself.
 */
const RECIPE: Record<Cue, SoundName> = {
  reply: 'arrival',
  question: 'chime',
  error: 'error'
}

let allowed = true

/**
 * Apply the user's preference.
 *
 * Volume lives with cuelume rather than being passed per call, so a change takes effect for
 * everything after it without every call site having to know the number.
 */
export function configureSound(settings: { enabled: boolean; volume: number } | undefined): void {
  // Tolerant of nothing at all. A settings object can arrive from somewhere other than the
  // store — a probe stub, a popped-out window — and reading `.enabled` off `undefined` here
  // took the whole renderer down, which is a silent audio preference costing an entire app.
  allowed = settings?.enabled ?? false
  setEnabled(allowed)
  setVolume(Math.min(1, Math.max(0, settings?.volume ?? 0.35)))
}

/**
 * Play a cue, if this is a moment for one.
 *
 * The focus check is here rather than at each call site so it cannot be forgotten at one of
 * them — and it is `document.hasFocus()` rather than visibility, because a window the user
 * can see but is not typing in is a window whose notification the operating system will
 * deliver. This is the only place in the app where focus is the right question and
 * visibility is not.
 */
export function cue(kind: Cue): void {
  if (!allowed) return
  if (!document.hasFocus()) return

  try {
    play(RECIPE[kind])
  } catch {
    // Web Audio can refuse for reasons that are none of this app's business — no output
    // device, a context the browser will not resume. A missing sound is not worth a
    // console full of errors, let alone a broken turn.
  }
}

import type { PendingQuestion } from '@shared/ipc'
import { ulid } from '../util/id'
import { createLogger } from '../logger'

const log = createLogger('agent:ask')

/**
 * Lets the agent ask the user something without ending its turn.
 *
 * The `ask_user` tool handler awaits one of these, so the CLI stays mid-turn
 * while a question card sits in the chat. That is the difference between "here is
 * my best guess" and "which of these did you mean" — the agent can use the answer
 * immediately instead of burning a whole round trip.
 *
 * A generous timeout resolves to a clear "no answer" so a turn can never hang
 * forever waiting on someone who walked away.
 */
const DEFAULT_TIMEOUT_MS = 4 * 60_000

interface Waiting {
  question: PendingQuestion
  resolve: (answer: string) => void
  timer: NodeJS.Timeout
}

export class QuestionBroker {
  private waiting = new Map<string, Waiting>()

  constructor(private broadcast: (channel: string, payload: unknown) => void) {}

  /**
   * Told whenever a question is raised.
   *
   * Questions do not travel as `AgentEvent`s — they have their own channel, because a
   * turn blocks on one — so anything in main that needs to react has to be told here.
   * The notifier is the caller: a question is the one thing worth interrupting for,
   * since the turn is stopped until it is answered and the chat that asked may not be
   * the one on screen.
   */
  onAsk: ((question: PendingQuestion) => void) | null = null

  ask(input: {
    sessionId: string
    question: string
    options?: string[]
    allowFreeText?: boolean
    timeoutMs?: number
  }): Promise<string> {
    const question: PendingQuestion = {
      id: ulid(),
      sessionId: input.sessionId,
      question: input.question,
      options: (input.options ?? []).slice(0, 6),
      allowFreeText: input.allowFreeText ?? true,
      askedAt: Date.now()
    }

    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(question.id)
        this.broadcast('chat:questionResolved', { id: question.id, answer: '' })
        log.info(`question ${question.id} timed out`)
        resolve('')
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      timer.unref?.()

      this.waiting.set(question.id, { question, resolve, timer })
      this.broadcast('chat:question', question)
      try {
        this.onAsk?.(question)
      } catch (err) {
        log.warn('a question listener threw', err)
      }
    })
  }

  answer(id: string, answer: string): boolean {
    const pending = this.waiting.get(id)
    if (!pending) return false

    this.waiting.delete(id)
    clearTimeout(pending.timer)
    this.broadcast('chat:questionResolved', { id, answer })
    pending.resolve(answer)
    return true
  }

  /** Release everything for a session, so an interrupted turn does not leak. */
  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.waiting) {
      if (pending.question.sessionId !== sessionId) continue
      this.waiting.delete(id)
      clearTimeout(pending.timer)
      this.broadcast('chat:questionResolved', { id, answer: '' })
      pending.resolve('')
    }
  }

  pending(): PendingQuestion[] {
    return [...this.waiting.values()].map((entry) => entry.question)
  }
}

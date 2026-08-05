/**
 * Tokens spent by one turn of the agent.
 *
 * A turn is not one request. Every tool call ends a request and begins another, so a turn
 * that reads three notes and writes one is five requests, each with its own usage — and the
 * user is watching a single answer. This class is the arithmetic that turns the one into
 * the other, kept out of `ClaudeProcess` so it can be tested against real recorded frames
 * without spawning anything.
 *
 * Two rules do all the work, and both are the kind that look right when written backwards:
 *
 *   1. `message_delta`'s `usage.output_tokens` is the running total for the request *in
 *      flight*, so it is **assigned**, never added. Added on each delta it is multiplied by
 *      the number of deltas — a counter that looks plausible and reads an order of
 *      magnitude high.
 *   2. The CLI emits several `assistant` frames for one message, one per content block, and
 *      every one of them carries the *same* final usage object. Summing frames therefore
 *      counts a request once per block. They are deduplicated by message id.
 *
 * Cache reads and writes count as input. They are tokens the request actually carried, and
 * leaving them out reports a two-thousand-token turn for one that moved a hundred thousand
 * — which is also how `usage/usage.ts` totals the footer's windows, so the two readouts
 * have to agree.
 */

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
}

/** A usage object as the CLI writes it, with everything optional. */
export type RawUsage = Record<string, unknown> | undefined | null

function num(usage: RawUsage, key: string): number {
  const value = usage?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Everything charged on the way in, cache included. */
export function inputOf(usage: RawUsage): number {
  return (
    num(usage, 'input_tokens') +
    num(usage, 'cache_read_input_tokens') +
    num(usage, 'cache_creation_input_tokens')
  )
}

export function outputOf(usage: RawUsage): number {
  return num(usage, 'output_tokens')
}

export class UsageMeter {
  /** What requests that have finished spent. */
  private bankedInput = 0
  private bankedOutput = 0
  /** What the request in flight has spent so far. */
  private liveInput = 0
  private liveOutput = 0
  private liveId: string | null = null
  /** Message ids already reconciled, so a repeated frame is not counted twice. */
  private settled = new Set<string>()

  /** A new turn. Not called, the counter carries the previous answer's total. */
  reset(): void {
    this.bankedInput = 0
    this.bankedOutput = 0
    this.liveInput = 0
    this.liveOutput = 0
    this.liveId = null
    this.settled.clear()
  }

  get total(): TurnUsage {
    return {
      inputTokens: this.bankedInput + this.liveInput,
      outputTokens: this.bankedOutput + this.liveOutput
    }
  }

  private bank(): void {
    this.bankedInput += this.liveInput
    this.bankedOutput += this.liveOutput
    this.liveInput = 0
    this.liveOutput = 0
    this.liveId = null
  }

  /**
   * `message_start`: a new request has opened.
   *
   * Its input side is final from the outset — the prompt is already known — so it is read
   * once here rather than waited for.
   */
  openRequest(id: string | null, usage: RawUsage): void {
    if (this.liveId !== null || this.liveInput !== 0 || this.liveOutput !== 0) this.bank()
    this.liveId = id
    this.liveInput = inputOf(usage)
    this.liveOutput = outputOf(usage)
  }

  /** `message_delta`: the running output total for the request in flight. */
  observeOutput(usage: RawUsage): boolean {
    const value = usage?.['output_tokens']
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (value === this.liveOutput) return false
    this.liveOutput = value
    return true
  }

  /**
   * An `assistant` frame: the authoritative final usage for a completed request.
   *
   * This is what makes the number on the finished message the CLI's own rather than a
   * reconstruction of it — any delta that was missed or arrived out of order is corrected
   * here. Returns whether anything changed, so the caller can avoid a pointless emit.
   */
  settleRequest(id: string | null, usage: RawUsage): boolean {
    if (id !== null && this.settled.has(id)) return false
    if (id !== null) this.settled.add(id)

    // A different id than the one in flight means no stream frames opened this request —
    // which is the whole story when partial messages are off. Bank the previous one rather
    // than overwriting it.
    if (id !== null && this.liveId !== null && id !== this.liveId) this.bank()

    const input = inputOf(usage)
    const output = outputOf(usage)
    // Guard against a frame that carries no usage at all: it must not zero what the deltas
    // already established.
    if (input === 0 && output === 0) return false

    if (id !== null) this.liveId = id
    this.liveInput = input
    this.liveOutput = output
    return true
  }
}

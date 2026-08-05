/**
 * Is the token count right?
 *
 * Two halves, because either alone would be worthless. The first drives the meter with
 * synthetic frames and asserts the exact number, including asserting what the *wrong*
 * answers would be — a test that only says "the total is 900" passes just as happily when
 * the arithmetic is accidentally right. The second reads the CLI's **own transcripts** on
 * this machine and checks the meter against real recorded usage objects, so a field the CLI
 * renames, or a shape it changes, fails here rather than silently zeroing a readout.
 *
 * No model is called and nothing is spawned.
 *
 * Only usage numbers and message ids are read out of the transcripts, and nothing is
 * printed but counts and totals — none of the user's own content is touched.
 *
 *   node scripts/run-ts.mjs src/main/agent/usage-meter.test.ts --node
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inputOf, outputOf, UsageMeter } from './usage-meter'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  console.log(`        expected ${JSON.stringify(expected)}`)
  console.log(`        actual   ${JSON.stringify(actual)}`)
}

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok    ${label}`)
    return
  }
  failures++
  console.log(`  FAIL  ${label}`)
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`)
}

console.log('turn usage\n')

/* ------------------------------------------------------- reading one usage */

console.log('what counts as input')

const USAGE = {
  input_tokens: 4,
  cache_read_input_tokens: 51_000,
  cache_creation_input_tokens: 2_400,
  output_tokens: 812
}

check('input is the sum of fresh, cache-read and cache-write', inputOf(USAGE), 53_404)
check('output is output', outputOf(USAGE), 812)
// The most likely accident: counting only `input_tokens`, which on a cached turn is single
// digits. That reads as a four-token request for one that carried fifty thousand.
ok('and input is not just input_tokens', inputOf(USAGE) !== USAGE.input_tokens)
check('a missing usage object is zero, not NaN', [inputOf(undefined), outputOf(null)], [0, 0])
check('a non-numeric field is ignored', inputOf({ input_tokens: 'lots' }), 0)

/* --------------------------------------------------- one request, streaming */

console.log('\none request')

const single = new UsageMeter()
single.openRequest('m1', { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 })
check('the input side is known at the start', single.total, { inputTokens: 100, outputTokens: 1 })

single.observeOutput({ output_tokens: 40 })
single.observeOutput({ output_tokens: 120 })
single.observeOutput({ output_tokens: 300 })
// The rule the whole thing turns on: each delta is the running total, so the answer is the
// last one, not the sum of them.
check('output follows the running total', single.total, { inputTokens: 100, outputTokens: 300 })
ok('and is not the sum of the deltas', single.total.outputTokens !== 1 + 40 + 120 + 300)

check('a delta that repeats the same number changes nothing', single.observeOutput({ output_tokens: 300 }), false)
check('a delta with no output_tokens is ignored', single.observeOutput({}), false)

/* ------------------------------------------- several requests, as tool calls */

console.log('\na turn with tool calls')

const turn = new UsageMeter()
turn.openRequest('a', { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 1 })
turn.observeOutput({ output_tokens: 200 })
turn.openRequest('b', { input_tokens: 5, cache_read_input_tokens: 1500, output_tokens: 1 })
turn.observeOutput({ output_tokens: 50 })
turn.openRequest('c', { input_tokens: 5, cache_read_input_tokens: 2000, output_tokens: 1 })
turn.observeOutput({ output_tokens: 900 })

check('finished requests are banked and the live one added', turn.total, {
  inputTokens: 1005 + 1505 + 2005,
  outputTokens: 200 + 50 + 900
})

/* ------------------------------------------------------------ reconciliation */

console.log('\nthe authoritative frame')

const settled = new UsageMeter()
settled.openRequest('m1', { input_tokens: 2, cache_read_input_tokens: 500, output_tokens: 1 })
settled.observeOutput({ output_tokens: 300 })
// The CLI's final word on that request. It corrects a delta that was missed.
check(
  'settling overwrites what the deltas guessed',
  settled.settleRequest('m1', { input_tokens: 2, cache_read_input_tokens: 500, output_tokens: 358 }),
  true
)
check('so the total is the CLI\'s own', settled.total, { inputTokens: 502, outputTokens: 358 })

// The reason dedup exists: real transcripts carry one of these frames per content block,
// each repeating the same total. Counted per frame, a request is counted several times.
check(
  'a repeated frame for the same message is ignored',
  settled.settleRequest('m1', { input_tokens: 2, cache_read_input_tokens: 500, output_tokens: 358 }),
  false
)
check('and the total does not move', settled.total, { inputTokens: 502, outputTokens: 358 })

// A frame carrying no usage must not wipe what is already known.
settled.settleRequest('m2', {})
check('an empty usage object does not zero the turn', settled.total, {
  inputTokens: 502,
  outputTokens: 358
})

// With partial messages off there are no stream frames at all, so `settle` is the only
// signal — and it has to accumulate across requests rather than overwrite.
const settleOnly = new UsageMeter()
settleOnly.settleRequest('x', { cache_read_input_tokens: 1000, output_tokens: 100 })
settleOnly.settleRequest('y', { cache_read_input_tokens: 1200, output_tokens: 250 })
settleOnly.settleRequest('z', { cache_read_input_tokens: 1400, output_tokens: 75 })
check('settle-only still accumulates', settleOnly.total, {
  inputTokens: 3600,
  outputTokens: 425
})

/* ------------------------------------------------------------------- reset */

console.log('\na second turn')

const reused = new UsageMeter()
reused.openRequest('t1', { cache_read_input_tokens: 900, output_tokens: 400 })
reused.reset()
check('reset clears everything', reused.total, { inputTokens: 0, outputTokens: 0 })
reused.openRequest('t1', { cache_read_input_tokens: 900, output_tokens: 5 })
// The same id as before, and it must not be treated as already settled.
check('and forgets which requests were settled', reused.settleRequest('t1', { output_tokens: 77 }), true)

/* ------------------------------------------------------ against real frames */

console.log('\nagainst the CLI\'s own transcripts')

interface RealMessage {
  id: string
  usage: Record<string, unknown>
}

/** Real assistant usages from this machine's transcripts, newest project first. */
function realMessages(limit: number): RealMessage[] {
  const root = join(homedir(), '.claude', 'projects')
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return []
  }

  const files: { path: string; size: number }[] = []
  for (const project of projects) {
    let entries: string[]
    try {
      entries = readdirSync(join(root, project))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const path = join(root, project, entry)
      try {
        files.push({ path, size: statSync(path).size })
      } catch {
        continue
      }
    }
  }

  // Biggest first: the most requests per file read.
  files.sort((a, b) => b.size - a.size)

  const out: RealMessage[] = []
  for (const file of files.slice(0, 3)) {
    let text: string
    try {
      text = readFileSync(file.path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (out.length >= limit) return out
      // Cheap pre-filter so a forty-megabyte transcript is not fully parsed.
      if (!line.includes('"usage"')) continue
      let row: Record<string, unknown>
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (row['type'] !== 'assistant') continue
      const message = row['message'] as Record<string, unknown> | undefined
      const usage = message?.['usage'] as Record<string, unknown> | undefined
      const id = message?.['id']
      if (!usage || typeof id !== 'string') continue
      out.push({ id, usage })
    }
  }
  return out
}

const real = realMessages(4000)

if (real.length === 0) {
  // CI has no transcripts, and neither does a machine where the CLI has never run. Skipping
  // is honest; failing would make the suite depend on the developer's own history.
  console.log('  skip  no CLI transcripts on this machine')
} else {
  console.log(`  read ${real.length} real assistant frames`)

  // The canary. If the CLI renames a field, every readout built on it silently reports zero,
  // and nothing else in the app would notice.
  const fields = new Set<string>()
  for (const message of real) for (const key of Object.keys(message.usage)) fields.add(key)
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens']) {
    ok(`real frames still carry ${field}`, fields.has(field), [...fields].sort())
  }
  ok(
    'and at least one real frame is cache-heavy, which is why cache counts',
    real.some((m) => inputOf(m.usage) > 10 * (m.usage['input_tokens'] as number ?? 0) + 1000)
  )

  // Deduplicate the way the meter does, then total it independently. Two different routes
  // to the same number: this one is a plain sum over distinct message ids, the meter's is
  // the banking logic. They can only agree if the banking is right.
  const distinct = new Map<string, Record<string, unknown>>()
  for (const message of real) if (!distinct.has(message.id)) distinct.set(message.id, message.usage)

  let expectedInput = 0
  let expectedOutput = 0
  for (const usage of distinct.values()) {
    expectedInput += inputOf(usage)
    expectedOutput += outputOf(usage)
  }

  ok(`the frames cover ${distinct.size} distinct requests`, distinct.size > 1, distinct.size)
  ok(
    'and the repeats are real, so dedup is load-bearing',
    real.length > distinct.size,
    { frames: real.length, requests: distinct.size }
  )

  // Fed exactly as the CLI feeds it: every frame, repeats included, in file order.
  const meter = new UsageMeter()
  for (const message of real) meter.settleRequest(message.id, message.usage)

  check('the meter totals real frames exactly', meter.total, {
    inputTokens: expectedInput,
    outputTokens: expectedOutput
  })
  console.log(
    `        ${(expectedInput / 1000).toFixed(0)}k in, ${(expectedOutput / 1000).toFixed(0)}k out across ${distinct.size} requests`
  )

  // And through the streaming path, for the same real numbers: a message_start with the
  // request's real input side, deltas climbing to its real output, then the real frame.
  const streamed = new UsageMeter()
  for (const [id, usage] of distinct) {
    const finalOutput = outputOf(usage)
    streamed.openRequest(id, { ...usage, output_tokens: 1 })
    for (const fraction of [0.25, 0.6, 0.9]) {
      streamed.observeOutput({ output_tokens: Math.floor(finalOutput * fraction) })
    }
    streamed.settleRequest(id, usage)
  }
  check('and totals them the same way through the stream', streamed.total, {
    inputTokens: expectedInput,
    outputTokens: expectedOutput
  })

  // The failure this whole design exists to prevent, stated as a number: adding each delta
  // instead of assigning it.
  const wrong = [...distinct.values()].reduce(
    (sum, usage) => sum + 1 + Math.floor(outputOf(usage) * 1.75) + outputOf(usage),
    0
  )
  ok(
    'the additive mistake would have read much higher',
    wrong > expectedOutput * 2,
    { correct: expectedOutput, additive: wrong }
  )
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

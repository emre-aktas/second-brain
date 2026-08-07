/**
 * The Codex engine: the arguments it builds and the frames it translates.
 *
 * Every assertion here is a bug that was real, found by running the actual CLI once and reading
 * what came back rather than what the documentation implied:
 *
 * - **stdin must be closed.** `codex exec` reads its prompt from stdin when stdin is a pipe, and
 *   a spawn's default stdio *is* a pipe. Left open it printed "Reading additional input from
 *   stdin..." and waited for a prompt it had already been given as an argument. From the app that
 *   is a turn that never starts, which is the hang that was reported.
 * - **`-m` must be omitted when no model is configured.** The app used to fall back to
 *   `settings.model` — a Claude name — so Codex was launched with `-m opus`, and DeepSeek was
 *   sent the same string over HTTP.
 * - **An expired session must be translated.** Codex reports "your refresh token was already
 *   used", and `codex login status` still answers "Logged in using ChatGPT" in that state, so the
 *   failing turn is the only signal there is.
 *
 * Driven by a stub standing in for the CLI, replaying frames captured from a real run, so this
 * costs no usage and needs no account. The engine owns its own argument list — which is the thing
 * under test — so the stub cannot be passed in as a path. It is named `exec` and written into the
 * working directory instead: `exec` is the engine's own first argument, and node resolves its
 * entry script relative to cwd, so the CLI's own argv is what selects the stand-in.
 *
 *   node scripts/run-ts.mjs src/main/agent/codex.probe.ts --node
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexEngine } from './engines/codex'
import { capabilitiesFor, resolveCodexBinary } from './engines/factory'
import { codexModels, codexConfigDefaults } from './engines/codexCatalogue'
import type { ClaudeStreamEvent } from './claude'
import type { EngineOptions } from './engine'

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

const work = mkdtempSync(join(tmpdir(), 'brain-codex-'))
const argsFile = join(work, 'args.json')
const stdinFile = join(work, 'stdin.txt')

const FAIL_MESSAGE =
  'Your access token could not be refreshed because your refresh token was already used. ' +
  'Please log out and sign in again.'

/**
 * A stand-in for `codex`.
 *
 * It records the argv it was given and whether its stdin reached `end`, then replays a captured
 * frame sequence. Extensionless and named for the subcommand, so `node exec --json ...` runs it.
 */
const stub = join(work, 'exec')
writeFileSync(
  stub,
  [
    "const fs = require('fs')",
    `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))`,
    // The whole point of the stdin assertion: does the stream ever end on its own?
    'let ended = false',
    "process.stdin.on('end', () => { ended = true })",
    'process.stdin.resume()',
    `const failing = process.env.FRAMES === 'fail'`,
    'const frames = failing',
    '  ? [',
    "      { type: 'thread.started', thread_id: 'th-1' },",
    "      { type: 'turn.started' },",
    `      { type: 'error', message: ${JSON.stringify(FAIL_MESSAGE)} },`,
    `      { type: 'turn.failed', error: { message: ${JSON.stringify(FAIL_MESSAGE)} } }`,
    '    ]',
    '  : [',
    "      { type: 'thread.started', thread_id: 'th-1' },",
    "      { type: 'turn.started' },",
    "      { type: 'item.completed', item: { id: 'i1', item_type: 'agent_message', text: 'PONG' } },",
    "      { type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 4, output_tokens: 2 } }",
    '    ]',
    "for (const frame of frames) process.stdout.write(JSON.stringify(frame) + '\\n')",
    // A moment for `end` to fire, then reported. Written before exit so the assertion can read it
    // whichever way the process leaves.
    'setTimeout(() => {',
    `  fs.writeFileSync(${JSON.stringify(stdinFile)}, ended ? 'ended' : 'open')`,
    '  process.exit(failing ? 1 : 0)',
    '}, 150)'
  ].join('\n')
)

// Written for its name, not its path — the engine never learns where it is.
void stub

function optionsFor(): EngineOptions {
  return {
    cwd: work,
    model: '',
    capability: 'build',
    appendSystemPrompt: '',
    mcpConfig: {},
    resumeSessionId: null,
    maxBudgetUsd: null,
    effort: null,
    unattended: false
  }
}

/** One turn against the stub, resolved when the engine reports its result. */
function run(
  model: string,
  frames: 'ok' | 'fail'
): Promise<{ events: ClaudeStreamEvent[]; argv: string[]; stdin: string }> {
  return new Promise((resolve) => {
    const events: ClaudeStreamEvent[] = []
    process.env['FRAMES'] = frames

    const engine = new CodexEngine(
      process.execPath,
      optionsFor(),
      capabilitiesFor({ providerId: 'codex-cli', model }),
      (event) => {
        events.push(event)
        if (event.type !== 'result') return
        // The stub writes its stdin verdict on the way out, which can land just after `close`.
        setTimeout(() => {
          resolve({
            events,
            argv: existsSync(argsFile) ? (JSON.parse(readFileSync(argsFile, 'utf8')) as string[]) : [],
            stdin: existsSync(stdinFile) ? readFileSync(stdinFile, 'utf8') : 'missing'
          })
        }, 60)
      }
    )

    engine.start()
    engine.send('Say PONG')
  })
}

async function main(): Promise<void> {
  console.log('codex engine')

  const ok = await run('', 'ok')

  check('stdin is closed, so the prompt argument is the whole prompt', ok.stdin === 'ended', ok.stdin)
  check('no -m when no model is configured', !ok.argv.includes('-m'), ok.argv)
  check('the sandbox is passed', ok.argv.includes('-s'), ok.argv)
  check('the working directory is passed', ok.argv.includes('-C'), ok.argv)
  check('json output is asked for', ok.argv.includes('--json'), ok.argv)

  // `start()` announces an empty init before anything is spawned, so the thread id is on the
  // one that follows it.
  const init = [...ok.events].reverse().find((e) => e.type === 'init')
  check(
    'thread.started becomes init with the thread id',
    init?.type === 'init' && init.claudeSessionId === 'th-1',
    init
  )

  const okResult = ok.events.find((e) => e.type === 'result')
  check(
    'a completed turn is not an error and carries the text',
    okResult?.type === 'result' && !okResult.isError && okResult.text === 'PONG',
    okResult
  )

  const usage = ok.events.find((e) => e.type === 'usage')
  check(
    'cached input counts as input',
    usage?.type === 'usage' && usage.inputTokens === 15 && usage.outputTokens === 2,
    usage
  )

  const withModel = await run('gpt-5.1-codex', 'ok')
  const at = withModel.argv.indexOf('-m')
  check(
    'a configured model is passed as -m',
    at >= 0 && withModel.argv[at + 1] === 'gpt-5.1-codex',
    withModel.argv
  )

  const bad = await run('', 'fail')
  const failResult = bad.events.find((e) => e.type === 'result')
  check('a failed turn is an error', failResult?.type === 'result' && failResult.isError, failResult)
  check(
    'an expired session is explained, not quoted',
    failResult?.type === 'result' && /codex login/.test(failResult.text ?? ''),
    failResult?.type === 'result' ? failResult.text : failResult
  )

  /*
   * The catalogue, against the real CLI.
   *
   * Local and unauthenticated — `codex debug models` reads a file the installer shipped — so this
   * costs nothing and still works when the CLI's ChatGPT session has expired, which is exactly
   * when a picker built on a network call would show an empty list. Skipped rather than failed
   * when Codex is absent: not having it installed is a normal state, not a broken one.
   */
  const binary = resolveCodexBinary()
  if (!binary) {
    console.log('  skip  codex is not installed; the catalogue is not checked')
  } else {
    const catalogue = await codexModels(binary, true)
    check('the catalogue reads', catalogue.models.length > 0, catalogue.error)

    const withLevels = catalogue.models.filter((m) => (m.reasoningLevels ?? []).length > 0)
    check(
      'models carry their own reasoning levels',
      withLevels.length > 0,
      catalogue.models.map((m) => `${m.id}:${(m.reasoningLevels ?? []).length}`)
    )
    // The whole reason the levels are per model rather than per provider: they differ, and a
    // single list would offer one model a level another rejects.
    const shapes = new Set(
      catalogue.models.map((m) => (m.reasoningLevels ?? []).map((l) => l.effort).join(','))
    )
    check('the level sets are not all identical', shapes.size > 1, [...shapes])

    check(
      'every model has an id and a label',
      catalogue.models.every((m) => Boolean(m.id) && Boolean(m.label)),
      catalogue.models.map((m) => m.id)
    )

    const defaults = codexConfigDefaults()
    // Only that it parses without throwing and never returns a table-scoped value; a machine
    // with no config at all is a normal state and answers null twice.
    check(
      'the config default is a scalar or nothing',
      (defaults.model === null || typeof defaults.model === 'string') &&
        (defaults.effort === null || typeof defaults.effort === 'string'),
      defaults
    )
    console.log(`        catalogue: ${catalogue.models.map((m) => m.id).join(', ')}`)
    console.log(`        config default: ${defaults.model ?? '(none)'} / ${defaults.effort ?? '(none)'}`)
  }

  rmSync(work, { recursive: true, force: true })
  console.log(failures === 0 ? '\nall ok' : `\n${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()

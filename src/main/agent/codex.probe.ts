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
 * - **`resume` is a subcommand and takes its own flags.** It accepts neither `-s/--sandbox` nor
 *   `-C/--cd`, which belong to `exec`. Sending them anyway made every turn after the first die
 *   instantly with `error: unexpected argument '-s' found` and a usage dump — so a Codex
 *   conversation was one message long and the reply to the second was the CLI's help text. The
 *   first turn worked, which is why it read as the app being flaky rather than as a wrong flag.
 *
 * That last one is checked against the CLI's *own* parser rather than against a list written here:
 * the help output is local and instant, so every flag the engine builds is looked up in the help
 * for the subcommand it will actually be parsed by. A list in this file would have to be kept in
 * step with a binary that updates itself, which is the same class of mistake one layer up.
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
import { execFileSync } from 'node:child_process'
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
    "let stdinText = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (chunk) => { stdinText += chunk })",
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
    // Both facts in one file: whether the stream ended, and what came down it. The prompt lives
    // on stdin now, so "was it closed" and "what was the prompt" are the same question.
    `  fs.writeFileSync(${JSON.stringify(stdinFile)}, (ended ? 'ended' : 'open') + '<|>' + stdinText)`,
    '  process.exit(failing ? 1 : 0)',
    '}, 150)'
  ].join('\n')
)

// Written for its name, not its path — the engine never learns where it is.
void stub

/** A Windows path with the escapes that were being mangled, so the round trip is a real one. */
const BRIDGE = 'C:\\Users\\Socian\\AppData\\Roaming\\brain\\bridge\\brain-mcp.mjs'

const INSTRUCTIONS = 'You are Second Brain. The vault holds 96 notes.'

function optionsFor(resume: string | null): EngineOptions {
  return {
    cwd: work,
    model: '',
    capability: 'build',
    sessionId: 'chat-1',
    appendSystemPrompt: INSTRUCTIONS,
    mcpConfig: {
      mcpServers: {
        brain: {
          command: 'C:\\Program Files\\brain\\electron.exe',
          args: [BRIDGE],
          env: { ELECTRON_RUN_AS_NODE: '1', BRAIN_TOKEN: 'abc' }
        }
      }
    },
    resumeSessionId: resume,
    maxBudgetUsd: null,
    effort: null,
    unattended: false
  }
}

/** One turn against the stub, resolved when the engine reports its result. */
function run(
  model: string,
  frames: 'ok' | 'fail',
  resume: string | null = null
): Promise<{ events: ClaudeStreamEvent[]; argv: string[]; stdin: string; prompt: string }> {
  return new Promise((resolve) => {
    const events: ClaudeStreamEvent[] = []
    process.env['FRAMES'] = frames

    const engine = new CodexEngine(
      process.execPath,
      optionsFor(resume),
      capabilitiesFor({ providerId: 'codex-cli', model }),
      (event) => {
        events.push(event)
        if (event.type !== 'result') return
        // The stub writes its stdin verdict on the way out, which can land just after `close`.
        setTimeout(() => {
          const raw = existsSync(stdinFile) ? readFileSync(stdinFile, 'utf8') : 'missing<|>'
          // A marker with no newline in it separates the verdict from the prompt, because the
          // prompt is many lines and contains everything else a separator could have been.
          const [state, ...rest] = raw.split('<|>')
          resolve({
            events,
            argv: existsSync(argsFile) ? (JSON.parse(readFileSync(argsFile, 'utf8')) as string[]) : [],
            stdin: state ?? 'missing',
            prompt: rest.join('<|>')
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

  check('stdin is closed, so the CLI knows the prompt is complete', ok.stdin === 'ended', ok.stdin)
  check('no -m when no model is configured', !ok.argv.includes('-m'), ok.argv)

  /* ------------------------------------------------------------ the instructions */

  /*
   * Codex was never given the app's system prompt at all.
   *
   * The manager built it — who the agent is, what the vault holds, which tools exist, what this
   * tier forbids — and this engine dropped it. So Codex answered "who am I?" like a stock
   * assistant while Claude answered it out of ninety-six notes, and that read as a difference
   * between the models rather than as a whole argument going missing.
   */
  check('the app’s instructions reach Codex', ok.prompt.includes(INSTRUCTIONS), ok.prompt.slice(0, 200))
  check('and the turn follows them', ok.prompt.includes('Say PONG'), ok.prompt.slice(-120))
  /*
   * On stdin, not in argv, and that is a hard requirement rather than a preference: the real
   * system prompt is about 30,000 characters and Windows caps an entire command line at 32,767 —
   * with the MCP config, the model and the user's own message on the same line. As an argument
   * it would pass every test here and fail on a real vault.
   */
  check('the prompt is passed as `-`, so no length limit applies', ok.argv.at(-1) === '-', ok.argv)
  check(
    'and no argument carries the instructions',
    !ok.argv.some((arg) => arg.includes(INSTRUCTIONS)),
    ok.argv
  )
  check('json output is asked for', ok.argv.includes('--json'), ok.argv)
  /*
   * The flag without which no tool call ever completes.
   *
   * `codex exec` cancels every MCP tool call — the server starts, the tools list, the model asks
   * for one, and it comes back "user cancelled MCP tool call" without reaching the bridge. It is
   * a known upstream limitation with no config key; `approval_policy` in all five values and
   * project `trust_level` were each tried against the real CLI and each still cancelled. The
   * cost is the sandbox, which goes with the prompt, and `capabilities.sandboxed` says so.
   */
  check(
    'approvals are bypassed, or no tool call ever completes',
    ok.argv.includes('--dangerously-bypass-approvals-and-sandbox'),
    ok.argv
  )
  // And the parameter that stopped meaning anything under it is not sent, rather than sent and
  // ignored — a bound that does not bind is worse than an absent one.
  check('and no sandbox_mode is sent, since it would be ignored', !ok.argv.some((arg) => arg.startsWith('sandbox_mode=')), ok.argv)

  /* ------------------------------------------------------------ the second turn */

  const resumed = await run('', 'ok', 'th-1')
  const resumeAt = resumed.argv.indexOf('resume')
  check('a thread is resumed by id', resumeAt >= 0 && resumed.argv[resumeAt + 1] === 'th-1', resumed.argv)
  // The two flags that made every follow-up turn fail. `codex exec resume --help` lists neither.
  check('resume is not sent -s', !resumed.argv.includes('-s'), resumed.argv)
  check('resume is not sent -C', !resumed.argv.includes('-C'), resumed.argv)
  check(
    'and it still bypasses approvals',
    resumed.argv.includes('--dangerously-bypass-approvals-and-sandbox'),
    resumed.argv
  )

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
    /*
     * Every flag the engine builds, looked up in the help for the subcommand that will parse it.
     *
     * This is the check that would have caught the resume bug, and the reason it is done this way
     * rather than against a list in this file is that the list would be a second copy of something
     * the binary already knows and updates on its own schedule. `--help` is local and instant, so
     * there is no reason to keep a copy.
     */
    const helpFor = (args: string[]): string =>
      execFileSync(binary, [...args, '--help'], { encoding: 'utf8', windowsHide: true })

    const flagsIn = (help: string): Set<string> =>
      new Set(help.match(/(?<![\w-])--?[A-Za-z][\w-]*/g) ?? [])

    const execFlags = flagsIn(helpFor(['exec']))
    const resumeFlags = flagsIn(helpFor(['exec', 'resume']))

    // `-c` takes a `key=value` whose value is TOML, so its argument is not a flag however it
    // looks; everything else beginning with a dash has to be one the parser knows.
    const flagsOf = (argv: string[]): string[] => {
      const out: string[] = []
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '-c') {
          i++
          continue
        }
        if (/^--?[A-Za-z]/.test(argv[i] ?? '')) out.push(argv[i] as string)
      }
      return out
    }

    const unknownFirst = flagsOf(ok.argv).filter((flag) => !execFlags.has(flag))
    check('every flag on a first turn is one `codex exec` accepts', unknownFirst.length === 0, unknownFirst)

    const unknownResume = flagsOf(resumed.argv).filter((flag) => !resumeFlags.has(flag))
    check(
      'every flag on a resumed turn is one `codex exec resume` accepts',
      unknownResume.length === 0,
      unknownResume
    )
    // Proves the check has teeth: the flags that were being sent really are absent from `resume`.
    check(
      'and `resume` genuinely rejects the two that were being sent',
      !resumeFlags.has('-s') && !resumeFlags.has('-C'),
      [...resumeFlags].filter((f) => f.length <= 3)
    )

    /* ------------------------------------------ the MCP path, through the real parser */

    /*
     * The bridge path, round-tripped through Codex's own config parser.
     *
     * `-c` values are parsed as TOML and the escapes are processed *twice*, so a Windows path in
     * the basic string `JSON.stringify` produces came back as `C:<TAB>mp<BS>rain-mcp.mjs`. Every
     * path this app injected arrived mangled, the brain MCP server could not start, and Codex
     * therefore ran with no access to the vault — which looked like the model choosing not to
     * use tools rather than like the tools not being there.
     *
     * Asserted against the CLI rather than against a theory of TOML escaping, because the theory
     * is what was wrong. `codex mcp get` needs no account and no network.
     */
    const mcpArg = ok.argv.find((arg) => arg.startsWith('mcp_servers.')) ?? ''
    check('an MCP server is injected at all', mcpArg.length > 0, ok.argv)

    const readBack = execFileSync(binary, ['mcp', 'get', 'brain', '-c', mcpArg], {
      encoding: 'utf8',
      windowsHide: true
    })
    const argsLine = readBack.split(/\r?\n/).find((line) => line.trim().startsWith('args:')) ?? ''
    const commandLine = readBack.split(/\r?\n/).find((line) => line.trim().startsWith('command:')) ?? ''

    check('the bridge path survives Codex’s own parser', argsLine.includes(BRIDGE), argsLine)
    check(
      'and so does the binary path',
      commandLine.includes('C:\\Program Files\\brain\\electron.exe'),
      commandLine
    )
    // The exact corruption that was happening, named so a regression is recognisable.
    check(
      'no tab or backspace was decoded out of a path',
      !/[\t\u0008]/.test(argsLine + commandLine),
      JSON.stringify(argsLine + commandLine)
    )

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

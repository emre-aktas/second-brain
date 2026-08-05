/**
 * Runs the whole verification suite.
 *
 * There is no test runner here on purpose — each script below is self-contained,
 * prints `ok`/`FAIL` lines and exits non-zero. This just walks them in order so that
 * "is the tree good?" is one command rather than a list to remember, which is what
 * CI needs and what someone who has just cloned the repo needs.
 *
 *   node scripts/verify.mjs              everything that needs no Claude subscription
 *   node scripts/verify.mjs --node-only  skip the ones that open a window
 *   node scripts/verify.mjs --all        include the probes that drive the real CLI
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const nodeOnly = args.includes('--node-only')
const includeCli = args.includes('--all')

/**
 * `node` runs under plain Node. `gui` needs a real BrowserWindow, so it needs a
 * desktop session — present on GitHub's Windows and macOS runners, absent on Linux
 * without a display server.
 *
 * `cli` drives the user's actual `claude` binary. Those are excluded by default
 * because CI has no Claude subscription to sign in with, not because they are slow.
 * None of them makes a model call — `agent.probe.ts` does, which is why it is not on
 * this list at all: it costs real usage every time it runs.
 */
const SUITE = [
  { file: 'src/main/util/slug.test.ts', mode: 'node' },
  { file: 'src/shared/hotkey.test.ts', mode: 'node' },
  { file: 'src/main/vault/markdown.test.ts', mode: 'node' },
  { file: 'src/main/vault/unicode.test.ts', mode: 'node' },
  { file: 'src/main/db/storage.test.ts', mode: 'node' },
  { file: 'src/main/canvas.probe.ts', mode: 'node' },
  { file: 'src/main/expiry.probe.ts', mode: 'node' },
  { file: 'src/main/agent/lifecycle.probe.ts', mode: 'node' },
  { file: 'src/main/agent/bridge.probe.ts', mode: 'node' },

  { file: 'src/main/graphIcons.probe.ts', mode: 'gui' },
  { file: 'src/main/canvasRender.probe.ts', mode: 'gui' },
  { file: 'src/main/chatStream.probe.ts', mode: 'gui' },
  { file: 'src/main/codeTool.probe.ts', mode: 'gui' },
  { file: 'src/main/toolWindow.probe.ts', mode: 'gui' },
  { file: 'src/main/windowSize.probe.ts', mode: 'gui' },
  { file: 'src/main/toolPreview.probe.ts', mode: 'gui' },

  { file: 'src/main/agent/spawn.probe.ts', mode: 'cli' },
  { file: 'src/main/agent/flags.probe.ts', mode: 'cli' }
]

const selected = SUITE.filter((entry) => {
  if (entry.mode === 'cli') return includeCli
  if (entry.mode === 'gui') return !nodeOnly
  return true
})

// The GUI probes write PNGs. Somewhere disposable, so a verification run never
// leaves anything behind in the repo.
const shots = mkdtempSync(join(tmpdir(), 'brain-verify-'))

const failed = []
const started = process.hrtime.bigint()

for (const entry of selected) {
  const label = entry.file.replace(/^src\//, '')
  process.stdout.write(`${label.padEnd(44)} `)

  const result = spawnSync(
    process.execPath,
    ['scripts/run-ts.mjs', entry.file, entry.mode === 'gui' ? '--gui' : '--node'],
    { cwd: root, env: { ...process.env, CANVAS_PROBE_OUT: shots }, encoding: 'utf8' }
  )

  if (result.status === 0) {
    console.log('ok')
  } else {
    console.log('FAIL')
    failed.push({ label, output: `${result.stdout ?? ''}${result.stderr ?? ''}` })
  }
}

rmSync(shots, { recursive: true, force: true })

const seconds = Number(process.hrtime.bigint() - started) / 1e9

if (failed.length > 0) {
  // The output only for what broke: a wall of text from a passing run is what makes
  // people stop reading CI logs.
  for (const failure of failed) {
    console.log(`\n${'-'.repeat(70)}\n${failure.label}\n${'-'.repeat(70)}`)
    console.log(failure.output.trimEnd())
  }
}

console.log(
  `\n${selected.length - failed.length}/${selected.length} passed in ${seconds.toFixed(1)}s` +
    (includeCli ? '' : ' (add --all for the probes that need the claude CLI)')
)

process.exit(failed.length === 0 ? 0 : 1)

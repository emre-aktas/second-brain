/**
 * Dev helper: bundle a main-process TypeScript entry with esbuild and run it in
 * the Electron runtime (or plain node) so modules can be exercised in isolation
 * without booting the whole app.
 *
 *   node scripts/run-ts.mjs <entry.ts> [--node]
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const entry = args.find((a) => !a.startsWith('--'))
const useNode = args.includes('--node')

if (!entry) {
  console.error('usage: node scripts/run-ts.mjs <entry.ts> [--node]')
  process.exit(2)
}

// Inside node_modules on purpose. External packages (node-sqlite3-wasm,
// gray-matter) are required at runtime, and Electron running as a real app
// ignores NODE_PATH — so the bundle has to sit somewhere the ordinary upward
// node_modules walk reaches the repo's own dependencies.
const outDir = mkdtempSync(join(root, 'node_modules', '.brain-runts-'))
const outFile = join(outDir, 'bundle.cjs')

await build({
  entryPoints: [resolve(root, entry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: outFile,
  sourcemap: 'inline',
  // Keep native/wasm packages and electron external, exactly like the real build.
  external: ['electron', 'node-sqlite3-wasm', 'gray-matter'],
  alias: { '@shared': resolve(root, 'src/shared') },
  logLevel: 'warning',
  // Vite gives the real build `?raw` imports for free; esbuild does not, and the
  // main process uses one for the bundled design brief.
  plugins: [
    {
      name: 'raw-text',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
          namespace: 'raw-text'
        }))
        pluginBuild.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({
          contents: readFileSync(args.path, 'utf8'),
          loader: 'text'
        }))
      }
    }
  ]
})

// --gui runs Electron as a real app (windows, capturePage) rather than as Node.
const useGui = args.includes('--gui')

/**
 * Where Electron's binary actually is.
 *
 * The `electron` package's main export is the path to it as a string, which is the
 * only way to get this right on every platform: it is `dist/electron.exe` on
 * Windows, `dist/Electron.app/Contents/MacOS/Electron` on macOS and `dist/electron`
 * on Linux. Hardcoding the Windows name meant every verification script was
 * unrunnable anywhere else.
 */
function electronBinary() {
  const fromPackage = createRequire(import.meta.url)('electron')
  if (typeof fromPackage === 'string' && existsSync(fromPackage)) return fromPackage
  throw new Error('could not resolve the electron binary — is `electron` installed?')
}

const bin = useNode ? process.execPath : electronBinary()

const env = { ...process.env, NODE_PATH: resolve(root, 'node_modules') }
if (!useGui) env.ELECTRON_RUN_AS_NODE = '1'
else delete env.ELECTRON_RUN_AS_NODE

const child = spawn(bin, [outFile], { stdio: 'inherit', cwd: root, env })

child.on('exit', (code) => {
  rmSync(outDir, { recursive: true, force: true })
  process.exit(code ?? 0)
})

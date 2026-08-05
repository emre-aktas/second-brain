# Second Brain — notes for Claude Code

Electron desktop app. A physics graph of markdown notes is the main screen; an
embedded agent (this CLI, spawned as a subprocess) works alongside it.

Read `README.md` first — it covers the architecture and the reasoning behind the
non-obvious choices. `DESIGN.md` is the design brief: tokens, type scale, motion
rules, the states every surface needs. Read it before changing anything visual —
the embedded agent reads it too, via the `design_principles` tool. This file is
only the things that will bite you.

## Commands

```bash
npm run dev         # electron-vite dev
npm run build       # all three bundles
npm run typecheck   # both tsconfig projects; run this before claiming done
npm run verify      # the whole verification suite; --all adds the CLI-driving probes
npm run dist        # release/ artifacts for the current platform (dist:win, dist:mac)
npm run icons       # regenerate build/icon.{png,ico} and icon-mac.png
node scripts/run-ts.mjs <file.ts> [--node|--gui]   # one main-process module in isolation
powershell -ExecutionPolicy Bypass -File scripts/screenshot.ps1   # capture the running window (Windows)
```

## Constraints that are easy to violate

**Vite must stay on 7.x.** `electron-vite@5` peers `vite ^5 || ^6 || ^7`. Vite 8
breaks the install. `@vitejs/plugin-react` must stay on 5.x for the same reason.

**Main and preload are CJS.** No `"type": "module"`. Any dependency added to
`dependencies` is externalised and must therefore be CJS-compatible — this is why
`chokidar@5` and `@modelcontextprotocol/sdk` are *not* used (both ESM-only) and
why the vault watcher is `fs.watch` and the MCP bridge is hand-written.
`devDependencies` get bundled and can be ESM.

**`TOOL_API.md` is the contract for `kind: "code"` tools** and is bundled into main
via `?raw`, returned by the `tool_api` brain tool. If you change the `BRIDGE` string
or `BASE_CSS` in `src/main/toolProtocol.ts`, change that file in the same commit — the
agent builds against it and cannot discover a drift.

**A tool run must never go quiet.** Assistant text deltas are forwarded into the
frame as cumulative `onText`, steps as `onStep`, plus `brain.elapsedMs` and
`brain.cancel()`. The header also ticks a seconds counter, which is the only progress
a canvas or kanban tool shows. Silence for twenty seconds is indistinguishable from a
crash, and that was the complaint.

**Window and preview theming reads `appearance()`**, never
`nativeTheme.shouldUseDarkColors` — that is the OS preference, and using it opened
dark tool windows and took dark preview screenshots for a user in light mode.

**A tool frame paints nothing until `data-theme` is on its root.** `BASE_CSS`'s
`var()` fallbacks are all dark values, so in light appearance the first frame was
black-on-white before init landed. The alternative — serving the document
pre-themed — means duplicating the whole palette into the main process, where it
would drift from `globals.css`. The reveal has a CSS-only 400ms failsafe so a host
that never sends init cannot leave a tool invisible.

**An exit only ends a session if it came from that session's current process.**
`stop()` is synchronous, `close` is not, so a replaced child reports its exit after
the replacement is already in `runtimes` — deleting by session id there removed the
*live* runtime and every event from the process doing the work was dropped by the
`if (!runtime) return` guard. `onEvent` takes the `proc` and compares identity;
`ClaudeProcess.stopped` marks a deliberate kill so it is not announced as a crash
(Windows reports code 1 for a killed child). `lifecycle.probe.ts` covers both.

**Every message into a tool frame carries a `gen`.** Request ids restart at `r1` in
each frame, so after a source change a reply meant for the old document could
resolve the new one's first request. The bridge latches the first generation it sees
and drops anything else; the host stamps a reply with the generation the *request*
arrived in, not the current one.

**Tool state writes are serialised and superseded ones are dropped.** Each write
carries the whole document, so two in flight are two snapshots, not two changes.
Unserialised they landed out of order and the older snapshot won the retry — putting
back a character the user had just deleted. See `write` in `ToolView`.

**`create_interactive_tool` refuses a name that already exists.** `ToolStore.save()`
with no id matches on name, so creating a tool twice silently replaced the user's
interface. Changing one goes through `update_interactive_tool` with its id.

**A question from a tool's run is rendered by the tool, not by chat.** `ChatPanel`
filters questions to the *current* session, which a tool's archived session never
is — so `ask_user` from a button was invisible and the run waited for the backstop.
`ToolView` subscribes to `chat:question` itself (a popped-out window has no store in
it) and forwards it as run status `ask`; `brain.answer` is the tool-side path.

**Cross-platform rules, all learned the hard way.**

- `window-all-closed` must **not** tear down on macOS. Closing the last window there
  does not quit the app, so shutting down the backend left the Dock icon reopening a
  window wired to nothing. `before-quit` does the teardown on every platform.
- `titleBarOverlay` is Windows/Linux only. macOS needs `trafficLightPosition`, and
  the renderer has to leave its gap on the **left** — `src/shared/window-chrome.ts`
  is the one source of truth for which side and how wide, used by both processes.
- Filenames are composed to NFC **only on macOS** (`normaliseUnicode` in
  `vault.ts`). APFS treats both Unicode forms as one file so composing is safe and
  fixes Turkish names churning every index pass; NTFS matches bytes, so composing
  there breaks opening a decomposed file. `vault/unicode.test.ts` asserts the
  invariant rather than the encoding, and caught exactly that regression.
- `formatHotkey` defaults to `win32`. Every call site must pass a platform or a Mac
  user is told "Ctrl" for a shortcut that is really Cmd.
- Never hardcode `electron.exe`. `require('electron')` returns the binary's real
  path on every platform; `run-ts.mjs` had the Windows name and no verification
  script could run anywhere else.
- The mac build is **ad-hoc signed** (`identity: '-'`), not unsigned. Apple Silicon
  refuses to run a wholly unsigned binary, so `identity: null` ships something that
  cannot launch. `hardenedRuntime` must stay off with an ad-hoc signature —
  app-builder-lib warns it needs a library-validation entitlement otherwise.
- `build/icon-mac.png` is separate from `build/icon.png` because macOS does not mask
  app icons; the artwork carries its own shape, inset on Apple's 824-in-1024 grid.

**The hourly check-in must earn its turn.** `buildHeartbeat` is a deterministic
pre-check and the only reason proactivity can default to on: twenty-four model turns a
day out of the user's subscription, most against an unchanged vault, is exactly the
casual spend this file forbids. Two rules make it work, and both were bugs first:
`heartbeat/lastSeenAt` advances **even on a skip** (or the same notes look new every
hour), and standing conditions are compared against `heartbeat/lastSignature` (or a
note past its expiry is raised every hour for ever). `changed` is deliberately outside
that signature — it is already time-filtered, so it is an event and speaks for itself.

**A scheduled run gets its own chat, never the user's.** `Scheduler.sessionFor` creates
an archived session per task and reuses it, so a digest never lands mid-conversation
and a task's history reads as a series. `tasks:openSession` un-archives on the way out.

**Catch-up is once, not once per missed interval.** `recordRun` computes the next time
from *now*, so a day offline collapses to a single run rather than twenty-four. The
scheduler also runs one task per tick and never two at once — two turns would be two
CLI processes on one vault, at double the spend, for work nobody is waiting on.

**Chat state is keyed by session id.** `chats` in the store, read through
`activeChat(state)`. The old flat shape dropped every event whose session was not on
screen, which made switching conversations indistinguishable from cancelling one. Only
the active chat gets a cost readout or an error toast — a task failing at 3am must not
throw a toast over whatever the user is doing now.

**Never notify about something already on screen.** `Notifier.unattended()` checks
every window, not just the main one. The heartbeat is told to answer exactly "Nothing
to report." when it has nothing, and the notifier filters that string — without it a
deliberately quiet feature becomes an hourly interruption.

**Do not use `--tools` when spawning the CLI.** It replaces the whole tool set
including MCP tools, which severs the agent from the brain. Capability tiers use
`--disallowedTools`; see `deniedToolsFor` in `src/main/agent/prompt.ts`.

**Do not add `--strict-mcp-config` back.** The user's Claude account has ~28
connectors already set up (Gmail, Calendar, Drive, Slack, ClickUp, Vidsmith,
Pencil…). That flag excludes all of them and was the reason integrations felt
broken. The app's own manifests are a fallback for services *not* already
connected, not the primary path.

**Generated UI must be re-emitted, not just stored.** `render_ui` appends a block
to an already-persisted message. The renderer holds its own copy, so
`handleGenUi` has to emit a fresh `message` event as well as calling
`chat.updateMessage` — otherwise the agent says "built an interface" and nothing
appears.

**Graph updates go through the worker's `update` message, not `init`.** `init`
rebuilds the simulation and throws away the layout, which makes the graph jump
mid-conversation. `GraphCanvas` diffs snapshots and only falls back to `init`
past ~30% churn.

**Don't namespace-import lucide.** `import * as LucideIcons` to resolve an icon
name dynamically added ~900KB to the bundle. `TOOL_ICONS` in `ToolsPanel.tsx` is
a curated map for exactly that reason.

**Never `spawnSync` in the main process.** It has one thread, and starting the CLI
takes most of a second — during which no IPC is answered, no agent event is
processed, and every window is frozen. Usage refreshed on a 90-second timer this
way, which is what "the app hangs sometimes" was. Use `runClaude()` in
`src/main/agent/claude.ts`. `resolveClaudeBinary()` is the one exception: a cached
`where claude`.

**MCP config must be built after `ToolHost.start()`.** `start()` is what writes the
bridge and populates `bridgePath`. Building the config earlier hands the CLI an
empty command and the spawn fails silently — the symptom is the model reporting it
has no `mcp__brain__*` tools.

**`init` is emitted before MCP servers finish connecting.** `mcp_servers: pending`
and zero brain tools in the `init` frame are normal and mean nothing. Judge by
whether tools reach the model during the turn.

## Spend

Usage comes out of the user's Claude subscription. They have asked explicitly that
it not draw on extra API credits.

- Anthropic auth/endpoint env vars are stripped in `subscriptionEnv()` before the
  CLI starts. Do not reintroduce a passthrough of the raw environment.
- Caps live in `Settings.budget` with `mode: 'auto'`, which enforces them **only**
  when the CLI bills metered API credits. On a subscription there is no per-token
  charge to cap, so they stand down and the footer shows real usage windows
  instead (`src/main/usage/usage.ts`, reconstructed from `~/.claude/projects`
  transcripts — this machine only, not claude.ai web usage).
- `--max-budget-usd` stops a turn *continuing*; it cannot make one step cheaper.
  A single turn can land over the per-turn cap. The daily cap is the real guard.
- The curator's agent pass defaults to **off**.
- **Do not run `agent.probe.ts` or any other live model call casually.** It costs
  real usage. `bridge.probe.ts` and `spawn.probe.ts` verify the plumbing without
  touching a model — prefer those.

## Testing

There is no test runner. Verification is done with self-contained scripts run
through `scripts/run-ts.mjs`, each printing `ok`/`FAIL` lines and exiting non-zero
on failure:

- `src/main/util/slug.test.ts` — filename and Turkish folding rules
- `src/main/vault/markdown.test.ts` — frontmatter, wikilinks, tags, round trip
- `src/main/db/storage.test.ts` — the whole storage layer end to end
- `src/main/agent/*.probe.ts` — agent plumbing (see the spend note above)
- `src/main/agent/lifecycle.probe.ts` — a deliberate stop vs. a process that dies
  mid-turn, driven by a stub script standing in for the CLI. No model, no cost.

Some probes need a real `BrowserWindow` and take `--gui`: `graphIcons`,
`canvasRender`, `chatStream`, `codeTool`, `toolWindow`, `windowSize`, `toolPreview`.
The rest take `--node`. `codeTool.probe.ts` renders every tool twice, dark and
light — the baseline stylesheet's fallbacks are all dark values, so the light pass
is the one that proves the real tokens arrived before anything painted.

Keep this pattern for new work rather than adding a framework.

## Conventions

- Vault-relative paths, always forward slashes.
- A note's `expires` lives in its own frontmatter; the `expires_at` column mirrors
  it. The file wins — deleting the key makes a note permanent on the next index.
  `Curator.retireExpired()` moves due notes to `.trash/`, never deletes, and skips
  pinned ones.
- Every path from the agent goes through `Vault.absolute()`, which bounds-checks.
- Mutations go through `BrainCore`, never directly to a store, so activity and
  renderer notifications happen exactly once.
- Edges carry an `origin`; `replaceFrom` is scoped by it so re-indexing a file
  cannot delete links the agent or curator added.
- New IPC goes in `ApiMap` in `src/shared/ipc.ts` and in `API_CHANNELS`. The
  handler table in `src/main/ipc.ts` is typed against it, so a missing handler is
  a compile error.
- Renderer motion: `--ease-out` for enter/exit, `--ease-in-out` for movement,
  under 300ms, `active:scale-[0.97]` on pressables. Nothing keyboard-initiated
  animates — the command palette deliberately has no transition. The rest is in
  `DESIGN.md`.
- **Never `text-transform: uppercase` on agent- or user-written text.** It turns
  Turkish "istiyorsun" into "ISTIYORSUN" and "Bitti" into "BITTI", losing the
  dotted İ. Fixed English chrome only; use `tracking-wide` elsewhere.
- Node kinds live in **one** table: `src/shared/node-kinds.ts` defines the label,
  colour token, family, icon and the sentence the agent reads. The type union, the
  canvas colours, the legend, the icon fallbacks, the frontmatter allowlist and the
  `create_note` enum all derive from it. Adding a kind means adding a row — and an
  icon to `scripts/gen-node-icons.mjs` if it needs a new glyph. Colour is the
  *family*, the icon is the kind: eight chart hues is the limit for telling colours
  apart at 17px, so kinds share hues and are separated by glyph.
- The kind wins over the subject keyword for every kind except `note` and `tag` —
  a decision about code is still a decision.
- Graph edges are drawn in four batched passes, curved so parallel bundles separate.
  Tag edges are a whisper (alpha 0.07) at rest and only drawn properly when their
  end is in attention: a tag sits on the rim, so its edges cross the whole canvas
  and were most of the clutter. Hiding them outright was worse — a tag with no edge
  reads as an orphan. `similar` edges are dashed, so the curator's guesses do not
  look like links the user wrote.
- Labels are placed in importance order and any that would overlap an already-placed
  one is dropped. Two overlapping labels are worse than one.
- Graph node icons: `src/shared/icon-paths.ts` is **generated** — run
  `node scripts/gen-node-icons.mjs` to change the set, never edit it. The picker
  lives in `src/shared/node-icons.ts` (pure logic, testable under Node); the canvas
  drawing is in `components/graph/node-icons.ts`. Keywords match as prefixes
  because Turkish is agglutinative — "tarif" has to catch "tarifi".
- `DESIGN.md` at the repo root is bundled into main via `?raw` and seeded to
  `<vault>/.brain/DESIGN.md` on first run. The agent reads the seeded copy, so the
  user can edit it; the repo copy is the default and gets reviewed like code.

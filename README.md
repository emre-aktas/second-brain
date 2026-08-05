# Second Brain

A desktop knowledge base where a physics-driven graph of your notes is the main
screen, and an agent works alongside it — reading and writing your notes, connecting
them, answering with a live interface instead of a wall of text, and checking in on
its own when something is worth raising.

Notes are plain markdown on your own disk. Nothing is locked in.

Windows 10/11 and macOS 11 Big Sur or newer, on both Apple Silicon and Intel.

![The graph on the left, the conversation on the right](docs/screenshot.png)

---

## What you need first

This app does not talk to an AI provider itself. It drives **your own**
[Claude Code](https://claude.com/claude-code) install as a subprocess:

- Install the `claude` CLI and sign in to it once, before opening the app.
- Everything the agent does draws on **that account's own limits**. There is no API
  key to paste anywhere, and no second bill — the footer shows how much of your
  current window is left.
- Anthropic auth and endpoint environment variables are deliberately stripped before
  the CLI starts, so the app cannot silently fall back to a key it inherited from
  the shell that launched it.

Without the CLI the app still opens and the graph still works, but the agent cannot
answer.

## Install

Grab an installer from [Releases](https://github.com/emre-aktas/second-brain/releases).

**Windows** — run the `Setup` installer, or use the portable `.exe`.

**macOS** — open the `.dmg` for your chip (`arm64` for Apple Silicon, `x64` for
Intel) and drag the app to Applications. These builds are ad-hoc signed but **not
notarized by Apple**, so the first launch is blocked: right-click the app and choose
**Open**, then confirm. Once only. If macOS still refuses:

```bash
xattr -dr com.apple.quarantine "/Applications/Second Brain.app"
```

---

## What it does

**The graph is the home screen.** Every note is a circle, every connection a line,
and nothing needs arranging — it lays itself out. Colour is the family a note belongs
to and the glyph is its kind, because eight hues is the limit for telling colours
apart at 17px. It settles and then stays still: this screen is open all day, and
ambient drift is noise. Movement happens only on meaningful events — a pulse when a
note changes, a camera tween when something is focused.

**Answers arrive as interfaces.** Ask for a comparison and you get a table; ask for a
breakdown and you get a chart. The agent emits a validated spec and the renderer maps
each block onto a real component, so nothing is ever eval'd and everything matches the
design system.

**Tools are built on request.** Ask for "a translator with a casual and a formal
button" and you get a saved tool with those buttons, its own document, and its own
window if you want one. The agent writes the interface as ordinary HTML and CSS inside
a sandboxed frame — so no two tools have to look alike — and each button runs a single
agent job against the tool's inputs.

**It works on its own clock.** The Tasks tab holds anything recurring: "every hour,
scan Slack and compile what is new", "every weekday at nine, summarise yesterday".
Ask for it in conversation and it appears there. Alongside them is an hourly check-in
that decides for itself whether anything is worth raising — and answers "nothing to
report" most of the time, which is the point.

One switch turns all of that off, including your own tasks. An app that acts
unprompted has to be legible, so every scheduled run is listed with what it will do,
when it goes next, and how the last one went.

**Notifications only when you are not looking.** A reply that lands while you are in
another window, a scheduled run with something to say, a question the agent is blocked
on. Never for something already on screen.

**Conversations run in parallel.** Starting a second one does not stop the first;
the history list shows which are still working.

---

## Your notes stay yours

A workspace is created at `Documents/Second Brain` on first launch:

```
vault/          your notes, as .md with YAML frontmatter
attachments/
integrations/   manifests and any code the agent writes
.brain/         SQLite index and logs — derived, safe to delete
.trash/         soft-deleted notes, never hard-deleted
```

`vault/` is the source of truth and the SQLite index is only a cache, rebuildable
from the files at any time. That is what makes it safe to open the same vault in
Obsidian, put it under git, or sync it however you like.

Two kinds of connection exist:

- `[[Wikilinks]]` in a note's body are part of the writing. They live in the file and
  are re-derived on every index.
- Edges the agent or the curator added live only in the index, tagged with their
  origin so re-indexing can never clobber them.

Linking to a note that does not exist yet is a feature: it shows up as a hollow node,
and when you eventually write it the note **inherits that node's identity**, so every
link already pointing at it stays intact.

Notes can also be given an expiry when they are written — a daily digest is worth
keeping for a week, not for ever. Expired notes move to `.trash/`, and pinned ones
are never touched.

---

## Architecture

```
src/shared/     types, the IPC contract, the Generated UI schema, schedule maths
src/main/       Electron main process
  db/           SQLite (WASM) — nodes, edges, FTS5, activity, chat, tools, tasks
  vault/        markdown parsing, file access, indexer, filesystem watcher
  agent/        claude CLI driver, tool host, MCP bridge, system prompt
  tasks/        the scheduler and the check-in's pre-check
  curator/      TF-IDF similarity and the idle-time background pass
src/preload/    the sandboxed bridge — an allowlist, nothing more
src/renderer/   React, Tailwind v4, shadcn/ui
  components/graph/   force worker + canvas renderer
  components/genui/   spec -> component renderer
  components/tools/   the sandboxed frame agent-written tools live in
```

### Notable decisions

**SQLite as WebAssembly.** `node-sqlite3-wasm` rather than `better-sqlite3`: it
removes the Electron ABI rebuild step entirely, so dev and packaged builds run
byte-identical engines and packaging needs no native toolchain. FTS5 and JSON1 are
both present, and the driver sits behind one file if it ever needs swapping.

**Turkish-aware search.** FTS5's `remove_diacritics` only strips combining marks, so
it never maps dotless `ı` to `i` or `ğ` to `g` — searching "ogrenme" would miss
"Öğrenme". Both the indexed text and the query are folded through an explicit
transliteration, so it does not.

**Filenames are composed to NFC, but only on macOS.** The same Turkish characters can
be encoded two ways, and APFS may hand back either. Left alone, the index and the disk
disagree about a name and every pass reports the note deleted and recreated. Windows
returns exactly what was written, and NTFS matches bytes — so composing there would
break opening the file instead of fixing anything.

**The agent talks to the app over MCP.** The `claude` CLI is spawned with
bidirectional `stream-json` and given a generated stdio MCP server that proxies to a
localhost JSON API. stdio over an HTTP endpoint because it is the most universally
supported transport; the bridge script is written at runtime so packaging needs no
extra resources, and it runs under the Electron binary as a Node runtime so no
separate Node install is required.

**Capability tiers use a denylist.** `--tools` replaces the entire available tool set
*including MCP tools*, which silently cuts the agent off from the app's own tools.
`--disallowedTools` removes only what is named. Tiers are `read-only`, `curate` (the
default) and `build`, which adds shell and file access and is opt-in per conversation.

**Generated UI is a schema, not code.** The agent emits a spec validated by zod
against 24 block types and the renderer maps each onto a component. No eval, no
runtime compilation, always consistent with the design system. Validation errors come
back with exact paths so the agent corrects itself.

**Agent-written tools run in a frame that can reach nothing.** Served from a custom
scheme with a policy that permits no network at all, sandboxed without
`allow-same-origin` so it lands on an opaque origin with no storage and no way to
touch the host document. The entire surface it gets is a handful of postMessage calls,
which is what makes running arbitrary generated code safe. The contract is in
[TOOL_API.md](TOOL_API.md).

**Unprompted work has to earn its turn.** The hourly check-in runs a deterministic
pre-check first — has anything actually changed? — and spends nothing when the answer
is no. It separates events from standing conditions, so a note past its expiry is
raised once rather than every hour for the rest of its life.

---

## Development

```bash
npm install
npm run dev
```

```bash
npm run build      # compile main, preload and renderer
npm run typecheck  # tsc over both tsconfig projects
npm run verify     # the whole verification suite
npm run icons      # regenerate build/icon.{png,ico} and icon-mac.png
npm run dist       # installers for the platform you are on, into release/
npm run dist:win   # NSIS installer + portable .exe
npm run dist:mac   # .dmg and .zip, arm64 and x64
```

macOS artifacts have to be built on macOS — `.icns` generation and `codesign` only
exist there. `.github/workflows/release.yml` builds both platforms on a tag.

### Verification

There is no test runner. Each check is a self-contained script that prints `ok`/`FAIL`
and exits non-zero, run through `scripts/run-ts.mjs`, which bundles one main-process
module with esbuild and runs it under the Electron runtime:

```bash
npm run verify              # everything that needs no Claude subscription
npm run verify -- --all     # plus the probes that drive the real claude CLI
```

Or one at a time. `--node` runs under plain Node; `--gui` needs a real
`BrowserWindow`, because those probes render offscreen and capture a PNG — looking at
the picture is the point:

```bash
node scripts/run-ts.mjs src/main/db/storage.test.ts --node
node scripts/run-ts.mjs src/shared/schedule.test.ts --node        # schedule arithmetic
node scripts/run-ts.mjs src/main/vault/unicode.test.ts --node     # NFC/NFD filenames
node scripts/run-ts.mjs src/main/agent/lifecycle.probe.ts --node  # a stop vs. a crash
node scripts/run-ts.mjs src/main/codeTool.probe.ts --gui          # tools, dark and light
node scripts/run-ts.mjs src/main/agent/agent.probe.ts --node      # round trip, SPENDS USAGE
```

`agent.probe.ts` runs a real model turn against your account, which is why nothing
runs it automatically. Everything in `npm run verify` is free.

`npm run verify` also fails if any file under `src/` or `scripts/` is excluded by
`.gitignore` — an unanchored directory pattern once swallowed two source folders, and
a working tree that looks complete gives no hint of it.

## Licence

MIT. See [LICENSE](LICENSE).

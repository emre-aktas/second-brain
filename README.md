# Second Brain

A desktop personal knowledge base where a physics-driven graph of your notes is
the main screen, and an embedded Claude agent works alongside it — reading and
writing your notes, connecting them, answering with generated interfaces instead
of walls of text, and quietly looking for connections while you are away.

Notes are plain markdown on your own disk. Nothing is locked in.

Windows 10/11 and macOS 11 Big Sur or newer, on both Apple Silicon and Intel.

## What you need first

Second Brain does not talk to an AI provider itself. It drives **your own**
[Claude Code](https://claude.com/claude-code) install as a subprocess, so:

- Install the `claude` CLI and sign in to it once, before opening this app.
- Work is billed to whatever that CLI is signed in to — a Claude subscription, or
  metered API credits if that is how the account is set up. Settings shows which,
  and the remaining usage windows.
- There is no API key to paste anywhere. Anthropic auth and endpoint environment
  variables are deliberately stripped before the CLI starts, so the app cannot
  silently fall back to a key inherited from the shell that launched it.

Without the CLI the app opens and the graph works, but the agent cannot answer.

## Install

Grab an installer from [Releases](https://github.com/emre-aktas/second-brain/releases).

**Windows** — run the `Setup` installer, or use the portable `.exe`.

**macOS** — open the `.dmg` for your chip (`arm64` for Apple Silicon, `x64` for
Intel) and drag the app to Applications. These builds are ad-hoc signed but **not
notarized by Apple**, so the first launch is blocked: right-click the app and
choose **Open**, then confirm. Once only. If macOS still refuses:

```bash
xattr -dr com.apple.quarantine "/Applications/Second Brain.app"
```

## Running from source

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

## The workspace

Created at `Documents/Second Brain` on first launch:

```
vault/          your notes, as .md with YAML frontmatter
integrations/   manifests and any code the agent writes
attachments/
.brain/         SQLite index and logs — derived, safe to delete
.trash/         soft-deleted notes
```

`vault/` is the source of truth. The SQLite index is a cache that can always be
rebuilt from the files, which is why it is safe to open the vault in Obsidian, put
it under git, or sync it however you like.

Two kinds of connection exist:

- `[[Wikilinks]]` in a note's body are part of the writing. They persist in the
  file and are re-derived on every index.
- Graph edges added by the agent or the curator live only in the index, and are
  tagged with their origin so re-indexing never clobbers them.

Linking to a note that does not exist yet is a feature: it appears as a hollow
node. When you later write that note, it **inherits the stub's identity**, so
every link that pointed at it stays intact.

## Architecture

```
src/shared/     types, the IPC contract, the Generated UI schema
src/main/       Electron main process
  db/           SQLite (WASM) — nodes, edges, FTS5, activity, chat, integrations
  vault/        markdown parsing, file access, indexer, filesystem watcher
  agent/        claude CLI driver, tool host, MCP bridge, system prompt
  integrations/ registry, MCP client, OAuth2, REST/script adapters, secrets
  curator/      TF-IDF similarity and the idle-time background pass
src/preload/    the sandboxed bridge — an allowlist, nothing more
src/renderer/   React, Tailwind v4, shadcn/ui
  components/graph/   force worker + canvas renderer
  components/genui/   spec -> component renderer
```

### Notable decisions

**SQLite as WebAssembly.** `node-sqlite3-wasm` rather than `better-sqlite3`: it
removes the Electron ABI rebuild step entirely, so dev and packaged builds run
byte-identical engines and packaging needs no native toolchain. FTS5 and JSON1 are
both present. The driver sits behind one file if it ever needs swapping.

**Turkish-aware search.** FTS5's `remove_diacritics` only strips combining marks,
so it never maps dotless `ı` to `i` or `ğ` to `g` — searching "ogrenme" would miss
"Öğrenme". Both the indexed text and the query are folded through an explicit
transliteration, so it does not.

**The agent talks to the app over MCP.** The `claude` CLI is spawned with
bidirectional `stream-json`, and given a generated stdio MCP server that proxies to
a localhost JSON API. stdio was chosen over an HTTP MCP endpoint because it is the
most universally supported transport; the bridge script is written to `userData` at
runtime, so packaging needs no extra resources, and it runs under the Electron
binary as a Node runtime so no separate Node install is required.

**Capability tiers use a denylist.** `--tools` replaces the entire available tool
set *including MCP tools*, which silently cuts the agent off from the brain.
`--disallowedTools` removes only what is named. Tiers are `read-only`, `curate`
(the default) and `build`, which adds shell and file access for authoring
integrations and is opt-in per conversation.

**Generated UI is a schema, not code.** The agent emits a spec validated by zod
against 24 block types, and the renderer maps each onto a shadcn component. No
eval, no runtime compilation, always consistent with the design system. Validation
errors come back with exact paths so the agent self-corrects.

**The graph settles and stays still.** There is no ambient drift. This screen is
open all day, and constant motion is noise. Movement happens only on meaningful
events: a pulse when a node changes, a camera tween when something is focused.

## Integrations

Five kinds, all described by a manifest:

| kind | for |
| --- | --- |
| `mcp-stdio`, `mcp-http` | anything that already speaks MCP — passed straight through to Claude Code |
| `rest` | HTTP APIs with none/apiKey/bearer/basic/oauth2 auth. Purely declarative |
| `script` | a Node script, when an API needs real logic |
| `webhook` | inbound JSON becomes a note |

Presets ship for Gmail, Google Calendar, GitHub, Slack, an MCP filesystem server
and a generic inbound webhook. All arrive disabled.

The agent can write its own. `rest` is why that works without code execution: it
declares a base URL, an auth scheme and a list of operations, and each becomes a
callable tool. Secrets are never inlined — a manifest declares `requiredSecrets`
by ref, you fill them in through the UI, and values are encrypted with the OS
keychain. Agent-registered integrations are saved **disabled** and wait for your
approval.

OAuth2 uses authorization-code + PKCE against a loopback redirect, so consent
happens in your real browser and this app never sees your password.

## Usage limits

The agent runs on whatever account `claude` is signed in to — check Settings,
which shows the address and whether it is a subscription or metered credits.
Anthropic auth and endpoint environment variables are stripped before the CLI
starts, so it cannot silently fall back to an API key inherited from the shell
that launched the app.

Two caps, both in Settings:

- **Daily cap** — the real guard. No turn starts once it is reached.
- **Per-turn cap** — passed to the CLI, which stops a turn from continuing past
  it. It cannot make a single step cheaper, so one turn can land slightly over.

Neither changes how your organisation is billed. To stop credit spend outright, an
admin has to turn off extra usage in the Anthropic Console.

The background curator's agent-assisted pass is **off by default**: the
deterministic half (TF-IDF links, orphans, near-duplicates) costs nothing and
stays on.

## Development

`scripts/run-ts.mjs` bundles a single main-process TypeScript file with esbuild and
runs it under the Electron runtime, which is how the storage and agent layers are
exercised in isolation:

```bash
npm run verify              # everything that needs no Claude subscription
npm run verify -- --all     # plus the probes that drive the real claude CLI
```

Or one at a time. `--node` runs under plain Node; `--gui` needs a real
`BrowserWindow`, because those probes render offscreen and capture a PNG, and
looking at the picture is the point:

```bash
node scripts/run-ts.mjs src/main/db/storage.test.ts --node
node scripts/run-ts.mjs src/main/vault/unicode.test.ts --node   # NFC/NFD filenames
node scripts/run-ts.mjs src/main/agent/lifecycle.probe.ts --node
node scripts/run-ts.mjs src/main/codeTool.probe.ts --gui        # renders tools, dark and light
node scripts/run-ts.mjs src/main/agent/agent.probe.ts --node    # full round trip, SPENDS USAGE
```

`agent.probe.ts` runs a real model turn against your account, which is why nothing
runs it automatically. Everything in `npm run verify` is free.

## Licence

MIT. See [LICENSE](LICENSE).

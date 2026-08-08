# Changelog

What changed in each release. Written for the person using the app, not for the person who
wrote it: a line here should say what is different now, not which file moved.

This file is bundled into the app and read back by the updater, so the version headings are
load-bearing — `notesFromChangelog` in `src/main/updater.ts` finds a release by its heading.
Keep them as `## <version>` with the newest first. `npm run release` writes the skeleton for a
new one from the commits since the last release; edit it before pushing.

## 0.5.0

*2026-08-08*

- Walk a beginner through installing and signing in to a CLI

## 0.4.0

*2026-08-08*

- Give the Engine tab steps that fit, and a check that means something
- Keep a tool's model and thinking level per engine
- Make Codex and the API engines actually reach the vault
- Store a chosen model for a provider that has none yet
- Stop sending Claude's model name to every other engine
- Annotate the release tag, or the release never happens

## 0.3.0

*2026-08-06*

**There is an Integrations panel now, and it works.** The agent could already write an integration
for a service — read your Figma files, pull from an API — and hand it back for you to approve. What
was missing was the screen where you approve it. It exists, it is in the sidebar, and an
integration waiting on you says so in the header.

Each card shows what the thing will be allowed to do *before* you say yes: every operation it can
call, with the method and the exact path, and the address it will reach. Then one masked field per
credential it needs, with a link to the page the token comes from. Pasting it saves and tests it in
one press, and tells you what the service actually answered — including the HTTP status, so a token
that is wrong looks different from one that is right. Nothing can be turned on until every
credential it declared is there.

Per credential you can reveal it (only on a press, never by default), rotate it, delete it, and
give it an expiry date. That last one matters if you use short-lived tokens: the card warns you
once the date passes, instead of the integration quietly failing the next time something asks.

**Credentials are stored properly.** In the Windows credential store, as before, and where that is
unavailable they are now encrypted with a local key rather than merely encoded — the panel tells you
which of the two you are getting. No credential ever reaches the agent: it sees the *name* of a
token, never its value, and a request that fails with the token quoted back in the error has it
removed before the agent or the log sees it. Every call an integration makes is recorded with which
credential it used, and never with the credential.

**The agent can look after them, short of one thing.** It can turn an integration off, forget a
token, record an expiry date, remove an integration, and open the panel at the right card to tell
you what to paste. It cannot enter a credential and it cannot turn an integration on — the token is
yours to paste and the switch is yours to press, and both of those are the reason the rest of this
is safe to hand over.

**Note names can be turned off.** A button under the zoom controls hides every label on the graph,
for a screen share or somebody walking past. It stays hidden until you turn it back on.

## 0.2.0

*2026-08-06*

**Second Brain updates itself now.** When a new version is published, a marker appears in the
footer; opening it shows what changed and one button downloads it, installs it and restarts the
app. What's new is shown again on the way back up, so an update never happens without saying
what it did. The portable build and the macOS build still have to be replaced by hand — a
portable exe has no installation to replace, and the macOS build is signed ad-hoc, which the
updater refuses to overwrite — but both will tell you a new version exists and take you to it.

**The Scheduled tab shows what runs when.** A timeline across the next day or week, one row per
job, with the current moment marked and your quiet hours shaded so a gap in the evening explains
itself. A job that is working right now says "running" rather than counting its past runs.

**The tab is also much quieter.** The five settings at the top are behind one disclosure, each
job card is two lines instead of five, and the prompt — hundreds of words written for a model —
is no longer shown anywhere. What you open a job for is whether it has been working.

**Nodes are sized by how connected they are.** Properly this time: the area a node covers is
proportional to its links, so four times the connections looks like four times the node, and
hubs past twenty links are no longer all drawn at the same size.

**A blue dot on the tray and app icon when something is waiting.** The app keeps working with
its window closed, and until now it had no way to say it had something for you.

**Anything a tool's button does stays in the tool.** Those runs no longer appear in your
conversation list, and a notification about one names the tool and opens it rather than dropping
you into the machinery behind it.

## 0.1.0

The first build.

- A physics graph of your notes as the home screen, in three dimensions, with the agent's
  attention shown live on it while it works.
- An embedded agent that reads and writes the same vault of markdown you do, through your own
  Claude subscription.
- Saved tools: interfaces the agent builds for work you repeat, each with its own window.
- Scheduled jobs and an hourly check-in that stays quiet unless something is worth raising.
- Notifications, an inbox for what you missed, and a tray icon so it keeps working with the
  window closed.

# Changelog

What changed in each release. Written for the person using the app, not for the person who
wrote it: a line here should say what is different now, not which file moved.

This file is bundled into the app and read back by the updater, so the version headings are
load-bearing — `notesFromChangelog` in `src/main/updater.ts` finds a release by its heading.
Keep them as `## <version>` with the newest first. `npm run release` writes the skeleton for a
new one from the commits since the last release; edit it before pushing.

## 0.6.1

*2026-08-08*

### 🚪 Sending a message no longer needs Claude installed

0.6.0 stopped the chat from *looking* blocked when another engine was running, but the send itself
still checked for the Claude CLI one layer down — so a message typed into a perfectly enabled box
was swallowed, and answered with a toast telling you to install Claude Code. That check now asks
the same question everything else does: can the engine you actually chose answer.

## 0.6.0

*2026-08-08*

### 💬 The chat no longer blocks you over an engine you are not using

If you had picked DeepSeek — or any other provider — and it was working, the chat still refused to
accept a message and explained that the Claude CLI was missing. It was asking the wrong question:
whether Claude is installed, rather than whether the engine you actually chose can answer.

Now the composer follows **your** engine. And when something genuinely is wrong, the reason appears
right above the box you are typing in — not only on an empty conversation, which is where it used
to hide — with a button straight to the Engine tab.

### 💸 Spend caps: findable, and off until you ask

Two things were wrong here. The caps were tucked inside the Claude-only card, so from DeepSeek —
the provider that actually charges you — there was no way to reach them at all. And the default
mode worked out whether to apply itself by reading your *Claude* sign-in, which meant that on a
Claude plan the caps quietly stood down while a metered provider spent real money.

They now live in the Engine tab for **every** engine, as one switch that is **off by default**.
Turn it on and you get a daily cap and a per-turn cap; leave it alone and nothing ever stops a turn
you did not ask to be stopped.

### 📓 Release notes worth reading

These notes used to be the raw list of commit subjects the release script generates. 0.4.0 and
0.5.0 have been rewritten too, so if you are arriving from an older version there is something
readable there.

## 0.5.0

*2026-08-08*

### 🧭 Getting a CLI installed no longer requires knowing how

Choosing Codex or Claude Code without having it produced a warning and stopped there. Now it opens
a three-step walkthrough — install, sign in, check — with the command for **your** platform, the
name of the terminal to paste it into, and a Copy button. Every command is quoted from the
vendor's current documentation, and the one offered first is the one that needs nothing else
installed beforehand.

Press "I have installed it" and the app looks again properly, so you do not have to restart it.

### 🔐 Sign-in is its own step, and it is honest

Codex reports itself as signed in even when its session has quietly expired — which is why it
sometimes stopped working for no visible reason. The app treats "not signed in" as fact and
anything else as unconfirmed, tells you so, and settles it with the small check at the end
instead of showing a tick it cannot stand behind.

## 0.4.0

*2026-08-08*

### 🤖 Other models actually work now

Codex and the API providers (DeepSeek, OpenRouter, OpenAI, Groq, Together, Ollama, LM Studio, or
any endpoint that speaks the same dialect) can now read and write your notes properly. Several
things were quietly broken:

- 🧩 **Your chosen model was never saved.** For any provider. The log said it had been.
- 💬 **Codex was never given the app's instructions**, so it answered like a stock assistant
  instead of like something that knows your vault.
- 🔨 **Codex could not reach your notes at all** — the paths it was handed arrived corrupted, and
  every tool call it made was being cancelled before it started.
- 🔁 **Codex conversations were one message long.** The second message failed every time.
- 🧠 **Thinking levels existed but could not be set** on any API provider.
- 💸 **Token counts and spend read as zero** on every real provider, so the daily cap could never
  be reached however much was spent.
- 🖼️ **Screenshots you pasted were dropped** before the model saw them.

### 🎛️ The Engine tab is a setup flow, not a form

Steps are counted from what your provider actually needs, so no more "step 2 of 2" with no step 1.
The last step **sends one small message and reports three things separately**: whether it reached
the provider, whether the model answered, and whether it could call a tool — because "answers but
will not touch your notes" is the common middle outcome and it decides whether the agent is any
use. It never runs on its own, and a failure never blocks you.

An engine that needs something now offers the control that provides it. A provider with a key
stored has a settings card — model, key, address, thinking level — instead of a label.

### 🧰 Tools keep a model per engine

A tool pinned to a fast model kept that choice only on Claude and silently lost it everywhere
else. Now it is remembered per provider: the flagship at maximum thinking on one, something quick
and cheap on another, and switching back finds the old choice intact.

### 🔎 Smaller things

- Truncated and empty answers are reported as failures with a reason, rather than as a blank reply.
- The footer no longer shows your Claude plan while a different provider is answering.
- ⚠️ Codex runs **unsandboxed**, and the Engine tab says so. Its CLI cancels every tool call
  unless the sandbox is off, so that is the trade it comes with; the app's own permission setting
  still governs what it does to your notes.

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

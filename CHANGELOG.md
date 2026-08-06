# Changelog

What changed in each release. Written for the person using the app, not for the person who
wrote it: a line here should say what is different now, not which file moved.

This file is bundled into the app and read back by the updater, so the version headings are
load-bearing — `notesFromChangelog` in `src/main/updater.ts` finds a release by its heading.
Keep them as `## <version>` with the newest first. `npm run release` writes the skeleton for a
new one from the commits since the last release; edit it before pushing.

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

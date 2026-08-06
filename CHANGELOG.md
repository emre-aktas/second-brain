# Changelog

What changed in each release. Written for the person using the app, not for the person who
wrote it: a line here should say what is different now, not which file moved.

This file is bundled into the app and read back by the updater, so the version headings are
load-bearing — `notesFromChangelog` in `src/main/updater.ts` finds a release by its heading.
Keep them as `## <version>` with the newest first. `npm run release` writes the skeleton for a
new one from the commits since the last release; edit it before pushing.

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

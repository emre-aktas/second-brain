import { app } from 'electron'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorkspaceInfo } from '@shared/types'
// The repository copy is the source of truth and gets reviewed like code; it is
// bundled here so a fresh install has it without shipping a loose file.
import DESIGN_BRIEF from '../../DESIGN.md?raw'

export interface AppPaths extends WorkspaceInfo {
  settingsFile: string
  secretsFile: string
  logFile: string
  attachmentsDir: string
  /** The design brief the agent reads before it builds an interface. */
  designFile: string
}

/**
 * The workspace lives in Documents rather than userData on purpose: the vault is
 * plain markdown the user should be able to open in Obsidian, put under git, or
 * sync however they like. Only derived state (index, logs, secrets) is hidden.
 */
export function defaultWorkspaceRoot(): string {
  return join(app.getPath('documents'), 'Second Brain')
}

export function resolveAppPaths(workspaceRoot: string): AppPaths {
  const root = resolve(workspaceRoot)
  const userData = app.getPath('userData')

  return {
    root,
    vaultDir: join(root, 'vault'),
    integrationsDir: join(root, 'integrations'),
    attachmentsDir: join(root, 'attachments'),
    trashDir: join(root, '.trash'),
    dbPath: join(root, '.brain', 'index.db'),
    settingsFile: join(userData, 'settings.json'),
    secretsFile: join(userData, 'secrets.enc'),
    logFile: join(root, '.brain', 'app.log'),
    designFile: join(root, '.brain', 'DESIGN.md')
  }
}

const WELCOME_NOTE = `---
title: Welcome to your Second Brain
kind: note
tags: [meta, start-here]
---

This vault is plain markdown on disk. Open it in Obsidian, put it under git, back
it up — nothing here is locked into the app.

## How it works

Every file becomes a node in the graph on the main screen. Links create edges:

- \`[[Wikilinks]]\` connect notes. A link to a note you have not written yet waits
  quietly; the edge appears the moment that note exists.
- \`#tags\` become their own nodes, so a tag is a place you can navigate to.

## The agent

Ask it anything in the panel on the right. It can read and write notes, link
them, pull from your connected tools, and answer with a generated interface
instead of a wall of text — try *"show me what I worked on this week"*.

It also works while you are not looking: when you go idle it looks for notes that
belong together, orphans worth filing, and duplicates worth merging, then leaves
those as suggestions for you to accept or dismiss.

## Connecting tools

Anything with an MCP server connects directly. For services without one, it can
write the integration itself — describe what you want in chat and approve the
manifest it produces.

See [[Ideas]] for a place to start.
`

const IDEAS_NOTE = `---
title: Ideas
kind: note
tags: [start-here]
---

A scratch node so the graph has an edge to draw on day one. Replace it with
whatever you are actually thinking about.

Linked from [[Welcome to your Second Brain]].
`

export function ensureWorkspace(paths: AppPaths): { created: boolean } {
  const created = !existsSync(paths.vaultDir)

  for (const dir of [
    paths.root,
    paths.vaultDir,
    paths.integrationsDir,
    paths.attachmentsDir,
    paths.trashDir,
    join(paths.root, '.brain')
  ]) {
    mkdirSync(dir, { recursive: true })
  }

  if (created) {
    writeFileSync(join(paths.vaultDir, 'Welcome to your Second Brain.md'), WELCOME_NOTE, 'utf8')
    writeFileSync(join(paths.vaultDir, 'Ideas.md'), IDEAS_NOTE, 'utf8')
  }

  // Seeded rather than bundled-and-read-only: this is the user's design brief now,
  // and editing it should change what the agent builds without a rebuild. Only
  // written when absent, so their edits are never overwritten on startup.
  if (!existsSync(paths.designFile)) {
    writeFileSync(paths.designFile, DESIGN_BRIEF, 'utf8')
  }

  // Keep derived state out of version control without the user having to think
  // about it, so `git init` in the workspace root just works.
  const gitignore = join(paths.root, '.gitignore')
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, ['.brain/', '.trash/', ''].join('\n'), 'utf8')
  }

  return { created }
}

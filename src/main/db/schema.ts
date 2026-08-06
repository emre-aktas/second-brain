import type { Db } from './sqlite'
import { createLogger } from '../logger'

const log = createLogger('db:schema')

interface Migration {
  version: number
  name: string
  up: string
}

/**
 * Forward-only migrations. The vault on disk is the source of truth, so a
 * corrupted or unreadable index can always be dropped and rebuilt from the
 * markdown files — that keeps migrations low-risk.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE nodes (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL DEFAULT 'note',
        title        TEXT NOT NULL,
        title_key    TEXT NOT NULL,
        path         TEXT,
        summary      TEXT,
        body         TEXT NOT NULL DEFAULT '',
        tags         TEXT NOT NULL DEFAULT '[]',
        props        TEXT NOT NULL DEFAULT '{}',
        pinned       INTEGER NOT NULL DEFAULT 0,
        x            REAL,
        y            REAL,
        color        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        accessed_at  INTEGER,
        content_hash TEXT
      );
      CREATE UNIQUE INDEX idx_nodes_path ON nodes(path) WHERE path IS NOT NULL;
      CREATE INDEX idx_nodes_title_key ON nodes(title_key);
      CREATE INDEX idx_nodes_kind ON nodes(kind);
      CREATE INDEX idx_nodes_updated ON nodes(updated_at DESC);

      CREATE TABLE edges (
        id         TEXT PRIMARY KEY,
        src        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        dst        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        weight     REAL NOT NULL DEFAULT 1,
        label      TEXT,
        origin     TEXT NOT NULL DEFAULT 'vault',
        created_at INTEGER NOT NULL,
        UNIQUE (src, dst, kind)
      );
      CREATE INDEX idx_edges_src ON edges(src);
      CREATE INDEX idx_edges_dst ON edges(dst);
      CREATE INDEX idx_edges_kind ON edges(kind);

      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        node_id UNINDEXED,
        title,
        body,
        tags,
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TABLE activity (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        kind    TEXT NOT NULL,
        actor   TEXT NOT NULL,
        node_id TEXT,
        title   TEXT NOT NULL,
        detail  TEXT
      );
      CREATE INDEX idx_activity_ts ON activity(ts DESC);
      CREATE INDEX idx_activity_node ON activity(node_id);
      CREATE INDEX idx_activity_kind ON activity(kind);

      CREATE TABLE suggestions (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        title           TEXT NOT NULL,
        rationale       TEXT NOT NULL DEFAULT '',
        payload         TEXT NOT NULL DEFAULT '{}',
        status          TEXT NOT NULL DEFAULT 'pending',
        auto_applicable INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        resolved_at     INTEGER
      );
      CREATE INDEX idx_suggestions_status ON suggestions(status, created_at DESC);

      CREATE TABLE sessions (
        id                TEXT PRIMARY KEY,
        claude_session_id TEXT,
        title             TEXT NOT NULL DEFAULT 'New conversation',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        archived          INTEGER NOT NULL DEFAULT 0,
        total_cost_usd    REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_sessions_updated ON sessions(archived, updated_at DESC);

      CREATE TABLE messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        blocks     TEXT NOT NULL DEFAULT '[]',
        ts         INTEGER NOT NULL,
        meta       TEXT
      );
      CREATE INDEX idx_messages_session ON messages(session_id, ts);

      CREATE TABLE genui (
        id         TEXT PRIMARY KEY,
        session_id TEXT,
        message_id TEXT,
        spec       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_genui_session ON genui(session_id, created_at DESC);

      CREATE TABLE integrations (
        id              TEXT PRIMARY KEY,
        manifest        TEXT NOT NULL,
        health          TEXT NOT NULL DEFAULT 'unknown',
        last_error      TEXT,
        last_checked_at INTEGER,
        tool_count      INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE kv (
        k          TEXT PRIMARY KEY,
        v          TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 2,
    name: 'drop-stub-nodes-add-saved-tools',
    up: `
      -- Placeholder nodes for unwritten wikilink targets are no longer created;
      -- clear the ones already in the index. Their edges cascade.
      DELETE FROM nodes_fts WHERE node_id IN (SELECT id FROM nodes WHERE kind = 'stub');
      DELETE FROM nodes WHERE kind = 'stub';

      -- Reusable prompts the agent writes for the user: a repeated task turned
      -- into a one-click tool.
      CREATE TABLE saved_tools (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon        TEXT,
        prompt      TEXT NOT NULL,
        params      TEXT NOT NULL DEFAULT '[]',
        pinned      INTEGER NOT NULL DEFAULT 0,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_by  TEXT NOT NULL DEFAULT 'agent',
        run_count   INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_saved_tools_pinned ON saved_tools(pinned DESC, sort_order, created_at);
    `
  },
  {
    version: 3,
    name: 'saved-tool-last-output',
    up: `
      -- The interface a tool most recently produced, so it can be reopened as a
      -- window without spending a turn regenerating it.
      ALTER TABLE saved_tools ADD COLUMN last_spec_id TEXT;
    `
  },
  {
    version: 4,
    name: 'interactive-tools',
    up: `
      -- Tools become small applications rather than one-shot views: they own a
      -- state document the user edits directly and the agent edits alongside
      -- them, plus their own conversation so the agent lives inside the tool.
      ALTER TABLE saved_tools ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt';
      ALTER TABLE saved_tools ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
      ALTER TABLE saved_tools ADD COLUMN session_id TEXT;
      ALTER TABLE saved_tools ADD COLUMN state TEXT NOT NULL DEFAULT '{}';
      -- Optimistic concurrency: the user and the agent both write, so a stale
      -- write has to be rejected rather than silently clobbering the other side.
      ALTER TABLE saved_tools ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 5,
    name: 'tool-actions',
    up: `
      -- Buttons that run the agent, and inputs to run them against. A tool being
      -- agentic means clicking something and the AI doing that one job — not
      -- having a chatbox bolted to the side.
      ALTER TABLE saved_tools ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE saved_tools ADD COLUMN fields TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    version: 6,
    name: 'tool-shortcuts-and-windows',
    up: `
      -- A tool can claim a global shortcut, and choose to live in its own window
      -- pinned above other work. Both are per-tool because "always on top" is
      -- right for a translator you reach for mid-sentence and wrong for a board.
      ALTER TABLE saved_tools ADD COLUMN hotkey TEXT;
      ALTER TABLE saved_tools ADD COLUMN open_in_window INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE saved_tools ADD COLUMN always_on_top INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 7,
    name: 'canvas-tools',
    up: `
      -- A layout tree, so a tool is not limited to the handful of fixed templates.
      -- Nodes bind to paths in the tool's own state document.
      ALTER TABLE saved_tools ADD COLUMN layout TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    version: 8,
    name: 'code-tools',
    up: `
      -- The interface as the agent wrote it: HTML, CSS and JavaScript run in a
      -- sandboxed frame. A layout tree can only ever produce variations of one
      -- house style; this is what lets two tools look nothing alike.
      ALTER TABLE saved_tools ADD COLUMN source TEXT NOT NULL DEFAULT '';
    `
  },
  {
    version: 9,
    name: 'tool-model-prefs',
    up: `
      -- Per-tool model and thinking budget. A translator wants a fast model on low
      -- effort; a weekly review wants the opposite. NULL means "use the app's".
      ALTER TABLE saved_tools ADD COLUMN model TEXT;
      ALTER TABLE saved_tools ADD COLUMN effort TEXT;
    `
  },
  {
    version: 10,
    name: 'tool-window-size',
    up: `
      -- Each tool remembers how big its window was left. A translator wants a small
      -- window and a board wants a wide one, and resizing it every single time is
      -- the kind of friction that makes a tool not worth opening.
      -- The stored size is the *normal* one: a maximised window records the size it
      -- would return to, plus the flag, so restoring does not open a near-fullscreen
      -- window that is not actually maximised.
      ALTER TABLE saved_tools ADD COLUMN window_width INTEGER;
      ALTER TABLE saved_tools ADD COLUMN window_height INTEGER;
      ALTER TABLE saved_tools ADD COLUMN window_maximized INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 11,
    name: 'note-expiry',
    up: `
      -- When a note stops being worth keeping. NULL means permanent, which is the
      -- default: nothing disappears unless it was written down as temporary.
      -- Mirrors the "expires" key in the note's own frontmatter, so the vault stays
      -- the source of truth and this survives being rebuilt from it.
      ALTER TABLE nodes ADD COLUMN expires_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_nodes_expires ON nodes(expires_at)
        WHERE expires_at IS NOT NULL;
    `
  },
  {
    version: 12,
    name: 'scheduled-tasks',
    up: `
      -- Work the app does on its own clock: the hourly check-in it runs for itself,
      -- and anything the user asked for in passing ("every hour, scan Slack").
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        -- What the agent is actually asked. Empty for 'heartbeat', which builds its
        -- prompt from whatever the pre-check found rather than from a fixed string.
        prompt        TEXT NOT NULL DEFAULT '',
        -- 'task' is an ordinary scheduled job; 'heartbeat' is the built-in check-in,
        -- which is gated behind a deterministic pre-check so an idle hour is free.
        kind          TEXT NOT NULL DEFAULT 'task',
        schedule      TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        capability    TEXT NOT NULL DEFAULT 'curate',
        model         TEXT,
        effort        TEXT,
        -- Each task keeps its own chat, so a run never lands in the middle of the
        -- conversation the user is having and its history reads as one thread.
        session_id    TEXT,
        created_by    TEXT NOT NULL DEFAULT 'user',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        next_run_at   INTEGER,
        last_run_at   INTEGER,
        -- 'ok' | 'error' | 'skipped'. 'skipped' is the common one and is not a
        -- failure: it means the pre-check found nothing worth spending a turn on.
        last_status   TEXT,
        last_summary  TEXT,
        run_count     INTEGER NOT NULL DEFAULT 0
      );

      -- The scheduler's only hot query: what is due?
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON scheduled_tasks(next_run_at)
        WHERE enabled = 1;
    `
  },
  {
    version: 13,
    name: 'task-runs',
    up: `
      -- One row per time a scheduled task actually ran.
      --
      -- Runs each get their own chat now. Reusing one chat per task meant that chat
      -- held one Claude session id, and every run resumed it — so run N replayed runs
      -- 1..N-1 and the context grew without limit, which on a subscription is real
      -- money for work nobody asked to see twice. A fresh chat per run has no session
      -- id to resume, so the process starts clean.
      --
      -- Deliberately nothing is backfilled. A backfill would have to insert a
      -- session_id, migrations run inside a transaction and rethrow, and a row
      -- pointing at a chat the user has since deleted would take the whole database
      -- down on launch. Existing tasks simply start their history here; the chat they
      -- shared is still reachable from scheduled_tasks.session_id.
      CREATE TABLE IF NOT EXISTS task_runs (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        -- The run's own chat. No foreign key on purpose: a chat can be deleted from
        -- the history list independently, and that should leave the run's outcome
        -- readable rather than deleting the record of it.
        session_id   TEXT,
        -- 'running' | 'ok' | 'error'. Never 'skipped' — a skip is not a run, and
        -- writing one here would make a task that has never had anything to do look
        -- as busy as one working every hour.
        status       TEXT NOT NULL,
        summary      TEXT NOT NULL DEFAULT '',
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_task_runs_task
        ON task_runs(task_id, started_at DESC);
    `
  },
  {
    version: 14,
    name: 'inbox',
    up: `
      -- Everything the app decided was worth telling the user about while they were
      -- away, whether or not the operating system managed to deliver it.
      --
      -- This exists because a desktop notification is not a reliable channel. On Windows
      -- a toast is activated through a COM class registered against the app's identity,
      -- and if no Start Menu shortcut carrying that identity points at the running
      -- executable — which is the normal state for a dev run, and unfixable for a
      -- portable build whose exe lives in a temp directory that is deleted on exit —
      -- the click dies in the shell and the app never hears about it. So the click is an
      -- accelerator, and this list is the door that always works.
      CREATE TABLE IF NOT EXISTS inbox (
        id          TEXT PRIMARY KEY,
        -- The chat to open. No foreign key: a run's chat can be retired while the record
        -- of what it said is still worth keeping.
        session_id  TEXT,
        task_id     TEXT,
        -- 'reply' | 'task' | 'question'
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        read_at     INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_inbox_unread ON inbox(read_at, created_at DESC);
    `
  },
  {
    version: 15,
    name: 'node-depth',
    up: `
      -- The graph settles in three dimensions now, so a node's layout is x, y and z.
      --
      -- Nullable with no backfill, exactly like x and y: a null means "no saved position",
      -- and the worker seeds one deterministically from the node's id. Writing a zero for
      -- every existing node would instead assert that the whole vault is on the mid-plane,
      -- which is a flat graph the simulation then has to be pushed out of.
      ALTER TABLE nodes ADD COLUMN z REAL;
    `
  },
  {
    version: 16,
    name: 'tool-sessions',
    up: `
      -- Which tool a chat is the plumbing for, permanently.
      --
      -- \`saved_tools.session_id\` holds a tool's *latest* run, and each run gets a fresh chat,
      -- so looking a session up there stops working the moment the next run starts: a
      -- notification about run 3 clicked after run 4 began found nothing and opened the
      -- archived chat instead of the tool. This is the durable direction of that relation,
      -- and it is also what keeps these chats out of the conversation list — a generated
      -- prompt and its reply are not a conversation the user had.
      --
      -- Deliberately not a foreign key: deleting a tool must not take its history with it,
      -- and a session whose tool is gone is still not a conversation.
      ALTER TABLE sessions ADD COLUMN tool_id TEXT;
      CREATE INDEX idx_sessions_tool ON sessions(tool_id);

      -- Backfill what can be known. \`saved_tools.session_id\` names each tool's most recent
      -- run, which is the one a live toast could still be about; runs before it were never
      -- recorded anywhere else and stay unmarked. They are archived, so they are absent from
      -- the conversation list either way — this is about the notification path.
      UPDATE sessions
         SET tool_id = (SELECT t.id FROM saved_tools t WHERE t.session_id = sessions.id)
       WHERE id IN (SELECT session_id FROM saved_tools WHERE session_id IS NOT NULL);
    `
  },
  {
    version: 17,
    name: 'integration-audit',
    up: `
      -- Every call an integration made, and which credential it used.
      --
      -- Its own table rather than a row in \`activity\`: activity is the user-visible feed of
      -- what happened to their notes, and a line per HTTP request would drown it. This is a
      -- trail you go looking for — "what did that token get used for" — and the answer has to
      -- exist even when nobody was watching.
      --
      -- \`secret_refs\` is a JSON array of vault *refs*. There is deliberately no column a
      -- value could be written into: the schema is the last place this rule can be enforced,
      -- and a nullable \`secret_value\` would eventually be filled in by someone debugging.
      CREATE TABLE integration_audit (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        ts             INTEGER NOT NULL,
        integration_id TEXT NOT NULL,
        operation      TEXT NOT NULL,
        secret_refs    TEXT NOT NULL DEFAULT '[]',
        ok             INTEGER NOT NULL,
        http_status    INTEGER,
        duration_ms    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_integration_audit_ts ON integration_audit(integration_id, ts DESC);
    `
  }
]

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  let current = db.pluck<number>('SELECT MAX(version) FROM schema_version') ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    log.info(`applying migration ${migration.version} (${migration.name})`)
    db.transaction(() => {
      db.exec(migration.up)
      db.run('INSERT INTO schema_version (version) VALUES (?)', [migration.version])
    })
    current = migration.version
  }

  log.info(`schema at version ${current}`)
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

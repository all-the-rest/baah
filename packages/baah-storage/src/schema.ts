/**
 * The schema of `Plan.md` §6.1, as ordered, idempotent DDL.
 *
 * Everything is a plain SQL string so it can be asserted on in Node without a
 * SQLite engine (see `test/schema.test.ts`). The real engine applies it through
 * `applyMigrations()` in `migrations.ts`.
 *
 * Conventions:
 * - Every table is `STRICT` (except the FTS5 shadow table, which SQLite builds).
 * - Every statement is `IF NOT EXISTS`, so applying a step twice is a no-op.
 * - JSON columns hold JSON *text*. There is no `JSON` type in SQLite; the
 *   shape is owned by the layer above, and the storage layer never parses it.
 * - `seq` is the per-parent sort key, `created_at` is display only (§6.2).
 */

/**
 * Pragmas applied once per connection, in this order.
 *
 * `journal_mode=DELETE` because WAL buys nothing in a Web VFS (§6.1) and
 * `sahpool` has no shared-memory file to back a WAL index.
 */
export const PRAGMAS: readonly string[] = [
  "PRAGMA foreign_keys=ON",
  "PRAGMA journal_mode=DELETE",
  "PRAGMA synchronous=NORMAL",
  "PRAGMA busy_timeout=5000",
];

/** Bookkeeping table. Created by `applyMigrations()` before anything else. */
export const SCHEMA_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at TEXT    NOT NULL
) STRICT;`;

/**
 * Sessions, turns, messages, parts and the append-only delta log.
 *
 * `messages.outcome` is the one column not spelled out in §6.1: §6.2 requires
 * the turn outcome to live on the `idle` message, and there is no other home
 * for it that stays queryable.
 */
export const STEP_CORE_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT    PRIMARY KEY,
  title         TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'archived')),
  model         TEXT,
  system_prompt TEXT,
  metadata      TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  archived_at   TEXT,
  -- An archived session must carry the timestamp that says so.
  CHECK (status <> 'archived' OR archived_at IS NOT NULL)
) STRICT;`,

  `CREATE TABLE IF NOT EXISTS turns (
  id           TEXT    PRIMARY KEY,
  session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  status       TEXT    NOT NULL
                        CHECK (status IN ('pending', 'streaming', 'succeeded', 'failed', 'interrupted')),
  lease_owner  TEXT,
  heartbeat_at TEXT,
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  error        TEXT,
  UNIQUE (session_id, seq)
) STRICT;`,

  `CREATE TABLE IF NOT EXISTS messages (
  id         TEXT    PRIMARY KEY,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id    TEXT    REFERENCES turns(id) ON DELETE CASCADE,
  parent_id  TEXT    REFERENCES messages(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT    NOT NULL
                      CHECK (role IN (
                        'user', 'assistant', 'synthetic', 'system', 'skill', 'shell',
                        'compaction', 'idle', 'agent-switched', 'model-switched',
                        'location-switched'
                      )),
  status     TEXT    CHECK (status IS NULL OR status IN (
                      'pending', 'running', 'streaming', 'completed', 'failed', 'aborted')),
  model      TEXT,
  -- The turn outcome rides on the idle message (§6.2), not on a separate construct.
  outcome    TEXT    CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'interrupted')),
  error      TEXT,
  usage      TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  UNIQUE (session_id, seq)
) STRICT;`,

  // Three part types only (§14.3). File diffs live in the tool part's
  // data.metadata.files, not in a fourth type.
  `CREATE TABLE IF NOT EXISTS parts (
  id           TEXT    PRIMARY KEY,
  message_id   TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  type         TEXT    NOT NULL CHECK (type IN ('text', 'reasoning', 'tool')),
  data         TEXT,
  -- Denormalised, searchable projection of the part text.
  content_text TEXT    NOT NULL DEFAULT '',
  status       TEXT    CHECK (status IS NULL OR status IN (
                         'pending', 'running', 'streaming', 'completed', 'failed', 'aborted')),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  UNIQUE (message_id, seq)
) STRICT;`,

  // Append-only log behind flushDelta (§6.2). The client-supplied id is the
  // idempotency key: a retried flush inserts the same id and is dropped.
  `CREATE TABLE IF NOT EXISTS part_deltas (
  id           TEXT    PRIMARY KEY,
  part_id      TEXT    NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  content_text TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  UNIQUE (part_id, seq)
) STRICT;`,

  `CREATE TABLE IF NOT EXISTS tool_invocations (
  id             TEXT    PRIMARY KEY,
  session_id     TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id     TEXT    REFERENCES messages(id) ON DELETE CASCADE,
  call_part_id   TEXT    REFERENCES parts(id) ON DELETE CASCADE,
  result_part_id TEXT    REFERENCES parts(id) ON DELETE CASCADE,
  tool_name      TEXT    NOT NULL,
  args           TEXT,
  status         TEXT    NOT NULL CHECK (status IN (
                         'pending', 'awaiting_approval', 'running', 'completed', 'failed', 'aborted')),
  result_preview TEXT,
  error          TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT;`,

  // decision IS NULL means "still open"; `always` stores the tool's proposed
  // pattern in `scope` (§7.5).
  `CREATE TABLE IF NOT EXISTS approvals (
  id                 TEXT    PRIMARY KEY,
  session_id         TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_invocation_id TEXT    REFERENCES tool_invocations(id) ON DELETE CASCADE,
  request            TEXT    NOT NULL,
  decision           TEXT    CHECK (decision IS NULL OR decision IN ('once', 'always', 'reject')),
  scope              TEXT,
  decided_at         TEXT,
  expires_at         TEXT,
  created_at         TEXT    NOT NULL
) STRICT;`,

  `CREATE TABLE IF NOT EXISTS todos (
  id         TEXT    PRIMARY KEY,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  content    TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority   INTEGER,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  UNIQUE (session_id, seq)
) STRICT;`,

  `CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('opfs', 'directory')),
  -- Reference into the sidecar IndexedDB. A FileSystemHandle cannot be stored
  -- in SQLite: WASM has no access to structured-clone objects (§6.2).
  root_handle_id TEXT,
  metadata       TEXT,
  created_at     TEXT    NOT NULL,
  last_opened_at TEXT
) STRICT;`,

  `CREATE TABLE IF NOT EXISTS file_handles (
  id              TEXT    PRIMARY KEY,
  workspace_id    TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK (kind IN ('file', 'directory')),
  name            TEXT    NOT NULL,
  relative_path   TEXT    NOT NULL,
  handle_id       TEXT,
  permission      TEXT    NOT NULL DEFAULT 'unknown'
                          CHECK (permission IN ('unknown', 'prompt', 'granted', 'denied')),
  last_checked_at TEXT,
  UNIQUE (workspace_id, relative_path)
) STRICT;`,

  `CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;`,
];

/**
 * FTS5 index over `parts.content_text`, maintained by triggers so no write path
 * can forget to update it.
 *
 * External content (`content='parts'`) keeps the text in exactly one place;
 * the `rowid` of `parts` is the FTS rowid. `parts_fts` is not `STRICT` — FTS5
 * virtual tables have their own column types and are exempt.
 */
export const STEP_FULL_TEXT_INDEX: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5 (
  content_text,
  content = 'parts',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);`,

  `CREATE TRIGGER IF NOT EXISTS parts_fts_after_insert AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts (rowid, content_text) VALUES (new.rowid, new.content_text);
END;`,

  `CREATE TRIGGER IF NOT EXISTS parts_fts_after_delete AFTER DELETE ON parts BEGIN
  INSERT INTO parts_fts (parts_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
END;`,

  // Split on every update: a single UPDATE can both delete and insert rows.
  `CREATE TRIGGER IF NOT EXISTS parts_fts_after_update AFTER UPDATE ON parts BEGIN
  INSERT INTO parts_fts (parts_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
  INSERT INTO parts_fts (rowid, content_text) VALUES (new.rowid, new.content_text);
END;`,
];

/**
 * The indexes the query patterns of §6.1/§6.2 need.
 *
 * Deliberately short: every `UNIQUE (parent, seq)` constraint already produces
 * the index that the hot paths (render a message, list a session) use, so a
 * second index on the same columns would only cost write throughput.
 */
export const STEP_INDEXES: readonly string[] = [
  // Session list: newest first, never two scans of the whole table.
  `CREATE INDEX IF NOT EXISTS idx_sessions_status_updated_at ON sessions (status, updated_at DESC);`,

  // The reload check: which turns are stuck in 'streaming' with a stale heartbeat.
  `CREATE INDEX IF NOT EXISTS idx_turns_status_heartbeat ON turns (status, heartbeat_at);`,

  `CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages (turn_id);`,
  `CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages (parent_id);`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages (session_id, created_at);`,

  // Session-scoped part scans (search result rendering, exports).
  `CREATE INDEX IF NOT EXISTS idx_parts_session_seq ON parts (session_id, seq);`,

  `CREATE INDEX IF NOT EXISTS idx_tool_invocations_session_status
     ON tool_invocations (session_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_tool_invocations_message_id ON tool_invocations (message_id);`,

  `CREATE INDEX IF NOT EXISTS idx_approvals_session_decision ON approvals (session_id, decision);`,
  // Partial index: the open-approvals banner is the only hot read here.
  `CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals (session_id, expires_at)
     WHERE decision IS NULL;`,

  `CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened_at ON workspaces (last_opened_at DESC);`,
];

/** Every DDL statement of the schema, in dependency order. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  ...STEP_CORE_TABLES,
  ...STEP_FULL_TEXT_INDEX,
  ...STEP_INDEXES,
];

/** Table names of §6.1 plus the delta log. Used by the schema test. */
export const TABLE_NAMES: readonly string[] = [
  "sessions",
  "turns",
  "messages",
  "parts",
  "part_deltas",
  "tool_invocations",
  "approvals",
  "todos",
  "workspaces",
  "file_handles",
  "settings",
  "schema_migrations",
];

/** Index names created by {@link STEP_INDEXES}. */
export const INDEX_NAMES: readonly string[] = [
  "idx_sessions_status_updated_at",
  "idx_turns_status_heartbeat",
  "idx_messages_turn_id",
  "idx_messages_parent_id",
  "idx_messages_session_created",
  "idx_parts_session_seq",
  "idx_tool_invocations_session_status",
  "idx_tool_invocations_message_id",
  "idx_approvals_session_decision",
  "idx_approvals_pending",
  "idx_workspaces_last_opened_at",
];

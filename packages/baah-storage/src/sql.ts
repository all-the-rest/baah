/**
 * The SQL of the typed helpers.
 *
 * Kept as plain strings next to the schema so the two can be reviewed together
 * — and so a reviewer can see at a glance that the `seq` of an appended row is
 * derived inside the write transaction, never from `created_at` (§6.2).
 *
 * Every statement is single-row-returning (`RETURNING` / `SELECT`) so the
 * client never has to re-read what it just wrote.
 */

import type { MessageInput, PartInput, SessionInput, SqlParam } from "./types.ts";

/** Column list, aliased to the camelCase field names of `Session`. */
export const SESSION_COLUMNS = `
  id, title, status, model,
  system_prompt AS systemPrompt,
  metadata,
  created_at   AS createdAt,
  updated_at   AS updatedAt,
  archived_at  AS archivedAt
`;

export const MESSAGE_COLUMNS = `
  id, session_id AS sessionId, turn_id AS turnId, parent_id AS parentId,
  seq, role, status, model, outcome, error, usage,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export const PART_COLUMNS = `
  id, message_id AS messageId, session_id AS sessionId, seq, type, data,
  content_text AS contentText,
  status,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

/**
 * `archived_at` is bound, not hardcoded: §6.1's CHECK says an archived session
 * must carry the timestamp, so the write path has to be able to supply it.
 */
export const INSERT_SESSION = `
  INSERT INTO sessions
    (id, title, status, model, system_prompt, metadata, created_at, updated_at, archived_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING ${SESSION_COLUMNS}`;

export const SELECT_SESSION = `
  SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`;

export const SELECT_SESSIONS = `
  SELECT ${SESSION_COLUMNS} FROM sessions
  ORDER BY updated_at DESC, created_at DESC`;

export const DELETE_SESSION = `DELETE FROM sessions WHERE id = ?`;

/**
 * `seq` is `MAX(seq) + 1` over the session, evaluated inside the same
 * statement, so two messages created in the same millisecond still get distinct
 * sequence numbers. An explicit `seq` overrides it.
 */
export const INSERT_MESSAGE = `
  INSERT INTO messages
    (id, session_id, turn_id, parent_id, seq, role, status, model, outcome, error, usage,
     created_at, updated_at)
  VALUES (
    ?, ?, ?, ?,
    COALESCE(?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE session_id = ?)),
    ?, ?, ?, ?, ?, ?, ?, ?
  )
  RETURNING ${MESSAGE_COLUMNS}`;

export const SELECT_MESSAGE = `
  SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`;

export const SELECT_MESSAGES = `
  SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? ORDER BY seq ASC`;

export const INSERT_PART = `
  INSERT INTO parts
    (id, message_id, session_id, seq, type, data, content_text, status, created_at, updated_at)
  VALUES (
    ?, ?, ?,
    COALESCE(?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM parts WHERE message_id = ?)),
    ?, ?, ?, ?, ?, ?
  )
  RETURNING ${PART_COLUMNS}`;

/**
 * Upsert by `id`. A retry of a streaming part therefore keeps the original
 * `seq` and cannot collide with the `UNIQUE (message_id, seq)` constraint.
 */
export const UPSERT_PART = `
  INSERT INTO parts
    (id, message_id, session_id, seq, type, data, content_text, status, created_at, updated_at)
  VALUES (
    ?, ?, ?,
    COALESCE(?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM parts WHERE message_id = ?)),
    ?, ?, ?, ?, ?, ?
  )
  ON CONFLICT (id) DO UPDATE SET
    content_text = excluded.content_text,
    data         = excluded.data,
    status       = excluded.status,
    updated_at   = excluded.updated_at
  RETURNING ${PART_COLUMNS}`;

export const SELECT_PARTS = `
  SELECT ${PART_COLUMNS} FROM parts WHERE message_id = ? ORDER BY seq ASC`;

/**
 * FTS5 over `parts.content_text`.
 *
 * `bm25()` is negative and lower is better, so ascending order is best-match
 * first. The session filter is appended as a separate variant instead of
 * `? IS NULL` so the plan can use the index either way.
 */
const SEARCH_SELECT = `
  SELECT
    p.id            AS partId,
    p.message_id    AS messageId,
    p.session_id    AS sessionId,
    p.seq           AS seq,
    p.type          AS type,
    p.created_at    AS createdAt,
    bm25(parts_fts) AS score,
    snippet(parts_fts, 0, '', '', '…', 12) AS excerpt
  FROM parts_fts
  JOIN parts p ON p.rowid = parts_fts.rowid
  WHERE parts_fts MATCH ?`;

/**
 * Two variants instead of a `? IS NULL` filter, so the query plan is the same
 * either way. `bm25()` is negative and lower is better, so ascending order is
 * best-match first.
 */
export function searchSql(bySession: boolean): string {
  return bySession
    ? `${SEARCH_SELECT} AND p.session_id = ? ORDER BY score LIMIT ?`
    : `${SEARCH_SELECT} ORDER BY score LIMIT ?`;
}

export const SEARCH_SQL_BY_SESSION = searchSql(true);
export const SEARCH_SQL_ALL_SESSIONS = searchSql(false);

/**
 * Positional parameters for {@link INSERT_SESSION}.
 *
 * `archived_at` is *derived*, never taken at face value: `Plan.md` §6.1's CHECK
 * makes the pair `status = 'archived'` ⇔ `archived_at IS NOT NULL`, and a
 * half-archived row is the exact corruption the CHECK exists to prevent. So a
 * non-archived session always writes NULL, and an archived one writes the
 * caller's timestamp or the insert timestamp.
 */
export function sessionParams(input: SessionInput, now: string): SqlParam[] {
  const status = input.status ?? "active";
  return [
    input.id,
    input.title ?? "",
    status,
    input.model ?? null,
    input.systemPrompt ?? null,
    input.metadata ?? null,
    input.createdAt ?? now,
    input.updatedAt ?? now,
    status === "archived" ? (input.archivedAt ?? now) : null,
  ];
}

/** Positional parameters for {@link INSERT_MESSAGE}. */
export function messageParams(input: MessageInput): SqlParam[] {
  return [
    input.id,
    input.sessionId,
    input.turnId ?? null,
    input.parentId ?? null,
    input.seq ?? null,
    input.sessionId,
    input.role,
    input.status ?? null,
    input.model ?? null,
    input.outcome ?? null,
    input.error ?? null,
    input.usage ?? null,
    input.createdAt,
    input.updatedAt,
  ];
}

/** Positional parameters for {@link INSERT_PART} and {@link UPSERT_PART}. */
export function partParams(input: PartInput): SqlParam[] {
  return [
    input.id,
    input.messageId,
    input.sessionId,
    input.seq ?? null,
    input.messageId,
    input.type,
    input.data ?? null,
    input.contentText,
    input.status ?? null,
    input.createdAt ?? input.updatedAt,
    input.updatedAt,
  ];
}

/**
 * The two statements of one `flushDelta`, in order: the part projection first
 * (the delta has a foreign key onto it), then the append-only log entry whose
 * `id` decides whether this flush is a retry.
 */
export const FLUSH_DELTA_PART_SQL = UPSERT_PART;

export const FLUSH_DELTA_LOG_SQL = `
  INSERT INTO part_deltas (id, part_id, session_id, seq, content_text, created_at)
  VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM part_deltas WHERE part_id = ?), ?, ?)
  ON CONFLICT (id) DO NOTHING`;

/**
 * Reads back the log position of a delta. `ON CONFLICT DO NOTHING` reports no
 * rows, so the retry case has to look the `seq` up to report it honestly.
 */
export const SELECT_DELTA_SEQ = `
  SELECT seq FROM part_deltas WHERE id = ? ORDER BY seq DESC LIMIT 1`;

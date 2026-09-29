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

import type {
  FinishTurnInput,
  MessageInput,
  PartInput,
  SessionInput,
  SqlParam,
  ToolCallKey,
  TurnInput,
} from "./types.ts";

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

export const TURN_COLUMNS = `
  id, session_id AS sessionId, seq, status, lease_owner AS leaseOwner,
  heartbeat_at AS heartbeatAt,
  started_at AS startedAt,
  finished_at AS finishedAt,
  error
`;

export const TOOL_INVOCATION_COLUMNS = `
  id, session_id AS sessionId, message_id AS messageId,
  call_part_id AS callPartId, result_part_id AS resultPartId,
  tool_name AS toolName, tool_call_id AS toolCallId, attempt, occurrence,
  args, status, output, result_preview AS resultPreview, error,
  started_at AS startedAt,
  finished_at AS finishedAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

/** The `UNIQUE` key of `tool_invocations`, in column order. */
export const TOOL_CALL_KEY_PREDICATE = `session_id = ? AND attempt = ? AND tool_call_id = ? AND occurrence = ?`;

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

/* ------------------------------------------------------------------ */
/* Turns and tool invocations                                          */
/* ------------------------------------------------------------------ */

/**
 * `seq` is `MAX(seq) + 1` over the session, same rule as messages: two turns
 * created in the same millisecond must still have a defined order, and
 * `started_at` is display only (§6.2).
 */
export const INSERT_TURN = `
  INSERT INTO turns
    (id, session_id, seq, status, lease_owner, heartbeat_at, started_at, finished_at, error)
  VALUES (
    ?, ?,
    COALESCE(?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM turns WHERE session_id = ?)),
    ?, ?, ?, ?, ?, ?
  )
  RETURNING ${TURN_COLUMNS}`;

/**
 * The reload anchor: everything that is not finished.
 *
 * `status NOT IN ('succeeded', 'failed')` is the definition the engine uses —
 * a turn is unfinished while it is *neither*, so `interrupted` is included
 * alongside `pending` and `streaming`. Writing it as a positive list of the two
 * finished states means a status added to the CHECK later is unfinished by
 * default, which is the direction that can be recovered from.
 *
 * `COALESCE(heartbeat_at, started_at)`: a turn that was created and never
 * started has no heartbeat, and reporting it as "infinitely stale" would close
 * a turn that may have been created a moment ago. Its own start is the honest
 * answer, and the engine's 30 s threshold then applies to that.
 */
export const SELECT_UNFINISHED_TURNS = `
  SELECT
    id            AS turnId,
    COALESCE(heartbeat_at, started_at) AS heartbeatAt,
    started_at    AS startedAt
  FROM turns
  WHERE session_id = ? AND status NOT IN ('succeeded', 'failed')
  ORDER BY seq ASC`;

/**
 * Renew the reload anchor: `heartbeat_at` and nothing else.
 *
 * One column, one statement. It renews *no* status and touches no other row,
 * because every column it did not have to write would be a second way for a
 * heartbeat to change the truth: a `status` write here would let a heartbeat
 * close (or reopen) a turn, and the engine's 30 s threshold is the only thing
 * that is allowed to decide that (`Plan.md` §6.1).
 *
 * `AND session_id = ?` is **chosen**, not forced, and that is a correction:
 * this statement used to carry no session guard, with a comment saying the
 * omission was unavoidable because `TurnStore` declared
 * `heartbeat({ turnId, at })` with no session. `TurnStore` now carries one, and
 * the engine has it in hand at the call site (`AgentLoopOptions.sessionId`, the
 * same closure that passes it to `flushDelta` and `finishTurn`). So the guard is
 * here, every write on the seam is session-scoped, and the old justification
 * that would have talked the next reader into removing it is gone with it.
 *
 * A turn id that does not exist — or is not in that session — changes 0 rows
 * and raises nothing: the recoverable direction, and the reason the engine may
 * fire this without awaiting it (`loop.ts` calls it as `void store.heartbeat(…)`,
 * so a rejection here would be an unhandled promise rejection).
 */
export const UPDATE_TURN_HEARTBEAT = `
  UPDATE turns SET heartbeat_at = ? WHERE id = ? AND session_id = ?`;

/**
 * Close one part: `parts.status`, and nothing else.
 *
 * **`id = ? AND session_id = ?`, and no read first.** A part's text is flushed
 * at most every 100 ms and once more at part end, and a flush that arrives
 * after a close writes back the `streaming` status a delta implies — so the
 * close is in a race with the delayed flush by construction. A
 * `listParts` + `upsertPart` would resolve that race by *losing the newer text*:
 * the upsert writes the `content_text` it read before the flush landed. Naming
 * the row in the `WHERE` clause leaves no window at all.
 *
 * `message_id` is deliberately **not** in the guard even though the caller knows
 * it: `id` is the primary key, so it already names one row, and adding the
 * message would be a stricter key that is wrong for a provider that mints the
 * same part id again on a retry — the upsert in `flushDelta` keeps the original
 * `message_id`, so the row the user is looking at is the *old* message's row.
 * See `ClosePartInput`.
 *
 * Zero rows matched is not an error: a part id that does not exist, or one that
 * belongs to another session, is a no-op — the same direction `renewHeartbeat`
 * takes, and the reason the engine may fire a close without treating silence as
 * failure.
 */
export const UPDATE_PART_STATUS = `
  UPDATE parts SET status = ?, updated_at = ?
  WHERE id = ? AND session_id = ?`;

/**
 * Close every **still-open** part of a turn, as `aborted`.
 *
 * `WHERE status = 'streaming'` is the half that makes this safe to run on a
 * turn somebody may still be writing: a part the provider finished before the
 * crash is `completed`, and walking it back to `aborted` would make a sentence
 * that was actually written look like it was cut off. Stated as a positive
 * predicate on the open state, not as "everything that is not `aborted`", so a
 * status added to the CHECK later is not swept up by a negative test.
 *
 * The parts are found through their messages
 * (`message_id IN (SELECT id FROM messages WHERE turn_id = ? AND session_id = ?)`)
 * because after a reload the engine no longer knows which part ids it was
 * writing — the turn is the only name it still has, and the subquery is what
 * turns that name into a set of rows. Scoping by the *message's* session rather
 * than by `parts.session_id` mirrors the statement exactly; both are the same
 * session in every row the schema allows, and the memory backend runs the same
 * two lookups.
 *
 * `updated_at` is bound, not `CURRENT_TIMESTAMP`: the callers are the same
 * adapter clock as everywhere else on this seam, and a wall clock the test
 * cannot pin is a value no assertion can mean anything about.
 */
export const ABORT_TURN_PARTS = `
  UPDATE parts SET status = 'aborted', updated_at = ?
  WHERE status = 'streaming'
    AND message_id IN (SELECT id FROM messages WHERE turn_id = ? AND session_id = ?)`;

/**
 * Close the anchor row: the turn stops being unfinished.
 *
 * Scoped by `session_id` **and** by id, because the caller names both and a
 * finish that ignored the session would close another session's turn. Zero rows
 * matched is reported, not raised — the caller turns it into a typed error.
 */
export const UPDATE_TURN_OUTCOME = `
  UPDATE turns
  SET status = ?, finished_at = ?, error = ?
  WHERE id = ? AND session_id = ?`;

/**
 * The turn outcome, as an `idle` message — `Plan.md` §6.2, and the reason the
 * reload check is "a query on `message.role = 'idle'`" rather than a table of
 * its own.
 *
 * Written as `INSERT … SELECT … FROM turns` instead of `INSERT … VALUES` for one
 * reason: the row's `session_id` and `turn_id` are read **from the turn that is
 * being closed**, and a guard (`t.id = ? AND t.session_id = ?`) decides whether
 * anything is written at all. A caller that names a turn and a session that do
 * not belong together therefore writes *nothing* — no message, no update — and
 * the caller can reject loudly on a zero-row update. The alternative (bind the
 * caller's session id and validate afterwards) would commit an outcome message
 * into a session that never ran the turn, which is exactly the cross-session
 * bleed `messages.session_id` exists to make impossible.
 *
 * `seq` follows §6.2: `MAX(seq) + 1` per session, evaluated in this statement.
 */
export const INSERT_TURN_OUTCOME_MESSAGE = `
  INSERT INTO messages
    (id, session_id, turn_id, parent_id, seq, role, status, model, outcome, error, usage,
     created_at, updated_at)
  SELECT
    ?, t.session_id, t.id, NULL,
    (SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE session_id = t.session_id),
    'idle', NULL, NULL, ?, ?, NULL, ?, ?
  FROM turns t
  WHERE t.id = ? AND t.session_id = ?
  RETURNING ${MESSAGE_COLUMNS}`;

/**
 * Positional parameters for {@link INSERT_TURN_OUTCOME_MESSAGE}.
 *
 * Not `messageParams()`: the two session/turn columns are not bound — they are
 * read from the turn row — and the guard pair comes last, after the message's
 * own columns, in that order.
 */
export function turnOutcomeMessageParams(input: FinishTurnInput, messageId: string): SqlParam[] {
  return [
    messageId,
    input.outcome,
    input.error ?? null,
    input.finishedAt,
    input.finishedAt,
    input.turnId,
    input.sessionId,
  ];
}

/** Positional parameters for {@link UPDATE_TURN_OUTCOME}. */
export function turnOutcomeParams(input: FinishTurnInput): SqlParam[] {
  return [input.outcome, input.finishedAt, input.error ?? null, input.turnId, input.sessionId];
}

/**
 * `beginToolCall`: write "may have run", and change nothing if the key is
 * taken.
 *
 * `ON CONFLICT … DO NOTHING` rather than `DO UPDATE`, and the distinction
 * matters: a `DO UPDATE` that wrote `status` would **downgrade a `done` record
 * to `begun`**, and the next replay would then refuse to short-circuit a call
 * that has already run — re-introducing, through the repair path, exactly the
 * corruption this column exists to prevent. So the only writer of `begun` is
 * the insert.
 *
 * `RETURNING` is absent for the same reason: a conflicting insert reports no
 * row, and the caller reads the truth back with {@link SELECT_TOOL_CALL}.
 */
export const INSERT_TOOL_INVOCATION_BEGUN = `
  INSERT INTO tool_invocations
    (id, session_id, message_id, call_part_id, result_part_id, tool_name,
     tool_call_id, attempt, occurrence, args, status, output, result_preview,
     error, started_at, finished_at, created_at, updated_at)
  VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 'begun', NULL, NULL, NULL, ?, NULL, ?, ?)
  ON CONFLICT (session_id, attempt, tool_call_id, occurrence) DO NOTHING`;

/**
 * `recordToolCall`: the call ran, and this is what it returned.
 *
 * An upsert, not an `UPDATE`, because the `begin` write is the one that can be
 * lost: the engine fires it before the tool and the record after. If the
 * process dies in between there is no row to update, and refusing to write one
 * would discard the only claim the engine *can* back up — the tool really did
 * return this. `args` stays NULL on that path: nobody passed the input, and
 * inventing it would be worse than admitting it.
 *
 * `result_preview` gets a bounded copy for the UI; `output` gets the exact
 * value, because a replay hands `output` back to the model as the tool's
 * answer and a truncated string there is a lie about what the tool returned.
 */
export const UPSERT_TOOL_INVOCATION_DONE = `
  INSERT INTO tool_invocations
    (id, session_id, message_id, call_part_id, result_part_id, tool_name,
     tool_call_id, attempt, occurrence, args, status, output, result_preview,
     error, started_at, finished_at, created_at, updated_at)
  VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, 'done', ?, ?, NULL, ?, ?, ?, ?)
  ON CONFLICT (session_id, attempt, tool_call_id, occurrence) DO UPDATE SET
    tool_name      = excluded.tool_name,
    status         = 'done',
    output         = excluded.output,
    result_preview = excluded.result_preview,
    finished_at    = excluded.finished_at,
    updated_at     = excluded.updated_at
  RETURNING ${TOOL_INVOCATION_COLUMNS}`;

/**
 * The replay lookup, and the only read that decides whether a tool re-runs.
 *
 * It projects `status` and `output` and nothing else: the engine needs to know
 * *which* of the two states the call is in and, for `done`, what it returned.
 * Reading a full row here would tempt a caller to branch on `result_preview` or
 * `finished_at`, and those are display fields that do not decide anything.
 */
export const SELECT_TOOL_CALL = `
  SELECT status, output FROM tool_invocations
  WHERE ${TOOL_CALL_KEY_PREDICATE}
  LIMIT 1`;

/** The key's positional parameters, in the order every statement above wants. */
export function toolCallKeyParams(key: ToolCallKey): SqlParam[] {
  return [key.sessionId, key.attempt, key.toolCallId, key.occurrence];
}

/** Positional parameters for {@link INSERT_TURN}. */
export function turnParams(input: TurnInput): SqlParam[] {
  return [
    input.id,
    input.sessionId,
    input.seq ?? null,
    input.sessionId,
    input.status ?? "pending",
    input.leaseOwner ?? null,
    input.heartbeatAt ?? null,
    input.startedAt,
    input.finishedAt ?? null,
    input.error ?? null,
  ];
}

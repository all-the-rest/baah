/**
 * `TranscriptReader` — the **read** port, and why it is not `TurnStore`.
 *
 * ## The gap this exists to close
 *
 * `Plan.md` §6.1 and `AGENTS.md` §3.1 require the partial text to survive a
 * reload. Measured before this file: the transcript *was* in the database and
 * nothing in the seam could read it. `TurnStore` has no `listParts`, no
 * `getMessages`, no `listMessages` — a grep for all three returns nothing — and
 * `recoverStaleTurns` returns `UnfinishedTurn[]`, which carries `turnId`,
 * `heartbeatAt` and `startedAt` and not one character of what the turn said. So
 * after a reload the app could be told *that* a turn died and had no way to be
 * told what it managed to write. The recovery is a list of anchors; nothing in it
 * was a sentence.
 *
 * ## Why a second port and not a second method
 *
 * `TurnStore` is the **engine's** seam, and the engine never reads a transcript
 * back — it builds `UIMessage[]` as it goes. Its ten methods are all the writes
 * one turn performs, and adding a read to it would be a method no engine caller
 * could call, i.e. a dead abstraction (`AGENTS.md` §5) that the composition root
 * would then have to satisfy on a fake the engine tests also implement. So the
 * seam stays one, and the read is a **second, separate port** the composition
 * root injects next to it: two dependencies, each with one job, and
 * `AGENTS.md` §4's layer rule untouched.
 *
 * ## Why it lives in this package and not in `baah-core`
 *
 * `TurnStore` is declared in core because **core consumes it**. Nothing consumes
 * `TranscriptReader`; the app does. Declaring it in core would put a type there
 * that core has no use for, and `baah-web → baah-storage → baah-core` already
 * lets the app import it from here — one hop, and the interface sits next to the
 * only implementation, which is the side that owns the schema.
 *
 * ## The shape, and the three questions it had to answer
 *
 * **1. Keyed by session, or by turn?** Both, and the session is the required half
 * and the turn an optional narrowing inside it. The two callers are real and they
 * ask different questions: a transcript view knows a session, and the reload
 * recovery knows a turn id (`recoverStaleTurns` hands one back). Neither key is
 * sufficient alone — a turn id without a session would make a cross-session read
 * possible and would make "no such turn here" indistinguishable from "that turn
 * said nothing", which the UI renders as two different things.
 *
 * **2. Does the read have to be consistent with a write in flight?** It is
 * consistent with the last flush, and that bound is exact rather than
 * approximate. `flushDelta` writes the part's cumulative text in the **same
 * transaction** as the delta-log append, so `parts` carries the current answer as
 * of the most recent flush; a part is then closed *after* its final flush, so a
 * finished part is exact. What a read can miss is the tail that arrived inside
 * the last `DELTA_FLUSH_INTERVAL_MS` (100 ms) and has not been flushed yet —
 * which is text the engine has not handed to the store at all, so **no** read,
 * delta log included, could have it. The consequence is stated rather than papered
 * over: a live transcript is at most one flush interval behind the in-memory
 * buffer, and a finished one is exact. A streaming part is returned *with* its
 * text and its `status: "streaming"`, so a UI can mark it in flight instead of
 * rendering a sentence that will still grow.
 *
 * The premise that a part's deltas "live in the delta log until the part closes"
 * is **not** what this schema does, and the test measures it: after two flushes of
 * the same part, the newest `part_deltas.content_text` and `parts.content_text`
 * are the same string. The log is an idempotency anchor (`Plan.md` §6.2), not a
 * holding pen — so the read uses the projection, which is one statement cheaper
 * and is the same definition the transcript and the export already use
 * (`operations.listTurnOutcomes` argues exactly this for outcomes).
 *
 * **3. What happens on a closed database?** It rejects, with `database_closed`,
 * and this file adds no `catch` anywhere. A read that returned an empty transcript
 * would let the UI say "nothing was here" about a conversation it had failed to
 * read — the worst of the three outcomes, because it is indistinguishable from
 * the truth. The same argument is why an unknown session and an unknown turn are
 * `sql_error` refusals rather than empty arrays: they are answers to a different
 * question, and an empty array would let the UI answer the wrong one confidently.
 *
 * ## What is deliberately not here
 *
 * No session listing, no search, no mutation. `AGENTS.md` §5 forbids
 * speculative abstractions, and a port with a method nobody calls is a contract
 * nobody has to keep. One method, because one question.
 */

import type {
  Message,
  Part,
  StorageDatabase,
  StreamStatus,
  TranscriptQuery,
  TranscriptRows,
} from "./types.ts";

/**
 * One message of a transcript, as the app needs it.
 *
 * **A projection, not {@link Message}.** Three reasons, in order of how much they
 * matter:
 *
 * 1. `usage`, `model` and `parentId` are not display facts. Handing them over
 *    invites a renderer to branch on a column that describes the *request* rather
 *    than the conversation, and a branch on `model` is a branch that will need
 *    three cases after the second provider lands.
 * 2. `usage` is raw JSON text, and only this package knows its shape. A port that
 *    handed the string out would be pushing the parse — and the validation of it,
 *    which `AGENTS.md` §5 requires at every boundary — into the app. Same rule
 *    `Session.metadata` already follows.
 * 3. It keeps the read a *port*. A port that returns the storage row is an alias
 *    for `StorageDatabase`, and an alias does not fail loudly when the row changes
 *    shape; this one does, at compile time, in the place that has to change.
 *
 * `outcome` is on here and not merely on the `idle` message: `Plan.md` §6.2 makes
 * the turn outcome a message, and the recovery's whole question is which outcome
 * this turn carries. A UI that had to filter `role === "idle"` to learn whether
 * the turn it just recovered said `interrupted` would be re-deriving the engine's
 * definition in a second place.
 */
export interface TranscriptMessage {
  id: string;
  /** `null` for a message that belongs to no turn — the user's prompt does not. */
  turnId: string | null;
  /** The sort key (`Plan.md` §6.2). Never `created_at`. */
  seq: number;
  role: Message["role"];
  status: StreamStatus | null;
  /** `succeeded | failed | interrupted`, on the `idle` outcome message. */
  outcome: Message["outcome"];
  /** The turn's own error text, when the turn said one. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  parts: readonly TranscriptPart[];
}

/** One part of a transcript message. */
export interface TranscriptPart {
  id: string;
  /** The sort key within its message. */
  seq: number;
  type: Part["type"];
  /**
   * The text, as of the most recent flush.
   *
   * For a part that is still `streaming` this is the tail the engine has
   * checkpointed, not the sentence the model is mid-way through — see the header.
   */
  contentText: string;
  /**
   * `streaming` while the part is being written; `completed`/`aborted` once it
   * has ended (`Plan.md` §6.1). **The load-bearing half of a transcript read
   * after a reload**: it is the difference between "the model is still writing
   * this" and "this was cut off", and the recovery is what sets it.
   */
  status: StreamStatus | null;
  /**
   * The type-specific JSON payload — file diffs for a `tool` part (§6.1) — as raw
   * text, or `null`. Not parsed here: only the layer that knows the shape may
   * parse it, and a port that handed a parsed object out would be asserting a
   * schema it does not own.
   */
  data: string | null;
  updatedAt: string;
}

/** What one read returned. */
export interface Transcript {
  sessionId: string;
  /** The turn the read was narrowed to, or `null` for a whole session. */
  turnId: string | null;
  /** Oldest first, by `seq`. A renderer wants the conversation in order. */
  messages: readonly TranscriptMessage[];
  /**
   * The store holds **at least one message more** than was returned.
   *
   * A boolean and not a count, and the reason is the cost: a count is a third
   * statement, and no caller in this repo has a use for the number — what a UI
   * needs is "there is more above this".
   */
  truncated: boolean;
  /** The bound that was applied, after clamping. Which window this is. */
  limit: number;
}

/** What to read. */
export type TranscriptRequest = TranscriptQuery;

/**
 * The read port.
 *
 * One method, because one question. The composition root injects this *beside*
 * the engine's `TurnStore`, and a caller that holds both has a write seam and a
 * read seam rather than one object that is both.
 */
export interface TranscriptReader {
  /**
   * Read a session's transcript back, or one turn's slice of it.
   *
   * **Rejects rather than returning an empty transcript** for every way the read
   * could fail to be an answer: a closed database (`database_closed`), a session
   * that does not exist and a turn that is not in that session (`sql_error`).
   * There is no `catch` in this package's read path, and that is the property.
   */
  read(request: TranscriptRequest): Promise<Transcript>;
}

/**
 * Build the read port over a `StorageDatabase`.
 *
 * A factory and not a singleton, for the same reason `createTurnStore` is one:
 * two ports over two databases have to stay apart, and a module-level one would
 * make the second test's fixture depend on the first's. Neither this function
 * nor the function it returns holds state — the database does.
 *
 * The return type is the interface, so a missing method or a changed signature is
 * a compile error in this file rather than a runtime surprise in a reloaded tab.
 */
export function createTranscriptReader(database: StorageDatabase): TranscriptReader {
  return {
    async read(request: TranscriptRequest): Promise<Transcript> {
      const rows = await database.readTranscript(request);
      return toTranscript(request, rows);
    },
  };
}

/**
 * Rows → the port's shapes.
 *
 * Oldest first, parts attached by **id**. Attaching by id rather than by position
 * is what makes the `limit + 1` window safe: the extra message the read asked for
 * and then dropped takes its parts with it, instead of the caller's last message
 * being handed the next one's parts. A zip would be wrong in exactly the case the
 * truncation exists for.
 */
function toTranscript(request: TranscriptRequest, rows: TranscriptRows): Transcript {
  const partsByMessage = new Map<string, TranscriptPart[]>();
  for (const part of rows.parts) {
    const existing = partsByMessage.get(part.messageId);
    const projected: TranscriptPart = {
      id: part.id,
      seq: part.seq,
      type: part.type,
      contentText: part.contentText,
      status: part.status,
      data: part.data,
      updatedAt: part.updatedAt,
    };
    if (existing === undefined) partsByMessage.set(part.messageId, [projected]);
    else existing.push(projected);
  }

  const messages: TranscriptMessage[] = rows.messages
    .map((message) => toTranscriptMessage(message, partsByMessage.get(message.id) ?? []))
    // `rows.messages` is newest-first (the window is taken at the end of the
    // log); a renderer reads oldest first.
    .reverse();

  return {
    sessionId: request.sessionId,
    turnId: request.turnId ?? null,
    messages,
    truncated: rows.truncated,
    limit: rows.limit,
  };
}

function toTranscriptMessage(message: Message, parts: readonly TranscriptPart[]): TranscriptMessage {
  return {
    id: message.id,
    turnId: message.turnId,
    seq: message.seq,
    role: message.role,
    status: message.status,
    outcome: message.outcome,
    error: message.error,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    parts,
  };
}

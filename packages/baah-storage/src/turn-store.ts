/**
 * `TurnStore`, implemented over `StorageDatabase`.
 *
 * ## Why this file lives in `baah-storage` and not in `baah-web`
 *
 * `Plan.md` §16.1 settles it: the Wave-2 composition root *injects* a
 * `TurnStore`, and if the adapter sat in the web app the engine would have two
 * ways into the database — this one and whatever the UI wrote for its own
 * reasons. Two ways in is how `classifyThrownError` and `classifyResponse` came
 * to disagree inside the engine while both were "correct": the second copy is
 * always one edit behind the first. One seam, one implementation, and the seam
 * lives on the side that owns the schema.
 *
 * ## What the adapter actually has to do
 *
 * Five of the ten methods are already structurally identical
 * (`listUnfinishedTurns`, `listTurnOutcomes`, `getToolCall`, `recordToolCall`,
 * `beginToolCall`) — the `ToolCallKey`/`ToolCallRecord`/`UnfinishedTurn`/
 * `TurnOutcomeEntry` shapes are layout-compatible and `AGENTS.md` §4 forbids
 * core from pointing here, so they cannot share a declaration. Those five are
 * passed through unchanged and **not** re-implemented; a pass-through that grew
 * a body would be a second implementation of a contract the storage layer
 * already owns.
 *
 * The others do not match, and each translation is documented at its method. In
 * short: `flushDelta` needs a whole `PartInput` the engine's signature does not
 * carry, the two close methods need a timestamp the engine does not have,
 * `finishTurn` has to become a transaction that writes the outcome as an `idle`
 * message *and* closes the anchor row, and `heartbeat` has to stop at exactly
 * one column.
 *
 * ## The three gaps this file used to report, and what closed them
 *
 * The contract was lossy in three places. It is not any more, and the shape of
 * each fix is the argument for why it needed the *engine* and not a workaround
 * on this side:
 *
 * 1. `flushDelta` named a part, a message, a session and a text — but no
 *    **type**, so a reasoning delta was filed as `text` and the transcript
 *    showed the model's thinking as something it said. There *was* a
 *    `TurnStoreOptions.partType` here, and it was the right diagnosis with the
 *    wrong priority: an option on the adapter made the gap *visible* and left it
 *    open, and every caller that forgot it got the same wrong transcript. The
 *    engine now names the kind, so there is nothing to forget and the option is
 *    gone.
 * 2. `flushDelta` could not say that a part was **finished** — a delta is
 *    mid-stream by definition, so every part this seam ever wrote was
 *    `streaming`, and a crash could not be told apart from a live stream.
 *    `closePart` and `closeTurnParts` say it, and both are single statements
 *    (below).
 * 3. `heartbeat` carried **no session**, so it was the one write on the seam
 *    that could renew an arbitrary turn's anchor. The engine supplies the
 *    session now, so it is forwarded and the `WHERE` clause uses it.
 *
 * ## Why the two closes are one statement each
 *
 * The engine flushes a part's text **before** closing it, and it keeps flushing
 * on a timer besides. A flush that arrives after a close writes back the
 * `streaming` status a delta implies, so "close, then a late flush" is a race
 * that exists by construction. A read-modify-write would lose it
 * deterministically: `listParts` reads a `content_text`, the delayed flush
 * writes a newer one, and the upsert then writes the *old* text back over it.
 * So `closePart` is `UPDATE_PART_STATUS` and nothing else, and `closeTurnParts`
 * is `ABORT_TURN_PARTS` — whose `status = 'streaming'` predicate is inside the
 * statement, so a part that is already `completed` is not walked backwards. The
 * reasoning is repeated at `sql.ts`, because that is where the statements live.
 */

import type { TurnStore } from "@all-the.rest/baah-core";

import type { PartInput, PartType, StorageDatabase } from "./types.ts";

export interface TurnStoreOptions {
  /**
   * ISO-8601 clock, injectable for deterministic tests.
   *
   * Needed because `TurnStore` hands out no timestamp for `finishTurn`, for the
   * two closes or for `flushDelta` — only `heartbeat` carries one (`at`, the
   * engine's own reading). Everything else this adapter writes is stamped from
   * here, so the storage side is the one place a clock enters; `AGENTS.md` §5
   * fixes the format.
   */
  now?: () => string;
}

/**
 * `TurnStore.flushDelta`'s `partType`, in storage's vocabulary.
 *
 * The engine's `PartKind` is `"text" | "reasoning"`, and `parts.type` also
 * allows `"tool"` — a tool part is written whole at `tool-call` and has no
 * mid-stream text, so it is deliberately not a third value here. `PartType` is
 * the wider type and the narrowing is a check, not a cast: a third `PartKind`
 * in the engine becomes a compile error in this file rather than a part written
 * as something the engine never asked for.
 */
type FlushablePartType = Extract<PartType, "text" | "reasoning">;

/** The `flushDelta` input, spelled out so a drift is a compile error here. */
interface FlushDeltaInput {
  deltaId: string;
  partId: string;
  messageId: string;
  sessionId: string;
  partType: FlushablePartType;
  contentText: string;
}

/** The `closePart` input, spelled out for the same reason. */
interface ClosePartInput {
  sessionId: string;
  messageId: string;
  partId: string;
  status: "completed" | "aborted";
}

/** The `closeTurnParts` input, spelled out for the same reason. */
interface CloseTurnPartsInput {
  sessionId: string;
  turnId: string;
}

/** The `finishTurn` input, spelled out for the same reason. */
interface FinishTurnInput {
  turnId: string;
  sessionId: string;
  outcome: "succeeded" | "failed" | "interrupted";
  error: string | undefined;
}

/** The `heartbeat` input, spelled out for the same reason. */
interface HeartbeatInput {
  turnId: string;
  sessionId: string;
  at: string;
}

/**
 * Build the engine's `TurnStore` over a `StorageDatabase`.
 *
 * The return type is the engine's interface, so every method has to exist with
 * the engine's exact signature — a rename, a dropped argument or a missing
 * method is a compile error in this file, not a runtime surprise. The
 * conformance test assigns the result to a `TurnStore` as well, so that a later
 * `Partial<TurnStore>` here would also fail.
 */
export function createTurnStore(
  database: StorageDatabase,
  options: TurnStoreOptions = {},
): TurnStore {
  const now = options.now ?? ((): string => new Date().toISOString());

  return {
    /**
     * One buffered streaming flush (`Plan.md` §6.2), **idempotent over
     * `deltaId`**.
     *
     * The translation: the engine passes five scalars, the store wants a whole
     * `PartInput` plus a flush timestamp. So `partId` becomes the part's `id`,
     * `partType` becomes `type` — forwarded, never defaulted, because a default
     * would be the same guess with a louder type and would file a reasoning
     * delta as something the model said — and `contentText` becomes both the
     * part's text projection and the delta log entry's. `created_at`,
     * `updated_at` and `status` are filled in here. `seq` is left out on
     * purpose so the store allocates it — §6.2's rule, not a guess made here.
     *
     * `deltaId` is passed through **verbatim**: it is the idempotency key, and a
     * key this layer re-mints would turn every retry into a new delta. The
     * return value (`applied: false` on a replay) is dropped because `TurnStore`
     * declares `Promise<void>` — the *behaviour* it names is what matters, and
     * the conformance test asserts it on the database, not on a return value
     * this interface does not have.
     */
    async flushDelta(input: FlushDeltaInput): Promise<void> {
      const at = now();
      await database.flushDelta({
        deltaId: input.deltaId,
        part: {
          id: input.partId,
          messageId: input.messageId,
          sessionId: input.sessionId,
          type: input.partType,
          contentText: input.contentText,
          // A delta is mid-stream by definition, so `streaming` is the only
          // status a delta may write. The part is closed by the two methods
          // below, which is why this is a description and not a gap.
          status: "streaming",
          createdAt: at,
          updatedAt: at,
        } satisfies PartInput,
        flushedAt: at,
      });
    },

    /**
     * Close one part, as `completed` or `aborted`.
     *
     * The whole translation is the timestamp: the engine knows the part ended
     * and which ending it was, and it has no clock reading for the event. The
     * rest — the row, the guard, the statement — is the storage layer's, and it
     * is **one statement** (`UPDATE_PART_STATUS`).
     *
     * The ordering is the engine's, not this layer's: `loop.ts` flushes the
     * part's text and *awaits* that flush before calling this, precisely because
     * a flush landing after a close would write back the `streaming` status a
     * delta implies. So this method must not read the part to find out what to
     * write — see the file header, and the test that interleaves a flush into
     * the middle of the close.
     *
     * `messageId` is forwarded and not used: `parts.id` is the primary key, so
     * the id already names one row, and the session guard is what keeps the
     * write inside its own log. A `message_id` predicate would be *stricter and
     * wrong* — see `ClosePartInput`.
     */
    async closePart(input: ClosePartInput): Promise<void> {
      await database.closePart({
        sessionId: input.sessionId,
        messageId: input.messageId,
        partId: input.partId,
        status: input.status,
        updatedAt: now(),
      });
    },

    /**
     * Close every still-open part of a turn, as `aborted` — the crash case.
     *
     * The engine can only name the turn: after a reload it does not know the
     * part ids, and that is the whole reason this is a separate method instead
     * of `closePart` with a list. So the *lookup* — this turn's messages, and
     * the parts still `streaming` on them — belongs here, and it is inside the
     * statement (`ABORT_TURN_PARTS`) rather than in a read followed by writes.
     *
     * A part that is already `completed` is left alone, and so keeps the
     * `updated_at` of its own close: a sentence the provider finished before the
     * tab died must not be walked backwards into looking cut off.
     */
    async closeTurnParts(input: CloseTurnPartsInput): Promise<void> {
      await database.closeTurnParts({
        sessionId: input.sessionId,
        turnId: input.turnId,
        updatedAt: now(),
      });
    },

    /**
     * Close the turn.
     *
     * The translation: the outcome becomes an `idle` message with `outcome` set
     * (`Plan.md` §6.2 — the outcome is a message, not a row in a turns table of
     * its own), *and* the anchor row stops reporting the turn as unfinished.
     * Both happen in one transaction inside the storage layer, because a crash
     * between them would leave a transcript that says `succeeded` next to an
     * anchor that still says "open" — and the next start-up would then interrupt
     * a turn that had already said how it ended.
     *
     * `error` is forwarded even when it is `undefined`: with
     * `exactOptionalPropertyTypes` an omitted key is a different type, and the
     * engine deliberately sends the key (`loop.ts`).
     */
    async finishTurn(input: FinishTurnInput): Promise<void> {
      await database.finishTurn({
        turnId: input.turnId,
        sessionId: input.sessionId,
        outcome: input.outcome,
        error: input.error,
        // The engine's contract has no timestamp for the finish. ISO-8601,
        // `AGENTS.md` §5, from the injectable clock.
        finishedAt: now(),
      });
    },

    /**
     * Renew `heartbeat_at`.
     *
     * The translation: `at` is already the engine's own clock reading
     * (`loop.ts` builds it from its injected `now()`), so it is forwarded
     * unchanged — the adapter must not substitute its own, or the 30 s threshold
     * would be measured against a different clock than the one that wrote it.
     * `sessionId` is forwarded for the same reason it is not substituted: it is
     * the second half of the write's key, and the engine has it in hand
     * (`AgentLoopOptions.sessionId`, the same closure that passes it to
     * `flushDelta` and `finishTurn`). The storage layer binds it into the `WHERE`
     * clause — see `UPDATE_TURN_HEARTBEAT`, whose comment records the stale
     * justification that scoping replaced.
     *
     * The engine does **not** await this call — `loop.ts` fires it on every step
     * end and at the start of every attempt, because `onStepEnd` is a synchronous
     * callback of `ToolLoopAgent` and there is no promise for it to return. So a
     * rejection here does **not** escape as an unhandled rejection: the engine
     * attaches a handler and reports a `storage-warning` event, which is where
     * "the anchor is no longer being renewed" becomes visible. An unknown turn
     * id, or one from another session, therefore writes nothing and raises
     * nothing, which is also what SQLite reports for a zero-row `UPDATE` — and it
     * is the *only* outcome that is meant to be silent.
     */
    async heartbeat(input: HeartbeatInput): Promise<void> {
      await database.renewHeartbeat({
        turnId: input.turnId,
        sessionId: input.sessionId,
        at: input.at,
      });
    },

    /**
     * The five below are already structurally identical — the same shapes, the
     * same key, the same union. They are listed so the seam is auditable as a
     * whole, and they are passed through rather than reimplemented: a body here
     * would be a second implementation of the replay key, which is precisely
     * the drift the shared `ToolCallKey` comment is about.
     *
     * `listTurnOutcomes` belongs on this list for the same reason: it is a read
     * of a row shape both sides already have, and a body would be a second
     * definition of "which outcomes does this log carry" next to the one in
     * `operations.ts`.
     */
    listUnfinishedTurns: (input) => database.listUnfinishedTurns(input),
    listTurnOutcomes: (input) => database.listTurnOutcomes(input),
    recordToolCall: (input) => database.recordToolCall(input),
    getToolCall: (key) => database.getToolCall(key),
    beginToolCall: (input) => database.beginToolCall(input),
  };
}

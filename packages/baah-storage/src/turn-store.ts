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
 * Four of the seven methods were already structurally identical
 * (`listUnfinishedTurns`, `getToolCall`, `recordToolCall`, `beginToolCall`) —
 * the `ToolCallKey`/`ToolCallRecord`/`UnfinishedTurn` shapes are layout-
 * compatible and `AGENTS.md` §4 forbids core from pointing here, so they cannot
 * share a declaration. Those four are passed through unchanged and **not**
 * re-implemented; a pass-through that grew a body would be a second
 * implementation of a contract the storage layer already owns.
 *
 * The other three do not match, and each translation is documented at its
 * method. In short: `flushDelta` needs a whole `PartInput` the engine's
 * signature does not carry, `finishTurn` has to become a transaction that writes
 * the outcome as an `idle` message *and* closes the anchor row, and `heartbeat`
 * has to stop at exactly one column.
 *
 * ## What this file does not fix
 *
 * The contract is lossy in three places, and the adapter translates rather than
 * pretends. Each is a defect in the *contract*, reported to the engine's owner:
 *
 * 1. `flushDelta` names a part, a message, a session and a text — but no
 *    **type**. `Plan.md` §6.1 allows `text | reasoning | tool`, and the loop
 *    emits reasoning deltas, so they would be filed as text. `partType` is an
 *    option for exactly this reason: the default is honest for a text delta and
 *    *cannot be* honest for a reasoning one.
 * 2. `flushDelta` cannot say that a part is **finished**. A delta is by
 *    definition mid-stream, so the part lands as `streaming`; closing it is
 *    somebody else's write.
 * 3. `heartbeat({ turnId, at })` carries **no session**, so it cannot be scoped
 *    to one. Turning this seam into the one place that can renew an arbitrary
 *    turn's anchor is a real, if narrow, loss of `session_id`.
 */

import type { TurnStore } from "@all-the.rest/baah-core";

import type { PartInput, PartType, StorageDatabase } from "./types.ts";

export interface TurnStoreOptions {
  /**
   * ISO-8601 clock, injectable for deterministic tests.
   *
   * Needed because `TurnStore` hands out no timestamp for `finishTurn` or
   * `flushDelta` — only `heartbeat` carries one (`at`, the engine's own reading).
   * Everything else this adapter writes is stamped from here, so the storage
   * side is the one place a clock enters; `AGENTS.md` §5 fixes the format.
   */
  now?: () => string;
  /**
   * `parts.type` for a flushed delta. `"text"` because that is what a text
   * delta is; a reasoning delta has to be declared here, because the engine's
   * `flushDelta` signature has nowhere to put it.
   */
  partType?: PartType;
}

/** The `flushDelta` input, spelled out so a drift is a compile error here. */
interface FlushDeltaInput {
  deltaId: string;
  partId: string;
  messageId: string;
  sessionId: string;
  contentText: string;
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
  const partType = options.partType ?? "text";

  return {
    /**
     * One buffered streaming flush (`Plan.md` §6.2), **idempotent over
     * `deltaId`**.
     *
     * The translation: the engine passes four scalars, the store wants a whole
     * `PartInput` plus a flush timestamp. So `partId` becomes the part's `id`,
     * `contentText` becomes both the part's text projection and the delta log
     * entry's, and the missing `created_at`/`updated_at`/`status`/`type` are
     * filled in from {@link TurnStoreOptions}. `seq` is left out on purpose so
     * the store allocates it — §6.2's rule, not a guess made here.
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
          type: partType,
          contentText: input.contentText,
          // A delta is mid-stream by definition; `TurnStore` has no way to
          // close the part, and writing `completed` here would make a crash
          // look like a finished message.
          status: "streaming",
          createdAt: at,
          updatedAt: at,
        } satisfies PartInput,
        flushedAt: at,
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
     *
     * The engine does **not** await this call — `loop.ts` fires it as
     * `void store.heartbeat(…)`, on every step end and at the start of every
     * attempt — so a rejection here would be an unhandled promise rejection
     * rather than a reported failure. An unknown turn id therefore writes
     * nothing and raises nothing, which is also what SQLite reports for a
     * zero-row `UPDATE`.
     */
    async heartbeat(input: HeartbeatInput): Promise<void> {
      await database.renewHeartbeat({ turnId: input.turnId, at: input.at });
    },

    /**
     * The four below are already structurally identical — the same shapes, the
     * same key, the same union. They are listed so the seam is auditable as a
     * whole, and they are passed through rather than reimplemented: a body here
     * would be a second implementation of the replay key, which is precisely
     * the drift the shared `ToolCallKey` comment is about.
     */
    listUnfinishedTurns: (input) => database.listUnfinishedTurns(input),
    recordToolCall: (input) => database.recordToolCall(input),
    getToolCall: (key) => database.getToolCall(key),
    beginToolCall: (input) => database.beginToolCall(input),
  };
}

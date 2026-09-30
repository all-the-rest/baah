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
 * Five of the thirteen methods are already structurally identical
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
 * ## The two creates and the tool part are near-pass-throughs, and that is not
 * ## a shortcut
 *
 * `appendTurn` and `appendMessage` are the two methods whose bodies are three
 * lines of field forwarding each. It is tempting to read that as "nothing to do
 * here", and the opposite is true: those two bodies are the **only** place the
 * engine's declared idempotency-by-`id` meets a statement, so they are the place
 * a `UNIQUE` catch would have been written if it had been written. Each is
 * documented at its method with the failure that was measured on the way to
 * `sql.ts`, and both are pinned in `test/turn-store.test.ts` — replay, order and
 * a duplicate `appendTurn`, on both backends, because "it is only a pass-through"
 * is a claim about the code, not about the behaviour.
 *
 * `upsertPart` forwards for a stronger reason: the state derivation it carries is
 * the engine's (`toolPartContent`, in `@all-the.rest/baah-core`), so this file's
 * remaining job is to have **no opinion** — the three decisions that really are
 * storage's are each named at the method.
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
 * Three more, found later and by other layers, and each one is a gap this file
 * could **not** have closed on its own — which is the whole argument for them:
 *
 * 4. The seam could not **create** the rows its parts hang off, so the engine's
 *    first write of a turn failed a foreign key and an app wrapped the store to
 *    manufacture them. `appendTurn` and `appendMessage` closed that, and
 *    `withTranscriptRows` is now a workaround with nothing left to do.
 * 5. The seam could not **persist a tool part**, so `§6.1`'s third part type was
 *    written by the app, from a second copy of the rule that decides whether a
 *    failed tool is stored as a failure. `upsertPart` moved the rule to the
 *    engine, which is where a rule about what a *reload* shows belongs.
 * 6. A duplicate `appendTurn` would have been a **rejection**, and the engine
 *    turns a rejection into a `failed` turn with `attempts: 0` — for a turn that
 *    is entirely present, because a resumed approval re-enters the same one. That
 *    is a *statement*-level fix, not an adapter one, and it is why the conflict
 *    clause is on `INSERT_TURN` and `INSERT_MESSAGE`.
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

import { toolPartContent, type ToolPartEvent, type TurnStore } from "@all-the.rest/baah-core";

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

/** The `appendTurn` input, spelled out for the same reason. */
interface AppendTurnInput {
  id: string;
  sessionId: string;
  startedAt: string;
}

/**
 * The `appendMessage` input, spelled out for the same reason.
 *
 * `turnId` is `string | null` and **not** optional, and the adapter forwards the
 * key as it arrives. That is the engine's declaration and this one, and it is
 * load-bearing rather than a type detail: a message written with no turn is a
 * real state — a turn whose create was refused — and with
 * `exactOptionalPropertyTypes` an omitted key is a different type from an
 * explicit `null`. Spreading the input and dropping the key would make "the
 * engine says which turn this belongs to" and "the adapter forgot" the same
 * value.
 */
interface AppendMessageInput {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  turnId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The `upsertPart` input, spelled out for the same reason. */
interface UpsertPartInput {
  sessionId: string;
  messageId: string;
  event: ToolPartEvent;
}

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
 * The `data` blob as a JSON string, or a shape a reader can still render.
 *
 * `JSON.stringify` returns `undefined` for a function and throws on a cycle or a
 * `BigInt`. Neither is worth losing a card over: the column is a projection of
 * facts the part already carries in its own columns, and a reader that meets
 * unparsable JSON renders a note rather than dropping the part (the rule is at
 * `transcript.ts`'s `parseData`). So a value that will not serialise is written
 * as an empty object, which says "the payload is not there" instead of "this
 * part does not exist" — and never as `null`, which would erase the
 * discriminator, the `toolCallId` and the state with it.
 */
function serialiseData(data: unknown): string {
  try {
    const json = JSON.stringify(data);
    return json ?? "{}";
  } catch {
    return "{}";
  }
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
     * Create the turn row, if it does not exist.
     *
     * **No translation, and that is the point.** The engine mints the turn id
     * and the timestamp, `TurnInput` asks for the same three scalars, and the
     * only thing this side owns is the *idempotency*: `INSERT_TURN` resolves a
     * duplicate id to the row that is already there instead of raising
     * (`sql.ts`, `ON CONFLICT (id) DO UPDATE SET id = excluded.id`).
     *
     * The engine declares it that way for a measured reason — a `regenerate`
     * re-sends into a fresh turn, and **a resumed approval re-enters the same
     * one**, so "already there" is a normal state and not an error. A plain
     * `INSERT` would turn that normal state into a rejection, which on the
     * engine's side surfaces as a `failed` turn with `attempts: 0` for a turn
     * that is in fact *entirely present*. The consequence is measured rather
     * than argued: `INSERT_TURN` carries the clause, and a version without it
     * is killed by the replay test in `test/turn-store.test.ts`.
     *
     * What a duplicate does is therefore decided by the statement, and it is the
     * conservative direction: `heartbeat_at` is **not** in the `SET` list, so a
     * second write is not a heartbeat and the 30 s staleness rule (§6.1) keeps
     * exactly one writer for its anchor. The same asymmetry `Plan.md` §16.1
     * records for `beginToolCall`'s `DO NOTHING`.
     *
     * `seq` is left out on purpose so the store allocates it — §6.2's rule, not
     * a guess made here.
     */
    async appendTurn(input: AppendTurnInput): Promise<void> {
      await database.appendTurn({
        id: input.id,
        sessionId: input.sessionId,
        startedAt: input.startedAt,
      });
    },

    /**
     * Create the message row, if it does not exist.
     *
     * The same shape as {@link TurnStore.appendTurn} and the same reason:
     * **this is the write whose plain-`INSERT` version was a real defect.** The
     * engine mints the prompt's id **once in `run`** and threads it through
     * `AgentTurn.#persistPrompt`, so a retried turn re-sends the *same* message
     * id — and with a per-attempt id, a retry would append a second prompt row
     * to the same turn. A second `user` message in a session is an empty bubble
     * in the transcript, and it is the row that says what the user asked, so a
     * duplicated one changes what the model is shown on the next read.
     *
     * `INSERT_MESSAGE`'s `ON CONFLICT (id)` is the engine's declared
     * idempotency, not a convenience, and the full argument for why it is on the
     * *statement* rather than caught here as a `UNIQUE` error lives at `sql.ts`.
     * The short form: `Plan.md` §16.1 assigns idempotency to this layer ("`seq`-
     * Vergabe, Upsert-Semantik, Idempotenz und Kaskaden **einmal** implementiert"),
     * and a string-matched `catch` would be a second, shape-shaped copy of the
     * same rule.
     *
     * `turnId` is forwarded even when it is `null`, and even though a `null`
     * means "no turn" — see {@link AppendMessageInput}. The foreign key is
     * still enforced: a message naming a turn that does not exist is refused
     * with a `sql_error` on both backends, and the adapter does not soften that
     * into a missing row.
     */
    async appendMessage(input: AppendMessageInput): Promise<void> {
      await database.appendMessage({
        id: input.id,
        sessionId: input.sessionId,
        role: input.role,
        turnId: input.turnId,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
    },

    /**
     * Persist a tool part, or fold the write into the row that is already there.
     *
     * **The mapping is not here.** `toolPartContent` (`@all-the.rest/baah-core`,
     * `agent/loop.ts`) decides the state, the part id, the discriminator and the
     * `data` blob, and this method does the three things that are genuinely
     * storage's:
     *
     * 1. `type: "tool"` — §6.1's third part type, and the one the engine's
     *    `PartKind` deliberately does not carry, because a tool part is written
     *    whole and has no mid-stream text.
     * 2. `JSON.stringify` of the `data` value. The column is a JSON **string**
     *    (`Plan.md` §16.1 hands it to the reader unparsed on purpose), and a
     *    serialisation failure must not become a lost card: a `data` blob that is
     *    not JSON is rendered as a note rather than dropped, so writing a
     *    projection is strictly better than writing nothing.
     * 3. `status: "completed"` and the two timestamps, from the injectable clock.
     *    A tool part is never `streaming` — it is written whole, and a card that
     *    stayed in flight across a reload would be a lie about a call that
     *    finished.
     *
     * `seq` is again left to the store, which is what makes the upsert fold in
     * place: `Plan.md` §16.1 has it keep the original `seq` and `created_at`, so
     * a card that changes state updates where it is instead of jumping down the
     * transcript.
     */
    async upsertPart(input: UpsertPartInput): Promise<void> {
      const at = now();
      const content = toolPartContent(input.event);
      const data = serialiseData(content.data);
      await database.upsertPart({
        id: content.partId,
        messageId: input.messageId,
        sessionId: input.sessionId,
        type: "tool",
        contentText: content.contentText,
        data,
        status: "completed",
        createdAt: at,
        updatedAt: at,
      });
    },

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

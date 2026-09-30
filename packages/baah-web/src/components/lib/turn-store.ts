/**
 * The `TurnStore` the app injects: core's seam, plus the one row core still cannot
 * create.
 *
 * ## What is left, and why it is not nothing
 *
 * It used to manufacture **two** rows. Core's `TurnStore` now carries `appendTurn`
 * and `appendMessage` (`packages/baah-core/src/agent/loop.ts`) and the engine calls
 * both: `AgentTurn.#persistPrompt` writes the **user's own prompt** — turn row,
 * message row, text part, part close — before the first model call, and it names the
 * turn the message belongs to. So the turn row and the user's message row are the
 * engine's business now, with no guessing, and this wrapper forwards them.
 *
 * What is **left** is the assistant's message row. The engine mints the assistant's
 * `messageId` and writes *parts* under it, but no call announces the message; so the
 * first part of an assistant turn still finds no row, and `parts.message_id →
 * messages.id` is a real foreign key. Measured, not inferred — a plain
 * `createTurnStore(createMemoryDatabase())` with no wrapper refuses with
 * `FOREIGN KEY constraint failed: messages.id = …`.
 *
 * ## `upsertPart` is where the ordering problem went
 *
 * A tool call arrives *before* the engine has flushed a single delta of that
 * attempt — step 1 is the tool call, step 2 is the text — so the assistant's message
 * row does not exist when the first `upsertPart` lands. The app used to solve that by
 * **buffering** the tool part in `components/lib/runtime.ts` until some other write
 * reported the message id; that buffer, and the copy of the row it wrote, are gone
 * (see `TurnStore.upsertPart` in core for the seam that replaced them).
 *
 * The replacement is one line: `upsertPart` names the message the part belongs to,
 * so `ensureMessage` runs **before** the delegate and the row is there. The write is
 * awaited by the engine — three writes land on the same row in order, and a fired
 * one can be overtaken by the call it follows — so "call, then result, then maybe a
 * denial" is a sequence the database sees in that order.
 *
 * ## The memo, and why it is a memo and not a lookup
 *
 * Both wrappers memoise per id, and the memo is also the "this row exists" answer.
 * That is not a shortcut around asking the store — it is **the** answer, because the
 * wrapper sees every `appendMessage` that reaches it: the engine's prompt write
 * marks its id, and the `flushDelta` that follows must not create a second row for
 * it. Asking `getMessage` instead would be a `postMessage` round trip per part to
 * learn something the wrapper already knows.
 *
 * ## The role, and the one property it protects
 *
 * The engine writes the **user's** message through `appendMessage` and then flushes
 * a delta under it. The memo is what stops `ensureMessage` from manufacturing a
 * second row for that id, and a second row would be a *second bubble in the
 * transcript claiming to be the assistant's answer to the user's own question*. So
 * `role` is the decorator's own, the forwarded `appendMessage` is never treated as
 * "a row to create", and the tool part a turn writes lands on the assistant's
 * message — never on the user's. `turn-store.test.ts` pins the unit half of that and
 * `turn-writes.test.ts` the end-to-end half, through a real `AgentTurn` and a real
 * store.
 *
 * ## `ensureTurn` is still here, and it is still a no-op in the common case
 *
 * `#persistPrompt` creates the turn row, so after the first flush `ensureTurn` finds
 * the memo and does nothing. It is kept for the one path that has no prompt: an
 * approval **resume** re-enters the same turn with `prompt === ""` and the engine
 * writes no prompt, and `INSERT_TURN_OUTCOME_MESSAGE` returns **zero rows** for a
 * turn it cannot find rather than refusing — so without the row the turn's outcome,
 * the only record of how it ended (`Plan.md` §6.2), would be written nowhere and
 * nothing would report an error.
 */
import type { TurnStore } from "@all-the.rest/baah-core";

/** The two writes this decorator performs before delegating. */
export interface TranscriptRowWriter {
  /** Create the turn row if it does not exist. Idempotent by turn id. */
  appendTurn(input: { id: string; sessionId: string; startedAt: string; status: "streaming" }): Promise<unknown>;
  /** Create the message row if it does not exist. Idempotent by message id. */
  appendMessage(input: {
    id: string;
    sessionId: string;
    role: "assistant" | "user" | "system";
    createdAt: string;
    updatedAt: string;
    turnId?: string | null;
  }): Promise<unknown>;
}

export interface TranscriptRowsOptions {
  readonly writer: TranscriptRowWriter;
  readonly sessionId: string;
  /** Injected for a deterministic test. ISO-8601 (`AGENTS.md` §5). */
  readonly now?: (() => string) | undefined;
  /**
   * The role the rows this wrapper creates belong to. The engine mints only the
   * assistant's, and the forwarded `appendMessage` keeps whatever role *it* named.
   */
  readonly role?: "assistant" | "user" | "system" | undefined;
}

/**
 * Wrap a `TurnStore` so the assistant's message row exists before its parts do.
 *
 * Every method delegates. The wrapper's own work is a memo per id, so a turn that
 * flushes a hundred deltas creates one message row — not a hundred.
 */
export function withTranscriptRows(store: TurnStore, options: TranscriptRowsOptions): TurnStore {
  const now = options.now ?? ((): string => new Date().toISOString());
  const role = options.role ?? "assistant";
  const sessionId = options.sessionId;

  /** turnId → the in-flight insert, or a resolved promise once the row exists. */
  const turns = new Map<string, Promise<void>>();
  /** messageId → the in-flight insert, or a resolved promise once the row exists. */
  const messages = new Map<string, Promise<void>>();

  /**
   * The turn id, once one has been seen.
   *
   * A single slot rather than a lookup: the engine runs one turn at a time per
   * `AgentTurn` (`runtime/index.ts` guards with `inFlight`), so a second id can
   * only be a *later* turn, and the newest is the one an unflushed message belongs
   * to. Keeping a map here would be an invitation to attribute a message to a turn
   * from two turns ago.
   */
  let knownTurnId: string | undefined;

  /** Mark a row as existing without writing it. */
  function remember(map: Map<string, Promise<void>>, id: string): void {
    if (!map.has(id)) map.set(id, Promise.resolve());
  }

  function ensureTurn(turnId: string | undefined): Promise<void> {
    if (turnId !== undefined) knownTurnId = turnId;
    if (knownTurnId === undefined) return Promise.resolve();
    const id = knownTurnId;
    const existing = turns.get(id);
    if (existing !== undefined) return existing;
    const at = now();
    const insert = options.writer
      .appendTurn({ id, sessionId, startedAt: at, status: "streaming" })
      .then(() => undefined)
      .catch((error: unknown) => {
        // A failed insert must not be memoised as done, or every later write of the
        // turn would proceed against a row that was never created and fail with a
        // foreign-key error that names the wrong thing.
        turns.delete(id);
        throw error;
      });
    turns.set(id, insert);
    return insert;
  }

  function ensureMessage(messageId: string): Promise<void> {
    const existing = messages.get(messageId);
    if (existing !== undefined) return existing;
    const at = now();
    const insert = options.writer
      .appendMessage({
        id: messageId,
        sessionId,
        role,
        createdAt: at,
        updatedAt: at,
        turnId: knownTurnId ?? null,
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        messages.delete(messageId);
        throw error;
      });
    messages.set(messageId, insert);
    return insert;
  }

  return {
    // The engine's own creates, forwarded. The ids are remembered so the `ensure`
    // path below does not manufacture a second row for a row that is already there.
    appendTurn: async (input) => {
      if (knownTurnId === undefined) knownTurnId = input.id;
      remember(turns, input.id);
      await store.appendTurn(input);
    },
    appendMessage: async (input) => {
      await store.appendMessage(input);
      // **Remembered, and never re-created.** The engine's prompt write goes through
      // here, and the `flushDelta` that follows must not manufacture an `assistant`
      // row for the user's own message id — see the module header.
      remember(messages, input.id);
    },
    /**
     * The engine's tool-part upsert, forwarded — with the row its part attaches to
     * created first.
     *
     * **This line is the whole reason the app-side tool writer is gone.** The engine
     * names the message (`TurnStore.upsertPart`, `{ sessionId, messageId, event }`),
     * so the row exists before the part does, in order, without a buffer and without
     * the app writing a second copy of the row: `turn-writes.test.ts` asserts that
     * the card lands on the assistant's message and that the store holds one row per
     * tool call, not two.
     */
    upsertPart: async (input) => {
      await ensureMessage(input.messageId);
      await store.upsertPart(input);
    },
    flushDelta: async (input) => {
      // The order is the foreign key's: turn, then message, then the part. The turn
      // row is normally already there — the engine created it before the first model
      // call — and `ensureTurn` is then a no-op.
      await ensureTurn(undefined);
      await ensureMessage(input.messageId);
      await store.flushDelta(input);
    },
    closePart: async (input) => {
      await ensureMessage(input.messageId);
      await store.closePart(input);
    },
    closeTurnParts: async (input) => {
      await ensureTurn(input.turnId);
      await store.closeTurnParts(input);
    },
    finishTurn: async (input) => {
      // Before the delegate, and this one is load-bearing: the delegate's
      // `INSERT_TURN_OUTCOME_MESSAGE` returns **zero rows** for a turn it cannot
      // find, so the turn's outcome would be written nowhere without this.
      await ensureTurn(input.turnId);
      await store.finishTurn(input);
    },
    heartbeat: async (input) => {
      await ensureTurn(input.turnId);
      await store.heartbeat(input);
    },
    // Reads pass through untouched — the wrapper has nothing to prepare for them.
    listUnfinishedTurns: (input) => store.listUnfinishedTurns(input),
    listTurnOutcomes: (input) => store.listTurnOutcomes(input),
    recordToolCall: (input) => store.recordToolCall(input),
    getToolCall: (key) => store.getToolCall(key),
    beginToolCall: (input) => store.beginToolCall(input),
  };
}

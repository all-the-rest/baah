/**
 * The `TurnStore` the app injects: core's seam, plus the transcript rows core
 * cannot create.
 *
 * ## The gap, stated
 *
 * `TurnStore` has ten methods (`packages/baah-core/src/agent/loop.ts`) and **none
 * of them appends a turn row or a message row**. The engine mints a `turnId`
 * (`AgentLoopOptions.turnId`) and a `messageId` (`newMessageId()`) and then writes
 * *parts* under them:
 *
 * ```
 * store.flushDelta({ deltaId, partId, messageId, sessionId, partType, contentText })
 * ```
 *
 * `baah-storage` enforces `parts.message_id → messages.id` as a foreign key
 * (`schema.ts`, and the same check in the in-memory mirror's `requireMessage`).
 * A part written under a message that was never appended is therefore refused:
 * `FOREIGN KEY constraint failed: messages.id = …`.
 *
 * **Measured, not inferred.** Running one text turn through
 * `createTurnStore(createMemoryDatabase())` with no wrapper:
 *
 * ```
 * Error: StorageError: FOREIGN KEY constraint failed: messages.id = 37a5dd8f-…
 * ```
 *
 * The same is true one level up: `INSERT_TURN_OUTCOME_MESSAGE` **returns zero rows
 * when the turn row is missing** rather than refusing
 * (`packages/baah-storage/src/factory.ts`), so the turn's outcome — the only record
 * of how a turn ended (`Plan.md` §6.2) — would be written nowhere and nothing
 * would say so. That is a silent loss, which is the failure mode this file exists to
 * prevent, so it is fixed here rather than discovered later in a browser.
 *
 * ## Why the fix is here and not in core
 *
 * Two options existed:
 *
 * 1. Add `appendTurn` / `appendMessage` to `TurnStore`, so the engine creates what
 *    it writes into. That is the **right** long-term shape: the engine is the party
 *    that mints the ids.
 * 2. Wrap the seam in the app.
 *
 * This block does not own `packages/baah-core` and was not allowed to change it, so
 * (2) is what ships, and (1) is the finding the report names. The wrapper is a
 * **decorator, not a second store**: every method it defines delegates, and the two
 * rows it creates are the ones the engine's own writes then attach to. The wrapper
 * holds no transcript state, so the duplication `Plan.md` §16.1 refused for the
 * adapter cannot happen here — there is one implementation of every part write.
 *
 * ## Why the turn id is learned rather than known
 *
 * The app does not mint the turn id: `runtime/index.ts` does, per turn
 * (`mintId("turn")`). So the wrapper learns it from the first call that carries one —
 * `heartbeat` is written at the start of every attempt, before any delta
 * (`loop.ts`), so it is always there — and additionally from the runtime's own
 * snapshot, which publishes `turnId` the moment a turn begins. Both paths are wired;
 * the heartbeat one alone would work, and the snapshot one closes the window in
 * which a message is written before the turn row exists.
 *
 * A message written before its turn is known is appended with `turnId: null` rather
 * than refused: it is still in the session's log and still renders, and the
 * alternative is losing text the provider already produced. The turn id is filled in
 * later by the outcome message's own row, and the transcript reads by session
 * (`SELECT_TRANSCRIPT_MESSAGES`), so nothing is lost and nothing is misattributed.
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
  /** The role the engine's parts belong to. It mints only assistant messages. */
  readonly role?: "assistant" | "user" | "system" | undefined;
  /**
   * Called with the id of each assistant message row the wrapper creates.
   *
   * ## Why the app needs to hear about this
   *
   * The engine mints the message id itself (`newMessageId()`) and never reports it
   * on any event — `tool-call` carries `toolCallId`, `toolName` and `input`, and
   * nothing that names the message the call belongs to. So an app that wants to
   * persist a **tool** part (which the engine does not persist at all, see the
   * module header) has no other way to learn which message to attach it to.
   *
   * The alternative — reading back the newest message, as an earlier version of
   * this file did for the user prompt — is a race: two prompts in flight would
   * attach their parts to each other's messages.
   */
  readonly onMessageCreated?: ((messageId: string) => void) | undefined;
}

/**
 * Wrap a `TurnStore` so the rows its parts attach to exist.
 *
 * Every method delegates. The wrapper's own work is a memo per id, so a turn that
 * flushes a hundred deltas creates one turn row and one message row — not a
 * hundred of each.
 */
export function withTranscriptRows(store: TurnStore, options: TranscriptRowsOptions): TurnStore {
  const now = options.now ?? ((): string => new Date().toISOString());
  const role = options.role ?? "assistant";
  const sessionId = options.sessionId;

  /** turnId → the in-flight insert, so concurrent calls await one write. */
  const turns = new Map<string, Promise<void>>();
  /** messageId → the in-flight insert. */
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
        // A failed insert must not be memoised as done, or every later write of
        // the turn would proceed against a row that was never created and fail
        // with a foreign-key error that names the wrong thing.
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
      .then(() => {
        options.onMessageCreated?.(messageId);
      })
      .catch((error: unknown) => {
        messages.delete(messageId);
        throw error;
      });
    messages.set(messageId, insert);
    return insert;
  }

  return {
    flushDelta: async (input) => {
      // The order is the foreign key's: turn, then message, then the part.
      await ensureTurn(undefined);
      await ensureMessage(input.messageId);
      // The turn id is learned here too, when it can be: a delta does not carry
      // one, but the heartbeat that precedes it does, and a direct `AgentTurn` use
      // (a test, a batch) may have produced neither.
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

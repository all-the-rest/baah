/**
 * Owned call site #2 — reload recovery at boot.
 *
 * ## The gap this closes
 *
 * `listUnfinishedTurns` and `recoverStaleTurns` both exist, `STALE_HEARTBEAT_MS`
 * is exported and documented at length, and **nobody calls either of them**. The
 * consequence is the silent failure `Plan.md` §5.4 exists to prevent: a turn whose
 * tab died mid-step stays `streaming` forever, its transcript stops mid-sentence,
 * and nobody is ever told.
 *
 * ## Why the threshold, and not "all unfinished turns"
 *
 * §6.1's boundary table, with both sides implemented and both tested:
 *
 * | `age < 30 s` | **alive** — a second tab is still working on it. Untouched. |
 * | `age >= 30 s` | **dead** — the tab is gone. `interrupted`, reason recorded. |
 *
 * Closing the fresh side would kill a live turn in another tab, which is worse
 * than the failure it fixes: the damage there is not merely "not noticed", it is
 * a turn marked dead while it is still writing.
 *
 * ## What "recovery" does and does not mean here
 *
 * §14.4: `DirectChatTransport.reconnectToStream()` always returns `null`. There
 * is no resume. So recovery is *closing the turn honestly and offering a re-send*,
 * and the report says so — the UI must never render a "continue" affordance,
 * because there is nothing to continue.
 *
 * ## The partial text survives, and that is the store's job to guarantee
 *
 * `finishTurn` writes the outcome and an `idle` message (§6.2). It deletes
 * nothing, so the text parts and the `flushDelta`ed deltas stay where they are.
 * This module's obligation is therefore to **not** touch them either — to issue
 * exactly one call per stale turn and nothing else. `recoverStaleTurns` (core)
 * already does that, and the test asserts the call count, which is what pins it.
 */

import {
  STALE_HEARTBEAT_MS,
  recoverStaleTurns,
  type TurnStore,
  type UnfinishedTurn,
} from "@all-the.rest/baah-core";

export interface BootReport {
  readonly sessionId: string;
  /** The turns that were on the stale side and have now been closed. */
  readonly recovered: readonly UnfinishedTurn[];
  /**
   * The turns that were left alone because their heartbeat was fresh.
   *
   * Reported, not just counted, because "a turn was skipped" and "no turn was
   * skipped" must be distinguishable by the UI — the first is worth a banner.
   */
  readonly untouched: readonly UnfinishedTurn[];
  /** The threshold used, so the UI can say "older than 30 s" without hard-coding. */
  readonly staleAfterMs: number;
  readonly checkedAt: string;
}

export interface RecoverOnBootOptions {
  readonly store: TurnStore;
  readonly sessionId: string;
  /** Defaults to the engine's `STALE_HEARTBEAT_MS`. */
  readonly staleAfterMs?: number;
  /** Injected clock, so a test can sit on either side of the boundary. */
  readonly now?: () => number;
}

/**
 * Close the turns a reload left open.
 *
 * Idempotent in the way that matters: a second call finds nothing unfinished,
 * because the first call finished them. Safe to call on every boot, and on every
 * tab becoming visible again.
 */
export async function recoverOnBoot(options: RecoverOnBootOptions): Promise<BootReport> {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? STALE_HEARTBEAT_MS;
  const nowMs = now();

  const recovered = await recoverStaleTurns({
    store: options.store,
    sessionId: options.sessionId,
    staleAfterMs,
    nowMs,
  });

  const unfinished = await options.store.listUnfinishedTurns({ sessionId: options.sessionId });
  const recoveredIds = new Set(recovered.map((turn) => turn.turnId));

  return {
    sessionId: options.sessionId,
    recovered,
    untouched: unfinished.filter((turn) => !recoveredIds.has(turn.turnId)),
    staleAfterMs,
    checkedAt: new Date(nowMs).toISOString(),
  };
}

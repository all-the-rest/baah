/**
 * Retry schedule for one turn (Plan.md §5.4, "Backoff: sofort, dann wachsend").
 *
 * Pure, and the randomness is a **parameter**. A backoff you cannot pin down in
 * a test is a backoff nobody trusts, so `random` is injected rather than read
 * from `Math.random`. Nothing in this file sleeps, fetches, or touches a clock.
 *
 * The shape of the schedule is the plan's, and the plan's reasoning is worth
 * keeping in the code: the first retry is immediate because most transient
 * provider failures are one blip; the waits then grow because a provider that
 * is genuinely down needs real time, not a second identical request. There is
 * no fourth attempt at all — after three tries the turn is handed to the user,
 * because every retry is a request that may be billed.
 */

/**
 * Wait **before** each attempt, in milliseconds. Indexed by `attempt - 1`.
 *
 * Attempt 1 → 0 ms (immediate), attempt 2 → 2 s, attempt 3 → 8 s.
 * There is no index 3: {@link MAX_ATTEMPTS} is the hard cap.
 */
export const RETRY_SCHEDULE_MS: readonly number[] = Object.freeze([0, 2_000, 8_000]);

/** Maximum automatic attempts per turn, including the first one (Plan.md §5.4). */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;

/** ±25 % jitter, applied to every wait (Plan.md §5.4). */
export const JITTER_RATIO = 0.25;

/**
 * Hard cap for a server-provided `Retry-After`.
 *
 * A `Retry-After` of an hour is a provider that has given up; following it
 * would freeze the tab's turn forever with no way to tell what happened.
 */
export const RETRY_AFTER_CAP_MS = 60_000;

/** The wait before an attempt, before jitter — the raw table plus the override. */
export function baseDelayMs(attempt: number, retryAfterMs?: number): number | undefined {
  if (attempt < 1 || attempt > MAX_ATTEMPTS) return undefined;
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(0, retryAfterMs), RETRY_AFTER_CAP_MS);
  }
  return RETRY_SCHEDULE_MS[attempt - 1];
}

/**
 * The wait before an attempt, with ±25 % jitter.
 *
 * `random` is expected to return a number in `[0, 1)`; `0.5` is therefore the
 * "no jitter" value and is what the tests use when they want the exact number.
 * A `Retry-After` from the server replaces the table entry and is then capped,
 * but it is jittered as well — the jitter exists to spread the herd, and an
 * uncoordinated client is exactly the failure mode the plan cites.
 *
 * @param attempt 1-based attempt number. Values outside `1..MAX_ATTEMPTS`
 *   return `undefined`, which is how the engine learns that there is no
 *   automatic attempt 4.
 */
export function nextDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number,
): number | undefined {
  const base = baseDelayMs(attempt, retryAfterMs);
  if (base === undefined) return undefined;
  if (base === 0) return 0;
  // `Math.min` re-applies the cap: a 60 s Retry-After jittered upwards must not
  // become 75 s, because the cap exists to bound the turn, not just the input.
  return Math.min(Math.round(base * (1 + (random() * 2 - 1) * JITTER_RATIO)), RETRY_AFTER_CAP_MS);
}

/** Is another automatic attempt allowed after `attempt` already happened? */
export function canRetry(attempt: number): boolean {
  return attempt < MAX_ATTEMPTS;
}

/** How many attempts a policy may still make from here, including the next one. */
export function remainingAttempts(attempt: number, maxAttempts: number = MAX_ATTEMPTS): number {
  return Math.max(0, maxAttempts - attempt);
}

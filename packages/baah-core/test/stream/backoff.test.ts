/**
 * The retry schedule (Plan.md §5.4).
 *
 * `random` is injected precisely so these can be exact rather than approximate:
 * a backoff asserted with a tolerance is a backoff nobody has checked.
 */
import { describe, expect, it } from "vitest";

import {
  baseDelayMs,
  canRetry,
  JITTER_RATIO,
  MAX_ATTEMPTS,
  nextDelayMs,
  remainingAttempts,
  RETRY_AFTER_CAP_MS,
  RETRY_SCHEDULE_MS,
} from "../../src/stream/backoff.ts";

/** The no-jitter value: `0.5` is the midpoint of the ±25 % band. */
const noJitter = (): number => 0.5;
const atFloor = (): number => 0;
const atCeiling = (): number => 1;

describe("the raw schedule", () => {
  it("is immediate, then 2 s, then 8 s", () => {
    expect([...RETRY_SCHEDULE_MS]).toEqual([0, 2_000, 8_000]);
  });

  it("has no fourth attempt", () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect(RETRY_SCHEDULE_MS).toHaveLength(3);
    expect(baseDelayMs(4)).toBeUndefined();
    expect(nextDelayMs(4, undefined, noJitter)).toBeUndefined();
  });

  it("rejects attempt 0 and negatives", () => {
    expect(baseDelayMs(0)).toBeUndefined();
    expect(baseDelayMs(-1)).toBeUndefined();
  });

  it("reports the raw base per attempt", () => {
    expect(baseDelayMs(1)).toBe(0);
    expect(baseDelayMs(2)).toBe(2_000);
    expect(baseDelayMs(3)).toBe(8_000);
  });
});

describe("the jittered delay", () => {
  it("is exact at the midpoint of the band", () => {
    expect(nextDelayMs(2, undefined, noJitter)).toBe(2_000);
    expect(nextDelayMs(3, undefined, noJitter)).toBe(8_000);
  });

  it("leaves the immediate first retry at zero", () => {
    // Jittering zero is still zero; a 0 ms wait must not become a random one.
    expect(nextDelayMs(1, undefined, atFloor)).toBe(0);
    expect(nextDelayMs(1, undefined, atCeiling)).toBe(0);
  });

  it("reaches the ±25 % bounds and no further", () => {
    expect(nextDelayMs(2, undefined, atFloor)).toBe(Math.round(2_000 * (1 - JITTER_RATIO)));
    expect(nextDelayMs(2, undefined, atCeiling)).toBe(Math.round(2_000 * (1 + JITTER_RATIO)));
    expect(nextDelayMs(3, undefined, atFloor)).toBe(Math.round(8_000 * (1 - JITTER_RATIO)));
    expect(nextDelayMs(3, undefined, atCeiling)).toBe(Math.round(8_000 * (1 + JITTER_RATIO)));
  });

  it("stays inside the band for every value of random, not just the ends", () => {
    for (let step = 0; step <= 20; step += 1) {
      const random = step / 20;
      for (const attempt of [2, 3]) {
        const base = RETRY_SCHEDULE_MS[attempt - 1] as number;
        const delay = nextDelayMs(attempt, undefined, () => random) as number;
        expect(delay).toBeGreaterThanOrEqual(Math.round(base * (1 - JITTER_RATIO)));
        expect(delay).toBeLessThanOrEqual(Math.round(base * (1 + JITTER_RATIO)));
      }
    }
  });

  it("actually varies with random — an unjittered backoff would be the bug", () => {
    const delays = new Set<number>();
    for (let step = 0; step <= 10; step += 1) {
      delays.add(nextDelayMs(2, undefined, () => step / 10) as number);
    }
    expect(delays.size).toBeGreaterThan(5);
  });
});

describe("Retry-After beats the table", () => {
  it("replaces the schedule entry", () => {
    expect(nextDelayMs(2, 1_000, noJitter)).toBe(1_000);
    // Shorter than the table's 2 s, so the override really did win.
    expect(nextDelayMs(2, 1_000, noJitter)).not.toBe(2_000);
  });

  it("wins on a longer wait too", () => {
    expect(nextDelayMs(2, 30_000, noJitter)).toBe(30_000);
  });

  it("is capped at 60 s", () => {
    expect(RETRY_AFTER_CAP_MS).toBe(60_000);
    expect(nextDelayMs(2, 600_000, noJitter)).toBe(60_000);
  });

  it("cannot exceed the cap even when jittered upwards", () => {
    // The cap bounds the turn, so the *result* is capped, not just the input.
    expect(nextDelayMs(2, RETRY_AFTER_CAP_MS, atCeiling)).toBe(RETRY_AFTER_CAP_MS);
  });

  it("clamps a negative override to zero", () => {
    expect(nextDelayMs(2, -5_000, noJitter)).toBe(0);
  });

  it("is still subject to the no-fourth-attempt rule", () => {
    // A provider sending `Retry-After: 600` must not buy a fourth request.
    expect(nextDelayMs(4, 600_000, noJitter)).toBeUndefined();
  });
});

describe("attempt bookkeeping", () => {
  it("allows a retry only while attempts remain", () => {
    expect(canRetry(1)).toBe(true);
    expect(canRetry(2)).toBe(true);
    expect(canRetry(3)).toBe(false);
  });

  it("counts the remaining attempts, including the next one", () => {
    expect(remainingAttempts(1)).toBe(2);
    expect(remainingAttempts(2)).toBe(1);
    expect(remainingAttempts(3)).toBe(0);
  });

  it("clamps a caller-supplied cap to zero rather than going negative", () => {
    expect(remainingAttempts(5)).toBe(0);
    expect(remainingAttempts(1, 1)).toBe(0);
  });
});

describe("the schedule is what the plan says", () => {
  it("accumulates to 10 s over three attempts", () => {
    // Plan.md's table: 0 s + 2 s + 8 s = 10 s cumulative.
    const total = RETRY_SCHEDULE_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBe(10_000);
  });

  it("is frozen, so a caller cannot mutate the shared table", () => {
    expect(Object.isFrozen(RETRY_SCHEDULE_MS)).toBe(true);
  });
});

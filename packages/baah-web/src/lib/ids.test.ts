/**
 * `newId`, and specifically its fallback.
 *
 * The fallback is the part nobody exercises, which is exactly why it was wrong: the
 * old one was `Date.now()` + `Math.trunc(performance.now() * 1000)`, and
 * `performance.now()` is **relative to page load**, so two calls in the same
 * millisecond produced the same id. It is unreachable where `crypto.randomUUID`
 * exists — and it exists precisely for the environments where it does not, where it
 * silently produced duplicate turn ids. Duplicate turn ids are the worst outcome
 * available: the store keys reload recovery on `turnId`, so two turns sharing one
 * are recovered as one, and one of them stays `streaming` forever.
 *
 * So the fallback is exercised here by removing `randomUUID`, which is the only way
 * to reach it, and by calling it in the shape that broke it: several ids inside one
 * millisecond.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { apiKeySlot, newId, nowIso } from "./ids.ts";

/** A `crypto` with no `randomUUID`, which is the environment the fallback is for. */
function withoutRandomUUID(): void {
  vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: undefined });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newId", () => {
  it("uses `crypto.randomUUID` when the browser has it (AGENTS.md §5)", () => {
    const randomUUID = vi.fn(() => "11111111-2222-3333-4444-555555555555");
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID });

    expect(newId("turn")).toBe("turn-11111111-2222-3333-4444-555555555555");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("gives every id in the same millisecond a different one", () => {
    // The regression, as a test. `Date.now` is frozen so the timestamp half of the
    // fallback cannot vary — under the old implementation the `performance.now()`
    // half did the work, and two calls in the same millisecond returned the same
    // string.
    vi.useFakeTimers();
    try {
      withoutRandomUUID();

      const ids = Array.from({ length: 1_000 }, () => newId("turn"));

      expect(new Set(ids).size).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps minting unique ids across a frozen clock, not just within one batch", () => {
    // A counter that resets would pass the batch test above and fail this one. The
    // failure it models is a long-lived tab: turn 1 at boot, turn 2 an hour later,
    // and a reader comparing the two.
    withoutRandomUUID();

    const early = newId("turn");
    const later = newId("turn");

    expect(early).not.toBe(later);
  });

  it("keeps the prefix, so a reader can tell a turn from a part without a lookup", () => {
    withoutRandomUUID();

    expect(newId("turn")).toMatch(/^turn-/);
    expect(newId("part")).toMatch(/^part-/);
  });

  it("stays sortable by time, because the timestamp is still the first component", () => {
    vi.useFakeTimers();
    try {
      withoutRandomUUID();
      vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
      const early = newId("turn");

      vi.setSystemTime(new Date("2026-09-29T12:00:01.000Z"));
      const later = newId("turn");

      // Lexicographic order, not chronological-by-counter: the timestamp leads.
      expect(early < later).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a `crypto` that is entirely absent", () => {
    vi.stubGlobal("crypto", undefined);

    const first = newId("turn");
    expect(first).toMatch(/^turn-/);
    expect(newId("turn")).not.toBe(first);
  });
});

describe("nowIso", () => {
  it("is an ISO-8601 string from the injected clock", () => {
    expect(nowIso(() => Date.parse("2026-09-29T12:00:00.000Z"))).toBe("2026-09-29T12:00:00.000Z");
  });

  it("sorts as text, which is the property the format is chosen for", () => {
    const earlier = nowIso(() => Date.parse("2026-09-29T12:00:00.000Z"));
    const later = nowIso(() => Date.parse("2026-09-29T12:00:01.000Z"));

    expect(earlier < later).toBe(true);
  });
});

describe("apiKeySlot", () => {
  it("is idempotent, so either caller form lands in the same slot", () => {
    // A stored selection carries the registry's own composite id, so the name is
    // already inside `vendor`. Re-joining without splitting first produced
    // `openai-compatible:groq:groq` — a slot nothing writes, which reports "no key"
    // for a key the user definitely entered.
    expect(apiKeySlot("openai-compatible:groq")).toBe("openai-compatible:groq");
    expect(apiKeySlot("openai-compatible", "groq")).toBe("openai-compatible:groq");
    expect(apiKeySlot("openai-compatible:groq", "groq")).toBe("openai-compatible:groq");
  });

  it("uses the flat vendor when there is no name", () => {
    expect(apiKeySlot("openai")).toBe("openai");
    expect(apiKeySlot("openai", "")).toBe("openai");
  });

  it("splits on the first colon, so a name may contain one", () => {
    expect(apiKeySlot("openai-compatible:groq:llama")).toBe("openai-compatible:groq:llama");
  });
});

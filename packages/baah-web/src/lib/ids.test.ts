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

import { apiKeySlot, newId, nowIso, readSessionId, resolveSessionId } from "./ids.ts";
import { createMemoryBackend, SettingsStorageError } from "./storage.ts";

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

/* ------------------------------------------------------------------ */
/* The session id that survives a reload                               */
/* ------------------------------------------------------------------ */

/**
 * The finding, as a test.
 *
 * The database is durable (`openDatabase()` → SQLite in OPFS), and the app minted a
 * **new** `sessionId` on every document load. A row no query can reach does not
 * survive a reload, so the previous build shipped a database full of history beside
 * an empty transcript — which is what the "the transcript does not survive a reload"
 * banner was really describing.
 */
describe("resolveSessionId", () => {
  const mint = (): string => "session-minted-1";

  it("mints and remembers on a first run", () => {
    const backend = createMemoryBackend();
    const first = resolveSessionId(backend, { mint, now: () => 0 });

    expect(first.sessionId).toBe("session-minted-1");
    expect(first.restored).toBe(false);
    expect(first.degraded).toBeUndefined();
  });

  it("hands the same id back on the next run — the whole point", () => {
    const backend = createMemoryBackend();
    const first = resolveSessionId(backend, { mint });

    // A second `resolveSessionId` with a **different** mint, so a mutant that always
    // mints fails here instead of passing because the test's mint is stable.
    const second = resolveSessionId(backend, { mint: () => "session-minted-2" });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.restored).toBe(true);
    expect(second.degraded).toBeUndefined();
  });

  it("never mints on a restored run", () => {
    // The stronger form of the same claim, and the one that catches "mints, then
    // returns the stored value" — which would look correct to the test above.
    const backend = createMemoryBackend();
    resolveSessionId(backend, { mint });

    let minted = 0;
    resolveSessionId(backend, {
      mint: () => {
        minted += 1;
        return "session-minted-2";
      },
    });

    expect(minted).toBe(0);
  });

  it("replaces a stored value that is not a session id, and says so", () => {
    // `readTranscript` **refuses** a session that does not exist rather than
    // answering "no messages" (`Plan.md` §16.1), so trusting a corrupted id would
    // leave the app permanently unable to read anything. Anything unparseable is
    // therefore replaced — and the user is told, because silently starting a new
    // session is how a conversation disappears without an error.
    for (const hostile of ["", "{}", "null", '"nope"', '{"sessionId":"../../etc/passwd"}', '{"sessionId":42}']) {
      const backend = createMemoryBackend();
      // Written by hand, because a `Map` backend round-trips only what we put in it.
      (backend as { write: (raw: string) => void }).write(hostile);

      const resolved = resolveSessionId(backend, { mint });

      expect(resolved.sessionId, hostile).toBe("session-minted-1");
      expect(resolved.restored, hostile).toBe(false);
    }
  });

  it("reports a storage that refuses to read, and still gives out a usable id", () => {
    // `lib/storage.ts` throws rather than answering "unset" for a browser with no
    // `localStorage` at all. This function is not the UI, so it does not decide what
    // that means — it mints a usable id and hands the caller one line to say.
    const backend = createMemoryBackend();
    backend.read = () => {
      throw new SettingsStorageError("unavailable", "no localStorage");
    };

    const resolved = resolveSessionId(backend, { mint });

    expect(resolved.sessionId).toBe("session-minted-1");
    expect(resolved.restored).toBe(false);
    expect(resolved.degraded).toContain("SettingsStorageError");
  });

  it("reports a storage that refuses to write, and does not throw", () => {
    // A browser that will not `setItem` starts a **new** session on every reload. A
    // user who finds that out by reloading has lost the conversation, so it is said
    // out loud (`AGENTS.md` §5: no silent catch) — and a throw here would take the
    // whole app down over a bookkeeping problem.
    const backend = createMemoryBackend();
    backend.write = () => {
      throw new SettingsStorageError("write-failed", "quota");
    };

    const resolved = resolveSessionId(backend, { mint });

    expect(resolved.sessionId).toBe("session-minted-1");
    expect(resolved.degraded).toContain("nicht gespeichert");
  });

  it("says nothing when nothing went wrong", () => {
    // The negative of the two branches above, because a degraded banner that shows
    // up on a healthy browser is its own kind of lie.
    const resolved = resolveSessionId(createMemoryBackend(), { mint });
    expect(resolved.degraded).toBeUndefined();
  });
});

describe("readSessionId", () => {
  it("reads the id out of what `resolveSessionId` wrote", () => {
    const backend = createMemoryBackend();
    resolveSessionId(backend, { mint: () => "session-abc" });
    expect(readSessionId(backend.read())).toBe("session-abc");
  });

  it("answers `undefined` for anything that is not our record", () => {
    // `undefined` and never a throw: the caller wants "is there a usable id here",
    // and a parse failure of somebody else's value is a fact, not an error.
    for (const raw of [undefined, "", "nope", "[]", '"session-x"', '{"at":"2026"}', '{"sessionId":"turn-x"}']) {
      expect(readSessionId(raw), String(raw)).toBeUndefined();
    }
  });
});

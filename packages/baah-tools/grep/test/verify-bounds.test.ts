/**
 * The bounds on the synchronous match loop: abort signal and wall clock.
 *
 * The scanner is a per-line `RegExp.test`, so a catastrophic pattern does not
 * slow the search down — it stops the tab. Measured on this machine with
 * `(a+)+$` against `"a"×N + "b"`: N=24 → 305 ms, N=26 → 1.1 s, N=28 → 4.6 s,
 * N=30 → 19 s, doubling per two characters. Both bounds below are checked
 * against that, and both must be visible in the result: a truncated search
 * that does not announce itself is the failure mode that matters.
 */
import { createMemoryWorkspace, type ToolContext, type Workspace } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  MAX_LINE_LENGTH,
  SEARCH_TIMEOUT_MS,
  executeGrep,
  grepInputSchema,
  grepTool,
  searchWithRegExp,
  type GrepFile,
} from "../src/index.ts";

const NUL = String.fromCharCode(0);

function context(files: Record<string, string>, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace: createMemoryWorkspace(files),
    cwd: ".",
    signal: new AbortController().signal,
    approve: async () => "allow-once",
    emit: () => {},
    toolCallId: "verify-call",
    attempt: 1,
    ...overrides,
  };
}

/** A line of N `a`s followed by `b` — the classic catastrophic-backtracking input. */
function evilLine(n: number): string {
  return `${"a".repeat(n)}b\n`;
}

const FILES: GrepFile[] = [
  { path: "src/a.ts", content: "const alpha = 1;\nconst beta = 2;\n" },
  { path: "src/b.ts", content: "function gamma() { return 'alpha'; }\n" },
];

describe("the scanner honours the abort signal", () => {
  it("a signal that is already aborted scans nothing", () => {
    const controller = new AbortController();
    controller.abort();

    const result = searchWithRegExp({
      files: FILES,
      pattern: "alpha",
      caseSensitive: true,
      signal: controller.signal,
    });

    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.stoppedBy).toBe("abort");
  });

  it("an abort that lands mid-scan stops the scan and keeps the partial list", () => {
    // The scan is synchronous, so a real abort can only arrive from a signal
    // whose `aborted` flips part-way through — which is exactly what the engine
    // does when the user hits stop while a long search runs. The check has to
    // happen *between lines*: 400 matching lines, the signal reads `false` for
    // the first 100 and `true` from then on, so the scan must stop at line 101
    // and report what it had.
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get: () => (reads++ < 100 ? false : true),
    });

    const result = searchWithRegExp({
      files: [{ path: "big.ts", content: "alpha\n".repeat(400) }],
      pattern: "alpha",
      caseSensitive: true,
      signal: controller.signal,
    });

    expect(result.truncated).toBe(true);
    expect(result.stoppedBy).toBe("abort");
    // Not 0: the 100 lines scanned before the abort are real matches, and
    // dropping them would make the truncation lossier than it has to be.
    expect(result.matches).toHaveLength(100);
    expect(result.matches[0]).toEqual({ path: "big.ts", line: 1, text: "alpha" });
  });

  it("a scan with a live signal runs to completion and is not flagged", () => {
    const result = searchWithRegExp({
      files: FILES,
      pattern: "alpha",
      caseSensitive: true,
      signal: new AbortController().signal,
    });

    expect(result.truncated).toBe(false);
    expect(result.stoppedBy).toBeUndefined();
    expect(result.matches).toHaveLength(2);
  });

  it("an abort that arrives after the last line is still seen", () => {
    // The per-line check reads `aborted` once per line; the post-loop check
    // reads it once more. A signal that reports `false` for the first three
    // reads and `true` for the fourth therefore isolates exactly the post-loop
    // check — which is what an abort arriving while the *last* line is being
    // matched looks like from inside the loop. Deleting it (mutation M7)
    // makes the scan report itself as complete.
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get: () => (reads++ < 3 ? false : true),
    });

    const result = searchWithRegExp({
      files: [{ path: "a.ts", content: "alpha\nbeta\nalpha\n" }],
      pattern: "alpha",
      caseSensitive: true,
      signal: controller.signal,
    });

    expect(result.truncated).toBe(true);
    expect(result.stoppedBy).toBe("abort");
    // Both matches were real and are kept; only the completion claim is cut.
    expect(result.matches).toHaveLength(2);
  });

  it("a scan over no lines at all still reports a post-loop abort", () => {
    // The zero-iteration case: the per-line check never runs, so the post-loop
    // check is the only thing that can see the signal.
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get: () => (reads++ < 0 ? false : true),
    });

    const result = searchWithRegExp({
      files: [],
      pattern: "alpha",
      caseSensitive: true,
      signal: controller.signal,
    });

    expect(result.truncated).toBe(true);
    expect(result.stoppedBy).toBe("abort");
    expect(result.matches).toEqual([]);
  });

  it("an abort on the last line keeps the matches and is still reported", () => {
    // Three lines, and the signal reports `false` for the first three probes
    // (one per line) and `true` for the fourth, which is the post-loop check.
    // The two matches are real and must be kept; only the completion claim is
    // cut.
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get: () => (reads++ < 3 ? false : true),
    });

    const result = searchWithRegExp({
      files: [{ path: "a.ts", content: "alpha\nbeta\nalpha\n" }],
      pattern: "alpha",
      caseSensitive: true,
      signal: controller.signal,
    });

    expect(result.truncated).toBe(true);
    expect(result.stoppedBy).toBe("abort");
    expect(result.matches).toHaveLength(2);
  });

  it("an abort raised during the last file read is still reported", async () => {
    // The defect: `scanCandidates` only observed `signal.aborted` at the TOP
    // of an iteration, so an abort raised during the final read ended the loop
    // normally and the result claimed a complete search. The read loop's
    // post-loop check covers that. It is not enough on its own, though — the
    // match loop sees the same signal and would report it anyway. The two
    // cases where only the read loop can know are the next two tests.
    const controller = new AbortController();
    const base = createMemoryWorkspace({ "a.ts": "hit\n" });
    const workspace: Workspace = {
      ...base,
      async readText(path) {
        const content = await base.readText(path);
        controller.abort();
        return content;
      },
    };

    const result = await grepTool.execute(context({}, { workspace, signal: controller.signal }), {
      pattern: "hit",
    });

    expect(controller.signal.aborted).toBe(true);
    expect(result.searchTruncated).toBe(true);
    expect(result.note ?? "").toMatch(/abort/);
  });

  it("an abort on the last read is reported even when the match loop has nothing to scan", async () => {
    // The single file is over the per-file cap and the workspace reports no
    // size (the real `DirectoryWorkspace` shape), so it IS read — the abort
    // lands on that read — and then dropped as oversized. `files` comes out
    // empty and `searchWithRegExp` iterates zero times, so it can only see the
    // signal through its own post-loop check. Both loops need that check, and
    // deleting either one alone (mutation M7) turns this result back into a lie.
    const controller = new AbortController();
    const base = createMemoryWorkspace({ "big.ts": `hit\n${"x".repeat(MAX_FILE_BYTES)}` });
    const workspace: Workspace = {
      ...base,
      walk(directory = ".", options = {}) {
        const inner = base.walk(directory, options);
        return {
          entries: {
            async *[Symbol.asyncIterator]() {
              for await (const entry of inner.entries) {
                const { size: _size, ...rest } = entry;
                yield rest;
              }
            },
          },
          get truncated() {
            return inner.truncated;
          },
          get visited() {
            return inner.visited;
          },
        };
      },
      async readText(path) {
        const content = await base.readText(path);
        controller.abort();
        return content;
      },
    };

    const result = await grepTool.execute(context({}, { workspace, signal: controller.signal }), {
      pattern: "hit",
    });

    expect(controller.signal.aborted).toBe(true);
    expect(result.filesScanned).toBe(0);
    expect(result.filesSkipped).toBe(1);
    expect(result.total).toBe(0);
    expect(result.searchTruncated).toBe(true);
    expect(result.note ?? "").toMatch(/abort/);
  });

  it("an abort on the last read of an otherwise clean search is reported by the read loop", async () => {
    // Here the match loop *does* have lines to scan, but it is entered with
    // the signal already aborted, so it stops before its first line. The read
    // loop is therefore the only one that finished its work, and the note has
    // to say so — the matcher's own wording ("stopped part-way through") would
    // be wrong, because the matcher never started.
    const controller = new AbortController();
    const base = createMemoryWorkspace({ "a.ts": "hit\n" });
    const workspace: Workspace = {
      ...base,
      async readText(path) {
        const content = await base.readText(path);
        controller.abort();
        return content;
      },
    };

    const result = await grepTool.execute(context({}, { workspace, signal: controller.signal }), {
      pattern: "hit",
    });

    // The file WAS read, so it is counted — the read loop finished its work and
    // only the abort afterwards stopped the search.
    expect(result.filesScanned).toBe(1);
    expect(result.searchTruncated).toBe(true);
    // The read loop's wording, not the matcher's: 1 of 1 candidates were read,
    // and the matcher then refused to scan them.
    expect(result.note).toMatch(/1 of 1 candidate files were read/);
    expect(result.note).not.toMatch(/stopped part-way/);
    // Nor the walk's: the walk completed and every candidate was found.
    expect(result.note).not.toMatch(/the walk stopped/);
  });

  it("an abort caught by the match loop is reported in the match loop's words", async () => {
    // The third of the three abort sites, and the one that is easiest to lose:
    // the walk finished, the read loop finished, and the matcher is what
    // stopped. The read loop's wording ("after N of M candidate files were
    // read") would be a false claim here — all of them *were* read.
    const controller = new AbortController();
    const base = createMemoryWorkspace({ "a.ts": "hit\nhit\nhit\n" });
    const signal = controller.signal;
    // The matcher can only be the one that sees an abort if the read loop's own
    // post-loop check saw `false` — so the flip is placed *between* the two
    // probes rather than at a fixed probe number. Counting from the read makes
    // that independent of how many probes the walk happens to make, which the
    // memory workspace's per-key signal check varies.
    //
    // After the read returns: probe +1 is the read loop's post-loop check
    // (must be false), probe +2 and onwards is the matcher (must be true).
    let reads = 0;
    let flipAt = Number.POSITIVE_INFINITY;
    Object.defineProperty(signal, "aborted", {
      configurable: true,
      get: () => {
        reads += 1;
        return reads >= flipAt;
      },
    });
    const workspace: Workspace = {
      ...base,
      async readText(path) {
        const content = await base.readText(path);
        // Let exactly one more probe go by — the read loop's post-loop check.
        flipAt = reads + 2;
        return content;
      },
    };

    const result = await grepTool.execute(context({}, { workspace, signal }), {
      pattern: "hit",
    });

    expect(result.filesScanned).toBe(1);
    expect(result.searchTruncated).toBe(true);
    expect(result.note).toMatch(/stopped part-way through/);
    // And NOT the read loop's claim: every candidate was read.
    expect(result.note).not.toMatch(/candidate files were read/);
  });

  it("an abort part-way through the files stops the read loop", async () => {
    // The signal fires during the second of three reads. `b.ts` was read to
    // completion before the abort landed, so it is scanned — claiming otherwise
    // would under-report real work. `c.ts` must never be read.
    const controller = new AbortController();
    const base = createMemoryWorkspace({ "a.ts": "hit\n", "b.ts": "hit\n", "c.ts": "hit\n" });
    const readPaths: string[] = [];
    const workspace: Workspace = {
      ...base,
      async readText(path) {
        readPaths.push(path);
        const content = await base.readText(path);
        if (readPaths.length === 2) controller.abort();
        return content;
      },
    };

    const result = await grepTool.execute(context({}, { workspace, signal: controller.signal }), {
      pattern: "hit",
    });

    expect(readPaths).toEqual(["a.ts", "b.ts"]);
    // The two files that were read before the abort are counted — claiming
    // otherwise would under-report work that happened.
    expect(result.filesScanned).toBe(2);
    // But the match loop honours the same signal and refuses to start, so
    // nothing is matched. That is the correct reading of an abort: stop, and
    // say you stopped.
    expect(result.total).toBe(0);
    expect(result.searchTruncated).toBe(true);
    expect(result.note).toMatch(/abort/);
    // The note must not claim more was read than was: 2 of 3 candidates.
    expect(result.note).toMatch(/2 of 3 candidate files/);
  });
});

describe("the scanner honours the wall clock", () => {
  it("a scan inside the budget reports a complete search", () => {
    const result = searchWithRegExp({
      files: FILES,
      pattern: "alpha",
      caseSensitive: true,
      timeoutMs: 5_000,
    });

    expect(result.truncated).toBe(false);
    expect(result.stoppedBy).toBeUndefined();
    expect(result.matches).toHaveLength(2);
  });

  it("a zero budget stops before the first line", () => {
    const result = searchWithRegExp({
      files: FILES,
      pattern: "alpha",
      caseSensitive: true,
      timeoutMs: 0,
    });

    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.stoppedBy).toBe("timeout");
  });

  it("a scan that used its whole budget on the last line is still complete", () => {
    // The opposite error, and the one a naive "check the clock after the loop"
    // fix introduces. A scan that ran every line to the end has *finished*;
    // reporting it as truncated would train the model to ignore
    // `searchTruncated`, which is worse than never reporting it.
    //
    // The per-line check is what fires here, and that is the point: there is no
    // post-loop clock check, because it could not fire. A loop that reached its
    // end was under budget on every line it checked, so by the time it ends the
    // elapsed time is the sum of many individually-small checks. Pinned here so
    // that adding such a branch has to confront this test.
    const result = searchWithRegExp({
      files: [{ path: "a.ts", content: "alpha\nalpha\n" }],
      pattern: "alpha",
      caseSensitive: true,
      timeoutMs: 5_000,
    });

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.stoppedBy).toBeUndefined();
  });

  it("the partial matches found before the timeout are kept, and flagged", () => {
    // 2000 lines through a pattern slow enough to blow a 0 ms budget after the
    // first line. Whatever was found is real; it is labelled as partial.
    const result = searchWithRegExp({
      files: [{ path: "big.ts", content: "alpha\n".repeat(2000) }],
      pattern: "alpha",
      caseSensitive: true,
      timeoutMs: 0,
    });

    expect(result.truncated).toBe(true);
    expect(result.stoppedBy).toBe("timeout");
    // Zero budget ⇒ nothing was allowed to run. The matches are still `[]`,
    // not a lie about a partial scan.
    expect(result.matches).toEqual([]);
  });

  it("the tool routes its budget into the scanner and reports a cut", async () => {
    // 2000 lines through a 1 ms budget: the loop must stop between lines and
    // the result must say why. This is the wiring the tool owns — a model
    // cannot pass `timeoutMs`, so the only way this could regress is if
    // `executeGrep` stopped passing the constant.
    const ctx = context({ "big.ts": "alpha\n".repeat(2000) });
    const result = await executeGrep(ctx, { pattern: "alpha" }, { timeoutMs: 1 });

    expect(result.searchTruncated).toBe(true);
    expect(result.hint).toMatch(/match budget ran out/);
    expect(result.note).toMatch(/Matching stopped after 1 ms/);
  });

  it("a scan stopped by the budget keeps the matches it really found", () => {
    // The partial list is the point, and the budget has to expire at a CHOSEN
    // line rather than at whichever one this machine reaches in 5 ms.
    //
    // The first version derived its expectation from wall-clock timing: "20 000
    // lines cost ~14 ms on this machine, so 5 ms cuts it in the middle". It
    // passed four local runs and failed in CI. Not because the scanner changed
    // - because the runner got through all 20 000 lines INSIDE the budget, so
    // searchTruncated was false and the assertion below broke. The failure mode
    // is speed, in both directions, and neither one is about the code under
    // test. Second time in this project that a measurement tool lied instead of
    // staying silent.
    // FOUR lines, not five, and the off-by-one is the behaviour rather than a
    // slip: `startedAt` consumes the clock's first reading, and every line reads
    // the clock BEFORE it is processed. So a 5 ms budget spent at 1 ms per line
    // trips on the check that precedes the fifth line, and that fifth line is
    // never scanned. Processing it anyway would be spending the budget and then
    // buying work with it. Do not "fix" this to five.
    const CUT_AFTER_LINES = 4;
    const content = "const alpha = 1; const beta = 2;\n".repeat(2_000);
    let tick = 0;
    const result = searchWithRegExp({
      files: [{ path: "big.ts", content }],
      pattern: "\\w+\\s*=\\s*\\w+;?$",
      caseSensitive: true,
      timeoutMs: 5,
      now: () => tick++,
    });

    expect(result.truncated).toBe(true);
    expect(result.stoppedBy).toBe("timeout");
    // Exactly the lines before the cut, no more: a prefix, not "all of them".
    expect(result.matches).toHaveLength(CUT_AFTER_LINES);
    expect(result.matches[0]).toEqual({
      path: "big.ts",
      line: 1,
      text: "const alpha = 1; const beta = 2;",
    });
  });

  it("the budget expires on a chosen line, whatever the host's speed", () => {
    // The property the test above used to assume. Same input, clocks with
    // wildly different step sizes, one answer.
    const content = "const alpha = 1;\n".repeat(200);
    const run = (step: number) => {
      let tick = 0;
      return searchWithRegExp({
        files: [{ path: "a.ts", content }],
        pattern: "const",
        caseSensitive: true,
        timeoutMs: 5,
        now: () => tick++ * step,
      });
    };

    // 1 ms per line against a 5 ms budget: the check preceding the fifth line
    // trips, so four lines are scanned. Same off-by-one as above, and the same
    // reason - a future reader will try to "fix" this to five.
    const oneMs = run(1); // 4 lines
    const tenMs = run(10); // 0 lines - the budget is gone before the first
    const never = run(0); // the clock does not move, so the budget is never spent

    expect(oneMs.truncated).toBe(true);
    expect(oneMs.matches).toHaveLength(4);
    expect(tenMs.truncated).toBe(true);
    expect(tenMs.matches).toHaveLength(0);
    // A clock that stands still is a fact about the INPUT, not a bug: the scan
    // finishes, and it says so instead of claiming a truncation that did not
    // happen. This is the same lie grep spent a whole block removing.
    expect(never.truncated).toBe(false);
    expect(never.matches).toHaveLength(200);
  });

  it("a catastrophic pattern on many lines is cut between lines", async () => {
    // The case the timeout exists for. One 300 ms line repeated 400 times is
    // two minutes of work; the budget turns it into 1 s and a partial answer.
    const content = evilLine(24).repeat(400);
    const result = await executeGrep(context({ "many.txt": content }), { pattern: "(a+)+$" }, {
      timeoutMs: 1_000,
    });

    expect(result.searchTruncated).toBe(true);
    expect(result.hint).toMatch(/match budget ran out/);
    expect(result.total).toBe(0);
  }, 60_000);

  it("the model cannot raise the budget through the schema", async () => {
    // zod objects are non-strict by default, so an unknown key is *stripped*
    // rather than rejected — the model gets no error, but it also gets no
    // effect: `executeGrep` reads the bound from its own parameter, and
    // `timeoutMs` never reaches it. Both halves are asserted, because a schema
    // that merely errors would also be correct but would teach the model the
    // wrong thing about what it may send.
    const parsed = grepInputSchema.safeParse({ pattern: "x", timeoutMs: 999_999 });
    expect(parsed.success).toBe(true);
    expect("timeoutMs" in (parsed.data ?? {})).toBe(false);

    // And the default the tool actually uses is the exported constant.
    expect(SEARCH_TIMEOUT_MS).toBe(5_000);
    const result = await grepTool.execute(context({ "a.ts": "hit\n" }), { pattern: "hit" });
    expect(result.searchTruncated).toBe(false);
  });
});

describe("the residual risk: one line that never returns", () => {
  // A single `RegExp.test` cannot be interrupted from the inside, so the
  // timeout bounds the *loop*, not one evaluation. This is stated rather than
  // fixed, and the measurement is kept in a test so the claim stays honest: if
  // a future engine made `(a+)+$` cheap, the growth assertion would fail and
  // this note would be wrong.
  it("cost grows exponentially with the line length", () => {
    const cost = (n: number): number => {
      const re = new RegExp("(a+)+$");
      const startedAt = Date.now();
      re.test(`${"a".repeat(n)}b`);
      return Date.now() - startedAt;
    };
    const small = cost(20);
    const large = cost(24);

    expect(large).toBeGreaterThan(small);
  }, 60_000);

  it("a line long enough to hang is bounded by the per-file cap, not the loop check", () => {
    // 20 lines of `a`×24 ≈ 6 s of backtracking; the timeout cuts the loop after
    // a few. ONE line of `a`×100 000 would not return at all, and nothing in
    // this function can stop it — the mitigations are the 1 MiB per-file cap
    // and the fact that `MAX_LINE_LENGTH` bounds what is *returned*. This test
    // documents the boundary rather than testing a hang.
    expect(MAX_FILE_BYTES).toBe(1024 * 1024);
    expect(MAX_LINE_LENGTH).toBe(500);
  });
});

describe("complete searches are not mislabelled as truncated", () => {
  it("a search with matches, no cap reached and no abort is complete", async () => {
    const result = await grepTool.execute(context({ "a.ts": "hit\nhit\n", "b.ts": "hit\n" }), {
      pattern: "hit",
    });

    expect(result.total).toBe(3);
    expect(result.searchTruncated).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
    expect(result.note).toBeUndefined();
  });

  it("`truncated` and `searchTruncated` mean different things and both are set independently", async () => {
    const result = await grepTool.execute(context({ "a.ts": "h\nh\nh\n" }), { pattern: "h", limit: 1 });

    // `limit` cut the list; the search itself looked at everything.
    expect(result.truncated).toBe(true);
    expect(result.searchTruncated).toBe(false);
  });
});

describe("binary detection still works next to the new bounds", () => {
  it("a NUL-containing file is skipped, not matched", async () => {
    const result = await grepTool.execute(context({ "a.ts": `x${NUL}hit\n` }), { pattern: "hit" });

    expect(result.filesSkipped).toBe(1);
    expect(result.filesScanned).toBe(0);
    expect(result.matches).toEqual([]);
  });
});

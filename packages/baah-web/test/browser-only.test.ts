/**
 * The browser-only gate's self-test, and it is the part that makes the gate mean
 * something.
 *
 * ## Scope, and why it is narrow on purpose
 *
 * This file tests the **pure** part: `scanBrowserOnly`, `stripCommentsAndStrings`,
 * `verifyRepository`. It **cannot** read the repository, because `baah-web`'s
 * TypeScript program has `"types": ["vite/client"]` and no `@types/node` — and
 * adding Node types there is §2's failure mode, in the very package that must not
 * have them. The first version of this gate imported `node:fs` and put `pnpm check`
 * into **12 compile errors** on the commit that introduced it.
 *
 * So the repository-level assertions live in `verifyRepository`, which the CLI
 * runs on **every** `pnpm check`. That is strictly better than a test: it cannot be
 * forgotten, and it needs no fixture to remember to point at the real tree.
 *
 * ## What this file is for
 *
 * A gate that only lists **forbidden** constructs is half a gate. Delete the
 * persistence layer and it passes, because nothing forbidden was imported — a
 * green gate that proves nothing. This project has hit that shape seven times in
 * different clothes: the truncated `grep` search reported as complete, the model
 * list that silently paginated once, 44 green E2E tests that never looked at a
 * phone, a screenshot harness that would have skipped everything and exit 0.
 *
 * And the required half only carries the requirement if it can tell the **target
 * state** from **zero**. That is what `project-folder` is for.
 *
 * ## Three mistakes these tests caught, all in the gate's reading rules
 *
 * 1. **An import specifier is a string literal.** A scanner that blanks strings is
 *    blind to every `node:fs` import in the repository, and reported itself as
 *    coverage. Forbidden rules got a `where`.
 * 2. **A query string is a string literal too** — same mistake one half a file
 *    away, going the other direction: `@sqlite.org/sqlite-wasm` and `?worker&url`
 *    were `code` alternatives, so they could never match, and the gate reported
 *    `browser-database` as missing on a repository that has it. **A gate that lies
 *    about absence gets its absence report ignored**, which is the same failure as
 *    a gate that lies about violations.
 * 3. `AGENTS.md` §2a said File System Access **or** OPFS. OPFS has
 *    `getFileHandle`, so an app with no folder at all satisfied a capability that
 *    exists to say the folder must be there. Two things are not one thing.
 *
 * Planted tokens are assembled from fragments: the stripper blanks string bodies,
 * so a planted token inside a string is invisible to the scan, and fragments keep
 * that true even if somebody later scans test trees.
 */

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_IDS,
  KNOWN_UNSATISFIED,
  REQUIRED,
  stripCommentsAndStrings,
  verifyRepository,
  type Report,
} from "../../../scripts/browser-only.ts";

/**
 * Satisfies **all** required capabilities and breaks none of the forbidden ones.
 *
 * The forbidden-rule tests are only about the forbidden half, so they need this
 * filler to keep the halves apart. An earlier two-capability filler made eleven
 * tests fail for a reason that had nothing to do with what they were checking — a
 * test that measures one thing and asserts another measures noise.
 */
const ALL_CAPABILITIES = [
  `import sqlite3InitModule from "@sqlite.org/sqlite-wasm";`,
  `const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });`,
  `const dir = await navigator.storage.getDirectory();`,
  `const handle = await showDirectoryPicker();`,
  `localStorage.getItem("k");`,
  `await sqlite3InitModule(); void dir; void handle; void worker;`,
].join("\n");

/** Everything except the one capability that is known not to be met yet. */
const ALL_BUT_PROJECT_FOLDER = ALL_CAPABILITIES
  .split("\n")
  .filter((line) => !line.includes("showDirectoryPicker"))
  .join("\n");

/**
 * Scan a planted source **alongside** the all-capabilities filler.
 *
 * The filler lives under its own path. It shared `packages/x/src/a.ts` with the
 * planted sources at first, and because a later spread key overwrites an earlier
 * one the filler was simply **replaced** — so seventeen tests failed on a missing
 * capability that had never been there. A helper that silently discards the setup
 * it is supposed to provide is worse than no helper: every failure points at the
 * rule under test instead of at the harness.
 */
const scan = (sources: Record<string, string>): Report =>
  verifyRepository({ "packages/x/src/filler.ts": ALL_CAPABILITIES, ...sources });

describe("the gate reads code the way code is written", () => {
  it("a capability that lives in a STRING is matched in raw source", () => {
    // The mistake the audit found: `@sqlite.org/sqlite-wasm` and `?worker&url` are
    // string contents, so they cannot match in blanked source. Both are the real
    // repository's spelling, and the gate reported them missing.
    const report = scan({
      "packages/baah-storage/src/worker.ts": [
        `import sqlite3InitModule from "@sqlite.org/sqlite-wasm";`,
        `import workerUrl from "./worker.ts?worker&url";`,
      ].join("\n"),
    });
    expect(report.satisfied["browser-database"]).toBeDefined();
    expect(report.satisfied["database-off-main-thread"]).toBeDefined();
  });

  it("the identifier alone is enough for browser-database", () => {
    const report = scan({ "packages/x/src/w.ts": `await sqlite3InitModule();\n` });
    expect(report.satisfied["browser-database"]).toBeDefined();
  });

  it("project-folder is NOT satisfied by OPFS's own getFileHandle", () => {
    // The third mistake. §2a said "FSAA **or** OPFS", and OPFS has
    // `getFileHandle`, so an app with no folder at all passed a capability whose
    // whole job is to say the folder must be there.
    const report = verifyRepository({
      "packages/x/src/a.ts": [
        `const root = await navigator.storage.getDirectory();`,
        `const file = await root.getFileHandle("baah.sqlite3", { create: true });`,
        `await sqlite3InitModule();`,
        `new Worker(url);`,
        `localStorage.getItem("k");`,
      ].join("\n"),
    });
    expect(report.violations).toEqual([]);
    expect(report.satisfied["origin-private-storage"]).toBeDefined();
    expect(report.satisfied["project-folder"]).toBeUndefined();
    expect(report.missing).toContain("project-folder");
  });

  it("showDirectoryPicker alone satisfies project-folder", () => {
    expect(scan({ "packages/x/src/a.ts": `await showDirectoryPicker();\n` }).missing).toEqual([]);
  });
});

describe("the forbidden half catches planted material", () => {
  const cases: readonly { readonly name: string; readonly code: string }[] = [
    { name: "node-fs", code: `import fs from "${["node", "fs"].join(":")}";` },
    { name: "node-fs", code: `import { readFile } from "${["node", "fs/promises"].join(":")}";` },
    { name: "node-path", code: `import path from "${["node", "path"].join(":")}";` },
    { name: "node-net", code: `import http from "${["node", "http"].join(":")}";` },
    { name: "node-net", code: `import { spawn } from "${["node", "child_process"].join(":")}";` },
    { name: "node-process-global", code: `const key = process.env.OPENAI_API_KEY;` },
    { name: "node-process-global", code: `export const cwd = process.cwd();` },
    { name: "node-buffer", code: `const b = Buffer.from("x", "utf8");` },
    { name: "commonjs-require", code: `const fs = require("fs");` },
    { name: "server-listen", code: `const server = createServer(handler); server.listen(8080);` },
    { name: "server-listen", code: `Deno.serve(() => new Response("hi"));` },
    { name: "own-transport", code: `const ws = new WebSocket("wss://example.invalid");` },
    { name: "own-transport", code: `const es = new EventSource("/events");` },
    { name: "own-origin-fetch", code: `await fetch("/api/sessions", { method: "POST" });` },
  ];

  for (const { name, code } of cases) {
    it(`flags ${name} in: ${code.slice(0, 52)}…`, () => {
      const report = scan({ "packages/x/src/a.ts": code });
      // Asserted first, so a failure says which half is wrong rather than
      // reporting a violation that was never looked for.
      expect(report.missing).toEqual([]);
      expect(report.violations.map((v) => v.rule)).toContain(name);
    });
  }

  it("a provider fetch at an absolute URL is not a violation", () => {
    // The rule is about OUR origin. A provider call is the whole point of the app.
    for (const url of ["https://api.openai.com/v1/chat/completions", "https://e2e.invalid/v1/models"]) {
      const report = scan({ "packages/x/src/a.ts": `await fetch("${url}");` });
      expect(report.violations, url).toEqual([]);
    }
  });

  it("reports one planted mistake once, not twice under two rules", () => {
    const report = scan({ "packages/x/src/a.ts": `import { readFile } from "node:fs/promises";\n` });
    expect(report.violations.map((v) => v.rule)).toEqual(["node-fs"]);
  });

  it("finds a specifier however the import is spelled", () => {
    for (const code of [
      `import fs from "node:fs";`,
      `import "node:fs";`,
      `const m = await import("node:fs");`,
      `const fs = require("node:fs");`,
    ]) {
      expect(scan({ "packages/x/src/a.ts": code }).violations.map((v) => v.rule), code).toContain(
        "node-fs",
      );
    }
  });

  it("reports the line, so a violation can be found without grepping", () => {
    const report = scan({
      "packages/x/src/a.ts": "const a = 1;\nconst b = 2;\nimport fs from \"node:fs\";\n",
    });
    expect(report.violations[0]?.line).toBe(3);
    expect(report.violations[0]?.file).toBe("packages/x/src/a.ts");
  });
});

describe("the required half is not satisfied by nothing", () => {
  it("a source set with no browser capability at all fails on every one", () => {
    const report = verifyRepository({
      "packages/api/src/server.ts": `const app = createServer(handler);\napp.listen(3000);\n`,
    });
    expect([...report.missing].sort()).toEqual([...CAPABILITY_IDS].sort());
  });

  it("an empty source set is not a pass either", () => {
    const report = verifyRepository({});
    expect(report.filesScanned).toBe(0);
    expect(report.missing).toHaveLength(CAPABILITY_IDS.length);
    expect(report.problems.length).toBeGreaterThan(0);
  });

  it("records which file satisfied each capability, so the report is readable", () => {
    // Deliberately **not** `scan()`: the all-capabilities filler would win the
    // race and the assertion would name the filler instead of the planted file.
    const report = verifyRepository({
      "packages/baah-storage/src/w.ts": `import sqlite3InitModule from "@sqlite.org/sqlite-wasm";\n`,
    });
    expect(report.satisfied["browser-database"]).toBe("packages/baah-storage/src/w.ts");
  });
});

/**
 * A local stand-in for `KNOWN_UNSATISFIED`.
 *
 * The first version of these tests used the **production** entry, so deleting it —
 * which is precisely what the gate demanded the moment the project folder was wired —
 * turned two mechanism tests red. The mechanism is a rule **about the object**, so it
 * must be testable with any object. A test welded to live data breaks when the data
 * gets fixed, and the failure then looks like the fix was wrong.
 */
const A_TRACKED_GAP: Readonly<Record<string, string>> = {
  "project-folder":
    "Stand-in for a tracked gap. Long enough to satisfy the reason check, which is " +
    "the point: a list entry without a reason is an explanation nobody can act on.",
};

describe("the known-unsatisfied list cannot rot in either direction", () => {
  it("a tracked gap does not become a problem", () => {
    // The load-bearing half. A gate that fails for a *tracked* gap is a gate people
    // learn to skip, and then it protects nothing.
    const report = verifyRepository({ "packages/x/src/a.ts": ALL_BUT_PROJECT_FOLDER }, A_TRACKED_GAP);
    expect(report.missing).toContain("project-folder");
    expect(report.problems).toEqual([]);
  });

  it("a tracked gap that got FIXED is a problem, so the entry cannot go stale", () => {
    const report = verifyRepository({ "packages/x/src/a.ts": ALL_CAPABILITIES }, A_TRACKED_GAP);
    expect(report.missing).toEqual([]);
    expect(report.problems).toContainEqual(expect.stringContaining("delete the entry"));
  });

  it("an untracked gap is a problem", () => {
    const report = verifyRepository({ "packages/x/src/a.ts": `const a = 1;\n` });
    expect(report.problems.join("\n")).toContain("untracked missing capability");
    expect(report.problems.join("\n")).toContain("origin-private-storage");
  });

  it("an entry that is not a capability is a problem", () => {
    // Otherwise a typo in the list silences a real gap forever: it is "tracked", so it
    // is not reported as missing, and the reverse check never fires because the id can
    // never become satisfied. A list that cannot fail is a comment.
    const report = verifyRepository(
      { "packages/x/src/a.ts": ALL_CAPABILITIES },
      { "project-folderr": "A typo. Silent forever if this check does not exist." },
    );
    expect(report.problems.join("\n")).toContain("is not a capability");
  });

  it("an entry without a real reason is a problem", () => {
    const report = verifyRepository(
      { "packages/x/src/a.ts": ALL_BUT_PROJECT_FOLDER },
      { "project-folder": "todo" },
    );
    expect(report.problems.join("\n")).toContain("needs a reason");
  });

  it("every entry in the real list names a real capability and carries a reason", () => {
    // The production list is **empty** right now, and this is what makes that a fact
    // rather than an assumption: it iterates whatever is there, so an entry added later
    // is checked by the same two rules that are exercised above with a fixture.
    for (const [id, reason] of Object.entries(KNOWN_UNSATISFIED)) {
      expect(REQUIRED.some((c) => c.id === id), `${id} is not a capability`).toBe(true);
      expect(reason.length, `${id} needs a reason`).toBeGreaterThan(60);
    }
  });

  it("the capability list is non-empty and every id is unique", () => {
    expect(CAPABILITY_IDS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(CAPABILITY_IDS).size).toBe(CAPABILITY_IDS.length);
  });
});


describe("the documented limit: deletion yes, miswiring no", () => {
  it("a remote call BESIDE an untouched database import passes both halves", () => {
    // Measured before it was documented, and kept as a test so the documentation
    // cannot quietly become false. What passes is a *remote* call to an absolute
    // URL next to the database import — indistinguishable, from source text, from
    // a provider call. Claiming otherwise would be overclaiming, which is the
    // defect this project has spent the session fixing.
    //
    // Built on the "all but project-folder" base, so the only missing capability is
    // the tracked one. Asserting `missing` on a source set that lacked four
    // capabilities in the first place would have been a test about the fixture.
    const report = verifyRepository({
      "packages/baah-storage/src/w.ts": [
        ALL_BUT_PROJECT_FOLDER,
        `await fetch("https://sync.example.invalid/turns", { method: "POST" });`,
      ].join("\n"),
    });
    expect(report.violations).toEqual([]);
    expect(report.missing).toEqual(["project-folder"]);
  });

  it("a same-origin call IS caught even beside the database import", () => {
    const report = verifyRepository({
      "packages/baah-storage/src/w.ts": [
        `import sqlite3InitModule from "@sqlite.org/sqlite-wasm";`,
        `await fetch("/api/sessions", { method: "POST" });`,
      ].join("\n"),
    });
    expect(report.violations.map((v) => v.rule)).toContain("own-origin-fetch");
  });
});

describe("prose about a forbidden API is not a violation", () => {
  it("ignores comments", () => {
    const report = scan({
      "packages/x/src/a.ts": "/** we do NOT use node:fs here, see AGENTS.md §2 */\nconst a = 1;\n",
    });
    expect(report.violations).toEqual([]);
  });

  it("ignores strings", () => {
    expect(scan({ "packages/x/src/a.ts": `const msg = "createServer is banned";\n` }).violations).toEqual([]);
  });

  it("still flags the same token in code, one line later", () => {
    const report = scan({
      "packages/x/src/a.ts": `const msg = "createServer is banned";\nconst s = createServer(h);\n`,
    });
    expect(report.violations.map((v) => v.rule)).toEqual(["server-listen"]);
  });
});

describe("the stripper the other gates share", () => {
  it("preserves offsets and newlines, so line numbers stay true", () => {
    const src = "a\n// comment\nb\n";
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain("a");
    expect(out).not.toContain("comment");
  });

  it("does not treat a regex literal as a string", () => {
    // A `//` inside a regex is not a line comment. Getting this wrong blanks the
    // rest of the file and hides a real violation after it.
    const out = stripCommentsAndStrings("const re = /a\\/\\/b/g;\nconst after = 1;\n");
    expect(out).toContain("const after");
  });
});
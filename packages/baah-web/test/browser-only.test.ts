/**
 * The browser-only gate's self-test, and it is the part that makes the gate mean
 * something.
 *
 * ## The problem this file exists for
 *
 * A gate that only lists **forbidden** constructs is half a gate. Delete the
 * persistence layer and it passes, because nothing forbidden was imported. That
 * is a green gate that proves nothing — and this project has now hit that shape
 * seven times in different clothes: the truncated `grep` search reported as
 * complete, the model list that silently paginated once, 44 green E2E tests that
 * never looked at a phone, a screenshot harness that would have skipped
 * everything and still exited 0.
 *
 * So this gate has a **required** half as well, and that is the half that
 * carries the requirement: the browser capabilities the project is defined by
 * must be *in use*. A server-backed persistence layer satisfies the forbidden
 * half perfectly and fails the required half completely.
 *
 * ## What each test is for
 *
 * 1. the reader really reads the repository, and the repository passes — so a
 *    broken scan cannot look like a clean bill of health;
 * 2. the forbidden half catches **planted** material, one rule at a time;
 * 3. the required half has teeth: a source set with no browser capability at all
 *    must report **all five** missing. Without this, a gate that had lost its
 *    required list would pass silently.
 *
 * The planted sources are assembled from fragments. That is not superstition:
 * the stripper blanks string bodies, so a planted token inside a string is
 * invisible to the scan, and building from fragments keeps that true even if
 * somebody later scans test trees too.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { collectSources, scanBrowserOnly, stripCommentsAndStrings } from "../../../scripts/browser-only.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** Every `src/` source in the repository, keyed by repo-relative path. */
function realSources(): Record<string, string> {
  return collectSources(REPO_ROOT);
}

describe("the browser-only gate reads the repository", () => {
  it("finds the sources rather than matching nothing", () => {
    const sources = realSources();
    // A vacuous pass is the failure mode. Eleven packages have a src/ tree, and
    // a threshold of 50 is low enough never to be the thing that breaks and high
    // enough that "the glob silently matched nothing" cannot pass.
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(Object.keys(sources).some((p) => p.includes("baah-core/"))).toBe(true);
    expect(Object.keys(sources).some((p) => p.includes("baah-storage/"))).toBe(true);
    expect(Object.keys(sources).some((p) => p.includes("baah-tools/"))).toBe(true);
  });

  it("does not read test trees, which would scan planted material", () => {
    const sources = realSources();
    const testish = Object.keys(sources).filter(
      (p) => p.includes("/test/") || p.includes(".test.") || p.includes("scripts/"),
    );
    expect(testish).toEqual([]);
  });

  it("the repository itself passes: no server form, all required capabilities in use", () => {
    const report = scanBrowserOnly(realSources());
    const detail = [
      ...report.violations.map((v) => `${v.rule} in ${v.file}:${v.line} (${v.text})`),
      ...report.missing.map((id) => `missing capability: ${id}`),
    ].join("\n");
    expect(detail).toBe("");
    expect(report.filesScanned).toBeGreaterThan(50);
  });
});

/**
 * A source that satisfies **all five** required capabilities and breaks none of
 * the forbidden ones.
 *
 * The forbidden-rule tests below are only about the forbidden half, so they need
 * this filler to keep the two halves apart. The first version used a two-line
 * filler that satisfied only two capabilities, and eleven tests failed for a
 * reason that had nothing to do with what they were checking — a test that
 * measures one thing and asserts another is a test that measures noise.
 */
const ALL_CAPABILITIES = [
  `import sqlite3InitModule from "@sqlite.org/sqlite-wasm";`,
  `const dir = await navigator.storage.getDirectory();`,
  `const handle = await showDirectoryPicker();`,
  `localStorage.getItem("k");`,
  `const worker = new Worker(new URL("./w.ts", import.meta.url), { type: "module" });`,
  `await sqlite3InitModule(); void dir; void handle; void worker;`,
].join("\n");

describe("the forbidden half catches planted material", () => {
  const cases: readonly { readonly name: string; readonly code: string }[] = [
    { name: "node-fs", code: `import fs from "${["node", "fs"].join(":")}";` },
    { name: "node-fs", code: `import { readFile } from "${["node", "fs/promises"].join(":")}";` },
    { name: "node-path", code: `import path from "${["node", "path"].join(":")}";` },
    { name: "node-net", code: `import http from "${["node", "http"].join(":")}";` },
    { name: "node-net", code: `import { spawn } from "${["node", "child_process"].join(":")}";` },
    { name: "node-process-global", code: `const key = process.env.OPENAI_API_KEY;` },
    { name: "commonjs-require", code: `const fs = require("fs");` },
    { name: "server-listen", code: `const server = createServer(handler); server.listen(8080);` },
    { name: "server-listen", code: `Deno.serve(() => new Response("hi"));` },
    { name: "own-transport", code: `const ws = new WebSocket("wss://example.invalid");` },
    { name: "own-transport", code: `const es = new EventSource("/events");` },
  ];

  for (const { name, code } of cases) {
    it(`flags ${name} in: ${code.slice(0, 48)}…`, () => {
      const report = scanBrowserOnly({ "packages/x/src/a.ts": ALL_CAPABILITIES + "\n" + code });
      // Asserted first, so a failure says which half is wrong rather than
      // reporting a violation that was never looked for.
      expect(report.missing).toEqual([]);
      expect(report.violations.map((v) => v.rule)).toContain(name);
    });
  }

  it("reports the line, so a violation can be found without grepping", () => {
    const report = scanBrowserOnly({
      "packages/x/src/a.ts": "const a = 1;\nconst b = 2;\nimport fs from \"node:fs\";\n",
    });
    expect(report.violations[0]?.line).toBe(3);
    expect(report.violations[0]?.file).toBe("packages/x/src/a.ts");
  });

  it("reports one planted mistake once, not twice under two rules", () => {
    // A gate that reports the same violation twice trains the reader to skip
    // lines. `node:fs/promises` is filesystem-only, so it must not also light up
    // the network rule.
    const report = scanBrowserOnly({
      "packages/x/src/a.ts": `import { readFile } from "node:fs/promises";\n`,
    });
    expect(report.violations.map((v) => v.rule)).toEqual(["node-fs"]);
  });

  it("finds a specifier however the import is spelled", () => {
    // Four spellings, one rule. The stripper blanks string bodies, so a
    // specifier is only ever visible to a raw-source rule anchored to an import
    // position — which means the anchor has to cover all of these, or the gate
    // is blind to the one the codebase happens to use.
    const spellings = [
      `import fs from "node:fs";`,
      `import "node:fs";`,
      `const m = await import("node:fs");`,
      `const fs = require("node:fs");`,
    ];
    for (const code of spellings) {
      const report = scanBrowserOnly({ "packages/x/src/a.ts": code });
      expect(report.violations.map((v) => v.rule), code).toContain("node-fs");
    }
  });
});

describe("prose about a forbidden API is not a violation", () => {
  it("ignores comments", () => {
    const report = scanBrowserOnly({
      "packages/x/src/a.ts": "/** we do NOT use node:fs here, see AGENTS.md §2 */\nconst a = 1;\n",
    });
    expect(report.violations).toEqual([]);
  });

  it("ignores strings", () => {
    const report = scanBrowserOnly({
      "packages/x/src/a.ts": `const msg = "createServer is banned";\n`,
    });
    expect(report.violations).toEqual([]);
  });

  it("still flags the same token in code, one line later", () => {
    const report = scanBrowserOnly({
      "packages/x/src/a.ts": `const msg = "createServer is banned";\nconst s = createServer(h);\n`,
    });
    expect(report.violations.map((v) => v.rule)).toEqual(["server-listen"]);
  });
});

describe("the required half has teeth", () => {
  it("a source set with no browser capability at all fails on all five", () => {
    // The load-bearing test of the whole file. A server-backed persistence layer
    // would sail past every forbidden rule in this gate, and this is the only
    // assertion that says so out loud.
    const report = scanBrowserOnly({
      "packages/api/src/server.ts": `const app = createServer(handler);\napp.listen(3000);\n`,
    });
    expect(report.missing.sort()).toEqual([
      "browser-database",
      "database-off-main-thread",
      "filesystem-access",
      "origin-private-storage",
      "web-storage",
    ]);
  });

  it("an empty source set is not a pass either", () => {
    // The vacuous case. An empty map must not read as "no problems found".
    const report = scanBrowserOnly({});
    expect(report.filesScanned).toBe(0);
    expect(report.missing).toHaveLength(5);
  });

  it("a browser-resident database satisfies the half a server cannot", () => {
    const report = scanBrowserOnly({
      "packages/baah-storage/src/worker.ts": [
        `import sqlite3InitModule from "@sqlite.org/sqlite-wasm";`,
        `const dir = await navigator.storage.getDirectory();`,
        `const handle = await showDirectoryPicker();`,
        `localStorage.getItem("k");`,
        `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });`,
      ].join("\n"),
    });
    expect(report.missing).toEqual([]);
    expect(report.violations).toEqual([]);
  });

  it("records which file satisfied each capability, so the report is readable", () => {
    const report = scanBrowserOnly({
      "packages/baah-storage/src/w.ts": `import sqlite3InitModule from "@sqlite.org/sqlite-wasm";\n`,
    });
    expect(report.satisfied["browser-database"]).toBe("packages/baah-storage/src/w.ts");
  });
});

describe("the stripper the other gates share", () => {
  it("preserves offsets and newlines, so line numbers stay true", () => {
    const src = 'a\n// comment\nb\n';
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain("a");
    expect(out).not.toContain("comment");
  });

  it("does not treat a regex literal as a string", () => {
    // A `//` inside a regex is not a line comment. Getting this wrong would blank
    // the rest of the file and hide a real violation after it.
    const out = stripCommentsAndStrings('const re = /a\\/\\/b/g;\nconst after = 1;\n');
    expect(out).toContain("const after");
  });
});

describe("the gate is wired where it can be run", () => {
  it("the script exists at the path the self-test imports", () => {
    expect(existsSync(new URL("../../../scripts/browser-only.ts", import.meta.url).pathname)).toBe(true);
  });
});

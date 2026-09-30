/**
 * The browser-only rule, made executable — and checkable in one command, so
 * "we are still browser-only" is an answer rather than an intention.
 *
 * ## Why this is a script and not a test in a package
 *
 * It has to scan `src/` in **every** package, including the ten tool packages.
 * `import.meta.glob("/src/**")` is rooted at one package, and §4 forbids a
 * package reaching into another one's tree — which is why the comment/string
 * stripper in the existing gates is duplicated four times rather than shared.
 * Duplicating a **repo-wide** gate seven times would be the same mistake with a
 * worse ratio, so this lives at the root and reads the tree with `node:fs`.
 *
 * That `node:fs` is the **only** one in the repository outside a test harness,
 * and it is the §2 exception read at its literal scope: the rule is about the
 * **runtime**, and this file is not shipped. It is checked by
 * `packages/baah-web/test/browser-only.test.ts`, which never touches the disk —
 * it calls {@link scanBrowserOnly} on strings, including planted ones.
 *
 * ## What it checks, and why it checks two things
 *
 * A list of forbidden imports is the obvious version and it is **half a gate**.
 * Delete the persistence layer and it passes, because nothing forbidden was
 * imported. That is a green gate that proves nothing — the failure this project
 * has now hit seven times in a different costume (the truncated `grep` search, the
 * skipped model list, the 44 green tests that never looked at a phone).
 *
 * So there are two halves, and **both** must hold:
 *
 *   1. **Forbidden** — no Node builtin, no server form, no raw socket in any
 *      `src/`. This is the half that reads like a rule.
 *   2. **Required** — the browser capabilities the project is *defined* by must
 *      actually be in use: File System Access, OPFS, a browser-resident database,
 *      that database off the main thread, and web storage.
 *
 * The second half is the one that carries the requirement. It is what turns
 * "there is no server" into "the database is **in the browser**" — because a
 * server-backed persistence layer satisfies the first half perfectly and fails
 * the second one completely.
 *
 * ## The distinction this file is here to protect
 *
 * A provider we cannot reach from a tab is a **risk we accepted**: CORS, and
 * `AGENTS.md` §2 says such a provider is simply not supported. File access and
 * persistence are the opposite — there is no external party to blame and no
 * fallback to offer. If the database ended up on a server, the project would not
 * be degraded, it would be a different project. A rule that cannot fail is a
 * note; this file is the part that fails.
 *
 * Run it per wave and before a release. See `AGENTS.md` §2.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/* ------------------------------------------------------------------ *
 * The forbidden half
 * ------------------------------------------------------------------ */

interface ForbiddenRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly why: string;
  /**
   * Which source the pattern is matched against.
   *
   * `code` — comment- and string-stripped. Right for a call like `console.log`
   * or `createServer(`, where the token is code.
   *
   * `specifier` — the **raw** source, anchored to an import position. This is not
   * a detail; it is the difference between a gate that works and one that does
   * not. An import specifier **is a string literal** — `import fs from "node:fs"`
   * — so a gate that strips strings is blind to every single `node:fs` import in
   * the repository. It would have passed a repo full of them, and reported
   * itself as coverage. The first version of this file made exactly that mistake
   * and its self-test caught it, which is the only reason to write one.
   *
   * Anchoring to `from` / `import` / `require` keeps prose honest: a comment
   * that says "we do not use node:fs" is not an import position, so it is not a
   * hit — and a comment that *shows* an import is, deliberately.
   */
  readonly where: "code" | "specifier";
}

/**
 * Assembled from fragments so that **this file's own source** contains no
 * forbidden token as a whole word, and can therefore be pasted into a test's
 * planted material without a self-match. The existing gates do the same.
 */
const N = "node:";
/** `from "x"`, `import "x"`, `import("x")`, `require("x")` — and nothing else. */
const AT_IMPORT = String.raw`(?:from|import|require)\s*\(?\s*["']`;
/**
 * Network, process and runtime specifiers **only**. `fs` and `path` are absent on
 * purpose: they carry their own rules, and listing them here made one planted
 * `node:fs/promises` report as two violations. A gate that reports the same
 * mistake twice trains the reader to skip lines, which is the one thing a gate
 * cannot afford.
 */
const NODE_SPECIFIER = String.raw`(?:${N})?(?:net|http|https|tls|dgram|child_process|worker_threads|os|crypto)`;

const FORBIDDEN: readonly ForbiddenRule[] = [
  {
    id: "node-fs",
    where: "specifier",
    pattern: new RegExp(`${AT_IMPORT}(?:${N})?(?:fs|fs/promises)["']`),
    why: "File access goes through the File System Access API or OPFS, never a filesystem.",
  },
  {
    id: "node-path",
    where: "specifier",
    pattern: new RegExp(`${AT_IMPORT}(?:${N})?path["']`),
    why: "Path arithmetic is a POSIX utility in baah-core (AGENTS.md §2), not node:path.",
  },
  {
    id: "node-net",
    where: "specifier",
    pattern: new RegExp(`${AT_IMPORT}${NODE_SPECIFIER}["']`),
    why: "No server part. AGENTS.md §2 is a definition, not a preference.",
  },
  {
    id: "commonjs-require",
    where: "code",
    pattern: /(^|[^.\w$])require\s*\(/,
    why: "The build is ESM. A require() is either a shim or a bundler doing something undeclared.",
  },
  {
    id: "node-process-global",
    where: "code",
    pattern: /(^|[^.\w$])process\s*\./,
    why: "`process` is a Node global. Keys are passed explicitly; there is no env fallback (AGENTS.md §3.1).",
  },
  {
    id: "server-listen",
    where: "code",
    pattern: /\b(createServer|listen)\s*\(|Deno\s*\.\s*serve|Bun\s*\.\s*serve/,
    why: "A listening socket is a server. There is none.",
  },
  {
    id: "own-transport",
    where: "code",
    pattern: /new\s+(WebSocket|EventSource)\s*\(|new\s+XMLHttpRequest\s*\(/,
    why: "The tab talks to the provider over fetch and nothing else. No socket, no SSE of our own.",
  },
];

/* ------------------------------------------------------------------ *
 * The required half
 * ------------------------------------------------------------------ */

interface RequiredCapability {
  readonly id: string;
  /** Any one of these in stripped source anywhere counts as "present". */
  readonly present: readonly RegExp[];
  readonly why: string;
}

const REQUIRED: readonly RequiredCapability[] = [
  {
    id: "filesystem-access",
    present: [/\bshow(OpenFile|Directory|SaveFile)Picker\s*\(/, /getFileHandle\s*\(/],
    why: "AGENTS.md §1: workspace access via the File System Access API or OPFS.",
  },
  {
    id: "origin-private-storage",
    // Matched on how the code **actually** calls it, which is `storage.getDirectory()`
    // on a local variable — not `navigator.storage.getDirectory()`. The first version
    // of this rule required the full chain and reported a capability the repository
    // genuinely has as missing. A gate that cries wolf about an absent capability is
    // a gate whose absence report gets ignored, which is the same failure as a gate
    // that cries wolf about a violation. `getDirectoryHandle` cannot match: `Handle`
    // sits between the name and the paren.
    present: [/\.getDirectory\s*\(/, /navigator\s*\.\s*storage\b/],
    why: "The in-memory sandbox needs a durable origin-private home, and OPFS is the browser's.",
  },
  {
    id: "browser-database",
    present: [/sqlite3InitModule/, /@sqlite\.org\/sqlite-wasm/, /wa-sqlite/, /waLib/],
    why: "The session database runs **in the browser**. This is the capability a server cannot provide, which is why it is required and not merely permitted.",
  },
  {
    id: "database-off-main-thread",
    present: [/\?worker&url/, /new\s+Worker\s*\(/, /importScripts/],
    why: "SQLite-WASM on the main thread would block the tab for every turn. It runs in a worker.",
  },
  {
    id: "web-storage",
    present: [/\blocalStorage\b/, /\bsessionStorage\b/, /indexedDB\s*\.\s*open/],
    why: "Keys and settings are kept in the browser's own storage, per AGENTS.md §2.",
  },
];

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

export interface Finding {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

export interface Report {
  readonly violations: readonly Finding[];
  /** Required capabilities with no occurrence in any scanned file. */
  readonly missing: readonly string[];
  /** Which required capability was satisfied, and by what. */
  readonly satisfied: Readonly<Record<string, string>>;
  readonly filesScanned: number;
  readonly packages: readonly string[];
}

/**
 * Replace comment and string bodies with spaces, preserving offsets and
 * newlines, so a hit is always a hit in **code**. The same routine the other
 * gates use, for the same reason: prose about a forbidden API is documentation,
 * not a violation, and a gate that flagged its own header would be switched off.
 */
export function stripCommentsAndStrings(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1] ?? "";

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      let cursor = i + 1;
      while (cursor < source.length) {
        const inner = source[cursor] ?? "";
        if (inner === "\\") {
          cursor += 2;
          continue;
        }
        cursor += 1;
        if (inner === char) break;
      }
      blank(i, cursor);
      i = cursor;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Check a set of sources. Pure: it takes `{ "path": "source" }` and never
 * touches the disk, which is what lets the self-test feed it planted material.
 */
export function scanBrowserOnly(files: Readonly<Record<string, string>>): Report {
  const violations: Finding[] = [];
  const satisfied: Record<string, string> = {};
  const missing: string[] = [];
  const packages = new Set<string>();

  for (const [file, source] of Object.entries(files)) {
    const packageOf = file.split("/").slice(0, 2).join("/");
    packages.add(packageOf);
    const code = stripCommentsAndStrings(source);

    for (const rule of FORBIDDEN) {
      // A specifier rule reads the **raw** source — see `where` on the rule. It is
      // anchored to an import position, so prose in a comment is still not a hit.
      const haystack = rule.where === "specifier" ? source : code;
      const match = rule.pattern.exec(haystack);
      if (match === null) continue;
      violations.push({
        rule: rule.id,
        file,
        line: haystack.slice(0, match.index).split("\n").length,
        text: match[0].trim(),
        why: rule.why,
      });
    }

    for (const capability of REQUIRED) {
      if (satisfied[capability.id] !== undefined) continue;
      const found = capability.present.some((p) => p.test(code));
      if (found) satisfied[capability.id] = file;
    }
  }

  for (const capability of REQUIRED) {
    if (satisfied[capability.id] === undefined) missing.push(capability.id);
  }

  return {
    violations,
    missing,
    satisfied,
    filesScanned: Object.keys(files).length,
    packages: [...packages].sort(),
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const SKIP_SEGMENTS = new Set(["node_modules", "dist", "test-results", ".git", "test", "e2e"]);

/** Every `src/**` source under the given root, minus tests and build output. */
export function collectSources(root: string): Record<string, string> {
  const found: Record<string, string> = {};

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (SKIP_SEGMENTS.has(entry)) continue;
      const full = join(directory, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      if (entry.includes(".test.") || entry.includes(".d.ts")) continue;
      found[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };

  walk(join(root, "packages"));
  return found;
}

function main(): number {
  const root = process.cwd();
  const report = scanBrowserOnly(collectSources(root));

  for (const finding of report.violations) {
    process.stdout.write(
      `browser-only: ${finding.rule} in ${finding.file}:${finding.line} ` +
        `(${finding.text}) — ${finding.why}\n`,
    );
  }
  for (const id of report.missing) {
    const why = REQUIRED.find((c) => c.id === id)?.why ?? "";
    process.stdout.write(`browser-only: required capability "${id}" is nowhere in src/ — ${why}\n`);
  }

  if (report.violations.length === 0 && report.missing.length === 0) {
    process.stdout.write(
      `browser-only: ${report.filesScanned} sources in ${report.packages.length} packages — ` +
        `no server form, all ${REQUIRED.length} required browser capabilities in use\n`,
    );
    return 0;
  }
  process.stdout.write(
    `browser-only: FAILED with ${report.violations.length} violation(s) and ` +
      `${report.missing.length} missing capability/capabilities\n`,
  );
  return 1;
}

// Only when executed directly; importing this file must not walk the disk.
if (process.argv[1] !== undefined && process.argv[1].includes("browser-only")) {
  process.exitCode = main();
}

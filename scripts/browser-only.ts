/**
 * The browser-only rule, made executable — and checkable in one command, so
 * "we are still browser-only" is an answer rather than an intention.
 *
 * ## Why a root script and not a test in a package
 *
 * It has to reach `src/` in **every** package, including the ten tool packages.
 * `import.meta.glob("/src/**")` is rooted at one package, and §4 forbids a
 * package reaching into another's tree — which is why the comment/string
 * stripper in the existing gates is duplicated four times rather than shared.
 * Duplicating a **repo-wide** gate seven times would be the same mistake with a
 * worse ratio.
 *
 * ## Node-free on purpose, and that is load-bearing
 *
 * This module contains **no** `node:fs`, no `node:path`, no `process`. Not
 * tidiness — a build-time consequence. The self-test in
 * `packages/baah-web/test/browser-only.test.ts` imports this file, which pulls
 * it into `baah-web`'s TypeScript program, and that program has
 * `"types": ["vite/client"]` with no `@types/node`. The first version imported
 * `node:fs` right here and put **`pnpm check` into 12 compile errors** on the
 * commit that introduced it.
 *
 * Two ways out existed. Giving the browser package Node types is §2's failure
 * mode in the very package that must not have them. The other is to keep this
 * module pure and let a `.mjs` entry point do the walking — which is not a
 * workaround but the better shape: **the pure part of a gate is the part worth
 * testing**, and a scanner test that needs a filesystem is a test that gets
 * skipped the day the filesystem is inconvenient.
 *
 * `scripts/check-browser-only.mjs` is the entry point. Plain JavaScript, so no
 * compile step and no Node typings in any package.
 *
 * ## What it checks, and why it checks two things
 *
 * A list of forbidden imports is the obvious version and it is **half a gate**.
 * Delete the persistence layer and it passes, because nothing forbidden was
 * imported. That is a green gate that proves nothing — the failure this project
 * has now hit seven times in different costume (the truncated `grep` search, the
 * skipped model list, the 44 green tests that never looked at a phone).
 *
 * So there are two halves, and **both** must hold:
 *
 *   1. **Forbidden** — no Node builtin, no server form, no raw socket, no
 *      same-origin `fetch` in any `src/`.
 *   2. **Required** — the browser capabilities the project is *defined* by must
 *      actually be in use.
 *
 * Each half reads the source in the way the thing it looks for is **written**:
 * a call like `console.log` is code, an import specifier is a string literal,
 * and a query string like `?worker&url` is a string too. Getting that wrong does
 * not fail loudly — it reports something that is genuinely there as missing.
 * Both mistakes were made here and both were caught by the self-test, which is
 * the entire argument for having one.
 *
 * ## What the required half does and does not carry — stated, not implied
 *
 * It detects **deletion**: remove the browser database and `browser-database`
 * goes missing, correctly. It does **not** detect **miswiring** — a source set
 * with `fetch("/api/sessions")` *and* an untouched `import sqlite3InitModule`
 * satisfies both halves. Measured, and kept in the self-test as a documented
 * limit. A gate that claims more than it checks is the defect this project has
 * spent the session fixing; adding one here would be absurd.
 *
 * Nor does it detect *wiring*: a capability mentioned in a function nobody calls
 * satisfies it. The distinction between "the API is used" and "the app is
 * connected" is not checkable from source text at this price, and pretending
 * otherwise would be the same overclaim in a new coat.
 *
 * Run it per wave and before a release. See `AGENTS.md` §2a, §2b.
 */

export interface Finding {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

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
   * `code` — comment- and string-stripped. Right for `console.log` or
   * `createServer(`, where the token is code.
   *
   * `specifier` — the **raw** source, anchored to an import position. This is
   * not a detail; it is the difference between a gate that works and one that
   * does not. An import specifier **is a string literal** — `import fs from
   * "node:fs"` — so a gate that strips strings is blind to every single
   * `node:fs` import in the repository. The first version of this file made
   * exactly that mistake and its self-test caught it.
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
/**
 * A `fetch` at a **same-origin, path-absolute** URL — i.e. a call to our own
 * server. Provider and tool fetches take an absolute URL, so they do not match.
 *
 * This rule is the one place where a half-measure would be actively dangerous:
 * §2 is a rule about *this project not having a backend*, and a rule that cannot
 * see `fetch("/api/sessions")` is a rule about most of that.
 */
const OWN_ORIGIN_FETCH = String.raw`fetch\s*\(\s*["']\/(?!\/)`;

export const FORBIDDEN: readonly ForbiddenRule[] = [
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
    // Bare `process`, not just `process.`: AGENTS.md §2 names `process` outright, and
    // the first version of this rule matched only the member access.
    pattern: /(^|[^.\w$])process\b/,
    why: "`process` is a Node global. Keys are passed explicitly; there is no env fallback (AGENTS.md §3.1).",
  },
  {
    id: "node-buffer",
    where: "code",
    pattern: /(^|[^.\w$])Buffer\b/,
    why: "`Buffer` is a Node global named outright in AGENTS.md §2. Bytes are Uint8Array.",
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
  {
    id: "own-origin-fetch",
    where: "specifier",
    pattern: new RegExp(OWN_ORIGIN_FETCH),
    why: "A same-origin path means our own backend. AGENTS.md §2 has no server, so there is nothing for it to call.",
  },
];

/* ------------------------------------------------------------------ *
 * The required half
 * ------------------------------------------------------------------ */

interface RequiredCapability {
  readonly id: string;
  /** Any one of these counts as "present". Mixed `where`, see below. */
  readonly present: readonly { readonly where: "code" | "specifier"; readonly pattern: RegExp }[];
  readonly why: string;
}

/**
 * `where` per alternative, not per capability, and the reason is the same bug one
 * half a file away: `import … from "@sqlite.org/sqlite-wasm"` is a **string**, so a
 * pattern matching the bare specifier can only ever match in **raw** source. The
 * second version of this gate listed it among `code` alternatives and therefore
 * reported `browser-database` as missing on a repository that has it. Only the
 * identifier alternatives (`sqlite3InitModule`) survived the stripper.
 */
export const REQUIRED: readonly RequiredCapability[] = [
  {
    id: "project-folder",
    present: [{ where: "code", pattern: /\bshow(OpenFile|Directory|SaveFile)Picker\s*\(/ }],
    // Deliberately **no** `getFileHandle` alternative, which is what OPFS offers
    // too. The first version had it, and an OPFS-only app with no project folder
    // at all passed this capability — measured, planted. The capability is
    // "the user picks a folder", which is not the same thing as "some browser
    // filesystem exists", and conflating them made the gate unable to tell the
    // target state from zero.
    why: "AGENTS.md §2a: the project folder, chosen with the File System Access API, is the truth source. OPFS is not a substitute — it is private to the origin and dies with site data.",
  },
  {
    id: "origin-private-storage",
    // Matched on how the code actually calls it: `storage.getDirectory()` on a local
    // variable, not `navigator.storage.getDirectory()`. The first version required
    // the full chain and reported a capability the repository genuinely has as
    // missing. `getDirectoryHandle` cannot match — `Handle` sits before the paren.
    present: [
      { where: "code", pattern: /\.getDirectory\s*\(/ },
      { where: "code", pattern: /navigator\s*\.\s*storage\b/ },
    ],
    why: "The durable origin-private home the storage layer sits on.",
  },
  {
    id: "browser-database",
    present: [
      { where: "specifier", pattern: /@sqlite\.org\/sqlite-wasm/ },
      { where: "code", pattern: /\bsqlite3InitModule\b/ },
      { where: "code", pattern: /\bwaLib\b/ },
    ],
    why: "The session database runs **in the browser**. No server can provide this, which is why it is required and not merely permitted.",
  },
  {
    id: "database-off-main-thread",
    present: [
      { where: "specifier", pattern: /\?worker&url/ },
      { where: "code", pattern: /new\s+Worker\s*\(/ },
      { where: "code", pattern: /importScripts\s*\(/ },
    ],
    why: "SQLite-WASM on the main thread would block the tab on every turn.",
  },
  {
    id: "web-storage",
    present: [
      { where: "code", pattern: /\blocalStorage\b/ },
      { where: "code", pattern: /\bsessionStorage\b/ },
      { where: "code", pattern: /indexedDB\s*\.\s*open/ },
    ],
    why: "Keys, settings and the session pointer live in the browser's own storage.",
  },
];

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

export interface Report {
  readonly violations: readonly Finding[];
  /** Required capabilities with no occurrence in any scanned file. */
  readonly missing: readonly string[];
  /** Which required capability was satisfied, and by what. */
  readonly satisfied: Readonly<Record<string, string>>;
  readonly filesScanned: number;
  /** Package trees seen. Derived from the path, so tool packages read as one. */
  readonly packages: readonly string[];
  /**
   * Every reason this repository does not satisfy the rule, as one string each.
   * Empty means clean. `scanBrowserOnly` leaves this empty; `verifyRepository`
   * fills it.
   */
  readonly problems: readonly string[];
}

/**
 * Replace comment and string bodies with spaces, preserving offsets and
 * newlines, so a hit in **code** is always a hit in code. Prose about a
 * forbidden API is documentation, not a violation, and a gate that flagged its
 * own header would be switched off.
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
 * touches a disk, which is what lets the self-test feed it planted material.
 */
export function scanBrowserOnly(files: Readonly<Record<string, string>>): Report {
  const violations: Finding[] = [];
  const satisfied: Record<string, string> = {};
  const missing: string[] = [];
  const packages = new Set<string>();

  for (const [file, source] of Object.entries(files)) {
    packages.add(file.split("/").slice(0, 2).join("/"));
    const code = stripCommentsAndStrings(source);
    const raw = source;

    for (const rule of FORBIDDEN) {
      const haystack = rule.where === "specifier" ? raw : code;
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
      const found = capability.present.some((alt) =>
        alt.pattern.test(alt.where === "specifier" ? raw : code),
      );
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
    problems: [] as readonly string[],
  };
}

/**
 * The check that runs on **every** `pnpm check:browser-only`: not just "no
 * violations", but that the repository and {@link KNOWN_UNSATISFIED} agree.
 *
 * It lives here rather than in the vitest suite for a structural reason, not a
 * preference: the self-test is in `baah-web`, whose TypeScript program has
 * `"types": ["vite/client"]` and **no** `@types/node`, so that test cannot read
 * the repository at all. Putting the repository-level assertions in a test would
 * mean either Node types in the browser package (§2's failure mode) or a test
 * that silently stops covering the real tree.
 *
 * Putting them here means they run on every `pnpm check`, not only when somebody
 * remembers to run a test. The pure logic is still tested by vitest, against
 * fixtures, where it belongs.
 */
export function verifyRepository(
  files: Readonly<Record<string, string>>,
  /**
   * The known-unsatisfied list to check against, defaulting to the real one.
   *
   * A parameter, not a hard reference, and that is a correction to the first
   * version of this file: the self-test verified the mechanism using the
   * *production* entry, so deleting that entry — which is exactly what the gate
   * demanded once the folder got wired — turned two mechanism tests red. The
   * mechanism is a rule **about the object**, so it has to be testable with any
   * object. A test coupled to live data is a test that breaks when the data is
   * fixed.
   */
  known: Readonly<Record<string, string>> = KNOWN_UNSATISFIED,
): Report {
  const report = scanBrowserOnly(files);
  const problems: string[] = [];

  for (const v of report.violations) {
    problems.push(`${v.rule} in ${v.file}:${v.line} (${v.text}) — ${v.why}`);
  }

  for (const id of report.missing) {
    const reason = known[id];
    if (reason === undefined) {
      problems.push(
        `untracked missing capability "${id}" — ${REQUIRED.find((c) => c.id === id)?.why ?? ""}`,
      );
    }
  }

  // The reverse direction, and it is the one that keeps the list honest: an entry
  // whose capability has become satisfied is a stale explanation for a problem
  // that no longer exists. Failing here is the reminder to delete it.
  for (const id of Object.keys(known)) {
    if (!report.missing.includes(id)) {
      problems.push(
        `KNOWN_UNSATISFIED lists "${id}" but the scan finds it satisfied — delete the entry`,
      );
    }
  }

  for (const [id, reason] of Object.entries(known)) {
    if (reason.length <= 60) problems.push(`KNOWN_UNSATISFIED "${id}" needs a reason, not just an id`);
    if (!REQUIRED.some((c) => c.id === id)) problems.push(`KNOWN_UNSATISFIED "${id}" is not a capability`);
  }

  return { ...report, problems };
}

/** Every capability id, for the CLI's summary line and for tests. */
export const CAPABILITY_IDS: readonly string[] = REQUIRED.map((c) => c.id);

/** Every forbidden rule id. */
export const RULE_IDS: readonly string[] = FORBIDDEN.map((r) => r.id);

/**
 * Capabilities that are **required by the target state and not met yet**, each
 * with the reason. They are reported loudly on every run and do **not** fail the
 * gate.
 *
 * ## Why not just fail
 *
 * The honest answer to "this rule is not satisfied" is not a red build. It is a
 * red build that nobody can fix until a planned feature lands, and the result is
 * that people stop reading the gate. `project-folder` is a **gap against a stated
 * goal**, not a forgotten one: the user designed the project folder as the truth
 * source and it is not wired. That belongs on the wall, loudly, every run.
 *
 * ## Why the link is bidirectional, which is what stops it rotting
 *
 * Two assertions in the self-test hold this list against reality:
 *
 * - every id here is **currently missing** from the scan — so an entry that was
 *   fixed is a failing test, not dead text;
 * - the real repository is missing **nothing else** — so a new capability that
 *   quietly stops being satisfied is a failing test.
 *
 * This is the count-keyed permit list from `no-foreign-error-text`, made
 * mechanical: a new problem fails, a solved problem fails, and only a deliberate
 * edit to this object changes either.
 */
/**
 * **Empty on purpose.** It held one entry, `project-folder`, from the moment the
 * gate landed until the project folder was actually wired — and the gate is what
 * said so: `KNOWN-UNSATISFIED lists "project-folder" but the scan finds it
 * satisfied — delete the entry`.
 *
 * That is the mechanism working as designed. The reverse check means a solved gap
 * cannot go stale: someone wires the folder, the gate stops being quiet, and the
 * only way to make it quiet again is a deliberate edit here. An entry that was
 * never deleted would have been a permanent explanation for a problem that no
 * longer exists, and this file is read on every `pnpm check`.
 *
 * `project-folder` is now genuinely satisfied: `showDirectoryPicker` is called
 * from a user gesture in `lib/project-folder.ts`, the handle lives in its own
 * IndexedDB database, and `components/lib/runtime.ts` constructs
 * `createFileSystemAccessWorkspace` in the composition root.
 */
export const KNOWN_UNSATISFIED: Readonly<Record<string, string>> = {};
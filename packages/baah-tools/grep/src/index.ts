import {
  assertInsideRoot,
  basenamePath,
  byteLength,
  defineTool,
  ToolError,
  type ToolContext,
  type Workspace,
} from "@all-the.rest/baah-core";
import { createIgnoreFilter } from "@all-the.rest/baah-core/ignore";
import { z } from "zod";

/** Default number of matching lines returned per call (reference: `DEFAULT_SEARCH_LIMIT`). */
export const DEFAULT_GREP_LIMIT = 100;

/** Longest single match line we hand back before truncating it. */
export const MAX_LINE_LENGTH = 500;

/** Files above this size are skipped: a minified bundle is not worth reading. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Total bytes one call may read before it stops scanning. */
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/**
 * Wall-clock bound for the matching loop of one call.
 *
 * The scanner is a synchronous, backtracking `RegExp.test` per line, so a
 * catastrophic pattern does not slow the search down — it stops the tab.
 * Measured on this machine with `(a+)+$` against `"a"×N + "b"`:
 * N=24 → 305 ms, N=26 → 1.1 s, N=28 → 4.6 s, N=30 → 19 s, doubling per two
 * characters. Nothing in the schema can prevent that; a model writes the
 * pattern.
 *
 * Why 5 s and not the reference's 30 s
 * (`FileSystem.DEFAULT_SEARCH_TIMEOUT_MS`, opencode v2.0.19): the reference
 * spawns a native ripgrep in a server process, where 30 s of wall clock is a
 * slow answer. Here the same 30 s is 30 s of frozen main thread, which the
 * user cannot recover from by scrolling. 5 s is an order of magnitude above
 * the worst *legitimate* scan measured on this machine — 16 MiB of real source
 * (207 121 lines) through `\w+\s*=\s*\w+;?$` takes 502 ms, and every other
 * measured pattern is ≤ 103 ms — and a cut is always reported in the result,
 * never silently swallowed.
 *
 * Residual, and it is not fixable from here: a *single* line can still block
 * for its own duration, because a synchronous `RegExp.test` cannot be
 * interrupted from the inside. `(a+)+$` against one 4 MiB line does not
 * return at all. The timeout bounds the scan, not one evaluation. See
 * `README.md`.
 */
export const SEARCH_TIMEOUT_MS = 5_000;

/**
 * Mirror of `baah-core`'s `DEFAULT_MAX_ENTRIES` — the number of entries
 * `Workspace.walk` yields before it gives up (`packages/baah-core/src/
 * workspace.ts:214`, `workspace/directory-workspace.ts:77`).
 *
 * **Stopgap.** `walk` returns `AsyncIterable<DirEntry>` and cannot say "I
 * stopped early", so the only way to notice the cap from here is to count the
 * entries that came out. That is a duplicated limit constant, and it is
 * conservative in the safe direction: a workspace with exactly this many
 * entries is reported as possibly-incomplete. It is replaced by a
 * `walkTruncated` flag on the walk itself — see the report.
 */
export const WALK_ENTRY_LIMIT = 50_000;

export const grepInputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Regular expression to search for, or plain text when `literal` is true. " +
        "The dialect is JavaScript's `RegExp` **as ripgrep's Rust regex accepts " +
        "it**: no lookaround (`(?=`, `(?<!`) and no backreferences (`\\1`). " +
        "Avoid nested quantifiers (`(a+)+$`): a backtracking engine takes " +
        "seconds on a short line and the search is cut off at " +
        `${SEARCH_TIMEOUT_MS / 1000} s.`,
    ),
  path: z
    .string()
    .optional()
    .describe("Directory to search, relative to the workspace root. Defaults to `.`."),
  include: z
    .string()
    .optional()
    .describe(
      "Glob filter for file names, e.g. `*.{ts,tsx}`. Matched against the file " +
        "name and against the workspace-relative path. Supported syntax: `*`, " +
        "`**`, `?`, `[…]`, `{a,b}` and `\\` as an escape. NOT supported: `!` " +
        "negation, extglobs (`@(a|b)`, `!(a|b)`) and POSIX classes " +
        "(`[[:alpha:]]`) — those are rejected with an error, not silently " +
        "ignored.",
    ),
  literal: z
    .boolean()
    .optional()
    .describe("Treat `pattern` as exact text instead of a regular expression. Defaults to false."),
  caseSensitive: z
    .boolean()
    .optional()
    .describe("Case-sensitive matching. Defaults to true."),
  limit: z
    .number()
    .int()
    // `.min(1)` only. The reference types this as `PositiveInt` — no upper
    // bound — and a model asking for `limit: 5000` gets a validation error
    // here and a result there. An invented ceiling is a divergence, not
    // safety: the byte cap and the search timeout, not the requested limit,
    // are what bound the work. A limit of 0 is kept out because "return no
    // matches" is not a question anyone means to ask.
    .min(1)
    .optional()
    .describe(`Maximum number of matching lines to return. Defaults to ${DEFAULT_GREP_LIMIT}.`),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

export interface GrepMatch {
  /** Workspace-relative path. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The matching line, without its trailing newline. */
  text: string;
}

/** Why a search stopped before it had looked at everything. */
export type IncompleteCause = "bytes" | "walk" | "abort" | "timeout";

export interface GrepOutput {
  pattern: string;
  /** The resolved search root the walk started from. */
  path: string;
  matches: GrepMatch[];
  /** Matching lines found before `limit` was applied. */
  total: number;
  /** `true` when `limit` cut the match list, i.e. the search itself was complete. */
  truncated: boolean;
  /** Files whose content was actually scanned. */
  filesScanned: number;
  /** Files skipped as binary or over `maxFileBytes`. */
  filesSkipped: number;
  /** Bytes read for this call. Always `<= maxBytes`. */
  bytesRead: number;
  /** The total byte cap that applies per call. */
  maxBytes: number;
  maxFileBytes: number;
  /**
   * `true` when the search did **not** look at everything it was asked to
   * look at: the byte cap, the walk cap, an abort, or the match timeout.
   *
   * This is the field a model must read before concluding "no matches". An
   * empty result with `searchTruncated: false` means "no match in what I
   * looked at"; with `true` it means "I stopped looking".
   */
  searchTruncated: boolean;
  /** Model-facing explanation: why the list is short or empty. */
  hint?: string;
  /** Set when `.gitignore` could not be used. */
  note?: string;
}

/** A file that passed the ignore/include filters, before it was read. */
interface Candidate {
  path: string;
  /** Bytes, or absent when the workspace does not report a size. */
  size?: number;
}

/** A file that was read successfully and is safe to hand to a scanner. */
export interface GrepFile {
  path: string;
  content: string;
}

const NUL = "\u0000";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampLine(line: string): string {
  return line.length > MAX_LINE_LENGTH
    ? `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated]`
    : line;
}

/** Drops the phantom line a trailing newline produces, like the `read` tool. */
function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the search regex once, so a bad pattern is a clear model-facing error
 * instead of a raw `SyntaxError` from deep inside a scanner.
 */
function buildRegExp(pattern: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (error) {
    throw new ToolError(
      `Invalid regular expression: ${pattern} — ${describe(error)}. ` +
        "Fix the pattern, or set `literal: true` to search for the text as-is.",
    );
  }
}

export interface RegExpSearchInput {
  files: readonly GrepFile[];
  pattern: string;
  caseSensitive: boolean;
  /** Stop the scan when this aborts. Checked before every line. */
  signal?: AbortSignal;
  /** Wall-clock bound for the whole scan. Defaults to `SEARCH_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface RegExpSearchResult {
  matches: GrepMatch[];
  /**
   * `true` when the scan stopped early. The match list is then a *prefix* of
   * the answer and must never be reported as "these are all the matches".
   */
  truncated: boolean;
  stoppedBy?: "abort" | "timeout";
}

/**
 * The only engine.
 *
 * The search is a per-line `RegExp.test`: one match per matching line, with
 * the line number and the line text, which is what the result shape promises.
 * A backtracking engine is the price for having no WASM to load, no `.wasm`
 * URL to resolve against a sub-path deployment, no `wasm-unsafe-eval` CSP
 * requirement, and no second dialect to keep equivalent (see `README.md`).
 *
 * `ripgrep` in WASM may come back as an **opt-in accelerator**. If it does, it
 * has to arrive with an equivalence test against this scanner over the dialect
 * the tool description promises — not as an unverified default with a silent
 * fallback, which is what it was.
 */
export function searchWithRegExp(input: RegExpSearchInput): RegExpSearchResult {
  const regex = buildRegExp(input.pattern, input.caseSensitive);
  const timeoutMs = Math.max(0, input.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const signal = input.signal;
  const startedAt = Date.now();
  const matches: GrepMatch[] = [];

  for (const file of input.files) {
    const lines = splitLines(file.content);
    for (let index = 0; index < lines.length; index += 1) {
      if (signal !== undefined && signal.aborted) {
        return { matches, truncated: true, stoppedBy: "abort" };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return { matches, truncated: true, stoppedBy: "timeout" };
      }
      const line = lines[index];
      if (line === undefined || !regex.test(line)) continue;
      matches.push({ path: file.path, line: index + 1, text: clampLine(line) });
    }
  }

  // Only the abort needs a check here. An abort can arrive *during* the last
  // line, after the per-line check has already passed, and it can be the only
  // thing observed for an empty file list — so without this a cut scan reports
  // itself as complete.
  //
  // The clock deliberately has no post-loop check. It cannot be reached in
  // practice: the per-line check fires first whenever the budget is already
  // spent, and a loop that ran to the end has, by construction, been under
  // budget for every line. A "check the clock after the loop" branch would be
  // code that cannot execute (AGENTS.md §5).
  if (signal !== undefined && signal.aborted) {
    return { matches, truncated: true, stoppedBy: "abort" };
  }

  return { matches, truncated: false };
}

function compareMatches(a: GrepMatch, b: GrepMatch): number {
  const byPath = a.path.localeCompare(b.path);
  if (byPath !== 0) return byPath;
  return a.line - b.line;
}

/** Test seam for the two time bounds; the tool itself always uses the defaults. */
export interface ExecuteGrepOptions {
  /** Overrides `SEARCH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Overrides `WALK_ENTRY_LIMIT`. */
  walkEntryLimit?: number;
}

export async function executeGrep(
  context: ToolContext,
  input: GrepInput,
  options: ExecuteGrepOptions = {},
): Promise<GrepOutput> {
  const path = assertInsideRoot(context.cwd, input.path ?? ".");
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  const literal = input.literal ?? false;
  const caseSensitive = input.caseSensitive ?? true;
  const walkEntryLimit = options.walkEntryLimit ?? WALK_ENTRY_LIMIT;

  // Validate before touching the filesystem: an invalid regex is a model
  // mistake, not a search failure, and `literal` never compiles one. The
  // `include` glob is compiled here too, so an unsupported syntax is an error
  // the model reads instead of an empty result it will over-interpret.
  if (!literal) buildRegExp(input.pattern, caseSensitive);
  const isIncluded = buildIncludeMatcher(input.include);

  if (path !== ".") {
    const stat = await context.workspace.stat(path);
    if (!stat) throw new ToolError(`Directory not found: ${path}`);
    if (stat.kind !== "directory") throw new ToolError(`Not a directory: ${path}`);
  }

  // `includeHidden: true` is what the reference does: ripgrep is invoked with
  // `--hidden` unconditionally (`ripgrep.ts:221`, opencode v2.0.19), so
  // `.github/workflows/*.yml` and `.env.example` are searchable there and were
  // unreachable here. `.git`, `node_modules`, `dist` and the binary extensions
  // stay in the default rule set and are still skipped — "hidden" and
  // "ignored" are two different things and only the first one was flipped.
  const isIgnored = await createIgnoreFilter(context.workspace, { includeHidden: true });

  const notes: string[] = [];
  if (isIgnored.gitignoreError !== undefined) {
    notes.push(`${isIgnored.gitignoreError} — search continued without it.`);
  }

  const candidates: Candidate[] = [];
  let visited = 0;
  let walkTruncated = false;
  for await (const entry of context.workspace.walk(path, {
    signal: context.signal,
    filter: (visitedEntry) => !isIgnored(visitedEntry.path, visitedEntry.kind),
  })) {
    visited += 1;
    if (entry.kind === "file" && isIncluded(entry.path)) {
      candidates.push({
        path: entry.path,
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      });
    }
    // `Workspace.walk` yields exactly `walkEntryLimit` entries before it
    // returns, so reaching that count means the walk may have been cut here:
    // files after this point were never considered as candidates. The entry
    // that hits the count is still processed — it *was* yielded.
    if (visited >= walkEntryLimit) {
      walkTruncated = true;
      notes.push(
        `The workspace walk stopped at its ${walkEntryLimit}-entry cap; entries after that point were never visited.`,
      );
      break;
    }
  }
  // An abort that lands during the walk ends the iteration without yielding
  // the rest. `walk` checks the signal at the top of each step, so this is the
  // only place that can observe it for the entries already seen — and it also
  // covers a signal that was aborted on entry, where nothing was seen at all.
  if (context.signal.aborted && !walkTruncated) {
    notes.push("Search aborted — the walk stopped before it had seen every entry.");
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path));

  const scan = await scanCandidates(context.workspace, candidates, context.signal);
  const search = searchWithRegExp({
    files: scan.files,
    pattern: literal ? escapeRegExp(input.pattern) : input.pattern,
    caseSensitive,
    signal: context.signal,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  search.matches.sort(compareMatches);
  const total = search.matches.length;
  const truncated = total > limit;
  const shown = search.matches.slice(0, limit);

  const causes: IncompleteCause[] = [];
  if (search.truncated && search.stoppedBy === "timeout") causes.push("timeout");
  if (scan.stoppedBy === "bytes") causes.push("bytes");
  if (walkTruncated) causes.push("walk");
  if (scan.stoppedBy === "abort" || (search.truncated && search.stoppedBy === "abort")) {
    causes.push("abort");
  }
  const searchTruncated = causes.length > 0;

  if (scan.stoppedBy === "bytes") {
    notes.push(`Read stopped at the ${MAX_TOTAL_BYTES}-byte budget (${MAX_TOTAL_BYTES / (1024 * 1024)} MiB).`);
  }
  if (scan.stoppedBy === "abort") {
    notes.push(
      `Search aborted after ${scan.files.length} of ${candidates.length} candidate files were read.`,
    );
  } else if (search.truncated && search.stoppedBy === "abort") {
    // Different loop, different fact: the read loop finished, and the matcher
    // is the one that stopped part-way through what it was handed. Reporting
    // "after N files" here would understate the work that was done.
    notes.push(
      `Search aborted; all ${scan.files.length} read files were handed to the matcher, which stopped part-way through.`,
    );
  }
  if (search.truncated && search.stoppedBy === "timeout") {
    notes.push(`Matching stopped after ${options.timeoutMs ?? SEARCH_TIMEOUT_MS} ms.`);
  }

  const hint = buildHint(input, total, shown.length, scan.filesSkipped, causes);

  return {
    pattern: input.pattern,
    path,
    matches: shown,
    total,
    truncated,
    filesScanned: scan.files.length,
    filesSkipped: scan.filesSkipped,
    bytesRead: scan.bytesRead,
    maxBytes: MAX_TOTAL_BYTES,
    maxFileBytes: MAX_FILE_BYTES,
    searchTruncated,
    ...(hint !== undefined ? { hint } : {}),
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

export const grepTool = defineTool<GrepInput, GrepOutput>({
  id: "grep",
  description:
    "Search file contents with a regular expression. Scans every text file " +
    "under `path` (default `.`), including dotfiles such as " +
    "`.github/workflows/*.yml`; skips build output, `node_modules`, binary " +
    "files, anything over 1 MiB and whatever the workspace `.gitignore` " +
    "excludes. The pattern is a Rust-regex-compatible subset: no lookaround " +
    "(`(?=`, `(?<!`) and no backreferences (`\\1`). Use `include` to restrict by " +
    "file glob (e.g. `*.{ts,tsx}`), `literal: true` for exact text, " +
    "`caseSensitive: false` to ignore case. Returns `path`/`line`/`text` " +
    "matches sorted by path. **Read `searchTruncated` before concluding that " +
    "a result is complete**: it is `true` when the byte cap, the workspace " +
    "walk cap, an abort or the 5 s match budget stopped the search early, in " +
    "which case an empty `matches` means 'stopped looking', not 'no match'. " +
    "Narrow `path`/`include` instead of re-running the same call.",
  access: "read",
  inputSchema: grepInputSchema,
  execute: (context, input) => executeGrep(context, input),
});

const CAUSE_HINTS: Readonly<Record<IncompleteCause, (shown: number) => string>> = {
  timeout: (shown) =>
    `The ${SEARCH_TIMEOUT_MS / 1000} s match budget ran out, so these ${shown} ` +
    "matches are incomplete. Avoid nested quantifiers (e.g. `(a+)+$`), and " +
    "narrow `path`/`include`.",
  bytes: (shown) =>
    `The byte cap stopped the scan, so these ${shown} matches are incomplete. ` +
    "Narrow `path`/`include` and search a subtree.",
  walk: () =>
    `The workspace walk stopped at its entry cap, so files past it were never ` +
    "searched. Narrow `path` and search a subtree — this is not a complete answer.",
  abort: (shown) => `The search was aborted, so these ${shown} matches are incomplete.`,
};

function buildHint(
  input: GrepInput,
  total: number,
  shown: number,
  filesSkipped: number,
  causes: readonly IncompleteCause[],
): string | undefined {
  const cause = causes[0];
  if (cause !== undefined) return CAUSE_HINTS[cause](shown);

  if (total === 0) {
    if (filesSkipped > 0) {
      return (
        `No line matches "${input.pattern}" under "${input.path ?? "."}", and ` +
        `${filesSkipped} file(s) were skipped before matching: anything over the ` +
        `${MAX_FILE_BYTES / (1024 * 1024)} MiB per-file cap is never read, so a ` +
        "needle can sit in one of them. Narrow `path`/`include` to smaller files, " +
        "or read a known file directly."
      );
    }
    return (
      `No line matches "${input.pattern}" under "${input.path ?? "."}". Widen ` +
      "`path`, set `include`, drop `literal` to search with a regex, or try " +
      "`caseSensitive: false`."
    );
  }
  if (shown < total) {
    const scope = input.include === undefined ? "`path`" : "`path`/`include`";
    return `Showing ${shown} of ${total} matching lines. Narrow ${scope} or raise \`limit\`.`;
  }
  return undefined;
}

interface ScanResult {
  files: GrepFile[];
  filesSkipped: number;
  /** Always `<= MAX_TOTAL_BYTES`. */
  bytesRead: number;
  stoppedBy?: "bytes" | "abort";
}

/**
 * Reads the candidates into memory under two caps.
 *
 * The byte budget is checked *before* a read, using the size the workspace
 * reported, and again *after* it for a workspace that reports none. Both
 * checks have to be there: a post-read check alone is what produced a result
 * claiming `bytesRead: 17,510,495` next to `maxBytes: 16,777,216` — a budget
 * that contradicts itself. The invariant is now absolute, and a file that
 * would cross the line is *not scanned* either, so the byte cap and the match
 * list can never disagree.
 */
async function scanCandidates(
  workspace: Workspace,
  candidates: readonly Candidate[],
  signal: AbortSignal,
): Promise<ScanResult> {
  const files: GrepFile[] = [];
  let filesSkipped = 0;
  let bytesRead = 0;
  // An already-aborted signal must be reported too: `walk` yields nothing then,
  // and an empty result that looks complete would be a lie.
  let stoppedBy: "bytes" | "abort" | undefined = signal.aborted ? "abort" : undefined;

  for (const candidate of candidates) {
    if (signal.aborted) {
      stoppedBy = "abort";
      break;
    }
    // A file already known to be over the cap is never read.
    if (candidate.size !== undefined && candidate.size > MAX_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }
    if (bytesRead + (candidate.size ?? 0) > MAX_TOTAL_BYTES) {
      stoppedBy = "bytes";
      break;
    }

    const content = await workspace.readText(candidate.path);
    const size = byteLength(content);
    if (content.includes(NUL) || size > MAX_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }
    if (bytesRead + size > MAX_TOTAL_BYTES) {
      stoppedBy = "bytes";
      break;
    }

    files.push({ path: candidate.path, content });
    bytesRead += size;
  }

  // An abort raised during the *last* read never reaches the top of an
  // iteration, so without this the read loop reports itself as complete while
  // the matcher — which checks the same signal — reports a cut. Both loops
  // carry the check, and the two of them together are what make the note say
  // which loop actually stopped.
  if (stoppedBy === undefined && signal.aborted) stoppedBy = "abort";

  return {
    files,
    filesSkipped,
    bytesRead,
    ...(stoppedBy !== undefined ? { stoppedBy } : {}),
  };
}

/** Matches the file name and the workspace-relative path, like ripgrep's `-g`. */
function buildIncludeMatcher(include: string | undefined): (path: string) => boolean {
  if (include === undefined) return () => true;
  const regex = new RegExp(`^${globToSource(include)}$`);
  return (path: string) => regex.test(path) || regex.test(basenamePath(path));
}

/** The syntax this converter can express, quoted back to the model. */
const UNSUPPORTED_GLOB = "`!` negation, extglobs (`@(a|b)`, `*(a)`, `?(a)`, `!(a)`, `+(a)`) and POSIX classes (`[[:alpha:]]`)";

/**
 * Rejects what `convertGlob` cannot express.
 *
 * The converter covers `*`, `**`, `?`, `[…]`, `{a,b}` and `\`-escapes — the
 * subset the tests pin against picomatch (`verify-include.test.ts`). What it
 * does not cover used to return an empty result that is indistinguishable
 * from "no file matches", which is the one answer a model must never get
 * wrong. An unsupported pattern is now an error naming the syntax.
 */
function assertSupportedGlob(glob: string): void {
  if (glob === "") {
    // The reference forwards `include` straight to `rg --glob=`, where an
    // empty glob is an error. Here it would compile to `^$` and quietly match
    // nothing, so it is rejected with the same clarity.
    throw new ToolError(
      "`include` must not be empty. Omit the parameter to search every file, " +
        "or use `*`.",
    );
  }
  if (glob.startsWith("!")) {
    throw new ToolError(
      "`include` does not support " +
        UNSUPPORTED_GLOB +
        ". Drop the leading `!` and search the whole tree, or use several " +
        "narrower calls.",
    );
  }
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char !== undefined && next === "(" && "!@+?*".includes(char)) {
      throw new ToolError(
        "`include` does not support " +
          UNSUPPORTED_GLOB +
          ` — found the extglob \`(${glob.slice(index, index + 2)}\`. ` +
          "Write the alternatives explicitly, e.g. `*.{ts,tsx}`.",
      );
    }
    if (char === "[" && glob[index + 1] === "[") {
      throw new ToolError(
        "`include` does not support " +
          UNSUPPORTED_GLOB +
          " — found a POSIX class. Spell the characters out, e.g. `[a-zA-Z0-9]`.",
      );
    }
  }
}

/**
 * `include` is a filter, not this tool's product, so a compact glob is enough:
 * `*` (no `/`), `**` (any depth), `?`, `[…]`, `{a,b}` and `\` as an escape. The
 * full glob engine lives in the `glob` tool; grep only needs a predicate.
 *
 * Every divergence from picomatch/ripgrep after the honesty fix above is in
 * the *stricter* direction: `{a}` with no comma is the literal text `{a}`, like
 * picomatch, instead of being silently un-braced.
 */
function globToSource(glob: string): string {
  assertSupportedGlob(glob);
  return convertGlob(glob);
}

function convertGlob(glob: string): string {
  let source = "";
  let index = 0;

  while (index < glob.length) {
    const char = glob[index] ?? "";

    if (char === "\\") {
      // A real escape: `a\*b.ts` is the file name `a*b.ts`, which is what
      // picomatch and ripgrep's globset both mean. Escaping the backslash
      // instead made the pattern match a name that literally contains one.
      const escaped = glob[index + 1];
      if (escaped === undefined) {
        source += "\\\\";
        index += 1;
        continue;
      }
      source += escapeRegExp(escaped);
      index += 2;
      continue;
    }

    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 2;
        if (glob[index] === "/") {
          index += 1;
          // `**/` also matches zero directories: `**/*.ts` hits `a.ts`.
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
      } else {
        index += 1;
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }

    if (char === "[") {
      const close = glob.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\[";
        index += 1;
        continue;
      }
      const body = glob.slice(index + 1, close).replace(/^!/, "^");
      source += `[${body}]`;
      index = close + 1;
      continue;
    }

    if (char === "{") {
      const close = findClosingBrace(glob, index);
      if (close === -1) {
        source += "\\{";
        index += 1;
        continue;
      }
      const body = glob.slice(index + 1, close);
      const alternatives = splitTopLevel(body);
      if (alternatives.length === 1) {
        // No comma: picomatch reads `{a}` as the literal text `{a}`.
        source += `\\{${convertGlob(body)}\\}`;
      } else {
        source += `(?:${alternatives.map(convertGlob).join("|")})`;
      }
      index = close + 1;
      continue;
    }

    source += escapeRegExp(char);
    index += 1;
  }

  return source;
}

function findClosingBrace(glob: string, start: number): number {
  let depth = 0;
  for (let index = start; index < glob.length; index += 1) {
    if (glob[index] === "{") depth += 1;
    else if (glob[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

export default grepTool;

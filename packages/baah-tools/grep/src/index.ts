import {
  assertInsideRoot,
  basenamePath,
  byteLength,
  defineTool,
  ToolError,
  type Workspace,
} from "@all-the.rest/baah-core";
import { createIgnoreFilter } from "@all-the.rest/baah-core/ignore";
import type { FileEntry, MatchResult, RipgrepWasm, SearchOptions } from "grep-wasm";
import { z } from "zod";

/** Default number of matching lines returned per call. */
export const DEFAULT_GREP_LIMIT = 100;
/** Hard ceiling — a bigger result belongs in several narrower calls. */
export const MAX_GREP_LIMIT = 1000;

/** Longest single match line we hand back before truncating it. */
export const MAX_LINE_LENGTH = 500;

/** Files above this size are skipped: a minified bundle is not worth reading. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Total bytes one call may read before it stops scanning. */
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** Files handed to ripgrep per call — the WASM boundary marshals JSON. */
export const SEARCH_BATCH_SIZE = 200;

export const grepInputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Regular expression to search for, or plain text when `literal` is true.",
    ),
  path: z
    .string()
    .optional()
    .describe("Directory to search, relative to the workspace root. Defaults to `.`."),
  include: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Glob filter for file names, e.g. `*.{ts,tsx}`. Matched against the file " +
        "name and against the workspace-relative path.",
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
    .min(1)
    .max(MAX_GREP_LIMIT)
    .optional()
    .describe(`Maximum number of matching lines to return. Defaults to ${DEFAULT_GREP_LIMIT}.`),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

/** Which engine produced the matches. Both are first-class. */
export type GrepEngine = "grep-wasm" | "javascript";

export interface GrepMatch {
  /** Workspace-relative path. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The matching line, without its trailing newline. */
  text: string;
}

export interface GrepOutput {
  pattern: string;
  /** The resolved search root the walk started from. */
  path: string;
  engine: GrepEngine;
  matches: GrepMatch[];
  /** Matching lines found before `limit` was applied. */
  total: number;
  truncated: boolean;
  /** Files whose content was actually scanned. */
  filesScanned: number;
  /** Files skipped as binary or over `maxFileBytes`. */
  filesSkipped: number;
  /** Bytes read for this call. */
  bytesRead: number;
  /** The total byte cap that applies per call. */
  maxBytes: number;
  maxFileBytes: number;
  /** `true` when the byte cap (or an abort) stopped the scan early. */
  searchTruncated: boolean;
  /** Model-facing explanation: why the list is short or empty. */
  hint?: string;
  /** Set when the preferred engine was unavailable, or `.gitignore` could not be used. */
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
}

/**
 * The JavaScript `RegExp` scanner — the guaranteed-available engine.
 *
 * This is not a stub. `grep-wasm@0.1.0` is a single-maintainer package that can
 * fail (a CSP without `wasm-unsafe-eval`, a blocked `.wasm` download, a regex
 * dialect ripgrep rejects), and a harness that loses search when that happens is
 * broken. Both engines report one match per matching line, so their results are
 * equivalent; `Plan.md` §14.5 calls this path out by name.
 */
export function searchWithRegExp(input: RegExpSearchInput): GrepMatch[] {
  const regex = buildRegExp(input.pattern, input.caseSensitive);
  const matches: GrepMatch[] = [];

  for (const file of input.files) {
    const lines = splitLines(file.content);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || !regex.test(line)) continue;
      matches.push({ path: file.path, line: index + 1, text: clampLine(line) });
    }
  }

  return matches;
}

/**
 * The ripgrep-in-WASM engine. Loaded lazily so the ~1.8 MB `.wasm` stays out of
 * the initial chunk, and memoised so `init()` runs at most once per tab.
 */
let engine: Promise<RipgrepWasm | null> | undefined;
let engineError: string | undefined;

async function initEngine(): Promise<RipgrepWasm | null> {
  try {
    const module = await import("grep-wasm");
    await module.ripgrep.init();
    return module.ripgrep;
  } catch (error) {
    // Not swallowed: the reason reaches the tool result.
    engineError = describe(error);
    return null;
  }
}

function loadEngine(): Promise<RipgrepWasm | null> {
  engine ??= initEngine();
  return engine;
}

interface WasmSearchInput {
  files: readonly GrepFile[];
  pattern: string;
  literal: boolean;
  caseSensitive: boolean;
}

/** Runs the search through ripgrep. Throws so the caller can fall back. */
async function searchWithRipgrep(input: WasmSearchInput): Promise<GrepMatch[]> {
  const ripgrep = await loadEngine();
  if (ripgrep === null) {
    throw new Error(engineError ?? "the WebAssembly module did not initialise");
  }

  // Option names verified against `grep-wasm@0.1.0` `dist/types.d.ts`
  // (`SearchOptions`); the SDK maps them onto the snake_case WASM keys in
  // `dist/sdk.js` (`convertOptions`).
  const options: SearchOptions = {
    caseInsensitive: !input.caseSensitive,
    fixedStrings: input.literal,
    lineNumbers: true,
    outputFormat: "detailed",
  };

  const matches: GrepMatch[] = [];
  for (let start = 0; start < input.files.length; start += SEARCH_BATCH_SIZE) {
    const batch: FileEntry[] = input.files
      .slice(start, start + SEARCH_BATCH_SIZE)
      .map((file) => ({ path: file.path, content: file.content }));

    const result = await ripgrep.search(input.pattern, batch, options);
    for (const match of result.matches) {
      matches.push(toMatch(match));
    }
  }
  return matches;
}

function toMatch(match: MatchResult): GrepMatch {
  return { path: match.path, line: match.lineNumber, text: clampLine(match.line) };
}

interface SearchRun {
  engine: GrepEngine;
  matches: GrepMatch[];
  /** Why the preferred engine was not used. */
  note?: string;
}

/**
 * Runs the search on the preferred engine and degrades to the JS scanner when
 * it is unavailable. `grep-wasm@0.1.0` has one maintainer and can fail for
 * reasons we cannot fix from here (a CSP without `wasm-unsafe-eval`, a blocked
 * `.wasm` download) or that are simply dialect differences (ripgrep's Rust
 * regex rejects lookaround and backreferences the JS engine accepts). A search
 * tool that goes down with it would be useless, so the fallback is equal, not
 * decorative.
 */
async function runSearch(
  files: readonly GrepFile[],
  input: GrepInput,
  literal: boolean,
  caseSensitive: boolean,
): Promise<SearchRun> {
  // Nothing to scan: report the empty result without fetching 1.8 MB of WASM.
  if (files.length === 0) return { engine: "javascript", matches: [] };

  try {
    const matches = await searchWithRipgrep({
      files,
      pattern: input.pattern,
      literal,
      caseSensitive,
    });
    return { engine: "grep-wasm", matches };
  } catch (error) {
    return {
      engine: "javascript",
      matches: searchWithRegExp({
        files,
        pattern: literal ? escapeRegExp(input.pattern) : input.pattern,
        caseSensitive,
      }),
      note: `grep-wasm unavailable (${describe(error)}) — used the JavaScript scanner.`,
    };
  }
}

function compareMatches(a: GrepMatch, b: GrepMatch): number {
  const byPath = a.path.localeCompare(b.path);
  if (byPath !== 0) return byPath;
  return a.line - b.line;
}

export const grepTool = defineTool<GrepInput, GrepOutput>({
  id: "grep",
  description:
    "Search file contents with a regular expression. Scans every text file " +
    "under `path` (default `.`), skipping hidden entries, build output, " +
    "`node_modules`, binary files and whatever the workspace `.gitignore` " +
    "excludes. Use `include` to restrict by file glob (e.g. `*.{ts,tsx}`), " +
    "`literal: true` to search for exact text, `caseSensitive: false` to ignore " +
    "case. Returns `path`/`line`/`text` matches sorted by path, plus the `engine` " +
    "that ran and `truncated`/`searchTruncated` so you can narrow the search " +
    "instead of re-running it.",
  access: "read",
  inputSchema: grepInputSchema,
  async execute(context, input) {
    const path = assertInsideRoot(context.cwd, input.path ?? ".");
    const limit = input.limit ?? DEFAULT_GREP_LIMIT;
    const literal = input.literal ?? false;
    const caseSensitive = input.caseSensitive ?? true;

    // Validate the pattern before touching the filesystem: an invalid regex is
    // a model mistake, not a search failure. `literal` never compiles one.
    if (!literal) buildRegExp(input.pattern, caseSensitive);

    if (path !== ".") {
      const stat = await context.workspace.stat(path);
      if (!stat) throw new ToolError(`Directory not found: ${path}`);
      if (stat.kind !== "directory") throw new ToolError(`Not a directory: ${path}`);
    }

    const isIgnored = await createIgnoreFilter(context.workspace);
    const isIncluded = buildIncludeMatcher(input.include);

    const candidates: Candidate[] = [];
    for await (const entry of context.workspace.walk(path, {
      signal: context.signal,
      filter: (visited) => !isIgnored(visited.path, visited.kind),
    })) {
      if (entry.kind !== "file") continue;
      if (!isIncluded(entry.path)) continue;
      candidates.push({
        path: entry.path,
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      });
    }
    candidates.sort((a, b) => a.path.localeCompare(b.path));

    const scan = await scanCandidates(context.workspace, candidates, context.signal);
    const run = await runSearch(scan.files, input, literal, caseSensitive);
    const notes: string[] = [];
    if (run.note !== undefined) notes.push(run.note);

    run.matches.sort(compareMatches);
    const total = run.matches.length;
    const truncated = total > limit;
    const shown = run.matches.slice(0, limit);
    if (isIgnored.gitignoreError !== undefined) {
      notes.push(`${isIgnored.gitignoreError} — search continued without it.`);
    }
    if (scan.aborted) notes.push(`Search aborted after ${scan.files.length} files.`);
    const hint = buildHint(input, total, shown.length, scan.searchTruncated);

    return {
      pattern: input.pattern,
      path,
      engine: run.engine,
      matches: shown,
      total,
      truncated,
      filesScanned: scan.files.length,
      filesSkipped: scan.filesSkipped,
      bytesRead: scan.bytesRead,
      maxBytes: MAX_TOTAL_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
      searchTruncated: scan.searchTruncated,
      ...(hint !== undefined ? { hint } : {}),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  },
});

function buildHint(
  input: GrepInput,
  total: number,
  shown: number,
  searchTruncated: boolean,
): string | undefined {
  if (total === 0) {
    return (
      `No line matches "${input.pattern}" under "${input.path ?? "."}". Widen ` +
      "`path`, set `include`, drop `literal` to search with a regex, or try " +
      "`caseSensitive: false`."
    );
  }
  if (searchTruncated) {
    return (
      `The byte cap stopped the scan, so these ${shown} matches are incomplete. ` +
      "Narrow `path`/`include` and search a subtree."
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
  bytesRead: number;
  searchTruncated: boolean;
  aborted: boolean;
}

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
  let aborted = signal.aborted;

  for (const candidate of candidates) {
    if (signal.aborted) {
      aborted = true;
      break;
    }
    // A file already known to be over the cap is never read.
    if (candidate.size !== undefined && candidate.size > MAX_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }
    if (bytesRead >= MAX_TOTAL_BYTES) {
      return { files, filesSkipped, bytesRead, searchTruncated: true, aborted };
    }

    const content = await workspace.readText(candidate.path);
    const size = byteLength(content);
    if (content.includes(NUL) || size > MAX_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }

    files.push({ path: candidate.path, content });
    bytesRead += size;
  }

  return { files, filesSkipped, bytesRead, searchTruncated: aborted, aborted };
}

/**
 * `include` is a filter, not this tool's product, so a compact glob is enough:
 * `*` (no `/`), `**` (any depth), `?`, `[…]` and `{a,b}`. The full glob engine
 * lives in the `glob` tool; grep only needs a predicate.
 */
function globToSource(glob: string): string {
  let source = "";
  let index = 0;

  while (index < glob.length) {
    const char = glob[index] ?? "";

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
      const alternatives = splitTopLevel(glob.slice(index + 1, close)).map(globToSource);
      source += `(?:${alternatives.join("|")})`;
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

/** Matches the file name and the workspace-relative path, like ripgrep's `-g`. */
function buildIncludeMatcher(include: string | undefined): (path: string) => boolean {
  if (include === undefined) return () => true;
  const regex = new RegExp(`^${globToSource(include)}$`);
  return (path: string) => regex.test(path) || regex.test(basenamePath(path));
}

export default grepTool;

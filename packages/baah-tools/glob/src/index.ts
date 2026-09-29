import {
  assertInsideRoot,
  DEFAULT_MAX_ENTRIES,
  defineTool,
  relativePath,
  ToolError,
  walkMayBeIncomplete,
  type DirEntry,
} from "@all-the.rest/baah-core";
import { createIgnoreFilter } from "@all-the.rest/baah-core/ignore";
import picomatch from "picomatch";
import { z } from "zod";

/** Default number of paths returned per call (reference: `DEFAULT_SEARCH_LIMIT`). */
export const DEFAULT_GLOB_LIMIT = 100;

export const globInputSchema = z.object({
  pattern: z
    .string()
    // `.min(1)` is a deliberate deviation: the reference
    // (`FileSystem.GlobInput.pattern`, opencode v2.0.19) only annotates the
    // field and adds no length check. An empty glob is a user error, not a
    // query — it matches every file under `path` and answers nothing — so it
    // is rejected at the schema instead of returning the whole tree. Do not
    // "fix" this back to the reference without deciding that a full-tree dump
    // is a reasonable answer.
    .min(1)
    .describe(
      "Glob to match, e.g. `**/*.ts`, `src/**` or `*.{ts,tsx}`. Matched against " +
        "paths relative to `path`.",
    ),
  path: z
    .string()
    .optional()
    .describe("Directory to search, relative to the workspace root. Defaults to `.`."),
  hidden: z
    .boolean()
    .optional()
    .describe("Include dotfiles and dot-directories. Defaults to false."),
  limit: z
    .number()
    .int()
    // `.min(1)` only. The reference types this as `PositiveInt` — no upper
    // bound — and a model asking for `limit: 5000` gets a validation error
    // here and a result there. An invented ceiling is a divergence, not
    // safety: the walk cap and `limit` are what bound the work, not the
    // requested maximum. A limit of 0 is kept out because "return no files" is
    // not a question anyone means to ask.
    .min(1)
    .optional()
    .describe(`Maximum number of paths to return. Defaults to ${DEFAULT_GLOB_LIMIT}.`),
});

export type GlobInput = z.infer<typeof globInputSchema>;

export interface GlobOutput {
  pattern: string;
  /** The resolved search root the walk started from. */
  path: string;
  /** Workspace-relative, sorted, capped at `limit`. */
  files: string[];
  /** Matches found before `limit` was applied. */
  total: number;
  /** `true` when `limit` cut the list, i.e. the search itself was complete. */
  truncated: boolean;
  /**
   * `true` when the walk did not see every entry, so `total` and `files`
   * cover only the part of the tree that was visited. An empty result with
   * `searchTruncated: false` means "no match in what I looked at"; with `true`
   * it means "I stopped looking".
   *
   * Deliberately over-reporting: a workspace of exactly the walk's entry cap
   * sets it, although that walk saw everything. See `walkMayBeIncomplete`.
   */
  searchTruncated: boolean;
  /** Model-facing explanation: why the list is short or empty. */
  hint?: string;
  /** Set when the workspace `.gitignore` could not be used. */
  note?: string;
}

/** Explains a short or empty result so the model does not re-run the same call. */
function buildHint(
  pattern: string,
  path: string,
  shown: number,
  total: number,
  searchTruncated: boolean,
): string | undefined {
  if (searchTruncated) {
    return (
      `These ${shown} of ${total} matches do not cover the whole tree: the walk ` +
      "stopped before it had seen every entry (an abort, or the " +
      `${DEFAULT_MAX_ENTRIES}-entry cap). Narrow \`path\` and search a subtree — this ` +
      "is not a complete answer."
    );
  }
  if (total === 0) {
    return (
      `No file matches "${pattern}" under "${path}". Check the pattern, or widen ` +
      "`path` / set `hidden: true`."
    );
  }
  if (shown < total) {
    return (
      `Showing ${shown} of ${total} matches. Narrow the pattern (add a directory ` +
      "prefix or an extension) or raise `limit` — do not re-run the same glob."
    );
  }
  return undefined;
}

export const globTool = defineTool<GlobInput, GlobOutput>({
  id: "glob",
  description:
    "Find files by glob pattern in the workspace. The pattern is matched " +
    "against paths relative to `path` (default `.`), so `path: \"src\"` with " +
    "pattern `**/*.ts` searches only `src`. Skips build output, " +
    "`node_modules`, binary files and whatever the workspace `.gitignore` " +
    "excludes. Returns sorted, workspace-relative paths plus `total`/`truncated` " +
    "so you can narrow the pattern instead of re-running it. `hidden: true` " +
    "includes dotfiles. **Read `searchTruncated`**: it is `true` when the walk " +
    "hit the workspace entry cap, so the result covers only part of the tree.",
  access: "read",
  inputSchema: globInputSchema,
  async execute(context, input) {
    const path = assertInsideRoot(context.cwd, input.path ?? ".");
    const limit = input.limit ?? DEFAULT_GLOB_LIMIT;
    const hidden = input.hidden ?? false;

    if (path !== ".") {
      const stat = await context.workspace.stat(path);
      if (!stat) throw new ToolError(`Directory not found: ${path}`);
      if (stat.kind !== "directory") throw new ToolError(`Not a directory: ${path}`);
    }

    const isIgnored = await createIgnoreFilter(context.workspace, { includeHidden: hidden });
    const isMatch = picomatch(input.pattern, { dot: hidden, posixSlashes: true });

    const files: string[] = [];
    const notes: string[] = [];
    let total = 0;
    // The walk owns the answer to "did you see everything?". This tool no
    // longer counts entries and no longer knows the cap: both used to be
    // duplicated here and both drifted apart from core.
    const walk = context.workspace.walk(path, {
      signal: context.signal,
      filter: (candidate: DirEntry) => !isIgnored(candidate.path, candidate.kind),
    });
    for await (const entry of walk.entries) {
      if (entry.kind === "file" && isMatch(relativePath(path, entry.path))) {
        total += 1;
        if (files.length < limit) files.push(entry.path);
      }
    }
    // The conservative reading, from the module that knows the cap. A walk that
    // finished *exactly* at the cap is reported here even though it saw
    // everything: the direction of the error is deliberately one-way, because a
    // model that is told "possibly incomplete" once too often learns to ignore
    // the field, and one told "complete" too often acts on a search that was
    // not.
    let searchTruncated = walkMayBeIncomplete(walk);
    if (walk.truncated) {
      notes.push(
        `The workspace walk stopped at its ${DEFAULT_MAX_ENTRIES}-entry cap; ` +
          "entries after that point were never visited.",
      );
    }
    // An abort that lands during the walk ends the iteration without yielding
    // the rest. `walk` checks the signal at the top of each step, so this is
    // the only place that can observe it for the entries already seen. It fires
    // for a signal that was aborted on entry too — an empty result from a
    // search that never looked is the case that most needs saying.
    // Two cases, one check: a signal that was already aborted on entry (the
    // walk yields nothing) and one that fired during it (the walk stops early).
    // Both end with "not every entry was seen", and the post-loop read is the
    // only place that can tell.
    if (context.signal.aborted) {
      searchTruncated = true;
      notes.push("Search aborted — the walk stopped before it had seen every entry.");
    }

    files.sort((a, b) => a.localeCompare(b));
    const truncated = total > limit;
    const hint = buildHint(input.pattern, path, files.length, total, searchTruncated);

    if (isIgnored.gitignoreError !== undefined) {
      notes.unshift(`${isIgnored.gitignoreError} — search continued without it.`);
    }

    return {
      pattern: input.pattern,
      path,
      files,
      total,
      truncated,
      searchTruncated,
      ...(hint !== undefined ? { hint } : {}),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  },
});

export default globTool;

import {
  assertInsideRoot,
  defineTool,
  relativePath,
  ToolError,
  type DirEntry,
} from "@all-the.rest/baah-core";
import { createIgnoreFilter } from "@all-the.rest/baah-core/ignore";
import picomatch from "picomatch";
import { z } from "zod";

/** Default number of paths returned per call. */
export const DEFAULT_GLOB_LIMIT = 100;
/** Hard ceiling — a bigger result belongs in several narrower calls. */
export const MAX_GLOB_LIMIT = 1000;

export const globInputSchema = z.object({
  pattern: z
    .string()
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
    .min(1)
    .max(MAX_GLOB_LIMIT)
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
  truncated: boolean;
  /** Model-facing explanation: why the list is short or empty. */
  hint?: string;
  /** Set when the workspace `.gitignore` could not be used. */
  note?: string;
}

/** Explains a short or empty result so the model does not re-run the same call. */
function buildHint(pattern: string, path: string, shown: number, total: number): string | undefined {
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
    "pattern `**/*.ts` searches only `src`. Skips hidden entries, build output, " +
    "`node_modules`, binary files and whatever the workspace `.gitignore` " +
    "excludes. Returns sorted, workspace-relative paths plus `total`/`truncated` " +
    "so you can narrow the pattern instead of re-running it. `hidden: true` " +
    "includes dotfiles.",
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
    let total = 0;
    for await (const entry of context.workspace.walk(path, {
      signal: context.signal,
      filter: (candidate: DirEntry) => !isIgnored(candidate.path, candidate.kind),
    })) {
      if (entry.kind !== "file") continue;
      if (!isMatch(relativePath(path, entry.path))) continue;
      total += 1;
      if (files.length < limit) files.push(entry.path);
    }

    files.sort((a, b) => a.localeCompare(b));
    const truncated = total > limit;
    const hint = buildHint(input.pattern, path, files.length, total);

    return {
      pattern: input.pattern,
      path,
      files,
      total,
      truncated,
      ...(hint !== undefined ? { hint } : {}),
      ...(isIgnored.gitignoreError !== undefined
        ? { note: `${isIgnored.gitignoreError} — search continued without it.` }
        : {}),
    };
  },
});

export default globTool;

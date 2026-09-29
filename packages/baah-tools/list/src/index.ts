import { assertInsideRoot, defineTool, ToolError, type DirEntry } from "@all-the.rest/baah-core";
import { z } from "zod";

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;

export const listInputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory to list, relative to the workspace root. Defaults to `.`."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_LIMIT)
    .optional()
    .describe(
      `Maximum number of entries to return. Defaults to ${DEFAULT_LIST_LIMIT}.`,
    ),
});

export type ListInput = z.infer<typeof listInputSchema>;

export interface ListEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  /** Bytes; only present for files. */
  size?: number;
}

export interface ListOutput {
  path: string;
  entries: ListEntry[];
  /** Total entry count before `limit` was applied. */
  total: number;
  truncated: boolean;
}

/** Directories first, then files; each group alphabetical, case-insensitive. */
function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  const aLower = a.name.toLowerCase();
  const bLower = b.name.toLowerCase();
  if (aLower < bLower) return -1;
  if (aLower > bLower) return 1;
  return a.name.localeCompare(b.name);
}

function toListEntry(entry: DirEntry): ListEntry {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    ...(entry.kind === "file" && entry.size !== undefined ? { size: entry.size } : {}),
  };
}

export const listTool = defineTool<ListInput, ListOutput>({
  id: "list",
  description:
    "List the direct children of a directory in the workspace. Directories " +
    `come first, then files (each alphabetical). Returns at most \`limit\` ` +
    `entries (default ${DEFAULT_LIST_LIMIT}) and reports \`total\` and ` +
    "`truncated` when there are more.",
  access: "read",
  inputSchema: listInputSchema,
  async execute(context, input) {
    const requested = input.path ?? ".";
    const path = assertInsideRoot(context.cwd, requested);
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;

    // The workspace root always exists; only stat real sub-paths.
    if (path !== ".") {
      const stat = await context.workspace.stat(path);
      if (!stat) throw new ToolError(`Directory not found: ${path}`);
      if (stat.kind !== "directory") throw new ToolError(`Not a directory: ${path}`);
    }

    const entries = await context.workspace.list(path);
    const sorted = [...entries].sort(compareEntries);
    const total = sorted.length;

    return {
      path,
      entries: sorted.slice(0, limit).map(toListEntry),
      total,
      truncated: total > limit,
    };
  },
});

export default listTool;

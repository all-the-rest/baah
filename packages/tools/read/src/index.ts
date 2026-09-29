import { assertInsideRoot, defineTool, ToolError } from "@ohw/core";
import { z } from "zod";

/** Longest single line we hand back before truncating it. */
export const MAX_LINE_LENGTH = 2000;
/** Default and maximum number of lines per call. */
export const DEFAULT_LIMIT = 2000;

export const readInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Path of the file to read, relative to the workspace root."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number to start reading from. Defaults to 1."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_LIMIT)
    .optional()
    .describe(`Maximum number of lines to return. Defaults to ${DEFAULT_LIMIT}.`),
});

export type ReadInput = z.infer<typeof readInputSchema>;

export interface ReadOutput {
  path: string;
  /** Line-numbered content, `"<n>: <text>"` per line. */
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

const NUL = "\u0000";

/** Heuristic: a NUL byte in the first chunk means "not a text file". */
function assertTextFile(path: string, content: string): void {
  if (content.includes(NUL)) {
    throw new ToolError(
      `File appears to be binary and cannot be read as text: ${path}`,
    );
  }
}

export function formatLines(lines: readonly string[], startLine: number): string {
  return lines
    .map((line, index) => {
      const number = startLine + index;
      const text =
        line.length > MAX_LINE_LENGTH
          ? `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated]`
          : line;
      return `${number}: ${text}`;
    })
    .join("\n");
}

export const readTool = defineTool<ReadInput, ReadOutput>({
  id: "read",
  description:
    "Read a text file from the workspace. Returns line-numbered content " +
    `(\`<line>: <text>\`), starting at \`offset\` (1-based) and returning at most ` +
    `\`limit\` lines (default ${DEFAULT_LIMIT}). Use \`offset\` to continue a long ` +
    "file instead of reading it again. Binary files are rejected.",
  access: "read",
  inputSchema: readInputSchema,
  async execute(context, input) {
    const path = assertInsideRoot(context.cwd, input.path);

    const stat = await context.workspace.stat(path);
    if (!stat) throw new ToolError(`File not found: ${input.path}`);
    if (stat.kind !== "file") throw new ToolError(`Not a file: ${input.path}`);

    const raw = await context.workspace.readText(path);
    assertTextFile(input.path, raw);

    const allLines = raw.split("\n");
    // A trailing newline produces one empty phantom line; drop it.
    if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();

    const totalLines = allLines.length;
    const startLine = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const startIndex = Math.min(startLine - 1, totalLines);
    const selected = allLines.slice(startIndex, startIndex + limit);
    const endLine = selected.length === 0 ? startLine - 1 : startLine + selected.length - 1;

    return {
      path: input.path,
      content: formatLines(selected, startLine),
      startLine,
      endLine,
      totalLines,
      truncated: endLine < totalLines,
    };
  },
});

export default readTool;

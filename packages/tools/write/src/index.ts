import { assertInsideRoot, defineTool, ToolError } from "@ohw/core";
import { z } from "zod";

/**
 * Largest payload we accept in one call. `writeText` holds the whole string in
 * memory twice (UTF-8 encode + store), so a hard cap keeps a runaway model
 * from freezing the tab.
 */
export const MAX_CONTENT_BYTES = 5_000_000;

export const writeInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Path of the file to write, relative to the workspace root."),
  content: z.string().describe("Full text content to write to the file."),
});

export type WriteInput = z.infer<typeof writeInputSchema>;

export interface WriteOutput {
  path: string;
  /** UTF-8 byte length of the written content. */
  bytesWritten: number;
  /** `true` when the file did not exist before this call. */
  created: boolean;
}

export const writeTool = defineTool<WriteInput, WriteOutput>({
  id: "write",
  description:
    "Write text to a file in the workspace, overwriting it if it exists and " +
    "creating missing parent directories as needed. Prefer `edit` for targeted " +
    "changes to an existing file.",
  access: "write",
  inputSchema: writeInputSchema,
  async execute(context, input) {
    const path = assertInsideRoot(context.cwd, input.path);

    const bytesWritten = new TextEncoder().encode(input.content).length;
    if (bytesWritten > MAX_CONTENT_BYTES) {
      throw new ToolError(
        `Content too large: ${bytesWritten} bytes exceeds the ` +
          `${MAX_CONTENT_BYTES}-byte limit. Split the write into smaller files.`,
      );
    }

    // Determine existence BEFORE writing, otherwise an overwrite looks "new".
    // A directory target is rejected here so the model gets a ToolError rather
    // than a raw workspace error.
    const stat = await context.workspace.stat(path);
    if (stat?.kind === "directory") {
      throw new ToolError(`Not a file: ${path}`);
    }
    const created = stat === null;

    await context.workspace.writeText(path, input.content);

    return { path, bytesWritten, created };
  },
});

export default writeTool;

import { assertInsideRoot, defineTool, ToolError } from "@ohw/core";
import { z } from "zod";

export const editInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Path of the file to edit, relative to the workspace root."),
  oldString: z
    .string()
    .min(1)
    .describe("Exact text to find. Must match the file byte for byte."),
  newString: z.string().describe("Replacement text for the matched region."),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence. Required when `oldString` appears more than once.",
    ),
});

export type EditInput = z.infer<typeof editInputSchema>;

export interface EditOutput {
  path: string;
  /** Number of occurrences that were replaced. */
  replacements: number;
}

/** Exact substring replacement — deliberately not fuzzy. */
export const editTool = defineTool<EditInput, EditOutput>({
  id: "edit",
  description:
    "Replace an exact substring in a file. `oldString` must match the file " +
    "exactly (including whitespace); there is no fuzzy matching. If it occurs " +
    "more than once, add surrounding context to make it unique or set " +
    "`replaceAll: true`. Read the file first when unsure of the exact text.",
  access: "write",
  inputSchema: editInputSchema,
  async execute(context, input) {
    if (input.oldString === input.newString) {
      throw new ToolError("oldString and newString are identical");
    }

    const path = assertInsideRoot(context.cwd, input.path);

    const stat = await context.workspace.stat(path);
    if (!stat) {
      throw new ToolError(`File not found: ${path}`);
    }
    if (stat.kind !== "file") {
      throw new ToolError(`Not a file: ${path}`);
    }

    const content = await context.workspace.readText(path);
    const occurrences = content.split(input.oldString).length - 1;

    if (occurrences === 0) {
      throw new ToolError(
        `String not found in ${path}. Read the file again and match the exact ` +
          "text, including whitespace.",
      );
    }

    if (occurrences > 1 && input.replaceAll !== true) {
      throw new ToolError(
        `Found ${occurrences} occurrences of oldString in ${path}. Add more ` +
          "surrounding context to make it unique, or pass `replaceAll: true` " +
          "to replace every occurrence.",
      );
    }

    // `String.replace` would treat `$` sequences in `newString` specially, so
    // splice by index to keep the replacement literal.
    const firstIndex = content.indexOf(input.oldString);
    const updated =
      input.replaceAll === true
        ? content.split(input.oldString).join(input.newString)
        : content.slice(0, firstIndex) +
          input.newString +
          content.slice(firstIndex + input.oldString.length);

    await context.workspace.writeText(path, updated);

    return { path, replacements: occurrences };
  },
});

export default editTool;

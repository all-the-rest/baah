import { assertInsideRoot, byteLength, defineTool, ToolError } from "@all-the.rest/baah-core";
import { z } from "zod";

/**
 * `patch` — several exact replacements in one file, applied as one write.
 *
 * ## Why hunks match by context, not by line number
 *
 * The alternative was a real one: a hunk could carry `startLine` and the tool
 * would splice at that offset. It is rejected, and the reason is what a stale
 * line number does when it is wrong.
 *
 * A model produces a line number from a read it may have done forty steps ago.
 * Since that read, an earlier `edit` in the same turn, a retried `write`, or the
 * user typing in a real File System Access folder can all have moved the file.
 * A line number is only valid against one exact revision of one file, and this
 * tool has no way to know which revision the model was looking at.
 *
 * Now consider the failure. A stale line number whose context *no longer*
 * matches is loud — the file changes shape and the spliced text is visibly
 * wrong. The dangerous case is the opposite: a file that changed by **the same
 * number of lines** elsewhere. The number stays in range, the tool writes
 * happily, and the hunk lands in the wrong place with no signal at all. Line
 * numbers are therefore not a weaker match, they are a *corruption vector*:
 * they make "the model was out of date" indistinguishable from "the patch
 * applied".
 *
 * A context match has the opposite failure profile, and it is the good one: it
 * either matches — and the result reports the line each hunk landed on, so a
 * wrong-but-successful patch is visible in the output — or it does not, and the
 * call fails with the file untouched.
 *
 * This is also what `edit` already decided. `edit` matches an exact substring
 * and is "deliberately not fuzzy"; line numbers would be exactly the fuzzy
 * matching it refused, only worse, because they would not even say what they
 * matched. `Plan.md` §4 describes this tool as a "Mehr-Hunk-Editor auf
 * `edit`-Basis", and the basis is the matching rule, not just the file API.
 *
 * **So there is one mechanism, not two.** No `startLine`, no fuzzy fallback, no
 * "try the number, then try the context". A dual scheme needs a stated rule for
 * which one wins when they disagree, and there is no disagreement in which one
 * can be trusted: the context is checkable and the number is not.
 */

/**
 * Largest patch result accepted, in bytes.
 *
 * The same 5 MB the `write` tool uses, and deliberately **not** imported from
 * it: `AGENTS.md` §4 forbids a tool from depending on another tool, so the
 * number is restated here. `patch` does not create content, but it can grow a
 * file, and the guard has to exist before the single write rather than after.
 */
export const MAX_RESULT_BYTES = 5_000_000;

export const patchHunkSchema = z.object({
  /**
   * The exact text to find. **Not** a pattern, not a line range.
   *
   * Non-empty on purpose. An empty `before` would be "insert at an arbitrary
   * position" — the purest form of the duplicate-context hazard below, since
   * there is nothing to anchor the position on at all.
   */
  before: z
    .string()
    .min(1)
    .describe(
      "Exact text to find, byte for byte including indentation. Read the file " +
        "first; do not compute line numbers, this tool matches on text.",
    ),
  /**
   * The replacement. May be empty — that is how a region is deleted, and it is
   * the one place emptiness is legal and meaningful.
   */
  after: z.string().describe("Replacement text for the matched region."),
});

export type PatchHunk = z.infer<typeof patchHunkSchema>;

export const patchInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Path of the file to patch, relative to the workspace root."),
  /**
   * At least one hunk. An empty list is rejected rather than treated as a no-op:
   * a patch that changes nothing still writes, which moves the mtime, trips
   * watchers and reports "applied" for work that was never done.
   */
  hunks: z.array(patchHunkSchema)
    .min(1)
    .describe(
      "Hunks applied in order, each against the text the previous ones " +
        "produced. Every `before` must match exactly once at the moment it is " +
        "applied.",
    ),
});

export type PatchInput = z.infer<typeof patchInputSchema>;

export interface PatchOutput {
  path: string;
  /** How many hunks applied. Always equal to `hunks.length` on success. */
  hunksApplied: number;
  /** 1-based line of each hunk's match, in the text that hunk was applied to. */
  appliedAt: number[];
  /** UTF-8 byte length of the new content. */
  bytesWritten: number;
}

interface AppliedPatch {
  text: string;
  /** 1-based line of each hunk's match. */
  appliedAt: number[];
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let position = text.indexOf("\n"); position !== -1 && position < index; position = text.indexOf("\n", position + 1)) {
    line += 1;
  }
  return line;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * Applies every hunk in memory, or throws having applied nothing.
 *
 * This function has no workspace access and no side effect: it is a pure
 * `(text) => text` that either returns the finished file or throws. That is
 * the whole of the atomicity guarantee — the caller cannot write a partial file
 * because the partial state never leaves this function, and the *only* way to
 * get a partial file is to write inside the loop, which is the mutation this
 * suite exists to kill.
 *
 * The order is **sequential, in the given list order**, each hunk matching
 * against the text its predecessors produced. That is what makes "insert, then
 * rewrite the inserted text" expressible, and it is also what makes overlap
 * detectable: if hunk 2's `before` overlaps the region hunk 1 replaced, hunk 2
 * simply no longer finds its text, and the call fails rather than guessing.
 */
export function applyHunks(content: string, hunks: readonly PatchHunk[], path: string): AppliedPatch {
  // Unreachable through the schema, which already requires at least one hunk.
  // It is here because `execute` is public: a direct call with an empty list
  // would otherwise write the file back unchanged — moving its mtime, tripping
  // watchers and reporting `hunksApplied: 0` as though work had been done.
  if (hunks.length === 0) {
    throw new ToolError(
      `patch: no hunks for ${path}. A patch with an empty list changes nothing, ` +
        "so nothing was written. Send at least one hunk, or use `edit` for a " +
        "single replacement.",
    );
  }

  let text = content;
  const appliedAt: number[] = [];

  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    // `noUncheckedIndexedAccess` plus a schema that guarantees the length.
    if (hunk === undefined) continue;
    const position = index + 1;

    if (hunk.before === hunk.after) {
      throw new ToolError(
        `patch: hunk ${position} of ${hunks.length} in ${path} has identical ` +
          "`before` and `after`. A hunk that changes nothing is a mistake in " +
          "the request, not a no-op to write.",
      );
    }

    const occurrences = countOccurrences(text, hunk.before);
    if (occurrences === 0) {
      // `content`, not `text`: the diagnostic must describe the file the model
      // can actually read. After hunk 1 the in-memory text matches nothing on
      // disk, and quoting *it* would send the model to compare against a
      // version of the file that does not exist.
      throw new ToolError(
        `patch: hunk ${position} of ${hunks.length} does not match anything in ` +
          `${path}.${describeFile(content)} Your \`before\` begins with ` +
          `${JSON.stringify(hunk.before.split("\n")[0] ?? "")}. Nothing was ` +
          "written. Read the file again and copy the `before` text out of it " +
          "exactly, including indentation; do not compute line numbers.",
      );
    }
    if (occurrences > 1) {
      throw new ToolError(
        `patch: the \`before\` text of hunk ${position} of ${hunks.length} ` +
          `matches ${occurrences} places in ${path}. Add surrounding lines to ` +
          "make it unique, or split the region. Nothing was written. Earlier " +
          "hunks have already been applied *in memory only*; the file on disk is " +
          "unchanged, so re-send the whole patch.",
      );
    }

    // Spliced by index rather than `String.replace`, so `$&` and friends in
    // `after` stay literal — the same reason `edit` does it.
    const at = text.indexOf(hunk.before);
    appliedAt.push(lineOf(text, at));
    text = text.slice(0, at) + hunk.after + text.slice(at + hunk.before.length);
  }

  return { text, appliedAt };
}

function lineCount(text: string): number {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function endsWithNewline(text: string): boolean {
  return text.endsWith("\n");
}

/**
 * Evidence for a failed match, without guessing.
 *
 * Four facts about the file as it is on disk: how many lines it has, whether it
 * ends with a newline, and its first and last non-empty line. That is
 * *evidence*, not fuzzy matching — nothing is matched by it and no hunk is
 * applied on the strength of it. It exists because the two commonest reasons a
 * context match fails are a stale read and a trailing-newline mismatch, and
 * both are answerable from exactly these facts.
 */
function describeFile(text: string): string {
  const populated = text.split("\n").filter((line) => line !== "");
  const first = populated[0] ?? "";
  const last = populated[populated.length - 1] ?? "";
  return (
    ` The file as it is on disk has ${lineCount(text)} line(s) and ` +
    `${endsWithNewline(text) ? "ends with a newline" : "does not end with a newline"}` +
    `; its first line is ${JSON.stringify(first)} and its last non-empty line is ` +
    `${JSON.stringify(last)}.`
  );
}

export const patchTool = defineTool<PatchInput, PatchOutput>({
  id: "patch",
  description:
    "Apply several exact replacements to one file as a single atomic write. " +
    "Each hunk has `before` (exact text, byte for byte) and `after`; the " +
    "hunks are applied in order, each against the text the previous ones " +
    "produced, and every `before` must match exactly once at that moment. " +
    "Hunks match on **text, never on line numbers** — a line number from a " +
    "stale read would land in the wrong place silently, so do not compute one. " +
    "**All or nothing:** if any hunk does not match, the file is left exactly " +
    "as it was, not partially patched, and the error names the hunk. Read the " +
    "file first. Use `edit` for a single replacement, and `write` to create or " +
    "replace a whole file.",
  access: "write",
  inputSchema: patchInputSchema,
  async execute(context, input) {
    const path = assertInsideRoot(context.cwd, input.path);

    // Existence and kind are settled before any of the hunks are looked at, so
    // a missing file cannot be reported as a hunk that failed to match.
    const stat = await context.workspace.stat(path);
    if (!stat) {
      throw new ToolError(
        `patch: file not found: ${path}. \`patch\` edits an existing file and ` +
          "never creates one — a patch that fails half-way would leave a new " +
          "file behind. Use `write` to create it.",
      );
    }
    if (stat.kind !== "file") {
      throw new ToolError(`patch: not a file: ${path}`);
    }

    const original = await context.workspace.readText(path);
    // One call, no workspace writes in between: if it throws, the file is
    // untouched by construction.
    const applied = applyHunks(original, input.hunks, path);

    if (context.signal.aborted) {
      throw new ToolError(
        "patch: the turn was aborted after the hunks matched. Nothing was " +
          "written; re-send the patch.",
      );
    }

    // An emptied file is refused rather than written. Every other outcome of a
    // patch is repairable by re-sending corrected hunks, because the old text
    // is still there to match against. An empty file has no text left to match,
    // the workspace has no undo, and the tool would report `hunksApplied: 2`
    // as though it had succeeded — the one way this operation can lose work
    // without anyone noticing.
    if (applied.text === "") {
      throw new ToolError(
        `patch: applying all ${input.hunks.length} hunk(s) to ${path} would ` +
          "leave the file empty, so nothing was written. Narrow the last hunk's " +
          "`before` so it stops short of the end of the file, or delete the " +
          "region in several steps and check the result between them.",
      );
    }

    const bytesWritten = byteLength(applied.text);
    if (bytesWritten > MAX_RESULT_BYTES) {
      throw new ToolError(
        `patch: the result would be ${bytesWritten} bytes, over the ` +
          `${MAX_RESULT_BYTES}-byte limit. Nothing was written. Split the change ` +
          "into several patches, or move the bulk of the content into another file.",
      );
    }

    // The one and only write, after every check has passed.
    await context.workspace.writeText(path, applied.text);

    return {
      path,
      hunksApplied: applied.appliedAt.length,
      appliedAt: applied.appliedAt,
      bytesWritten,
    };
  },
});

export default patchTool;

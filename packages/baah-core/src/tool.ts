import type { z } from "zod";

import type { Workspace } from "./workspace.ts";

/**
 * How a tool touches the outside world. Drives the permission system: a `read`
 * tool runs freely, `write`/`execute`/`network` tools must be approved unless
 * the user granted a standing permission (see Plan.md §6).
 */
export type ToolAccess = "read" | "write" | "execute" | "network";

export type ApprovalDecision = "allow-once" | "allow-session" | "allow-always" | "deny";

export interface ApprovalRequest {
  toolId: string;
  /** Short human sentence, e.g. `Write to src/app.ts`. */
  summary: string;
  /** The exact input the model produced, for the approval card. */
  detail: unknown;
}

export interface ToolProgress {
  type: "progress" | "log";
  message: string;
}

export interface ToolContext {
  workspace: Workspace;
  /** Workspace-relative directory the session runs in. */
  cwd: string;
  signal: AbortSignal;
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  emit(event: ToolProgress): void;

  /**
   * Identity of this one tool call (AGENTS.md §3.1, Plan.md §14.4:
   * "ausgeführte `toolCallId`s persistieren und kurzschließen").
   *
   * Present because the rule is **not implementable without it**. The engine
   * short-circuits a replay *before* calling `execute`, so a tool that already
   * ran is never re-entered — but a tool cannot be re-entered blindly either:
   * `question` would open a second card, and `todo` would `set` a list built
   * from what the model last saw, overwriting whatever the user did since. A
   * tool that wants to be safe on its own (a retry loop, a resumable step) has
   * to be able to ask "is this the same call?", and that needs the id here.
   */
  toolCallId: string;
  /**
   * Which attempt of the turn this is, 1-based. Plan.md §5.4 caps a turn at
   * three attempts; a tool that writes needs to know whether it is being asked
   * to do the work for the first time or again after a retry.
   *
   * A retry is a *new* attempt with new `toolCallId`s — the failed attempt is
   * never continued — so this is for a tool's own bookkeeping, not for
   * deduplication. Deduplication keys on `toolCallId` alone.
   */
  attempt: number;
}

/** What a tool's own `toModelOutput` is given. */
export interface ToolModelOutput<Input, Output> {
  toolCallId: string;
  input: Input;
  output: Output;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  readonly id: string;
  /** Model-facing description. This text is what the LLM reads to decide. */
  readonly description: string;
  readonly access: ToolAccess;
  /** zod schema; the same object is handed to the AI SDK as `inputSchema`. */
  readonly inputSchema: z.ZodType<Input>;
  execute(context: ToolContext, input: Input): Promise<Output>;
  /**
   * Frame the result for the model. Optional — omit it and the default
   * rendering applies, unchanged.
   *
   * **Why a tool needs this at all.** The transcript and the database hold the
   * output; the *model* gets a separate, capped rendering of it. Without a seam
   * the rendering is `JSON.stringify(output)`, and for a tool whose output is a
   * bare structure that is unreadable: `question` returns
   * `{ answers: [["SQLite WASM (Recommended)"]] }`, which reaches the model as
   * `{"answers":[["SQLite WASM (Recommended)"]]}` — no indication of *which*
   * question was answered, and no marker that the value is the user's own answer
   * rather than something the tool derived.
   *
   * **What this seam is and is not.** It is framing, not trust. Marking a value
   * as "the user said this" is a label the model is told to treat as data, not
   * an instruction it must follow — the untrusted-answer obligation is a separate
   * concern and stays out of here. Declared as a method, not a property, so the
   * erased `ToolDefinition<unknown, unknown>` form stays assignable from a
   * concrete tool (same reason as `execute`).
   *
   * Returning `undefined` means "no opinion, use the default", so a tool can
   * frame only some of its results. Synchronous by design: see the note at
   * `createSdkTool`'s `toModelOutput`.
   */
  toModelOutput?(result: ToolModelOutput<Input, Output>): string | undefined;
}

/** Preserves the concrete input type when declaring a tool. */
export function defineTool<Input, Output>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}

/** Thrown for expected, model-visible failures (not bugs). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** The model-visible shape of a tool failure. Never leaks a stack trace. */
export function toToolErrorResult(error: unknown): { ok: false; error: string } {
  if (error instanceof ToolError) return { ok: false, error: error.message };
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

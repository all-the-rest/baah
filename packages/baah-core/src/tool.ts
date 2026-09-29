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
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  readonly id: string;
  /** Model-facing description. This text is what the LLM reads to decide. */
  readonly description: string;
  readonly access: ToolAccess;
  /** zod schema; the same object is handed to the AI SDK as `inputSchema`. */
  readonly inputSchema: z.ZodType<Input>;
  execute(context: ToolContext, input: Input): Promise<Output>;
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

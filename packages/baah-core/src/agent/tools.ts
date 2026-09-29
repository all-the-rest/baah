/**
 * Adapting our `ToolDefinition`s to the AI SDK's tool set.
 *
 * Plan.md §4.2 fixes the tool contract and §5.1 fixes the rule that the
 * **same** zod schema is both what the model sees and what validates the call.
 * There is no second schema here, and there must not be: a tool with two
 * schemas has two truths, and the one that is not tested is the one that lets a
 * model write outside the workspace.
 *
 * The adapter is intentionally thin. It does four things and nothing else:
 *
 * 1. reuses `inputSchema` verbatim as the SDK's `inputSchema`,
 * 2. builds a `ToolContext` per call, wiring the AI SDK's `abortSignal` through
 *    to the tool so a long tool stops when the user presses stop,
 * 3. turns a thrown error into a model-readable tool result instead of a dead
 *    stream, and
 * 4. caps what the **model** sees (2000 lines / 51200 bytes by default) with a
 *    visible marker, while the transcript keeps the full value.
 *
 * ## Layering (AGENTS.md §4)
 *
 * This module never imports from `baah-tools`. The tool packages depend on
 * `baah-core`, so importing them here would be a dependency cycle. The app wires
 * them: `createToolSet({ tools: [readTool, writeTool, …] })`.
 *
 * ## A note on `tool()` and `ToolSet`
 *
 * `ai@7.0.122` does **not** re-export `tool()`, `dynamicTool()`, `ToolSet` or
 * `Context` — those live in `@ai-sdk/provider-utils`, which is a transitive
 * dependency of `ai` and therefore not resolvable from this package under pnpm's
 * isolated `node_modules`. {@link AiToolSet} therefore recovers the SDK's own
 * `ToolSet` type from a public signature instead of depending on a package we
 * do not own. Verified with `tsc` against the installed `dist/index.d.ts`.
 */

import type { z } from "zod";

import type { ToolContext, ToolDefinition } from "../tool.ts";
import { toToolErrorResult, type ApprovalDecision, type ApprovalRequest, type ToolProgress } from "../tool.ts";
import type { Workspace } from "../workspace.ts";
import { byteLength } from "../workspace.ts";
import type { convertToModelMessages } from "ai";

/**
 * The AI SDK's own `ToolSet`, recovered from the public `convertToModelMessages`
 * signature. See the module note above for why this is not imported.
 */
export type AiToolSet = NonNullable<NonNullable<Parameters<typeof convertToModelMessages>[1]>["tools"]>;

/** One entry of an {@link AiToolSet}. */
export type AiTool = AiToolSet[string];

/**
 * The `toModelOutput` contract we implement, spelled out.
 *
 * `@ai-sdk/provider-utils` — where the real declarations live — is not
 * resolvable from this package, and the union members of {@link AiTool} cannot
 * be indexed without collapsing to `never`/`undefined`. These two interfaces
 * mirror the installed `dist/index.d.ts` exactly:
 *
 * ```
 * toModelOutput?: (options: { toolCallId: string; input: INPUT; output: OUTPUT })
 *                => ToolResultOutput | PromiseLike<ToolResultOutput>
 * type ToolResultOutput = { type: 'text'; value: string; providerOptions?: … }
 *                        | { type: 'json'; value: JSONValue; … } | …
 * ```
 *
 * The final `as AiTool` on {@link createSdkTool}'s return is checked against the
 * SDK's real union, so a divergence here fails the typecheck rather than
 * silently changing behaviour.
 */
export interface AiToModelOutputArgs {
  toolCallId: string;
  input: unknown;
  output: unknown;
}

export interface AiToolResultOutput {
  type: "text";
  value: string;
}

/**
 * Any of our tools, independent of its input/output types.
 *
 * `ToolDefinition<unknown, unknown>` — **not** `<never, unknown>`. Verified
 * against `tsc`: a concrete `ToolDefinition<{ path: string }, { text: string }>`
 * is assignable to `<unknown, unknown>` (the erased form) and *not* to
 * `<never, unknown>`, because `inputSchema: z.ZodType<Input>` is checked
 * contravariantly in `Input`.
 *
 * `execute` and `toModelOutput` are declared as *methods* in `tool.ts`, so their
 * parameters stay bivariant and the erased form remains callable with an
 * unvalidated input — which is exactly why {@link createSdkTool} validates
 * against the concrete schema before calling it.
 */
export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

/* ------------------------------------------------------------------ */
/* The replay key                                                       */
/* ------------------------------------------------------------------ */

/**
 * The identity a recorded tool call is keyed by.
 *
 * The bare `toolCallId` this replaces was a correctness bug in two independent
 * ways, and each part of the key closes one of them. See `nextToolCallKey` in
 * `agent/loop.ts` for the full argument; in short: a reused id inside one attempt
 * was a dropped call, and an id without a session was a record shared across
 * sessions.
 */
export interface ToolCallKey {
  /** §6.1: `tool_invocations` has the column, and so does the store. */
  sessionId: string;
  /** 1-based attempt number, so a retry's records stay its own. */
  attempt: number;
  /** The SDK's id for this call. */
  toolCallId: string;
  /** 0-based: how many calls with this id have already begun in this attempt. */
  occurrence: number;
}

/**
 * What is known about a recorded call.
 *
 * **The status is the whole point of the type.** Both writers of a record used
 * to read back as "no record", which made "began without an outcome"
 * unrepresentable — and unrepresentable means the only behaviour available for a
 * crash in that window was to run the tool again, which for a `write` tool
 * means corrupting the user's files rather than merely omitting a step.
 *
 * A union rather than a field, so that reading `output` off a `begun` record is
 * a type error and not a runtime `undefined` that a caller forwards to the model
 * as if it were the tool's answer.
 */
export type ToolCallRecord =
  | { status: "begun" }
  | { status: "done"; output: unknown };

/** Tool output caps. Defaults follow the reference harness. */
export interface ToolOutputLimits {
  maxLines: number;
  maxBytes: number;
}

/**
 * 2000 lines / 51200 bytes.
 *
 * Plan.md §14.3 records that the reference harness makes these configurable and
 * that the configuration belongs in the *settings*, not in the code — so these
 * are defaults that {@link createToolSet} overrides, not constants.
 */
export const DEFAULT_TOOL_OUTPUT_LIMITS: ToolOutputLimits = Object.freeze({
  maxLines: 2000,
  maxBytes: 51200,
});

/** The marker that makes truncation visible instead of silent. */
export const TRUNCATION_MARKER = "[truncated by baah";

export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalLines: number;
  originalBytes: number;
}

/**
 * Cap a text payload to `maxLines` / `maxBytes`.
 *
 * Byte-based, not character-based: `String#length` counts UTF-16 units and a
 * 2000-character cap on a file of 4-byte emoji is a 8000-byte payload. The
 * encoder is the browser's own `TextEncoder` — no `Buffer` (AGENTS.md §2).
 *
 * The marker is appended **and counted against the byte cap**, so the result
 * never exceeds `maxBytes`. Truncation is never silent: a reader can always
 * tell a shortened payload from a complete one.
 */
export function truncateToolOutput(
  value: string,
  limits: ToolOutputLimits = DEFAULT_TOOL_OUTPUT_LIMITS,
): TruncationResult {
  const originalLines = value.length === 0 ? 0 : value.split("\n").length;
  const originalBytes = byteLength(value);

  if (originalLines <= limits.maxLines && originalBytes <= limits.maxBytes) {
    return { text: value, truncated: false, originalLines, originalBytes };
  }

  const marker = `\n${TRUNCATION_MARKER}: ${originalLines} lines / ${originalBytes} bytes shown in part]\n`;
  const markerBytes = byteLength(marker);
  const byteBudget = Math.max(0, limits.maxBytes - markerBytes);

  // Line cap first, then the byte cap on what is left.
  const byLines = value.split("\n").slice(0, limits.maxLines).join("\n");
  const encoder = new TextEncoder();
  const kept = truncateToBytes(byLines, encoder, byteBudget);

  return {
    text: kept + marker,
    truncated: true,
    originalLines,
    originalBytes,
  };
}

function truncateToBytes(value: string, encoder: TextEncoder, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;

  // Cut back to a UTF-8 character boundary. A cut in the middle of a multi-byte
  // sequence does not merely lose a character: a non-fatal decode turns the
  // dangling bytes into U+FFFD, which is *three* bytes each. Two of them were
  // enough to push a 51200-byte result to 51202 — the cap would be exceeded by
  // the very act of enforcing it.
  //
  // A lead byte is `11xxxxxx`; a continuation byte is `10xxxxxx`. Walking back
  // while the byte at the cut is a continuation finds the sequence's start.
  let cut = maxBytes;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(bytes.subarray(0, cut));
}

/** Render any tool output as the text the model should receive. */
export function renderToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A tool output that cannot be serialised is a fact worth showing, not a
    // reason to hide it.
    return String(value);
  }
}

/** What {@link createToolSet} needs that is not part of the tool list. */
export interface ToolSetOptions {
  /** Tools, usually from a `ToolRegistry` (`registry.list()`). */
  tools: readonly AnyToolDefinition[];
  workspace: Workspace;
  /** Workspace-relative working directory for this session. */
  cwd: string;
  /**
   * The permission decision point (Plan.md §4.2). Called only for tools whose
   * `access` is not `read`; `read` runs free.
   */
  approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Tool progress/log lines, forwarded as engine events. */
  emit?: (progress: ToolProgress) => void;
  /**
   * Outer abort signal. The SDK's per-call signal is merged with it, so a tool
   * stops when the user stops the turn *or* when the turn is torn down.
   */
  signal?: AbortSignal;
  limits?: ToolOutputLimits;
  /**
   * Replay short-circuit (AGENTS.md §3.1, Plan.md §14.4). Returns what is
   * recorded for `toolCallId`, or `undefined` when the call has never begun.
   *
   * Without this a `regenerate` after a reload writes the same file twice, asks
   * the user the same question twice, or — worst — replays a `todo` list built
   * from what the model last saw and overwrites a newer edit as if it were the
   * update. The lookup is a function rather than a set so persistence can stay
   * asynchronous.
   *
   * The callback takes the **bare id on purpose**. The full
   * {@link ToolCallKey} — session, attempt, occurrence — belongs to the engine,
   * which owns the occurrence counter; if the adapter minted the key it would
   * have to be told about the counter too, and the two could disagree about
   * which occurrence a record belongs to. Resolving the key in one place is the
   * property that makes a same-id reuse distinguishable from a replay.
   *
   * The returned **status** decides what happens, and both non-`done` outcomes
   * are non-obvious enough to be worth stating:
   *
   * - `done` → short-circuit. The call has an outcome; return it.
   * - `begun` → the crash window. See the long note at
   *   {@link createSdkTool}'s `execute`; the call does **not** run and does
   *   **not** silently succeed.
   */
  lookupToolCall?: (toolCallId: string) => Promise<ToolCallRecord | undefined>;
  /** Called when a persisted call was short-circuited. */
  onReplayedToolCall?: (toolCallId: string, toolName: string) => void;
  /**
   * Called when a call began and never reported an outcome.
   *
   * The user-facing half of the same event the model sees: the engine hands the
   * model a readable "outcome unknown" result and reports this, so neither side
   * is told a thing that is not true.
   */
  onUnknownOutcomeToolCall?: (info: { toolCallId: string; toolName: string; input: unknown }) => void;
  /** Called when the model-facing output had to be shortened. */
  onTruncatedOutput?: (info: {
    toolCallId: string;
    toolName: string;
    originalLines: number;
    originalBytes: number;
  }) => void;
  /** Called for every failed tool, with the original throwable. */
  onToolError?: (info: { toolCallId: string; toolName: string; error: unknown }) => void;
  /**
   * Called **before** `execute`, once the arguments are validated.
   *
   * This is the "may have run" write of the idempotency record. It is
   * deliberately a separate hook from {@link ToolSetOptions.lookupToolCall} and
   * from a post-run record: persisting only *after* the call returns would
   * leave a crash in between invisible, and a tool that re-ran in that window
   * would write twice (or, for `todo`, overwrite a newer list with a stale one
   * while reporting `changed: true`).
   */
  beginToolCall?: (info: { toolCallId: string; toolName: string; input: unknown }) => Promise<void>;
  /** 1-based attempt number, handed to the tool as `ctx.attempt`. */
  attempt?: number;
}

/**
 * The AI SDK's per-call execution options, narrowed to what we read.
 *
 * `toolCallId` is **optional in the type but required in practice**: the SDK
 * always supplies one, and a fabricated stand-in would be worse than a type
 * error, because a wrong id defeats the replay short-circuit silently
 * (AGENTS.md §3.1). {@link MissingToolCallIdError} turns the absence into a loud
 * failure instead of a quiet one.
 *
 * Exported so a caller that drives `execute` directly — a test, or a non-SDK
 * embedding — can pass the same shape without reaching into
 * `@ai-sdk/provider-utils`.
 */
export interface SdkExecutionOptions {
  toolCallId?: string | undefined;
  abortSignal?: AbortSignal | undefined;
}

/** The options a direct caller passes to `execute`. */
export type SdkCall = SdkExecutionOptions;

export class MissingToolCallIdError extends Error {
  constructor(toolName: string) {
    super(`The SDK did not supply a toolCallId for "${toolName}"; refusing to run it without a call identity.`);
    this.name = "MissingToolCallIdError";
  }
}

/**
 * Build the `tools` map for `ToolLoopAgent`.
 *
 * The returned value is the SDK's own `ToolSet` type — no wrapper type, no
 * re-declared schema.
 */
export function createToolSet(options: ToolSetOptions): AiToolSet {
  const limits = options.limits ?? DEFAULT_TOOL_OUTPUT_LIMITS;
  const toolSet: Record<string, AiTool> = {};

  for (const definition of options.tools) {
    toolSet[definition.id] = createSdkTool(definition, options, limits);
  }

  return toolSet as AiToolSet;
}

function createSdkTool(
  definition: AnyToolDefinition,
  options: ToolSetOptions,
  limits: ToolOutputLimits,
): AiTool {
  const toolName = definition.id;
  const schema = definition.inputSchema as z.ZodType<unknown>;

  // The literal is typed locally and narrowed to the SDK's union at the end.
  // Annotating it as `AiTool` directly makes TypeScript resolve the `execute`
  // return type against the `Tool<any, never, any>` member of the union, i.e.
  // `never` — the object literal, not the SDK, would be the thing at fault.
  const tool: {
    description: string;
    inputSchema: z.ZodType<unknown>;
    execute: (input: unknown, options: SdkExecutionOptions) => Promise<unknown>;
    toModelOutput: (args: AiToModelOutputArgs) => AiToolResultOutput;
  } = {
    description: definition.description,
    // The one and only parameter truth (Plan.md §4.2). Passed through
    // untouched: no re-derivation, no JSON-Schema copy.
    inputSchema: schema,

    execute: async (rawInput: unknown, sdkOptions: SdkExecutionOptions) => {
      const toolCallId = sdkOptions?.toolCallId;
      if (toolCallId === undefined || toolCallId === "") {
        // Refuse rather than invent one. A fabricated id would never match a
        // persisted id, so the replay short-circuit would silently stop working
        // — exactly the failure this whole mechanism exists to prevent.
        throw new MissingToolCallIdError(toolName);
      }

      // Validation happens *before* the short-circuit lookup and before
      // `execute`, on every path. The bounds live in the schema because the
      // model breaks them (Plan.md §4.2), and a tool that trusts its caller
      // has already lost. Validating here also means the persisted id
      // bookkeeping is never reached for an argument set we would refuse.
      const parsed = parseInput(schema, rawInput, toolName);

      // Replay short-circuit: an already-*finished* call must not run again.
      // Placed after validation and before `execute`, so the tool is not
      // re-entered at all — it is not idempotent, it writes, it asks, it shows
      // UI.
      const record = await options.lookupToolCall?.(toolCallId);
      if (record?.status === "done") {
        options.onReplayedToolCall?.(toolCallId, toolName);
        return record.output;
      }

      /**
       * The crash window: begun, no outcome.
       *
       * This is the branch that had no correct answer available, and the choice
       * taken is stated here so a reader can disagree with it on the evidence
       * rather than guess what happened.
       *
       * The state means the tab died, the process was killed, or the store
       * write and the result write straddled a boundary — between the moment
       * this call was marked as about to run and the moment its result came
       * back. **Whether the side effect happened is genuinely unknown**, and
       * the three available responses are all lossy:
       *
       * 1. *Run it again.* For a `write` tool this is not a retry, it is a
       *    second append to the user's file: measured, an append produced
       *    `log === ["x", "x"]` while the transcript showed one write. The model
       *    cannot undo that, and the user may not notice.
       * 2. *Skip it silently.* Also wrong, and in the opposite direction: the
       *    model is told a call completed, believes the work is done, and builds
       *    its next step on a premise that is false. That is the silent omission.
       * 3. **This one.** Do not run it, do not pretend it finished, and say so —
       *    to the model as a readable result it can reason about, and to the user
       *    as its own event. The model is told to *verify* before repeating,
       *    which is the action that is correct under either answer.
       *
       * **Residual risk, stated plainly:** the tool's effect may have happened,
       * and the harness cannot find out. The user sees an explicit warning rather
       * than a silent either/or, and `read` is available to resolve it. The
       * alternative trade — a duplicate side effect — is not recoverable by the
       * model at all, which is why it was not taken.
       *
       * The returned shape is deliberately **not** `toToolErrorResult`: `ok:
       * false` reads to a model as a malfunction to be retried, and retrying is
       * the one thing that must not happen here.
       */
      if (record?.status === "begun") {
        options.onUnknownOutcomeToolCall?.({ toolCallId, toolName, input: parsed });
        return {
          ok: false,
          outcome: "unknown",
          toolCallId,
          toolName,
          error:
            `This call to ${toolName} began but never reported a result — the previous session ended ` +
            `in the middle of it, so its effect may or may not have happened.`,
          guidance:
            "Do not repeat it blindly. Check the current state first (read the file, list the " +
            "directory) and only then decide whether the work is still needed.",
        };
      }

      // Mark the call as *about to* run, before it does. "May have run" is the
      // honest state; "ran successfully" is only true afterwards, and a crash
      // in between is the entire reason the rule exists.
      await options.beginToolCall?.({ toolCallId, toolName, input: parsed });

      const signal = mergeSignals(options.signal, sdkOptions.abortSignal);
      const context: ToolContext = {
        workspace: options.workspace,
        cwd: options.cwd,
        signal,
        // `read` runs free (Plan.md §4.2); every other access class asks.
        approve: (request) =>
          definition.access === "read"
            ? Promise.resolve("allow-once" satisfies ApprovalDecision)
            : options.approve({ ...request, toolId: toolName }),
        emit: (progress) => options.emit?.(progress),
        toolCallId,
        attempt: options.attempt ?? 1,
      };

      try {
        return await definition.execute(context, parsed);
      } catch (error) {
        options.onToolError?.({ toolCallId, toolName, error });
        // A thrown tool error would abort the step. §5 wants a model-visible
        // failure instead, so the model can read it and react.
        return toToolErrorResult(error);
      }
    },

    /**
     * What the **model** sees, capped. `execute` keeps the full value so the
     * transcript and the database stay lossless; only the copy handed to the
     * model is shortened, and it carries a visible marker.
     *
     * A tool's own `toModelOutput` runs first and may replace the rendering
     * entirely (`ToolDefinition.toModelOutput`, `tool.ts`). It returns a string
     * or `undefined`, and `undefined` means "use the default" — so a tool that
     * does not care pays nothing and a tool that does gets a seam. The cap is
     * applied to the framed text as well: framing is not a way around the limit.
     *
     * Synchronous on purpose. The SDK accepts a promise here; accepting one
     * would make the whole model-facing path async for the sake of a tool that
     * has nothing async to do. A tool that needs real work should do it in
     * `execute` and frame the result.
     */
    toModelOutput: (args) => {
      const info = {
        toolCallId: String(args.toolCallId),
        toolName,
      };
      const framed = definition.toModelOutput?.({
        toolCallId: String(args.toolCallId),
        input: args.input,
        output: args.output,
      });
      const rendered = framed ?? renderToolOutput(args.output);
      const result = truncateToolOutput(rendered, limits);
      if (result.truncated) {
        options.onTruncatedOutput?.({
          ...info,
          originalLines: result.originalLines,
          originalBytes: result.originalBytes,
        });
      }
      return { type: "text" as const, value: result.text };
    },
  };

  return tool as AiTool;
}

/**
 * Validate the model's arguments with the tool's own schema.
 *
 * The SDK already validates against `inputSchema`, so this is a second line of
 * defence rather than the only one — but the tools are also reachable without
 * the SDK (direct registry use in tests), and an unvalidated `input.path` is a
 * path traversal.
 */
function parseInput(schema: z.ZodType<unknown>, rawInput: unknown, toolName: string): unknown {
  const result = schema.safeParse(rawInput);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid input for tool ${toolName}: ${issues}`);
}

/**
 * Combine the outer signal with the SDK's per-call signal.
 *
 * `AbortSignal.any` is not available everywhere the app must run, and a manual
 * listener has to be cleaned up. `any` when present, otherwise a listener that
 * forwards into a fresh controller.
 */
function mergeSignals(outer: AbortSignal | undefined, inner: AbortSignal | undefined): AbortSignal {
  if (outer === undefined) return inner ?? new AbortController().signal;
  if (inner === undefined) return outer;
  const anyFn = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([outer, inner]);

  const controller = new AbortController();
  const forward = (source: AbortSignal): void => {
    if (source.aborted) controller.abort(source.reason);
  };
  if (outer.aborted || inner.aborted) {
    forward(outer.aborted ? outer : inner);
    return controller.signal;
  }
  outer.addEventListener("abort", () => forward(outer), { once: true });
  inner.addEventListener("abort", () => forward(inner), { once: true });
  return controller.signal;
}

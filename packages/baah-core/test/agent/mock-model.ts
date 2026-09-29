/**
 * A mock language model, built from the AI SDK's own test entrypoint.
 *
 * ## Where the names come from
 *
 * `ai/test` (`node_modules/ai/dist/test/index.d.ts`). The class was renamed
 * across majors, so nothing here is from memory:
 *
 * | what | export used |
 * |---|---|
 * | the mock | `MockLanguageModelV4` (`MockLanguageModelV3` is the old spec version) |
 * | a stream of parts | `simulateReadableStream<T>()` |
 *
 * Both are re-exported by `ai/test` from `@ai-sdk/provider-utils/test`
 * (`simulateReadableStream`) and defined locally (`MockLanguageModelV4`).
 *
 * ## Why the types are derived instead of imported
 *
 * `@ai-sdk/provider` — where `LanguageModelV4StreamPart`, `…CallOptions` and
 * `…Usage` live — is a *transitive* dependency of `ai` and is **not resolvable**
 * from this package under pnpm's isolated `node_modules` (verified with
 * `require.resolve`). `ai/test` does not re-export those types either. So they
 * are recovered from `MockLanguageModelV4`'s own method signatures, which is
 * the same SDK surface, and any upstream change breaks here rather than
 * silently.
 */
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";

/** The call options the mock receives. */
export type MockCallOptions = Parameters<MockLanguageModelV4["doStream"]>[0];

/** The result of a mocked `doStream`. */
export type MockStreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

/** One part of a v4 provider stream. */
export type MockStreamPart = MockStreamResult["stream"] extends ReadableStream<infer T> ? T : never;

/** The usage shape a `finish` part has to carry. */
export type MockUsage = Extract<MockStreamPart, { type: "finish" }>["usage"];

/** Zero usage, for the parts that do not care. */
export const NO_USAGE: MockUsage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** `ai/test` also exports `mockValues`; this is the shape it returns. */
type ValuesFn<T> = () => T;

/**
 * A `finish` part.
 *
 * Note the shape, which differs from the v3 spec and from `ai`'s own
 * `FinishReason`: the provider part takes `finishReason: { unified, raw }`, not
 * a bare string. Verified in `@ai-sdk/provider/dist/index.d.ts`,
 * `type LanguageModelV4FinishReason` — and reachable from here only through
 * `MockLanguageModelV4`'s signatures, because that package is not resolvable.
 */
export function finish(unified: "stop" | "tool-calls" | "length" | "error" | "content-filter" | "other" = "stop"): MockStreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage: NO_USAGE };
}

/** A text block, as a `text-start`/`delta`/`end` run. */
export function text(id: string, value: string): MockStreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: value },
    { type: "text-end", id },
  ];
}

/**
 * A tool call.
 *
 * The field is `input`, not `args`, and it is a **JSON string** — verified in
 * `@ai-sdk/provider/dist/index.d.ts`, `type LanguageModelV4ToolCall`. (The v3
 * spec used `args`; getting this wrong produces a tool call the SDK silently
 * refuses to parse.)
 */
export function toolCall(args: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}): MockStreamPart {
  return {
    type: "tool-call",
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    input: JSON.stringify(args.input),
  };
}

/** A reasoning block. */
export function reasoning(id: string, value: string): MockStreamPart[] {
  return [
    { type: "reasoning-start", id },
    { type: "reasoning-delta", id, delta: value },
    { type: "reasoning-end", id },
  ];
}

/** An `error` part — the "200 but unusable" shape from Plan.md §5.4. */
export function errorPart(error: unknown): MockStreamPart {
  return { type: "error", error };
}

export interface MockStep {
  /**
   * The parts this step emits.
   *
   * Optional because a step may instead `throws` — the two are alternatives,
   * and requiring an empty array alongside a throw would only add noise.
   */
  parts?: MockStreamPart[];
  /** Thrown instead of streaming, to model a transport failure. */
  throws?: unknown;
  /** Milliseconds to wait before the first part, to drive the stall window. */
  delayMs?: number;
}

export interface MockModelOptions {
  /** One entry per model call; the last entry repeats once exhausted. */
  steps: readonly MockStep[];
  provider?: string;
  modelId?: string;
}

/**
 * Build a mock `LanguageModel` that replays `steps` in order.
 *
 * Returned as `LanguageModel` because that is what `ToolLoopAgent` takes, and
 * `MockLanguageModelV4` satisfies it (verified with `tsc`).
 */
export function createMockModel(options: MockModelOptions): LanguageModel {
  let call = 0;
  const model = new MockLanguageModelV4({
    provider: options.provider ?? "mock",
    modelId: options.modelId ?? "mock-model",
    doStream: async (): Promise<MockStreamResult> => {
      const index = Math.min(call, options.steps.length - 1);
      call += 1;
      const step = options.steps[index];
      if (step === undefined) throw new Error("mock model: no steps configured");
      if (step.throws !== undefined) throw step.throws;
      return {
        stream: simulateReadableStream<MockStreamPart>({
          chunks: step.parts ?? [],
          ...(step.delayMs === undefined ? {} : { initialDelayInMs: step.delayMs }),
        }),
      };
    },
  });
  return model;
}

export type { ValuesFn };

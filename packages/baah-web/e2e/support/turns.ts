/**
 * OpenAI-compatible chunk builders — one function per scenario in Plan.md §15.6.
 *
 * The shapes come from `@ai-sdk/openai@4.0.80`, the provider version `ai@7.0.122`
 * pins in its own devDependencies, read out of `dist/index.js`:
 *
 * - `openaiChatChunkSchema` (the union arm that is not `openaiErrorDataSchema`):
 *   `{ id?, created?, model?, choices: [{ index, delta?: { role?, content?,
 *   tool_calls?: [{ index, id?, type?, function: { name?, arguments? } }] },
 *   logprobs?, finish_reason? }], usage? }`.
 * - `openaiResponsesChunkSchema`: a union of `response.created`,
 *   `response.in_progress`, `response.output_text.delta`
 *   (`{ item_id, output_index?, delta, logprobs? }`), `response.output_item.added`
 *   / `.done` (item `{ type: "message" | "function_call", ... }`),
 *   `response.function_call_arguments.delta` / `.done`, `response.completed` /
 *   `response.incomplete`, `response.failed` and `{ type: "error" }`.
 *
 * Every builder returns a complete turn. The agent loop asks the provider for
 * one step per request, so a tool call is a complete, terminal turn of its own;
 * a multi-step turn is a sequence of turns, not one long stream. Nothing here
 * decides *when* a chunk is written — that is the pacer's job (`pacer.ts`).
 */
import { frameSse, type SseEvent } from "./sse.ts";

/** A complete response body, plus the ids a test may want to assert on. */
export type Turn = {
  /** The exact bytes the route hands to the page. */
  readonly body: string;
  /** Tool call ids in the turn, in order. */
  readonly toolCallIds: readonly string[];
  /** Tool names in the turn, in order. */
  readonly toolNames: readonly string[];
};

const data = (value: unknown): SseEvent => ({ kind: "data", value });
const done: SseEvent = { kind: "done" };

const MODEL = "gpt-fake";
const CREATED = 1_700_000_000;

/** Tool-call arguments arrive as JSON fragments that must be concatenated. */
function fragmentJson(value: unknown): string[] {
  const json = JSON.stringify(value);
  const size = Math.max(1, Math.ceil(json.length / 6));
  const out: string[] = [];
  for (let at = 0; at < json.length; at += size) out.push(json.slice(at, at + size));
  return out;
}

const noTools: Pick<Turn, "toolCallIds" | "toolNames"> = {
  toolCallIds: [],
  toolNames: [],
};

function turn(events: readonly SseEvent[], tools: Omit<Turn, "body">): Turn {
  return { body: frameSse([...events, done]), ...tools };
}

// --------------------------------------------------------------------------
// OpenAI Chat Completions — POST {baseURL}/chat/completions
// --------------------------------------------------------------------------

/**
 * A plain text turn: role announcement, content deltas, terminal
 * `finish_reason: "stop"`, `data: [DONE]`.
 *
 * §15.6 "reiner Text-Stream".
 */
export function chatTextTurn(text: string): Turn {
  const chunk = (choice: unknown): SseEvent =>
    data({ id: "chatcmpl-text", created: CREATED, model: MODEL, choices: [choice] });

  return turn(
    [
      chunk({ index: 0, delta: { role: "assistant" } }),
      ...text.split(" ").map((word) => chunk({ index: 0, delta: { content: `${word} ` } })),
      chunk({ index: 0, delta: {}, finish_reason: "stop" }),
    ],
    noTools,
  );
}

/**
 * A turn that calls one tool and stops. The next request in the turn carries
 * the tool result, so "text → tool call → tool result → text" is two turns.
 *
 * §15.6 "Stream mit Tool-Call, Tool OK, dann Text" (this is the first half).
 */
export function chatToolCallTurn(options: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}): Turn {
  const { toolCallId, toolName, input } = options;
  const chunk = (choice: unknown): SseEvent =>
    data({ id: "chatcmpl-tool", created: CREATED, model: MODEL, choices: [choice] });

  return turn(
    [
      chunk({ index: 0, delta: { role: "assistant" } }),
      chunk({
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: toolCallId, type: "function", function: { name: toolName, arguments: "" } },
          ],
        },
      }),
      ...fragmentJson(input).map((fragment) =>
        chunk({
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
        }),
      ),
      // The terminal event for a tool call is `tool_calls`, not `stop`.
      chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }),
    ],
    { toolCallIds: [toolCallId], toolNames: [toolName] },
  );
}

/**
 * A stream that dies *inside* a tool call: the last argument fragment arrives,
 * then the connection ends with no `finish_reason` and no `[DONE]`.
 *
 * §15.6 "Tool-Call mit `output-error`" (transport half) and Plan.md §5.4
 * "SSE-Stream bricht mitten drin ab". The `output-error` half — the tool ran
 * and itself failed — is produced by the app under test and has no provider
 * shape at all; see `scenarios.e2e.ts`.
 */
export function chatTruncatedToolCallTurn(options: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}): Turn {
  const { toolCallId, toolName, input } = options;
  const chunk = (choice: unknown): SseEvent =>
    data({ id: "chatcmpl-trunc", created: CREATED, model: MODEL, choices: [choice] });
  const fragments = fragmentJson(input);
  const kept = fragments.slice(0, Math.max(1, fragments.length - 1));

  return {
    // No `done` event, and the final fragment is left without its terminating
    // blank line: the parser never dispatches it and the turn never terminates.
    body: frameSse([
      chunk({ index: 0, delta: { role: "assistant" } }),
      chunk({
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: toolCallId, type: "function", function: { name: toolName, arguments: "" } },
          ],
        },
      }),
      ...kept.map((fragment) =>
        chunk({
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
        }),
      ),
    ]) + `data: ${JSON.stringify({
      id: "chatcmpl-trunc",
      created: CREATED,
      model: MODEL,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: fragments[kept.length] ?? "" } }] },
        },
      ],
    })}\n`,
    toolCallIds: [toolCallId],
    toolNames: [toolName],
  };
}

// --------------------------------------------------------------------------
// OpenAI Responses — POST {baseURL}/responses
// --------------------------------------------------------------------------

/** A plain text turn on the Responses API. §15.6 "reiner Text-Stream". */
export function responsesTextTurn(text: string): Turn {
  const itemId = "msg_fake";
  return turn(
    [
      data({ type: "response.created", response: { id: "resp_fake", created_at: CREATED, model: MODEL } }),
      data({ type: "response.in_progress", response: { id: "resp_fake", created_at: CREATED, model: MODEL } }),
      data({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, phase: "final_answer" } }),
      ...text
        .split(" ")
        .map((word) =>
          data({ type: "response.output_text.delta", item_id: itemId, output_index: 0, delta: `${word} ` }),
        ),
      data({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: itemId, phase: "final_answer" } }),
      data({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 } } }),
    ],
    noTools,
  );
}

/** A function call on the Responses API. §15.6 tool-call scenarios. */
export function responsesToolCallTurn(options: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}): Turn {
  const { toolCallId, toolName, input } = options;
  const itemId = "fc_fake";
  const fragments = fragmentJson(input);
  return turn(
    [
      data({ type: "response.created", response: { id: "resp_fake", created_at: CREATED, model: MODEL } }),
      data({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: itemId, call_id: toolCallId, name: toolName, arguments: "" } }),
      ...fragments.map((fragment) =>
        data({ type: "response.function_call_arguments.delta", item_id: itemId, output_index: 0, delta: fragment }),
      ),
      data({ type: "response.function_call_arguments.done", item_id: itemId, output_index: 0, arguments: JSON.stringify(input) }),
      data({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: itemId, call_id: toolCallId, name: toolName, arguments: JSON.stringify(input) } }),
      data({ type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 13, total_tokens: 22 } } }),
    ],
    { toolCallIds: [toolCallId], toolNames: [toolName] },
  );
}

// --------------------------------------------------------------------------
// AI SDK UI Message Stream Protocol v1 — the fallback transport of §5.4
// --------------------------------------------------------------------------

/**
 * `text-start` / `text-delta` / `text-end` / `finish` / `[DONE]`, the framing
 * documented at ai-sdk.dev/docs/ai-sdk-ui/stream-protocol.
 *
 * Not a §15.6 scenario on its own. It exists because Plan.md §5.4 keeps a
 * documented fallback ("`generateText` → `createUIMessageStream` with synthetic
 * `text-delta` chunks"), and that fallback is the one path whose framing the
 * suite can pin *today*: it is pure wire format, independent of the chat UI
 * Wave 2 is building.
 */
export function uiMessageStreamTurn(text: string): Turn {
  const id = "msg_e2e";
  return turn(
    [
      data({ type: "start", messageId: "ai_e2e" }),
      data({ type: "start-step" }),
      data({ type: "text-start", id }),
      ...text.split(" ").map((word) => data({ type: "text-delta", id, delta: `${word} ` })),
      data({ type: "text-end", id }),
      data({ type: "finish-step" }),
      data({ type: "finish" }),
    ],
    noTools,
  );
}

// --------------------------------------------------------------------------
// Failure scenarios — Plan.md §5.4
// --------------------------------------------------------------------------

/** A body that is not an SSE stream at all. */
export function errorJsonBody(options: {
  readonly type?: string;
  readonly code?: string;
  readonly message?: string;
} = {}): string {
  return JSON.stringify({
    error: {
      type: options.type ?? "server_error",
      code: options.code ?? "internal_error",
      message: options.message ?? "the provider is unhappy, and said so with a 200",
    },
  });
}

/**
 * §15.6 "200 mit Fehler-JSON" and Plan.md §5.4 step 4: the status line says
 * success, the body says failure. A naive check reads this as a working turn.
 */
export const jsonErrorIn200 = (options?: Parameters<typeof errorJsonBody>[0]): string =>
  errorJsonBody(options);

/** §15.6 "401 ohne Retry" — a final error, retrying it changes nothing. */
export const unauthorizedBody = (): string =>
  errorJsonBody({
    type: "invalid_request_error",
    code: "invalid_api_key",
    message: "Incorrect API key provided",
  });

/** §15.6 "5xx mit Backoff" — transient, so the loop is supposed to try again. */
export const serverErrorBody = (): string =>
  errorJsonBody({
    type: "server_error",
    code: "internal_error",
    message: "the provider had a bad day",
  });

/** §15.6 "Abbruch mitten im Stream": a `200` that stops without a terminal event. */
export const truncatedStreamBody = (): string =>
  // Text arrived, then the connection ended: no `finish_reason`, no `[DONE]`,
  // and not even the blank line that would dispatch the last delta.
  `data: ${JSON.stringify({
    id: "chatcmpl-cut",
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, delta: { role: "assistant" } }],
  })}\n\ndata: ${JSON.stringify({
    id: "chatcmpl-cut",
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, delta: { content: "this text arrived, " } }],
  })}\n\ndata: ${JSON.stringify({
    id: "chatcmpl-cut",
    created: CREATED,
    model: MODEL,
    choices: [{ index: 0, delta: { content: "and then nothing" } }],
  })}\n`;

/** A `200` whose SSE body carries an error event mid-stream. §5.4, "error-Event". */
export const errorEventStreamBody = (): string =>
  frameSse([
    data({ id: "chatcmpl-err", created: CREATED, model: MODEL, choices: [{ index: 0, delta: { role: "assistant" } }] }),
    data({ id: "chatcmpl-err", created: CREATED, model: MODEL, choices: [{ index: 0, delta: { content: "partial" } }] }),
    data({ error: { type: "server_error", code: "internal_error", message: "the stream died" } }),
  ]);

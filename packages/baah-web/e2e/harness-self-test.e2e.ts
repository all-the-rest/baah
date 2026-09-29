/**
 * Harness self-test.
 *
 * The builders in `support/turns.ts` are the foundation every §15.6 scenario
 * rests on. If the framing is wrong, every later failure is indistinguishable
 * from a bug in the app. So the builders are proven on their own, today, without
 * the chat UI Wave 2 is building:
 *
 * 1. byte level — the exact bytes contain `data:` lines, a terminal event and
 *    `data: [DONE]`, and a cut-off body has neither;
 * 2. parser level — a transcription of `eventsource-parser` (the parser the AI
 *    SDK uses) recovers the payloads, and rejects a malformed stream;
 * 3. browser level — Chromium really fetches the fulfilled body, really parses
 *    it with the same `parseSse`, and the text arrives.
 *
 * Steps 1 and 2 need no browser at all, so they cannot be flaked by one.
 */
import type { Page } from "@playwright/test";
import { consumerScriptSource, type ConsumerOptions, type ConsumerResult } from "./support/consumer.ts";
import { expect, test } from "./support/fixtures.ts";
import { CHAT_COMPLETIONS_PATH, PROVIDER_BASE_URL, RESPONSES_PATH } from "./support/provider.ts";
import { frameSse, isCleanlyTerminated, parseSse, parseSseJson, SSE_DONE, splitSse } from "./support/sse.ts";
import {
  chatTextTurn,
  chatToolCallTurn,
  chatTruncatedToolCallTurn,
  errorEventStreamBody,
  jsonErrorIn200,
  responsesTextTurn,
  responsesToolCallTurn,
  truncatedStreamBody,
  uiMessageStreamTurn,
} from "./support/turns.ts";

/** A request body an OpenAI-compatible client would send. */
const CHAT_BODY = JSON.stringify({
  model: "gpt-fake",
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: "user", content: "hello" }],
});

/** Mount the consumer page on the app's origin. */
async function mountConsumer(app: Page): Promise<void> {
  await app.goto("/");
  await app.addScriptTag({ content: consumerScriptSource });
}

async function stream(
  app: Page,
  url: string,
  body: string,
): Promise<ConsumerResult> {
  const options: ConsumerOptions = { url, body };
  return (await app.evaluate(
    (input) =>
      (
        window as unknown as {
          __baahE2EStream: (options: unknown) => Promise<ConsumerResult>;
        }
      ).__baahE2EStream(input),
    options,
  )) as ConsumerResult;
}

test.describe("SSE framing, byte level", () => {
  test("a chat-completions turn is data lines, a terminal event and [DONE]", () => {
    const turn = chatTextTurn("hello from the fake");

    expect(turn.body.startsWith("data: {")).toBe(true);
    // Every event is dispatched by a blank line, so every event ends with one.
    expect(turn.body.endsWith(`data: ${SSE_DONE}\n\n`)).toBe(true);
    expect(turn.body).not.toContain("\r");
    expect(isCleanlyTerminated(turn.body)).toBe(true);

    const chunks = parseSseJson(turn.body) as Array<Record<string, unknown>>;
    // role announcement, one delta per word, then the terminal finish_reason.
    expect(chunks).toHaveLength("hello from the fake".split(" ").length + 2);
    const last = chunks[chunks.length - 1] as Record<string, unknown>;
    const choices = last["choices"] as Array<Record<string, unknown>>;
    expect(choices[0]?.["finish_reason"]).toBe("stop");
  });

  test("the Responses API turn terminates with response.completed", () => {
    const turn = responsesTextTurn("hello from the fake");
    const types = (parseSseJson(turn.body) as Array<Record<string, unknown>>).map(
      (chunk) => chunk["type"],
    );
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_text.delta");
    expect(types[types.length - 1]).toBe("response.completed");
    expect(isCleanlyTerminated(turn.body)).toBe(true);
  });

  test("the UI message stream turn uses the documented part names", () => {
    const turn = uiMessageStreamTurn("hello from the fake");
    const types = (parseSseJson(turn.body) as Array<Record<string, unknown>>).map(
      (chunk) => chunk["type"],
    );
    // ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
    expect(types).toContain("finish");
  });

  test("a Responses API function call carries call_id, name and arguments", () => {
    const turn = responsesToolCallTurn({
      toolCallId: "call_resp_1",
      toolName: "read",
      input: { path: "a.txt" },
    });
    const types = (parseSseJson(turn.body) as Array<Record<string, unknown>>).map(
      (chunk) => chunk["type"],
    );
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    expect(turn.toolCallIds).toEqual(["call_resp_1"]);
    expect(turn.toolNames).toEqual(["read"]);

    // The arguments arrive in fragments and have to be concatenated, exactly as
    // on the chat-completions path.
    const fragments = (parseSseJson(turn.body) as Array<Record<string, unknown>>)
      .filter((chunk) => chunk["type"] === "response.function_call_arguments.delta")
      .map((chunk) => chunk["delta"])
      .join("");
    expect(JSON.parse(fragments)).toEqual({ path: "a.txt" });
  });

  test("a cut-off stream has no terminal event and no [DONE]", () => {
    const body = truncatedStreamBody();
    expect(isCleanlyTerminated(body)).toBe(false);
    expect(body).not.toContain(SSE_DONE);

    // Two events were framed and terminated, so the parser dispatches them. The
    // third was written but never got its blank line, so it is lost — which is
    // why the transcript shows text without a finished turn.
    const events = parseSse(body);
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.data?.includes("and then nothing"))).toBe(false);
    // Nothing anywhere in the stream says "this turn is over".
    expect(
      events.some((event) => event.data?.includes("finish_reason")),
      "no finish_reason was ever received",
    ).toBe(false);

    // The same holds for a turn cut in the middle of a tool call.
    const turn = chatTruncatedToolCallTurn({
      toolCallId: "call_cut",
      toolName: "read",
      input: { path: "a.txt" },
    });
    expect(isCleanlyTerminated(turn.body)).toBe(false);
  });

  test("a truncated turn loses the last argument fragment, and cannot be parsed", () => {
    const input = { path: "a.txt" };
    const turn = chatTruncatedToolCallTurn({ toolCallId: "call_cut", toolName: "read", input });
    const complete = chatToolCallTurn({ toolCallId: "call_cut", toolName: "read", input });

    /** Concatenate the streamed `arguments` fragments of a turn. */
    const argumentsOf = (body: string): string =>
      (parseSseJson(body) as Array<{
        choices: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
      }>)
        .flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? [])
        .map((delta) => delta.function?.arguments ?? "")
        .join("");

    // The complete turn assembles; the cut one is a strict prefix that no
    // longer parses. That is the failure the app has to recognise.
    expect(JSON.parse(argumentsOf(complete.body))).toEqual(input);
    const cut = argumentsOf(turn.body);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.length).toBeLessThan(argumentsOf(complete.body).length);
    expect(() => JSON.parse(cut)).toThrow();
  });

  test("splitSse keeps the unterminated tail, so nothing is silently dropped", () => {
    const body = truncatedStreamBody();
    const parts = splitSse(body);
    expect(parts.join("")).toBe(body);
    // Two complete events plus the fragment the server never finished.
    expect(parts).toHaveLength(3);
    expect(parts[2]?.endsWith("\n\n")).toBe(false);
  });

  test("a 200 carrying an error body is not a stream at all", () => {
    const body = jsonErrorIn200();
    // A JSON body has no `data:` line, so nothing is dispatched and the stream
    // never terminates. Give it a trailing newline and the parser raises
    // "Unknown field" instead — which is the real `eventsource-parser`
    // behaviour, and also not a success. Both paths are "not a stream".
    expect(parseSse(body)).toEqual([]);
    expect(() => parseSse(`${body}\n`)).toThrow(/Unexpected SSE field/);
    expect(isCleanlyTerminated(body)).toBe(false);
    expect(isCleanlyTerminated(`${body}\n`)).toBe(false);
  });

  test("an error event inside a 200 stream still has no terminal event", () => {
    // The shape Plan.md §5.4 warns about: status line, content-type and body
    // all look like a normal stream until the third event.
    const body = errorEventStreamBody();
    expect(isCleanlyTerminated(body)).toBe(false);
    expect(body).not.toContain(SSE_DONE);
    const chunks = parseSseJson(body) as Array<Record<string, unknown>>;
    expect(chunks.some((chunk) => "error" in chunk)).toBe(true);
    // The text before the failure is real and kept: the turn is interrupted,
    // not blank. `finish_reason` never arrives, which is the other half of
    // "not terminated".
    const withText = chunks.filter(
      (chunk) =>
        Array.isArray(chunk["choices"]) &&
        (chunk["choices"] as Array<{ delta?: { content?: string } }>)[0]?.delta?.content !==
          undefined,
    );
    expect(withText).toHaveLength(1);
    expect(
      chunks.some((chunk) =>
        (chunk["choices"] as Array<{ finish_reason?: string }> | undefined)?.[0]
          ?.["finish_reason"] !== undefined,
      ),
      "no finish_reason anywhere in the stream",
    ).toBe(false);
  });

  test("framing rejects fields the real parser would reject", () => {
    // `eventsource-parser` reports an unknown field as an error, so the suite
    // must never emit one.
    expect(() => parseSse(`x-thing: 1\ndata: {}\n\n`)).toThrow(/Unexpected SSE field/);
  });

  test("frameSse writes nothing for a hold event", () => {
    expect(frameSse([{ kind: "hold" }, { kind: "done" }])).toBe(`data: ${SSE_DONE}\n\n`);
  });
});

test.describe("the faked provider, end to end in Chromium", () => {
  test("a chat-completions turn reaches the page and the text arrives", async ({
    app,
    provider,
  }) => {
    await provider.script([{ path: CHAT_COMPLETIONS_PATH, reply: { kind: "sse", turn: chatTextTurn("hello from the fake") } }]);
    await mountConsumer(app);

    const result = await stream(app, `${PROVIDER_BASE_URL}/chat/completions`, CHAT_BODY);

    expect(result.error).toBeNull();
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/event-stream");
    expect(result.done).toBe(true);
    expect(result.text.trim()).toBe("hello from the fake");
    expect(provider.countFor(CHAT_COMPLETIONS_PATH)).toBe(1);
    // The request carried what an OpenAI-compatible client sends.
    const body = provider.last()?.body as Record<string, unknown>;
    expect(body["stream"]).toBe(true);
  });

  test("a Responses API turn reaches the page too", async ({ app, provider }) => {
    await provider.script([{ path: RESPONSES_PATH, reply: { kind: "sse", turn: responsesTextTurn("hello from the responses api") } }]);
    await mountConsumer(app);

    const result = await stream(app, `${PROVIDER_BASE_URL}/responses`, CHAT_BODY);

    expect(result.error).toBeNull();
    expect(result.text.trim()).toBe("hello from the responses api");
    expect(provider.countFor(RESPONSES_PATH)).toBe(1);
  });

  test("a tool call survives the wire as a complete JSON argument", async ({
    app,
    provider,
  }) => {
    const input = { path: "src/index.ts", limit: 20 };
    const turn = chatToolCallTurn({ toolCallId: "call_1", toolName: "read", input });
    // Two requests: the tool-call turn, then the raw turn read back to inspect
    // its bytes.
    await provider.script([{ reply: { kind: "sse", turn } }, { reply: { kind: "sse", turn } }]);
    await mountConsumer(app);

    const result = await stream(app, `${PROVIDER_BASE_URL}/chat/completions`, CHAT_BODY);

    // No text in a tool-call turn: the tool call is in the chunks, not the text.
    expect(result.text).toBe("");
    const chunks = (await app.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-fake", stream: true, messages: [] }),
      });
      return response.text();
    }, `${PROVIDER_BASE_URL}/chat/completions`)) as string;

    const deltas = (parseSseJson(chunks) as Array<{
      choices: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    }>).flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? []);
    const joined = deltas.map((delta) => delta.function?.arguments ?? "").join("");
    // The provider streams arguments in fragments; the consumer must
    // concatenate them before the JSON is parseable.
    expect(JSON.parse(joined)).toEqual(input);
  });
});

test.describe("the pacer", () => {
  test("a gated stream delivers exactly what it was released, and no more", async ({
    app,
    provider,
    pacer,
  }) => {
    const turn = chatTextTurn("one two three four five");
    const total = parseSse(turn.body).filter((event) => event.data !== SSE_DONE).length;
    expect(total).toBeGreaterThan(4);

    await provider.script([{ reply: { kind: "sse", turn } }]);
    await mountConsumer(app);

    // Arm the gate *before* the request, so the very first three events are
    // the only ones that get through. The command is order-independent.
    await pacer.command({ op: "delay", ms: 5 });
    await pacer.command({ op: "release", count: 3 });

    const pending = app.evaluate(
      (url) =>
        (
          window as unknown as {
            __baahE2EStream: (options: unknown) => Promise<ConsumerResult>;
          }
        ).__baahE2EStream({ url, body: JSON.stringify({ model: "gpt-fake", stream: true }) }),
      `${PROVIDER_BASE_URL}/chat/completions`,
    );

    // The stream is now open and stalled. This is Plan.md §5.4's "the provider
    // is thinking" state: an answer started, and it is not finished. The poll
    // is a signal, not a sleep — it returns the moment the gate is reached.
    await expect
      .poll(async () => (await pacer.state()).emitted, { timeout: 5_000 })
      .toBe(3);
    expect((await pacer.state()).gated).toBe(true);
    expect((await pacer.state()).closed).toBe(false);
    expect(total).toBeGreaterThan(3);

    // Let the rest through; the turn finishes with its [DONE].
    await pacer.command({ op: "releaseAll" });
    const result = (await pending) as ConsumerResult;
    expect(result.done).toBe(true);
    expect(result.text.trim()).toBe("one two three four five");
  });

  test("a stream can be cut mid-flight and the cut is observable", async ({
    app,
    provider,
    pacer,
  }) => {
    await provider.script([{ reply: { kind: "sse", turn: chatTextTurn("a b c d e f") } }]);
    await mountConsumer(app);

    const pending = app.evaluate(
      (url) =>
        (
          window as unknown as {
            __baahE2EStream: (options: unknown) => Promise<ConsumerResult>;
          }
        ).__baahE2EStream({ url, body: JSON.stringify({ model: "gpt-fake", stream: true }) }),
      `${PROVIDER_BASE_URL}/chat/completions`,
    );

    await pacer.command({ op: "delay", ms: 5 });
    // Error the stream after three events: role announcement plus two words
    // have arrived, so there is real partial output to keep, and then the
    // connection dies.
    await pacer.command({ op: "errorAt", count: 3 });

    const result = (await pending) as ConsumerResult;
    expect(result.error).toContain("cut mid-flight");
    expect(result.done).toBe(false);
    expect(result.text.trim()).toBe("a b");

    const state = await pacer.state();
    expect(state.errored).toBe(true);
    expect(state.closed).toBe(true);
  });

  test("a response the app never streams is untouched", async ({ app, provider }) => {
    await provider.script([
      { reply: { kind: "json", status: 401, body: JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_api_key" } }) } },
    ]);
    await mountConsumer(app);

    const result = await stream(app, `${PROVIDER_BASE_URL}/chat/completions`, CHAT_BODY);

    expect(result.status).toBe(401);
    expect(result.contentType).toContain("application/json");
    // A JSON body is not re-streamed: no SSE event was dispatched.
    expect(result.events).toBe(0);
    expect(result.done).toBe(false);
  });
});


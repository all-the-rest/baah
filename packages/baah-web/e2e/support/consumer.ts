/**
 * A minimal page that speaks the faked provider's wire protocol.
 *
 * The app under test cannot exercise the provider yet: `packages/baah-web/src`
 * is still a placeholder shell, so there is no chat UI to send a turn from. The
 * alternative — inventing an app feature the product does not have, in order to
 * have something to test — would be testing the fake, not the code.
 *
 * So the harness tests itself. This page is a real document on the app's own
 * origin, it does a real `fetch`, and Chromium's real network stack carries the
 * response. It parses with `parseSse`, the exact implementation the Node-side
 * specs assert against, which mirrors `eventsource-parser@3.1.1` — the parser
 * every AI SDK provider runs (`@ai-sdk/provider-utils` → `parseJsonEventStream`).
 *
 * The page half is written as ordinary typed functions and injected as their
 * transpiled source, so the code that touches the wire is typechecked here
 * rather than pasted into a template string.
 */
import { parseSse } from "./sse.ts";

/** What a client-side stream attempt reports back. */
export type ConsumerResult = {
  readonly status: number;
  readonly contentType: string | null;
  /** Text assembled from the text-bearing chunks of the stream. */
  readonly text: string;
  /** How many SSE events were dispatched. */
  readonly events: number;
  /** True when a `[DONE]` sentinel was dispatched. */
  readonly done: boolean;
  /** Index of the first dispatched event, for a stalled-stream assertion. */
  readonly firstEventIndex: number | null;
  /** Set when the attempt failed. */
  readonly error: string | null;
};

/** The options `__baahE2EStream` takes. */
export type ConsumerOptions = {
  readonly url: string;
  readonly body: string;
  readonly method?: string;
  /** Name of an `AbortSignal` created by `__baahE2ESignal`. */
  readonly signalName?: string;
};

/**
 * Pull assistant text out of one dispatched SSE payload, in either dialect.
 *
 * Returns `null` for a payload that carries no text — a role announcement, a
 * tool call, the `[DONE]` sentinel — so a caller can tell "no text here" from
 * "empty text here".
 *
 * This function is stringified into the page, so it must stay self-contained.
 */
function textOfChunk(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;

  // AI SDK UI message stream protocol v1.
  if (record["type"] === "text-delta") {
    const delta = record["delta"];
    return typeof delta === "string" ? delta : null;
  }
  // OpenAI Responses API.
  if (record["type"] === "response.output_text.delta") {
    const delta = record["delta"];
    return typeof delta === "string" ? delta : null;
  }

  // OpenAI Chat Completions: choices[0].delta.content.
  const choices = record["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (first !== null && typeof first === "object") {
      const delta = (first as Record<string, unknown>)["delta"];
      if (delta !== null && typeof delta === "object") {
        const content = (delta as Record<string, unknown>)["content"];
        if (typeof content === "string") return content;
      }
    }
  }

  return null;
}

/**
 * The browser half, injected via `page.addScriptTag`. It reads a POST body,
 * consumes the SSE response and reports everything a spec might assert on.
 *
 * Stringified into the page, so it must stay self-contained apart from the two
 * helpers injected alongside it.
 */
function installConsumer(): void {
  const global = window as unknown as Record<string, unknown>;

  global["__baahE2ESignal"] = (name: string): AbortSignal => {
    const bus = window as unknown as Record<string, AbortController>;
    if (bus[name] === undefined) bus[name] = new AbortController();
    return bus[name].signal;
  };

  global["__baahE2EAbort"] = (name: string): void => {
    const bus = window as unknown as Record<string, AbortController>;
    if (bus[name] === undefined) bus[name] = new AbortController();
    bus[name].abort();
  };

  global["__baahE2EStream"] = async (options: {
    url: string;
    body: string;
    method?: string;
    signalName?: string;
  }): Promise<ConsumerResult> => {
    const base = {
      status: 0,
      contentType: null,
      text: "",
      events: 0,
      done: false,
      firstEventIndex: null,
      error: null,
    };

    let text = "";
    let events = 0;
    let done = false;
    let firstEventIndex: number | null = null;

    const report = (extra: Partial<ConsumerResult>): ConsumerResult => ({
      ...base,
      ...extra,
      text,
      events,
      done,
      firstEventIndex,
    });

    try {
      const init: RequestInit = {
        method: options.method ?? "POST",
        headers: { "content-type": "application/json" },
        body: options.body,
      };
      if (options.signalName !== undefined) {
        const bus = window as unknown as Record<string, AbortController>;
        const signal = bus[options.signalName]?.signal;
        if (signal !== undefined) init.signal = signal;
      }

      const response = await fetch(options.url, init);
      const status = response.status;
      const contentType = response.headers.get("content-type");
      if (response.body === null) {
        return report({ status, contentType, error: "no response body" });
      }

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      // The parser dispatches on a blank line, so the buffer has to survive
      // across chunk boundaries — which is why every framed event ends with
      // "\n\n" and why a cut-off stream loses exactly its last event.
      let buffer = "";

      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary + 2);
          buffer = buffer.slice(boundary + 2);
          for (const event of parseSse(frame)) {
            if (firstEventIndex === null) firstEventIndex = events;
            events += 1;
            if (event.data === undefined || event.data === "[DONE]") {
              done = done || event.data === "[DONE]";
              continue;
            }
            const chunkText = textOfChunk(JSON.parse(event.data));
            if (chunkText !== null) text += chunkText;
          }
          boundary = buffer.indexOf("\n\n");
        }
      }

      return report({ status, contentType });
    } catch (cause) {
      return report({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  };
}

/**
 * The `addScriptTag` payload.
 *
 * `var` rather than `const`: the injected functions close over `parseSse` and
 * `textOfChunk`, and script-level `var` puts them on the global object where
 * those closures resolve them.
 */
export const consumerScriptSource: string = [
  `var parseSse = ${parseSse.toString()};`,
  `var textOfChunk = ${textOfChunk.toString()};`,
  `var installConsumer = ${installConsumer.toString()};`,
  "installConsumer();",
].join("\n");

/**
 * SSE wire format, hand-built.
 *
 * The framing implemented here is not a guess. It was read off the code that
 * actually consumes it:
 *
 * - `eventsource-parser@3.1.1` (`src/index.js`, the `createParser` used by every
 *   AI SDK provider): a `data:` line may carry ONE optional space after the
 *   colon (`valueStart = charCodeAt(start+5) === SPACE ? start+6 : start+5`),
 *   consecutive `data:` lines join with `"\n"`, and an event is dispatched only
 *   on an empty line (`dispatchEvent` is called from `parseLine` when
 *   `start === end`). Lines that do not start with `data:`/`event:`/`id:`/
 *   `retry:` are reported as `Unknown field` errors — so nothing else may be
 *   emitted.
 * - `@ai-sdk/provider-utils@5.0.51` → `parseJsonEventStream`: a literal
 *   `data: [DONE]` event is swallowed (`if (data === '[DONE]') return`), i.e.
 *   `[DONE]` is a terminator, not a payload.
 * - The schemas the chunks have to satisfy come from the provider the loop will
 *   use: `@ai-sdk/openai@4.0.80` (the version `ai@7.0.122` pins in
 *   devDependencies) for `openaiChatChunkSchema` / `openaiResponsesChunkSchema`,
 *   and `@ai-sdk/anthropic@4.0.68` for `anthropicChunkSchema`
 *   (`packages/baah-web/e2e/support/turns.ts` reads both).
 *
 * Nothing in this file imports a provider, a Node builtin, or Playwright. It is
 * pure data, so it can be unit-asserted from a spec without a browser.
 */

/** The literal terminator OpenAI sends and the AI SDK ignores. */
export const SSE_DONE = "[DONE]";

/**
 * The AI SDK UI Message Stream Protocol v1 (ai-sdk.dev/docs/ai-sdk-ui/stream-protocol).
 * Used by the fallback transport of Plan.md §5.4 ("`generateText` →
 * `createUIMessageStream` with synthetic `text-delta` chunks") if that fallback
 * ever goes over HTTP.
 */
export const uiMessageStreamHeader = "x-vercel-ai-ui-message-stream";

/** Marks a fulfilled route so the in-page pacer knows to re-stream it. */
export const streamMarkerHeader = "x-baa-e2e-stream";

/** One SSE event's worth of payload, before framing. */
export type SseEvent =
  /** A JSON payload, serialised into a single `data:` line. */
  | { readonly kind: "data"; readonly value: unknown; readonly event?: string }
  /** The terminal `data: [DONE]` sentinel. */
  | { readonly kind: "done" }
  /** A zero-length write; used to hold a stream open on purpose. */
  | { readonly kind: "hold" };

/**
 * Frame events as an SSE byte stream.
 *
 * Every event is terminated by a blank line, because that is the only thing
 * that dispatches it in the parser the AI SDK uses. `hold` frames write nothing
 * at all: they exist so a stream can be kept open (or cut off) at a precise
 * point without inventing a payload.
 *
 * ## The optional `event:` name is load-bearing for Anthropic
 *
 * Anthropic's Messages stream names every event — `event: message_start`,
 * `event: content_block_delta`, `event: message_stop` — and the docs are explicit
 * that "each event uses an SSE event name … and includes the matching event
 * `type` in its data". A fake that emitted only `data:` lines would parse
 * identically (the AI SDK reads `data`) but would not be the wire format, and the
 * brief for the Anthropic block is explicit that a fake which only *resembles*
 * the thing hides exactly the bug it was written to find. `event:` is a legal
 * field for the parser (it is one of the four), so emitting it is safe.
 */
export function frameSse(events: readonly SseEvent[]): string {
  let out = "";
  for (const event of events) {
    switch (event.kind) {
      case "data": {
        const name = event.event === undefined ? "" : `event: ${event.event}\n`;
        out += `${name}data: ${JSON.stringify(event.value)}\n\n`;
        break;
      }
      case "done":
        out += `data: ${SSE_DONE}\n\n`;
        break;
      case "hold":
        break;
    }
  }
  return out;
}

/**
 * Build the split points for delivering `body` as a sequence of network
 * chunks: one write per SSE event, in order.
 *
 * A "cut off mid-stream" is a body whose last event is missing its terminating
 * blank line (or whose `[DONE]` never arrives), so the parser never dispatches
 * the final event and the turn has no terminal marker — exactly the failure
 * Plan.md §5.4 calls "abgeschnitten". `splitSse` therefore appends the
 * unterminated remainder as its own final part, so nothing is lost.
 */
export function splitSse(body: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const boundary = body.indexOf("\n\n", cursor);
    if (boundary === -1) break;
    parts.push(body.slice(cursor, boundary + 2));
    cursor = boundary + 2;
  }
  if (cursor < body.length) parts.push(body.slice(cursor));
  return parts;
}

/** One dispatched event, as the parser hands it to the consumer. */
export type ParsedSseEvent = {
  /** The joined `data:` payload, or `undefined` when the event carried none. */
  readonly data: string | undefined;
  /** The `event:` field, when the event set one. */
  readonly event: string | undefined;
};

/**
 * A faithful transcription of `eventsource-parser@3.1.1`'s line handling, kept
 * deliberately small: the suite needs the rules the AI SDK depends on, and a
 * re-implementation with extra rules would prove nothing.
 */
export function parseSse(body: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  let data: string | undefined;
  let dataLines = 0;
  let event: string | undefined;

  const dispatch = (): void => {
    if (dataLines > 0) events.push({ data, event });
    data = undefined;
    dataLines = 0;
    event = undefined;
  };

  // `splitSse` guarantees a complete body; normalize CRLF the way the parser
  // does and drop the BOM it also strips.
  //
  // The last element is the text *after* the final line terminator: an
  // unterminated line, not a blank one. `eventsource-parser` keeps such a
  // line in its buffer and never dispatches it, so it must not be mistaken
  // for the blank line that dispatches the event before it. Getting this
  // wrong makes a stream cut mid-event look like one that ended cleanly.
  const lines = body.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  for (const line of lines.slice(0, -1)) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
      data = dataLines === 0 ? value : `${data}\n${value}`;
      dataLines += 1;
      continue;
    }
    if (line.startsWith("event:")) {
      const value = line.slice(6).startsWith(" ") ? line.slice(7) : line.slice(6);
      event = value === "" ? undefined : value;
      continue;
    }
    // `id:` carries no meaning for a POST stream and is not asserted anywhere.
    // Anything else would be an "Unknown field" error in the real parser.
    throw new Error(`Unexpected SSE field: ${JSON.stringify(line)}`);
  }
  // No trailing dispatch. `eventsource-parser` keeps a line that never got its
  // terminating blank line in its buffer, so a stream cut mid-event loses
  // exactly that event. Flushing here would invent an event that never
  // arrived.
  return events;
}

/** Parse the JSON payloads of an SSE body, skipping the `[DONE]` sentinel. */
export function parseSseJson(body: string): unknown[] {
  const out: unknown[] = [];
  for (const event of parseSse(body)) {
    if (event.data === undefined || event.data === SSE_DONE) continue;
    out.push(JSON.parse(event.data));
  }
  return out;
}

/**
 * Whether a stream ended the way Plan.md §5.4 defines success: a terminal event
 * and the `[DONE]` sentinel. A `200` says nothing.
 *
 * A body that is not an SSE stream at all (`application/json` with a status of
 * 200) is not a failure of this function — it is a body that never claimed to
 * be a stream, and it is not cleanly terminated.
 */
export function isCleanlyTerminated(body: string): boolean {
  try {
    const events = parseSse(body);
    const last = events[events.length - 1];
    return last?.data === SSE_DONE;
  } catch {
    return false;
  }
}

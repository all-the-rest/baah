/**
 * One SSE turn builder the existing `support/turns.ts` does not have: a
 * **reasoning-then-text** turn on the chat-completions path.
 *
 * ## Why this file exists at all
 *
 * `support/turns.ts` is the scenario library for the functional suite and it is
 * **not** touched by this harness — the brief says to reuse the machinery, not to
 * write a second fake, and there is exactly one fake (the route interception in
 * `support/provider.ts`) and exactly one SSE framing (`support/sse.ts`). This is
 * neither: it is one additional *chunk shape* on the same wire format, needed
 * because `reasoning` is one of `Plan.md` §6.1's three part types and the
 * transcript renders it (`Transcript.tsx`'s `PartView` has a `reasoning` arm
 * behind a collapsed `<details>`).
 *
 * `support/turns.ts` cannot express it because none of its builders emit a
 * `reasoning_content` delta, and that is not an omission: none of the seven
 * `§15.6` scenarios is about reasoning. Adding it there would have meant editing a
 * file the functional suite's assertions are written against, so it lives here,
 * inside the screenshot set's own folder.
 *
 * ## Why `reasoning_content` is the right field
 *
 * Verified against the installed `@ai-sdk/openai-compatible@3.0.59`, not from
 * memory: `src/chat/openai-compatible-chat-language-model.ts` builds
 * `chunkBaseSchema` with
 *
 * ```
 * z.object({
 *   role: ..., content: openAICompatibleContentSchema,
 *   reasoning_content: z.string().nullish(),
 *   reasoning: z.string().nullish(),      // gpt-oss style
 *   tool_calls: ...
 * })
 * ```
 *
 * and the stream loop reads `delta.reasoning_content ?? delta.reasoning`,
 * emitting `reasoning-start` / `reasoning-delta` / `reasoning-end` around it
 * (and closing any active text part first). So a `reasoning_content` delta
 * reaches `Plan.md` §6.1's `reasoning` part on the wire the app already speaks.
 *
 * The terminal event is `finish_reason: "stop"`, identical to `chatTextTurn`'s,
 * because `Plan.md` §5.4's terminal check is `rawFinishReason !== undefined` and
 * `@ai-sdk/openai-compatible` fills `raw` from `choice.finish_reason` (unlike the
 * Responses path, which is why `support/app.ts` configures the
 * `openai-compatible` catalog row).
 */
import { frameSse, type SseEvent } from "../support/sse.ts";
import type { Turn } from "../support/turns.ts";

const MODEL = "gpt-fake";
const CREATED = 1_700_000_000;
const CHUNK_ID = "chatcmpl-reasoning";

const data = (value: unknown): SseEvent => ({ kind: "data", value });
const done: SseEvent = { kind: "done" };

function chunk(delta: unknown, finish?: string): SseEvent {
  return data({
    id: CHUNK_ID,
    created: CREATED,
    model: MODEL,
    choices: [
      finish === undefined ? { index: 0, delta } : { index: 0, delta: {}, finish_reason: finish },
    ],
  });
}

/**
 * Split a German sentence into word-sized deltas, the way a real provider
 * streams it. `chatTextTurn` does the same thing with `text.split(" ")`, and the
 * point of *not* sending one big delta is that the screenshot of a live turn has
 * to look like a stream, not like a `curl`.
 */
function words(text: string): string[] {
  return text.split(" ").map((word) => `${word} `);
}

/**
 * `reasoning` deltas first, then `content` deltas, then `finish_reason: "stop"`.
 *
 * The order matters and is the provider's, not ours: the SDK closes the
 * reasoning part (`reasoning-end`) before it opens the text part
 * (`text-start`), so the transcript's part order — a collapsed
 * „Denkprozess des Modells" `<details>` above the answer — is what a real
 * reasoning model produces. Emitting them interleaved would produce an
 * alternation the SDK flattens into several parts and a screenshot nobody would
 * recognise as the app.
 */
export function chatReasoningThenTextTurn(options: {
  readonly reasoning: string;
  readonly text: string;
}): Turn {
  const { reasoning, text } = options;
  return {
    body: frameSse([
      chunk({ role: "assistant" }),
      ...words(reasoning).map((word) => chunk({ reasoning_content: word })),
      ...words(text).map((word) => chunk({ content: word })),
      chunk({}, "stop"),
      done,
    ]),
    toolCallIds: [],
    toolNames: [],
  };
}

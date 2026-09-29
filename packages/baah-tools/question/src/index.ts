/**
 * @all-the.rest/baah-tool-question — ask the user something mid-turn and wait.
 *
 * The tool is deliberately thin: it validates the questions, hands them to an
 * injected `QuestionChannel` (the UI bridge) and waits for the answers. It has
 * no DOM access and no storage — the engine supplies the channel in Wave 2
 * (see README.md). If no channel is wired up, calls fail loudly with a
 * `ToolError` instead of hanging forever.
 */

import { defineTool, ToolError, type ToolDefinition } from "@all-the.rest/baah-core";
import { z } from "zod";

/** Convention: the header is a label, not a sentence. */
export const MAX_HEADER_LENGTH = 30;
/**
 * One option, not two. The reference harness (OpenCode v2.0.19) puts no
 * minimum on `options` and drives a one-option question in its own test
 * (`packages/core/test/tool-question.test.ts` upstream) — a one-option card is
 * the "confirm this" shape, and a model that can answer a binary question at
 * all will emit exactly that. A `min(2)` here is a hard schema rejection of a
 * call the tool could have rendered perfectly, so the floor is 1.
 *
 * Zero options stays rejected: there would be no question to ask.
 */
export const MIN_OPTIONS = 1;
export const MAX_OPTIONS = 8;
/** More than this and the user is being buried, not asked. */
export const MAX_QUESTIONS = 10;
export const MAX_QUESTION_LENGTH = 1000;
export const MAX_OPTION_LABEL_LENGTH = 100;
export const MAX_OPTION_DESCRIPTION_LENGTH = 500;

const questionOptionSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(MAX_OPTION_LABEL_LENGTH)
    // CONTRACT TEXT, NOT DECORATION. This string is serialised into the JSON
    // schema the model reads (the AI SDK derives it from this zod object) and
    // the UI renders `label` as a selectable button, so the 1-5-words rule is
    // the only thing standing between the model and a wall of buttons. It is
    // asserted by test/contract.test.ts and must not be reworded lightly.
    .describe("Display text (1-5 words, concise)"),
  description: z
    .string()
    .trim()
    .min(1)
    .max(MAX_OPTION_DESCRIPTION_LENGTH)
    .optional()
    .describe("One sentence explaining the consequence of picking this option."),
});

const questionSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(MAX_QUESTION_LENGTH)
    .describe("The complete question, phrased so it can be answered without more context."),
  header: z
    .string()
    .trim()
    .min(1)
    .max(MAX_HEADER_LENGTH)
    .describe(`Very short label for the card, max ${MAX_HEADER_LENGTH} characters.`),
  options: z
    .array(questionOptionSchema)
    .min(MIN_OPTIONS)
    .max(MAX_OPTIONS)
    .describe(
      `At least ${MIN_OPTIONS} and at most ${MAX_OPTIONS} options. A single option is ` +
        "allowed and reads as a confirmation (\"proceed?\"). Do not add a free-text option — " +
        "the UI always offers one. If you recommend an option, put it first and end its " +
        "label with `(Recommended)`.",
    ),
  multiple: z
    .boolean()
    .optional()
    .describe("Set to `true` to let the user pick more than one option."),
});

/** One question, as the model produced it. */
export type Question = z.input<typeof questionSchema>;

export const questionInputSchema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(MAX_QUESTIONS)
    .describe("The questions to ask, in the order they should be shown."),
});

export type QuestionInput = z.input<typeof questionInputSchema>;

/** One array of chosen labels (or free text) per question, in the same order. */
export type QuestionAnswers = string[][];

export interface QuestionOutput {
  answers: QuestionAnswers;
}

/**
 * The model-facing text for a dismissal. Deliberately *not* phrased as a
 * malfunction: a dismissed card means the user declined the interaction, and
 * the correct next move is to proceed on a stated assumption, not to retry.
 */
export const DISMISSED_MESSAGE =
  "The user dismissed this question without answering it. That is a decision, not a " +
  "failure. Do not call `question` again in this turn. Continue with the most likely " +
  "course of action and state the assumption you are making.";

/**
 * The user closed the card **without answering** — a dismissal.
 *
 * This is deliberately not the same thing as a skip, and the difference is
 * visible to the model:
 *
 * | outcome | the model sees |
 * |---|---|
 * | answered | `{ answers: [["SQLite WASM (Recommended)"]] }` |
 * | skipped | `{ answers: [[]] }` — a *result*, per-question |
 * | dismissed | a thrown {@link QuestionCancelledError} — a *rejection* |
 *
 * A length check alone cannot tell a dismissal from a skip: both "produced no
 * answer for this question". The reference harness has the same problem and
 * solves it with a typed `CancelledError` ("The user dismissed this question"),
 * which is what {@link QuestionCancelledError} is. Wave 2's channel raises it
 * from `ask()` when the user closes the card (Escape, the ✕, a panel
 * unmount); see README.md.
 */
export class QuestionCancelledError extends ToolError {
  constructor(message: string = DISMISSED_MESSAGE) {
    super(message);
    this.name = "QuestionCancelledError";
  }
}

/**
 * Recognises a dismissal from a channel that does not import this package.
 *
 * `instanceof` is the contract; the text match is the migration path for a
 * channel copied from the reference harness, which raises a `CancelledError`
 * with the message "The user dismissed this question". It can only *specialise*
 * an error — a wrong guess turns a generic failure into a slightly more
 * specific one, and it never touches the answer payload.
 */
export function isQuestionDismissed(error: unknown): boolean {
  if (error instanceof QuestionCancelledError) return true;
  if (!(error instanceof Error)) return false;
  return /dismiss/i.test(error.name) || /dismiss/i.test(error.message);
}

/**
 * The UI bridge. One method, because the engine owns the pending-promise
 * bookkeeping: it shows the questions, and resolves when the user is done.
 */
export interface QuestionChannel {
  /**
   * Show `questions` and resolve with one array of answer strings per question,
   * in the same order.
   *
   * Per question:
   * - **answered** — the chosen labels, or the free text as a single string.
   * - **skipped** — an empty array. The user was shown the question and chose
   *   not to pick; the tool result carries that as a per-question empty list.
   *
   * The strings are **user input and are returned verbatim** — not trimmed, not
   * normalised, not interpreted. In particular an empty free-text answer is
   * `[""]` (one empty string), which is a *different* outcome from the `[]` of
   * a skip, and this tool does not collapse the two.
   *
   * **Dismissal is not a resolution.** If the user closes the card without
   * answering, reject with a {@link QuestionCancelledError} rather than
   * resolving with empty rows: "I looked at this and declined" and "I never got
   * to see it" are different facts and must not both arrive as `[]`.
   *
   * The tool races this promise against `ToolContext.signal`, so a turn abort
   * never leaves the tool waiting. The channel should also settle its own
   * pending card (dismiss it) when the surrounding turn is aborted.
   */
  ask(questions: readonly Question[]): Promise<QuestionAnswers>;
}

export const NO_CHANNEL_MESSAGE =
  "The question tool is running without a user interface: no QuestionChannel is wired " +
  "up, so nobody can answer. Do not call `question` again in this turn — either continue " +
  "with the most likely answer and state the assumption explicitly, or stop and report " +
  "that you need a decision from the user.";

export const ABORTED_MESSAGE =
  "The question was cancelled because the turn was aborted before the user answered. " +
  "Do not call `question` again in this turn.";

/** Default channel: fails loudly rather than waiting for an answer that never comes. */
export const disconnectedQuestionChannel: QuestionChannel = {
  ask() {
    return Promise.reject(new ToolError(NO_CHANNEL_MESSAGE));
  },
};

/**
 * The channel is an outside boundary, so its payload is parsed, not trusted.
 *
 * `z.string()` is used bare on purpose: **no trim, no transform, no length cap
 * on the way out.** The answer is untrusted text the user typed, and the whole
 * job of this pass is to prove it is a `string[][]` of the right length — not
 * to improve it. A `""` stays `""` (a free-text answer the user left empty),
 * a leading space stays a leading space, and a 10.000-character rant stays
 * intact: silently "fixing" it would make the transcript and the model input
 * disagree about what the user said. Framing and delimiting are Wave 2's job
 * at the `toModelOutput` seam (README.md), not ours.
 */
const answersSchema = z.array(z.array(z.string()));

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Guarantees that whatever reaches the model for a dismissal carries the
 * model-facing instruction, whatever the channel called it.
 *
 * A `QuestionCancelledError` reaches the model with the channel's own wording
 * (`"user pressed ESC"`), and on its own that is a log line, not an
 * instruction: the model is not told that this was a decision, not a
 * malfunction, nor that it must not ask again this turn. Idempotent — the
 * default message already satisfies it.
 */
function withDismissalGuidance(error: QuestionCancelledError): QuestionCancelledError {
  return error.message.startsWith(DISMISSED_MESSAGE)
    ? error
    : new QuestionCancelledError(`${DISMISSED_MESSAGE} (${error.message})`);
}

function toChannelError(error: unknown): ToolError {
  // Order matters, and the first two are deliberately different.
  //
  // 1. A `QuestionCancelledError` stays a `QuestionCancelledError` — so the
  //    engine can still separate a dismissal from an abort by `instanceof` —
  //    but it is re-issued with the model's instruction attached.
  if (error instanceof QuestionCancelledError) return withDismissalGuidance(error);
  // 2. Every other deliberate `ToolError` a channel raised on purpose is
  //    returned unchanged. Re-wrapping it would flatten a tagged error into a
  //    plain one and lose the distinction the channel was making.
  if (error instanceof ToolError) return error;
  // 3. A channel copied from the reference harness raises a plain `Error`.
  //    The dismissal text is kept after ours rather than dropped: it is the
  //    only evidence of *why* the card went away (Escape vs. panel unmount),
  //    and the model's own instruction has to come first regardless.
  if (isQuestionDismissed(error)) return new QuestionCancelledError(withDetail(error));
  return new ToolError(
    `The question could not be answered: ${describeError(error)}. Assume nobody can ` +
      "reply right now — do not call `question` again in this turn. Continue with the " +
      "most likely option and state the assumption explicitly.",
  );
}

/** `DISMISSED_MESSAGE`, with the channel's own words kept in parentheses. */
function withDetail(error: unknown): string {
  return `${DISMISSED_MESSAGE} (${describeError(error)})`;
}

/**
 * Races `work` against `signal`. Rejects with a `ToolError` instead of leaving
 * the call pending forever, and always detaches the abort listener again.
 */
function withAbort<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new ToolError(message));

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new ToolError(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(toChannelError(error));
      },
    );
  });
}

export interface QuestionToolOptions {
  /**
   * The UI bridge. Omit it and every call rejects with `NO_CHANNEL_MESSAGE` —
   * a headless run fails visibly instead of stalling the turn.
   */
  channel?: QuestionChannel;
}

/** Builds the tool with the channel the engine wired to the transcript UI. */
export function createQuestionTool(
  options: QuestionToolOptions = {},
): ToolDefinition<QuestionInput, QuestionOutput> {
  const channel = options.channel ?? disconnectedQuestionChannel;

  return defineTool<QuestionInput, QuestionOutput>({
    id: "question",
    description:
      "Ask the user one or more questions and wait for the answers. Use it when a " +
      "decision changes the result and a wrong guess is expensive (library choice, " +
      "product decision, a destructive action). Do not use it for facts you can read " +
      "from the workspace, and do not use it when running unattended.\n\n" +
      "Conventions the UI enforces:\n" +
      "- Do not add a free-text option. The UI always offers one.\n" +
      "- If you recommend an option, put it first and end its label with " +
      "`(Recommended)`.\n" +
      `- \`header\` is a very short label (max ${MAX_HEADER_LENGTH} characters); ` +
      "`question` is the complete sentence the user reads.\n" +
      `- Give at least ${MIN_OPTIONS} and at most ${MAX_OPTIONS} options per question. A ` +
      "single option is fine when you only need a confirmation. Set `multiple: true` when " +
      "more than one may be picked, and keep each option label to 1-5 words.\n\n" +
      "Returns the answers in the order the questions were asked. An empty answer for a " +
      "question means the user skipped it; if the user dismisses the card, the call fails " +
      "instead and no answers are returned — do not call `question` again in that turn.",
    access: "read",
    inputSchema: questionInputSchema,
    async execute(context, input) {
      // Check before asking: an aborted turn must not open a question card
      // that nobody will ever answer.
      if (context.signal.aborted) throw new ToolError(ABORTED_MESSAGE);

      // A dismissal throws out of `withAbort` as a `QuestionCancelledError`,
      // which is *not* a shape problem: it never reaches the checks below,
      // and it is not folded into "unanswered" either.
      const answers = await withAbort(
        channel.ask(input.questions),
        context.signal,
        ABORTED_MESSAGE,
      );

      const parsed = answersSchema.safeParse(answers);
      if (!parsed.success) {
        throw new ToolError(
          "The question channel answered in an unexpected shape (expected one array of " +
            "answer strings per question). Treat the question as unanswered, do not call " +
            "`question` again in this turn, and continue with a stated assumption.",
        );
      }
      if (parsed.data.length !== input.questions.length) {
        throw new ToolError(
          `The question channel returned ${parsed.data.length} answer(s) for ` +
            `${input.questions.length} question(s). Treat the question as unanswered, do ` +
            "not call `question` again in this turn, and continue with a stated assumption.",
        );
      }

      // `parsed.data` is zod's own copy, not the array the channel handed us:
      // a channel that reuses one array across calls cannot have its result
      // mutated out from under the engine afterwards.
      return { answers: parsed.data };
    },
  });
}

/**
 * Ready-to-use instance without a UI. Every call rejects with
 * `NO_CHANNEL_MESSAGE` — see README.md.
 */
export const questionTool = createQuestionTool();

export default questionTool;

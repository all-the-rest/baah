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
/** A question with one option is not a question, more than eight does not fit. */
export const MIN_OPTIONS = 2;
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
    .describe("Short answer text shown as the selectable label."),
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
      `Between ${MIN_OPTIONS} and ${MAX_OPTIONS} options. Do not add a free-text option — ` +
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
 * The UI bridge. One method, because the engine owns the pending-promise
 * bookkeeping: it shows the questions, and resolves when the user is done.
 */
export interface QuestionChannel {
  /**
   * Show `questions` and resolve with one array of answer strings per question,
   * in the same order. An empty array means "skipped". Free-text answers come
   * back as a single string, exactly as the user typed it.
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

/** The channel is an outside boundary, so its payload is parsed, not trusted. */
const answersSchema = z.array(z.array(z.string()));

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toChannelError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  return new ToolError(
    `The question could not be answered: ${describeError(error)}. Assume nobody can ` +
      "reply right now — do not call `question` again in this turn. Continue with the " +
      "most likely option and state the assumption explicitly.",
  );
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
      `- Give between ${MIN_OPTIONS} and ${MAX_OPTIONS} options per question, and set ` +
      "`multiple: true` when more than one may be picked.\n\n" +
      "Returns the answers in the order the questions were asked.",
    access: "read",
    inputSchema: questionInputSchema,
    async execute(context, input) {
      // Check before asking: an aborted turn must not open a question card
      // that nobody will ever answer.
      if (context.signal.aborted) throw new ToolError(ABORTED_MESSAGE);

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

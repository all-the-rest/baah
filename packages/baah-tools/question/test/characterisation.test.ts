/**
 * Characterisation tests written by the verify agent. They do not assert new
 * features — each one pins down a promise the README or the source comments
 * make but that `question.test.ts` does not actually check. Every test here
 * passes on the current source; several of them fail once a specific guard is
 * deleted (see the verify report for the mutant/killed-by table).
 */
import { createMemoryWorkspace, ToolError, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it, vi } from "vitest";

import {
  createQuestionTool,
  MAX_OPTION_DESCRIPTION_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
  MAX_QUESTION_LENGTH,
  questionInputSchema,
  type QuestionAnswers,
  type QuestionChannel,
} from "../src/index.ts";

function context(signal: AbortSignal): ToolContext {
  return {
    workspace: createMemoryWorkspace(),
    cwd: ".",
    signal,
    approve: async () => "allow-once",
    emit: () => {},
    toolCallId: "call-1",
    attempt: 1,
  }
}

const live = (): AbortSignal => new AbortController().signal;

const base = {
  question: "Which storage engine should the app use?",
  header: "Storage",
  options: [{ label: "SQLite WASM (Recommended)" }, { label: "IndexedDB" }],
};

/** 1. Kills the mutant that deletes `signal.removeEventListener`. */
describe("abort listener lifecycle", () => {
  it("registers exactly one abort listener and removes it again", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const channel: QuestionChannel = { ask: async () => [["a"]] };

    await createQuestionTool({ channel }).execute(context(controller.signal), {
      questions: [base],
    });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toBe("abort");
    // A turn can run dozens of tool calls; a listener per call leaks otherwise.
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[0]).toBe("abort");
  });

  it("removes the listener when the channel rejects too", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const channel: QuestionChannel = { ask: () => Promise.reject(new Error("nope")) };

    await expect(
      createQuestionTool({ channel }).execute(context(controller.signal), { questions: [base] }),
    ).rejects.toThrow(/nope/);

    expect(remove).toHaveBeenCalledTimes(1);
  });
});

/** 2. Kills the mutant that deletes `multiple` from the schema. */
describe("schema fields the model may rely on", () => {
  it("keeps `multiple` as a real, pass-through field", () => {
    const parsed = questionInputSchema.safeParse({
      questions: [{ ...base, multiple: true }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.questions[0]?.multiple).toBe(true);

    expect(questionInputSchema.safeParse({ questions: [{ ...base, multiple: false }] }).success).toBe(
      true,
    );
    expect(questionInputSchema.safeParse({ questions: [{ ...base, multiple: "yes" }] }).success).toBe(
      false,
    );
  });

  it("keeps `option.description` optional and trims it when present", () => {
    const without = questionInputSchema.safeParse({ questions: [base] });
    expect(without.success).toBe(true);
    if (without.success) {
      expect(without.data.questions[0]?.options[0]?.description).toBeUndefined();
    }

    const with_ = questionInputSchema.safeParse({
      questions: [
        { ...base, options: [{ label: "  a  ", description: "  why  " }, { label: "b" }] },
      ],
    });
    expect(with_.success).toBe(true);
    if (with_.success) {
      expect(with_.data.questions[0]?.options[0]).toEqual({ label: "a", description: "why" });
    }
  });
});

/** 3. Kills the mutants that delete the three text-length caps. */
describe("length caps are real, not just documented constants", () => {
  it("caps the question text at MAX_QUESTION_LENGTH", () => {
    expect(
      questionInputSchema.safeParse({ questions: [{ ...base, question: "x".repeat(MAX_QUESTION_LENGTH) }] })
        .success,
    ).toBe(true);
    expect(
      questionInputSchema.safeParse({
        questions: [{ ...base, question: "x".repeat(MAX_QUESTION_LENGTH + 1) }],
      }).success,
    ).toBe(false);
  });

  it("caps the option label and description", () => {
    const withLabel = (label: string) => ({ ...base, options: [{ label }, { label: "b" }] });
    expect(
      questionInputSchema.safeParse({ questions: [withLabel("x".repeat(MAX_OPTION_LABEL_LENGTH))] })
        .success,
    ).toBe(true);
    expect(
      questionInputSchema.safeParse({
        questions: [withLabel("x".repeat(MAX_OPTION_LABEL_LENGTH + 1))],
      }).success,
    ).toBe(false);

    const withDescription = (description: string) => ({
      ...base,
      options: [{ label: "a", description }, { label: "b" }],
    });
    expect(
      questionInputSchema.safeParse({
        questions: [withDescription("x".repeat(MAX_OPTION_DESCRIPTION_LENGTH))],
      }).success,
    ).toBe(true);
    expect(
      questionInputSchema.safeParse({
        questions: [withDescription("x".repeat(MAX_OPTION_DESCRIPTION_LENGTH + 1))],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty question text", () => {
    expect(questionInputSchema.safeParse({ questions: [{ ...base, question: "" }] }).success).toBe(false);
    expect(questionInputSchema.safeParse({ questions: [{ ...base, question: "   " }] }).success).toBe(
      false,
    );
  });
});

/** 4. Kills the mutant that re-wraps an already-actionable ToolError. */
describe("error passthrough", () => {
  it("does not bury a ToolError the channel raised on purpose", async () => {
    const channel: QuestionChannel = { ask: () => Promise.reject(new Error("user dismissed")) };
    await expect(
      createQuestionTool({ channel }).execute(context(live()), { questions: [base] }),
    ).rejects.toThrow(/user dismissed/);
  });

  it("preserves the identity of a ToolError from the channel", async () => {
    // A channel that already produced an actionable ToolError (a typed
    // "cancelled" error, say) must reach the engine unchanged — re-wrapping it
    // would flatten a tagged error into a plain one and lose the distinction.
    const raised = new ToolError("The user dismissed this question");
    const channel: QuestionChannel = { ask: () => Promise.reject(raised) };

    await expect(
      createQuestionTool({ channel }).execute(context(live()), { questions: [base] }),
    ).rejects.toBe(raised);
  });
});

/**
 * 5. Documents the trust boundary the README states but no test pins: `execute`
 *    does NOT re-parse its input. Every bound above lives in `inputSchema`
 *    alone, so it holds only if the engine parses before calling (README
 *    "Injektions-Vertrag" §4). This test is here so the boundary is visible in
 *    code, not only in prose.
 */
describe("execute trusts the engine to have parsed the input", () => {
  it("forwards input that the schema would have rejected", async () => {
    const ask = vi.fn<(questions: readonly unknown[]) => Promise<QuestionAnswers>>();
    ask.mockResolvedValue([["a"]]);
    const tool = createQuestionTool({ channel: { ask } });

    // None of this satisfies `questionInputSchema`: no header, empty question,
    // 30 options. Calling `execute` directly skips the engine's parse.
    await tool.execute(context(live()), {
      questions: [
        {
          question: "",
          options: Array.from({ length: 30 }, (_, i) => ({ label: `o${i}` })),
        },
      ] as never,
    });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).toHaveLength(1);
    expect(questionInputSchema.safeParse(ask.mock.calls[0]?.[0]).success).toBe(false);
  });
});

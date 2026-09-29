import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it, vi } from "vitest";

import {
  ABORTED_MESSAGE,
  createQuestionTool,
  MAX_HEADER_LENGTH,
  MAX_OPTIONS,
  MIN_OPTIONS,
  NO_CHANNEL_MESSAGE,
  questionInputSchema,
  questionTool,
  type Question,
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
  }
}

const single = {
  question: "Which storage engine should the app use?",
  header: "Storage",
  options: [
    { label: "SQLite WASM (Recommended)", description: "Fits the plan." },
    { label: "IndexedDB" },
  ],
};

function fixedChannel(answers: QuestionAnswers): QuestionChannel {
  return { ask: async () => answers };
}

describe("question tool", () => {
  it("is a read tool and matches the tool contract", () => {
    expect(questionTool.id).toBe("question");
    expect(questionTool.access).toBe("read");
  });

  it("forwards the questions and returns the answers", async () => {
    const ask = vi.fn<(questions: readonly Question[]) => Promise<QuestionAnswers>>();
    ask.mockResolvedValue([["SQLite WASM (Recommended)"]]);
    const tool = createQuestionTool({ channel: { ask } });

    const result = await tool.execute(context(new AbortController().signal), {
      questions: [single],
    });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).toEqual([single]);
    expect(result).toEqual({ answers: [["SQLite WASM (Recommended)"]] });
  });

  it("keeps the order and length of multiple questions", async () => {
    const ask = vi.fn<(questions: readonly Question[]) => Promise<QuestionAnswers>>();
    ask.mockResolvedValue([["a"], ["b", "c"], []]);
    const tool = createQuestionTool({ channel: { ask } });

    const result = await tool.execute(context(new AbortController().signal), {
      questions: [
        single,
        { ...single, question: "And a second one?", header: "Second", multiple: true },
        { ...single, question: "And a third?", header: "Third" },
      ],
    });

    expect(result.answers).toEqual([["a"], ["b", "c"], []]);
    expect(ask.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it("turns a rejecting channel into an actionable ToolError", async () => {
    const channel: QuestionChannel = {
      ask: () => Promise.reject(new Error("transcript panel is not mounted")),
    };
    const tool = createQuestionTool({ channel });

    await expect(
      tool.execute(context(new AbortController().signal), { questions: [single] }),
    ).rejects.toThrow(/transcript panel is not mounted/);
    await expect(
      tool.execute(context(new AbortController().signal), { questions: [single] }),
    ).rejects.toThrow(/do not call `question` again/);
  });

  it("fails loudly when no channel is wired up, instead of hanging", async () => {
    await expect(
      questionTool.execute(context(new AbortController().signal), { questions: [single] }),
    ).rejects.toThrow(NO_CHANNEL_MESSAGE);
  });

  it("rejects instead of hanging when the turn is aborted while waiting", async () => {
    const controller = new AbortController();
    // A channel that never answers, like a user who walks away.
    const channel: QuestionChannel = { ask: () => new Promise<QuestionAnswers>(() => {}) };
    const tool = createQuestionTool({ channel });

    const pending = tool.execute(context(controller.signal), { questions: [single] });
    controller.abort();

    await expect(pending).rejects.toThrow(ABORTED_MESSAGE);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const ask = vi.fn<(questions: readonly Question[]) => Promise<QuestionAnswers>>();
    ask.mockReturnValue(new Promise<QuestionAnswers>(() => {}));
    const tool = createQuestionTool({ channel: { ask } });

    await expect(
      tool.execute(context(controller.signal), { questions: [single] }),
    ).rejects.toThrow(/aborted/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("detaches the abort listener once the answer arrives", async () => {
    const controller = new AbortController();
    const tool = createQuestionTool({ channel: fixedChannel([["a"]]) });

    const result = await tool.execute(context(controller.signal), { questions: [single] });

    expect(result.answers).toEqual([["a"]]);
    // Aborting after the fact must not resurrect a settled rejection.
    controller.abort();
    await expect(Promise.resolve(result)).resolves.toEqual({ answers: [["a"]] });
  });

  it("rejects an answer payload that does not match the questions", async () => {
    const tooFew = createQuestionTool({ channel: fixedChannel([["a"]]) });
    await expect(
      tooFew.execute(context(new AbortController().signal), {
        questions: [single, { ...single, header: "Second" }],
      }),
    ).rejects.toThrow(/1 answer\(s\) for 2 question\(s\)/);

    const tooMany = createQuestionTool({ channel: fixedChannel([["a"], ["b"], ["c"]]) });
    await expect(
      tooMany.execute(context(new AbortController().signal), { questions: [single] }),
    ).rejects.toThrow(/3 answer\(s\) for 1 question\(s\)/);
  });

  it("rejects a channel that answers in the wrong shape", async () => {
    const channel = {
      ask: () => Promise.resolve("a" as unknown as QuestionAnswers),
    };
    const tool = createQuestionTool({ channel });

    await expect(
      tool.execute(context(new AbortController().signal), { questions: [single] }),
    ).rejects.toThrow(/unexpected shape/);
  });

  it("rejects a header over the convention limit in the schema", () => {
    const long = "x".repeat(MAX_HEADER_LENGTH + 1);
    expect(questionInputSchema.safeParse({ questions: [{ ...single, header: long }] }).success).toBe(
      false,
    );
    expect(
      questionInputSchema.safeParse({ questions: [{ ...single, header: "" }] }).success,
    ).toBe(false);
    // Exactly at the limit is still fine.
    expect(
      questionInputSchema.safeParse({
        questions: [{ ...single, header: "x".repeat(MAX_HEADER_LENGTH) }],
      }).success,
    ).toBe(true);
  });

  it("enforces the option-count bounds in the schema", () => {
    const option = (n: number) => ({ label: `o${n}` });
    const withOptions = (count: number) => ({
      question: single.question,
      header: single.header,
      options: Array.from({ length: count }, (_, index) => option(index)),
    });

    expect(questionInputSchema.safeParse({ questions: [withOptions(MIN_OPTIONS - 1)] }).success).toBe(
      false,
    );
    expect(questionInputSchema.safeParse({ questions: [withOptions(MIN_OPTIONS)] }).success).toBe(true);
    expect(questionInputSchema.safeParse({ questions: [withOptions(MAX_OPTIONS)] }).success).toBe(true);
    expect(questionInputSchema.safeParse({ questions: [withOptions(MAX_OPTIONS + 1)] }).success).toBe(
      false,
    );
    expect(questionInputSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(
      questionInputSchema.safeParse({
        questions: Array.from({ length: 11 }, () => single),
      }).success,
    ).toBe(false);
  });

  it("documents the free-text and (Recommended) conventions for the model", () => {
    expect(questionTool.description).toContain("free-text");
    expect(questionTool.description).toContain("(Recommended)");
    expect(questionTool.description).toContain("Do not add a free-text option");
    expect(questionTool.description).toContain(`${MAX_HEADER_LENGTH} characters`);
    expect(single.options[0]?.label).toContain("(Recommended)");
  });
});

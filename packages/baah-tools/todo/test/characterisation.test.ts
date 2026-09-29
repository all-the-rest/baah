/**
 * Characterisation tests written by the verify agent. Each one pins down a
 * promise the README/source comments make but that `todo.test.ts` does not
 * actually check. They all pass on the current source; several fail once the
 * specific guard they cover is deleted (see the verify report).
 */
import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import {
  createMemoryTodoStore,
  createTodoTool,
  MAX_CONTENT_LENGTH,
  todoInputSchema,
  type TodoInputItem,
  type TodoItem,
  type TodoStore,
} from "../src/index.ts";

function context(): ToolContext {
  return {
    workspace: createMemoryWorkspace(),
    cwd: ".",
    signal: new AbortController().signal,
    approve: async () => "allow-once",
    emit: () => {},
    toolCallId: "call-1",
    attempt: 1,
  };
}

const item = (overrides: Partial<TodoInputItem> = {}): TodoInputItem => ({
  content: "Task",
  status: "pending",
  ...overrides,
});

/** 1. Kills the mutant that deletes the 200-character cap on `content`. */
describe("content length cap", () => {
  it("accepts exactly MAX_CONTENT_LENGTH and rejects one more", () => {
    const at = (content: string) => todoInputSchema.safeParse({ todos: [{ content, status: "pending" }] });

    expect(at("x".repeat(MAX_CONTENT_LENGTH)).success).toBe(true);
    expect(at("x".repeat(MAX_CONTENT_LENGTH + 1)).success).toBe(false);
  });
});

/** 2. Kills the mutant where `get()` hands out the live internal array. */
describe("the store hands out copies, not its own state", () => {
  it("get() returns a copy: mutating the result cannot corrupt the store", async () => {
    const store = createMemoryTodoStore();
    const tool = createTodoTool({ store, sessionId: "s1" });
    await tool.execute(context(), { todos: [item()] });

    const first = await store.get("s1");
    (first[0] as TodoItem).content = "MUTATED THROUGH get()";

    expect((await store.get("s1"))[0]?.content).toBe("Task");
  });

  it("get() does not leak a mutable array between callers", async () => {
    const store = createMemoryTodoStore();
    const tool = createTodoTool({ store, sessionId: "s1" });
    await tool.execute(context(), { todos: [item()] });

    const a = await store.get("s1");
    const b = await store.get("s1");
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });
});

/**
 * 3. Kills the mutant that drops the `await` on `store.set`. The Wave-2 store
 *    is async (README: DB-backed store answers over the worker), so `execute`
 *    must not resolve before the write has landed.
 */
describe("execute waits for an async store write", () => {
  it("resolves only after a slow set() has committed", async () => {
    let committed = false;
    const slowStore: TodoStore = {
      get: () => [],
      set: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            committed = true;
            resolve();
          }, 5);
        }),
    };

    const result = await createTodoTool({ store: slowStore, sessionId: "s1" }).execute(context(), {
      todos: [item()],
    });

    expect(committed).toBe(true);
    expect(result.changed).toBe(true);
  });

  it("propagates a failing store.set instead of reporting success", async () => {
    const failingStore: TodoStore = {
      get: () => [],
      set: () => Promise.reject(new Error("sqlite is locked")),
    };

    await expect(
      createTodoTool({ store: failingStore, sessionId: "s1" }).execute(context(), {
        todos: [item()],
      }),
    ).rejects.toThrow(/sqlite is locked/);
  });
});

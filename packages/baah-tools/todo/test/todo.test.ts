import { createMemoryWorkspace, type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it, vi } from "vitest";

import {
  createMemoryTodoStore,
  createTodoTool,
  DEFAULT_PRIORITY,
  defaultTodoStore,
  MAX_TODOS,
  todoInputSchema,
  todoTool,
  type TodoItem,
  type TodoStore,
} from "../src/index.ts";

function context(signal?: AbortSignal): ToolContext {
  return {
    workspace: createMemoryWorkspace(),
    cwd: ".",
    signal: signal ?? new AbortController().signal,
    approve: async () => "allow-once",
    emit: () => {},
    toolCallId: "call-1",
    attempt: 1,
  };
}

const ctx = context();

function item(overrides: Partial<TodoItem> = {}): TodoItem {
  return { content: "Task", status: "pending", priority: "medium", ...overrides };
}

describe("todo tool", () => {
  it("is a write tool and matches the tool contract", () => {
    expect(todoTool.id).toBe("todo");
    expect(todoTool.access).toBe("write");
  });

  it("stores the list and reports the resulting state", async () => {
    const store = createMemoryTodoStore();
    const tool = createTodoTool({ store, sessionId: "s1" });

    const result = await tool.execute(ctx, {
      todos: [
        { content: "Read the spec", status: "completed", priority: "high" },
        { content: "Write the code", status: "in_progress" },
      ],
    });

    expect(result).toEqual({
      todos: [
        { content: "Read the spec", status: "completed", priority: "high" },
        { content: "Write the code", status: "in_progress", priority: "medium" },
      ],
      changed: true,
      completedCount: 1,
    });
    expect(await store.get("s1")).toEqual(result.todos);
  });

  it("replaces the whole list instead of merging", async () => {
    const store = createMemoryTodoStore();
    const tool = createTodoTool({ store });

    await tool.execute(ctx, {
      todos: [
        { content: "one", status: "pending" },
        { content: "two", status: "pending" },
        { content: "three", status: "pending" },
      ],
    });

    const second = await tool.execute(ctx, {
      todos: [
        { content: "two", status: "completed" },
        { content: "four", status: "in_progress" },
      ],
    });

    // "one" and "three" were dropped by the model, so they are gone.
    expect(second.todos.map((todo) => todo.content)).toEqual(["two", "four"]);
    expect(second.completedCount).toBe(1);
    expect(await store.get("default")).toEqual(second.todos);
  });

  it("detects whether anything changed", async () => {
    const store = createMemoryTodoStore();
    const tool = createTodoTool({ store });
    const list = [{ content: "one", status: "pending" as const }];

    expect((await tool.execute(ctx, { todos: list })).changed).toBe(true);
    // Same content, but the model spelled out the default priority explicitly.
    expect(
      (
        await tool.execute(ctx, {
          todos: [{ content: "one", status: "pending", priority: DEFAULT_PRIORITY }],
        })
      ).changed,
    ).toBe(false);
    expect(
      (await tool.execute(ctx, { todos: [{ content: "one", status: "completed" }] })).changed,
    ).toBe(true);
    expect(
      (
        await tool.execute(ctx, {
          todos: [
            { content: "one", status: "completed" },
            { content: "two", status: "pending" },
          ],
        })
      ).changed,
    ).toBe(true);
  });

  it("rejects two in_progress items and names both", async () => {
    const store = createMemoryTodoStore();
    const tool = createTodoTool({ store });

    await expect(
      tool.execute(ctx, {
        todos: [
          { content: "alpha", status: "in_progress" },
          { content: "beta", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow(/at most one todo may be in_progress.*"alpha", "beta"/i);

    // Rejected means rejected: the store still holds the old list.
    expect(await store.get("default")).toEqual([]);
  });

  it("defaults the priority and trims the content", async () => {
    const tool = createTodoTool({ store: createMemoryTodoStore() });

    const result = await tool.execute(ctx, {
      todos: [{ content: "  spaced out  ", status: "pending" }],
    });

    expect(result.todos[0]).toEqual({
      content: "spaced out",
      status: "pending",
      priority: DEFAULT_PRIORITY,
    });
  });

  it("rejects empty content in the schema", () => {
    expect(todoInputSchema.safeParse({ todos: [{ content: "", status: "pending" }] }).success).toBe(
      false,
    );
    expect(
      todoInputSchema.safeParse({ todos: [{ content: "   ", status: "pending" }] }).success,
    ).toBe(false);
    expect(
      todoInputSchema.safeParse({ todos: [{ content: "x", status: "unknown" }] }).success,
    ).toBe(false);
    expect(todoInputSchema.safeParse({ todos: [] }).success).toBe(false);
    expect(
      todoInputSchema.safeParse({
        todos: Array.from({ length: MAX_TODOS + 1 }, () => ({
          content: "x",
          status: "pending",
        })),
      }).success,
    ).toBe(false);
  });

  it("keeps sessions apart in a shared store", async () => {
    const store = createMemoryTodoStore();
    const a = createTodoTool({ store, sessionId: "a" });
    const b = createTodoTool({ store, sessionId: "b" });

    await a.execute(ctx, { todos: [{ content: "a task", status: "pending" }] });
    await b.execute(ctx, { todos: [{ content: "b task", status: "pending" }] });

    expect((await store.get("a")).map((todo) => todo.content)).toEqual(["a task"]);
    expect((await store.get("b")).map((todo) => todo.content)).toEqual(["b task"]);
    expect((await store.get("c")).map((todo) => todo.content)).toEqual([]);
  });

  it("notifies onChange only when the list really changed", async () => {
    const onChange = vi.fn<(sessionId: string, todos: readonly TodoItem[]) => void>();
    const tool = createTodoTool({
      store: createMemoryTodoStore({ onChange }),
      sessionId: "s1",
    });

    await tool.execute(ctx, { todos: [{ content: "one", status: "pending" }] });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toBe("s1");

    await tool.execute(ctx, { todos: [{ content: "one", status: "pending" }] });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a throwing onChange (AGENTS.md §5: no silent catches)", async () => {
    // The README promises the throwing callback surfaces as a tool failure so
    // the bug stays visible. A `try/catch` around the notification would turn a
    // broken sidebar into a silent success, and nothing else in the suite
    // would notice.
    const store = createMemoryTodoStore({
      onChange: () => {
        throw new Error("sidebar is not mounted");
      },
    });
    const tool = createTodoTool({ store, sessionId: "s1" });

    await expect(
      tool.execute(ctx, { todos: [{ content: "one", status: "pending" }] }),
    ).rejects.toThrow(/sidebar is not mounted/);
  });

  it("hands a private copy to the store and to onChange", async () => {
    const seen: TodoItem[][] = [];
    const store = createMemoryTodoStore({
      onChange: (_sessionId, todos) => seen.push([...todos]),
    });
    const tool = createTodoTool({ store });

    const result = await tool.execute(ctx, { todos: [item()] });
    (result.todos[0] as TodoItem).content = "mutated after the call";
    const firstSeen = seen[0]?.[0];
    if (firstSeen !== undefined) firstSeen.content = "mutated too";

    const stored = await store.get("default");
    expect(stored[0]?.content).toBe("Task");
  });

  it("reports a stable result shape", async () => {
    const tool = createTodoTool({ store: createMemoryTodoStore() });

    const result = await tool.execute(ctx, { todos: [item({ status: "completed" })] });

    expect(Object.keys(result).sort()).toEqual(["changed", "completedCount", "todos"]);
    expect(result.completedCount).toBe(1);
  });

  it("emits a progress log on change only", async () => {
    const events: string[] = [];
    const tool = createTodoTool({ store: createMemoryTodoStore() });
    const withEmit: ToolContext = { ...ctx, emit: (event) => events.push(event.message) };

    await tool.execute(withEmit, { todos: [item(), item({ status: "completed" })] });
    await tool.execute(withEmit, { todos: [item(), item({ status: "completed" })] });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/2 item\(s\), 1 completed, 1 open/);
  });

  it("works with an async, DB-shaped store", async () => {
    const calls: string[] = [];
    const backing = new Map<string, readonly TodoItem[]>();
    const asyncStore: TodoStore = {
      get: async (sessionId) => {
        calls.push(`get:${sessionId}`);
        return backing.get(sessionId) ?? [];
      },
      set: async (sessionId, todos) => {
        calls.push(`set:${sessionId}`);
        backing.set(sessionId, todos);
      },
    };
    const tool = createTodoTool({ store: asyncStore, sessionId: "s1" });

    const first = await tool.execute(ctx, { todos: [item()] });
    const second = await tool.execute(ctx, { todos: [item()] });

    expect(calls).toEqual(["get:s1", "set:s1", "get:s1"]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  it("ships a working default instance backed by its own store", async () => {
    const result = await todoTool.execute(ctx, {
      todos: [{ content: "default instance", status: "in_progress", priority: "high" }],
    });

    expect(result.changed).toBe(true);
    expect((await defaultTodoStore.get("default")).map((todo) => todo.content)).toEqual([
      "default instance",
    ]);
    // The second call is a no-op, so the demo store does not grow.
    const again = await todoTool.execute(ctx, { todos: [...result.todos] });
    expect(again.changed).toBe(false);
    expect(await defaultTodoStore.get("default")).toHaveLength(1);
  });

  it("falls back to the default session key", async () => {
    const store = createMemoryTodoStore();
    const tool = createTodoTool({ store });
    const another = createTodoTool({ store });

    await tool.execute(ctx, { todos: [item()] });
    await another.execute(ctx, { todos: [item({ content: "second" })] });

    expect((await store.get("default")).map((todo) => todo.content)).toEqual(["second"]);
  });
});

/**
 * @all-the.rest/baah-tool-todo — the task list the agent keeps for the user.
 *
 * The list outlives a single `execute` call, so the tool itself is stateless:
 * the engine hands in a session-scoped `TodoStore` and the store owns the
 * state. The tool never touches a database, the DOM or IndexedDB — it only
 * talks to that store (see README.md for the Wave 2 contract).
 */

import { defineTool, ToolError, type ToolDefinition } from "@all-the.rest/baah-core";
import { z } from "zod";

/** Hard cap on one call. A runaway model must not be able to fill the sidebar. */
export const MAX_TODOS = 100;
/** Hard cap on a single item's text. */
export const MAX_CONTENT_LENGTH = 200;
/** Priority applied when the model omits the field. Neutral middle, like most tasks. */
export const DEFAULT_PRIORITY = "medium";
/** Store key used when no `sessionId` is bound at construction time. */
export const DEFAULT_SESSION_ID = "default";

const todoItemSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CONTENT_LENGTH)
    .describe("Imperative one-liner describing the task, e.g. `Wire up the storage layer`."),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .describe("`pending` = queued, `in_progress` = being worked on right now, `completed` = done."),
  priority: z
    .enum(["low", "medium", "high"])
    .default(DEFAULT_PRIORITY)
    .describe(`Relative importance. Defaults to \`${DEFAULT_PRIORITY}\`.`),
});

/** One list item as the model sends it: `priority` may be omitted. */
export type TodoInputItem = z.input<typeof todoItemSchema>;

/** One list item after normalisation: trimmed, with a resolved priority. */
export type TodoItem = z.output<typeof todoItemSchema>;

export const todoInputSchema = z.object({
  todos: z
    .array(todoItemSchema)
    .min(1)
    .max(MAX_TODOS)
    .describe(
      "The COMPLETE list, on every call. This replaces the stored list — items you " +
        "leave out are deleted, so never send a partial patch.",
    ),
});

/**
 * `z.input`, not `z.infer`: the model may leave `priority` out, and the
 * `default` in the schema is what fills it. `execute` is typed against the
 * input so the signature tells the truth about what the model produces.
 */
export type TodoInput = z.input<typeof todoInputSchema>;

export interface TodoOutput {
  /** The list as stored after this call. */
  todos: readonly TodoItem[];
  /** `false` when the call was a no-op (the stored list already looked like this). */
  changed: boolean;
  /** How many items ended up `completed`. */
  completedCount: number;
}

/** A store may answer immediately (memory) or later (worker/DB round trip). */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Session-scoped list storage. The engine owns the implementation: the
 * in-memory one below for tests and a single-session demo, a DB-backed one
 * (table `todos`) for the real app.
 */
export interface TodoStore {
  /** The stored list; an empty list when nothing was stored for the session yet. */
  get(sessionId: string): MaybePromise<readonly TodoItem[]>;
  /**
   * Replaces the whole list — never a merge. The tool hands over ownership of
   * `todos` and does not mutate it afterwards, so an implementation may keep
   * the array.
   */
  set(sessionId: string, todos: readonly TodoItem[]): MaybePromise<void>;
}

export interface MemoryTodoStoreOptions {
  /**
   * Called after every successful `set`, with a private copy of the new list.
   * The UI subscribes here to re-render the sidebar. A throwing callback is
   * *not* swallowed: it surfaces as a tool failure so the bug stays visible
   * (AGENTS.md §5, no silent catches).
   */
  onChange?: (sessionId: string, todos: readonly TodoItem[]) => void;
}

function copy(todo: TodoItem): TodoItem {
  return { content: todo.content, status: todo.status, priority: todo.priority };
}

/** In-memory `TodoStore`, keyed by session id. Node-free and synchronous. */
export function createMemoryTodoStore(options: MemoryTodoStoreOptions = {}): TodoStore {
  const lists = new Map<string, readonly TodoItem[]>();

  return {
    get(sessionId) {
      const stored = lists.get(sessionId);
      return stored === undefined ? [] : stored.map(copy);
    },
    set(sessionId, todos) {
      const snapshot = todos.map(copy);
      lists.set(sessionId, snapshot);
      options.onChange?.(sessionId, snapshot.map(copy));
    },
  };
}

export interface TodoToolOptions {
  /** Where the list lives. The tool keeps no state of its own. */
  store: TodoStore;
  /**
   * Key handed to the store. The engine creates one tool instance per session
   * and binds the id here. Defaults to `"default"` so a bare
   * `createTodoTool({ store })` works — always pass it in the app.
   */
  sessionId?: string;
}

function assertSingleInProgress(todos: readonly TodoInputItem[]): void {
  const active = todos.filter((todo) => todo.status === "in_progress");
  if (active.length <= 1) return;
  const names = active.map((todo) => `"${todo.content}"`).join(", ");
  throw new ToolError(
    `At most one todo may be in_progress, but ${active.length} are: ${names}. ` +
      "Mark all but one as pending or completed, then call the tool again.",
  );
}

function isSameList(previous: readonly TodoItem[], next: readonly TodoItem[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((todo, index) => {
    const other = next[index];
    return (
      other !== undefined &&
      todo.content === other.content &&
      todo.status === other.status &&
      todo.priority === other.priority
    );
  });
}

function countCompleted(todos: readonly TodoItem[]): number {
  return todos.reduce((total, todo) => (todo.status === "completed" ? total + 1 : total), 0);
}

function summarize(todos: readonly TodoItem[]): string {
  const completed = countCompleted(todos);
  const open = todos.length - completed;
  return `Todo list updated: ${todos.length} item(s), ${completed} completed, ${open} open.`;
}

/**
 * Builds the tool. One instance per session: the store may hold many sessions,
 * the `sessionId` here selects the one this tool instance owns.
 */
export function createTodoTool(options: TodoToolOptions): ToolDefinition<TodoInput, TodoOutput> {
  const { store } = options;
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;

  return defineTool<TodoInput, TodoOutput>({
    id: "todo",
    description:
      "Create or update the task list for the current session. Send the COMPLETE list " +
      "on every call: the stored list is replaced, not merged, and any item you leave " +
      "out is deleted. Each item needs a one-line `content` and a `status` " +
      "(`pending` / `in_progress` / `completed`); `priority` is optional. At most one " +
      "item may be `in_progress` — keep exactly one while you work, none when you are " +
      "done or when the plan changes. Returns the stored list, whether anything " +
      "changed, and how many items are completed.",
    access: "write",
    inputSchema: todoInputSchema,
    async execute(context, input) {
      assertSingleInProgress(input.todos);

      // Normalise here instead of trusting the caller: the priority default and
      // the trim live in the schema, but the type of `input` is the raw one.
      const todos: readonly TodoItem[] = input.todos.map((todo) => ({
        content: todo.content.trim(),
        status: todo.status,
        priority: todo.priority ?? DEFAULT_PRIORITY,
      }));

      const previous = await store.get(sessionId);
      const changed = !isSameList(previous, todos);

      // No-op calls skip the write: the stored list already is the truth, and
      // `onChange` stays a real "something moved" signal for the UI.
      if (changed) {
        await store.set(sessionId, todos);
        context.emit({ type: "log", message: summarize(todos) });
      }

      return { todos, changed, completedCount: countCompleted(todos) };
    },
  });
}

/** Backing store of the ready-to-use default instance below. */
export const defaultTodoStore = createMemoryTodoStore();

/**
 * Ready-to-use instance for tests and single-session demos. Its state is
 * module-global — the engine must call `createTodoTool({ store, sessionId })`
 * with its own store.
 */
export const todoTool = createTodoTool({
  store: defaultTodoStore,
  sessionId: DEFAULT_SESSION_ID,
});

export default todoTool;

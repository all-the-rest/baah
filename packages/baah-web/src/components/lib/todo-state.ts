/**
 * The todo list's state, and the seam the tool writes through.
 *
 * ## Why the app owns the list and the tool does not
 *
 * `TodoStore` is `Plan.md` §16.2's injection contract: `get` / `set`, and `set` is
 * a **full replacement**, never a merge. The tool is stateless by design — a
 * tool that kept the list would have to be re-created per session or two sessions
 * would share one.
 *
 * So the app holds the state and hands the tool a store bound to one session. Two
 * things then live here that do **not** go into the tool's list:
 *
 * 1. **The user's own confirmations.** The list is the model's to write (§16.2:
 *   "The COMPLETE list, on every call. This replaces the stored list"). If the UI
 *   wrote a confirmation into it, the model's next call would delete it — and a
 *   user who ticked a box and watched it vanish would be right to distrust the
 *   sidebar. So the confirmation lives beside the list, keyed by content, and the
 *   list is never edited by the UI.
 * 2. **The provenance rule.** `completed` from the tool is *reported*, never
 *   *confirmed*; see `todo.ts` for why that is the honest direction.
 */
import { createObservable, type Observable } from "../../lib/observable.ts";
import { confirmRow, todoRows, unconfirmRow, type TodoRow, type UserConfirmations } from "./todo.ts";

/** The item shape the tool's schema produces after normalisation. */
export interface StoredTodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly priority: "low" | "medium" | "high";
}

export interface TodoSnapshot {
  readonly rows: readonly TodoRow[];
  /** Items the store returned that did not parse. Surfaced, never hidden. */
  readonly dropped: number;
}

export interface TodoState {
  /** For a component: subscribe, read. */
  subscribe(listener: () => void): () => void;
  get(): TodoSnapshot;
  /** The user's own confirmation, and what it does to the row. */
  confirm(content: string, at: string): void;
  /** Undo a confirmation. The user may change their mind. */
  unconfirm(content: string): void;
  /** The `TodoStore` the tool is built with, bound to one session. */
  toolStore(sessionId: string): {
    get(sessionId: string): readonly StoredTodoItem[];
    set(sessionId: string, todos: readonly StoredTodoItem[]): void;
  };
}

/**
 * The todo state.
 *
 * Kept outside React because the tool calls `set` from inside a turn's tool
 * execution, and the promise it returns has to resolve to a list the sidebar then
 * renders. A `useState` would be a component's business, and the tool would have
 * to know a component exists — which `AGENTS.md` §4 forbids ("Ein Tool greift nie
 * direkt auf IndexedDB oder UI zu, nur über den `ToolContext`").
 */
export function createTodoState(): TodoState {
  const lists = new Map<string, readonly StoredTodoItem[]>();
  const confirmations: Observable<UserConfirmations> = createObservable<Record<string, string>>({});
  const revision: Observable<number> = createObservable(0);

  const publish = (): void => {
    revision.set(revision.get() + 1);
  };

  return {
    subscribe(listener) {
      // Both are subscribed: a confirmation changes the *rendering* of a row
      // without changing the tool's list, so a subscriber that only watched the
      // list would not re-render a ticked row.
      const offConfirmations = confirmations.subscribe(publish);
      const offRevision = revision.subscribe(() => listener());
      return () => {
        offConfirmations();
        offRevision();
      };
    },

    get() {
      const items = [...lists.values()].flat();
      return todoRows({ items, confirmations: confirmations.get() });
    },

    confirm(content, at) {
      confirmations.set(confirmRow(confirmations.get(), content, at));
    },

    unconfirm(content) {
      confirmations.set(unconfirmRow(confirmations.get(), content));
    },

    toolStore(boundSessionId) {
      return {
        get(sessionId) {
          // Scoped by the id the caller passes, and it must be the **bound** one.
          // The tool's own contract (`packages/baah-tools/todo`) says the session
          // id "MUSS gesetzt sein — sonst fällt der Key auf 'default' und alle
          // Sessions teilen sich eine Liste". Ignoring the argument would be a
          // quieter version of the same bug: two sessions, two lists in the map,
          // and whichever the caller named wins.
          if (sessionId !== boundSessionId) return [];
          return lists.get(sessionId) ?? [];
        },
        set(sessionId, todos) {
          if (sessionId !== boundSessionId) return;
          const previous = lists.get(sessionId);
          lists.set(sessionId, todos.map((todo) => ({ ...todo })));
          // `publish` only when something moved. The tool skips a no-op write
          // itself, so a re-render on an unchanged list would be a re-render on
          // every call — and the sidebar is the one view a user watches while
          // waiting.
          if (!sameList(previous, todos)) publish();
        },
      };
    },
  };
}

function sameList(before: readonly StoredTodoItem[] | undefined, after: readonly StoredTodoItem[]): boolean {
  if (before === undefined) return false;
  if (before.length !== after.length) return false;
  return before.every((todo, index) => {
    const other = after[index];
    return (
      other !== undefined &&
      todo.content === other.content &&
      todo.status === other.status &&
      todo.priority === other.priority
    );
  });
}

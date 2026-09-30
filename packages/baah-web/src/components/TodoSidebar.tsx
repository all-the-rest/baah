/**
 * The todo sidebar, and the one place this UI would rather understate than
 * overstate.
 *
 * ## Why a task list is a trust boundary
 *
 * `TodoStore.set` is a **full replacement** of a list whose `content` strings came
 * out of the model — and the model puts there whatever it read, including a line
 * from a `README.md`. Nothing on a row records the origin, and `TodoStore` is the
 * tool's own contract (`Plan.md` §16.2), so this block cannot add provenance to
 * it.
 *
 * Two things follow, and they are the reason this component is careful:
 *
 * 1. **`completed` is the most trusted-*looking* thing in the whole app.** It reads
 *    as work the agent already did. A tick icon and a strikethrough on a
 *    tool-authored row would state as fact something nobody verified. So a
 *    tool-authored `completed` gets: a plain marker, the words
 *    „vom Agenten behauptet — nicht geprüft", and **no** checkbox the user could
 *    mistake for a confirmation of theirs.
 * 2. **The list round-trips back into the next turn's model context.** So a row is
 *    also an injection surface, and the sidebar labels the whole list as
 *    tool-authored rather than as the agent's own plan.
 *
 * ## The user can confirm a row, and that is the only thing that does
 *
 * Ticking a box records the user's own confirmation **beside** the list, keyed by
 * content. It does not write the list: the list is the model's to write
 * (`Plan.md` §16.2 — "The COMPLETE list, on every call. This replaces the stored
 * list"), and a UI that wrote it would be a second writer of a list the model is
 * told it owns. So a confirmation survives a model overwrite, and the claim column
 * follows it.
 */
import { useEffect, useState } from "react";

import { claimLabel, statusLabel, type TodoRow } from "./lib/todo.ts";
import type { TodoState } from "./lib/todo-state.ts";
import { TODO_UNTRUSTED_NOTE, PROVENANCE_ATTRIBUTE } from "./lib/trust.ts";

export interface TodoSidebarProps {
  readonly todos: TodoState;
}

/** The list. Renders an explicit "empty" rather than nothing. */
export function TodoSidebar({ todos }: TodoSidebarProps) {
  const [snapshot, setSnapshot] = useState(() => todos.get());

  useEffect(() => {
    setSnapshot(todos.get());
    return todos.subscribe(() => setSnapshot(todos.get()));
  }, [todos]);

  return (
    <aside aria-label="Aufgaben" className="flex w-64 shrink-0 flex-col border-l border-base-300 p-3">
      <h2 className="text-sm font-semibold">Aufgaben</h2>

      {/*
       * The provenance note is above the list, always — not only when a row looks
       * suspicious. There is no per-row signal to condition on: origin is not
       * recorded, so the only honest statement is the general one.
       */}
      <p {...{ [PROVENANCE_ATTRIBUTE]: "untrusted" }} className="mt-1 rounded-field border border-base-300 px-2 py-1 text-xs opacity-80">
        {TODO_UNTRUSTED_NOTE}
      </p>

      {snapshot.dropped > 0 && (
        <p data-baah-todo-dropped={snapshot.dropped} className="mt-2 text-xs text-warning">
          {snapshot.dropped} Eintrag/Einträge waren nicht lesbar und werden nicht angezeigt.
        </p>
      )}

      {snapshot.rows.length === 0 ? (
        <p data-baah-todo="empty" className="mt-2 text-xs opacity-60">
          Keine Aufgaben. Der Agent legt sie an, wenn er einen Plan hat.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {snapshot.rows.map((row) => (
            <TodoItem key={row.content} row={row} onConfirm={todos.confirm} onUnconfirm={todos.unconfirm} />
          ))}
        </ul>
      )}
    </aside>
  );
}

function TodoItem({
  row,
  onConfirm,
  onUnconfirm,
}: {
  row: TodoRow;
  onConfirm: (content: string, at: string) => void;
  onUnconfirm: (content: string) => void;
}) {
  const claim = claimLabel(row);
  const confirmed = row.claim === "user-confirmed";

  return (
    <li data-baah-todo-status={row.status} data-baah-todo-claim={row.claim} className="rounded-field border border-base-300/70 px-2 py-1">
      <div className="flex items-start gap-2">
        {/*
         * The control exists for **every** row, so the user's own confirmation is
         * always one click away — and it is *not* pre-ticked for a tool-authored
         * `completed` row, because that would draw a checkmark the user never put
         * there. That inversion is the whole point: a checkmark means "the user
         * checked this", and only the user's own click may draw one.
         */}
        <input
          type="checkbox"
          checked={confirmed}
          data-baah-todo-confirm={row.content}
          aria-label={`${statusLabel(row)}: ${row.content} — als geprüft bestätigen`}
          onChange={() => (confirmed ? onUnconfirm(row.content) : onConfirm(row.content, new Date().toISOString()))}
          className="checkbox checkbox-sm mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm break-words ${row.status === "completed" && !confirmed ? "opacity-90" : ""}`}
          >
            {row.content}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs opacity-70">
            <span data-baah-todo-status-label={row.status}>{statusLabel(row)}</span>
            {row.priority !== "medium" && <span>· {row.priority}</span>}
            {row.claim === "user-confirmed" && <span data-baah-todo-confirmed="true">· bestätigt</span>}
          </div>
          {/*
           * The claim, in words, on every `completed` row. Not a tooltip and not a
           * colour: the sentence is the only thing that stops a reader from
           * concluding the work was verified.
           */}
          {claim !== undefined && (
            <p data-baah-todo-claim-label={row.claim} className="mt-0.5 text-xs text-warning">
              {claim}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The todo sidebar, and the provenance rule it exists to enforce.
 *
 * ## Why this is a module rather than a component
 *
 * Because the decision in it is dangerous and needs a test that does not need a
 * browser: **what a `completed` row is allowed to claim.** Everything else about
 * a task list is styling.
 */
import { z } from "zod";

/** The three statuses the tool's schema allows (`packages/baah-tools/todo`). */
export type TodoStatus = "pending" | "in_progress" | "completed";

/**
 * What a `completed` row may be read as.
 *
 * `TodoStore.set` is a **full replacement** of a list whose `content` strings
 * came out of the model — and the model puts there whatever it read, including a
 * `README.md` line. Nothing on the row records the origin, and `TodoStore` is the
 * tool's own contract (`Plan.md` §16.2), so this block cannot add provenance to
 * it.
 *
 * `completed` is the most trusted-*looking* thing in the whole UI: it reads as
 * work the agent already did, and a user who reads it that way does not check.
 * The list also round-trips back into the next turn's model context. So:
 *
 * - a tool-authored `completed` is `agent-reported` — shown as *the agent's
 *   claim*, never with a tick or a strikethrough that implies verification;
 * - a row the **user** ticked is `user-confirmed` and is a fact, because the user
 *   is the one who checked it;
 * - everything else is `unverified`, which is the honest default when origin
 *   cannot be established.
 *
 * The costs are asymmetric: overstating tells the user work happened that may not
 * have, and that belief is not recoverable by anything later in the session.
 * Understating costs one sentence — which is why this module understates.
 */
export type TodoCompletionClaim = "agent-reported" | "user-confirmed" | "unverified";

/** One row of the sidebar, as the UI needs it. */
export interface TodoRow {
  readonly content: string;
  readonly status: TodoStatus;
  readonly priority: "low" | "medium" | "high";
  /** `false` when the model left the field out and the schema's default filled it. */
  readonly priorityFromModel: boolean;
  /** How this row's completion may be read. See {@link TodoCompletionClaim}. */
  readonly claim: TodoCompletionClaim;
  /** ISO timestamp of the user's own confirmation; `undefined` otherwise. */
  readonly confirmedByUserAt: string | undefined;
}

/* ------------------------------------------------------------------ */
/* Parsing the store's answer                                          */
/* ------------------------------------------------------------------ */

const prioritySchema = z.enum(["low", "medium", "high"]);
const statusSchema = z.enum(["pending", "in_progress", "completed"]);

/**
 * One stored item, parsed rather than cast.
 *
 * `AGENTS.md` §5: the store is an injected seam and everything crossing it is
 * zod-parsed. A row that fails the parse is **dropped, not rendered**: a
 * half-parsed task item with `status: "completed"` is exactly the row this
 * module exists to distrust, and rendering it would defeat the point.
 */
const storedItemSchema = z.object({
  content: z.string(),
  status: statusSchema,
  priority: prioritySchema,
});

/** What the user ticked, and when. Keyed by content — see {@link todoKey}. */
export type UserConfirmations = Readonly<Record<string, string>>;

/**
 * The identity of a row.
 *
 * `content` and not the index: the tool replaces the whole list on every call
 * (`Plan.md` §16.2), so an index means something different after every write. The
 * text is the only thing that survives, and it is also the only thing worth
 * matching a confirmation against.
 */
export function todoKey(content: string): string {
  return content;
}

/**
 * Project the store's list into rows.
 *
 * `items` is whatever the `TodoStore` returned — unvalidated, because the seam is
 * injected — and this is the boundary. A row that does not parse is dropped and
 * counted in `dropped`, so a UI can say "3 von 5 Einträgen lesbar" instead of
 * quietly showing three.
 */
export function todoRows(input: {
  readonly items: unknown;
  readonly confirmations?: UserConfirmations;
}): { readonly rows: readonly TodoRow[]; readonly dropped: number } {
  if (!Array.isArray(input.items)) return { rows: [], dropped: 0 };
  const confirmations = input.confirmations ?? {};
  const rows: TodoRow[] = [];
  let dropped = 0;

  for (const item of input.items) {
    const parsed = storedItemSchema.safeParse(item);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    const key = todoKey(parsed.data.content);
    const confirmedAt = confirmations[key];
    rows.push({
      content: parsed.data.content,
      status: parsed.data.status,
      priority: parsed.data.priority,
      priorityFromModel: true,
      claim: claimFor(parsed.data.status, confirmedAt),
      confirmedByUserAt: confirmedAt,
    });
  }

  return { rows, dropped };
}

function claimFor(status: TodoStatus, confirmedAt: string | undefined): TodoCompletionClaim {
  if (confirmedAt !== undefined) return "user-confirmed";
  // Not `completed`? Nothing is being claimed, so there is nothing to qualify.
  if (status !== "completed") return "unverified";
  return "agent-reported";
}

/**
 * The user's own confirmation, and what it does to the row.
 *
 * The user ticking a box is the **only** thing in this app that turns
 * `agent-reported` into `user-confirmed`. It does not edit the tool's store — the
 * list is the model's to write (`Plan.md` §16.2), and a UI that wrote it would be
 * a second writer of a list the model is told it owns. The confirmation lives in
 * the UI's own storage, and the tool's next call overwrites the list, which is
 * why the confirmation is keyed by content and re-applied.
 */
export function confirmRow(
  confirmations: UserConfirmations,
  content: string,
  at: string,
): UserConfirmations {
  return { ...confirmations, [todoKey(content)]: at };
}

/** Undo a confirmation. The user may change their mind; the claim follows. */
export function unconfirmRow(confirmations: UserConfirmations, content: string): UserConfirmations {
  const { [todoKey(content)]: _removed, ...rest } = confirmations;
  return rest;
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/** What a `completed` row says about itself. Never "erledigt", alone. */
export function claimLabel(row: TodoRow): string | undefined {
  if (row.status !== "completed") return undefined;
  return row.claim === "user-confirmed" ? "von dir bestätigt" : "vom Agenten behauptet — nicht geprüft";
}

/**
 * The `aria-label` for the status, so colour is not the only signal.
 *
 * Reads the **claim** and not the label string, and that is the load-bearing
 * detail: an earlier version compared the German label against a constant, so a
 * copy change silently turned "von dir bestätigt" into "nicht geprüft" — the row
 * would have told a user who *had* checked something that it was unchecked. The
 * claim is the state; the label is its rendering.
 */
export function statusLabel(row: TodoRow): string {
  if (row.status === "completed") {
    return row.claim === "user-confirmed" ? "Erledigt, von dir bestätigt" : "Erledigt laut Agent, nicht geprüft";
  }
  return row.status === "in_progress" ? "In Arbeit" : "Offen";
}

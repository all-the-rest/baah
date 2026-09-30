/**
 * The todo list's provenance rule, and the `completed` claim.
 *
 * ## Why this is the most carefully tested file in the UI block
 *
 * Three things happen here that do not happen anywhere else:
 *
 * 1. **Any text from a file the agent read can become a sidebar row.** There is no
 *    provenance on the row and `TodoStore` is the tool's contract, so the UI cannot
 *    add one — the honest move is to say so.
 * 2. **`completed` is the most trusted-looking thing in the app.** A tick and a
 *    strikethrough on a tool-authored row would state as fact something nobody
 *    verified. So a tool-authored `completed` is `agent-reported`, and only the
 *    user's own click produces `user-confirmed`.
 * 3. **The list round-trips into the next turn's model context**, so a row is also
 *    an injection surface.
 *
 * The brief for this file was "rather understate than overstate", and the tests
 * below check the understatement *and* the direction: a mutation that made the
 * claim stronger must fail here.
 */
import { describe, expect, it } from "vitest";

import { claimLabel, confirmRow, statusLabel, todoKey, todoRows, unconfirmRow } from "./todo.ts";
import { createTodoState } from "./todo-state.ts";

const agentClaimed = { content: "Migration schreiben", status: "completed" as const, priority: "high" as const };
const open = { content: "Tests ergänzen", status: "pending" as const, priority: "medium" as const };

describe("a tool-authored `completed` is a claim, not a fact", () => {
  it("claims it was reported by the agent, not verified", () => {
    const { rows } = todoRows({ items: [agentClaimed] });
    // The whole point. `user-confirmed` here would be a lie the UI cannot support:
    // nobody checked the file.
    expect(rows[0]?.claim).toBe("agent-reported");
  });

  it("says so in words on the row", () => {
    const { rows } = todoRows({ items: [agentClaimed] });
    const label = claimLabel(rows[0]!);
    expect(label).toContain("vom Agenten behauptet");
    // "nicht geprüft" is the half that stops a reader concluding the work happened.
    expect(label).toContain("nicht geprüft");
  });

  it("says it in the accessible label too, so colour is not the only signal", () => {
    const { rows } = todoRows({ items: [agentClaimed] });
    // A screen-reader user gets the same information a sighted one does.
    expect(statusLabel(rows[0]!)).toBe("Erledigt laut Agent, nicht geprüft");
  });

  it("does not claim the key for an open row", () => {
    // Nothing is being claimed about a pending row, so there is nothing to qualify.
    const { rows } = todoRows({ items: [open] });
    expect(rows[0]?.claim).toBe("unverified");
    expect(claimLabel(rows[0]!)).toBeUndefined();
  });
});

describe("only the user's own click confirms a row", () => {
  it("upgrades the claim after a confirmation", () => {
    const { rows } = todoRows({
      items: [agentClaimed],
      confirmations: confirmRow({}, agentClaimed.content, "2026-01-01T00:00:00.000Z"),
    });
    expect(rows[0]?.claim).toBe("user-confirmed");
    expect(statusLabel(rows[0]!)).toBe("Erledigt, von dir bestätigt");
  });

  it("downgrades it again when the user changes their mind", () => {
    const confirmations = confirmRow({}, agentClaimed.content, "2026-01-01T00:00:00.000Z");
    const { rows } = todoRows({
      items: [agentClaimed],
      confirmations: unconfirmRow(confirmations, agentClaimed.content),
    });
    // The claim follows the user, and the row says it is unverified again. A
    // confirmation the user cannot take back is a confirmation they do not trust.
    expect(rows[0]?.claim).toBe("agent-reported");
  });

  it("keys the confirmation by content, not by index", () => {
    // `Plan.md` §16.2: `set` is a full replacement on every call, so an index means
    // something different after every write. The text is the only stable key.
    expect(todoKey(agentClaimed.content)).toBe(agentClaimed.content);
    const confirmations = confirmRow({}, "erste", "t");
    expect(unconfirmRow(confirmations, "zweite")).toEqual(confirmations);
  });

  it("survives the model overwriting the list", () => {
    // The list is the model's to write; a UI that wrote the confirmation into it
    // would have it deleted by the next call. The confirmation lives beside it.
    const state = createTodoState();
    const store = state.toolStore("s1");
    store.set("s1", [agentClaimed]);
    state.confirm(agentClaimed.content, "2026-01-01T00:00:00.000Z");
    store.set("s1", [agentClaimed, open]);
    expect(state.get().rows.find((row) => row.content === agentClaimed.content)?.claim).toBe("user-confirmed");
  });
});

describe("a row that does not parse is dropped, not rendered", () => {
  it("counts the dropped rows instead of showing half a list", () => {
    // A half-parsed item with `status: "completed"` is exactly the row this module
    // exists to distrust. `AGENTS.md` §5: the store is an injected seam, so
    // everything crossing it is parsed.
    const { rows, dropped } = todoRows({
      items: [agentClaimed, { content: "kaputt", status: "vielleicht" }, null, "text"],
    });
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(3);
  });

  it("returns nothing for a non-array", () => {
    expect(todoRows({ items: undefined })).toEqual({ rows: [], dropped: 0 });
  });
});

describe("the store seam is session-scoped", () => {
  it("refuses a read or write for a different session", () => {
    // The tool's own contract: the session id "MUSS gesetzt sein — sonst fällt der
    // Key auf 'default' und alle Sessions teilen sich eine Liste". Ignoring the
    // argument would be a quieter version of the same bug.
    const state = createTodoState();
    const store = state.toolStore("s1");
    store.set("s1", [open]);
    expect(store.get("s2")).toEqual([]);
    store.set("s2", [agentClaimed]);
    expect(store.get("s1")).toHaveLength(1);
  });

  it("does not publish for a no-op write", () => {
    // The tool skips a no-op itself, so an extra publish would be a re-render on
    // every call — and the sidebar is the view a user watches while waiting.
    const state = createTodoState();
    const store = state.toolStore("s1");
    let notifications = 0;
    state.subscribe(() => {
      notifications += 1;
    });
    store.set("s1", [open]);
    const after = notifications;
    store.set("s1", [open]);
    expect(notifications).toBe(after);
  });

  it("publishes for a real change", () => {
    const state = createTodoState();
    const store = state.toolStore("s1");
    let notifications = 0;
    state.subscribe(() => {
      notifications += 1;
    });
    store.set("s1", [open]);
    store.set("s1", [agentClaimed]);
    expect(notifications).toBeGreaterThanOrEqual(2);
  });

  it("re-renders on a confirmation, which changes no list at all", () => {
    // A confirmation changes the *rendering* of a row without changing the tool's
    // list, so a subscriber that only watched the list would show a stale claim.
    const state = createTodoState();
    state.toolStore("s1").set("s1", [agentClaimed]);
    let notifications = 0;
    state.subscribe(() => {
      notifications += 1;
    });
    state.confirm(agentClaimed.content, "2026-01-01T00:00:00.000Z");
    expect(notifications).toBeGreaterThan(0);
    expect(state.get().rows[0]?.claim).toBe("user-confirmed");
  });
});

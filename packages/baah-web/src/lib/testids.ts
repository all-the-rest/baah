/**
 * The `data-testid` contract between this layer and the UI block.
 *
 * ## Why this file exists
 *
 * `packages/baah-web/e2e/scenarios.e2e.ts` records seven Wave-2 scenarios as
 * `test.fixme` and says, verbatim, that the suite "will not guess at selectors".
 * Guessing is how an E2E suite ends up asserting on a class name that a Tailwind
 * upgrade renames: the suite goes red for a reason nobody can act on, gets
 * ignored, and then gets deleted. So the names are decided **here**, exported as
 * constants, and the UI block imports them rather than retyping the strings — a
 * typo becomes a type error instead of a silently missing node.
 *
 * They are exported from `src/lib/` rather than from the runtime so that a
 * component can import one name without pulling in the composition root.
 *
 * ## Naming rule
 *
 * Every id starts with `baah-` and says what it *is*, not where it sits. No
 * `data-testid` encodes a class, a colour, or a position in the tree: the class is
 * a styling decision that changes without a test breaking, and a position in the
 * tree changes without anything breaking.
 */

export const TEST_IDS = {
  /* ---- the workbench --------------------------------------------- */
  /**
   * The chat region: header, transcript, question card and composer as one
   * element — the thing the sidebar sits next to.
   *
   * Named for **what it is**, not where it sits: `baah-chat`, not
   * `baah-chat-column` and not `baah-left-pane`. The naming rule above is not a
   * formality — it is the reason a spec survives a Tailwind upgrade — and
   * `column` is exactly the kind of word that describes a CSS decision
   * (`flex-row` + `flex-1`) rather than the region. A spec that has to say
   * "the chat is still beside the sidebar" needs *a* handle on the chat, and
   * this is the narrowest one that does not encode the layout.
   */
  chat: "baah-chat",

  /* ---- transcript ------------------------------------------------ */
  /** The scroll container holding every message of the current session. */
  transcript: "baah-transcript",
  /** One message. `data-baah-role` carries `user|assistant|system`. */
  transcriptMessage: "baah-transcript-message",
  /** The role, as its own node so a spec can assert on the text. */
  transcriptMessageRole: "baah-transcript-message-role",
  /** One text part's content. Streaming text lives here. */
  transcriptText: "baah-transcript-text",
  /** Shown when the session has no message yet. */
  transcriptEmpty: "baah-transcript-empty",

  /* ---- tool card ------------------------------------------------- */
  /** One tool invocation. `data-baah-tool-call-id` identifies it. */
  toolCard: "baah-tool-card",
  /** The `state` of the card, as text: `input-available`, `output-available`, … */
  toolCardState: "baah-tool-card-state",
  toolCardName: "baah-tool-card-name",
  toolCardError: "baah-tool-card-error",

  /* ---- approval card --------------------------------------------- */
  /** One open question. `data-baah-approval-id` addresses the answer. */
  approvalCard: "baah-approval-card",
  approvalCardTool: "baah-approval-card-tool",
  approvalCardReason: "baah-approval-card-reason",
  /** Approve once. Answers `approve({ approvalId, approved: true })`. */
  approvalAllow: "baah-approval-allow",
  /** Deny. Also rejects every other open approval of the session (§7.5). */
  approvalDeny: "baah-approval-deny",

  /* ---- outcome unknown ------------------------------------------- */
  /**
   * A tool call that began and never reported an outcome.
   *
   * Its own node, never a variant of the tool card: `Plan.md` §5.1 — the engine
   * ran it a second time and reported it as failed, both of which are lies the
   * model would act on. A card that claims neither is the whole point of the
   * event, so a spec must be able to assert its presence on its own.
   */
  outcomeUnknown: "baah-outcome-unknown",
  outcomeUnknownTool: "baah-outcome-unknown-tool",

  /* ---- turn status ----------------------------------------------- */
  /** The turn's overall state, as text: `idle|running|awaiting-approval`. */
  turnStatus: "baah-turn-status",
  /** `succeeded|failed|interrupted|waiting`. Also on a recovered turn. */
  turnStatusOutcome: "baah-turn-status-outcome",
  /** "Versuch 2 von 3" (§5.4: the attempts must be visible). */
  turnStatusAttempts: "baah-turn-status-attempts",
  /** A §5.4 stall report: the provider produced nothing for the window. */
  stallWarning: "baah-stall-warning",
  /** Re-send the turn as a **new** attempt. Never labelled "resume" (§14.4). */
  retryTurn: "baah-retry-turn",
  stopTurn: "baah-stop-turn",

  /* ---- provider connection test ---------------------------------- */
  /** The onboarding connection test's verdict. `data-baah-outcome` carries it. */
  providerProbeResult: "baah-provider-probe-result",
  providerProbeDetail: "baah-provider-probe-detail",

  /* ---- settings --------------------------------------------------- */
  /** The §8.2 opt-in. Off by default; the export stays key-free without it. */
  settingsExportIncludeKeys: "baah-settings-export-include-keys",
  settingsExportDownload: "baah-settings-export-download",
  settingsImportFile: "baah-settings-import-file",
  /** The §8.2 "was ändert sich?" preview. Rendered before anything is written. */
  settingsImportDiff: "baah-settings-import-diff",
  /** Never a key value — the slot name only. Assert on this, not on the input. */
  settingsKeySlot: "baah-settings-key-slot",

  /* ---- sidebar / drawer (below the 1024 px breakpoint) ---------------- */
  /**
   * Opens and closes the collapsed sidebar. **Exists only below 1024 px** — on a wide
   * viewport the sidebar is always open and the control is not rendered at all.
   *
   * So a test must never assert on it unconditionally; see the mobile branch of the
   * screenshot manifest's `chat-todo`, which asks whether the thing it wants to
   * photograph is visible and only then opens the drawer.
   */
  sidebarToggle: "baah-toggle-sidebar",
  /** Covers the page while the drawer is open, and closes it on click. */
  sidebarBackdrop: "baah-sidebar-backdrop",
  /** The drawer's own close control, for reaching it without the backdrop. */
  sidebarClose: "baah-sidebar-close",
} as const;

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];

/**
 * The non-`data-testid` attributes a spec may rely on.
 *
 * `data-testid` says *which* element; these say *which value*. A spec that has to
 * parse a visible string to check a state is a spec that breaks on a copy change.
 */
export const TEST_ATTRIBUTES = {
  /** `data-baah-role` — `user` | `assistant` | `system`. */
  messageRole: "data-baah-role",
  /** `data-baah-message-id` — the `UIMessage.id`, so a spec can follow one turn. */
  messageId: "data-baah-message-id",
  /** `data-baah-tool-call-id` — the `toolCallId`; §14.4's idempotency key. */
  toolCallId: "data-baah-tool-call-id",
  /** `data-baah-approval-id` — the id `answerApproval` takes. */
  approvalId: "data-baah-approval-id",
  /** `data-baah-outcome` — a turn outcome or a probe verdict. */
  outcome: "data-baah-outcome",
} as const;

export type TestAttribute = (typeof TEST_ATTRIBUTES)[keyof typeof TEST_ATTRIBUTES];

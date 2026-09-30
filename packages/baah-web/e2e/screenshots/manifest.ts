/**
 * The UI-review manifest: the single place that says which **application states**
 * of `baah` are screenshotted, in which viewports, and how each one is reached.
 *
 * Adding a state is a manifest edit and nothing else — `ui-screenshots.shot.ts`
 * contains no state knowledge of any kind.
 *
 * ## A "route" here is an application state, not a URL
 *
 * The app is an SPA with **no router** (`src/App.tsx` renders `<AppShell>`, and
 * `AppShell` picks `onboarding` or `workbench` from the stored settings). There
 * is exactly one URL — `/` — and it is not a useful axis: a returning user and a
 * first-time visitor both load it and see different applications. So the matrix
 * is *states*, each reached from a fresh document by `prepare`, and the `empty`
 * axis means exactly one thing here: **nothing is configured in this browser
 * yet** — no provider, no key, no model, no transcript. Every `empty` shot is
 * therefore a first-run screen, and every `filled` shot is a configured one.
 *
 * ## Why `prepare` and not `nav` steps
 *
 * The `ui-review` harness reference models routes as `{path, nav: [click steps]}`
 * because a router lets a spec load a page by URL and then walk its chrome. With
 * no router the "chrome" *is* the state — the wizard is four steps of component
 * state, the settings panel is a boolean, and the interesting states are
 * mid-turn, which no click sequence reaches deterministically (they are reached
 * by a **faked provider stream** held open by the in-page pacer). `prepare` is
 * therefore the honest shape: "given a fresh document and the existing fake,
 * produce this state". It reuses `e2e/support/app.ts` for the walk, so the
 * wizard's selectors stay in one place and a wizard change breaks the manifest
 * loudly rather than silently.
 *
 * ## Nothing in this file asserts anything
 *
 * `prepare` only *reaches* a state. Every `waitFor` is a wait for pixels to
 * exist, never a claim about behaviour; the functional suite (`scenarios.e2e.ts`)
 * is where behaviour is proven, and it is not this file's business.
 */
import type { Page } from "@playwright/test";

import { SESSION_ID_KEY } from "../../src/lib/ids.ts";
import { TEST_IDS } from "../../src/lib/testids.ts";
import {
  openConfiguredApp,
  waitForApp,
  waitForStoredTranscript,
  waitForTurnIdle,
} from "../support/app.ts";
import type { PacerCommand, PacerState } from "../support/pacer.ts";
import { CHAT_COMPLETIONS_PATH, PROVIDER_BASE_URL, type ProviderFake } from "../support/provider.ts";
import {
  chatTextTurn,
  chatToolCallTurn,
  serverErrorBody,
  truncatedStreamBody,
  unauthorizedBody,
} from "../support/turns.ts";
import { chatReasoningThenTextTurn } from "./reasoning-turn.ts";

/** `empty` = a browser with nothing configured. `filled` = a configured one. */
export type UiReviewState = "empty" | "filled";

export type UiReviewViewport = "desktop" | "mobile";

/** The slice of the shared fixtures this manifest needs. See `fixtures.ts`. */
export interface UiReviewPacer {
  command(command: PacerCommand): Promise<PacerState>;
  state(): Promise<PacerState>;
}

export interface UiReviewShotContext {
  readonly page: Page;
  readonly provider: ProviderFake;
  readonly pacer: UiReviewPacer;
}

export interface UiReviewShot {
  /** File name, without extension, and the `--grep` handle. */
  readonly name: string;
  readonly states: readonly UiReviewState[];
  /** Defaults to both. */
  readonly viewports?: readonly UiReviewViewport[];
  /** Drive a fresh document into this state. Must be deterministic. */
  readonly prepare: (context: UiReviewShotContext) => Promise<void>;
  /** Why this state exists, or what makes it hard to reach. Read by the reviewer. */
  readonly note?: string;
}

/* ------------------------------------------------------------------ */
/* German copy used to fill the fake states                            */
/* ------------------------------------------------------------------ */

/**
 * Not a credential.
 *
 * `support/app.ts`'s `completeWizard` writes this same string, so the settings
 * panel shot's key slot has something behind it. `AGENTS.md` §2: no secret in the
 * repo, and a screenshot must not be one either — which is why the settings
 * shots assert nothing and render the **slot name** only (the app never renders
 * a key value; `TEST_IDS.settingsKeySlot` is the contract for exactly that).
 */
const FAKE_KEY = "sk-e2e-not-a-real-key";

const PROMPT = "Was steht in HINWEIS.md?";

/** A real-ish answer, so the transcript has the line lengths it has in use. */
const ANSWER =
  "Die Datei HINWEIS.md beschreibt den Sandbox-Workspace. Sie überlebt keinen Reload, " +
  "solange der Arbeitsbereich nur im Arbeitsspeicher liegt. Eine zweite Datei mit dem " +
  "Namen gibt-es-nicht.md gibt es nicht — der read-Aufruf darauf ist fehlgeschlagen, " +
  "und ich habe dir beide Ergebnisse oben als Tool-Karte gezeigt.";

const REASONING =
  "Der Nutzer fragt nach HINWEIS.md. Ich lese die Datei zuerst und prüfe danach, " +
  "ob eine zweite Datei existiert. Wenn der zweite Leseversuch scheitert, " +
  "sage ich das ausdrücklich, statt es zu übergehen.";

const QUESTION_INPUT = {
  questions: [
    {
      header: "Bereich",
      question:
        "Soll der Agent nur im Sandbox-Workspace arbeiten oder das Ausgabeformat der Antwort mit festlegen?",
      options: [
        { label: "Nur Sandbox (Empfohlen)", description: "Keine Datei auf deinem Rechner wird berührt." },
        { label: "Auch Ausgabe festlegen", description: "Der Agent nennt zusätzlich das Dateiformat." },
      ],
    },
  ],
};

const TODO_INPUT = {
  todos: [
    { content: "HINWEIS.md lesen und zusammenfassen", status: "completed", priority: "high" },
    { content: "Fehlende Datei im Workspace prüfen", status: "in_progress", priority: "medium" },
    { content: "Export der Einstellungen üben", status: "pending", priority: "low" },
  ],
};

/* ------------------------------------------------------------------ */
/* Shared navigation helpers                                           */
/* ------------------------------------------------------------------ */

/** A fresh document with nothing stored: the wizard's first screen. */
async function bootFresh(page: Page): Promise<void> {
  await page.goto("/");
  await waitForApp(page);
}

/**
 * Send a prompt with the **keyboard**, not by clicking „Senden".
 *
 * ## Why not `support/app.ts`'s `sendPrompt`
 *
 * `sendPrompt` clicks `[data-testid="baah-composer-send"]`, and at 390 px that
 * click **cannot land**. Measured on this build, in the configured workbench at
 * `viewport: 390×844`:
 *
 * ```
 * innerWidth                       390
 * left column  (flex min-w-0 flex-1)   x 0 → 0     width 0
 * right column (flex flex-col)          x 0 → 390   width 390
 * composer                              width 24
 * Send button                           x 46 → 131
 * elementFromPoint(centre of Senden) → <div class="flex flex-col border-l border-base-300">
 * ```
 *
 * `AppShell`'s shell is `flex h-screen` with the left column `flex-1 min-w-0` and
 * the right column carrying `TodoSidebar` (`w-64 shrink-0`) and `WorkspacePanel`
 * (no width at all). The right column has no `min-w-0`, so its automatic minimum
 * size is its **max-content** width — and `WorkspacePanel`'s `modeExplanation` is
 * one long German paragraph, which does not wrap for width purposes. At 390 px
 * that minimum exceeds the viewport, the left column is squeezed to exactly
 * **zero**, and everything in it — header, transcript, composer — is rendered
 * underneath the sidebar. Every click in the chat column is intercepted.
 *
 * That is a product defect, not a harness problem, and it is reported as one. It
 * also has a hard consequence for this harness: **the mobile half of the
 * `chat-*` and `error-*` matrix can only be reached without a pointer**, so this
 * helper uses `Enter`, which the app's own composer copy advertises
 * („Enter sendet, Shift+Enter macht eine neue Zeile, Esc bricht ab") and which
 * `ChatView.tsx` handles in `onKeyDown`.
 *
 * Using it on **both** viewports rather than only on mobile keeps one code path
 * and makes the choice auditable. It reaches the same state the button reaches;
 * it changes nothing about the pixels under review.
 */
async function sendViaKeyboard(page: Page, prompt: string): Promise<void> {
  const input = page.locator('[data-testid="baah-composer-input"]');
  // `fill` needs no pointer. `focus` + `keyboard.press` rather than
  // `input.press`, because `Locator.press` waits for the element to be *visible*
  // and this textarea is 26 px wide inside a zero-width column at 390 px — it is
  // laid out, not usable, and the difference is the whole finding.
  await input.fill(prompt);
  await input.focus();
  await page.keyboard.press("Enter");
}

/**
 * Walk the wizard as far as the **model** step: a provider row selected, a label
 * and a base URL filled, and the model-id field on screen.
 *
 * The order is the wizard's, not `§8.1`'s letter for letter, and the reason is in
 * `support/app.ts`: the connection test addresses a model, so asking for the key
 * first would make the probe impossible on a first run.
 */
async function walkToModelStep(page: Page): Promise<void> {
  await page.locator('[data-testid="baah-wizard-provider-openai-compatible"]').click();
  await page.locator('[data-testid="baah-wizard-provider-label"]').fill("e2e");
  await page.locator('[data-testid="baah-wizard-provider-baseurl"]').fill(PROVIDER_BASE_URL);
  await page.locator('[data-testid="baah-wizard-next-provider"]').click();
}

/**
 * One step further: the **key** step, with a model id filled and nothing saved.
 *
 * Shared by every `onboarding-*` shot from the key step on, so that those shots
 * differ only in what they do on that step — which is what makes them comparable
 * in a review.
 */
async function walkToKeyStep(page: Page): Promise<void> {
  await walkToModelStep(page);
  await page.locator('[data-testid="baah-wizard-model"]').fill("gpt-fake");
  await page.locator('[data-testid="baah-wizard-next-model"]').click();
}

/** Fill and save the key on the step `walkToKeyStep` arrives at. */
async function saveKey(page: Page): Promise<void> {
  await page.locator('[data-testid="baah-wizard-api-key"]').fill(FAKE_KEY);
  await page.locator('[data-testid="baah-wizard-save-key"]').click();
}

/**
 * Script the probe's inference call and click „Verbindung testen".
 *
 * `GET /models` needs no script — `support/provider.ts` answers it
 * unconditionally — so exactly one step is queued, on `/chat/completions`. The
 * three verdicts come from the two-request comparison in `providers/probe.ts`:
 * models answered + inference answered ⇒ `ok`; + inference 401 ⇒
 * `http-error`/`key-rejected`; + inference aborted ⇒ `cors-blocked`, §9's
 * headline finding.
 */
async function runProbe(
  context: UiReviewShotContext,
  reply:
    | { readonly kind: "json"; readonly status: number; readonly body: string }
    | { readonly kind: "abort"; readonly errorCode: string },
): Promise<void> {
  await saveKey(context.page);
  await context.provider.script([{ path: CHAT_COMPLETIONS_PATH, reply }]);
  await context.page.locator('[data-testid="baah-wizard-probe"]').click();
  await context.page.locator(`[data-testid="${TEST_IDS.providerProbeResult}"]`).waitFor();
}

/**
 * The transcript's three tool cards, in one conversation.
 *
 * Two steps produce two different card states and the third produces a
 * `reasoning` part next to the answer:
 *
 * - `read HINWEIS.md` — the sandbox file, so `output-available`;
 * - `read gibt-es-nicht.md` — the tool raises, so the SDK reports
 *   `output-available` for a *value* that is `toToolErrorResult`'s envelope and
 *   `renderPart`'s `toolStateForResult` promotes to `output-error`. That
 *   promotion is the reason the card says „Fehlgeschlagen" and not „Ausgeführt",
 *   and a screenshot is the only place a reviewer can see whether the two states
 *   are actually distinguishable **by eye**.
 */
async function toolConversation(context: UiReviewShotContext): Promise<void> {
  await context.provider.script([
    {
      reply: {
        kind: "sse",
        turn: chatToolCallTurn({ toolCallId: "shot_read_ok", toolName: "read", input: { path: "HINWEIS.md" } }),
      },
    },
    {
      reply: {
        kind: "sse",
        turn: chatToolCallTurn({ toolCallId: "shot_read_err", toolName: "read", input: { path: "gibt-es-nicht.md" } }),
      },
    },
    { reply: { kind: "sse", turn: chatReasoningThenTextTurn({ reasoning: REASONING, text: ANSWER }) } },
  ]);
  await openConfiguredApp(context.page);
  await sendViaKeyboard(context.page, PROMPT);
  await waitForTurnIdle(context.page);
  await waitForStoredTranscript(context.page);
}

/* ------------------------------------------------------------------ */
/* The manifest                                                        */
/* ------------------------------------------------------------------ */

export const shots: readonly UiReviewShot[] = [
  /* ---- empty / onboarding ---------------------------------------- */
  {
    name: "onboarding-provider",
    states: ["empty"],
    prepare: async ({ page }) => {
      await bootFresh(page);
    },
    note:
      "The first screen a user ever sees. Every later screen is reached from here, " +
      "so this is the one with the most unexamined pixels in the app: nine provider rows, " +
      "two badges each, and the data-placement paragraph that has to be read before anyone pastes a key.",
  },
  {
    name: "onboarding-model",
    states: ["empty"],
    prepare: async ({ page }) => {
      await bootFresh(page);
      await walkToModelStep(page);
      await page.locator('[data-testid="baah-wizard-model"]').fill("gpt-fake");
    },
    note:
      "The model step. The provider's own model list is the source of truth and no catalogue is " +
      "bundled, so this screen carries the app's entire answer to „what do I type here“ — as an " +
      "admission rather than as a list.",
  },
  {
    name: "onboarding-key",
    states: ["empty"],
    prepare: async ({ page }) => {
      await bootFresh(page);
      await walkToKeyStep(page);
    },
    note:
      "The key step before anything is saved. Carries the disabled „Verbindung testen“ button and " +
      "its explanation — the first place the app admits a capability is not available yet.",
  },
  {
    name: "onboarding-probe-ok",
    states: ["empty"],
    prepare: async (context) => {
      await bootFresh(context.page);
      await walkToKeyStep(context.page);
      await runProbe(context, { kind: "json", status: 200, body: JSON.stringify({ choices: [] }) });
    },
    note: "The green verdict. Reachable: the fake answers `/models` and a plain 200 on the inference call.",
  },
  {
    name: "onboarding-probe-key-rejected",
    states: ["empty"],
    prepare: async (context) => {
      await bootFresh(context.page);
      await walkToKeyStep(context.page);
      await runProbe(context, { kind: "json", status: 401, body: unauthorizedBody() });
    },
    note:
      "The rejected-key verdict *inside the wizard*. It is a different screen from a rejected key " +
      "during a turn (`error-rejected-key`), which is why both are in the set.",
  },
  {
    name: "onboarding-probe-cors-blocked",
    states: ["empty"],
    prepare: async (context) => {
      await bootFresh(context.page);
      await walkToKeyStep(context.page);
      await runProbe(context, { kind: "abort", errorCode: "failed" });
    },
    note:
      "The `cors-blocked` warning — `Plan.md` §9's measured shape and the reason the wizard exists. " +
      "It must read as „the key works, chat will fail“, never as „the key is wrong“.",
  },
  {
    name: "onboarding-workspace",
    states: ["empty"],
    prepare: async ({ page }) => {
      await bootFresh(page);
      await walkToKeyStep(page);
      await saveKey(page);
      await page.locator('[data-testid="baah-wizard-next-key"]').click();
    },
    note: "§5.3's mode choice, where the mode must be visible before it is chosen.",
  },
  {
    name: "onboarding-done",
    states: ["empty"],
    prepare: async ({ page }) => {
      await bootFresh(page);
      await walkToKeyStep(page);
      await saveKey(page);
      await page.locator('[data-testid="baah-wizard-next-key"]').click();
      await page.locator('[data-testid="baah-wizard-workspace-memory"]').click();
    },
    note: "The closing step. Note that the wizard's own header, the step list and the trust note stay on screen.",
  },
  {
    name: "chat-empty",
    states: ["empty"],
    prepare: async ({ page }) => {
      await bootFresh(page);
      await page.locator('[data-testid="baah-wizard-skip"]').click();
      await page.locator(`[data-testid="${TEST_IDS.transcript}"]`).waitFor();
    },
    note:
      "`Plan.md` §8.1's „the wizard must be skippable“ state, and the first configured-looking " +
      "screen a user lands on when they skipped: empty transcript plus a composer that says what is missing.",
  },

  /* ---- filled / chat -------------------------------------------- */
  {
    name: "chat-answer",
    states: ["filled"],
    prepare: async (context) => {
      await context.provider.script([{ reply: { kind: "sse", turn: chatTextTurn(ANSWER) } }]);
      await openConfiguredApp(context.page);
      await sendViaKeyboard(context.page, PROMPT);
      await waitForTurnIdle(context.page);
      await waitForStoredTranscript(context.page);
    },
    note: "The ordinary success screen: question, answer, and the §6.2 „Turn-Ende: idle“ outcome row.",
  },
  {
    name: "chat-streaming",
    states: ["filled"],
    prepare: async (context) => {
      await context.provider.script([{ reply: { kind: "sse", turn: chatTextTurn(ANSWER) } }]);
      await openConfiguredApp(context.page);
      // The pacer's hard gate, armed *before* the request: exactly six SSE events
      // are delivered and the stream then blocks. Six events on `chatTextTurn`'s
      // framing is the role announcement plus five content deltas, so the answer is
      // visibly half-written and carries the `data-baah-inflight` marker.
      await context.pacer.command({ op: "release", count: 6 });
      await sendViaKeyboard(context.page, PROMPT);
      await context.page.locator('[data-baah-inflight="true"]').waitFor();
    },
    note:
      "A turn in flight. Held open by the pacer rather than by a sleep, so the frame is deterministic. " +
      "What to look at: the in-flight marker, the Stopp button, and whether the user's own question " +
      "is still on screen.",
  },
  {
    name: "chat-tools",
    states: ["filled"],
    prepare: async (context) => {
      await toolConversation(context);
    },
    note:
      "Two tool cards in two different states — „Ausgeführt“ and „Fehlgeschlagen“ — plus a `reasoning` " +
      "part above the answer. The error card is auto-expanded and the successful one is collapsed " +
      "(`ToolCard.tsx`), so this is also the shot that shows whether a glance can tell them apart.",
  },
  {
    name: "chat-reasoning-open",
    states: ["filled"],
    viewports: ["desktop"],
    prepare: async (context) => {
      await toolConversation(context);
      /*
       * The `<details>` a reasoning part is rendered as has **no** testid:
       * `lib/parts.ts` says so explicitly and refuses to invent one, so it is
       * addressed by the visible summary text — the same handle a user has.
       *
       * Desktop-only, and the same reason as the three settings states: at 390 px
       * the transcript is inside a zero-width column, so this `<summary>` is laid
       * out but **not visible** and Playwright refuses to click it. That is the
       * consequence of the layout defect `sendViaKeyboard` measures — on a phone
       * the reasoning text cannot be opened at all, because nothing of the chat
       * column is on screen.
       *
       * It is `dispatchEvent` rather than a DOM `.click()` for one reason: it is
       * the same event a real click produces, so it toggles the `<details>` the
       * way a user does, without requiring the element to be visible. Using
       * `.click()` here would be a harness workaround for a *layout* defect and
       * would produce a screenshot of a state that cannot be reached — the thing
       * the desktop-only marker is for.
       */
      await context.page
        .locator("summary", { hasText: "Denkprozess des Modells" })
        .dispatchEvent("click");
    },
    note:
      "The same conversation with the reasoning part expanded. Collapsed, a reasoning part is one line " +
      "of „Denkprozess des Modells“ — this is the only shot where its content is actually reviewable. " +
      "Desktop-only: the disclosure cannot be operated at 390 px, where the chat column has zero width.",
  },
  {
    name: "chat-approval",
    states: ["filled"],
    prepare: async (context) => {
      // `read` on `.env` is the one call `Plan.md` §7.4's **default** rules judge
      // `ask`, so the pause is reached without configuring a special case: the
      // card below is the default policy, not a demonstration of it.
      await context.provider.script([
        {
          reply: {
            kind: "sse",
            turn: chatToolCallTurn({ toolCallId: "shot_env", toolName: "read", input: { path: ".env" } }),
          },
        },
        { reply: { kind: "sse", turn: chatTextTurn("Ich habe die Konfiguration nicht gelesen.") } },
      ]);
      await openConfiguredApp(context.page);
      await sendViaKeyboard(context.page, PROMPT);
      await context.page.locator(`[data-testid="${TEST_IDS.approvalCard}"]`).waitFor();
    },
    note:
      "THE shot. A card a user reads before granting a tool access to a secret, with its three answers " +
      "(once / always / reject), the exact model input, the rule that asked, and the pattern an " +
      "„immer“ answer would store. The tool card above it is in `approval-requested` — the one " +
      "tool-card state that is held open indefinitely, and therefore the only one of the three the " +
      "brief could ask for that this app actually reaches (see the report on `input-streaming`).",
  },
  {
    name: "chat-question",
    states: ["filled"],
    prepare: async (context) => {
      await context.provider.script([
        {
          reply: {
            kind: "sse",
            turn: chatToolCallTurn({ toolCallId: "shot_question", toolName: "question", input: QUESTION_INPUT }),
          },
        },
        { reply: { kind: "sse", turn: chatTextTurn("Alles klar, ich mache so weiter.") } },
      ]);
      await openConfiguredApp(context.page);
      await sendViaKeyboard(context.page, PROMPT);
      await context.page.locator('[data-baah-question="open"]').waitFor();
    },
    note:
      "The `question` tool's card. The tool blocks on the user's answer, so this frame is stable — and " +
      "the tool card next to it is pinned at `input-available` („Freigegeben, startet gleich“), which is " +
      "the only reachable way to see a tool card in a genuinely running state.",
  },
  {
    name: "chat-todo",
    states: ["filled"],
    prepare: async (context) => {
      await context.provider.script([
        {
          reply: {
            kind: "sse",
            turn: chatToolCallTurn({ toolCallId: "shot_todo", toolName: "todo", input: TODO_INPUT }),
          },
        },
        { reply: { kind: "sse", turn: chatTextTurn("Die Aufgabenliste steht, ich arbeite die zweite ab.") } },
      ]);
      await openConfiguredApp(context.page);
      await sendViaKeyboard(context.page, PROMPT);
      await waitForTurnIdle(context.page);
      await waitForStoredTranscript(context.page);
      await context.page.locator("[data-baah-todo-status]").first().waitFor();
    },
    note:
      "The sidebar with rows in all three states, including the tool-authored `completed` row and its " +
      "„vom Agenten behauptet — nicht geprüft“ claim. The claim is the trust boundary and it is on a " +
      "row that also carries a checkbox.",
  },
  {
    name: "chat-stall",
    states: ["filled"],
    prepare: async (context) => {
      await context.provider.script([{ reply: { kind: "sse", turn: chatTextTurn(ANSWER) } }]);
      await openConfiguredApp(context.page);
      // One event, then silence. The watchdog is armed on `attempt-started` and
      // every `text-delta` pushes the window out, so a stream that delivers a
      // role announcement and then nothing trips it at
      // `DEFAULT_STALL_TIMEOUT_MS` (20 s) — deliberately, and without ending the turn.
      await context.pacer.command({ op: "release", count: 1 });
      await sendViaKeyboard(context.page, PROMPT);
      await context.page.locator(`[data-testid="${TEST_IDS.stallWarning}"]`).waitFor({ timeout: 90_000 });
    },
    note:
      "The stall report, which must read as a **waiting state** and never as a failure or a timeout " +
      "verdict (`Plan.md` §5.4). It is the state a user stares at for 20 s at 2 a.m. The 20 s is real " +
      "wall-clock, not a harness shortcut.",
  },

  /* ---- filled / settings ----------------------------------------- */
  /*
   * The three states below are **desktop-only**, and not because a screenshot of
   * them would be inconvenient.
   *
   * Each is reached by clicking `[data-testid="baah-open-settings"]`, and at
   * 390 px that button is rendered inside a **zero-width** column underneath the
   * 256-px sidebar (`sendViaKeyboard`'s header has the measurement): Playwright
   * reports the sidebar's own note element intercepting pointer events at the
   * button's coordinates, and a real finger would land on the same pixels.
   *
   * There is no second route. `SettingsPanel` is mounted only from that button's
   * `onClick` in `AppShell.tsx` — no deep link, no command, no keyboard
   * shortcut. So a mobile user cannot open the settings at all, and
   * `viewports: ["desktop"]` is the honest matrix entry rather than a
   * `force: true` click that would produce a picture of a state nobody can reach.
   * Reported as a finding; see `sendViaKeyboard` for the measurement.
   */
  {
    name: "settings-panel",
    states: ["filled"],
    viewports: ["desktop"],
    prepare: async (context) => {
      await openConfiguredApp(context.page);
      await context.page.locator('[data-testid="baah-open-settings"]').click();
      await context.page.locator(`[data-testid="${TEST_IDS.settingsKeySlot}"]`).first().waitFor();
    },
    note:
      "The panel with the key **slot** (`openai-compatible:e2e`) and never a key value — `AGENTS.md` §2 " +
      "expressed as markup. Desktop-only: the button that opens it is unclickable at 390 px.",
  },
  {
    name: "settings-export-optin",
    states: ["filled"],
    viewports: ["desktop"],
    prepare: async (context) => {
      await openConfiguredApp(context.page);
      await context.page.locator('[data-testid="baah-open-settings"]').click();
      await context.page.locator(`[data-testid="${TEST_IDS.settingsExportIncludeKeys}"]`).check();
    },
    note:
      "`Plan.md` §8.2's opt-in **ticked**. The export summary underneath is the only thing that says " +
      "what the file will contain, so the two states of this checkbox must read very differently. " +
      "Desktop-only, like `settings-panel`.",
  },

  /* ---- error states ---------------------------------------------- */
  {
    name: "error-missing-key",
    states: ["filled"],
    viewports: ["desktop"],
    prepare: async (context) => {
      await openConfiguredApp(context.page);
      await context.page.locator('[data-testid="baah-open-settings"]').click();
      await context.page.locator(`[data-testid="${TEST_IDS.settingsKeySlot}"]`).first().waitFor();
      // The panel's own „entfernen" next to the slot, then close the panel. Closing
      // is not decoration: `AppShell` reads `settings.summary()` during render and
      // does not subscribe to the store, so without a state change of its own the
      // composer would keep claiming it is ready. See the report.
      await context.page
        .locator(`li:has([data-testid="${TEST_IDS.settingsKeySlot}"]) button`)
        .click();
      await context.page.locator('[data-testid="baah-settings-close"]').click();
      await context.page.locator('[data-baah-composer-disabled="true"]').waitFor();
    },
    note:
      "A configured provider with the key deleted. The composer's disabled reason must name the key, " +
      "not the transcript — `Plan.md` §9: the SDK reads no environment, so there is no `.env` to find. " +
      "Desktop-only: it is reached through the settings panel.",
  },
  {
    name: "error-rejected-key",
    states: ["filled"],
    prepare: async (context) => {
      await context.provider.script([
        { reply: { kind: "json", status: 401, body: unauthorizedBody() } },
      ]);
      await openConfiguredApp(context.page);
      await sendViaKeyboard(context.page, PROMPT);
      await waitForTurnIdle(context.page);
      await waitForStoredTranscript(context.page);
    },
    note:
      "A 401 during a turn. `Plan.md` §5.4's table: `invalid_api_key` is never retried, so this is one " +
      "request and one honest outcome — and the answer is not \"try again\".",
  },
  {
    name: "error-stream-cut",
    states: ["filled"],
    prepare: async (context) => {
      await context.provider.script([{ reply: { kind: "sse-raw", body: truncatedStreamBody() } }]);
      await openConfiguredApp(context.page);
      await sendViaKeyboard(context.page, PROMPT);
      await waitForTurnIdle(context.page, 45_000);
      await waitForStoredTranscript(context.page);
    },
    note:
      "The transport cut mid-answer: the text that arrived is **kept**, the turn is not `succeeded`, and " +
      "there is no „Fortsetzen“ anywhere (§14.4: `reconnectToStream()` always returns `null`). " +
      "Attempts 2 and 3 run against the fake's 501, so this frame also shows „Versuch 3 von 3“.",
  },
  {
    name: "error-retry-attempts",
    states: ["filled"],
    prepare: async (context) => {
      await context.provider.script([
        { reply: { kind: "json", status: 503, body: serverErrorBody() } },
        { reply: { kind: "json", status: 503, body: serverErrorBody() } },
        { reply: { kind: "sse", turn: chatTextTurn("Dritter Versuch, diesmal hat es geklappt.") } },
      ]);
      await openConfiguredApp(context.page);
      await sendViaKeyboard(context.page, PROMPT);
      await waitForTurnIdle(context.page, 45_000);
      await waitForStoredTranscript(context.page);
    },
    note:
      "The *recovered* turn: a silent retry made visible. §5.4 requires „Versuch 2 von 3“ on screen, " +
      "because a retry the user cannot see is unhelpful exactly when the failure is hard to diagnose.",
  },
  {
    name: "error-storage-boot",
    states: ["empty"],
    prepare: async ({ page }) => {
      // A browser with no `localStorage` at all — a real configuration (blocked
      // storage, a hardened profile), not a mocked React state. `createAppRuntime`
      // opens the database first and then builds the settings store, whose
      // `load()` calls `backend.read()`; `createWebStorageBackend` throws a typed
      // `SettingsStorageError("unavailable")`, `createAppRuntime` rejects, and
      // `App.tsx` renders `baah-boot-failure`.
      await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get: () => undefined,
        });
      });
      await page.goto("/");
      await page.locator('[data-testid="baah-boot-failure"]').waitFor();
    },
    note:
      "The boot-failure screen. This is the app's whole screen when the composition root fails, and it " +
      "carries no way forward — by design, since `App.tsx` deliberately does not print the message. " +
      "Whether a user can do anything with this frame is the review's question.",
  },
  {
    name: "error-storage-session",
    states: ["filled"],
    prepare: async ({ page }) => {
      // Configure for real first, so the settings blob is the app's own. Then make
      // *only* the session pointer unreadable and reload: the workbench boots,
      // `resolveSessionId` cannot restore the id, and `AppShell` renders the
      // `data-baah-boot-problem` bar that says the next reload starts a new session.
      await openConfiguredApp(page);
      await page.addInitScript((sessionKey: string) => {
        const real = window.localStorage;
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get: () => ({
            getItem(key: string): string | null {
              if (key === sessionKey) {
                throw new DOMException("storage blocked", "SecurityError");
              }
              return real.getItem(key);
            },
            setItem: (key: string, value: string) => {
              real.setItem(key, value);
            },
            removeItem: (key: string) => {
              real.removeItem(key);
            },
          }),
        });
      }, SESSION_ID_KEY);
      await page.reload();
      await page.locator('[data-baah-boot-problem="true"]').waitFor();
    },
    note:
      "The session-id warning bar — the one designed surface for \"your conversation is about to become " +
      "unreachable\". `AGENTS.md` §5 forbids swallowing it; a user who finds out by reloading has lost " +
      "the conversation, which is the one thing the persistent database was for.",
  },
];

/** Every state name, for the report and for `--grep`. */
export const shotNames: readonly string[] = shots.map((shot) => shot.name);

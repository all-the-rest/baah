/**
 * U8 — the question card squeezes the transcript to 15 % and paints over the turn
 * status.
 *
 * ## What this file pins, and why each number is a literal
 *
 * The defect was measured on the built app at two viewports (Chromium, 1280×800 and
 * 390×844) with an open question card, and the measurement is the reason for every
 * number below. Those figures were **re-measured** while this file's findings were being
 * fixed, because three of the numbers originally quoted here did not reproduce; the
 * corrected values are the ones below. The file now visits four viewports, because four
 * are needed to see four different rules:
 *
 * ```
 *                                        desktop 1280×800     mobile 390×844
 * baah-turn-status (badge)              y  49 …  73 (24 px)   y  81 … 105 (24 px)
 * the bar containing it                y  41 …  82 (41 px)   y  73 … 114 (41 px)
 * [data-baah-question="open"]           y  49 … 600 (547 px)  y  81 … 632 (547 px)
 * overlap (badge.bottom - card.top)            24 px                 24 px
 * elementFromPoint(badge centre)        SECTION[…]           SECTION[data-baah-question]
 * baah-transcript client/scroll height     24 / 159 px           24 / 159 px
 * ```
 *
 * Two facts, not one. The 24 px overlap is the **visible** half: the card's top edge
 * sat exactly on the badge's top edge at *both* viewports, so the whole badge was
 * painted over — only the bar's first 8 px stayed visible, and „Turn läuft · Versuch 1
 * von 3" was never seen. And the **consequence** is bigger than the overlap: the
 * transcript's scroll viewport is 24 px tall while holding 159 px of content — 15 %
 * readable. A spec that only asserted "the boxes do not overlap" would pass on a
 * transcript that is one line tall. So the floor in `READABLE_TRANSCRIPT_PX` is asserted
 * on its own.
 *
 * ⚠️ **The two are not the same assertion, but the box one is NOT blind.**
 * `baah-transcript` is the *scroll container*; the card and the status bar are its
 * siblings, so a "no overlap" check is a statement about the column's vertical
 * arithmetic, while `elementFromPoint` is a statement about **which element is painted
 * on top**. Measured on the pre-fix build, the boxes genuinely overlapped by 24 px at
 * both viewports, so a box-only spec **does** catch this defect — an earlier claim in
 * this file said otherwise and was wrong. The hit test is kept anyway, because it is
 * the only one of the two that catches the class of defect arithmetic cannot: a
 * negative margin, a `transform`, or an absolutely-positioned overlay can cover the bar
 * with every box still "not overlapping" it. Geometry says where things are; the hit
 * test says who is on top.
 *
 * ⚠️ **The "24 px" in that table is the badge, not the status bar.**
 * `[data-testid="baah-turn-status"]` is the `badge` span, and `elementFromPoint` at its
 * centre returns that span — so 24 px is the badge's line box. The bar containing it
 * measures **41 px** (`py-2` 16 + 24 + 1-px border) at *both* viewports, so it does not
 * wrap on a phone. That 17-px difference was load-bearing while fixing this: a
 * transcript floor reasoned from 24 px left 111 px at 390×844 rather than the 120 px
 * asserted below, and a screenshot of that state looked correct. `Transcript.tsx`
 * carries the same note next to `min-h-[10.5rem]`.
 *
 * The cause was one missing flex rule, and it is viewport-independent: the chat column
 * is `flex flex-col`, the transcript is `flex-1 min-h-0` (so it is the only item that
 * *can* shrink) and the question card had no flex class at all — `min-height: auto`
 * meant it refused to shrink below its 547 px of content and the transcript absorbed
 * the entire deficit. Desktop and mobile differ only in how much there is to absorb.
 *
 * Every expectation here is a hand-chosen number, not a value read out of the
 * implementation. `agents.todo.md` „Lehre 1": a test that derives its expectation from
 * the constant under test proves nothing.
 */
import type { Locator, Page, TestInfo } from "@playwright/test";

import { expect, test } from "./support/fixtures.ts";
import { completeWizard, waitForApp, waitForStoredTranscript, waitForTurnIdle } from "./support/app.ts";
import type { ProviderFake } from "./support/provider.ts";
import { chatTextTurn, chatToolCallTurn } from "./support/turns.ts";
import { TEST_IDS } from "../src/lib/testids.ts";

/** Desktop, and the width the screenshot suite photographs. */
const DESKTOP = { width: 1280, height: 800 } as const;

/** A phone. Also the viewport the 24-px-overlap measurement was taken at. */
const MOBILE = { width: 390, height: 844 } as const;

/**
 * A phone in **landscape**, 844×390 — the one viewport of the three where the card's
 * own floor is the binding constraint rather than its cap.
 *
 * Measured on the built app: here the transcript's own floor wins (127 px, the section's
 * `min-h-[10.5rem]` minus the 41-px status bar) and the card is held at its
 * `min-h-[10rem]` (156 px). Remove either and something has to give. With the
 * transcript's floor gone, the card takes the difference instead — measured at 390×844,
 * the transcript drops from 127 px to 105 px, below the 120 px
 * `READABLE_TRANSCRIPT_PX` asserts. With the card's floor gone, the card itself is what
 * gets squeezed — to **24 px**, because `overflow-y-auto` makes its `min-height: auto`
 * resolve to zero and it is then the only item in the column that can give way. At 390 px
 * of viewport height a 24-px card has no room for its answer row at all.
 *
 * That is why this viewport is visited at all: at 1280×800 and at 390×844 the card's
 * floor is never reached, so both of those viewports leave it untested.
 */
const LANDSCAPE = { width: 844, height: 390 } as const;

/**
 * The transcript viewport must be at least this tall while a question is open.
 *
 * **Why 120 px, as a hand-chosen floor and not a measurement.** The transcript's
 * body text is `text-sm` (14 px) at `leading-relaxed` (~22 px a line), and the scroll
 * container carries `py-3` (24 px of padding). 120 px is therefore *about three lines
 * of text* — the least that lets a user read the question the model just asked while
 * they look for where to answer it. It is not a claim about the ideal height, and it
 * is deliberately well below the height a phone actually has room for; the CSS floor
 * in `Transcript.tsx` is stated in `rem` and slightly higher, so a rounding
 * difference can never put the measured `clientHeight` on the wrong side of this
 * number.
 *
 * The value is a literal in this file on purpose: it is a statement about what a user
 * needs, and a spec that read the floor out of the stylesheet would be asserting that
 * the code equals itself.
 */
const READABLE_TRANSCRIPT_PX = 120;

/**
 * The composer's action button must be at least this wide.
 *
 * The measured history: `e2e/screenshots/manifest.ts`'s `sendViaKeyboard` documents a
 * state where the button was **24 px** wide at 390 px and every click on it was
 * intercepted by the sidebar. 40 px is the floor for a touch target a finger can hit
 * (`WCAG 2.2` target size, minimum, 24 CSS px, with 44 px the comfortable value) —
 * and 40 px is asserted because the history's 24 px must not come back. Like the
 * transcript floor this is a literal, not a mirror of a CSS value.
 */
const MIN_ACTION_BUTTON_PX = 40;

/**
 * A tablet in portrait, 768×1024. The viewport the card's **cap** is argued on.
 *
 * At 1280×800 and at 390×844 the transcript's own floor is what ends the arithmetic, so
 * the cap changes almost nothing there. At 1024 px of height the cap is the binding
 * constraint, which is why the test that covers it runs here and not at the two
 * viewports the defect was found at.
 */
const TABLET = { width: 768, height: 1024 } as const;

/**
 * The transcript viewport at 768×1024 must be at least this tall while a card is open.
 *
 * **Why 260 px, as a hand-chosen floor and not a measurement of the build.** A 1024-px
 * screen has room for the conversation to be *large*, not for three lines of it. The
 * transcript's body text is `text-sm` (14 px) at `leading-relaxed` (~23 px a line) inside
 * a container with `py-3` (24 px), so 260 px is about **ten lines** — the difference
 * between a conversation you can read and one you can only glance at.
 *
 * It is deliberately **not** a mirror of the cap in `QuestionCard.tsx`. Measured on the
 * built app at 768×1024 with the cap: transcript 300 px, card 461 px of 527 px of
 * content. With `max-h-[45vh]` removed from the card: transcript **230 px**, card 527 px
 * of 527 px — the card at its full content height. 260 px sits between the two with room
 * on both sides, and it is a statement about the user rather than about the stylesheet.
 *
 * ⚠️ **Why `READABLE_TRANSCRIPT_PX` above was NOT raised to cover the cap instead.**
 * Measured: with the cap the transcript is 145 px at 1280×800 and 127 px at 390×844.
 * Any literal that separates the two at those viewports therefore has to sit close to
 * 127 — within a few pixels of the value the CSS floor produces, which is a flake
 * waiting for a runner with different font metrics, and a number picked from the
 * implementation rather than from a need. This floor is a second, independent statement
 * at the one viewport where the cap decides the outcome.
 */
const TABLET_TRANSCRIPT_PX = 260;

/** A prompt long enough to put a realistic line in the transcript. */
const PROMPT = "Soll ich nur im Sandbox-Workspace arbeiten?";

/**
 * The `question` tool's input, the same shape `e2e/screenshots/manifest.ts` photographs.
 *
 * Written out rather than imported: `screenshots/` belongs to the review instrument and
 * this file is the functional suite — the two runners are kept apart on purpose (see
 * `playwright.config.ts`'s `testMatch` note), and one runner importing the other's
 * fixture is how that separation ends.
 */
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

/** A box, as this file asserts on it. */
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** Everything the layout claims about itself, measured in one round trip. */
type Layout = {
  readonly chatColumn: Box;
  readonly sidebar: Box | undefined;
  readonly status: Box;
  readonly transcriptSection: Box;
  readonly transcript: Box;
  readonly transcriptClientHeight: number;
  readonly transcriptScrollHeight: number;
  readonly question: Box;
  readonly questionClientHeight: number;
  readonly questionScrollHeight: number;
  readonly composer: Box;
  readonly actionButton: Box;
  /** Which testid the composer's action button carries, for the report. */
  readonly actionButtonTestId: string;
  /** The topmost node at the status badge's centre, described. */
  readonly statusCentreHit: string;
  readonly statusCentreInsideStatus: boolean;
  readonly statusCentreInsideQuestion: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
};

/** The open question card. */
function questionCard(app: Page): Locator {
  return app.locator('[data-baah-question="open"]');
}

/**
 * Measure the whole chat column's vertical arithmetic, plus the hit test at the status
 * badge's centre and the card's two heights (its box and its content, so "is the card
 * capped?" can be asked as a comparison rather than as a CSS constant).
 *
 * The hit test is done in the page and returned as a **description plus two booleans**
 * rather than as a serialized node: what the assertions need to know is "is the
 * topmost node at this point the status badge or the question card", and answering that
 * question in the page keeps the decision next to the geometry it is about.
 */
async function measureLayout(app: Page): Promise<Layout> {
  // Every selector here is built from the `TEST_IDS` contract in `src/lib/testids.ts`,
  // so a renamed id is a type error in this file rather than a spec that quietly
  // measures nothing. `baah-composer-send` is the one literal left: it is not in the
  // contract — `baah-composer` is not either — and it is written out in
  // `ChatView.tsx` and in `e2e/support/app.ts` alike.
  const selectors = {
    status: `[data-testid="${TEST_IDS.turnStatus}"]`,
    stop: `[data-testid="${TEST_IDS.stopTurn}"]`,
    send: '[data-testid="baah-composer-send"]',
    transcript: `[data-testid="${TEST_IDS.transcript}"]`,
    chat: `[data-testid="${TEST_IDS.chat}"]`,
    composer: '[data-testid="baah-composer"]',
  };
  // This object is passed straight into `page.evaluate`, where a mistake in a selector
  // string is **not** an exception — it is a `null` and a `Number.NaN`, and the test then
  // asserts on NaN and fails with a message about geometry. One cheap shape check at the
  // top turns that class of typo into an error that names the key.
  for (const [name, selector] of Object.entries(selectors)) {
    if (!/^\[data-testid="baah-[a-z-]+"\]$/.test(selector)) {
      throw new Error(`measureLayout: malformed selector for ${name}: ${selector}`);
    }
  }

  return app.evaluate((selectors) => {
    const box = (element: Element | null): { x: number; y: number; width: number; height: number } => {
      const rect = element?.getBoundingClientRect();
      return {
        x: rect?.x ?? Number.NaN,
        y: rect?.y ?? Number.NaN,
        width: rect?.width ?? Number.NaN,
        height: rect?.height ?? Number.NaN,
      };
    };

    const status = document.querySelector(selectors.status);
    const question = document.querySelector('[data-baah-question="open"]');
    const transcript = document.querySelector<HTMLElement>(selectors.transcript);
    const chatColumn = document.querySelector(selectors.chat);
    const composer = document.querySelector(selectors.composer);
    const sidebar = document.getElementById("baah-sidebar");
    const send = document.querySelector(selectors.send);
    const stop = document.querySelector(selectors.stop);
    const button = send ?? stop;

    // The status badge's centre, rounded to whole pixels: a half-pixel coordinate is
    // a coin flip between the badge and whatever is next to it.
    const statusRect = status?.getBoundingClientRect();
    const centreX = statusRect === undefined ? Number.NaN : Math.round(statusRect.x + statusRect.width / 2);
    const centreY = statusRect === undefined ? Number.NaN : Math.round(statusRect.y + statusRect.height / 2);
    const hit = Number.isFinite(centreX) && Number.isFinite(centreY)
      ? document.elementFromPoint(centreX, centreY)
      : null;

    return {
      chatColumn: box(chatColumn),
      sidebar: sidebar === null ? undefined : box(sidebar),
      status: box(status),
      transcriptSection: box(transcript?.parentElement ?? null),
      transcript: box(transcript),
      transcriptClientHeight: transcript?.clientHeight ?? -1,
      transcriptScrollHeight: transcript?.scrollHeight ?? -1,
      question: box(question),
      questionClientHeight: question?.clientHeight ?? -1,
      questionScrollHeight: question?.scrollHeight ?? -1,
      composer: box(composer),
      actionButton: box(button),
      actionButtonTestId: send === null ? "baah-stop-turn" : "baah-composer-send",
      statusCentreHit: hit === null
        ? "null"
        : `${hit.tagName.toLowerCase()}${hit.className === "" ? "" : `.${String(hit.className).split(" ").join(".")}`}`,
      statusCentreInsideStatus: hit !== null && status !== null && status.contains(hit),
      statusCentreInsideQuestion: hit !== null && question !== null && question.contains(hit),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, selectors);
}

/**
 * Numbers into the report, never into the console: `e2e/tsconfig.json` has `"types": []`.
 *
 * `unknown` rather than `Layout`, so a test may attach a one-off probe (the answer-row
 * geometry, say) without inventing a second serialisation helper for it.
 */
async function attachLayout(
  testInfo: TestInfo,
  label: string,
  layout: unknown,
): Promise<void> {
  await testInfo.attach(`${label}.json`, {
    body: JSON.stringify(layout, undefined, 2),
    contentType: "application/json",
  });
}

/**
 * Open the app at `viewport` and leave a question card on screen.
 *
 * The prompt is sent with the **keyboard**, exactly like
 * `e2e/screenshots/manifest.ts`'s `sendViaKeyboard`, and for that file's reason: a
 * pointer click on the send button is the one interaction the 390-px layout has
 * historically made impossible, so a click-based setup would turn a layout defect into
 * a setup failure with a misleading message. Duplicated rather than imported for the
 * same reason `QUESTION_INPUT` is written out: `screenshots/` is the review
 * instrument's tree.
 */
/**
 * One turn's worth of provider script, with a **fresh** `toolCallId`.
 *
 * ⚠️ The id must differ per turn and the reason is the engine, not the test: a
 * `toolCallId` that has already run is persisted and **short-circuited** on replay
 * (`AGENTS.md` §3.1, "Tool-Idempotenz beim Replay"), so a second turn scripted with the
 * same id does not re-open a card — the `question` tool is never called, and the spec
 * waits for a node that will not arrive. Measured while writing this file: the
 * two-viewport loop passed at 390 px and then hung on its second iteration with
 * `[data-baah-question="open"]` never appearing.
 */
let turnCounter = 0;

async function openWithQuestion(
  app: Page,
  provider: ProviderFake,
  viewport: { readonly width: number; readonly height: number },
): Promise<void> {
  turnCounter += 1;
  // Before the first navigation: `AppShell` decides sidebar-vs-drawer from
  // `matchMedia`, and a viewport changed after mount leaves the drawer where it was.
  await app.setViewportSize(viewport);
  //
  // ⚠️ **Exactly one step, and only the question.** The follow-up text turn is scripted
  // by the caller that *answers* the question, not here. `ProviderFake.script` appends
  // to a queue, and nothing clears it: an iteration that leaves a card open leaves its
  // follow-up turn queued, so the **next** iteration's first request was answered by
  // the previous iteration's text — the `question` tool was never called, and the wait
  // for the card timed out with a transcript showing a perfectly normal answer. The
  // failure reads as "the card does not open" and is actually a stale queue.
  await provider.script([
    {
      reply: {
        kind: "sse",
        turn: chatToolCallTurn({
          toolCallId: `u8_question_${String(turnCounter)}`,
          toolName: "question",
          input: QUESTION_INPUT,
        }),
      },
    },
  ]);
  await app.goto("/");
  await waitForApp(app);
  // ⚠️ The wizard is walked **only if it is on screen**, and a test that walks it twice
  // times out rather than fails with a message. The configuration is persisted, so the
  // second `goto` in a two-viewport loop lands straight in the workbench and
  // `completeWizard`'s first click waits for a node that is never coming. The
  // alternative — a fresh browser context per viewport — would give up the shared
  // `ProviderFake`, and this file's setup is two lines, not a fixture.
  if (await app.locator('[data-testid="baah-wizard-skip"]').isVisible()) {
    await completeWizard(app);
  }
  const input = app.locator('[data-testid="baah-composer-input"]');
  await input.fill(PROMPT);
  await input.focus();
  await app.keyboard.press("Enter");
  await questionCard(app).waitFor();
}

test.describe("question card layout (U8)", () => {
  test("the card does not overlap the turn status at 1280×800 or 390×844", async ({
    app,
    provider,
  }, testInfo) => {
    for (const viewport of [DESKTOP, MOBILE]) {
      await openWithQuestion(app, provider, viewport);
      const layout = await measureLayout(app);
      await attachLayout(testInfo, `overlap-${viewport.width}`, layout);

      const overlap = layout.status.y + layout.status.height - layout.question.y;
      expect(
        layout.question.y,
        `at ${viewport.width}px the card must start at or below the status bar (status ` +
          `${layout.status.y}…${layout.status.y + layout.status.height}, card from ` +
          `${layout.question.y}, overlap ${overlap}px, transcript ` +
          `${layout.transcriptClientHeight}/${layout.transcriptScrollHeight}px)`,
      ).toBeGreaterThanOrEqual(layout.status.y + layout.status.height);
    }
  });

  test("at 390×844 the turn status is the node painted at its own centre", async ({
    app,
    provider,
  }, testInfo) => {
    // The paint-order assertion, and **not** a claim that the bounding boxes were blind
    // to this defect — a box-only spec catches it too, measured: pre-fix the boxes
    // overlapped by 24 px at both viewports, so `question.y >= status.y + status.height`
    // fails on the first viewport. The hit test stays because it is the assertion
    // arithmetic cannot make at all: a negative margin, a `transform` or an absolutely
    // positioned overlay covers the bar while every box is still legitimately adjacent.
    // Measured before the fix, this resolved to the question card at **both** viewports —
    // on the phone the whole 24-px badge was covered, and on the desktop viewport the
    // badge was covered just the same, leaving only the bar's first 8 px visible.
    await openWithQuestion(app, provider, MOBILE);
    const layout = await measureLayout(app);
    await attachLayout(testInfo, "hit-test-390", layout);

    expect(layout.statusCentreInsideStatus, "the status badge is on top at its own centre").toBe(true);
    expect(
      layout.statusCentreInsideQuestion,
      `the card must not paint over the status bar (hit test resolved to ${layout.statusCentreHit})`,
    ).toBe(false);
  });

  test("the transcript viewport stays readable while a question is open", async ({
    app,
    provider,
  }, testInfo) => {
    // The consequence, and the half of the defect the overlap number only hinted at:
    // 24 px of viewport for 159 px of content is 15 % readable. A card that does not
    // overlap the status bar can still leave nothing to read.
    for (const viewport of [DESKTOP, MOBILE]) {
      await openWithQuestion(app, provider, viewport);
      const layout = await measureLayout(app);
      await attachLayout(testInfo, `transcript-${viewport.width}`, layout);

      expect(
        layout.transcriptClientHeight,
        `at ${viewport.width}px the transcript viewport must be at least ` +
          `${READABLE_TRANSCRIPT_PX}px tall (measured ${layout.transcriptClientHeight}px for ` +
          `${layout.transcriptScrollHeight}px of content)`,
      ).toBeGreaterThanOrEqual(READABLE_TRANSCRIPT_PX);
    }
  });

  test("at 768×1024 the card is capped, so the transcript keeps a tablet's worth of room", async ({
    app,
    provider,
  }, testInfo) => {
    // ⚠️ **This is the assertion that dies when `max-h-[45vh]` is removed**, and getting
    // here took one wrong turn worth recording.
    //
    // The first version of this test asserted `card.clientHeight < card.scrollHeight` —
    // "the card scrolls its own content" — at 1280×800 and 390×844, and it stayed
    // **green** with the cap removed. Remove the cap and the card is no longer at its
    // content height, but it is still shorter than its content: flex shrinks it to
    // whatever the column can give it, and it still scrolls. A relation between two
    // heights cannot tell "capped" from "squeezed".
    //
    // What separates the two is what the *conversation* gets. With the cap the card stops
    // at 45 vh and the transcript grows into the slack; without it the card's flex basis
    // is its whole content, it wins the argument, and the transcript is left short.
    // Measured here at 768×1024, cap removed: transcript **230 px** and card 527 px of
    // 527 px — the card at its full content height, which is also what finally breaks the
    // relation the first version used.
    //
    // Both facts are asserted, in that order, because either alone leaves a hole: a
    // floor on the transcript says the conversation got its room, and the relation says
    // the card gave it up rather than overflowing the column.
    await openWithQuestion(app, provider, TABLET);
    const layout = await measureLayout(app);
    await attachLayout(testInfo, "capped-768x1024", layout);

    expect(
      layout.transcriptClientHeight,
      `at ${TABLET.width}×${TABLET.height} the transcript viewport must be at least ` +
        `${TABLET_TRANSCRIPT_PX}px tall while a question card is open (measured ` +
        `${layout.transcriptClientHeight}px for ${layout.transcriptScrollHeight}px of ` +
        `content; card ${layout.questionClientHeight}px of ` +
        `${layout.questionScrollHeight}px — a card at its full content height means it ` +
        `took the column's room instead of being capped)`,
    ).toBeGreaterThanOrEqual(TABLET_TRANSCRIPT_PX);

    // And the price of the cap, as a second, independent statement: the card really does
    // scroll its own content. Measured here: 461 px of 527 px.
    expect(
      layout.questionClientHeight,
      `the card must be shorter than its own content, i.e. scroll it (clientHeight ` +
        `${layout.questionClientHeight}px, scrollHeight ${layout.questionScrollHeight}px)`,
    ).toBeLessThan(layout.questionScrollHeight);
  });

  test("at 844×390 the answer button is inside the card and is on top of it", async ({
    app,
    provider,
  }, testInfo) => {
    // ⚠️ **The one test that dies without the card's `min-h-[10rem]`.** Landscape is
    // the only one of the three viewports where the card's *floor* binds: at 844×390 the
    // transcript keeps its 127 px (its own floor), the composer is 165 px, and what is
    // left for the card is its `min-h-[10rem]` — 156 px measured. Remove the floor and
    // the card is squeezed to **24 px** (measured), because `overflow-y-auto` makes its
    // `min-height: auto` resolve to zero and it is then the only item in the column that
    // can give way. At 24 px the card has no room for its answer row at all: the
    // „Antworten" button falls outside the card's box and the hit test at its centre
    // resolves to `form[baah-composer]` — the composer has painted over the card, so a
    // click on the one button that ends a blocked turn answers nothing.
    //
    // Two assertions, and the second is the one that matters. "The button exists and is
    // in the card's box" distinguishes *squeezed* from *fine*; `elementFromPoint` at the
    // button's own centre distinguishes *reachable* from *present*, which is the whole
    // difference between a user who can answer and a user who can only look.
    await openWithQuestion(app, provider, LANDSCAPE);
    const layout = await measureLayout(app);
    await attachLayout(testInfo, "answer-reachable-844x390", layout);

    const answerRow = await app.evaluate(() => {
      const card = document.querySelector('[data-baah-question="open"]');
      const answer = document.querySelector('[data-baah-question-choice="submit"]');
      const composer = document.querySelector('[data-testid="baah-composer"]');
      if (card === null || answer === null) return { insideCard: false, onAnswer: false, onComposer: false, detail: "missing" };
      const cardBox = card.getBoundingClientRect();
      const answerBox = answer.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(answerBox.x + answerBox.width / 2),
        Math.round(answerBox.y + answerBox.height / 2),
      );
      return {
        insideCard:
          answerBox.top >= cardBox.top &&
          answerBox.bottom <= cardBox.bottom &&
          answerBox.left >= cardBox.left &&
          answerBox.right <= cardBox.right,
        onAnswer: hit !== null && answer.contains(hit),
        onComposer: hit !== null && composer !== null && composer.contains(hit),
        detail:
          `card ${Math.round(cardBox.top)}…${Math.round(cardBox.bottom)} ` +
          `(${card.clientHeight}px), answer ${Math.round(answerBox.top)}…${Math.round(answerBox.bottom)}, ` +
          `hit ${hit === null ? "null" : hit.tagName.toLowerCase()}`,
      };
    });
    await attachLayout(testInfo, "answer-reachable-844x390-detail", { layout, answerRow });

    // ⚠️ **The order is deliberate.** The hit test comes first because it is the stronger
    // claim and the one that names the real consequence: "the button is in the DOM and
    // inside the card's box" would still hold for a card so short that a different
    // element paints over the button. If this test ever fails, the first assertion's
    // message already says *who* is on top.
    expect(
      answerRow.onAnswer,
      `a click on „Antworten" must land on the button itself, not on whatever paints over ` +
        `it (${answerRow.detail})`,
    ).toBe(true);
    expect(
      answerRow.onComposer,
      `the composer must not paint over the answer button (${answerRow.detail})`,
    ).toBe(false);
    expect(
      answerRow.insideCard,
      `at ${LANDSCAPE.width}×${LANDSCAPE.height} the answer button must be inside the visible ` +
        `part of the card (${answerRow.detail}; the card's clientHeight was ` +
        `${layout.questionClientHeight}px for ${layout.questionScrollHeight}px of content)`,
    ).toBe(true);
  });

  test("at 390×844 the composer's action button is reachable and not covered", async ({
    app,
    provider,
  }, testInfo) => {
    // The composer may not be squeezed out of the viewport by the pinned card: a user
    // who cannot answer and cannot reach the composer has a dead app. The button must
    // be wide enough to hit **and** be the topmost node at its own centre, which is
    // what "not covered by the sidebar" means in a browser.
    //
    // ⚠️ Which button this measures, and why it is not always `baah-composer-send`:
    // `ChatView` renders **either** the send button (idle) **or** the stop button (a
    // turn is in flight) into the same slot, and they are mutually exclusive. While a
    // question card is open the turn *is* in flight — the `question` tool blocks until
    // the user answers — so the send button is not mounted at that moment and a spec
    // addressing it there would wait forever for a node that cannot exist. The
    // reachability claim is about the **slot**, which is what the 24-px history broke;
    // the real send button is measured too, after the question has been answered.
    await openWithQuestion(app, provider, MOBILE);
    const withCard = await measureLayout(app);
    await attachLayout(testInfo, "composer-390-card-open", withCard);

    expect(
      withCard.actionButton.width,
      `the action button in the send slot (${withCard.actionButtonTestId}) must be at least ` +
        `${MIN_ACTION_BUTTON_PX}px wide, measured ${withCard.actionButton.width}px`,
    ).toBeGreaterThanOrEqual(MIN_ACTION_BUTTON_PX);
    expect(withCard.actionButton.x).toBeGreaterThanOrEqual(0);
    expect(withCard.actionButton.x + withCard.actionButton.width).toBeLessThanOrEqual(withCard.viewport.width);
    expect(withCard.actionButton.y).toBeGreaterThanOrEqual(0);
    expect(withCard.actionButton.y + withCard.actionButton.height).toBeLessThanOrEqual(withCard.viewport.height);

    // And the button in the send slot really is the topmost node there — the same
    // question asked about the button, not about the status bar.
    const buttonHit = await app.evaluate(() => {
      const button = document.querySelector('[data-testid="baah-composer-send"], [data-testid="baah-stop-turn"]');
      const composer = document.querySelector('[data-testid="baah-composer"]');
      const rect = button?.getBoundingClientRect();
      if (rect === undefined || button === null || composer === null) return { insideComposer: false, hit: "null" };
      const hit = document.elementFromPoint(
        Math.round(rect.x + rect.width / 2),
        Math.round(rect.y + rect.height / 2),
      );
      return {
        insideComposer: hit !== null && (hit === button || composer.contains(hit)),
        hit: hit === null ? "null" : `${hit.tagName.toLowerCase()}#${hit.id}`,
      };
    });
    expect(
      buttonHit.insideComposer,
      `a click on the button must land on the composer, not on whatever paints over it (hit: ${buttonHit.hit})`,
    ).toBe(true);

    // The same question asked of the **card's own** answer row, and this one is the
    // assertion that earns `QuestionCard.tsx`'s `sticky bottom-0`. The card now scrolls
    // its content (`max-h-[45vh]`), so "the user can always answer" is a geometric
    // claim and not a matter of taste: the „Antworten" button has to be inside the
    // card's own visible box, at the bottom of it, without the user having discovered
    // that they have to scroll a 45-vh card to find out how to answer a question.
    //
    // A button that exists in the DOM but sits 100 px below the card's fold satisfies
    // every other assertion in this file.
    const answerRow = await app.evaluate(() => {
      const card = document.querySelector('[data-baah-question="open"]');
      const answer = document.querySelector('[data-baah-question-choice="submit"]');
      if (card === null || answer === null) return { insideCard: false, detail: "missing" };
      const cardBox = card.getBoundingClientRect();
      const answerBox = answer.getBoundingClientRect();
      return {
        insideCard:
          answerBox.top >= cardBox.top &&
          answerBox.bottom <= cardBox.bottom &&
          answerBox.left >= cardBox.left &&
          answerBox.right <= cardBox.right,
        detail:
          `card ${Math.round(cardBox.top)}…${Math.round(cardBox.bottom)}, answer ` +
          `${Math.round(answerBox.top)}…${Math.round(answerBox.bottom)}`,
      };
    });
    expect(
      answerRow.insideCard,
      `the answer button must be inside the visible part of the card, not below its ` +
        `fold (${answerRow.detail})`,
    ).toBe(true);

    // The literal `baah-composer-send`, in the state where it exists — see the note at
    // the top of this test. The send button must not be narrower than the stop button
    // it replaces.
    //
    // The follow-up turn is scripted **here**, immediately before the answer, and not
    // in `openWithQuestion` — see the stale-queue note in its header. Ordering is
    // safe: the `question` tool blocks, so no request is in flight while the card is
    // open, and this is therefore the only point at which the queue's next entry is
    // known to be this turn's.
    await provider.script([
      { reply: { kind: "sse", turn: chatTextTurn("Verstanden, ich arbeite nur im Sandbox-Workspace weiter.") } },
    ]);
    await app.locator('[data-baah-question-choice="submit"]').click();
    await waitForTurnIdle(app);
    await waitForStoredTranscript(app);
    const send = app.locator('[data-testid="baah-composer-send"]');
    await expect(send, "the send button is mounted once the turn is idle").toBeVisible();
    const sendBox = await send.boundingBox();
    expect(sendBox, "the send button has a box").not.toBeNull();
    expect(
      sendBox?.width ?? 0,
      `the send button must be at least ${MIN_ACTION_BUTTON_PX}px wide at ${MOBILE.width}px`,
    ).toBeGreaterThanOrEqual(MIN_ACTION_BUTTON_PX);
  });

  test("at 1280×800 the chat column and the sidebar are side by side", async ({
    app,
    provider,
  }, testInfo) => {
    // The regression guard for the other direction. Everything above is about a narrow
    // viewport, and a fix that reached up into `AppShell`'s row (making the column
    // scroll, or stacking the sidebar under the chat) would satisfy every mobile
    // assertion and destroy the desktop layout the screenshot set is taken on. Two
    // columns, not one: each has width, they do not overlap, and together they fill
    // the row.
    await openWithQuestion(app, provider, DESKTOP);
    const layout = await measureLayout(app);
    await attachLayout(testInfo, "two-column-1280", layout);

    expect(layout.chatColumn.width, "the chat column has width").toBeGreaterThan(0);
    expect(layout.sidebar, "the sidebar is a column, not a drawer, above 1024px").toBeDefined();
    expect(layout.sidebar?.width ?? 0, "the sidebar has width").toBeGreaterThan(0);
    // ⚠️ The brief for this spec said "the chat column's `left` is greater than the
    // sidebar's `right`". **Measured on this build, the sidebar is on the right** —
    // `AppShell` renders the chat column first and the sidebar last, so the chat is at
    // x 0 and the sidebar ends at the viewport's right edge. The literal form of the
    // brief's assertion therefore fails on a *correct* layout, and passing it would
    // have required reordering the shell. What the brief was after — "side by side,
    // not stacked" — is asserted here as non-overlap in **either** order, which holds
    // whichever side the sidebar ends up on, plus both boxes being on screen. A row
    // that had become a column satisfies neither.
    const sidebar = layout.sidebar;
    expect(sidebar, "the sidebar box was measured").toBeDefined();
    if (sidebar === undefined) return;

    const chatRight = layout.chatColumn.x + layout.chatColumn.width;
    const sidebarRight = sidebar.x + sidebar.width;
    const message =
      `chat ${layout.chatColumn.x}…${chatRight}, sidebar ${sidebar.x}…${sidebarRight} — ` +
      "the two must not overlap, and both must lie inside the viewport";
    expect(
      layout.chatColumn.x >= sidebarRight || sidebar.x >= chatRight,
      `${message} (either order is fine; overlapping is not)`,
    ).toBe(true);
    expect(chatRight, message).toBeLessThanOrEqual(layout.viewport.width);
    expect(sidebarRight, message).toBeLessThanOrEqual(layout.viewport.width);
    expect(layout.chatColumn.x, message).toBeGreaterThanOrEqual(0);
    expect(sidebar.x, message).toBeGreaterThanOrEqual(0);
    // And they really do fill the row between them rather than leaving a hole: two
    // 20-px boxes at opposite corners satisfy "both have width, neither overlaps".
    // 80 % of the viewport is a literal floor for "this is a two-column layout", and it
    // is far below the measured 100 % (chat 460 px + sidebar 820 px at 1280 px) — it is
    // here to catch a column that collapsed, not to pin a pixel count.
    expect(
      layout.chatColumn.width + sidebar.width,
      `the two columns must together fill the row (chat ${layout.chatColumn.width}px + ` +
        `sidebar ${sidebar.width}px of a ${layout.viewport.width}px viewport)`,
    ).toBeGreaterThan(layout.viewport.width * 0.8);
  });
});

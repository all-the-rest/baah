/**
 * The question card, and the two trust boundaries it carries.
 *
 * ## What is untrusted here
 *
 * `question` is the only tool whose *return value* is a human's keystrokes. The
 * tool passes them through **verbatim** — not trimmed, not normalised
 * (`packages/baah-tools/question/README.md`) — and the engine hands them back to
 * the model. `AGENTS.md` §2 puts the API key in the same tab and the same origin,
 * so an answer is untrusted input on its way into model context.
 *
 * ## The two rendering rules
 *
 * 1. **The free-text field and the option list are structurally different.** Not
 *    a colour: a different container, a border, a label that names what the field
 *    is. The tool's schema allows a 1000-character `question` and a
 *    100-character option `label`, and a UI that renders both at the same weight
 *    lets the long one impersonate the short one. The option list renders one
 *    entry per option with a fixed layout; the free text is one field with its own
 *    label, and the two are never in the same visual container.
 * 2. **The answer is echoed before it is handed over.** The user sees exactly what
 *    will reach the model, including the framing header — so "I typed something and
 *    it went into the model's context verbatim" is a fact they are entitled to, not
 *    a thing they have to trust.
 *
 * ## The framing itself
 *
 * The model's side is `frameQuestionAnswers` in `lib/question.ts`, applied at the
 * tool's `toModelOutput` seam (`Plan.md` §16.2). This component shows the same
 * text the model receives, so the two cannot disagree.
 *
 * ## A dismissed card is not a skip
 *
 * The tool's contract distinguishes answered / skipped / **dismissed**
 * (`Plan.md` §16.2), and a dismissal is a **rejection** — the model is told to
 * continue on a stated assumption rather than to try again. So the close button
 * says "Verwerfen" and the skip button says "Überspringen", and they are different
 * actions with different consequences.
 */
import { useEffect, useState } from "react";

import type { QuestionChannelState, QuestionView } from "./lib/question.ts";
import { answerPreview, UNTRUSTED_ANSWER_HEADER } from "./lib/question.ts";

export interface QuestionCardProps {
  readonly state: QuestionChannelState;
}

/** The card. Renders nothing when no question is open. */
export function QuestionCard({ state }: QuestionCardProps) {
  const card = useQuestion(state);
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string[]>>({});

  if (state.unreadable && card !== undefined) {
    return (
      // The same flex rules as the open card below, and for the same structural
      // reason: this is a **pinned** child of the chat column, not a child of the
      // transcript's scroll box, so an unbounded height here would be taken out of the
      // transcript exactly as it was before. Today's content is short and fixed, so the
      // cap is never reached — it is here so that a longer explanation added to this
      // card later cannot silently re-create the defect the open card's rules kill.
      <section
        data-baah-question="unreadable"
        data-baah-question-id={card.id}
        role="alert"
        className="my-2 flex min-h-[10rem] max-h-[45vh] shrink flex-col overflow-y-auto rounded-box border-2 border-error/70 bg-error/10 p-3"
      >
        <h3 className="font-semibold">Fragekarte nicht lesbar</h3>
        <p className="mt-1 text-sm">
          Der Agent hat eine Frage gestellt, deren Format baah nicht lesen konnte. Es ist keine Karte
          sichtbar, und der Turn wartet auf eine Antwort, die du nicht geben kannst.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            data-baah-question-choice="dismiss"
            className="btn btn-error btn-sm"
            onClick={() => state.dismiss(card.id)}
          >
            Karte verwerfen
          </button>
        </div>
        <p className="mt-1 text-xs opacity-70">
          Verwerfen ist eine Entscheidung, kein Fehler: der Agent macht mit der wahrscheinlichsten Annahme
          weiter und sagt, welche.
        </p>
      </section>
    );
  }

  if (card === undefined || card.questions.length === 0) return null;

  const submit = (question: QuestionView, index: number): void => {
    const selected = picked[question.id] ?? [];
    const text = (freeText[question.id] ?? "").trim();
    // One array per question, in order. A question with neither a pick nor text is
    // **skipped** — `[]`, which the model sees as "not answered", distinct from
    // `[""]` (the user typed and left it empty) and from a dismissal.
    const row = selected.length > 0 ? selected : text === "" ? [] : [text];
    const next: string[][] = [];
    for (let at = 0; at < card.questions.length; at += 1) {
      next.push(at === index ? row : picked[card.questions[at]?.id ?? ""] ?? []);
    }
    state.answer(card.id, next);
  };

  const submitAll = (): void => {
    const rows = card.questions.map((question) => {
      const selected = picked[question.id] ?? [];
      const text = (freeText[question.id] ?? "").trim();
      return selected.length > 0 ? selected : text === "" ? [] : [text];
    });
    state.answer(card.id, rows);
  };

  return (
    <section
      data-baah-question="open"
      data-baah-question-id={card.id}
      role="group"
      aria-label="Frage des Agenten"
      className="my-2 flex min-h-[10rem] max-h-[45vh] shrink flex-col overflow-y-auto rounded-box border-2 border-info/70 bg-info/10 p-3"
    >
      {/*
       * ## The layout decision, and the measurement that forced it
       *
       * This card is **pinned**, deliberately: the approval card has the same intent
       * (see `e2e/screenshots/ui-screenshots.shot.ts`'s header), so the column is not
       * made scrollable and the card is not moved into the transcript's scroll
       * container. The transcript is the conversation, and it has to stay readable
       * *while* a question is open — that is the whole point of the defect.
       *
       * The defect, measured on the built app with an open card (Chromium, the
       * `QuestionCard` of `HEAD`, before this change). Re-measured while the findings
       * on this block were being fixed, because three of the figures originally quoted
       * here did not reproduce:
       *
       * ```
       *                                     desktop 1280×800   mobile 390×844
       * question card (clientHeight)        547 px             547 px
       * question card (top edge)            y 49               y 81
       * baah-transcript viewport            24 px              24 px
       * …while holding this much content    159 px             159 px
       * status bar (of which the badge is 24 px)  41 px       41 px
       * overlap with the badge               24 px              24 px
       * ```
       *
       * The cause was one missing flex rule and it was **viewport-independent**: the
       * card had no flex class at all, so `min-height: auto` refused to shrink below
       * its content, and the transcript — the only item that *could* shrink — absorbed
       * the whole deficit. Desktop and mobile differed only in how much there was to
       * absorb. The card's **top edge landed exactly on the badge's top edge at both
       * viewports**, so the whole 24-px badge was painted over and only the bar's first
       * 8 px survived — „Turn läuft · Versuch 1 von 3 · RÜCKFRAGE" was never visible,
       * on the phone *and* on the desktop. The first report called it a phone defect
       * because 24 px is what a phone's transcript was left with; the overlap was the
       * same 24 px either way.
       *
       * The 24 px in the "overlap" row is the status **badge**; the bar is 41 px. See
       * `Transcript.tsx` — that distinction is 17 px of the transcript floor and is
       * named there.
       *
       * ### Why the fix is two halves and not one
       *
       * Both are needed, and neither is sufficient alone:
       *
       * - **`max-h-[45vh]` + `overflow-y-auto`** gives the deficit somewhere to go. A
       *   pinned card of unbounded height cannot coexist with a readable transcript on
       *   an 844-px phone: 547 + 120 + 229 (the composer, measured) is more than the
       *   viewport. The card takes at most 45 % of the screen and scrolls its own
       *   content — it is one question with one to ten sub-questions, so a scroll
       *   inside it is a cost the user pays once.
       * - **`min-h-[10rem]`** keeps the card from being squeezed to nothing on a short
       *   viewport. The floor is what the sticky answer row below needs to exist at
       *   all, so „the user can always answer" survives a landscape phone.
       *
       * ⚠️ **Which of these the E2E suite actually kills, measured by mutation.** Each
       * row below is one class removed, nothing else changed, `e2e/question-card-layout.e2e.ts`
       * run on all seven of its tests (Chromium, this host). The list used to claim
       * "3 of 5 tests die"; the measured truth is:
       *
       * | class removed | tests that die |
       * |---|---|
       * | the section's `min-h-[10.5rem]` (`Transcript.tsx`) | 1 of 7 — the transcript floor |
       * | `max-h-[45vh]` | 1 of 7 — the 768×1024 cap test |
       * | `min-h-[10rem]` | 1 of 7 — the 844×390 answer-row test |
       * | `sticky bottom-0` | 2 of 7 — the 844×390 and the 390×844 answer-row assertions |
       * | `overflow-y-auto` | 2 of 7 — the same two |
       * | `shrink-0` on the status bar | **0 of 7** |
       * | `shrink-0` on the composer | **0 of 7** |
       *
       * Two things in that table are worth reading twice.
       *
       * **`max-h-[45vh]` is load-bearing in the *opposite* direction** from how an earlier
       * version of this comment argued it. Removing it kills nothing at 1280×800 or at
       * 390×844: at both of those the transcript has already been pushed down to 127 px
       * by its **own** floor, and `READABLE_TRANSCRIPT_PX = 120` sits below that, so the
       * assertion cannot see the difference either. What the cap buys is the viewport
       * where there *is* slack: at 768×1024 the transcript is **300 px** with the cap
       * and **230 px** without it, and the card is 461 px of 527 px with it and 527 px
       * of 527 px — its full content height — without. That test was added for this; it
       * did not exist before.
       *
       * **The two `shrink-0` classes are inert.** Measured: removing either leaves all
       * seven green and changes no measured number, because a flex item's automatic
       * minimum size already floors it at its content height. They are kept as defence
       * in depth and are named as untested where they are written
       * (`Transcript.tsx`, `ChatView.tsx`) — do not read this class list as seven gates.
       *
       * The `45vh` is a share of the viewport and not a pixel count, deliberately: a
       * fixed 380 px is right on exactly one screen and wrong on every other.
       *
       * ### What it costs, measured
       *
       * After the change, at 390×844 with one question open: card 354 px of a 563-px
       * content box (63 % visible, the rest one scroll away), transcript viewport
       * **127 px** against 159 px of content, status bar fully visible, composer 229 px
       * and fully on screen. At 1280×800: card 356 px of 563 px, transcript 145 px. At
       * 768×1024: card 461 px of 527 px, transcript 300 px. So the price of the fix is
       * *a scrollbar inside the card*, and the thing it bought is a conversation that can
       * still be read while the agent is waiting for an answer.
       *
       * The transcript's half of the trade lives in `Transcript.tsx` (`min-h-[10.5rem]`
       * on the section), and this file's floor of 10 rem and cap of 45 vh together
       * with it are what the E2E spec `e2e/question-card-layout.e2e.ts` measures — at
       * 1280×800, 390×844, 844×390 and 768×1024, because the four viewports are what
       * make each of the four rules visible.
       *
       * ### ⚠️ The one consequence nobody asked for, written down on purpose
       *
       * `sticky bottom-0` below does what it was put here to do: measured with a **tall**
       * card (three questions, long descriptions — **1463 px** of content in a 354-px box,
       * i.e. 1109 px of scrolling) at 390×844, the „Antworten" button is inside the card's
       * box and is the node `elementFromPoint` returns at its own centre at **every** one
       * of five scroll positions (0 %, 25 %, 50 %, 75 %, 100 %). That is the feature.
       *
       * It also means the button is reachable for questions the user has not read. The
       * handler is `submitAll`: it submits **every** row of the card, read or not. So a
       * user who scrolls straight to the pinned button can answer questions 2 and 3
       * without ever having seen them, and the model gets those answers. That is the
       * price of „the user can always answer" and it is a deliberate choice — the
       * alternative, a button below a fold the user has to find, is the failure this
       * whole block exists to remove. It is recorded here so the next reader knows it
       * was considered and not overlooked.
       *
       * The obvious follow-up, if it is ever wanted, is to make the pinned button submit
       * only what the user has interacted with and to say so on it. That is a product
       * decision, not a layout one, and nothing in this file takes it.
       */}
      <header className="mb-2">
        <h3 className="text-xs font-semibold tracking-wide uppercase opacity-60">Rückfrage</h3>
      </header>

      {card.questions.map((question, index) => (
        <div key={question.id} data-baah-question-index={index} className="mb-4 last:mb-0">
          <h4 className="text-sm font-semibold">{question.header}</h4>
          {/*
           * The question text is rendered as a **text node**. React escapes it, and
           * this component never uses `dangerouslySetInnerHTML` — so a 1000-character
           * string containing markup renders as those characters. That is the whole
           * of the "data, never markup" rule: it is a property of how the value is
           * placed in the tree, not of a sanitiser someone has to remember to call.
           */}
          <p data-baah-question-text={index} className="mt-1 text-sm whitespace-pre-wrap break-words">
            {question.question}
          </p>

          {/*
           * The option list. A `fieldset` with a `legend`, and one button per option:
           * a short label and, when present, one sentence of consequence beneath it.
           * Nothing else goes in this container — the free-text field is deliberately
           * **outside** it, so a long question string cannot sit where an option sits.
           */}
          <fieldset className="mt-2 rounded-box border border-base-300 bg-base-100/40 p-2">
            <legend className="px-1 text-xs opacity-70">
              {question.options.length === 1 ? "Bestätigen" : question.multiple ? "Mehrfachauswahl" : "Ein Option wählen"}
            </legend>
            <div className="flex flex-col gap-1">
              {question.options.map((option) => {
                const selected = (picked[question.id] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    data-baah-question-option={option.label}
                    aria-pressed={selected}
                    onClick={() => {
                      const current = picked[question.id] ?? [];
                      const next = question.multiple
                        ? selected
                          ? current.filter((entry) => entry !== option.label)
                          : [...current, option.label]
                        : [option.label];
                      setPicked({ ...picked, [question.id]: next });
                    }}
                    className={`rounded-field border px-2 py-1 text-left text-sm ${
                      selected ? "border-info bg-info/20" : "border-base-300 hover:border-info/50"
                    }`}
                  >
                    <span className="block font-medium">{option.label}</span>
                    {option.description !== undefined && (
                      <span className="block text-xs opacity-70">{option.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/*
           * The free-text field, in its **own** container with its own label. The
           * README says the UI always offers one ("Do not add a free-text option.
           * The UI always offers one."), and this is it.
           */}
          <div data-baah-question-freetext={index} className="mt-2 rounded-box border-2 border-dashed border-base-300 p-2">
            <label htmlFor={`${card.id}-${question.id}`} className="block text-xs font-semibold opacity-80">
              Eigene Antwort (Freitext)
            </label>
            <textarea
              id={`${card.id}-${question.id}`}
              data-baah-question-freetext-input={index}
              className="textarea textarea-bordered mt-1 w-full text-sm"
              rows={2}
              value={freeText[question.id] ?? ""}
              onChange={(event) => setFreeText({ ...freeText, [question.id]: event.target.value })}
              placeholder="Etwas, das in keine der Optionen passt"
            />
          </div>

          <button
            type="button"
            data-baah-question-skip={index}
            className="btn btn-ghost btn-xs mt-2"
            onClick={() => submit(question, index)}
          >
            Überspringen
          </button>
        </div>
      ))}

      {/*
       * The echo. What the model will receive, verbatim, including the framing
       * header — so the user can see the boundary the answer crosses.
       */}
      <details className="mt-3 rounded-box border border-base-300 px-2 py-1 text-xs">
        <summary className="cursor-pointer opacity-70">Was das Modell bekommt</summary>
        <p className="mt-1 opacity-80">{UNTRUSTED_ANSWER_HEADER}</p>
        <pre className="mt-1 whitespace-pre-wrap break-words">
          {answerPreview(
            card.questions.map((question) => {
              const selected = picked[question.id] ?? [];
              const text = (freeText[question.id] ?? "").trim();
              return selected.length > 0 ? selected : text === "" ? [] : [text];
            }),
          )}
        </pre>
      </details>

      {/*
       * The answers, **pinned to the bottom of the card's own scroll box**.
       *
       * The card scrolls now (`max-h-[45vh]` + `overflow-y-auto` above), so without
       * this the „Antworten" button could sit below the fold *of the card* — a user who
       * has to discover that they have to scroll a 45 vh card to find out how to
       * answer a question has been handed a question they cannot answer.
       *
       * `sticky bottom-0` is what makes it reachable at every card height.
       *
       * ⚠️ **It does cover the content above it**, and `bg-base-100` on the next line is
       * exactly why that is not a defect: `bg-info/10` is **translucent**, so a sticky
       * element over it would show the text sliding underneath, and a button whose label
       * is briefly unreadable while you are reaching for it is the same defect one layer
       * down. The row is opaque for the whole of the width it covers.
       *
       * It is **not** the last flex child of the column — the „Verwerfen ist eine
       * Entscheidung…" paragraph below it is. That paragraph is deliberately *not*
       * opaque and does not need to be: it follows the row in the flow, so the row can
       * only ever lift over the content **above** it, never over what comes after.
       *
       * Measured at 844×390, the viewport where the card's floor binds: with `sticky`
       * the answer row is at 331…363 inside the card's 217…377; without it, at 666…698 —
       * 289 px below the card's fold, and the hit test at its centre resolves to nothing
       * at all. Measured at 390×844: card 249…607, answer 718…750 without `sticky`.
       */}
      <div className="sticky bottom-0 mt-3 flex flex-wrap gap-2 bg-base-100 pt-1">
        <button type="button" data-baah-question-choice="submit" className="btn btn-primary btn-sm" onClick={submitAll}>
          Antworten
        </button>
        <button
          type="button"
          data-baah-question-choice="dismiss"
          className="btn btn-outline btn-error btn-sm"
          onClick={() => state.dismiss(card.id)}
        >
          Karte verwerfen
        </button>
      </div>
      <p className="mt-1 text-xs opacity-70">
        Verwerfen ist eine Entscheidung, kein Fehler: der Agent macht mit der wahrscheinlichsten Annahme
        weiter und sagt, welche. Er stellt die Frage in diesem Turn nicht noch einmal.
      </p>
    </section>
  );
}

/** Subscribe to the channel's card. One `useState`, no external store library. */
function useQuestion(state: QuestionChannelState): QuestionChannelState["current"] {
  const [card, setCard] = useState<QuestionChannelState["current"]>(state.current);
  useEffect(() => {
    // The channel holds a promise that outlives this component, so the subscription
    // is set up on mount and torn down on unmount — a card that outlives its
    // component would leave the tool waiting on an answer nobody can give.
    setCard(state.current);
    return state.subscribe(() => setCard(state.current));
  }, [state]);
  return card;
}

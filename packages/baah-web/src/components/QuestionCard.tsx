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
      <section
        data-baah-question="unreadable"
        data-baah-question-id={card.id}
        role="alert"
        className="my-2 rounded-box border-2 border-error/70 bg-error/10 p-3"
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
      className="my-2 rounded-box border-2 border-info/70 bg-info/10 p-3"
    >
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

      <div className="mt-3 flex flex-wrap gap-2">
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

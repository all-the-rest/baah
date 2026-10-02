/**
 * The transcript: messages, their parts, and the four things that must not be
 * confused with each other.
 *
 * ## What is rendered, and from where
 *
 * Two sources, joined by `messageId` and never by position — see
 * `lib/transcript.ts` for why. This file is the *drawing*: every decision it makes
 * about what to show was made there and is testable without a DOM.
 *
 * ## The five things that must each look different
 *
 * | thing | why it must not look like anything else |
 * |---|---|
 * | a `turn-stopped` | a user stop, never a timeout. Rendering it as one was a real bug. |
 * | a `StallReport` | a **waiting state** with `silentForMs`, never a failure, never a verdict |
 * | a `tool-outcome-unknown` | neither success nor failure — the effect is genuinely unknown |
 * | a `config-error` / missing key | points at the **key**, not at the transcript |
 * | a `storage-warning` | a warning about bookkeeping; the turn itself is fine |
 *
 * Each has its own element and its own `data-baah-*` marker, so a spec can assert
 * the distinction and so a user can see it.
 *
 * ## A `streaming` part is shown, not hidden
 *
 * `Plan.md` §16.1: a read may be up to one flush interval (100 ms) behind, and a
 * live part comes back **with its text**. Rendering a sentence that will still grow
 * — marked, visibly in flight — is honest; rendering nothing until the part closes
 * makes the app look broken for a reason it has not got.
 */
import type { AgentEvent } from "@all-the.rest/baah-core";
import type { RuntimeState, TranscriptRead } from "../runtime/index.ts";
import type { StallReport } from "../runtime/watchdog.ts";
import { TEST_ATTRIBUTES, TEST_IDS } from "../lib/testids.ts";
import { PROVENANCE_ATTRIBUTE, provenanceLabel, provenanceTitle } from "./lib/trust.ts";
import {
  EMPTY_LIVE_TURN,
  roleOf,
  transcriptModel,
  type LiveTurn,
  type TranscriptModel,
} from "./lib/transcript.ts";
import type { RenderPart } from "./lib/parts.ts";
import { ToolCard } from "./ToolCard.tsx";
import { ApprovalCard, approvalViewFromState, type AlwaysGrant, type ApprovalCardProps } from "./ApprovalCard.tsx";
import { turnBanner, type TurnBanner } from "./lib/turn-view.ts";

export interface TranscriptProps {
  readonly state: RuntimeState;
  readonly live: LiveTurn;
  readonly read: TranscriptRead | undefined;
  readonly stop: StallReport | undefined;
  readonly answerApproval: (approvalId: string, approved: boolean) => void;
  /** `always`: store the grant before resuming, so the promise the button makes holds. */
  readonly grantAlways: (grant: AlwaysGrant) => void;
}

/** The scrollable transcript. */
export function Transcript(props: TranscriptProps) {
  const model = transcriptModel({ read: props.read, live: props.live });
  const banner = turnBanner(props.state, props.stop);
  const approval = approvalViewFromState(props.live, props.state);

  return (
    /*
     * ## The three-way vertical budget of the chat column
     *
     * The column is `flex flex-col` and holds the header, this section, the question
     * card and the composer. Only two of the three scrollable things may shrink at
     * will, and the budget has to be stated in one place or the third one eats it:
     *
     * | element | rule | why |
     * |---|---|---|
     * | this section | `min-h-[10.5rem] flex-1` | grows into the slack, never below the floor |
     * | question card | `max-h-[45vh] min-h-[10rem] shrink overflow-y-auto` (`QuestionCard.tsx`) | scrolls its own content |
     * | composer | `shrink-0` (`ChatView.tsx`) | the row a user types into; its height is its content |
     *
     * `min-h-0` alone is what let the transcript collapse to **24 px** while holding
     * 159 px of content: `flex-1` sets `flex-basis: 0`, so the transcript is *pure*
     * slack receiver, and the card — which had `min-height: auto` and therefore
     * refused to shrink — handed it the whole deficit. Measured on the built app
     * before this change, both at 1280×800 and at 390×844.
     *
     * So the floor is the load-bearing half, and it **replaces** `min-h-0` rather than
     * being added next to it. Two `min-height` classes on one element is a coin flip:
     * which one wins is decided by the order the utilities happen to appear in the
     * stylesheet, not by the order they are written here. `min-h-[10.5rem]` still lets
     * the section shrink — `flex-1` is `flex: 1 1 0%`, so shrinking is unaffected by
     * the minimum — it only says where shrinking stops.
     *
     * **10.5 rem = 168 px, and the arithmetic behind it was wrong the first time.** The
     * first cut was 9.5 rem (152 px), reasoned as 120 px of transcript plus "the 24 px
     * status bar" — and 24 px is the height of the status **badge**, which is what
     * `elementFromPoint` at the badge's centre returns and therefore what the defect
     * report quoted. The bar itself measures **41 px** (`py-2` = 16, the badge's line
     * box 24, plus the 1-px border) at both viewports, so a floor built from the
     * badge was 17 px short: measured 111 px of transcript at 390×844, and the E2E
     * spec's 120 px assertion failed against a layout that looked right in a
     * screenshot. **A height read off a hit test is the badge's, not the box's.** The
     * number is now 120 + 41 + 2, rounded up to 168.
     *
     * The E2E spec (`e2e/question-card-layout.e2e.ts`) asserts its own **independent**
     * literal of 120 px against `[data-testid="baah-transcript"]`'s `clientHeight` — a
     * floor only enforced by the same constant that states it is not a floor.
     */
    <section className="flex min-h-[10.5rem] flex-1 flex-col" aria-label="Verlauf">
      <TurnStatusBar state={props.state} banner={banner} />

      <div
        data-testid={TEST_IDS.transcript}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        role="log"
        aria-live="polite"
      >
        {/*
         * The three "there is nothing here" cases, and they are **different**.
         * A failed read is not an empty conversation: `Plan.md` §16.1 says the
         * store rejects rather than answering with an empty transcript precisely so
         * this distinction can be made, and collapsing the two is the exact lie the
         * union exists to prevent.
         *
         * A **pending** read is a fourth thing and is not in that union at all: it is
         * a request outstanding, so it gets a neutral line rather than the warning
         * panel. The in-memory build never showed it because the read was a resolved
         * promise; real SQLite makes it a `postMessage` round trip to the worker, and
         * a loading state drawn as a warning is an error the user is asked to act on.
         */}
        {model.pending && (
          <p data-baah-read="pending" className="p-4 text-center text-sm opacity-70">
            Der Verlauf wird geladen …
          </p>
        )}

        {model.readProblem !== undefined && (
          <p
            data-baah-read="problem"
            className="rounded-box border border-warning/50 bg-warning/10 p-3 text-sm"
          >
            {model.readProblem}
          </p>
        )}

        {!model.pending && !model.readProblem && model.empty && (
          <p data-testid={TEST_IDS.transcriptEmpty} className="p-4 text-center text-sm opacity-70">
            Noch nichts in diesem Verlauf.
          </p>
        )}

        {model.truncated && (
          <p className="mb-2 rounded-box border border-base-300 p-2 text-xs opacity-80">
            Nur die letzten {""}Nachrichten geladen — ältere liegen in der Datenbank, sind hier aber nicht
            sichtbar.
          </p>
        )}

        {model.entries.map((entry, index) =>
          entry.kind === "message" ? (
            <MessageRow
              key={entry.id === "" ? `msg-${String(index)}` : entry.id}
              id={entry.id}
              role={entry.role}
              parts={entry.parts}
              /**
               * **No card on a stored row, and the reason is that it could not
               * work.**
               *
               * An approval is answerable only while the `AgentTurn` that opened it
               * is alive — `BaahRuntime.answerApproval` answers a card by
               * `AgentTurn.respondToApproval`, and after a reload that instance is
               * gone, so every button on a stored card would throw `turn-busy`. The
               * live fold is therefore the only source of an *open* card.
               *
               * Passing the card here as well also **rendered it twice** for a turn
               * that is merely parked: the same `toolCallId` is in the live fold and
               * in the stored row (the engine persists the `approval-requested` part
               * itself), and the card is matched by `toolCallId` — so one approval,
               * two identical sets of buttons, and a strict-mode violation in the
               * E2E suite. The duplication is the symptom; the dead buttons after a
               * reload are the defect.
               */
              approval={undefined}
              onAnswer={props.answerApproval}
              onAlways={props.grantAlways}
            />
          ) : (
            <LiveRow
              key="live"
              parts={entry.parts}
              approval={approval}
              onAnswer={props.answerApproval}
              onAlways={props.grantAlways}
            />
          ),
        )}

        {/*
         * The stall report is a **waiting state**, and it is rendered as one: a
         * spinner-free, non-error note with a stop button. `Plan.md` §5.4 and
         * `runtime/watchdog.ts` both say it never ends the turn, and a card with an
         * error colour would teach the user that a slow provider is a broken one.
         */}
        {props.stop !== undefined && <StallNote report={props.stop} />}
      </div>
    </section>
  );
}

function MessageRow({
  id,
  role,
  parts,
  approval,
  onAnswer,
  onAlways,
}: {
  id: string;
  role: string;
  parts: readonly RenderPart[];
  approval: ApprovalCardProps | undefined;
  onAnswer: (approvalId: string, approved: boolean) => void;
  onAlways: (grant: AlwaysGrant) => void;
}) {
  const kind = roleOf(role);
  const isIdle = role === "idle";

  return (
    <article
      data-testid={TEST_IDS.transcriptMessage}
      {...{ [TEST_ATTRIBUTES.messageRole]: kind }}
      {...(id === "" ? {} : { [TEST_ATTRIBUTES.messageId]: id })}
      className={`mb-3 flex flex-col gap-1 ${isIdle ? "opacity-70" : ""}`}
    >
      {isIdle ? null : (
        <span data-testid={TEST_IDS.transcriptMessageRole} className="text-xs font-semibold opacity-60">
          {kind === "user" ? "Du" : kind === "assistant" ? "Assistent" : "System"}
        </span>
      )}
      {parts.map((part, index) => (
        <PartView
          key={partIndex(part, index)}
          part={part}
          approval={approval}
          onAnswer={onAnswer}
          onAlways={onAlways}
        />
      ))}
      {isIdle && <IdleOutcome role={role} />}
    </article>
  );
}

function LiveRow({
  parts,
  approval,
  onAnswer,
  onAlways,
}: {
  parts: readonly RenderPart[];
  approval: ApprovalCardProps | undefined;
  onAnswer: (approvalId: string, approved: boolean) => void;
  onAlways: (grant: AlwaysGrant) => void;
}) {
  return (
    <article
      data-testid={TEST_IDS.transcriptMessage}
      {...{ [TEST_ATTRIBUTES.messageRole]: "assistant" }}
      data-baah-live="true"
      className="mb-3 flex flex-col gap-1"
    >
      {parts.map((part, index) => (
        <PartView
          key={partIndex(part, index)}
          part={part}
          approval={approval}
          onAnswer={onAnswer}
          onAlways={onAlways}
        />
      ))}
    </article>
  );
}

/** A stable key. Tool cards key on the `toolCallId`; text on its position. */
function partIndex(part: RenderPart, index: number): string {
  return part.kind === "tool" ? `tool-${part.toolCallId}-${String(index)}` : `part-${String(index)}`;
}

/** One part. Three types, and an explicit note for a fourth. */
function PartView({
  part,
  approval,
  onAnswer,
  onAlways,
}: {
  part: RenderPart;
  approval: ApprovalCardProps | undefined;
  onAnswer: (approvalId: string, approved: boolean) => void;
  onAlways: (grant: AlwaysGrant) => void;
}) {
  switch (part.kind) {
    case "text":
      return (
        <div data-testid={TEST_IDS.transcriptText} className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {part.text}
          {part.inFlight && <InFlight />}
        </div>
      );
    case "reasoning":
      // Collapsed by default and always labelled. The model's thinking is not the
      // user-facing answer (`Plan.md` §5.1: a reasoning delta persisted as text
      // shows deliberation as if it were a statement), so it is visually
      // subordinate and never mistaken for the answer.
      return (
        <details className="rounded-box border border-base-300/60 bg-base-200/30 px-2 py-1 text-xs">
          <summary className="cursor-pointer opacity-70">Denkprozess des Modells</summary>
          <div className="mt-1 whitespace-pre-wrap break-words opacity-80">{part.text}</div>
        </details>
      );
    case "tool": {
      // The approval card is **inside** the tool card, because the card is about
      // this call: same `toolCallId`, same input, one thing to read.
      const card = approval !== undefined && approval.toolCallId === part.toolCallId ? approval : undefined;
      return (
        <>
          <ToolCard part={part} />
          {/*
           * The card is spread **without** its own `onAnswer` and given both
           * handlers explicitly, so a card can never answer itself while skipping
           * the grant. The ordering (`onAlways` before `onAnswer`) is the card's
           * own business and is documented there.
           */}
          {card !== undefined && (
            <ApprovalCard
              {...card}
              onAnswer={onAnswer}
              {...(onAlways === undefined ? {} : { onAlways })}
            />
          )}
        </>
      );
    }
    case "unsupported":
      return (
        <p data-baah-unsupported-part={part.type} className="text-xs opacity-60">
          Ein Part-Typ, den diese Version nicht kennt: <code>{part.type}</code>.
        </p>
      );
  }
}

/** The marker for a part that is still being written. */
function InFlight() {
  return (
    <span
      data-baah-inflight="true"
      aria-label="wird gerade geschrieben"
      role="status"
      className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-info align-middle"
    />
  );
}

function IdleOutcome({ role }: { role: string }) {
  return (
    <span {...{ [TEST_ATTRIBUTES.outcome]: "idle" }} className="text-xs opacity-60">
      Turn-Ende: {role === "idle" ? "idle" : role}
    </span>
  );
}

/**
 * The turn's own state: outcome, attempts, steps.
 *
 * `Plan.md` §5.4 requires the attempts to be **visible** — "Versuch 2 von 3" — and
 * a silent retry is unhelpful precisely when the failure is hard to diagnose. The
 * numbers come from the engine's `attempt-started` and `step-end` events, so they
 * are facts rather than a second guess at when something happened.
 */
function TurnStatusBar({ state, banner }: { state: RuntimeState; banner: TurnBanner }) {
  return (
    /*
     * `shrink-0`, and it is **defence in depth, currently inert** — stated here so it
     * is not mistaken for a rule something depends on.
     *
     * ⚠️ **Measured, twice, and the second time it corrected the first.** Removing this
     * class leaves all seven tests of `e2e/question-card-layout.e2e.ts` green at
     * 1280×800, 390×844 and 844×390, and it changes **no** measured number at any of
     * them: the bar measures 41 px (`py-2` 16 + the badge's 24-px line box + a 1-px
     * border) with and without the class.
     *
     * The mechanism an earlier version of this comment gave was wrong. It said the bar
     * "is the child the browser would squash first" — but a flex item's *automatic
     * minimum size* is already its content height, so it cannot be squashed below 41 px
     * in the first place, and no explicit `min-height` is set here to change that. What
     * `shrink-0` removes is the possibility that something later gives this box a
     * smaller `min-height`, or adds a row that may collapse; `ChatView.tsx`'s comment on
     * its own `shrink-0` says the same thing for the same reason.
     *
     * The section's `min-h-[10.5rem]` **is** the tested rule, and `READABLE_TRANSCRIPT_PX`
     * in the E2E spec is what enforces it.
     */
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-base-300 px-4 py-2 text-xs">
      {/*
       * Two attributes, deliberately. `data-baah-status` mirrors
       * `RuntimeState.status` verbatim — that is the engine's own fact, and a spec
       * waits on it. `data-baah-outcome` carries the *turn's* outcome, which is a
       * different value: a turn can be `running` and already be `awaiting-approval`.
       * Collapsing them would make "the turn ended" unassertable, which is the one
       * thing every scenario here needs to state.
       */}
      <span
        data-testid={TEST_IDS.turnStatus}
        data-baah-status={state.status}
        {...{ [TEST_ATTRIBUTES.outcome]: state.status }}
        className="badge badge-ghost"
      >
        {state.status === "running" ? "Turn läuft" : "bereit"}
      </span>
      {banner.outcome !== undefined && (
        <span data-testid={TEST_IDS.turnStatusOutcome} {...{ [TEST_ATTRIBUTES.outcome]: banner.outcome }} className="badge badge-outline">
          {banner.outcome}
        </span>
      )}
      {banner.attempts !== undefined && (
        <span data-testid={TEST_IDS.turnStatusAttempts} className="opacity-70">
          {banner.attempts}
        </span>
      )}
      {banner.steps !== undefined && <span className="opacity-70">{banner.steps}</span>}
      {banner.stop !== undefined && (
        <span data-baah-stop-stage={banner.stop.stage} className="badge badge-ghost">
          {banner.stop.message}
        </span>
      )}
      {banner.hitStepLimit && (
        <span className="badge badge-warning">Step-Limit erreicht — die Antwort ist unvollständig</span>
      )}
      {banner.pointsAtKey && (
        // The key is the fix, and the affordance says so. A user who reads this
        // and looks in the transcript finds nothing, because the transcript is not
        // where the problem is (`Plan.md` §9: the SDK reads no environment).
        <span data-baah-points-at="key" className="badge badge-error">
          Kein API-Key hinterlegt — in den Einstellungen eintragen
        </span>
      )}
    </div>
  );
}

/**
 * The stall report.
 *
 * A **waiting state**, with the measurement and a stop button. Not an error, not
 * a timeout verdict: `Plan.md` §5.4 says a stall is a waiting state plus a manual
 * action and never an automatic one, and `runtime/watchdog.ts` says the report
 * carries no classification and cannot end the turn.
 */
function StallNote({ report }: { report: StallReport }) {
  const seconds = Math.round(report.silentForMs / 100) / 10;
  return (
    <p
      data-testid={TEST_IDS.stallWarning}
      data-baah-stall="waiting"
      role="status"
      className="mt-2 rounded-box border border-info/50 bg-info/10 p-2 text-xs"
    >
      Der Provider antwortet seit {seconds.toLocaleString("de-DE", { maximumFractionDigits: 1 })} s nicht.
      Das ist eine Warteanzeige, kein Fehler — der Turn läuft weiter, und baah bricht ihn nicht von selbst ab.
    </p>
  );
}

/** Re-exported so a spec can import the whole vocabulary from one place. */
export { TEST_ATTRIBUTES, TEST_IDS, PROVENANCE_ATTRIBUTE, provenanceLabel, provenanceTitle };
export { EMPTY_LIVE_TURN };
export type { AgentEvent, TranscriptModel };

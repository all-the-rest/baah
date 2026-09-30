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
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Verlauf">
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
         */}
        {model.readProblem !== undefined ? (
          <p
            data-baah-read="problem"
            className="rounded-box border border-warning/50 bg-warning/10 p-3 text-sm"
          >
            {model.readProblem}
          </p>
        ) : model.empty ? (
          <p data-testid={TEST_IDS.transcriptEmpty} className="p-4 text-center text-sm opacity-70">
            Noch nichts in diesem Verlauf.
          </p>
        ) : null}

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
              approval={approval}
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
    <div className="flex flex-wrap items-center gap-2 border-b border-base-300 px-4 py-2 text-xs">
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

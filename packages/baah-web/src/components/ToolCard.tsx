/**
 * The tool card: one tool invocation, from `input-available` to its outcome.
 *
 * ## What a card has to get right, in order
 *
 * 1. **The state is the headline.** `Plan.md` §15.5 asks for `running` /
 *    `approval-requested` / `output-available` / `output-error` to be
 *    distinguishable, and the state is the *first* thing rendered so a glance
 *    answers it. The SDK's own identifiers are not shown; the German label is,
 *    and `lib/testids.ts` says a spec must be able to assert the state as text
 *    rather than by parsing a class.
 * 2. **`searchTruncated` is shown.** `grep` and `glob` can both report an
 *    incomplete search that *looks* complete (`Plan.md` §4, §16.1). A card that
 *    renders the results without the flag turns the model's confident wrong answer
 *    into an apparently authoritative one, so the warning is above the output and
 *    is never suppressed for a small result set.
 * 3. **The output is untrusted.** It is a file's content, a directory listing, a
 *    search result. `Plan.md` §4.1's injection surface. It is rendered as text —
 *    React escapes it and this component never uses `dangerouslySetInnerHTML` — and
 *    it is marked as coming from a tool, not from the agent.
 * 4. **A file diff is metadata, not a fourth part type.** `Plan.md` §6.1 and
 *    §14.3: `edit`/`write` put `metadata.files` on the tool part. There is no
 *    diff part type in this build, and the one in the table is not introduced here.
 */
import type { RenderPart } from "./lib/parts.ts";
import { TEST_ATTRIBUTES, TEST_IDS } from "../lib/testids.ts";
import { PROVENANCE_ATTRIBUTE, provenanceLabel, provenanceTitle } from "./lib/trust.ts";

/** A card's outcome tone. `unknown` is deliberately distinct from `error`. */
type CardTone = "idle" | "running" | "waiting" | "done" | "error" | "denied" | "unknown";

function toneFor(part: Extract<RenderPart, { kind: "tool" }>): CardTone {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return "running";
    case "approval-requested":
    case "approval-responded":
      return "waiting";
    case "output-available":
      return "done";
    case "output-error":
      return "error";
    case "output-denied":
      return "denied";
  }
}

const TONE_CLASS: Readonly<Record<CardTone, string>> = {
  idle: "border-base-300 bg-base-200/40",
  running: "border-info/60 bg-info/10",
  waiting: "border-warning/60 bg-warning/10",
  done: "border-success/60 bg-success/10",
  error: "border-error/60 bg-error/10",
  denied: "border-base-300 bg-base-300/20",
  unknown: "border-warning/60 bg-warning/10",
};

/**
 * One tool card.
 *
 * Collapsed by default once it has an output, and expanded while it is waiting or
 * running: a finished `read` of a 400-line file must not push the conversation
 * off the screen, and a pending approval must be impossible to scroll past.
 */
export function ToolCard({ part, defaultExpanded }: { part: RenderPart; defaultExpanded?: boolean }) {
  if (part.kind !== "tool") return null;
  const tone = toneFor(part);
  const waiting = tone === "waiting";
  const expanded = defaultExpanded ?? (waiting || part.state === "output-error");

  return (
    <article
      data-testid={TEST_IDS.toolCard}
      data-baah-tool-card-tone={tone}
      /*
       * The call id as an attribute, so a spec can address one card among several.
       * `lib/testids.ts` puts the id in the card's own text and in
       * `data-baah-tool-call-id`; this is the same value under a card-scoped name,
       * because the transaction a spec makes is "the card for *this* call".
       */
      {...{ [TEST_ATTRIBUTES.toolCallId]: part.toolCallId }}
      data-baah-tool-card-id={part.toolCallId}
      className={`rounded-box border ${TONE_CLASS[tone]} p-3 text-sm`}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span data-testid={TEST_IDS.toolCardName} className="font-mono font-semibold">
          {part.toolName}
        </span>
        {/*
         * The state as text, in the element `lib/testids.ts` names. Not a class,
         * not a colour: a spec asserts this, and a Tailwind upgrade cannot change
         * it.
         */}
        <span data-testid={TEST_IDS.toolCardState} className="opacity-80">
          {part.stateLabel}
        </span>
        {part.toolCallId !== "" && (
          <span className="ml-auto font-mono text-xs opacity-50">{part.toolCallId}</span>
        )}
      </header>

      {waiting && (
        <p className="mt-2 text-xs opacity-80">
          Der Turn wartet auf dich. Solange die Karte offen ist, ruft baah das Modell nicht erneut auf.
        </p>
      )}

      {part.truncation !== undefined && (
        // Above the output, and unconditional. `searchTruncated: true` means the
        // search looked complete and was not (Plan.md §16.1), and the whole cost
        // of this component is that the user learns it here rather than from a
        // wrong answer three turns later.
        <p
          data-baah-truncation={part.truncation.field}
          className="mt-2 rounded-field border border-warning/50 bg-warning/15 px-2 py-1 text-xs"
        >
          {part.truncation.message}
        </p>
      )}

      {part.errorText !== undefined && part.errorText !== "" && (
        <p data-testid={TEST_IDS.toolCardError} className="mt-2 text-xs text-error">
          {part.errorText}
        </p>
      )}

      {part.diffs.length > 0 && (
        <ul className="mt-2 space-y-1">
          {part.diffs.map((diff) => (
            <li key={diff.file} className="font-mono text-xs">
              <span className="font-semibold">{diff.file}</span>
              {diff.status !== undefined && <span className="opacity-70"> — {diff.status}</span>}
              {diff.additions !== undefined && <span className="text-success"> +{String(diff.additions)}</span>}
              {diff.deletions !== undefined && <span className="text-error"> −{String(diff.deletions)}</span>}
            </li>
          ))}
        </ul>
      )}

      <details className="mt-2" open={expanded}>
        <summary className="cursor-pointer text-xs opacity-70">Eingabe und Ausgabe</summary>
        {part.input !== "" && (
          <Section title="Eingabe" body={part.input} />
        )}
        {part.output !== undefined && (
          // Marked as tool-authored, and the marker says *why*: the content came
          // from a file, not from the agent's own reasoning. A user reading a
          // prompt-injection attempt in a README needs to see which side of the
          // line it is on.
          <Section
            title="Ausgabe"
            body={part.output}
            provenance={part.outputProvenance}
            provenanceTitle={provenanceTitle(part.outputProvenance)}
          />
        )}
      </details>
    </article>
  );
}

function Section({
  title,
  body,
  provenance,
  provenanceTitle: title2,
}: {
  title: string;
  body: string;
  provenance?: "untrusted" | "tool-authored" | "user" | "model" | "app";
  provenanceTitle?: string;
}) {
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold opacity-70">{title}</span>
        {provenance !== undefined && (
          <span
            {...{ [PROVENANCE_ATTRIBUTE]: provenance }}
            title={title2}
            className="badge badge-ghost badge-xs"
          >
            {provenanceLabel(provenance)}
          </span>
        )}
      </div>
      {/*
       * `whitespace-pre-wrap` + `overflow-x-auto` and nothing else. React escapes
       * every interpolated string, so this is text — a file that contains
       * `<script>` renders as those seven characters, which is the property the
       * whole trust section is about.
       */}
      <pre className="mt-1 max-h-72 overflow-auto rounded-field bg-base-300/40 p-2 text-xs whitespace-pre-wrap break-words">
        {body}
      </pre>
    </div>
  );
}

/** The `data-baah-*` attributes a spec may rely on, re-exported for convenience. */
export { TEST_ATTRIBUTES, TEST_IDS };

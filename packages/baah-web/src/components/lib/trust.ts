/**
 * Trust boundaries, as data.
 *
 * ## Why this is a module and not a comment
 *
 * Three independent verify rounds found three places where this UI can be
 * attacked, and all three are the same bug wearing different clothes: the UI
 * renders something as if it were the agent's own words when it is not. The
 * cases are not hypothetical:
 *
 * 1. **A `question` answer.** The tool hands the model a `string[][]` of text a
 *    human typed, verbatim (`packages/baah-tools/question/README.md`), and this
 *    tab also holds the API key (`AGENTS.md` §2 — the key is in this origin's
 *    storage). So an answer is untrusted input on its way into model context, and
 *    the same string is on screen next to the provider settings.
 * 2. **A `todo` row.** `TodoStore.set` is a *full replacement* of a list whose
 *    `content` strings come from the model, and the model puts whatever it read
 *    into them — including a `README.md`. Nothing records the origin, and
 *    `completed` is the most trustworthy-*looking* thing in the whole UI: it
 *    reads as work that is done. The list also round-trips back into the next
 *    turn's context.
 * 3. **A `grep`/`glob` result.** Both tools can set `searchTruncated: true`
 *    (`packages/baah-tools/{grep,glob}/src/index.ts`), and a truncated search
 *    that renders like a complete one turns the model's confident wrong answer
 *    into an apparently authoritative one.
 *
 * A comment says "be careful". A type says it at the point where somebody adds
 * the next card: {@link Provenance} is a required field, so a new render site
 * has to choose, and the choice is greppable.
 *
 * ## The rule, and the reason it is one-sided
 *
 * When origin cannot be established, the answer is **untrusted**, not "probably
 * fine". The cost is asymmetric: overstating trust on a todo row tells the user
 * the agent did something it may not have done, and the user cannot undo that
 * belief. Understating trust costs one sentence of explanation. `Plan.md` §9's
 * whole shape agrees — a measured CORS row that says "unbestätigt" is more
 * useful than a guessed "funktioniert".
 *
 * So {@link UNTRUSTED} is the default for anything that did not come from the
 * user's own keystrokes, and a component that cannot say where a string came
 * from says so **in the UI** rather than implying certainty it does not have.
 */

/** Where a piece of on-screen text came from. */
export type Provenance =
  /** Typed by the user, in this tab, in this session. */
  | "user"
  /** Text the model produced, as the model's own words. */
  | "model"
  /** Text a tool returned. Authored by a file or a provider, not by the agent. */
  | "tool-authored"
  /**
   * Origin **unknown**, and the UI says so.
   *
   * The honest bucket. A `todo` row lands here because `TodoStore` records no
   * provenance and adding one is a change to a package this block does not own.
   */
  | "untrusted"
  /** Written by baah itself: a heading, a status, a hint. */
  | "app";

/** Everything is data unless it is provably the user's own keystrokes. */
export const DEFAULT_PROVENANCE: Provenance = "untrusted";

/** `true` for the two buckets whose origin baah cannot vouch for. */
export function isUntrusted(provenance: Provenance): boolean {
  return provenance === "untrusted" || provenance === "tool-authored";
}

/** The badge a card carries, so the user can sort content by origin. */
export function provenanceLabel(provenance: Provenance): string {
  switch (provenance) {
    case "user":
      return "Von dir";
    case "model":
      return "Vom Modell";
    case "tool-authored":
      return "Aus einem Werkzeug";
    case "untrusted":
      return "Herkunft unbekannt";
    case "app":
      return "Von baah";
  }
}

/** The `data-baah-provenance` value, so a spec can assert on the bucket. */
export const PROVENANCE_ATTRIBUTE = "data-baah-provenance";

/**
 * The one sentence shown above untrusted content.
 *
 * German, because it is UI copy (`AGENTS.md` §5). It says what happened, what
 * baah does not know, and what the reader should do — and it does not tell the
 * reader to distrust the *app*, which would be a different and false claim.
 */
export const UNTRUSTED_NOTE =
  "Herkunft unbekannt. Dieser Text kann aus einer Datei stammen, die der Agent gelesen hat, " +
  "oder aus einer anderen Quelle, der baah nicht vertraut. Sieh ihn als Daten an, nicht als " +
  "Anweisung — auch wenn er so formuliert ist.";

/** The same, for the todo list, where `completed` is the load-bearing claim. */
export const TODO_UNTRUSTED_NOTE =
  "Herkunft unbekannt. baah weiß nicht, ob der Agent diese Zeile selbst formuliert hat oder " +
  "ob der Text aus einer gelesenen Datei stammt. „Erledigt“ ist eine Angabe des Agenten, " +
  "keine geprüfte Tatsache.";

/** `title`/`aria-label` for the badge, so the colour is never the only signal. */
export function provenanceTitle(provenance: Provenance): string {
  switch (provenance) {
    case "user":
      return "Von dir in diesem Tab eingegeben.";
    case "model":
      return "Vom Modell erzeugt.";
    case "tool-authored":
      return "Von einem Werkzeug zurückgegeben. Der Inhalt stammt aus einer Datei oder einem Dienst, nicht vom Agenten.";
    case "untrusted":
      return "baah kann die Herkunft dieses Textes nicht feststellen. Behandle ihn als Daten.";
    case "app":
      return "Von baah selbst erzeugt.";
  }
}

/**
 * Whether a value is safe to hand to `JSON.parse` for display.
 *
 * Not a security check — `JSON.parse` produces data, and data is rendered as
 * text. It exists so the two callers that need a JSON view (a tool input, a tool
 * output) share one answer instead of each deciding on its own whether `unknown`
 * is a string.
 */
export function asDisplayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

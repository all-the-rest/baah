/**
 * Identifiers and timestamps.
 *
 * AGENTS.md §5: ids are `crypto.randomUUID()`, timestamps are ISO-8601 strings
 * (sortable). Both helpers exist so that rule has exactly one implementation in
 * the web package — the same reason the core loop carries its own copy.
 *
 * The last helper here is the one that makes `Plan.md` §1's DoD 4 reachable: a
 * session id that is minted per document is a session the user can never see again
 * after a reload, however durably the rows are stored.
 */
import type { KeyValueBackend } from "./storage.ts";

/**
 * The fallback's counter.
 *
 * Module scope, not a field on anything: `newId` is a free function and a per-call
 * counter would start at zero every time, which is the same defect as no counter at
 * all. It is the one piece of mutable state in this file and it is deliberate.
 */
let fallbackCounter = 0;

/**
 * A prefixed id.
 *
 * The prefix is not decoration: `flushDelta` keys on `deltaId`, the store's
 * tool-call key on `(sessionId, attempt, toolCallId, occurrence)`, and a debug
 * reader looking at a row has to be able to tell a turn id from a part id
 * without a schema lookup.
 *
 * ## The fallback, and why it is a counter
 *
 * `crypto.randomUUID` is the rule (AGENTS.md §5) and a missing WebCrypto is a
 * degraded browser, not a crash — so there is a fallback. The fallback used to be
 * `Date.now()` plus `Math.trunc(performance.now() * 1000)`, and that is **wrong in a
 * way that only shows up in the environment the fallback exists for**:
 *
 * - `performance.now()` is measured **relative to page load**, so it is not a clock
 *   and not monotonic in wall-clock terms. Two calls in the same millisecond
 *   produce the same `performance.now()` reading and therefore the *same id*.
 * - Two calls in the same millisecond is not an edge case here. `newId("turn")` is
 *   called at the top of every turn, and a user who hits send twice, or a
 *   reconciliation pass that mints a turn id and a part id back to back, is
 *   exactly that. Duplicate **turn ids** are the worst outcome available: the store
 *   keys recovery on `turnId`, so two turns sharing one are recovered as one.
 * - `Math.trunc(performance.now() * 1000)` also *quantises*: `performance.now()` is
 *   clamped to 100 µs in Chromium, so `× 1000` can only ever produce 100 distinct
 *   values per 10 ms, and the low digits it does produce are the ones most likely to
 *   be equal between two ids minted close together.
 *
 * So the fallback is a monotonic counter appended to the timestamp. It is unique
 * within a document by construction, and the timestamp keeps the ids sortable —
 * which is the property `nowIso` exists for and the reason ids are prefixed.
 *
 * What it is still *not*: unique across tabs. Neither was the old one, and that is
 * why only in-process ids are minted here.
 */
export function newId(prefix: string): string {
  const cryptoRef = globalThis.crypto;
  const uuid = typeof cryptoRef?.randomUUID === "function" ? cryptoRef.randomUUID() : undefined;
  if (uuid !== undefined) return `${prefix}-${uuid}`;
  fallbackCounter += 1;
  const time = Date.now().toString(36);
  return `${prefix}-${time}-${fallbackCounter.toString(36)}`;
}

/** An ISO-8601 timestamp, from an injectable clock. */
export function nowIso(now: () => number = Date.now): string {
  return new Date(now()).toISOString();
}

/**
 * The key a provider's API key is stored under.
 *
 * The composite form is `vendor:name` for an `openai-compatible` entry, because
 * a user can have three of those at once (Groq, xAI, Together) and one flat
 * `openai-compatible` slot would overwrite the others in a way that only shows up
 * when the wrong provider answers. Mirrors `ProviderSettings.name` being a label
 * rather than a URL (`provider/registry.ts`).
 *
 * ## It splits before it joins, and that is load-bearing
 *
 * A stored selection holds `vendor: "openai-compatible:groq"` — the registry's own
 * composite id, which `parseVendorId` splits on the **first** colon. So the name is
 * already inside `vendor` when the caller got it from the settings. Re-joining
 * without splitting first produces `openai-compatible:groq:groq`, which is a slot
 * nothing ever writes and which therefore reports "no key" for a key the user
 * definitely entered. Making the function idempotent removes the whole class: the
 * two callers (the runtime's provider read and the probe) can pass either the
 * composite id or a vendor plus a name and land in the same place.
 */
export function apiKeySlot(vendor: string, name?: string | undefined): string {
  const separator = vendor.indexOf(":");
  const vendorPart = separator < 0 ? vendor : vendor.slice(0, separator);
  const suffix = name ?? (separator < 0 ? "" : vendor.slice(separator + 1));
  return suffix === "" ? vendorPart : `${vendorPart}:${suffix}`;
}

/** The default key the current session id is stored under. */
export const SESSION_ID_KEY = "baah.session.v1";

/** What `resolveSessionId` did, so a caller can say it out loud if it must. */
export interface SessionIdResolution {
  readonly sessionId: string;
  /** `true` when the id came out of storage — i.e. this is a returning user. */
  readonly restored: boolean;
  /** Set when the stored value was unusable, or writing the new one failed. */
  readonly degraded: string | undefined;
}

/** `session-…`, the prefix `newId("session")` produces. */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9-]+$/;

/**
 * The session this browser talks to, across reloads.
 *
 * ## Why the id has to be remembered at all
 *
 * SQLite rows that outlive the tab are worth nothing to a user who cannot get back
 * to them. `openDatabase()` gives durability; **this** gives reachability: after a
 * reload the app must ask the read port about the *same* `sessionId`, or it opens a
 * fresh session and renders an empty transcript beside a database full of the
 * previous conversation. `Plan.md` §1 DoD 4 is "survives a reload", and a row no
 * query can reach does not survive it.
 *
 * It is `localStorage` rather than a `settings` row, deliberately. `lib/storage.ts`
 * says why settings are not in SQLite — a second path into the database — and the
 * same argument applies here with more force: this is one pointer, it is read before
 * the database is open, and putting it in the database would make the database
 * depend on the database.
 *
 * ## A hostile stored value is treated as no value
 *
 * `readTranscript` refuses a session that does not exist rather than answering "no
 * messages" (§16.1), so a corrupted id would leave the app permanently unable to
 * read anything. Anything that is not a `session-…` string inside our own JSON is
 * therefore **replaced**, not trusted, and {@link SessionIdResolution.degraded} says
 * so when there is something to say.
 *
 * Writing is best-effort and its failure is reported rather than swallowed: a browser
 * that refuses `setItem` is a browser where the next reload starts a new session, and
 * the user is entitled to know that before they lose a conversation.
 */
export function resolveSessionId(
  backend: KeyValueBackend,
  options: { readonly mint?: (() => string) | undefined; readonly now?: (() => number) | undefined } = {},
): SessionIdResolution {
  const mint = options.mint ?? (() => newId("session"));
  const stamp = new Date((options.now ?? Date.now)()).toISOString();

  let stored: string | undefined;
  let readProblem: string | undefined;
  try {
    stored = readSessionId(backend.read());
  } catch (cause) {
    // `read()` throws rather than answering "unset" for a browser with no storage at
    // all — that is a UI decision, not this function's. Here it only means "there is
    // nothing to restore", and the caller is told why in one line.
    readProblem = `Die gespeicherte Sitzung konnte nicht gelesen werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}.`;
  }

  if (stored !== undefined) {
    return { sessionId: stored, restored: true, degraded: readProblem };
  }

  const sessionId = mint();
  let writeProblem: string | undefined;
  try {
    backend.write(JSON.stringify({ sessionId, at: stamp }));
  } catch (cause) {
    writeProblem =
      `Die Sitzung konnte nicht gespeichert: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}. ` +
      "Nach einem Neuladen beginnt eine neue Sitzung, der Verlauf der alten bleibt zwar in der Datenbank, ist aber nicht mehr erreichbar.";
  }

  return {
    sessionId,
    restored: false,
    degraded: writeProblem ?? readProblem,
  };
}

/** The `sessionId` out of a value written by {@link resolveSessionId}. */
export function readSessionId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const sessionId = (parsed as { readonly sessionId?: unknown }).sessionId;
    return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined;
  } catch {
    // A value that is not our JSON is a value from something else. Not an error, and
    // not an `Error` either — the caller wants "is there a usable id here".
    return undefined;
  }
}

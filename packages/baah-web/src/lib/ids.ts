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

/**
 * The key the **per-project** session pointers live under.
 *
 * ## Why this is a second key and not a change of `SESSION_ID_KEY`
 *
 * `baah.session.v1` held one value: "the session this browser talks to". With
 * projects that is no longer a fact — a browser now has one session **per project**,
 * and opening project B must not cost project A's conversation. So the mapping is
 * project → session, and it is keyed by the project's own stable id (the one in
 * `.baah/project.json`), which is why the key can be a plain object.
 *
 * The old key is left alone and still read. Dropping it would make every existing
 * browser open an empty project on the next load, and the rows of the old session
 * would be unreachable — the exact "verwaist und unauffindbar" state
 * `Plan.md` §19.6 lists as missing. So {@link readLegacySessionId} is the migration
 * path, and it is used **once**, for the project a legacy pointer can name: none. A
 * legacy pointer has no project, so it is adopted as the *sandbox* project's session
 * and nothing else — which is the truth about it.
 */
export const PROJECT_SESSIONS_KEY = "baah.sessions.v2";

/**
 * The project id used for the browser's own sandbox workspace.
 *
 * The sandbox is a project too — its files live in the browser rather than on the
 * user's disk, and it has the same "one folder, many conversations" shape. Giving it
 * a reserved id rather than treating "no folder" as a special case means the session
 * lookup has exactly one code path, and it means the sandbox's conversation also
 * survives a reload: `localStorage["baah.session.v1"]` becomes this project's entry.
 *
 * A literal rather than a minted id, because there is exactly one sandbox per origin
 * and it must be the **same** project on every run.
 */
export const SANDBOX_PROJECT_ID = "opfs:sandbox";

/**
 * The two backends {@link resolveProjectSession} needs.
 *
 * **Two, not one, because `KeyValueBackend` is bound to a single key at construction**
 * (`createWebStorageBackend({ key })` in `lib/storage.ts`) and the project map and the
 * legacy pointer are two different keys. Widening the interface to `write(key, value)`
 * would have been the tidier shape and it is not available here: `lib/storage.ts` is
 * not this block's file, and a second `KeyValueBackend` costs one object.
 */
export interface ProjectSessionStores {
  /** Bound to {@link PROJECT_SESSIONS_KEY}. */
  readonly projects: KeyValueBackend;
  /** Bound to {@link SESSION_ID_KEY}, the pre-project single pointer. */
  readonly legacy: KeyValueBackend;
}

/** One project's remembered session, as stored. */
interface ProjectSessionPointer {
  readonly sessionId: string;
  readonly at: string;
}

const PROJECT_SESSIONS_PATTERN = /^\{[\s\S]*\}$/;

/** What {@link resolveProjectSession} did, so a caller can say it out loud. */
export interface ProjectSessionResolution {
  readonly sessionId: string;
  /** `true` when the id came out of storage — i.e. this is a returning user. */
  readonly restored: boolean;
  /**
   * `true` when the stored pointer was a **legacy** `baah.session.v1` value adopted
   * for the sandbox project.
   *
   * Its own flag because adopting it moves the pointer: the legacy key is written
   * once and then left for the record, so a second browser profile on the same
   * machine cannot end up adopting the same session into two different projects.
   */
  readonly adopted: boolean;
  /** Set when the stored value was unusable, or writing the new one failed. */
  readonly degraded: string | undefined;
}

/**
 * The session this browser uses **for one project**, across reloads.
 *
 * The same contract as {@link resolveSessionId} and the same reason it exists — a
 * durable row nothing can query has not survived anything — with one difference that
 * is the whole point: the lookup is by project, so two projects on one machine keep
 * two conversations instead of one overwriting the other's pointer.
 *
 * A hostile stored value is **replaced, not trusted**, exactly as in
 * {@link resolveSessionId}: `readTranscript` refuses a session that does not exist,
 * so a corrupted pointer would leave the app permanently unable to read anything. The
 * value is additionally checked to be a `session-…` string *and* to belong to the
 * project asked for — the map is keyed by project id, so a pointer filed under the
 * wrong project is as wrong as a malformed one.
 */
export function resolveProjectSession(
  stores: ProjectSessionStores,
  projectId: string,
  options: {
    readonly mint?: (() => string) | undefined;
    readonly now?: (() => number) | undefined;
  } = {},
): ProjectSessionResolution {
  const mint = options.mint ?? (() => newId("session"));
  const stamp = new Date((options.now ?? Date.now)()).toISOString();

  let stored: Readonly<Record<string, ProjectSessionPointer>> | undefined;
  let readProblem: string | undefined;
  try {
    stored = readProjectSessions(stores.projects.read());
  } catch (cause) {
    readProblem = `Die gespeicherten Sitzungen konnten nicht gelesen werden: ${
      cause instanceof Error ? cause.name : "unbekannter Fehler"
    }.`;
  }

  // The legacy pointer, read **before** the early return below and behind its own
  // `try`. Two reasons, and the second one is a bug this comment exists because of:
  //
  // 1. it is only *acted on* for the sandbox project, which is the narrow adoption
  //    rule below;
  // 2. `backend.read()` **throws** rather than answering "unset" for a browser with no
  //    storage at all (`lib/storage.ts`), so an unguarded read here rejects out of
  //    `createAppRuntime` and lands the user on the boot-failure screen — for a key
  //    that is a *migration input*, not the pointer the app runs on.
  let legacy: string | undefined;
  let legacyProblem: string | undefined;
  try {
    legacy = readLegacySessionId(stores.legacy.read());
  } catch (cause) {
    // Named as what it is: a pointer from **before** projects existed. It is not the one
    // the app runs on, so the sentence must not claim the conversation is lost — only
    // that one may be out there and unreachable.
    legacyProblem =
      "Die ältere gespeicherte Sitzung konnte nicht gelesen werden (" +
      `${cause instanceof Error ? cause.name : "unbekannter Fehler"}). ` +
      "Falls es noch eine Unterhaltung aus einer früheren Version gibt, ist sie über diesen Browser nicht erreichbar.";
  }

  const existing = stored?.[projectId];
  if (existing !== undefined) {
    // A legacy pointer that could not be read is worth saying out loud even though this
    // project has its own entry: we cannot rule out a pre-project conversation that
    // nothing points at any more. It is reported, never guessed at.
    return {
      sessionId: existing.sessionId,
      restored: true,
      adopted: false,
      degraded: readProblem ?? legacyProblem,
    };
  }

  // The legacy adoption, and it is deliberately narrow: **only** for the sandbox
  // project. A `baah.session.v1` pointer names a session that predates projects, so
  // it cannot be attributed to any folder — and attributing it to whichever folder
  // happens to be opened first would be a guess that moves a user's conversation
  // into an unrelated project.
  if (legacy !== undefined && projectId === SANDBOX_PROJECT_ID) {
    const writeProblem = writeProjectSessions(stores.projects, {
      ...(stored ?? {}),
      [projectId]: { sessionId: legacy, at: stamp },
    });
    return { sessionId: legacy, restored: true, adopted: true, degraded: writeProblem ?? readProblem ?? legacyProblem };
  }

  const sessionId = mint();
  const writeProblem = writeProjectSessions(stores.projects, {
    ...(stored ?? {}),
    [projectId]: { sessionId, at: stamp },
  });
  return {
    sessionId,
    restored: false,
    adopted: false,
    degraded: writeProblem ?? readProblem,
  };
}

/** Remember which session a project uses, without resolving anything. */
export function rememberProjectSession(
  stores: ProjectSessionStores,
  projectId: string,
  sessionId: string,
  now: () => number = Date.now,
): string | undefined {
  let stored: Readonly<Record<string, ProjectSessionPointer>> | undefined;
  try {
    stored = readProjectSessions(stores.projects.read());
  } catch (cause) {
    return `Die gespeicherten Sitzungen konnten nicht gelesen werden: ${
      cause instanceof Error ? cause.name : "unbekannter Fehler"
    }.`;
  }
  return writeProjectSessions(stores.projects, {
    ...(stored ?? {}),
    [projectId]: { sessionId, at: new Date(now()).toISOString() },
  });
}

/**
 * Parse the project→session map out of storage.
 *
 * **Total, and it never throws.** A value that is not our JSON, not an object, or
 * not a record of `{sessionId, at}` yields `undefined` — "there is nothing usable
 * here" — because every caller of this wants exactly one more attempt at the normal
 * path, and a thrown parse error in a click handler is a different failure than a
 * missing pointer. Each entry is validated **on its own**: one unusable project
 * pointer does not discard the other eleven.
 */
function readProjectSessions(raw: string | undefined): Readonly<Record<string, ProjectSessionPointer>> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const usable: Record<string, ProjectSessionPointer> = {};
  for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const candidate = value as { readonly sessionId?: unknown; readonly at?: unknown };
    if (typeof candidate.sessionId !== "string") continue;
    if (!SESSION_ID_PATTERN.test(candidate.sessionId)) continue;
    usable[projectId] = {
      sessionId: candidate.sessionId,
      at: typeof candidate.at === "string" ? candidate.at : "",
    };
  }
  return usable;
}

/**
 * Write the map back, or say why it could not be written.
 *
 * The failure text names the operation and never the value: a `setItem` error can
 * quote the payload, and the payload is a session id — harmless, but the rule here is
 * uniform and the cost of following it is one line. Returns `undefined` on success.
 */
function writeProjectSessions(
  backend: KeyValueBackend,
  sessions: Readonly<Record<string, ProjectSessionPointer>>,
): string | undefined {
  const body = JSON.stringify(sessions);
  // The pattern check is on the *container*, not the ids: a value that does not even
  // look like our JSON is not ours to overwrite. It is deliberately weak — the real
  // validation is `readProjectSessions` — because its only job is to avoid clobbering
  // something foreign that happens to live under our key.
  if (!PROJECT_SESSIONS_PATTERN.test(body)) {
    return "Die gespeicherten Sitzungen konnten nicht gespeichert werden: unerwartetes Format.";
  }
  try {
    backend.write(body);
    return undefined;
  } catch (cause) {
    return (
      `Die Sitzung konnte nicht gespeichert: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}. ` +
      "Nach einem Neuladen beginnt eine neue Sitzung, der Verlauf der alten bleibt zwar in der Datenbank, ist aber nicht mehr erreichbar."
    );
  }
}

/** The single-session pointer of the pre-project era, or `undefined`. */
function readLegacySessionId(raw: string | undefined): string | undefined {
  return readSessionId(raw);
}

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

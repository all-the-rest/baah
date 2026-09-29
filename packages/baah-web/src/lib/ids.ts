/**
 * Identifiers and timestamps.
 *
 * AGENTS.md §5: ids are `crypto.randomUUID()`, timestamps are ISO-8601 strings
 * (sortable). Both helpers exist so that rule has exactly one implementation in
 * the web package — the same reason the core loop carries its own copy.
 */

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

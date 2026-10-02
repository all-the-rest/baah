/**
 * The provider list the onboarding wizard offers.
 *
 * ## This list is `Plan.md` §9, and §9 is measured
 *
 * §9 is not a vendor wishlist; it is a table of observed CORS behaviour, and the
 * two rows that matter here are the awkward ones:
 *
 * - **OpenAI is in the list and marked `cors: "unconfirmed"`.** §9 measured that
 *   `GET /v1/models` answers with `access-control-allow-origin: *` even on a 401,
 *   while `POST /v1/chat/completions` and `POST /v1/responses` send **no ACAO on
 *   the error path**. Whether the success path sends one is untested — that needs
 *   a real key, and a key does not live in this repo. So OpenAI appears, it is
 *   marked as needing the connection test, and nothing here claims it works.
 * - **Anthropic is in the list with `requiresBrowserHeader: true`.** Without
 *   `anthropic-dangerous-direct-browser-access: true` its 401 carries no ACAO, so
 *   the browser turns a wrong key into an opaque `TypeError: Failed to fetch`. The
 *   SDK does not set the header; `provider/registry.ts` adds it; `probe.ts` sends
 *   it. Three places, one rule, and a test on each.
 * - **`anthropic-compatible` is in the list with `requiresBrowserHeader: false`,
 *   and that is the row that proves the rule above is about the *operator*.** The
 *   same three places are exercised for it, and every one of them asserts the
 *   header's **absence** — see the block below.
 *
 * ## OpenCode Zen is absent, and stays absent
 *
 * §9: Preflight `404`, error path without ACAO, "nicht möglich". It is not
 * browser-callable, so listing it would offer the user a choice that cannot work.
 * AGENTS.md §2 forbids the obvious workaround (a proxy) and §9 says "nicht darum
 * herum designen". There is no entry, and `providers/catalog.test.ts` asserts
 * there is none, so adding one is a decision somebody has to make on purpose.
 *
 * ## The openai-compatible row
 *
 * One row covers Groq, xAI, Mistral, Cerebras, Together and DeepSeek — all
 * measured `*` on both paths. They share the `openai-compatible` vendor in
 * `@ai-sdk/openai-compatible`, so they differ only in `baseUrl` and label. The
 * label is a label: `ProviderSettings.name` is never used as a URL
 * (`provider/registry.ts`), which is why this row has no base URL of its own.
 *
 * ## The anthropic-compatible row, and why it is a row and not a vendor
 *
 * A service that speaks `/v1/messages` at its own address could only be entered
 * as `openai-compatible` until this block, which posts `chat/completions` at it
 * — the wrong request to the wrong path, failing **silently** rather than
 * loudly. That is worse than not offering it: a user cannot tell a mistyped path
 * from a bad key.
 *
 * So it is a catalog row with its own id, `anthropic-compatible`, which speaks
 * the Messages dialect at somebody else's address. It is deliberately **not** a
 * member of core's `ProviderVendor`: a vendor is a company, and adding one per
 * dialect counts dialects as vendors. What the row carries instead is
 * `cors: "unmeasured"` — §9 measured no Messages-compatible third party at all,
 * and this app cannot measure one on the user's behalf without a key it must not
 * have. The connection test is what settles it, and the row says so.
 *
 * ## `cors` is a three-state verdict, and `corsVerified` is not the source
 *
 * `cors` here is written out per row rather than read from core, because core's
 * `corsVerdict` answers the same question for a **vendor id** and this is a
 * catalogue of entries. `probe.test.ts` holds the two against each other, which
 * is what stops them drifting.
 *
 * There is deliberately **no** re-export of core's `corsVerdict` here — see the note
 * above {@link findProvider}, which is where that decision is written down. (An
 * earlier version of this header claimed `corsVerified()` "is kept because the
 * barrel and one runtime read use it", while the same file said the wrapper was
 * deleted for having zero callers. Both cannot be true; the second was.)
 */

import { parseVendorId, type CorsVerdict, type ProviderVendor } from "@all-the.rest/baah-core";

export interface ProviderEntry {
  /** The registry's vendor id — what `ProviderRegistry.resolve` is handed. */
  readonly id: ProviderVendor | (string & {});
  readonly label: string;
  /**
   * What §9 measured for **this** endpoint. Three states, because two cannot say
   * what has to be said:
   *
   * - `"verified"` — measured to work from a browser;
   * - `"unconfirmed"` — measured, and the measurement does not establish it;
   * - `"unmeasured"` — nobody looked, or what was looked at is not this row.
   *
   * `"unmeasured"` is the default for a template row, and saying so is the
   * point: a badge reading „CORS bestätigt" on a `openai-compatible` entry is a
   * claim about six named operators, none of which this app knows the id of.
   */
  readonly cors: CorsVerdict;
  /**
   * The strict narrowing of {@link cors}, kept because two callers want a
   * boolean and the loss is visible at their call site.
   *
   * **Not** the source of truth: it is `cors === "verified"`, asserted equal by
   * `probe.test.ts`.
   */
  readonly corsVerified: boolean;
  /**
   * The header from `requiredHeaders()` has to survive to the wire — and only
   * for a row that means "Anthropic's own endpoint".
   */
  readonly requiresBrowserHeader: boolean;
  /** Needs a `name` (a label) *and* a `baseUrl` from the user. */
  readonly needsEndpoint: boolean;
  /** The default base URL, when the vendor has one. */
  readonly baseUrl: string | undefined;
  /**
   * The one sentence the wizard shows under the entry.
   *
   * Prose, not a comment, because the alternative is the wizard paraphrasing it
   * from memory — and the paraphrase of "unconfirmed" tends to be "works".
   */
  readonly note: string;
}

export const PROVIDER_CATALOG: readonly ProviderEntry[] = Object.freeze([
  {
    id: "openai",
    label: "OpenAI",
    // §9: /v1/models sends `*`, the inference endpoints do not on the error path.
    cors: "unconfirmed",
    corsVerified: false,
    requiresBrowserHeader: false,
    needsEndpoint: false,
    baseUrl: "https://api.openai.com/v1",
    note:
      "Unconfirmed from a browser: /v1/models answers with a CORS header, the inference endpoints do not. " +
      "If the connection test fails with a network error, the provider is blocking the call — not your key.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    cors: "verified",
    corsVerified: true,
    // The SDK does not set this header; the registry adds it (Plan.md §9).
    requiresBrowserHeader: true,
    needsEndpoint: false,
    baseUrl: "https://api.anthropic.com/v1",
    note:
      "Needs a special request header, which the app sets for you. " +
      "Without it a wrong key looks like a network error.",
  },
  {
    id: "google",
    label: "Google (Generative Language)",
    cors: "verified",
    corsVerified: true,
    requiresBrowserHeader: false,
    needsEndpoint: false,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    note: "Works from a browser; the error path echoes the origin.",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-kompatibel (Groq, xAI, Mistral, Cerebras, Together, DeepSeek)",
    // §9's row is "beliebige OpenAI-kompatible baseURL: **zur Laufzeit prüfen**".
    // The six operators were measured; *this row* is the shape a user fills in,
    // and the endpoint behind it has not been. "Unmeasured" is the honest word.
    cors: "unmeasured",
    corsVerified: false,
    requiresBrowserHeader: false,
    needsEndpoint: true,
    baseUrl: undefined,
    note:
      "Enter the provider's base URL yourself, e.g. https://api.groq.com/openai/v1. " +
      "The name is only a label — it never becomes part of the URL. " +
      "Not measured from a browser: use the connection test.",
  },
  {
    id: "anthropic-compatible",
    label: "Anthropic-kompatibel (eigener Endpunkt, /v1/messages)",
    // The new row. §9 measured **no** Messages-compatible third party, so this
    // is unmeasured by construction — not "verified because the word Anthropic
    // is in it", which is the mistake this whole block exists to remove.
    cors: "unmeasured",
    corsVerified: false,
    // **Deliberately false.** `anthropic-dangerous-direct-browser-access: true`
    // is a statement about the security model of the machine on the other end.
    // Anthropic requires it; a third party does not, and claiming it to one is
    // both untrue and a disclosure. The row exists precisely so this header is
    // NOT sent here.
    requiresBrowserHeader: false,
    needsEndpoint: true,
    baseUrl: undefined,
    note:
      "For a server that speaks Anthropic's /v1/messages format at its own address. " +
      "Enter its base URL, e.g. https://my-gateway.example/v1. " +
      "Deliberately no Anthropic browser header: that claim is only true for Anthropic's own endpoint. " +
      "Not measured from a browser — use the connection test.",
  },
]);

/** The catalog as `{ id: label }`, for a `<select>`. */
export function providerChoices(): { readonly id: string; readonly label: string }[] {
  return PROVIDER_CATALOG.map((entry) => ({ id: entry.id, label: entry.label }));
}

/**
 * Does this vendor id have a catalog entry?
 *
 * `false` for an unknown id is not an error by itself: a user may type one, and
 * `ProviderRegistry.resolve` will fail with a named `ProviderError` if no factory
 * is registered for it. This only answers "do we know enough to offer it".
 */
export function isKnownProvider(id: string): boolean {
  const { vendor } = parseCatalogId(id);
  return PROVIDER_CATALOG.some((entry) => entry.id === vendor);
}

/**
 * Split a vendor id into the catalog key.
 *
 * **A one-line re-export of core's `parseVendorId`, and it was a copy.**
 * `parseVendorId` splits on the **first** colon, so
 * `openai-compatible:groq:llama-3` is the vendor `openai-compatible` with the
 * label `groq:llama-3`; the comment here claimed "it is imported, not copied"
 * while the function body below duplicated the `indexOf`/`slice` pair. Two
 * copies of a parser are two places for the first-colon rule to be one colon
 * different — and `apiKeySlot` (`lib/ids.ts`) and `splitVendor`
 * (`components/lib/onboarding.ts`) both already key on core's version, so this
 * was the odd one out.
 */
export const parseCatalogId: (id: string) => { vendor: string; name: string | undefined } = parseVendorId;

/** The catalog entry for a vendor id, or `undefined`. */
export function findProvider(id: string): ProviderEntry | undefined {
  const { vendor } = parseCatalogId(id);
  return PROVIDER_CATALOG.find((entry) => entry.id === vendor);
}

/**
 * There is deliberately **no** re-export of core's `corsVerdict` here.
 *
 * An earlier draft of this file ended with two thin wrappers — `corsVerdictFor`
 * and a boolean `corsVerified` — under a comment claiming "two callers want a
 * boolean". Measured: **zero** callers, production or test; the only thing using
 * either name was the export list itself. A wrapper with no caller is a second
 * name for a first one, which is what `AGENTS.md` §5 calls a dead abstraction —
 * and a comment asserting a justification nobody checked is worse than the dead
 * code it justified.
 *
 * So the two statements of the measurement stay where they belong: the verdict in
 * core, the per-entry `cors` in the catalogue. `probe.test.ts` › "agrees with
 * core's corsVerdict for every entry" holds them against each other by importing
 * core's function directly, which is also the only way that test could notice the
 * catalogue having been rewritten to agree with core by construction.
 */


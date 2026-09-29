/**
 * The provider list the onboarding wizard offers.
 *
 * ## This list is `Plan.md` §9, and §9 is measured
 *
 * §9 is not a vendor wishlist; it is a table of observed CORS behaviour, and the
 * two rows that matter here are the awkward ones:
 *
 * - **OpenAI is in the list and marked `corsVerified: false`.** §9 measured that
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
 */

import { isCorsVerified, type ProviderVendor } from "@all-the.rest/baah-core";

export interface ProviderEntry {
  /** The registry's vendor id — what `ProviderRegistry.resolve` is handed. */
  readonly id: ProviderVendor | (string & {});
  readonly label: string;
  /** What §9 measured. `false` means "test the connection before promising". */
  readonly corsVerified: boolean;
  /** The header from `requiredHeaders()` has to survive to the wire. */
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
    corsVerified: true,
    requiresBrowserHeader: false,
    needsEndpoint: false,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    note: "Works from a browser; the error path echoes the origin.",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-kompatibel (Groq, xAI, Mistral, Cerebras, Together, DeepSeek)",
    corsVerified: true,
    requiresBrowserHeader: false,
    needsEndpoint: true,
    baseUrl: undefined,
    note:
      "Enter the provider's base URL yourself, e.g. https://api.groq.com/openai/v1. " +
      "The name is only a label — it never becomes part of the URL.",
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
 * `parseVendorId` in core splits on the **first** colon, so
 * `openai-compatible:groq:llama-3` is the vendor `openai-compatible` with the
 * label `groq:llama-3`. Reimplemented here rather than imported-and-wrapped
 * because the catalog lookup needs the *vendor* half and core's return shape
 * already gives it — so it is imported, not copied.
 */
export function parseCatalogId(id: string): { vendor: string; name: string | undefined } {
  const separator = id.indexOf(":");
  if (separator < 0) return { vendor: id, name: undefined };
  const vendor = id.slice(0, separator);
  const name = id.slice(separator + 1);
  return name === "" ? { vendor, name: undefined } : { vendor, name };
}

/** The catalog entry for a vendor id, or `undefined`. */
export function findProvider(id: string): ProviderEntry | undefined {
  const { vendor } = parseCatalogId(id);
  return PROVIDER_CATALOG.find((entry) => entry.id === vendor);
}

/**
 * `Plan.md` §9's `corsVerified` and core's `isCorsVerified` must agree.
 *
 * They are two statements of the same measurement, in two packages. If they ever
 * diverge, one of them is lying to the wizard. Exported so the test can assert the
 * invariant instead of a comment asserting it.
 */
export function corsVerified(vendor: string): boolean {
  return isCorsVerified(vendor);
}

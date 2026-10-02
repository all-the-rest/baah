/**
 * The real provider factories.
 *
 * ## Why this file and not the registry
 *
 * `@all-the.rest/baah-core`'s registry is deliberately vendor-free: none of the
 * `@ai-sdk/*` packages is its dependency, and the app passes the factories in
 * (`provider/registry.ts` says so, and says why). This is that injection point,
 * and it is the only module in the app that imports a vendor SDK.
 *
 * Everything that could get the Anthropic browser header wrong lives downstream of
 * {@link defineProviderFactory}, which merges the *required* headers last:
 *
 * ```ts
 * headers: { ...(settings.headers ?? {}), ...requiredHeaders(vendor) }
 * ```
 *
 * Object spread merges right-to-left, so "last" is what wins — a settings object
 * carrying the same header with `"false"` in it would otherwise turn a working key
 * into the same opaque `Failed to fetch` the header exists to prevent. That is a
 * registry rule, so it is not re-decided here; this file only forwards.
 *
 * ## Why each `create*` is wrapped instead of passed directly
 *
 * Two reasons, both mechanical rather than stylistic:
 *
 * 1. **`exactOptionalPropertyTypes`.** `defineProviderFactory`'s callback declares
 *    `baseURL?: string | undefined`, while `@ai-sdk/openai`'s settings declare
 *    `baseURL?: string`. Passing the vendor function straight through is a type
 *    error under this repo's settings, and it is *correct* to be: handing a
 *    vendor `baseURL: undefined` explicitly is not the same as omitting it. The
 *    wrappers omit instead.
 * 2. **`@ai-sdk/openai-compatible` requires `baseURL` and `name`.** Unlike the
 *    three built-ins it has no default endpoint — which is correct, since a
 *    user-chosen OpenAI-compatible server has no vendor default. So an entry
 *    without a `baseUrl` cannot be built at all, and that is raised here as a
 *    named `ProviderError` instead of reaching the SDK as `baseURL: undefined`.
 *    `catalog.ts` marks the row `needsEndpoint: true` for the same reason.
 * 3. **`@ai-sdk/anthropic` requires `baseURL` for the `anthropic-compatible`
 *    row, for the opposite reason.** That SDK *does* have a default —
 *    `https://api.anthropic.com/v1` — so omitting it would send a third-party
 *    entry to Anthropic itself, headerless, and produce an unexplained
 *    `Failed to fetch`. A default is only a feature where the default is the
 *    right target.
 *
 * ## One factory per catalog row, and the fifth one
 *
 * `factories.test.ts` asserts `registry.vendors()` equals `catalogVendorIds()`,
 * so the list below and the catalog cannot disagree about which providers exist.
 * `anthropic-compatible` is the new row, and it is the only one whose factory
 * reuses another row's SDK — see its own comment for why the same
 * `createAnthropic` produces a correct model here and a *different* set of
 * headers on the wire.
 *
 * ## Versions
 *
 * Checked with `npm view <pkg> version` before being added, and each one resolves
 * `@ai-sdk/provider@4.0.19` + `@ai-sdk/provider-utils@5.0.51` — the exact pair
 * `ai@7.0.122` itself depends on, so no second spec version is dragged in.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import {
  ProviderError,
  ProviderRegistry,
  defineProviderFactory,
  type ProviderFactory,
} from "@all-the.rest/baah-core";

import { PROVIDER_CATALOG } from "./catalog.ts";

/** Omit an absent option rather than passing `undefined` explicitly. */
function baseUrlOption(baseURL: string | undefined): { baseURL: string } | Record<string, never> {
  return baseURL === undefined ? {} : { baseURL };
}

function headersOption(headers: Record<string, string> | undefined): { headers: Record<string, string> } | Record<string, never> {
  return headers === undefined ? {} : { headers };
}

export function createDefaultProviderFactories(): readonly ProviderFactory[] {
  return [
    defineProviderFactory("openai", ({ apiKey, headers, baseURL }) =>
      createOpenAI({ apiKey, ...headersOption(headers), ...baseUrlOption(baseURL) }),
    ),

    defineProviderFactory("anthropic", ({ apiKey, headers, baseURL }) =>
      // `headers` carries `anthropic-dangerous-direct-browser-access: true`,
      // merged last by the registry (§9). Forwarded here untouched — a filter
      // would be exactly the bug the registry's comment warns about.
      createAnthropic({ apiKey, ...headersOption(headers), ...baseUrlOption(baseURL) }),
    ),

    defineProviderFactory("google", ({ apiKey, headers, baseURL }) =>
      createGoogle({ apiKey, ...headersOption(headers), ...baseUrlOption(baseURL) }),
    ),

    defineProviderFactory("openai-compatible", ({ apiKey, headers, baseURL }) => {
      if (baseURL === undefined) {
        // No default endpoint exists for an arbitrary OpenAI-compatible server, so
        // this is a user error rather than a configuration to default. The message
        // names a working example because the next question is always "what do I
        // type there".
        throw new ProviderError(
          "An openai-compatible provider needs a base URL, e.g. https://api.groq.com/openai/v1. " +
            "The name is a label; only the base URL decides where requests go.",
          "missing_name",
        );
      }
      return createOpenAICompatible({ apiKey, baseURL, name: "baah", ...headersOption(headers) });
    }),

    /**
     * A Messages-format endpoint at somebody else's address.
     *
     * **Same SDK as first-party Anthropic, different row — and the SDK cannot
     * tell them apart.** `createAnthropic` sends `anthropic-version` to whatever
     * `baseURL` it is given (verified in
     * `@ai-sdk/anthropic@4.0.68`: `getHeaders()` sets it from a literal, not from
     * the host), which is right: the version is a parameter of the **dialect**,
     * and a Messages server needs it.
     *
     * What must *not* go out is
     * `anthropic-dangerous-direct-browser-access: true`. That one is a claim about
     * the security model of the machine on the other end, so it is
     * {@link requiredHeaders}'s business and it keys off the **operator**, not
     * off this factory. `headers` therefore arrives empty for this row, and
     * `factories.test.ts` asserts the absence **on the outgoing request** — a
     * test on `requiredHeaders` alone would pass with a header added here.
     */
    defineProviderFactory("anthropic-compatible", ({ apiKey, headers, baseURL }) => {
      if (baseURL === undefined) {
        // **Required, and it is a correctness issue, not a nicety.**
        // `createAnthropic`'s own default is `https://api.anthropic.com/v1`, so an
        // entry without a base URL would silently address *Anthropic* — without
        // the browser header, because this row is third-party. The result would be
        // a 401 with no ACAO, which the browser reports as `TypeError: Failed to
        // fetch`: an unexplained network failure against a provider the user did
        // not choose. A named error is the honest outcome.
        throw new ProviderError(
          "An anthropic-compatible provider needs the base URL of the server that speaks /v1/messages, " +
            "e.g. https://my-gateway.example/v1. Without it the request would go to Anthropic itself, " +
            "which is not what this entry is for.",
          "missing_name",
        );
      }
      // `name` is deliberately left at Anthropic's default. It appears in the
      // provider metadata as a provider identifier, and nothing here reads it.
      return createAnthropic({ apiKey, baseURL, ...headersOption(headers) });
    }),
  ];
}

/** The registry the composition root resolves providers through. */
export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry(createDefaultProviderFactories());
}

/**
 * The catalog ids, in order.
 *
 * Exported so the catalog↔registry invariant has a name both sides can be tested
 * against, rather than a comment claiming it holds.
 */
export function catalogVendorIds(): string[] {
  return PROVIDER_CATALOG.map((entry) => entry.id);
}

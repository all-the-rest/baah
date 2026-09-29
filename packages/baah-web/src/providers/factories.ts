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

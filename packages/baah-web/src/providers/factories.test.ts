/**
 * The real provider factories.
 *
 * ## What is actually verified here
 *
 * Two things a comment cannot pin, and both have broken before in this repo's
 * history:
 *
 * 1. **The vendor set is the catalog's.** A wizard entry the registry cannot build
 *    is a dead end; a registry entry with no wizard entry is unreachable. They are
 *    one list, checked from both sides.
 * 2. **The Anthropic browser header survives to the wire.** §9 measured that
 *    without `anthropic-dangerous-direct-browser-access: true` the 401 carries no
 *    ACAO and a wrong key becomes an opaque `TypeError`. The registry merges the
 *    required headers last, this file forwards them, and the SDK adds its own — so
 *    the header is asserted on the *request*, not on the settings object. Anything
 *    that drops it in that chain fails here.
 */

import { describe, expect, it } from "vitest";
import { ProviderRegistry, requiredHeaders } from "@all-the.rest/baah-core";
import type { LanguageModel } from "ai";

import { PROVIDER_CATALOG } from "./catalog.ts";
import { catalogVendorIds, createDefaultProviderFactories, createDefaultProviderRegistry } from "./factories.ts";

describe("the default factories", () => {
  it("registers exactly the catalog's vendors, in order", () => {
    const registry = createDefaultProviderRegistry();

    // `ProviderRegistry` returns registration order, so this is a genuine
    // cross-check between two modules that could otherwise drift.
    expect(registry.vendors()).toEqual(catalogVendorIds());
  });

  it("builds a model for every catalog vendor", async () => {
    const registry = createDefaultProviderRegistry();

    for (const entry of PROVIDER_CATALOG) {
      const settings = {
        // The registry's own contract: an `openai-compatible` entry carries its
        // label in the vendor id (`openai-compatible:groq`), not in a separate
        // field. `parseVendorId` splits on the first colon.
        vendor: entry.needsEndpoint ? `${entry.id}:example` : entry.id,
        model: "some-model",
        apiKey: "sk-not-a-real-key",
        // `openai-compatible` has no default endpoint; the catalog says so.
        ...(entry.needsEndpoint ? { baseUrl: "https://api.example.invalid/v1" } : {}),
      };

      const model = await registry.resolve(settings);

      expect(typeof (model as { doStream?: unknown }).doStream).toBe("function");
    }
  });

  it("refuses to build an openai-compatible entry without a base URL", async () => {
    const registry = createDefaultProviderRegistry();

    // `@ai-sdk/openai-compatible` requires `baseURL` and has no default, so a
    // missing one has to fail here rather than reach the SDK as `undefined`.
    await expect(
      registry.resolve({ vendor: "openai-compatible:groq", model: "llama-3", apiKey: "k" }),
    ).rejects.toThrow(/base URL/);
  });

  it("keeps the required Anthropic header on the outgoing request", async () => {
    // The real check: resolve a model through the real registry, call `doStream`,
    // and look at what the SDK's fetch was handed. A missing header here is not a
    // type error or a settings mistake — it is a browser that refuses to show the
    // user a 401.
    const seen: { url: string; headers: Headers }[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as string, init);
      seen.push({ url: request.url, headers: request.headers });
      // The SDK will try to read a stream it will not get; failing here is fine,
      // the assertion is about what was sent.
      return Promise.reject(new TypeError("stubbed"));
    }) as typeof globalThis.fetch;

    try {
      const registry = createDefaultProviderRegistry();
      const model = await registry.resolve({
        vendor: "anthropic",
        model: "claude-haiku-4-5",
        apiKey: "sk-not-a-real-key",
      });

      await expect(doStream(model)).rejects.toThrow();

      expect(seen.length).toBeGreaterThan(0);
      for (const call of seen) {
        expect(call.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not put the browser header on other vendors", () => {
    // A header that is only correct for Anthropic; sending it elsewhere is noise at
    // best, and this pins that `requiredHeaders` stays vendor-scoped.
    expect(requiredHeaders("anthropic")).toEqual({ "anthropic-dangerous-direct-browser-access": "true" });
    expect(requiredHeaders("openai")).toEqual({});
    expect(requiredHeaders("google")).toEqual({});
  });

  it("rejects a duplicate vendor rather than resolving by array order", () => {
    expect(() => new ProviderRegistry(createDefaultProviderFactories())).not.toThrow();
    expect(() => new ProviderRegistry([...createDefaultProviderFactories(), ...createDefaultProviderFactories()])).toThrow(
      /Duplicate provider factory/,
    );
  });
});

/**
 * Drive one streaming call far enough for the SDK to issue a request.
 *
 * The prompt shape is the SDK's own (`Prompt` from `@ai-sdk/provider`), which is
 * not resolvable from this package under pnpm's isolated `node_modules` — the same
 * constraint core's mock model documents. So the shape is written out and a change
 * in the SDK breaks here, which is the point.
 */
async function doStream(model: LanguageModel): Promise<void> {
  // `LanguageModel` in v7 is a union that also admits a model-id string resolved
  // through a registry, so the `.doStream` member has to be narrowed before use.
  // The registry always returns the object form.
  if (typeof model === "string") throw new Error("expected a LanguageModel instance, got a model id");
  await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    includeRawChunks: false,
  } as never);
}

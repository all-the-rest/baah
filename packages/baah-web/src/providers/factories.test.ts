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
    const seen = await captureRequests({
      vendor: "anthropic",
      model: "claude-haiku-4-5",
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    }
  });

  it("FIXED: an anthropic-compatible request carries NO Anthropic browser header", async () => {
    // **The negative, on the wire, through the same real SDK.** A test on
    // `requiredHeaders()` alone would pass with the header re-added inside
    // `factories.ts`, and `requiredHeaders` is not the only place a header can
    // be added — so this one looks at `Headers`, the last thing before the wire.
    //
    // What makes it dangerous to send: the header states that the *client* accepts
    // browser-exposed keys for that endpoint's security model. Anthropic requires
    // it and is entitled to ask. A third party is not, and receiving it also
    // discloses that this app talks to Anthropic at all.
    const seen = await captureRequests({
      vendor: "anthropic-compatible:my-proxy",
      baseUrl: "https://proxy.example.invalid/v1",
      model: "claude-fake",
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.url).toBe("https://proxy.example.invalid/v1/messages");
    for (const call of seen) {
      // `Headers.get` is `null`, not `undefined` and not `""` — the three
      // spellings of "absent" a sloppy assertion would let through.
      expect(call.headers.get("anthropic-dangerous-direct-browser-access"), call.url).toBeNull();
      expect([...call.headers.keys()], call.url).not.toContain("anthropic-dangerous-direct-browser-access");
    }

    // …and the dialect's own parameter *is* there. It is a request parameter of
    // the wire format, set by the SDK for any `baseURL`, and a Messages server
    // that did not receive it would reject the request for a different reason —
    // so "no Anthropic header" must not have been achieved by "no headers".
    expect(seen[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("builds an anthropic-compatible model against the user's URL, never the label", async () => {
    // Acceptance criterion 1, on the real factory: the request goes to the
    // `baseUrl`, and the label `my-proxy` appears in **no** URL. The old bug was
    // `https://groq/…`, so this asserts on the whole recorded request list
    // rather than on the first one.
    const seen = await captureRequests({
      vendor: "anthropic-compatible:my-proxy",
      baseUrl: "https://gateway.example.invalid/v1",
      model: "claude-fake",
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.url.startsWith("https://gateway.example.invalid/v1/")).toBe(true);
      expect(call.url).not.toContain("my-proxy");
    }
  });

  it("refuses an anthropic-compatible entry with no base URL", async () => {
    // Without this the SDK's own default — `https://api.anthropic.com/v1` — would
    // silently receive a third-party entry, headerless, and answer 401 without
    // an ACAO, which the browser reports as `Failed to fetch`. The error names
    // that, because "network error" is not an actionable message here.
    const registry = createDefaultProviderRegistry();
    await expect(
      registry.resolve({ vendor: "anthropic-compatible:my-proxy", model: "claude-fake", apiKey: "k" }),
    ).rejects.toThrow(/base URL/);
  });

  it("does not put the browser header on other vendors", () => {
    // A header that is only correct for Anthropic's own endpoint; sending it
    // elsewhere is noise at best, and this pins that `requiredHeaders` stays
    // operator-scoped.
    expect(requiredHeaders("anthropic")).toEqual({ "anthropic-dangerous-direct-browser-access": "true" });
    expect(requiredHeaders("openai")).toEqual({});
    expect(requiredHeaders("google")).toEqual({});
    expect(requiredHeaders("anthropic-compatible:my-proxy")).toEqual({});
  });

  it("rejects a duplicate vendor rather than resolving by array order", () => {
    expect(() => new ProviderRegistry(createDefaultProviderFactories())).not.toThrow();
    expect(() => new ProviderRegistry([...createDefaultProviderFactories(), ...createDefaultProviderFactories()])).toThrow(
      /Duplicate provider factory/,
    );
  });
});

/**
 * ## The wire format, asserted **here** and not in core
 *
 * `ResolvedVendor.dialect` used to be a `ProviderDialect` field in core, with
 * tests asserting `resolveVendor("openai").dialect === "responses"`. It was
 * **deleted**: `rg '\.dialect'` over every `src/` in the workspace found zero
 * production readers, and `AGENTS.md` §5 forbids an abstraction with no consumer.
 *
 * The wire format is real and it matters — a `chat/completions` POST to a
 * `/messages` server fails *silently*, which is the whole reason
 * `anthropic-compatible` exists as a row. But the thing that decides it is **this
 * array**, the one that calls `createOpenAI` / `createAnthropic` /
 * `createOpenAICompatible`, and a declaration in core that nothing reads cannot
 * disagree with this array, because nothing compares them. So the assertions live
 * here, where they can see a real request.
 */
describe("the wire format each vendor actually posts", () => {
  it("`openai` posts to `/responses` — the SDK's default, not chat/completions", async () => {
    // Measured, not assumed: `createOpenAI({…})` returns the **Responses** API model
    // by default (the SDK's own error text says so — "Received a Chat Completions
    // stream while using the OpenAI Responses API"), and `e2e/support/app.ts`
    // documents the E2E suite paying for it. Asserting `chat-completions` here
    // because it is the shape people expect would be the same lie a second time.
    const seen = await captureRequests({ vendor: "openai", model: "gpt-4o-mini" });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/responses");
  });

  it("`openai-compatible` posts to `/chat/completions` at the user's URL", async () => {
    // Two unrelated services can speak the same wire format, and neither is OpenAI
    // — which is the fact a `dialect`-by-vendor-name type could not express.
    const seen = await captureRequests({
      vendor: "openai-compatible:groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3",
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("`anthropic` and `anthropic-compatible` BOTH post to `/messages`", async () => {
    // One company, one format; and the same format at somebody else's address. The
    // pair is the reason the wire format and the operator are two questions: these
    // two rows send the **same request** and differ only in whether the browser
    // header is attached.
    const firstParty = await captureRequests({ vendor: "anthropic", model: "claude-haiku-4-5" });
    const thirdParty = await captureRequests({
      vendor: "anthropic-compatible:my-proxy",
      baseUrl: "https://gateway.example.invalid/v1",
      model: "claude-fake",
    });

    expect(firstParty[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(thirdParty[0]?.url).toBe("https://gateway.example.invalid/v1/messages");
    // …and the difference between them, on the same wire format: the claim.
    expect(firstParty[0]?.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(thirdParty[0]?.headers.get("anthropic-dangerous-direct-browser-access")).toBeNull();
  });

  it("`google` addresses the model in the path, on the streaming endpoint", async () => {
    const seen = await captureRequests({ vendor: "google", model: "gemini-2.0-flash" });

    expect(seen.length).toBeGreaterThan(0);
    // A fourth wire format, and the one that puts the model **in the URL** — which
    // is why `probe.ts` refuses to put the *key* there.
    //
    // `:streamGenerateContent?alt=sse` rather than `:generateContent`, and that is
    // **measured, not chosen**: `doStream` is a streaming call and
    // `@ai-sdk/google@4` maps it to the SSE variant. `probe.ts`'s own path *is*
    // `generateContent` — it is a one-shot, not a stream — so the two differ by
    // design and the pair is what shows the probe was not guessing from the SDK.
    expect(seen[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    );
    // The key is a header, never `?key=` — a URL is the most loggable string there
    // is. Asserted on the wire, not on the settings.
    expect(seen[0]?.url).not.toContain("?key=");
    expect(seen[0]?.headers.get("x-goog-api-key")).toBe("sk-not-a-real-key");
  });
});

/**
 * Resolve through the **real** registry and drive `doStream` far enough that
 * the SDK issues a request, recording what it handed to `fetch`.
 *
 * The recorded `Headers` is the last thing before the wire: `requiredHeaders`,
 * `createProviderModel`'s merge order, `defineProviderFactory`'s forwarding and
 * the SDK's own header handling are all upstream of it, so a header missing
 * here is missing everywhere. A test that only asserted on the settings object
 * would pass with any one of those four adding or dropping it.
 */
async function captureRequests(settings: {
  readonly vendor: string;
  readonly model: string;
  readonly baseUrl?: string | undefined;
}): Promise<readonly { readonly url: string; readonly headers: Headers }[]> {
  const seen: { url: string; headers: Headers }[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as string, init);
    seen.push({ url: request.url, headers: request.headers });
    // The SDK will try to read a stream it will not get; failing here is fine,
    // the assertions are about what was sent.
    return Promise.reject(new TypeError("stubbed"));
  }) as typeof globalThis.fetch;

  try {
    const registry = createDefaultProviderRegistry();
    const model = await registry.resolve({
      vendor: settings.vendor,
      model: settings.model,
      apiKey: "sk-not-a-real-key",
      ...(settings.baseUrl === undefined ? {} : { baseUrl: settings.baseUrl }),
    });
    await expect(doStream(model)).rejects.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
  }

  return seen;
}

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

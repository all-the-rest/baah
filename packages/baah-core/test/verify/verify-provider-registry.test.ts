/**
 * C1 — the provider registry, against an injected factory.
 *
 * ## Why this file exists
 *
 * The build report claimed `provider/registry.ts` "has no tests and cannot have
 * any, because no provider SDK is installed". The registry's own module note
 * (registry.ts:39-47) says the opposite: the factories are **injected**,
 * precisely so the file stays free of vendor imports and "makes the CORS/key
 * rules testable without a network". If the injection is the mechanism, the
 * claim cannot be right — the environment is not the obstacle, the omission is.
 *
 * Every factory here is a fake. That is not a downgrade: the behaviour under
 * test is the registry's own (key handling, header computation, vendor
 * dispatch, memoisation), none of which lives in a vendor SDK. What a fake
 * cannot prove is that a *real* SDK honours the header — and that is stated
 * here as a named gap, not smuggled in as a pass.
 */
import { describe, expect, it } from "vitest";

import type { LanguageModel } from "ai";
import {
  createProviderModel,
  defineProviderFactory,
  fingerprint as registryFingerprint,
  isCorsVerified,
  parseVendorId,
  ProviderError,
  ProviderRegistry,
  requiredHeaders,
  type ProviderFactory,
  type ProviderSettings,
} from "../../src/provider/registry.ts";
import registrySource from "../../src/provider/registry.ts?raw";

/* ------------------------------------------------------------------ */
/* A fake vendor                                                        */
/* ------------------------------------------------------------------ */

interface CreateCall {
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  baseUrl: string | undefined;
}

/** Records what the registry asked for and hands back a distinguishable model. */
function fakeFactory(vendor: string): ProviderFactory & { calls: CreateCall[] } {
  const calls: CreateCall[] = [];
  return {
    vendor,
    calls,
    create(options) {
      calls.push(options);
      return { modelId: `${vendor}/${options.model}` } as unknown as LanguageModel;
    },
  };
}

/**
 * `fingerprint` is **async**: the API key enters the memo key as a
 * `crypto.subtle` digest, because a memo key is exactly the kind of value that
 * ends up in a log line uninvited, and a key must never be one.
 */
const fingerprint = (s: ProviderSettings): Promise<string> => registryFingerprint(s);

const settings = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
  vendor: "anthropic",
  model: "claude-haiku-4-5",
  apiKey: "sk-test-not-a-real-key",
  ...over,
});

/* ------------------------------------------------------------------ */
/* C1a — the key is explicit, and there is no environment fallback      */
/* ------------------------------------------------------------------ */

describe("the key is explicit (AGENTS.md §2)", () => {
  it("refuses a missing key, naming the browser rather than the network", () => {
    const factory = fakeFactory("anthropic");
    expect(() =>
      createProviderModel({ settings: settings({ apiKey: "" }), factories: [factory] }),
    ).toThrow(ProviderError);

    try {
      createProviderModel({ settings: settings({ apiKey: "" }), factories: [factory] });
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderError).code).toBe("missing_api_key");
      // The SDK's own `LoadAPIKeyError` would read as a network problem.
      expect((error as Error).message).toContain("browser");
    }
    expect(factory.calls).toHaveLength(0);
  });

  it("treats a whitespace-only key as missing rather than sending it", () => {
    const factory = fakeFactory("anthropic");
    try {
      createProviderModel({ settings: settings({ apiKey: "   " }), factories: [factory] });
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderError).code).toBe("missing_api_key");
    }
  });

  it("passes the key straight through — no trimming, no substitution", () => {
    const factory = fakeFactory("anthropic");
    createProviderModel({ settings: settings({ apiKey: "  sk-raw  " }), factories: [factory] });
    expect(factory.calls[0]?.apiKey).toBe("  sk-raw  ");
  });

  it("never reads process.env anywhere in the module", () => {
    // Not a spy: a source-level assertion, because the rule is a source-level
    // rule. Comments are stripped first — the file *mentions* `process.env` in
    // prose to explain why it is absent, and a naive grep would flag its own
    // explanation.
    const code = registrySource
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/process\s*\.\s*env/);
    expect(code).not.toMatch(/globalThis\s*\.\s*process/);
  });
});

/* ------------------------------------------------------------------ */
/* C1b — the Anthropic header                                           */
/* ------------------------------------------------------------------ */

describe("the Anthropic browser header", () => {
  it("is added for anthropic and for no other vendor", () => {
    expect(requiredHeaders("anthropic")).toEqual({
      "anthropic-dangerous-direct-browser-access": "true",
    });
    expect(requiredHeaders("openai")).toEqual({});
    expect(requiredHeaders("google")).toEqual({});
    expect(requiredHeaders("openai-compatible")).toEqual({});
  });

  it("reaches the factory on every construction, not just the first", () => {
    const factory = fakeFactory("anthropic");
    for (let i = 0; i < 3; i += 1) {
      createProviderModel({ settings: settings(), factories: [factory] });
    }
    expect(factory.calls).toHaveLength(3);
    for (const call of factory.calls) {
      expect(call.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    }
  });

  it("reaches the factory through the memoising registry too", async () => {
    const factory = fakeFactory("anthropic");
    const registry = new ProviderRegistry([factory]);
    await registry.resolve(settings());
    await registry.resolve(settings());
    expect(factory.calls).toHaveLength(1);
    expect(
      factory.calls[0]?.headers["anthropic-dangerous-direct-browser-access"],
    ).toBe("true");
  });

  it("is a real header on the fetch, not a comment", () => {
    // A route that could plausibly drop it: the header must survive the
    // `defineProviderFactory` wrapper too, not only a hand-written factory.
    const seen: Record<string, string>[] = [];
    const wrapped = defineProviderFactory("anthropic", (options) => {
      seen.push({ ...(options.headers ?? {}) });
      return { languageModel: (modelId) => ({ modelId }) as unknown as LanguageModel };
    });
    createProviderModel({ settings: settings(), factories: [wrapped] });
    expect(seen[0]?.["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("FIXED: a caller header can NO LONGER drop the required one", () => {
    // registry.ts:71 and registry.ts:199-201 both *stated* that required
    // headers are merged first "so they cannot be dropped by an accident in the
    // settings". Object spread merges right-to-left, so `settings.headers` won,
    // and the stated guarantee was the exact opposite of the behaviour. This is
    // a CORS bug with a security rationale: Anthropic without the header answers
    // 401 without an ACAO, so a wrong key becomes an opaque network failure.
    const factory = fakeFactory("anthropic");
    createProviderModel({
      settings: settings({ headers: { "anthropic-dangerous-direct-browser-access": "false" } }),
      factories: [factory],
    });
    expect(factory.calls[0]?.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("a caller header still ADDS to the required ones, it does not replace them", () => {
    const factory = fakeFactory("anthropic");
    createProviderModel({
      settings: settings({ headers: { "x-trace": "1" } }),
      factories: [factory],
    });
    expect(factory.calls[0]?.headers).toEqual({
      "x-trace": "1",
      "anthropic-dangerous-direct-browser-access": "true",
    });
  });
});

/* ------------------------------------------------------------------ */
/* C1c — model id → vendor dispatch                                     */
/* ------------------------------------------------------------------ */

describe("model id to vendor dispatch", () => {
  it("routes to the factory whose vendor matches, not by position", () => {
    const google = fakeFactory("google");
    const openai = fakeFactory("openai");
    const model = createProviderModel({
      settings: settings({ vendor: "google", model: "gemini-2.5-pro" }),
      factories: [google, openai],
    });
    expect((model as unknown as { modelId: string }).modelId).toBe("google/gemini-2.5-pro");
    expect(google.calls).toHaveLength(1);
    expect(openai.calls).toHaveLength(0);
  });

  it("passes the model id through verbatim, including provider prefixes", () => {
    const factory = fakeFactory("openai-compatible");
    createProviderModel({
      settings: settings({ vendor: "openai-compatible:groq", model: "groq/llama-3-70b" }),
      factories: [factory],
    });
    expect(factory.calls[0]?.model).toBe("groq/llama-3-70b");
  });

  it("refuses a model that is blank, before touching any factory", () => {
    const factory = fakeFactory("openai");
    for (const model of ["", "   "]) {
      try {
        createProviderModel({ settings: settings({ vendor: "openai", model }), factories: [factory] });
        expect.unreachable();
      } catch (error) {
        expect((error as ProviderError).code).toBe("missing_model");
      }
    }
    expect(factory.calls).toHaveLength(0);
  });

  it("names the vendor it could not find", () => {
    try {
      createProviderModel({ settings: settings({ vendor: "cohere" }), factories: [fakeFactory("openai")] });
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderError).code).toBe("unknown_vendor");
      expect((error as Error).message).toContain("cohere");
    }
  });

  it("survives a duplicate vendor rather than letting array order decide", () => {
    expect(() => new ProviderRegistry([fakeFactory("openai"), fakeFactory("openai")])).toThrow(
      /Duplicate provider factory/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* C1d — parseVendorId and the base URL it produces                    */
/* ------------------------------------------------------------------ */

describe("parseVendorId", () => {
  it("splits a bare vendor", () => {
    expect(parseVendorId("anthropic")).toEqual({ vendor: "anthropic", name: undefined });
  });

  it("splits on the FIRST colon only", () => {
    expect(parseVendorId("openai-compatible:groq")).toEqual({
      vendor: "openai-compatible",
      name: "groq",
    });
  });

  it("treats a trailing colon as no name", () => {
    expect(parseVendorId("openai-compatible:")).toEqual({
      vendor: "openai-compatible",
      name: undefined,
    });
  });

  it("FIXED: the error message now recommends a format the parser accepts", () => {
    // registry.ts:186 told the user to write `openai-compatible:groq:llama-3`.
    // `indexOf(":")` splits once, so the name became "groq:llama-3" — and that
    // string was then handed to the vendor SDK as a base URL. The parse is
    // unchanged and correct (a label may contain anything); the *message* was
    // the thing that did not match it, and a name is a label, never a URL.
    const factory = fakeFactory("openai-compatible");
    let message = "";
    try {
      createProviderModel({ settings: settings({ vendor: "openai-compatible", model: "m" }), factories: [factory] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("openai-compatible:groq");
    expect(message).not.toContain("openai-compatible:groq:llama-3");
    // …and it says the thing that is actually true: the name is a label.
    expect(message).toContain("label");
  });

  it("FIXED: an openai-compatible entry with no baseUrl gets NO baseUrl", () => {
    // What it used to get: "groq" — the name, used verbatim as a URL. The
    // vendor SDK would have requested `https://groq/…`, which cannot resolve
    // and says nothing about why.
    const factory = fakeFactory("openai-compatible");
    createProviderModel({
      settings: settings({ vendor: "openai-compatible:groq", model: "llama-3" }),
      factories: [factory],
    });
    expect(factory.calls[0]?.baseUrl).toBeUndefined();
  });

  it("and a three-part id is a label, not a URL", () => {
    const factory = fakeFactory("openai-compatible");
    createProviderModel({
      settings: settings({ vendor: "openai-compatible:groq:llama-3", model: "llama-3" }),
      factories: [factory],
    });
    expect(factory.calls[0]?.baseUrl).toBeUndefined();
  });

  it("but an explicit baseUrl does win", () => {
    const factory = fakeFactory("openai-compatible");
    createProviderModel({
      settings: settings({
        vendor: "openai-compatible:groq",
        model: "llama-3",
        baseUrl: "https://api.groq.com/openai/v1",
      }),
      factories: [factory],
    });
    expect(factory.calls[0]?.baseUrl).toBe("https://api.groq.com/openai/v1");
  });

  it("requires a name for openai-compatible, and accepts settings.name for it", () => {
    const factory = fakeFactory("openai-compatible");
    try {
      createProviderModel({ settings: settings({ vendor: "openai-compatible" }), factories: [factory] });
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderError).code).toBe("missing_name");
    }
    // `settings.name` satisfies the requirement…
    createProviderModel({
      settings: settings({ vendor: "openai-compatible", name: "my-endpoint", model: "m" }),
      factories: [factory],
    });
    expect(factory.calls[0]?.baseUrl).toBeUndefined();
  });

  it("FIXED: `settings.name` is a real part of the identity, not a presence flag", async () => {
    // It used to decide whether the call succeeded and then be thrown away: the
    // check read `name ?? settings.name` while everything after read the id
    // suffix alone. The label is now both the gate and part of the identity, so
    // two entries that differ only by their label are two configurations.
    const withA = settings({ vendor: "openai-compatible", name: "a", model: "m" });
    const withB = settings({ vendor: "openai-compatible", name: "b", model: "m" });
    expect(await fingerprint(withA)).not.toBe(await fingerprint(withB));

    // The gate itself: a label in the field satisfies the requirement, and the
    // id suffix satisfies it too — one resolved value, used everywhere, and the
    // two are alternatives rather than additive.
    const factory = fakeFactory("openai-compatible");
    createProviderModel({
      settings: settings({ vendor: "openai-compatible:fromId", name: "fromField", model: "m" }),
      factories: [factory],
    });
    expect(factory.calls).toHaveLength(1);
    expect(() =>
      createProviderModel({
        settings: settings({ vendor: "openai-compatible", name: undefined, model: "m" }),
        factories: [factory],
      }),
    ).toThrow(ProviderError);
  });
});

/* ------------------------------------------------------------------ */
/* C1e — the fingerprint memo                                          */
/* ------------------------------------------------------------------ */

describe("the fingerprint memo", () => {
  it("reuses the instance when nothing changed", async () => {
    const factory = fakeFactory("anthropic");
    const registry = new ProviderRegistry([factory]);
    const first = await registry.resolve(settings());
    const second = await registry.resolve(settings());
    expect(second).toBe(first);
    expect(factory.calls).toHaveLength(1);
  });

  it("rebuilds when the model changes", async () => {
    const factory = fakeFactory("anthropic");
    const registry = new ProviderRegistry([factory]);
    await registry.resolve(settings());
    await registry.resolve(settings({ model: "claude-opus-4-1" }));
    expect(factory.calls).toHaveLength(2);
  });

  it("FIXED: DOES rebuild when only the key changes", async () => {
    // The comment at registry.ts said "Headers and the key are part of the
    // identity: two settings that differ only by key must not share a model
    // instance." `fingerprint()` never read `apiKey`, so a user who pasted a new
    // key got the *old* key's model back until something else happened to
    // change. The key is in the identity now, as a digest.
    const factory = fakeFactory("anthropic");
    const registry = new ProviderRegistry([factory]);
    await registry.resolve(settings({ apiKey: "sk-first" }));
    await registry.resolve(settings({ apiKey: "sk-second" }));
    expect(factory.calls).toHaveLength(2);
    expect(await fingerprint(settings({ apiKey: "sk-first" }))).not.toBe(
      await fingerprint(settings({ apiKey: "sk-second" })),
    );
  });

  it("the key enters as a digest, never as itself", async () => {
    // A memo key is the kind of value that ends up in a log line, a `?raw`
    // source dump or an IndexedDB row uninvited. A key must not be one of those.
    const secret = "sk-do-not-leak-this-value";
    const print = await fingerprint(settings({ apiKey: secret }));
    expect(print).not.toContain(secret);
    // …and it is a digest, not an accidental omission: the same key always
    // produces the same string, so the memo still works.
    expect(await fingerprint(settings({ apiKey: secret }))).toBe(print);
    expect(print).toMatch(/^["\[]/); // a JSON array, per the injective form
  });

  it("an empty key is still a distinct configuration from a real one", async () => {
    // `createProviderModel` refuses a blank key outright, so this pair never
    // reaches a factory — but the memo must still tell them apart, or an
    // unconfigured registry could hand back a configured model.
    expect(await fingerprint(settings({ apiKey: "" }))).not.toBe(await fingerprint(settings({ apiKey: "k" })));
  });

  it("rebuilds when the base URL or the headers change", async () => {
    const factory = fakeFactory("openai-compatible");
    const registry = new ProviderRegistry([factory]);
    const base = { vendor: "openai-compatible:groq", model: "m", apiKey: "k" } as const;
    await registry.resolve({ ...base });
    await registry.resolve({ ...base, baseUrl: "https://a.example" });
    await registry.resolve({ ...base, headers: { "x-trace": "1" } });
    expect(factory.calls).toHaveLength(3);
  });

  it("ignores header ORDER, so a settings round-trip is not a rebuild", async () => {
    const base = { vendor: "openai-compatible", model: "m", apiKey: "k" } as const;
    expect(await fingerprint({ ...base, headers: { a: "1", b: "2" } })).toBe(
      await fingerprint({ ...base, headers: { b: "2", a: "1" } }),
    );
  });

  it("invalidate() forces the next resolve to rebuild", async () => {
    const factory = fakeFactory("anthropic");
    const registry = new ProviderRegistry([factory]);
    await registry.resolve(settings());
    registry.invalidate();
    await registry.resolve(settings());
    expect(factory.calls).toHaveLength(2);
  });

  it("still one slot, so alternating between two settings rebuilds every time", async () => {
    // NOT a correctness bug and not fixed: `#cached` holds one entry, not a map.
    // The class is a performance property, and the trade is deliberate — a map
    // would pin live provider clients (each holding a key) with no way to know
    // they are garbage. Pinned so the choice stays a decision rather than a
    // rediscovery.
    const factory = fakeFactory("anthropic");
    const registry = new ProviderRegistry([factory]);
    const a = settings({ model: "a" });
    const b = settings({ model: "b" });
    for (let i = 0; i < 4; i += 1) await registry.resolve(i % 2 === 0 ? a : b);
    expect(factory.calls).toHaveLength(4);
  });

  it("FIXED: a separator collision no longer aliases two configurations", async () => {
    // `fingerprint` used to `join("|")`, which is not injective:
    // `baseUrl: "x|y", name: "z"` and `baseUrl: "x", name: "y|z"` produced the
    // same key, and the memo would hand the first configuration's model to the
    // second. Rated latent — reaching it needs a pipe character in a base URL or
    // a name — but a memo key should still be injective, and the fix was free.
    const base = { vendor: "openai-compatible:groq", model: "m", apiKey: "k" } as const;
    const a = await fingerprint({ ...base, baseUrl: "x|y", name: "z" });
    const b = await fingerprint({ ...base, baseUrl: "x", name: "y|z" });
    expect(a).not.toBe(b);
  });
});

/* ------------------------------------------------------------------ */
/* C1f — the CORS verdict and the factory adapter                      */
/* ------------------------------------------------------------------ */

describe("isCorsVerified", () => {
  it("marks only openai unverified", () => {
    expect(isCorsVerified("openai")).toBe(false);
    expect(isCorsVerified("anthropic")).toBe(true);
    expect(isCorsVerified("google")).toBe(true);
    expect(isCorsVerified("openai-compatible")).toBe(true);
  });
});

describe("defineProviderFactory", () => {
  it("forwards key, base URL and headers, and adds no browser flag", () => {
    // §14.4: `dangerouslyAllowBrowser` does not exist in the AI SDK. If a
    // future edit adds one, this test is the thing that notices.
    const options: Record<string, unknown>[] = [];
    const factory = defineProviderFactory("google", (o) => {
      options.push(o);
      return { languageModel: (modelId) => ({ modelId }) as unknown as LanguageModel };
    });

    factory.create({ apiKey: "k", model: "gemini", headers: { a: "1" }, baseUrl: "https://x" });
    expect(options[0]).toEqual({ apiKey: "k", baseURL: "https://x", headers: { a: "1" } });
    expect(options[0]).not.toHaveProperty("dangerouslyAllowBrowser");

    // An absent base URL must be *omitted*, not sent as `undefined` — some
    // vendor SDKs treat an explicit `baseURL: undefined` differently from none.
    factory.create({ apiKey: "k", model: "gemini", headers: {}, baseUrl: undefined });
    expect(Object.keys(options[1] ?? {})).toEqual(["apiKey", "headers"]);
  });
});

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
  corsVerdict,
  defineProviderFactory,
  fingerprint as registryFingerprint,
  isCorsVerified,
  parseVendorId,
  ProviderError,
  ProviderRegistry,
  requiredHeaders,
  resolveVendor,
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

  it("FIXED: an `anthropic-compatible:<label>` entry gets NO browser header", () => {
    // **The negative, asserted as a negative.** `anthropic-compatible:my-proxy`
    // is a third party speaking Anthropic's dialect. Sending the header there
    // makes a claim about someone else's security model that is not true, and
    // tells a service that has no business knowing that this app talks to
    // Anthropic at all.
    //
    // The three spellings are all exercised deliberately: the bare shape, the
    // shape with a label, and a label that is literally the word "anthropic" —
    // because "does the string contain anthropic" is the mutation this is here
    // to kill, and a user can type that label.
    for (const id of ["anthropic-compatible", "anthropic-compatible:my-proxy", "anthropic-compatible:anthropic"]) {
      expect(requiredHeaders(id), id).toEqual({});
      expect(Object.keys(requiredHeaders(id)), id).not.toContain("anthropic-dangerous-direct-browser-access");
    }
  });

  it("and the absence survives the whole chain into a factory, not just the pure function", () => {
    // The pure function is where the decision is made; this is the place where a
    // later edit could add the header back — in `createProviderModel`, in the
    // merge order, or in `defineProviderFactory`. Both directions, on the wire.
    const factory = fakeFactory("anthropic-compatible");
    createProviderModel({
      settings: settings({
        vendor: "anthropic-compatible:my-proxy",
        baseUrl: "https://proxy.example.invalid/v1",
      }),
      factories: [factory],
    });
    expect(factory.calls[0]?.headers).toEqual({});
    expect(factory.calls[0]?.headers).not.toHaveProperty("anthropic-dangerous-direct-browser-access");
    expect(factory.calls[0]?.baseUrl).toBe("https://proxy.example.invalid/v1");

    // …and the first-party entry through the same factory-free path still has it.
    const firstParty = fakeFactory("anthropic");
    createProviderModel({ settings: settings(), factories: [firstParty] });
    expect(firstParty.calls[0]?.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("does not leak onto an id that merely *starts with* anthropic", () => {
    // A `startsWith` mutation passes both of the tests above for
    // `anthropic-compatible:…` only if the label is not also part of the string
    // under test. These are the ids a substring check would get wrong.
    for (const id of ["anthropic-compatible", "anthropic-2", "anthropicx", "xanthropic"]) {
      expect(requiredHeaders(id), id).toEqual({});
    }
    expect(requiredHeaders("anthropic")).not.toEqual({});
  });

  it("DECIDED: a first-party `anthropic` with a FOREIGN `baseUrl` still sends it", () => {
    // **The policy, pinned — because it is a policy and not an accident.**
    //
    // This was left undecided and untested: `vendor: "anthropic"` with
    // `baseUrl: "https://proxy.example.invalid/v1"` sends
    // `anthropic-dangerous-direct-browser-access: true` to a host that is not
    // Anthropic, which is the same third-party disclosure the
    // `anthropic-compatible` row exists to prevent. It is reachable without the
    // wizard: `baseUrl` is a bare `z.string().optional()` in the §8.2 import
    // schema, so an imported settings file can do it.
    //
    // **The decision is: allow it.** The user selected the Anthropic row and typed
    // that address; that *is* the identity claim, and a proxy in front of Anthropic
    // genuinely needs the header forwarded. The row for "this is not Anthropic" is
    // `anthropic-compatible:<label>`, and it exists precisely so the negative claim
    // can be made.
    //
    // The rejected alternative was keying off the **hostname**: it would make a
    // guess about a host the arbiter of a security claim, and `proxy.example.invalid`
    // and `api.anthropic.com` are the same deployment in every case that matters.
    // That is strictly worse than a decision the user made, so it was not taken.
    //
    // Asserted on the **factory's outgoing headers**, not on `requiredHeaders` alone:
    // a refusal implemented anywhere else in the chain would pass the pure function.
    const factory = fakeFactory("anthropic");
    createProviderModel({
      settings: settings({ vendor: "anthropic", baseUrl: "https://proxy.example.invalid/v1" }),
      factories: [factory],
    });

    expect(factory.calls[0]?.baseUrl).toBe("https://proxy.example.invalid/v1");
    expect(factory.calls[0]?.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");

    // …and the *labelled* third party, through the same factory, in the same test
    // file, gets nothing. The two are one decision and are asserted together on
    // purpose: an asymmetry between them is the bug this block's negative is for.
    const thirdParty = fakeFactory("anthropic-compatible");
    createProviderModel({
      settings: settings({ vendor: "anthropic-compatible:my-proxy", baseUrl: "https://proxy.example.invalid/v1" }),
      factories: [thirdParty],
    });
    expect(thirdParty.calls[0]?.baseUrl).toBe("https://proxy.example.invalid/v1");
    expect(thirdParty.calls[0]?.headers).toEqual({});
  });

  it("the operator is derived from the parse, and the two agree on every id", () => {
    // The claim being corrected, **measured**: over the adversarial ids below,
    // `operator === "anthropic"` and `parseVendorId(id).vendor === "anthropic"`
    // have 0 mismatches. They are the same predicate, and the doc comment above
    // used to claim an independence the code does not have.
    //
    // So this test does two things. It **pins the parity** — because the parity is
    // what the code actually does and a future edit that breaks it would otherwise
    // be invisible. And it **enumerates the class the parse closes**: every one of
    // these is an id where a `startsWith` or a raw-string check would give a
    // different answer than the first-colon split.
    const ids = [
      "anthropic",
      "anthropic:eu",
      "anthropic:",
      "anthropicx",
      "anthropic-2",
      "xanthropic",
      "anthropic-compatible",
      "anthropic-compatible:anthropic",
      "Anthropic",
      "ANTHROPIC",
      " anthropic",
      "anthropic ",
      "openai",
      "google",
      "",
      ":",
    ] as const;
    for (const id of ids) {
      const resolved = resolveVendor(id);
      expect(resolved.operator === "anthropic", id).toBe(resolved.vendor === "anthropic");
    }

    // The specific pairs, named — so a reader can see what the parity is *for*.
    // Case matters: `Anthropic` is not the Anthropic row, and a `toLowerCase()`
    // "fix" would send a credential-bearing claim to a host the user mistyped.
    expect(resolveVendor("Anthropic").operator).toBe("third-party");
    expect(resolveVendor("ANTHROPIC").operator).toBe("third-party");
    // A label is not the vendor, however it is spelled.
    expect(resolveVendor("anthropic:eu").operator).toBe("anthropic");
    expect(resolveVendor("anthropic-compatible:anthropic").operator).toBe("third-party");
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

  it("requires a name for `anthropic-compatible` too — the same rule, one implementation", () => {
    // This is why the check keys off `resolveVendor().template` instead of
    // `vendor === "openai-compatible"`: the new shape has to be covered, and a
    // second string comparison is how it would have been forgotten.
    const factory = fakeFactory("anthropic-compatible");
    try {
      createProviderModel({
        settings: settings({ vendor: "anthropic-compatible", baseUrl: "https://proxy.example.invalid/v1" }),
        factories: [factory],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderError).code).toBe("missing_name");
      expect((error as Error).message).toContain("anthropic-compatible:groq");
    }
    // With a label it builds, at the user's URL, and with no header.
    createProviderModel({
      settings: settings({
        vendor: "anthropic-compatible:my-proxy",
        baseUrl: "https://proxy.example.invalid/v1",
      }),
      factories: [factory],
    });
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]?.baseUrl).toBe("https://proxy.example.invalid/v1");
    expect(factory.calls[0]?.headers).not.toHaveProperty("anthropic-dangerous-direct-browser-access");
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
  it("marks only the three first-party operators verified", () => {
    // §9's table, read off the page rather than off the implementation. The
    // expectations are literals on purpose: `entry.id !== "openai"` inside the
    // expectation would be the old bug wearing the test's clothes.
    expect(corsVerdict("anthropic")).toBe("verified");
    expect(corsVerdict("google")).toBe("verified");
    // §9 measured OpenAI and the measurement does not establish it: only
    // `/v1/models` sends ACAO, the inference endpoints do not on the error path,
    // and the success path needs a real key — which does not live in this repo.
    expect(corsVerdict("openai")).toBe("unconfirmed");

    expect(isCorsVerified("anthropic")).toBe(true);
    expect(isCorsVerified("google")).toBe(true);
    expect(isCorsVerified("openai")).toBe(false);
  });

  it("FIXED: an unmeasured endpoint is `unmeasured`, not `true`", () => {
    // `return vendor !== "openai"` reported every one of these as verified. The
    // wizard renders this as „CORS bestätigt" (`Onboarding.tsx`), so the string
    // comparison was the badge.
    const unmeasured = [
      "openai-compatible",
      "openai-compatible:groq",
      "openai-compatible:my-vllm",
      "anthropic-compatible",
      "anthropic-compatible:my-proxy",
      // A typo, and a vendor id added tomorrow.
      "openaai",
      "anthropicc",
      "cohere",
      "",
    ];
    for (const id of unmeasured) {
      expect(corsVerdict(id), id).toBe("unmeasured");
      expect(isCorsVerified(id), id).toBe(false);
    }
  });

  it("a self-chosen label cannot vouch for an endpoint", () => {
    // §9 measured six named OpenAI-compatible operators, and the app has no id
    // for any of them — the label is free text. So `…:groq` is *not* a claim
    // that this is Groq, and must not be scored as one; the connection test is
    // what settles it (`probe.ts`), which is what the wizard already says.
    expect(corsVerdict("openai-compatible:groq")).toBe(corsVerdict("openai-compatible:not-a-real-provider"));
    // Same for the operator: the *shape* is third-party whatever it is called.
    expect(corsVerdict("anthropic-compatible:anthropic")).toBe("unmeasured");
  });

  it("`isCorsVerified` is the strict narrowing, and says so by existing", () => {
    // Two booleans cannot carry three states. The pair has to agree, and the
    // wrapper must be the `=== "verified"` one rather than a second opinion.
    for (const id of ["anthropic", "google", "openai", "openai-compatible:groq", "nope"]) {
      expect(isCorsVerified(id), id).toBe(corsVerdict(id) === "verified");
    }
  });

  it("a LABELLED first-party id is `unmeasured`, and that branch is the point", () => {
    // **Mutation m14 survived the whole suite by deleting this branch.** Nothing
    // asserted `corsVerdict` for any labelled first-party id, so
    // `corsVerdict("anthropic:eu")` could report `"verified"` with everything else
    // green — and a badge reading „CORS bestätigt" on a **region nobody measured**
    // is exactly the claim this function exists to refuse.
    //
    // The two first-party rows that *can* be labelled, both ways, plus the boundary
    // case the parser produces: `anthropic:` has an **empty** label, and
    // `parseVendorId` normalises that to `name: undefined` — so it is the bare id
    // and keeps the measurement. Asserting it makes the normalisation visible
    // rather than incidental.
    for (const id of ["anthropic:eu", "anthropic:us", "anthropic:x", "anthropic:0"]) {
      expect(corsVerdict(id), id).toBe("unmeasured");
      expect(isCorsVerified(id), id).toBe(false);
    }
    for (const id of ["openai:eu", "google:eu"]) {
      expect(corsVerdict(id), id).toBe("unmeasured");
    }
    // The measured bare ids keep their verdicts, so the branch narrows and does not
    // simply turn everything into "unmeasured".
    expect(corsVerdict("anthropic")).toBe("verified");
    expect(corsVerdict("google")).toBe("verified");
    expect(corsVerdict("openai")).toBe("unconfirmed");
    // An empty label is no label: `parseVendorId` says so, and the branch follows
    // the parse rather than the character.
    expect(corsVerdict("anthropic:")).toBe("verified");
  });

  it("m13: a template is unmeasured in BOTH places, from ONE set", () => {
    // **Mutation m13 survived 615/615: a fourth shape added to `TEMPLATE_VENDORS`
    // alone.** `TEMPLATE_VENDORS` and `MEASURED_CORS` are two tables, and the
    // registry's comment claimed "one function, on purpose" against a drift that
    // was still reachable — a shape in one and not the other compiles and is wrong
    // in the other. There is no fourth table to collapse it into (the wire format
    // moved to the factory array), so the agreement is **asserted from outside**.
    //
    // This is the property that survives the mutation: whatever a new shape's row
    // says in `MEASURED_CORS`, a template must never be `verified`, because §9
    // measured **no** endpoint behind a template — the whole class is user-supplied.
    for (const template of ["openai-compatible", "anthropic-compatible"]) {
      // The set says it is a template…
      expect(resolveVendor(template).template, template).toBe(true);
      // …and the CORS table must agree, in both directions.
      expect(corsVerdict(template), template).toBe("unmeasured");
      expect(isCorsVerified(template), template).toBe(false);
      // …and the label must not change that, however it is spelled.
      expect(corsVerdict(`${template}:groq`), template).toBe("unmeasured");
      expect(corsVerdict(`${template}:groq`), template).toBe(corsVerdict(`${template}:anything-else`));
    }
  });

  it("a first-party row is in `MEASURED_CORS` and is not a template — both ways", () => {
    // The same agreement from the other side, and the half that catches a shape
    // added to `MEASURED_CORS` but not to `TEMPLATE_VENDORS`: that mutation would
    // give a new user-filled row a `verified` badge, which is the lie this function
    // was written to remove.
    const measured = ["anthropic", "google", "openai"] as const;
    for (const vendor of measured) {
      expect(resolveVendor(vendor).template, vendor).toBe(false);
      expect(corsVerdict(vendor), vendor).not.toBe("unmeasured");
    }
    // And the two sets partition the app's own ids exactly: a vendor is either
    // something §9 measured at a known endpoint, or a shape the user fills in.
    // Nothing is both, and nothing is neither.
    const templates = ["openai-compatible", "anthropic-compatible"];
    for (const vendor of [...measured, ...templates]) {
      const isTemplate = resolveVendor(vendor).template;
      expect(corsVerdict(vendor) === "unmeasured", vendor).toBe(isTemplate);
    }
  });
});

describe("resolveVendor — an operator and a label", () => {
  it("gives `anthropic-compatible` the third-party operator without a new vendor", () => {
    // P1's acceptance criterion 1: same wire format as first-party, different
    // operator. The **wire format** half is asserted where the routing lives — in
    // `baah-web/src/providers/factories.test.ts`, against the real SDK calls —
    // because the `dialect` field that used to carry it here had no production
    // reader and was deleted (`AGENTS.md` §5; the module header says why).
    //
    // What is left on this side is the **claim**, and that is what this asserts.
    const thirdParty = resolveVendor("anthropic-compatible:my-proxy");
    expect(thirdParty.operator).toBe("third-party");
    expect(thirdParty.name).toBe("my-proxy");
    expect(thirdParty.template).toBe(true);

    expect(resolveVendor("anthropic").operator).toBe("anthropic");
    expect(resolveVendor("anthropic").template).toBe(false);
  });

  it("splits on the first colon, so a label may contain one", () => {
    // A label containing a colon must still never become a URL — this is the
    // shape of the old `https://groq/…` bug, one syntax level over.
    const resolved = resolveVendor("anthropic-compatible:my:proxy:8080");
    expect(resolved.vendor).toBe("anthropic-compatible");
    expect(resolved.name).toBe("my:proxy:8080");

    const factory = fakeFactory("anthropic-compatible");
    createProviderModel({
      settings: settings({ vendor: "anthropic-compatible:my:proxy:8080" }),
      factories: [factory],
    });
    expect(factory.calls[0]?.baseUrl).toBeUndefined();
  });

  it("refuses an id it does not know by name, rather than building one", () => {
    // The wire format for an unknown id is not "guessed at `chat-completions`" —
    // no factory is registered for it, so `createProviderModel` names the gap.
    // Asserted here because the *refusal* is this layer's, and because the deleted
    // `dialect: undefined` used to be the mechanism a reader was told to look for.
    //
    // The factory list holds a **different** vendor on purpose: registering a
    // `cohere` factory and then expecting a refusal would assert the opposite of
    // what the code does, and would pass for the wrong reason.
    const known = fakeFactory("anthropic");
    expect(() => createProviderModel({ settings: settings({ vendor: "cohere" }), factories: [known] })).toThrow(
      /No provider factory registered for "cohere"/,
    );
    expect(known.calls).toHaveLength(0);

    // And an empty id resolves to the safe default rather than to a request.
    expect(resolveVendor("").operator).toBe("third-party");
    expect(resolveVendor("").template).toBe(false);
    expect(resolveVendor("anthropic-compatible:my-proxy").operator).toBe("third-party");
  });

  it("tolerates the bare vendor half as well as the full id", () => {
    // Every caller in the app has a full id; the pure function must not be the
    // one place that breaks if someone hands it the half.
    expect(resolveVendor("openai-compatible").name).toBeUndefined();
    expect(resolveVendor("openai-compatible").template).toBe(true);
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

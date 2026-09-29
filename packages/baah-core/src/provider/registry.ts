/**
 * Provider registry: a string id → a configured `LanguageModel`.
 *
 * ## Why this file owns headers and keys
 *
 * Two facts from `Plan.md` §9/§14.4 are not the app's business to rediscover,
 * and both are silent failures when forgotten:
 *
 * 1. **Anthropic needs `anthropic-dangerous-direct-browser-access: true`.** The
 *    SDK does not add it. Without it Anthropic answers `401` *without* an
 *    `access-control-allow-origin` header, so the browser turns a wrong key into
 *    an opaque `TypeError: Failed to fetch` and the user blames the app.
 * 2. **The API key must be passed explicitly.** There is no `process.env`
 *    fallback in a browser; without `apiKey` the SDK throws `LoadAPIKeyError` on
 *    the first call rather than at construction time.
 *
 * So the registry computes the required headers from the vendor and hands them
 * to the factory together with the key. The factory wires them into whatever the
 * vendor SDK wants; it never invents a header.
 *
 * ## OpenAI is unverified, and this file does not pretend otherwise
 *
 * §9 measured that `POST /v1/chat/completions` and `POST /v1/responses` return
 * **no ACAO on the error path** (only `/v1/models` sends `*`). Whether the
 * success path sends it is untested — that needs a real key, and a key must not
 * live in this repo. OpenAI is therefore registered like any other vendor and
 * marked as needing the onboarding connection test (`Plan.md` §8.1 step 3);
 * nothing here claims it works.
 *
 * ## OpenRouter is deliberately absent
 *
 * `Plan.md` §9 lists OpenRouter as CORS-friendly, but **no package for it is
 * installed** and the community ones are unmaintained forks. Adding it would
 * mean adding a dependency, which is out of scope here. `Plan.md` §7 adds the
 * deeper reason anyway: a provider is unsupported if CORS blocks it, and we
 * never add a proxy to work around that. Whoever wants OpenRouter adds it as an
 * `openai-compatible` entry, which needs no new package at all.
 *
 * ## Factories are injected
 *
 * None of `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` or
 * `@ai-sdk/openai-compatible` is a dependency of this package, and none is
 * resolvable from it (verified: `require.resolve` fails for all four). The app
 * passes the real factories in. That keeps this file free of vendor imports,
 * makes the CORS/key rules testable without a network, and means adding a vendor
 * is a one-line change at the composition root.
 */

import type { LanguageModel } from "ai";

/** Vendors with a measured CORS story (Plan.md §9). */
export type ProviderVendor = "openai" | "anthropic" | "google" | "openai-compatible";

export interface ProviderSettings {
  /** `openai`, `anthropic`, `google`, or a custom name for `openai-compatible`. */
  vendor: ProviderVendor | (string & {});
  /** Model id passed to the vendor, e.g. `gpt-4o`, `claude-haiku-4-5`. */
  model: string;
  /**
   * Explicit key. Required — there is no environment fallback in a browser
   * (§9), and an empty string is treated as missing rather than sent.
   */
  apiKey: string;
  /**
   * Base URL for `openai-compatible`, and an override for the built-ins.
   * Omitted means the vendor SDK's own default.
   */
  baseUrl?: string | undefined;
  /**
   * Name of a custom `openai-compatible` entry; a fallback when the vendor id
   * carries no suffix.
   *
   * A **label, and only a label.** It is never used as a base URL: a name is
   * something the user typed, and putting it in front of a request produced
   * `https://groq/…` — a URL that cannot resolve, for a reason no error message
   * would explain. `baseUrl` is the one field that decides where requests go,
   * and it is the user's to set.
   */
  name?: string | undefined;
  /**
   * Extra headers, merged **underneath** the required ones so a required header
   * can never be dropped by an accident in the settings.
   */
  headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * What a vendor SDK wrapper must be able to do.
 *
 * Three capabilities, not one: a vendor that cannot take headers, a key and a
 * model is not expressible here, and pretending otherwise would push the
 * Anthropic bug back into the app.
 */
export interface ProviderFactory {
  readonly vendor: string;
  /**
   * Build a model.
   *
   * @param apiKey passed explicitly; the SDKs throw `LoadAPIKeyError` without it.
   * @param headers already contains every required header (see
   *   {@link requiredHeaders}); the factory must pass them through, not filter.
   * @param baseUrl `undefined` means "use the vendor default".
   */
  create(options: {
    apiKey: string;
    model: string;
    headers: Record<string, string>;
    baseUrl: string | undefined;
  }): LanguageModel;
}

/**
 * Headers a vendor cannot work without from a browser (Plan.md §9, measured).
 *
 * Anthropic's `401` carries no `access-control-allow-origin` unless this
 * header is set — the SDK does not add it, so it has to be added here or the
 * browser reports a wrong key as a network failure.
 *
 * These are merged **last** in {@link createProviderModel}, and the reason is a
 * security one rather than a tidiness one: Anthropic without this header turns a
 * wrong key into an opaque `TypeError: Failed to fetch`, and a settings object
 * that happens to carry the same header with `"false"` in it would turn a
 * working key into the same opaque failure. Object spread merges right-to-left,
 * so "last" is what wins — the earlier arrangement merged required headers
 * *first* and the caller's value silently overwrote them, which is the exact
 * opposite of what the comment beside it claimed.
 */
export function requiredHeaders(vendor: string): Record<string, string> {
  if (vendor === "anthropic") {
    return { "anthropic-dangerous-direct-browser-access": "true" };
  }
  return {};
}

/** Does the browser-direct path have a measured CORS story? (Plan.md §9) */
export function isCorsVerified(vendor: string): boolean {
  return vendor !== "openai";
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unknown_vendor"
      | "missing_api_key"
      | "missing_model"
      | "missing_name"
      | "duplicate_vendor",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * A vendor name, or a custom `openai-compatible` label.
 *
 * Splits on the **first** colon, so `openai-compatible:groq:llama-3` is the
 * vendor `openai-compatible` with the label `groq:llama-3`. That is deliberate:
 * the label is a label (see {@link ProviderSettings.name}) and a colon inside it
 * is harmless now, because a label never becomes a URL. The error message at
 * {@link createProviderModel} used to recommend exactly that three-part form
 * while the parser could only produce a two-part one — and the three-part form's
 * label was then handed to the vendor SDK as a base URL.
 */
export function parseVendorId(value: string): { vendor: string; name: string | undefined } {
  const separator = value.indexOf(":");
  if (separator < 0) return { vendor: value, name: undefined };
  const vendor = value.slice(0, separator);
  const name = value.slice(separator + 1);
  return name === "" ? { vendor, name: undefined } : { vendor, name };
}

/**
 * A short, non-reversible digest of an API key.
 *
 * **Why a hash and not the key itself.** The fingerprint is a memo key, and a
 * memo key is the kind of value that ends up in a log line, a `?raw` source
 * dump, an error message or an IndexedDB row without anybody deciding to put it
 * there. The key is a credential; a memo key must not be able to become one.
 *
 * **Why `crypto.subtle` and not a hand-rolled mix.** AGENTS.md §2 names
 * `crypto.subtle` as the only hashing primitive in this package, and a
 * synchronous "good enough" hash would be exactly the sort of crypto that looks
 * fine and is not. The cost is that `crypto.subtle.digest` is **async**, which is
 * why {@link fingerprint} and {@link ProviderRegistry.resolve} are async too.
 * That is a real API cost and it is the honest one: a synchronous WebCrypto does
 * not exist, and a synchronous alternative would mean shipping a hash function.
 *
 * 8 of the 32 digest bytes. A cache key needs collision resistance against
 * *accidental* collisions, not preimage resistance, and 64 bits is far past what
 * a handful of provider configurations can collide on. Truncating also keeps the
 * key out of any eyeball-scannable string, which is half the point.
 */
async function digestKey(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  const bytes = new Uint8Array(digest).subarray(0, 8);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * A stable, **injective** key for memoization.
 *
 * The key itself is part of the value, the headers are part of the value, and
 * so is the API key — "two settings that differ only by key must not share a
 * model instance" is what the comment claimed and what the code did not do:
 * `fingerprint()` never read `apiKey`, so a user who pasted a new key got the
 * *old* key's model back until something else happened to change. The key enters
 * as a {@link digestKey}, never as itself.
 *
 * Injective, not merely collision-resistant: `JSON.stringify` of the parts
 * array, not a `join("|")`. A join is not injective — `baseUrl: "x|y", name: "z"`
 * and `baseUrl: "x", name: "y|z"` produce the same string, and the memo would
 * hand the first configuration's model to the second. Reaching that needs a pipe
 * character inside a base URL or a name, which is why it was rated latent; a
 * memo key should still be injective, and the fix is free.
 */
export async function fingerprint(settings: ProviderSettings): Promise<string> {
  return JSON.stringify([
    settings.vendor,
    settings.model,
    settings.baseUrl ?? "",
    settings.name ?? "",
    // Sorted so a settings round-trip that reorders headers is not a rebuild.
    JSON.stringify(Object.entries(settings.headers ?? {}).sort()),
    await digestKey(settings.apiKey),
  ]);
}

export interface ProviderRegistryOptions {
  settings: ProviderSettings;
  factories: readonly ProviderFactory[];
}

/**
 * Resolve the settings to a `LanguageModel`.
 *
 * Not memoised on its own — a cached instance is a *decision* that a settings
 * change is irrelevant, and the settings screen changes provider, model and key
 * while the app is running. Callers memoise with {@link fingerprint}.
 */
export function createProviderModel(options: ProviderRegistryOptions): LanguageModel {
  const { settings, factories } = options;
  const { vendor, name: nameFromId } = parseVendorId(settings.vendor);
  /**
   * One label, resolved once, from the id suffix or the field.
   *
   * The id suffix wins. It used to be read twice and differently: the presence
   * check read `nameFromId ?? settings.name` while everything after read the
   * suffix alone, so `settings.name` decided whether the call succeeded and
   * nothing about what happened next.
   *
   * **Honest scope of that claim:** the resolved label has exactly one consumer
   * today — the presence check — because the factory takes no label and the
   * fingerprint uses the raw `settings.name` field. The *precedence* between the
   * two sources is therefore not observable, and reversing it is an equivalent
   * mutation rather than a killed one. It is written the way it is because the
   * id is the more specific of the two and the direction should not depend on
   * which line a later edit happens to touch.
   */
  const name = nameFromId ?? settings.name;

  if (settings.model.trim() === "") {
    throw new ProviderError("A model must be selected", "missing_model");
  }
  if (settings.apiKey.trim() === "") {
    // Named explicitly because the alternative — a `LoadAPIKeyError` thrown
    // from inside the SDK on the first request — reads as a network problem.
    throw new ProviderError(
      "No API key configured. The AI SDK reads no environment in a browser, so the key must be passed explicitly.",
      "missing_api_key",
    );
  }
  if (vendor === "openai-compatible" && name === undefined) {
    throw new ProviderError(
      'An openai-compatible entry needs a name, e.g. vendor `openai-compatible:groq` with ' +
        'baseUrl "https://api.groq.com/openai/v1". The name is a label; only `baseUrl` decides ' +
        "where requests go.",
      "missing_name",
    );
  }

  const factory = factories.find((candidate) => candidate.vendor === vendor);
  if (factory === undefined) {
    throw new ProviderError(`No provider factory registered for "${vendor}"`, "unknown_vendor");
  }

  return factory.create({
    apiKey: settings.apiKey,
    model: settings.model,
    // Required headers LAST: object spread merges right-to-left, so this is the
    // side that wins. The two comments that used to claim the opposite — one on
    // `ProviderSettings.headers`, one right here — described an arrangement that
    // let a caller's `headers` drop `anthropic-dangerous-direct-browser-access`,
    // i.e. turned a working key into an opaque `Failed to fetch`.
    headers: { ...(settings.headers ?? {}), ...requiredHeaders(vendor) },
    // **Only** the explicit `baseUrl`. The id suffix is a label; feeding it in
    // here is what produced `https://groq/…` for an entry the user had simply
    // not given a URL for.
    baseUrl: settings.baseUrl,
  });
}

/**
 * A registry that can be rebuilt at runtime.
 *
 * The settings screen hands it a new settings object and gets a fresh model;
 * two calls with the same fingerprint get the *same* instance, so a settings
 * round-trip that did not change anything does not rebuild the provider.
 *
 * ## It is one slot, not a map — and that is a deliberate trade
 *
 * `#cached` holds exactly one entry. A caller alternating between two settings
 * objects — two sessions, or a user switching provider between turns — never
 * hits the memo and rebuilds every time.
 *
 * That is a **performance** property, not a correctness one, and the reason it
 * stays is that the alternative has a real cost this does not. A `Map` would
 * hold live provider clients — each with its own key in memory — indefinitely,
 * with no way to know when a settings change has made every one of them
 * garbage. One slot means the previous instance is collectable the moment the
 * next one is built, and a rebuild is a `create*` call, not a request. The
 * settings screen, which is the caller that alternates most, is exactly where a
 * rebuild is free.
 *
 * `invalidate()` exists for the case that does need a hard drop: deleting a key
 * must not leave a live client holding it.
 */
export class ProviderRegistry {
  readonly #factories: readonly ProviderFactory[];
  #cached: { key: string; model: LanguageModel } | undefined;

  constructor(factories: readonly ProviderFactory[]) {
    const seen = new Set<string>();
    for (const factory of factories) {
      if (seen.has(factory.vendor)) {
        // A duplicate would make the resolved vendor depend on array order.
        throw new ProviderError(`Duplicate provider factory: ${factory.vendor}`, "duplicate_vendor");
      }
      seen.add(factory.vendor);
    }
    this.#factories = factories;
  }

  /**
   * Resolve, reusing the instance when the settings are unchanged.
   *
   * Async because {@link fingerprint} is: the API key enters the memo key as a
   * `crypto.subtle` digest, and there is no synchronous WebCrypto. The
   * alternative — a hand-rolled synchronous hash — would be shipping crypto to
   * avoid one `await`, which is the wrong trade in a file that also says a key
   * must never end up in a loggable string.
   */
  async resolve(settings: ProviderSettings): Promise<LanguageModel> {
    const key = await fingerprint(settings);
    if (this.#cached?.key === key) return this.#cached.model;
    const model = createProviderModel({ settings, factories: this.#factories });
    this.#cached = { key, model };
    return model;
  }

  /** Drop the cached instance, e.g. when the key is deleted. */
  invalidate(): void {
    this.#cached = undefined;
  }

  /** The vendors this registry can build, in registration order. */
  vendors(): string[] {
    return this.#factories.map((factory) => factory.vendor);
  }
}

/**
 * Adapt a vendor SDK's `create*` function into a {@link ProviderFactory}.
 *
 * This is how the app wires a real SDK without this file importing one:
 *
 * ```ts
 * import { createAnthropic } from "@ai-sdk/anthropic";
 * createProviderRegistry([
 *   anthropicFactory(createAnthropic),
 *   openAiCompatibleFactory(createOpenAICompatible),
 * ]);
 * ```
 *
 * The wrapper is thin on purpose: it forwards the key, the headers and the base
 * URL and nothing else. In particular it does **not** add a browser flag —
 * `dangerouslyAllowBrowser` does not exist in the AI SDK (§14.4), and there is
 * nothing to switch on.
 */
export function defineProviderFactory(
  vendor: string,
  create: (options: {
    apiKey: string;
    baseURL?: string | undefined;
    headers?: Record<string, string> | undefined;
  }) => { languageModel(modelId: string): LanguageModel },
): ProviderFactory {
  return {
    vendor,
    create({ apiKey, model, headers, baseUrl }) {
      const provider = create({
        apiKey,
        ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
        ...(headers === undefined ? {} : { headers }),
      });
      return provider.languageModel(model);
    },
  };
}

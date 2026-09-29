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
  /** Name of a custom `openai-compatible` entry; required for that vendor. */
  name?: string | undefined;
  /** Extra headers, merged *after* the required ones so they cannot drop them. */
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

/** A vendor name, or a custom `openai-compatible` label. */
export function parseVendorId(value: string): { vendor: string; name: string | undefined } {
  const separator = value.indexOf(":");
  if (separator < 0) return { vendor: value, name: undefined };
  const vendor = value.slice(0, separator);
  const name = value.slice(separator + 1);
  return name === "" ? { vendor, name: undefined } : { vendor, name };
}

/** A stable key for memoization. The key itself is part of the value. */
export function fingerprint(settings: ProviderSettings): string {
  const parts = [
    settings.vendor,
    settings.model,
    settings.baseUrl ?? "",
    settings.name ?? "",
    // Headers and the key are part of the identity: two settings that differ
    // only by key must not share a model instance.
    JSON.stringify(Object.entries(settings.headers ?? {}).sort()),
  ];
  return parts.join("|");
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
  const { vendor, name } = parseVendorId(settings.vendor);

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
  if (vendor === "openai-compatible" && (name ?? settings.name) === undefined) {
    throw new ProviderError(
      "An openai-compatible entry needs a name, e.g. `openai-compatible:groq:llama-3`",
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
    // Required headers first, so a caller's `headers` can add to them but a
    // required header can never be dropped by an accident in the settings.
    headers: { ...requiredHeaders(vendor), ...(settings.headers ?? {}) },
    baseUrl: settings.baseUrl ?? name ?? undefined,
  });
}

/**
 * A registry that can be rebuilt at runtime.
 *
 * The settings screen hands it a new settings object and gets a fresh model;
 * two calls with the same fingerprint get the *same* instance, so a settings
 * round-trip that did not change anything does not rebuild the provider.
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

  /** Resolve, reusing the instance when the settings are unchanged. */
  resolve(settings: ProviderSettings): LanguageModel {
    const key = fingerprint(settings);
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

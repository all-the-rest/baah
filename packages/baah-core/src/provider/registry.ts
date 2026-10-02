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
 *
 * ## A vendor id is a **label for an endpoint**, not a vendor
 *
 * The string before the first colon (`parseVendorId`) used to be the whole of a
 * provider's identity, which conflated two different things. This file now
 * separates them, and each one is named because each one answers a different
 * question:
 *
 * | concept | question | wrong answer costs |
 * |---|---|---|
 * | {@link ProviderOperator} — who **runs** the endpoint | which headers may we claim? | asserting Anthropic's browser-access policy to a third party |
 * | the **label** after the colon | which of this user's entries is it? | `https://groq/…`, a URL nobody chose |
 *
 * `anthropic-compatible:<label>` is the case that forced the split: it speaks the
 * Messages dialect, and it is *not* Anthropic. It is therefore a fifth **catalog
 * row**, not a fifth member of {@link ProviderVendor} — a vendor is a company,
 * and adding a member per dialect would count dialects as vendors.
 *
 * ### The wire format is a third question, and it is answered **where it is used**
 *
 * "Which request shape goes out?" is real — a `chat/completions` POST to a
 * `/messages` server fails *silently* — and it used to be a `ProviderDialect` field
 * on {@link ResolvedVendor}. **It was deleted**, and the reason is measured rather
 * than stylistic: `rg '\.dialect'` over every `src/` in the workspace found zero
 * readers outside this file and its own test. The routing that actually decides the
 * request is the factory array in `baah-web/src/providers/factories.ts`, and it
 * cannot read a field from here without becoming the place where a dialect is
 * declared *and* the place where a factory is written — two lists that would drift
 * exactly the way this file's header is about.
 *
 * `AGENTS.md` §5: no speculative abstractions. A well-documented field with no
 * production reader is one, and a comment explaining why it is valuable is not an
 * argument for keeping it — it is the thing the next reader has to un-believe.
 * The distinction itself survives where it is load-bearing: {@link TEMPLATE_VENDORS}
 * names the two shapes, and the note on {@link ProviderOperator} says why they
 * cannot be decided by wire format.
 */

import type { LanguageModel } from "ai";

/**
 * Vendors this app can address at a known, measured endpoint.
 *
 * **Not "every vendor id there is".** `openai-compatible` and
 * `anthropic-compatible` are *shapes* a user fills in, so their CORS story is
 * whatever the connection test finds and nothing else — see
 * {@link corsVerdict}. `ProviderSettings.vendor` accepts them anyway, through the
 * `(string & {})` escape hatch.
 */
export type ProviderVendor = "openai" | "anthropic" | "google" | "openai-compatible";

/**
 * Who **runs** the endpoint this vendor id names.
 *
 * ## Why this is a concept and not a `vendor === "anthropic"` test
 *
 * `anthropic-dangerous-direct-browser-access: true` is not a formatting hint. It
 * is a statement the client makes **about the security model of the machine on
 * the other end**: "I am a browser, my key is exposed to the page, I accept
 * that." `Plan.md` §9 measured it against `api.anthropic.com` and nowhere else.
 *
 * So it cannot key off the **wire format**: `anthropic` and `anthropic-compatible`
 * both speak the Messages API, and sending the header to the second one would tell a
 * third party a true-sounding claim about a security model that is not theirs —
 * while also revealing that this app talks to Anthropic at all.
 *
 * ## What the operator *is* — and what it is not, measured
 *
 * **An earlier version of this comment claimed the operator is decided
 * independently of the string** ("the operator *is* the identity claim; the string
 * is only how the user typed it"). Measured over 16 adversarial ids — `anthropic:eu`,
 * `Anthropic`, `" anthropic"`, `anthropic-compatible:anthropic`, `""`, `":"`, … —
 * `operator === "anthropic"` and `parseVendorId(id).vendor === "anthropic"` had
 * **0 mismatches**. They are the same predicate, because
 * {@link resolveVendor} computes one and derives the other from it.
 *
 * So the independence is not there, and a comment claiming it is worse than a
 * comment that names the mechanism: a reader who trusts it looks for a claim
 * registry, does not find one, and has to re-derive the actual rule.
 *
 * **What the parse does buy, and it is not nothing:**
 *
 * 1. It closes the `startsWith` class. `"anthropic-compatible:x".startsWith("anthropic")`
 *    is `true`; a first-colon split is not fooled by it. The distinction between
 *    "a name" and "a name and a label" is what makes `anthropic-compatible` a
 *    separate row possible at all.
 * 2. {@link TEMPLATE_VENDORS} is **one shared set**, so the second template cannot be
 *    added to one switch and forgotten in another. See the note on
 *    {@link resolveVendor}.
 * 3. The *claim* is now a named value in {@link ResolvedVendor} rather than a
 *    comparison a reader has to spot — so the next vendor id added anywhere has to
 *    decide it, rather than inheriting "not Anthropic" by accident.
 *
 * That is the real property, and it is worth having. It is just not
 * independence, and the difference is the whole reason this paragraph was rewritten.
 *
 * ## Why `baseUrl` does not decide it — a decision, not an accident
 *
 * `vendor: "anthropic"` with a `baseUrl` of `https://proxy.example` sends the
 * header there, and **that is deliberate**: the user selected the **Anthropic**
 * row and typed that address, which is a claim that the endpoint *is* Anthropic,
 * reached by a route. A proxy in front of Anthropic genuinely needs the header
 * forwarded, and refusing it would break a deployment that works. The row that
 * says "this is **not** Anthropic" is `anthropic-compatible:<label>`, and it
 * exists precisely so that claim can be made. `routing` and `identity` are
 * different questions; only the second one licenses a header.
 *
 * ⚠️ **The route this leaves open, named rather than hidden.** `baseUrl` is
 * reachable without the wizard: it is a bare `z.string().optional()` in the §8.2
 * import schema (`baah-web/src/lib/settings.ts`), so an imported settings file can
 * put a foreign `baseUrl` on the `anthropic` row. That is the **same** third-party
 * disclosure the `anthropic-compatible` row exists to prevent, reached by a
 * different route, and the policy above accepts it on purpose: an operator who
 * imports a configuration has stated the same claim the wizard would have.
 * `verify-provider-registry.test.ts` pins the behaviour so it is a **decision with
 * a test** rather than an accident, and the alternative — keying the header off
 * the hostname — was not taken because it would make a *guess about a host* the
 * arbiter of a security claim, which is strictly worse.
 *
 * **Deny by default.** Anything not measured as Anthropic-operated is
 * `third-party`, including a typo and including a vendor id added tomorrow.
 */
export type ProviderOperator = "anthropic" | "third-party";

export interface ProviderSettings {
  /**
   * The vendor id: `openai`, `anthropic`, `google`, `openai-compatible:<label>`
   * or `anthropic-compatible:<label>`.
   *
   * A **full** id, label included — that is what the wizard stores, what
   * {@link parseVendorId} splits, and what {@link fingerprint} compares. An
   * entry that needs a label and has none is refused by name rather than
   * silently addressed at a default.
   *
   * `anthropic-compatible:<label>` is a *shape*, not a vendor: it speaks the
   * Messages dialect at somebody else's address, which is why it is not a member
   * of {@link ProviderVendor}. See the module header.
   */
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
   * Name of a custom `openai-compatible` / `anthropic-compatible` entry; a
   * fallback when the vendor id carries no suffix.
   *
   * A **label, and only a label.** It is never used as a base URL: a name is
   * something the user typed, and putting it in front of a request produced
   * `https://groq/…` — a URL that cannot resolve, for a reason no error message
   * would explain. `baseUrl` is the one field that decides where requests go,
   * and it is the user's to set. The same is true **because** the label cannot
   * reach {@link corsVerdict}: an operator claim is made by the *shape*, never
   * by what the user typed after the colon.
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
 * **The parameter is the vendor id, and it is parsed before anything else.**
 * `requiredHeaders("anthropic")` and `requiredHeaders("anthropic-compatible:my-proxy")`
 * are different answers, and the second one is the whole reason this function
 * goes through {@link resolveVendor} rather than comparing the raw string: the
 * raw string `anthropic` is a prefix of a string that must **not** get the
 * header, so an equality test on the unparsed id is one careless refactor away
 * from `startsWith`-style leakage.
 *
 * These are merged **last** in {@link createProviderModel}, and the reason is a
 * security one rather than a tidiness one: Anthropic without this header turns a
 * wrong key into an opaque `TypeError: Failed to fetch`, and a settings object
 * that happens to carry the same header with `"false"` in it would turn a
 * working key into the same opaque failure. Object spread merges right-to-left,
 * so "last" is what wins — the earlier arrangement merged required headers
 * *first* and the caller's value silently overwrote them, which is the exact
 * opposite of what the comment beside it claimed.
 *
 * Note the asymmetry with `anthropic-version`, which the SDK sets itself and
 * which therefore goes out to `anthropic-compatible` as well: **one header is a
 * request parameter of the dialect, the other is a claim about the operator.**
 */
export function requiredHeaders(vendor: string): Record<string, string> {
  if (resolveVendor(vendor).operator === "anthropic") {
    return { "anthropic-dangerous-direct-browser-access": "true" };
  }
  return {};
}

/**
 * How much is known about a vendor id's browser-direct story (Plan.md §9).
 *
 * Three states, because two states cannot say what has to be said:
 *
 * | state | meaning |
 * |---|---|
 * | `"verified"` | measured to work from a browser (`*`, or an origin echo) |
 * | `"unconfirmed"` | measured, and the measurement does **not** establish it — OpenAI's inference endpoints send no ACAO on the error path |
 * | `"unmeasured"` | nobody looked, or what was looked at is not this endpoint |
 */
export type CorsVerdict = "verified" | "unconfirmed" | "unmeasured";

/**
 * §9's first-party rows, read off the table rather than inferred.
 *
 * An explicit table, not a default and not a comparison — the failure mode this
 * whole function exists to remove is a *default* answering for an endpoint nobody
 * measured, so the absence of a row is the meaningful case and it has to be
 * legible as such.
 *
 * `openai` is `"unconfirmed"`, not `"verified"`: `/v1/models` sends ACAO but the
 * inference endpoints send none on the error path, and whether the success path
 * sends one needs a real key, which does not live in this repo (§9).
 */
const MEASURED_CORS: Readonly<Record<string, CorsVerdict>> = Object.freeze({
  anthropic: "verified",
  google: "verified",
  openai: "unconfirmed",
});

/**
 * What §9 actually established for this endpoint.
 *
 * ## The bug this replaces, measured
 *
 * `return vendor !== "openai"` is a lie generator. It was `true` for
 * `anthropic-compatible:anything`, for `google`, and — because `!==` matches
 * every string that is not literally `"openai"` — for `"openaai"`, for `""`, for
 * any typo and for any vendor id added next month. A user who mistyped one got
 * a wizard badge reading „CORS bestätigt" (`Onboarding.tsx` renders it from this
 * value) on the strength of a string comparison that measured nothing.
 *
 * `openai-compatible` is the case that makes the third state unavoidable rather
 * than theoretical. §9's row is "beliebige OpenAI-kompatible `baseURL`:
 * **zur Laufzeit prüfen**" — and the row covers *six named* operators, none of
 * which the app knows about by id. `openai-compatible` is a **template** for a
 * user-supplied endpoint, and the endpoint named `openai-compatible:my-vllm` has
 * never been measured by anyone. Reporting `"verified"` for it because the vendor
 * half is a known one is precisely the truncation this function exists to stop
 * reporting.
 *
 * So: the measured set is the three first-party operators, and a vendor id that
 * is only a *shape* is `"unmeasured"` — the connection test (`probe.ts`) is what
 * settles it, which is what the wizard already tells the user to do.
 *
 * **Separate from {@link ProviderOperator}, deliberately.** Google is
 * `"verified"` and is not Anthropic-operated, and Anthropic is `"verified"` and
 * is. Deriving one from the other would have made Google's row wrong the moment
 * the two functions were written, which is the argument for both being derived
 * once in {@link resolveVendor} and neither being derived from the other.
 */
export function corsVerdict(vendor: string): CorsVerdict {
  const resolved = resolveVendor(vendor);
  // A first-party vendor id *with* a label suffix is not the plain endpoint any
  // more (`anthropic:eu` is a claim about a region nobody measured), so the
  // measurement only holds for the bare id.
  if (resolved.name !== undefined) return "unmeasured";
  // **The absence from {@link MEASURED_CORS} is the mechanism, not an oversight.**
  // `openai-compatible` and `anthropic-compatible` are deliberately *not* in that
  // table, which is why a bare `openai-compatible` — a template, no label, no
  // operator claim — still lands on `"unmeasured". An earlier draft also tested
  // `resolved.template` here; that was redundant with the fallback below, and a
  // redundant branch with a comment saying it was load-bearing is worse than no
  // branch, because the next reader counts on it and stops looking at the table.
  return MEASURED_CORS[resolved.vendor] ?? "unmeasured";
}

/**
 * Does the browser-direct path have a measured CORS story? (Plan.md §9)
 *
 * **A strict "yes", and the narrowing is the point.** `false` now means *either*
 * "measured, and no" *or* "not measured" — so a caller that needs the
 * difference must call {@link corsVerdict}. This wrapper exists so the common
 * question ("can I show the green badge") has one name, and it exists next to
 * the three-state function so the loss is visible at the call site.
 */
export function isCorsVerified(vendor: string): boolean {
  return corsVerdict(vendor) === "verified";
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
 * The vendor-id **shapes** that stand for an endpoint nobody here has measured.
 *
 * `openai-compatible` and `anthropic-compatible` are not vendors, and the
 * distinction is load-bearing in two places:
 *
 * - **the wire format** — they are the *same dialect* as their first-party
 *   namesake (`anthropic-compatible` speaks the Messages API), which is what makes
 *   a third-party Messages endpoint expressible without a fifth member of
 *   {@link ProviderVendor}. That mapping lives where it is used — the factory array
 *   in `baah-web/src/providers/factories.ts` — and a `ProviderDialect` field here
 *   was deleted for having no production reader (see the module header);
 * - {@link corsVerdict} — they are *unmeasured*, always. §9 measured six named
 *   OpenAI-compatible operators (Groq, xAI, Mistral, Cerebras, Together,
 *   DeepSeek) and no `anthropic-compatible` endpoint at all, and the app has no
 *   id for any of them: the label is free text, so nothing downstream can tell
 *   `openai-compatible:groq` from `openai-compatible:my-vllm`.
 *
 * **Not derived from the presence of a label.** `openai-compatible` *without* a
 * label is the same template — the wizard renders it, it is still a row the user
 * fills in — and `resolveVendor` therefore keys on the vendor half alone. Keying
 * on "has a label" instead would make `openai-compatible` the one shape whose
 * verdict changes when the user leaves a field empty, which is not a fact about
 * the endpoint.
 *
 * ### The one set, and why the drift it prevents is now tested
 *
 * The doc above used to claim "one function, on purpose" against a drift that was
 * still reachable: the shapes were derived in **three** places — this set,
 * `corsVerdict`'s table, and (then) a dialect switch — and a fourth shape added to
 * one of them would compile and be wrong in the others. The set is now the single
 * source for "is this a template", and
 * `verify-provider-registry.test.ts` › "every template resolves to one dialect and
 * one CORS verdict" asserts the agreement from the outside, so adding a shape
 * alone fails a test rather than passing quietly.
 */
const TEMPLATE_VENDORS: ReadonlySet<string> = new Set(["openai-compatible", "anthropic-compatible"]);

/**
 * A vendor id, resolved into the things it conflates.
 *
 * **One function, on purpose.** The operator and the template flag are answers to
 * two different questions about the same string, and deriving them in two places is
 * how they drift. Every caller here reads this one.
 */
export interface ResolvedVendor {
  /** The vendor half, before the first colon. */
  readonly vendor: string;
  /** The label after the first colon. Never a URL. */
  readonly name: string | undefined;
  /** Who runs the endpoint — the thing the required header is a claim about. */
  readonly operator: ProviderOperator;
  /** A shape the user fills in, rather than a vendor with its own endpoint. */
  readonly template: boolean;
}

/**
 * Split a vendor id into {@link ResolvedVendor}.
 *
 * Accepts the **full id**, label included — `resolveVendor("openai-compatible:groq")`
 * — because every caller in the app has a full id (it is what
 * {@link ProviderSettings.vendor} holds) and a function that only accepted the
 * vendor half would be one more thing to get wrong at each call site. It
 * tolerates the bare half too, since {@link parseVendorId} on a bare vendor
 * returns `name: undefined`.
 *
 * **`anthropic-compatible` resolves to `operator: "third-party"` because the
 * operator is decided by the *shape the user picked*, not by the word
 * "anthropic" appearing in it.** `anthropic-compatible:anthropic` is still not
 * Anthropic, and this is the property that keeps {@link requiredHeaders} from
 * becoming a substring test.
 *
 * An **unknown** id resolves without error: `operator: "third-party"`,
 * `template: false`. It is a claim nobody made, which is the safe default, and
 * {@link createProviderModel} refuses it by name on the missing factory rather
 * than on anything this function decides.
 */
export function resolveVendor(value: string): ResolvedVendor {
  const { vendor, name } = parseVendorId(value);
  const template = TEMPLATE_VENDORS.has(vendor);
  const firstParty = !template && vendor === "anthropic";
  return {
    vendor,
    name,
    // **Only the first-party shape.** `anthropic` is the one id in this app that
    // means "Anthropic's own endpoint"; every other id, including an unknown one,
    // is somebody else's server and gets no claim made about its security model.
    operator: firstParty ? "anthropic" : "third-party",
    template,
  };
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
  const resolved = resolveVendor(settings.vendor);
  const { vendor, template } = resolved;
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
  const name = resolved.name ?? settings.name;

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
  if (template && name === undefined) {
    // **Both** templates, keyed off `resolveVendor` rather than a second
    // `=== "openai-compatible"` string. `anthropic-compatible` is the new shape
    // and the check has to cover it, and a check that is written once here is
    // the only way the two shapes cannot drift apart.
    //
    // The example in the message is OpenAI-shaped because it is the one a user
    // is most likely to be reproducing; the requirement is the same either way.
    throw new ProviderError(
      `An ${vendor} entry needs a name, e.g. vendor \`${vendor}:groq\` with ` +
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
    //
    // The **full** id goes in, label included: the required header depends on the
    // operator, and the operator is a property of the whole id. Passing the
    // vendor half would work today (the label cannot change the operator) and
    // would be wrong the moment a shape exists whose operator *does* depend on
    // what the user called it.
    headers: { ...(settings.headers ?? {}), ...requiredHeaders(settings.vendor) },
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

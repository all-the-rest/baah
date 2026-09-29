/**
 * The connection test the onboarding wizard runs (`Plan.md` §8.1 step 3).
 *
 * ## A boolean would be a lie
 *
 * §9's OpenAI row is the reason. Measured, not guessed:
 *
 * ```
 * GET  /v1/models             → 401 + access-control-allow-origin: *
 * POST /v1/chat/completions   → 401 + (kein ACAO)
 * POST /v1/responses          → 401 + (kein ACAO)
 * ```
 *
 * So a browser calling `/v1/chat/completions` against OpenAI does not get a 401 —
 * it gets an opaque `TypeError: Failed to fetch`, exactly the same thing it gets
 * when the network is down. **The browser deliberately does not tell the two
 * apart.** A probe that returned `false` would train the user to blame their key
 * for a provider policy, and §9 says the opposite: the failure has to be
 * explained as "the provider blocks browser calls (or the key is wrong)", not as
 * an app bug.
 *
 * ## What makes the diagnosis possible anyway
 *
 * `/v1/models` *does* answer with a CORS header, on both the success and the
 * error path. So the probe asks **two** questions and compares the answers:
 *
 * | `/v1/models` | `/v1/chat/completions` | verdict |
 * |---|---|---|
 * | answered | answered | the key is good or the request is rejected — read the status |
 * | answered | **blocked** | **`cors-blocked`** — exactly §9's OpenAI finding |
 * | blocked | blocked | `unreachable` — DNS, offline, wrong base URL |
 * | blocked | answered | unusual; reported as-is rather than guessed at |
 *
 * The second row is the one the wizard exists for, and it is the row a single
 * boolean collapses into "your key is wrong".
 *
 * ## What this probe does not do
 *
 * It does not install a proxy (AGENTS.md §2 forbids it), it does not retry, and it
 * does not repair anything. A provider that blocks the browser is **not
 * supported** — that is the definition, not a defect to work around.
 *
 * ## Secrets
 *
 * The key travels in a header and nowhere else: never in a URL, never in the
 * report, never in an error message. Google's REST API accepts `x-goog-api-key`
 * precisely so the query-string form — which every server log on the path would
 * record — is not needed. A response body is not echoed either; only the
 * `type`/`code` fields of an error object are read out of it, because those are
 * enums that say "quota" or "invalid_api_key" without quoting the key back.
 */

import { requiredHeaders } from "@all-the.rest/baah-core";
import { apiKeySlot } from "../lib/ids.ts";
import type { SettingsSnapshot } from "../lib/settings.ts";
import { findProvider, isKnownProvider, parseCatalogId } from "./catalog.ts";

/* ------------------------------------------------------------------ */
/* What the probe observed                                             */
/* ------------------------------------------------------------------ */

export type ProbeOutcome = "ok" | "cors-blocked" | "unreachable" | "http-error";

/** Reads the *reason*, not just the failure. Rendered next to the outcome. */
export type ProbeVerdict = "none" | "key-rejected" | "rate-limited" | "provider-error" | "request-rejected";

export interface EndpointObservation {
  readonly url: string;
  readonly method: "GET" | "POST";
  /**
   * `answered` — the browser let us read the response.
   * `blocked`   — `fetch` rejected. **Could be CORS, could be the network.**
   * `threw`     — `fetch` rejected with a non-`TypeError`.
   */
  readonly result: "answered" | "blocked" | "threw";
  readonly status: number | undefined;
  readonly allowOrigin: string | undefined;
  readonly contentType: string | undefined;
  readonly elapsedMs: number;
  readonly errorKind: "none" | "cors-or-network" | "network" | "aborted";
  /** `error.type` / `error.code` from a JSON error body. Never the message. */
  readonly providerErrorType: string | undefined;
  readonly providerErrorCode: string | undefined;
}

export interface ConnectionProbeReport {
  readonly vendor: string;
  readonly model: string;
  readonly outcome: ProbeOutcome;
  readonly verdict: ProbeVerdict;
  readonly endpoints: {
    readonly models: EndpointObservation;
    readonly inference: EndpointObservation;
  };
  /** One line for the wizard. */
  readonly summary: string;
  /** Why, in sentences. May be empty when there is nothing to add. */
  readonly detail: string;
  readonly measuredAt: string;
  /** What `Plan.md` §9 already knew, so the wizard can say "not yet confirmed". */
  readonly corsVerifiedInPlan: boolean;
}

/* ------------------------------------------------------------------ */
/* The request                                                         */
/* ------------------------------------------------------------------ */

/** The narrowed `fetch` the probe uses, so a test can supply one. */
export type ProbeFetch = (input: string, init: ProbeRequestInit) => Promise<Response>;

export interface ProbeRequestInit {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly mode: "cors";
  readonly signal: AbortSignal;
}

export interface ConnectionProbeRequest {
  /** `openai`, `anthropic`, `google`, or `openai-compatible:<name>`. */
  readonly vendor: string;
  readonly model: string;
  /** Explicit, always (§9: the SDK reads no environment in a browser). */
  readonly apiKey: string;
  /** Required for `openai-compatible`; an override for the built-ins. */
  readonly baseUrl?: string | undefined;
  /** A label. Never becomes part of a URL. */
  readonly name?: string | undefined;
}

export interface ConnectionProbeOptions {
  readonly fetch?: ProbeFetch | undefined;
  /** Budget for the whole probe. A wizard must not hang on a black hole. */
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export class ConnectionProbeError extends Error {
  constructor(
    readonly code: "unknown_provider" | "missing_endpoint" | "missing_api_key" | "missing_model",
    message: string,
  ) {
    super(message);
    this.name = "ConnectionProbeError";
  }
}

/* ------------------------------------------------------------------ */
/* Per-vendor endpoints                                                */
/* ------------------------------------------------------------------ */

/** How a vendor authenticates. Never a query parameter (§ above). */
type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key";

interface VendorProbe {
  readonly auth: AuthStyle;
  readonly headers: Record<string, string>;
  /** Relative to the base URL. */
  readonly modelsPath: string;
  /** Relative to the base URL; `{model}` is substituted. */
  readonly inferencePath: string;
  /** The request body for the inference probe. The smallest legal one. */
  readonly inferenceBody: (model: string) => string;
}

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The minimal legal inference body per vendor.
 *
 * Small on purpose (§8.1: "minimaler Call"): one token, no system prompt, no
 * tools. A connection test that spends real tokens is a connection test users
 * disable.
 */
const BODIES = {
  chat: (model: string): string =>
    JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
    }),
  anthropic: (model: string): string =>
    JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
  google: (): string => JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }], maxOutputTokens: 1 }),
} as const;

function vendorProbe(vendor: string): VendorProbe {
  switch (vendor) {
    case "openai":
    case "openai-compatible":
      return {
        auth: "bearer",
        headers: {},
        modelsPath: "/models",
        inferencePath: "/chat/completions",
        inferenceBody: BODIES.chat,
      };
    case "anthropic":
      return {
        auth: "x-api-key",
        headers: { "anthropic-version": ANTHROPIC_VERSION },
        modelsPath: "/models",
        inferencePath: "/messages",
        inferenceBody: BODIES.anthropic,
      };
    case "google":
      return {
        auth: "x-goog-api-key",
        headers: {},
        modelsPath: "/models",
        // Google addresses the model in the path. The key is deliberately *not*
        // a `?key=` query parameter — a URL is the most loggable string there is.
        inferencePath: "/models/{model}:generateContent",
        inferenceBody: BODIES.google,
      };
    default:
      throw new ConnectionProbeError(
        "unknown_provider",
        `No connection test is defined for "${vendor}". A provider without one has not been measured (Plan.md §9).`,
      );
  }
}

/* ------------------------------------------------------------------ */
/* The probe                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Run the two requests and report what actually happened.
 *
 * Never throws for a provider problem — a blocked call is a *result*, and the
 * wizard's job is to show it. It throws only for a request it cannot even
 * address (unknown vendor, missing endpoint/key/model), because those are caller
 * bugs and silently probing `undefined` would produce a confident wrong answer.
 */
export async function probeConnection(
  request: ConnectionProbeRequest,
  options: ConnectionProbeOptions = {},
): Promise<ConnectionProbeReport> {
  const { vendor } = parseCatalogId(request.vendor);

  if (request.apiKey.trim() === "") {
    throw new ConnectionProbeError(
      "missing_api_key",
      "No API key given. The AI SDK reads no environment in a browser, so the key has to be passed explicitly (§9).",
    );
  }
  if (request.model.trim() === "") {
    throw new ConnectionProbeError("missing_model", "No model selected; the connection test needs a model id.");
  }

  const entry = findProvider(request.vendor);
  const probe = vendorProbe(vendor);

  const baseUrl = resolveBaseUrl(request.baseUrl, entry?.baseUrl, vendor);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  // Required headers **last**, for the same security reason as in the registry:
  // the Anthropic header has to survive anything the caller put in its way.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    [probe.auth === "bearer" ? "authorization" : probe.auth]: request.apiKey,
    ...probe.headers,
    ...requiredHeaders(vendor),
  };

  const models = await observe({
    url: joinUrl(baseUrl, probe.modelsPath),
    method: "GET",
    headers,
    doFetch,
    timeoutMs,
    now,
  });

  const inference = await observe({
    url: joinUrl(baseUrl, probe.inferencePath.replace("{model}", encodeURIComponent(request.model))),
    method: "POST",
    headers,
    body: probe.inferenceBody(request.model),
    doFetch,
    timeoutMs,
    now,
  });

  const outcome = classify({ models, inference });
  const verdict = verdictFor(outcome, inference);

  return {
    vendor: request.vendor,
    model: request.model,
    outcome,
    verdict,
    endpoints: { models, inference },
    summary: summaryFor(outcome, verdict, request.vendor, inference.status),
    detail: detailFor(outcome, request.vendor, entry?.note ?? ""),
    measuredAt: new Date(now()).toISOString(),
    corsVerifiedInPlan: isKnownProvider(request.vendor) && (entry?.corsVerified ?? false),
  };
}

/* ------------------------------------------------------------------ */
/* One request, observed                                               */
/* ------------------------------------------------------------------ */

interface ObserveInput {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly doFetch: ProbeFetch;
  readonly timeoutMs: number;
  readonly now: () => number;
}

async function observe(input: ObserveInput): Promise<EndpointObservation> {
  const started = input.now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs);

  try {
    const response = await input.doFetch(input.url, {
      method: input.method,
      headers: input.headers,
      mode: "cors",
      signal: controller.signal,
      // `exactOptionalPropertyTypes`: an absent body is not an undefined one.
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    const { type, code } = await readProviderError(response);
    return {
      url: input.url,
      method: input.method,
      result: "answered",
      status: response.status,
      allowOrigin: response.headers.get("access-control-allow-origin") ?? undefined,
      contentType: response.headers.get("content-type") ?? undefined,
      elapsedMs: input.now() - started,
      errorKind: "none",
      providerErrorType: type,
      providerErrorCode: code,
    };
  } catch (error) {
    /**
     * The two things a browser refuses to distinguish.
     *
     * A `TypeError` from `fetch` means *either* "the response had no
     * `Access-Control-Allow-Origin` for this origin" *or* "the request never
     * arrived". They produce the same exception with the same shape, and no
     * amount of trying tells them apart — which is why the probe compares two
     * endpoints instead of trying to name the cause from one. The label says
     * exactly that, instead of guessing "network".
     */
    const aborted = controller.signal.aborted;
    const isTypeError = error instanceof TypeError;
    return {
      url: input.url,
      method: input.method,
      result: isTypeError ? "blocked" : "threw",
      status: undefined,
      allowOrigin: undefined,
      contentType: undefined,
      elapsedMs: input.now() - started,
      errorKind: aborted ? "aborted" : isTypeError ? "cors-or-network" : "network",
      providerErrorType: undefined,
      providerErrorCode: undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The two enum-ish fields of a JSON error body, and nothing else.
 *
 * §5.4 classifies on `error.type`; the wizard's job is "quota" versus "wrong
 * key". Both live in `type`/`code`. `message` does not: Google's 401 quotes the
 * key back verbatim, and a probe report is rendered, screenshotted and pasted
 * into an issue.
 */
async function readProviderError(response: Response): Promise<{ type?: string; code?: string }> {
  if (response.ok) return {};
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return {};

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return {};
  }
  if (typeof body !== "object" || body === null) return {};

  const error = (body as { error?: unknown }).error;
  const source = typeof error === "object" && error !== null ? error : body;
  const record = source as { type?: unknown; code?: unknown; status?: unknown };
  // The field name differs per vendor and both spellings occur in the wild:
  // OpenAI uses `type`/`code`, Google's REST error puts the machine-readable value
  // in `status`. Reading only one of them means the wizard says "an error" for a
  // provider that told us exactly which one.
  const type = firstString(record.type, record.status);
  const code = firstString(record.code, record.status);
  return {
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
  };
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* The comparison — the part that earns the probe its keep              */
/* ------------------------------------------------------------------ */

function classify(endpoints: {
  models: EndpointObservation;
  inference: EndpointObservation;
}): ProbeOutcome {
  const models = endpoints.models.result === "answered";
  const inference = endpoints.inference.result === "answered";

  // The §9 row, read off two requests instead of guessed from one.
  if (models && !inference) return "cors-blocked";
  if (!models && !inference) return "unreachable";
  if (inference && endpoints.inference.status !== undefined && endpoints.inference.status >= 400) {
    return "http-error";
  }
  return "ok";
}

function verdictFor(outcome: ProbeOutcome, inference: EndpointObservation): ProbeVerdict {
  if (outcome !== "http-error") return "none";
  const status = inference.status ?? 0;
  if (status === 401 || status === 403) return "key-rejected";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "provider-error";
  return "request-rejected";
}

function summaryFor(
  outcome: ProbeOutcome,
  verdict: ProbeVerdict,
  vendor: string,
  status: number | undefined,
): string {
  switch (outcome) {
    case "ok":
      return `${vendor} answered the connection test.`;
    case "cors-blocked":
      return `${vendor} answers its model list but blocks the inference call from a browser (Plan.md §9).`;
    case "unreachable":
      return `${vendor} could not be reached at all — offline, wrong base URL, or the host is down.`;
    case "http-error":
      switch (verdict) {
        case "key-rejected":
          return `${vendor} rejected the key (HTTP ${String(status)}).`;
        case "rate-limited":
          return `${vendor} is rate-limiting this key (HTTP ${String(status)}).`;
        case "provider-error":
          return `${vendor} answered with a server error (HTTP ${String(status)}).`;
        case "request-rejected":
          return `${vendor} rejected the request itself (HTTP ${String(status)}) — not the key.`;
        case "none":
          return `${vendor} answered with an error.`;
      }
  }
}

function detailFor(outcome: ProbeOutcome, vendor: string, note: string): string {
  const corsNote =
    outcome === "cors-blocked"
      ? ` The model list answered with a CORS header and the inference call did not, which is exactly the measured shape for ${vendor} in Plan.md §9. ` +
        "In a browser this provider is therefore not usable — and AGENTS.md §2 forbids adding a proxy to make it look usable."
      : "";
  return `${note}${corsNote}`.trim();
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function resolveBaseUrl(explicit: string | undefined, fromCatalog: string | undefined, vendor: string): string {
  const base = explicit ?? fromCatalog;
  if (base === undefined || base.trim() === "") {
    throw new ConnectionProbeError(
      "missing_endpoint",
      vendor === "openai-compatible"
        ? "An OpenAI-compatible provider needs its base URL, e.g. https://api.groq.com/openai/v1."
        : `No base URL is known for "${vendor}".`,
    );
  }
  return base.replace(/\/+$/, "");
}

function joinUrl(base: string, path: string): string {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/* ------------------------------------------------------------------ */
/* The wizard's entry point                                            */
/* ------------------------------------------------------------------ */

export interface ProbeFromSettingsOptions extends ConnectionProbeOptions {
  /** The registry slot the key is stored under; defaults to `vendor[:name]`. */
  readonly slot?: string | undefined;
}

/**
 * Probe using the stored settings.
 *
 * Exists so the wizard never has to assemble a key by hand — a component that
 * receives an `apiKey` prop can render it, log it, put it in a dependency array
 * and pass it down. Here the key is read out of the store at the moment of the
 * call and appears in no component's scope.
 */
export async function probeFromSettings(
  settings: SettingsSnapshot,
  options: ProbeFromSettingsOptions = {},
): Promise<ConnectionProbeReport> {
  const selection = settings.provider;
  if (selection === undefined) {
    throw new ConnectionProbeError("unknown_provider", "No provider is selected yet.");
  }
  const { name } = parseCatalogId(selection.vendor);
  // Idempotent — see `apiKeySlot`.
  const slot = options.slot ?? apiKeySlot(selection.vendor, name);
  const apiKey = settings.apiKeys[slot];
  if (apiKey === undefined) {
    throw new ConnectionProbeError("missing_api_key", `No API key is stored for "${slot}".`);
  }
  return probeConnection(
    {
      vendor: selection.vendor,
      model: selection.model,
      apiKey,
      ...(selection.baseUrl === undefined ? {} : { baseUrl: selection.baseUrl }),
      ...(name === undefined ? {} : { name }),
    },
    options,
  );
}

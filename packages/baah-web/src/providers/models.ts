/**
 * The model list, read from the provider's own `/models` endpoint.
 *
 * ## Why the provider and not a bundled catalogue
 *
 * `Plan.md` §8.1 step 4 asks for a catalogue, and §9 names two sources:
 * `@opencode-ai/models` (models.dev) and the provider. This file uses the
 * provider, for one reason: **a bundled catalogue is a second truth about a
 * thing that already has a first one.** It goes stale silently, and a stale
 * catalogue produces a "model not found" the user cannot diagnose — they did
 * nothing wrong and the app told them their model does not exist. The
 * snapshot is also 6.35 MB (`@opencode-ai/models`), which is a large thing to
 * ship to answer a question the provider answers for free.
 *
 * ## `GET /models` is the one endpoint §9 measured as browser-callable
 *
 * ```
 * GET  /v1/models             → 401 + access-control-allow-origin: *
 * POST /v1/chat/completions   → 401 + (kein ACAO)
 * POST /v1/responses          → 401 + (kein ACAO)
 * ```
 *
 * So even for OpenAI — whose inference path is unconfirmed — the model list is
 * reachable from a browser. That is not a convenience, it is what makes this
 * file possible at all under AGENTS.md §2: no proxy, no server, direct call.
 *
 * ## Two response shapes, one loader
 *
 * | vendor | body |
 * |---|---|
 * | OpenAI, and every `openai-compatible` server | `{ data: [{ id }] }` |
 * | Anthropic | `{ data: [{ id, display_name }], has_more, first_id, last_id }` |
 * | Google | `{ models: [{ name, displayName }], nextPageToken }` |
 *
 * A loader that only reads `data[].id` is **half** correct for Anthropic and
 * **wrong** for Google: without `display_name` the wizard shows a user
 * `claude-haiku-4-5-20251001` where a name exists, and Google's array is not
 * under `data` at all. So the three shapes are read as three shapes.
 *
 * ## Pagination: followed to the end, and **reported** when it is not
 *
 * This is the part where an incomplete list presented as a complete one is the
 * same lie as a truncated `grep`: the user picks a model that was missing, and
 * nothing in the product told them the list they chose from was partial.
 *
 * So the loader follows pagination to its end, and when it stops before the end
 * it says so in {@link ModelList.complete} — which the wizard renders, in
 * `Onboarding.tsx`'s `ModelListPanel`, above the `<select>`. The stop conditions
 * are: the page cap, or a cursor that stops advancing (a server answering
 * `has_more: true` with the same `last_id` forever would otherwise spin). Both
 * are visible in the report rather than silent.
 *
 * The rendering is a claim with a witness: `e2e/model-list.e2e.ts` drives the
 * wizard on a scripted incomplete list and asserts the notice is on screen, and
 * on a complete one and asserts it is **not**. Deleting the notice paragraph used
 * to leave `pnpm check` and `pnpm e2e` both green, which is what "nobody renders
 * the return value" measures like.
 *
 * ## Secrets
 *
 * The key travels in a header and nowhere else: never in a URL, never in the
 * report, never in an error message. Google's REST API accepts `x-goog-api-key`
 * precisely so the query-string form — which every server log on the path would
 * record — is not needed. `ModelListError` messages are literals; no body, no
 * URL and no header value is ever interpolated into one.
 */

import { z } from "zod";

import { requiredHeaders } from "@all-the.rest/baah-core";
import { apiKeySlot } from "../lib/ids.ts";
import type { SettingsSnapshot } from "../lib/settings.ts";
import { authHeaderName, authHeaderValue, type AuthStyle } from "./auth-header.ts";
import { findProvider, parseCatalogId } from "./catalog.ts";

/* ------------------------------------------------------------------ */
/* The wire shapes, validated                                            */
/* ------------------------------------------------------------------ */

/**
 * One model, as this loader reports it.
 *
 * `displayName` is what the user reads; `id` is what gets sent. Keeping them
 * separate is the whole point of reading `display_name` — collapsing the two at
 * parse time would make it impossible to say which one the provider supplied.
 */
export interface ModelInfo {
  readonly id: string;
  readonly displayName: string;
}

/**
 * The `data: [...]` envelope — OpenAI's and Anthropic's, which are the same one.
 *
 * **One schema, not two.** Anthropic's extra keys are optional here, so OpenAI's
 * body parses against it unchanged and Anthropic's parses with the cursor fields
 * filled. A branch on the vendor id would have to be *right* about which vendor
 * it is talking to; this reads what arrived.
 *
 * Its strictness is load-bearing below: `data` is required, so a Google body
 * (`{ models: [...] }`) cannot be mistaken for it.
 */
const dataEnvelopeSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      display_name: z.string().optional(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

/**
 * Google's shape. The array is under `models`, the id under `name`, and the
 * cursor is a `nextPageToken` rather than a `last_id`.
 *
 * `models` is required, so an `openai`-shaped body cannot be mistaken for it.
 */
const googleEnvelopeSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      displayName: z.string().optional(),
    }),
  ),
  nextPageToken: z.string().optional(),
});

/**
 * The six ways reading a model list can fail, and what each one means.
 *
 * Named as a type of its own — and not written inline in the constructor — because
 * a **second place** has to enumerate all six: `runtime/index.ts` maps each one onto
 * its own `RuntimeErrorCode` so the wizard can react to it. A union written twice
 * drifts; a union written once and `key`ed over does not, and a seventh code becomes
 * a type error in the mapping rather than a silent fall-through to a generic
 * "the provider could not be reached".
 *
 * | code | the wizard should say |
 * |---|---|
 * | `unknown_provider` | this app has no model list for that vendor |
 * | `missing_endpoint` | fill in the base URL first |
 * | `missing_api_key` | save the key first |
 * | `http_error` | the provider answered, and refused — look at the status |
 * | `unreachable` | the call did not complete: blocked, offline, or too slow |
 * | `malformed_response` | the answer was not a model list this app can read |
 *
 * The last two were one code in a first draft, which meant "the provider answered
 * 401" and "the provider answered with something we cannot parse" reached the screen
 * as the same sentence — the difference between *the provider refused you* and *we
 * failed to understand it*.
 */
export type ModelListErrorCode =
  | "unknown_provider"
  | "missing_endpoint"
  | "missing_api_key"
  | "http_error"
  | "unreachable"
  | "malformed_response";

export class ModelListError extends Error {
  constructor(
    readonly code: ModelListErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelListError";
  }
}

/* ------------------------------------------------------------------ */
/* The request                                                          */
/* ------------------------------------------------------------------ */

/** The narrowed `fetch`, injected so a test never touches the network. */
export type ModelListFetch = (input: string, init: ModelRequestInit) => Promise<Response>;

export interface ModelRequestInit {
  readonly method: "GET";
  readonly headers: Record<string, string>;
  readonly mode: "cors";
  readonly signal: AbortSignal;
}

export interface ModelListRequest {
  /** A full vendor id, label included. */
  readonly vendor: string;
  /** Explicit, always (§9: the SDK reads no environment in a browser). */
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
}

export interface ModelListOptions {
  readonly fetch?: ModelListFetch | undefined;
  /** Hard cap on pages. See the module header: hitting it sets `complete: false`. */
  readonly maxPages?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * What the endpoint actually served.
 *
 * `complete` is a first-class field and not an afterthought: it is the difference
 * between "here are the models" and "here are the models we saw before we
 * stopped looking", and a caller that cannot tell them apart will render the
 * second as the first.
 */
export interface ModelList {
  readonly models: readonly ModelInfo[];
  /** `false` when pagination stopped early. Never optimistically `true`. */
  readonly complete: boolean;
  /** How many pages were fetched. */
  readonly pages: number;
  /** Why it stopped, when it stopped early. Empty when `complete` is `true`. */
  readonly incompleteReason: string;
  /** The dialect the loader read the response as. For diagnostics and tests. */
  readonly shape: "openai" | "anthropic" | "google";
}

/* ------------------------------------------------------------------ */
/* Per-vendor request shape                                             */
/* ------------------------------------------------------------------ */

interface ModelsEndpoint {
  readonly auth: AuthStyle;
  /** Relative to the base URL. Identical everywhere — `/v1/models`. */
  readonly modelsPath: string;
  readonly extraHeaders: Record<string, string>;
}

function modelsEndpoint(vendor: string): ModelsEndpoint {
  switch (vendor) {
    case "openai":
    case "openai-compatible":
      return { auth: "bearer", modelsPath: "/models", extraHeaders: {} };
    case "anthropic":
    case "anthropic-compatible":
      return {
        auth: "x-api-key",
        modelsPath: "/models",
        // A request parameter of the dialect, like the SDK's own — and the same
        // header goes out to **both** rows, because a Messages server needs it
        // whoever runs it.
        //
        // It is **not** `anthropic-dangerous-direct-browser-access`. That one is a
        // claim about the *operator* and is `requiredHeaders`' decision, keyed off
        // the operator — so `anthropic` gets it and **`anthropic-compatible` does
        // not**. (The first draft of this comment claimed the opposite; the test
        // "does NOT send the Anthropic browser header to an anthropic-compatible
        // endpoint" is the assertion, and it is the one that counts.)
        extraHeaders: { "anthropic-version": "2023-06-01" },
      };
    case "google":
      return { auth: "x-goog-api-key", modelsPath: "/models", extraHeaders: {} };
    default:
      throw new ModelListError(
        "unknown_provider",
        `No model list is defined for "${vendor}". A provider without one has not been measured (Plan.md §9).`,
      );
  }
}

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Read `/models` and return what the endpoint serves.
 *
 * Never throws for a provider problem — an unreachable endpoint or a rejected
 * key is a **result**, and the wizard's job is to show it. It throws only for a
 * request it cannot even address (unknown vendor, no endpoint, no key) or for a
 * body that is not a model list at all, because rendering "0 Modelle" for a
 * shape we failed to parse is the same lie as a truncated list.
 */
export async function listModels(
  request: ModelListRequest,
  options: ModelListOptions = {},
): Promise<ModelList> {
  const { vendor } = parseCatalogId(request.vendor);

  if (request.apiKey.trim() === "") {
    throw new ModelListError(
      "missing_api_key",
      "No API key given. The AI SDK reads no environment in a browser, so the key has to be passed explicitly (§9).",
    );
  }

  const entry = findProvider(request.vendor);
  const endpoint = modelsEndpoint(vendor);
  const baseUrl = resolveBaseUrl(request.baseUrl, entry?.baseUrl, vendor, entry?.needsEndpoint === true);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  // Required headers **last**, exactly as in `probe.ts`: they are not optional,
  // and a caller's value must not be able to remove one.
  //
  // `bearer` is an *auth style*, not a header name, and the difference is not
  // cosmetic. RFC 6750 §2.1: the `Authorization` header carries a **scheme** and
  // the credential, `Authorization: Bearer <token>`. Sending the bare token is a
  // malformed header, and the §9-measured OpenAI-compatible operators answer one
  // with `401` — which `probe.ts` then reports as **"your key was rejected"** for a
  // key that is perfectly fine. The two keyed styles are the opposite case and are
  // correct as they stand: Anthropic documents the raw key in `x-api-key` and
  // Google documents it in `x-goog-api-key`, so neither takes a scheme.
  const headers: Record<string, string> = {
    accept: "application/json",
    [authHeaderName(endpoint.auth)]: authHeaderValue(endpoint.auth, request.apiKey),
    ...endpoint.extraHeaders,
    ...requiredHeaders(request.vendor),
  };

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let afterId: string | undefined;
  let pageToken: string | undefined;
  let pages = 0;
  let complete = false;
  let incompleteReason = "";
  // Overwritten by every page. A later page that is a bare OpenAI list would
  // downgrade the verdict, which is the honest reading — the two envelopes in one
  // response sequence is itself a fact about the endpoint.
  let shape: ModelList["shape"] = "openai";

  while (pages < maxPages) {
    const page = await fetchPage({
      url: pageUrl(baseUrl, endpoint.modelsPath, afterId, pageToken),
      headers,
      doFetch,
      timeoutMs,
    });
    pages += 1;
    shape = page.shape;

    for (const info of page.models) {
      // **Deduplicated.** Anthropic's pagination is cursor-based and a page
      // boundary can repeat an entry; a duplicate in a `<select>` is a model the
      // user picks twice and cannot tell apart.
      if (seen.has(info.id)) continue;
      seen.add(info.id);
      models.push(info);
    }

    /**
     * **On `page.shape`, not on `vendor`.** The two disagree in the wild: a proxy
     * in front of Google is free to answer with Google's `{ models, nextPageToken }`
     * envelope while the vendor id says `openai-compatible`. The `parsePage` header
     * states the rule this follows — content is the only evidence — and the
     * pagination used to contradict it, so a Google-shaped body behind a
     * non-Google id was read correctly and then **paged wrongly**: the
     * `nextPageToken` was present and discarded, one page was fetched, and
     * `complete: false` said "the cap" when the truth was "you stopped reading a
     * cursor you were handed".
     *
     * The `hasMore` cursor below is the same story from the other side: the Google
     * branch sets `hasMore` from `nextPageToken`, so keying on the shape is enough
     * for both envelopes and neither vendor string is consulted.
     */
    if (page.shape === "google") {
      if (page.nextPageToken === undefined) {
        complete = true;
        break;
      }
      if (page.nextPageToken === pageToken) {
        incompleteReason = "The provider returned the same page token twice.";
        break;
      }
      pageToken = page.nextPageToken;
      continue;
    }

    if (page.hasMore !== true) {
      complete = true;
      break;
    }
    if (page.lastId === undefined || page.lastId === afterId) {
      // `has_more: true` with no cursor to advance by is an endpoint we cannot
      // page through. Reported, not looped on: this is the condition that would
      // otherwise spin until the cap.
      incompleteReason = "The provider says more models exist but sent no cursor to fetch them with.";
      break;
    }
    afterId = page.lastId;
  }

  if (!complete && incompleteReason === "") {
    incompleteReason = `Stopped after ${String(pages)} pages; the provider may serve more models.`;
  }

  return { models, complete, pages, incompleteReason, shape };
}

/* ------------------------------------------------------------------ */
/* One page                                                             */
/* ------------------------------------------------------------------ */

interface Page {
  readonly models: readonly ModelInfo[];
  readonly hasMore: boolean | undefined;
  readonly lastId: string | undefined;
  readonly nextPageToken: string | undefined;
  /**
   * Which envelope answered, read off the **body**.
   *
   * `"anthropic"` when the body carried any of Anthropic's extra keys —
   * `display_name`, `has_more`, `last_id` — because that is the only evidence
   * in the response that a different server produced it than a bare OpenAI list.
   * A first draft derived this from `has_more === true`, which is wrong on the
   * most common Anthropic response of all: a complete first page with
   * `has_more: false` reported itself as `"openai"`.
   */
  readonly shape: "openai" | "anthropic" | "google";
}

async function fetchPage(input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly doFetch: ModelListFetch;
  readonly timeoutMs: number;
}): Promise<Page> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs);
  try {
    const response = await input.doFetch(input.url, {
      method: "GET",
      headers: input.headers,
      mode: "cors",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ModelListError(
        "http_error",
        `The provider answered the model list with HTTP ${String(response.status)}.`,
      );
    }
    const body: unknown = await response.json();
    return parsePage(body);
  } catch (error) {
    if (error instanceof ModelListError) throw error;
    // A rejected `fetch` is CORS or the network, and the browser refuses to say
    // which — the same two cases `probe.ts` documents. **A timeout is named
    // separately**, because "the provider blocks this call" is a provider policy
    // claim and a 10-second wait is not evidence of one; `probe.ts` carries an
    // `aborted` error kind for the same reason.
    const timedOut = controller.signal.aborted;
    throw new ModelListError(
      "unreachable",
      timedOut
        ? "The model list did not arrive in time — the host may be slow, unreachable, or still sending."
        : "The model list could not be read from the browser — the provider blocks this call, or the host is unreachable.",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read whichever of the three shapes arrived.
 *
 * **Tried by content, and the order does not matter.** Each schema *requires*
 * the array it knows about, so each rejects the other two's body; there is
 * nothing to prefer. That is deliberate: an earlier draft tried the vendor's
 * own shape first and ordered the rest by sniffing the hostname for
 * `googleapis`, which was a guess about a host dressed up as a lookup. Content
 * is the only thing here that is actually evidence.
 *
 * A proxy in front of a provider is free to answer with either envelope, and a
 * guess from the vendor id that then fails to parse would reach the wizard as
 * "0 models".
 */
function parsePage(body: unknown): Page {
  for (const schema of [dataEnvelopeSchema, googleEnvelopeSchema]) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) continue;
    const value = parsed.data;
    if ("models" in value) {
      return {
        models: value.models.map((model) => ({ id: model.name, displayName: model.displayName ?? model.name })),
        hasMore: value.nextPageToken !== undefined,
        lastId: undefined,
        nextPageToken: value.nextPageToken,
        shape: "google",
      };
    }
    return {
      models: value.data.map((model) => ({ id: model.id, displayName: model.display_name ?? model.id })),
      hasMore: value.has_more,
      lastId: value.last_id ?? undefined,
      nextPageToken: undefined,
      // The keys are optional in the schema, so their **presence** is what the
      // body had to say to be recognisably Anthropic's. `has_more: false` is a
      // presence.
      shape:
        value.has_more !== undefined ||
        value.last_id != null ||
        value.data.some((model) => model.display_name !== undefined)
          ? "anthropic"
          : "openai",
    };
  }

  // Unparseable, and **not** an empty list: "the provider's answer was not a
  // model list" and "the provider serves no models" are different facts and the
  // second is not knowable from the first.
  throw new ModelListError(
    "malformed_response",
    "The provider's answer was not a model list this app can read.",
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * The page URL, with a cursor **only** when there is one.
 *
 * The cursor goes in the query string and the key does not: a URL is the most
 * loggable string there is, and a cursor is not a secret.
 */
function pageUrl(base: string, path: string, afterId: string | undefined, pageToken: string | undefined): string {
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const query: string[] = [];
  if (afterId !== undefined) query.push(`after_id=${encodeURIComponent(afterId)}`);
  if (pageToken !== undefined) query.push(`pageToken=${encodeURIComponent(pageToken)}`);
  return query.length === 0 ? url : `${url}?${query.join("&")}`;
}

function resolveBaseUrl(
  explicit: string | undefined,
  fromCatalog: string | undefined,
  vendor: string,
  needsEndpoint: boolean,
): string {
  const base = explicit ?? fromCatalog;
  if (base === undefined || base.trim() === "") {
    throw new ModelListError(
      "missing_endpoint",
      needsEndpoint
        ? `An ${vendor} entry needs the base URL of the server it addresses before its models can be read.`
        : `No base URL is known for "${vendor}".`,
    );
  }
  return base.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ */
/* The wizard's entry point                                              */
/* ------------------------------------------------------------------ */

/**
 * Read the model list using the stored settings.
 *
 * Exists for the same reason as `probeFromSettings`: the wizard must never hold
 * the key. A component that receives an `apiKey` prop can render it, log it and
 * put it in a dependency array; here the key is read out of the store at the
 * moment of the call and appears in no component's scope.
 */
export async function listModelsFromSettings(
  settings: SettingsSnapshot,
  options: ModelListOptions = {},
): Promise<ModelList> {
  const selection = settings.provider;
  if (selection === undefined) {
    throw new ModelListError("unknown_provider", "No provider is selected yet.");
  }
  const { name } = parseCatalogId(selection.vendor);
  // Idempotent — see `apiKeySlot`.
  const slot = apiKeySlot(selection.vendor, name);
  const apiKey = settings.apiKeys[slot];
  if (apiKey === undefined) {
    throw new ModelListError("missing_api_key", `No API key is stored for "${slot}".`);
  }
  return listModels(
    {
      vendor: selection.vendor,
      apiKey,
      ...(selection.baseUrl === undefined ? {} : { baseUrl: selection.baseUrl }),
    },
    options,
  );
}

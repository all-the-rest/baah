/**
 * The faked provider.
 *
 * `context.route()` answers every request that goes to a known provider origin,
 * and records each one so a spec can assert *whether a retry happened*.
 * Plan.md §5.4 makes a retry a second request: "the user sees an error" and
 * "the user sees attempt 2 of 3" are different products, and only the request
 * count tells them apart.
 *
 * The interception is deny-by-default. A provider request this module was not
 * scripted for is answered with a `501` that names the gap and recorded in
 * `unscripted` — never allowed through to the network, and never allowed to
 * hang the test. A silent pass on a real API call is the failure mode worth
 * engineering against.
 */
import type { BrowserContext, Route } from "@playwright/test";
import { streamMarkerHeader } from "./sse.ts";
import type { Turn } from "./turns.ts";

/**
 * The OpenAI-compatible base URL the E2E build points the app at. It is
 * `https://e2e.invalid/v1` (see `vite.config.ts`); this constant is the same
 * value, so the build and the specs cannot drift apart.
 */
export const PROVIDER_BASE_URL = "https://e2e.invalid/v1";

/**
 * Every origin a provider call may go to. A request to anything else is not
 * intercepted at all, so the app's own assets keep loading.
 *
 * The list is Plan.md §9's CORS matrix plus the E2E base URL: if a future wave
 * adds a provider, adding its origin here is the only change needed — and until
 * it is added here, that provider is genuinely unreachable from the suite
 * rather than accidentally live.
 */
export const PROVIDER_ORIGINS: readonly string[] = [
  "https://e2e.invalid",
  "https://api.openai.com",
  "https://api.anthropic.com",
  "https://generativelanguage.googleapis.com",
  "https://openrouter.ai",
  "https://api.groq.com",
  "https://api.x.ai",
  "https://api.cerebras.ai",
  "https://api.together.xyz",
  "https://api.deepseek.com",
  "https://models.dev",
];

/** The chat-completions path suffix. */
export const CHAT_COMPLETIONS_PATH = "/chat/completions";

/** The Responses API path suffix. */
export const RESPONSES_PATH = "/responses";

/** A recorded intercepted request. */
export type ProviderRequest = {
  readonly url: string;
  readonly method: string;
  /** The parsed JSON body, when there was one. */
  readonly body: unknown;
  /** Request headers, lowercased by Playwright. */
  readonly headers: Readonly<Record<string, string>>;
};

/** How a response should be produced. */
export type ProviderReply =
  /** A complete SSE turn, framed and terminated. */
  | { readonly kind: "sse"; readonly turn: Turn }
  /** Hand-built SSE bytes, for the broken and truncated cases. */
  | { readonly kind: "sse-raw"; readonly body: string }
  /** A JSON body, served with whatever status the scenario needs. */
  | { readonly kind: "json"; readonly status: number; readonly body: string }
  /** A transport-level failure: the request never gets a response at all. */
  | { readonly kind: "abort"; readonly errorCode: string };

/** One request to answer. */
export type ProviderStep = {
  /**
   * Only answer a request whose path ends with this. Omit to answer any
   * provider path.
   */
  readonly path?: string;
  readonly reply: ProviderReply;
};

export type ProviderFake = {
  /** Every intercepted request, in order. */
  readonly requests: readonly ProviderRequest[];
  /** URLs answered with the "nothing was scripted" 501, in order. */
  readonly unscripted: readonly string[];
  /** How many requests were intercepted. */
  count(): number;
  /** How many requests hit a path suffix. */
  countFor(path: string): number;
  /** The most recent intercepted request, or `undefined`. */
  last(): ProviderRequest | undefined;
  /** Queue more steps. */
  script(steps: readonly ProviderStep[]): void;
  /** Forget every recorded request. */
  reset(): void;
};

function parseBody(raw: string | undefined): unknown {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Whether the URL is on a provider origin and therefore ours to answer. */
export function isProviderUrl(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return PROVIDER_ORIGINS.includes(target.origin);
}

/**
 * CORS headers for every fulfilled provider response.
 *
 * Not decoration. The app is served from `http://127.0.0.1:4173` and calls
 * `https://e2e.invalid`, so Chromium applies its normal CORS rules to a
 * Playwright-fulfilled response. Without `access-control-allow-origin` the
 * `fetch` rejects before the body is ever read, and the suite would be testing
 * a CORS failure while claiming to test a stream.
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
  // Without this, `response.headers.get(...)` in the page sees only the
  // CORS-safelisted headers — the pacer's marker would be invisible and every
  // stream would arrive as one unscheduled write.
  "access-control-expose-headers": "*",
  "access-control-max-age": "0",
};

function headers(extra: Readonly<Record<string, string>>): Record<string, string> {
  return { ...CORS_HEADERS, [streamMarkerHeader]: "0", ...extra };
}

async function fulfillSse(route: Route, body: string): Promise<void> {
  await route.fulfill({
    status: 200,
    // Plan.md §5.4 keys on this: a `200` carrying `application/json` is an
    // error, and a `200` carrying `text/event-stream` still has to end on a
    // terminal event before it counts as success.
    contentType: "text/event-stream",
    headers: headers({
      "cache-control": "no-cache",
      // Tells the in-page pacer to re-deliver this body one event at a time.
      [streamMarkerHeader]: "1",
    }),
    body,
  });
}

/** A minimal, obviously-fake model catalogue for `GET /v1/models`. */
const MODELS_BODY = JSON.stringify({
  object: "list",
  data: [{ id: "gpt-fake", object: "model", owned_by: "e2e" }],
});

/**
 * Install the fake on a context. Registered on the context, not the page, so a
 * popup or a second tab would be covered too.
 */
export async function installProvider(
  context: BrowserContext,
  steps: readonly ProviderStep[] = [],
): Promise<ProviderFake> {
  const queue: ProviderStep[] = [...steps];
  const requests: ProviderRequest[] = [];
  const unscripted: string[] = [];

  await context.route(
    (url) => isProviderUrl(url.href),
    async (route: Route) => {
      const request = route.request();
      const url = request.url();

      requests.push({
        url,
        method: request.method(),
        body: parseBody(request.postData() ?? undefined),
        headers: request.headers(),
      });

      if (request.method() === "GET" && url.endsWith("/models")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: headers({}),
          body: MODELS_BODY,
        });
        return;
      }

      const index = queue.findIndex(
        (step) => step.path === undefined || url.endsWith(step.path),
      );
      if (index === -1) {
        unscripted.push(url);
        await route.fulfill({
          status: 501,
          contentType: "application/json",
          headers: headers({}),
          body: JSON.stringify({
            error: {
              type: "e2e_harness",
              message: `no step was scripted for ${url} — see e2e/support/provider.ts`,
            },
          }),
        });
        return;
      }

      const step = queue.splice(index, 1)[0];
      if (step === undefined) return;

      switch (step.reply.kind) {
        case "sse":
          await fulfillSse(route, step.reply.turn.body);
          return;
        case "sse-raw":
          await fulfillSse(route, step.reply.body);
          return;
        case "json":
          await route.fulfill({
            status: step.reply.status,
            contentType: "application/json",
            headers: headers({}),
            body: step.reply.body,
          });
          return;
        case "abort":
          await route.abort(step.reply.errorCode);
          return;
      }
    },
  );

  return {
    requests,
    unscripted,
    count: () => requests.length,
    countFor: (path) => requests.filter((entry) => entry.url.endsWith(path)).length,
    last: () => requests[requests.length - 1],
    script: (more) => queue.push(...more),
    reset: () => {
      requests.length = 0;
      unscripted.length = 0;
    },
  };
}

/**
 * The connection probe, against the §9 matrix.
 *
 * ## The scenario that earns the probe its existence
 *
 * §9 measured, for OpenAI: `GET /v1/models` answers `401` **with** an ACAO header,
 * and `POST /v1/chat/completions` answers `401` **without** one. A browser therefore
 * gets a readable 401 from one endpoint and an opaque `TypeError` from the other.
 *
 * Every test below reproduces one cell of that table. The one that matters is
 * "models answered, inference blocked ⇒ `cors-blocked`", because a boolean probe
 * would report it as "your key is wrong" and send the user off to regenerate a key
 * that was fine.
 */

import { describe, expect, it } from "vitest";

import {
  ConnectionProbeError,
  probeConnection,
  probeFromSettings,
  type ConnectionProbeRequest,
  type EndpointObservation,
  type ProbeFetch,
  type ProbeRequestInit,
} from "./probe.ts";
import { defaultSettings } from "../lib/settings.ts";
import { PROVIDER_CATALOG, findProvider, isKnownProvider } from "./catalog.ts";
// **Core's function, imported directly.** A re-export through `catalog.ts` would
// let the two statements be compared through a name that both share, and the
// comparison would go green if the catalogue were rewritten to agree with core
// by construction — which is the failure this test exists to prevent.
import { corsVerdict, type CorsVerdict } from "@all-the.rest/baah-core";

const SECRET = "sk-probe-DO-NOT-LEAK-abcdefghijklmno";

interface Recorded {
  readonly url: string;
  readonly init: ProbeRequestInit;
}

/** What a browser does when a response carries no ACAO: reject with a `TypeError`. */
function corsBlock(): Promise<never> {
  return Promise.reject(new TypeError("Failed to fetch"));
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * A scripted fetch, keyed by path suffix.
 *
 * A suffix that is not scripted gets a `501` rather than being allowed through —
 * the same deny-by-default the E2E suite uses, because a probe test that silently
 * reaches the network proves nothing and flaked tests are worse.
 */
function scriptedFetch(
  routes: Record<string, () => Promise<Response>>,
): { fetch: ProbeFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      const route = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
      if (route === undefined) {
        return Promise.resolve(
          new Response(`no route scripted for ${path}`, { status: 501 }),
        );
      }
      return route[1]();
    },
  };
}

function request(overrides: Partial<ConnectionProbeRequest> = {}): ConnectionProbeRequest {
  return {
    vendor: "openai",
    model: "gpt-4o-mini",
    apiKey: SECRET,
    ...overrides,
  };
}

describe("probeConnection — the §9 matrix", () => {
  it("reports `ok` when both endpoints answer and the inference succeeds", async () => {
    const { fetch } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({ data: [] }, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({ id: "x" }, { headers: { "access-control-allow-origin": "*" } })),
    });

    const report = await probeConnection(request(), { fetch });

    expect(report.outcome).toBe("ok");
    expect(report.verdict).toBe("none");
    expect(report.endpoints.models.status).toBe(200);
    expect(report.endpoints.inference.status).toBe(200);
  });

  it("reports `cors-blocked` for exactly the measured OpenAI shape", async () => {
    // /v1/models → 401 **with** ACAO. /chat/completions → blocked, no ACAO.
    const { fetch, calls } = scriptedFetch({
      "/models": () =>
        Promise.resolve(
          jsonResponse(
            { error: { type: "invalid_request_error", code: "invalid_api_key" } },
            { status: 401, headers: { "access-control-allow-origin": "*" } },
          ),
        ),
      "/chat/completions": corsBlock,
    });

    const report = await probeConnection(request(), { fetch });

    expect(report.outcome).toBe("cors-blocked");
    expect(report.endpoints.models.result).toBe("answered");
    expect(report.endpoints.models.allowOrigin).toBe("*");
    expect(report.endpoints.inference.result).toBe("blocked");
    // The browser cannot tell a CORS block from a network failure, and the label
    // says so instead of guessing.
    expect(report.endpoints.inference.errorKind).toBe("cors-or-network");
    expect(report.summary).toContain("blocks the inference call");
    // And the explanation has to name §9, or the user files it as an app bug.
    expect(report.detail).toContain("Plan.md §9");
    expect(calls).toHaveLength(2);
  });

  it("reports `unreachable` when nothing answers at all", async () => {
    const { fetch } = scriptedFetch({ "/models": corsBlock, "/chat/completions": corsBlock });

    const report = await probeConnection(request(), { fetch });

    expect(report.outcome).toBe("unreachable");
    expect(report.summary).toContain("could not be reached");
  });

  it("reads a rejected key off the status, without blaming CORS", async () => {
    const { fetch } = scriptedFetch({
      "/models": () =>
        Promise.resolve(jsonResponse({ error: { type: "invalid_request_error" } }, { status: 401, headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () =>
        Promise.resolve(jsonResponse({ error: { type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 })),
    });

    const report = await probeConnection(request(), { fetch });

    // Both answered, so this is an HTTP verdict, not a transport one.
    expect(report.outcome).toBe("http-error");
    expect(report.verdict).toBe("key-rejected");
    expect(report.endpoints.inference.providerErrorCode).toBe("invalid_api_key");
  });

  it("separates a rate limit from a bad key", async () => {
    const { fetch } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({}, { status: 429 })),
    });

    expect((await probeConnection(request(), { fetch })).verdict).toBe("rate-limited");
  });

  it("separates a provider fault from a rejected request", async () => {
    const server = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({}, { status: 503 })),
    });
    expect((await probeConnection(request(), { fetch: server.fetch })).verdict).toBe("provider-error");

    const bad = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({}, { status: 400 })),
    });
    // §5.4: a 400 is the request being wrong, not the key.
    expect((await probeConnection(request(), { fetch: bad.fetch })).verdict).toBe("request-rejected");
  });

  it("surfaces an error `type` but never an error `message`", async () => {
    const { fetch } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      // Google's 401 quotes the key back verbatim. A probe report is rendered,
      // screenshotted and pasted into an issue.
      "/chat/completions": () =>
        Promise.resolve(
          jsonResponse(
            { error: { message: `API key not valid: ${SECRET}. Please pass a valid API key.`, status: "API_KEY_INVALID" } },
            { status: 400 },
          ),
        ),
    });

    const report = await probeConnection(request(), { fetch });

    expect(report.endpoints.inference.providerErrorType).toBe("API_KEY_INVALID");
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
});

describe("probeConnection — the Anthropic header", () => {
  it("sends `anthropic-dangerous-direct-browser-access` — the SDK does not", async () => {
    // §9: without it, Anthropic's 401 carries no ACAO and the browser turns a wrong
    // key into an opaque `TypeError`. This is the assertion that keeps a downstream
    // refactor from dropping it.
    const { fetch, calls } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/messages": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    await probeConnection(request({ vendor: "anthropic", model: "claude-haiku-4-5" }), { fetch });

    for (const call of calls) {
      expect(call.init.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    }
  });

  it("sends the Anthropic version header and the key as `x-api-key`", async () => {
    const { fetch, calls } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/messages": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    await probeConnection(request({ vendor: "anthropic", model: "claude-haiku-4-5" }), { fetch });

    const inference = calls.find((call) => call.url.endsWith("/messages"));
    expect(inference?.init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(inference?.init.headers["x-api-key"]).toBe(SECRET);
    expect(inference?.init.headers["authorization"]).toBeUndefined();
  });

  it("addresses the Messages endpoint, not chat/completions", async () => {
    const { fetch, calls } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/messages": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    await probeConnection(request({ vendor: "anthropic", model: "claude-haiku-4-5" }), { fetch });

    expect(calls.some((call) => call.url.includes("chat/completions"))).toBe(false);
  });
});

/**
 * ## The auth header, and the misdiagnosis it caused
 *
 * The Anthropic test above asserts `authorization` is **`undefined`** for the
 * Messages row — which says nothing about what a `bearer` row sends. There was no
 * assertion anywhere on the OpenAI row's actual header value, and it was wrong: the
 * raw key went into `authorization` with no `Bearer ` scheme.
 *
 * The damage is not a rejected request, it is a **wrong sentence on the screen**.
 * §9 measured all six OpenAI-compatible operators (Groq, xAI, Mistral, Cerebras,
 * Together, DeepSeek) as sending ACAO on **both** paths, so a 401 from either is
 * *readable* — and `verdictFor` turns a 401 into `key-rejected`. The user is told
 * their working key was rejected. That is precisely the misdiagnosis this module's
 * two-request design exists to prevent, arrived at from the other direction.
 *
 * (First-party `openai` survived it **by luck**: its inference path sends no ACAO,
 * so the outcome is `cors-blocked` regardless of what the header said.)
 */
describe("probeConnection — how the key travels", () => {
  it("sends `Authorization: Bearer <key>` to every bearer endpoint", async () => {
    // RFC 6750 §2.1: the scheme is part of the credential. Literal, with the space.
    for (const [vendor, baseUrl] of [
      ["openai", undefined],
      ["openai-compatible:groq", "https://api.groq.com/openai/v1"],
    ] as const) {
      const { fetch, calls } = scriptedFetch({
        "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
        "/chat/completions": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      });

      await probeConnection(request({ vendor, ...(baseUrl === undefined ? {} : { baseUrl }) }), { fetch });

      for (const call of calls) {
        expect(call.init.headers.authorization).toBe(`Bearer ${SECRET}`);
        expect(Object.keys(call.init.headers)).not.toContain("x-api-key");
      }
    }
  });

  it("sends the two KEYED styles raw, and never an `authorization` at all", async () => {
    // The opposite case. Anthropic and Google document the **bare** key in their own
    // header, so prefixing it would be a second bug of the same shape — and the
    // absence of `authorization` is asserted because a loader that sent both headers
    // would be sending the credential twice.
    const anthropic = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/messages": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });
    await probeConnection(request({ vendor: "anthropic", model: "claude-haiku-4-5" }), { fetch: anthropic.fetch });
    for (const call of anthropic.calls) {
      expect(call.init.headers["x-api-key"]).toBe(SECRET);
      expect(Object.keys(call.init.headers)).not.toContain("authorization");
    }

    const google = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/models/gemini-2.0-flash:generateContent": () =>
        Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });
    await probeConnection(request({ vendor: "google", model: "gemini-2.0-flash" }), { fetch: google.fetch });
    for (const call of google.calls) {
      expect(call.init.headers["x-goog-api-key"]).toBe(SECRET);
      expect(Object.keys(call.init.headers)).not.toContain("authorization");
    }
  });

  it("keeps the prefixed key out of every URL", async () => {
    // `Bearer ` must not become a query parameter either. A URL is the most
    // loggable string on the path, and this one would now carry a credential
    // *and* the word that says so.
    const { fetch, calls } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    await probeConnection(request({ vendor: "openai-compatible:groq", baseUrl: "https://api.groq.com/openai/v1" }), { fetch });

    for (const call of calls) {
      expect(call.url).not.toContain(SECRET);
      expect(call.url).not.toContain("Bearer");
    }
  });
});

describe("probeConnection — secrets and shapes", () => {
  it("never puts the key in a URL", async () => {
    const { fetch, calls } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    const report = await probeConnection(request(), { fetch });

    for (const call of calls) {
      expect(call.url).not.toContain(SECRET);
    }
    // A URL is the most loggable string there is, so Google's key must not become a
    // `?key=` query parameter.
    expect(calls.some((call) => call.url.includes("key="))).toBe(false);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("sends the key in a header for Google too", async () => {
    const { fetch, calls } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "generateContent": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    await probeConnection(
      request({ vendor: "google", model: "gemini-2.0-flash" }),
      { fetch },
    );

    expect(calls[0]?.init.headers["x-goog-api-key"]).toBe(SECRET);
  });

  it("asks for the smallest legal request", async () => {
    const { fetch, calls } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    await probeConnection(request(), { fetch });

    const inference = calls.find((call) => call.init.method === "POST");
    const body = JSON.parse(inference?.init.body ?? "{}") as Record<string, unknown>;
    // A connection test that spends real tokens is one users switch off.
    expect(body["max_tokens"]).toBe(1);
    expect(body["stream"]).toBe(false);
  });

  it("refuses to probe without a key, and says why", async () => {
    await expect(probeConnection(request({ apiKey: "" }))).rejects.toBeInstanceOf(ConnectionProbeError);
    await expect(probeConnection(request({ apiKey: "   " }))).rejects.toMatchObject({
      code: "missing_api_key",
    });
  });

  it("refuses to probe without a model", async () => {
    await expect(probeConnection(request({ model: "" }))).rejects.toMatchObject({ code: "missing_model" });
  });

  it("refuses a vendor with no measured CORS story", async () => {
    await expect(
      probeConnection(request({ vendor: "opencode-zen" }), { fetch: scriptedFetch({}).fetch }),
    ).rejects.toMatchObject({ code: "unknown_provider" });
  });

  it("insists on a base URL for an OpenAI-compatible entry", async () => {
    // `@ai-sdk/openai-compatible` has no default endpoint, and neither has the
    // registry's contract — a name is a label, never a URL.
    await expect(
      probeConnection(
        request({ vendor: "openai-compatible:groq", baseUrl: undefined }),
        { fetch: scriptedFetch({}).fetch },
      ),
    ).rejects.toMatchObject({ code: "missing_endpoint" });
  });

  it("strips a trailing slash so the joined path is well-formed", async () => {
    const { fetch, calls } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    await probeConnection(
      request({ vendor: "openai-compatible:groq", baseUrl: "https://api.groq.com/openai/v1/" }),
      { fetch },
    );

    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/models");
  });

  it("times out rather than hanging the wizard", async () => {
    // The fake honours the signal, because a real `fetch` does — that is the whole
    // contract the probe's timeout depends on. A fake that ignored the signal would
    // hang here forever and prove nothing about the abort.
    const stalled: ProbeFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });

    const report = await probeConnection(request(), { fetch: stalled, timeoutMs: 5 });

    // Without the timeout, a black-hole endpoint hangs the onboarding wizard.
    expect(report.endpoints.models.errorKind).toBe("aborted");
    expect(report.endpoints.models.result).toBe("threw");
    expect(report.outcome).toBe("unreachable");
  });

  it("records how long each endpoint took", async () => {
    let tick = 0;
    const { fetch } = scriptedFetch({
      "/models": () => {
        tick = 5;
        return Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } }));
      },
      "/chat/completions": () => {
        tick = 12;
        return Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } }));
      },
    });

    const report = await probeConnection(request(), { fetch, now: () => tick });

    expect(report.endpoints.models.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.endpoints.inference.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("probeFromSettings", () => {
  function settingsWith(vendor: string, slot: string, apiKey: string | undefined): ReturnType<typeof defaultSettings> {
    const base = defaultSettings();
    return {
      ...base,
      provider: { vendor, model: "gpt-4o-mini" },
      apiKeys: apiKey === undefined ? {} : { [slot]: apiKey },
    };
  }

  it("reads the key out of the store and probes with it", async () => {
    const { fetch } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    const report = await probeFromSettings(settingsWith("openai", "openai", SECRET), { fetch });

    expect(report.outcome).toBe("ok");
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("names the slot when no key is stored for it", async () => {
    await expect(probeFromSettings(settingsWith("openai", "openai", undefined))).rejects.toMatchObject({
      code: "missing_api_key",
    });
  });

  it("keeps a named OpenAI-compatible entry's key in its own slot", async () => {
    const { fetch } = scriptedFetch({
      "/models": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
      "/chat/completions": () => Promise.resolve(jsonResponse({}, { headers: { "access-control-allow-origin": "*" } })),
    });

    // A key under the bare `openai-compatible` slot must NOT be found for
    // `openai-compatible:groq`. Three of those can exist at once, and a flat slot
    // would hand one provider's key to another.
    await expect(
      probeFromSettings(settingsWith("openai-compatible:groq", "openai-compatible", SECRET), { fetch }),
    ).rejects.toMatchObject({ code: "missing_api_key" });

    // With the key in its own slot, the probe gets as far as the missing endpoint.
    await expect(
      probeFromSettings(settingsWith("openai-compatible:groq", "openai-compatible:groq", SECRET), { fetch }),
    ).rejects.toMatchObject({ code: "missing_endpoint" });

    // And with both, it runs.
    const settings = settingsWith("openai-compatible:groq", "openai-compatible:groq", SECRET);
    const report = await probeFromSettings(
      { ...settings, provider: { vendor: "openai-compatible:groq", model: "llama-3", baseUrl: "https://api.groq.com/openai/v1" } },
      { fetch },
    );
    expect(report.outcome).toBe("ok");
  });

  it("refuses when no provider is selected", async () => {
    const settings = { ...defaultSettings() };
    await expect(probeFromSettings(settings)).rejects.toMatchObject({ code: "unknown_provider" });
  });
});

describe("the catalog (Plan.md §9)", () => {
  it("does not offer OpenCode Zen — it is not browser-callable", () => {
    // §9: preflight 404, no ACAO on the error path, "nicht möglich". Listing it
    // would offer a choice that cannot work, and §2 forbids the proxy that would
    // "fix" it.
    const ids = PROVIDER_CATALOG.map((entry) => entry.id);
    expect(ids).not.toContain("opencode-zen");
    expect(JSON.stringify(PROVIDER_CATALOG).toLowerCase()).not.toContain("zen");
    expect(isKnownProvider("opencode-zen")).toBe(false);
  });

  it("marks OpenAI as unconfirmed, which is what §9 measured", () => {
    const openai = findProvider("openai");

    // Only `/v1/models` sends ACAO; the inference endpoints do not on the error
    // path, so §9's row reads "unbestätigt" and the UI must not promise otherwise.
    expect(openai?.cors).toBe("unconfirmed");
    expect(openai?.corsVerified).toBe(false);
    expect(openai?.note).toContain("/v1/models");
  });

  it("marks Anthropic as needing its browser header", () => {
    const anthropic = findProvider("anthropic");

    expect(anthropic?.requiresBrowserHeader).toBe(true);
    expect(anthropic?.cors).toBe("verified");
  });

  it("agrees with core's corsVerdict for every entry — from literals, not from core", () => {
    // Two statements of one measurement in two packages. The expectation is a
    // **table written out here**, one row per catalog entry, and NOT
    // `coreSomething(entry.id)`: the previous version of this test compared
    // `entry.corsVerified` against `entry.id !== "openai"`, which is the old bug
    // restated — it would have gone green against a catalog that lied in the
    // same direction.
    //
    // `openai-compatible` and `anthropic-compatible` read "unmeasured" because
    // §9's rows are "beliebige … zur Laufzeit prüfen" and "no Messages-compatible
    // third party was measured at all". The six named OpenAI-compatible
    // operators were measured; this row is the *shape* a user fills in, and the
    // app has no id for any of the six.
    const expected: Readonly<Record<string, CorsVerdict>> = {
      openai: "unconfirmed",
      anthropic: "verified",
      google: "verified",
      "openai-compatible": "unmeasured",
      "anthropic-compatible": "unmeasured",
    };

    expect(PROVIDER_CATALOG.map((entry) => entry.id)).toEqual(Object.keys(expected));

    for (const entry of PROVIDER_CATALOG) {
      expect({ id: entry.id, cors: entry.cors }, entry.id).toEqual({ id: entry.id, cors: expected[entry.id] });
      // …and the boolean the wizard badge is rendered from is the strict
      // narrowing of the same row, not a second opinion.
      expect(entry.corsVerified, entry.id).toBe(entry.cors === "verified");
      // …and the two packages still agree, which is what this test is for.
      expect(corsVerdict(entry.id), entry.id).toBe(expected[entry.id]);
    }
  });

  it("claims the Anthropic browser header on exactly one row", () => {
    // The negative, per row. `requiresBrowserHeader` is what the wizard shows as
    // "Sonderheader nötig", and it is the row-level face of the operator
    // decision core makes in `requiredHeaders`.
    expect(findProvider("anthropic")?.requiresBrowserHeader).toBe(true);
    for (const id of ["openai", "google", "openai-compatible", "anthropic-compatible"]) {
      expect(findProvider(id)?.requiresBrowserHeader, id).toBe(false);
    }
  });

  it("offers the anthropic-compatible shape, needing an endpoint and no header", () => {
    const row = findProvider("anthropic-compatible");

    expect(row?.needsEndpoint).toBe(true);
    expect(row?.baseUrl).toBeUndefined();
    // Spoken by `isKnownProvider` for the *composite* id too, so a stored
    // `anthropic-compatible:my-proxy` finds its row.
    expect(isKnownProvider("anthropic-compatible:my-proxy")).toBe(true);
    expect(findProvider("anthropic-compatible:my-proxy")?.id).toBe("anthropic-compatible");
  });

  it("requires an endpoint for the OpenAI-compatible row", () => {
    const compatible = findProvider("openai-compatible");

    expect(compatible?.needsEndpoint).toBe(true);
    expect(compatible?.baseUrl).toBeUndefined();
  });

  it("finds a named OpenAI-compatible entry by its composite id", () => {
    expect(findProvider("openai-compatible:groq")?.id).toBe("openai-compatible");
    expect(isKnownProvider("openai-compatible:groq:llama-3")).toBe(true);
  });
});

/** Keeps the exported observation type referenced where it is produced. */
export type _ObservationShape = EndpointObservation;

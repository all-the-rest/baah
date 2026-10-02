/**
 * The model list, against the three response shapes §9's providers actually send.
 *
 * ## What is under test and why each case earns its place
 *
 * The loader is the first thing in this block that reads a body it did not
 * shape, so the tests are mostly about **not lying**:
 *
 * 1. **Both `data[]` shapes.** OpenAI's is `{ data: [{ id }] }`; Anthropic's is
 *    the same envelope plus `display_name` and the cursor fields. A loader that
 *    reads only `data[].id` is half right for Anthropic: the wizard would show
 *    `claude-haiku-4-5-20251001` where `Claude Haiku 4.5` exists.
 * 2. **Pagination, followed to the end.** `has_more: true` means the first page
 *    is not the list. The `after_id` cursor is asserted on the **request URL**,
 *    because a loader that re-requests page one forever still terminates — on
 *    the cap, with a list that looks complete to the caller.
 * 3. **Incompleteness, reported.** When the loader stops early it sets
 *    `complete: false` and says why. That is the same promise as a truncated
 *    `grep`: a partial list presented as a whole is a model the user could not
 *    have picked.
 * 4. **The key never in a URL.** Every recorded request is checked.
 */

import { describe, expect, it } from "vitest";

import { ModelListError, listModels, type ModelListFetch, type ModelRequestInit } from "./models.ts";
import { defaultSettings } from "../lib/settings.ts";
import { listModelsFromSettings } from "./models.ts";

const SECRET = "sk-models-DO-NOT-LEAK-abcdefghijklmno";

interface Recorded {
  readonly url: string;
  readonly init: ModelRequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

/**
 * A fetch driven by a list of responses, one per call.
 *
 * Deny-by-default in the sense that matters: a run that asks for more pages than
 * the script has answers with a body that is **not** a model list, so an
 * accidental extra request fails the parse instead of quietly returning `[]` and
 * letting a `complete: true` slip through.
 */
function pagedFetch(bodies: readonly unknown[]): { fetch: ModelListFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const body = bodies[calls.length - 1];
      if (body === undefined) {
        return Promise.resolve(jsonResponse({ error: { type: "unexpected_extra_request" } }, 501));
      }
      return Promise.resolve(jsonResponse(body));
    },
  };
}

/* ------------------------------------------------------------------ */
/* The two `data[]` shapes                                              */
/* ------------------------------------------------------------------ */

describe("listModels — the OpenAI shape", () => {
  it("reads ids from `data[].id`, and no cursor from a body that has none", async () => {
    const { fetch, calls } = pagedFetch([
      { object: "list", data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o", object: "model" }] },
    ]);

    const list = await listModels({ vendor: "openai", apiKey: SECRET }, { fetch });

    expect(list.models.map((model) => model.id)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    // No `display_name` in this shape, so the id is the name. Asserted because
    // the fallback is what makes one loader serve both.
    expect(list.models[0]?.displayName).toBe("gpt-4o-mini");
    expect(list.complete).toBe(true);
    expect(list.pages).toBe(1);
    expect(list.incompleteReason).toBe("");
    // No cursor was invented, so the request carried no query string at all.
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
  });

  it("works for an openai-compatible server at the user's base URL", async () => {
    const { fetch, calls } = pagedFetch([{ data: [{ id: "llama-3" }] }]);

    const list = await listModels(
      { vendor: "openai-compatible:groq", apiKey: SECRET, baseUrl: "https://api.groq.com/openai/v1" },
      { fetch },
    );

    expect(list.models.map((model) => model.id)).toEqual(["llama-3"]);
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/models");
  });
});

/* ------------------------------------------------------------------ */
/* The auth header, and the defect it had                                */
/* ------------------------------------------------------------------ */

describe("listModels — how the key travels", () => {
  it("sends `Authorization: Bearer <key>` to every bearer endpoint", async () => {
    // **The scheme is part of the credential.** RFC 6750 §2.1. This asserted the
    // bare key for a while, which is worse than uncovered: it pinned the defect.
    // Every one of the six §9-measured OpenAI-compatible operators answers a bare
    // token with `401`, and `probe.ts` reads a `401` as `key-rejected` — so the
    // wizard told six operators' users their working key was rejected.
    for (const [vendor, baseUrl] of [
      ["openai", undefined],
      ["openai-compatible:groq", "https://api.groq.com/openai/v1"],
    ] as const) {
      const { fetch, calls } = pagedFetch([{ data: [{ id: "m" }] }]);

      await listModels({ vendor, apiKey: SECRET, ...(baseUrl === undefined ? {} : { baseUrl }) }, { fetch });

      // Literal, and the exact shape: `Bearer ` with one space. A loader that
      // dropped the prefix, or spelled it `bearer `, would fail this line.
      expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${SECRET}`);
      // …and nothing else carries the key.
      expect(Object.keys(calls[0]?.init.headers ?? {})).not.toContain("x-api-key");
      expect(Object.keys(calls[0]?.init.headers ?? {})).not.toContain("x-goog-api-key");
    }
  });

  it("sends the two KEYED styles raw — Anthropic and Google document no scheme", async () => {
    // The opposite case, and it must not be "fixed" along with the one above:
    // `x-api-key` and `x-goog-api-key` take the bare key, so a `Bearer ` prefix here
    // would be a second bug of the same shape.
    const anthropic = pagedFetch([{ data: [], has_more: false }]);
    await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch: anthropic.fetch });
    expect(anthropic.calls[0]?.init.headers["x-api-key"]).toBe(SECRET);
    expect(anthropic.calls[0]?.init.headers.authorization).toBeUndefined();

    const google = pagedFetch([{ models: [] }]);
    await listModels({ vendor: "google", apiKey: SECRET }, { fetch: google.fetch });
    expect(google.calls[0]?.init.headers["x-goog-api-key"]).toBe(SECRET);
    expect(google.calls[0]?.init.headers.authorization).toBeUndefined();
  });

  it("keeps the prefixed key out of the URL on a bearer endpoint too", async () => {
    // The `Bearer ` prefix must not become part of a query parameter. A URL is the
    // most loggable string on the path and this one carries a credential.
    const { fetch, calls } = pagedFetch([
      { data: [{ id: "a" }], has_more: true, last_id: "a" },
      { data: [{ id: "b" }] },
    ]);

    await listModels({ vendor: "openai-compatible:groq", apiKey: SECRET, baseUrl: "https://api.groq.com/openai/v1" }, { fetch });

    for (const call of calls) {
      expect(call.url).not.toContain(SECRET);
      expect(call.url).not.toContain("Bearer");
    }
  });
});

describe("listModels — the Anthropic shape", () => {
  it("prefers `display_name` and keeps the id for the request", async () => {
    // The case a `data[].id`-only loader gets wrong: the list is *readable* and
    // only the labels are missing, which is exactly the kind of defect that
    // survives a smoke test.
    const { fetch } = pagedFetch([
      {
        data: [
          { type: "model", id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
          { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" },
        ],
        has_more: false,
        first_id: "claude-haiku-4-5-20251001",
        last_id: "claude-opus-5",
      },
    ]);

    const list = await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch });

    expect(list.models).toEqual([
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
      { id: "claude-opus-5", displayName: "Claude Opus 5" },
    ]);
    expect(list.shape).toBe("anthropic");
    expect(list.complete).toBe(true);
  });

  it("sends `x-api-key` and `anthropic-version`, and the browser header", async () => {
    const { fetch, calls } = pagedFetch([{ data: [], has_more: false }]);

    await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch });

    expect(calls[0]?.init.headers["x-api-key"]).toBe(SECRET);
    expect(calls[0]?.init.headers["anthropic-version"]).toBe("2023-06-01");
    // First-party: the browser-access header is required here (§9) or a wrong key
    // arrives as an opaque `Failed to fetch`.
    expect(calls[0]?.init.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("does NOT send the Anthropic browser header to an anthropic-compatible endpoint", async () => {
    // Same assertion as the registry and the factory tests, at the third place a
    // header could be added. A loader that "helpfully" added it would leak the
    // fact that this app talks to Anthropic to a third party.
    const { fetch, calls } = pagedFetch([{ data: [], has_more: false }]);

    await listModels(
      { vendor: "anthropic-compatible:my-proxy", apiKey: SECRET, baseUrl: "https://gateway.example.invalid/v1" },
      { fetch },
    );

    expect(Object.keys(calls[0]?.init.headers ?? {})).not.toContain(
      "anthropic-dangerous-direct-browser-access",
    );
    // …and the dialect's own parameter is still there, so "no header" was not
    // achieved by "no headers".
    expect(calls[0]?.init.headers["anthropic-version"]).toBe("2023-06-01");
  });
});

/* ------------------------------------------------------------------ */
/* Pagination — the acceptance criterion for P3                         */
/* ------------------------------------------------------------------ */

describe("listModels — Anthropic pagination", () => {
  it("follows `has_more` to the END, using `after_id` as the cursor", async () => {
    // Three pages, `has_more: true` twice. The third body is deliberately
    // *smaller* than the second, so a loader that overwrites rather than
    // appends would end up with two models instead of three.
    const { fetch, calls } = pagedFetch([
      {
        data: [{ id: "claude-a", display_name: "A" }],
        has_more: true,
        first_id: "claude-a",
        last_id: "claude-a",
      },
      {
        data: [{ id: "claude-b", display_name: "B" }],
        has_more: true,
        first_id: "claude-b",
        last_id: "claude-b",
      },
      { data: [{ id: "claude-c", display_name: "C" }], has_more: false, last_id: "claude-c" },
    ]);

    const list = await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch });

    expect(list.models.map((model) => model.id)).toEqual(["claude-a", "claude-b", "claude-c"]);
    expect(list.pages).toBe(3);
    expect(list.complete).toBe(true);
    expect(list.incompleteReason).toBe("");
    // The cursor is on the **request**, asserted literally: a loader that re-asks
    // for page one terminates on the cap instead, and then reports a list that
    // looks complete to the caller.
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[1]?.url).toBe("https://api.anthropic.com/v1/models?after_id=claude-a");
    expect(calls[2]?.url).toBe("https://api.anthropic.com/v1/models?after_id=claude-b");
  });

  it("deduplicates a repeated entry across a page boundary", async () => {
    // Cursor pagination can repeat the boundary item. Two identical rows in a
    // `<select>` are a model the user picks twice and cannot tell apart.
    const { fetch } = pagedFetch([
      { data: [{ id: "claude-a" }, { id: "claude-b" }], has_more: true, last_id: "claude-b" },
      { data: [{ id: "claude-b" }, { id: "claude-c" }], has_more: false, last_id: "claude-c" },
    ]);

    const list = await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch });

    expect(list.models.map((model) => model.id)).toEqual(["claude-a", "claude-b", "claude-c"]);
    expect(list.complete).toBe(true);
  });

  it("REPORTS an incomplete list when the page cap is hit — never a silent partial", async () => {
    // `has_more: true` forever, capped at 2. The three models are kept and the
    // fact that there are more is stated; `complete: false` is the whole promise.
    const { fetch } = pagedFetch([
      { data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" },
      { data: [{ id: "claude-b" }], has_more: true, last_id: "claude-b" },
      { data: [{ id: "claude-c" }], has_more: true, last_id: "claude-c" },
    ]);

    const list = await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch, maxPages: 2 });

    expect(list.models.map((model) => model.id)).toEqual(["claude-a", "claude-b"]);
    expect(list.pages).toBe(2);
    expect(list.complete).toBe(false);
    expect(list.incompleteReason).not.toBe("");
  });

  it("REPORTS incompleteness when `has_more` is true but there is no cursor", async () => {
    // The endpoint that would otherwise spin: it says there is more and sends
    // nothing to fetch it with. Reported, not retried.
    const { fetch, calls } = pagedFetch([{ data: [{ id: "claude-a" }], has_more: true }]);

    const list = await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch });

    expect(list.complete).toBe(false);
    expect(list.incompleteReason).not.toBe("");
    expect(calls).toHaveLength(1);
  });

  it("stops when the cursor stops advancing, rather than looping", async () => {
    const { fetch, calls } = pagedFetch([
      { data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" },
      { data: [{ id: "claude-b" }], has_more: true, last_id: "claude-a" },
    ]);

    const list = await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch });

    expect(list.complete).toBe(false);
    expect(list.incompleteReason).not.toBe("");
    expect(calls).toHaveLength(2);
  });

  it("follows Google's `nextPageToken` too, and stops when it is absent", async () => {
    const { fetch, calls } = pagedFetch([
      { models: [{ name: "models/gemini-flash", displayName: "Gemini Flash" }], nextPageToken: "tok-1" },
      { models: [{ name: "models/gemini-pro", displayName: "Gemini Pro" }] },
    ]);

    const list = await listModels({ vendor: "google", apiKey: SECRET }, { fetch });

    expect(list.models).toEqual([
      { id: "models/gemini-flash", displayName: "Gemini Flash" },
      { id: "models/gemini-pro", displayName: "Gemini Pro" },
    ]);
    expect(list.complete).toBe(true);
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(calls[1]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageToken=tok-1");
    // The key is a header, never a query parameter — a URL is the most loggable
    // string on the path and every server log on it records one.
    expect(calls[0]?.init.headers["x-goog-api-key"]).toBe(SECRET);
    expect(calls[1]?.url).not.toContain(SECRET);
  });

  it("follows `nextPageToken` for a GOOGLE-SHAPED body behind a NON-Google vendor id", async () => {
    // **The parse honours "content is the only evidence"; the pagination must too.**
    //
    // A proxy in front of Google is free to answer with Google's envelope while the
    // vendor id says `openai-compatible` — the `parsePage` header says exactly that.
    // Keying the pagination on the vendor string contradicted it: the body was read
    // correctly as `shape: "google"` and then paged as if it were a `data[]` list,
    // so the `nextPageToken` was **present and discarded**. One page, one of two
    // models, `complete: false` blaming the cap.
    //
    // Measured before the fix: `urls: ["…/v1/models"]`, `models: ["models/gemini-flash"]`.
    const { fetch, calls } = pagedFetch([
      { models: [{ name: "models/gemini-flash", displayName: "Gemini Flash" }], nextPageToken: "tok-1" },
      { models: [{ name: "models/gemini-pro", displayName: "Gemini Pro" }] },
    ]);

    const list = await listModels(
      { vendor: "openai-compatible:my-proxy", apiKey: SECRET, baseUrl: "https://p.example.invalid/v1" },
      { fetch },
    );

    // Both pages, on the **request URL** — the cursor is the thing that was dropped.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://p.example.invalid/v1/models");
    expect(calls[1]?.url).toBe("https://p.example.invalid/v1/models?pageToken=tok-1");
    expect(list.models.map((model) => model.id)).toEqual(["models/gemini-flash", "models/gemini-pro"]);
    // And the honest verdict: the cursor ran out, so this list IS complete. The bug
    // reported `false` here while the second page sat unfetched.
    expect(list.complete).toBe(true);
    expect(list.incompleteReason).toBe("");
    expect(list.shape).toBe("google");
  });

  it("stops on a repeated `nextPageToken` from a non-Google vendor, and says so", async () => {
    // The other half of the same branch: a cursor that does not advance has to
    // terminate. This is reachable from a non-Google vendor only because the branch
    // now keys on the shape, so it is the case that proves the branch is reached.
    const { fetch, calls } = pagedFetch([
      { models: [{ name: "models/a" }], nextPageToken: "tok-1" },
      { models: [{ name: "models/b" }], nextPageToken: "tok-1" },
    ]);

    const list = await listModels(
      { vendor: "openai-compatible:my-proxy", apiKey: SECRET, baseUrl: "https://p.example.invalid/v1" },
      { fetch },
    );

    expect(calls).toHaveLength(2);
    expect(list.complete).toBe(false);
    expect(list.incompleteReason).toBe("The provider returned the same page token twice.");
    expect(list.models.map((model) => model.id)).toEqual(["models/a", "models/b"]);
  });

  it("paginates a `data[]` body with a `has_more` cursor behind a GOOGLE vendor id", async () => {
    // The mirror image, and the one that would break if the fix had been "prefer
    // Google's cursor": a proxy in front of Anthropic may answer with the `data[]`
    // envelope under a `google` vendor id. Keying on the vendor would have read
    // `has_more` as absent and stopped after one page with `complete: true` — the
    // worst possible answer, because it is a lie in the optimistic direction.
    const { fetch, calls } = pagedFetch([
      { data: [{ id: "m-a" }], has_more: true, last_id: "m-a" },
      { data: [{ id: "m-b" }], has_more: false, last_id: "m-b" },
    ]);

    const list = await listModels(
      { vendor: "google", apiKey: SECRET, baseUrl: "https://p.example.invalid/v1beta" },
      { fetch },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://p.example.invalid/v1beta/models?after_id=m-a");
    expect(list.models.map((model) => model.id)).toEqual(["m-a", "m-b"]);
    expect(list.complete).toBe(true);
    expect(list.shape).toBe("anthropic");
  });
});

/* ------------------------------------------------------------------ */
/* Refusing to guess                                                    */
/* ------------------------------------------------------------------ */

describe("listModels — it refuses rather than guesses", () => {
  it("rejects a body that is not a model list, instead of reporting 0 models", async () => {
    // "The provider serves no models" and "the provider's answer was not a
    // model list" are different facts, and only one of them may become an empty
    // list in the wizard.
    const { fetch } = pagedFetch([{ error: { type: "invalid_request_error" } }]);

    await expect(listModels({ vendor: "openai", apiKey: SECRET }, { fetch })).rejects.toMatchObject({
      name: "ModelListError",
      code: "malformed_response",
    });
  });

  it("rejects an HTTP error as `http_error`, not as an unparseable body", async () => {
    // "The provider refused you" and "we could not understand the answer" are
    // different sentences on screen. One code for both would have said the
    // second about a 401.
    const failing: ModelListFetch = () => Promise.resolve(jsonResponse({ error: {} }, 401));

    try {
      await listModels({ vendor: "openai", apiKey: SECRET }, { fetch: failing });
      expect.unreachable();
    } catch (error) {
      expect((error as ModelListError).code).toBe("http_error");
      expect((error as Error).message).toContain("401");
    }
  });

  it("reports a blocked call as `unreachable`, and a timeout as a timeout", async () => {
    // A rejected `fetch` is CORS or the network, and the browser refuses to say
    // which — exactly the §9 situation `probe.ts` documents. The **timeout** is
    // named separately: "the provider blocks this call" is a claim about a
    // provider policy, and waiting 10 ms is not evidence of one.
    const blocked: ModelListFetch = () => Promise.reject(new TypeError("Failed to fetch"));
    try {
      await listModels({ vendor: "openai", apiKey: SECRET }, { fetch: blocked });
      expect.unreachable();
    } catch (error) {
      expect((error as ModelListError).code).toBe("unreachable");
      expect((error as Error).message).toContain("blocks this call, or the host is unreachable");
      expect((error as Error).message).not.toContain("in time");
    }

    // A fetch that rejects only once the signal fires is what a timeout looks
    // like from here.
    const hangs: ModelListFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    try {
      await listModels({ vendor: "openai", apiKey: SECRET }, { fetch: hangs, timeoutMs: 5 });
      expect.unreachable();
    } catch (error) {
      expect((error as ModelListError).code).toBe("unreachable");
      expect((error as Error).message).toContain("did not arrive in time");
    }
  });

  it("refuses a template row with no base URL, and an unknown vendor", async () => {
    await expect(
      listModels({ vendor: "openai-compatible:groq", apiKey: SECRET }),
    ).rejects.toMatchObject({ code: "missing_endpoint" });

    await expect(listModels({ vendor: "cohere", apiKey: SECRET })).rejects.toMatchObject({
      code: "unknown_provider",
    });
  });

  it("refuses an empty key rather than sending one", async () => {
    await expect(listModels({ vendor: "openai", apiKey: "  " })).rejects.toMatchObject({
      code: "missing_api_key",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Secrets                                                              */
/* ------------------------------------------------------------------ */

describe("listModels — the key never leaves the header", () => {
  it("is absent from every URL and from every error message", async () => {
    const { fetch, calls } = pagedFetch([
      { data: [{ id: "a" }], has_more: true, last_id: "a" },
      { data: [{ id: "b" }], has_more: false },
    ]);

    await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch });

    for (const call of calls) expect(call.url).not.toContain(SECRET);

    const blocked: ModelListFetch = () => Promise.reject(new TypeError("Failed to fetch"));
    try {
      await listModels({ vendor: "anthropic", apiKey: SECRET }, { fetch: blocked });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).stack ?? "").not.toContain(SECRET);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The wizard's entry point                                             */
/* ------------------------------------------------------------------ */

describe("listModelsFromSettings", () => {
  const withProvider = (vendor: string, baseUrl: string, apiKey: string) => ({
    ...defaultSettings(),
    provider: { vendor, model: "m", baseUrl },
    apiKeys: { [vendor]: apiKey },
  });

  it("reads the key out of the store, so the wizard never holds it", async () => {
    const { fetch, calls } = pagedFetch([{ data: [{ id: "claude-fake" }] }]);

    const list = await listModelsFromSettings(
      withProvider("anthropic-compatible:my-proxy", "https://gateway.example.invalid/v1", SECRET),
      { fetch },
    );

    expect(list.models.map((model) => model.id)).toEqual(["claude-fake"]);
    expect(calls[0]?.url).toBe("https://gateway.example.invalid/v1/models");
    expect(calls[0]?.init.headers["x-api-key"]).toBe(SECRET);
  });

  it("looks in the row's own key slot, not a flat one", async () => {
    // Three OpenAI-compatible endpoints can exist at once; a flat slot hands one
    // provider's key to another.
    const settings = {
      ...defaultSettings(),
      provider: { vendor: "openai-compatible:groq", model: "m", baseUrl: "https://api.groq.com/openai/v1" },
      apiKeys: { "openai-compatible": SECRET },
    };

    await expect(listModelsFromSettings(settings)).rejects.toMatchObject({ code: "missing_api_key" });
  });

  it("refuses when no provider is selected", async () => {
    await expect(listModelsFromSettings(defaultSettings())).rejects.toMatchObject({
      code: "unknown_provider",
    });
  });

  it("surfaces the loader's own error type, so a caller can name it", () => {
    // The runtime classifies failures by class; an anonymous `Error` here would
    // be reported as an unknown subsystem.
    expect(new ModelListError("unknown_provider", "x")).toBeInstanceOf(ModelListError);
  });
});

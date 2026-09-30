/**
 * `webfetch` — the behaviour a model acts on.
 *
 * The claims under test, in the order the brief puts them:
 *  1. a bare `TypeError` is reported as *indistinguishable*, never guessed;
 *  2. a real HTTP status is reported and a body is never invented;
 *  3. an over-cap body is refused and reported, never silently shortened;
 *  4. the call is abortable, and an abort reads as an abort;
 *  5. content type decides the treatment;
 *  6. fetched content is marked as data, not instructions.
 */
import { type ToolContext } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import {
  createWebfetchTool,
  executeWebfetch,
  MAX_ERROR_BODY_BYTES,
  webfetchTool,
} from "../src/index.ts";
import { corsBlockedFetch, fakeFetch, fakeResponse, stallingFetch } from "./fake-fetch.ts";

function context(signal = new AbortController().signal): ToolContext {
  return {
    // `webfetch` never touches the workspace — that is the point of `access:
    // "network"`, and it is asserted in `verify-seam.test.ts`. The field is
    // still required by the context contract.
    workspace: { id: "unused", label: "unused" },
    cwd: ".",
    signal,
    approve: async () => "allow-once",
    emit: () => {},
    toolCallId: "test-webfetch",
    attempt: 1,
  } as unknown as ToolContext;
}

const URL_OK = "https://example.test/page";

describe("a CORS-blocked request is reported as indistinguishable, not guessed", () => {
  it("names every cause it cannot tell apart, and never says 'network down'", async () => {
    const { fetch } = corsBlockedFetch();

    const error = await executeWebfetch(context(), { url: URL_OK }, { fetch }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.startsWith("webfetch blocked:")).toBe(true);
    // The two claims that matter: the CORS cause is named, and the tool says
    // it cannot choose between the causes.
    expect(message).toMatch(/Access-Control-Allow-Origin/);
    expect(message).toMatch(/not observable from here/);
    expect(message).toMatch(/no network/);
    expect(message).toMatch(/DNS/);
    expect(message).toMatch(/TLS/);
    expect(message).toMatch(/redirect/);
    // The instruction the model must not get wrong: nothing established that
    // the site is down.
    expect(message).toMatch(/Do not report this as "the site is down"/);
    expect(message).toMatch(/Nothing was fetched/);
  });

  it("does not call the outcome a network failure", async () => {
    const { fetch } = corsBlockedFetch();
    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message).not.toMatch(/network (error|failure|problem|is down)/i);
  });

  it("quotes what the browser said, so a real message is not lost", async () => {
    const { fetch } = corsBlockedFetch();
    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message).toMatch(/Failed to fetch/);
  });

  it("still asked for the URL — the browser's refusal is about the response", async () => {
    const { fetch, calls } = corsBlockedFetch();
    await executeWebfetch(context(), { url: URL_OK }, { fetch }).catch(() => undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.test/page");
  });
});

describe("a real HTTP status is reported, and no body is invented", () => {
  it("reports the status and the status text", async () => {
    const { fetch } = fakeFetch([
      { status: 404, statusText: "Not Found", contentType: "text/plain", body: "no such page" },
    ]);

    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message.startsWith("webfetch http-error:")).toBe(true);
    expect(message).toMatch(/answered 404 Not Found/);
  });

  it("quotes the real body, fenced as untrusted, and never fabricates one", async () => {
    const { fetch } = fakeFetch([
      { status: 403, contentType: "text/plain", body: "rate limit exceeded" },
    ]);

    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message).toMatch(/rate limit exceeded/);
    expect(message).toMatch(/BEGIN FETCHED CONTENT/);
    expect(message).toMatch(/END FETCHED CONTENT/);
  });

  it("says so when the error response had no body, rather than inventing one", async () => {
    const { fetch } = fakeFetch([{ status: 500, contentType: "text/plain", body: "" }]);
    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message).toMatch(/It sent no body/);
  });

  it("cuts a long error body and says that it did", async () => {
    const { fetch } = fakeFetch([
      { status: 500, contentType: "text/plain", body: "e".repeat(MAX_ERROR_BODY_BYTES * 3) },
    ]);
    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message).toMatch(/body cut at 2000 characters/);
  });

  it("a 3xx is not silently followed into a body — the transport owns redirects", async () => {
    // The platform follows redirects itself, so a 3xx reaching this tool means
    // something unusual. Treating it as success would hand the model an empty
    // document that looks like a page.
    const { fetch } = fakeFetch([{ status: 302, contentType: "text/html", body: "" }]);
    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message.startsWith("webfetch http-error:")).toBe(true);
  });

  it("treats 299 as success and 300 as an error — the boundary is the status, not `ok`", async () => {
    const ok = fakeFetch([{ status: 299, contentType: "text/plain", body: "fine" }]);
    await expect(
      executeWebfetch(context(), { url: URL_OK }, { fetch: ok.fetch }),
    ).resolves.toMatchObject({ status: 299, content: "fine" });

    const notOk = fakeFetch([{ status: 300, contentType: "text/plain", body: "" }]);
    await expect(
      executeWebfetch(context(), { url: URL_OK }, { fetch: notOk.fetch }),
    ).rejects.toThrow(/http-error/);
  });
});

describe("an over-cap body is refused, not shortened", () => {
  it("refuses on the Content-Length header without transferring anything", async () => {
    const { fetch, calls } = fakeFetch([
      { contentType: "text/plain", contentLength: "5000", body: "short" },
    ]);

    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch, maxBytes: 100 }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message.startsWith("webfetch too-large:")).toBe(true);
    expect(message).toMatch(/announced 5000 bytes, over the 100-byte cap/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a body that lies about its length, and cancels the transfer", async () => {
    const built = fakeResponse({ contentType: "text/plain", contentLength: "10", body: "x".repeat(50), chunkSize: 10 });
    const message = await executeWebfetch(
      context(),
      { url: URL_OK },
      { fetch: () => Promise.resolve(built.response), maxBytes: 20 },
    ).then(() => "", (error: unknown) => (error as Error).message);

    expect(message.startsWith("webfetch too-large:")).toBe(true);
    expect(message).toMatch(/will not return half a document/);
    // Not merely discarded: the transfer is stopped.
    expect(built.cancelled()).toBe(true);
  });

  it("returns no part of the body it refused", async () => {
    const { fetch } = fakeFetch([
      { contentType: "text/plain", contentLength: "999999", body: "SECRET-BODY" },
    ]);
    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message).not.toMatch(/SECRET-BODY/);
  });

  it("refuses a body that crosses the cap mid-stream, and stops reading there", async () => {
    // `contentLength: null` suppresses the header, so the byte count in the
    // reader loop is the only thing that can catch this. Without that
    // distinction the header short-circuit and the loop shadow each other, and
    // deleting the loop would be invisible.
    const built = fakeResponse({
      contentType: "text/plain",
      contentLength: null,
      body: "abcdefghij",
      chunkSize: 4,
    });
    const message = await executeWebfetch(
      context(),
      { url: URL_OK },
      { fetch: () => Promise.resolve(built.response), maxBytes: 6 },
    ).then(() => "", (error: unknown) => (error as Error).message);

    expect(message.startsWith("webfetch too-large:")).toBe(true);
    expect(message).toMatch(/after 8 bytes were transferred/);
    expect(built.cancelled()).toBe(true);
    expect(built.cancelReason()).toBe("webfetch byte cap");
  });

  it("a body exactly at the cap is accepted — the limit is inclusive", async () => {
    const built = fakeResponse({ contentType: "text/plain", contentLength: null, body: "abcdefghij" });
    const result = await executeWebfetch(
      context(),
      { url: URL_OK },
      { fetch: () => Promise.resolve(built.response), maxBytes: 10 },
    );
    expect(result.content).toBe("abcdefghij");
    expect(result.bytes).toBe(10);
    expect(result.maxBytes).toBe(10);
  });

  it("reports the cap it applied, so the number in the result is never invented", async () => {
    const { fetch } = fakeFetch([{ contentType: "text/plain", body: "x" }]);
    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });
    expect(result.maxBytes).toBe(1_048_576);
  });
});

describe("the call is abortable", () => {
  it("makes no request at all when the turn was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, calls } = corsBlockedFetch();

    const message = await executeWebfetch(context(controller.signal), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );

    expect(message.startsWith("webfetch aborted:")).toBe(true);
    expect(message).toMatch(/already aborted/);
    expect(calls).toHaveLength(0);
  });

  it("passes the turn's signal down to the transport, so one abort stops both", async () => {
    const controller = new AbortController();
    const { fetch, calls } = stallingFetch();
    const pending = executeWebfetch(context(controller.signal), { url: URL_OK }, { fetch });
    await Promise.resolve();

    // The transport is handed a signal of its own that is wired to the turn's,
    // not the caller's object: the tool needs to abort it on timeout too.
    const handed = calls[0]?.init.signal;
    expect(handed).toBeDefined();
    expect(handed).not.toBe(controller.signal);
    expect(handed?.aborted).toBe(false);

    controller.abort();
    expect(handed?.aborted).toBe(true);
    await pending.catch(() => undefined);
  });

  it("stops listening to the turn once the response has been read", async () => {
    // A listener left on the turn's signal outlives the call; on a long session
    // that is a leak, and it also means a later abort reaches into a request
    // that has already finished.
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch([{ contentType: "text/plain", body: "x" }]);
    await executeWebfetch(context(controller.signal), { url: URL_OK }, { fetch });
    const handed = calls[0]?.init.signal;
    controller.abort();
    expect(handed?.aborted).toBe(false);
  });

  it("reads a mid-request abort as an abort, not as a CORS block", async () => {
    const controller = new AbortController();
    const { fetch } = stallingFetch();
    // A short own timeout on purpose. An implementation that drops the caller's
    // abort still *labels* the outcome correctly, because the classifier reads
    // `context.signal.aborted` directly rather than trusting the transport to
    // tell it — so a label assertion alone does not catch that mutant. The
    // damage is the request still running, and that is what the next test
    // measures. Here the short deadline just keeps the mutant quick.
    const pending = executeWebfetch(context(controller.signal), { url: URL_OK }, {
      fetch,
      timeoutMs: 250,
    });
    await Promise.resolve();
    controller.abort();

    const message = await pending.then(() => "", (error: unknown) => (error as Error).message);
    expect(message.startsWith("webfetch aborted:")).toBe(true);
    expect(message).not.toMatch(/Access-Control-Allow-Origin/);
    expect(message).not.toMatch(/webfetch timeout:/);
  });

  it("stops the request on the turn's abort alone, not on its own deadline", async () => {
    // The defect the label assertion above cannot see: an implementation that
    // does not forward the turn's signal leaves the request in flight until the
    // tool's own timeout fires, burning the user's bandwidth and connection for
    // a turn that was cancelled. Raced against a short timer so the mutant
    // fails an *assertion* in a second rather than hanging until vitest's
    // ceiling.
    const controller = new AbortController();
    const { fetch } = stallingFetch();
    const pending = executeWebfetch(context(controller.signal), { url: URL_OK }, {
      fetch,
      timeoutMs: 60_000,
    });
    await Promise.resolve();
    controller.abort();

    const settled = await Promise.race([
      pending.then(() => "RESOLVED", (error: unknown) => (error as Error).message),
      new Promise<string>((resolve) => setTimeout(() => resolve("STILL PENDING"), 1_000)),
    ]);
    expect(settled).not.toBe("STILL PENDING");
    expect(settled.startsWith("webfetch aborted:")).toBe(true);
  });

  it("reads a mid-body abort as an abort and keeps no part of the body", async () => {
    const controller = new AbortController();
    const pending = executeWebfetch(
      context(controller.signal),
      { url: URL_OK },
      {
        fetch: (_url, init) =>
          Promise.resolve(
            fakeResponse({
              contentType: "text/plain",
              body: "first-chunk-SECOND",
              chunkSize: 11,
              // The body stops answering after one chunk, so the abort has to
              // land while the reader is waiting.
              stallAfterChunks: 1,
              signal: init.signal,
            }).response,
          ),
      },
    );
    await Promise.resolve();
    controller.abort();

    const message = await pending.then(() => "", (error: unknown) => (error as Error).message);
    expect(message.startsWith("webfetch aborted:")).toBe(true);
    expect(message).not.toMatch(/first-chunk/);
  });

  it("a timeout reads as a timeout, not as a blocked origin", async () => {
    const { fetch } = stallingFetch();
    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch, timeoutMs: 5 }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message.startsWith("webfetch timeout:")).toBe(true);
    expect(message).not.toMatch(/Access-Control-Allow-Origin/);
  });

  it("the caller's abort outranks the timeout when both land together", async () => {
    const controller = new AbortController();
    const { fetch } = stallingFetch();
    const pending = executeWebfetch(
      context(controller.signal),
      { url: URL_OK },
      { fetch, timeoutMs: 5 },
    );
    await Promise.resolve();
    controller.abort();
    const message = await pending.then(() => "", (error: unknown) => (error as Error).message);
    expect(message.startsWith("webfetch aborted:")).toBe(true);
  });
});

describe("content type decides the treatment", () => {
  it("returns plain text as it arrived", async () => {
    const { fetch } = fakeFetch([{ contentType: "text/plain; charset=utf-8", body: "hello  world" }]);
    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });
    expect(result.kind).toBe("text");
    expect(result.content).toBe("hello  world");
    expect(result.contentType).toBe("text/plain");
  });

  it("strips HTML, including the script and style a model would read as content", async () => {
    const { fetch } = fakeFetch([
      {
        contentType: "text/html; charset=utf-8",
        body:
          "<!doctype html><html><head><title>T</title>" +
          "<style>body{color:red}</style><script>alert('x')</script></head>" +
          "<body><h1>Heading</h1><p>First&nbsp;para &amp; more.</p>" +
          "<!-- a comment --></body></html>",
      },
    ]);

    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });

    expect(result.kind).toBe("html");
    expect(result.content).toContain("Heading");
    expect(result.content).toContain("First para & more.");
    expect(result.content).not.toMatch(/alert/);
    expect(result.content).not.toMatch(/color:red/);
    expect(result.content).not.toMatch(/a comment/);
    expect(result.content).not.toMatch(/<[a-z]/i);
    expect(result.note).toMatch(/HTML/);
  });

  it("parses JSON and hands back valid, quoted-able JSON with the real values", async () => {
    const { fetch } = fakeFetch([
      { contentType: "application/json", body: JSON.stringify({ name: "baah", nested: { ok: true }, list: [1, 2, 3] }) },
    ]);

    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });

    expect(result.kind).toBe("json");
    expect(JSON.parse(result.content)).toEqual({
      name: "baah",
      nested: { ok: true },
      list: [1, 2, 3],
    });
    expect(result.truncated).toBe(false);
    expect(result.note).toMatch(/nothing was elided/);
  });

  it("reports an elision instead of quietly dropping JSON entries", async () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1) wide[`k${index}`] = index;
    const { fetch } = fakeFetch([{ contentType: "application/json", body: JSON.stringify(wide) }]);

    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });

    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/20 array item\(s\) or object key\(s\)/);
    expect(result.content).toMatch(/…elided…/);
    expect(Object.keys(JSON.parse(result.content) as object)).toHaveLength(21);
  });

  it("falls back to text and says so when declared JSON does not parse", async () => {
    const { fetch } = fakeFetch([{ contentType: "application/json", body: "{not json" }]);
    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });
    expect(result.kind).toBe("text");
    expect(result.content).toBe("{not json");
    expect(result.note).toMatch(/does not parse as JSON/);
  });

  it("refuses a binary media type instead of handing over mojibake", async () => {
    const { fetch } = fakeFetch([{ contentType: "application/pdf", body: "%PDF-1.4" }]);
    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message.startsWith("webfetch unsupported-content:")).toBe(true);
    expect(message).toMatch(/mojibake/);
  });

  it("refuses a body that lies about being text", async () => {
    const { fetch } = fakeFetch([
      { contentType: "text/plain", body: `PNG\u0000` },
    ]);
    const message = await executeWebfetch(context(), { url: URL_OK }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message.startsWith("webfetch unsupported-content:")).toBe(true);
    expect(message).toMatch(/NUL bytes/);
  });

  it("treats a response with no Content-Type as text and shows the gap", async () => {
    const { fetch } = fakeFetch([{ contentType: null, body: "plain" }]);
    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });
    expect(result.kind).toBe("text");
    expect(result.content).toBe("plain");
    expect(result.contentType).toBe("");
  });

  it("a charset parameter never changes the classification", async () => {
    const { fetch } = fakeFetch([
      { contentType: "  TEXT/HTML  ; charset=ISO-8859-1", body: "<p>x</p>" },
    ]);
    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });
    expect(result.kind).toBe("html");
    expect(result.contentType).toBe("text/html");
  });

  it("recognises a +json suffix", async () => {
    const { fetch } = fakeFetch([{ contentType: "application/vnd.api+json", body: "[1]" }]);
    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });
    expect(result.kind).toBe("json");
  });
});

describe("the URL itself", () => {
  it("rejects a string that is not a URL", async () => {
    const { fetch, calls } = corsBlockedFetch();
    const message = await executeWebfetch(context(), { url: "example.test" }, { fetch }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(message.startsWith("webfetch invalid-url:")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a scheme a browser tab cannot fetch", async () => {
    const { fetch, calls } = corsBlockedFetch();
    for (const url of ["file:///etc/passwd", "data:text/plain,hi", "javascript:alert(1)"]) {
      const message = await executeWebfetch(context(), { url }, { fetch }).then(
        () => "",
        (error: unknown) => (error as Error).message,
      );
      expect(message, url).toMatch(/webfetch unsupported-scheme:/);
    }
    expect(calls).toHaveLength(0);
  });

  it("normalises the URL it sends and reports the redirect target", async () => {
    const { fetch, calls } = fakeFetch([
      { contentType: "text/plain", body: "arrived", url: "https://example.test/final" },
    ]);
    const result = await executeWebfetch(context(), { url: "https://example.test/a/../page#frag" }, {
      fetch,
    });
    expect(calls[0]?.url).toBe("https://example.test/page");
    expect(result.url).toBe("https://example.test/page");
    expect(result.finalUrl).toBe("https://example.test/final");
  });

  it("falls back to the requested URL when the transport reports no final URL", async () => {
    const { fetch } = fakeFetch([{ contentType: "text/plain", body: "x", url: "" }]);
    const result = await executeWebfetch(context(), { url: URL_OK }, { fetch });
    expect(result.finalUrl).toBe(URL_OK);
  });
});

describe("the registered tool", () => {
  it("is a network tool, not a free-running read", () => {
    // `read` runs without approval (§4.2). A tool that issues HTTP requests to
    // a model-chosen origin on every turn must not be in that class, and
    // `Plan.md` §4 lists it as `network`. Pinned so the class cannot drift
    // quietly into `read`.
    expect(webfetchTool.access).toBe("network");
  });

  it("has a named export and a default that are the same tool", () => {
    expect(webfetchTool).toBe(webfetchTool);
    expect(webfetchTool.id).toBe("webfetch");
  });

  it("the factory produces an independent tool bound to its transport", async () => {
    const tool = createWebfetchTool({ fetch: stallingFetch().fetch, timeoutMs: 5 });
    expect(tool.access).toBe("network");
    await expect(
      tool.execute(context(), { url: URL_OK }),
    ).rejects.toThrow(/webfetch timeout:/);
  });

  it("sends the request without the user's credentials", async () => {
    const { fetch, calls } = corsBlockedFetch();
    await executeWebfetch(context(), { url: URL_OK }, { fetch }).catch(() => undefined);
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });
});

/**
 * Every branch of the "a 200 is not a success" table (Plan.md §5.4).
 *
 * The point of these tests is the *order*: a 200 with an error body has to be
 * caught after the status checks and before the stream checks, or it looks
 * exactly like a success. A test that only asserts one classification per case
 * would pass with the order reversed, so the pairs that are mutually exclusive
 * are asserted together.
 */
import { describe, expect, it } from "vitest";

import {
  classifyResponse,
  classifyThrownError,
  isKnownErrorType,
  isRetryableErrorType,
  normalizeErrorType,
  NON_RETRYABLE_ERROR_TYPES,
  parseRetryAfter,
  RETRYABLE_ERROR_TYPES,
  type Classification,
} from "../../src/stream/classify.ts";

/** A stream that ran to completion. */
const cleanStream = { partCount: 12, sawTerminalEvent: true, sawErrorEvent: false };

describe("step 1 — no response at all", () => {
  it("is no-response, and never retried", () => {
    const result = classifyResponse({ responded: false });
    expect(result).toEqual({ kind: "no-response" });
  });

  it("wins over every other fact, including a status that would say otherwise", () => {
    // The order is load-bearing: a stalled connection that still carries a 500
    // from a previous response must not be retried on the strength of that 500.
    expect(classifyResponse({ responded: false, status: 500 })).toEqual({ kind: "no-response" });
  });
});

describe("step 2 — 429 and 5xx are retryable", () => {
  it("429 without Retry-After is retryable and carries no delay", () => {
    const result = classifyResponse({ responded: true, status: 429 });
    expect(result).toEqual({ kind: "http-error", status: 429, retryable: true });
    expect("retryAfterMs" in result).toBe(false);
  });

  it("429 with Retry-After carries the server's delay", () => {
    const result = classifyResponse({
      responded: true,
      status: 429,
      headers: { "Retry-After": "12" },
    });
    expect(result).toEqual({ kind: "http-error", status: 429, retryable: true, retryAfterMs: 12_000 });
  });

  it("reads the header case-insensitively", () => {
    const result = classifyResponse({
      responded: true,
      status: 429,
      headers: { "retry-after": "3" },
    });
    expect(result).toEqual({ kind: "http-error", status: 429, retryable: true, retryAfterMs: 3_000 });
  });

  it("500 is retryable", () => {
    expect(classifyResponse({ responded: true, status: 500 })).toEqual({
      kind: "http-error",
      status: 500,
      retryable: true,
    });
  });

  it("503 is retryable", () => {
    expect(classifyResponse({ responded: true, status: 503 })).toEqual({
      kind: "http-error",
      status: 503,
      retryable: true,
    });
  });
});

describe("step 3 — a 4xx that repeating cannot change", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    it(`${status} is final`, () => {
      expect(classifyResponse({ responded: true, status })).toEqual({
        kind: "http-error",
        status,
        retryable: false,
      });
    });
  }

  it("401 is final even with a Retry-After header — the key is wrong, not busy", () => {
    expect(
      classifyResponse({ responded: true, status: 401, headers: { "retry-after": "1" } }),
    ).toEqual({ kind: "http-error", status: 401, retryable: false });
  });
});

describe("step 4 — a 200 is a claim, not a fact", () => {
  it("a clean stream is the only success", () => {
    expect(
      classifyResponse({
        responded: true,
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: cleanStream,
      }),
    ).toEqual({ kind: "success" });
  });

  it("a stream that ended without a terminal event is a protocol error", () => {
    // The case Plan.md §5.4 lists as "abgeschnitten": chunks arrived, the
    // connection closed, no `finish`.
    expect(
      classifyResponse({
        responded: true,
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: { partCount: 7, sawTerminalEvent: false, sawErrorEvent: false },
      }),
    ).toEqual({ kind: "protocol-error", reason: "stream ended without a terminal event (7 parts)" });
  });

  it("an error event inside a 200 stream is a protocol error", () => {
    expect(
      classifyResponse({
        responded: true,
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: { partCount: 4, sawTerminalEvent: true, sawErrorEvent: true },
      }),
    ).toEqual({ kind: "protocol-error", reason: "error event inside a 4-part stream" });
  });

  it("an error event beats a terminal event, because the error is the truth", () => {
    // A provider that emits `finish` and then an error part is broken; the
    // error is the part that explains the missing output.
    const result = classifyResponse({
      responded: true,
      status: 200,
      headers: { "content-type": "text/event-stream" },
      stream: { partCount: 9, sawTerminalEvent: true, sawErrorEvent: true },
    });
    expect(result.kind).toBe("protocol-error");
  });

  it("an empty stream is a protocol error, not a success", () => {
    expect(
      classifyResponse({
        responded: true,
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: { partCount: 0, sawTerminalEvent: false, sawErrorEvent: false },
      }),
    ).toEqual({ kind: "protocol-error", reason: "stream ended without a terminal event (0 parts)" });
  });
});

describe("step 4a — 200 with application/json is read and evaluated", () => {
  it("a transient error body is a body-error and IS retried", () => {
    const result = classifyResponse({
      responded: true,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ error: { type: "server_error", message: "upstream exploded" } }),
    });
    expect(result).toEqual({
      kind: "body-error",
      code: "server_error",
      message: "upstream exploded",
      retryable: true,
    });
  });

  it("insufficient_quota is a body-error and is NEVER retried", () => {
    // The money case from §5.4: a retry loop here is literally burning money.
    const result = classifyResponse({
      responded: true,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({
        error: { type: "insufficient_quota", message: "You exceeded your current quota" },
      }),
    });
    expect(result).toEqual({
      kind: "body-error",
      code: "insufficient_quota",
      message: "You exceeded your current quota",
      retryable: false,
    });
  });

  it("an unknown error type is retried — once, which the engine enforces", () => {
    const result = classifyResponse({
      responded: true,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ error: { type: "we_brand_new_error", message: "?" } }),
    });
    expect(result).toEqual({
      kind: "body-error",
      code: "we_brand_new_error",
      message: "?",
      retryable: true,
    });
    // The "only once" half is not expressible in the boolean, so the engine
    // reads the code. Assert both halves here.
    expect(isKnownErrorType("we_brand_new_error")).toBe(false);
    expect(isKnownErrorType("server_error")).toBe(true);
  });

  it("falls back to `code` when there is no `type`", () => {
    const result = classifyResponse({
      responded: true,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } }),
    });
    expect(result).toEqual({ kind: "body-error", code: "invalid_api_key", message: "bad key", retryable: false });
  });

  it("a flat error body without nesting still classifies", () => {
    const result = classifyResponse({
      responded: true,
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({ error: "something broke", code: "overloaded" }),
    });
    expect(result).toEqual({ kind: "body-error", code: "overloaded", message: "something broke", retryable: true });
  });

  it("JSON without an error and without a stream is a protocol error", () => {
    expect(
      classifyResponse({
        responded: true,
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ choices: [{ text: "hi" }] }),
      }),
    ).toEqual({
      kind: "protocol-error",
      reason: "content-type is application/json but the body is neither a stream nor an error",
    });
  });

  it("a body that does not parse is a protocol error, not a success", () => {
    expect(
      classifyResponse({
        responded: true,
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: "<html>gateway</html>",
      }),
    ).toEqual({
      kind: "protocol-error",
      reason: "content-type is application/json but the body does not parse",
    });
  });

  it("an empty 200 with a json content type is a protocol error", () => {
    expect(
      classifyResponse({
        responded: true,
        status: 200,
        headers: { "content-type": "application/json" },
        bodyText: "",
      }),
    ).toEqual({ kind: "protocol-error", reason: "empty body behind a 200" });
  });

  it("a +json structured suffix counts as json", () => {
    const result = classifyResponse({
      responded: true,
      status: 200,
      headers: { "content-type": "application/problem+json; charset=utf-8" },
      bodyText: JSON.stringify({ error: { type: "billing", message: "no credit" } }),
    });
    expect(result).toEqual({ kind: "body-error", code: "billing", message: "no credit", retryable: false });
  });
});

describe("step 5 — a 200 with the wrong content type", () => {
  it("text/html is a protocol error", () => {
    expect(
      classifyResponse({
        responded: true,
        status: 200,
        headers: { "content-type": "text/html" },
        bodyText: "<html>captive portal</html>",
      }),
    ).toEqual({ kind: "protocol-error", reason: "unexpected content-type: text/html" });
  });

  it("text/plain is a protocol error", () => {
    expect(
      classifyResponse({ responded: true, status: 200, headers: { "content-type": "text/plain" }, bodyText: "ok" }),
    ).toEqual({ kind: "protocol-error", reason: "unexpected content-type: text/plain" });
  });

  it("a 200 with no content-type and no stream is a protocol error", () => {
    expect(classifyResponse({ responded: true, status: 200 })).toEqual({
      kind: "protocol-error",
      reason: "200 without a content-type and without a stream",
    });
  });

  it("an announced event stream with no observed stream is a protocol error", () => {
    expect(
      classifyResponse({
        responded: true,
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ).toEqual({
      kind: "protocol-error",
      reason: "event stream announced but no stream was observed",
    });
  });
});

describe("statuses outside 2xx/4xx/5xx", () => {
  it("a 3xx that reached us is a transport defect", () => {
    // `fetch` follows redirects, so a 302 arriving means something intercepted
    // the request — a proxy, not a provider.
    expect(classifyResponse({ responded: true, status: 302 })).toEqual({
      kind: "protocol-error",
      reason: "unexpected status 302 behind a response",
    });
  });
});

describe("the retryable-type table (Plan.md §5.4)", () => {
  it("covers every type the plan names, and nothing else", () => {
    expect([...NON_RETRYABLE_ERROR_TYPES].sort()).toEqual([
      "authentication",
      "billing",
      "credit",
      "insufficient_quota",
      "invalid_api_key",
      "not_found",
      "permission",
    ]);
    expect([...RETRYABLE_ERROR_TYPES].sort()).toEqual([
      "internal",
      "overloaded",
      "rate_limit",
      "server_error",
    ]);
  });

  it("normalises the spellings providers actually send", () => {
    // OpenAI sends `rate_limit_error`, Anthropic sends `overloaded_error`.
    expect(normalizeErrorType("rate_limit_error")).toBe("rate_limit");
    expect(normalizeErrorType("Overloaded-Error")).toBe("overloaded");
    expect(normalizeErrorType("INSUFFICIENT_QUOTA")).toBe("insufficient_quota");
  });

  it("a suffixed known type keeps its verdict", () => {
    expect(isRetryableErrorType("rate_limit_error")).toBe(true);
    expect(isRetryableErrorType("insufficient_quota_error")).toBe(false);
  });

  it("an invented suffix stays unknown rather than becoming retryable", () => {
    expect(normalizeErrorType("server_error_v2")).toBe("server_error_v2");
    expect(isKnownErrorType("server_error_v2")).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30", 0)).toBe(30_000);
  });

  it("reads an HTTP date as an offset from now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:20 GMT", now)).toBe(20_000);
  });

  it("clamps a past date to zero rather than going negative", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined for junk, so the caller falls back to its own table", () => {
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter("", 0)).toBeUndefined();
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
  });
});

describe("classifyThrownError", () => {
  it("reads the status off an APICallError-shaped throwable", () => {
    const error = Object.assign(new Error("rate limited"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "5" },
    });
    expect(classifyThrownError(error)).toEqual({
      kind: "http-error",
      status: 429,
      retryable: true,
      retryAfterMs: 5_000,
    });
  });

  it("finds a 200 error body inside a throwable", () => {
    // The realistic browser shape: the SDK throws an APICallError carrying
    // `statusCode: 200` and the error JSON in `responseBody`.
    const error = Object.assign(new Error("Bad Request"), {
      statusCode: 200,
      responseBody: JSON.stringify({ error: { type: "billing", message: "credit exhausted" } }),
    });
    expect(classifyThrownError(error)).toEqual({
      kind: "body-error",
      code: "billing",
      message: "credit exhausted",
      retryable: false,
    });
  });

  it("an abort is no-response, so a stop is never retried", () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    expect(classifyThrownError(error)).toEqual({ kind: "no-response" });
  });

  it("a missing API key is no-response, not a retryable 4xx", () => {
    // §9: without `apiKey` the SDK throws LoadAPIKeyError. Retrying that
    // three times would produce the identical error three times.
    const error = new Error("No API key found");
    error.name = "LoadAPIKeyError";
    expect(classifyThrownError(error)).toEqual({ kind: "no-response" });
  });

  it("an unrecognisable throwable is a protocol error, not a crash", () => {
    const result = classifyThrownError(new Error("socket hang up"));
    expect(result).toEqual({ kind: "protocol-error", reason: "socket hang up" });
  });
});

describe("classification is total", () => {
  it("every branch returns a known kind", () => {
    const cases: Classification[] = [
      classifyResponse({ responded: false }),
      classifyResponse({ responded: true, status: 500 }),
      classifyResponse({ responded: true, status: 404 }),
      classifyResponse({ responded: true, status: 200, stream: cleanStream }),
      classifyResponse({ responded: true, status: 200, headers: { "content-type": "text/html" } }),
    ];
    for (const result of cases) {
      expect([
        "success",
        "no-response",
        "http-error",
        "body-error",
        "protocol-error",
      ]).toContain(result.kind);
    }
  });
});

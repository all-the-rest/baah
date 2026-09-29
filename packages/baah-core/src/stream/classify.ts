/**
 * Response classification — "a 200 is not a success" (Plan.md §5.4).
 *
 * This module is the reason the harness has its own success logic. The AI SDK
 * resolves a stream and throws when something is obviously wrong, but the whole
 * class of failures listed in Plan.md §5.4 is **invisible to a status check**:
 * the provider answers `200`, and then the body is an error object, or the SSE
 * stream stops without a terminal event, or it never starts at all. A harness
 * that only asks "did it throw?" marks those turns as finished and the
 * transcript is silently incomplete.
 *
 * Therefore: **success = the stream ended cleanly with a terminal event.
 * Everything else is a classified failure.**
 *
 * The function is pure and does no I/O. It takes the *observable facts* of one
 * response and returns what they mean. The engine (agent/loop.ts) owns the
 * observation; this file owns the judgement. That split is what makes the
 * hardest part of the harness unit-testable without a browser.
 *
 * The evaluation order is load-bearing and must not be shuffled: a `200` with an
 * error body has to be caught *after* the status checks and *before* the stream
 * checks, otherwise it looks exactly like a success.
 */

/** The verified meaning of one response attempt. */
export type Classification =
  /** The stream ended cleanly with a terminal event. */
  | { kind: "success" }
  /** Nothing came back inside the stall window. Never retried (Plan.md §5.4). */
  | { kind: "no-response" }
  /** The status line itself says the call failed. */
  | { kind: "http-error"; status: number; retryable: boolean; retryAfterMs?: number }
  /** HTTP 200 plus a JSON body that *is* an error object. */
  | { kind: "body-error"; code: string; message: string; retryable: boolean }
  /** HTTP 200 but the payload is unusable: wrong content type, truncated, … */
  | { kind: "protocol-error"; reason: string };

/**
 * Error types that must **never** be retried (Plan.md §5.4).
 *
 * Money and configuration, not bad luck:
 * - `insufficient_quota`, `billing`, `credit` — the account cannot pay.
 * - `invalid_api_key`, `authentication` — the key is wrong, not broken.
 * - `permission`, `not_found` — the request itself is wrong.
 *
 * Retrying any of them burns requests and hides the real problem.
 */
export const NON_RETRYABLE_ERROR_TYPES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "billing",
  "credit",
  "invalid_api_key",
  "authentication",
  "permission",
  "not_found",
]);

/**
 * Error types that are transient and therefore safe to retry (Plan.md §5.4).
 *
 * A provider that is overloaded or rate limiting will be fine in a moment; the
 * same request again is the correct action.
 */
export const RETRYABLE_ERROR_TYPES: ReadonlySet<string> = new Set([
  "rate_limit",
  "overloaded",
  "server_error",
  "internal",
]);

/**
 * Fold the spelling variants providers actually emit onto the keys of the
 * tables above.
 *
 * OpenAI sends `rate_limit_error`, Anthropic sends `overloaded_error`; the plan
 * lists the bare forms. A provider that invents a new suffix must stay
 * *unknown* rather than silently becoming retryable, so only the `_error`
 * suffix and `-`/`_` spelling are normalised — nothing else is guessed.
 *
 * The suffix is stripped **only when the stripped form is itself a table key**.
 * Otherwise `server_error` — which is a key in its own right, not a decorated
 * `server` — would normalise to `server`, miss both tables, and be treated as
 * an unknown type. That is a real bug this function had, caught by a test
 * asserting `isKnownErrorType("server_error") === true`.
 */
export function normalizeErrorType(raw: string): string {
  const lowered = raw.trim().toLowerCase().replaceAll("-", "_");
  if (!lowered.endsWith("_error")) return lowered;
  const stripped = lowered.slice(0, -"_error".length);
  const isKey = RETRYABLE_ERROR_TYPES.has(stripped) || NON_RETRYABLE_ERROR_TYPES.has(stripped);
  return isKey ? stripped : lowered;
}

/**
 * Is this error type one the plan names?
 *
 * The loop needs this: an unknown type is "retry **once** only", while a known
 * transient type may use the full budget. The {@link Classification} union
 * carries only a boolean, so the distinction is exposed here instead of being
 * smuggled into a fourth state.
 */
export function isKnownErrorType(code: string): boolean {
  const normalized = normalizeErrorType(code);
  return RETRYABLE_ERROR_TYPES.has(normalized) || NON_RETRYABLE_ERROR_TYPES.has(normalized);
}

/**
 * The retry decision for a `200 + error JSON` body, from the table in
 * Plan.md §5.4. Unknown types are retried **once** — the caller enforces that
 * via {@link isKnownErrorType}; this function only answers "worth another
 * request at all?".
 */
export function isRetryableErrorType(code: string): boolean {
  return !NON_RETRYABLE_ERROR_TYPES.has(normalizeErrorType(code));
}

/** What the caller observed on the wire. Nothing here is interpreted. */
export interface StreamObservation {
  /** Parts that actually arrived, including `start`/`finish` markers. */
  partCount: number;
  /**
   * A terminal event arrived: `finish` for the turn, `finish-step` for a step.
   *
   * This is the *only* positive success signal. Missing `data: [DONE]` in the
   * SSE sense and missing `finish` in the SDK sense are the same defect.
   */
  sawTerminalEvent: boolean;
  /** An `error` part arrived inside an otherwise `200` response. */
  sawErrorEvent: boolean;
  /** Payload carried by that error part, when it carried one. */
  errorEvent?: unknown;
}

/** Every observable fact about a single response attempt. */
export interface ResponseFacts {
  /**
   * Did *anything* come back inside the stall window — headers, a body, a
   * stream part? `false` is the 20-second silence of Plan.md §5.4.
   */
  responded: boolean;
  /** HTTP status. `undefined` when a transport surfaced data without headers. */
  status?: number;
  /** Response headers. Key case is irrelevant. */
  headers?: Readonly<Record<string, string>>;
  /**
   * The body, read exactly once, when the response was not a stream. Reading an
   * error body twice is not free, and the plan says "read it once".
   */
  bodyText?: string;
  /** What arrived on the wire, if the response was a stream. */
  stream?: StreamObservation;
  /** The error the SDK threw, if the attempt ended in a throw. */
  error?: unknown;
}

const encoder = new TextEncoder();

function lowerCaseKeys(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

/** `application/json; charset=utf-8` → `application/json`. */
export function normalizeContentType(raw: string | undefined): string {
  if (raw === undefined) return "";
  const [type] = raw.split(";");
  return (type ?? "").trim().toLowerCase();
}

/** `application/json` and every `+json` structured suffix. */
export function isJsonContentType(raw: string | undefined): boolean {
  const type = normalizeContentType(raw);
  return type === "application/json" || type.endsWith("+json");
}

/**
 * Parse a `Retry-After` header into milliseconds (Plan.md §5.4).
 *
 * RFC 9110 allows delta-seconds or an HTTP date; both are accepted because
 * providers use both. An unparsable value yields `undefined` so the caller
 * falls back to its own schedule instead of waiting for a wrong number.
 */
export function parseRetryAfter(raw: string | undefined, nowMs: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - nowMs);
}

const abortLikeNames = new Set([
  "AbortError",
  "TimeoutError",
  "AI_LoadAPIKeyError",
  "LoadAPIKeyError",
]);

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && abortLikeNames.has(error.name);
}

/**
 * The facts a provider error carries, read **structurally**.
 *
 * Deliberately not `instanceof APICallError`: `@ai-sdk/provider` is a
 * transitive dependency of `ai` and is not resolvable from this package, and a
 * duck-typed read also survives a re-bundled copy where the class identity
 * differs from the one the engine was built against.
 */
function readErrorFacts(error: unknown): {
  status?: number;
  headers?: Record<string, string>;
  bodyText?: string;
  name?: string;
  message?: string;
} {
  if (typeof error !== "object" || error === null) {
    return typeof error === "string" ? { message: error } : {};
  }
  const candidate = error as {
    statusCode?: unknown;
    responseHeaders?: unknown;
    responseBody?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const status = typeof candidate.statusCode === "number" ? candidate.statusCode : undefined;
  const headers =
    typeof candidate.responseHeaders === "object" &&
    candidate.responseHeaders !== null &&
    !Array.isArray(candidate.responseHeaders)
      ? lowerCaseKeys(candidate.responseHeaders as Record<string, string>)
      : undefined;
  const bodyText = typeof candidate.responseBody === "string" ? candidate.responseBody : undefined;
  const name = typeof candidate.name === "string" ? candidate.name : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : undefined;

  const result: {
    status?: number;
    headers?: Record<string, string>;
    bodyText?: string;
    name?: string;
    message?: string;
  } = {};
  if (status !== undefined) result.status = status;
  if (headers !== undefined) result.headers = headers;
  if (bodyText !== undefined) result.bodyText = bodyText;
  if (name !== undefined) result.name = name;
  if (message !== undefined) result.message = message;
  return result;
}

/** Pull `{ error: { … } }` out of a parsed body, tolerating the flat variants. */
function readErrorObject(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const nested = record["error"];
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  // `error` may be a bare string with the type/code beside it. The string is the
  // *message*, and the sibling `code` is still the type — merging them keeps
  // `{"error":"overloaded","code":"overloaded"}` from degrading to "unknown"
  // and losing the retry decision that the code carries.
  if (typeof nested === "string") {
    return {
      message: nested,
      ...(typeof record["type"] === "string" ? { type: record["type"] } : {}),
      ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
    };
  }
  // Some providers put the error fields at the top level.
  if (record["message"] !== undefined || record["code"] !== undefined) return record;
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Decide what a `200` actually delivered.
 *
 * Reached only after the status checks passed, so everything here is a
 * *verification* step: the status was a claim, this is the evidence.
 */
function classifySuccessPath(facts: ResponseFacts, headers: Record<string, string>): Classification {
  // A failure the SDK surfaced while the status said 200 is still a failure.
  if (facts.error !== undefined) {
    const fromError = classifyThrownErrorBody(facts.error);
    if (fromError !== undefined) return fromError;
  }

  const contentType = headers["content-type"];
  const mediaType = normalizeContentType(contentType);

  if (mediaType === "text/event-stream" || facts.stream !== undefined) {
    const stream = facts.stream;
    if (stream === undefined) {
      return { kind: "protocol-error", reason: "event stream announced but no stream was observed" };
    }
    if (stream.sawErrorEvent) {
      return {
        kind: "protocol-error",
        reason: `error event inside a ${stream.partCount}-part stream`,
      };
    }
    if (!stream.sawTerminalEvent) {
      return {
        kind: "protocol-error",
        reason: `stream ended without a terminal event (${stream.partCount} parts)`,
      };
    }
    return { kind: "success" };
  }

  if (isJsonContentType(contentType)) {
    const body = facts.bodyText;
    if (body === undefined || body.trim() === "") {
      return { kind: "protocol-error", reason: "empty body behind a 200" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { kind: "protocol-error", reason: "content-type is application/json but the body does not parse" };
    }
    const error = readErrorObject(parsed);
    if (error === undefined) {
      return {
        kind: "protocol-error",
        reason: "content-type is application/json but the body is neither a stream nor an error",
      };
    }
    const code =
      asNonEmptyString(error["type"]) ??
      asNonEmptyString(error["code"]) ??
      asNonEmptyString(error["status"]) ??
      "unknown";
    const message = asNonEmptyString(error["message"]) ?? `provider reported ${code}`;
    return { kind: "body-error", code, message, retryable: isRetryableErrorType(code) };
  }

  if (mediaType === "") {
    return { kind: "protocol-error", reason: "200 without a content-type and without a stream" };
  }
  return { kind: "protocol-error", reason: `unexpected content-type: ${mediaType}` };
}

/**
 * Classify an error object that arrived *with* a 200 (directly, or inside a
 * thrown `APICallError` whose `responseBody` holds it).
 */
function classifyThrownErrorBody(error: unknown): Classification | undefined {
  const errorFacts = readErrorFacts(error);
  const body = errorFacts.bodyText;
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const inner = readErrorObject(parsed);
  if (inner === undefined) return undefined;
  const code =
    asNonEmptyString(inner["type"]) ??
    asNonEmptyString(inner["code"]) ??
    asNonEmptyString(inner["status"]) ??
    "unknown";
  const message = asNonEmptyString(inner["message"]) ?? `provider reported ${code}`;
  return { kind: "body-error", code, message, retryable: isRetryableErrorType(code) };
}

/**
 * Turn the observable facts of one response attempt into a classification.
 *
 * The order of the checks is the spec (Plan.md §5.4):
 *
 * 1. nothing came back → `no-response` (never retried),
 * 2. `429` / `5xx` → `http-error`, retryable,
 * 3. every other `4xx` → `http-error`, final,
 * 4. `2xx` → **verify**, do not believe,
 * 5. inside (4): an error body → `body-error`; a stream without a terminal
 *    event, a truncated stream, an error event, or a content type that fits
 *    neither → `protocol-error`,
 * 6. otherwise → `success`.
 */
export function classifyResponse(
  facts: ResponseFacts,
  nowMs: number = 0,
): Classification {
  // 1. Silence. The provider may still be generating, so this is never a retry.
  if (!facts.responded) return { kind: "no-response" };

  const errorFacts = readErrorFacts(facts.error);
  const status = facts.status ?? errorFacts.status;
  const headers = lowerCaseKeys({ ...(facts.headers ?? {}), ...(errorFacts.headers ?? {}) });
  const bodyText = facts.bodyText ?? errorFacts.bodyText;

  // A local abort is not a provider failure and must not be retried; the caller
  // sees the abort through the signal, but the classification has to say so too.
  if (isAbortLike(facts.error) && status === undefined) {
    const abortName =
      errorFacts.message ??
      errorFacts.name ??
      (typeof facts.error === "object" &&
      facts.error !== null &&
      typeof (facts.error as { name?: unknown }).name === "string"
        ? (facts.error as { name: string }).name
        : "unknown");
    return { kind: "protocol-error", reason: `request aborted: ${abortName}` };
  }

  if (status !== undefined) {
    // 2. Rate limit first: it is the only branch that may carry Retry-After.
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(headers["retry-after"], nowMs);
      return retryAfterMs === undefined
        ? { kind: "http-error", status, retryable: true }
        : { kind: "http-error", status, retryable: true, retryAfterMs };
    }
    if (status >= 500 && status <= 599) {
      return { kind: "http-error", status, retryable: true };
    }
    // 3. 4xx that repeating cannot change (400/401/403/404/422 and friends).
    if (status >= 400 && status <= 499) {
      return { kind: "http-error", status, retryable: false };
    }
    // 2xx only from here on. A 1xx or a 3xx is a transport-level defect:
    // `fetch` follows redirects, so a 302 reaching us means something
    // intercepted the request — a proxy, not a provider.
    if (status < 200 || status > 299) {
      return { kind: "protocol-error", reason: `unexpected status ${status} behind a response` };
    }
  }

  // 4. A 2xx (or a status-less success) is a claim. Verify it.
  return classifySuccessPath({ ...facts, ...(bodyText === undefined ? {} : { bodyText }) }, headers);
}

/**
 * Convenience wrapper: classify a thrown provider error.
 *
 * Used by the engine when the SDK rejects instead of yielding an `error` part.
 * A local abort is reported as `no-response` so the caller never retries it —
 * the user pressed stop, and a retry would be the wrong reaction to a
 * deliberate action.
 */
export function classifyThrownError(error: unknown, nowMs: number = 0): Classification {
  if (isAbortLike(error)) return { kind: "no-response" };
  const errorFacts = readErrorFacts(error);
  const status = errorFacts.status;
  const headers = lowerCaseKeys(errorFacts.headers ?? {});

  if (status !== undefined) {
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(headers["retry-after"], nowMs);
      return retryAfterMs === undefined
        ? { kind: "http-error", status, retryable: true }
        : { kind: "http-error", status, retryable: true, retryAfterMs };
    }
    if (status >= 500 && status <= 599) {
      return { kind: "http-error", status, retryable: true };
    }
    if (status >= 400 && status <= 499) {
      return { kind: "http-error", status, retryable: false };
    }
    if (status < 200 || status > 299) {
      return { kind: "protocol-error", reason: `unexpected status ${status}` };
    }
  }

  const bodyError = classifyThrownErrorBody(error);
  if (bodyError !== undefined) return bodyError;

  return {
    kind: "protocol-error",
    reason: errorFacts.message ?? "provider call failed without a usable response",
  };
}

/** UTF-8 byte length of a string, without `Buffer` (AGENTS.md §2). */
export function byteLengthOf(value: string): number {
  return encoder.encode(value).length;
}

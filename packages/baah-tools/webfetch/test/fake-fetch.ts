/**
 * A fake transport for `webfetch`.
 *
 * `AGENTS.md` §2 means this tool can only ever be exercised against an injected
 * transport: the real `fetch` is the browser's, and none of the outcomes under
 * test here — a bare `TypeError`, a stalled body, a transfer that crosses the
 * cap — can be produced on demand from a real network. Every test in this
 * package drives this file, and `test/verify-seam.test.ts` pins that the
 * platform `fetch` fits the same interface.
 */
import type { WebfetchFetch, WebfetchResponse } from "../src/index.ts";

const encoder = new TextEncoder();

export interface FakeResponseInit {
  status?: number;
  statusText?: string;
  /** `null` sends no `Content-Type` header at all. */
  contentType?: string | null;
  /** The body. `null` makes the response body-less, like a 204. */
  body?: string | null;
  /** Split the body into chunks of this many bytes, to exercise the reader. */
  chunkSize?: number;
  /**
   * Stop answering after this many chunks: the next `read()` never resolves
   * until the request's signal aborts, which is what the platform does.
   */
  stallAfterChunks?: number;
  url?: string;
  /** Overrides the `Content-Length` header, including lying about it. */
  contentLength?: string | null;
  /** The request signal. Only needed by `stallAfterChunks`. */
  signal?: AbortSignal;
}

export interface FakeResponse {
  response: WebfetchResponse;
  /** `true` once the tool called `reader.cancel()`. */
  cancelled: () => boolean;
  /** The reason passed to `cancel()`, if any. */
  cancelReason: () => unknown;
}

export function fakeResponse(init: FakeResponseInit = {}): FakeResponse {
  const status = init.status ?? 200;
  const statusText = init.statusText ?? (status === 200 ? "OK" : "");
  const bodyText = init.body ?? "";
  const declaredLength = init.contentLength;
  const bytes = encoder.encode(bodyText);
  const headers = new Map<string, string>();
  if (init.contentType !== null) {
    headers.set("content-type", init.contentType ?? "text/plain; charset=utf-8");
  }
  if (declaredLength !== undefined && declaredLength !== null) {
    headers.set("content-length", declaredLength);
  } else if (init.contentLength === undefined && init.body !== null) {
    headers.set("content-length", String(bytes.length));
  }

  let cancelled = false;
  let cancelReason: unknown;
  let cursor = 0;
  const chunkSize = init.chunkSize ?? (bytes.length === 0 ? 1 : bytes.length);
  const stallAfter = init.stallAfterChunks;
  const signal = init.signal;

  const body = {
    getReader() {
      return {
        read(): Promise<{ done: boolean; value?: Uint8Array }> {
          if (cursor >= bytes.length) return Promise.resolve({ done: true });
          if (stallAfter !== undefined && cursor / chunkSize >= stallAfter) {
            return new Promise((_resolve, reject) => {
              const abort = (): void => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              };
              if (signal === undefined) {
                reject(new Error("fake-fetch: stall requested without a signal"));
                return;
              }
              if (signal.aborted) {
                abort();
                return;
              }
              signal.addEventListener("abort", abort, { once: true });
            });
          }
          const end = Math.min(cursor + chunkSize, bytes.length);
          const chunk = bytes.slice(cursor, end);
          cursor = end;
          return Promise.resolve({ done: false, value: chunk });
        },
        cancel(reason?: unknown): Promise<void> {
          cancelled = true;
          cancelReason = reason;
          return Promise.resolve();
        },
      };
    },
  };

  const response: WebfetchResponse = {
    status,
    statusText,
    url: init.url ?? "",
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body: init.body === null ? null : body,
    text: () => Promise.resolve(bodyText),
  };
  return { response, cancelled: () => cancelled, cancelReason: () => cancelReason };
}

export interface FakeCall {
  url: string;
  init: { signal: AbortSignal; credentials: "same-origin" };
}

export interface FakeFetch {
  fetch: WebfetchFetch;
  calls: FakeCall[];
}

/** A transport that answers with `responses` in order, repeating the last. */
export function fakeFetch(responses: readonly FakeResponseInit[]): FakeFetch {
  const calls: FakeCall[] = [];
  let index = 0;
  const fetch: WebfetchFetch = async (url, init) => {
    calls.push({ url, init });
    const chosen = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (chosen === undefined) throw new Error("fake-fetch: no response configured");
    return fakeResponse({ ...chosen, signal: init.signal }).response;
  };
  return { fetch, calls };
}

/** A transport that never answers, and rejects only when the signal aborts. */
export function stallingFetch(): { fetch: WebfetchFetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetch: WebfetchFetch = (url, init) => {
    calls.push({ url, init });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true },
      );
    });
  };
  return { fetch, calls };
}

/** A transport that fails the way a browser fails a CORS-blocked request. */
export function corsBlockedFetch(): { fetch: WebfetchFetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetch: WebfetchFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.reject(new TypeError("Failed to fetch"));
  };
  return { fetch, calls };
}

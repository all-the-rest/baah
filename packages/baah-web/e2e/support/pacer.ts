/**
 * The in-page stream pacer.
 *
 * `page.route()` can hand the page a complete response, but `route.fulfill()`
 * has no streaming option, so a Playwright-fulfilled SSE body always arrives in
 * one write. That is fine for "does the app parse my bytes?" and useless for
 * "is the app still alive when the stream stalls?", which Plan.md §5.4 needs in
 * order to tell "no answer" apart from "an answer came, and was unusable".
 *
 * So the route fulfils the real bytes, and this pacer — injected by Playwright
 * as an init script, never part of the app bundle — re-delivers them through a
 * `ReadableStream` one SSE event at a time, with two controls a test can drive:
 *
 * - a per-event delay, and
 * - a hard gate. `release(n)` delivers exactly `n` more events and then blocks,
 *     no matter how many are left. That is a *signal*, not a sleep: the test
 *     asserts what has and has not arrived, and only then decides when the rest
 *     comes.
 *
 * Only responses carrying `x-baa-e2e-stream: 1` are re-streamed; everything
 * else (the app's own assets) passes through the native `fetch` untouched.
 */
import type { Page } from "@playwright/test";

/** How a test controls the pacer from inside the page. */
export type PacerCommand =
  | { readonly op: "release"; readonly count: number }
  | { readonly op: "releaseAll" }
  | { readonly op: "delay"; readonly ms: number }
  | { readonly op: "errorAt"; readonly count: number }
  | { readonly op: "state" };

/** What the pacer reports about the stream it is currently delivering. */
export type PacerState = {
  readonly target: string;
  /** Events already written into the stream. */
  readonly emitted: number;
  /** Events still to come, counting any the gate is holding back. */
  readonly remaining: number;
  readonly gated: boolean;
  readonly closed: boolean;
  readonly errored: boolean;
  /** How many responses the pacer has re-streamed. */
  readonly streams: number;
};

/**
 * Installed through `page.addInitScript({ content })`. It has to be
 * self-contained: it is stringified and evaluated in the page, so it must not
 * close over anything from this module. Being ordinary TypeScript, it is still
 * typechecked here — the annotations are erased, not skipped.
 */
function installBaaE2EPacer(marker: string): void {
  type StreamRecord = {
    target: string;
    emitted: number;
    remaining: number;
    gated: boolean;
    closed: boolean;
    errored: boolean;
  };

  const records: StreamRecord[] = [];
  let delayMs = 0;
  let errorAt: number | null = null;
  let budget: number | null = null;
  let streams = 0;
  const waiters: Array<() => void> = [];

  const notify = (): void => {
    while (waiters.length > 0) {
      const next = waiters.shift();
      if (next !== undefined) next();
    }
  };

  const last = (): StreamRecord | undefined =>
    records.length > 0 ? records[records.length - 1] : undefined;

  const state = (): unknown => {
    const record = last();
    return {
      target: record === undefined ? "" : record.target,
      emitted: record === undefined ? 0 : record.emitted,
      remaining: record === undefined ? 0 : record.remaining,
      gated: record === undefined ? false : record.gated,
      closed: record === undefined ? false : record.closed,
      errored: record === undefined ? false : record.errored,
      streams,
    };
  };

  const command = (raw: unknown): unknown => {
    const input = raw as PacerCommand | null;
    if (input === null || typeof input !== "object") return state();
    if (input.op === "release") {
      errorAt = null;
      // A budget, not a remainder: comparing it against the number of events
      // already written makes the command order-independent, so a test can arm
      // the gate before the request it is about to make.
      budget = (last()?.emitted ?? 0) + input.count;
      notify();
    } else if (input.op === "releaseAll") {
      errorAt = null;
      budget = null;
      notify();
    } else if (input.op === "delay") {
      delayMs = input.ms;
    } else if (input.op === "errorAt") {
      errorAt = input.count;
    }
    return state();
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const realFetch = window.fetch.bind(window);

  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await realFetch(input, init);
    if (response.headers.get(marker) !== "1") return response;
    if (response.body === null) return response;

    const text = await response.text();
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // One write per SSE event, so the stream the app sees has the same shape a
    // real provider's would. An unterminated tail becomes its own final write:
    // that is what a stream cut off mid-event looks like on the wire.
    const parts = text.split(/(?<=\n\n)/);

    const record: StreamRecord = {
      target,
      emitted: 0,
      remaining: parts.length,
      gated: false,
      closed: false,
      errored: false,
    };
    records.push(record);
    streams += 1;

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set(marker, "0");

    const signal =
      init !== undefined && init.signal != null ? init.signal : undefined;

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const part of parts) {
          while (budget !== null && record.emitted >= budget) {
            record.gated = true;
            await new Promise<void>((resolve) => {
              waiters.push(resolve);
            });
          }
          record.gated = false;
          if (signal !== undefined && signal.aborted) {
            record.closed = true;
            controller.close();
            return;
          }
          if (errorAt !== null && record.emitted === errorAt) {
            record.errored = true;
            record.remaining = 0;
            record.closed = true;
            controller.error(new Error("baah-e2e: stream cut mid-flight"));
            return;
          }
          controller.enqueue(encoder.encode(part));
          record.emitted += 1;
          record.remaining -= 1;
          if (delayMs > 0) await sleep(delayMs);
        }
        record.closed = true;
        controller.close();
      },
      cancel() {
        record.closed = true;
        record.remaining = 0;
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  Object.defineProperty(window, "__baahE2EPacer", {
    value: { command, state },
    configurable: true,
  });
}

/**
 * The init script. `Function.prototype.toString()` is the transport: the caller
 * stringifies `installBaaE2EPacer`, which is why it has to stay one
 * self-contained function.
 */
export function pacerInitScript(marker: string): string {
  return `(${installBaaE2EPacer.toString()})(${JSON.stringify(marker)});`;
}

/** Send a command to the pacer and return the state it reports back. */
export async function pacerCommand(
  page: Page,
  command: PacerCommand,
): Promise<PacerState> {
  return (await page.evaluate(
    (raw: unknown) => {
      const pacer = (window as unknown as Record<string, unknown>)[
        "__baahE2EPacer"
      ] as { command: (raw: unknown) => unknown } | undefined;
      if (pacer === undefined) {
        throw new Error("the e2e stream pacer is not installed on this page");
      }
      return pacer.command(raw);
    },
    command as unknown,
  )) as PacerState;
}

/** Read the pacer state without changing anything. */
export async function pacerState(page: Page): Promise<PacerState> {
  return pacerCommand(page, { op: "state" });
}

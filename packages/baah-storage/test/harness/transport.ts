/**
 * The transport doubles.
 *
 * `client.ts` and `worker.ts` talk to each other over `postMessage`. A real
 * `Worker` needs a browser, so this file provides the two ends of that channel
 * in one process: a fake `WorkerLike` whose `postMessage` hands the payload to a
 * real {@link StorageWorker}, and a scope that carries the response back —
 * asynchronously, as a real worker does.
 *
 * The point is that the *worker logic* under test is the shipped logic, not a
 * re-implementation: the ownership guard, the zod check and the nested-batch
 * refusal in `worker.ts` are what runs here.
 */

import type { WorkerLike, WorkerStorageDatabase } from "../../src/client.ts";
import { WorkerStorageDatabase as Client } from "../../src/client.ts";
import type { RpcResponse } from "../../src/protocol.ts";
import { createStorageWorker } from "../../src/worker.ts";
import { handleWorkerMessage, type StorageWorker, type StorageWorkerOptions } from "../../src/worker.ts";

/** Everything the worker posted, in order. */
export interface RecordedScope {
  readonly outbox: RpcResponse[];
  /** The last response, for the common "one message, one answer" assertion. */
  last(): RpcResponse;
  /** Everything the worker has answered so far, drained. */
  drain(): RpcResponse[];
}

/**
 * The response log of a worker instance.
 *
 * The loopback below builds its own scope, because the client has to be woken
 * *asynchronously*: a real `postMessage` never re-enters the sender
 * synchronously, and a harness that answered inline would hide a whole class of
 * ordering bug.
 */
export function createRecordingScope(): RecordedScope {
  const outbox: RpcResponse[] = [];
  return {
    outbox,
    last: () => {
      const response = outbox.at(-1);
      if (response === undefined) throw new Error("The worker has not answered yet.");
      return response;
    },
    drain: () => outbox.splice(0, outbox.length),
  };
}

/** A worker instance wired to a recording scope, with the SQLite seams filled. */
export interface WorkerHarness {
  worker: StorageWorker;
  recorded: RecordedScope;
  /** Sends one raw message, the way a `message` event would. */
  send(data: unknown): Promise<void>;
  /**
   * Sends a request and returns its correlated response.
   *
   * Takes `unknown` on purpose: a test has to be able to send the *malformed*
   * messages this file exists to check, and the parsed `RpcRequest` type is not
   * the right contract for them.
   */
  request(request: unknown): Promise<RpcResponse>;
  /** The error payload of the last failure response, or `null`. */
  lastError(): { code: string; message: string } | null;
}

export function createWorkerHarness(options: StorageWorkerOptions): WorkerHarness {
  const recorded = createRecordingScope();
  const worker = createStorageWorker({
    ...options,
    scope: { postMessage: (data) => recorded.outbox.push(data as RpcResponse), addEventListener: () => {} },
  });
  return {
    worker,
    recorded,
    send: async (data) => {
      await worker.handleMessage(data);
    },
    request: async (request) => {
      recorded.drain();
      await worker.handleMessage(request);
      const response = recorded.last();
      const sentId = idOf(request);
      if (sentId !== null && response.id !== sentId) {
        throw new Error(
          `The worker answered id ${response.id} for a request with id ${sentId}.`,
        );
      }
      return response;
    },
    lastError: () => {
      const response = recorded.last();
      if (response.ok) return null;
      const error: unknown = response.error;
      if (typeof error !== "object" || error === null) return null;
      const { code, message } = error as { code: string; message: string };
      return { code, message };
    },
  };
}

/** The correlation id of a request, if it has a usable one. */
function idOf(request: unknown): string | null {
  if (typeof request !== "object" || request === null) return null;
  const id: unknown = (request as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

export interface FakeWorkerOptions {
  /** Answers the message. Defaults to none (the worker stays silent). */
  onMessage?: (data: unknown) => void;
  /** Delivers a message to the client. Defaults to a microtask hop. */
  deliver?: (data: unknown) => void;
}

/**
 * A `WorkerLike` that is not a worker.
 *
 * `openDatabase()` takes a `workerFactory`, and `WorkerStorageDatabase` takes a
 * `WorkerLike`, so a test can hand the client one of these and drive the whole
 * client → worker path — including the response validation in `#receive` —
 * without a browser.
 */
export class FakeWorker implements WorkerLike {
  /** Everything the client posted, in order. */
  readonly sent: unknown[] = [];
  terminated = false;

  readonly #listeners = new Map<string, ((event: never) => void)[]>();
  readonly #options: FakeWorkerOptions;

  constructor(options: FakeWorkerOptions = {}) {
    this.#options = options;
  }

  postMessage(data: unknown): void {
    if (this.terminated) return;
    this.sent.push(data);
    const handler = this.#options.onMessage;
    if (handler === undefined) return;
    const deliver = this.#options.deliver ?? ((value: unknown) => queueMicrotask(() => handler(value)));
    deliver(data);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const existing = this.#listeners.get(type) ?? [];
    existing.push(listener);
    this.#listeners.set(type, existing);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Pushes a message at the client, as the worker would. */
  emit(data: unknown): void {
    for (const listener of this.#listeners.get("message") ?? []) {
      (listener as (event: { data: unknown }) => void)({ data });
    }
  }

  /** Pushes a message at the client on the next microtask. */
  emitLater(data: unknown): void {
    queueMicrotask(() => this.emit(data));
  }

  /** Fires the `error` event, as a crashed worker would. */
  emitError(message: string): void {
    for (const listener of this.#listeners.get("error") ?? []) {
      (listener as (event: { message: string }) => void)({ message });
    }
  }

  /** Fires `messageerror`, as an unserialisable answer would. */
  emitMessageError(): void {
    for (const listener of this.#listeners.get("messageerror") ?? []) {
      (listener as (event: unknown) => void)(undefined);
    }
  }

  /** The last message the client posted. */
  lastSent(): unknown {
    return this.sent.at(-1);
  }
}

export interface Loopback extends WorkerHarness {
  /** The client, wired to this worker. Its `open()` installs and migrates. */
  readonly client: WorkerStorageDatabase;
  /** The transport the client posts to. */
  readonly transport: FakeWorker;
  /** A `workerFactory` for `openDatabase()`, bound to this loopback. */
  /**
   * `url` may be `undefined`: `openDatabase()` only has one when the caller passed
   * a `workerUrl`. The implementation below has always ignored the argument, so this
   * widening describes what was always true rather than changing it.
   */
  readonly workerFactory: (url: string | URL | undefined) => WorkerLike;
}

/**
 * Client and worker in one process, connected by the real dispatch path.
 *
 * `client.open()` is what installs the VFS, applies the pragmas and migrates,
 * so a test that calls it exercises the whole open path.
 */
export function createLoopback(options: StorageWorkerOptions): Loopback {
  const recorded = createRecordingScope();
  // Wired after both halves exist; until then nothing can be delivered.
  let deliverToClient: (data: unknown) => void = () => {
    throw new Error("The loopback is not wired up yet.");
  };
  const worker = createStorageWorker({
    ...options,
    scope: {
      postMessage: (data) => {
        recorded.outbox.push(data as RpcResponse);
        deliverToClient(data);
      },
      addEventListener: () => {},
    },
  });
  const transport = new FakeWorker({
    onMessage: (data) => {
      // The same entry point the module's own `addEventListener` uses, so the
      // loopback exercises the shipped fire-and-forget *and* its failure path
      // rather than a private copy of the happy half. It is not awaited here
      // either — a real `postMessage` never re-enters the sender synchronously,
      // which is the whole reason this harness answers later.
      handleWorkerMessage(worker, data);
    },
  });
  deliverToClient = (data) => {
    transport.emitLater(data);
  };
  const client = new Client(transport, "/baah.sqlite3");

  return {
    client,
    transport,
    worker,
    recorded,
    workerFactory: () => transport,
    send: async (data) => {
      await worker.handleMessage(data);
    },
    request: async (request) => {
      recorded.drain();
      await worker.handleMessage(request);
      const response = recorded.last();
      const sentId = idOf(request);
      if (sentId !== null && response.id !== sentId) {
        throw new Error(
          `The worker answered id ${response.id} for a request with id ${sentId}.`,
        );
      }
      return response;
    },
    lastError: () => {
      const response = recorded.last();
      if (response.ok) return null;
      const error: unknown = response.error;
      if (typeof error !== "object" || error === null) return null;
      const { code, message } = error as { code: string; message: string };
      return { code, message };
    },
  };
}

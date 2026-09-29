/**
 * The one error type the runtime rejects with, in its own module for one reason:
 * `guard.ts` needs it, and a cycle back into the composition root would make both
 * files depend on each other's evaluation order.
 *
 * It is a `code` and a `message` and never a `cause` — see the note in `events.ts`
 * about why a provider error must not enter this layer's vocabulary, and
 * {@link module:runtime/index} for why an arbitrary `Error.message` is never
 * forwarded either.
 */

import type { RuntimeErrorCode } from "./events.ts";

export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

/**
 * The tripwire on the awaited `ProviderRegistry.resolve`.
 *
 * ## Why this is its own module
 *
 * Not for size — it is fifteen lines. It is its own module because
 * {@link assertResolvedLanguageModel} is called from `index.ts` and is only
 * *reachable* if the `await` above it is removed (see below), which means "does
 * `resolveModel` call it?" has no behavioural answer. A test can only observe a call
 * that goes through an import, so the call is put behind one and
 * `error.origin-unknown.test.ts` spies on this module to count it. Inlining the
 * check back into `index.ts` would make the tripwire un-testable again, which is the
 * one thing it must not be.
 *
 * ## Why the check cannot fail while the `await` is there
 *
 * The `await` operator flattens thenables, recursively: awaiting a promise that
 * resolves to a thenable resolves to *that* thenable's outcome. So the value
 * `resolveModel` holds after a correct `await` can never be a promise, and this
 * function can never throw. That is not a reason to delete it — it is the whole
 * reason it exists:
 *
 * - Delete the `await` and this check is what turns "the loop died three layers
 *   down inside the SDK" into "ProviderRegistry.resolve was not awaited", naming
 *   the line and the cause.
 * - Its cost is two lines, and it costs nothing when it does not fire.
 *
 * The `AgentTurn` option is the last place a promise could still slip through
 * (anything that hands it a `LanguageModel` without awaiting), and that path is
 * core's; the guard here is the app-side half of the same check.
 */

import type { LanguageModel } from "ai";

/** The error a forgotten `await` is reported as. Its own module, to avoid a cycle. */
import { RuntimeError } from "./error.ts";

/**
 * Reject a value that is still a `Promise`.
 *
 * The failure this prevents is invisible until it is very far away: without the
 * `await`, `model` is a promise, `ToolLoopAgent` takes it, and the turn dies with
 * a provider error that names neither the cause nor the line. Two lines of guard
 * turn that into a message at the call site.
 */
export function assertResolvedLanguageModel(value: LanguageModel, vendor: string): LanguageModel {
  if (isThenable(value)) {
    throw new RuntimeError(
      "provider-unresolved",
      `ProviderRegistry.resolve("${vendor}") was not awaited: the value is a Promise, not a LanguageModel.`,
    );
  }
  return value;
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * The smallest observable that `useSyncExternalStore` can drive.
 *
 * ## Why it exists and why it is this small
 *
 * The composition root has to be consumable by a React tree without being a
 * React module — the UI block owns the components, and the runtime has to stay
 * testable in vitest with no DOM (AGENTS.md §6: a feature without a test is not
 * finished, and a test that needs a DOM would not run in the unit job). So the
 * runtime keeps plain immutable snapshots and hands out a subscription; React's
 * `useSyncExternalStore(subscribe, getSnapshot)` is the adapter, and it belongs
 * to the UI block.
 *
 * ## The one behaviour worth knowing
 *
 * `set` is a no-op when the value is `Object.is`-equal to the current one, and
 * listeners are notified **after** the value has been stored. A subscriber can
 * therefore always read the new value and can never be notified for a write
 * that changed nothing — which is what stops a chat transcript from
 * re-rendering on every no-op write.
 *
 * A listener that throws is **not** isolated: the exception propagates out of
 * `set`. That is deliberate (AGENTS.md §5 forbids silent swallowing), but it
 * means a subscriber can stop later subscribers from being called in the same
 * `set`. Subscribers here are React state setters and test assertions; neither
 * throws.
 */

export interface Observable<T> {
  /** The current value. Cheap and side-effect free — `getSnapshot` needs both. */
  get(): T;
  /** Replace the value. A no-op when `Object.is` says nothing changed. */
  set(next: T): void;
  /**
   * Subscribe to changes.
   *
   * @returns the unsubscribe function. Calling it twice is harmless.
   */
  subscribe(listener: () => void): () => void;
  /** How many listeners are attached. Diagnostics and tests only. */
  readonly size: number;
}

export function createObservable<T>(initial: T): Observable<T> {
  let current = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => current,

    set(next: T): void {
      if (Object.is(next, current)) return;
      current = next;
      // A copy, so a listener that unsubscribes itself (React's
      // `useSyncExternalStore` does, on unmount) cannot mutate the set we are
      // iterating.
      for (const listener of [...listeners]) listener();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get size(): number {
      return listeners.size;
    },
  };
}

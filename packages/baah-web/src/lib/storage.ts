/**
 * Browser storage for the settings, behind an injected backend.
 *
 * ## Why settings are *not* in SQLite
 *
 * `Plan.md` §6.1 has a `settings(key, value, updated_at)` table, so the obvious
 * home for them is the database. They are not, and the reason is a rule rather
 * than taste:
 *
 * - The runtime **injects** its `TurnStore` (AGENTS.md §4 layer rule: `baah-web`
 *   → `baah-storage` → `baah-core`, never back). Importing storage here to read
 *   settings would create a *second* path to the database next to the injected
 *   one — the exact thing `Plan.md` §16.1 refused for the `TurnStore` adapter,
 *   where two paths into one store are how the two classifiers drifted apart.
 * - An API key in `localStorage` and an API key in a SQLite file inside the same
 *   origin are the same exposure anyway. There is no second boundary to win.
 *
 * So the settings live in the browser's own key/value storage, behind a two-method
 * backend that a test replaces with a `Map`.
 */

export interface KeyValueBackend {
  /** `undefined` when nothing is stored — never `null`, never a parsed value. */
  read(): string | undefined;
  /** Overwrites whatever was there. Throws `SettingsStorageError` on failure. */
  write(raw: string): void;
  clear(): void;
  /** Human-readable origin, for a settings screen ("localStorage", "memory"). */
  readonly description: string;
}

export type SettingsStorageErrorCode = "unavailable" | "write-failed" | "read-failed" | "corrupt";

export class SettingsStorageError extends Error {
  constructor(
    readonly code: SettingsStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SettingsStorageError";
  }
}

/** A `Map`-backed backend. Tests, and the SSR-free fallback for private modes. */
export function createMemoryBackend(seed?: Readonly<Record<string, string>>): KeyValueBackend {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    read: () => map.get("settings"),
    write: (raw) => {
      map.set("settings", raw);
    },
    clear: () => {
      map.delete("settings");
    },
    description: "in-memory",
  };
}

/** The subset of the `Storage` interface this module needs. */
interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `localStorage`, and the honest reason it is wrapped rather than used directly.
 *
 * Both `getItem` and `setItem` throw in real situations — Safari's private mode
 * used to throw on write, and a blocked third-party context throws on read — and
 * a quota error arrives as a `DOMException` whose message says nothing useful.
 * All three are converted into a typed `SettingsStorageError` so the UI can say
 * "the browser refused to store the settings" instead of dying inside a getter
 * (AGENTS.md §5: no silent failures).
 *
 * `globalThis.localStorage` is read **per call**, not captured at module load:
 * a test that stubs it after importing this module must still hit the stub.
 */
export function createWebStorageBackend(options?: { readonly key?: string }): KeyValueBackend {
  const key = options?.key ?? "baah.settings.v1";

  const storage = (): WebStorageLike => {
    const candidate = (globalThis as { localStorage?: WebStorageLike }).localStorage;
    if (candidate === undefined) {
      throw new SettingsStorageError(
        "unavailable",
        "This browser exposes no localStorage, so the settings cannot be persisted. " +
          "Everything still works; the settings will be lost on reload.",
      );
    }
    return candidate;
  };

  return {
    read(): string | undefined {
      try {
        return storage().getItem(key) ?? undefined;
      } catch (error) {
        // The "there is no localStorage at all" case is re-thrown unchanged: a UI
        // that says "this browser cannot store anything" is right, and a UI that
        // says "reading failed, treat as unset" would invite the user to try again
        // against a browser that will never work.
        if (error instanceof SettingsStorageError && error.code === "unavailable") throw error;
        throw new SettingsStorageError(
          "read-failed",
          `Reading the settings from ${key} failed: ${describeCause(error)}. ` +
            "They will be treated as unset, and the first write will report why.",
        );
      }
    },

    write(raw: string): void {
      try {
        storage().setItem(key, raw);
      } catch (error) {
        // The value itself is never named. A quota message that quoted the
        // payload would put the API key into a `DOMException`, which lands in
        // an error boundary and therefore in a log.
        throw new SettingsStorageError(
          "write-failed",
          `Writing the settings to ${key} failed: ${describeCause(error)}. ` +
            "The change was not saved.",
        );
      }
    },

    clear(): void {
      try {
        storage().removeItem(key);
      } catch (error) {
        throw new SettingsStorageError(
          "write-failed",
          `Clearing the settings in ${key} failed: ${describeCause(error)}.`,
        );
      }
    },

    description: "localStorage",
  };
}

/**
 * A cause, by name only.
 *
 * `DOMException` names are stable and carry nothing; `error.message` from a
 * browser storage failure can quote the value that was written. So the class name
 * is used and the message is dropped — which makes the diagnostic slightly worse
 * and the secret safe, and that is the trade §8.2 is about.
 */
function describeCause(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "unknown error";
}

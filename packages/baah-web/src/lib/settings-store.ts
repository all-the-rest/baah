/**
 * The settings store: one snapshot, persisted on every change, observable.
 *
 * ## What it deliberately is not
 *
 * Not a database table, not a `process.env` read, not a cache with a TTL. It is
 * the whole settings state of the app, held as one zod-validated snapshot and
 * written back through the injected {@link KeyValueBackend}.
 *
 * ## Failures are loud, and the order of operations is the reason
 *
 * A write that the browser refuses (quota, private mode, blocked storage) throws
 * `SettingsStorageError` and **does not** update the in-memory snapshot. The
 * opposite order — publish, then write — is how a settings screen comes to claim a
 * provider key is stored when it is not, and the user finds out on the next
 * reload, from the provider.
 *
 * A stored blob that no longer parses throws `SettingsStorageError("corrupt")`
 * from the constructor rather than being replaced by defaults. Silently resetting
 * someone's configuration — including their permission rules — to "first run" is
 * the worst available answer; the UI can offer a deliberate reset instead.
 */

import { createObservable, type Observable } from "./observable.ts";
import { SettingsStorageError, type KeyValueBackend } from "./storage.ts";
import {
  buildSettingsExport,
  defaultSettings,
  diffSettings,
  parseSettingsImport,
  serialiseSettingsExport,
  settingsSchema,
  summariseSettings,
  type PermissionRuleSetting,
  type ProviderSelection,
  type SettingsDiff,
  type SettingsExportFile,
  type SettingsExportOptions,
  type SettingsSnapshot,
  type SettingsSummary,
} from "./settings.ts";

/** The part of a snapshot a caller may change. `version` and `apiKeys` are not here. */
export interface SettingsPatch {
  readonly provider?: ProviderSelection | undefined;
  readonly theme?: SettingsSnapshot["theme"] | undefined;
  readonly instructions?: string | undefined;
  readonly permissions?:
    | {
        readonly rules: readonly PermissionRuleSetting[];
        readonly grants: readonly PermissionRuleSetting[];
      }
    | undefined;
}

export interface SettingsStore {
  /** The current snapshot. A copy — callers cannot mutate the store's own object. */
  get(): SettingsSnapshot;
  /** The redacted projection a UI is allowed to render. */
  summary(): SettingsSummary;
  subscribe(listener: () => void): () => void;
  /** Apply a patch, persist it, notify. Returns the new snapshot. */
  update(patch: SettingsPatch): SettingsSnapshot;
  /** Store an API key. An empty string is a removal, matching the registry's view. */
  setApiKey(slot: string, apiKey: string): SettingsSnapshot;
  removeApiKey(slot: string): SettingsSnapshot;
  /** Drop every stored key, without touching the rest of the settings. */
  clearApiKeys(): SettingsSnapshot;
  /** The export file, keys excluded unless `options.includeApiKeys` says otherwise. */
  export(options?: SettingsExportOptions): SettingsExportFile;
  /** The export file as the text of a `.json` download. */
  serialise(options?: SettingsExportOptions): string;
  /**
   * Validate a file and **return** the resulting snapshot plus the diff —
   * without applying it.
   *
   * `Plan.md` §8.2: "nie blind überschreiben". The caller shows `diff` and calls
   * {@link SettingsStore.applyImport} once the user agreed.
   */
  prepareImport(raw: string): { readonly next: SettingsSnapshot; readonly diff: SettingsDiff };
  /** Apply a snapshot that {@link SettingsStore.prepareImport} already validated. */
  applyImport(next: SettingsSnapshot): SettingsDiff;
  /** Forget everything — the "delete everything and start over" path. */
  reset(): SettingsSnapshot;
}

export interface SettingsStoreOptions {
  readonly backend: KeyValueBackend;
  /** Override the starting point, e.g. a fixture. */
  readonly initial?: SettingsSnapshot;
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const backend = options.backend;
  const state: Observable<SettingsSnapshot> = createObservable(load(backend, options.initial));

  /**
   * Write first, publish second.
   *
   * The returned copy matters too: the store hands out snapshots that callers
   * could otherwise mutate behind its back, which would make the persisted value
   * and the in-memory value differ with no write in between.
   */
  const persist = (next: SettingsSnapshot): SettingsSnapshot => {
    backend.write(JSON.stringify(next));
    state.set(next);
    return copyOf(next);
  };

  return {
    get: () => copyOf(state.get()),

    summary: () => summariseSettings(state.get()),

    subscribe: (listener) => state.subscribe(listener),

    update(patch) {
      const current = state.get();
      return persist({
        version: current.version,
        theme: patch.theme ?? current.theme,
        instructions: patch.instructions ?? current.instructions,
        // `undefined` means "not part of this patch", so the provider selection
        // survives a theme change. Clearing a provider is done with an explicit
        // `reset()` or a selection whose fields are empty, never by omission.
        provider: patch.provider === undefined ? current.provider : patch.provider,
        permissions:
          patch.permissions === undefined
            ? current.permissions
            : { rules: [...patch.permissions.rules], grants: [...patch.permissions.grants] },
        apiKeys: { ...current.apiKeys },
      });
    },

    setApiKey(slot, apiKey) {
      const current = state.get();
      const apiKeys = { ...current.apiKeys };
      // An empty key is a removal, not an empty credential: the registry treats a
      // blank `apiKey` as missing (`createProviderModel`), and storing `""` would
      // make the settings screen claim a key exists when none does.
      if (apiKey === "") delete apiKeys[slot];
      else apiKeys[slot] = apiKey;
      return persist({ ...current, apiKeys });
    },

    removeApiKey(slot) {
      const current = state.get();
      if (!(slot in current.apiKeys)) return copyOf(current);
      const apiKeys = { ...current.apiKeys };
      delete apiKeys[slot];
      return persist({ ...current, apiKeys });
    },

    clearApiKeys() {
      return persist({ ...state.get(), apiKeys: {} });
    },

    // Forwarded, not reimplemented: the "keys are excluded by default" rule has
    // exactly one implementation, and it is `buildSettingsExport`.
    export: (exportOptions) => buildSettingsExport(state.get(), exportOptions),

    serialise: (exportOptions) => serialiseSettingsExport(state.get(), exportOptions),

    prepareImport(raw) {
      const next = parseSettingsImport(raw);
      return { next, diff: diffSettings(state.get(), next) };
    },

    applyImport(next) {
      const diff = diffSettings(state.get(), next);
      persist(next);
      return diff;
    },

    reset() {
      return persist(defaultSettings());
    },
  };
}

function copyOf(snapshot: SettingsSnapshot): SettingsSnapshot {
  return {
    ...snapshot,
    provider: snapshot.provider === undefined ? undefined : { ...snapshot.provider },
    permissions: {
      rules: snapshot.permissions.rules.map((rule) => ({ ...rule })),
      grants: snapshot.permissions.grants.map((rule) => ({ ...rule })),
    },
    apiKeys: { ...snapshot.apiKeys },
  };
}

/**
 * Read and validate what is in storage.
 *
 * Two boundaries, two failure modes, kept apart:
 *
 * - `JSON.parse` failing means the *bytes* are broken. Rewritten into the same
 *   typed `SettingsStorageError("corrupt")` as a shape mismatch, and without the
 *   `SyntaxError` message — V8 quotes the offending text in a syntax error, and
 *   that text is the settings, which may hold a key.
 * - the schema failing means the *shape* changed. The issue count is reported; the
 *   issues themselves are not, for the same reason.
 */
function load(backend: KeyValueBackend, override: SettingsSnapshot | undefined): SettingsSnapshot {
  if (override !== undefined) return override;

  // A backend that cannot be read at all (blocked storage) throws its own typed
  // error — "unavailable"/"read-failed", not "corrupt". The UI words those
  // differently: one means "this browser cannot store anything", the other means
  // "we wrote something we can no longer read".
  const raw = backend.read();
  if (raw === undefined || raw === "") return defaultSettings();

  const parsed = parseStored(raw);
  if (parsed === undefined) {
    throw new SettingsStorageError(
      "corrupt",
      `The settings stored in ${backend.description} are unreadable. They were left untouched; ` +
        "reset them explicitly if that is what you want.",
    );
  }
  return parsed;
}

function parseStored(raw: string): SettingsSnapshot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const parsed = settingsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

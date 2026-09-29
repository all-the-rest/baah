/**
 * The settings store and its transfer boundary.
 *
 * ## The tests that matter here are the negative ones
 *
 * A test asserting "the export contains the provider" passes on an implementation
 * that also ships every key in the repo. So the load-bearing assertions in this
 * file are: **a key cannot be found anywhere in an export**, by any route — the
 * obvious one, a nested one, the diff, and the *error* path, which is where a
 * secret usually escapes because a validation message quotes its input.
 */

import { describe, expect, it } from "vitest";

import {
  SETTINGS_FORMAT,
  SETTINGS_VERSION,
  SettingsImportError,
  buildSettingsExport,
  defaultSettings,
  diffSettings,
  parseSettingsImport,
  serialiseSettingsExport,
  settingsExportFileSchema,
  summariseSettings,
  type SettingsSnapshot,
} from "./settings.ts";
import { createSettingsStore } from "./settings-store.ts";
import { SettingsStorageError, createMemoryBackend, createWebStorageBackend } from "./storage.ts";

const SECRET = "sk-live-DO-NOT-LEAK-0123456789";
const OTHER_SECRET = "anthropic-secret-abcdefghijklmnop";

/** A backend that fails on write, to test the "publish second" ordering. */
function failingBackend(): ReturnType<typeof createMemoryBackend> {
  const backend = createMemoryBackend();
  return {
    ...backend,
    description: "failing",
    write: () => {
      throw new SettingsStorageError("write-failed", "QuotaExceededError: the settings could not be saved.");
    },
  };
}

/** A store with two distinct secrets stored. */
function storeWithKeys(): ReturnType<typeof createSettingsStore> {
  const store = createSettingsStore({ backend: createMemoryBackend() });
  store.update({
    provider: { vendor: "openai", model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
    theme: "light",
    instructions: "answer in German",
  });
  store.setApiKey("openai", SECRET);
  store.setApiKey("anthropic", OTHER_SECRET);
  return store;
}

/** Every string that appears anywhere in a JSON value. */
function allStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, found);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) allStrings(item, found);
  }
  return found;
}

describe("the settings snapshot", () => {
  it("starts with Plan.md §7.4's default policy, taken from core", () => {
    const settings = defaultSettings();

    // Not a copy of §7.4 — the same call, so a change to the policy in core cannot
    // leave a stale duplicate behind.
    expect(settings.permissions.rules.length).toBeGreaterThan(0);
    expect(settings.permissions.grants).toHaveLength(0);
    expect(settings.apiKeys).toEqual({});
    expect(settings.version).toBe(SETTINGS_VERSION);
  });

  it("hands out copies, so a caller cannot mutate the store behind its back", () => {
    const store = createSettingsStore({ backend: createMemoryBackend() });
    store.setApiKey("openai", SECRET);

    const snapshot = store.get();
    snapshot.apiKeys["openai"] = "tampered";
    snapshot.permissions.rules.push({ action: "*", resource: "*", effect: "allow" });

    expect(store.get().apiKeys["openai"]).toBe(SECRET);
    expect(store.get().permissions.rules).toHaveLength(
      defaultSettings().permissions.rules.length,
    );
  });

  it("treats an empty key as a removal, not as a credential", () => {
    const store = createSettingsStore({ backend: createMemoryBackend() });
    store.setApiKey("openai", SECRET);

    store.setApiKey("openai", "");

    // The registry treats a blank `apiKey` as missing, so storing `""` would make
    // the settings screen claim a key exists when none does.
    expect(store.get().apiKeys["openai"]).toBeUndefined();
  });

  it("does not publish a change the browser refused to store", () => {
    const store = createSettingsStore({ backend: failingBackend() });

    expect(() => store.setApiKey("openai", SECRET)).toThrow(SettingsStorageError);
    // Publish-second would show "stored" for a key that is not there — and the user
    // would find out from a 401 after a reload.
    expect(store.get().apiKeys).toEqual({});
  });

  it("refuses to start on a corrupt blob rather than silently resetting", () => {
    const backend = createMemoryBackend({ settings: "{not json" });

    // Silently replacing someone's permission rules with "first run" is the worst
    // available answer; the UI can offer a deliberate reset instead.
    expect(() => createSettingsStore({ backend })).toThrow(SettingsStorageError);
  });

  it("refuses to start on a blob with the wrong shape", () => {
    const backend = createMemoryBackend({ settings: JSON.stringify({ version: 99 }) });

    expect(() => createSettingsStore({ backend })).toThrow(/unreadable/);
  });

  it("notifies subscribers on every change", () => {
    const store = createSettingsStore({ backend: createMemoryBackend() });
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });

    store.update({ theme: "light" });
    store.setApiKey("openai", SECRET);

    expect(calls).toBe(2);
  });
});

describe("the export (Plan.md §8.2)", () => {
  it("excludes keys by default", () => {
    const store = storeWithKeys();

    const file = store.export();

    expect(file.apiKeys).toBeUndefined();
  });

  it("cannot leak a key anywhere in the serialised export", () => {
    const store = storeWithKeys();

    const raw = store.serialise();
    const parsed: unknown = JSON.parse(raw);

    // Not `expect(raw).not.toContain(SECRET)` — that only checks the top level. A
    // nested copy inside `permissions`, a `metadata` field or a key name would all
    // pass it.
    for (const value of allStrings(parsed)) {
      expect(value).not.toContain(SECRET);
      expect(value).not.toContain(OTHER_SECRET);
    }
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(OTHER_SECRET);
  });

  it("carries a version and a format, so the file is a migration anchor", () => {
    const file = buildSettingsExport(defaultSettings(), { now: () => 0 });

    expect(file.format).toBe(SETTINGS_FORMAT);
    expect(file.version).toBe(SETTINGS_VERSION);
    expect(file.exportedAt).toBe(new Date(0).toISOString());
    expect(settingsExportFileSchema.safeParse(file).success).toBe(true);
  });

  it("includes the keys only when the caller opts in", () => {
    const store = storeWithKeys();

    const file = store.export({ includeApiKeys: true });

    expect(file.apiKeys).toEqual({ openai: SECRET, anthropic: OTHER_SECRET });
  });

  it("keeps the non-secret settings intact either way", () => {
    const store = storeWithKeys();

    const without = store.export();
    const with_ = store.export({ includeApiKeys: true });

    expect(without.settings).toEqual(with_.settings);
    expect(without.settings.provider?.model).toBe("gpt-4o-mini");
    expect(without.settings.theme).toBe("light");
    expect(without.settings.instructions).toBe("answer in German");
  });

  it("round-trips through serialise and back", () => {
    const store = storeWithKeys();

    const restored = parseSettingsImport(store.serialise());

    expect(restored.provider?.vendor).toBe("openai");
    expect(restored.theme).toBe("light");
    // No keys in the file, so no keys in the result — importing a key-free export
    // must not leave a stale key behind either.
    expect(restored.apiKeys).toEqual({});
  });
});

describe("the import boundary (AGENTS.md §5)", () => {
  it("rejects a file that is not JSON, without quoting it", () => {
    // V8's syntax errors quote the offending text. The file may hold a key, so the
    // message must not be forwarded — this assertion is the whole reason.
    let thrown: unknown;
    try {
      parseSettingsImport(`{"apiKeys": {"openai": "${SECRET}"`);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SettingsImportError);
    expect((thrown as Error).message).not.toContain(SECRET);
    expect((thrown as SettingsImportError).code).toBe("invalid_json");
  });

  it("rejects a wrong shape, without echoing the value", () => {
    const raw = JSON.stringify({
      format: SETTINGS_FORMAT,
      version: SETTINGS_VERSION,
      exportedAt: new Date(0).toISOString(),
      settings: { theme: "neon", instructions: SECRET, permissions: { rules: [], grants: [] } },
    });

    expect(() => parseSettingsImport(raw)).toThrow(SettingsImportError);
    try {
      parseSettingsImport(raw);
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
      // The path is reported so the user knows *what* is wrong...
      expect((error as Error).message).toContain("theme");
      // ...and the offending value is not.
      const issues = (error as SettingsImportError).issues;
      expect(issues.map((issue) => issue.path)).toContain("settings.theme");
    }
  });

  it("rejects a file from a newer build instead of guessing at the migration", () => {
    const raw = JSON.stringify({
      format: SETTINGS_FORMAT,
      version: SETTINGS_VERSION + 1,
      exportedAt: new Date(0).toISOString(),
      settings: { theme: "dark", instructions: "", permissions: { rules: [], grants: [] } },
    });

    expect(() => parseSettingsImport(raw)).toThrow(/version/);
  });

  it("rejects a file that is not one of ours", () => {
    const raw = JSON.stringify({ hello: "world" });

    expect(() => parseSettingsImport(raw)).toThrow(SettingsImportError);
  });

  it("never lets a secret reach an error, at any nesting depth", () => {
    const shapes: unknown[] = [
      { format: SETTINGS_FORMAT, version: SETTINGS_VERSION, apiKeys: { openai: SECRET } },
      { format: SETTINGS_FORMAT, version: "not-a-number", settings: SECRET },
      { format: 42, version: SETTINGS_VERSION, settings: { theme: SECRET } },
      { format: SETTINGS_FORMAT, version: SETTINGS_VERSION, settings: { permissions: SECRET } },
      [SECRET],
      SECRET,
      null,
    ];

    for (const shape of shapes) {
      try {
        parseSettingsImport(JSON.stringify(shape));
        throw new Error(`expected a rejection for ${JSON.stringify(Object.keys(shape as object))}`);
      } catch (error) {
        if (error instanceof SettingsImportError) {
          expect(error.message).not.toContain(SECRET);
          expect(JSON.stringify(error.issues)).not.toContain(SECRET);
        }
      }
    }
  });

  it("returns a diff and changes nothing until it is applied", () => {
    const store = storeWithKeys();
    // The incoming file is produced the way a real one would be: from a snapshot,
    // through the export, and serialised.
    const incoming = serialiseSettingsExport(
      { ...store.get(), theme: "dark", instructions: "answer in English" },
      { now: () => 0 },
    );

    const prepared = store.prepareImport(incoming);

    expect(prepared.diff.theme).toEqual({ from: "light", to: "dark" });
    expect(prepared.diff.instructions.changed).toBe(true);
    // §8.2: "nie blind überschreiben". The store is untouched until `apply`.
    expect(store.get().theme).toBe("light");

    const applied = store.applyImport(prepared.next);
    expect(store.get().theme).toBe("dark");
    expect(applied.identical).toBe(false);
  });
});

describe("the diff (Plan.md §8.2 preview)", () => {
  it("reports key slots by name and nothing else", () => {
    const store = storeWithKeys();
    const next = { ...store.get(), apiKeys: { ...store.get().apiKeys, openai: "sk-rotated" } };

    const diff = diffSettings(store.get(), next);

    expect(diff.apiKeys.replaced).toEqual(["openai"]);
    expect(diff.apiKeys.unchanged).toEqual(["anthropic"]);
    // A diff is rendered, screenshotted and pasted into issues. Not the value, not
    // its length, not a hash — the name is all the user needs.
    expect(JSON.stringify(diff)).not.toContain(SECRET);
    expect(JSON.stringify(diff)).not.toContain(OTHER_SECRET);
  });

  it("lists added, removed and replaced keys separately", () => {
    const current = defaultSettings();
    const next = { ...current, apiKeys: { openai: SECRET, google: SECRET } };

    const diff = diffSettings({ ...current, apiKeys: { anthropic: SECRET } }, next);

    expect(diff.apiKeys.added).toEqual(["google", "openai"]);
    expect(diff.apiKeys.removed).toEqual(["anthropic"]);
    expect(diff.apiKeys.replaced).toEqual([]);
  });

  it("calls an unchanged snapshot identical", () => {
    const store = storeWithKeys();

    expect(diffSettings(store.get(), store.get()).identical).toBe(true);
  });

  it("counts permission rule changes without quoting them", () => {
    const current = defaultSettings();
    const added: SettingsSnapshot = {
      ...current,
      permissions: { rules: [{ action: "shell", resource: "rm *", effect: "deny" }], grants: [] },
    };

    const diff = diffSettings(current, added);

    expect(diff.permissions.rules.added).toBe(1);
    expect(diff.identical).toBe(false);
  });

  it("treats a reordering as a change, because the last rule wins", () => {
    // §7.1: "ein Ruleset ist eine **geordnete** Liste. Die letzte passende Regel
    // gewinnt." Swapping an allow and a deny flips the outcome while adding and
    // removing nothing — a membership-only comparison would call that unchanged.
    const rules: SettingsSnapshot["permissions"]["rules"] = [
      { action: "read", resource: "*.env", effect: "allow" },
      { action: "read", resource: "*.env.local", effect: "deny" },
    ];
    const swapped: SettingsSnapshot["permissions"]["rules"] = [rules[1] as never, rules[0] as never];

    const before = { ...defaultSettings(), permissions: { rules, grants: [] } };
    const after = { ...defaultSettings(), permissions: { rules: swapped, grants: [] } };

    const diff = diffSettings(before, after);

    expect(diff.permissions.rules).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(diff.identical).toBe(false);
  });
});

describe("the redacted summary", () => {
  it("exposes which keys exist and no key value", () => {
    const store = storeWithKeys();

    const summary = summariseSettings(store.get());

    expect(summary.keySlots).toEqual(["anthropic", "openai"]);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(summary.instructionsLength).toBe("answer in German".length);
  });
});

describe("the browser storage backend", () => {
  it("names an unavailable localStorage instead of crashing on a getter", () => {
    const backend = createWebStorageBackend();
    const hadLocalStorage = "localStorage" in globalThis;

    try {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: undefined,
      });
      expect(() => backend.read()).toThrow(/no localStorage/);
    } finally {
      if (!hadLocalStorage) {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
  });

  it("reduces a quota failure to its class name, never its payload", () => {
    const backend = createWebStorageBackend();
    try {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: () => null,
          // A browser quota message can quote what was written. The store must not
          // let that reach a DOMException that an error boundary will log.
          setItem: () => {
            throw new Error(`Quota exceeded while writing ${SECRET}`);
          },
          removeItem: () => {},
        },
      });

      expect(() => backend.write(SECRET)).toThrow(SettingsStorageError);
      try {
        backend.write(SECRET);
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
        expect((error as Error).message).toContain("Error");
      }
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

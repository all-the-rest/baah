/**
 * Settings: export, import, and the key slots.
 *
 * ## Export
 *
 * `Plan.md` §8.2: a JSON file with a `version` field, and **keys excluded by
 * default** behind a separate, warning checkbox. The exclusion itself is enforced
 * structurally in `lib/settings.ts` (`buildSettingsExport` destructures `apiKeys`
 * out); this panel only chooses the default and shows what the file will contain.
 *
 * The default is `false` and is derived from nothing — not "the user has a key
 * stored", not "the user ticked it last time". A checkbox that remembers is a
 * checkbox that will be ticked by accident exactly once, and the consequence is an
 * API key in a file the user then attaches somewhere.
 *
 * ## Import
 *
 * `§8.2`: "zod-validiert, mit Diff-Vorschau, **nie blind überschreiben**." So the
 * two actions are distinct: *Vorschau zeigen* validates and returns the diff, and
 * *Anwenden* is only reachable afterwards. The runtime's `prepareSettingsImport`
 * applies nothing (`runtime/index.ts`), which is what makes the two-step structural
 * rather than a matter of remembering to hide a button.
 *
 * `SettingsDiff` reports key **slot names** and never a value, a length or a hash
 * — so the preview has nothing secret in it, and a key value can never reach this
 * markup.
 */
import { useState } from "react";

import type { SettingsDiff } from "../lib/settings.ts";
import type { SettingsStore } from "../lib/settings-store.ts";
import { TEST_ATTRIBUTES, TEST_IDS } from "../lib/testids.ts";
import { diffLines, EXPORT_KEY_WARNING, exportFileName, exportSummary, IMPORT_WARNING } from "./lib/export.ts";
import { nowIso } from "../lib/ids.ts";

export interface SettingsPanelProps {
  readonly settings: SettingsStore;
  readonly runtime: {
    exportSettings(options?: { readonly includeApiKeys?: boolean }): unknown;
    prepareSettingsImport(raw: string): { readonly diff: SettingsDiff; readonly apply: () => SettingsDiff };
  };
  readonly onOpenWizard: () => void;
  readonly onClose: () => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const summary = props.settings.summary();
  const [includeApiKeys, setIncludeApiKeys] = useState(false);
  const [diff, setDiff] = useState<SettingsDiff | undefined>();
  const [pendingApply, setPendingApply] = useState<(() => SettingsDiff) | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const download = (): void => {
    const file = props.runtime.exportSettings(includeApiKeys ? { includeApiKeys: true } : {});
    const json = `${JSON.stringify(file, null, 2)}\n`;
    const name = exportFileName(Date.parse(nowIso()));
    // A Blob and an object URL, not a server route: `AGENTS.md` §2 forbids the
    // app having a backend, and a download is a browser feature.
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(`Export geschrieben: ${name}`);
    setError(undefined);
  };

  const preview = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setError(undefined);
    setNotice(undefined);
    try {
      const raw = await file.text();
      // Validates and returns the diff. Applies nothing — that is the runtime's
      // own contract, not a UI convention.
      const prepared = props.runtime.prepareSettingsImport(raw);
      setDiff(prepared.diff);
      setPendingApply(() => prepared.apply);
    } catch (cause) {
      // `SettingsImportError`'s message is built from paths and codes and never
      // quotes the input (`lib/settings.ts`), so it is safe to show. An
      // unexpected error is reduced to its class name for the same reason a
      // provider error is.
      setDiff(undefined);
      setPendingApply(undefined);
      setError(
        cause instanceof Error && cause.name === "SettingsImportError"
          ? cause.message
          : `Die Datei konnte nicht gelesen werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}.`,
      );
    }
  };

  return (
    <aside aria-label="Einstellungen" className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-l border-base-300 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Einstellungen</h2>
        <button type="button" data-testid="baah-settings-close" className="btn btn-ghost btn-xs" onClick={props.onClose}>
          Schließen
        </button>
      </div>

      <section>
        <h3 className="text-sm font-semibold">Provider</h3>
        <p className="text-xs opacity-80">
          {summary.provider === undefined ? "Kein Provider gewählt." : summary.provider.vendor}
          {summary.provider?.model === undefined || summary.provider.model === "" ? "" : ` · ${summary.provider.model}`}
        </p>
        <button type="button" data-testid="baah-settings-open-wizard" className="btn btn-outline btn-sm mt-1" onClick={props.onOpenWizard}>
          Einrichtung erneut öffnen
        </button>
      </section>

      <section>
        <h3 className="text-sm font-semibold">API-Keys</h3>
        {summary.keySlots.length === 0 ? (
          <p className="text-xs opacity-70">Kein Key gespeichert.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {summary.keySlots.map((slot) => (
              <li key={slot} className="flex items-center gap-2">
                {/*
                 * The **slot name**, never the value. `lib/testids.ts` says it
                 * outright — "Never a key value: the slot name only. Assert on
                 * this, not on the input" — and the reason is the same one the
                 * diff's reason is: this text is rendered, screenshotted and
                 * pasted into issues.
                 */}
                <code data-testid={TEST_IDS.settingsKeySlot} className="text-xs">
                  {slot}
                </code>
                <button
                  type="button"
                  data-baah-key-slot={slot}
                  className="btn btn-ghost btn-xs"
                  onClick={() => props.settings.removeApiKey(slot)}
                >
                  entfernen
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold">Export</h3>
        {/*
         * The opt-in, with its warning **next to it** rather than behind a dialog:
         a user exporting settings to move to another device learns what the file
         will contain in the same view they click in.
         */}
        <label className="mt-1 flex items-start gap-2 text-xs">
          <input
            data-testid={TEST_IDS.settingsExportIncludeKeys}
            type="checkbox"
            className="checkbox checkbox-sm mt-0.5"
            checked={includeApiKeys}
            onChange={(event) => setIncludeApiKeys(event.target.checked)}
          />
          <span>
            <span className="font-semibold">Keys mitschreiben (unsicher)</span>
            <span className="block opacity-80">{EXPORT_KEY_WARNING}</span>
          </span>
        </label>
        <p data-baah-export-summary="true" className="mt-1 text-xs opacity-80">
          {exportSummary(includeApiKeys, summary)}
        </p>
        <button
          type="button"
          data-testid={TEST_IDS.settingsExportDownload}
          className="btn btn-primary btn-sm mt-1"
          onClick={download}
        >
          Als JSON exportieren
        </button>
      </section>

      <section>
        <h3 className="text-sm font-semibold">Import</h3>
        <p className="text-xs opacity-80">{IMPORT_WARNING}</p>
        <input
          data-testid={TEST_IDS.settingsImportFile}
          type="file"
          accept="application/json,.json"
          className="file-input file-input-bordered file-input-sm mt-1 w-full text-xs"
          onChange={(event) => {
            void preview(event.target.files?.[0]);
          }}
        />
        {diff !== undefined && (
          <div data-testid={TEST_IDS.settingsImportDiff} className="mt-2 rounded-box border border-base-300 p-2">
            <p className="text-xs font-semibold">{diff.identical ? "Keine Änderung" : "Diese Änderungen:"}</p>
            <ul className="mt-1 flex flex-col gap-1 text-xs">
              {diffLines(diff).map((line, index) => (
                <li key={`${line.field}-${String(index)}`} data-baah-diff-field={line.field} data-baah-diff-key={String(line.involvesKey)}>
                  <span className="font-semibold">{line.field}:</span>{" "}
                  <span className="opacity-70 line-through">{line.from}</span> → <span>{line.to}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              data-testid="baah-settings-apply-import"
              className="btn btn-primary btn-xs mt-2"
              onClick={() => {
                const applied = pendingApply?.();
                if (applied !== undefined) {
                  setDiff(applied);
                  setPendingApply(undefined);
                  setNotice("Import angewendet.");
                }
              }}
            >
              Anwenden
            </button>
          </div>
        )}
      </section>

      {error !== undefined && (
        <p data-baah-settings-error="true" role="alert" className="rounded-box border border-error/60 p-2 text-xs">
          {error}
        </p>
      )}
      {notice !== undefined && (
        <p data-baah-settings-notice="true" role="status" className="rounded-box border border-base-300 p-2 text-xs">
          {notice}
        </p>
      )}
    </aside>
  );
}

export { TEST_ATTRIBUTES, TEST_IDS };

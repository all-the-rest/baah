/**
 * Settings export and import, as the UI presents them.
 *
 * ## Keys are excluded unless someone ticks a box
 *
 * `Plan.md` §8.2: "Keys standardmäßig NICHT enthalten; separater, warnender Haken."
 * The *enforcement* is `buildSettingsExport` in `lib/settings.ts`, which
 * destructures `apiKeys` out of the snapshot — this file only chooses the default
 * and shows the consequence.
 *
 * The default is `false` and is not inferred from anything. A checkbox whose
 * state is remembered from last time, or derived from "the user has a key stored",
 * is a checkbox that will be ticked by accident exactly once.
 *
 * ## The diff is rendered before anything is written
 *
 * §8.2: "Import: zod-validiert, mit Diff-Vorschau, **nie blind überschreiben**." So
 * the wizard's import step has two actions that are not a cancel: *what changes?*
 * and *apply* — and the second is only reachable after the first has been shown.
 *
 * `SettingsDiff` reports key **slot names** and never a value, a length or a hash
 * (`lib/settings.ts` says why, and the reason holds: a diff gets screenshotted and
 * pasted into issues). So the diff view has nothing secret to redact, and a
 * change to that property would be a change in `lib/settings.ts`, not here.
 */
import type { SettingsDiff } from "../../lib/settings.ts";
import type { SettingsSummary } from "../../lib/settings.ts";

/** One line of the diff preview. */
export interface DiffLine {
  readonly field: string;
  readonly from: string;
  readonly to: string;
  /** `true` when the value is a key *slot name*, never a key. */
  readonly involvesKey: boolean;
}

/**
 * The diff as rows.
 *
 * Key slots are rendered as a set difference, not as a value change: "openai:
 * ersetzt" is what the user needs, and "openai: `sk-…` → `sk-…`" is the thing
 * `lib/settings.ts` refuses to build.
 */
export function diffLines(diff: SettingsDiff): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  const provider = pair(diff.provider.from, diff.provider.to);
  if (provider !== undefined) lines.push({ field: "Provider", ...provider, involvesKey: false });
  const model = pair(diff.model.from === "" ? undefined : diff.model.from, diff.model.to === "" ? undefined : diff.model.to);
  if (model !== undefined) lines.push({ field: "Modell", ...model, involvesKey: false });
  const baseUrl = pair(diff.baseUrl.from, diff.baseUrl.to);
  if (baseUrl !== undefined) lines.push({ field: "Base-URL", ...baseUrl, involvesKey: false });
  if (diff.instructions.changed) {
    lines.push({
      field: "Instruktionen",
      from: `${String(diff.instructions.fromChars)} Zeichen`,
      to: `${String(diff.instructions.toChars)} Zeichen`,
      involvesKey: false,
    });
  }
  const rules = diff.permissions.rules;
  if (rules.added + rules.removed + rules.changed > 0) {
    lines.push({
      field: "Berechtigungsregeln",
      from: `${String(rules.removed)} entfernt`,
      to: `${String(rules.added)} neu, ${String(rules.changed)} umsortiert`,
      involvesKey: false,
    });
  }
  const keys = diff.apiKeys;
  for (const slot of keys.added) lines.push({ field: "API-Key-Slot", from: "—", to: `${slot} (neu)`, involvesKey: true });
  for (const slot of keys.removed) lines.push({ field: "API-Key-Slot", from: `${slot} (entfernt)`, to: "—", involvesKey: true });
  for (const slot of keys.replaced) lines.push({ field: "API-Key-Slot", from: `${slot} (alter Wert)`, to: `${slot} (neuer Wert)`, involvesKey: true });
  for (const slot of keys.unchanged) lines.push({ field: "API-Key-Slot", from: `${slot} (unverändert)`, to: `${slot}`, involvesKey: true });
  return lines;
}

function pair(from: string | undefined, to: string | undefined): { from: string; to: string } | undefined {
  if (from === to) return undefined;
  return { from: from ?? "—", to: to ?? "—" };
}

/** The export's file name, dated. ISO, so it sorts (`AGENTS.md` §5). */
export function exportFileName(now: number): string {
  return `baah-settings-${new Date(now).toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
}

/**
 * The checkbox's warning, and the sentence that follows a ticked box.
 *
 * Shown **next to** the checkbox, not behind a confirm dialog: a user who is
 * exporting settings to move to another device should learn what the file will
 * contain before they write it, in the same view.
 */
export const EXPORT_KEY_WARNING =
  "Keys mitschreiben (unsicher): Die Datei enthält deine API-Keys im Klartext. " +
  "Sie gehört damit in denselben Schutz wie die Schlüssel selbst — nicht in ein Repository, " +
  "nicht in einen Chat, nicht in einen Screenshot.";

/** What the export contains, for the button's summary line. */
export function exportSummary(includeApiKeys: boolean, summary: SettingsSummary): string {
  const keys = summary.keySlots.length;
  if (includeApiKeys) {
    return `Enthält ${String(keys)} Key-Slot(s) im Klartext.`;
  }
  return keys === 0
    ? "Enthält keine Keys — es sind keine gespeichert."
    : `Enthält keine Keys. ${String(keys)} Slot(s) bleiben in diesem Browser.`;
}

/** The re-import warning, so nobody re-imports a file from an untrusted source. */
export const IMPORT_WARNING =
  "Eine importierte Datei kann Provider, Base-URL, Instruktionen und Berechtigungsregeln ersetzen. " +
  "Prüfe die Vorschau, bevor du anwendest — insbesondere die Base-URL, denn dorthin gehen deine Keys.";

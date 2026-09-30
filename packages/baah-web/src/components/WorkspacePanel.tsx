/**
 * The workspace picker — `Plan.md` §8.1 step 5, and §5.3's mode requirement.
 *
 * ## Why the mode is the headline
 *
 * §5.3: "Die UI muss den Modus *sichtbar* machen („du arbeitest in einer
 * Kopie") — sonst erwartet ein Firefox-Nutzer Speicherungen auf der Platte, die
 * nicht passieren." A user who believes writes land on disk and finds they do not
 * has lost twice: once by expecting it, once by not exporting.
 *
 * So every option states, in its own label, where the bytes go.
 *
 * ## Why `showDirectoryPicker` is **not** offered here
 *
 * `Plan.md` §14.1: the File System Access API is Chromium-only, Firefox has a
 * negative standards position and Safari opposes it. Offering a Chromium-only
 * button in a cross-browser build means a Firefox user clicks it and gets nothing
 * — so the button would exist only in the browser that does not need it (Safari's
 * OPFS sandbox is the answer there, and OPFS works everywhere, §14.1's table).
 *
 * The task-tool `requestPermission()` constraint from §14.1 is the second reason
 * it is not wired: permission can only be requested from a user gesture on the main
 * thread, and the tool would have to prompt on every cold start. That is a real
 * piece of work, not a button.
 */
import { useState } from "react";

import { PROVENANCE_ATTRIBUTE } from "./lib/trust.ts";

export interface WorkspacePanelProps {
  /** `Plan.md` §5.3's `Workspace["kind"]`. */
  readonly mode: "opfs" | "memory" | "local-directory";
  readonly onOpen: () => void;
  readonly onRefresh: () => void;
  /** `true` when the store is in memory, so the transcript dies on reload. */
  readonly ephemeralTranscript: boolean;
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const run = (work: () => void): void => {
    setBusy(true);
    setError(undefined);
    try {
      work();
    } catch (cause) {
      // Class name only. An `Error.message` from a browser API boundary can
      // quote the value being written (`lib/storage.ts` documents the same rule
      // for `localStorage`).
      setError(cause instanceof Error ? `${cause.name}: ${"Der Zugriff auf den Workspace wurde abgelehnt."}` : "Unbekannter Fehler.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 p-4" aria-label="Workspace">
      <header className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold">Workspace</h2>
        <span
          data-baah-workspace-mode={props.mode}
          {...{ [PROVENANCE_ATTRIBUTE]: "app" }}
          className="badge badge-ghost badge-sm"
        >
          {modeLabel(props.mode)}
        </span>
      </header>

      <p className="text-xs opacity-80">{modeExplanation(props.mode)}</p>

      {props.ephemeralTranscript && (
        // Not a footnote. `Plan.md` §1's DoD says the transcript must survive a
        // reload, this build does not, and a user who finds that out by reloading
        // has lost their work. The statement is in the panel they open to look at
        // their setup.
        <p data-baah-ephemeral="true" className="rounded-box border border-warning/60 bg-warning/10 p-2 text-xs">
          Der Verlauf liegt in diesem Build im Arbeitsspeicher: <strong>ein Reload löscht ihn</strong>.
          Exportiere die Einstellungen, wenn du sie mitnehmen willst — der Verlauf selbst ist davon nicht
          erfasst.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="baah-workspace-refresh"
          className="btn btn-outline btn-sm"
          disabled={busy}
          onClick={() => run(props.onRefresh)}
        >
          Neu einlesen
        </button>
        <button
          type="button"
          data-testid="baah-workspace-open"
          className="btn btn-sm"
          disabled={busy || props.mode !== "local-directory"}
          onClick={() => run(props.onOpen)}
        >
          Ordner verbinden
        </button>
      </div>

      {error !== undefined && (
        <p data-baah-workspace-error="true" role="alert" className="rounded-box border border-error/60 p-2 text-xs">
          {error}
        </p>
      )}
    </section>
  );
}

function modeLabel(mode: WorkspacePanelProps["mode"]): string {
  switch (mode) {
    case "opfs":
      return "Sandbox (OPFS)";
    case "memory":
      return "Arbeitsspeicher";
    case "local-directory":
      return "Lokaler Ordner";
  }
}

function modeExplanation(mode: WorkspacePanelProps["mode"]): string {
  switch (mode) {
    case "opfs":
      return (
        "Privater Sandbox-Ordner im Browser. Schreibzugriffe landen nicht auf deiner Platte; " +
        "du musst den Ordner am Ende exportieren. Der Browser kann ungenutzte Daten nach 7 Tagen ohne " +
        "Interaktion löschen (Plan.md §14.1)."
      );
    case "memory":
      return (
        "Nur im Arbeitsspeicher. Nichts wird gespeichert — weder auf der Platte noch über einen Reload. " +
        "Gut zum Ausprobieren, ungeeignet für echte Arbeit."
      );
    case "local-directory":
      return (
        "In-place auf einem echten Ordner. Schreibzugriffe landen direkt auf deiner Platte, " +
        "über die File System Access API — und damit nur in Chromium (Plan.md §14.1)."
      );
  }
}

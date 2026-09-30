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
 * ## `showDirectoryPicker` **is** offered here, and the docstring that said
 * otherwise was wrong
 *
 * The previous version of this file argued that the File System Access API is
 * Chromium-only and therefore must not be offered. The first half is true
 * (`Plan.md` §14.1's table) and the conclusion was not: a Chromium-only
 * **button**, disabled with a stated reason everywhere else, is available to
 * every user and useful to exactly the users who need it. Suppressing it made
 * `AGENTS.md` §2a's target unreachable rather than cross-browser.
 *
 * The second reason it was not wired — "permission can only be requested from a
 * user gesture, so the tool would have to prompt on every cold start" — is a real
 * constraint, and it is handled rather than avoided: `lib/project-folder.ts`
 * asks with `queryPermission` at boot and only ever calls `requestPermission`
 * from this button's click handler. `Plan.md` §14.1 point 1 asks for exactly that
 * ("Nach jedem Kaltstart ein 'Projekt wieder öffnen'-Button"), and that button is
 * this one.
 */
import { useState } from "react";

import { PROVENANCE_ATTRIBUTE } from "./lib/trust.ts";
import type { ProjectFolderState } from "../lib/project-folder.ts";
import type { WorkspaceMode } from "../lib/swappable-workspace.ts";

export type { WorkspaceMode };

export interface WorkspacePanelProps {
  /** `Plan.md` §5.3's `Workspace["kind"]`, read off the real workspace. */
  readonly mode: WorkspaceMode;
  /**
   * Pick a folder. **Called from a click handler**, which is the only context in
   * which `requestPermission` is permitted — see the module header.
   */
  readonly onOpen: () => void;
  readonly onRefresh: () => void;
  /** The folder's own state, which is not the same fact as `mode`. */
  readonly folder: ProjectFolderState;
  /** `false` where §14.1's table says there is no picker at all. */
  readonly pickerAvailable: boolean;
}

/**
 * The mode, as a badge, for a place that is **not** this panel.
 *
 * `AppShell` puts one in its header, because below the two-column threshold the
 * panel itself is behind a drawer that starts closed — and §5.3 asks for the mode to
 * be *visible*, not merely reachable. Reaching it in two taps is not the same
 * statement.
 *
 * `max-lg:inline-flex hidden` rather than a `wide ? … : null`: it is one element that
 * changes presentation rather than one that appears and disappears, so nothing in the
 * tree can drift out of step with `lib/viewport.ts`'s threshold. The `hidden` is what
 * keeps it off the desktop header, where the panel is visible anyway and a second copy
 * of the mode would be noise.
 *
 * A **separate** attribute from the panel's `data-baah-workspace-mode` — two nodes
 * claiming to be the mode is exactly what a strict-mode locator trips over.
 */
export function WorkspaceModeBadge({ mode }: { readonly mode: WorkspaceMode }) {
  return (
    <span
      data-baah-workspace-mode-badge={mode}
      {...{ [PROVENANCE_ATTRIBUTE]: "app" }}
      className="badge badge-ghost badge-sm hidden max-lg:inline-flex"
    >
      {modeLabel(mode)}
    </span>
  );
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

      {/* The "der Verlauf übersteht keinen Reload" warning that used to live here is
          gone, and the panel's docstring is the reason it can be: this component is
          about where **workspace writes** land (§5.3), and that question is still
          open. The **transcript** was a different fact — SQLite in OPFS, durable —
          and a second copy of a warning that is no longer true is worse than no
          warning at all. */}

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
          // **No longer `props.mode !== "local-directory"`.** That condition made
          // the button permanently dead: the mode could only become
          // `local-directory` *through this button*, so the button was disabled
          // for exactly the state it existed to reach. The two real reasons to
          // disable it are now the two real ones — the browser has no picker, or
          // something is already running.
          disabled={busy || !props.pickerAvailable}
          title={props.pickerAvailable ? undefined : "Dieser Browser bietet keine Ordner-Auswahl (Plan.md §14.1)."}
          onClick={() => run(props.onOpen)}
        >
          {props.folder.kind === "connected" ? "Ordner wechseln" : "Ordner verbinden"}
        </button>
      </div>

      {/*
       * The folder's own state, and it is a **separate line from the mode badge**
       * on purpose. After a cold start the mode is already `local-directory`
       * while the grant is gone; showing only the mode would tell a user their
       * folder is attached when every write is about to fail. §5.3 asks for the
       * mode to be visible — it does not ask for the mode to be the whole truth.
       */}
      {folderNote(props.folder, props.mode) !== undefined && (
        <p
          data-baah-folder-state={props.folder.kind}
          data-testid="baah-workspace-folder-note"
          role="status"
          className="rounded-box border border-base-300 p-2 text-xs"
        >
          {folderNote(props.folder, props.mode)}
        </p>
      )}

      {error !== undefined && (
        <p data-baah-workspace-error="true" role="alert" className="rounded-box border border-error/60 p-2 text-xs">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The one sentence the folder's state adds, or `undefined` when there is nothing
 * to add.
 *
 * `connected` while the mode is already `local-directory` says nothing new, so it
 * returns `undefined` and the panel stays quiet. Every other case names what the
 * user can do about it, because a state that is rendered but not explained is
 * decoration: `needs-gesture` in particular is the cold-start case, and the whole
 * point of `lib/project-folder.ts` is that it is stated rather than papered over.
 */
function folderNote(folder: ProjectFolderState, mode: WorkspaceMode): string | undefined {
  switch (folder.kind) {
    case "connected":
      return mode === "local-directory" ? `Verbunden mit „${folder.label}".` : undefined;
    case "needs-gesture":
      return (
        `„${folder.label}" ist ausgewählt, aber der Browser hat die Freigabe zurückgesetzt — ` +
        "das überlebt keinen Kaltstart (Plan.md §14.1). Drücke „Ordner verbinden“, um sie erneut zu erteilen."
      );
    case "denied":
      return `Der Zugriff auf „${folder.label}" wurde abgelehnt. Ohne Freigabe wird im Sandbox-Workspace gearbeitet.`;
    case "unsupported":
      return folder.reason;
    case "no-handle":
      return undefined;
  }
}

function modeLabel(mode: WorkspaceMode): string {
  switch (mode) {
    case "opfs":
      return "Sandbox (OPFS)";
    case "memory":
      return "Arbeitsspeicher";
    case "local-directory":
      return "Lokaler Ordner";
  }
}

function modeExplanation(mode: WorkspaceMode): string {
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

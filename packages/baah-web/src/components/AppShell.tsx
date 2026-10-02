/**
 * The app shell: the two screens, the one that decides between them, and the
 * React adapter for the runtime.
 *
 * ## How the runtime reaches React
 *
 * `runtime/index.ts` is deliberately a plain object with `subscribeState` and
 * `getState`, and its own module header says the adapter
 * (`useSyncExternalStore(runtime.subscribeState, runtime.getState)`) "belongs to
 * the component that needs it". This is that component — one hook, used once, and
 * the rest of the tree is ordinary React.
 *
 * ## The live fold
 *
 * The runtime's snapshot carries `messages` and `text`, but `text` is
 * **reasoning and text mixed together** — `handleEvent` appends both to one
 * buffer. So the snapshot is not enough to render a live turn, and the live parts
 * are folded from the event bus instead (`applyAgentEvent`). The bus forwards the
 * engine's events verbatim, and the fold keeps reasoning in its own map, so the
 * model's deliberation is never shown as its answer.
 *
 * ## The read port
 *
 * `runtime.readTranscript()` returns a **union**, and the two failure kinds render
 * as an explicit problem note rather than an empty transcript — see
 * `lib/transcript.ts` and the header in `runtime/index.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { UIMessage } from "ai";

import type { AgentEvent, RuntimeState, TranscriptRead } from "../runtime/index.ts";
import { ChatView } from "./ChatView.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { TEST_IDS } from "../lib/testids.ts";
import { isDirectoryPickerAvailable } from "../lib/project-folder.ts";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { TodoSidebar } from "./TodoSidebar.tsx";
import { Transcript } from "./Transcript.tsx";
import { WorkspaceModeBadge, WorkspacePanel } from "./WorkspacePanel.tsx";
import type { AppRuntime, ProjectTarget } from "./lib/runtime.ts";
import { applyAgentEvent, EMPTY_LIVE_TURN, type LiveTurn } from "./lib/transcript.ts";
import { bootNotice, turnBanner } from "./lib/turn-view.ts";
import { isConfigured, type WizardState } from "./lib/onboarding.ts";
import { useIsWideViewport } from "./lib/viewport.ts";

export type Screen = "onboarding" | "workbench";

export interface AppShellProps {
  readonly app: AppRuntime;
  /** Overridden by a test. `undefined` means "decide from the settings". */
  readonly initialScreen?: Screen;
}

export function AppShell({ app: initialApp, initialScreen }: AppShellProps) {
  /**
   * The live app, which a project switch **replaces**.
   *
   * `app` arrives as a prop built once by `App.tsx`, and for the whole life of this
   * component it used to be that one object. It cannot be: opening a different project
   * has to change which conversation is on screen, and the conversation is bound into
   * the runtime, the tool set and the store decorator at construction. So the prop is
   * the *initial* app and the state is the current one.
   *
   * A state and not a ref, and that is load-bearing: `useRuntimeState(runtime)` and
   * `useLiveTurn(runtime)` subscribe by identity, so a replaced runtime has to reach
   * them through a re-render. A ref would have swapped the object without ever
   * re-subscribing, and the transcript would have kept showing the old conversation —
   * the same visible bug, one layer further up.
   */
  const [app, setApp] = useState<AppRuntime>(initialApp);
  const { runtime, settings, questions, todos } = app;
  const state = useRuntimeState(runtime);
  const live = useLiveTurn(runtime);
  const wide = useIsWideViewport();
  const [screen, setScreen] = useState<Screen | undefined>(initialScreen);
  const [read, setRead] = useState<TranscriptRead | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [liveError, setLiveError] = useState<string | undefined>();
  const mounted = useRef(true);

  /**
   * The project folder's state, subscribed rather than read once.
   *
   * Two facts have to stay apart here, and this is where the earlier design had
   * them confused. `app.workspaceMode` is **derived** from the workspace and is
   * the answer to "where do writes land". This is the answer to "may the browser
   * still touch the folder you picked", and after a cold start those disagree: the
   * mode is `local-directory` while the grant is gone. Rendering the mode alone
   * would tell a user their folder is attached when every write is about to fail.
   *
   * `useSyncExternalStore` for the same reason as `useRuntimeState` — the
   * controller is a plain observable (`lib/observable.ts`), and this is the
   * adapter. It is a separate subscription from the runtime's because the folder
   * changes on a **click**, not on a turn, and coupling them would re-render the
   * transcript when a folder is picked.
   */
  const folder = useSyncExternalStore(
    app.projectFolder.state.subscribe,
    app.projectFolder.current,
    app.projectFolder.current,
  );

  /**
   * Whether this browser has a folder picker at all (`Plan.md` §14.1's table).
   *
   * Read per render rather than captured in a module constant: it is a
   * capability of the browser, and a test that installs a stub after import has
   * to hit the stub.
   */
  const pickerAvailable = isDirectoryPickerAvailable();

  /**
   * Move the whole app to a project, and re-read the transcript that belongs to it.
   *
   * **This is what makes the folder switch visible.** `openProjectFolder` used to
   * call `app.workspace.swap(...)` and stop there: the files changed, the
   * conversation did not, so opening project B showed project A's history. The
   * conversation is bound into the runtime, the tools and the store decorator, so it
   * takes a new `AppRuntime` — see `AppRuntime.switchProject`.
   *
   * The transcript is read **after** the swap and only then set, and it is cleared
   * first. Rendering the previous project's messages for the duration of an `await`
   * is the same bug one frame later, and a user who watches it happen will have seen
   * the wrong conversation twice.
   */
  const adoptProject = useCallback(
    async (target: ProjectTarget): Promise<void> => {
      setLiveError(undefined);
      setRead(undefined);
      const result = await app.switchProject(target);
      if (!mounted.current) return;
      if (result.kind !== "switched") {
        setLiveError(result.reason);
        return;
      }
      const next = result.app;
      setApp(next);
      // The new app has a new runtime and therefore a new session; reading through
      // it is what puts the right conversation on screen. A failed read is rendered
      // as the union's own `failed` variant, so "could not read" and "nothing there"
      // stay apart.
      const transcript = await next.runtime.readTranscript();
      if (!mounted.current) return;
      setRead(transcript);
    },
    [app],
  );

  /**
   * Pick a folder, and switch the app to the project it identifies.
   *
   * **This is the user gesture.** `requestPermission` is only legal inside it,
   * which is why the call is not wrapped in a timer, a `useEffect` or an
   * `await` before it — every one of those loses transient user activation and
   * the browser throws `SecurityError` (or, worse, prompts for something the
   * user did not ask for).
   *
   * The switch happens only on `connected`, so a refused or abandoned pick leaves
   * the current project in place rather than pointing the app at a folder the
   * browser will not let us touch.
   *
   * `pick()` resolves the project's own id from `.baah/project.json` — two folders
   * with the same name are two projects, because the name is a label and not an
   * identity.
   */
  const openProjectFolder = useCallback((): void => {
    setLiveError(undefined);
    app.projectFolder
      .pick()
      .then((next) => {
        if (!mounted.current) return;
        if (next.kind !== "connected") return;
        const identity = app.projectFolder.project();
        if (identity === undefined) return;
        void adoptProject({ identity });
      })
      .catch((cause: unknown) => {
        // Class name only, and never the message: a picker failure message can
        // quote the filesystem path the user is looking at. Same rule as
        // `lib/storage.ts` and `lib/settings.ts`.
        if (mounted.current) {
          setLiveError(
            `Der Ordner konnte nicht verbunden werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}.`,
          );
        }
      });
  }, [adoptProject, app]);

  /**
   * ## The sidebar is one thing with two shapes, not two sidebars
   *
   * Measured defect, at 390×844: `AppShell` is `flex h-screen`, the right column had
   * no `min-w-0`, so its automatic minimum width was its **max-content** — and
   * `WorkspacePanel`'s `modeExplanation` is one long German paragraph. At 390 px that
   * minimum exceeded the viewport, the chat column was squeezed to **exactly zero**,
   * and header, transcript and composer were all rendered *underneath* the sidebar.
   * Measured before the fix: chat column 0 px, composer 24 px, the narrowest text on
   * screen wrapping to **7 characters per line**.
   *
   * `min-w-0` on the right column was the obvious one-token fix and it is **not** one.
   * The left column is `flex-1` (basis 0) and the right is `0 1 auto`, so a
   * negative free space is scaled by `shrink × basis`: the left column's basis is
   * zero, it contributes nothing to the scaled shrink factor, and the *entire*
   * deficit is taken off the right column. The sidebar would land at 390 px, still
   * covering the whole viewport, and the chat column would still be 0 px. It fixes
   * the overflow and none of the defect.
   *
   * So below the width where two columns fit at all, the sidebar stops being a column
   * and becomes a **drawer**: not mounted unless it is open, and while open it is a
   * fixed overlay rather than a sibling that competes for width. The chat keeps the
   * full viewport. `lib/viewport.ts` carries the measurement and the threshold.
   *
   * Above the threshold this is the layout it always was — the same element, the
   * same classes, the same DOM — which is why the 1280 px screenshots and the 44
   * functional tests are unaffected.
   */
  const sidebarOpen = wide || drawerOpen;

  /**
   * A drawer that survives a rotation is a drawer that reopens over the chat the
   * user just came back to. Crossing the threshold upwards closes it, and it is not
   * reopened by crossing downwards — a phone that is rotated back finds the chat.
   */
  useEffect(() => {
    if (wide) setDrawerOpen(false);
  }, [wide]);

  /**
   * `Esc` closes the drawer, and only while it is actually open.
   *
   * `ChatView` already owns `Esc` for aborting a turn; this handler only reacts while
   * the overlay is on screen, which cannot overlap a turn the user is reading, and it
   * does not call `preventDefault` so it does not fight the abort path when both are
   * live.
   */
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

  /**
   * Monotonic token for the newest send.
   *
   * Two turns can be in flight in sequence before the first one's `finally` runs
   * (the user sends again while the first is settling), and without this the
   * older `finally` would install its read over the newer turn's. A ref, not state:
   * it is read and written inside async callbacks and never rendered.
   */
  const settleToken = useRef(0);

  /**
   * The transcript handed to the next turn, as `UIMessage[]`.
   *
   * `AGENTS.md` §3.1: `UIMessage[]` is the **storage truth**, and the loop is
   * constructed with the restored transcript. A turn that did not receive it would
   * start with an empty context, so the second turn of a conversation would not
   * know the first one happened.
   *
   * A ref, not state: it is written on every turn and read on the next `send`, and
   * putting it in state would cost a render for a value no component displays. It
   * is seeded from the runtime's own snapshot — which already holds the settled
   * `messages` of the last turn — and then updated from each `TurnResult`.
   */
  const messagesRef = useRef<readonly UIMessage[]>(state.messages);

  /* ---- boot: recovery, then the first read -------------------------- */

  /**
   * ## There is deliberately **no** `pagehide` close
   *
   * `opfs-sahpool` permits exactly one connection per origin (`Plan.md` §14.2), so
   * closing on `pagehide` looks like the obvious way to let the *next* document
   * claim the pool. **Measured, and it is the other way round:** with the close in
   * place, a reload of this very app came up on the boot-failure screen with a
   * `StorageError` — the departing document's worker still held the pool while the
   * arriving one tried to install it, and the close is asynchronous, so it loses the
   * race it was entered to win. Removing the handler made the reload boot cleanly.
   *
   * So the release is the platform's job. A dedicated worker context is destroyed
   * with its document, and `opfs-sahpool` needs no COOP/COEP precisely because its
   * handles are owned per context (`Plan.md` §14.2). A second *tab* is the case
   * §15.4's D2 is about, and there the refusal is the correct answer anyway: the
   * newcomer gets a typed `database_owned_by_another_context`, which is a fact
   * about the data rather than a corrupt file.
   *
   * `app.database` is still exposed, for the reason its own field says: a test has
   * to be able to ask what is actually on disk.
   */

  useEffect(() => {
    mounted.current = true;
    const run = async (): Promise<void> => {
      try {
        // The recovery first, then the read — and in that order. `boot()` marks
        // stale turns `interrupted` and closes their open parts, so a read that
        // ran first would show parts as `streaming` that the recovery is about to
        // mark `aborted`. Reading the state the boot produced is the only way the
        // transcript and the turn log agree.
        await runtime.boot();
      } catch (cause) {
        // Recovery already published the classified error into the snapshot
        // (`fail(error, "recovery")`), so this only has to say something.
        if (mounted.current) {
          setLiveError(
            `Die Wiederheralyse nach dem Neuladen ist fehlgeschlagen: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}.`,
          );
        }
      }
      const transcript = await runtime.readTranscript();
      if (mounted.current) setRead(transcript);
    };
    void run();
    return () => {
      mounted.current = false;
    };
  }, [runtime]);

  /* ---- the send path ------------------------------------------------ */

  const send = useCallback(
    (prompt: string): void => {
      setLiveError(undefined);
      // Drop the stored view for the duration of the turn. The live fold from the
      // event bus is the live turn's transcript, and rendering the last *stored*
      // one underneath it would put the same answer on screen twice.
      setRead(undefined);
      // Held, not chained onto `send`.
      //
      // A chain would render the transcript twice — once from the live fold, once
      // from the stored read — for as long as the read took, and would race the
      // next turn's `setRead(undefined)`. Holding a settle token and resolving the
      // read in a `finally` means: the live fold is the truth while a turn runs,
      // the stored read is the truth once it has, and never both.
      const token = settleToken.current + 1;
      settleToken.current = token;

      /**
       * The question is written by the **engine**, not here.
       *
       * `AgentTurn.#persistPrompt` puts the prompt into `messages` and `parts`
       * through the store seam before the first model call, and names the turn it
       * belongs to. The app used to do this itself — it had to, because the engine
       * only built the prompt in memory — and the two writers would now disagree
       * about the id, so the question would appear in the transcript **twice**.
       * `seq` also settles itself: the engine writes the prompt first, so it gets the
       * lower number and reads before its answer.
       */
      runtime
        .send({ prompt, messages: messagesRef.current })
        .then((result) => {
          messagesRef.current = result.messages;
        })
        .catch((cause: unknown) => {
          // The runtime classified this and put it in `state.lastError`; the
          // banner renders it. Here only the class name, because an
          // `Error.message` from a provider boundary can carry the key back
          // (Google's 401 does).
          if (mounted.current) {
            setLiveError(
              `Der Turn konnte nicht abgeschlossen werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}. Details stehen in der Statusleiste.`,
            );
          }
        })
        .finally(() => {
          // The token guards the *older* turn's `finally` from overwriting a newer
          // turn's state: a user who sends twice would otherwise have the first
          // turn's read land after the second turn's.
          if (!mounted.current || token !== settleToken.current) return;
          void runtime.readTranscript().then((transcript) => {
            if (mounted.current && token === settleToken.current) setRead(transcript);
          });
        });
    },
    [runtime],
  );

  const stop = useCallback((): void => {
    void runtime.stop();
  }, [runtime]);

  /**
   * Answer a card and let the paused turn continue.
   *
   * `Plan.md` §7.6: the SDK owns the pause and the resume, and the runtime's
   * `answerApproval` is the entry point. The loop is re-sent **with the tool
   * result**, which is the second request the approval scenario counts.
   */
  const answerApproval = useCallback(
    (approvalId: string, approved: boolean): void => {
      // The stored read is dropped for the duration of the continuation, **exactly
      // as `send` drops it for a turn**, and for the same reason: the live fold is
      // the truth while work is in progress, and the stored read is the truth once it
      // has settled.
      //
      // Without this the two views overlapped and the same tool call was rendered
      // twice — once from the stored row, once from the live fold — with two
      // different states, because the row was written from an earlier event. It did
      // not show before only because `send`'s re-read happened to land after the
      // resume's writes; that was a race, not a design, and the E2E suite's
      // `toolCardState` helper is a strict-mode locator that refuses to guess.
      setRead(undefined);
      const token = settleToken.current + 1;
      settleToken.current = token;
      runtime
        .answerApproval({ approvalId, approved })
        .then((result) => {
          if (result !== undefined) messagesRef.current = result.messages;
        })
        .catch((cause: unknown) => {
          if (mounted.current) {
            setLiveError(
              `Die Freigabe konnte nicht übertragen werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}.`,
            );
          }
        })
        .finally(() => {
          // The same token discipline as `send`, for the same reason: an answer
          // resumes the turn, and two answers in flight would race the reads.
          if (!mounted.current || token !== settleToken.current) return;
          void runtime.readTranscript().then((transcript) => {
            if (mounted.current && token === settleToken.current) setRead(transcript);
          });
        });
    },
    [runtime],
  );

  /**
   * `always` — record the grant for the action and resource the card named.
   *
   * `Plan.md` §7.5: the tool proposes the pattern, the user sees it, and the
   * answer stores it. Recording it is the difference between a third answer and a
   * second one: the *next* call of the same shape then runs without a card, which is
   * the entire promise the button makes. A card that labelled a button "immer"
   * without doing this would be a lie with a button on it.
   *
   * The `action` comes from the **card**, which read it off core's own
   * `DEFAULT_APPROVAL_TARGETS` — the same table `runtime/approval.ts` judges by. A
   * grant stored under a different action would never match, so `todo` would keep
   * asking even after the user said "immer".
   */
  const grantAlways = useCallback(
    (input: { readonly action: string; readonly resources: readonly string[] }): void => {
      runtime.approvals.engine
        .recordAlways(input.action, [...input.resources])
        .catch((cause: unknown) => {
          // A grant that could not be stored is visible, not silent: the user was
          // told a decision was remembered. `AGENTS.md` §5 forbids a bare `catch`,
          // and the card is the only place the difference is observable.
          if (mounted.current) {
            setLiveError(
              `Die Dauerfreigabe konnte nicht gespeichert werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}. Die nächste Anfrage fragt erneut.`,
            );
          }
        });
    },
    [runtime],
  );

  /* ---- the screen decision ------------------------------------------ */

  const summary = settings.summary();
  const wizardState: WizardState = useMemo(
    () => ({
      vendor: summary.provider?.vendor ?? "",
      baseUrl: summary.provider?.baseUrl ?? "",
      model: summary.provider?.model ?? "",
      hasKey: summary.keySlots.length > 0,
      // `WizardState["workspaceKind"]` is `"opfs" | "memory" | "none"` and does
      // not list `local-directory` — it was written when the folder was not
      // reachable at all. Its **only** two consumers are `!== "none"`
      // (`isConfigured`, `missingSteps`), so it is a boolean wearing three
      // values, and a picked folder answers "is a workspace configured?" with
      // yes. It is mapped to `"opfs"` here — the member that also means "a real,
      // durable workspace" — rather than widening a union in
      // `components/lib/onboarding.ts`, which this block does not own.
      //
      // What is **not** lost: the panel and the mode badge both render
      // `app.workspaceMode` directly, so the user is told `Lokaler Ordner`.
      // This field only decides whether the wizard is skipped.
      workspaceKind: app.workspaceMode === "local-directory" ? "opfs" : app.workspaceMode,
    }),
    [summary, app.workspaceMode],
  );
  const effective = screen ?? (isConfigured(wizardState) ? "workbench" : "onboarding");
  const banner = turnBanner(state, state.stall, live);
  const boot = bootNotice(state);

  if (effective === "onboarding") {
    return (
      <Onboarding
        provider={summary.provider?.vendor}
        baseUrl={summary.provider?.baseUrl}
        model={summary.provider?.model ?? ""}
        hasKey={summary.keySlots.length > 0}
        keySlot={summary.keySlots[0]}
        onProvider={(vendor, baseUrl) => {
          settings.update({ provider: { vendor, model: summary.provider?.model ?? "", baseUrl } });
        }}
        onApiKey={(slot, apiKey) => {
          settings.setApiKey(slot, apiKey);
        }}
        onModel={(model) => {
          const current = settings.summary().provider;
          settings.update({
            provider: { vendor: current?.vendor ?? "openai", model, ...(current?.baseUrl === undefined ? {} : { baseUrl: current.baseUrl }) },
          });
        }}
        onWorkspace={() => {
          // Choosing a sandbox in the wizard detaches a folder picked earlier, so
          // the panel cannot go on claiming "Lokaler Ordner" over a workspace the
          // user just left. It was a no-op before, which is how the mode and the
          // workspace could disagree without anything noticing.
          //
          // **Nothing is swapped here, and that is load-bearing.** An earlier
          // version did `app.workspace.swap(createMemoryWorkspace())` on the
          // assumption that the mode had to change immediately. It re-renders the
          // shell, `isConfigured` then sees provider + key + model + a workspace
          // and returns `true`, and the wizard is replaced by the workbench
          // **mid-step** — before the `done` step ever renders. Measured: 20 of
          // the 44 E2E scenarios died on a `baah-wizard-finish` locator that was
          // already gone.
          //
          // `release()` alone is correct and sufficient: it sets the folder state
          // to `no-handle`, and the derived `workspaceMode` follows on the next
          // read. The wizard keeps its own step, which is the whole point of a
          // wizard — the shell deciding which screen to show must not change while
          // the user is walking through one.
          //
          // **And the conversation is switched separately, and only once the wizard
          // is done.** A wizard that had already shown project B's transcript on its
          // way to the project-B step would be a leak of the previous project's
          // history into a screen the user has not finished. `onReleaseFolder` is
          // therefore followed by an explicit `adoptProject({ identity: undefined })`
          // from the caller, which is the one place that knows the wizard is finished.
          app.projectFolder.release().catch((cause: unknown) => {
            if (mounted.current) {
              setLiveError(
                `Der Ordner konnte nicht getrennt werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}.`,
              );
            }
          });
        }}
        onPickFolder={async () => {
          // The gesture. Same rule as `openProjectFolder` — no `setTimeout`, no
          // intervening `await`, or transient user activation is gone and
          // `requestPermission` throws.
          try {
            const next = await app.projectFolder.pick();
            if (next.kind === "connected") {
              const identity = app.projectFolder.project();
              if (identity === undefined) return false;
              await adoptProject({ identity });
              return true;
            }
            if (mounted.current) {
              setLiveError(
                next.kind === "needs-gesture"
                  ? "Der Browser hat die Freigabe nicht erteilt. Bitte den Ordner erneut auswählen."
                  : "Es konnte kein Ordner verbunden werden. Die App arbeitet im Sandbox-Workspace.",
              );
            }
            return false;
          } catch (cause) {
            if (mounted.current) {
              setLiveError(
                `Der Ordner konnte nicht verbunden werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}.`,
              );
            }
            return false;
          }
        }}
        onProbe={() => runtime.probe()}
        onFinish={() => setScreen("workbench")}
        onSkip={() => setScreen("workbench")}
      />
    );
  }

  return (
    <div className="flex h-screen min-h-0">
      {/*
       * `data-testid={TEST_IDS.chat}` — the one handle a spec needs on the chat
       * region, and it lives in `src/lib/testids.ts` with the rest of the
       * contract. It is here because `e2e/question-card-layout.e2e.ts` asserts
       * that the chat and the sidebar are still two columns above 1024 px, and
       * the only alternative to a testid was a Tailwind class.
       *
       * The name is `baah-chat`, deliberately **not** `baah-chat-column`: the
       * file's naming rule says a testid says what it is, not where it sits, and
       * "column" is a `flex-row`/`flex-1` decision that may change without
       * anything breaking. That rule is a contract, so the first writer to need a
       * handle adds the name there rather than next to the markup.
       */}
      <div data-testid={TEST_IDS.chat} className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-base-300 px-4 py-2">
          {/*
           * The drawer toggle, and it is **only** rendered below the threshold.
           *
           * Above it the sidebar is a permanent column and a button claiming to
           * toggle something that cannot be toggled is a lie with a click handler on
           * it. `aria-expanded` carries the real state, and `aria-controls` names the
           * region it opens, so the relationship survives being read out.
           */}
          <button
            type="button"
            data-testid={TEST_IDS.sidebarToggle}
            className="btn btn-ghost btn-xs lg:hidden"
            aria-expanded={sidebarOpen}
            aria-controls="baah-sidebar"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            Menü
          </button>
          <h1 className="text-sm font-bold">baah</h1>
          <span className="badge badge-ghost badge-sm">browser-only · kein Server</span>
          {/*
           * `Plan.md` §5.3's standing requirement — the mode has to be **visible**,
           * or a Firefox user expects writes on their disk that never happen — is the
           * one thing a drawer-by-default would quietly take away on the form factor
           * where it matters most. So the panel's own badge is repeated in the header
           * while the panel itself is out of sight.
           *
           * A second element with the mode, so it gets a second attribute name
           * (`data-baah-workspace-mode-badge`) rather than a duplicate
           * `data-baah-workspace-mode`: two nodes claiming to be *the* mode is a
           * strict-mode locator's problem and a reader's.
           */}
          <WorkspaceModeBadge mode={app.workspaceMode} />
          <button
            type="button"
            data-testid="baah-open-settings"
            className="btn btn-ghost btn-xs ml-auto"
            onClick={() => {
              const next = !settingsOpen;
              setSettingsOpen(next);
              // Below the threshold the panel lives inside the drawer, so toggling
              // the state alone would flip a boolean that renders into an **unmounted**
              // sidebar: the button would be a dead control on the form factor where
              // it is most needed. Turning the panel *on* therefore opens the drawer
              // that holds it. Turning it off leaves the drawer alone — the user can
              // still see the todos and the workspace panel behind it.
              if (next && !wide) setDrawerOpen(true);
            }}
          >
            Einstellungen
          </button>
        </header>

        {app.bootProblems.map((problem) => (
          // Said, not swallowed: a browser that would not store the session id
          // starts a new session on the next reload, and a user who finds that out
          // by reloading has lost the conversation. `AGENTS.md` §5.
          <p key={problem} data-baah-boot-problem="true" role="alert" className="border-b border-warning/50 bg-warning/10 px-4 py-1 text-xs">
            {problem}
          </p>
        ))}
        {boot !== undefined && (
          <p data-baah-boot="recovered" className="border-b border-base-300 px-4 py-1 text-xs opacity-80">
            {boot.message}
          </p>
        )}
        {liveError !== undefined && (
          <p data-baah-runtime-error="true" role="alert" className="border-b border-error/50 px-4 py-1 text-xs">
            {liveError}
          </p>
        )}
        {state.lastError !== undefined && (
          <p
            data-baah-runtime-error-code={state.lastError.code}
            role="alert"
            className="border-b border-error/50 px-4 py-1 text-xs"
          >
            {state.lastError.code}: {state.lastError.message}
          </p>
        )}
        {banner.warnings.map((warning) => (
          <p key={warning} data-baah-storage-warning="true" className="border-b border-warning/50 px-4 py-1 text-xs">
            {warning}
          </p>
        ))}

        <Transcript
          state={state}
          live={live}
          read={read}
          stop={state.stall}
          answerApproval={answerApproval}
          grantAlways={grantAlways}
        />

        <QuestionCard state={questions} />

        <ChatView
          running={state.status === "running"}
          disabled={!isConfigured(wizardState)}
          disabledReason={missingReason(wizardState)}
          onSend={send}
          onStop={stop}
        />
      </div>

      {/*
       * The backdrop. A `button`, not a `div` with an `onClick`, because it is the
       * dismissal affordance a keyboard and a screen reader need to reach — a
       * click-only overlay is unreachable for both. It is mounted only while the
       * drawer is open, so it never intercepts a pointer that belongs to the chat.
       */}
      {drawerOpen && !wide && (
        <button
          type="button"
          data-testid={TEST_IDS.sidebarBackdrop}
          aria-label="Menü schließen"
          className="fixed inset-0 z-30 cursor-default bg-black/50 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/*
       * The same column as before, below the threshold a `position: fixed` overlay
       * instead of a flex sibling.
       *
       * `max-lg:` rather than `lg:` on purpose: above the threshold **no** class on
       * this element changes, so the wide layout is bit-for-bit the one the desktop
       * screenshots and the functional suite were written against. Below it the
       * element leaves the flex row entirely — that is the fix, not a width on it —
       * and `w-80 max-w-[85vw]` keeps it usable on a 320 px phone. `overflow-y-auto`
       * because the three blocks inside it are taller than 844 px together on a
       * phone with a task list.
       *
       * `max-lg:bg-base-100` is **load-bearing** and was not visible in any
       * measurement. Every width in this column read correct while the drawer was
       * still unusable: the transcript behind it showed straight through and two sets
       * of German sentences were drawn on top of each other. An overlay has to paint
       * its own surface — as a static column it inherited the page background and
       * needed none. Found by looking at the screenshot: a bounding box cannot tell
       * you that a background is transparent.
       */}
      {sidebarOpen && (
        <div
          id="baah-sidebar"
          className="flex flex-col border-l border-base-300 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:w-80 max-lg:max-w-[85vw] max-lg:overflow-y-auto max-lg:bg-base-100 max-lg:shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-base-300 px-3 py-2 lg:hidden">
            <span className="text-sm font-semibold">Aufgaben &amp; Workspace</span>
            <button
              type="button"
              data-testid={TEST_IDS.sidebarClose}
              className="btn btn-ghost btn-xs"
              onClick={() => setDrawerOpen(false)}
            >
              Schließen
            </button>
          </div>

          <TodoSidebar todos={todos} />
          <WorkspacePanel
            mode={app.workspaceMode}
            onOpen={openProjectFolder}
            folder={folder}
            pickerAvailable={pickerAvailable}
            onRefresh={() => {
              void runtime.readTranscript().then((transcript) => {
                if (mounted.current) setRead(transcript);
              });
            }}
          />
          {settingsOpen && (
            <SettingsPanel
              settings={settings}
              runtime={runtime}
              onOpenWizard={() => setScreen("onboarding")}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function missingReason(state: WizardState): string | undefined {
  if (isConfigured(state)) return undefined;
  const parts: string[] = [];
  if (state.vendor === "") parts.push("Provider");
  if (!state.hasKey) parts.push("API-Key");
  if (state.model.trim() === "") parts.push("Modell");
  return `Es fehlt noch: ${parts.join(", ")}. Ohne diese Angaben kann kein Turn laufen — der Browser liest keine Umgebungsvariablen (Plan.md §9).`;
}

/**
 * The runtime's snapshot, in React.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the runtime replaces
 * the snapshot wholesale and `subscribeState` is exactly the contract
 * `useSyncExternalStore` wants, so a subscriber that mounts late sees the current
 * value instead of waiting for the next change.
 */
export function useRuntimeState(runtime: AppRuntime["runtime"]): RuntimeState {
  return useSyncExternalStore(runtime.subscribeState, runtime.getState, runtime.getState);
}

/**
 * The live turn, folded from the engine's events.
 *
 * The runtime's `text` buffer mixes reasoning into the answer text
 * (`handleEvent` appends both), so the snapshot cannot be the source for a live
 * transcript. The bus forwards the events verbatim and the fold keeps the two
 * apart — which is `Plan.md` §5.1's lesson about a reasoning delta persisted as
 * text, one layer up.
 *
 * ## The fold is emptied on `turn-settled`, and that is load-bearing
 *
 * The stored read and the live fold are two views of the same turn. Once the turn
 * has settled, the read carries it — authoritatively, from the database — and the
 * fold is history. Clearing it on `turn-settled` rather than on the next
 * `attempt-started` is what stops the answer appearing **twice**: the live row
 * appended below the stored messages, with the live row's text a few characters
 * different from the stored one because the last deltas had not been flushed.
 *
 * ## … except when the turn *parked*, which is the exception that decides the feature
 *
 * A turn that stops for an approval is **not settled**: `AgentTurn.run` resolves with
 * `outcome: "awaiting-approval"` and the SDK is holding the loop open until
 * `respondToApproval` sends the answer (`packages/baah-core/src/agent/loop.ts:817-834`).
 * `settle` is still called for it — the runtime does not special-case the outcome —
 * so an unconditional clear on `turn-settled` wiped `openApprovals` and the approval
 * card vanished the instant it appeared, leaving a turn parked forever on a question
 * no one could answer.
 *
 * The test for "settled" is therefore the **outcome**, not the event: `turn-settled`
 * with `awaiting-approval` keeps the fold. It is also the only correct behaviour on
 * the read side. The engine persists an `approval-requested` tool part
 * (`TurnStore.upsertPart`, awaited, from the same events this fold sees), but a
 * **stored** read does not replace the fold while the turn is open: the fold is what
 * holds `openApprovals`, and that list exists only here. Clearing it would not be a
 * cosmetic loss but the end of the turn — a parked turn whose card cannot be found
 * is a turn no one can finish.
 */
export function useLiveTurn(runtime: AppRuntime["runtime"]): LiveTurn {
  const [live, setLive] = useState<LiveTurn>(EMPTY_LIVE_TURN);

  useEffect(() => {
    setLive(EMPTY_LIVE_TURN);
    return runtime.subscribe((event) => {
      if (event.kind === "turn-settled") {
        // The snapshot has already been updated when the bus fires
        // (`runtime/index.ts`'s `settle` publishes first), so clearing here cannot
        // race the read that the same event's caller kicks off.
        //
        // …unless the turn is parked on an approval, in which case there is no later
        // event to bring it back. See the header.
        if (event.result.outcome === "awaiting-approval") return;
        setLive(EMPTY_LIVE_TURN);
        return;
      }
      if (event.kind !== "agent") return;
      setLive((current) => applyAgentEvent(current, event.event as AgentEvent));
    });
  }, [runtime]);

  return live;
}

export { Transcript, ChatView, TodoSidebar, QuestionCard, Onboarding, SettingsPanel, WorkspacePanel };

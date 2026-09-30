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
import { SettingsPanel } from "./SettingsPanel.tsx";
import { TodoSidebar } from "./TodoSidebar.tsx";
import { Transcript } from "./Transcript.tsx";
import { WorkspacePanel } from "./WorkspacePanel.tsx";
import type { AppRuntime } from "./lib/runtime.ts";
import { applyAgentEvent, EMPTY_LIVE_TURN, type LiveTurn } from "./lib/transcript.ts";
import { bootNotice, turnBanner } from "./lib/turn-view.ts";
import { isConfigured, type WizardState } from "./lib/onboarding.ts";

export type Screen = "onboarding" | "workbench";

export interface AppShellProps {
  readonly app: AppRuntime;
  /** Overridden by a test. `undefined` means "decide from the settings". */
  readonly initialScreen?: Screen;
}

/**
 * Persist a tool invocation, and report a failure rather than swallowing it.
 *
 * ## Why this is a separate hook and not part of `useLiveTurn`
 *
 * `useLiveTurn` folds events into a *view*; this writes them to the *store*. They have
 * different failure modes, and a view must not fail because a write did — so the write
 * is fire-and-report and never awaited into the fold.
 *
 * The four events are the four states a `tool` part can be in, and they map one to one
 * onto the SDK's `UIToolInvocation` states, so a reloaded card says the same thing a
 * live one does. `tool-outcome-unknown` is **not** among them: it gets its own node (a
 * banner), because a card that claimed an outcome would be the lie `Plan.md` §5.1 is
 * written against.
 */
function useToolPartRecorder(
  app: AppRuntime,
  runtime: AppRuntime["runtime"],
  onWarning: (message: string) => void,
  isMounted: () => boolean,
): void {
  useEffect(() => {
    const write = (input: Parameters<AppRuntime["recordToolInvocation"]>[0]): void => {
      void app.recordToolInvocation(input).catch((cause: unknown) => {
        if (!isMounted()) return;
        onWarning(
          `Der Werkzeugaufruf konnte nicht in den Verlauf geschrieben werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}. ` +
            "Die Karte ist nur in dieser Sitzung sichtbar.",
        );
      });
    };

    return runtime.subscribe((event) => {
      if (event.kind !== "agent") return;
      const agent = event.event;
      switch (agent.type) {
        case "tool-call":
          write({ toolCallId: agent.toolCallId, toolName: agent.toolName, state: "input-available", value: agent.input });
          return;
        case "tool-result":
          write({ toolCallId: agent.toolCallId, toolName: agent.toolName, state: "output-available", value: agent.output });
          return;
        case "tool-error":
          write({ toolCallId: agent.toolCallId, toolName: agent.toolName, state: "output-error", value: agent.error });
          return;
        case "tool-output-denied":
          // `output-denied`, not `output-error`: `Plan.md` §7.6 — a refusal is a
          // legitimate answer the model reads and routes around, and a card wearing
          // the failure state would tell the user the tool broke.
          write({ toolCallId: agent.toolCallId, toolName: agent.toolName, state: "output-denied" });
          return;
        default:
          return;
      }
    });
  }, [app, runtime, onWarning, isMounted]);
}

export function AppShell({ app, initialScreen }: AppShellProps) {
  const { runtime, settings, questions, todos } = app;
  const state = useRuntimeState(runtime);
  const live = useLiveTurn(runtime);
  const [screen, setScreen] = useState<Screen | undefined>(initialScreen);
  const [read, setRead] = useState<TranscriptRead | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveError, setLiveError] = useState<string | undefined>();
  const mounted = useRef(true);

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
   * Writes the tool parts the engine does not persist.
   *
   * Called before the boot effect so the subscription exists before the first event
   * can arrive — a hook order change would silently drop the first tool card, and a
   * test asserting `provider.count()` would still pass.
   */
  const isMounted = useCallback((): boolean => mounted.current, []);
  useToolPartRecorder(
    app,
    runtime,
    useCallback((message: string) => setLiveError(message), []),
    isMounted,
  );

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

      // The question into the log, before the turn. `AGENTS.md` §3.1: `UIMessage[]`
      // is the storage truth, and the engine only builds the prompt in memory — so
      // without this the transcript shows answers with their questions missing.
      // Awaited before `send` so `seq` puts the question first; a failure is
      // reported and the turn still runs, because a user who cannot send anything
      // has no way to act on the error at all.
      app.recordUserMessage(prompt)
        .catch((cause: unknown) => {
          if (mounted.current) {
            setLiveError(
              `Die Frage konnte nicht in den Verlauf geschrieben werden: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}.`,
            );
          }
        })
        .then(() =>
          // The previous transcript, per `AGENTS.md` §3.1.
          runtime.send({ prompt, messages: messagesRef.current }),
        )
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
    [app, runtime],
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
      workspaceKind: app.workspaceMode,
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
        onWorkspace={() => undefined}
        onProbe={() => runtime.probe()}
        onFinish={() => setScreen("workbench")}
        onSkip={() => setScreen("workbench")}
      />
    );
  }

  return (
    <div className="flex h-screen min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-base-300 px-4 py-2">
          <h1 className="text-sm font-bold">baah</h1>
          <span className="badge badge-ghost badge-sm">browser-only · kein Server</span>
          <button
            type="button"
            data-testid="baah-open-settings"
            className="btn btn-ghost btn-xs ml-auto"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            Einstellungen
          </button>
        </header>

        {app.ephemeralTranscript && (
          // Repeated here as well as in the workspace panel, because this is the
          // screen a user actually looks at. A warning that only exists behind a
          // settings toggle is a warning nobody reads.
          <p data-baah-ephemeral-banner="true" className="border-b border-warning/50 bg-warning/10 px-4 py-1 text-xs">
            Arbeitsspeicher-Datenbank: Der Verlauf übersteht <strong>keinen</strong> Reload. Für dauerhafte
            Daten ist die SQLite-Anbindung aus `Plan.md` §6 nötig.
          </p>
        )}

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

      <div className="flex flex-col border-l border-base-300">
        <TodoSidebar todos={todos} />
        <WorkspacePanel
          mode={app.workspaceMode}
          ephemeralTranscript={app.ephemeralTranscript}
          onOpen={() => undefined}
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
 * the read side. The engine persists no tool parts, so the open approval exists
 * *only* in the fold — a stored read cannot replace it, which makes clearing the
 * fold not merely a cosmetic loss but the end of the turn.
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

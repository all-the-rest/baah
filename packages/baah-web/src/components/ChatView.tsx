/**
 * The composer: send, stop, and the "no model catalog" honesty.
 *
 * ## Stop, and what it is not
 *
 * `runtime.stop()` aborts the provider fetch (`Plan.md` §14.4 — resume is
 * impossible, `reconnectToStream()` always returns `null`). The button says what
 * happens to the provider's work: the model may keep generating and be billed for
 * it. A stop button that quietly says "Stopp" invites a user to believe the tokens
 * are saved, and `§5.4`'s cost note says they are not.
 *
 * ## Enter sends, `Esc` stops
 *
 * `Plan.md` §15.5 lists both as UI requirements, and both are here: `Enter` sends,
 * `Shift+Enter` inserts a newline, and `Esc` stops a running turn.
 */
import { useEffect, useState } from "react";

import { TEST_IDS } from "../lib/testids.ts";
import { UNTRUSTED_NOTE } from "./lib/trust.ts";

export interface ChatViewProps {
  readonly running: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | undefined;
  readonly onSend: (prompt: string) => void;
  readonly onStop: () => void;
}

export function ChatView(props: ChatViewProps) {
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && props.running) {
        event.preventDefault();
        props.onStop();
      }
    };
    // On `window`, not on the textarea: `Esc` has to work wherever the focus is,
    // and a user who clicked a tool card to read it should not have to click back
    // into the composer to abort.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const submit = (): void => {
    const trimmed = prompt.trim();
    if (trimmed === "" || props.disabled) return;
    setPrompt("");
    props.onSend(trimmed);
  };

  return (
    <form
      data-testid="baah-composer"
      className="border-t border-base-300 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {props.disabled && props.disabledReason !== undefined && (
        <p data-baah-composer-disabled="true" className="mb-2 rounded-box border border-warning/60 p-2 text-xs">
          {props.disabledReason}
        </p>
      )}

      {/*
       * The reminder, once, and small. Everything the agent reads is untrusted
       * (Plan.md §4.1), and the model is the party that has to be careful — so the
       * note tells the *user* what the harness does about it, which is the thing
       * they are in a position to verify.
       */}
      <p {...{ "data-baah-provenance": "untrusted" }} className="mb-2 text-xs opacity-60">
        {UNTRUSTED_NOTE}
      </p>

      <div className="flex items-end gap-2">
        <textarea
          data-testid="baah-composer-input"
          className="textarea textarea-bordered min-h-16 flex-1"
          rows={2}
          value={prompt}
          disabled={props.disabled}
          placeholder="Womit soll der Agent anfangen?"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // `Enter` sends, `Shift+Enter` does not. A composer that swallows
            // `Enter` without a visible alternative is a composer people fight.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {props.running ? (
          <button
            type="button"
            data-testid={TEST_IDS.stopTurn}
            className="btn btn-outline btn-error"
            onClick={props.onStop}
          >
            Stopp
          </button>
        ) : (
          <button
            type="submit"
            data-testid="baah-composer-send"
            className="btn btn-primary"
            disabled={props.disabled || prompt.trim() === ""}
          >
            Senden
          </button>
        )}
      </div>
      <p className="mt-1 text-xs opacity-60">
        Enter sendet, Shift+Enter macht eine neue Zeile, Esc bricht ab. Nach einem Abbruch kann der Provider
        weiterarbeiten und abrechnen — die bereits erzeugten Tokens sind nicht erstattungsfähig
        (Plan.md §5.4).
      </p>
    </form>
  );
}

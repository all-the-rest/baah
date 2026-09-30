/**
 * The onboarding wizard — `Plan.md` §8.1, step by step.
 *
 * ## Four steps, and the constraints that are not negotiable
 *
 * provider → key (+ **connection probe**) → model → workspace, with a closing
 * step. `§8.1` also says the wizard must be **skippable** and re-openable from
 * the settings, so the "Überspringen" link is part of the spec rather than an
 * escape hatch: a user with a provider they cannot reach today must still be able
 * to get to the app, and a user who skips it lands in a chat that says what is
 * missing.
 *
 * ## What this wizard does *not* do
 *
 * - **No proxy** (`AGENTS.md` §2). A provider that blocks the browser is not
 *   supported; the wizard says so and does not work around it.
 * - **No model catalogue.** `§8.1` step 4 asks for one and `§9` names
 *   `@opencode-ai/models` as the source, but it is not wired in this build. The
 *   field is a free-text model id and the wizard **says** that a catalogue is
 *   absent — a hard-coded list would be a list that goes stale silently and gets
 *   blamed for a provider error.
 * - **No OpenCode Zen.** Not in `providers/catalog.ts` (`§9`: Preflight 404, no
 *   ACAO, "nicht darum herum designen"), and `catalog.test.ts` asserts the
 *   absence so adding one is a decision somebody makes on purpose.
 *
 * ## The probe's result is rendered as four different things
 *
 * `§9` measured that OpenAI's inference endpoints send no ACAO on the error path,
 * so a browser sees an opaque `Failed to fetch` — identical to being offline. A
 * wizard that showed "fehlgeschlagen" would train the user to blame their key for
 * a provider policy, which `§9` says is exactly backwards. So
 * `probeView` returns four sentences and this component renders the one that
 * matches, and the `cors-blocked` row says **the key works and chat will fail**.
 */
import { useState } from "react";

import { PROVIDER_CATALOG, findProvider, type ProviderEntry } from "../providers/catalog.ts";
import type { ConnectionProbeReport } from "../providers/probe.ts";
import { TEST_ATTRIBUTES, TEST_IDS } from "../lib/testids.ts";
import {
  defaultBaseUrl,
  probeView,
  splitVendor,
  STEP_TITLE,
  vendorId,
  WIZARD_STEPS,
  type ProbeView,
  type WizardStep,
} from "./lib/onboarding.ts";

export interface OnboardingProps {
  /** The stored vendor id, suffix included — see `splitVendor`. */
  readonly provider: string | undefined;
  /** The stored base URL, so a re-opened wizard does not blank a working one. */
  readonly baseUrl: string | undefined;
  readonly model: string;
  readonly hasKey: boolean;
  /** Where the key lives, as a slot name. Never the value. */
  readonly keySlot: string | undefined;
  readonly onProvider: (vendor: string, baseUrl: string) => void;
  readonly onApiKey: (slot: string, apiKey: string) => void;
  readonly onModel: (model: string) => void;
  /**
   * The chosen workspace.
   *
   * `"local-directory"` is new and is **not** handled here — it cannot be, because
   * choosing a folder needs a user gesture and a native dialog, and this step's
   * buttons call `go("done")` immediately afterwards. It is wired in `AppShell`,
   * which calls `projectFolder.pick()` from its own click handler and keeps the
   * wizard on this step until the user is actually connected. See
   * `components/WorkspacePanel.tsx` for the same path from the sidebar.
   */
  readonly onWorkspace: (kind: "opfs" | "memory") => void;
  /**
   * Open the folder picker. The wizard advances **only** if a grant comes back,
   * which is why this is a callback returning a promise rather than a plain
   * `onClick`: a dismissed dialog must leave the user on this step instead of
   * landing in a chat that claims a folder it does not have.
   */
  readonly onPickFolder: () => Promise<boolean>;
  /** §8.1 step 3's connection test. Never throws for a provider problem. */
  readonly onProbe: () => Promise<ConnectionProbeReport>;
  readonly onFinish: () => void;
  readonly onSkip: () => void;
}

/**
 * The wizard as the settings remember it.
 *
 * `Plan.md` §8.1: the wizard must be re-openable from the settings, and a
 * re-openable wizard that starts blank is a wizard that loses the configuration when
 * the user walks forward through it. Three things have to be hydrated, and each one
 * has a concrete failure if it is not:
 *
 * | hydrated from | what breaks without it |
 * |---|---|
 * | `provider` **split** on `:` | no row is selected, the label is lost, the slot name changes and the stored key is orphaned |
 * | `baseUrl` | the `Weiter` on the provider step writes an empty base URL over a working one |
 * | `hasKey` | the probe button stays disabled, so §8.1's "Verbindung testen" is unreachable on the screen it is written for |
 *
 * `model` was already seeded from the props; it is in the table for that reason.
 */
export function Onboarding(props: OnboardingProps) {
  const [step, setStep] = useState<WizardStep>("provider");
  const [vendor, setVendor] = useState(() => splitVendor(props.provider).id);
  const [baseUrl, setBaseUrl] = useState(() => {
    // The stored value wins, including when it is `""` for a row that has no default
    // — a stored `""` is a fact about the provider, and a catalog default would
    // silently replace the choice the user made.
    if (props.baseUrl !== undefined) return props.baseUrl;
    const restored = findProvider(vendor);
    return restored === undefined ? "" : defaultBaseUrl(restored);
  });
  const [label, setLabel] = useState(() => splitVendor(props.provider).label);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(props.model);
  const [report, setReport] = useState<ConnectionProbeReport | undefined>();
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | undefined>();
  // A key that is already in the store needs no re-saving before the probe, and
  // the button's own guard (`!saved`) would otherwise make the connection test
  // unreachable the second time the user opens the wizard.
  const [saved, setSaved] = useState(props.hasKey);
  /** A folder pick is in flight; the step is held until the browser answers. */
  const [picking, setPicking] = useState(false);

  const entry = findProvider(vendor);
  const fullVendor = vendorId(vendor, label);
  const slot = vendorId(vendor, label);
  const index = WIZARD_STEPS.indexOf(step);

  const go = (next: WizardStep): void => {
    setProbeError(undefined);
    setStep(next);
  };

  const runProbe = async (): Promise<void> => {
    setProbing(true);
    setProbeError(undefined);
    setReport(undefined);
    try {
      setReport(await props.onProbe());
    } catch (error) {
      // The runtime classifies a probe failure itself (`fail(error, "provider")`)
      // and never throws for a provider problem; what reaches here is a request
      // it could not even address — an unknown vendor, a missing endpoint or key.
      // The class name only: an `Error.message` from a boundary can carry a key.
      setProbeError(
        `Der Verbindungstest konnte nicht durchgeführt werden: ${error instanceof Error ? error.name : "unbekannter Fehler"}.`,
      );
    } finally {
      setProbing(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-bold">baah</h1>
        <p className="mt-1 text-sm opacity-80">
          Browser as a Harness. Alles läuft in diesem Tab: kein Server, keine Installation, kein Konto.
          Schlüssel und Verlauf liegen in diesem Browser.
        </p>
      </header>

      {/*
       * §8.1's own words, and the reason they are on the first screen: a user who
       * does not know where their data goes will not paste a key.
       */}
      <p className="rounded-box border border-base-300 bg-base-200/40 p-2 text-xs">
        Dein API-Key wird ausschließlich in diesem Browser gespeichert und nur an den Provider geschickt, den
        du wählst. Beim Export wird er weggelassen, außer du aktivierst das ausdrücklich.
      </p>

      <ol className="flex flex-wrap gap-1 text-xs">
        {WIZARD_STEPS.map((candidate, at) => (
          <li
            key={candidate}
            data-baah-wizard-step={candidate}
            aria-current={candidate === step ? "step" : undefined}
            className={`rounded-field px-2 py-1 ${candidate === step ? "bg-primary text-primary-content" : "opacity-60"}`}
          >
            {at + 1}. {STEP_TITLE[candidate]}
          </li>
        ))}
      </ol>

      <h2 className="text-lg font-semibold">{STEP_TITLE[step]}</h2>

      {step === "provider" && (
        <section className="flex flex-col gap-3">
          {PROVIDER_CATALOG.map((candidate) => (
            <ProviderRow
              key={candidate.id}
              entry={candidate}
              selected={candidate.id === vendor}
              onSelect={() => {
                setVendor(candidate.id);
                setBaseUrl(defaultBaseUrl(candidate));
                setLabel("");
              }}
            />
          ))}
          {entry?.needsEndpoint === true && (
            <>
              <label className="form-control">
                <span className="label-text">Bezeichnung (nur ein Label, wird nie Teil der URL)</span>
                <input
                  data-testid="baah-wizard-provider-label"
                  className="input input-bordered"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="groq"
                />
              </label>
              <label className="form-control">
                <span className="label-text">Base-URL</span>
                <input
                  data-testid="baah-wizard-provider-baseurl"
                  className="input input-bordered"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://api.groq.com/openai/v1"
                />
              </label>
            </>
          )}
          {entry?.baseUrl !== undefined && entry.needsEndpoint !== true && (
            <p className="font-mono text-xs opacity-70">Endpunkt: {defaultBaseUrl(entry)}</p>
          )}
          <button
            type="button"
            data-testid="baah-wizard-next-provider"
            className="btn btn-primary self-start"
            onClick={() => {
              props.onProvider(fullVendor, baseUrl);
              go("model");
            }}
          >
            Weiter
          </button>
        </section>
      )}

      {step === "key" && (
        <section className="flex flex-col gap-3">
          <p className="text-sm">
            Slot <code data-testid={TEST_IDS.settingsKeySlot}>{slot}</code>
            {props.hasKey ? " — es ist bereits ein Key hinterlegt." : " — dort wird der Key abgelegt."}
          </p>
          <label className="form-control">
            <span className="label-text">API-Key</span>
            <input
              data-testid="baah-wizard-api-key"
              type="password"
              autoComplete="off"
              className="input input-bordered"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          {/*
           * §8.1 step 3: "Eingabe + 'Verbindung testen' (minimaler Call)". The
           * probe is the *only* way to settle §9's unconfirmed rows, so it is on
           * this step rather than hidden behind a settings screen.
           *
           * Disabled until the key is **saved**, because `probeFromSettings` reads
           * it out of the store rather than out of component state — that is the
           * point of the function (`providers/probe.ts`: a component that received
           * an `apiKey` prop could render it, log it and pass it down). Probing
           * before the save would test a key the app does not have.
           */}
          <button
            type="button"
            data-testid="baah-wizard-probe"
            className="btn btn-outline self-start"
            disabled={probing || !saved}
            onClick={() => {
              void runProbe();
            }}
          >
            {probing ? "Teste …" : "Verbindung testen"}
          </button>
          {!saved && <p className="text-xs opacity-70">Speichere den Key zuerst — der Test liest ihn aus dem Store.</p>}
          {probeError !== undefined && (
            <p data-baah-probe="error" role="alert" className="rounded-box border border-error/60 p-2 text-sm">
              {probeError}
            </p>
          )}
          {report !== undefined && <ProbeResult view={probeView(report)} />}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="baah-wizard-save-key"
              className="btn btn-primary"
              onClick={() => {
                props.onApiKey(slot, apiKey);
                setApiKey("");
                setSaved(true);
              }}
            >
              Key speichern
            </button>
            <button type="button" data-testid="baah-wizard-next-key" className="btn" onClick={() => go("workspace")}>
              Weiter
            </button>
          </div>
        </section>
      )}

      {step === "model" && (
        <section className="flex flex-col gap-3">
          {/*
           * `§8.1` step 4 asks for a catalogue with context length and price, and
           * `§9` names `models.dev` as the source. **It is not wired in this
           * build**, and the wizard says so instead of inventing a list: a
           * hard-coded model table is a table that goes stale silently, and a
           * stale table produces a model error the user cannot diagnose.
           *
           * This step comes **before** the key — see `WIZARD_STEPS` for why: the
           * connection test addresses a model, so it cannot run without one.
           */}
          <p data-baah-model-catalog="absent" className="rounded-box border border-base-300 p-2 text-sm">
            Es ist kein Modellkatalog eingebunden. Trage die Modell-ID so ein, wie dein Provider sie
            anzeigt — die Liste des Providers ist die Quelle, nicht eine hier hinterlegte Tabelle.
          </p>
          <label className="form-control">
            <span className="label-text">Modell-ID</span>
            <input
              data-testid="baah-wizard-model"
              className="input input-bordered"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="gpt-4o-mini"
            />
          </label>
          <button
            type="button"
            data-testid="baah-wizard-next-model"
            className="btn btn-primary self-start"
            onClick={() => {
              props.onModel(model);
              go("key");
            }}
          >
            Weiter
          </button>
        </section>
      )}

      {step === "workspace" && (
        <section className="flex flex-col gap-3">
          {/*
           * §5.3's two modes, and the reason the mode must be visible: a Firefox
           * user who expects writes on their disk and gets a sandbox has lost
           * work twice — once by expecting it, once by not exporting.
           */}
          <button
            type="button"
            data-testid="baah-wizard-workspace-opfs"
            className="btn btn-primary self-start"
            onClick={() => {
              props.onWorkspace("opfs");
              go("done");
            }}
          >
            Sandbox im Browser (OPFS)
          </button>
          <button
            type="button"
            data-testid="baah-wizard-workspace-memory"
            className="btn self-start"
            onClick={() => {
              props.onWorkspace("memory");
              go("done");
            }}
          >
            Nur im Arbeitsspeicher
          </button>
          {/*
           * The third option, and the one `AGENTS.md` §2a calls the truth source.
           *
           * It was a paragraph saying the feature was not offered, and that
           * paragraph was the reason the project folder was unreachable. It is now
           * a button: `AppShell` wires it to `projectFolder.pick()`, which is a
           * user gesture, and the wizard only advances once the browser reports a
           * live grant. A dismissed dialog leaves the user on this step rather
           * than claiming a folder they did not grant.
           *
           * The Chromium note stays, because §14.1's table is still true — it just
           * no longer means "therefore nothing".
           */}
          <button
            type="button"
            data-testid="baah-wizard-workspace-folder"
            className="btn btn-outline self-start"
            onClick={() => {
              // The gesture is this click. `void`-ing the promise would let the
              // wizard advance optimistically, which is the lie this step must
              // not tell — so the step is held until the browser has answered.
              setPicking(true);
              props
                .onPickFolder()
                .then((connected) => {
                  if (connected) go("done");
                })
                .finally(() => setPicking(false));
            }}
            disabled={picking}
          >
            Eigenen Projektordner verwenden
          </button>
          <p className="text-xs opacity-70">
            Der eigene Ordner schreibt direkt auf deine Platte und ist die Wahrheitsquelle für Dateien und
            Verlauf. Er braucht einen Klick und eine Browserfreigabe — die Freigabe überlebt keinen Kaltstart,
            nach dem Neuladen muss der Ordner erneut verbunden werden (Plan.md §14.1, Chromium-only).
          </p>
        </section>
      )}

      {step === "done" && (
        <section className="flex flex-col gap-3">
          <p className="text-sm">Fertig. Du landest im Chat.</p>
          <p className="rounded-box border border-base-300 p-2 text-xs">
            Vorschlag zum ersten Schritt: „erkläre mir dieses Projekt“.
          </p>
          <button type="button" data-testid="baah-wizard-finish" className="btn btn-primary self-start" onClick={props.onFinish}>
            Los
          </button>
        </section>
      )}

      {index < WIZARD_STEPS.length - 1 && (
        <button type="button" data-testid="baah-wizard-skip" className="btn btn-ghost btn-sm self-start" onClick={props.onSkip}>
          Überspringen
        </button>
      )}
    </main>
  );
}

/** One provider row, with §9's note and the `corsVerified` flag stated. */
function ProviderRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ProviderEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`baah-wizard-provider-${entry.id}`}
      data-baah-cors-verified={String(entry.corsVerified)}
      aria-pressed={selected}
      onClick={onSelect}
      className={`rounded-box border p-3 text-left ${selected ? "border-primary bg-primary/10" : "border-base-300"}`}
    >
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{entry.label}</span>
        {/*
         * The flag, as words. §9's OpenAI row is "unbestätigt aus dem Browser",
         * and the note under it says a failed test means the *provider* blocks the
         * call, not that the key is wrong. A wizard that hid this would produce
         * exactly the wrong conclusion the matrix exists to prevent.
         */}
        <span
          data-baah-cors-state={entry.corsVerified ? "verified" : "unconfirmed"}
          className={`badge badge-sm ${entry.corsVerified ? "badge-success" : "badge-warning"}`}
        >
          {entry.corsVerified ? "CORS bestätigt" : "CORS unbestätigt"}
        </span>
        {entry.requiresBrowserHeader && <span className="badge badge-ghost badge-sm">Sonderheader nötig</span>}
      </span>
      <span className="mt-1 block text-xs opacity-80">{entry.note}</span>
    </button>
  );
}

/**
 * The probe's verdict.
 *
 * Four different tones, four different sentences — see the module header. The
 * `data-baah-outcome` is the outcome+verdict pair, so a spec asserts the verdict
 * and not a colour or a class.
 */
function ProbeResult({ view }: { view: ProbeView }) {
  const toneClass =
    view.tone === "ok" ? "border-success/60 bg-success/10" : view.tone === "warning" ? "border-warning/60 bg-warning/10" : view.tone === "error" ? "border-error/60 bg-error/10" : "border-base-300";
  return (
    <div
      data-testid={TEST_IDS.providerProbeResult}
      {...{ [TEST_ATTRIBUTES.outcome]: view.outcome }}
      data-baah-probe-tone={view.tone}
      role="status"
      className={`rounded-box border p-3 ${toneClass}`}
    >
      <p className="text-sm font-semibold">{view.headline}</p>
      {view.detail !== "" && (
        <p data-testid={TEST_IDS.providerProbeDetail} className="mt-1 text-xs">
          {view.detail}
        </p>
      )}
      {view.warnBeforeContinuing && (
        <p className="mt-1 text-xs font-semibold">
          Du kannst fortfahren — dann wird der Chat voraussichtlich fehlschlagen. Es gibt keinen Proxy, der das
          behebt (AGENTS.md §2).
        </p>
      )}
    </div>
  );
}

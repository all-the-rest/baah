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
 * - **No bundled model catalogue.** `§8.1` step 4 asks for one and `§9` names
 *   `@opencode-ai/models` as a source; the wizard reads the **provider's own**
 *   `/models` instead (`providers/models.ts`), and says why in the panel below. A
 *   hard-coded table is a second truth about something that already has a first
 *   one, and it goes stale silently and then gets blamed for a provider error.
 *   The free-text model-id field stays either way: the provider's list can be
 *   incomplete, and a user whose model is missing must have somewhere to type it.
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
import type { ModelList } from "../providers/models.ts";
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
  /**
   * §8.1 step 4's model list, read from the provider itself.
   *
   * **Required, and it was optional for a while the loader was unreachable.** The
   * prop existed with a "the absence is not an error" contract while
   * `AppShell` passed nothing — so the wizard rendered the "no catalogue"
   * paragraph, `ModelList.complete` was a return value no screen read, and the
   * whole feature was a module. It is wired now, and the optional type and the
   * paragraph are **gone with it** (`AGENTS.md` §5: a branch no caller can reach
   * is a second statement of what the product does, and this one was false).
   *
   * It is a callback rather than an `apiKey` for the reason `probe.ts` exists: a
   * component holding the key can render it, log it and put it in a dependency
   * array. `AppShell` passes `() => runtime.listModels()`, and the key is read out
   * of the store at the moment of the call.
   */
  readonly onListModels: () => Promise<ModelList>;
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
  const [models, setModels] = useState<ModelList | undefined>();
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelListError, setModelListError] = useState<string | undefined>();

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
      //
      // The **code**, for the same reason as the model list below: what arrives is
      // a `RuntimeError`, so `error.name` was the literal string „RuntimeError" and
      // the `missing_model` / `missing_api_key` distinction the probe's own error
      // class draws never reached the screen. The message is not shown either — a
      // boundary's own text is the one shape that can carry a key.
      setProbeError(
        `Der Verbindungstest konnte nicht durchgeführt werden: ${errorCode(error) ?? "unbekannter Fehler"}.`,
      );
    } finally {
      setProbing(false);
    }
  };

  const runModelList = async (): Promise<void> => {
    setLoadingModels(true);
    setModelListError(undefined);
    try {
      setModels(await props.onListModels());
    } catch (error) {
      // **The `code`, not the class name** — and this is not a style preference.
      //
      // `AppShell` wires `runtime.listModels`, and the runtime classifies every
      // failure: what reaches here is a `RuntimeError`, so `error.name` was the
      // literal string **„RuntimeError"** on every one of the loader's six codes.
      // The user was told the class of the app's own wrapper and nothing else.
      //
      // `runtime/index.ts` maps each of `ModelListError`'s six codes onto its own
      // `RuntimeErrorCode`, and those are the words that say what to do next —
      // `model-list-missing-endpoint` means "fill in the base URL", which is
      // different from `model-list-http-error` ("the provider refused you") and
      // from `model-list-unreachable` ("it is blocked or offline").
      //
      // The message is deliberately **not** shown: a boundary's own text is the one
      // shape that can carry a key, and the code plus a fixed German sentence is
      // what a user can act on.
      setModelListError(
        `Die Modellliste konnte nicht geladen werden: ${errorCode(error) ?? "unbekannter Fehler"}.`,
      );
    } finally {
      setLoadingModels(false);
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
           * `§8.1` step 4 asks for a catalogue with context length and price.
           *
           * **The list comes from the provider's own `/models`**
           * (`providers/models.ts`), not from a table shipped with the app: §9
           * measured `/v1/models` as the one endpoint that sends ACAO even on a
           * 401, and a bundled catalogue would be a second truth about something
           * that already has a first one — one that goes stale silently and then
           * gets blamed for a provider error.
           *
           * It is a **button, not an automatic fetch**. The wizard is skippable
           * (`§8.1`) and the list is one network call per press; loading it on
           * arrival would put a provider round trip in front of every user who
           * only came to look at the workspace. The failure is rendered as its own
           * line, not as an empty list, and the free-text field below is never
           * removed: a list the provider reported as **incomplete** is exactly the
           * case where the user needs to type an id the list did not contain.
           *
           * There **was** a second paragraph here — „Es ist kein Modellkatalog
           * eingebunden" — rendered when no `onListModels` was passed. It was the
           * truth about the build while the prop had no caller, and a **lie** the
           * moment `AppShell` started passing one: a user would have been told the
           * catalogue does not exist while a "Modelle laden" button sat above it.
           * Both the paragraph and the optional type are gone (§5), and
           * `e2e/model-list.e2e.ts` asserts `data-baah-model-catalog="absent"` has
           * **zero** matches, so a reintroduction is a red test rather than a
           * contradiction two paragraphs down.
           */}
          <button
            type="button"
            data-testid={TEST_IDS.modelListLoad}
            className="btn btn-outline self-start"
            disabled={loadingModels}
            onClick={() => {
              void runModelList();
            }}
          >
            {loadingModels ? "Lade …" : "Modelle laden"}
          </button>
          {modelListError !== undefined && (
            <p data-baah-model-list="error" role="alert" className="rounded-box border border-error/60 p-2 text-sm">
              {modelListError}
            </p>
          )}
          {models !== undefined && <ModelListPanel list={models} onPick={(id) => setModel(id)} />}
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

/**
 * The `code` of a classified error, or `undefined` when there is none.
 *
 * ## Why this reads `code` and not `name`
 *
 * Both callbacks in this component (`runProbe`, `runModelList`) are handed a
 * promise that goes through `runtime/index.ts`'s `toRuntimeError`, so **every**
 * failure arrives as a `RuntimeError`. Rendering `error.name` therefore printed the
 * literal string **„RuntimeError"** — the class of the app's own wrapper, in German,
 * on a wizard a non-technical user is looking at. The information the boundary
 * worked to produce was one property away and never read.
 *
 * `code` is that property, and it is the one the runtime was careful about:
 * `MODEL_LIST_CODES` maps each of the loader's six codes to its own
 * `RuntimeErrorCode` so this can say `model-list-missing-endpoint` rather than
 * "something went wrong".
 *
 * **Never `error.message`.** A provider boundary can quote the key back — Google's
 * 401 does — and this string is rendered, screenshotted and pasted into issues
 * (`AGENTS.md` §2). The `code` is drawn from a closed union of literals in this
 * repo, so it cannot carry a credential.
 *
 * Returns `undefined` rather than a name so the caller decides what the fallback
 * word is: "unbekannter Fehler" is a statement about *our* vocabulary, and a thrown
 * string or a plain object has none.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * The provider's model list, and what it does not contain.
 *
 * ## Why the incomplete notice is not a footnote
 *
 * `ModelList.complete` is `false` when the loader stopped before the end of the
 * provider's pagination — a page cap, or a `has_more: true` with no cursor to
 * advance by. Showing those models without saying so is the same lie as a
 * truncated `grep` search: the user picks from a list that is missing entries,
 * and nothing in the product told them. So the notice is above the `<select>`,
 * not under it, and `data-baah-model-list="incomplete"` is a node a spec can
 * assert on.
 *
 * The `<select>` labels are the provider's own `display_name` where it sent one
 * and the raw id where it did not — a `claude-haiku-4-5-20251001` in a dropdown
 * is a worse answer than the same id plus the name the provider knew.
 */
function ModelListPanel({ list, onPick }: { list: ModelList; onPick: (id: string) => void }) {
  if (list.models.length === 0) {
    return (
      <p data-testid={TEST_IDS.modelListPanel} data-baah-model-list="empty" className="text-sm">
        Der Provider hat unter dieser Adresse keine Modelle gemeldet.
      </p>
    );
  }

  return (
    <div data-testid={TEST_IDS.modelListPanel} data-baah-model-list={list.complete ? "complete" : "incomplete"}>
      {list.complete ? (
        <p className="text-xs opacity-70">
          {list.models.length} Modelle, aus der Liste des Providers ({list.pages} Seiten).
        </p>
      ) : (
        <p data-baah-model-list-incomplete="true" className="rounded-box border border-warning/60 p-2 text-sm">
          Unvollständig: {list.incompleteReason} Du siehst {list.models.length} von mindestens so vielen Modellen —
          ein Modell, das hier fehlt, kann es sehr wohl geben. Trage die ID oben ein, wenn du es nicht findest.
        </p>
      )}
      <label className="form-control">
        <span className="label-text">Modell aus der Liste des Providers</span>
        <select
          data-testid={TEST_IDS.modelListSelect}
          className="select select-bordered"
          value=""
          onChange={(event) => {
            onPick(event.target.value);
          }}
        >
          <option value="">— Liste wählen —</option>
          {list.models.map((info) => (
            <option key={info.id} value={info.id}>
              {info.displayName} ({info.id})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * The CORS verdict, as words.
 *
 * ## Three states, three sentences
 *
 * The old badge had two: „CORS bestätigt" and „CORS unbestätigt", and the
 * second one covered both *measured-and-negative* (OpenAI, §9) and
 * *never-measured* (every `openai-compatible` entry — §9's own row for an
 * arbitrary compatible `baseURL` reads "zur Laufzeit prüfen"). Those are
 * different facts with different next steps, and collapsing them told a user
 * with an unmeasured endpoint that somebody had already looked and found
 * nothing good.
 *
 * `data-baah-cors-state` carries the state verbatim so a spec asserts the verdict
 * rather than a colour, and `data-baah-cors-verified` stays for the strict
 * boolean it has always been — one attribute that lost a distinction, kept
 * because it is the older contract, not hidden behind the new one.
 *
 * **A `switch` and not a lookup table.** A `Record<CorsVerdict, …>` indexed by a
 * union reads back as `… | undefined` under this repo's compiler settings, so a
 * fourth state added next month would compile and render `undefined` as a badge.
 * The switch is total: adding a state without a branch here is a type error at
 * the one place a user would read it.
 */
function corsBadge(cors: ProviderEntry["cors"]): { readonly label: string; readonly className: string } {
  switch (cors) {
    case "verified":
      return { label: "CORS bestätigt", className: "badge-success" };
    case "unconfirmed":
      return { label: "CORS unbestätigt", className: "badge-warning" };
    case "unmeasured":
      return { label: "CORS ungemessen", className: "badge-ghost" };
  }
}

function ProviderRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ProviderEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const badge = corsBadge(entry.cors);

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
         * The verdict, as words. §9's OpenAI row is "unbestätigt aus dem Browser"
         * and the note under it says a failed test means the *provider* blocks the
         * call, not that the key is wrong. A wizard that hid this would produce
         * exactly the wrong conclusion the matrix exists to prevent — and an
         * "ungemessen" badge is what stops it happening for an endpoint nobody
         * has ever called.
         */}
        <span data-baah-cors-state={entry.cors} className={`badge badge-sm ${badge.className}`}>
          {badge.label}
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

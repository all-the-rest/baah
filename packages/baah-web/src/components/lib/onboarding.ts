/**
 * Onboarding: `Plan.md` §8.1, and §9's measured CORS matrix.
 *
 * ## The probe's honest result is not a boolean
 *
 * §9 measured, per provider:
 *
 * ```
 * GET  /v1/models             → 401 + access-control-allow-origin: *
 * POST /v1/chat/completions   → 401 + (kein ACAO)
 * POST /v1/responses          → 401 + (kein ACAO)
 * ```
 *
 * So a browser calling the inference endpoint against OpenAI does not get a 401 —
 * it gets an opaque `TypeError: Failed to fetch`, **the same thing it gets when
 * the network is down**, and the browser deliberately does not tell the two apart.
 * A wizard that showed "Verbindung fehlgeschlagen" would train the user to blame
 * their key for a provider policy, which §9 says is exactly backwards.
 *
 * So the probe's four outcomes are four *different* sentences, and
 * `cors-blocked` is the one the wizard exists for:
 *
 * | outcome | what the wizard says |
 * |---|---|
 * | `ok` | the key works and chat is reachable |
 * | `cors-blocked` | **the key works, but chat will fail from a browser** |
 * | `unreachable` | no route to the host at all — offline, wrong base URL, host down |
 * | `http-error` + `key-rejected` | the key is wrong; retrying changes nothing |
 *
 * The `cors-blocked` row is reported **as such and the wizard still lets the user
 * continue** — with a warning, not a wall. `AGENTS.md` §2 forbids the fix: a
 * provider that blocks the browser is *not supported*, and the honest response is
 * the explanation, not a proxy. Saying "this will not work" and letting the user
 * try anyway is more useful than a dead end, and more honest than silence.
 *
 * ## Anthropic's header, and why the wizard mentions it
 *
 * Without `anthropic-dangerous-direct-browser-access: true`, Anthropic's 401
 * carries no ACAO and a wrong key becomes an indistinguishable network error. The
 * SDK does not set the header; `providers/factories.ts` does, at the registry.
 * The wizard's copy says so, because a user who reads "network error" and never
 * learns the header was missing has no way to act.
 *
 * ## No model catalogue
 *
 * `Plan.md` §8.1 step 4 asks for a catalogue with context length and price, and
 * `@opencode-ai/models` (models.dev, CORS `*` per §9) is the documented source.
 * **It is not wired in this build** and the wizard says so rather than inventing a
 * list — a hard-coded model table is a table that goes stale silently and gets
 * blamed for a provider error. The field is a free-text model id with a link to
 * the provider's own documentation.
 *
 * ## OpenCode Zen
 *
 * Absent from `providers/catalog.ts` and absent here, and `catalog.test.ts` asserts
 * the absence so adding one is a decision somebody has to make on purpose (§9:
 * Preflight 404, error path without ACAO, "nicht darum herum designen").
 */
import type { ConnectionProbeReport, ProbeOutcome, ProbeVerdict } from "../../providers/probe.ts";
import { PROVIDER_CATALOG, findProvider, type ProviderEntry } from "../../providers/catalog.ts";

/** The wizard's steps. */
export type WizardStep = "provider" | "model" | "key" | "workspace" | "done";

/**
 * ## The order differs from `Plan.md` §8.1, and the reason is the probe
 *
 * §8.1 lists provider → key (+ connection test) → model → workspace. That order
 * makes the connection test **impossible on a first run**: the probe's second
 * request addresses a *model* (`POST …/{model}:generateContent` for Google,
 * `model` in the body for the OpenAI-shaped vendors — `probe.ts`), so with no
 * model stored it throws `missing_model` before any request leaves the browser.
 *
 * Two options existed:
 *
 * 1. Keep §8.1's order and make the probe reachable only after the model is
 *    known — which means it never runs on a first run, and §8.1 step 3's
 *    "Verbindung testen" is dead code on exactly the screen it is written for.
 * 2. Ask for the model before the key.
 *
 * (2) is taken. It moves one step and keeps every part of §8.1 intact: the probe
 * is still on the key step, still reads the key **out of the store** rather than
 * from component state (`probe.ts` exists for that reason), and still explains
 * itself. Asking for a model id before a key costs one field on a screen the user
 * is already filling in; the alternative costs the feature.
 *
 * A user who leaves the model blank can still skip (`§8.1`: the wizard must be
 * skippable) — but then the probe button says why it is unavailable rather than
 * failing with `missing_model`.
 */
export const WIZARD_STEPS: readonly WizardStep[] = ["provider", "model", "key", "workspace", "done"];

/** The German heading per step. */
export const STEP_TITLE: Readonly<Record<WizardStep, string>> = {
  provider: "Provider wählen",
  model: "Modell wählen",
  key: "API-Key hinterlegen",
  workspace: "Workspace wählen",
  done: "Fertig",
};

/* ------------------------------------------------------------------ */
/* The probe verdict                                                   */
/* ------------------------------------------------------------------ */

/** The four tones the probe result can take. */
export type ProbeTone = "ok" | "warning" | "error" | "info";

export interface ProbeView {
  readonly tone: ProbeTone;
  /** `data-baah-outcome`, so a spec asserts the verdict and not a colour. */
  readonly outcome: string;
  /** One sentence. The headline. */
  readonly headline: string;
  /** Why, in sentences. May be empty. */
  readonly detail: string;
  /**
   * `true` when continuing is a *known* dead end and the wizard says so.
   *
   * The wizard still allows it: `AGENTS.md` §2 forbids the fix, so refusing
   * outright would leave the user with nothing, and pretending it works would be
   * the lie. Warning + proceed is the honest combination.
   */
  readonly warnBeforeContinuing: boolean;
}

/** The four outcomes, four sentences. Never collapsed into "fehlgeschlagen". */
export function probeView(report: ConnectionProbeReport): ProbeView {
  const entry = findEntry(report.vendor);
  return {
    tone: toneFor(report.outcome, report.verdict),
    outcome: `${report.outcome}:${report.verdict}`,
    headline: report.summary,
    detail: detailFor(report, entry),
    warnBeforeContinuing: report.outcome === "cors-blocked" || report.outcome === "unreachable",
  };
}

function toneFor(outcome: ProbeOutcome, verdict: ProbeVerdict): ProbeTone {
  switch (outcome) {
    case "ok":
      return "ok";
    case "cors-blocked":
      // `warning`, not `error`: the key works, and the *chat* path is blocked.
      // A red box here teaches the user their key is wrong, which §9 says is the
      // one conclusion they must not draw.
      return "warning";
    case "unreachable":
      return "error";
    case "http-error":
      return verdict === "key-rejected" || verdict === "rate-limited" ? "error" : "warning";
  }
}

function detailFor(report: ConnectionProbeReport, entry: ProviderEntry | undefined): string {
  const lines: string[] = [];

  if (report.outcome === "cors-blocked") {
    lines.push(
      "Gemessen: die Modelliste antwortet mit einem CORS-Header, der Inferenz-Aufruf nicht. " +
        "Das ist exakt der Befund aus Plan.md §9 für OpenAI.",
    );
    lines.push(
      "Heißt: der Key ist gültig, aber der Chat-Aufruf wird aus dem Browser scheitern. " +
        "Der Browser zeigt dann nur noch „Failed to fetch“ — das ist der Provider, nicht dein Key.",
    );
    lines.push(
      "Es gibt keinen Umweg: AGENTS.md §2 verbietet einen Proxy, und ein Provider, der Browser-Aufrufe " +
        "blockt, ist damit nicht unterstützt. Du kannst trotzdem fortfahren — dann wird der Chat fehlschlagen.",
    );
  } else if (report.outcome === "unreachable") {
    lines.push(
      "Weder die Modelliste noch der Inferenz-Endpunkt waren erreichbar. Das liegt an der Verbindung " +
        "oder an der Base-URL, nicht am Key.",
    );
  } else if (report.verdict === "key-rejected") {
    lines.push("Der Provider hat den Key abgelehnt. Wiederholen ändert nichts — bitte den Key prüfen.");
  } else if (report.verdict === "rate-limited") {
    lines.push("Der Provider drosselt diesen Key (429). Nach Plan.md §5.4 wird das nicht automatisch wiederholt.");
  }

  if (entry?.requiresBrowserHeader === true) {
    lines.push(
      "Anthropic braucht den Header `anthropic-dangerous-direct-browser-access: true`; baah setzt ihn " +
        "automatisch. Ohne ihn sieht ein falscher Key wie ein Netzwerkfehler aus.",
    );
  }

  if (report.corsVerifiedInPlan === false) {
    lines.push(
      "Plan.md §9 führt diesen Provider als „aus dem Browser unbestätigt“. Der Verbindungstest ist der " +
        "einzige Weg, das zu klären — die CORS-Matrix kann es nicht.",
    );
  }

  const elapsed = report.endpoints.inference.elapsedMs;
  if (report.endpoints.models.result === "answered" && report.endpoints.inference.result === "answered") {
    lines.push(`Antwortzeiten: Modelliste ${String(elapsed)} ms, Inferenz ${String(report.endpoints.inference.elapsedMs)} ms.`);
  }

  return lines.join(" ");
}

function findEntry(vendor: string): ProviderEntry | undefined {
  const base = vendor.split(":")[0] ?? vendor;
  return PROVIDER_CATALOG.find((entry) => entry.id === base);
}

/* ------------------------------------------------------------------ */
/* The base URL                                                        */
/* ------------------------------------------------------------------ */

/**
 * The E2E build's provider endpoint, or `""`.
 *
 * `vite.config.ts` defines `import.meta.env.BAAH_E2E_PROVIDER_BASE_URL` to the
 * faked origin under `--mode e2e` and to `""` otherwise, and
 * `e2e/support/provider.ts` intercepts that origin. Reading it here is what lets
 * the suite reach a model with no real key and no network.
 *
 * **Empty outside the E2E build**, so a production bundle carries no test seam —
 * the same property the define block in `vite.config.ts` documents.
 */
export function e2eProviderBaseUrl(): string {
  const value = import.meta.env.BAAH_E2E_PROVIDER_BASE_URL;
  return typeof value === "string" ? value : "";
}

/**
 * The base URL the wizard prefills.
 *
 * The catalog's own `baseUrl` where it has one (§9's measured endpoints), and
 * the E2E override in an E2E build. `""` for `openai-compatible`, which has no
 * default — `providers/catalog.ts` marks that row `needsEndpoint` and
 * `factories.ts` raises a named `ProviderError` without a base URL, so a prefilled
 * value here would be a value the user never chose.
 */
export function defaultBaseUrl(entry: ProviderEntry): string {
  const override = e2eProviderBaseUrl();
  if (override !== "" && entry.id === "openai") return override;
  return entry.baseUrl ?? "";
}

/* ------------------------------------------------------------------ */
/* The vendor id                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the stored `vendor` id from the wizard's inputs.
 *
 * `apiKeySlot` splits on the **first** colon, so a custom entry is
 * `openai-compatible:<label>` or `anthropic-compatible:<label>` and the label is
 * a *label* — it never becomes part of a URL (`ids.ts` documents the round trip,
 * and `factories.ts` documents that the name is not a URL).
 *
 * ## The test is `entry.needsEndpoint`, not the vendor's name
 *
 * It used to be `if (base !== "openai-compatible") return base;` — a hardcoded
 * list of one. The second shape, `anthropic-compatible`, arrived and the same
 * question had to be asked about it: *is this a row the user fills in, or a
 * vendor with its own endpoint?* That is exactly what `needsEndpoint` means in
 * the catalog, and it is now the test.
 *
 * ⚠️ **What this does NOT fix, named rather than implied.** A template row whose
 * label is blank still comes out of here as the **bare** id —
 * `vendorId("anthropic-compatible", "  ") === "anthropic-compatible"` — and
 * `createProviderModel` refuses a shape with no label (`missing_name`). So the
 * wizard's `Weiter` can still write a configuration the app then rejects, with no
 * field on screen explaining why.
 *
 * That is **pre-existing and identical for both templates**, so it is not a
 * regression and this block did not make it worse. It is also **not fixed here**:
 * refusing to advance, or synthesising a label, would be a product decision about
 * the wizard's flow, and a half-made one is worse than a stated gap. The gap is
 * pinned by `onboarding.test.ts` › "a blank label produces a bare template id, for
 * both rows alike" so the next reader finds it in a test rather than having to
 * re-derive it from a comment that used to imply it was closed.
 */
export function vendorId(base: string, label: string | undefined): string {
  if (findProvider(base)?.needsEndpoint !== true) return base;
  const trimmed = (label ?? "").trim();
  return trimmed === "" ? base : `${base}:${trimmed}`;
}

/**
 * The inverse of {@link vendorId}: a stored id back into the row and the label.
 *
 * ## Why the wizard needs it
 *
 * `Plan.md` §8.1 requires the wizard to be re-openable from the settings ("später
 * aus den Settings erneut aufrufbar"). A re-opened wizard that takes the stored
 * string as a *catalog id* finds nothing — `findProvider("openai-compatible:e2e")`
 * is `undefined` — and then:
 *
 * - the base-URL field starts **empty**, so the next `Weiter` writes an empty base
 *   URL over a working configuration;
 * - the label field starts empty, so the slot name silently changes and the stored
 *   key is orphaned;
 * - the selected row is no row, because no row's id equals a suffixed string.
 *
 * So this is not a cosmetic restore: without it, re-opening the wizard and walking
 * forward **destroys** the configuration the user already has. `apiKeySlot` splits
 * on the first colon (`ids.ts`), so the split here is on the first colon too.
 */
export function splitVendor(stored: string | undefined): { readonly id: string; readonly label: string } {
  if (stored === undefined || stored === "") return { id: "openai", label: "" };
  const at = stored.indexOf(":");
  if (at === -1) return { id: stored, label: "" };
  return { id: stored.slice(0, at), label: stored.slice(at + 1) };
}

/* ------------------------------------------------------------------ */
/* Completeness                                                        */
/* ------------------------------------------------------------------ */

export interface WizardState {
  readonly vendor: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly hasKey: boolean;
  readonly workspaceKind: "opfs" | "memory" | "none";
}

export function isConfigured(state: WizardState): boolean {
  return state.vendor !== "" && state.model.trim() !== "" && state.hasKey && state.workspaceKind !== "none";
}

/** What is still missing, in the order the wizard asks for it. */
export function missingSteps(state: WizardState): readonly WizardStep[] {
  const missing: WizardStep[] = [];
  if (state.vendor === "") missing.push("provider");
  if (state.model.trim() === "") missing.push("model");
  if (!state.hasKey) missing.push("key");
  if (state.workspaceKind === "none") missing.push("workspace");
  return missing;
}

/**
 * The wizard's own decisions, with no DOM.
 *
 * `Onboarding.tsx` is a component and its rendering is Playwright's job. What lives
 * here is the set of decisions that are **not** rendering: the step order, the
 * vendor-id round trip, and the completeness check. Each of them is a place where
 * the wrong value costs a user their configuration rather than a pixel.
 */
import { describe, expect, it } from "vitest";

import { isConfigured, missingSteps, probeView, splitVendor, vendorId, WIZARD_STEPS } from "./onboarding.ts";

describe("WIZARD_STEPS", () => {
  it("asks for the model before the key, because the probe addresses a model", () => {
    // `Plan.md` §8.1's letter is provider → key (+ test) → model. Taken literally the
    // connection test is impossible on a first run: `probe.ts` throws `missing_model`
    // before any request leaves the browser, so §8.1 step 3 is dead code on exactly
    // the screen it was written for. The order is the wizard's decision and it is
    // asserted here so a reorder cannot happen silently.
    expect(WIZARD_STEPS).toEqual(["provider", "model", "key", "workspace", "done"]);
    expect(WIZARD_STEPS.indexOf("model")).toBeLessThan(WIZARD_STEPS.indexOf("key"));
  });

  it("keeps the probe on the key step, where §8.1 puts it", () => {
    // The probe reads the key out of the store, so it has to be reachable after the
    // key step and before the wizard ends.
    expect(WIZARD_STEPS.indexOf("key")).toBeGreaterThan(0);
    expect(WIZARD_STEPS.indexOf("key")).toBeLessThan(WIZARD_STEPS.length - 1);
  });
});

describe("the vendor id", () => {
  it("appends a label to BOTH template rows, and to no other", () => {
    // The label exists so a second user-filled provider can have its own key slot;
    // for every row with a known endpoint there is exactly one and a label would be
    // a second name for the same thing.
    //
    // **Both templates, not just `openai-compatible`.** The test was titled
    // "appends a label only for `openai-compatible`" and had no
    // `anthropic-compatible` case at all — so mutation m15 (the hardcoded
    // `base !== "openai-compatible"` that this function replaced) survived the
    // whole suite, because every assertion in it happened to be about the row that
    // the mutation still handled correctly. A title that names one shape is a test
    // that checks one shape.
    expect(vendorId("openai-compatible", "e2e")).toBe("openai-compatible:e2e");
    expect(vendorId("anthropic-compatible", "e2e")).toBe("anthropic-compatible:e2e");
    // A label the user typed as the vendor's own name is still just a label.
    expect(vendorId("anthropic-compatible", "anthropic")).toBe("anthropic-compatible:anthropic");

    // …and no other row grows one.
    for (const firstParty of ["openai", "anthropic", "google"]) {
      expect(vendorId(firstParty, "e2e"), firstParty).toBe(firstParty);
    }
  });

  it("a blank label produces a bare template id, for both rows alike", () => {
    // A whitespace-only label is the same as none. **The consequence is that
    // `createProviderModel` refuses it with `missing_name`** — a template row with
    // no label is not a usable configuration, and the wizard's `Weiter` writes it
    // anyway. That is pre-existing and identical for both rows (F10, LOW: not a
    // regression), and it is asserted here rather than left for a reader to
    // discover: a test that only asserted the bare id would pass against a
    // `vendorId` that had stopped trimming.
    expect(vendorId("openai-compatible", "  ")).toBe("openai-compatible");
    expect(vendorId("anthropic-compatible", "  ")).toBe("anthropic-compatible");
    expect(vendorId("openai-compatible", undefined)).toBe("openai-compatible");
    expect(vendorId("anthropic-compatible", undefined)).toBe("anthropic-compatible");
    // A label with whitespace *around* it is trimmed rather than stored verbatim —
    // otherwise the key slot becomes `"openai-compatible: groq"` and a stored key
    // under the untrimmed name is orphaned.
    expect(vendorId("openai-compatible", "  groq  ")).toBe("openai-compatible:groq");
    expect(vendorId("anthropic-compatible", "  groq  ")).toBe("anthropic-compatible:groq");
  });

  it("round-trips through `splitVendor`", () => {
    for (const label of ["e2e", "groq", "ein label mit leerzeichen"]) {
      expect(splitVendor(vendorId("openai-compatible", label))).toEqual({ id: "openai-compatible", label });
    }
    expect(splitVendor("openai")).toEqual({ id: "openai", label: "" });
  });

  it("splits on the **first** colon, like `apiKeySlot` does", () => {
    // `ids.ts` documents that the slot name splits on the first colon. A split on the
    // last one would put `openai-compatible` in the label and the key in the base,
    // and the round trip would not hold.
    expect(splitVendor("openai-compatible:a:b")).toEqual({ id: "openai-compatible", label: "a:b" });
  });

  it("falls back to the `openai` row for a fresh install", () => {
    // A wizard that opened with no row selected and an empty base URL is a wizard
    // whose first `Weiter` writes a URL nobody chose.
    expect(splitVendor(undefined)).toEqual({ id: "openai", label: "" });
    expect(splitVendor("")).toEqual({ id: "openai", label: "" });
  });
});

describe("completeness", () => {
  const complete = { vendor: "openai-compatible:e2e", baseUrl: "https://x.invalid/v1", model: "m", hasKey: true, workspaceKind: "memory" } as const;

  it("needs all four answers before a turn can run", () => {
    expect(isConfigured(complete)).toBe(true);
    expect(isConfigured({ ...complete, vendor: "" })).toBe(false);
    expect(isConfigured({ ...complete, model: "  " })).toBe(false);
    expect(isConfigured({ ...complete, hasKey: false })).toBe(false);
    expect(isConfigured({ ...complete, workspaceKind: "none" })).toBe(false);
  });

  it("lists what is missing in the order the wizard asks for it", () => {
    expect(missingSteps({ ...complete, vendor: "", model: "", hasKey: false, workspaceKind: "none" })).toEqual([
      "provider",
      "model",
      "key",
      "workspace",
    ]);
    expect(missingSteps(complete)).toEqual([]);
  });
});

describe("probeView", () => {
  const report = {
    vendor: "openai",
    outcome: "cors-blocked",
    verdict: "unknown",
    summary: "Der Key funktioniert, der Chat wird aus dem Browser aber scheitern.",
    endpoints: {
      models: { url: "https://api.openai.com/v1/models", result: "answered", status: 401, elapsedMs: 40, hasCorsHeader: true },
      inference: { url: "https://api.openai.com/v1/chat/completions", result: "network-error", status: null, elapsedMs: 40, hasCorsHeader: false },
    },
    corsVerifiedInPlan: false,
  };

  it("reports `cors-blocked` as a warning, not an error", () => {
    // `Plan.md` §9: a browser gets an opaque `Failed to fetch`, identical to being
    // offline. Showing "connection failed" trains the user to blame their key for a
    // provider policy — the one conclusion §9 says is wrong.
    const view = probeView(report as never);
    expect(view.tone).toBe("warning");
    expect(view.outcome).toBe("cors-blocked:unknown");
    expect(view.warnBeforeContinuing).toBe(true);
  });

  it("treats a rejected key as an error", () => {
    const view = probeView({
      ...report,
      outcome: "http-error",
      verdict: "key-rejected",
      endpoints: { ...report.endpoints, inference: { ...report.endpoints.inference, result: "answered", status: 401, hasCorsHeader: true } },
    } as never);
    expect(view.tone).toBe("error");
    expect(view.warnBeforeContinuing).toBe(false);
  });
});

/**
 * `webfetch` — the contract, pinned.
 *
 * Three things that are not behaviour and can still be broken by a careless
 * edit, so they are pinned here rather than left to the behavioural suite to
 * notice by accident:
 *
 *  1. the platform `fetch` satisfies the injected seam — checked by the
 *     compiler, because a seam the real transport does not fit is a seam that
 *     only ever runs in tests;
 *  2. the input schema has exactly one field, and the parameters that were
 *     deliberately left out stay left out (`AGENTS.md` §5: no speculative
 *     building);
 *  3. the tool touches no workspace at all, which is what makes `access:
 *     "network"` the honest class for it.
 */
import { createMemoryWorkspace } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import {
  createWebfetchTool,
  MAX_RESPONSE_BYTES,
  TIMEOUT_MS,
  WEBFETCH_OUTCOMES,
  type WebfetchFetch,
  type WebfetchResponse,
  webfetchInputSchema,
} from "../src/index.ts";
import { fakeFetch } from "./fake-fetch.ts";

describe("the transport seam accepts the real thing", () => {
  it("the platform fetch satisfies WebfetchFetch", () => {
    // A compile-time assertion that a runtime test cannot phrase any better.
    // If the DOM lib ever stops satisfying the narrow interface, this file
    // fails `tsc` before a single test runs.
    const platform: WebfetchFetch = (url, init) => globalThis.fetch(url, init);
    expect(typeof platform).toBe("function");
  });

  it("a real Response is assignable to the narrow response interface", () => {
    const platformResponse: (promise: Promise<Response>) => Promise<WebfetchResponse> = (promise) =>
      promise as Promise<WebfetchResponse>;
    expect(typeof platformResponse).toBe("function");
  });
});

describe("the input schema is exactly one field", () => {
  it("has only `url`, and nothing optional", () => {
    expect(Object.keys(webfetchInputSchema.shape)).toEqual(["url"]);
  });

  it("rejects an empty object and an empty url", () => {
    expect(webfetchInputSchema.safeParse({}).success).toBe(false);
    expect(webfetchInputSchema.safeParse({ url: "" }).success).toBe(false);
  });

  it("strips a parameter that is not in the schema instead of passing it through", () => {
    // The claim is not "zod rejects it" — a zod object *strips* unknown keys by
    // design, and every other tool in the repo relies on that. The claim is the
    // one that matters: no parameter the model invents ever reaches `execute`,
    // so there is no second schema to keep in step (`AGENTS.md` §4).
    for (const invented of [
      { headers: {} },
      { method: "POST" },
      { timeout: 5 },
      { maxBytes: 5 },
      { format: "raw" },
      { selector: "main" },
      { body: "x" },
    ]) {
      const parsed = webfetchInputSchema.safeParse({ url: "https://a.test", ...invented });
      expect(parsed.success, JSON.stringify(invented)).toBe(true);
      expect(Object.keys(parsed.data ?? {}), JSON.stringify(invented)).toEqual(["url"]);
    }
  });

  it("`url` is a string with a description the model can act on", () => {
    const field = webfetchInputSchema.shape.url as {
      _def: { type: string };
      description?: string;
    };
    expect(field._def.type).toBe("string");
    expect(field.description).toMatch(/Access-Control-Allow-Origin/);
  });
});

describe("the constants are single-sourced", () => {
  it("the byte cap is 1 MiB and the timeout is 20 s", () => {
    expect(MAX_RESPONSE_BYTES).toBe(1_048_576);
    expect(TIMEOUT_MS).toBe(20_000);
  });

  it("the outcome list is complete and has no duplicate entries", () => {
    expect(new Set(WEBFETCH_OUTCOMES).size).toBe(WEBFETCH_OUTCOMES.length);
    expect(WEBFETCH_OUTCOMES).toContain("blocked");
    expect(WEBFETCH_OUTCOMES).toContain("http-error");
    expect(WEBFETCH_OUTCOMES).toContain("too-large");
    expect(WEBFETCH_OUTCOMES).toContain("timeout");
    expect(WEBFETCH_OUTCOMES).toContain("aborted");
    expect(WEBFETCH_OUTCOMES).toContain("ok");
  });
});

describe("this tool touches no workspace", () => {
  it("never calls anything on the workspace, even when one is present", async () => {
    const touched: string[] = [];
    const inner = createMemoryWorkspace({ "a.txt": "content" });
    const context = {
      workspace: new Proxy(inner, {
        get(target, property, receiver) {
          if (typeof property === "string") touched.push(property);
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
      cwd: ".",
      signal: new AbortController().signal,
      approve: async () => "allow-once" as const,
      emit: () => {},
      toolCallId: "test-workspace",
      attempt: 1,
    };

    const { fetch } = fakeFetch([{ contentType: "text/plain", body: "ok" }]);
    const tool = createWebfetchTool({ fetch });
    await tool.execute(context, { url: "https://a.test/x" });

    expect(touched).toEqual([]);
  });
});

/**
 * `webfetch` — the two content reducers as units.
 *
 * `stripHtml` and `summariseJson` are the two places where the tool decides what
 * the model actually sees, so they are tested on their own rather than only
 * through `execute`. The limits they are known to have are stated here instead
 * of being left for a reader to discover.
 */
import { describe, expect, it } from "vitest";

import {
  JSON_ELISION_KEY,
  MAX_JSON_CHILDREN,
  MAX_JSON_DEPTH,
  MAX_JSON_STRING,
  stripHtml,
  summariseJson,
} from "../src/index.ts";

describe("stripHtml", () => {
  it("removes raw-text elements wholesale, contents included", () => {
    const html =
      "<div>keep<script>var secret = 1;</script><style>.a{color:red}</style>" +
      "<noscript>no js</noscript><template><p>tpl</p></template>keep2</div>";
    expect(stripHtml(html)).toBe("keep keep2");
  });

  it("keeps the text and drops the tags, turning block ends into newlines", () => {
    // Two adjacent block tags produce a blank line, which is the point: a
    // paragraph boundary is real structure, and collapsing it would merge
    // sentences that were never in the same paragraph.
    expect(stripHtml("<h1>Title</h1><p>One</p><p>Two</p>")).toBe("Title\n\nOne\n\nTwo");
  });

  it("a <br> is one newline, not a blank line", () => {
    expect(stripHtml("a<br>b<br/>c")).toBe("a\nb\nc");
  });

  it("decodes named, decimal and hex entities", () => {
    expect(stripHtml("<p>&lt;a&gt; &amp; &quot;b&quot; &#65; &#x42; &nbsp;end</p>")).toBe(
      '<a> & "b" A B end',
    );
  });

  it("decodes &amp;lt; once, not twice", () => {
    // The single-pass guarantee: a page's own escaped markup must not come back
    // as live markup.
    expect(stripHtml("<p>&amp;lt;script&amp;gt;</p>")).toBe("&lt;script&gt;");
  });

  it("leaves an unknown entity alone rather than guessing at it", () => {
    expect(stripHtml("<p>a&nbsp;b&notarealentity;c</p>")).toBe("a b&notarealentity;c");
  });

  it("drops comments, including one that contains markup", () => {
    expect(stripHtml("a<!-- <p>hidden</p> -->b")).toBe("a b");
  });

  it("does not treat a bare `<` in prose as a tag", () => {
    // A tag needs a name after the `<`. Without that requirement the naive
    // `<[^>]*>` would swallow "a < b and c > d" — half a sentence.
    expect(stripHtml("<p>if a < b and c > d then</p>")).toBe("if a < b and c > d then");
  });

  it("collapses runs of whitespace but keeps one blank line", () => {
    expect(stripHtml("<p>a   \n\n\n   b</p>")).toBe("a\n\nb");
    expect(stripHtml("<p>a\t\t\tb</p>")).toBe("a b");
  });

  it("is a no-op on a body with no markup", () => {
    expect(stripHtml("just words")).toBe("just words");
  });

  it("an empty document yields an empty string, not whitespace", () => {
    expect(stripHtml("<html><head></head><body></body></html>")).toBe("");
  });
});

describe("summariseJson", () => {
  it("returns scalars untouched", () => {
    expect(summariseJson(42).value).toBe(42);
    expect(summariseJson("hi").value).toBe("hi");
    expect(summariseJson(true).value).toBe(true);
    expect(summariseJson(null).value).toBe(null);
  });

  it("returns a small document with its exact values and elides nothing", () => {
    const value = { name: "baah", tags: ["a", "b"], meta: { ok: true, count: 3 } };
    const summary = summariseJson(value);
    expect(summary.value).toEqual(value);
    expect(summary.elided).toBe(0);
  });

  it("cuts a long string leaf and says so by ending it with an ellipsis", () => {
    const summary = summariseJson({ s: "x".repeat(MAX_JSON_STRING + 50) });
    const s = (summary.value as { s: string }).s;
    expect(s.length).toBe(MAX_JSON_STRING + 1);
    expect(s.endsWith("…")).toBe(true);
    expect(summary.elided).toBe(0);
  });

  it("keeps the first MAX_JSON_CHILDREN array items and counts the rest", () => {
    const value = Array.from({ length: 50 }, (_unused, index) => index);
    const summary = summariseJson(value);
    const out = summary.value as unknown[];
    expect(out).toHaveLength(MAX_JSON_CHILDREN + 1);
    expect(out[MAX_JSON_CHILDREN]).toBe(`${JSON_ELISION_KEY} ${50 - MAX_JSON_CHILDREN} more array items`);
    expect(summary.elided).toBe(50 - MAX_JSON_CHILDREN);
  });

  it("keeps the first MAX_JSON_CHILDREN object keys and counts the rest", () => {
    const value: Record<string, number> = {};
    for (let index = 0; index < 50; index += 1) value[`k${index}`] = index;
    const summary = summariseJson(value);
    const out = summary.value as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(MAX_JSON_CHILDREN + 1);
    expect(out[JSON_ELISION_KEY]).toBe(`${50 - MAX_JSON_CHILDREN} more object keys`);
    expect(summary.elided).toBe(50 - MAX_JSON_CHILDREN);
  });

  it("stops descending at MAX_JSON_DEPTH and counts the whole subtree as elided", () => {
    let deep: unknown = "leaf";
    for (let level = 0; level < MAX_JSON_DEPTH + 3; level += 1) deep = { level, deep };
    const summary = summariseJson(deep);
    expect(summary.elided).toBeGreaterThan(0);
    expect(JSON.stringify(summary.value)).toContain(JSON_ELISION_KEY);
  });

  it("counts a wide array of wide objects correctly rather than per level", () => {
    const value = Array.from({ length: 30 }, () => ({ a: 1, b: 2 }));
    const summary = summariseJson(value);
    expect(summary.elided).toBe(10);
  });

  it("always produces something JSON.stringify can serialise", () => {
    const value = { a: [1, { b: "x" }], c: { d: [true, null] } };
    expect(() => JSON.stringify(summariseJson(value).value)).not.toThrow();
  });
});

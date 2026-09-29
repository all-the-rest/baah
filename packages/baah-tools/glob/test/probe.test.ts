import { expect, it } from "vitest";
import "../src/probe.ts";
import { lines } from "../src/probe2.ts";
it("probe", () => {
  expect(lines.join("\n")).toBe("SHOW ME");
});

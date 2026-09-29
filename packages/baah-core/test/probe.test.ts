import { createMemoryWorkspace } from "@all-the.rest/baah-core";
import { describe, expect, it } from "vitest";

import { createIgnoreFilter } from "../src/ignore.ts";

const nasty: string[] = [
  "!",
  "!!",
  "![",
  "\\",
  "a\u0000b",
  "/",
  "//",
  "[",
  "**/",
  "#",
  "\u0000",
  "a\\",
  "!x/",
  "[]",
  "{}",
];

describe("probe", () => {
  it("what makes ignore().add throw", async () => {
    const report: string[] = [];
    for (const rule of nasty) {
      try {
        const isIgnored = await createIgnoreFilter(
          createMemoryWorkspace({ ".gitignore": `${rule}\n` }),
        );
        report.push(`${JSON.stringify(rule)} -> applied=${String(isIgnored.gitignoreApplied)} err=${String(isIgnored.gitignoreError)}`);
      } catch (error) {
        report.push(`${JSON.stringify(rule)} -> THREW ${(error as Error).message}`);
      }
    }
    const failing = await createIgnoreFilter({
      exists: async () => true,
      readText: async () => {
        throw new Error("permission denied");
      },
    } as never);
    report.push(`throwing workspace -> applied=${String(failing.gitignoreApplied)} err=${String(failing.gitignoreError)}`);
    expect(report.join("\n")).toBe("SHOW ME");
  });
});

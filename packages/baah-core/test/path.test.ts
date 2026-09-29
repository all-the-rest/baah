import { describe, expect, it } from "vitest";

import {
  assertInsideRoot,
  basenamePath,
  dirnamePath,
  extnamePath,
  joinPath,
  normalizePath,
  relativePath,
  resolvePath,
} from "../src/path.ts";

describe("normalizePath", () => {
  it("collapses segments and separators", () => {
    expect(normalizePath("a//b/./c")).toBe("a/b/c");
    expect(normalizePath("a/b/../c")).toBe("a/c");
    expect(normalizePath("/a/../../b")).toBe("/b");
    expect(normalizePath("")).toBe(".");
    expect(normalizePath(".")).toBe(".");
  });

  it("keeps leading .. for relative paths", () => {
    expect(normalizePath("../a")).toBe("../a");
    expect(normalizePath("a/../../b")).toBe("../b");
  });
});

describe("joinPath / resolvePath", () => {
  it("joins parts", () => {
    expect(joinPath("a", "b", "c")).toBe("a/b/c");
    expect(joinPath("a", "/b")).toBe("a/b");
  });

  it("lets an absolute target win", () => {
    expect(resolvePath("root/sub", "/abs")).toBe("/abs");
    expect(resolvePath("root", "sub/x.ts")).toBe("root/sub/x.ts");
  });
});

describe("dirname / basename / extname", () => {
  it("splits paths", () => {
    expect(dirnamePath("a/b/c.ts")).toBe("a/b");
    expect(dirnamePath("c.ts")).toBe(".");
    expect(dirnamePath("/a")).toBe("/");
    expect(basenamePath("a/b/c.ts")).toBe("c.ts");
    expect(extnamePath("a/b/c.ts")).toBe(".ts");
    expect(extnamePath("a/b/.gitignore")).toBe("");
    expect(extnamePath("Makefile")).toBe("");
  });
});

describe("relativePath", () => {
  it("walks up and down", () => {
    expect(relativePath("/a/b", "/a/b/c/d")).toBe("c/d");
    expect(relativePath("/a/b/c", "/a")).toBe("../..");
    expect(relativePath("/a", "/a")).toBe(".");
    expect(relativePath(".", "src/a.ts")).toBe("src/a.ts");
    expect(relativePath(".", ".")).toBe(".");
  });
});

describe("assertInsideRoot", () => {
  it("accepts paths inside the root", () => {
    expect(assertInsideRoot(".", "src/a.ts")).toBe("src/a.ts");
    expect(assertInsideRoot("sub", "a.ts")).toBe("sub/a.ts");
  });

  it("treats a leading / as workspace-root relative, regardless of cwd", () => {
    expect(assertInsideRoot(".", "/src/a.ts")).toBe("src/a.ts");
    expect(assertInsideRoot("sub", "/src/a.ts")).toBe("src/a.ts");
    expect(assertInsideRoot("deep/nested", "/src/a.ts")).toBe("src/a.ts");
  });

  it("resolves relative paths against cwd", () => {
    expect(assertInsideRoot("sub", "a.ts")).toBe("sub/a.ts");
    expect(assertInsideRoot("sub", "../a.ts")).toBe("a.ts");
  });

  it("rejects escapes", () => {
    expect(() => assertInsideRoot(".", "../x")).toThrow(/escapes/);
    expect(() => assertInsideRoot("sub", "../../x")).toThrow(/escapes/);
    expect(() => assertInsideRoot(".", "..")).toThrow(/escapes/);
  });
});

import { describe, expect, it } from "vitest";

import {
  applyReply,
  createDefaultRules,
  decide,
  DEFAULT_RULES,
  evaluate,
  matchResource,
  proposeSavePattern,
  type Effect,
  type PermissionRule,
  type ResourceRequest,
} from "../src/permission.ts";

const request = (action: ResourceRequest["action"], resource: string): ResourceRequest => ({
  action,
  resource,
});

/** Build a ruleset from `[action, resource, effect]` triples. */
function rules(...entries: ReadonlyArray<readonly [string, string, Effect]>): PermissionRule[] {
  return entries.map(([action, resource, effect]) => ({
    action: action as PermissionRule["action"],
    resource,
    effect,
  }));
}

describe("matchResource", () => {
  it("matches the whole value, never a prefix", () => {
    expect(matchResource("src/app.ts", "src/app.ts")).toBe(true);
    expect(matchResource("src/app.ts", "src/app.tsx")).toBe(false);
    expect(matchResource("src/app.ts", "prefix/src/app.ts")).toBe(false);
  });

  it("`*` matches zero or more characters, including `/`", () => {
    expect(matchResource("*.env", ".env")).toBe(true);
    expect(matchResource("*.env", "packages/app/.env")).toBe(true);
    expect(matchResource("src/*", "src/a/b/c.ts")).toBe(true);
    expect(matchResource("src/*", "other/a.ts")).toBe(false);
    expect(matchResource("*", "anything/at/all")).toBe(true);
  });

  it("`?` matches exactly one character", () => {
    expect(matchResource("a?c", "abc")).toBe(true);
    expect(matchResource("a?c", "ac")).toBe(false);
    expect(matchResource("a?c", "abbc")).toBe(false);
  });

  it("a trailing \" *\" also matches the bare value", () => {
    expect(matchResource("git status *", "git status")).toBe(true);
    expect(matchResource("git status *", "git status -sb")).toBe(true);
    expect(matchResource("git status *", "git commit")).toBe(false);
    expect(matchResource("git status *", "git statusx")).toBe(false);
  });

  it("normalises backslashes to `/` on both sides", () => {
    expect(matchResource("src/*.ts", "src\\a\\b.ts")).toBe(true);
    expect(matchResource("src\\*.ts", "src/a/b.ts")).toBe(true);
  });

  it("treats regex metacharacters literally", () => {
    expect(matchResource("a.b", "a.b")).toBe(true);
    expect(matchResource("a.b", "axb")).toBe(false);
    expect(matchResource("C:\\secrets", "C:/secrets")).toBe(true);
    expect(matchResource("a+b", "a+b")).toBe(true);
    expect(matchResource("a+b", "aab")).toBe(false);
  });
});

describe("decide — the last matching rule wins", () => {
  it("lets a later rule overrule an earlier one", () => {
    const configured = rules(
      ["*", "*", "allow"],
      ["read", "*.env", "deny"],
    );

    expect(decide(configured, request("read", ".env"))).toBe("deny");
    expect(decide(configured, request("read", "src/app.ts"))).toBe("allow");
  });

  it("asks when nothing matches", () => {
    expect(decide(rules(["read", "src/*", "allow"]), request("shell", "ls -la"))).toBe("ask");
    expect(decide([], request("read", "src/app.ts"))).toBe("ask");
  });
});

describe("evaluate across several resources", () => {
  const configured = rules(
    ["*", "*", "allow"],
    ["read", "*.env.local", "ask"],
    ["read", "*.env", "deny"],
  );

  it("a single deny denies the whole call", () => {
    expect(evaluate(configured, [request("read", "src/a.ts"), request("read", ".env")])).toBe(
      "deny",
    );
  });

  it("any ask asks, even next to allows", () => {
    expect(
      evaluate(configured, [request("read", "src/a.ts"), request("read", ".env.local")]),
    ).toBe("ask");
  });

  it("allows when everything is allowed", () => {
    expect(evaluate(configured, [request("read", "src/a.ts"), request("edit", "src/b.ts")])).toBe(
      "allow",
    );
  });

  it("accepts a single request as well as a list", () => {
    expect(evaluate(configured, request("read", "src/a.ts"))).toBe("allow");
    expect(evaluate(configured, request("read", ".env"))).toBe("deny");
  });
});

describe("DEFAULT_RULES (Plan.md §7.4)", () => {
  it("allows ordinary work", () => {
    expect(evaluate(DEFAULT_RULES, request("read", "src/app.ts"))).toBe("allow");
    expect(evaluate(DEFAULT_RULES, request("edit", "src/app.ts"))).toBe("allow");
    expect(evaluate(DEFAULT_RULES, request("shell", "git status"))).toBe("allow");
  });

  it("asks before handing out secrets", () => {
    expect(evaluate(DEFAULT_RULES, request("read", ".env"))).toBe("ask");
    expect(evaluate(DEFAULT_RULES, request("read", "packages/app/.env"))).toBe("ask");
    expect(evaluate(DEFAULT_RULES, request("read", ".env.production"))).toBe("ask");
  });

  it("lets `.env.example` through — it is meant to be read", () => {
    expect(evaluate(DEFAULT_RULES, request("read", ".env.example"))).toBe("allow");
    expect(evaluate(DEFAULT_RULES, request("read", "config/.env.example"))).toBe("allow");
  });

  it("asks for anything outside the workspace", () => {
    expect(evaluate(DEFAULT_RULES, request("external_directory", "/etc"))).toBe("ask");
  });

  it("is frozen and copyable", () => {
    expect(Object.isFrozen(DEFAULT_RULES)).toBe(true);
    const copy = createDefaultRules();
    copy.push({ action: "shell", resource: "rm *", effect: "deny" });
    expect(copy).toHaveLength(DEFAULT_RULES.length + 1);
    expect(DEFAULT_RULES).toHaveLength(5);
  });

  it("documented gap: writing a secret is not covered by the default policy", () => {
    // Plan.md §7.4 only guards `read`. `edit` of `.env` therefore runs without
    // a prompt. Asserted here so the behaviour is on the record, not assumed.
    expect(evaluate(DEFAULT_RULES, request("edit", ".env"))).toBe("allow");
  });
});

describe("stored grants", () => {
  const configured = rules(["*", "*", "allow"], ["read", "src/secret.ts", "deny"]);

  it("turn an ask into an allow", () => {
    const grants: PermissionRule[] = [{ action: "read", resource: "src/*.ts", effect: "allow" }];
    expect(evaluate(configured, request("read", "src/app.ts"), grants)).toBe("allow");
  });

  it("never overrule a configured deny", () => {
    const grants: PermissionRule[] = [{ action: "read", resource: "src/*", effect: "allow" }];
    expect(evaluate(configured, request("read", "src/secret.ts"), grants)).toBe("deny");
  });

  it("do not leak into other resources", () => {
    // Everything asks by default; the grant covers `src/*.ts` and nothing else.
    const asksDocs: PermissionRule[] = [{ action: "read", resource: "docs/*", effect: "ask" }];
    const grants: PermissionRule[] = [{ action: "read", resource: "src/*.ts", effect: "allow" }];

    expect(evaluate(asksDocs, request("read", "src/app.ts"), grants)).toBe("allow");
    expect(evaluate(asksDocs, request("read", "docs/a.md"), grants)).toBe("ask");
    expect(
      evaluate(asksDocs, [request("read", "src/app.ts"), request("read", "docs/a.md")], grants),
    ).toBe("ask");
  });
});

describe("proposeSavePattern — the tool proposes, the UI does not", () => {
  it("keeps the command prefix for shell commands", () => {
    expect(proposeSavePattern("shell", "git status -sb")).toBe("git status *");
    expect(proposeSavePattern("shell", "git status")).toBe("git status *");
    expect(proposeSavePattern("shell", "ls -la /tmp")).toBe("ls -la *");
  });

  it("proposes exactly what the tool named for everything else", () => {
    expect(proposeSavePattern("subagent", "reviewer")).toBe("reviewer");
    expect(proposeSavePattern("skill", "pdf")).toBe("pdf");
    expect(proposeSavePattern("glob", "src/**/*.ts")).toBe("src/**/*.ts");
    expect(proposeSavePattern("grep", "TODO|FIXME")).toBe("TODO|FIXME");
    expect(proposeSavePattern("webfetch", "https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(proposeSavePattern("external_directory", "C:\\Users\\me\\notes")).toBe(
      "C:/Users/me/notes",
    );
  });

  it("yields a pattern that actually matches the original call", () => {
    for (const [action, resource] of [
      ["shell", "git status -sb"],
      ["shell", "npm run build -- --watch"],
      ["grep", "TODO|FIXME"],
      ["read", ".env.local"],
    ] as const) {
      const pattern = proposeSavePattern(action, resource);
      expect(matchResource(pattern, resource)).toBe(true);
    }
  });
});

describe("applyReply", () => {
  it("stores the proposed pattern for `always`", () => {
    const grants = applyReply([], "always", "shell", "git status -sb");
    expect(grants).toEqual([{ action: "shell", resource: "git status *", effect: "allow" }]);
  });

  it("leaves the grant list alone for `once` and `reject`", () => {
    expect(applyReply([], "once", "shell", "git status")).toEqual([]);
    expect(applyReply([], "reject", "shell", "git status")).toEqual([]);
  });

  it("a stored grant is enough to let the next call through", () => {
    const grants = applyReply([], "always", "shell", "git status -sb");
    expect(evaluate(DEFAULT_RULES, request("shell", "git status --short"), grants)).toBe("allow");
    expect(evaluate(DEFAULT_RULES, request("shell", "rm -rf /"), grants)).toBe("allow");
  });
});

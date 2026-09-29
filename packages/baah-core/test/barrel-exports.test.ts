/**
 * The barrel: no name is exported twice, and nothing is silently dropped.
 *
 * ## Why this file exists
 *
 * `export *` is not additive. When two modules export the same name, the
 * barrel **loses that name entirely** — no error at the export, no error at the
 * import, just a missing member at the place where a consumer needed it. That
 * is the failure mode `src/index.ts` deliberately works around, and a comment
 * saying so is not a guarantee: the next module somebody adds can reintroduce
 * it. This test measures the module sources instead of trusting the comment.
 *
 * The names are read out of the **source**, not out of the runtime namespace,
 * because the interesting collisions here are type-only (`AiToolSet` is a type)
 * and a runtime `Object.keys()` cannot see a single one of them. The `?raw`
 * import is the same mechanism the replay verify already uses; it needs no Node
 * built-in, so the browser-only rule of `AGENTS.md` §2 is not touched.
 *
 * The second thing pinned here is that the engine is reachable from the barrel
 * at all. `agent`, `provider` and `stream` were implemented and verified but
 * not exported, so Wave 2 could not consume them without a deep import into
 * `src/` — which is exactly the boundary `AGENTS.md` §4 draws.
 */

import { describe, expect, it } from "vitest";

import * as barrel from "../src/index.ts";
import * as agentApproval from "../src/agent/approval.ts";
import * as agentLoop from "../src/agent/loop.ts";
import * as agentTools from "../src/agent/tools.ts";
import * as ignore from "../src/ignore.ts";
import * as path from "../src/path.ts";
import * as permission from "../src/permission.ts";
import * as providerRegistry from "../src/provider/registry.ts";
import * as registry from "../src/registry.ts";
import * as streamBackoff from "../src/stream/backoff.ts";
import * as streamClassify from "../src/stream/classify.ts";
import * as tool from "../src/tool.ts";
import * as workspace from "../src/workspace.ts";

import indexSource from "../src/index.ts?raw";
import pathSource from "../src/path.ts?raw";
import registrySource from "../src/registry.ts?raw";
import toolSource from "../src/tool.ts?raw";
import workspaceSource from "../src/workspace.ts?raw";
import ignoreSource from "../src/ignore.ts?raw";
import permissionSource from "../src/permission.ts?raw";
import approvalSource from "../src/agent/approval.ts?raw";
import loopSource from "../src/agent/loop.ts?raw";
import toolsSource from "../src/agent/tools.ts?raw";
import providerSource from "../src/provider/registry.ts?raw";
import backoffSource from "../src/stream/backoff.ts?raw";
import classifySource from "../src/stream/classify.ts?raw";

/**
 * Every name a module exports, types included.
 *
 * A deliberately small reader, not a parser: it recognises the declaration
 * forms this package uses plus the two brace forms. It has to be *complete*
 * rather than clever — a missed form would hide a collision, which is the
 * failure this file exists to catch.
 */
function exportedNames(source: string): string[] {
  const names: string[] = [];

  const declaration = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|abstract\s+class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declaration)) {
    if (match[1] !== undefined) names.push(match[1]);
  }

  const braced = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm;
  for (const match of source.matchAll(braced)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name !== "") names.push(name);
    }
  }

  return names;
}

const MODULES: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ["path", pathSource, path as unknown as Record<string, unknown>],
  ["registry", registrySource, registry as unknown as Record<string, unknown>],
  ["tool", toolSource, tool as unknown as Record<string, unknown>],
  ["workspace", workspaceSource, workspace as unknown as Record<string, unknown>],
  ["ignore", ignoreSource, ignore as unknown as Record<string, unknown>],
  ["permission", permissionSource, permission as unknown as Record<string, unknown>],
  ["agent/approval", approvalSource, agentApproval as unknown as Record<string, unknown>],
  ["agent/loop", loopSource, agentLoop as unknown as Record<string, unknown>],
  ["agent/tools", toolsSource, agentTools as unknown as Record<string, unknown>],
  ["provider/registry", providerSource, providerRegistry as unknown as Record<string, unknown>],
  ["stream/backoff", backoffSource, streamBackoff as unknown as Record<string, unknown>],
  ["stream/classify", classifySource, streamClassify as unknown as Record<string, unknown>],
];

/**
 * The names two modules provide, and which one the barrel names.
 *
 * `agent/loop.ts` re-exports `AiToolSet` for the convenience of a caller that
 * only holds an `AgentTurn`; `agent/tools.ts` is where the type is defined.
 * Both are the *same* declaration, so nothing is lost either way — but
 * `export *` would drop the name, so the barrel writes it out explicitly.
 * The winner is `agent/tools.ts`: the definition, not the convenience
 * re-export. `ProviderRegistry` and `ToolRegistry` are deliberately *not* here;
 * they are different types and the names do not collide.
 */
const RESOLVED_COLLISIONS: Readonly<Record<string, string>> = {
  AiToolSet: "agent/tools.ts",
};

describe("no name is exported by two modules", () => {
  it("every duplicate is one we resolved deliberately", () => {
    const owner = new Map<string, string>();
    const collisions: { name: string; modules: string[] }[] = [];

    for (const [moduleName, source] of MODULES) {
      for (const name of exportedNames(source)) {
        const first = owner.get(name);
        if (first === undefined) {
          owner.set(name, moduleName);
          continue;
        }
        const existing = collisions.find((entry) => entry.name === name);
        if (existing === undefined) collisions.push({ name, modules: [first, moduleName] });
        else existing.modules.push(moduleName);
      }
    }

    const unexplained = collisions
      .filter((entry) => !(entry.name in RESOLVED_COLLISIONS))
      .map((entry) => `${entry.name}: ${entry.modules.join(" + ")}`);

    expect(unexplained).toEqual([]);
  });

  it("the resolved collision is still a collision, and is still declared", () => {
    // If somebody "fixes" the second export instead of the barrel, this fails:
    // the collision would silently disappear and the reason for the explicit
    // re-export would go with it.
    for (const [name, winner] of Object.entries(RESOLVED_COLLISIONS)) {
      const providers = MODULES.filter(([, source]) => exportedNames(source).includes(name)).map(
        ([moduleName]) => moduleName,
      );
      expect(providers.length, name).toBeGreaterThan(1);

      // The barrel resolves it with an explicit local re-export, which wins
      // over the star exports by the ES specification. `winner` is the module
      // key, so this is the exact specifier `src/index.ts` must carry.
      expect(indexSource, name).toContain(`export type { ${name} } from "./${winner}";`);
    }
  });

  it("the reader sees the collision it is meant to catch", () => {
    // A self-check on the reader above: if the declaration form changed and the
    // reader stopped matching, the two tests above would pass vacuously.
    expect(exportedNames(loopSource)).toContain("AiToolSet");
    expect(exportedNames(toolsSource)).toContain("AiToolSet");
    expect(exportedNames(loopSource)).toContain("TurnStore");
    expect(exportedNames(toolsSource)).toContain("ToolCallKey");
  });
});

describe("the barrel re-exports the engine", () => {
  it("every runtime value of every module is reachable from the barrel", () => {
    const missing: string[] = [];
    for (const [moduleName, , namespace] of MODULES) {
      for (const name of Object.keys(namespace)) {
        if (!(name in (barrel as unknown as Record<string, unknown>))) missing.push(`${moduleName}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the turn runner", () => {
    for (const name of [
      "AgentTurn",
      "recoverStaleTurns",
      "isRecoverableTurn",
      "isTurnStale",
      "heartbeatAgeMs",
      "staticAgentSettings",
      "STALE_HEARTBEAT_MS",
      "DEFAULT_STALL_TIMEOUT_MS",
      "DELTA_FLUSH_INTERVAL_MS",
    ] as const) {
      expect((barrel as unknown as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it("the tool adapter", () => {
    for (const name of [
      "createToolSet",
      "truncateToolOutput",
      "renderToolOutput",
      "MissingToolCallIdError",
      "DEFAULT_TOOL_OUTPUT_LIMITS",
      "TRUNCATION_MARKER",
    ] as const) {
      expect((barrel as unknown as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it("the permission/approval seam", () => {
    for (const name of [
      "createApprovalResolver",
      "createRuleEnginePermissionEngine",
      "buildApprovalTargets",
      "toApprovalStatus",
      "DEFAULT_APPROVAL_TARGETS",
    ] as const) {
      expect((barrel as unknown as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it("the provider registry", () => {
    for (const name of [
      "ProviderRegistry",
      "createProviderModel",
      "defineProviderFactory",
      "ProviderError",
      "requiredHeaders",
      "isCorsVerified",
      "parseVendorId",
      "fingerprint",
    ] as const) {
      expect((barrel as unknown as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it("the stream classifier and the backoff", () => {
    for (const name of [
      "classifyResponse",
      "classifyThrownError",
      "normalizeErrorType",
      "isKnownErrorType",
      "isRetryableErrorType",
      "normalizeContentType",
      "parseRetryAfter",
      "nextDelayMs",
      "remainingAttempts",
      "canRetry",
      "MAX_ATTEMPTS",
      "RETRY_SCHEDULE_MS",
    ] as const) {
      expect((barrel as unknown as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it("the pre-existing modules, including the new walk contract", () => {
    for (const name of [
      "createMemoryWorkspace",
      "byteLength",
      "isWorkspaceRoot",
      "DEFAULT_MAX_ENTRIES",
      "walkMayBeIncomplete",
      "defineTool",
      "createToolRegistry",
      "createIgnoreFilter",
      "createDefaultRules",
      "evaluate",
      "assertInsideRoot",
      "CORE_PACKAGE",
    ] as const) {
      expect((barrel as unknown as Record<string, unknown>)[name], name).toBeDefined();
    }
  });
});

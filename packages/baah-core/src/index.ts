/**
 * @all-the.rest/baah-core — the browser-only agent harness engine.
 *
 * This package must stay free of Node built-ins and of any assumption that a
 * server exists. Everything here runs inside the browser (main thread or a
 * Web Worker). See AGENTS.md §2.
 *
 * ## The barrel
 *
 * Every module of the package is re-exported here, and the names are **chosen
 * deliberately** rather than left to `export *`:
 *
 * - A star export that two modules both provide is *silently dropped* from the
 *   barrel — it is not a compile error, and the consumer gets a missing name at
 *   the point where it matters. So every module that is re-exported is listed
 *   here, and `test/barrel-exports.test.ts` intersects the module namespaces
 *   and fails if two of them ever export the same name.
 * - Where a name *is* provided twice, the winner is written out as an explicit
 *   local re-export, which takes precedence over the star exports. Today that
 *   is exactly one name, `AiToolSet`, and the reason is in the barrel test.
 *
 * Wave 2 consumes `agent`, `provider` and `stream` from here; they used to be
 * reachable only by deep import, which no consumer should have to do.
 */

export * from "./path.ts";
export * from "./registry.ts";
export * from "./tool.ts";
export * from "./workspace.ts";
export * from "./ignore.ts";
export * from "./permission.ts";

/* The engine. `loop.ts` re-exports `AiToolSet` for callers of `AgentTurn`; */
/* `tools.ts` is where the type is defined, so that is the one the barrel */
/* names. See `test/barrel-exports.test.ts`. */
export * from "./agent/approval.ts";
export * from "./agent/loop.ts";
export * from "./agent/tools.ts";
export type { AiToolSet } from "./agent/tools.ts";

export * from "./provider/registry.ts";
export * from "./stream/backoff.ts";
export * from "./stream/classify.ts";

export const CORE_PACKAGE = "@all-the.rest/baah-core";

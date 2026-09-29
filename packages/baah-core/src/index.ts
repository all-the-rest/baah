/**
 * @all-the.rest/baah-core — the browser-only agent harness engine.
 *
 * This package must stay free of Node built-ins and of any assumption that a
 * server exists. Everything here runs inside the browser (main thread or a
 * Web Worker). See AGENTS.md §2.
 */

export * from "./path.ts";
export * from "./registry.ts";
export * from "./tool.ts";
export * from "./workspace.ts";
export * from "./ignore.ts";
export * from "./permission.ts";

export const CORE_PACKAGE = "@all-the.rest/baah-core";

/**
 * @ohw/core — the browser-only agent harness engine.
 *
 * This package must stay free of Node built-ins and of any assumption that a
 * server exists. Everything here runs inside the browser (main thread or a
 * Web Worker). See AGENTS.md §2.
 */

export * from "./path.ts";
export * from "./registry.ts";
export * from "./tool.ts";
export * from "./workspace.ts";

export const CORE_PACKAGE = "@ohw/core";

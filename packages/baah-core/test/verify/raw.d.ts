/**
 * Vite's `?raw` import, for the source-level assertions in `test/verify/`.
 *
 * The engine has to be checked for *absent* code ("there is no heartbeat
 * threshold", "`classifyResponse` is never called"), and the only honest way
 * to assert an absence is to read the source. `readFileSync` would need
 * `@types/node`, which this package deliberately does not have — it is
 * browser-targeted and Node-free (AGENTS.md §2), and adding Node types to a
 * Node-free package to make a test compile is the wrong trade.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Build mode used by the Playwright suite. `pnpm e2e` builds with
 * `--mode e2e`, so the app learns the OpenAI-compatible base URL that
 * `packages/baah-web/e2e/support/provider.ts` intercepts. A normal `pnpm build`
 * leaves the value empty, so a production bundle carries no test seam.
 */
const E2E_PROVIDER_BASE_URL = "https://e2e.invalid/v1";

export default defineConfig(({ mode }) => {
  const isE2E = mode === "e2e";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5273,
    },
    preview: {
      // `vite preview` serves `dist/` and nothing else — no proxy, no rewrite
      // to an API. The E2E suite points `webServer` at this fixed port, so
      // `strictPort` makes a port clash a loud error instead of a silent
      // fallback to 4174.
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
    },
    // The whole app must stay browser-only: no server-side proxying of model
    // calls, no Node polyfills that hide a server dependency. See AGENTS.md §2.
    define: {
      "import.meta.env.BAAH_BROWSER_ONLY": JSON.stringify("true"),
      // Test-only seam. Empty outside `--mode e2e`; the Playwright route
      // handlers in `e2e/support/provider.ts` answer every request to it, so no
      // byte of a test ever leaves the machine.
      "import.meta.env.BAAH_E2E_PROVIDER_BASE_URL": JSON.stringify(
        isE2E ? E2E_PROVIDER_BASE_URL : "",
      ),
    },
    optimizeDeps: {
      // `@sqlite.org/sqlite-wasm` loads a .wasm binary through
      // `import.meta.url`. Vite's dependency pre-bundling rewrites that URL and
      // the module then fails to fetch the binary, so it may not be
      // pre-bundled. See packages/baah-storage/README.md.
      exclude: ["@sqlite.org/sqlite-wasm"],
    },
  };
});

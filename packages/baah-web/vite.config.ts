import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
  },
  // The whole app must stay browser-only: no server-side proxying of model
  // calls, no Node polyfills that hide a server dependency. See AGENTS.md §2.
  define: {
    "import.meta.env.BAAH_BROWSER_ONLY": JSON.stringify("true"),
  },
  optimizeDeps: {
    // Both packages load a .wasm binary through `import.meta.url`. Vite's
    // dependency pre-bundling rewrites that URL and the module then fails to
    // fetch the binary, so neither may be pre-bundled.
    // See packages/baah-tools/grep/README.md and packages/baah-storage/README.md.
    exclude: ["grep-wasm", "@sqlite.org/sqlite-wasm"],
  },
});

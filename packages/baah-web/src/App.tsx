import { useEffect, useState } from "react";

import { CORE_PACKAGE } from "@all-the.rest/baah-core";

import { AppShell } from "./components/AppShell.tsx";
import { createAppRuntime, type AppRuntime } from "./components/lib/runtime.ts";

/**
 * The app root: build the runtime, then hand it to the shell.
 *
 * ## Why the runtime is built in an effect and not at module scope
 *
 * `createAppRuntime` is `async` — the tool packages are dynamic imports and the
 * storage module is a chunk — and it touches `localStorage` through
 * `createWebStorageBackend`. Both are browser-only. So it runs after mount, and
 * until it resolves the root shows a *boot* state rather than a spinner with no
 * explanation: a user who opened the app and got a blank frame cannot tell
 * "loading" from "broken".
 *
 * ## Why a failure is shown and not swallowed
 *
 * `AGENTS.md` §5 forbids silent catch blocks, and a composition failure is exactly
 * the kind a user has to see: without the runtime there is no app, and an error
 * boundary's blank page says nothing about which of the eight imports failed. The
 * class name is shown and the message is not — a `Error.message` from a module-load
 * failure can quote the specifier, and this build loads the storage package
 * through a relative path that a bundler error would print in full.
 */
export function App() {
  const [app, setApp] = useState<AppRuntime | undefined>();
  const [failure, setFailure] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    createAppRuntime()
      .then((built) => {
        if (!cancelled) setApp(built);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setFailure(
            `Die App konnte nicht starten: ${cause instanceof Error ? cause.name : "unbekannter Fehler"}. ` +
              "Im Browserfenster stehen die Einzelheiten.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failure !== undefined) {
    return (
      <main className="hero min-h-screen">
        <div className="hero-content text-center">
          <div className="max-w-xl">
            <h1 className="text-2xl font-bold">baah</h1>
            <p data-testid="baah-boot-failure" role="alert" className="py-4 text-sm text-error">
              {failure}
            </p>
            <div className="badge badge-outline">browser-only · no server</div>
          </div>
        </div>
      </main>
    );
  }

  if (app === undefined) {
    return (
      <main className="hero min-h-screen">
        <div className="hero-content text-center">
          <div className="max-w-xl">
            <h1 className="text-4xl font-bold">baah</h1>
            <p data-testid="baah-boot" className="py-4 opacity-80">
              Starte die Werkzeuge und die Datenbank …
            </p>
            <p className="text-xs opacity-60">Engine: <code className="kbd kbd-sm">{CORE_PACKAGE}</code></p>
          </div>
        </div>
      </main>
    );
  }

  // No `initialScreen`: the shell decides from the stored settings, which is what
  // makes a reload land a configured user straight in the chat rather than in the
  // wizard again.
  return <AppShell app={app} />;
}

export default App;

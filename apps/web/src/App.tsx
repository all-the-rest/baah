import { CORE_PACKAGE } from "@ohw/core";

/**
 * Placeholder shell. The real UI (onboarding wizard, workspace picker, chat
 * transcript, tool approval cards, settings export) lands in phase 2+ — see
 * Plan.md.
 */
export function App() {
  return (
    <main className="hero min-h-screen">
      <div className="hero-content text-center">
        <div className="max-w-xl">
          <h1 className="text-4xl font-bold">opencode-harness-web</h1>
          <p className="py-4 opacity-80">
            A browser-only coding agent harness. Engine:{" "}
            <code className="kbd kbd-sm">{CORE_PACKAGE}</code>
          </p>
          <div className="badge badge-outline">browser-only · no server</div>
        </div>
      </div>
    </main>
  );
}

export default App;

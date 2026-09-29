# AGENTS.md — Regeln für `opencode-harness-web`

Diese Datei ist die **verbindliche Regelbasis** für Menschen und Agenten, die in
diesem Repo arbeiten. Das *Was* (Ziel, Architektur, Phasen) steht in
[`Plan.md`](Plan.md) — `Plan.md` ist die Spezifikation, `AGENTS.md` sind die
Regeln. Bei Konflikt gilt: `AGENTS.md` für Prozess/Constraints, `Plan.md` für
Inhalt.

> Kurzfassung: Eine OpenCode-artige Coding-Agent-Harness **rein im Browser**.
> Kein Server. Keine Node-Runtime zur Laufzeit. Alles (Agent-Loop, Tools,
> Persistenz, File-Zugriff) läuft im Tab.

---

## 1. Projektzweck & Scope

Ziel ist eine Web-App, die den Kern einer OpenCode-artigen Harness nachbildet:

- Agent-Loop mit Multi-Step-Tool-Calling gegen einen LLM-Provider
- Werkzeugkasten analog zu OpenCode (Datei lesen/schreiben/editieren, suchen,
  Shell-Ersatz, Todo-Liste, Subagent-Task, Web-Fetch)
- **Workspace-Zugriff** über die File System Access API bzw. OPFS
- **Onboarding** (Erststart-Wizard: Provider/Key/Modell/Workspace wählen)
- **Settings-Export/Import** als JSON (inkl. späterer Re-Import auf anderem Gerät)
- Persistenz von Sessions/Nachrichten/Tool-Calls in der Browser-DB, damit der
  Loop Reloads übersteht

**Nicht in Scope (jetzt):** MCP-Support (bewusst zurückgestellt, siehe
`Plan.md` §10), Server-/Multi-User-Betrieb, native Shell, LSP-Vollintegration.

## 2. HARTE REGEL: Browser-only

Es gibt **keinen Server-Teil**. Kein Express/Hono, kein Node-Prozess, kein
Proxy, keine Serverless-Function, kein SSR. Das ist keine Präferenz, sondern die
Projektdefinition.

Konkrete Konsequenzen — jede verletzt diese Regel:

- **Keine Node-Builtins importieren.** Kein `node:fs`, `node:path`,
  `node:child_process`, `node:crypto`, `Buffer`, `process`. Ziel-Runtime ist
  ausschließlich der Browser (Main Thread + Web Worker).
  - Pfad-Arithmetik: eigene Utility in `@ohw/core` (POSIX-Semantik, `/`-separiert),
    nicht `node:path`.
  - Hashing/Zufall: `crypto.subtle` / `crypto.randomUUID()`.
- **Kein Server-Proxy für LLM-Calls.** Der Browser spricht direkt mit dem
  Provider (CORS-Matrix in `Plan.md` §7). Wenn ein Provider CORS nicht erlaubt,
  ist er damit **nicht unterstützt** — es wird kein Backend nachgerüstet.
- **Keine Secrets im Repo.** Keine API-Keys in Dateien, Commits, Fixtures,
  Logs oder Fehlermeldungen. Keys liegen ausschließlich im Browser-Storage des
  Nutzers.
- **Kein SSR/RSC.** Reine SPA (Vite). Bibliotheken, die einen Node-Runtime
  voraussetzen, werden nicht eingebaut.
- `@ohw/core` muss **Node-frei** sein und in einem Web Worker laufen können.
  Neue Core-Module dürfen keine DOM-Annahmen machen, wo es vermeidbar ist
  (damit sie in Worker + Vitest laufen).

## 3. Stack (gesetzt)

| Bereich | Wahl |
|---|---|
| Package-Manager | **pnpm** (Workspace, `pnpm-workspace.yaml`) |
| Sprache | **TypeScript** (strict, `tsconfig.base.json`) |
| UI | **React 19** + **Vite** (SPA) |
| Styling | **Tailwind CSS v4** + **daisyUI v5** (Theme `dark` als Default) |
| LLM-Layer | **Vercel AI SDK** (`ai` + `@ai-sdk/react`) |
| Validierung | **zod** an allen externen Grenzen |
| Tests | **vitest** (Unit, `@ohw/core`), Playwright für E2E (ab Phase 4) |

Versionen werden **nicht geraten**: vor dem Hinzufügen einer Dependency die
aktuelle Version prüfen (`npm view <pkg> version`) und im jeweiligen
`package.json` eintragen. Downgrades/Upgrades einzelner Kernpakete gehören in
die Commit-Message.

## 4. Repo-Layout

```
apps/web/                React-SPA (UI, Routing, Worker-Registrierung)
  src/                   UI-Code
packages/core/           Harness-Engine: Agent-Loop, Tool-Registry,
                         Workspace-Abstraktion, Storage-Adapter.
                         Node-frei, worker-tauglich, unit-getestet.
packages/tools/<id>/     EIN Package pro Tool ("read", "grep", "edit", …).
Plan.md                  Spezifikation (Ziel, Architektur, Phasen)
AGENTS.md                diese Regeln
```

- **Schichtregel:** `apps/web` → `packages/tools/*` → `packages/core`.
  Abhängigkeiten zeigen **nie** zurück. `core` kennt weder React noch DOM-UI,
  noch die konkreten Tools.
- **Ein Tool = ein Package.** Konvention:
  - Verzeichnis `packages/tools/<id>/`, Paketname `@ohw/tool-<id>`.
  - `src/index.ts` exportiert die Definition als benannten Export
    (`export const readTool`) **und** als `default`.
  - Das Tool ist ein `ToolDefinition` aus `@ohw/core` (`defineTool({...})`):
    `id`, `description`, `access`, `inputSchema` (zod), `execute`.
  - `inputSchema` ist die **einzige** Quelle der Parameter-Wahrheit — sie geht
    an das Modell (AI SDK) *und* an die Validierung. Kein zweites Schema.
  - Eigene Tests unter `test/<id>.test.ts`, immer gegen
    `createMemoryWorkspace()` aus `@ohw/core` — **kein** Browser und kein DOM
    nötig, damit die Verifikation in CI läuft.
  - Ein Tool greift **nie** direkt auf IndexedDB oder UI zu, nur über den
    `ToolContext`.
- **Neues Tool:** Package anlegen, in `Plan.md` §4 aufnehmen (mit `access`-Klasse),
  in der Tool-Liste der Engine registrieren. Reihenfolge/Abhängigkeiten der Tools
  untereinander sind verboten — Tools kennen nur den `ToolContext`.
- Kein Wildwuchs: ein neues Package braucht einen Eintrag in `Plan.md`.

## 5. Code-Regeln

- **TypeScript strict.** `any` ist verboten (bei Fremd-APIs: `unknown` + zod
  parsen oder ein enges Interface schreiben).
- **Grenzen validieren:** Alles, was von außen kommt (Provider-Streams,
  importierte Settings-JSONs, FS-Handles, Worker-Nachrichten) wird mit zod
  geparst — nie blind gecastet.
- **IDs:** `crypto.randomUUID()`. Zeitstempel: ISO-8601-Strings (sortierbar).
- **Fehler:** keine stillen `catch`-Blöcke. Fehler, die der Nutzer sehen muss
  (Tool-Fehler, Provider-Fehler), werden zu typisierten Events im Agent-Loop,
  nicht zu `console.error`.
- **Sprache:** Identifier und Code-Kommentare auf Englisch, Prosa/Docs
  (README, `Plan.md`, `AGENTS.md`) auf Deutsch. Commit-Messages: Conventional
  Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- **Keine toten Abstraktionen:** Was nicht in `Plan.md` steht, wird nicht
  „vorsorglich“ gebaut.

## 6. Verifikation (nicht verhandelbar)

Vor jedem Commit, der `packages/core` oder `apps/web/src` berührt:

```bash
pnpm check        # = pnpm typecheck && pnpm test
```

- `pnpm typecheck` muss fehlerfrei durchlaufen (alle Workspace-Packages).
- Neue Engine-Logik in `@ohw/core` braucht Unit-Tests (vitest). Ein Feature
  ohne Test ist nicht fertig.
- „Fertig“ heißt: Befehl ausgeführt und Ausgabe gesehen — **nicht** „sollte
  laufen“. Ergebnisse immer mit dem tatsächlichen Output belegen.
- Browser-Verhalten (File System Access API, OPFS, IndexedDB) kann nicht per
  Unit-Test bewiesen werden ⇒ dafür ein manuelles Prüfskript/Schrittliste in
  `Plan.md` §9 pflegen und im PR/Commit referenzieren.

## 7. Orchestrierung & Subagenten

Der Haupt-Agent ist **Orchestrator**, nicht Implementierer größerer Teile.
Für jede größere Arbeitseinheit (Feature-Slice aus `Plan.md` §8):

1. **Implementer-Subagent** bekommt: Ziel, betroffene Dateien, Akzeptanzkriterien,
   die relevanten `AGENTS.md`-Regeln und den Verifikationsbefehl.
2. **Verifier-Subagent** (separate, unabhängige Session) prüft anschließend
   gegen dieselben Akzeptanzkriterien: Tests laufen lassen, Code lesen,
   Grenzfälle suchen, Regelverstöße melden.
3. **Regel:** Niemals lässt man denselben Subagenten seine eigene Arbeit
   verifizieren. Implementierung und Verifikation sind getrennte Sessions.
4. Der Orchestrator führt zusammen, behebt Integrationsbrüche und committet.

Subagenten bekommen **nicht** die ganze `Plan.md`, sondern den relevanten
Ausschnitt + Regeln — sonst arbeiten sie am Ziel vorbei.

## 8. Git

- Kleine, thematische Commits; ein Commit = eine logische Änderung.
- `main` bleibt lauffähig (`pnpm check` grün).
- `node_modules/`, `dist/`, Testartefakte sind gitignored — nie committen.
- Kein `git push` ohne ausdrückliche Anweisung des Nutzers.

## 9. Umgang mit Unsicherheit

- Nichts erfinden: API-Formen (AI SDK, File System Access API, Provider-CORS)
  werden gegen die Doku oder lokalen Quellcode verifiziert, nicht aus dem
  Gedächtnis behauptet. Unverifiziertes wird als `UNVERIFIED` markiert.
- Wenn eine Anforderung mit §2 (Browser-only) kollidiert: **melden**, nicht
  heimlich einen Server einbauen.

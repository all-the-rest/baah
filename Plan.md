# Plan.md — `opencode-harness-web`

> **Status:** Entwurf v1 (Phase 0 abgeschlossen, Recherche läuft).
> Abschnitte mit ⏳ werden aus der laufenden Recherche belegt, nicht geraten.
> **Regeln:** siehe [`AGENTS.md`](AGENTS.md) — insbesondere §2 *Browser-only* (hart)
> und §4 *Ein Tool = ein Package*.

---

## 1. Ziel

Eine **web-first Coding-Harness**: eine Web-App, die den *Basis-Werkzeugkasten*
und den *Agent-Loop* einer Coding-Harness rein im Browser nachbaut.

Der Nutzer öffnet eine URL, verbindet einen Projektordner, hinterlegt seinen
Provider-Key — und hat eine Harness, die Dateien liest/schreibt/sucht, Aufgaben
plant, Subagenten startet und den Verlauf über Reloads hinweg behält.
**Ohne Backend, ohne Installation.**

Vorbild ist der Werkzeugkasten einer etablierten Harness (OpenCode und die
Tools, die der Autor dieses Plans selbst benutzt). Wir bauen nicht „irgendwas
mit KI“, sondern gezielt **dieses Tool-Set** nach — nur eben web-first.

**Definition of Done für v1:**

1. Onboarding führt von null zu einem lauffähigen Workspace (Provider + Key +
   Modell + Ordner) — ohne Doku lesen zu müssen.
2. Der Agent-Loop läuft browser-intern mit Multi-Step-Tool-Calling.
3. Tier 1 (§4) ist vollständig implementiert, jedes Tool mit eigener
   Test-Suite.
4. Sessions/Nachrichten/Tool-Calls stehen in der Browser-DB und überleben einen
   Reload; unterbrochene Turns sind erkennbar und wiederholbar.
5. Settings lassen sich als JSON exportieren und re-importieren.

## 2. Nicht-Ziele

| Nicht-Ziel | Begründung |
|---|---|
| **Server / Backend jeder Art** | Projektdefinition (`AGENTS.md` §2). Provider ohne CORS werden *nicht* per Proxy unterstützt. |
| **MCP** | Vertagt, siehe §11. Großer eigener Block (Transport, Auth, Tool-Namespacing, UI). |
| **Echte native Shell** | Kein `child_process` im Browser. Optionen in §5.4, aber nicht v1. |
| **Vollständiges LSP/Debugging** | Nicht Teil des Basis-Sets. |
| **Multi-User, Accounts, Cloud-Sync** | Wäre wieder ein Server. Export/Import (§8) deckt den Umzug ab. |
| **Headless-Browser-Steuerung** | Ein Browser steuert sich nicht selbst; das ist ein Feature *anderer* Harnesses. |

## 3. Harte Constraints

1. **Browser-only.** Kein Server, kein SSR, kein Proxy. Runtime = Browser-Tab +
   Web Worker.
2. **Persistenz nur im Browser** (IndexedDB oder SQLite-WASM/OPFS). Konsequenz
   für die UX: *„Browserdaten löschen = Verlauf weg"* — deshalb Export/Import.
3. **Provider direkt per `fetch`.** Die unterstützte Provider-Liste ergibt sich
   aus der CORS-Matrix (§9), nicht aus einer Wunschliste.
4. **Dateizugriff nur mit Erlaubnis** — File System Access API (Nutzer wählt
   Ordner) oder privater OPFS-Sandbox-Ordner. Keine beliebigen Pfade.
5. **Keine Secrets im Repo.** Keys nur im Browser-Storage.

## 4. Das Basis-Tool-Set (Projektinhalt)

**Ein Tool = ein Package** (`AGENTS.md` §4). Die Tabelle ist die
Arbeitsliste; jede Zeile wird unabhängig implementiert und unabhängig
verifiziert (§12).

### Tier 1 — Datei-I/O und Suche (das Minimum einer Coding-Harness)

| Tool | Package | `access` | Web-first Realisierung | Machbar |
|---|---|---|---|---|
| `read` | `@ohw/tool-read` ✅ | read | `getFile()` → `text()`, Zeilennummern, `offset`/`limit`, Binär-Abweisung, Zeilen-Truncation | ✅ fertig |
| `write` | `@ohw/tool-write` | write | `getFileHandle(create)` → `createWritable()` → `write`/`close` | ✅ |
| `edit` | `@ohw/tool-edit` | write | exakter String-Ersatz; Fehler bei 0 Treffern; `>1` nur mit `replaceAll` | ✅ |
| `list` | `@ohw/tool-list` | read | `dirHandle.values()`; Verzeichnisse mit `/` markiert | ✅ |
| `glob` | `@ohw/tool-glob` | read | Walker über `values()` + `picomatch`/`minimatch`; Ergebnis sortiert | ✅ (Perf ⏳) |
| `grep` | `@ohw/tool-grep` | read | Walker + `RegExp` über Dateiinhalte; Musterfilter, `head_limit`, ignoriert Binärdateien | ✅ (Perf ⏳) |
| `patch` | `@ohw/tool-patch` | write | optionaler Mehr-Hunk-Editor auf `edit`-Basis | später |

### Tier 2 — Arbeitsorganisation und Delegation

| Tool | Package | `access` | Web-first Realisierung | Machbar |
|---|---|---|---|---|
| `todowrite` | `@ohw/tool-todo` | write | Aufgabenliste in der DB, UI in der Sidebar | ✅ |
| `task` | `@ohw/tool-task` | execute | Sub-Agent mit eigenem Message-Array + reduziertem Tool-Set, im Worker; Ergebnis als Text | ✅ |
| `question` | `@ohw/tool-question` | read | UI-Karte im Transcript; `Promise`, das der Loop `await`et | ✅ |
| `skill` | `@ohw/tool-skill` | read | Markdown unter `.ohw/skills/*.md` laden und in den System-Prompt injizieren | ✅ |

### Tier 3 — Netz und Ausführung

| Tool | Package | `access` | Web-first Realisierung | Machbar |
|---|---|---|---|---|
| `webfetch` | `@ohw/tool-webfetch` | network | `fetch()` → Text; **CORS-limitiert**, nur erlaubende Origins | ⚠️ eingeschränkt |
| `websearch` | `@ohw/tool-websearch` | network | externe Such-API („bring your own key"), ebenfalls CORS-abhängig | ⚠️ |
| `shell` | `@ohw/tool-shell` | execute | kein natives Shell — Optionen §5.4; v1: **nicht** | ❌/optional |

### 4.1 Querschnitt: Projekt-Instruktionen

Kein Tool, sondern Engine-Verhalten: beim Workspace-Connect wird `AGENTS.md` im
Wurzelverzeichnis gesucht und in den System-Prompt aufgenommen (analog zum
Vorbild). Das ist die billigste „echte Harness"-Eigenschaft und gehört in
Phase 4.

### 4.2 Tool-Vertrag

Bereits implementiert in `@ohw/core`:

```ts
interface ToolDefinition<Input, Output> {
  readonly id: string;                 // "read", "grep", …
  readonly description: string;        // modell-sichtbar
  readonly access: ToolAccess;         // read | write | execute | network
  readonly inputSchema: z.ZodType<Input>;
  execute(ctx: ToolContext, input: Input): Promise<Output>;
}
```

`ToolContext` = `{ workspace, cwd, signal, approve, emit }`. **Kein Tool greift
direkt auf IndexedDB oder UI zu.** `access` steuert das Permission-System
(§7): `read` läuft frei, alles andere fragt (oder nutzt eine erteilte
Dauerfreigabe). `inputSchema` ist die einzige Quelle der Parameter-Wahrheit —
sie geht an das Modell *und* an die Validierung.

## 5. Architektur

```
┌──────────────────────────── Browser-Tab ─────────────────────────────┐
│  apps/web  (React 19 + Vite + Tailwind 4 + daisyUI 5)                │
│   Onboarding-Wizard · Transcript · Tool-Karten · Approval-Cards ·     │
│   Todo-Sidebar · Settings · Export/Import · Workspace-Picker          │
│                              │ PostMessage                            │
│  ────────────────────────────┼──────────────────────────────────────  │
│  packages/core  (Harness-Engine, Node-frei)                           │
│   Agent-Loop · Tool-Registry · Workspace-Abstraktion · Storage        │
│   AI SDK: streamText + stopWhen + tool(inputSchema)                   │
│                              │                                        │
│  Web Worker: FS-Walker · Suche · DB-Writer                            │
│  packages/tools/*  (read, write, edit, list, glob, grep, …)           │
└───────────────────────────────────────────────────────────────────────┘
                                  │ fetch (CORS)
                            LLM-Provider-API
```

**Abhängigkeitsrichtung:** `apps/web` → `packages/tools/*` → `packages/core`.
Niemals zurück. `core` kennt keine konkreten Tools, kein React, kein DOM.

### 5.1 Engine-Loop (Skizze)

```
User-Turn
  → Prompt bauen (System + AGENTS.md + Skills + Verlauf)
  → streamText({ model, messages, tools, stopWhen: stepCountIs(N), abortSignal })
  → pro Step: Text-Deltas persistieren, Tool-Calls einsammeln
  → Tool-Ausführung: access != "read" ? approve() : direkt
  → Tool-Result als part persistieren, zurück ins Modell
  → bis keine Tool-Calls mehr kommen oder Step-Limit erreicht
  → Turn-Status: complete | interrupted | error
```

### 5.2 Worker

FS-Walk, Suche und DB-Schreibvorgänge gehören nicht auf den UI-Thread. Ziel:
**ein** Worker als Single-Writer für die DB und für FS-Operationen, Kommunikation
per `PostMessage` (typisierte Nachrichten, zod-validiert).

⏳ *Offen:* ob die gewählte DB `SharedArrayBuffer` (⇒ COOP/COEP-Header)
braucht. Eine rein statische SPA kann Response-Header nicht setzen — falls das
zutrifft, fällt die Engine auf IndexedDB zurück (siehe §13, Recherche C).

### 5.3 Workspace-Abstraktion

Ein Interface, mehrere Implementierungen (`@ohw/core`, bereits vorhanden):

| Implementierung | Zweck | Status |
|---|---|---|
| `createMemoryWorkspace` | Tests, Demo, „kein Ordner nötig" | ✅ fertig |
| `FileSystemAccessWorkspace` | echter Projektordner via `showDirectoryPicker()` | Phase 5 |
| `OpfsWorkspace` | privater Sandbox-Ordner, immer verfügbar | Phase 1 |

Beide Produktions-Varianten erfüllen dasselbe `Workspace`-Interface
(`stat`, `exists`, `readText`, `writeText`, `list`, `remove`, `walk`). Tools
kennen nur dieses Interface — deshalb sind sie ohne Browser testbar.

### 5.4 Shell-Optionen (bewusst nicht v1)

| Option | Was | Aufwand | v1 |
|---|---|---|---|
| A — virtuelle Shell | Mini-Interpreter für ~8 Kommandos (`ls`, `cat`, `echo`, `mkdir`, `rm`, `mv`, `grep`) auf der FS-Abstraktion | S | optional |
| B — WASM-Tools/WASI | kompilierte Unix-Tools auf einem gemounteten WASM-FS, nicht auf dem echten Ordner | M | nein |
| C — WASM-Node im Browser | echtes Node + Shell im Browser; Lizenz-, Größen- und Header-Themen | L | nein |

Begründung: Ein Modell arbeitet mit strukturierten Tools (`read`/`grep`/`glob`/
`edit`) präziser und sicherer als mit einer halbgaren Shell. Eine *schlechte*
Shell ist schlechter als keine.

## 6. Datenmodell

⏳ Finalisierung aus Recherche C. Entwurf:

```sql
sessions(id, title, workspace_id, parent_session_id, created_at, updated_at, archived)
messages(id, session_id, role, seq, created_at, status, model, provider)
  -- status: streaming | complete | interrupted | error
parts(id, message_id, idx, type, data_json)
  -- type: text | reasoning | tool_call | tool_result | file | error
tool_invocations(id, message_id, tool_call_id, tool_name, input_json,
                 state, output_json, error, started_at, finished_at)
approvals(id, tool_call_id, decision, scope, decided_at)
todos(session_id, id, content, status, priority, seq)
workspaces(id, name, kind, label, created_at)
file_handles(workspace_id, handle)      -- FileSystemDirectoryHandle, structured clone
settings(key, value_json)
```

Design-Entscheidungen:

- **`seq`** (Integer, pro Session) ist der Sortierschlüssel, **nicht** der
  Zeitstempel — zwei Nachrichten können in derselben Millisekunde entstehen.
- **Partielle Assistenten-Antworten** werden inkrementell an denselben
  `part`-Datensatz angehängt; `messages.status` markiert beim Laden, was als
  unterbrochen gilt.
- **Token/Kosten** werden pro Message mitgeschrieben (Anzeige + Budget).

## 7. Permissions (Reimplementierung des Vorbilds)

Das Vorbild kennt `ask`/`allow`/`deny`. Für eine Web-App:

| `access` | Default | UI |
|---|---|---|
| `read` | allow | keine Rückfrage |
| `write` | ask | Approval-Card mit Diff-Vorschau; „einmal / Session / immer" |
| `execute` | ask | Approval-Card mit dem exakten Input |
| `network` | ask | Approval-Card mit der Domain (wichtig bei `webfetch`) |

- „Immer" wird als Regel in `settings` persistiert (pro Tool, bei Shell später
  pro Kommando-Muster).
- Jede Entscheidung landet in `approvals` — nachvollziehbar im Transcript.
- **Regel:** Ein Tool darf seine eigene Freigabe nicht erteilen; die Freigabe
  kommt ausschließlich aus der UI über `ToolContext.approve`.

## 8. Onboarding & Settings-Export

### 8.1 Onboarding (Erststart)

1. **Willkommen** — ein Satz, was die App ist; „alles bleibt in diesem Browser".
2. **Provider** — nur CORS-taugliche (§9); Auswahl.
3. **Key** — Eingabe + „Verbindung testen" (minimaler Call). Hinweis, wo der Key
   liegt und wie man ihn wieder löscht.
4. **Modell** — Katalog mit Kontextlänge und Preis.
5. **Workspace** — „Ordner verbinden" (`showDirectoryPicker`) *oder* Sandbox
   (OPFS). Danach Vorschau: wie viele Dateien, `AGENTS.md` gefunden?
6. **Fertig** — landet im Chat, Vorschlag: „erkläre mir dieses Projekt".

Der Wizard muss überspringbar sein und später aus den Settings erneut
aufrufbar.

### 8.2 Settings-Export/Import

- **Export:** eine JSON-Datei mit `version`-Feld (Migrationsanker), Provider-,
  Modell-, Theme-, Permission- und Instruktions-Einstellungen.
- **Keys standardmäßig NICHT enthalten**; separater, warnender Haken
  „Keys mitschreiben (unsicher)".
- **Import:** zod-validiert, mit Diff-Vorschau („was ändert sich?"), nie blind
  überschreiben.
- **Session-Export** zusätzlich als Markdown und JSON (Transcript; kein Key).

## 9. Provider (CORS entscheidet)

⏳ Beleg aus Recherche B. Prinzip: unterstützt ist, was der Browser direkt
aufrufen darf. Bekannte Kandidaten: OpenAI (vermutlich ja), Anthropic
(vermutlich nur mit Spezial-Header), Google (zu prüfen), OpenRouter (gilt als
CORS-freundlich), beliebige OpenAI-kompatible `baseURL` (betreiberabhängig).

Die UI listet nur funktionierende Provider und erklärt bei Ablehnung *warum* —
statt einen Proxy nachzurüsten.

## 10. Roadmap

Jede Phase endet mit `pnpm check` grün **und** unabhängiger Verifikation (§12).

| Phase | Inhalt | Fertig, wenn |
|---|---|---|
| **0 — Fundament** ✅ | Repo, pnpm-Workspace, TS 7/Tailwind 4/daisyUI 5, `core`-Verträge, `read`-Tool, `Plan.md`, `AGENTS.md` | `pnpm check` grün; 17 Tests |
| **1 — Engine-Kern** | `write`, `edit`, `list`, OPFS-Workspace, Storage-Adapter, Loop-Skelett gegen Mock-Modell | Contract-Tests aller Tools; Loop läuft headless im Test |
| **2 — Suche** | `glob`, `grep`, ignore-Filter, Worker-Auslagerung, Perf-Smoke (≥10k Dateien) | Suche blockiert UI nicht; Benchmark dokumentiert |
| **3 — UI + Onboarding** | Transcript, Tool-Karten, Approval-Cards, Wizard, Settings, Export/Import | Playwright: 0 → Chat, Reload-Resilienz, Export→Import |
| **4 — Tier 2** | `todowrite`, `question`, `skill`, `AGENTS.md`-Injektion, `task`/Subagent | Subagent läuft isoliert mit eigenem Kontext |
| **5 — Härtung** | FS-Access-Workspace (echter Ordner), Resume nach Reload, Token/Kosten, `webfetch` | Reconnect-Test: Reload mitten im Turn → sauberer Zustand |
| **6 — optional** | virtuelle Shell (§5.4 A), MCP-Spike, Tree-Sitter-Highlighting | — |

## 11. MCP — vertagt, aber vorgesehen

Browser-only wäre MCP machbar (Streamable HTTP + OAuth-PKCE; lokale
stdio-Server nie). Es ist trotzdem kein v1-Thema: Transport, Auth,
Tool-Namespacing und eine Server-Verwaltungs-UI sind ein eigener Block.

**Design-Vorsorge:** Die Tool-Registry ist bereits generisch. Ein MCP-Tool wäre
später eine weitere `ToolDefinition`-Quelle neben den Built-ins — kein Umbau.

## 12. Verifikation & Delegation

### 12.1 Test-Strategie

- **Unit (vitest):** `packages/core` und jedes Tool-Package gegen
  `createMemoryWorkspace()`. Kein DOM, kein Browser → läuft in CI.
- **Contract-Tests:** Jedes Tool erfüllt dieselbe Suite — Happy Path,
  Fehlerfall (nicht gefunden, kein File, binär), Root-Escape, große Datei,
  Permission-Verweigerung.
- **E2E (Playwright, ab Phase 3):** Wizard, Chat mit gemocktem `fetch`,
  Reload-Resilienz, Export→Import-Roundtrip.
- **Manuell (dokumentationspflichtig):** alles mit echten Browser-APIs
  (`showDirectoryPicker`, Permission-Re-Request, OPFS-Eviction).

### 12.2 Delegations-Matrix

Der Orchestrator implementiert nicht selbst, sondern schneidet und prüft.
**Implementierung und Verifikation sind immer getrennte Sessions**
(`AGENTS.md` §7).

| Einheit | Implementer bekommt | Verifier prüft |
|---|---|---|
| Tool-Package (z. B. `glob`) | Vertrag aus §4.2, `read` als Vorlage, Akzeptanzkriterien, Contract-Suite | Root-Escape, Muster-Syntax, Sortierung, Perf |
| Storage-Adapter | Schema aus §6, Engine-Entscheid aus §13 | Migration, Reload, Streaming-Append, Idempotenz |
| Loop | Loop-Skizze §5.1, Mock-Modell | Step-Limit, Abbruch, Fehlerpfad, Persistenz pro Step |
| UI-Slice | Wireframe-Beschreibung + Datenvertrag | Wizard-Durchlauf, Approval-Fluss, Export→Import |

Ein Subagent bekommt **nur** den relevanten `Plan.md`-Ausschnitt plus
`AGENTS.md` — nicht das ganze Dokument.

## 13. Offene Fragen (Recherche)

| # | Frage | Strang |
|---|---|---|
| 1 | IndexedDB vs. SQLite-WASM/OPFS — welche Engine? | C ⏳ |
| 2 | Braucht SQLite-WASM `SharedArrayBuffer`/COOP-COEP — verträgt sich das mit einer statischen SPA? | C ⏳ |
| 3 | Läuft der AI-SDK-Loop vollständig im Browser (Flags, Bundling)? | B ⏳ |
| 4 | Welche Provider erlauben CORS direkt? | B ⏳ |
| 5 | `grep`/`glob` ohne natives ripgrep: welche Perf bei ≥10k Dateien? | C ⏳ |
| 6 | Wie weit trägt ein WASM-Node/WebContainer als Shell-Ersatz? | C ⏳ |
| 7 | Exakter Tool-Katalog + Loop-Semantik des Vorbilds (Truncation, Parallelität, Fehlerform) | A ⏳ |
| 8 | Modellkatalog-Quelle und Preis-Anzeige (`@opencode-ai/models`?) | B ⏳ |

## 14. Recherche-Anhang

Wird nach Abschluss der Stränge befüllt:

- **A — Vorbild-Innenleben:** Tool-Katalog, Agent-Loop, Datenmodell,
  Config/Permissions. *Zweck: unsere Tools sind gegen ein echtes Vorbild
  gespiegelt statt erfunden.*
- **B — Vercel AI SDK:** Loop-API, Streaming, Browser-Runtime, Provider-CORS,
  Persistenz-Primitive, Lücken.
- **C — Browser-FS & Browser-DB:** File System Access API vs. OPFS, Worker,
  WASM-Werkzeuge (Suche/Glob/Diff/Highlighting), DB-Wahl, Shell-Optionen.

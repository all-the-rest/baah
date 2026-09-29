# Plan.md — `opencode-harness-web`

> **Status:** Entwurf (Phase 0). Recherche läuft, Abschnitte mit ⏳ sind noch zu belegen.
> **Regeln:** siehe [`AGENTS.md`](AGENTS.md) — insbesondere §2 *Browser-only* (hart).

---

## 1. Ziel

Eine **web-first Coding-Harness**: eine Web-App, die den *Basis-Werkzeugkasten* und
den *Agent-Loop* einer Coding-Harness (Vorbild: OpenCode, sowie die Tools, die der
Autor dieses Plans selbst zur Verfügung hat) rein im Browser nachbaut.

Anders formuliert: Der Nutzer öffnet eine URL, verbindet einen lokalen
Projektordner, hinterlegt seinen Provider-Key — und hat dann eine Coding-Harness,
die Dateien liest/schreibt/sucht, Aufgaben plant, Subagenten startet und den
Gesprächsverlauf über Reloads hinweg behält. **Ohne Backend.**

Erfolgskriterium für v1 (Definition of Done):

1. Onboarding-Wizard führt von null zu einem lauffähigen Workspace
   (Provider + Key + Modell + Ordner).
2. Ein Agent-Loop läuft browser-intern mit Multi-Step-Tool-Calling.
3. Das Tool-Set aus §4 (Tier 1) ist implementiert und getestet.
4. Sessions/Nachrichten/Tool-Calls stehen in der Browser-DB und überleben einen
   Reload; unterbrochene Turns sind erkennbar und wiederholbar.
5. Settings lassen sich als JSON exportieren und re-importieren.

## 2. Nicht-Ziele (bewusst)

| Nicht-Ziel | Warum |
|---|---|
| **Server / Backend jeglicher Art** | Projektdefinition, siehe `AGENTS.md` §2. Provider, die CORS verbieten, werden nicht „per Proxy“ unterstützt. |
| **MCP-Support** | Zurückgestellt (siehe §11). Wäre reizvoll, ist aber ein eigener großer Block (Transport, Auth, Tool-Mapping, UI). |
| **Echte native Shell** | Kein `child_process` im Browser. Es gibt Optionen (§5.3), aber sie sind ein *optionaler* Ausbau, nicht v1. |
| **Vollständiges LSP / Debuggen** | Nicht Kern des Basis-Sets. Später höchstens als Web-Tree-Sitter-Highlighting. |
| **Multi-User / Accounts / Sync** | Wäre wieder ein Server. Export/Import (§7) deckt den Umzug ab. |
| **Headless-Browser-Tools im Browser** | Ein Browser kann sich nicht selbst fernsteuern; das ist der `browser.*`-Teil *dieser* Harness, nicht des Nachbaus. |

## 3. Harte Constraints

1. **Browser-only.** Kein Server, kein SSR, kein Proxy. Ziel-Runtime: Browser-Tab
   + Web Worker.
2. **Alles was persistiert, persistiert im Browser** (IndexedDB bzw. SQLite-WASM
   über OPFS). Der Nutzer muss wissen: *Cache löschen = Daten weg*. Deshalb
   Export/Import.
3. **Provider direkt.** Der Browser spricht per `fetch` mit den Provider-APIs.
   Auswahl der unterstützten Provider richtet sich nach der CORS-Matrix (§8).
4. **Dateizugriff nur mit Nutzer-Erlaubnis** (File System Access API) oder im
   privaten OPFS-Sandbox-Ordner. Kein Zugriff auf beliebige Pfade.
5. **Keine Secrets im Repo.** Keys ausschließlich im Browser-Storage.

## 4. Das Basis-Tool-Set (Kern des Nachbaus)

Referenz ist der Werkzeugkasten einer Coding-Harness. Die linke Spalte sind die
*Konzept-Tools*, die eine solche Harness ausmachen; die rechte Spalte ist die
web-first Realisierung. **Das ist der eigentliche Projektinhalt.**

### Tier 1 — Datei-I/O und Suchen (das Minimum einer Coding-Harness)

| Konzept-Tool | Zweck | Web-first Realisierung | Machbar? |
|---|---|---|---|
| `read` | Datei lesen, mit Zeilennummern, `offset`/`limit` | `FileSystemFileHandle.getFile()` → `text()`, danach Zeilennummern-Präfix im Tool-Result | ✅ |
| `write` | Datei (über)schreiben | `getFileHandle(name, {create:true})` → `createWritable()` → `write`/`close` | ✅ |
| `edit` | **Exakter** String-Ersatz, Fehler bei 0 oder >1 Treffer | `read` → `indexOf`/`lastIndexOf`-Prüfung → `write`; `replaceAll`-Flag | ✅ |
| `glob` | Pfad-Muster (`**/*.ts`) | eigener Walker über `FileSystemDirectoryHandle.values()` + `picomatch`/`minimatch`; `<dir>`-Marker wie bei Harness-Glob | ✅ |
| `grep` | Regex-Inhaltssuche, Dateimuster-Filter, `head_limit` | Walker + `File.text()` + `RegExp`; im Worker, chunked; optional WASM-`ripgrep` | ✅ (Perf ⏳) |
| `list` | Verzeichnisinhalt | `dirHandle.values()` | ✅ |
| `gitignore`-Filter | Ignorierte Pfade überspringen | `.gitignore` aus dem Workspace lesen und parsen; Default-Ignores (`node_modules`, `dist`) | ✅ |

### Tier 2 — Arbeitsorganisation und Delegation

| Konzept-Tool | Zweck | Web-first Realisierung | Machbar? |
|---|---|---|---|
| `todowrite` / `todoread` | Aufgabenliste des Agenten | identische Semantik, Persistenz in der Browser-DB (Tabelle `todos`), UI im Sidebar | ✅ |
| `task` (Subagent) | Sub-Agent mit **eigenem** Kontext, eigenem Tool-Set, eigener Session | zweiter Agent-Loop im selben Tab (Web Worker) mit eigenem Message-Array; Ergebnis als zusammengefasster Text zurück | ✅ |
| `question` | Agent stellt dem Nutzer eine Frage und wartet | UI-Karte im Transcript; `Promise`, das der Loop `await`et | ✅ |
| `skill` | Vorab-Instruktionen (Markdown) laden | Markdown-Dateien aus dem Workspace (`.ohw/skills/*.md`) laden und in den System-Prompt injizieren | ✅ |
| `AGENTS.md`-Instruktionen | Projektregeln automatisch laden | beim Workspace-Connect `AGENTS.md` im Wurzelverzeichnis suchen und in den System-Prompt aufnehmen | ✅ |

### Tier 3 — Netz und Ausführung

| Konzept-Tool | Zweck | Web-first Realisierung | Machbar? |
|---|---|---|---|
| `webfetch` | URL → Text | `fetch()` + `Response.text()`. **Achtung:** CORS — nur Seiten, die es erlauben, oder über eine öffentliche CORS-fähige Umleitung. Ehrlich als Einschränkung dokumentieren. | ⚠️ eingeschränkt |
| `websearch` | Websuche | externe Such-API, ebenfalls CORS-abhängig; optional „bring your own key“ | ⚠️ |
| `shell` | Kommandos ausführen | **kein natives Shell.** Optionen siehe §5.3: (a) virtuelle Shell mit Kommando-Whitelist (`ls`, `cat`, `grep`, `echo`, `mkdir`, `rm`, `mv`) auf der FS-Abstraktion, (b) WASM-Node (WebContainers) als optionaler Modus. | ⚠️/❌ |
| `execute` (Code-Mode) | Tool-Aufrufe scripten | Code in einem Sandbox-`iframe`/Worker ausführen, der nur die Harness-Tools sieht | ✅ später |

**Konsequenz für v1:** Tier 1 + Tier 2 vollständig, Tier 3 nur `webfetch` (mit
CORS-Disclaimer). Shell ist explizit ein *optionaler* Ausbau.

### 4.1 Tool-Vertrag

Damit die Tools austauschbar und testbar bleiben, gilt für **jedes** Tool:

```ts
interface HarnessTool<In, Out> {
  name: string;              // "read", "grep", ...
  description: string;      // für das Modell, inkl. Grenzen
  inputSchema: z.ZodType<In>;   // Grenze → immer zod-validiert
  execute(input: In, ctx: ToolContext): Promise<Out>;
}
```

`ToolContext` trägt: Workspace-Handle, AbortSignal, Permission-Gate,
Persistenz-Schreiber, Fortschritts-Events. **Kein Tool spricht direkt mit
IndexedDB oder der UI** — alles über den Context.

## 5. Architektur

```
┌──────────────────────── Browser-Tab ─────────────────────────┐
│  apps/web (React 19)                                          │
│   Onboarding · Chat-Transcript · Tool-Karten · Approval-Cards │
│   Settings · Export/Import · Workspace-Picker                 │
│                          │  (PostMessage / Comlink)           │
│  ────────────────────────┼──────────────────────────────────  │
│  packages/core (harness engine, Node-frei)                     │
│   Agent-Loop ── Tool-Registry ── FS-Abstraktion ── Storage     │
│   (AI SDK: streamText + stopWhen)   │            │            │
│                          │           │            │            │
│                  Web Worker: FS-Walker/     Browser-DB         │
│                  Grep + SQLite-WASM         (OPFS/IDB)         │
└──────────────────────────────────────────────────────────────┘
                              │ fetch (CORS)
                        LLM-Provider-API
```

### 5.1 Warum Worker?

Datei-Suche (`grep`/`glob`) und die DB dürfen den UI-Thread nicht blockieren.
Ziel: FS-Walker + Suche + DB in einem Worker. ⏳ *Zu belegen:* ob SQLite-WASM
`SharedArrayBuffer` (und damit COOP/COEP-Header, die eine reine statische SPA
nicht setzen kann) braucht — falls ja, ist IndexedDB die einfachere Wahl.

### 5.2 FS-Abstraktion

Ein Interface, zwei Implementierungen:

- `FileSystemAccessWorkspace` — echter Projektordner, vom Nutzer per
  `showDirectoryPicker()` freigegeben; Handles werden in IndexedDB persistiert,
  nach Reload wird die Permission erneut erbeten.
- `OpfsWorkspace` — privater Sandbox-Ordner (`navigator.storage.getDirectory()`),
  immer verfügbar, gut für „einfach mal ausprobieren“ ohne Ordner-Freigabe.

Beide erfüllen dasselbe `Workspace`-Interface (`read`, `write`, `list`, `stat`,
`walk`). Tools kennen nur dieses Interface.

### 5.3 Shell-Optionen

| Option | Was es ist | Aufwand | v1? |
|---|---|---|---|
| A — virtuelle Shell | Eigenes Mini-Interpreter für ~8 Kommandos auf der FS-Abstraktion; kein echtes Prozessmodell, keine Pipes zu echten Binaries | klein | optional |
| B — WASM-Busybox / WASI | kompilierte Unix-Tools, laufen auf einem gemounteten WASM-FS; nicht auf dem echten Projektordner | mittel | nein |
| C — WebContainers (WASM-Node + Service Worker) | echtes Node im Browser, echter Shell-Zugriff; Lizenz-/Größen-/COOP-COEP-Themen | groß | nein |

Für v1 gilt: das Modell bekommt statt Shell die *strukturierten* Tools (`read`,
`grep`, `glob`, `edit`) — genau so, wie eine gute Harness es ohnehin bevorzugt.

## 6. Datenmodell

⏳ Wird aus der DB-Recherche finalisiert. Entwurf:

```sql
sessions(id, title, workspace_id, created_at, updated_at, parent_session_id, archived)
messages(id, session_id, role, created_at, seq, status)           -- status: streaming|complete|interrupted|error
parts(id, message_id, idx, type, data_json)                        -- text|reasoning|tool_call|tool_result|file|error
tool_invocations(id, message_id, tool_call_id, tool_name, input_json, state, output_json, error, started_at, finished_at)
approvals(id, tool_call_id, decision, reason, decided_at)          -- ask/allow/deny
todos(session_id, id, content, status, priority, seq)
workspaces(id, name, kind, label, created_at)                      -- kind: fs-access|opfs
file_handles(workspace_id, handle)                                 -- FileSystemDirectoryHandle (structured clone)
settings(key, value_json)                                          -- Provider, Theme, Permissions, Export-Version
```

`seq` ist der Sortierschlüssel pro Session — nicht die Wanduhr, weil zwei
Nachrichten in derselben Millisekunde entstehen können. Partielle Assistenten-
Antworten werden **inkrementell** an denselben `part`-Datensatz angehängt;
`status` markiert beim Laden, was als „unterbrochen“ gilt.

## 7. Onboarding & Settings-Export

### 7.1 Onboarding (Erststart)

1. **Willkommen** — kurz: was die App ist, dass alles lokal bleibt.
2. **Provider** — Liste der CORS-tauglichen Provider (§8), Auswahl.
3. **Key** — Eingabe, sofortiger „Verbindung testen“-Aufruf (1 Token), Hinweis
   „bleibt in diesem Browser“.
4. **Modell** — Auswahl aus dem Katalog (⏳ Quelle: `@opencode-ai/models` /
   models.dev), mit Preis-Anzeige.
5. **Workspace** — „Ordner verbinden“ (`showDirectoryPicker`) *oder* Sandbox
   (OPFS). Anschließend Vorschau, was gefunden wurde (Dateien, `AGENTS.md`?).
6. **Fertig** — landet im Chat, optional direkt „erkläre mir dieses Projekt“.

### 7.2 Settings-Export/Import

- Export: **eine** JSON-Datei mit `version`-Feld (Migrationsanker), Provider-
  Konfiguration, Modellwahl, Theme, Tool-Permissions, Custom-Instructions,
  UI-Präferenzen.
- **API-Keys sind standardmäßig ausgeschlossen**; ein bewusster Extra-Haken
  „Keys mitschreiben (unsicher)“ nimmt sie auf. Export-Datei ist bei
  eingeschlossenem Key als Klartext gekennzeichnet.
- Import: zod-validiert, mit Vorschau-Diff („was ändert sich?“), nie blind
  überschreiben.
- Zusätzlich: **Session-Export** als Markdown/JSON (Transcript, kein Key).

## 8. Provider-Auswahl (CORS-entscheidend)

⏳ *Zu belegen durch die AI-SDK-Recherche.* Prinzip: Ein Provider ist nur
unterstützt, wenn der Browser direkt mit ihm sprechen darf. Bekannte Punkte:

| Provider | Direkt aus dem Browser? | Anmerkung |
|---|---|---|
| OpenAI | ⏳ | voraussichtlich ja |
| Anthropic | ⏳ | vermutlich nur mit speziellem Header (`anthropic-dangerous-direct-browser-access`) |
| Google | ⏳ | zu prüfen |
| OpenRouter | ⏳ | gilt als CORS-freundlich |
| Beliebige OpenAI-kompatible `baseURL` | ⏳ | hängt vom Betreiber ab |

Daraus folgt: Die Provider-Liste der App ist **nicht** „alle Provider der Welt“,
sondern „die, die das CORS-Kriterium erfüllen“ — und die UI erklärt bei
Ablehnung, warum.

## 9. Roadmap (Phasen)

Jede Phase endet mit: `pnpm check` grün + Verifikation durch einen
**unabhängigen** Subagenten (`AGENTS.md` §7).

| Phase | Inhalt | Fertig, wenn |
|---|---|---|
| **0 — Fundament** ✅/⏳ | Repo, Workspace, TS/Tailwind/daisyUI, `Plan.md`, `AGENTS.md`, Recherche | `pnpm check` grün, Plan steht |
| **1 — Engine-Kern** | FS-Abstraktion (OPFS zuerst), Storage-Adapter, Tool-Vertrag, Loop-Skelett mit `read`/`write`/`edit` | Unit-Tests für FS + `edit`-Eindeutigkeit; Loop läuft gegen ein Mock-Modell |
| **2 — Tool-Set Tier 1** | `glob`, `grep`, `list`, ignore-Filter, Worker-Auslagerung | Tests inkl. Perf-Smoke; Worker blockiert UI nicht |
| **3 — UI + Onboarding** | Transcript, Tool-Karten, Approval-Cards, Wizard, Settings, Export/Import | Durchlauf von 0 auf Chat im Browser, per Playwright belegt |
| **4 — Tier 2** | `todowrite`/`todoread`, `question`, `skill`, `AGENTS.md`-Injektion, `task`/Subagent | Subagent-Session läuft isoliert mit eigenem Kontext |
| **5 — Härtung** | FS-Access-Workspace (echter Ordner), Reload/Resume, Kosten-/Tokenanzeige, `webfetch` | Reconnect-Test: Reload mitten im Turn → sauberer Zustand |
| **6 — optional** | virtuelle Shell (§5.3 A), MCP-Spike, Tree-Sitter-Highlighting | — |

## 10. Test-Strategie

- **Unit (vitest):** `packages/core` gegen einen **In-Memory-Workspace** und eine
  **Mock-Persistenz**. Kein DOM nötig → schnell und CI-tauglich. Das ist der
  Grund für die Trennung `core` / `web`.
- **Contract-Tests:** Jedes Tool erfüllt dieselbe Test-Suite (Happy Path,
  Fehlerfall, Permission-Verweigerung, große Datei, Binärdatei).
- **E2E (Playwright, ab Phase 3):** Wizard-Durchlauf, Chat mit Fake-Provider
  (gemockter `fetch`), Reload-Resilienz, Export→Import-Roundtrip.
- **Manuell (dokumentationspflichtig):** alles, was echte Browser-APIs braucht
  (`showDirectoryPicker`, Permission-Re-Request, OPFS-Eviction).
- **Regel:** Kein Feature gilt als fertig ohne Test oder dokumentierten
  manuellen Prüfschritt.

## 11. MCP — bewusst vertagt

MCP wäre in einer browser-only Harness machbar (Streamable HTTP + OAuth-PKCE;
lokale stdio-Server aber nie). Es ist dennoch kein v1-Thema, weil es einen
eigenen Werkzeugkasten braucht (Transport, Auth, Tool-Namespacing, UI für
Server-Verwaltung). **Vorgesehener Platz im Design:** die Tool-Registry aus §4.1
ist bereits generisch — ein MCP-Tool wäre später nur eine weitere
`HarnessTool`-Quelle neben `builtin` und `skill`.

## 12. Offene Fragen

1. Browser-DB: IndexedDB (einfach) vs. SQLite-WASM/OPFS (mächtig)? → ⏳ Recherche.
2. Braucht SQLite-WASM `SharedArrayBuffer`/COOP-COEP — verträgt sich das mit
   einer statischen SPA? → ⏳
3. Läuft der AI-SDK-Loop wirklich vollständig im Browser (Flags, Bundling)? → ⏳
4. Größe des Workspace-Ordners, den wir per Walker vertragen (10k? 100k Dateien)?
   → Benchmark in Phase 2.
5. Subagenten: eigener Worker pro Task oder Zeitmultiplex in einem Worker?
6. Modellkatalog-Quelle und Preis-Anzeige (`@opencode-ai/models` vs.
   eigener Fetch) → ⏳

## 13. Recherche-Anhang

Wird nach Abschluss der drei Recherche-Stränge befüllt:

- **A — OpenCode-V2-Innenleben:** Tool-Katalog, Agent-Loop, Server-API,
  Datenmodell, Config/AGENTS.md, Permission-Modell.
  *Zweck: unsere Konzept-Tools (§4) sind gegen ein echtes Vorbild gespiegelt.*
- **B — Vercel AI SDK:** Agent-Loop-API, Streaming-Protokoll, Browser-Runtime,
  Provider-CORS, Persistenz-Primitive, Lücken.
- **C — Browser-FS + Browser-DB:** File System Access API vs. OPFS, Worker,
  WASM-Werkzeuge (Suche/Glob/Diff/Highlighting), Datenbank-Wahl.

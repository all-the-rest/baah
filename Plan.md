# Plan.md — `opencode-harness-web`

> **Status:** Entwurf v1 (Phase 0 abgeschlossen, Recherche läuft).
> Abschnitte mit ⏳ werden aus der laufenden Recherche belegt, nicht geraten.
> **Regeln:** siehe [`AGENTS.md`](AGENTS.md) — insbesondere §2 *Browser-only* (hart)
> und §4 *Ein Tool = ein Package*.

---

## 0. Projektname & Rename (entschieden, noch nicht ausgeführt)

| Ding | Ziel |
|---|---|
| Projektname | **`baah`** — „**B**rowser **a**s **a** **H**arness" |
| npm-Scope | `@all-the-rest` |
| Root-Package | `@all-the-rest/baah` |
| App | `@all-the-rest/baah-web` |
| Engine | `@all-the-rest/baah-core` |
| Tools | `@all-the-rest/baah-tool-<id>` (z. B. `baah-tool-read`) |
| Verzeichnis | `/projects/baah-harness` |
| GitHub-Repo | `all-the-rest/baah` (voraussichtlich) |

**Ist-Zustand bis zum Rename:** Verzeichnis `opencode-harness-web`,
Scope `@ohw`, Pakete `@ohw/{web,core,tool-*}` (~50 Textstellen in 20 Dateien).

**Reihenfolge (Nutzerentscheidung):** Der Rename passiert **erst nach Abschluss
der Recherche** (§14), damit die Recherche-Dokumente nicht zweimal angefasst
werden. Der Rename ist ein eigener Commit, kein Nebenprodukt einer
Feature-Änderung. Danach ist `@ohw` im Repo verboten.

**Warum der Name:** `baah` beschreibt genau die Projektdefinition (§1) und
vermeidet die Verwechslung mit OpenCode, das nur *Vorbild* ist, nicht
Bestandteil.

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
| `write` | `@ohw/tool-write` ✅ | write | `getFileHandle(create)` → `createWritable()` → `write`/`close`; 5-MB-Guard, Verzeichnis-Guard | ✅ fertig |
| `edit` | `@ohw/tool-edit` ✅ | write | exakter String-Ersatz; Fehler bei 0 Treffern; `>1` nur mit `replaceAll`; literale `$`-Sequenzen | ✅ fertig |
| `list` | `@ohw/tool-list` ✅ | read | `dirHandle.values()`; Verzeichnisse zuerst, `limit`/`total`/`truncated` | ✅ fertig |
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
| `FileSystemAccessWorkspace` | **echter** Projektordner via `showDirectoryPicker()` — in-place lesen *und* schreiben | Phase 5 |
| `OpfsWorkspace` | privater Sandbox-Ordner; Import + Export | Phase 1 |

**Browser-Realität (belegt, §14.1):** Die File System Access API ist
**Chromium-only** — Firefox hat eine negative Standards-Position, Safari
opponiert. Daraus folgt zwingend ein Zwei-Modus-Design:

| Modus | Browser | Verhalten |
|---|---|---|
| **In-place** | Chrome/Edge 86+ (Desktop), Chrome Android 132+ | Ordner verbinden, direkt im echten Projekt lesen/schreiben |
| **Workspace** | Firefox 111+, Safari 16.4+ | Ordner **importieren** (read-only) → in OPFS arbeiten → **exportieren** |

Die UI muss den Modus *sichtbar* machen („du arbeitest in einer Kopie") — sonst
erwartet ein Firefox-Nutzer Speicherungen auf der Platte, die nicht passieren.

**Harte technische Nebenbedingungen** (aus §14.1, alle im Design berücksichtigt):

- **Permission nur aus einem Klick.** `requestPermission()` braucht eine
  Nutzergeste auf dem **Main Thread**; ein Worker kann ein *gewährtes* Handle
  benutzen, aber nie selbst um Erlaubnis fragen. ⇒ Nach jedem Kaltstart zeigt die
  App einen „Projekt wieder öffnen"-Button, der die Permission im Click-Handler
  anfordert.
- **Handles gehören in IndexedDB** (structured clone), nicht in JSON. Sie
  referenzieren den Eintrag, nicht die Bytes.
- **Safari kann gepickte Handles nicht an einen Worker übergeben** (Stand heute
  nur Preview). ⇒ Der Worker holt sich im OPFS-Modus sein Root selbst über
  `navigator.storage.getDirectory()`; im In-place-Modus läuft der Walk auf dem
  Main Thread bzw. Chromium-only im Worker.
- **Eviction ist real:** Safari löscht skript-erzeugte Daten nach **7 Tagen ohne
  Interaktion**; OPFS ist per Default *best-effort*. ⇒ `navigator.storage.persist()`
  anfordern, den Nutzer warnen, und Export/Backup als First-Class-Feature
  behandeln (nicht als Nebenfunktion).
- **`grep`/`glob` existieren nicht** als Plattform-Primitiv ⇒ auf `list`/`read`
  aufbauen, mit Ignore-Liste, Byte-Cap und Binär-Sniffing (§14.1).


### 5.4 Shell-Optionen (bewusst nicht v1)

| Option | Was | Aufwand | v1 |
|---|---|---|---|
| A — virtuelle Shell | Mini-Interpreter für ~8 Kommandos (`ls`, `cat`, `echo`, `mkdir`, `rm`, `mv`, `grep`) auf der FS-Abstraktion | S | optional |
| B — WASM-Tools/WASI | kompilierte Unix-Tools auf einem gemounteten WASM-FS, nicht auf dem echten Ordner | M | nein |
| C — WASM-Node im Browser | echtes Node + Shell im Browser; Lizenz-, Größen- und Header-Themen | L | nein |

Begründung: Ein Modell arbeitet mit strukturierten Tools (`read`/`grep`/`glob`/
`edit`) präziser und sicherer als mit einer halbgaren Shell. Eine *schlechte*
Shell ist schlechter als keine.

## 6. Datenmodell & Persistenz (entschieden)

**Engine: `@sqlite.org/sqlite-wasm` mit dem `opfs-sahpool`-VFS, in genau einem
dedizierten Web Worker.** Belegt in §14.2 — und der ausschlaggebende Punkt:
`opfs-sahpool` braucht **kein `SharedArrayBuffer`** und damit **keine
COOP/COEP-Header**, die eine statische SPA nicht setzen kann. Der klassische
`opfs`-VFS fällt genau deshalb aus.

| Aspekt | Entscheidung |
|---|---|
| Engine | `@sqlite.org/sqlite-wasm` (WASM, FTS5 verifiziert vorhanden) |
| VFS | `opfs-sahpool` — kein COOP/COEP, schnellster OPFS-VFS, **Single Connection** |
| Query-Layer | `drizzle-orm/sqlite-proxy` — generischer async-Callback, passt exakt auf einen Worker-RPC |
| Volltextsuche | FTS5 über `parts.content_text` (external content, Trigger-basiert) |
| Handles & Blobs | **Sidecar-IndexedDB** — WASM-SQLite kann `FileSystemHandle` nicht halten |
| Multi-Tab | Ein Writer via `navigator.locks`; zweiter Tab liest oder zeigt Banner |
| Migrationen | `PRAGMA user_version` + `schema_migrations`-Tabelle, SQL aus `drizzle-kit` |

### 6.1 Schema (SQLite, `STRICT`)

```sql
sessions(id TEXT PK, title, status, model, system_prompt, metadata JSON,
         created_at, updated_at, archived_at)

turns(id PK, session_id FK, seq, status, lease_owner, heartbeat_at,
      started_at, finished_at, error, UNIQUE(session_id, seq))
  -- der Reload-/Interrupt-Anker: der Writer erneuert heartbeat_at je Flush

messages(id PK, session_id FK, turn_id FK, parent_id FK, seq, role, status,
         model, error, usage JSON, created_at, updated_at, UNIQUE(session_id, seq))

parts(id PK, message_id FK, session_id FK, seq, type, data JSON,
      content_text, status, created_at, updated_at, UNIQUE(message_id, seq))
  -- type: text|reasoning|tool_call|tool_result|file_diff|file|image|source|error|step
  -- content_text ist die denormalisierte, durchsuchbare Projektion

tool_invocations(id PK, session_id FK, message_id FK, call_part_id, result_part_id,
                 tool_name, args JSON, status, result_preview, error,
                 started_at, finished_at, created_at, updated_at)

approvals(id PK, session_id FK, tool_invocation_id FK, request JSON,
          decision, scope, decided_at, expires_at, created_at)

todos(id PK, session_id FK, seq, content, status, priority, created_at, updated_at)

workspaces(id PK, name, kind, root_handle_id, metadata JSON, created_at, last_opened_at)

file_handles(id PK, workspace_id FK, kind, name, relative_path, handle_id,
             permission, last_checked_at, UNIQUE(workspace_id, relative_path))

settings(key PK, value JSON, updated_at)
schema_migrations(version PK, name, applied_at)
```

Pragmas pro Verbindung: `foreign_keys=ON`, `journal_mode=DELETE` (WAL bringt im
Web-VFS nichts), `synchronous=NORMAL`, `busy_timeout=5000`.

### 6.2 Design-Entscheidungen

- **`seq`** (Integer, pro Parent, innerhalb der Schreibtransaktion vergeben) ist
  der Sortierschlüssel — **nicht** `created_at`. Zwei Nachrichten können in
  derselben Millisekunde entstehen. `created_at` ist reine Anzeige.
- **Parts: eine Tabelle mit `type`-Diskriminator + JSON**, nicht eine Tabelle je
  Typ. Die Part-Taxonomie folgt dem Protokoll und ändert sich; eine Nachricht
  rendern ist ein indizierter Scan statt `UNION ALL`. Schwere Fälle
  (`tool_invocations`, `approvals`) sind bewusst eigene Tabellen — dieser Hybrid
  hält den heißen Pfad einfach.
- **Streaming:** Deltas im Worker puffern, alle ~50–100 ms in **einer kurzen**
  Transaktion flushen (UPSERT auf `parts` + append-only `part_deltas` für
  Idempotenz). **Niemals** eine Transaktion über ein `await` außerhalb SQLite
  offen halten. Kein Schreiben pro Token.
- **Reload:** Beim Start `turns` mit `status='streaming'` und altem
  `heartbeat_at` auf `interrupted` setzen; Teilttext **behalten**, nicht
  verwerfen; UI bietet „Wiederholen" (neuer Turn) und „Fortsetzen" an.
- **`FileSystemHandle` liegt in IndexedDB**, nicht in SQLite — WASM hat keinen
  Zugriff auf die structured-clone-Objekte. `handle_id` ist eine Referenz per
  Konvention.

### 6.3 Was browser-only unmöglich bleibt

- Ein laufender Stream ist nach einem Reload **nicht** wieder anhängbar — die
  `ReadableStream` der Seite ist weg, es gibt keinen Server, der sie hält.
- Der Provider generiert nach dem Abbruch ggf. weiter (und rechnet ab); diese
  Tokens sind unwiederbringlich.
- Ein bereits laufendes Tool kann nicht „exactly once" wiederhergestellt werden;
  offene Approvals müssen nach dem Reload neu bestätigt werden.
- Kein Multi-Tab-/Multi-Gerät-Wahrheitsanspruch, keine Server-Retention.

Gegenmaßnahme ist bewusst UX, nicht Technik: Verlust ist auf das Flush-Intervall
begrenzt (≤ ~100 ms), und Export ist ein First-Class-Feature (§8.2).


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
| **0 — Fundament** ✅ | Repo, pnpm-Workspace, TS 7/Tailwind 4/daisyUI 5, `core`-Verträge, `read`/`write`/`edit`/`list`, `Plan.md`, `AGENTS.md`, Recherche FS + DB | `pnpm check` grün; 52 Tests |
| **1 — Engine-Kern** | OPFS-Workspace, SQLite-Worker (`sqlite-wasm` + `opfs-sahpool`), Drizzle-`sqlite-proxy`, Migrationen, Loop-Skelett gegen Mock-Modell | Contract-Tests aller Tools; Loop läuft headless im Test; Reload überlebt |
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

## 13. Offene Fragen

| # | Frage | Status |
|---|---|---|
| 1 | IndexedDB vs. SQLite-WASM/OPFS — welche Engine? | ✅ **entschieden** §6 (`sqlite-wasm` + `opfs-sahpool`) |
| 2 | Braucht SQLite-WASM `SharedArrayBuffer`/COOP-COEP — verträgt sich das mit einer statischen SPA? | ✅ **gelöst**: `opfs-sahpool` braucht es **nicht** (§14.2) |
| 3 | Läuft der AI-SDK-Loop vollständig im Browser (Flags, Bundling)? | ⏳ B |
| 4 | Welche Provider erlauben CORS direkt? | ⏳ B |
| 5 | `grep`/`glob` ohne natives ripgrep: welche Perf bei ≥10k Dateien? | ⏳ C — Sucharchitektur offen |
| 6 | Wie weit trägt ein WASM-Node/WebContainer als Shell-Ersatz? | ⏳ C |
| 7 | Exakter Tool-Katalog + Loop-Semantik des Vorbilds | ⏳ A |
| 8 | Modellkatalog-Quelle und Preis-Anzeige (`@opencode-ai/models`?) | ⏳ B |
| 9 | Multi-Tab: ein Writer via `navigator.locks` reicht das, oder braucht es `wa-sqlite OPFSCoopSyncVFS`? | ⏳ Phase 1 |
| 10 | Wie erkennt die App „dieser Workspace ist zu groß für einen Walk"? (Byte-/Datei-Budget) | ⏳ Phase 2 |

## 14. Recherche-Ergebnisse

### 14.1 Dateizugriff im Browser (abgeschlossen)

**Kernbefund: Es gibt keinen browserübergreifenden Weg auf den echten
Projektordner.** Die File System Access API ist Chromium-only (Firefox:
negative Standards-Position, Safari: opponiert). Daraus folgt das Zwei-Modus-
Design in §5.3.

| Fähigkeit | Chromium | Firefox | Safari |
|---|---|---|---|
| Ordner-Picker (`showDirectoryPicker`) | ✅ 86+ | ❌ | ❌ |
| In-place lesen/schreiben | ✅ | ❌ | ❌ |
| OPFS (`getDirectory`) | ✅ 108+ | ✅ 111+ | ✅ 16.4+ |
| Sync-Access-Handle (nur Worker) | ✅ 102+ | ✅ 111+ | ✅ 15.2+ |
| Handle per `postMessage` in Worker | ✅ | (nur OPFS) | ⚠️ nur Preview |
| `SharedArrayBuffer` | COOP/COEP nötig | dito | dito |

Zentrale Konsequenzen (alle im Design berücksichtigt):

1. **Permission nur per Klick auf dem Main Thread.** `requestPermission()`
   verlangt eine Nutzergeste und wirft im Worker `SecurityError`. ⇒ Nach jedem
   Kaltstart ein „Projekt wieder öffnen"-Button.
2. **Handles in IndexedDB** (structured clone), nie in JSON; sie referenzieren
   den Eintrag, nicht die Bytes.
3. **Safari kann gepickte Handles nicht an Worker übergeben** ⇒ Worker holt sich
   im OPFS-Modus sein Root selbst.
4. **Eviction ist real:** Safari löscht skript-erzeugte Daten nach 7 Tagen ohne
   Interaktion; OPFS ist per Default best-effort. ⇒ `storage.persist()` +
   Warnung + Export als First-Class-Feature.
5. **`grep`/`glob` sind keine Plattform-Primitive** ⇒ auf `list`/`read` bauen,
   mit Ignore-Liste, Byte-Cap und Binär-Sniffing (Extension → NUL-Byte →
   `TextDecoder(fatal:true)`). `file.size` ist vor dem Lesen verfügbar — das ist
   das Gate für große Dateien.
6. **`createWritable()` schreibt atomar** (Temp-Datei, Ersetzen bei `close()`) —
   gut für `edit`/`write`. `createSyncAccessHandle()` ist Worker-only und
   exclusive-locked — das ist die Grundlage des Single-Writer-Modells der DB.

### 14.2 Browser-Datenbank (abgeschlossen)

Verglichen wurden IndexedDB (+`idb`/`dexie`), `sql.js`, `wa-sqlite` und
`@sqlite.org/sqlite-wasm`. Entscheidung und Begründung stehen in §6.

Die ausschlaggebenden Messungen/Funde:

- **FTS5 ist im offiziellen `sqlite-wasm`-Build verifiziert vorhanden und
  funktionsfähig** (`ENABLE_FTS5=1`, `MATCH` liefert Treffer, `bm25()`/`snippet()`
  nutzbar). `sql.js` **nicht** (`no such module: fts5`) und ist zudem rein
  in-memory — damit für inkrementelles Append untauglich.
- **`opfs-sahpool` braucht kein COOP/COEP** (im Gegensatz zum `opfs`-VFS, das
  `SharedArrayBuffer` und damit Header verlangt, die eine statische SPA nicht
  setzen kann). Die offizielle SQLite-Doku empfiehlt es ausdrücklich für
  Clients, die keine Response-Header setzen können.
- **`drizzle-orm/sqlite-proxy` ist kein HTTP-Treiber**, sondern ein generischer
  async-Callback `(sql, params, method) => Promise<{rows}>` — er bildet 1:1 auf
  einen Worker-RPC ab. Transaktionen laufen als echtes SQL (`begin`/`commit`/
  `rollback`, verschachtelt via `savepoint`) durch denselben Callback.
- **`SQLocal` scheidet aus**, weil es Cross-Origin-Isolation voraussetzt — genau
  das Problem, das `opfs-sahpool` vermeidet.
- **Preis von `opfs-sahpool`:** genau **eine** Verbindung. Ein zweiter Tab kann
  nicht mitinstallieren ⇒ Writer-Wahl über `navigator.locks`, sonst
  Read-only-Spiegel. Falls Multi-Tab-Writes später Pflicht werden, ist der
  Wechsel auf `wa-sqlite OPFSCoopSyncVFS` der vorgesehene Ausweg — **SQL und
  Schema bleiben dabei identisch**, es ändert sich nur VFS/Treiber.

### 14.3 Vorbild-Innenleben (Tool-Katalog, Loop, Config)

⏳ läuft.

### 14.4 Vercel AI SDK (Browser-Runtime, CORS, Persistenz)

⏳ läuft.

### 14.5 Browser-Sandbox / Shell-Ersatz

⏳ läuft. Vorab: Der `shell`-Tool ist bewusst **nicht** v1 (§5.4) — die
strukturierten Tools (`read`/`grep`/`glob`/`edit`) sind präziser und sicherer
als eine halbe Shell.


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
| npm-Scope | `@all-the.rest` |
| Root-Package | `@all-the.rest/baah` |
| App | `@all-the.rest/baah-web` |
| Engine | `@all-the.rest/baah-core` |
| Tools | `@all-the.rest/baah-tool-<id>` (z. B. `baah-tool-read`) |
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
| `glob` | `@ohw/tool-glob` | read | Walker über `values()` + **`picomatch@4`** (zero deps); Pfad-Index im Worker, damit es nach dem ersten Walk sofort ist | ✅ |
| `grep` | `@ohw/tool-grep` | read | **`grep-wasm`** (echtes ripgrep als WASM, in-memory-API, wendet `.gitignore` an) + **JS-`RegExp`-Fallback**; Kandidatenliste über `ignore@7` | ✅ |
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
| `shell` | `@ohw/tool-shell` | execute | **`just-bash`** (echter Bash-Interpreter im Browser, ~90 Built-ins) auf unserem `Workspace`; Kommando-Allow-Liste. Kein `npm install`/`node` (§5.4) | ✅ Phase 4 |
| `git` | `@ohw/tool-git` | execute | **`isomorphic-git`**: `status`, `log`, `diff`, `commit`, `branch`. **Keine Remotes** (`clone`/`push` bräuchten einen CORS-Proxy = Server) | ✅ Phase 4 |

**Nicht im Vorbild, aber sinnvoll:** `git` hat OpenCode v2 nicht als eigenes Tool
(es läuft dort über die Shell). Für uns ist ein eigener Tool besser, weil die
Shell keine echte `git`-Binary hat.

**Umgekehrt fehlt im Vorbild, was wir bauen:** OpenCode v2 hat **kein
`todowrite`** mehr (nur als V1-Altlast). Unser Todo-Tool ist also eine eigene
Zutat, kein Nachbau.


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

Der Loop ist **kein Eigenbau**: Das AI SDK liefert ihn in v7 als `ToolLoopAgent`
plus `DirectChatTransport`, der den Agenten **im Browser-Prozess** ausführt — ohne
Server-Route (belegt in §14.4).

```
User-Turn
  → useChat({ transport: new DirectChatTransport({ agent }) })
  → ToolLoopAgent({ model, instructions, tools, stopWhen: isStepCount(N) })
  → pro Step: Text-Deltas persistieren, Tool-Calls einsammeln
  → Tool-Ausführung: access != "read" ? approve() : direkt
  → Tool-Result als part persistieren, zurück ins Modell
  → onStepEnd: Checkpoint in die DB (nicht erst am Turn-Ende)
  → bis keine Tool-Calls mehr kommen oder Step-Limit erreicht
```

**Was wir selbst bauen** (das SDK liefert es nicht, §14.4):
Permission-Policy + UI, FS-Bridge, Workspace-Index, Session-Baum, Kompaktierung,
Subagent-Tool, Todo-Tool, Kosten-/Budget-Anzeige, `AGENTS.md`-Injektion.

**Wichtig:** `UIMessage[]` ist der Speicher-Wahrheitsanspruch (nicht
`ModelMessage[]`). `ModelMessage[]` wird pro Request neu aus den UIMessages
berechnet (`convertToModelMessages`, seit v6 **async**).


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


### 5.4 Shell — von „nicht v1" zu „v1 möglich" (revidiert)

Ursprünglich hatte ich Shell vertagt. Die Recherche (§14.5) hat das widerlegt:
es gibt eine **header-freie, quelloffene** Option, die auf unserem
`Workspace`-Interface aufsetzt.

| Option | Was | Header nötig? | Lizenz | v1? |
|---|---|---|---|---|
| **A — `just-bash`** | Echter Bash-Interpreter in TypeScript (Pipes, `&&`, Variablen, Globs, Heredocs) mit ~90 Built-ins: `ls cat cp mv rm mkdir find grep rg sed awk cut sort uniq head tail wc xargs diff jq tar base64 …`. Läuft im Browser; nur `python3`/`sqlite3`/`js-exec`/`OverlayFs`/`ReadWriteFs` fehlen dort. | **nein** | Apache-2.0 | ✅ **ja** |
| B — WASM-Busybox / WASI | kompilierte Unix-Tools auf einem WASM-FS | **ja** (COOP/COEP) | teils proprietär | nein |
| C — WebContainers / BrowserPod | echtes Node + Shell + npm | **ja** + kommerzielle Lizenz/API-Key | proprietär | nein (Route B) |

**Entscheidung:** `just-bash` wird der `shell`-Tool — **hinter einer
Werkzeug-Allow-Liste** und mit unserem `Workspace` als Dateisystem-Adapter,
damit es auf dem *echten* Projektordner arbeitet statt auf einem In-Memory-FS.

Drei ehrliche Einschränkungen, die in die UI gehören:

1. **`just-bash` ist keine Sicherheitsgrenze.** Es ist ein In-Process-Interpreter
   (gehärtet gegen Prototype-Pollution, mit Ausführungslimits), aber keine
   VM-Isolation. Wer untrusted Code ausführen will, braucht
   `quickjs-emscripten` — das ist ein eigener Modus, kein Nebeneffekt.
2. **Kein `npm install`, kein `node script.js`.** Das bleibt Route B.
3. **`git` wird nicht über die Shell gefahren**, sondern als eigener Tool über
   `isomorphic-git` (§4, Tier 3) — und **ohne Remotes**, weil `clone`/`push`
   einen CORS-Proxy bräuchten und damit einen Server.

Damit verschiebt sich der Shell-Tool von „optional/Phase 6" auf **Phase 4**.


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
  -- type: text | reasoning | tool     (nur drei — wie das Vorbild, §14.3)
  -- Datei-Diffs stecken in data.metadata.files des tool-Parts, nicht in einem
  -- eigenen Part-Typ: { file, patch, additions, deletions, status }
  -- content_text ist die denormalisierte, durchsuchbare Projektion
  -- message.type: user|assistant|synthetic|system|skill|shell|compaction|idle|…
  -- Der Turn-Ausgang ist eine idle-Nachricht mit outcome
  -- (succeeded|failed|interrupted) — kein separates turns-Konstrukt

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
- **Parts: eine Tabelle mit `type`-Diskriminator + JSON**, und nur **drei**
  Typen (`text`, `reasoning`, `tool`) — das Vorbild hat genau diese drei
  (§14.3). Datei-Diffs sind Teil des `tool`-Parts, kein eigener Typ. Das hält
  den heißen Pfad („Nachricht rendern") bei einem indizierten Scan.
- **Der Turn-Ausgang ist eine `idle`-Nachricht** mit
  `outcome: succeeded|failed|interrupted`, kein separates `turns`-Konstrukt.
  Damit liegt der Zustand im selben Log wie alles andere und der Reload-Check
  ist eine Query auf `message.type = 'idle'`.
- **`synthetic`-Nachrichten** tragen eingespielte Inhalte (z. B. ein
  Hintergrund-Subagent, der fertig ist) — nötig für `task` im Hintergrundmodus.
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


## 7. Permissions (Regel-Engine nach Vorbild, Ausführung über `toolApproval`)

Das Vorbild hat ein durchdachtes, erprobtes Modell. Wir übernehmen es — es ist
besser als ein naives „ask/allow/deny pro Tool".

### 7.1 Regeln

Eine Regel ist `{ action, resource, effect }`:

- `effect`: `"allow" | "deny" | "ask"`
- `resource`: Muster mit `*` (beliebig viele Zeichen, **auch `/`**) und `?`
  (genau eines); alles andere literal. Ein Muster, das auf `" *"` endet,
  matcht auch das blanke Kommando (`git status *` → `git status`).
- Ein Ruleset ist eine **geordnete Liste. Die letzte passende Regel gewinnt.**
- **Matcht keine Regel, ist die Antwort `ask`** — nie stillschweigend erlauben.

### 7.2 Aktionen

| Aktion | Resource |
|---|---|
| `read` | normalisierter Pfad |
| `edit` | Zielpfad (deckt `write` und `patch` mit ab) |
| `glob` | das Muster |
| `grep` | **die Regex**, nicht der Suchpfad |
| `shell` | der jeweilige Kommandostring |
| `subagent` | Ziel-Agent-ID |
| `skill` | Skill-ID |
| `question` | `*` |
| `webfetch` / `websearch` | URL bzw. Query |
| `network` | Domain (unsere Ergänzung für `webfetch`-Ziele) |
| `external_directory` | kanonisches Verzeichnis außerhalb des Workspace |

### 7.3 Mehrere Resources pro Aufruf

**Jede `deny` → deny; sonst jede `ask` → ask; sonst allow.**

### 7.4 Default-Policy (jede Session)

```jsonc
[ {"action":"*",              "resource":"*",            "effect":"allow"},
  {"action":"external_directory","resource":"*",          "effect":"ask"},
  {"action":"read",           "resource":"*.env",         "effect":"ask"},
  {"action":"read",           "resource":"*.env.*",       "effect":"ask"},
  {"action":"read",           "resource":"*.env.example", "effect":"allow"} ]
```

Also: grundsätzlich erlaubt, aber Secrets und alles außerhalb des Workspace
fragen nach. Das ist die richtige Voreinstellung für eine Coding-Harness.

### 7.5 Antworten auf eine Rückfrage

`"once" | "always" | "reject"` — bewusst nicht mehr Werte:

- `once` — nur dieser Aufruf.
- `always` — schreibt die vom **Tool vorgeschlagenen** Muster als dauerhafte
  `allow`-Regel. Das Tool schlägt das Muster vor (Shell z. B. `git status *`,
  Subagent seine Agent-ID), nicht die UI — es weiß am besten, was es braucht.
- `reject` — lehnt **auch alle anderen offenen Anfragen dieser Session** ab.
  Verhindert, dass ein Nutzer nach einem „nein" noch zehn Karten wegklicken muss.

Gespeicherte Freigaben sind **pro Projekt** gültig und **überstimmen niemals**
eine konfigurierte `deny`-Regel.

### 7.6 Ausführung über das AI SDK

Die Engine entscheidet, das SDK führt aus (§14.4):

```
Regel-Engine (unsere)  →  toolApproval: 'user-approval' | 'not-applicable' | 'denied'
                       →  SDK pausiert den Loop, UI zeigt approval-requested
                       →  addToolApprovalResponse({ id, approved })
                       →  sendAutomaticallyWhen: …WithApprovalResponses
```

- Ein `allow`-Regeltreffer ⇒ `'not-applicable'` (läuft ohne Rückfrage durch).
- `ask` ⇒ `'user-approval'`.
- `deny` ⇒ `{ type: "denied", reason }` — das Modell bekommt die Ablehnung als
  `tool-output-denied` und kann reagieren, statt in einen Fehler zu laufen.
- Jede Entscheidung landet in `approvals`; gespeicherte `always`-Regeln in
  `settings` (pro Projekt).

> **Ehrlichkeit, die ins README gehört:** In einer browser-only App ist die
> Nutzerin die Vertrauensgrenze. Es gibt keinen Server, der eine Freigabe
> signieren könnte. Das Approval-System ist damit eine **UX-Leitplanke, keine
> Sicherheitskontrolle** — es schützt vor Versehen, nicht vor einem
> kompromittierten Browserprofil.



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

## 9. Provider (empirisch geprüft)

Die entscheidende Frage war: darf der Browser direkt mit dem Provider sprechen?
Nicht geraten, sondern **gemessen** — Preflight und Response-Header (§14.4):

| Provider | `access-control-allow-origin` | Browser-direkt? |
|---|---|---|
| **OpenAI** (Chat Completions + Responses) | `*` | ✅ ja (nicht vertraglich garantiert) |
| **Anthropic** | `*` — **nur mit Spezial-Header** | ⚠️ ja, siehe unten |
| **Google** (Generative Language) | echot die Origin, erlaubt `x-goog-api-key` | ✅ ja |
| **OpenRouter** | `*` | ✅ ja |
| **Groq**, **xAI**, **Mistral**, **Cerebras**, **Together**, **DeepSeek** | `*` bzw. Origin-Echo | ✅ ja |
| **models.dev** (Modellkatalog) | `*` | ✅ ja |
| Beliebige OpenAI-kompatible `baseURL` | betreiberabhängig | ❓ **zur Laufzeit prüfen** |

Damit ist die Sorge „wir brauchen doch einen Proxy" **widerlegt** — für eine
breite Provider-Liste. Das ist die Grundlage dafür, dass §2 (browser-only)
überhaupt tragfähig ist.

**Anthropic ist der Sonderfall:** Die API erlaubt Browser-Aufrufe **nur**, wenn
bei jedem Request der Header `anthropic-dangerous-direct-browser-access: true`
mitgeht. Ohne ihn kommt eine 401 **ohne** CORS-Header — der Browser blockt.
Wichtig: Das AI SDK setzt diesen Header **nicht** selbst, er muss explizit
konfiguriert werden:

```ts
createAnthropic({
  apiKey,
  headers: { "anthropic-dangerous-direct-browser-access": "true" },
})
```

**OpenAI ist „funktioniert heute, aber nicht zugesichert":** Es gab einen
dokumentierten ~12-Stunden-Ausfall, in dem der Preflight geblockt wurde. Die
App muss einen CORS-Fehlschlag als *Provider-Problem* erklären können, nicht als
App-Bug.

Weitere Konsequenzen:

- **Keys müssen explizit übergeben werden.** Das SDK liest im Browser **keine**
  Umgebungsvariablen; ohne `apiKey` wirft es `LoadAPIKeyError` beim ersten
  Aufruf. Diese Fehlermeldung gehört in der UI zu „bitte API-Key hinterlegen".
- **`dangerouslyAllowBrowser` gibt es im AI SDK nicht** (das ist ein Flag der
  Vendor-SDKs). Es gibt also nichts „einzuschalten" — die Verantwortung ist rein
  organisatorisch und gehört ins Onboarding (§8.1).
- **Telemetrie explizit aus:** `telemetry: { isEnabled: false }` setzen. Ohne
  registrierte Integration sendet das SDK zwar nichts, aber die Option ist
  laut Doku default-aktiv und würde nach einem späteren Upgrade stillschweigend
  Daten schicken.
- **Generische `baseURL` wird unterstützt, aber zur Laufzeit validiert** — mit
  klarer Fehlermeldung „dieser Endpunkt erlaubt keine Browser-Aufrufe".



## 10. Roadmap

Jede Phase endet mit `pnpm check` grün **und** unabhängiger Verifikation (§12).

| Phase | Inhalt | Fertig, wenn |
|---|---|---|
| **0 — Fundament** ✅ | Repo, pnpm-Workspace, TS 7/Tailwind 4/daisyUI 5, `core`-Verträge, `read`/`write`/`edit`/`list`, `Plan.md`, `AGENTS.md`, Recherche FS + DB | `pnpm check` grün; 52 Tests |
| **1 — Engine-Kern** | OPFS-Workspace, SQLite-Worker (`sqlite-wasm` + `opfs-sahpool`), Drizzle-`sqlite-proxy`, Migrationen, Loop-Skelett gegen Mock-Modell | Contract-Tests aller Tools; Loop läuft headless im Test; Reload überlebt |
| **2 — Suche** | `glob` (`picomatch`), `grep` (`grep-wasm` + JS-Fallback), `ignore`-Filter, Pfad-Index im Worker, Perf-Smoke (≥10k Dateien) | Suche blockiert UI nicht; Benchmark dokumentiert; Fallback-Pfad getestet |
| **3 — UI + Onboarding** | Transcript, Tool-Karten, Approval-Cards, Wizard, Settings, Export/Import | Playwright: 0 → Chat, Reload-Resilienz, Export→Import |
| **4 — Tier 2 + Shell** | `todowrite`, `question`, `skill`, `AGENTS.md`-Injektion, `task`/Subagent, `shell` (`just-bash`), `git` (`isomorphic-git`) | Subagent läuft isoliert mit eigenem Kontext; Shell nur über die Allow-Liste |
| **5 — Härtung** | FS-Access-Workspace (echter Ordner), Resume nach Reload, Token/Kosten, `webfetch`, CORS-Matrix als Test | Reconnect-Test: Reload mitten im Turn → sauberer Zustand |
| **6 — optional** | Route B (WASM-Node) als bewusst eingeschalteter Modus, MCP-Spike (nur `remote`), Tree-Sitter-Highlighting, TS-6-Sprachdienst im Worker | — |

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
- **Loop-Tests ohne Netz:** Das AI SDK liefert unter `ai/test` Mock-Modelle. Damit
  wird der Agent-Loop (Tool-Calls, Step-Limit, Abbruch, Approval-Pause) im Test
  durchgespielt, ohne einen einzigen Provider-Aufruf. Das ist der Grund, warum
  die Engine auch ohne Browser testbar bleibt.
- **Contract-Tests:** Jedes Tool erfüllt dieselbe Suite — Happy Path,
  Fehlerfall (nicht gefunden, kein File, binär), Root-Escape, große Datei,
  Permission-Verweigerung.
- **E2E (Playwright, ab Phase 3):** Wizard, Chat mit gemocktem Provider,
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
| 3 | Läuft der AI-SDK-Loop vollständig im Browser (Flags, Bundling)? | ✅ **ja** — `ToolLoopAgent` + `DirectChatTransport`, keine Node-Builtins, **kein** Flag (§14.4) |
| 4 | Welche Provider erlauben CORS direkt? | ✅ **gemessen**: OpenAI, Anthropic (mit Header), Google, OpenRouter, Groq, xAI, Mistral, Cerebras, Together, DeepSeek (§9) |
| 5 | `grep`/`glob` ohne natives ripgrep: welche Perf bei ≥10k Dateien? | ⏳ C — Sucharchitektur offen |
| 6 | Wie weit trägt ein WASM-Node/WebContainer als Shell-Ersatz? | ⏳ C |
| 7 | Exakter Tool-Katalog + Loop-Semantik des Vorbilds | ⏳ A |
| 8 | Modellkatalog-Quelle und Preis-Anzeige (`@opencode-ai/models`?) | ✅ `@opencode-ai/models` (models.dev, CORS `*`, Offline-Snapshot) (§14.4) |
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

### 14.3 Vorbild-Innenleben (abgeschlossen)

Untersucht wurde das installierte OpenCode v2.0.19 (Binary, gebündelte
Drizzle-Schemas, die Live-SQLite-DB) plus die v2-Doku.

**Speicher:** SQLite via `bun:sqlite`, `journal_mode = WAL`, Zugriff über
Drizzle. Architektur ist **event-sourced mit relationalen Projektionen**:
`event`/`event_sequence` sind das dauerhafte Log, `session_v2`/`session_message`/
`permission`/`project` die Projektionen. Message-IDs werden aus Event-IDs
abgeleitet (`evt_…` → `msg_…`). Migrationen als `migration(id, time_completed)`
mit Drizzle-Kit-Namen.

**Was wir daraus übernehmen:**

1. **Parts sind nur drei Varianten:** `text`, `reasoning`, `tool`. Es gibt
   **keine** `file`-, `patch`-, `snapshot`- oder `step-*`-Parts (das ist V1).
   Datei-Änderungen stecken im **Tool-State**: `edit`/`write`/`patch` liefern
   `metadata.files = [{file, patch, additions, deletions, status}]`, also einen
   Unified-Diff. Das ist deutlich einfacher als mein erster Entwurf — und der
   Diff hängt genau dort, wo er hingehört.
2. **Der Turn-Ausgang ist eine Nachricht.** `idle` mit
   `outcome: "succeeded" | "failed" | "interrupted"` wird als Message
   protokolliert. Eleganter als ein separates `turns`-Konstrukt: der Zustand
   liegt im selben Log wie alles andere.
3. **`synthetic`-Nachrichten** für eingespielte Inhalte (z. B. ein
   Hintergrund-Subagent, der fertig wird). Wir brauchen das für `task` im
   Hintergrundmodus.
4. **Message-Typen insgesamt:** `user`, `assistant`, `synthetic`, `system`,
   `skill`, `shell`, `compaction`, `idle`, `agent-switched`, `model-switched`,
   `location-switched`.
5. **Session-Felder, die wir übernehmen:** `cost`, `tokens_{input,output,reasoning,cache_read,cache_write}`,
   `parent_id`, `fork_session_id` + `fork_boundary`, `directory`, `path`,
   `revert`, `permission` (Session-Override), `agent`, `model`, `idle_outcome`,
   `resume_attempts`, `time_compacting`.
6. **Permission-Modell** — vollständig übernommen, siehe §7.
7. **Subagent-Semantik:** eigenes Kind-Session mit `parent_id`;
   `subagent_depth` default **1** (Subagenten starten **keine** weiteren
   Subagenten); Vordergrund blockiert, `background: true` kehrt sofort zurück
   und benachrichtigt den Parent per `synthetic`-Nachricht; das Kind läuft mit
   **eigenen** Permissions, nicht mit einer Teilmenge des Parents.
8. **`AGENTS.md`-Ladung:** nur `AGENTS.md` (kein `CLAUDE.md`); global
   `~/.config/opencode/AGENTS.md`, dann jede `AGENTS.md` von cwd bis Home;
   **verschachtelte Dateien werden lazy geladen**, wenn der Agent darunter liest.
   Die `instructions`-Config-Liste wird in v2 akzeptiert, aber **nicht
   aufgelöst** — das ist eine Falle, die wir nicht nachbauen.
9. **Compaction ist ein First-Class-Message-Typ** mit eigenem versteckten
   `summary`-Agenten und `status: running|completed|failed`.
10. **Tool-Ausgabe-Limits** sind konfigurierbar (`tool_output: {max_lines, max_bytes}`)
    — das gehört bei uns in die Settings, nicht in den Code.
11. **Tool-Umbenennungen v1 → v2:** `bash` → `shell`, `task` → `subagent`,
    `apply_patch` → `patch`. **`todowrite` wurde gestrichen** (kein v2-Äquivalent).

**Was eine Browser-App nicht nachbauen kann** (bewusst offen dokumentiert):
`process.env` und `{env:VAR}`-Substitution; lokale Auth-Dateien (`~/.aws`,
ADC, `az`/`aws`/`gcloud`); OAuth-Flows, die einen **localhost-Callback-Server**
binden; lokale MCP-Server (`type: "local"`, `command`) — nur `type: "remote"`
ist browser-erreichbar; Snapshots/Revert (OpenCode nutzt eine Git-ODB auf der
Platte); Plugins als npm-Pakete; die TUI-Keybinds/Themes aus `cli.json`.


### 14.4 Vercel AI SDK (abgeschlossen)

Versionen (verifiziert): `ai@7.0.122`, `@ai-sdk/react@4.0.125`,
`@ai-sdk/provider@4.0.19`, `zod@4.6.5`.

**Der zentrale Fund: das SDK hat den Loop schon.** `ToolLoopAgent` +
`DirectChatTransport` führen den kompletten Agent-Loop **im Browser-Prozess**
aus, ohne HTTP-Hop — die Doku nennt als Anwendungsfall ausdrücklich
„single-process applications". `useChat` konsumiert das wie jeden anderen
Transport. Wir bauen also **nicht** den Loop, sondern das Drumherum (§5.1).

**Browser-Tauglichkeit — verifiziert, nicht vermutet:**

- **Keine statischen `node:`-Imports.** Node-Module werden über
  `isNodeRuntime()`-Guards dynamisch per String geladen; Bundler versuchen gar
  nicht erst, sie aufzulösen. Kein Polyfill nötig.
- **`dangerouslyAllowBrowser` existiert im AI SDK nicht** (das ist ein Flag der
  Vendor-SDKs). Es gibt nichts einzuschalten — und damit auch keine Warnung, die
  man wegdrücken könnte. Die Verantwortung ist organisatorisch.
- **Keys müssen explizit übergeben werden.** Im Browser gibt es keinen
  `process.env`-Fallback; ohne `apiKey` wirft das SDK `LoadAPIKeyError`. Diese
  Meldung wird in der UI zu „bitte API-Key hinterlegen".
- **`tsc` braucht `skipLibCheck: true`** (die `.d.ts` importiert typsicher
  `node:http` für `ServerResponse`). Bei uns bereits gesetzt.
- **React-Peer ist enger als `^19`**: `~19.0.1 || ~19.1.2 || ^19.2.1` schließt
  19.0.0/19.1.0/19.1.1 aus. Wir sind mit 19.3.0 ✅.
- **Telemetrie explizit abschalten** (`telemetry: { isEnabled: false }`): ohne
  registrierte Integration sendet das SDK zwar nichts, aber die Option gilt laut
  Doku als default-aktiv — ein späteres Upgrade würde sonst stillschweigend
  Daten schicken.

**v7-Namen, die Implementer kennen müssen** (v6-Namen sind teils noch Aliase,
aber wir schreiben v7):

| v6 (nicht verwenden) | v7 |
|---|---|
| `onFinish` | `onEnd` |
| `onStepFinish` | `onStepEnd` |
| `stepCountIs` | `isStepCount` (Alias existiert) |
| `fullStream` | `stream` |
| `experimental_telemetry` | `telemetry` |
| `needsApproval` (am Tool) | `toolApproval` (am Agent/Call) |
| `addToolResult` | `addToolOutput` |
| `system` | `instructions` (System-Rolle in `messages` wird **abgelehnt**) |
| `experimental_context` | `context` / `runtimeContext` |
| `result.usage` | alle Steps (`totalUsage` deprecated) |

Weitere v7-Änderungen: `result.content`/`toolCalls`/`toolResults` akkumulieren
über Steps — für „nur letzter Step" gibt es `result.finalStep.*`;
`convertToModelMessages` ist **async**; `onChunk` liefert jetzt **alle**
Stream-Parts (auf `chunk.type` prüfen).

**CORS — gemessen (§9).** Zusätzlich zu den vier Haupt-Providern antworten
Groq, xAI, Mistral, Cerebras, Together und DeepSeek mit `*`. Anthropic braucht
den Header, den das SDK **nicht** selbst setzt. OpenAI funktioniert, ist aber
nicht vertraglich garantiert (dokumentierter ~12-h-Ausfall).

**Persistenz.** `UIMessage[]` ist der Speicher-Wahrheitsanspruch, nicht
`ModelMessage[]` — die Doku sagt das ausdrücklich. `ModelMessage[]` wird pro
Request neu berechnet. Beim Laden: `safeValidateUIMessages` (validiert gegen die
*aktuellen* Tool-Schemas) statt blindem Cast. Für Checkpoints **`onStepEnd`**
nutzen, nicht erst das Turn-Ende. IDs sind stabil (`generateMessageId` +
`originalMessages`), also ist ein wiederholtes `onEnd` ein idempotenter Upsert.

**Resume ist unmöglich** — bestätigt: `DirectChatTransport.reconnectToStream()`
liefert **immer `null`**. `useChat({ resume: true })` braucht einen Server
(`/api/chat/[id]/stream`, Redis, `resumable-stream`) und ist damit ausgeschlossen.
Muster: beim Start unfertige Nachrichten als `interrupted` markieren, Teilttext
behalten, „Wiederholen" anbieten (= `regenerate`, kein Resume).
**Idempotenz-Falle:** Tools, die schon gelaufen sind, dürfen beim Replay nicht
erneut wirken — ausgeführte `toolCallId`s persistieren und kurzschließen.
Positiv: `stop()` **wirkt** hier echt (der `fetch` wird abgebrochen), weil kein
Server den Stream weiterführt.

**Permissions** kommen vom SDK (§7): `toolApproval` → `'user-approval'` pausiert
den Loop, UI-Part `approval-requested`, `addToolApprovalResponse`,
`sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`,
Ablehnung als `tool-output-denied`. **Aber:** ohne Server gibt es keinen
Signierer — `experimental_toolApprovalSecret` ist bedeutungslos. HITL ist hier
eine UX-Leitplanke, keine Sicherheitskontrolle.

**Modellkatalog:** `@opencode-ai/models` (models.dev) — `Models.make({ baseUrl })`
mit `.providers()` / `.models()` / `.catalog()`, plus ein Offline-Snapshot unter
`@opencode-ai/models/snapshot` (≤ ~24 h alt). CORS `*` ist gemessen. Das SDK
selbst kann **keine** Modelle auflisten — es gibt nur `model(id)`-Fabriken.

**Keine offiziellen Chat-Komponenten.** Alles über `message.parts` selbst
rendern (daisyUI hat passende `chat`/`chat-bubble`-Klassen). `@ai-sdk/rsc` ist
RSC-only und wird **nicht** verwendet.


### 14.5 Browser-Sandbox, Shell-Ersatz und Code-Suche (abgeschlossen)

**Kernbefund: die Frage ist nicht „läuft es?", sondern „welche Lizenz-, Header-
und API-Key-Steuer zahlst du?".** Es gibt einen header-freien, quelloffenen Weg
(Route A) und einen mächtigeren, aber belasteten (Route B).

| Fähigkeit | 2026 möglich? | Paket |
|---|---|---|
| Echter Bash-Interpreter im Browser | ✅ **ohne Header** | **`just-bash@3.4.2`** (Apache-2.0) |
| ripgrep als WASM, in-memory-Dateien | ✅ | **`grep-wasm@0.1.0`** (MIT/Unlicense) |
| `git status`/`log`/`commit` serverfrei | ✅ | `isomorphic-git@1.42.3` |
| Untrusted JS sandboxen | ✅ ohne Header | `quickjs-emscripten@0.32.0` |
| Tree-sitter-Parsing | ✅ | `web-tree-sitter@0.27.0` + Grammatik-Pakete |
| Glob-Matching | ✅ trivial | `picomatch@4.0.7` (zero deps) |
| `.gitignore`-Auswertung | ✅ | `ignore@7.0.10` (zero deps) |
| `npm install` / `node script.js` | ⚠️ nur Route B | WebContainers / BrowserPod |

**Route A (unser v1): header-frei, quelloffen, alle Browser.** `just-bash` +
`grep-wasm` + `isomorphic-git` + `web-tree-sitter` + `picomatch` + `ignore`.
Kein COOP/COEP, keine API-Keys, kein Vendor-Runtime.

**Route B (optional, später): „echtes Node".** WebContainers (`@webcontainer/api`,
Lizenz **MIT im Paket, aber kommerzielle Nutzung kostenpflichtig**; npm läuft über
StackBlitz-Server; **keine `git`-Binary**; nicht offline) oder BrowserPod
(proprietär, API-Key **und** COOP/COEP Pflicht, kommerziell kostenpflichtig).
Nur als bewusst eingeschalteter Modus, nie als Fundament — COOP/COEP ist
„ansteckend" und bricht OAuth-Popups und Third-Party-Embeds.

#### Drei Fallen, die Geld und Zeit kosten

1. **TypeScript 7 hat keine JS-Compiler-API mehr.** TS 7 ist der Go-Port; im
   Tarball fehlt `lib/typescript.js`. `ts.createLanguageService` ist damit auf
   `typescript@latest` **unmöglich**. Ein In-Browser-Sprachdienst braucht
   gepinnt `@typescript/typescript6@6.0.2` (oder `typescript@5.9.3`) +
   `@typescript/vfs`. **Unser `typescript@^7.0.2` ist davon nicht betroffen** —
   wir nutzen nur die CLI zum Typechecken, nicht die JS-API. Das muss so bleiben:
   wer später eine TS-Sprachdienst-Funktion baut, importiert **nicht** unser
   `typescript`, sondern das gepinnte TS 6.
2. **CSP muss WASM erlauben** (`script-src 'wasm-unsafe-eval'`). Betrifft
   `grep-wasm`, `quickjs-emscripten`, `sqlite-wasm` und `web-tree-sitter`
   gleichzeitig. Früh prüfen, nicht am Ende.
3. **`@zenfs/*` ist LGPL-3.0-or-later.** Technisch die schönste FS-Abstraktion,
   aber copyleft. **Wir brauchen sie nicht** — unser eigenes `Workspace`-Interface
   ist genau der Adapter, den ZenFS liefern würde, nur ohne Lizenzfrage.

#### `grep`: was `grep-wasm` kann und was nicht

`grep-wasm` ist echtes ripgrep (Engine + `ignore`-Crate), nimmt aber **Dateien
im Speicher** entgegen — es läuft **nicht** selbst über einen
`FileSystemDirectoryHandle`. Wir müssen also selbst enumerieren und lesen und
`{path, content}` übergeben. Nicht enthalten: `-v`, `-c`, `-m`, `-A/-B/-C`,
`-o`, Multiline, Binärsuche.

**Risiko:** Version `0.1.0`, ein Maintainer. Deshalb ist der
JS-`RegExp`-Scanner **kein Notnagel, sondern ein gleichwertiger Pfad** — und
`grep-wasm` wird hinter eine Fähigkeitsprüfung gehängt, nicht vorausgesetzt.

**Sucharchitektur (entschieden):** Beim Öffnen des Workspace einen **Pfad-Index**
(`path`, `size`, `mtime`) im Worker aufbauen und persistieren. `glob`/`list`
sind danach sofort. `grep` filtert über `ignore` + `picomatch` auf eine
Kandidatenliste und liest diese in Batches. **Kein Volltext-Index über 300 MB
beim Start.** FTS5 ist für Regex-Suche das falsche Werkzeug (token-basiert) —
es bleibt der Symbol-/Nachrichten-Suche vorbehalten (§6).

Erwartung, ehrlich: `glob`/`list` nach dem Index ~sofort; voller `grep` über
~300 MB **Sekunden, nicht Millisekunden**. Das ist eine Schätzung, kein
Benchmark — Phase 2 misst.

#### Was v1 bewusst nicht tut

`npm install`/`node`/Dev-Server-Preview (Route B); Git-**Remotes** (`clone`/
`fetch`/`push` brauchen einen CORS-Proxy); ripgrep-Multiline und `-A/-B/-C/-v`;
Volar/LSP-Vollintegration; Filesystem-Watcher (stattdessen mtime-Vergleich on
demand); Volltext-Indexierung des ganzen Korpus; Windows-Pfadsemantik; und
**niemals** die Behauptung, `just-bash` sei ein Sicherheits-Sandbox.



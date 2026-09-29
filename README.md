# baah — Browser as a Harness

Eine **Coding-Harness, die vollständig im Browser läuft.** Kein Server, kein
Proxy, keine Installation: URL öffnen, Projektordner verbinden, API-Key
hinterlegen — und man hat einen Agenten, der Dateien liest, schreibt und sucht,
Kommandos ausführt, Subagenten startet und den Verlauf über Reloads hinweg
behält.

> **Status:** Phase 0 abgeschlossen (Fundament + Recherche), Phase 1 beginnt.
> Der Rename auf `baah` / `@all-the.rest/*` läuft nach Abschluss der Recherche;
> bis dahin heißen die Packages noch `@ohw/*` (siehe [`Plan.md`](Plan.md) §0).

---

## Soll-Capabilities

Das ist das Zielbild — was `baah` können soll, gruppiert nach Fähigkeit, mit
ehrlichem Status. ✅ = implementiert, 🔜 = geplant, ⛔ = bewusst nicht.

### 1. Workspace und Dateizugriff

| Fähigkeit | Status |
|---|---|
| Echten Projektordner verbinden und **in-place** lesen/schreiben (File System Access API) | 🔜 |
| Fallback ohne Ordner-Picker: Import → Sandbox (OPFS) → Export | 🔜 |
| Freigabe nach Reload erneut erteilen (Handle in IndexedDB, Permission per Klick) | 🔜 |
| Kein Zugriff außerhalb des Workspace — jeder Pfad läuft durch einen Root-Escape-Schutz | ✅ |
| In-Memory-Workspace für Tests und „einfach mal ausprobieren" | ✅ |

### 2. Agent-Loop

| Fähigkeit | Status |
|---|---|
| Multi-Step-Tool-Calling **im Browser-Prozess** (kein Server-Hop) | 🔜 |
| Step-Limit und Abbruch mitten im Turn | 🔜 |
| Checkpoint nach jedem Step, nicht erst am Turn-Ende | 🔜 |
| Turn-Ausgang explizit: `succeeded` / `failed` / `interrupted` | 🔜 |
| Unterbrochene Turns nach Reload erkennen und wiederholen | 🔜 |

### 3. Tool-Set (das Basis-Set einer Coding-Harness)

Ein Tool = ein Package (`packages/tools/<id>/`). Jedes Tool ist ein
`ToolDefinition` mit `id`, `description`, `access`, zod-`inputSchema` und
`execute` — das Schema ist gleichzeitig Modell-Beschreibung und Validierung.

| Tool | Was es kann | Status |
|---|---|---|
| `read` | Datei mit Zeilennummern, `offset`/`limit`, Binär-Abweisung, Zeilen-Truncation | ✅ |
| `write` | Datei schreiben/überschreiben, Elternverzeichnisse anlegen, 5-MB-Guard | ✅ |
| `edit` | **Exakter** String-Ersatz; Fehler bei 0 Treffern; `>1` nur mit `replaceAll`; literale `$`-Sequenzen | ✅ |
| `list` | Verzeichnis, Verzeichnisse zuerst, `limit`/`total`/`truncated` | ✅ |
| `glob` | Pfadmuster (`**/*.ts`) über einen Pfad-Index im Worker | 🔜 |
| `grep` | Regex-Inhaltssuche via WASM-ripgrep, mit JS-`RegExp`-Fallback; `.gitignore` beachtet | 🔜 |
| `shell` | Echter Bash-Interpreter im Browser (Pipes, `&&`, Globs, ~90 Built-ins) — hinter einer Kommando-Allow-Liste | 🔜 |
| `todowrite` | Aufgabenliste des Agenten, in der Sidebar sichtbar | 🔜 |
| `task` | Subagent mit eigenem Kontext, eigenem Transcript und eigenen Rechten | 🔜 |
| `question` | Agent stellt dem Nutzer eine Frage und wartet auf die Antwort | 🔜 |
| `skill` | Vorab-Instruktionen aus dem Workspace laden | 🔜 |
| `webfetch` | URL → Text (CORS-limitiert) | 🔜 |
| `git` | `status`, `log`, `diff`, `commit`, `branch` | 🔜 |
| `patch` | Mehr-Hunk-Editor auf `edit`-Basis | 🔜 später |

**Projekt-Instruktionen:** `AGENTS.md` im Workspace wird beim Verbinden erkannt
und in den System-Prompt aufgenommen. 🔜

### 4. Permissions

| Fähigkeit | Status |
|---|---|
| Regel-Engine mit geordneten Regeln `{action, resource, effect}` — **letzte passende Regel gewinnt** | 🔜 |
| Effekte `allow` / `deny` / `ask`; **kein Treffer ⇒ `ask`** (nie stillschweigend erlauben) | 🔜 |
| Wildcards (`*`, `?`), Mehrfach-Ressourcen: jede `deny` schlägt alles | 🔜 |
| Antworten `once` / `always` / `reject` — `reject` lehnt alle offenen Anfragen der Session mit ab | 🔜 |
| Dauerfreigaben pro Projekt; das **Tool** schlägt das Speicher-Muster vor | 🔜 |
| Default: Secrets (`*.env`) und alles außerhalb des Workspace fragen nach | 🔜 |
| Jede Entscheidung im Transcript nachvollziehbar | 🔜 |

### 5. Persistenz

| Fähigkeit | Status |
|---|---|
| Sessions, Nachrichten, Parts, Tool-Aufrufe, Approvals, Todos in der Browser-DB (SQLite-WASM über OPFS) | 🔜 |
| Verlauf übersteht einen Reload | 🔜 |
| Volltextsuche über die Historie (FTS5) | 🔜 |
| Streaming-Deltas werden inkrementell persistiert (Verlust ≤ ~100 ms) | 🔜 |
| Alles bleibt lokal — nichts wird hochgeladen | ✅ |
| Service Worker: Offline-App-Shell, ein DB-Writer über alle Tabs hinweg | 🔜 |
| Installierbar als PWA — auf Chrome bleiben Datei-Freigaben dadurch ohne erneute Rückfrage erhalten | 🔜 |

### 6. Onboarding und Settings

| Fähigkeit | Status |
|---|---|
| Erststart-Wizard: Provider → API-Key (+ Verbindungstest) → Modell → Workspace | 🔜 |
| Modellauswahl aus dem Katalog **mit Preisen** | 🔜 |
| Settings-Export/-Import als JSON mit Versionsfeld | 🔜 |
| Keys sind beim Export **standardmäßig ausgeschlossen**, nur über bewussten Extra-Haken | 🔜 |
| Import mit Diff-Vorschau, nie blind überschreiben | 🔜 |
| Session-Export als Markdown und JSON | 🔜 |

### 7. Provider

Alle folgenden sind **empirisch geprüft** (Response-Header, inkl. Preflight) —
der Browser darf direkt mit ihnen sprechen:

| Provider | Direkt aus dem Browser |
|---|---|
| OpenAI (Chat Completions + Responses) | ✅ |
| Anthropic | ✅ — **nur** mit `anthropic-dangerous-direct-browser-access: true` |
| Google (Generative Language) | ✅ |
| OpenRouter | ✅ |
| Groq, xAI, Mistral, Cerebras, Together, DeepSeek | ✅ |
| Beliebige OpenAI-kompatible `baseURL` | ❓ zur Laufzeit geprüft, mit klarer Fehlermeldung |

### 8. Oberfläche

| Fähigkeit | Status |
|---|---|
| Transcript mit Parts (Text, Reasoning, Tool-Aufrufe) | 🔜 |
| Tool-Karten mit Ein-/Ausgabe und Status | 🔜 |
| Approval-Cards mit Diff-Vorschau für Schreibzugriffe | 🔜 |
| Todo-Sidebar | 🔜 |
| Kosten-/Token-Anzeige pro Turn | 🔜 |
| Settings inkl. Modellwechsel zur Laufzeit | 🔜 |

---

## Bewusste Nicht-Ziele

| Nicht-Ziel | Warum |
|---|---|
| **Server, Proxy, SSR, Serverless** | Projektdefinition. Ein Provider ohne CORS wird nicht per Backend „repariert". |
| **MCP** | Vertagt. Die Tool-Registry ist bereits generisch, ein MCP-Tool wäre später nur eine weitere Quelle. |
| **`npm install` / `node script.js`** | Braucht einen WASM-Node-Sandbox mit COOP/COEP **und** kommerzieller Lizenz. Optionaler Modus, nicht Fundament. |
| **Git-Remotes** (`clone`/`push`) | Bräuchten einen CORS-Proxy — also wieder einen Server. |
| **Multi-User, Accounts, Cloud-Sync** | Wäre ein Server. Export/Import deckt den Umzug ab. |
| **Sicherheits-Sandbox** | Die Shell ist ein In-Process-Interpreter. Wer untrusted Code ausführen will, braucht einen eigenen Isolationsmodus. |

---

## Grenzen, die man kennen muss

Ehrlichkeit ist Teil des Designs — diese Punkte gehören ins Produkt, nicht ins
Kleingedruckte:

1. **Der API-Key liegt im Browser.** Bei „bring your own key" unvermeidlich. Er
   geht nur an den Provider, aber wer Zugriff auf das Browserprofil hat, kommt
   an ihn. Empfehlung im Onboarding: eigener, widerrufbarer Key mit Ausgabenlimit.
2. **Ein Reload mitten im Turn ist nicht beliebig lange überlebbar.** Der Stream
   gehört dem Tab. Ein Service Worker kann ihn über einen **Reload** retten —
   aber nicht über den Browser, und hart begrenzt auf **~5 Minuten** pro Request
   (Chrome und Firefox beenden den Worker auch mitten im Stream). Der Teiltext
   bleibt in jedem Fall erhalten; der Turn wird als unterbrochen markiert und
   kann wiederholt werden.
3. **Die Permission-Freigabe ist eine UX-Leitplanke, keine Sicherheitskontrolle.**
   Ohne Server gibt es niemanden, der eine Freigabe signieren könnte.
4. **Nicht jeder Browser kann alles.** Der echte Projektordner in-place geht nur
   auf Chromium; Firefox und Safari arbeiten auf einer Kopie in der Sandbox.
5. **Browserdaten können gelöscht werden.** Safari räumt nach 7 Tagen ohne
   Interaktion auf. Export ist deshalb ein Kernfeature, nicht ein Extra.
6. **Suche ist nicht gratis.** Über einen großen Workspace ist `grep` Sekunden
   wert, nicht Millisekunden — es gibt kein natives ripgrep im Browser.

---

## Technik

| Bereich | Wahl |
|---|---|
| Package-Manager | pnpm (Workspace) |
| Sprache | TypeScript (strict) |
| UI | React 19 + Vite (SPA, kein SSR) |
| Styling | Tailwind CSS v4 + daisyUI v5 |
| LLM-Layer | Vercel AI SDK v7 (`ToolLoopAgent` + `DirectChatTransport`) |
| Validierung | zod |
| Datenbank | SQLite-WASM (`@sqlite.org/sqlite-wasm`, `opfs-sahpool`-VFS) über Drizzle |
| Tests | vitest (Unit), Playwright (E2E) |

## Struktur

```
apps/web/                React-SPA (UI, Onboarding, Transcript, Settings)
packages/core/           Engine: Agent-Loop, Tool-Registry, Workspace-Abstraktion
packages/tools/<id>/     Ein Package pro Tool
Plan.md                  Spezifikation (Ziel, Architektur, Roadmap, Recherche)
AGENTS.md                Projektregeln
```

## Kommandos

```bash
pnpm install
pnpm dev         # SPA auf http://localhost:5273
pnpm check       # typecheck + tests (muss grün sein)
pnpm test        # nur Tests
pnpm build       # Produktions-Build
```

## Stand

- ✅ **Fundament:** pnpm-Workspace, TS strict, React/Vite/Tailwind/daisyUI,
  `Workspace`-Abstraktion mit In-Memory-Implementierung, POSIX-Pfad-Utils mit
  Root-Escape-Schutz, `ToolDefinition`-Vertrag, Tool-Registry.
- ✅ **Vier Tools:** `read`, `write`, `edit`, `list` — je eigenes Package, je
  eigene Test-Suite, 52 Tests gesamt.
- ✅ **Recherche:** Dateizugriff, Browser-Datenbank, Vorbild-Innenleben,
  AI SDK, Shell-/Such-Alternativen — belegt in [`Plan.md`](Plan.md) §14.
- 🔜 **Nächste Phase:** OPFS-Workspace, SQLite-Worker, Loop-Skelett,
  `glob`/`grep`.

Die vollständige Roadmap und die Herleitung jeder Entscheidung stehen in
[`Plan.md`](Plan.md).

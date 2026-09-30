# Plan.md — `baah`

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

**Status: umgesetzt.** Verzeichnis `/projects/baah-harness`, Scope
`@all-the.rest`, Pakete `@all-the.rest/baah-{core,web,tool-<id>}`. Der `@ohw`-Name
existiert im Repo nicht mehr und ist für neue Dateien verboten.

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
| **Streaming-Proxy / Long-Polling-Transport** | Siehe §5.4. Ein Proxy wäre die einzige saubere Lösung für einen gebrochenen Middlebox-Weg — er wäre aber wieder ein Server, dem man den API-Key anvertrauen müsste. **Wann sich ein Proxy lohnt:** hinter einem Firmen-Gateway, das Streaming zerlegt, oder für Provider ohne CORS. Beides ist bewusste Tragweite, keine Lücke. |

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
| `read` | `@all-the.rest/baah-tool-read` ✅ | read | `getFile()` → `text()`, Zeilennummern, `offset`/`limit`, Binär-Abweisung, Zeilen-Truncation | ✅ fertig |
| `write` | `@all-the.rest/baah-tool-write` ✅ | write | `getFileHandle(create)` → `createWritable()` → `write`/`close`; 5-MB-Guard, Verzeichnis-Guard | ✅ fertig |
| `edit` | `@all-the.rest/baah-tool-edit` ✅ | write | exakter String-Ersatz; Fehler bei 0 Treffern; `>1` nur mit `replaceAll`; literale `$`-Sequenzen | ✅ fertig |
| `list` | `@all-the.rest/baah-tool-list` ✅ | read | `dirHandle.values()`; Verzeichnisse zuerst, `limit`/`total`/`truncated` | ✅ fertig |
| `glob` | `@all-the.rest/baah-tool-glob` | read | Walker über `values()` + **`picomatch@4`** (zero deps); Pfad-Index im Worker, damit es nach dem ersten Walk sofort ist | ✅ |
| `grep` | `@all-the.rest/baah-tool-grep` | read | **JS-`RegExp`-Scanner als einzige Engine** (`grep-wasm` entfernt, Begründung §14.5); Kandidatenliste über `ignore@7`; `signal` + 5-s-Timeout; Hidden-Files wie im Vorbild | ✅ |
| `patch` | `@all-the.rest/baah-tool-patch` | write | optionaler Mehr-Hunk-Editor auf `edit`-Basis | später |

### Tier 2 — Arbeitsorganisation und Delegation

| Tool | Package | `access` | Web-first Realisierung | Machbar |
|---|---|---|---|---|
| `todo` | `@all-the.rest/baah-tool-todo` | write | Aufgabenliste in der DB, UI in der Sidebar | ✅ |
| `task` | `@all-the.rest/baah-tool-task` | execute | Sub-Agent mit eigenem Message-Array + reduziertem Tool-Set, im Worker; Ergebnis als Text | ✅ |
| `question` | `@all-the.rest/baah-tool-question` | read | UI-Karte im Transcript; `Promise`, das der Loop `await`et | ✅ |
| `skill` | `@all-the.rest/baah-tool-skill` | read | Markdown unter `.baah/skills/*.md` laden und in den System-Prompt injizieren | ✅ |

### Tier 3 — Netz und Ausführung

| Tool | Package | `access` | Web-first Realisierung | Machbar |
|---|---|---|---|---|
| `webfetch` | `@all-the.rest/baah-tool-webfetch` | network | `fetch()` → Text; **CORS-limitiert**, nur erlaubende Origins | ⚠️ eingeschränkt |
| `websearch` | `@all-the.rest/baah-tool-websearch` | network | externe Such-API („bring your own key"), ebenfalls CORS-abhängig | ⚠️ |
| `shell` | `@all-the.rest/baah-tool-shell` | execute | **`just-bash`** (echter Bash-Interpreter im Browser, ~90 Built-ins) auf unserem `Workspace`; Kommando-Allow-Liste. Kein `npm install`/`node` (§5.4) | ✅ Phase 4 |
| `git` | `@all-the.rest/baah-tool-git` | execute | **`isomorphic-git`**: `status`, `log`, `diff`, `commit`, `branch`. **Keine Remotes** (`clone`/`push` bräuchten einen CORS-Proxy = Server) | ✅ Phase 4 |

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

Bereits implementiert in `@all-the.rest/baah-core`:

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

#### Zwei Zustände, die Welle 2 speichern muss (aus der Verifikation)

**1. `tool_invocations.status` ist `begun | done`, nicht „läuft oder nicht".**
`beginToolCall` schreibt **vor** der Ausführung, `recordToolCall` **danach**.
Vor dieser Präzisierung gab es kein Feld, das „begonnen, Ausgang unbekannt"
ausdrückte — der Zustand war **nicht darstellbar**, und damit war im
Absturzfenster zwischen beiden Schritten genau eine Antwort möglich: das Tool
noch einmal laufen zu lassen. Bei einem `write`-Tool ist das keine Wiederholung,
sondern ein **zweites Anhängen an die Datei des Nutzers** (gemessen:
`log === ["x","x"]`, während das Transcript einen Write zeigt). Das ist stiller
Datenverlust, den das Modell nicht zurücknehmen kann.

Die Engine löst den Konflikt nicht durch Wiederholen und nicht durch
stilles Überspringen, sondern durch **Sichtbarkeit**: `begin` ohne `done` wird
dem Modell als Ergebnis mit `outcome: "unknown"` zurückgegeben — mit der
Anweisung, den Zustand zu **prüfen**, statt zu wiederholen — und als Event
`tool-outcome-unknown` gemeldet. **Bleibendes Restrisiko, ausdrücklich gesagt:**
ob die Wirkung eingetreten ist, weiß die Engine nicht und kann es nicht wissen.
Der User sieht eine Warnung, kein stilles Entweder-oder.

Der Kurzschluss feuert **nur** auf `done`. Und er ist nicht auf die bloße
`toolCallId` geschlüsselt: der Schlüssel ist
`(sessionId, attempt, toolCallId, occurrence)` — **jede** Komponente ist nötig,
denn jede schließt einen gemessenen Fehler:

| Komponente | Fehler, den sie schließt |
|---|---|
| `sessionId` | zwei Sessions mit gleicher Id teilten sich einen Record (§6.1 hat die Spalte) |
| `attempt` | ein Retry ist ein neuer Turn; ohne ihn schwieg der alte Record einen neuen legitimen Aufruf |
| `occurrence` | ein Provider, der eine Id **zweimal** benutzt, verlor sonst den zweiten Aufruf — still, und der Turn meldete `succeeded` |

`occurrence` wird bei der **Lookup** hochgezählt, nicht beim `begin`: ein
kurzgeschlossener Aufruf beginnt nie, und ein Turn, der zwei Aufrufe mit
gleicher Id replayt, löste sonst **beide** auf Occurrence 0 auf.

**2. Reload-Recovery braucht eine Schwelle, nicht nur einen Anker.**
`heartbeat_at` wird bei **jedem** `onStepEnd` und zu **Beginn jedes Versuchs**
erneuert. Beim Start markiert `recoverStaleTurns` jeden unfertigen Turn, dessen
Heartbeat **älter als 30 s** ist, als `interrupted` — und lässt alle anderen
unangetastet.

| Seite der Grenze | Bedeutung |
|---|---|
| `age < 30 s` | **lebendig** — jemand arbeitet noch daran. Ein zweiter Tab darf diesen Turn nicht schließen. |
| `age >= 30 s` | **tot** — der Tab ist weg. `interrupted`, mit Grund, Teiltext bleibt. |

Die Grenze ist **bewusst kurz**, und der Trade ist benannt: zu lang, und ein im
Schritt 7 von 20 gestorbener Turn sieht weiter aus wie lebendig — das ist
genau der stille Fall, den §5.4 verhindern will. Zu kurz, und ein wirklich
arbeitender Turn wird für tot erklärt; der Schaden ist ein `interrupted` mit
`regenerate`-Angebot, also sichtbar und umkehrbar. 30 s liegt über dem
20-s-Stallfenster aus §5.4 und weit unter der Dauer eines echten Schritts.
Resume bleibt unmöglich (§14.4) — „Recovery" heißt hier also *ehrlich
abschließen und neu senden lassen*, nicht fortsetzen.


### 5.2 Worker

FS-Walk, Suche und DB-Schreibvorgänge gehören nicht auf den UI-Thread. Ziel:
**ein** Worker als Single-Writer für die DB und für FS-Operationen, Kommunikation
per `PostMessage` (typisierte Nachrichten, zod-validiert).

⏳ *Offen:* ob die gewählte DB `SharedArrayBuffer` (⇒ COOP/COEP-Header)
braucht. Eine rein statische SPA kann Response-Header nicht setzen — falls das
zutrifft, fällt die Engine auf IndexedDB zurück (siehe §13, Recherche C).

### 5.3 Workspace-Abstraktion

Ein Interface, mehrere Implementierungen (`@all-the.rest/baah-core`, bereits vorhanden):

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


### 5.4 Stream-Transport: Streaming ist der einzige Weg

**Streaming (SSE) ist Default und einziger Transport.** Es gibt bewusst
**keinen** zweiten „Long-Polling"-Transport — das ist eine begründete
Entscheidung, keine Auslassung:

- Eine OpenAI-kompatible API hat **keine Job-ID**, die man pollen könnte. Es
  gibt keine Anfrageform, die einen kaputten Stream-Middlebox überlebt, außer
  gar nicht zu streamen.
- Die einzige saubere Lösung für einen gebrochenen Middlebox-Weg wäre ein
  **Proxy** — und der ist out of scope, siehe §2.

**Was wir stattdessen bauen** — ein Detektor, ein Fallback und ein Retry.

#### Erfolgskriterium: nicht der Status, sondern der Stream

Ein `200` ist **kein** Erfolgsindikator. Bekannt und reproduzierbar sind Fälle,
in denen der Status `200` ist und die Antwort trotzdem unbrauchbar:

| 200-aber-failed | Wie es sich zeigt |
|---|---|
| Header kommen, **Body bleibt leer** | Stream endet sofort, null Chunks |
| SSE-Stream **bricht mitten drin ab** | Chunks hörten auf, **kein** `data: [DONE]`, kein `finish`-Event |
| **Fehler-Event im Stream** | `200` bei den Headern, dann ein `error`-Part im Protokoll |
| **JSON-Fehlerbody statt SSE** | `200`, aber `content-type: application/json` mit einem Fehlerobjekt |
| **Terminal-Event fehlt** | Text kam, aber kein `finish`/`stop` — der Turn ist unvollständig |

**Erfolg = der Stream endet sauber mit einem Terminal-Event.** Alles andere ist
ein Fehler, egal was die Statuszeile sagt. Diese Regel ersetzt jede Prüfung auf
den HTTP-Status und ist der Grund, warum wir überhaupt eine eigene Erfolgslogik
brauchen statt auf „kein Wurf = gut" zu vertrauen.

#### Welche Fehler automatisch wiederholt werden

| Klasse | Beispiele | Auto-Retry? |
|---|---|---|
**Reihenfolge der Prüfung** — die Reihenfolge ist nicht beliebig, sie ist der
Schlüssel, weil ein `200` mit Fehler-JSON sonst wie ein Erfolg aussieht:

```
1. Gab es überhaupt eine Antwort?   nein → KEINE Retry (20-s-Regel unten)
2. Statuscode                        5xx / 429 → Retry (429: Retry-After gewinnt)
3. 4xx, die sich nicht ändern        400/401/403/404/422 → KEINE Retry
4. Status 200 → Antwort VERIFIZIEREN, nicht annehmen
5. Stream endet mit Terminal-Event?   nein → Retry
6. Sonst                             Erfolg
```

Schritt 4 ist der ganze Punkt: **Ein `200` ist eine Behauptung, keine
Tatsache.** Geprüft wird, was wirklich ankam:

| Was ankam | Bewertung | Reaktion |
|---|---|---|
| `content-type: application/json` statt `text/event-stream` | **Fehler-JSON** mit Status 200 | Body **einmal** lesen, das JSON auswerten |
| JSON mit `error`, `message`, `code` | Providerfehler trotz 200 | wie 5xx behandeln → Retry |
| JSON mit `error.type = "insufficient_quota"` / `billing` | **kein** Retry | Endgültiger Fehler, Key/Quota melden, Retry-Schleife wäre Geldverbrennung |
| JSON **ohne** Fehler, aber kein Stream | Protokoll-Missverständnis | einmaliger Retry, dann Nutzer |
| SSE-Stream ohne `data: [DONE]` / ohne Terminal-Part | abgeschnitten | Retry |
| SSE-Stream **mit** `error`-Event | Abbruch mitten drin | Retry |
| leere Antwort trotz 200 | unbrauchbar | Retry |

**Drei verschiedene Dinge, die alle als „200" ankommen** — und die man nicht
verwechseln darf:

| | 5xx im Status | 200 + Fehler im JSON | 200 + leer/abgeschnitten |
|---|---|---|---|
| Was es ist | Server kaputt | Server lehnt inhaltlich ab, transporttechnisch 200 | Transport kaputt |
| Wiederholbar? | ja | **kommt auf den Inhalt an** | ja |
| Unser Verhalten | Retry | Inhalt auswerten → dann entscheiden | Retry |

Für den JSON-Fehlerfall gibt es deshalb **kein** festes „retry ja/nein",
sondern eine Regel über den erkannten Fehlertyp:

| `error.type` / Muster | Retry | Grund |
|---|---|---|
| `insufficient_quota`, `billing`, `credit` | ❌ nie | Geld, nicht Zufall |
| `invalid_api_key`, `authentication` | ❌ nie | Key ist falsch, nicht kaputt |
| `permission`, `not_found` | ❌ nie | Anfrage ist falsch |
| `rate_limit`, `overloaded`, `server_error`, `internal` | ✅ ja | transient |
| unbekannt | ✅ einmal, dann an den Nutzer | lieber sichtbar raten als still |

**Begründung für diese Sorgfalt:** Ein `200` mit Fehler-JSON sieht für jede
naive Erfolgskontrolle wie ein Erfolg aus. Genau daran scheitern gute
Harnesses still — der Turn gilt als fertig, das Transcript ist unvollständig,
und niemand erfährt warum. Deshalb ist „`200` allein zählt nie" hier eine
harte Regel und keine Vorsicht.

#### Auto-Retry-Klassen (Zusammenfassung)

| Klasse | Beispiele | Auto-Retry? |
|---|---|---|
| **Antwort kam, unbrauchbar** | 5xx, 429, 200+Fehler-JSON (transient), 200+abgeschnitten/leer, Verbindung nach den Headern abgerissen | ✅ **ja** |
| **429 mit `Retry-After`** | Rate-Limit | ✅ ja, **mit** dem vom Server genannten Warten |
| **Keine Antwort überhaupt** | Verbindung kam nie zustande, 20 s Stillstand bei offener Verbindung | ❌ **nein** — der Provider generiert womöglich noch; „Warte auf das Modell (Ns)" + manuelle Aktion |
| **Endgültige Fehler** | 401, `insufficient_quota`, `billing`, `invalid_api_key`, 400/403/404/422 | ❌ nein — wiederholen behebt nichts, ein 401- oder Quota-Loop verbrennt nur Requests |
| **Nutzer hat abgebrochen** | `stop()` | ❌ nein |

Auto-Retry also **nur dort, wo tatsächlich eine verwertbare Antwort angekommen
ist, und nur bei transienten Ursachen**. Die inhaltliche Prüfung des
Fehler-JSON ist dabei kein Detail, sondern die halbe Logik.

Auto-Retry also **nur dort, wo tatsächlich eine Antwort angekommen ist**. Das ist
die Grenze, die der Nutzer gezogen hat, und sie ist die richtige: ohne Antwort
ist der erste Versuch möglicherweise schon teuer im Lauf, mit Antwort ist er
nachweislich unbrauchbar.

#### Backoff: sofort, dann wachsend

| Versuch | Warten **vor** dem Versuch | kumuliert |
|---|---|---|
| 1 | **0 s** — sofort | 0 s |
| 2 | **2 s** | 2 s |
| 3 | **8 s** | 10 s |
| 4 | **ab hier kein Auto-Retry** | — |

- **±25 % Jitter** auf jede Wartezeit. Ohne Jitter starten nach einem
  Provider-Aussetzer alle Clients weltweit im selben Takt erneut — das ist der
  Unterschied zwischen „erholt sich" und „verlängert den Ausfall".
- `Retry-After` vom Server **gewinnt** über unsere Tabelle, gedeckelt auf 60 s.
- Obergrenze: **maximal 3 automatische Versuche pro Turn**, danach Übergabe an
  den Nutzer. Ein Retry ist immer teuer (die Anfrage wird erneut gesendet), also
  ist eine unbegrenzte Schleife ausgeschlossen.
- Die Versuche werden im UI sichtbar: „Versuch 2 von 3" — ein stilles
  Wiederholen wäre bei genau diesem Fehlerbild unhilfreich.

#### Was mit dem Teiloutput passiert

Ein Retry kann den Stream nicht fortsetzen (keine Resume-ID, §14.4). Also wird
der **gesamte Turn** erneut gesendet. Damit das nicht still verschwindet:

- Der abgebrochene Versuch wird im Transcript als **`interrupted` markiert und
  sichtbar gelassen** — inklusive des Teilttexts.
- Der neue Versuch ist ein eigener Turn mit eigener Nachricht.
- Nie wird der Teiltext eines fehlgeschlagenen Versuchs in den neuen
  kopiert. Der Nutzer sieht „Versuch 1 abgebrochen, Versuch 2 läuft" — genau
  damit wird ein 200-aber-failed-Fall überhaupt diagnostizierbar.

#### Kosten — dokumentierte Entscheidung

Ein Retry sendet die Anfrage erneut. Hat der Provider angefangen zu
generieren, wird der erste Versuch **trotzdem abgerechnet**. Auto-Retry bei
„Antwort kam, unbrauchbar" kann also Mehrkosten verursachen. Das ist bewusst so
entschieden: bei 200-aber-failed ist der erste Versuch für den Nutzer wertlos,
und ein Turn, der hängen bleibt, ist schlechter. Die harte Grenze bleibt
**3 Versuche pro Turn**.

#### Stream-Transport im Übrigen

- **Passive Erkennung** der Chunk-Signatur pro `provider + baseURL`, gespeichert
  und in den Settings sichtbar und zurücksetzbar.
- **Onboarding-Probe** mit derselben Messung auf einer winzigen Anfrage.
- **Fallback ohne Streaming:** `generateText` → `createUIMessageStream` mit
  synthetischen `text-delta`-Chunks. Kein eigener Transport, kein zweiter
  Codepfad im Loop.
- **Dauerhafter Hinweis**, wenn Antworten am Stück ankommen — sonst hält man die
  UI für kaputt.

#### Was die Engine tatsächlich prüft — und wo die Grenze liegt (revidiert)

Dieser Abschnitt ist eine **Korrektur**, keine Ergänzung. Die Regel oben
(„ein 200 ist eine Behauptung, keine Tatsache") bleibt richtig; sie ist aber
**nicht auf jeder Ebene** durch den Code einlösbar, und das gehört hier hin,
statt es in einem Kommentar zu verstecken.

**Die Regel gilt auf der Response-Body-Ebene, nicht auf der Chunk-Ebene.**
Durch `ToolLoopAgent` sieht die Engine **keinen** rohen Chunk-Stream:
`ToolLoopAgentSettings` hat **kein** `onChunk`, **kein** `includeRawChunks`,
**kein** `onError` (gegen `ai/dist/index.d.ts` geprüft). Das
SSE-`data: [DONE]`, das oben als Erfolgskriterium steht, ist von hier aus
**nicht erreichbar**. Wer es braucht, muss das `LanguageModel` in der
Registry umhüllen — **eine spätere Entscheidung, hier nicht getroffen.**

Was **stattdessen** gemessen wird, zwei Signale, beide echt:

| Signal | Woher | Was es trägt |
|---|---|---|
| `rawFinishReason` am `finish`-Part | der **Provider** selbst, wörtlich; der SDK lässt es `undefined`, wenn er den Part **selbst** erzeugt | abgeschnittener Stream → `undefined`; ein vom Provider gesendeter `finish`, auch mit `other` → gesetzt |
| `AI_NoOutputGeneratedError` | der SDK, mit `"The model stream ended without a finish chunk."` | ein Stream ganz ohne Ausgabe |

**Warum die alte Heuristik ersetzt werden musste — nicht verbessert.** Sie war
nicht ungenau, sie war **entartet**: `ai@7.0.122` rechnet
`unified: finishReason === "unknown" ? "other" : finishReason`. Ein Provider,
der **absichtlich** mit dem spec-legalen `"unknown"` endet, erzeugt damit eine
**byte-identische** Part-Sequenz wie ein abgeschnittener Stream — beide melden
`"other"`. Gemessen: ein sauber beendeter `finish("other")` wurde als
Abschneidung gelesen und **erneut gesendet** — drei Requests für eine Antwort,
die da war. Ein Terminal-Event aus einem **normalisierten** Wert zu raten ist
schlimmer als gar keiner, weil es auf richtigen Antworten feuert.

**Und die Klassifikation hat jetzt *eine* Implementierung.** `classifyResponse`
ist die einzige Regel; `classifyThrownError` ist ein dünner Adapter darauf, und
der Loop ruft `classifyResponse` **für jeden fehlgeschlagenen Turn** mit den
beobachteten Fakten. Vorher gab es zwei Regelsätze, die sich widersprachen, und
nur einer davon wurde von einem Turn je erreicht: `AbortError` mit
`statusCode 500` war „nicht wiederholen" gegen „retryable 500", und eine fehlende
`LoadAPIKeyError` — also ein **nicht konfigurierter Key** — wurde als
`no-response` gemeldet, also als das 20-Sekunden-Stillstandskonzept „warte auf
eine Antwort, die nie kommen kann". Der User wurde auf ein Warten hingewiesen,
das nichts beheben konnte. Beides ist jetzt eine Aussage: ein lokaler Abbruch
ist `no-response` (nie wiederholen, egal was der Wurf trägt), ein fehlender Key
ist `config-error` (endgültig, mit benanntem Code für die UI).

**Offene Lücke, benannt statt kaschiert:** `stallTimeoutMs` ist die Länge des
`waiting`-Zustands und **misst nichts**. Der Loop kann ein `stream()`, auf das
er wartet, nicht unterbrechen, also kann er keinen Stillstand messen — und
`no-response` hat damit im Turn keine Erzeugung. Die Messung gehört an den


#### Korrektur 2 (datiert): der Terminal-Check war ein Feld, das nicht überall existiert

Die vorige Korrektur in diesem Abschnitt sagt, der Check sei
`sawTerminalEvent = part.rawFinishReason !== undefined`. **Das war falsch**, und nicht aus
einem Nebensatzgrund: **`@ai-sdk/openai@4.0.81` setzt `rawFinishReason` auf dem
Responses-Pfad nie.**

```
$ grep -rn "rawFinishReason" node_modules/.pnpm/@ai-sdk+openai@4.0.81*/…/dist/
  (keine Treffer)
955:  incomplete_details?: { reason: string } | null | undefined
```

`incomplete_details.reason` ist optional und fehlt bei einem **sauberen** Abschluss. Mit dem
OpenAI-Provider las sich daher **jeder erfolgreiche Responses-Turn wie ein abgeschnittener
Stream** — drei Wiederholungen für eine Antwort, die bereits vorlag. Gegen echtes Geld.

**Die Lehre, die ich notiere, weil sie mich selbst betrifft:** ein *besseres* Signal ist
nicht dasselbe wie ein Signal, das **auf jedem Pfad vorkommt**. Ich habe `rawFinishReason`
gefeiert, weil es öffentlich, typisiert und trägt die Begründung des Providers wörtlich — und
nie gefragt, ob es überall existiert.

**Und die Lehre aus dem grünen E2E-Lauf, der nichts bewies:** die Suite war grün, weil der
Fake über `openai-compatible` fährt — **den einen Pfad, auf dem `raw` immer gesetzt ist.**
Der Defekt war für den Fake aus demselben Grund unsichtbar wie für jeden Core-Test. Ein
grüner Lauf, dessen Fake zufällig die richtige Ecke des Fehlers abdeckt, ist **kein** Beweis.

#### Der Check, der jetzt gilt — die **Konjunktion**, und sie ist keine Heuristik

Gemessen am echten `ToolLoopAgent`, nicht am Mock:

| Fall | `finishReason` | `rawFinishReason` |
|---|---|---|
| Stream mitten im Text abgeschnitten | `"other"` | `undefined` |
| Chat-Completions, sauber | `"stop"` | `"stop"` |
| **Responses, sauber** | `"stop"` | **`undefined`** |
| Provider meldet absichtlich `"other"` | `"other"` | `"other"` |
| gar keine Ausgabe | — | — (`NoOutputGeneratedError`) |

```
sawTerminalEvent = part.rawFinishReason !== undefined
                 || part.finishReason !== "other"
```

**Beide Hälften sind tragend**, und das ist der Punkt:

- `raw` allein verfehlt den **sauberen Responses-Turn**.
- `finishReason !== "other"` allein ist der zurückgenommene Proxy — er feuert bei einem
  Provider, der **absichtlich** mit `"other"` endet.

Und es ist **keine** Heuristik, weil `ai@7.0.122` die Platzhalter selbst setzt
(`dist/index.js:11236`):

```js
let stepFinishReason = "other";
let stepRawFinishReason = void 0;
```

`flush()` stellt den schließenden Part **nur dann** aus diesen Werten zusammen, wenn
`hasReceivedTerminalChunk` false ist. Ein Part, der **beide** Platzhalter noch hält, ist
der SDK, der einen abgeschnittenen Stream meldet — über den einzigen Kanal, den er hat.

**Meine vermeintlich sicherere Vorgabe war falsch.** „Abwesenheit ist kein Beweis für
Trunkierung" hätte §5.4s Trunkierungs-Verdikt **ersatzlos gestrichen**: der SDK
synthetisiert *immer* einen `finish`-Part, also erreicht `"absent"` die Prüfung nie. Die
sichere Richtung ist hier die **strenge**, und das war nicht vorhergesehen.

`NoOutputGeneratedError` behält seinen eigenen Grund, damit die UI „erzeugte nichts und
hielt nie" von „mitten im Stream abgebrochen" unterscheiden kann.

**§5.4 hat jetzt eine Implementierung, nicht zwei:** der Loop fragt `classifyResponse` und
folgt dem Verdikt. Ein zweites Prädikat im Loop war zunächst äquivalent zum
Klassifikator — der Mutator überlebte, und statt Äquivalenz zu erklären wurde der
Duplikatcode **entfernt**. Ein Prädikat, das ein anderes dupliziert, ist eine
Wartungsfalle, auch wenn es gerade korrekt ist.

#### Korrektur (datiert): `no-response` **wird** im Turn erzeugt

Die Zeile oben — *„`no-response` hat damit im Turn keine Erzeugung"* — ist **falsch**, und
sie ist mir von einem Verify-Agenten widerlegt worden. Belege:

```
classify.ts:504   if (!facts.responded) return { kind: "no-response" };
classify.ts:517   if (isAbortLike(facts.error)) return { kind: "no-response" };
loop.ts:829       if (classification.kind === "no-response") { … }
```

Die Engine erzeugt das Verdict. Was nicht existiert, ist ein **App-seitiger Erzeuger**, und
genau darüber ist die Absatz verwaschen: aus „der App fehlt ein Erzeuger" wurde fälschlich
„niemand erzeugt es".

**Was tatsächlich gilt, und worauf ich in meinem Auftrag falsch bestanden habe:** ich habe
einen Watchdog verlangt, der §5.4s `no-response` erfüllt. Der vorhandene Watchdog in
`packages/baah-web/src/runtime/watchdog.ts` tut das **nicht** — und **soll das auch nicht**.
Er beobachtet jedes `AgentEvent` des Loops, setzt seinen Timer echt zurück und latched in den
Zustand, damit ein spät abonnierter Subscriber den Wartezustand noch erfährt. Aber er trägt
`silentForMs` und `lastEventType`, **keine Klassifikation**, und er kann den Turn nicht
beenden.

| | Klassifikation | Stall-Report |
|---|---|---|
| wer | Engine (`classify.ts`) | App (`watchdog.ts`) |
| was | `kind: "no-response"` | `silentForMs` + `lastEventType` |
| Wirkung | beendet den Turn | **keine** — §5.4: ein Stall ist ein Wartezustand, nie eine automatische Aktion |
| erreicht §5.4? | ja | **nein, und das ist dokumentiert** |

**Bleibt offen, ehrlich benannt:** der **rohe Provider-Chunk**. `ToolLoopAgentSettings` hat
kein `onChunk`, kein `includeRawChunks`, kein `onError` — dieselbe Grenze, die schon beim
Terminal-Event aufgefallen ist. Ein Watchdog auf dem richtigen Signal, der §5.4 behauptet,
wäre schlimmer als eine benannte Lücke. Diese Datei benennt sie.

→ **Anhang, keine Überschreibung** (`AGENTS.md` §7.2b). Der Absatz oben bleibt stehen, weil
er dokumentiert, **wie** die Aussage entstanden ist; dieser Block sagt, was daran falsch war.

Transport (ein Watchdog auf die Chunk-Zeitpunkte), also an dieselbe Stelle, an
der auch das 20-s-Fenster durchgesetzt werden müsste, damit es etwas bedeutet.
Ein Stall-Detektor, der keinen Stall beobachten kann, ist von gar keinem nicht
unterscheidbar.




### 5.5 Shell — von „nicht v1" zu „v1 möglich" (revidiert)

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

#### Präzisierung der zwei Anker (aus der Verifikation)

**`tool_invocations.status` ist `begun | done`.** Die Spalte existierte, stand
aber für nichts Brauchbares, weil beide Schreiber — `beginToolCall` **vor** der
Ausführung, `recordToolCall` **danach** — in dasselbe Feld schrieben. „Begonnen,
Ausgang unbekannt" war damit **nicht darstellbar**, und genau das ist der
Zustand, in dem ein Absturz zwischen den beiden Schritten landet. Die Engine
schließt daraus nie stillschweigend: Kurzschluss nur auf `done`, sonst ein für
Modell **und** User sichtbares „Ausgang unbekannt". Vollständig in §5.1.

Der Kurzschluss-Key ist `(session_id, attempt, toolCallId, occurrence)`. Für
`session_id` hat die Tabelle bereits die Spalte; `attempt` und `occurrence` sind
Engine-Buchführung und gehören in die Key-Berechnung des Stores, nicht
zwingend in die Tabelle.

**`heartbeat_at` braucht eine Schwelle, sonst ist es kein Anker.** §6.1 nennt
den Anker, aber keine Grenze — ein frischer und ein verwaister Turn waren
identisch. Die Engine erneuert ihn je `onStepEnd` **und** zu Beginn jedes
Versuchs; beim Start gilt `age >= 30 s` als tot, alles darunter als lebendig
(also: **nicht** anfassen — ein zweiter Tab arbeitet daran). Grenze, Trade und
Restrisiko in §5.1.

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

### 6.3 Was browser-only (nicht) möglich ist

**Korrektur zu einer früheren Fassung dieses Plans:** Ich hatte geschrieben,
ein laufender Stream sei nach einem Reload „nicht wieder anhängbar". Das ist zu
absolut. Ein **Service Worker** ist ein dokumentunabhängiger Kontext und kann
die Seite überleben — damit überlebt der Stream *einen Reload*. Aber er
überlebt nicht den Browser.

Belegte Grenzen (§14.6), die die Reichweite festlegen:

| Grenze | Wert | Konsequenz |
|---|---|---|
| Idle-Timeout des Service Workers | **30 s** ohne Aktivität | Der Idle-Timer wird bei **jedem `reader.read()`** zurückgesetzt, solange das Promise offen ist. Ein *aktiv fließender* Stream hält den SW also am Leben — `setInterval` dagegen **nicht**. |
| Einzelner Request | **5 min** hart, Chrome **und** Firefox | WONTFIX in der Spec-Diskussion („Chrome stops the service worker after 5+ minutes timeout **even if it is streaming**"). |
| `fetch()`-Antwort | 30 s bis zum ersten Byte | Für LLM-Streams unkritisch. |

**Was daraus folgt — ehrlich:**

- Ein Turn, der **kürzer als ~5 Minuten** ist, überlebt einen Reload: der SW
  schreibt die Deltas weiter in die DB, die neue Seite liest sie und hängt sich
  wieder an.
- Ein **längerer** Turn stirbt **hart** — mitten im Stream, ohne Vorwarnung. Das
  ist schlechter als der heutige Zustand, weil man es nicht kommen sieht.
- Pausiert der Provider **> 30 s** (langes Reasoning ohne Deltas), kann Chrome
  den SW trotzdem abräumen.

**Der Preis:** Der ganze Loop (AI SDK + Tool-Ausführung) müsste in den SW
wandern. Das kollidiert mit unserem Design:

- `showDirectoryPicker()` und `requestPermission()` brauchen einen
  **Main-Thread mit Nutzergeste** — der SW kann beides nicht.
- Approval-Cards und `question` sind UI und müssen über die Seite laufen.
- Also bräuchte jeder Tool-Aufruf einen Round-Trip Page ↔ SW, und der SW müsste
  ein bereits gewährtes `FileSystemDirectoryHandle` per `postMessage` bekommen
  (ob SWs Handles annehmen, ist **UNVERIFIED** — muss getestet werden).

**Entscheidung:** Service Worker wird **nicht** zum Fundament des Loops. Er kommt
in zwei Stufen, die beide auch ohne ihn nützlich sind:

1. **Phase 2 — SW als Infrastruktur:** Offline-App-Shell, Single-Writer für die
   DB über Tabs hinweg (`navigator.locks` + `BroadcastChannel`), und
   **PWA-Installation**. Der Install bringt einen konkreten Gewinn: eine
   installierte PWA behält auf Chrome die Datei-Freigaben **ohne erneute
   Rückfrage** (§14.1).
2. **Phase 6 — Experiment „Stream überlebt Reload":** SW als Stream-Relay,
   hinter einer Fähigkeitsprüfung und mit ehrlichem Erwartungswert (≤ 5 min).
   Wird nur gebaut, wenn die Messung die 5-Minuten-Grenze nicht ohnehin
   entwertet.

**Was in jedem Fall unmöglich bleibt:**

- Ein Stream, der **den Browser** überlebt (Tab schließen, Browser beenden).
- Der Provider generiert nach dem Abbruch weiter und rechnet ab — diese Tokens
  sind unwiederbringlich.
- Ein bereits laufendes Tool „exactly once" wiederherstellen; offene Approvals
  müssen nach dem Reload neu bestätigt werden.
- **`Background Fetch`** löst das nicht: Chrome-only, erzwingt eine
  nicht-schließbare Browser-UI, ist auf GET/Blob-Downloads ausgelegt — nicht auf
  einen POST mit gestreamter Antwort.

Die Recovery-Leitplanke aus §6.2 bleibt also **in jedem Fall** nötig: Deltas
aggressiv persistieren, unterbrochene Turns markieren, „Wiederholen" anbieten.
Der SW verbessert die Lage, er ersetzt sie nicht.


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
| `todo` | `*` (unsere eigene Zutat, §14.3 — das Vorbild hat kein Todo-Tool) |
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

| Provider | Preflight | Fehlerpfad (401) | Browser-direkt? |
|---|---|---|---|
| **OpenAI** | ✅ | ❌ **kein ACAO** auf `/v1/chat/completions` und `/v1/responses` (nur `/v1/models` hat `*`) | ⚠️ **unbestätigt** — siehe unten |
| **Anthropic** | ✅ mit Header | ✅ `*` **nur mit** Header | ✅ ja, Header ist Pflicht |
| **Google** (Generative Language) | ✅ | ✅ (Origin-Echo) | ✅ ja |
| **OpenRouter** | ✅ | ✅ `*` | ✅ ja |
| **Groq**, **xAI**, **Mistral**, **Cerebras**, **Together**, **DeepSeek** | ✅ | ✅ `*` | ✅ ja |
| **Vercel AI Gateway** | ✅ | ✅ `*` | ✅ ja (siehe Vorbehalt) |
| **OpenCode Zen** | ❌ | ❌ kein ACAO | ⛔ **nicht möglich** |
| **models.dev** (Modellkatalog) | — | — | ✅ ja |
| Beliebige OpenAI-kompatible `baseURL` | betreiberabhängig | — | ❓ **zur Laufzeit prüfen** |

**OpenAI ist der Sonderfall — und ich hatte das zuerst zu optimistisch
hingeschrieben.** Gemessen (eigener Test, nicht übernommen):

```
GET  /v1/models             → 401 + access-control-allow-origin: *
POST /v1/chat/completions   → 401 + (kein ACAO)
POST /v1/responses          → 401 + (kein ACAO)
```

Der Preflight geht durch, aber die **Inferenz-Endpunkte senden auf dem
Fehlerpfad keine CORS-Header**. Im Browser heißt das: statt einer lesbaren 401
sieht der Nutzer ein undurchsichtiges `TypeError: Failed to fetch`. Ob der
**Erfolgspfad** (200, gestreamt) ACAO sendet, ist **ungetestet** — dafür
braucht es einen echten Key.

Konsequenz für das Design: **OpenAI wird nicht als „funktioniert" beworben,
sondern über den Verbindungstest im Onboarding geprüft.** Und die
Fehlerbehandlung muss den CORS-Fall abfangen und als „der Provider blockt
Browser-Aufrufe (oder der Key ist falsch)" erklären — nicht als App-Bug.

**Anthropic ist der andere Sonderfall, und der Befund ist eindeutig:**
Ohne `anthropic-dangerous-direct-browser-access: true` → 401 **ohne** ACAO
(Browser blockt). Mit dem Header → 401 **mit** `*`. Das AI SDK setzt den Header
**nicht** selbst:

```ts
createAnthropic({
  apiKey,
  headers: { "anthropic-dangerous-direct-browser-access": "true" },
})
```

**OpenCode Zen ist nicht nutzbar** (Preflight 404, Fehlerpfad ohne ACAO). Nicht
darum herum designen.

**Vercel AI Gateway** funktioniert (auch im Fehlerpfad) und wäre der
Ausweg für Provider, die blocken. Der Vorbehalt gehört in die UI: es ist ein
Dritter, der den gesamten Traffic sieht. Optional, nie Voreinstellung.

Weitere Konsequenzen:

- **Keys müssen explizit übergeben werden.** Das SDK liest im Browser **keine**
  Umgebungsvariablen; ohne `apiKey` wirft es `LoadAPIKeyError` beim ersten
  Aufruf. Diese Fehlermeldung gehört in der UI zu „bitte API-Key hinterlegen".
- **`dangerouslyAllowBrowser` gibt es im AI SDK nicht** (das ist ein Flag der
  Vendor-SDKs) — es gibt nichts „einzuschalten".
- **Telemetrie explizit aus:** `telemetry: { isEnabled: false }`. Ohne
  registrierte Integration sendet das SDK nichts, aber die Option gilt laut
  Doku als default-aktiv, sobald eine Integration registriert ist.
- **Jeder Provider wird im Onboarding real getestet**, nicht nur ausgewählt.




## 10. Roadmap

Jede Phase endet mit `pnpm check` grün **und** unabhängiger Verifikation (§12).

| Phase | Inhalt | Fertig, wenn |
|---|---|---|
| **0 — Fundament** ✅ | Repo, pnpm-Workspace, TS 7/Tailwind 4/daisyUI 5, `core`-Verträge, `read`/`write`/`edit`/`list`, `Plan.md`, `AGENTS.md`, Recherche FS + DB | `pnpm check` grün; 52 Tests |
| **1 — Engine-Kern** | OPFS-Workspace, SQLite-Worker (`sqlite-wasm` + `opfs-sahpool`), Drizzle-`sqlite-proxy`, Migrationen, Loop-Skelett gegen Mock-Modell | Contract-Tests aller Tools; Loop läuft headless im Test; Reload überlebt |
| **2 — Suche + Service Worker** | `glob` (`picomatch`), `grep` (`grep-wasm` + JS-Fallback), `ignore`-Filter, Pfad-Index im Worker, Perf-Smoke (≥10k Dateien); **SW als Infrastruktur**: Offline-App-Shell, Single-Writer (`navigator.locks` + `BroadcastChannel`), PWA-Manifest | Suche blockiert UI nicht; Benchmark dokumentiert; App startet offline; zwei Tabs kollidieren nicht |
| **3 — UI + Onboarding** | Transcript, Tool-Karten, Approval-Cards, Wizard, Settings, Export/Import | Playwright: 0 → Chat, Reload-Resilienz, Export→Import |
| **4 — Tier 2 + Shell** | `todo`, `question`, `skill`, `AGENTS.md`-Injektion, `task`/Subagent, `shell` (`just-bash`), `git` (`isomorphic-git`) | Subagent läuft isoliert mit eigenem Kontext; Shell nur über die Allow-Liste |
| **5 — Härtung** | FS-Access-Workspace (echter Ordner), Resume nach Reload, Token/Kosten, `webfetch`, CORS-Matrix als Test | Reconnect-Test: Reload mitten im Turn → sauberer Zustand |
| **6 — optional** | Route B (WASM-Node) als bewusst eingeschalteter Modus, MCP-Spike (nur `remote`), Tree-Sitter-Highlighting, TS-6-Sprachdienst im Worker, **SW-Relay-Experiment** („Stream überlebt Reload", Erwartungswert ≤ 5 min, §14.6) | — |

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

**Keine offiziellen Chat-Komponenten.** Alles über `message.parts` selbst
rendern (daisyUI hat passende `chat`/`chat-bubble`-Klassen). `@ai-sdk/rsc` ist
RSC-only und wird **nicht** verwendet.

#### Was daraus für den Loop folgt (Nachtrag aus der Verifikation)

**Der rohe Chunk-Stream ist durch `ToolLoopAgent` nicht erreichbar.** Die
Einstellungen kennen **kein** `onChunk`, **kein** `includeRawChunks`, **kein**
`onError` — alle drei gegen die installierte `dist/index.d.ts` geprüft. Damit
gibt es auf dieser Ebene **keinen** Weg, das `data: [DONE]` aus §5.4 zu sehen.
Das ist keine Lücke in der Implementierung, sondern eine Eigenschaft der
gewählten Schicht; sie aufzulösen heißt, das `LanguageModel` in der
Provider-Registry zu umhüllen — **eine spätere Entscheidung, hier nicht
getroffen.** Was die Engine stattdessen hat, steht in §5.4.

**`rawFinishReason` ist der Ersatz, und er ist kein Ersatz im Notsinn.** Auf dem
`finish`-Part trägt er den **Grund des Providers, wörtlich**; der SDK lässt ihn
`undefined`, wenn er den Part nach einem Stream ohne Provider-Ende selbst
erzeugt. Gemessen gegen `ai@7.0.122`: ein sauberer `finish("other")` des
Providers meldet `finishReason: "other"` **und** `rawFinishReason: "other"`, ein
abgeschnittener meldet `finishReason: "other"` und **kein** `rawFinishReason`.
Genau diese eine unterscheidbare Eigenschaft war vorher nicht benutzt worden —
stattdessen wurde `finishReason !== "other"` geraten, was nicht ungenau, sondern
**entartet** war.

**Was `ToolLoopAgent` *nicht* kann, steht hier, weil es jemand brauchen wird:**
`streamRetries` gibt es auf `streamText`, **nicht** auf `ToolLoopAgentSettings`
(Durchreichen ist ein Typfehler). Der einzige Retry-Loop der Engine ist der
eigene, und `maxRetries: 0` schaltet den SDK-Loop ab. Beides steht als Wert in
`staticAgentSettings()` und wird von einem Test geprüft — nicht in einem
Kommentar, denn das Löschen der Zeile hat einmal **403 Tests** überlebt.


### 14.5 Browser-Sandbox, Shell-Ersatz und Code-Suche (abgeschlossen)

**Kernbefund: die Frage ist nicht „läuft es?", sondern „welche Lizenz-, Header-
und API-Key-Steuer zahlst du?".** Es gibt einen header-freien, quelloffenen Weg
(Route A) und einen mächtigeren, aber belasteten (Route B).

| Fähigkeit | 2026 möglich? | Paket |
|---|---|---|
| Echter Bash-Interpreter im Browser | ✅ **ohne Header** | **`just-bash@3.4.2`** (Apache-2.0) |
| ripgrep als WASM, in-memory-Dateien | ❌ | **verworfen** — die Messung ergab zwei ungleiche Engines, also einen stillen Dialektwechsel. Siehe §14.5 |
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

**Risiko:** Version `0.1.0`, ein Maintainer. ~~Deshalb ist der
JS-`RegExp`-Scanner kein Notnagel, sondern ein gleichwertiger Pfad.~~

**Korrigiert, weil die Verifikation es gemessen hat — diese Behauptung war
falsch.** Die beiden Engines sind *nicht* gleichwertig: `\p{L}+` liefert auf
ripgrep 6 Treffer und auf dem JS-Scanner 0, Lookaround und Backreferences nimmt
nur eine von beiden an. Der Fallback war damit **kein Sicherheitsnetz, sondern ein
stiller Dialektwechsel** — und das ist *schlimmer* als gar keine zweite Engine,
denn das Ergebnis sieht in beiden Fällen identisch aus.

→ **Entscheidung (umgesetzt): `grep-wasm` entfernt, nicht deaktiviert.** Die
Begründung, die ich jetzt für die tragfähige halte, ist **nicht** die
Schema-Argumentation und auch nicht „war langsam und ungenutzt":

| Begründung | trägt? |
|---|---|
| „`0.1.0`, ein Maintainer" | Risiko, aber kein Beweis |
| „lief nie — in keinem Test" | Symptom |
| „kein Schemaparameter bildet eine ripgrep-Fähigkeit ab" | **wahr, aber nicht das stärkste** — das gilt ebenso für ein gut gewähltes Schema |
| **„der Fallback log nicht mit, welche Sprache geantwortet hat"** | **das Entscheidende** |

Die Abhängigkeit wurde also **nicht entfernt, weil sie ungenutzt war, sondern
weil sie unehrlich war**: ein Tool, das ein Ergebnis liefert und nicht sagt,
welche von zwei Query-Sprachen es war, ist ein Tool, das eine Behauptung über
Vollständigkeit aufstellt, die es nicht einlösen kann.

Der Scanner bleibt der **einzige** Motor, und sein Dialekt steht jetzt im
`description`-Feld, damit das Modell ihn kennt (`Rust-regex-Teilmenge; kein
Lookaround, keine Backreferences`). Die Naht bleibt: falls ripgrep zurückkommt,
als **opt-in Accelerator mit Äquivalenztest** gegen den JS-Scanner.

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

### 14.6 Service Worker als Überlebensschicht (nachgezogen)

Auf Nachfrage geprüft, ob ein Worker den Stream über einen Reload retten kann.
Ergebnis: **Dedicated und Shared Worker nicht, Service Worker teilweise.**

| Kontext | Lebt der Stream einen Reload der Seite? |
|---|---|
| Dedicated Worker | ❌ stirbt mit dem Dokument |
| Shared Worker | ❌ stirbt, wenn der letzte Client geht |
| **Service Worker** | ⚠️ **ja — bis ~5 Minuten**, dann hart beendet |
| Background Fetch | ❌ Chrome-only, Pflicht-UI, GET/Blob — kein POST-Stream |

Die harten Zahlen (Chrome-Doku, Spec-Diskussion, Mozilla-Bug):

- **30 s Inaktivität** → beendet. Der Timer wird bei **jedem `reader.read()`**
  zurückgesetzt, solange das Promise offen ist. **Ein aktiver Lese-Loop hält den
  SW also am Leben; `setInterval` nicht.**
- **5 min pro Request** → hart beendet, **auch wenn gestreamt wird**.
  Chrome-Bug 753646 wurde als WONTFIX geschlossen; Firefox beendet ebenfalls
  nach ~5 Minuten. Kein `waitUntil()` hebt das auf.
- **30 s bis zur ersten Byte einer `fetch()`-Antwort** → beendet.
- Serverseitige Pausen > 30 s (langes Reasoning ohne Deltas) sind damit ein
  zusätzliches Risiko.

**Fazit:** Der SW ist die einzige echte Verbesserung — aber er ist ein
Zeitfenster, kein Zustand. Er rechtfertigt keinen Umbau des Loops in den SW
(Tool-Ausführung braucht Main-Thread-Gesten und UI), wohl aber zwei Dinge, die
auch für sich lohnen: **Offline-App-Shell + Single-Writer + PWA-Install**
(Phase 2) und ein **begrenztes Relay-Experiment** (Phase 6).

### 14.7 Nachtrag aus dem Gegencheck

Ein zusätzlicher Recherche-Agent hat den AI-SDK-Strang unabhängig geprüft. Er
hat einen **Fehler in meiner Matrix gefunden** (§9: OpenAI sendet auf dem
Fehlerpfad kein ACAO — ich hatte das zu optimistisch als „✅" geführt) und
mehrere Punkte ergänzt, die sonst später Zeit gekostet hätten:

**Harte Verifikation, die Vertrauen verdient:**

- **Browser-Bundle real gebaut:** `esbuild --bundle --platform=browser` über
  `ai` + `@ai-sdk/react` + vier Provider → **exit 0, keine Warnungen, null
  `node:*`-Imports**. Damit ist „läuft im Browser" nicht mehr plausibel, sondern
  belegt — und `vite-plugin-node-polyfills` ist **nicht** nötig (und wäre ein
  Geruch).
- `@ai-sdk/provider-utils` exportiert offiziell `isBrowserRuntime()`.

**Praktische Fallen, die neu sind:**

| Fund | Konsequenz |
|---|---|
| `@opencode-ai/models/snapshot` ist **6,35 MB** statisches ESM | Nur per dynamischem `import()` laden, sonst dominiert es den Bundle. |
| `@ai-sdk/code-mode` ist **Node-only** („not available in browser or edge runtimes") | Unser Code-Mode-Tool ist damit ein Eigenbau — oder gestrichen. |
| `@ai-sdk/mcp` Haupt-Entry ist browser-safe, **`/mcp-stdio` nicht** | Für die spätere MCP-Phase: nur HTTP/SSE importieren. |
| **Subagenten haben laut Doku keine Tool-Approvals** | Unser Permission-Modell darf sich nicht darauf verlassen, dass ein Subagent nachfragen kann — die Policy muss **vor** dem Start greifen. |
| `execute` darf ein **Async-Generator** sein → vorläufige Tool-Ergebnisse | Genau richtig für Subagent-Fortschritt im UI. |
| `pruneMessages({messages, reasoning, toolCalls, emptyMessages})` ist eingebaut | Mechanische Kompaktierung ist gratis; nur die Zusammenfassung ist unsere Arbeit. |
| `experimental_sandbox` an `execute` ist **host-provided** | Kein Browser-Sandbox — nicht darauf planen. |
| `HarnessAgent` / `@ai-sdk/harness-*` existieren, sind aber experimentell und sandbox-orientiert | Nicht der richtige Weg für uns. |

**Reuse-Shortlist (verifiziert, browser-safe):** `shiki@4.4.3` (Highlighting,
Browser-Entry), `streamdown@2.6.0` (streaming-sicheres Markdown — passt genau zu
unseren Deltas), `react-markdown@10.1.0`, `gpt-tokenizer@4.0.0` bzw.
`js-tiktoken@1.0.21` (Token-Zählung für die Kostenanzeige), `diff@9.0.0`
(Diff-Vorschau für Approval-Cards), `picomatch@4.0.7`, `ignore@7.0.10`,
`idb@8.0.3`.




---

## 15. Manuelle Browser-Prüfung

Diese Schritte sind **nicht** automatisierbar — sie brauchen eine echte
Browser-Umgebung. Jeder Punkt nennt, **was** geprüft wird und **woran** erkennbar
ist, dass es kaputt ist. Ein Punkt gilt als erledigt, wenn das erwartete
Verhalten beobachtet wurde, nicht wenn der Code gelesen wurde.

### 15.1 Workspace: echter Ordner (Chromium)

| # | Schritt | Erwartet | Kaputt, wenn |
|---|---|---|---|
| W1 | „Ordner verbinden" klicken, echten Projektordner wählen | Ordner erscheint als Workspace, Dateiliste stimmt | Liste leer oder Fehler |
| W2 | `read` auf eine bekannte Datei | Inhalt mit Zeilennummern | `File not found` trotz existierender Datei |
| W3 | `write` in eine neue Datei, dann in einem **Texteditor daneben** nachsehen | Datei liegt real auf der Platte | Nichts auf der Platte |
| W4 | `edit` an der Datei, im Texteditor nachsehen | Änderung sichtbar, keine Temp-Datei daneben | `.tmp`-Dateien, halber Inhalt |
| W5 | Seite neu laden, dann auf „Projekt wieder öffnen" klicken | Permission-Dialog, danach voller Zugriff | Handle verloren |
| W6 | `glob` über ein echtes Repo | Treffer, `node_modules` fehlt | `node_modules` im Ergebnis |
| W7 | `grep` nach einem bekannten Symbol | Treffer mit Datei und Zeile | Timeout oder Treffer in Binärdateien |
| W8 | Reload mitten in einem laufenden Turn | Teiltext bleibt, Turn `interrupted`, Wiederholen angeboten | Stiller Verlust oder Hänger |

### 15.2 Workspace: Sandbox-Modus (Firefox/Safari)

| # | Schritt | Erwartet | Kaputt, wenn |
|---|---|---|---|
| S1 | Sandbox öffnen, Datei schreiben, neu laden | Datei noch da | Daten weg |
| S2 | `navigator.storage.persist()` anzeigen | „Dauerhaft gespeichert" | „nur bis Tab geschlossen" |
| S3 | Projektordner importieren, bearbeiten, exportieren | Export enthält die Änderungen | Änderungen bleiben nur in der Sandbox |
| S4 | **7 Tage ohne Interaktion** simulieren, dann öffnen | Daten noch da | Eviction durch Safari |

### 15.3 Stream-Verhalten

| # | Schritt | Erwartet | Kaputt, wenn |
|---|---|---|---|
| T1 | Onboarding-Verbindungstest | Antwort streamt | „Streaming blockiert" erscheint fälschlich |
| T2 | Frage stellen, Deltas ansehen | Text erscheint laufend | Alles auf einmal trotz Streaming-Support |
| T3 | **Ausfall simulieren:** Netz nach 1 s kappen | Ein Retry mit Backoff, sichtbar als „Versuch 2 von 3" | Kein Retry oder Endlosschleife |
| T4 | **200-mit-Fehler-JSON** provozieren (ungültiger Modellname) | Klarer Provider-Fehler, kein Retry-Loop | Endlosschleife oder „Erfolg" mit leerem Transcript |
| T5 | `429` provozieren (Quota erschöpft) | Hinweis auf Quota, **keine** Wiederholung | Wiederholungsschleife bei `insufficient_quota` |
| T6 | `401` provozieren (falscher Key) | Hinweis „Key ungültig", **keine** Wiederholung | 401-Loop |
| T7 | Sehr lange Antwort (Reasoning-Modell) | Wartenanzeige, **keine** automatische Degradierung | Stream fälschlich als „gepuffert" markiert |

### 15.4 Persistenz

| # | Schritt | Erwartet | Kaputt, wenn |
|---|---|---|---|
| D1 | Turn abschließen, neu laden | Verlauf vollständig, Reihenfolge korrekt | Nachrichten fehlen oder sind vertauscht |
| D2 | Zwei Tabs öffnen | Einer meldet „anderer Tab besitzt die Daten" | Beide schreiben gleichzeitig, korrupte DB |
| D3 | Lange Konversation | Historie per FTS5 durchsuchbar | Suche findet nichts |
| D4 | Speicher auffüllen bis Quota | Verständlicher Fehler | Stiller Datenverlust |

### 15.5 UI (nach dem Build, zusammen mit dem UI-Review)

- [ ] Onboarding auf Desktop und auf schmalem Viewport
- [ ] Tool-Karten: `running` / `approval-requested` / `output-available` / `output-error` unterscheidbar
- [ ] Approval-Card blockiert die weitere Bedienung eindeutig
- [ ] Tastaturbedienung: Tab-Reihenfolge, `Enter` zum Senden, `Esc` zum Abbrechen
- [ ] Dark/Light-Theme ohne unlesbare Kontraste
- [ ] Lange Pfade, lange Tool-Ausgaben und Fehlermeldungen brechen das Layout nicht

### 15.6 E2E mit gefälschten Provider-Antworten

Die Playwright-Suite fängt `fetch` ab und liefert selbst gebaute
OpenAI-kompatible Streams. Damit wird **ohne** echten Key und **ohne** Netz
getestet: reiner Text-Stream · Stream mit Tool-Call, Tool OK, dann Text ·
Tool-Call mit `output-error` · Approval-Pause und -Fortsetzung · 200 mit
Fehler-JSON · 5xx mit Backoff · 401 ohne Retry · Abbruch mitten im Stream.

---

## 16. Wave-2-Verträge

Diese Verträge sind **fertig und implementiert**. Welle 2 baut darauf auf, sie
nicht neu.

### 16.1 Persistenz: `StorageDatabase`

`@all-the.rest/baah-storage` exportiert **eine** Operationsoberfläche, zweimal
gebunden: an SQLite im Worker und an `Map`s in Node. Dadurch sind `seq`-Vergabe,
Upsert-Semantik, Idempotenz und Kaskaden **einmal** implementiert, nicht
zweimal — und die Engine lässt sich vollständig gegen Node testen.

**Unterstützt, identisch in beiden Backends:** `createSession` / `getSession` /
`listSessions` / `deleteSession` (Kaskade auf Nachrichten, Parts, Deltas) ·
`appendMessage` / `getMessage` / `listMessages` (`seq` pro Session automatisch,
`UNIQUE (session_id, seq)` und Fremdschlüssel erzwungen) · `appendPart` /
`upsertPart` / `listParts` (`seq` pro Nachricht; Upsert behält `seq` und
`created_at`) · `flushDelta` (idempotent über `deltaId`, `applied: false` beim
Wiederholen) · `search` (tokenisiertes AND-Matching) · `close`.

**Bewusst nicht unterstützt:**

- `query` / `run` / `transaction` — die In-Memory-Variante hat keine SQL-Engine
  und lehnt mit `code: "unsupported"` **und dem Hinweis auf `openDatabase()`** ab.
- `applyMigrations` — die Maps *sind* das Schema.
- `turns`, `tool_invocations`, `approvals`, `todos`, `workspaces`,
  `file_handles`, `settings`: noch keine typisierte Operation.
  ⇒ **Welle 2 ergänzt jede Operation und ihre In-Memory-Implementierung
  gleichzeitig.**
- FTS5-Treue: `score` ist eine Term-Häufigkeit, nicht `bm25()`; fehlerhafte
  `MATCH`-Ausdrücke verhalten sich anders. Nur Feldmenge und Sortierrichtung
  sind aussagekräftig.

**Was identische Semantik ausdrücklich NICHT bedeutet** (vom Verify-Agenten
gemessen, nicht vermutet):

| Eigenschaft | gleich? | Warum |
|---|---|---|
| `seq`-Vergabe, Kaskaden, Fremdschlüssel, `UNIQUE` | ja | gegen echtes SQLite gemessen |
| Idempotenz von `flushDelta` und `applyMigrations` | ja | gemessen, `changes()` 1 dann 0 |
| **Anzahl** der Treffer bei jedem `limit` | ja | getestet fuer -1, 0, normal, riesig |
| **Reihenfolge** der Treffer | **nein** | FTS5 sortiert nach `bm25()`, die Memory-Engine nach Einfuegung. **Nicht vergleichen** -- ein Test, der gleiche Reihenfolge behauptet, prueft etwas, das kein Backend zusagt. |
| `score`-Werte | nein | Term-Haeufigkeit statt `bm25()` |
| `NaN`/`Infinity` als `limit` | nein | ueber den Draht `invalid_message`, in Memory geklemmt. Beides **laut**, keines eine stille Teilmenge -- und `postMessage` kann kein non-finite uebertragen. |
| `TxResult.changes` bei gemischten Batches | **keine Zeilenzahl** | `sqlite3_changes()` wird von einem SELECT **nicht** zurueckgesetzt; ein Batch Schreiben-dann-Lesen zaehlt die Zeile doppelt. Der ehrliche Kanal ist `results`. |

Test-Harness: `worker.ts` und `client.ts` laufen gegen **echtes** SQLite
(Node-Build derselben WASM-Bibliothek, siehe `AGENTS.md` §2 Ausnahme), nicht
gegen ein Modell. Nur `installOpfsSAHPoolVfs` ist ersetzt. Deshalb sind
CHECK-Verletzungen, Rollback, FTS5 und `changes()`-Buchhaltung **gemessen**.

**Mutationsnachweis** (7 eingebaute Eingriffe, alle 7 toeten jetzt mindestens einen
Test): `isOwnershipFailure`-Zweig loeschen, zod-Validierung im Worker
ueberspringen, Antwort-Huelle im Client nicht parsen, Ergebnis-Validierung je
`kind` ueberspringen, Double-open-Guard entfernen, `nested_transaction`-Guard
entfernen, unbekannten Status zu `active` coerced. Vor der Erweiterung
ueberlebten alle sieben **176 gruene Tests** -- das war die eigentliche Luecke.

**Worker-Protokoll** — jede Anfrage korreliert, **nie** über die Grenze geworfen:

```ts
{ id, kind: "open",       payload: { filename, vfsName?, directory? } }
{ id, kind: "query",      payload: { sql, params?, method: "run"|"all"|"values"|"get" } }
{ id, kind: "run",        payload: { sql, params? } }
{ id, kind: "tx",         payload: { statements: { sql, params? }[] } }   // 1..512
{ id, kind: "search",     payload: { query, sessionId?, limit? } }         // 50, 1..500
{ id, kind: "flushDelta", payload: { deltaId, part, flushedAt } }
{ id, kind: "close",      payload: {} }

{ id, kind, ok: true,  result }
{ id, kind, ok: false, error: { code, message, details } }
```

Fehlercodes: `invalid_message`, `database_owned_by_another_context`,
`database_already_open`, `database_not_open`, `database_closed`, `sql_error`,
`nested_transaction`, `unsupported`, `internal`.

**Einstiegspunkt für die App:** `openDatabase()` / `closeDatabase()` /
`createDrizzleCallback()` — nicht selbst posten, der Client parst jede Antwort
durch zod.

**Bewusste Schema-Abweichungen** (vom Verify-Agenten bestätigt und dokumentiert):

| Abweichung | Grund |
|---|---|
| `messages.outcome` (Spalte) | §6.2 verlangt den Turn-Ausgang auf der `idle`-Nachricht; ohne Spalte kein abfragbares Zuhause. `CHECK` auf `succeeded\|failed\|interrupted` |
| `part_deltas` (Tabelle) | §6.2 nennt das Delta-Log; ohne Tabelle ist `flushDelta` nicht idempotent |
| `todos` mit `UNIQUE (session_id, seq)` | Härtung, im Plan nicht verlangt |
| 11 zusätzliche `CHECK`-Constraints | Härtung; `parts.type IN (text, reasoning, tool)` ist dagegen **vom Plan gefordert** |
| 11 Indizes | §6.1 listet keine; aus dem Hot-Path abgeleitet |

#### Nachtrag: `tool_invocations` nach der Migration 4 (Build-Block W2-A)

`Plan.md` §6.1 nannte für `tool_invocations` weder den Aufrufschlüssel noch den neuen
Status. Beides nachgetragen — **angehängt, nicht überschrieben** (`AGENTS.md` §7.2b).

| Spalte | Zweck |
|---|---|
| `session_id` | Session-Scoping des Kurzschlusses (existierte schon als Spalte) |
| `attempt` | 1-basierter Versuchszähler |
| `tool_call_id` | die Id des Aufrufs, **nicht** die Zeilen-Id |
| `occurrence` | trennt zwei Aufrufe, die dieselbe `toolCallId` tragen |
| `status` | **`begun` \| `done`** — genau zwei Werte |
| `output` | was ein Replay zurückgibt. **Nicht** `result_preview`. |
| `result_preview` | bleibt, für die UI |

```sql
UNIQUE (session_id, attempt, tool_call_id, occurrence)
```

**Spalten, nicht nur Key-Berechnung.** §6.1 ließ die Frage offen („gehören in die
Key-Berechnung des Stores, nicht zwingend in die Tabelle"). Geschlossen, weil ein
Schlüssel, den die Datenbank nicht erzwingen kann, einer ist, über den SQLite und die
In-Memory-Map sich uneinig werden *dürfen* — und genau das war schon zweimal passiert.

**`status` auf zwei Werte verengt.** Es waren sechs (`pending`, `awaiting_approval`,
`running`, `completed`, `failed`, `aborted`) — und **das war das Crash-Fenster**:
`beginToolCall` und `recordToolCall` schrieben in dasselbe Feld, also war „begonnen,
Ausgang unbekannt" nicht darstellbar. §7.5 modelliert eine offene Freigabe über
`approvals.decision IS NULL` und braucht keinen Lifecycle-Wert.

**`recordToolCall` ist ein Upsert, `beginToolCall` ist `DO NOTHING` — asymmetrisch, aus
Grund.** Ein `DO UPDATE` auf `begin` würde ein `done` auf `begun` herabstufen, und der
nächste Replay liefe das Tool noch einmal. Nur ein Insert darf `begun` schreiben. Und
`record` verwirft nichts: das `begin` ist die_write, die verloren gehen *kann*; die
einzige Aussage, die die Engine belegen kann, ist „das Tool hat das zurückgegeben".

#### Migration 4 ist ein **Rebuild** — und dafür braucht es eine SQLite-Falle

Erste Rebuild-Migration im Paket. Ein Rebuild kann `IF NOT EXISTS` nicht tragen;
Idempotenz kommt aus der Transaktion plus `schema_migrations`, **gemessen** (5×
`applyMigrations` auf echtem SQLite: identische Rows, identisches `sqlite_master`,
4 Versionszeilen).

**Die Falle, die beim *Messen* gefunden wurde und beim Lesen nicht:** `DROP TABLE` auf
eine Tabelle, auf die andere zeigen, ist ein implizites `DELETE FROM` — und
`ON DELETE CASCADE` **feuert trotzdem**. `PRAGMA defer_foreign_keys` hilft **nicht**: es
vertreagt die Constraint-*Prüfung*, nicht den Kaskaden, und danach ist nichts mehr zu
prüfen. Ohne Parkplatz-Tabelle hätte die Migration **jede `approvals`-Zeile
stillschweigend gelöscht**.

Die Parkplatz-Tabelle selbst war in der ersten Fassung **zweimal** getötet: erst von
`approvals`, dann von ihrem eigenen kaskadierenden Fremdschlüssel. Beide Varianten sind
als Test festgenagelt. **Wer die nächste schreibt, kopiert nicht die DDL — er liest
diesen Absatz.**

Die Kopie ist absichtlich **verlustbehaftet in die sichere Richtung**: nur `completed` ist
Evidenz für ein Ergebnis, also nur das wird `done`; alles andere wird `begun`. Und
`output` bleibt **NULL** statt `result_preview` — ein gekürzter Präview, der einem Replay
als Antwort des Tools zurückgegeben wird, ist dieselbe Lüge, die die Spalte beseitigt.

Die Migration ist fest an **Version 4** gebunden. Ein späterer Schemaumbau braucht
Version 5, nicht eine neue `CREATE TABLE`-Zeile in Schritt 1.

#### `Workspace.walk` meldet jetzt seine eigene Trunkierung

```ts
export const DEFAULT_MAX_ENTRIES: number;   // 50_000, jetzt exportiert
export interface WalkResult {
  entries: AsyncIterable<DirEntry>;
  truncated: boolean;   // true, wenn ein Eintrag DA war und nicht genommen wurde
  visited: number;
}
walk(directory?, options?): WalkResult;      // synchron, siehe Kommentar im Code
```

`truncated` ist wörtlich umgesetzt: der Cap wird **vor** dem `yield` geprüft. Es ist
also eine Aussage über den **Baum**, nicht über einen Zähler, der zufällig auf der
Grenze landete. **Ein Abbruch ist keine Trunkierung** (der Aufrufer hat ihn ausgelöst,
er weiß es) und ein Baum mit **genau** `maxEntries` ist es auch nicht.

`walkMayBeIncomplete(result, maxEntries?)` wohnt **im Walk**, nicht in den Tools: nur der
Walk kennt **beides**, was die Beurteilung braucht — den angewandten Cap und die
herausgegebene Eintrittszahl. Ein Tool, das eines von beidem neu ableitet, wäre eine
**dritte** Kopie einer Zahl, die zweimal auseinandergelaufen ist.

Die Verzerrung überberichtet **weiter absichtlich**: `visited >= maxEntries ⇒ true`, auch
wenn der Walk fertig war. Ein Modell, dem einmal zu oft „vollständig" gesagt wird, handelt
auf einer Teilsuche.

#### Beschlossen: der `TurnStore`-Adapter gehört in `baah-storage`

`StorageDatabase` erfüllt die vier neuen Methoden bereits strukturell identisch zu
`TurnStore`; `flushDelta` (Signatur), `finishTurn` und `heartbeat` passen **nicht**.
Der Adapter geht **nicht** in `baah-web`: sonst bekommt die Engine einen zweiten Weg in
die Datenbank, und die beiden Wege driften auseinander wie die beiden Klassifikatoren.

#### Was §16.1 jetzt nicht mehr stimmt

§16.1 sagt, für `turns`, `tool_invocations` u. a. gebe es „noch keine typisierte
Operation ⇒ Welle 2 ergänzt jede". Das gilt nicht mehr. Abweichungen, die §16.1 noch
nicht kannte: `tool_call_id`, `attempt`, `occurrence`, `output`, der Wegwerf von
`ToolInvocationStatus`, und `appendTurn` (dazugekommen, weil `listUnfinishedTurns` sonst
nichts zu lesen hatte).

Ein Turn ohne `heartbeat_at` meldet `COALESCE(heartbeat_at, started_at)` — ein Leerstring
parst als „unendlich alt" und würde einen eben erzeugten Turn sofort schließen.


#### Nachtrag: ein **zweiter** Port neben `TurnStore` — der Read-Port

`AGENTS.md` §3.1 verlangt, dass der **Teilttext einen Reload überlebt**. Gemessen war das
erfüllt und trotzdem unbrauchbar: `TurnStore` hatte **keine einzige Lesemethode** — kein
`listParts`, kein `getMessages`, kein `listMessages` — und `recoverStaleTurns` liefert
`UnfinishedTurn[]` mit `turnId`/`heartbeatAt`/`startedAt` und **ohne Text**. Die App konnte
also nach einem Reload sagen, **dass** ein Turn starb, aber nicht, **was er sagte**.

```ts
// packages/baah-storage/src/transcript.ts
read(input: { sessionId: string; turnId?: string; limit?: number }): Promise<Transcript>;
```

`createTurnStore` bleibt **unberührt** und bleibt der **Schreib**-Pfad. Die App
injiziert **zwei** Dinge, nicht einen Gott-Objekt.

**Warum in `baah-storage` und nicht in `baah-core`:** `TurnStore` steht in core, weil
**core es konsumiert**. Niemand konsumiert den Reader — in core wäre er eine tote
Abstraktion (§5).

Drei Entscheidungen, die **gemessen** und nicht geraten sind:

- **Session ist die Pflichthälfte, Turn die Verengung.** Mit einer Turn-Id allein wäre ein
  Cross-Session-Read möglich und *„kein solcher Turn hier"* von *„dieser Turn sagte
  nichts"* **ununterscheidbar** — und die UI rendert das verschieden. Ein genannter Turn
  wird auf Existenz **in dieser Session** geprüft; ein fehlender ist eine Ablehnung.
- **Die Read ist mit dem letzten Flush konsistent, und die Grenze ist exakt.** Die
  Leitlinie im Auftrag war, ein Read könnten einen laufenden Turn „verpassen". **Gemessen
  ist das Gegenteil:** `flushDelta` schreibt den kumulierten Part-Text **in derselben
  Transaktion** wie den Delta-Log-Eintrag, also sind nach drei Flushes das neueste
  `part_deltas.content_text` und `parts.content_text` **derselbe String**. Das Log ist ein
  **Idempotenz-Anker, kein Zwischenlager**. Ein Read verfehlt also nie einen fertigen Part;
  ein laufender ist höchstens `DELTA_FLUSH_INTERVAL_MS` (100 ms) hinten und kommt **mit**
  Text und `status: "streaming"` zurück, damit die UI ihn als in Flug markieren kann.
- **Eine geschlossene DB lehnt mit `database_closed` ab** — und im ganzen Lesepfad steht
  kein `catch`. Aus demselben Grund wird eine unbekannte Session **nicht** als leeres
  Array beantwortet: das wäre die Lüge *„hier war nichts"* in einer Form, die die UI
  anzeigt.

Parts werden **über die Id** gehängt, **nicht** über die Position zippend — ein Zip ist
genau in dem Fall falsch, für den es `truncated` gibt.

**Offen, ehrlich benannt:** der Port ist **nicht** in `baah-web` verdrahtet. Zwei Ports
existieren und sind exportiert; die App nimmt zwei. Das ist der nächste Block. Und die
`Transcript`-Form ist ein **gewähltes** Format — `Plan.md` sagt nichts darüber, welche
Spalten eine Transkript-Ansicht braucht, also sind `model` / `usage` / `parentId`
absichtlich nicht drin. Braucht die UI sie, **bricht es kompiliert** statt still.


### 16.2 Tools: Injektions-Verträge

`todo` und `question` brauchen Zustand bzw. UI, den ein Tool nicht besitzen
darf. Beide werden **vom Erzeuger** hereingereicht:

```ts
// todo — eine Instanz pro Session
const tool = createTodoTool({ store: TodoStore, sessionId });
//   TodoStore = { get(sessionId): MaybePromise<readonly TodoItem[]>;
//                 set(sessionId, todos): MaybePromise<void> }
//   set ist VOLLSTÄNDIGES Ersetzen, kein Merge.
//   sessionId MUSS gesetzt sein — sonst fällt der Key auf "default" und alle
//   Sessions teilen sich eine Liste.
//   NICHT den Default-Export registrieren: die Registry wirft bei doppelter id.

const tool = createQuestionTool({ channel: QuestionChannel });
//   QuestionChannel = { ask(questions): Promise<string[][]> }
//   Antwortvertrag: genau eine Zeile je Frage, in Reihenfolge; leere Zeile =
//   übersprungen. Formabweichung -> ToolError, NICHT still reparieren.
//   Der Channel bekommt das Signal NICHT: er muss seine Karte selbst schließen.
```

### 16.3 Workspaces

`createDirectoryWorkspace(root, { id, label, kind })` bildet ein `Workspace` über
**jeden** `FileSystemDirectoryHandle`; darauf setzen `createOpfsWorkspace` und
`createFileSystemAccessWorkspace` auf. Beide Produktionsvarianten teilen sich
damit denselben Code.

`createFileSystemAccessWorkspace` liefert zusätzlich `ensurePermission(write)`,
`refreshPermission(write)` (die **niemals** promptet) und `describe().writable`,
das **erst nach geklärter Permission** `true` wird.
`PERMISSION_REQUIRES_USER_GESTURE` ist der exportierte Satz für die UI.

### 16.4 Permissions

`permission.ts` liefert `evaluate(rules, resources, grants?)`, `DEFAULT_RULES`,
`createDefaultRules()`, `proposeSavePattern(action, resource)` und
`applyReply(grants, reply, action, resource)`. Die Engine kapselt das gegen ein
schmales `PermissionEngine`-Interface, damit sie nicht von den konkreten
Exportnamen abhängt.

---

## 17. PWA und Ablage — Zielbild und die zwei Schichten

Ergänzt am 2026-09-30, nachdem ein **unabhängiger Prüfer** die Architektur gegen das
PWA-Ziel aus `AGENTS.md` §2a geprüft hat (`HEAD = 1fb9821`, ganze Historie). Vorher
gab es dieses Ziel als **Behauptung in einer Regel, aber als keinen Ort in der
Spezifikation** — ein Verweis aus `AGENTS.md` zeigte auf eine Stelle, die nicht
existierte.

### 17.1 Wo die Daten heute liegen — gemessen, nicht behauptet

| Ort | Was | Lebensdauer |
|---|---|---|
| OPFS `/opfs-sahpool/baah.sqlite3` | **Sessions, Messages, Parts** (SQLite-WASM, `opfs-sahpool`, im Web Worker) | stirbt mit „Website-Daten löschen" |
| `localStorage["baah.session.v1"]` | Session-Zeiger | dito |
| `localStorage["baah.settings.v1"]` | Settings, Theme, Instruktionen, Permissions, **API-Keys** | dito |
| Arbeitsspeicher | **der Workspace selbst** | Reload |
| `baah-settings-<ts>.json` (Download) | **nur Settings** — 0 Sessions, 0 Transcript | manuell |

**„Website-Daten löschen" löscht das restlos, und es gibt keinen Weg, die Daten vorher
herauszuholen.** Ein Gerätewechsel nimmt alles mit. Das ist der praktische Kern von
„Projektordner als Wahrheitsquelle".

### 17.2 Das Zielbild

> **Der Projektordner trägt Sessions und Verlauf. Der Browser trägt den
> Arbeitsspeicher. Kein Server.**

### 17.3 Warum es zwei Schichten sein müssen — und was **nicht** geht

**Nicht möglich: die SQLite-Datei in den Projektordner schreiben.** Zwei Gründe, und
sie sind verschieden — was `AGENTS.md` §2a jetzt mit „Plattform" bzw. „Bibliothek"
markiert:

- **Plattform.** `FileSystemFileHandle.createSyncAccessHandle()` existiert überall, aber
  der File-System-Spec (§2.3.3) weist es außerhalb eines *„bucket file system"* mit
  `InvalidStateError` ab, und ein Bucket-Dateisystem ist genau die OPFS-Wurzel.
- **Bibliothek.** `@sqlite.org/sqlite-wasm` hat **keinen VFS, der ein Handle annimmt**;
  `installOpfsSAHPoolVfs({ directory })` will einen String-Pfad **innerhalb** von OPFS.

**Also wandert die Wahrheitsquelle, nicht die Datei:**

1. **Projektordner = Wahrheitsquelle.** Transcript als Dateien (z. B.
   `.baah/sessions/<id>/…` plus eine Menschenlesbare Zusammenfassung), geschrieben
   über `FileSystemDirectoryHandle.createWritable()`. Portabel, lesbar, versionierbar,
   überlebt das Löschen der Website-Daten.
2. **OPFS/SQLite = Arbeitsspeicher.** Transaktional, und es trägt die Resume- und
   Interrupt-Abfragen (`listUnfinishedTurns`, `closeTurnParts`, `finishTurn`), die auf
   Dateien nicht billig sind.
3. **Abgleich** in beide Richtungen: Schreiben in den Ordner bei jedem Turn-Ende,
   Import beim Öffnen. Ein Konfliktfall wird **benannt**, nicht überschrieben.

### 17.4 Was die PWA-Installation tatsächlich bringt

`Plan.md` §822-824 behauptete, eine installierte PWA behalte die Datei-Freigaben „ohne
erneute Rückfrage". **Diese Behauptung ist widerlegt** — nicht von mir, sondern von der
eigenen Spezifikation an anderer Stelle plus der Chrome-Dokumentation:

> `Plan.md:1129-1131`: „Permission nur per Klick auf den Main Thread. ⇒ Nach jedem
> Kaltstart ein ‚Projekt wieder öffnen'-Button."
>
> Chrome, *Permission persistence*: „The web app can continue to save changes to the
> file without prompting **until all tabs for its origin are closed. Once a tab is
> closed, the site loses all access.**"

**Es gibt damit **keinen** belegten PWA-Gewinn für die Freigabe** — und genau das ist
der Grund, warum die Ordner-Freigabe **nicht** die kritische Eigenschaft des Ziels ist.
Die kritischen Eigenschaften sind: die Daten liegen im Ordner (17.3), die App ist
installierbar und offline lauffähig (Manifest, Service Worker, Icons — **alle drei
fehlen**, `dist/` enthält **null** Bilddateien).

Ob es in Chromium eine installationsgebundene Berechtigungslogik gibt, ist **nicht
gemessen** und wird hier **nicht behauptet**. Es ist ein **offenes Gate**: eine
manuelle Messung auf einem echten Gerät (installieren, schließen, öffnen,
`queryPermission({mode:"readwrite"})`).

### 17.5 `storage.persist()` — der Schutz sitzt auf einem Pfad, den niemand geht

`Plan.md` §1136-1138 begründet `storage.persist()` damit, dass OPFS per Default
best-effort ist und Safari skript-erzeugte Daten nach 7 Tagen ohne Interaktion löscht.
Gemessen: `storage.persist()` steht in `baah-core/src/workspace/opfs.ts` — und
**diese Funktion wird von der App nie gerufen**. Für die **Datenbank**, die in OPFS
liegt, wird der Schutz **nie** angefragt.

### 17.6 Reihenfolge, und was zuerst kommt

| # | Block | Schwere | Kosten |
|---|---|---|---|
| 1 | `queryPermission` bei Kaltstart, Ordner wirklich öffnen (`showDirectoryPicker` **im Onboarding**, `createFileSystemAccessWorkspace` **in der Composition Root**, `workspaceMode` aus dem echten Workspace, `onOpen` verdrahten) | high | der schwierige Teil ist der Kaltstart, nicht der Picker |
| 2 | `storage.persist()` für die Datenbank + sichtbarer Zustand | medium | eine Zeile plus UI |
| 3 | Manifest, Icons, `theme-color`, Service Worker mit Precache der 16 `dist/`-Dateien | critical (fehlt komplett) | ~1 Tag |
| 4 | Transcript-Export über `showSaveFilePicker` (`createTranscriptReader` existiert bereits) | high | Voraussetzung dafür, dass ein Browser-Speicher je eine Wahrheitsquelle sein darf |
| 5 | Zwei-Schichten-Ablage (17.3) | high | der eigentliche Zielbau |
| 6 | `dist/assets/worker-*.ts` — **20 738 Byte untranspiliertes TypeScript** werden ausgeliefert und referenziert | medium | vor Block 3, sonst wird der Precache mit Müll gebaut |

**Und was manuell bleibt und darum **kein** Befund ist:** installierte PWA auf echtem
Gerät · Reload nach Kaltstart · überlebt die Ordner-Freigabe · `storage.persist()` in
einem echten Browser · „Website-Daten löschen", Deinstallation, Gerätewechsel · zweiter
Tab gegen `opfs-sahpool` (der Code markiert das selbst als `UNVERIFIED`,
`errors.ts:126-130`).

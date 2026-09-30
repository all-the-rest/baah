# AGENTS.md — Regeln für `baah`

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
  - Pfad-Arithmetik: eigene Utility in `@all-the.rest/baah-core` (POSIX-Semantik, `/`-separiert),
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
- `@all-the.rest/baah-core` muss **Node-frei** sein und in einem Web Worker laufen können.
  Neue Core-Module dürfen keine DOM-Annahmen machen, wo es vermeidbar ist
  (damit sie in Worker + Vitest laufen).

**Einzige Ausnahme — Test-Harness, nicht Laufzeit:** Ein Test darf den
**Node-Build** einer WASM-Bibliothek importieren, wenn dieselbe Bibliothek im
Browser läuft. Konkret: `packages/baah-storage/test/harness/sqlite.ts` importiert
`@sqlite.org/sqlite-wasm` über dessen `exports.node`-Eintrag, damit die
Worker-Tests gegen **echtes** SQLite laufen statt gegen ein Modell davon.

Bedingungen, alle drei:

1. **Nur im Test-Baum.** Nichts unter `src/` eines Package darf das tun.
2. **Nichts davon wird ausgeliefert** — kein Import aus `src/`, kein Bundling.
3. **Die Ausnahme wird im Bericht des Build-Agenten genannt**, damit sie
   sichtbar bleibt und nicht zur Gewohnheit verkommt.

### 2a. Das Ziel ist eine **PWA**, und Dateizugriff wie Speicherung laufen **ausschließlich** über Browser-APIs

§2 sagt, was verboten ist. Dieser Abschnitt sagt, **was stattdessen wahr sein muss** —
denn ein Verbot ohne Anforderung wird erfüllt, indem man die Hälfte wegbaut.

**Ziel:** eine statische, **installierbare, offline lauffähige Web-App** (PWA), deren
**Projektordner** (per File System Access API gewählt) die **Wahrheitsquelle** für
Sessions und Verlauf ist. Kein Server — zu keinem Zeitpunkt, für nichts.

**Drei Regeln, jede mit einem Befehl:**

1. **Dateizugriff** nur über die File System Access API
   (`showDirectoryPicker`, `FileSystemFileHandle.createWritable`) oder OPFS
   (`navigator.storage.getDirectory`).
2. **Speicherung** nur über Browser-Speicher: Local Storage, Session Storage,
   IndexedDB, Cache Storage, OPFS.
3. **Die Session-Datenbank liegt im Browser.** Heute: SQLite-WASM als
   `opfs-sahpool` in einem Web Worker (`baah-storage`). Das ist eine
   **Plattformgrenze**, keine Designentscheidung: `opfs-sahpool` braucht einen
   `FileSystemSyncAccessHandle`, und den gibt es **nur in OPFS**. Ein per
   `showDirectoryPicker()` gewählter Ordner liefert nur `createWritable()`, also
   einen Schreibstrom ohne Zufallszugriff. **SQLite lässt sich dort nicht öffnen.**
   Wer das ändern will, muss die *Wahrheitsquelle* verlagern, nicht die Datei
   hinschreiben — siehe `Plan.md` zur Zwei-Schichten-Ablage.

**Vollzug, nicht Notiz:**

```bash
pnpm check:browser-only     # Teil von `pnpm check` und eigenes CI-Step
```

`scripts/browser-only.ts` prüft **zwei** Hälften, und beide sind nötig:

- **verboten** — keine Node-Builtins, keine Serverform, kein eigener Socket in
  `src/` (das ist der Teil, der wie eine Regel aussieht);
- **erforderlich** — die fünf Browser-Fähigkeiten, die das Projekt *definiert*
  (FSAA, OPFS, Browser-Datenbank, Datenbank neben dem Hauptthread, Web-Storage)
  müssen **tatsächlich benutzt** werden.

Die zweite Hälfte ist die, die die Anforderung trägt. Eine servergestützte
Ablage besteht die erste Hälfte **vollkommen** und fällt an der zweiten durch.
Ein Gate, das nur verbietet, ist **halb** ein Gate: Löscht man die Persistenz,
läuft es grün durch, weil nichts Verbotenes importiert wurde.

⚠️ **Zwei Fallen, die beim Schreiben dieses Gates real passiert sind** — beide in
`scripts/browser-only.ts` dokumentiert:

- **Ein Import-Specifier ist immer ein String-Literal.** Ein Gate, das Strings
  blankt (wie `no-console` es für `console.log` zu Recht tut), ist für `node:fs`
  **vollständig blind**. Specifier-Regeln lesen darum den **Rohsource**, verankert
  an einer Import-Position (`from "…"`, `import "…"`, `import(…)`, `require(…)`).
- **Ein Muster muss der Wirklichkeit entsprechen, wie der Code es schreibt.** Die
  erste Fassung verlangte `navigator.storage.getDirectory()`, der Code ruft
  `storage.getDirectory()` auf einer lokalen Variablen auf — das Gate meldete eine
  Fähigkeit als fehlend, die es gibt. **Ein Gate, das bei *Abwesenheit* lügt, wird
  genauso ignoriert wie eines, das bei *Verstößen* lügt.**

Selbsttest mit **gepflanztem Material** in
`packages/baah-web/test/browser-only.test.ts`, beide Hälften: ein Quellensatz ganz
ohne Browser-Fähigkeit muss **alle fünf** als fehlend melden.

### 2b. Die Einhaltung wird **unabhängig** geprüft, über einen Commit-Range

`pnpm check:browser-only` beweist, dass **kein** Server in `src/` steht. Es beweist
**nicht**, dass die PWA-Regeln aus 2a eingehalten werden — die meisten davon sind
Eigenschaften des *ausgelieferten* Artefakts, nicht des Quelltexts.

**Deshalb: nach jeder Implementierungs-Welle und vor jedem Release prüft ein
Subagent in einer eigenen Session** den Bereich

```bash
git log --oneline <letzter-prüf-commit>..HEAD
```

und berichtet mit Schweregrad, Datei:Zeile und **Messwert**. **Regel wie bei Build
und Verify (§7.2): derselbe Agent darf seine eigene Arbeit nie prüfen.** Der
Prüf-Commit wird am Bericht genannt, damit der nächste Lauf ihn als `HEAD`
übernehmen kann. Beim ersten Lauf ist der Range **alles**.

Was ein Quelltext-Gate **nicht** abdeckt und was darum **manuell** bleibt
(und als offenes Gate zu benennen ist, nicht als Befund): installierte PWA auf
einem echten Gerät, Reload, überlebt die Verzeichnis-Freigabe, funktioniert
offline, überlebt „Website-Daten löschen" das, was es überleben soll.

Warum das erlaubt ist: Es ist derselbe SQLite-Compiler, nur anders geladen. Der
Test prüft damit die **SQL-Semantik**, die auch im Browser gilt — ein Fake hätte
genau die Properties geprüft, die der Fake selbst definiert. Die
*Browser*-Eigenheiten (OPFS, `FileSystemSyncAccessHandle`, VFS-Eigentum) bleiben
unberührt und weiterhin nur manuell beweisbar (`Plan.md` §15).

## 3. Stack (gesetzt)

| Bereich | Wahl |
|---|---|
| Package-Manager | **pnpm** (Workspace, `pnpm-workspace.yaml`) |
| Sprache | **TypeScript** (strict, `tsconfig.base.json`) |
| UI | **React 19** + **Vite** (SPA) |
| Styling | **Tailwind CSS v4** + **daisyUI v5** (Theme `dark` als Default) |
| LLM-Layer | **Vercel AI SDK** (`ai` + `@ai-sdk/react`) |
| Validierung | **zod** an allen externen Grenzen |
| Tests | **vitest** (Unit, `@all-the.rest/baah-core`), Playwright für E2E (ab Phase 4) |

Versionen werden **nicht geraten**: vor dem Hinzufügen einer Dependency die
aktuelle Version prüfen (`npm view <pkg> version`) und im jeweiligen
`package.json` eintragen. Downgrades/Upgrades einzelner Kernpakete gehören in
die Commit-Message.

## 3.1 AI SDK — verbindliche Konventionen (v7)

Wir schreiben **AI SDK v7** (`ai@7.x`, `@ai-sdk/react@4.x`). Die v6-Namen sind
teils noch Aliase, werden aber **nicht** verwendet:

| Nicht verwenden (v6) | Verwenden (v7) |
|---|---|
| `onFinish` | `onEnd` |
| `onStepFinish` | `onStepEnd` |
| `stepCountIs` | `isStepCount` |
| `fullStream` | `stream` |
| `experimental_telemetry` | `telemetry` |
| `needsApproval` (am Tool) | `toolApproval` (am Agent/Call) |
| `addToolResult` | `addToolOutput` |
| `system` | `instructions` |
| `experimental_context` | `context` / `runtimeContext` |

Weitere Regeln:

- **Loop nicht selbst bauen.** `ToolLoopAgent` + `DirectChatTransport` laufen
  in-process im Browser. Der Agent-Loop ist **kein** Eigenbau.
- **`UIMessage[]` ist der Speicher-Wahrheitsanspruch**, nicht `ModelMessage[]`.
  `ModelMessage[]` wird pro Request aus den UIMessages berechnet.
- **Kein `@ai-sdk/rsc`** (RSC-only). Kein `pipeUIMessageStreamToResponse`
  (braucht Node `ServerResponse`).
- **Telemetrie explizit aus:** `telemetry: { isEnabled: false }`.
- **Keys explizit übergeben** — im Browser gibt es keinen `process.env`-Fallback.
- **Anthropic** braucht `headers: { "anthropic-dangerous-direct-browser-access": "true" }`;
  das SDK setzt den Header **nicht** selbst.
- **Resume ist unmöglich.** `reconnectToStream()` liefert immer `null`. Unfertige
  Turns werden als `interrupted` markiert und per `regenerate` wiederholt —
  niemals „fortsetzen" versprechen.
- **Checkpoints per `onStepEnd`**, nicht erst am Turn-Ende.
- **Tool-Idempotenz beim Replay:** ausgeführte `toolCallId`s persistieren und
  kurzschließen, sonst wirkt ein Tool beim Wiederholen doppelt.
- **Kein Provider-Proxy.** Ein Provider, der CORS nicht erlaubt, ist nicht
  unterstützt (§2).

## 4. Repo-Layout

```
packages/baah-web/         React-SPA (UI, Onboarding, Transcript, Settings)
  src/                     UI-Code
packages/baah-core/        Harness-Engine: Agent-Loop, Tool-Registry,
                           Workspace-Abstraktion. Node-frei, worker-tauglich,
                           unit-getestet.
packages/baah-storage/     Persistenz: SQLite-WASM im Web Worker, Schema,
                           Migrationen, Drizzle-Zugriff.
packages/baah-tools/<id>/  EIN Package pro Tool ("read", "grep", "edit", …).
Plan.md                    Spezifikation (Ziel, Architektur, Phasen)
AGENTS.md                  diese Regeln
```

- **Schichtregel:** `baah-web` → `baah-tools/*` + `baah-storage` → `baah-core`.
  Abhängigkeiten zeigen **nie** zurück. `core` kennt weder React noch DOM-UI,
  noch die konkreten Tools, noch `baah-storage`.
- **Ein Tool = ein Package.** Konvention:
  - Verzeichnis `packages/baah-tools/<id>/`, Paketname `@all-the.rest/baah-tool-<id>`.
  - `src/index.ts` exportiert die Definition als benannten Export
    (`export const readTool`) **und** als `default`.
  - Das Tool ist ein `ToolDefinition` aus `@all-the.rest/baah-core` (`defineTool({...})`):
    `id`, `description`, `access`, `inputSchema` (zod), `execute`.
  - `inputSchema` ist die **einzige** Quelle der Parameter-Wahrheit — sie geht
    an das Modell (AI SDK) *und* an die Validierung. Kein zweites Schema.
  - Eigene Tests unter `test/<id>.test.ts`, immer gegen
    `createMemoryWorkspace()` aus `@all-the.rest/baah-core` — **kein** Browser und kein DOM
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
- Neue Engine-Logik in `@all-the.rest/baah-core` braucht Unit-Tests (vitest). Ein Feature
  ohne Test ist nicht fertig.
- „Fertig“ heißt: Befehl ausgeführt und Ausgabe gesehen — **nicht** „sollte
  laufen“. Ergebnisse immer mit dem tatsächlichen Output belegen.
- Browser-Verhalten (File System Access API, OPFS, IndexedDB) kann nicht per
  Unit-Test bewiesen werden ⇒ dafür ein manuelles Prüfskript/Schrittliste in
  `Plan.md` §9 pflegen und im PR/Commit referenzieren.

## 7. Orchestrierung, Wellen & Subagenten

Der Haupt-Agent ist **Orchestrator**, nicht Implementierer größerer Teile.

### 7.1 Wellen

Die Umsetzung läuft in **Wellen**. Jede Welle hat ein klares Fertig-Kriterium
und wird erst verifiziert abgeschlossen, bevor die nächste beginnt.

| Welle | Inhalt | Fertig, wenn |
|---|---|---|
| **0** | Fundament, Recherche, Rename, Veröffentlichung | ✅ erledigt |
| **1** | Persistenz (`baah-storage`), Workspace-Implementierungen, Tier-1-Suche (`glob`/`grep`), Tier-2-Basis (`todo`/`question`) | Tests grün, Workspace-Implementierungen erfüllen `Workspace`, Schemata migrierbar |
| **2** | Agent-Loop, Onboarding, Transcript, Tool-/Approval-Karten, Settings, Export/Import | Durchlauf 0 → Chat im Browser |
| **3** | E2E (Playwright, gefälschte OpenAI-kompatible Antworten) + UI-Verifikation | E2E grün, Screenshots geprüft, Befunde behoben |
| **4** | `shell`, `git`, `task`/Subagent, `webfetch`, Service-Worker-Infrastruktur, `AGENTS.md`-Injektion | jeweils mit Tests |

Regeln für Wellen:

- **Welle 1 endet mit einem unabhängigen Verify-Subagenten**, bevor Welle 2
  startet. Kein „wird schon passen".
- Welle 1 wird **parallel** gebaut, aber nur mit **disjunkten Dateibesitzern**.
  Der Orchestrator legt vorher alle `package.json` an und installiert **einmal** —
  parallele `pnpm install`-Läufe zerstreiten am Lockfile.

### 7.2 Build und Verify sind getrennte Subagenten

Für **jeden Aufgabenblock** einer Welle:

1. **Build-Subagent** bekommt: Ziel, die exakt zugewiesenen Dateien,
   Akzeptanzkriterien, die relevanten `AGENTS.md`-Regeln, den Verifikationsbefehl.
   Er committet **nicht**.
2. **Verify-Subagent** — **eigene Session, nie dieselbe wie Build** — prüft gegen
   dieselben Akzeptanzkriterien: Tests ausführen, Code lesen, Grenzfälle suchen,
   Regelverstöße melden, eigene Probe-Tests schreiben und wieder löschen.
3. Der Orchestrator behebt die Befunde, committet und meldet.

**Regel:** Ein Subagent darf seine eigene Arbeit nie verifizieren.

### 7.2a Commit-Disziplin bei laufenden Agenten

Während Build-Subagenten schreiben, gilt im Repo:

- **Kein `git add -A` und kein `git commit` des Orchestrators**, solange
  mindestens ein Build-Subagent aktiv ist. Sonst landen seine
  Zwischenstände in einem Doku-Commit — passiert in Welle 1 und hat zwei
  Commits unlesbar gemacht.
- **Commit immer über explizite Pfade**, nie über den Arbeitsbaum:
  `git add packages/baah-storage/…` statt `git add -A`. Pfade, die ein
  **aktiver** Agent besitzt, werden ausgelassen — sie gehören nicht in diesen
  Commit, auch nicht teilweise.
- Der Orchestrator committet **erst nach der Verify-Session** eines Blocks und
  committet dann **genau die Dateien dieses Blocks**, nicht den Arbeitsbaum.
- Falsch aufgenommene Dateien werden **nicht** per History-Rewrite repariert,
  wenn schon gepusht wurde. Der Orchestrator benennt die Vermischung im
  Commit-Hinweis und zieht die Dateien beim nächsten Block-Commit nach.
- Faustregel vor jedem Orchestrator-Commit: `git status --short` muss genau
  die Dateien zeigen, die der aktuelle Commit enthalten soll.
- **Ein `package.json`-Commit enthaelt die Lockfile-Aenderung mit**, die ihn
  verursacht hat. `pnpm install --frozen-lockfile` prueft das in CI, und **der
  erste Push dieser Sitzung ist daran gescheitert**:
  `ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE`, weil der gepushte Lockfile
  keinen `importers:`-Block hatte — ein gefiltertes `pnpm install` schreibt ihn
  halb. **Vor dem Push pruefen:** `git status --short pnpm-lock.yaml` muss leer
  sein, und `pnpm install --frozen-lockfile` muss lokal durchlaufen.
  *Lokal gruen sagt nichts:* der Fehler faellt nur dort auf, wo der Lockfile
  unvollstaendig ist — lokal war er es nicht, weil die Arbeitskopie die
  vollstaendige war und nur nicht committet.

### 7.2b Append-only-Dateien werden nie mit `write` überschrieben

`Plan.md` und `AGENTS.md` sind **wachsende Spezifikationen**. Sie werden
ausschließlich **ergänzt**, nie ersetzt.

- **Verboten:** ein Write-Tool auf eine dieser Dateien, um einen neuen
  Abschnitt anzuhängen. `write` **ersetzt** den gesamten Inhalt.
- **Richtig:** `edit` mit einem eindeutigen Anker am Ende der Datei, oder
  `cat >> datei <<'EOF' … EOF`.
- **Nach jedem Schreibvorgang gegenprüfen:** `wc -l` gegen den Wert **vor** dem
  Schreiben. Sinkt die Zeilenzahl, wurde Inhalt zerstört.
- Passiert es trotzdem: `git show <letzter-guter-commit>:<datei> > <datei>` und
  die Ergänzungen erneut anhängen. Deshalb wird `Plan.md` in **jeder** Session
  mit voller Historie committet, nicht erst am Ende.

> **Vorfall in Welle 1 (2026-09-29):** `Plan.md` hatte 1.220 Zeilen. Ein
> `write`-Aufruf, der nur den neuen Abschnitt §15 enthalten sollte, hat die
> Datei auf 78 Zeilen reduziert — und ein zweiter auf 116. Die Spec §§6–14 waren
> weg, **während ein Build-Agent gegen §6.1 programmierte**. Aufgefallen ist es
> erst durch den Verify-Agenten, der die Diffs gegen §6.1 nicht fand und
> nachfragte. Wiederhergestellt aus `d02a2c3` und um §15/§16 ergänzt.
>
> **Lehre:** Ein Subagent, der „ein Dokument liest, das es nicht gibt",
> fällt nicht auf, sondern erfindet. Die Verifikation muss nicht nur den Code
> prüfen, sondern auch, ob die Spezifikation, gegen die geprüft wird,
> überhaupt noch existiert.

Subagenten bekommen **nicht** die ganze `Plan.md`, sondern den relevanten
Ausschnitt + Regeln — sonst arbeiten sie am Ziel vorbei.

### 7.3 Fortschritt melden

Der Orchestrator meldet **am Ende jeder Welle** und bei jedem Abschluss eines
Aufgabenblocks zwei getrennte Zahlen:

| Kennzahl | Bedeutung | Frage, die sie beantwortet |
|---|---|---|
| **Completion %** | Fertigstellung | Wie viel des Ziels aus `Plan.md` §1 (DoD) ist gebaut und verifiziert? |
| **Change %** | Planstabilität | Wie viel des ursprünglichen Plans wurde durch die Arbeit revidiert — neue Entscheidungen, verworfene Annahmen, verschobener Scope? |

**Regel:** Beide Zahlen werden **geschätzt, aber begründet** — mit den Werten pro
Welle und den konkreten Entscheidungen, aus denen die Change-% abgeleitet sind.
Eine Zahl ohne Begründung ist wertlos; `Completion` ohne `Change` verdeckt,
wie viel Plan unterwegs neu erfunden wurde.

## 7.4 Arbeitsliste

[`agents.todo.md`](agents.todo.md) ist die **Arbeitsliste** und hat Vorrang vor
jedem neuen Plan. Beim Start einer Welle wird sie gelesen und die Punkte der
Welle abgearbeitet; danach wird dort abgehakt, mit Commit-Referenz.

Verhältnis der drei Dateien:

| Datei | Rolle | Wann schreiben |
|---|---|---|
| `Plan.md` | **Was** — Spezifikation, Architektur, Recherche | wenn sich eine Entscheidung ändert |
| `AGENTS.md` | **Wie** — verbindliche Regeln | wenn eine Regel falsch war oder fehlte |
| `agents.todo.md` | **Jetzt** — offene konkrete Punkte | nach **jeder** erledigten Einheit |

Eine erledigte Einheit wird **hier** abgehakt und nicht in `AGENTS.md`.

### 6a TS 7 (`typescript@7.0.2`, der native Port) — zwei Fallen

Gemessen in dieser Sitzung, nicht aus der Doku. Beide kosten einen Zyklus, wenn man sie
nicht kennt.

**1. `--noExplicitAny` existiert nicht.**

```
$ ./node_modules/.bin/tsc --noEmit --noExplicitAny
error TS5023: Unknown compiler option '--noExplicitAny'.
$ ./node_modules/.bin/tsc --all | grep -i explicit     # nichts
```

Die Flag ist **absent**, nicht nur ungesetzt. „Flag in `tsconfig.base.json` eintragen" ist
hier ein Fehler, keine Lösung. Die nächste Compiler-Antwort wäre eine Lint-Regel = neue
Dependency + neue Config-Fläche (§3). Wer `AGENTS.md` §5 („`any` ist verboten") durchsetzen
will, muss den **Quelltext-Gate** nehmen:
`packages/baah-core/test/no-explicit-any.test.ts` liest `src/**` und `test/**` über Vites
`import.meta.glob(..., { query: "?raw" })` (kein `node:fs`, §2), streicht Kommentare und
String-Literale und sucht danach. Er hat **drei** Tests: der Glob liest wirklich Quellen,
null Treffer, und ein **Selbsttest mit gepflanztem Material** — ohne den letzten würde ein
kaputter Scanner alle anderen bestehen.

Bekannte Grenzen, im Doc-Kopf der Datei und nicht versteckt: er ist **regex-basiert, kein
Parser**. `${…}`-Interpolation gilt ihm als String, und ein Regex-Literal mit einem
Quote-Zeichen würde den String-Scan früh beenden.

**Es gibt inzwischen fünf Source-Gates, nicht einen.** `no-explicit-any` (nur
`baah-core`), `no-bare-void` und `no-console` (je in `baah-core` **und** `baah-storage`).
Der Kommentar-/String-Stripper ist deshalb **viermal dupliziert**, weil §4 einem Paket
verbietet, aus dem Testbaum des anderen zu importieren. Das ist eine **Folge der
Schichtregel**, in jeder Datei benannt statt wegworkaroundet. `no-bare-void` scannt in
beiden Paketen nur `src/` und verfehlt **zeilenübergreifende Operanden** in `test/`.

**Warum es Gates braucht:** `AGENTS.md` §5s „kein `console.error`" hatte **null**
Vollzug. Die Mutation, die auf die Konsole schrieb, starb nur, weil vier Tests zufällig
der Event-Stream lasen — die Variante, die **verhaltensrichtig *und* auf die Konsole
schreibt**, tötet ausschließlich das Gate.

**Und die Lehre aus der dritten Fundstelle:** eine Quelltext-Assertion, die ein
**whitespace-empfindliches** Muster zählt, hört auf zu greifen, sobald der Aufruf
umformatiert wird. `verify-replay-window.test.ts:511` zählte
`/store\.heartbeat\(/g` und wurde still zu einem No-Op, als der Aufruf auf zwei Zeilen
umgebrochen wurde. → **Jedes Gate braucht einen Selbsttest mit gepflanztem Material.**

Gemessen: bei 3 von 4 `any`-Mutationen war `tsc` **sauber** und die gesamte Verhaltens-Suite
grün. Der Gate ist damit nicht Kosmetik, sondern der einzige Vollzug dieser Regel.

**2. Ein Backtick-Paar über zwei `//`-Zeilen gescannt falsch.**

Ein `//`-Kommentar mit einem **unbalancierten** Backtick auf einer Zeile schluckt die
nächste als Template-Literal und erzeugt eine Kaskade von ~30 falschen `TS1005`-Fehlern.
Kein Hinweis auf die wahre Ursache. **Regel: einen in Backticks gesetzten Span auf **eine**
Zeile legen.**

## 8. Git

- Kleine, thematische Commits; ein Commit = eine logische Änderung.
- `main` bleibt lauffähig (# = pnpm typecheck && pnpm testgrün).
- `node_modules/`, `dist/`, Testartefakte sind gitignored — nie committen.
- Kein `git push` ohne ausdrückliche Anweisung des Nutzers.

## 9. Umgang mit Unsicherheit

- Nichts erfinden: API-Formen (AI SDK, File System Access API, Provider-CORS)
  werden gegen die Doku oder lokalen Quellcode verifiziert, nicht aus dem
  Gedächtnis behauptet. Unverifiziertes wird als `UNVERIFIED` markiert.
- Wenn eine Anforderung mit §2 (Browser-only) kollidiert: **melden**, nicht
  heimlich einen Server einbauen.

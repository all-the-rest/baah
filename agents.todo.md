# agents.todo.md — offene Punkte für `baah`

**So wird diese Datei benutzt**

- Jeder Punkt ist **konkret**: wo, was, und **woran** erkennbar ist, dass er fertig
  ist. „Fertig" heißt: Ausgabe gesehen, nicht Code gelesen.
- Nach erledigter Arbeit wird der Punkt **hier abgehakt** — nicht in `AGENTS.md`.
  `AGENTS.md` sind Regeln, `Plan.md` ist die Spezifikation, diese Datei ist die
  Arbeitsliste.
- Erledigte Punkte wandern nach unten in „Abgehakt" mit Commit-Referenz. Die
  Liste wächst, wenn etwas dazukommt, und wird **nicht** gelöscht.
- Ein Punkt, der nur durch einen Test grün ist, aber nicht im Browser geprüft
  wurde, bekommt den Vermerk `[manuell offen]` und bleibt offen.
- Blockiert ein Punkt andere, steht das dabei. Ein Blocker ohne Folge ist kein
  Blocker.

**Legende:** `[ ]` offen · `[~]` in Arbeit · `[x]` fertig · `[!]` Blocker

---

## Welle 1 — Fundament (abschließen)

- [x] **Repo, pnpm-Workspace, TS strict, React/Vite/Tailwind/daisyUI** — `471f07d`
- [x] **Recherche: Dateizugriff, Browser-DB, Vorbild-Interna, AI SDK, Shell/Suche** — `Plan.md` §14
- [x] **Rename auf `baah` / `@all-the.rest`** — `1dc13dd`
- [x] **Publikation als öffentliches Repo** — https://github.com/all-the-rest/baah
- [x] **Tool `read`** — `a8f0d8f`, 8 Tests
- [x] **Tools `write`, `edit`, `list`** — `f719328`, 24 Tests
- [x] **Tools `todo`, `question`** — 28 Tests, Injektions-Verträge in `Plan.md` §16.2
- [x] **Tools `glob`, `grep`** — `766c0f7`, 47 Tests
- [x] **Workspaces (OPFS, File System Access) + Permission-Engine** — `917f223`, 87 Tests
- [x] **Persistenz `baah-storage`** (Schema, Migrationen, Worker-RPC, Memory-Backend) — `fa7fb6e`, 270 Tests
- [x] **Verify: `glob`/`grep`** — abgeschlossen. 12 Mutationen, **2 überlebten** (M1, M7).
      3 Defekte habe ich **persönlich nachgemessen** und bestätigt (siehe unten).
- [!] **Verify: Workspaces + Permission** — **bewusst zurückgestellt.** Der Block
      liegt in `packages/baah-core`, wo der Engine-Agent gerade schreibt. Ein
      `pnpm test` im Core-Paket würde dessen halbfertige Tests mitlaufen lassen;
      der Verify-Bericht zeigte dann Fremdfehler. Nach dem Engine-Block.
- [x] **Verify: `todo`/`question`** — abgeschlossen. **Meine Ausgangsfrage war falsch**
      (siehe Korrekturen weiter unten); trotzdem 5 Defekte + 9 Mutationslücken gefunden.
- [~] **Agent-Engine** (`ToolLoopAgent`, Classification, Backoff, Approval) — Build-Agent läuft.
      `stream/classify.ts` + `stream/backoff.ts` stehen, `agent/*` + `provider/*` fehlen.
- [ ] **Verify: Agent-Engine** — eigener Verify-Agent, danach Mutationstest. **offen**
      **Hängt an der Reihenfolge:** Core-Paket, gleiche Paketgrenze wie oben.

## Welle 2 — Engine verdrahten + Oberfläche

- [ ] **Tool-Registry befüllen**: alle 8 Tools in eine Registry, eine Instanz pro Session
- [ ] **Engine ↔ Storage verdrahten**: `onStepEnd` → `flushDelta`, Turn-Ende → `idle`-Nachricht
- [ ] **Reload-Recovery**: Turns mit `status = 'streaming'` und altem Heartbeat beim Start auf `interrupted` setzen, Teilttext behalten
- [ ] **Tool-Idempotenz**: ausgeführte `toolCallId`s persistieren, beim Replay kurzschließen
- [ ] **Provider-Registry**: OpenAI, Anthropic (mit `anthropic-dangerous-direct-browser-access`), Google, OpenAI-kompatibel
- [ ] **Modellkatalog** via `@opencode-ai/models` **lazy** laden (Snapshot ist 6,35 MB)
- [ ] **Stream-Detektor** anbinden: Chunk-Signatur messen, `buffered` pro `provider+baseURL` merken
- [ ] **Retry mit Backoff** anbinden: 0 s / 2 s / 8 s, ±25 % Jitter, `Retry-After` gewinnt, max. 3 Versuche
- [ ] **Approval-Cards** an `toolApproval` anbinden (`once` / `always` / `reject`)
- [ ] **Onboarding-Wizard**: Provider → Key (+ Verbindungstest) → Modell → Workspace
- [ ] **Chat-UI**: Transcript, Tool-Karten, Reasoning, Diff-Vorschau, Stop-Knopf
- [ ] **Todo-Sidebar** aus `todo`-Store
- [ ] **Settings** inkl. Modellwechsel zur Laufzeit
- [ ] **Settings-Export/Import** (Keys standardmäßig ausgeschlossen)
- [ ] **Session-Export** als Markdown und JSON
- [ ] **Streaming-Hinweis**, wenn Antworten am Stück ankommen

## Welle 3 — E2E und Verifikation im Browser

- [~] **GitHub Actions** (Quality + E2E auf jedem Push) — Build-Agent läuft
- [~] **E2E-Harness mit gefälschten OpenAI-Antworten** — Build-Agent läuft
- [ ] **E2E-Szenarien** aus `Plan.md` §15.6 vollständig abdecken
- [ ] **UI-Review** (Screenshots + Vision-Analyse) — Skill `ui-review`
- [ ] **Befunde aus dem UI-Review beheben**, nicht nur protokollieren
- [ ] **Manuelle Browser-Prüfung** `Plan.md` §15.1–15.4 abarbeiten

## Welle 4 — Ausbau

- [ ] **`shell`** (`just-bash`) auf der `Workspace`-Abstraktion, mit Kommando-Allow-Liste
- [ ] **`git`** (`isomorphic-git`): `status`, `log`, `diff`, `commit`, `branch` — **ohne** Remotes
- [ ] **`task`/Subagent** mit eigenem Kontext, `subagent_depth` default 1, Background-Modus
- [ ] **`webfetch`** mit ehrlicher CORS-Meldung
- [ ] **`skill`** (Markdown aus `.baah/skills/*.md`)
- [ ] **`AGENTS.md`-Injektion** beim Workspace-Connect
- [ ] **`patch`** (Mehr-Hunk)
- [ ] **Service-Worker**: Offline-Shell, Single-Writer, PWA-Manifest
- [ ] **MCP-Spike** (nur `type: "remote"`)

## Offen aus der Verifikation `todo`/`question` — 22 Mutationen, 9 überlebten

Befunde mit `file:line` stehen im Verifier-Report. Hier nur, was **noch zu tun** ist.

- [ ] **`MIN_OPTIONS = 2` lehnt eine Form ab, die das Vorbild selbst benutzt.**
      OpenCode v2.0.19 hat **kein** Minimum auf `options`, und dessen eigener Test
      fährt eine **Ein-Option**-Frage. Unsere Fixture umging das, indem sie immer
      zwei Optionen schrieb. → Fix-Agent läuft (F1).
- [ ] **`dismissed` und `skipped` sind für das Modell nicht unterscheidbar.**
      Das Vorbild hat dafür ein typisiertes `CancelledError`. **Meine Spec-Zeile
      `Plan.md:1400-1401` ist hier falsch** — sie kollabiert beide zu
      leere Zeile = übersprungen. Korrigiere ich selbst, aber **erst nach dem
      Landen des Fix-Agenten** (siehe unten). → Fix-Agent läuft (F2).
- [ ] **`option.label`-Beschreibung ohne Längen-Konvention** — (1-5 words, concise)
      ist Teil des Vertrags, nicht Dekoration. → Fix-Agent läuft (F3).
- [ ] **README begründet `access: "read"` falsch** — die Begründung stimmt nicht mehr,
      die Entscheidung ist trotzdem richtig. → Fix-Agent läuft (F4).
- [ ] **9 Mutationslücken in den ursprünglichen 28 Tests** — u. a. `MAX_CONTENT_LENGTH`
      ungetestet, `get()` lieferte live das interne Array, `await` auf `store.set()`
      war nicht beweisbar (der Test nutzte einen Store, der sofort auflöst), ein
      **nie abgehängter** Abort-Listener unter einem Test, der behauptet, das zu prüfen.
      15 neue `characterisation.test.ts` schließen sie. **Nicht wieder löschen.**

## Schnittstellen-Lücken, die der Core-Agent jetzt bekommt

- [!] **`ToolContext` hat keine Call-Identität** (`core/src/tool.ts:27-34`) — damit ist
      `AGENTS.md:126-127` / `Plan.md:1054-1055` (toolCallId persistieren und
      kurzschließen) **nicht umsetzbar**, nicht nur unbequem. Der schlimme Fall ist
      nicht `question` (doppelte Karte), sondern **`todo`**: `set` ist ein vollständiges
      Ersetzen, ein Replay trägt die veraltete Liste und **überschreibt eine inzwischen
      vom User gemachte Sidebar-Änderung** — und meldet dabei `changed: true`. Das ist
      ein **verlorener Update, der sich als echter Update ausgibt**. → Core-Agent.
- [!] **`todo` hat keine Permission-Action** — `Action` kennt `"question"`, aber nicht
      `"todo"`, also fällt es auf `{action:"edit", resource: undefined}` zurück. Folge:
      **ein User kann keine einzige Regel schreiben, die Todo-Schreibvorgänge
      kontrolliert** — kein `ask`, kein `deny`, nie. Braucht `Action` + `Plan.md` §7.2
      Zeile. → Core-Agent, exklusiv dafür freigegeben.

## Korrekturen an meiner eigenen Planung

- **Falsch gefragt:** Ich gab dem Verify-Agent die Hypothese mit, `todo`/`question` seien
  vielleicht keine Callable-Tools, sondern injizierter Text. **Falsch.** `question`
  existiert in v2.0.19 als echtes Tool (`packages/core/src/tool/plugin/question.ts`), ein
  `todo`-Tool gibt es dort **gar nicht** — `Plan.md:123` und `Plan.md:975` sagen genau
  das und nennen unseres eine eigene Zutat. Die zod-`ToolDefinition`-Form ist richtig.
  Die Prüfung hat trotzdem etwas gebracht — sie fand den `MIN_OPTIONS`-Fehler.
- **Folge für künftige Verifikationen:** meine Hypothese war plausibel genug, dass ich
  sie als Auftrag formuliert habe, statt sie als Frage zu stellen. Eine Hypothese, die
  ich nicht belegen kann, gehört in den Bericht als **Frage**, nicht in den Auftrag.
- **Dieselbe Lektion wie bei Plan.md:** ein Verify-Agent, der die Spec gegen den Code
  prüft, muss auch prüfen, ob die Spec die Behauptung überhaupt trägt. Zwei der
  wichtigsten Funde dieser Runde entstanden genau dort.

## Harte Anforderungen an Welle 2 (aus der Verifikation, nicht im Code lösbar)

Diese Punkte stehen hier, weil sie sonst verschwinden. Kein grüner Test im Tool-Paket
kann sie schließen — sie sind Rendering- und Vertrauensfragen.

- [ ] **`question`: Antworten sind nicht vertrauenswürdig.** Sie landen ungeframed im
      Modellkontext, während derselbe Page den API-Key hält. Das strukturierte
      `{answers[][]}` ist **besser** als das Vorbild (das in einen quoted Satz splisset,
      den ein Anführungszeichen in der Antwort sprengt) — aber Wave 2 **muss** die
      Antwort eindeutig abgrenzen. Nicht implementiert, nur dokumentiert.
- [ ] **`todo`: Zeilen haben keine Provenienz.** Ein Angreifer-Text aus einer
      `README.md` wird zur Sidebar-Zeile mit Status `completed` — das vertrauenswürdigste
      Element der UI, es liest sich wie bereits erledigte Arbeit. Die Liste fließt beim
      nächsten `todo`-Aufruf **zurück** in den Modellkontext: klassisches
      Stored-Persistence-Muster, ein zweiter Biss. Wave 2 muss untrusted content
      unterscheidbar rendern.
- [ ] **`todo` gibt die ganze Liste als Tool-Output zurück** (~20 k Zeichen an den
      Maxima, kumuliert pro Schritt). Offene Entscheidung: Diff statt Vollliste.
- [ ] **Scratch-Dateien im Baum**: `baah-core/probe-scratch.ts`, `probe2.ts`,
      `tsconfig.probe.json` — gehören einem aktiven Agenten, **nicht committen**,
      beim Landen aufräumen. `.gitignore` um `probe*.ts` ergänzen.

---

## `grep-wasm` fliegt raus — Entscheidung des Orchestrators

Begründung aus **gemessenen** Fakten, nicht aus Prinzip:

- **Kein Codepfad, in dem ripgrep etwas kann, was der JS-Scanner nicht kann.** Das
  `grep`-Schema bietet kein `-v`, `-c`, `-m`, `-A/-B/-C`, `-o`, kein Multiline, keine
  Binärsuche. Sechs Parameter, **null** davon eine ripgrep-Fähigkeit. Was ripgrep
  kauft, ist Geschwindigkeit — und der Tool deckelt sich selbst bei 16 MB.
- **Die beiden Engines sind nicht gleichwertig.** `\p{L}+` liefert auf WASM 6 Treffer,
  auf JS 0. Lookaround und Backreferences werden von einer Engine abgelehnt und von der
  anderen akzeptiert. Der Fallback ist eine **andere, schwächere Query-Sprache**.
- **`grep-wasm` hat in diesem Projekt nie ausgeführt** — kein einziges Mal, in keinem
  der 96 Tests. Der Browser-Pfad ist nicht nur unverifiziert, sondern **falsch per
  Default**: `init()` bekommt kein Argument, die Binary-URL leitet sich aus der
  Modul-URL ab, und `vite.config.ts` setzt **kein `base`** → bei einem Sub-Path
  landet der Fetch auf der Domain-Wurzel und 404t.
- **1,8 MB Binary, die in drei ungetesteten Dimensionen stimmen müssen**, um nichts zu
  liefern, was das Tool überhaupt anbietet.
- Die einzige Doku dieses Vertrags ist ein Kommentar in `vite.config.ts:19`, der auf
  **zwei nicht existierende READMEs** zeigt (von mir geprüft: beide fehlen).

**Bleibt:** die Naht. Wenn ripgrep zurückkommt, dann als **opt-in Accelerator** mit
Äquivalenztest gegen den JS-Scanner — nicht als unverifizierter Default.

- [ ] **Toten `optimizeDeps.exclude: ["grep-wasm"]` in `vite.config.ts` entfernen.**
      Datei gehört dem CI-Agenten. **Nach dessen Landung**, nicht vorher.

## Aus der Verifikation `glob`/`grep` — 3 Defekte selbst nachgemessen

- [!] **Die Suche kann den Tab unbegrenzt blockieren. Höchster Schweregrad.**
      `grep/src/index.ts:157-161`: `RegExpSearchInput` hat **kein `signal`**, der Scanner
      ist ein synchrones Backtracking-`RegExp.test` pro Zeile, **ohne Timeout**. Gemessen
      auf dieser Maschine, `(a+)+$` gegen `"a"×N + "b"`:
      **N=24 → 281 ms · N=26 → 1,1 s · N=28 → 4,6 s** — verdoppelt je 2 Zeichen.
      Und der Docstring `:161-171` behauptet, der Fallback existiere *weil* eine schlechte
      Dialekt-Auswahl ein Ausfallrisiko sei — er **ist** selbst das unbegrenzte.
      Das Vorbild begrenzt das mit `DEFAULT_SEARCH_TIMEOUT_MS = 30_000`. → Fix-Agent läuft.
- [!] **Eine gekappte Suche meldet sich als vollständig.**
      `core/src/workspace.ts:214` kappt `walk` bei `maxEntries ?? 50_000`, und **keines
      der beiden Tools meldet das**. Bei 50 051 Dateien, wo nur die alphabetisch letzte
      die Nadel enthält, liefert `grep` `total: 0`, `matches: []`,
      **`searchTruncated: false`**, `truncated: false` und den Hinweis
      *No line matches … Widen `path` …*. Das Tool behauptet vollständiges Wissen,
      ohne jemals nachgesehen zu haben. `glob` genauso: `total: 50000` als Trefferzahl
      bei 50 051 existierenden Dateien.
      **Braucht eine Kern-Änderung, die mir nicht gehört:** `Workspace.walk` muss eine
      Kappungs-Flagge zurückgeben. Der Fix-Agent liefert mir die exakte Signatur.
- [ ] **`bytesRead` überschreitet den `maxBytes`, den es selbst meldet.**
      `:442-444` prüft das Budget *vor* jedem Read, also wird die überstehende Datei
      voll gelesen. Gemessen: `bytesRead = 17.510.495` bei `maxBytes = 16.777.216` —
      **das Ergebnis widerspricht sich selbst.** → Fix-Agent läuft.

## Weitere Defekte aus der Verifikation (Fix-Agent läuft)

- [ ] **Ein übersprungener Riesendatei erzeugt einen aktive falschen Hinweis** — der
      Hinweis nennt `path`/`include`/`literal`, **keines davon** würde eine Datei finden,
      die wegen >1 MiB übersprungen wurde.
- [ ] **`grep` kann keine Hidden Files durchsuchen.** Das Vorbild setzt `--hidden`
      **unbedingt** (`ripgrep.ts:221`), wir haben kein `includeHidden`. Ein Harness, der
      `.github/workflows/*.yml` nicht greppen kann, fehlt einem Agenten viel.
- [ ] **Schema-Abweichungen zu v2.0.19**: `limit` hat bei uns ein erfundenes
      `.max(1000)` ohne Gegenstück (Vorbild: kein Maximum) — ein Modell mit
      `limit: 5000` bekommt hier einen Validierungsfehler und dort Ergebnisse.
      `glob.pattern` und `grep.include` haben bei uns ein `.min(1)`, wo das Vorbild keins
      hat; das bleibt **bewusst**, mit dokumentiertem Grund statt stillschweigend.
- [ ] **Der `include`-Konverter ist gut und bleibt.** 26 Muster gleich zu echtem
      picomatch, und `globToSource`s `(?:[^/]+/)*` für `**/` ist der klassische
      Off-by-one und **richtig**. Seine Abweichungen gehen alle in die Richtung
      *matched still nichts*: `!`-Negation, Extglobs, POSIX-Klassen, `{a}`, `a\*b.ts`.
      Der Scope ist bewusst und vertretbar — **nicht vertretbar ist, dass nicht
      unterstützte Syntax ein leeres Ergebnis liefert, ununterscheidbar von „nichts
      gefunden"**, und dass das Modell nie erfährt, welche Syntax unterstützt ist.
- [ ] **Zwei Tests behaupten mehr, als sie prüfen**: `grep.test.ts:253` („das Ergebnis
      entspricht der JS-Engine") belegt `fallback == fallback`, weil das wasm nie lädt —
      es *liest sich* wie ein Äquivalenzbeweis und ist keiner. `:269` („meldet, welche
      Engine lief") ist `expect([...]).toContain(engine)` — eine Tautologie.
- [ ] **Zwei tote Tests in `glob.test.ts`**: `> is a read-only tool` wiederholt
      `access: "read"` aus der Quelle, `> sorts deterministically` bescheinigt etwas, das
      `src` schon `localeCompare`d.
- [ ] **Zwei fehlende READMEs**, auf die `vite.config.ts:19` zeigt.

## Was der Verifier richtig gemacht hat, das ich notiere

Der `include`-Konverter war der Punkt, an dem ich einen Bug erwartet habe — handgeschriebene
Glob-Konverter sind, wo die Fehler wohnen. Stattdessen: **26 Muster gleich zu echtem
picomatch**, gemessen gegen die installierte Bibliothek statt geraten, inklusive aller
Fälle, die ich genannt hatte. Und beim Entfernen von `grep-wasm`: es war die
**entscheidende** Beobachtung, dass kein einziger Schemaparameter eine ripgrep-Fähigkeit
abbildet. Das ist die Art Argument, die eine Abhängigkeit killt — nicht „0.1.0 hat nur
einen Maintainer".

---

## Nur manuell beweisbar
## Nur manuell beweisbar
## Nur manuell beweisbar — `Plan.md` §15

Diese Punkte bleiben offen, bis jemand in einem echten Browser zusieht. Kein
grüner Test schließt sie.

- [ ] **W1–W8**: echter Ordner in-place, Permission nach Reload, `glob`/`grep` auf echtem Repo
- [ ] **S1–S4**: Sandbox-Modus, `persist()`, Export, Safari-Eviction nach 7 Tagen
- [ ] **T1–T7**: Streaming, Netz-Ausfall, 200-mit-Fehler-JSON, 429, 401, langes Reasoning
- [ ] **D1–D4**: Persistenz über Reload, zwei Tabs, FTS5-Suche, Quota
- [ ] **grep-wasm im Browser**: der WASM-Pfad lief noch nie — in Node blockiert durch
      extensionless Imports und `fetch(file:)` (siehe Commit `766c0f7`)
- [ ] **`sqlite-wasm` im Browser**: VFS-Aufnahme, `.wasm`-Auflösung über Vite, zweiter Tab scheitert

## Bekannte offene Punkte aus Reviews

- [ ] **Worker-/`client.ts`-Tests für `baah-storage` waren 0** — behoben in `fa7fb6e`,
      Mutationstest 7/7 getötet. **Bei jedem neuen Block gilt derselbe Maßstab:**
      ein Block gilt erst als fertig, wenn mindestens eine Mutation, die genau
      seine Kernzusage kaputt macht, einen Test umwirft.
- [ ] **`memory-coverage.test.ts` war eine Tautologie** — behoben in `fa7fb6e`.
      Die Zusage in `Plan.md` §16.1 ist nachgezogen.
- [ ] **`Plan.md` wurde von mir zerstört** (1220 → 78 Zeilen) — behoben in `ac51cc6`.
      Regel in `AGENTS.md` §7.2b.
- [ ] **`TxResult.changes` ist bei gemischten Batches keine Zeilenzahl** — dokumentiert,
      aber die Engine darf sich nicht darauf verlassen.

---

## Abgehakt

*(nach unten wandern, mit Commit-Referenz)*

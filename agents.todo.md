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
- [x] **Fix: `todo`/`question`** — F1–F4 behoben, 43 → 65 Tests (21 todo / 44 question),
      **30 Mutationen, 0 überlebt** (Rekonstruktion, siehe Lehre 4).
      ⚠️ **Commit wartet auf den Engine-Block:** Core hat `toolCallId`/`attempt` auf
      `ToolContext` gesetzt (uncommittet, 24 Zeilen in `tool.ts`). Die Tests hier brauchen
      die Felder, ein Commit jetzt wäre also ein **roter `main`** (§8). Erst nach Core.
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

- [x] **`MIN_OPTIONS = 2` lehnt eine Form ab, die das Vorbild selbst benutzt.**
      → `MIN_OPTIONS = 1`, Begründung als Kommentar. `0` bleibt verboten (dann gibt es
      nichts zu fragen). Der Konstante folgten **zwei modellseitige Strings**, deshalb
      blieb ihr Name. **Mutant Q06 (zurück auf 2) tötet 3 Tests.**
- [x] **`dismissed` und `skipped` sind für das Modell nicht unterscheidbar.**
      → Dismissal ist jetzt ein **typisierter Fehler** (`QuestionCancelledError extends
      ToolError`), Überspringen bleibt eine leere Zeile. Die **Werte** unterscheiden
      sich, nicht das Timing. **9 Tests.**
- [ ] **`Plan.md:1400-1401` korrigieren** — meine Spec-Zeile kollabiert dismissed und
      skipped zu leere Zeile = übersprungen. **Das ist falsch**, wie oben belegt.
      Bleibt bei mir, aber **erst nach dem Commit des Fix-Blocks** (siehe Welle-1-Liste).
- [x] **`option.label`-Beschreibung ohne Längen-Konvention** — wortgleich mit dem
      Vorbild wiederhergestellt, mit Kommentar: Vertragstext, geht in das
      modellseitige JSON-Schema, wird **behauptet**. Getestet über `z.toJSONSchema()`,
      nicht gegen die Konstante — eine Konstante würde der Umformulierung folgen.
- [x] **README begründet `access: "read"` falsch** — Begründung durch den tatsächlichen
      Codepfad aus `approval.ts` ersetzt, `approval.ts` als *in flight* markiert. Die
      Entscheidung (`read`) bleibt, und zwar mit tragfähiger Begründung.
- [x] **9 Mutationslücken geschlossen** — 15 `characterisation.test.ts` vom Verifier,
      dazu `contract.test.ts` vom Fix-Agent. **Nicht wieder löschen.**

## Lehren aus dem `todo`/`question`-Fix — beide gehen in künftige Aufträge ein

**1. Ein Test, der seine Erwartung aus der Konstante unter Prüfung ableitet, beweist nichts.**
Der alte Grenzwert-Test las seine Grenzen aus `MIN_OPTIONS`. Als der Wert von 2 auf 1
geändert wurde, **folgte der Test der Änderung und blieb grün** — er hatte die Änderung
nie geprüft. Die neuen Tests behaupten deshalb **Literale** (1 parst, 0 nicht, 8 parst,
9 nicht) statt die Konstante zu spiegeln.
→ **Regel für jeden Auftrag:** Test-Erwartungen müssen **Literale** sein, keine Spiegel der
Implementierung. Sonst misst der Test die Konsistenz des Codes mit sich selbst.

**2. Zwei Überlebende im ersten Durchlauf waren beide echte Löcher.**
- **T09:** das README verspricht, dass ein werfendes `onChange` als Tool-Fehler auftaucht
  (`AGENTS.md` §5, keine stillen Catches) — **nichts prüfte das.** Ein `try/catch` um die
  Benachrichtigung hätte eine kaputte Sidebar als stillen Erfolg verkauft.
- **N01:** `isQuestionDismissed` lieferte `false` für den typisierten Fehler und **überlebte**,
  weil die Default-Nachricht zufällig das englische Wort *dismiss* enthält und der
  Regex-Fallback sie abfing. Ein Kanal, der `new QuestionCancelledError("user pressed
  ESC")` wirft, wäre falsch gemappt worden.
→ **Regel:** Ein Mutant, der nur durch *einen* Zufall stirbt, ist nicht getötet. Der zweite
Weg muss den Test ebenfalls töten.

**3. Der Fix-Agent fand einen Defekt in seiner eigenen Lösung.** Die erste Fassung von F2 gab
`QuestionCancelledError` unverändert über den `instanceof ToolError`-Zweig zurück, also
bekam das Modell bei `new QuestionCancelledError("user pressed ESC")` genau den String
`user pressed ESC` — **ohne Anweisung, ohne dont-ask-again**. Ein unbestätigter Zweig genau
der Art, vor der ich gewarnt hatte, und gefunden von einem **neuen** Test, nicht vom Review.

**4. Ehrliche Einschränkung, die der Agent selbst genannt hat:** die 22-Mutationsliste des
Verificators war **nicht in seinem Auftrag**. Er hat eine Menge rekonstruiert, die alle 10 in
meinem Bericht genannten Mutationen enthält, plus weitere. „30 angewandt, 0 überlebt" ist
also **seine** Rekonstruktion, kein 1:1-Nachlauf. Zwei Mutationen waren im ersten Lauf
`NOT-APPLIED`, weil sein Refactoring die Anker verschoben hatte; er hat es genannt, die
Anker korrigiert und neu gelaufen.

**5. Meine Entscheidung zur Text-Erkennung — angenommen, mit Auflagen.** Der Fix-Agent hat
bewusst **auch** per Text auf dismissed geprüft, nicht nur per `instanceof`. Ich hatte
Text-Sniffing auf Fehler skeptisch gesehen. Die Begründung hat mich überzeugt: `instanceof`
greift nicht über einen Kanal, der gegen das Vorbild geschrieben wurde und unsere Klasse nie
importiert hat — und der Ausfall ist still und schlecht, weil ein Dismissal dann zu *„The
question could not be answered … Assume nobody can reply right now"* verkommt, was dem
Modell sagt, **die UI sei kaputt**. Genau die Verwechslung, die F2 beseitigen soll.
Auflage: der Text-Pfad ist ein **dokumentierter Migrationspfad** und darf ausschließlich
einen Fehler *spezifischer* machen, niemals die Antwort berühren.

---

## Schnittstellen-Lücken, die der Core-Agent jetzt bekommt

- [!] **`ToolContext` hat keine Call-Identität** (`core/src/tool.ts:27-34`) — damit ist
      `AGENTS.md:126-127` / `Plan.md:1054-1055` (toolCallId persistieren und
      kurzschließen) **nicht umsetzbar**, nicht nur unbequem. Der schlimme Fall ist
      nicht `question` (doppelte Karte), sondern **`todo`**: `set` ist ein vollständiges
      Ersetzen, ein Replay trägt die veraltete Liste und **überschreibt eine inzwischen
      vom User gemachte Sidebar-Änderung** — und meldet dabei `changed: true`. Das ist
      ein **verlorener Update, der sich als echter Update ausgibt**. → Core-Agent.
- [x] **`todo` hat keine Permission-Action** — Core hat `"todo"` in die `Action`-Union
      aufgenommen (`permission.ts:57`) und `todo: {action:"todo", resource: () => "*"}`
      gesetzt (`approval.ts:132`). **Jetzt kann ein User Regeln schreiben.**
      ⚠️ **Die Resource muss die Konstante `"*"` sein** und darf **nicht** aus dem Input
      gelesen werden: eine aus `content` abgeleitete Resource ließe jede Regel gegen einen
      vom Angreifer kontrollierten String matchen. Und `"*"` statt `undefined`, weil
      `createRuleEnginePermissionEngine` eine leere Liste zu `["*"]` macht, eine engere
      Default-Policy aber nicht.

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
- [ ] **`todo`-Kosten entscheiden.** **Meine Entscheidung: Vollliste als *Input* bleibt.**
      Der Fix-Agent hat gemessen, wo die Kosten wirklich sitzen: das `todos`-**Input** des
      Modells ist so groß wie das Resultat, und bei einem 20-Schritte-Turn wird die Liste
      **20-mal** übertragen. Ein Diff-**Resultat** spart ~35 %, ein Diff-**Input** ~75 % —
      zerstört aber *vollständiges Ersetzen, kein stilles Verschwinden*, die eigentliche
      Sicherheitseigenschaft des Tools. Ein fehlerhaftes Delta ließe Aufgaben
      stillschweigend fallen, also genau der Fehlermodus, den das aktuelle Design vermeiden soll.
      **Billige Variante, die ich nehme:** Vollliste bei `changed: true`, bei einem
      No-op-Aufruf nur `{changed, completedCount}`. Heute schickt ein No-op die ganze Liste
      für nichts. → Welle-2-Batch, kein eigener Agent.
      Betroffen: `todo.test.ts` „stores the list and reports the resulting state" und
      „reports a stable result shape" (beide `toEqual` bzw. `Object.keys`), außerdem
      „replaces the whole list", „keeps sessions apart" und der Default-Instanz-Test.
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

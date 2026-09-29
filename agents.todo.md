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
- [~] **Verify: `glob`/`grep`** — Verify-Agent läuft. Prüft u. a., ob der
      grep-wasm-Pfad im Bundle überhaupt eine plausible URL auflöst und ob der
      JS-Fallback wirklich *gleichwertig* durch dasselbe Entry-Point läuft.
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

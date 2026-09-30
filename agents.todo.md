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

## Stand (30.09.2026) — die Liste darunter ist ein Log, nicht mehr die Queue

**Gemessen, nicht geschätzt:**

```
core     570 Tests   storage 457   web 396/397   E2E 44 (0 skipped)
11 Pakete, alle typisieren. 35 Commits, UNGEPUSHT — die CI ist nie gelaufen.
```

| Welle | Stand |
|---|---|
| **0** Fundament, Recherche, Repo | ✅ |
| **1** Storage, Workspaces, Rechte, Suche, Basis-Tools | ✅ gebaut **und** verifiziert (jeder Block mit 12–31 Mutationen) |
| **2** Engine, Runtime, Oberfläche | ✅ gebaut · Verifikation: 3 Blöcke grün, 2 Agenten laufen (Core-Leak, Web-Löschung) |
| **3** E2E, UI-Review | E2E ✅ 8/8 Szenarien · **UI-Review noch offen** — die Oberfläche existiert jetzt, also ist es endlich sinnvoll |
| **4** `shell`, `git`, `task`, `webfetch`, `skill`, Service-Worker | **offen** — kein einziges dieser Tools existiert |

### Kritischer Pfad, in dieser Reihenfolge

1. **W2-K und W2-L landen** → Baum wird grün → **`git push`** (35 Commits). Erst dann läuft
   die CI zum ersten Mal, und **das ist ein offenes Gate, kein erledigter Punkt**: der
   Workflow ist gelesen und per YAML geparst, aber nie ausgeführt. `AGENTS.md` §8 verlangt
   für den Push eine ausdrückliche Anweisung — **die habe ich noch nicht.**
2. **Wave 3: UI-Review.** Screenshots + Vision-Analyse der *echten* Oberfläche, dann die
   Befunde beheben, nicht nur protokollieren. Erster Blick auf etwas, das ein Mensch
   benutzen würde.
3. **Wave 4: die fehlenden Tools.** `Plan.md` §4 verspricht `shell`, `git`, `task` und
   `webfetch`; **keines davon ist gebaut.** Das ist die größte einzelne Lücke zwischen
   Spezifikation und Wirklichkeit.

### Was ich als Orchestrator falsch gemacht habe — zum Nachlesen

- **Eine unbewiesene Hypothese als Auftrag formuliert.** „`todo`/`question` sind vielleicht
  keine Callable-Tools" — falsch, und ich hatte es als Instruktion gegeben statt als Frage.
- **Ein Feld gefeiert, ohne zu fragen, ob es überall vorkommt.** `rawFinishReason` fehlt auf
  dem OpenAI-Responses-Pfad; **jeder** erfolgreiche Turn las sich als Trunkierung. Ein
  *besseres* Signal ist nicht ein Signal, das überall existiert.
- **Aus gekürzter Ausgabe geschlossen.** Ich meldete „alle Tool-Pakete sauber" aus einer
  `head -20`-gekürzten Pipe. Drei Pakete waren rot, `main` war rot, ein Subagent fand es.
- **Die sicherere Vorgabe war falsch.** „Abwesenheit ist kein Beweis für Trunkierung" hätte
  §5.4s Verdict ersatzlos gestrichen. Es galt, sie auszuprobieren statt sie zu akzeptieren.
- **Zweimal einen Agenten ohne Antwort enden lassen.** Bei ~5700 Zeilen eigener Arbeit gibt
  er nichts Berichtetes zurück — und Tests ohne jemanden, der sagt, was sie prüfen, sind
  Hoffnung. Regel: **fehlender Bericht = Block unverifiziert**, Zustand messen.

### Muster, die sich in dieser Sitzung wiederholt haben

| Muster | Wo |
|---|---|
| Ein Test, der eine Eigenschaft **behauptet, die er nicht prüft** | `removeEventListener` · `get()`-Kopie · `MAX_CONTENT_LENGTH` · `b\pm t\d+\$` · `console`-Gate |
| Ein Messgerät, das **lügt statt zu schweigen** | 7 Überlebende in 403 · Wrapper-Restore · `&&` nach Fehlschlag · `sed` ohne Match |
| Eine **Mutation, die keine Mutation ist** | `lastFlushAt.clear()` nach der Schleife · `text-start` außerhalb der Union |
| Ein **grüner Lauf, der nichts beweist** | Fake deckte die *richtige* Ecke des Fehlers ab (Responses-Pfad) |
| Ein Agent, der **sich selbst korrigiert** — die häufigste und beste Form | 6× in dieser Sitzung |


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
- [x] **Agent-Engine** — `0f068cc`, 323 Tests. `ToolLoopAgent` + `DirectChatTransport`,
      `ToolContext` mit `toolCallId`/`attempt`, `todo` als eigene Permission-Action.
- [x] **Verify: Agent-Engine** — abgeschlossen. **20 Befunde**, 81 neue Tests → **404**.
      Der wichtigste ist eine **Architektur-Lüge**, keine Bug: siehe „Engine: was der
      Verify-Agent umgeworfen hat".
- [~] **Fix: Agent-Engine** — Fix-Agent läuft. Drei Schnittstellen-Entscheidungen sind
      gefallen (D1/D2/D3 unten), der Rest ist als Bugliste durchnummeriert.

## Welle 2 — Engine verdrahten + Oberfläche

**Blockaufteilung mit disjunkten Pfadbesitzern.** Reihenfolge ist erzwungen, nicht
gewählt: A muss landen, bevor B den Store bauen kann, und B braucht `package.json`,
das gerade ein anderer Agent hält.

| Block | Besitz | Status |
|---|---|---|
| **A** — `Workspace.walk`-Vertrag + Storage-Implementierung der neuen Engine-Verträge + Core-Barrel | `baah-core/{workspace*,index.ts,test}`, `baah-storage/**`, `baah-tools/{glob,grep}/**` | ✅ `dbbb62d`, 869 → **969 Tests** |
| **B** — Runtime-Layer in `baah-web` ohne UI: Settings-Store, Provider-Verdrahtung, Tool-Registry, `flushDelta`-Aufrufstelle, 20-s-Watchdog | `baah-web/src/{runtime,state,providers,lib}/**` | ⏸ wartet auf A **und** auf den CI-Agenten |
| **C** — React-UI: Onboarding, Transcript, Tool-/Approval-Karten, Diff-Vorschau, Todo-Sidebar, Settings, Export/Import | `baah-web/src/{components,App.tsx}` | ⏸ wartet auf B |

**Warum B wartet, obwohl A und B disjunkt wären:** B braucht neue Dependencies
(`baah-core`, `baah-storage`, die Tool-Pakete, `ai`, `@ai-sdk/react`) in
`packages/baah-web/package.json` **und** den Lockfile. Der CI-Agent schreibt gerade in
beide. Zwei Agenten auf einem Lockfile zerschießen ihn, und ein zerstörtes Lockfile
kostet mehr als eine Welle Verzögerung. → **B startet, wenn der CI-Agent gelandet ist.**

**Ein Loch, das allen Blocken im Weg lag:** `baah-core/src/index.ts` exportierte
`agent`, `provider` und `stream` **nicht** — Welle 2 konnte die Engine gar nicht
konsumieren. Block A fixt es.

- [!] **B braucht noch einen Entscheid von mir — den habe ich gefällt, er steht in B:**
      der **`TurnStore`-Adapter gehört in `baah-storage`**, nicht in `baah-web`. Sonst
      bekommt die Engine einen zweiten Weg in die Datenbank, und die beiden Wege driften
      auseinander wie die beiden Klassifikatoren es getan haben.
- [ ] **Tool-Registry befüllen**: alle 8 Tools in eine Registry, eine Instanz pro Session
- [x] **Engine ↔ Storage verdrahten**: `onStepEnd` → `flushDelta`, Turn-Ende → `idle`-Nachricht.
      ⚠️ **`flushDelta` wird vom Loop bis heute nicht aufgerufen** — die Aufrufstelle ist
      **Block B**, nicht die Engine. Wie `onProgress` liegt sie an der Naht fuer die App.
- [~] **Reload-Recovery**: `listUnfinishedTurns` existiert, `STALE_HEARTBEAT_MS` und
      `recoverStaleTurns` sind implementiert und **beidseitig getestet** (30 s: `>=` ist
      stale). Offen bleibt der **Aufruf beim Start** — das ist Block B.
- [x] **Tool-Idempotenz**: `tool_invocations.status` ist `begun | done`, der
      **Vier-Teil-Schlüssel** ist `UNIQUE` in der Tabelle (nicht nur in der Arithmetik des
      Stores), `beginToolCall` ist `DO NOTHING` und `recordToolCall` ein Upsert.
      `begun`-ohne-`done` wird als **Ergebnis unbekannt** gemeldet, weder neu ausgeführt
      noch still übersprungen.
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
- [~] **CI-Erstlauf war rot, Ursache gefunden und behoben.** `ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE`
      in **beiden** Jobs, vor dem ersten Test: der gepushte Lockfile hatte keinen
      `importers:`-Block. Ein gefiltertes `pnpm install` schreibt ihn halb. Regel in
      `AGENTS.md` §7.2a. → `3dc00da`. **Zweiter Lauf läuft.**
- [ ] **E2E sharden / Docker-Image — gemessen beantwortet: beides noch nicht.** Siehe
      „CI-Laufzeiten" unten.

### CI-Laufzeiten — was die Zeit frisst, ist nicht die Testanzahl

| | |
|---|---|
| E2E-Suite | **44 Tests, 1,6 min** lokal, Chromium, 1 Worker |
| Doppelte Arbeit | `quality` **und** `e2e` machen beide `checkout` + `install` + `build` |
| Parallelität | die zwei Jobs haben `needs: []` — sie laufen **nebeneinander** |

**Sharding: nein.** 44 Tests auf Shards zu verteilen, deren jeder Checkout, `pnpm install`
und Browser-Install braucht, macht den Lauf **langsamer** — der Overhead pro Shard ist
Minuten, die Arbeit ist 1,6 Minuten. Die nützliche Form von Sharding — Jobs laufen
nebeneinander — ist **schon da**. **Auslöser zum Neudenken: >200 Tests oder >10 min.**

**Docker-Image: nein für die App** (`AGENTS.md` §2, es gibt keinen Server zu containerisieren;
die E2E serviert ein statisches `dist`), **ja möglicherweise für die Toolchain** — aber
`actions/cache` deckt den Browser schon ab, und das **Systembibliotheken-Desaster dieser
Sitzung** (20 Bibliotheken mitten im Lauf verschwunden) zeigte: der Cache gehört dem Host,
nicht einem Image.

**Die Optimierung, die sich lohnt, ist keine der beiden:** `quality` und `e2e` bauen
dasselbe. **Einen** dieser Builds einzusparen ist der Hebel. ⚠️ `dist` zu cachen ist fragil;
die saubere Form ist ein gemeinsamer Build-Job mit `upload-artifact`.

⚠️ **Dieser Eintrag hat noch keinen echten Messpunkt:** der erste Lauf starb an der
Installation, der zweite war zum Schreiben nicht durch. **Nach dem zweiten Lauf mit echten
Zeiten statt mit Schätzungen ausfüllen.**



## Anforderung: Anthropic-förmige Endpunkte **und** Modellliste von beiden

Vom Nutzer gefordert. Zwei Punkte, die **ein** Block sind, weil 3 an 1 hängt.

### Was heute fehlt — und es ist nicht „ein Vendor"

`ProviderVendor` hat genau **einen** erweiterbaren Schlitz:

```ts
export type ProviderVendor = "openai" | "anthropic" | "google" | "openai-compatible";
//                                                                 ↑ Chat-Completions-Dialekt
```

`parseVendorId` kennt nur `openai-compatible:<label>`. Es gibt **kein**
`anthropic-compatible:<label>`.

**Die Falle, die eine naive Lösung verdeckt:** `baseUrl` gibt es bereits auch für die
eingebauten Vendors, also *sieht* es so aus, als sei es getan. Aber **Anthropic und OpenAI
sprechen verschiedene Drahtformate** — `/v1/messages` gegen `/v1/chat/completions`. Ein
Anthropic-förmiger Dienst auf eigener `baseURL` lässt sich heute **nur** als
`openai-compatible` eintragen, und das sendet die **falsche Anfrage**: kein Fehler, den der
User sieht, sondern ein stilles Scheitern. **Eine Anforderung, die man mit dem vorhandenen
`baseUrl`-Feld „löst", wäre schlimmer als gar keine — sie sieht gelöst aus.**

- [ ] **P1 — zweiter erweiterbarer *Dialekt*, nicht ein zweiter Vendor.**
      `anthropic-compatible:<label>` mit eigener `baseUrl` und **eigenem** Fabrikslot.
      `ProviderVendor` wird **nicht** länger, sondern **Dialekt + Name** — die Form, die
      zwei Dialekte trägt statt sie zu zählen.

- [ ] **P2 — Required-Header an den *Dialekt*, nicht an `=== "anthropic"`.**
      Heute: `if (vendor === "anthropic") return { "anthropic-dangerous-…": "true" }`.
      Für die Erstpartei korrekt; für `anthropic-compatible:<label>` wäre der Header
      **wirkungslos** — und schlimmer: er ginge an einen **fremden** Dienst und wäre eine
      Behauptung über dessen Sicherheitsmodell, die nicht stimmt.
      **Mit Test, der beweist, dass ein `anthropic-compatible`-Eintrag ihn NICHT bekommt.**

### Modellliste — und `Plan.md` hat hier schon einmal gelogen

`Plan.md` §14.4 behauptet wörtlich:

> **Modellkatalog:** `@opencode-ai/models` (models.dev) — CORS `*` ist **gemessen**. Das SDK
> selbst **kann keine Modelle auflisten** — es gibt nur `model(id)`-Fabriken.

**Beides ist falsch, und beides hat derselbe Fehler erzeugt: es wurde nicht ausprobiert.**
Gleiche Fehlerklasse wie `rawFinishReason`. Und die Behauptung *„kann keine Modelle
auflisten"* hat vermutlich dazu geführt, dass der Wizard heute **frei tippen** lässt
(E2E: *„the wizard says no model catalogue is wired, rather than inventing one"*).

**Dass `/v1/models` funktioniert, ist gemessen** — `Plan.md:973` und `:987`:

> OpenAI: **kein ACAO** auf `/v1/chat/completions` und `/v1/responses` — **nur
> `/v1/models` hat `*`** · `GET /v1/models → 401 + access-control-allow-origin: *`

**`/v1/models` ist der einzige Endpunkt, den OpenAI im Browser erlaubt.** Die Anforderung
ist damit nicht nur sinnvoll, sie ist die Lösung **ohne** das 6,35-MB-Bundle
(`@opencode-ai/models/snapshot`, das laut `Plan.md:1510` nur per dynamischem `import()`
ladbar ist und sonst den Bundle dominiert).

- [ ] **P3 — Modellliste über einen injizierten `fetch`, beide Antwortformen korrekt.**
      Offener Pfad, zwei Formen:
      - **OpenAI**: `{ data: [{ id, … }] }`
      - **Anthropic**: `{ data: [{ id, display_name, … }], has_more, first_id, last_id }`
      **Und Anthropic paginiert.** Ein Loader, der nur `data[].id` liest, funktioniert für
      OpenAI und **halb** für Anthropic: ohne `display_name` zeigt der Wizard einem Menschen
      `claude-haiku-4-5-20251001` statt eines Namens. Und `has_more` heißt: die erste Seite
      ist **keine vollständige Liste**. **Eine unvollständige Modellliste, die als
      vollständige dargestellt wird, ist dieselbe Lüge wie die gekappte `grep`-Suche** —
      nur teurer, weil der User danach ein Modell wählt, das fehlt.
      **Also:** vollständig paginieren **oder** ehrlich als unvollständig markieren.
      `display_name` verwenden, wenn da; auf `id` zurückfallen, wenn nicht.
      **Kein 6,35-MB-Bundle** — `/v1/models` ist der einzige erlaubte Endpunkt, und ein
      zweiter Katalog wäre eine zweite Wahrheit über dieselbe Sache.

- [ ] **P4 — der Probe wird die Modellliste.** Ein Aufruf, der **Key, CORS und
      Erreichbarkeit** in einem beantwortet. Genau `/v1/models` unterscheidet bei OpenAI
      **beides** — heute fehlt uns nur die Aussage. Anthropic braucht den Header; ob
      `/v1/models` dort ACAO trägt, ist **unbestätigt** und muss der Wizard sagen, statt eine
      leere Liste zu zeigen.

- [ ] **P5 — ein Anthropic-Turn durch die App**, per gefälschtem Endpunkt.
      ⚠️ **Heute fährt die E2E-Suite ausschließlich `openai-compatible`** („die ist ehrlich,
      weil der Fake genau das ist"). `anthropic` ist also **deklariert, header-behandelt,
      dokumentiert — und nie ausgeführt worden.** Dieselbe Fehlerklasse wie
      `rawFinishReason`: ein Pfad, den kein Test sieht, weil die Tests einen anderen Provider
      fahren. **Ohne P5 ist „Anthropic wird unterstützt" eine Behauptung, keine Tatsache.**

### Reihenfolge und Abhängigkeiten

`P1 → P3 → P4`, `P5` über allem. Block startet, sobald der Screenshot-Agent durch ist
(Hostregel: **ein Agentenstrom, serielle Beauftragung**).

### Aus dem CI-Lauf, gehört hierher

- [ ] **`@opencode-ai/models` als Quelle streichen oder als Fallback begründen.** Die
      Begründung in §14.4 ist **falsch**; die Korrektur gehört an dieselbe Stelle, und die
      Frage *„behalten wir es als Fallback für Endpunkte ohne `/v1/models`?"* ist offen.

---


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

## Engine: was der Verify-Agent umgeworfen hat

**Die Behauptung „`classify.ts` ist implementiert" war falsch.** `loop.ts:65` importiert
**nur `classifyThrownError`. Für `classifyResponse` gibt es in `src/` keinen einzigen
Aufruf.** Die ganze 200-Verifikation — JSON-Fehler-Bodies, Content-Type-Prüfung,
`sawTerminalEvent` — wird **nur von ihren eigenen Unit-Tests ausgeführt und nie von einem
Turn.** Das ist eine Spezifikationszusage ohne Implementierung, die 46 grüne Tests trägt.

**Und der Ersatz, der an ihre Stelle trat, ist degeneriert — nicht verlustbehaftet.**
Gemessen wurden zwei Part-Sequenzen durch `ToolLoopAgent.stream()`:

| Eingang | Sequenz |
|---|---|
| abgeschnittener Stream (kein finish-Part) | `start, start-step, text-start, text-delta, text-end, finish-step(other), finish(other)` |
| **legitimes** `finish("other")` | **byte-identisch** |

`ai@7.0.122`: `unified: finishReason === "unknown" ? "other" : finishReason`. Ein Provider,
der **bewusst** mit dem spec-legalen `"unknown"` endet, wird als Trunkierung gelesen und
**erneut versucht — 3 Requests für eine Antwort, die bereits da war.**

**Das Rohsignal existiert und wird weggeworfen.** Ein leerer Stream wirft
`AI_NoOutputGeneratedError: "No output generated. The model stream ended without a finish
chunk."` — §5.4s Rohsignal, wörtlich. `loop.ts` schickt es durch `classifyThrownError` und
verliert den Namen.

**Architekturelle Ursache:** `ToolLoopAgentSettings` hat **kein** `onChunk`, **kein**
`includeRawChunks`, **kein** `onError`. Auf dieser Ebene ist der rohe Chunk **nicht
erreichbar** — nicht schwer, nicht mühsam: nicht. → **D1: Heuristik streichen, typisierten
Fehler benutzen, und `Plan.md` §5.4 ehrlich amendieren** (das Prinzip gilt auf Body-Ebene,
nicht auf Chunk-Ebene).

### Zwei Implementierungen, die auseinanderdriften

`classifyThrownError` (live) und `classifyResponse` (tot) **widersprechen sich** beim
selben Input. `LoadAPIKeyError` → live `no-response`, das ist §5.4s Konzept des
**20-Sekunden-Stalls** — ein **fehlender API-Key wird der UI als Stall gemeldet**.
`loop.ts:1082-1086` behauptet „diese Datei hat bewusst keine zweite Kopie" — die *Datei*
hat keine, das **Modul** schon, und sie driften. Die live ist die schlechtere. → **D2.**

### D3 — das Crash-Fenster: der Zustand war nicht darstellbar

Gemessen: `beginToolCall` schreibt eine Zeile, die **niemand zurücklesen kann**.
`TurnStore` hat kein Statusfeld, „begonnen ohne Ergebnis" ist **nicht darstellbar**.
Absturz zwischen den zwei → der Aufruf ist unsichtbar, der Kurzschluss greift nicht, und
**das Tool läuft erneut.** Ein `write`, das anhängt, ergab `log === ["x","x"]`, während
das Transkript **einen** Schreibvorgang zeigte.

Meine Abwägung: Wiederholen macht aus einem **stillen Auslassen** eine **stille
Beschädigung der Dateien des Users** — und Beschädigung ist vom Modell nicht reparierbar,
Auslassen meistens schon. → **`getToolCall` bekommt einen Status (`begun`/`done`)**, der
Kurzschluss feuert **nur auf `done`**, und `begun`-ohne-`done` wird als **Ergebnis
unbekannt** sichtbar gemeldet statt still entschieden. **Es gibt hier keine kostenlose
Antwort**, also muss die getroffene Wahl im Kommentar lesbar sein.

### Weitere Befunde, nach Schwere

- [ ] **Der Anthropic-Header kann stillschweigend verloren gehen — und der Kommentar
      behauptet das Gegenteil.** `registry.ts:201`: Object-Spread merged rechts nach
      links, also gewinnt `settings.headers` vom Aufrufer. Der Kommentar sagt, Required
      Header werden zuerst gemergt, „so kann ein Required Header nie durch einen Unfall in
      den Settings verloren gehen" — **zweimal im Code gesagt und genau verkehrt herum.**
- [ ] **Der API-Key ist nicht Teil des Fingerprints.** `registry.ts:144-155`: Der Kommentar
      sagt, zwei Settings, die sich nur im Key unterscheiden, dürfen keine Instanz teilen —
      `fingerprint()` joint `vendor|model|baseUrl|name|headers` und **nie den Key**.
      **Wer einen neuen Key einfügt, bekommt das Modell des alten Keys zurück.**
      Fix mit **Hash**, nie mit dem Rohwert (Browser-Storage, Logs).
- [ ] **Die Heartbeat-Altersgrenze existiert nicht.** `store.heartbeat` wird **einmal**
      geschrieben und **nie gelesen** (`loop.ts:697`). Keine Altersarithmetik, keine
      Konstante — „welche Seite der Grenze" hat also keine Antwort. Jedes `interrupted` im
      Loop ist **versuchsbezogen** (Stop / Fehlschlag / Budget / no-response); **keines ist
      Reload-Recovery**, obwohl `AGENTS.md` §3.1 es verlangt und `Plan.md` §6.1
      `heartbeat_at` den Reload-Anker nennt. **Das ist eine fehlende Funktion, kein
      fehlender Test** — kein Fake hätte das gefunden, nur die Frage „wo ist es?".
- [ ] **Ein 200 + `server_error`-Body bekommt 2 Versuche statt 3.** `loop.ts:1058-1062`:
      `isUnknownBodyError` strippt `_error` bedingungslos, `"server_error"` → `"server"`,
      was kein Key ist, also gilt ein gelisteter *retryable* Typ als unbekannt.
      `classify.ts:79-85` **dokumentiert genau diesen Bug**, sagt, er habe ihn gehabt, und
      schützt ihn mit `normalizeErrorType` — **der Schutz ist nicht in die Loop-Kopie
      übernommen.** Genau ein Eintrag ist kaputt.
- [ ] **Eine wiederverwendete `toolCallId` verwirft einen legitimen Aufruf, still.**
      Dedupliziert auf der nackten Id: kein Versuch, keine Session (`loop.ts:629`). Und
      `getToolCall`/`recordToolCall` führen **keine Session-Id**, obwohl `tool_invocations`
      eine hat (§6.1) und der Store eine `sessionId` kennt.
- [ ] **Ein Tool kann seinen eigenen Output nicht rahmen.** `ToolDefinition` hat **kein**
      `toModelOutput`-Feld, `createSdkTool` verdrahtet eines. Das `question`-Tool sagt,
      Rahmen sei „Welle-2-Aufgabe an der `toModelOutput`-Naht" — **die Naht existiert
      nicht.** Als optionales Feld ergänzen.
- [ ] **`loop.ts:569-575`:** ein User-Abbruch in `#continue` wird als `no-response`
      synthetisiert und als `attempt-failed` emittiert — **ein Stop während einer
      Approval-Aufsetzung wird der UI als 20-Sekunden-Stall gemeldet.** Wer stoppt,
      verdient ein anderes Event als ein Timeout.
- [ ] **Vier Parser-Befunde in `registry.ts`**: `openai-compatible` ohne `baseUrl` bekommt
      seinen **Namen** als Base-URL; die Fehlermeldung empfiehlt
      `openai-compatible:groq:llama-3`, der Parser splittet aber am **ersten** Doppelpunkt;
      `settings.name` dient nur als Anwesenheits-Flag; `fingerprint` ist nicht injektiv.
- [ ] **`loop.ts:470-474`**: `void store;` ist tot, der Kommentar darüber **wörtlich
      doppelt** — Reste eines Hand-Patches.

### Zwei Mutationen, die überlebten — beide lehrreich

- [ ] **`maxRetries: 0` löschen: 403 Tests bleiben grün.** Ursache: der Test-Helfer baut ein
      **einfaches `Error`**, der SDK-Retry-Predicate ist aber
      `APICallError.isInstance(error) && error.isRetryable === true`. Der Fake war für die
      Retry-Schleife **unsichtbar** — **kein Test *konnte* die Wiederholung beobachten.**
      Das ist die Mutation, die der Build-Report ausdrücklich als getötet gemeldet hat.
      **Die Behauptung war wahr, der Beweis existierte nicht.** Der Verify-Agent hat die
      fehlenden Tests mit einem **echten `APICallError`** gebaut; M1 stirbt jetzt an
      5-Sekunden-Timeouts — was selbst der Beweis ist, dass das SDK durch seinen eigenen
      Backoff geschlafen hat.
- [ ] **`telemetry: { isEnabled: false }` löschen: null Tests sterben.** Bindende Konvention
      in `AGENTS.md` §3.1, Begründung in §14.4, **null Abdeckung** — und trivial prüfbar
      am Objekt, das an `ToolLoopAgent` geht.

### Lehren aus dieser Verifikation

**1. „Kann nicht getestet werden" war eine halbe Ausrede — in einem Durchgang widerlegt.**
Der Build-Agent schrieb, `provider/registry.ts` habe keine Tests, weil kein
Provider-SDK installiert sei. Er hatte die Vendor-Factories **selbst injiziert**, genau um
die Verdrahtung testbar zu halten. Der Verify-Agent schrieb **32 Tests** mit einem Fake und
fand **sechs** Befunde. → **Regel:** Wenn ein Agent sagt, etwas sei nicht testbar, muss er
**strukturell** begründen, warum — nicht mit einer fehlenden Dependency, die seine eigene
Injektion ohnehin umgeht.

**2. Ein Build-Agent kann eine Mutation als getötet melden, die nichts getötet hat.** M1
war die vom Build-Report explizit als tot verbuchte Mutation. Grund war nicht Schlamperei,
sondern ein **Fixture am falschen Ort**: der Test prüfte die *richtige* Sache für das *falsche*
Publikum. → **Regel:** Bei jeder Behauptung „Mutation X stirbt an Test Y" muss Y das
**richtige Publikum** haben — ein Fake, den der Produktionscode nicht erkennt, ist kein Test.

**3. „Braucht einen Browser" und „niemand hat einen Test geschrieben" sind verschiedene
Behauptungen — und nur eine ist eine Ausrede.** Der Verify-Agent hat die Liste sauber
getrennt. Das ist die Unterscheidung, die ich künftig in jedem Auftrag verlange.

**4. Ein Missing Feature sieht aus wie ein Missing Test.** Der Heartbeat-Anker wurde von
**keinem** Test verlangt, weil keine Zeile Code ihn liest. Kein Mutationstest hätte ihn
gefunden; nur die Frage „wo ist er?" — dieselbe Frage, die den `Plan.md`-Unfall gefunden hat.

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

## Uebergabe an Welle 2 — Vertraege, die der Engine-Fix gewachsen sind

Das ist keine Task-Liste, das sind **Schnittstellen**, die in Welle 2 brechen, wenn sie
niemand liest. Alle aus `ca7c02e`.

- [!] **`ProviderRegistry.resolve` und `fingerprint` sind jetzt `async`.**
      `AGENTS.md` §2 verlangt `crypto.subtle`, und es gibt kein synchrones WebCrypto.
      Heute bricht nichts (`baah-web` importiert nur `CORE_PACKAGE`), **Welle 2 muss
      awaiten.**
- [!] **Der Store-Vertrag ist gewachsen.** Welle 2 muss bauen:
      1. `tool_invocations.status` — unterscheidet `begun` von `done`. Ohne die Spalte ist
         das Crash-Fenster wieder unsichtbar und `write` haengt ein zweites Mal an.
      2. **Vier-Teile-Schluessel** statt nackter `toolCallId`:
         `{sessionId, attempt, toolCallId, occurrence}`. `session_id` ist als Spalte schon da,
         `attempt` und `occurrence` sind Engine-Buchhaltung.
      3. `listUnfinishedTurns({ sessionId })` — neu, fuer die Reload-Recovery.
- [ ] **`store.flushDelta` wird vom Loop bis heute nicht aufgerufen.** Wie `onProgress` liegt
      es an der Naht fuer die **App**, nicht fuer die Engine. Von mir benannt, damit es nicht
      als tote Methode wiederentdeckt wird. **Gehoert in Block B.**
- [!] **`Workspace.walk` meldet seine eigene Kappung nicht.** Block A fixt es auf
      `{ entries, truncated, visited }` plus exportiertes `DEFAULT_MAX_ENTRIES`; danach
      fallen die **gespiegelten 50 000-Konstanten** in `grep` und `glob` weg. Der jetzige
      Stopgap **überberichtet absichtlich** (exakt 50 000 Einträge werden als „möglicherweise
      unvollständig" gemeldet) — diese konservative Verzerrung muss den Wechsel überleben.
      Nebenbei offen: **schließt der Walk seinen Cursor, wenn der Verbraucher die
      `for await`-Schleife bricht?** Ein Handle-Leak im Browser ist still und dauerhaft.
- [ ] **`ToolDefinition.toModelOutput?` existiert jetzt** — optional, synchron,
      `undefined` = Default. Die im `question`-README dokumentierte Rahmen-Pflicht ist damit
      **implementierbar**; die Pflicht selbst bleibt Welle 2 (untrusted answer, API-Key im
      selben Tab).
- [ ] **Neue Verdict-/Event-Typen brauchen UI:** `config-error` mit `missing_api_key` (vorher
      als 20-Sekunden-Stall gemeldet), `tool-outcome-unknown` mit `TurnResult.unknownOutcomes`,
      und `turn-stopped` fuer beide Stop-Pfade.
- [!] **Der 20-Sekunden-Stall-Watchdog fehlt weiterhin** und ist in `Plan.md` §5.4 als Luecke
      protokolliert. Er braucht einen Timer auf **Chunk-Ebene** — also dieselbe Ebene, die
      `ToolLoopAgent` nicht freigibt. Haengt an derselben Entscheidung wie der Roh-Chunk-Zugriff.

## Lehren aus dem Engine-Fix — vier, die in kuenftige Auftraege gehoeren

**1. Ich habe ein Signal vorgegeben, der Agent hat ein besseres gemessen.** Ich schrieb
*benutze `AI_NoOutputGeneratedError`*. Der Agent hat **vor dem Schreiben das SDK gemessen**
und `TextStreamFinishPart.rawFinishReason` gefunden — ein **oeffentliches, typisiertes**
Feld, das die eigene Begruendung des Providers woertlich traegt und das der SDK **bei einem
selbst synthetisierten** `finish`-Part `undefined` laesst. Gemessen:

| Lauf | `finishReason` | `rawFinishReason` |
|---|---|---|
| abgeschnitten (kein Provider-`finish`) | `"other"` | **fehlt** |
| Provider sendet `finish("other")` | `"other"` | **`"other"`** |

→ **Regel:** Wenn ich einen Fix-Agenten auf ein Signal anweise, ist das eine **Hypothese**,
keine Vorgabe. Sagen: *das Signal, das ich vermute, ist X — miss erst, ob es das ist.*
Ich hatte die Fehlerklasse richtig und das falsche Feld.

**2. Ein ueberlebender Mutant muss entweder sterben oder als bedeutungslos bewiesen werden —
und wenn er bedeutungslos ist, ist meistens der *Kommentar* die Luege.** M25b ueberlebte,
weil der aufgeloeste Label **genau einen** Konsumenten hat. Der Agent hat keinen Test gebaut,
der eine tote Reihenfolge festnagelt, sondern **den Kommentar korrigiert**, der eine
Reihenfolge behauptete, die kein Test halten kann. → Ein Test fuer ein
Implementierungsdetail ist schlechter als ehrliche Dokumentation.

**3. Ein Test, der einen Defekt behauptet, kann den Fix nicht ueberleben — richtig ist
umdrehen, nicht loeschen.** Vier Verify-Tests behaupteten den Header-Drop, das falsche
Format, den Namen als Base-URL, den fehlenden Key und die Fingerprint-Alias. Sie wurden
**invertiert**: Fall bleibt, Name und Behauptung beschreiben jetzt das behobene Verhalten.
**Geloescht haetten sie die Abdeckung gekostet.**

**4. Eine Mutation fand einen echten Bug in der Loesung des Agenten selbst.** M10b
(occurrence-Vorschub in `begin` statt im Lookup) — ein kurzgeschlossener Aufruf beginnt nie,
also loesten zwei Aufrufe mit gleicher Id **beide** auf Occurrence 0 auf und das Modell
bekam die Antwort des ersten fuer den zweiten. Gefunden von einem **neuen** Test, nicht vom
Review — die dritte Runde, in der ein Test den Agenten belogen hat statt umgekehrt.

---


## W2-A: SQLite-Falle, die beim Messen auffiel — nicht beim Lesen

`DROP TABLE` auf eine Tabelle, auf die andere zeigen, ist ein **implizites `DELETE
FROM`**, und `ON DELETE CASCADE` **feuert trotzdem**. `PRAGMA defer_foreign_keys` hilft
**nicht**: es vertagt die Constraint-*Prüfung*, nicht den Kaskaden, und danach ist nichts
mehr zu prüfen.

Ohne Parkplatz-Tabelle hätte Migration 4 **jede `approvals`-Zeile stillschweigend
gelöscht**. Die Parkplatz-Tabelle in der ersten Fassung war **zweimal** getötet: erst von
`approvals`, dann von ihrem **eigenen** kaskadierenden Fremdschlüssel. Beide Varianten
sind als Test festgenagelt.

→ **Für die nächste Rebuild-Migration: nicht die DDL kopieren, den Absatz lesen.**

## W2-A: Entscheidungen, die ich getroffen habe

- **`ToolInvocationStatus` auf `begun | done` verengt** — akzeptiert. Die sechs
  Lifecycle-Werte **waren** das Crash-Fenster: `begin` und `record` schrieben in dasselbe
  Feld. §7.5 modelliert eine offene Freigabe über `approvals.decision IS NULL` und braucht
  keinen Lifecycle-Wert. Der Agent hat die Typ-Änderung von sich aus **als semantische
  Änderung an einem exportierten Typ** markiert — das war korrekt und ist hier notiert.
- **`walk` bleibt synchron, `truncated`/`visited` sind veränderliche Felder** — akzeptiert.
  Die Begründung trägt: `DirectoryWorkspace.walk` löst das Wurzel-Handle **im Generator
  beim ersten `next()`** auf, `walk()` berührt also gar kein Dateisystem. Ein `async`
  Rückgabetyp ließe jeden Aufrufer auf einen Wert warten, den es schon gibt. Und
  `truncated` ist erst **nach** der `for await` sinnvoll lesbar — genau dann, wenn ein
  Aufrufer fragt.
- **Vier `counts()`-Assertions von `toEqual` auf `toMatchObject` aufgeweicht** — akzeptiert,
  **nach eigener Prüfung**: `memory-coverage.test.ts:321` nagelt die vollständige Form fest,
  `:337` prüft die Schlüsselmenge explizit. Die Abdeckung ist **umgezogen**, nicht
  verschwunden — und vier Kopien des ganzen Objekts waren strukturell schlechter als eine
  an der richtigen Stelle.
- **Cursor-Freigabe**: getestet über ein **Ledger am Fake-Handle**, nicht über ein
  Generator-`finally`, das sich selbst meldet. Der Fake ist ein handgeschriebener Iterator,
  dessen Zähler sich nur bewegen, wenn der **Aufrufer** `return()` aufruft. Ebenso: der
  **erschöpfte** Cursor wird mitfreigegeben — `values()` liefert einen echten Iterator,
  dessen `return()` der dokumentierte Weg zum Schließen ist.

## W2-A: was das Messgerät des Agenten geliefert hat

**Der Agent hat sein eigenes Harness als defekt gemeldet, unaufgefordert.** Es stellte nur
die Dateien wieder her, die es in seiner Edit-Liste kannte. Eine Mutation hatte eine
**zweite Edit-Stelle**, die stehen blieb und **jeden danach laufenden Mutanten
verunreinigte**. Sichtbar wurde es, weil die Killer **die falschen Tests** waren. Er baute
das Harness auf einen Vollbaum-Snapshot um und maß neu. Zweite Korrektur: eine Mutation
lief mit `&&`, die Core-Suite schlug fehl, also liefen die zwei Tool-Suiten **nie** — und er
hätte „ein Killer" gemeldet, wo fünf sind.

→ Das ist die **dritte** Instanz dieser Sitzung, in der ein Test oder ein Messgerät den
Agenten belogen hat statt umgekehrt. Alle drei Fälle fielen auf, weil jemand **gefragt
hat, welcher Test welchen Mutanten tötet** — nicht, weil der Lauf grün war.

**W2-A: `write`/`edit`-Idempotenz ist nur gegen `TurnStore` getestet, nie gegen die echte
DB.** Ein Tool schreibt, der Idempotenz-Pfad wird aber nur über den Mock geprüft.

## W2-A: neu offen

- [ ] **`TurnStore`-Adapter** (`flushDelta`-Signatur, `finishTurn`, `heartbeat`) →
      `baah-storage`. Block B oder ein eigener Agent.
- [ ] **`Plan.md` §6.1 Drift** ist nachgetragen (§16.1 „Nachtrag: `tool_invocations`" in
      `Plan.md`), inkl. der SQLite-Kaskadenfalle.
- [ ] **`write`/`edit` gegen die echte DB testen**, nicht nur gegen den Mock.

---

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

## Zwei Defekte in der E2E-Harness, gefunden an einem 404

Aus einem Lauf mit `workers: 2`: **42 passed, 2 failed**, und die zwei Fehler waren
`GET / is served → Expected 200, Received 404` plus ein folgender Locator-nicht-gefunden.
Das sah zuerst nach einem Worker-Problem aus (zwei Tests parallel, eins davon
`the app boots … and logs nothing`). **Es war keins.** Beim Nachmessen:

```
$ grep '"build"' packages/baah-web/package.json
  build   tsc --noEmit && vite build        ← die Kopplung
$ grep -n reuseExistingServer …/playwright.config.ts
  reuseExistingServer: !process.env.CI      ← und die zweite
```

- [ ] **H1 — `tsc --noEmit` in der E2E-`build` koppelt fremde Typfehler an den App-Test.**
      ### BEWIESEN, nicht vermutet — die Kette, gemessen
      ```      packages/baah-web/package.json
      "build": "tsc --noEmit && vite build"
      ```
      ```      $ pnpm exec tsc --noEmit
      e2e/screenshots/manifest.ts(267,25): error TS2552: Cannot find name 'window0'. Did you mean 'window'?
      ```
      **Ein Tippfehler** — `window0` statt `window` — in einem **Screenshot-Manifest**.
      Folge: `tsc` ≠ 0 → `&&` bricht ab → `vite build` läuft **nie** → `&& preview` auch
      nicht → **die gesamte E2E-Suite startet nicht.**

      Und die Datei hat mit der **App** nichts zu tun. Sie gehört zu einem anderen
      Werkzeug. Trotzdem ist sie die Ursache dafür, dass die App **nicht getestet**
      werden kann.

      **Das eigentliche Übel ist nicht der Kopplungsfehler, sondern die
      Umbenennung auf dem Weg nach außen.** Ein Fehler erscheint als **drei verschiedene**
      Dinge, und keines davon sagt die Wahrheit:
      1. `TS2552: Cannot find name 'window0'` — echte Ursache, falsche Datei im Blick
      2. `[WebServer] Command failed with exit code 1` — der Server kam nicht hoch
      3. im Lauf davor: `GET / → Expected 200, Received 404` plus Locator-nicht-gefunden
      Das liest sich wie **Produktdefekt**. Es ist **Umgebungsdefekt**.
      *„Die App ist kaputt" und „dein Testlauf hatte eine kaputte Umgebung" sind zwei
      verschiedene Befunde, und ein Harness, der den ersten meldet, ist schlimmer als
      keiner — weil man ihn debuggt.*

      **Kostennachweis, nicht Theorie:** H1 hat mich genau **eine** Messung gekostet. Der
      gezielte Serienlauf (3×, `the cut is observable`) kam nicht an, weil der
      Screenshot-Agent in derselben Sekunde `manifest.ts` anfasste. Ohne H1 hätte ich
      die Frage beantwortet.
      **Konsequenz für die Orchestrierung:** Solange ein Build-Agent Dateien unter
      `baah-web/` anfasst, ist **kein** E2E-Lauf dieses Repos eine gültige Messung.
      Das ist eine Regel, keine Warnung.
      `build` ist `tsc --noEmit && vite build`, und `tsc` prüft **alles** unter
      `baah-web` — auch `e2e/screenshots/playwright.config.ts`, also eine Datei, die
      mit der App **überhaupt nichts** zu tun hat. Ein Tippfehler dort hätte
      `vite build` **nie** laufen lassen. Ein Tippfehler in einer *Screenshot-Config*
      darf nicht bewirken, dass die *App* defekt aussieht.
      **Auftrennung:** der Build der App und der Typcheck der E2E-Harness sind zwei
      Schritte. Oder, ehrlicher: `vite build` ohne `tsc` (Typecheck ist `quality`-
      Sache) und die Harness-Configs in ein eigenes `tsconfig`.

- [ ] **H2 — `reuseExistingServer: true` lokal lässt einen *veralteten* Server die ganze
      Suite bedienen, und die Suite meldet das als *Produktfehler*.**
      Das ist die Fehlerklasse, die in dieser Sitzung schon sechsmal aufgetaucht ist:
      **eine Messung, die die falsche Sache meldet.** Ein Server, der eine kaputte
      `dist/` ausliefert, erzeugt `GET / → 404` — und der Test sagt „die App ist
      kaputt", während die Wahrheit „dein Testlauf hatte eine veraltete Umgebung"
      lautet. Ein Testlauf darf nie eine Umgebung als Produktfehler ausgeben.
      **Entscheidung offen:** gar kein `reuseExistingServer` (jeder Lauf baut selbst,
      kostet aber die Zeit), oder — besser — **vor** dem Start prüfen, ob der vorhandene
      Server die *aktuelle* `dist/` ausliefert, und ihn sonst verwerfen.

**Was ich ausdrücklich NICHT behaupte:** welcher der beiden Wege die 404 verursacht
hat. Beide Kandidaten sind gemessen *vorhanden*, die Verursachung ist es nicht — sie
wäre in dem Moment zu prüfen gewesen, und ich habe stattdessen die Suite zweimal
laufen lassen. Aus einem grünen zweiten Lauf folgt **nicht**, dass der erste Lauf
derselbe Fehler war.

## Kontrastprüfung — neuer Block, vom Nutzer gefordert

„Auch für die Screenshot- und Kontrast-Testläufe." Der Screenshot-Agent baut die
Aufnahmen; die **Kontrastprüfung ist neu** und liegt als eigener Block daneben.

### Zuerst: das ist zu einem großen Teil **schon entworfen** — ich hatte es erfunden

Ich hatte K1–K5 als Grünanlage notiert. Dann die `ui-review`-Checklist gelesen, §11
**„Color contrast matrix (automated)"** — und mein Entwurf ist darin, wortgleich in der
Absicht:

- eigener Lauf: `pnpm test:contrast`, Spec `tests/contrast/contrast.spec.ts`, über
  `playwright.contrast.config.ts` (**nicht** in der normalen Suite — dieselbe Trennung
  wie beim Screenshot-Lauf);
- **WCAG AA** als Schwelle;
- Farben **über ein Canvas** auflösen, weil daisyUI v5 `oklch` benutzt und
  `getComputedStyle` genau das liefert — die Palette also **nicht** aus dem Quelltext
  raten, sondern den Browser fragen;
- **beide Themes** (hell und dunkel);
- `alert-{color}` **über der Seitenfläche komponiert** prüfen, weil Alerts transluzent
  sind und erst der gerenderte Farbwert zählt;
- `badge-{color}`, Fließtext und `link link-primary` gegen `bg-base-100`;
- **blockierende** Schwere, gleich `critical`/`high`;
- neu aufgenommene semantische Farbe, neue Badge-/Alert-Variante oder geändertes
  Theme-Token → neu laufen lassen, vor dem Merge.

⚠️ **Ehrliche Grenze dieser Vorlage:** sie existiert **als Text**, nicht als Datei. In
`references/templates/` liegen nur die drei Screenshot-Templates
(`playwright.screenshots.config.ts.example`, `ui-review-manifest.ts.example`,
`ui-screenshots.spec.ts.example`) — **keine Kontrast-Vorlage**. Ich habe also einen
*Entwurf*, kein *Artefakt*. „Portieren" heißt hier **implementieren**, nicht kopieren, und
wer das als Kopie meldet, meldet es falsch.

- [ ] **K1 — Token-Matrix nach dem Skill-Entwurf.** Das ist die Basis und sie ist
      gesetzt: `badge-*`, `alert-*` (komponiert über die Seitenfläche), Fließtext und
      `link link-primary` gegen `bg-base-100`, WCAG AA, beide Themes, Canvas-Auflösung.
      **Ehrliche Namensgebung:** das prüft die **Palette auf Selbstkonsistenz** — es
      sagt, ob die Farben zueinander passen. Es sagt **nicht**, ob eine Karte lesbar ist.

- [ ] **K2 — die *gerenderte* Karte. Das ist die Lücke, die der Skill nicht schließt.**
      Eine Token-Matrix kann vollständig grün sein, während die Tool-Karte in echt
      `muted` auf `base-200` setzt und bei 3,8:1 landet, weil **niemand diese Kombination
      je deklariert hat**. Genau dafür braucht es den zweiten Lauf: die Knoten, die
      **tatsächlich** im Chat stehen, mit `getComputedStyle` gelesen, gegen den
      **effektiven** Hintergrund gerechnet.
      **Und die Zustände, in denen das auftritt, sind genau die vier:** Tool-Karte,
      Approval-Karte, Fehlerbanner, abgeschnittenes Suchergebnis (`searchTruncated`).
      Eine Prüfung, die die Textur-Karte „4.5:1" sieht und die Fehlerkarte nie ansieht,
      ist eine Prüfung der Textur-Karte.

- [ ] **K3 — Unentscheidbares wird *gezählt und ausgegeben*, nicht bestanden.**
      Gradients, Bilder, Text über Text, `mix-blend-mode`. Der Grund ist nicht Sorgfalt,
      sondern die Fehlerklasse, die in dieser Sitzung sechsmal auftrat: die gekappte
      `grep`-Suche und die unvollständige Modellliste waren beide grün, **weil nichts
      beanstandet wurde**. Ein Gate, das `0 unentscheidbar` meldet, ist nur dann
      glaubwürdig, wenn es auch `7 unentscheidbar` melden *könnte* — also muss der Test
      das mit beweisen, sonst ist die Zahl Dekoration.

- [ ] **K4 — `workers: process.env.CI ? 4 : 2` auch hier, mit derselben Begründung.**
      Steht im Auftrag an den Screenshot-Agenten. **Warnung mitgeliefert:** mehrere
      Worker + `fullPage`-Aufnahmen sind eine bekannte Fehlerquelle. Falls es Flakes gibt,
      ist die Auflösung **Serialisierung der Aufnahmen**, nicht ein kleinerer Wert — wie
      beim `grep`-Test: hängt das Ergebnis vom Host ab, ist der Test das Problem.

## Welle 3 — Screenshot-Harness gelandet, und was er gefunden hat

**25 States, 46 Full-Page-, 72 Section-PNGs, 118 Dateien.** Vom Screenshot-Agenten
gebaut, nicht committet (auftragsgemäß), von mir übernommen.

### Erst die Harness selbst geprüft — sie könnte alles übersprungen haben

Ein Screenshot-Harness, der **alles** überspringt, ist immer grün. Also die Matrix
gegen die Platte geprüft, statt die „46 passed" zu glauben:

| | desktop | mobile |
|---|---|---|
| `empty/` | 20 PNGs | 24 PNGs |
| `filled/` | 37 PNGs | 37 PNGs |
| **Summe** | **57** | **61** → **118** |

- **Jede** deklarierte State hat ihren Full-Page-Shot in jedem deklarierten Viewport.
- **Vier** States sind **nur Desktop**, exakt die vier, die die Manifest-Tabelle mit „—"
  für mobile führt: `chat-reasoning-open`, `error-missing-key`, `settings-export-optin`,
  `settings-panel`. Kein State fehlt in beiden Projekten — der Fall, in dem
  `test.skip` **zweimal** greift und trotzdem grün meldet.
- Die „46 skipped" sind **kein Defekt**: die States×Viewports-Matrix wird unter zwei
  Playwright-Projekten expandiert, jeder Test überspringt das fremde Viewport
  (`ui-screenshots.shot.ts:214`).
- **Eigener Fehler dabei:** Ich habe die Struktur `filled/desktop/<state>/*.png`
  angenommen und eine Ebene zu tief gezählt — die PNGs liegen direkt in
  `filled/desktop/`. Erst der saubere Durchgang hat die Zahlen geliefert.

### Der Fund, der wichtiger ist als der Harness: **die App hat kein benutzbares Mobil-Layout**

Bei **390×844** gemessen, nicht vermutet:

```
innerWidth                             390
linke Spalte  (flex min-w-0 flex-1)   x 0 → 0     Breite 0
rechte Spalte (flex flex-col)          x 0 → 390   Breite 390
Composer                                Breite 24
elementFromPoint(Senden-Mitte) → <div class="flex flex-col border-l border-base-300">
```

`AppShell` ist `flex h-screen`; der **rechten** Spalte fehlt `min-w-0`, also ist ihre
automatische Mindestbreite ihre **max-content**-Breite, und `WorkspacePanel`s
`modeExplanation` ist ein langer deutscher Absatz. Bei 390 px übersteigt das die
Viewport-Breite, die linke Spalte wird auf **exakt null** gequetscht, und
Header/Transcript/Composer rendern **unter** der Sidebar.

- [ ] **U1 — `min-w-0` fehlt an der rechten Spalte. `critical`. — und die Schilderung war
      zu MILD.** Ich habe `filled/mobile/chat-approval-sec0.png` selbst angesehen. Der
      Screenshot-Agent hatte geschrieben, „die Approval-Karte und das Transcript
      **übereinander geschrieben** in derselben 390-px-Spalte". Das ist eine
      **Milderung** dessen, was das Bild zeigt:

      - **Jedes Textelement bricht auf ein Wort pro Zeile um.** „Approvals",
        „Ordner verbinden", „Zusammenfassung", „waiting" — vertikal gestapelt, ein Wort
        pro Zeile, über die volle Höhe des Bildes.
      - **Mehrere Textspalten liegen übereinander.** Der Transcript-Text rendert in einer
        ~20 px breiten Spalte, die Überschriften auf voller Breite, **darüber**.
      - Die Sidebar („Workspace", „Neu einlesen", „Ordner verbinden") liegt **auf** dem
        Transcript.
      - Die **Textarea ist 24 px breit**; sichtbar sind „n", „f", „a" untereinander.

      **Der Zustand ist nicht „Bedienung unmöglich". Er ist „Text unlesbar".** Und
      **Desktop ist sauber** (`filled/desktop/chat-approval-sec0.png`): zweispaltig,
      lesbar, Approval-Karte in Warnfarbe, Tool-Karten korrekt, Kontrast gut. Der Defekt
      ist **ausschließlich** mobil.

      ### Und die Lehre ist nicht der Befund, sondern die Meldung
      Die **Messung** des Agenten war richtig und gut: `linke Spalte 0 px`, `Composer
      24 px`, `elementFromPoint` nennt das verdeckende Element. Aber er hat daraus
      „**jeder Klick ist tot**" gemacht. Das ist die *funktionale* Konsequenz, und sie
      ist die **milderste** vorstellbare.
      **Ein Breitenwert von 0 und ein umgebrochenes Wort pro Zeile sind dieselbe
      Ursache, aber nicht derselbe Schweregrad.** Wer eine Layout-Messung in Prosa
      übersetzt, verliert die Schwere, weil die Zahl nüchtern aussieht und die
      Konsequenz nicht.
      → **Regel für jeden Auftrag, der misst:** die Meldung braucht **beides** — den
      Messwert *und* die Konsequenz, mit der ein Mensch konfrontiert wird. Am besten,
      indem der Auftrag ausdrücklich verlangt, **einen Screenshot mit eigenen Augen
      anzusehen**, bevor der Bericht geschrieben wird. *Ich habe es diesmal getan, und
      es hat die Schwere verdoppelt.*

- [ ] **U1-KONTRAST — was der Desktop-Blick nebenbei zeigt, als Kandidaten für K2:**
      `Turn-Ende: idle` und die Metazeile `Versuch 1 von 3 · Schritt 1` sind sehr
      gedämpft. **Noch kein Befund** — das ist ein Augeneindruck aus einem PNG, und die
      K-Prüfung rechnet. Steht hier, damit es **nicht** verloren geht und damit niemand
      „ich sehe doch, es ist grau, das ist ein Befund" schreibt. *Ein Bildeindruck ist
      kein Messwert.*
      Ebenfalls unauffällig: der ausgegraute Button „Ordner verbinden" — **disabled**,
      niedriger Kontrast ist dort **korrekt** und darf nicht als Befund auftauchen.

      Kein Testfehler, sondern ein **Produktdefekt**: bei 390 px ist **jeder Klick in der
      Chat-Spalte tot.** Das ist der Grund, warum der Screenshot-Agent für den
      Sendepfad `Enter` nehmen musste (was der Composer-Text ohnehin ankündigt) — er hat
      sich damit um den Defekt **herumgebaut, statt ihn zu melden**, was richtig war,
      aber der Defekt bleibt.
      **Und die mobile Bilder zeigen ihn** — `filled/mobile/chat-approval-sec0.png` ist
      Approval-Karte und Transcript **übereinander geschrieben** in derselben
      390-px-Spalte.

- [ ] **U2 — drei States sind nur Desktop, weil sie mobil nicht erreichbar sind.**
      `settings-panel`, `settings-export-optin`, `error-missing-key` (kein Deep-Link, kein
      Shortcut — `SettingsPanel` mountet nur per `onClick`) und `chat-reasoning-open`
      (das `<summary>` ist layoutmäßig da, aber **nicht sichtbar**, also lässt sich der
      Reasoning-Text am Telefon gar nicht öffnen).
      **`force: true` hätte Bilder von Zuständen erzeugt, die kein User erreichen kann.**
      Richtig so — aber die *Ursache* ist U1, und nach U1 sind sie womöglich alle vier
      mobil. **Nach U1 neu aufnehmen und prüfen, nicht vorher.**

- [ ] **U3 — der Transcript scrollt nicht automatisch.** Kein `scrollTop`, kein
      `scrollIntoView` in `Transcript.tsx`. Die Approval-Karte ist als „nicht
      wegzuscrollen" dokumentiert und liegt unterhalb des Folds. Die `-secN`-Aufnahmen
      machen das sichtbar, statt es zu verdecken — dafür sind sie da.

- [ ] **U4 — `error-storage-boot` (16 KB) ist der leerste Bildschirm im Satz** und hat
      **keinen** Weg vorwärts. Ein toter Bildschirm braucht eine Handlung.

### Der Umfang von U1 ist **alle 25 States**, nicht ein State

`filled/mobile/chat-tools-sec0.png` ist **nicht** anders, sondern **gleich**:
dieselbe zerstörte Shell, nur anderer Transcript-Inhalt („disucceeded" / „Abschneiden"
statt „waiting" / „Kappieren"). Die Kaputtheit hängt **nicht** am State, sondern an der
**Shell**.

→ **Auf dem Mobil-Viewport sind alle 25 States unbrauchbar.** Es gibt keinen mobilen
State, der funktioniert. Die vier „nur Desktop"-States sind damit nicht „weniger
abgedeckt", sie sind die **einzigen**, in denen überhaupt etwas zu sehen ist.

### U1 ist auf die **Workspace-Shell** begrenzt — der Wizard ist in Ordnung

`empty/mobile/onboarding-provider.png` bei 390 px: **einwandfrei.** Einspaltig, Fließtext
in normaler Zeilenlänge, Karten mit ausreichendem Kontrast, Badges lesbar
(`CORS unbestätigt` / `CORS bestätigt`), Buttons erreichbar.

→ Der Defekt sitzt **`AppShell`**, nicht daisyUI, nicht das Theme, nicht der Wizard. Das
grenzt die Suche von vornherein ein und ist **gute Nachricht für die Behebung**: es ist
**eine** Komponente, nicht ein systematischer Fehler.

(Nebenbefund mit Content-Bezug: das Bild zeigt, dass die CORS-Matrix aus `Plan.md` §9
**bereits im Wizard steht** — inklusive des Hinweises, dass `/v1/models` einen CORS-Header
liefert und die Inferenz-Endpunkte nicht. Das ist genau der Befund, auf dem **P3/P4**
aufsetzen. Block P muss den Wizard also **nicht** erfinden, sondern die vorhandene
Aussage von „CORS unbestätigt" zu einer **gemessenen** Probe ausbauen.)

### Und was das über die E2E-Suite sagt — das ist der wichtigere Teil

**44 grüne E2E-Tests, und die App ist auf dem halben Viewport unlesbar.** Kein einziger
der 44 Tests sieht es, und das ist **konstruktiv**, nicht zufällig: die Tests adressieren
über `data-testid`, `waitForTurnIdle` wartet auf `data-baah-status="idle"`, und der
Screenshot-Assert prüft `toHaveTitle`. **Kein Test prüft, ob etwas lesbar ist.**

Das ist kein Testfehler, das ist die **Grenze des Ansatzes** — und sie ist ehrlich
benennbar, also muss sie benannt werden:

- **Funktional grün** heißt: *die Mechanik* stimmt (Turn läuft, Tool liefert, Approval
  wartet, Retry zählt).
- **Visuell kaputt** heißt: *das Ergebnis* ist unbrauchbar.

Ein Harness, der nur das Erste prüft, ist **nicht grün** — er ist **halb** geprüft und
sieht dabei so aus, als wäre alles geprüft. Das ist dieselbe Fehlerklasse wie die
übersprungene Modellliste: grün, **weil etwas nicht geprüft wurde.**

→ **Deshalb ist die Screenshot-Harness kein Luxus, sondern die einzige Sache, die diesen
Fehlertyp findet.** Und deshalb ist sie auch das Einzige, was K1–K5 tragen kann: eine
Kontrastprüfung, die in einem Playwright-Test rechnet, sieht **Layout-Überlagerung
nicht**, und Layout-Überlagerung war hier der teurere Defekt.

### Zwei States, die es nicht gibt

- [ ] **U5 — `chat-stall` und `chat-streaming` sind BYTE-IDENTISCH** (md5, beide
      Viewports). Das Pacer-Gate hält bei einem Event, also erscheint der Stall-Hinweis
      nie: der Watchdog wird bei `attempt-started` scharf und durch den `text-delta`
      abgeschaltet, den das 6-Event-Gate durchlässt. Der Zustand wird durch
      **Stille** erreicht, und mein Gate liefert **Text**.
      → **Entweder** das Gate so bauen, dass es wirklich schweigt (0 Events, dann
      Stille) **oder** die State streichen. Ein doppelter State, der zwei Namen trägt,
      ist schlimmer als ein fehlender: er zählt in der Abdeckung mit, ohne etwas
      abzudecken.

- [ ] **U6 — `error-stream-cut` zeigt „Versuch 1 von 3", nicht 3.** Die Versuche 2–3
      treffen den 501 des Fakes und die retryable-Einstufung läuft anders aus als die
      §5.4-Tabelle vorsieht. Entweder die Klassifikation des 501 korrigieren **oder** die
      Erwartung an das ändern, was tatsächlich klassifiziert wird — **mit der Begründung
      im Spec**, warum das richtig ist. Sonst repariert der nächste Agent die Zahl und
      nicht das Verhalten.

### Was die Kontrastprüfung K2 braucht und nicht hat

- [ ] **K2-VORBEDINGUNG — `searchTruncated` fehlt im Satz.** Kein `grep`/`glob`-Aufruf ist
      skriptet, weil eine Kappung einen Workspace **über der Entry-Cap** braucht und die
      In-Memory-Sandbox **eine Datei** hat.
      Also: **einer der vier K2-Zustände existiert nicht.** Entweder einen
      Workspace mit vielen Dateien im Sandbox-Setup **oder** den vierten Zustand
      streichen und die Aussage auf drei reduzieren. Ein Prüfziel, das es nicht gibt,
      wäre ein **grüner K2 über eine Lücke**.

### Der Absturz, jagdbar gemacht — und was **nicht** die Ursache ist

Der Jäger-Report. Reproduktion **nicht** gelungen: **0 von 440** Testausführungen in
10 Suite-Läufen, `oom_kill` über alle Läufe **unbewegt bei 3**. Also: selten, und nicht
erzwungen — mit Recht, denn ein absichtliches OOM trifft hier `mariadbd`.

**Der Absturz ist derzeit eine Hypothese mit gutem Bogen, kein Befund.** Der fehlende
Link ist genau einer, und er ist markiert: `oom_kill` blieb in allen 440 Läufen stehen.

**Die Diskriminator-Zeile, die ich selbst benutzen kann:**

```bash
cat /sys/fs/cgroup/memory.events   # VOR und NACH dem Lauf
```

Bewegt sich `oom_kill` → Kernel, also Host. Bleibt es stehen → der Renderer ist von
allein gestorben, dann ist es ein Chromium-Bug und der nächste Schritt wäre
`channel: "chromium"` statt der alten, eingefrorenen `chrome-headless-shell` 153.0.8010.12.

**Und die Korrektur an meiner Lücke:** „beide Abstürze beim DB-Boot" war **nur für Test
18** richtig. Für Test 32 zeigt der Seitenzustand **keinen** Boot-Screen, sondern eine
laufende Workbench im **dritten** Provider-Versuch. **Das ist ein zweiter Codepfad**, und
er schwächt jede rein boot-spezifische Erklärung. Ich habe die Prämisse zu früh
verallgemeinert.

#### Die drei Ausschlüsse — eine Landkarte dessen, was es **nicht** ist

Jeder gemessen, keiner behauptet. Das ist der wertvollste Teil des Reports, weil eine
Ausschlussliste billiger ist als eine Wiederholung:

- **OPFS-VFS-Eigentum — nicht der Pfad.** Der Fehlerfall wäre **sichtbar**
  (`database_owned_by_another_context` → `baah-boot-failure`, und `waitForApp` prüft
  das auf 0). Kein Report zeigt einen. Strukturell kann er bei `workers: 1` nicht feuern.
- **WASM/Speicher — nicht der Pfad.** Footprint nach vollem Boot, **30 frische Contexts,
  jedes Mal identisch**: `6 Dateien, 450560 Bytes = 1× 430080 (SQLite) + 5× 4096 (leere
  Pool-Slots)`. `initialCapacity: 6`, die App nutzt **1** Slot. Kein Wachstum, kein
  `journal_mode=WAL`. **Es gibt nichts, das wachsen und den Renderer töten könnte.**
- **Worker-Lebenszyklus — nicht der Pfad.** Chromium-Prozesse über einen 44-Test-Lauf:
  `6 → 11/12 während eines Tests → 6 am Ende`. RSS oszilliert **ohne Trend**.
- **`/dev/shm` ist 64 MB — aber irrelevant**, weil Playwright 1.63
  `--disable-dev-shm-usage` **selbst** setzt (an der Launch-Zeile gemessen), `shmem` = 0.
  Diese Hypothese ist **tot**, und zwar nachweislich.

#### Und die libc-Hypothese ist **ausgeschlossen**, mit Beleg

`/var/log/dpkg.log` ist lesbar. `install-deps` lief 14:02:52–14:05:57. `libc-bin` wurde
**neu entpackt, nicht angehoben** (`trigproc`, kein `upgrade`-Eintrag) — und `libc-bin`
enthält **nur Werkzeuge** (`ldd`, `getent`, `locale`), **nicht `libc.so.6`**. `libc6` hat
ctime 2026-09-19, ist heute unberührt. Von den 14 heutigen `upgrade`-Zeilen (`libssl3`,
`openssl`, 12× `php8.5-*`) ist **keine** in Chromiums Link-Set.

**Was wirklich neu ist:** 24 der 53 Libraries, die `chrome-headless-shell` lädt, wurden
heute **neu angelegt** — die waren weg. **Was nicht trennbar ist:** Browser-Binary **und**
24 seiner Bibliotheken wurden im selben Fenster ersetzt, und `dpkg.log` protokolliert nur
den heutigen Tag. Für den 44/44-Lauf davor gibt es **keinen Zustandsnachweis**. Also:
libc ausgeschlossen, der Rest **nicht** — und das ist eine ehrliche Grenze, keine Ausrede.

### ENV4 — der zweite Fehlermodus, und der **maskiert sich**

Nach `playwright install chromium` war die Binary da (197 MB) — und der Lauf **immer
noch** rot, jetzt in **3 ms** statt 7 ms, mit **anderer** Meldung:

```text
browserType.launch: Target page, context or browser has been closed
```

Das liest sich wie ein **Test- oder Produktproblem**. Es ist keines: der Container-Reset
hat die **Systembibliotheken** mitgenommen, diesmal nicht den Browser.

```text
$ chrome-headless-shell --version
error while loading shared libraries: libnspr4.so: cannot open shared object file
$ ld "$BROWSER" | grep -c "not found"
15
```

Reparatur: `sudo pnpm exec playwright install-deps chromium`.

→ **Zwei Fehlermodi, zwei Meldungen, zwei Reparaturen, und der zweite tarnt sich:**

| Was fehlt | Meldung | Reparatur |
|---|---|---|
| die **Binary** | `Executable doesn't exist at …` | `playwright install chromium` |
| die **Libraries** | `Target page, context or browser has been closed` | `playwright install-deps chromium` |

**„Browser has been closed" ist die Meldung, die man normalerweise als Produktfehler
liest.** Sie ist es nie, wenn sie **alle** Tests gleichzeitig und in **einstelligen
Millisekunden** trifft. Das ist das eigentliche Kriterium, und es gilt für beide Modi:
**flächendeckend + sofort = Umgebung, nie Code.**

- [ ] **ENV5 — `ENV2` braucht die zweite Probe.** `ls ~/.cache/ms-playwright/` füllt ist
      **nicht** genug: die Binary kann da sein und trotzdem **15 `.so` nicht**. Die
      vollständige Probe ist **eine Zeile** und beantwortet beides:
      ```bash
      "$HOME/.cache/ms-playwright"/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell --version
      ```
      Fehlt die Binary, findet der Glob nichts; fehlen die Libs, antwortet der Aufruf
      mit `error while loading shared libraries`. **Ein Aufruf, zwei Diagnosen** — billiger
      als jeder Fehlschlag, den die Suite danach meldet.

---

### Aufnahmetechnik: zwei Stellen, an denen die Sections nichts bringen

- [ ] **U7 — `chat-answer-sec0` und `chat-answer.png` sind dasselbe Bild** (Desktop).
      Nichts unterhalb des Folds bei 1280×800. Die Sections lohnen sich nur, wo eine
      Spalte lang ist — bei **20** der 25 States ist es genau ein `-sec0`.
      Das ist kein Fehler, aber eine Information: **die Section-Logik kostet 72 Dateien,
      davon tragen ~52 keinen zusätzlichen Blick.** Wer die Suite verkleinern will, hat
      hier den Hebel.

---

## Parallelität — was gemessen ist, und wo die Grenze wirklich liegt

Vom Nutzer gefordert: **hier headless 2, in der CI 4.** Der Widerspruch löst sich auf,
sobald man ihn als **zwei Maschinen** liest — lokaler Host (geteilt, `mariadbd` im
Risiko) gegen GitHub-Runner (eigenes Budget). Die Host-Regel steht jetzt in
`~/.config/opencode/Agents.headless.md` (war `HEADLESS.md`; der Verweis in `AGENTS.md`
zeigte bereits auf den neuen Namen und war damit **kaputt**), der Einzeiler in `AGENTS.md`.

**Und die Zahl 2 steht dort, weil jemand sie später hochsetzen will. Genau darum steht
sie mit Begründung drin, nicht als nackte Ziffer.**

### Der eine echte Stellschrauber, und was die Plattform *nicht* kann

GitHubs Workflow-`concurrency` **kann „höchstens N" nicht ausdrücken** — eine
Concurrency-Gruppe ist **exklusiv**: `cancel-in-progress: true` heißt *ein laufender plus
ein abgebrochener wartender*, `false` heißt *einer plus Queue*. Und `strategy.max-parallel`
braucht eine **Matrix**, die es nicht gibt (zwei Build-Jobs). Beide Zahlen landen deshalb
in Playwrights `workers`.

### Und dort trennt sich die Sache — an einer **gemessenen**, nicht an einer gewählten Grenze

| Lauf | `workers` | Umfang | Ergebnis |
|---|---|---|---|
| 1 | **1** | ganze Suite | **44/44** |
| 2 | **2** | ganze Suite | **42/44** — zwei `waitForTurnIdle`-Timeouts |
| 3 | **2** | ganze Suite | **43/44** — der Pacer-Race |
| 4 | **2** | **nur** die 2 verdächtigen Tests, 3× | **6/6** |

**Der entscheidende Befund ist Zeile 4, nicht Zeile 1.** Die Fehler treten **nur im
Vollauf** auf und **nicht**, wenn dieselben Tests allein laufen. Das ist also *nicht*
„`workers: 2` ist kaputt" — es heißt: **diese Suite ist noch nicht unabhängig davon, wie
viel CPU sie bekommt.**

Dieselbe Fehlerklasse wie der `grep`-Timeout-Test, dessen Erwartung aus „~14 ms **auf
dieser Maschine**" abgeleitet war und der in CI an einem **schnelleren** Runner rot
wurde. Beide sind **Tests, die den Host messen.** Und die Warnung gilt für **beide**
Richtungen: der `grep`-Test wurde nicht langsamer, er wurde schneller.

- [ ] ~~**PP1 — `workers` bleibt `1`**~~ **ZURÜCKGENOMMEN am selben Tag.**
      Beide Gründe sind gemessen, keiner ist eine Vermutung.

      **Grund 1 — es ist Speicher, nicht CPU.** `/sys/fs/cgroup/` ist **ohne sudo**
      lesbar, und dort steht, was `dmesg` nicht hergab:

      ```text
      memory.max     5368709120   (5120 MB)
      memory.peak    5369569280   <- ÜBER memory.max
      memory.events  max 67752  oom 3  oom_kill 3
      ```

      **Der OOM-Killer hat in diesem Container 3× gefeuert**, und ein voller Lauf
      bringt `memory.current` auf **5118 von 5120 MB** — **2 MB unter der Decke**.
      Nach `oom_score` sortiert ist `chrome:renderer` mit `adj+300` der **höchste Kill-
      Kandidat des ganzen Hosts** (Chromium setzt `oom_score_adj` absichtlich hoch, um
      geopfert zu werden), `chrome:browser` überlebt mit `adj 0`.
      → **Renderer stirbt, Browserprozess lebt = genau Playwrights `Page crashed`.**
      Und **deshalb kann `workers: 1` nichts ändern**: Speicher ist kein CPU-Kontention-
      Phänomen. Meine Flake-Tabelle ist damit als Begründung **wertlos**, auch wenn die
      Zahlen echt sind.

      **Grund 2 — der eine Flake, den man *kann*, wird auf langsameren Maschinen
      ZUVERLÄSSIGER.** `scenarios.e2e.ts:385`, 4 von 8 Läufen, vollständig diagnostiziert
      und von **mir nachgelesen**, nicht übernommen:
      - `loop.ts:2559`: `case "no-response": return false;`
      - Der Testkommentar (`scenarios.e2e.ts:418`) sagt: *„the classification of an
        aborted request **is retryable**"*.
      **Das ist falsch.** `route.abort("failed")` ⇒ Fetch lehnt **ohne Antwort** ab ⇒
      `no-response` ⇒ `isRetryable` = `false` ⇒ der Turn endet nach **Versuch 1 von 3**.
      Das Artefakt zeigt genau das („bereit", „Versuch 1 von 3").
      Die Assertion `data-baah-status="idle"` hat `toHaveCount(0)` — sie prüft also, dass
      der Turn **noch läuft**. Das Fenster dafür sind **Millisekunden** zwischen dem Klick
      und der Klassifizierung des Abbruchs.
      → **Für diesen Test ist „Last reduzieren" die falsche Richtung: langsamer macht
      ihn grüner.** Ein Test, der dafür sorgt, dass eine Behauptung wahr aussieht, ist
      kein Test, der sie prüft.
      ⚠️ Das ist ein **Testentwurfsfehler, kein Hostproblem** — und er ist der
      **billigere Hebel** als der Absturz.

      **Was aus `PP1` wird:** `workers: 1` bleibt vorerst stehen, aber **nicht aus dem
      genannten Grund**. Sobald der Speicher unter der Decke liegt und `scenarios.e2e.ts:385`
      ehrlich ist, entscheiden wir neu — und **nicht** nach dem Gesicht des `workers`-Werts,
      sondern nach `memory.current`.

- [ ] **PP2 — die Parallele kommt dorthin, wo die Arbeit reihenfolgeunabhängig ist:**
      die **Screenshot-Suite** nimmt `process.env.CI ? 4 : 2`. Sie fotografiert Pixel und
      prüft **keine** Zeitverhältnisse. Aufteilung nach *gemessener* Eigenschaft, nicht
      nach Bequemlichkeit.

- [ ] **PP3 — die zwei lastempfindlichen Stellen sind **benannt**, nicht geraten:**
      `scenarios.e2e.ts:385` (Approval-Pause, 20 s Budget für eine **Statusanzeige** —
      daran kann CPU-Konkurrenz nichts ändern) und `scenarios.e2e.ts:480` (Backoff, 2 s + 8 s
      spezifiziert gegen **20 s** Budget, also 2× Headroom, und `setTimeout` dehnt sich
      unter Last **nicht**).
      ⚠️ **Deshalb trägt die Erklärung des Screenshot-Agenten nicht**, die da lautete, den
      Tests fehle ein „wall-clock budget for a second worker stealing CPU". **20 s für
      10 s Arbeit sind kein zu knappes Budget**, und der Approval-Test hat gar keine
      Wartezeit. Die Erklärung ist plausibel, **nicht bestätigt** — ich habe den Fehler
      nicht reproduziert, nur nicht-in-Isoliert. Genau so steht es im Config-Kommentar.

- [ ] **PP4 — `waitForTurnIdle` ist kein Test-Detail, sondern ein geteilter Ort.** 20 s
      Default, an 18 Stellen aufgerufen, plus ein eigener `waitForTranscriptRead` mit
      eigener Begründung. Jeder Test, der eine **spezifizierte Verzögerung** des Produkts
      abwartet, sollte sein Budget **aus dieser Spezifikation ableiten** statt aus einer
      Magic-Number — sonst ist „20 s" genauso eine Maschinenannahme wie „14 ms".

### Und die vierte Zahl, die beinahe eine Lüge in die Config geschrieben hätte

```text
$ CI=1 pnpm --filter @all-the.rest/baah-web test:screenshots
  Running 92 tests using 2 workers      ← 2, bei workers: 4 in der Datei
```

**Playwright verteilt *Dateien* auf Worker.** Die Screenshot-Suite ist **eine** Spec-Datei
(`ui-screenshots.shot.ts`) unter **zwei** Projekten — mit `fullyParallel: false` hat sie
also genau **zwei Arbeitseinheiten**, und `workers: 4` ist **strukturell unerreichbar**.

Damit wäre `workers: process.env.CI ? 4 : 2` in dieser Config **eine Behauptung über eine
Parallelität, die die Suite nicht haben kann** — sie *liest* wie parallel und ist es
nicht. Das ist der **`grep-wasm`-Fehlermodus**: eine Konfiguration, die etwas zu tun
scheint und nichts tut.

- [ ] **PP5 — `fullyParallel: true` in `e2e/screenshots/playwright.config.ts`, weil `workers`
      sonst bedeutungslos ist.** Und das ist **hier** sicher, **konstruktiv**: jeder Test
      präpariert seinen Zustand aus seiner **eigenen** `app`-Fixture (eigene Page, eigener
      `BrowserContext` — der gefälschte Provider ist `context.route()` auf genau diesem
      Context, es gibt **nichts** zu teilen) und schreibt auf seinen **eigenen** Pfad.
      Kein Test beobachtet einen anderen.
      **Gegenprobe statt Hoffnung:** 118 PNGs vorher gesichert, Lauf mit 4 Workern,
      danach Dateimenge und Bytegrößen **Bit für Bit** verglichen. Ein halb gerenderter
      Frame — die vom Screenshot-Agenten befürchtete Flake — fiele als **deutlich
      kleinere Datei** auf, nicht als „Flake, die man irgendwann bemerkt".

- [ ] **PP6 — REGEL: eine Parallelitätseinstellung gilt erst, wenn sie die gemeldete
      Worker-Zahl verändert.** `Running N tests using M workers` ist die **einzige**
      Messung, die zählt, und sie gehört in jeden Commit, der `workers` anfasst.
      Sonst steht irgendwann `workers: 8` in einer Config, die 2 kann, und niemand
      merkt es — weil eine Zahl in einer Datei **aussieht** wie eine Einstellung.
      *Ergänzt zu `no-foreign-error-text` und den fünf Source-Gates: eine Einstellung,
      die nichts bewirkt, ist ein Gate ohne Wirkung.*

- [ ] **PP7 — und die Umkehrung gilt genauso:** Der **E2E**-Config hat
      `fullyParallel: false` und **drei** Spec-Dateien, also drei Arbeitseinheiten — dort
      sind `workers: 2` **und** `workers: 1` **wirksam**, und genau deswegen sind die
      Messungen der Tabelle oben gültig. **Dieselbe Zeile bedeutet in zwei Configs etwas
      anderes**, was ein Kommentar in beiden nötig macht.

### Und der Grund, warum das nicht sofort reparierbar war

H1 hat die Messung gekostet: der 3×-Serienlauf kam nicht an, weil der Screenshot-Agent
in derselben Sekunde `manifest.ts` anfasste. **Regel, die daraus folgt:** solange ein
Build-Agent `packages/baah-web/` anfasst, ist **kein** E2E-Lauf dieses Repos eine gültige
Messung. Das ist eine Regel, keine Warnung.

---

## Umgebungsbefund: der Playwright-Cache wird **wieder** gelöscht — zum dritten Mal

`pnpm --filter baah-web e2e` meldete **33 failed** bei `workers: 1`, davon einer in
**7 ms**. Ursache:

```text
Error: browserType.launch: Executable doesn't exist at
/home/dev/.cache/ms-playwright/chromium_headless_shell-1243/.../chrome-headless-shell
```

```text
$ ls -1 /home/dev/.cache/ms-playwright/     # LEER
$ df -h /home/dev                           # 209 G frei
```

**Drittes Mal in dieser Sitzung**, identische Signatur wie beim ersten Mal (Cache
verschwunden, danach 20 Systembibliotheken): **kein Platzmangel** (209 GB frei), also
**kein Eviction**, sondern der in `Agents.headless.md` §2 beschriebene periodische
Container-Reset, der diesmal nur *Teile* des Dateisystems mitnimmt.

→ **Ausdrücklich *kein* Befund.** Es steht hier, weil die Versuchung groß ist,
„33 failed bei `workers: 1`" als Ergebnis zu notieren. Es ist **Umgebung**, und die
Suite **sieht aus wie ein Produktdefekt**. Dritte Instanz derselben Klasse wie H1.

- [ ] **ENV1 — REGEL: ein Playwright-Fehler unter ~100 ms ist ein Fixture- oder
      Browserproblem, kein Produktproblem.** Ein Test, der in 7 ms fehlschlägt, ist
      **nie gelaufen** — er ist an der Fixture gescheitert, bevor ein Assert erreicht
      war. **Die Dauer ist das Signal**, und es steht in der Testausgabe.
      Bei 33 roten Tests **immer zuerst die Dauer ansehen**, bevor man über Code spricht.
      Das hat hier einen falschen Alarm und eine falsche Rückschlussnahme verhindert.

- [ ] **ENV2 — vor jedem E2E-Lauf auf diesem Host den Browser prüfen, oder den Lauf
      als ungültig verwerfen.** Ein Lauf, der erst am Browser scheitert, hat **keine
      Aussage** über `workers`, über Flakes oder über den Code. Das ist billig:
      `ls /home/dev/.cache/ms-playwright/` ist leer → der Lauf zählt nicht.
      *Und die Reparatur ist teuer:* 114 MB Download, während die Unit-Suite in
      90 Sekunden fertig ist. **Ein Befund, der auf einer fehlenden Datei beruht, ist
      teurer zu korrigieren als zu verhindern.**

- [ ] **ENV3 — und dieselbe Prüfung für die Screenshot-Suite**, sonst gilt dasselbe:
      118 PNGs aus einer Suite, deren Browser fehlt, wären **118 leere oder
      halb gerenderte Bilder** — und der Harness meldet „passed".

---

## Der vorgeschlagene Speicherhebel ist **widerlegt** — von mir selbst gemessen

Der Crash-Jäger hatte aus einer **richtigen** Messung eine **falsche** Schlussfolgerung
gezogen: Chromium-Peak-RSS **1189 MB** mit `trace`+`video` gegen **657 MB** ohne, also
„schalte die Aufzeichnung ab". Die Zahlen stimmen. Die Kette stimmt **an der Stelle
nicht, an der es zählt.**

**Mein Paar-Lauf, gleiche Suite, nur die Aufzeichnung verschieden:**

| Lauf | Ergebnis | `memory.current` Peak | Anteil an 5120 MB |
|---|---|---|---|
| A: `--trace=off` | **44 passed**, rc=0 | 5368655872 | **99,999 %** |
| B: wie konfiguriert | **44 passed**, rc=0 | 5364957184 | 99,93 % |
| `oom_kill` vorher → nachher | — | **3 → 3** | **kein Kill** |

Der Unterschied ist **3,7 MB = 0,07 %.** **Trace-Aufzeichnung abzuschalten kauft auf
diesem Host keinen einzigen KB Luft.** Die Empfehlung ist **nicht** umgesetzt worden und
**darf nicht** umgesetzt werden.

### Warum die Schlussfolgerung kippte — die Regel ist das eigentliche Ergebnis

> **Ein Komponenten-Peak sagt nichts darüber, ob eine Grenze überschritten wird.**

Die Grenze ist nicht „wie viel braucht Chromium", sondern **wie viel ist insgesamt da** —
und das sind laut Messung **3,1–3,5 GB Page-Cache**, 0,9–1,6 GB `anon`, 0,4 GB Kernel,
plus `opencode`, `codegraph` und die `node`-Prozesse. **532 MB aus einem 5120-MB-Budget
zu streichen, während der Rest bereits ~4,5 GB belegt, ist eine Rundung.**

Das ist verzeihbar, weil die Komponentenmessung die *greifbare* ist — sie hat eine Zahl
für das Ding, das man ändern wollte. **Die Gesamtmessung hat eine Zahl für das Ding, das
tatsächlich begrenzt.** Und sie ist genauso billig: `cat /sys/fs/cgroup/memory.current` in
einer Schleife.

- [ ] **ENV6 — bei jedem Speicherproblem **beides** messen, nie nur eines:**
      ```bash
      sort -n /tmp/opencode/p.txt | tail -1   # Peak von memory.current
      cat /sys/fs/cgroup/memory.events         # oom_kill, VOR und NACH
      ```
      **Und die Reihenfolge ist Teil der Regel:** erst der **Gesamtpeak** gegen
      `memory.max`, dann die Aufteilung. Wer mit der Aufteilung beginnt,optimiert das
      Falsche — und zwar mit einer Zahl, die **stimmt**.

- [ ] **ENV7 — `trace: "retain-on-failure"` bleibt, unverändert.** Zur Klarstellung, weil
      es leicht für einen Fehler gehalten wird: `retain-on-failure` **zahlt die
      Aufzeichnungskosten auf jedem Test** und verwirft erst danach. Der Preis ist also
      **immer** da, nicht nur bei Fehlschlägen. Das ist der Grund, warum der Hebel
      überhaupt nahelag — und der Grund, warum er trotzdem **nichts** bringt.

- [ ] **ENV8 — und der Zustand, in dem wir gerade sind, ist besser als er klingt:**
      **zwei Läufe in Folge 44/44, `oom_kill` unbewegt.** Der Absturz ist selten. Die
      Erklärung „Kernel opfert den Renderer" bleibt die beste, ist aber **unbeobachtet** —
      in **440** Testausführungen hat sich `oom_kill` **kein einziges Mal** bewegt. Also:
      **plausibel, nicht bewiesen**, und die Diskriminator-Zeile ist weiterhin
      `oom_kill` vor und nach dem Lauf.

- [ ] **ENV9 — Zwei Zahlen, die nur dieser Host trägt, und die deshalb NICHT in
      `AGENTS.md` gehören** (`Agents.headless.md` §Grundsätze: „Zahlen und Messungen nie
      hierher übernehmen"): `memory.max` 5120 MB, 3× `oom_kill` in dieser Sitzung.
      Was **allgemein** ist und deshalb in `AGENTS.md` darf, steht als **Regel** dort:
      *Ein projektweises Speicherlimit macht eine grüne Suite zur Zufallsaussage über
      den Host.* Keine Zahl, nur die Aussage, die die Zahl trägt.

---

## `scenarios.e2e.ts:385` — behoben, und meine Diagnose war **unvollständig**

Der Flake (4 von 8 Läufen) hatte eine falsche **Prämisse im Kommentar**. Erster Befund von
mir: der Test behauptete „retryable", der Code sage `false`. **Das war unvollständig, und
der Build-Agent hat mich korrigiert** — nachgelesen, nicht übernommen:

```ts
case "success":
case "no-response":
// A local configuration error. Repeating a request that was never
// configured produces the identical error; §5.4's rule for `invalid_api_key`
// — "Key ist falsch, nicht kaputt" — applies verbatim.
case "config-error":
  return false;
```

Der Kommentar steht **zwischen** `no-response` und `config-error` und sagt *„A local
configuration error"* — er gehört zu `config-error`. **Es gibt keine §5.4-Regel über
`no-response`.**

> **Mein Brief stellte es dar, als widerspreche der Code einer vorhandenen Regel. Es
> widersprach keiner — die Regel war nie da.** Der Test war gegen ein **erfundenes**
> Verhalten geschrieben.
>
> Das ist die **stärkere** Diagnose, und ich hatte die schwächere: „der Test ist falsch"
> hätte man mit einer Codeänderung beantworten können. „der Test prüft eine Regel, die es
> nicht gibt" heißt: **der Test prüft nichts**, und es gibt keinen Fix am Code.

### Die Behebung: das Fenster wird **hergestellt**, nicht **erwartet**

- `e2e/support/pacer.ts`: ein neues Op `{ op: "gate" }` — armt ein einmaliges Budget von
  0 für den **nächsten** Stream. Nötig, weil `release` sein Budget aus `last().emitted`
  bildet und deshalb nur einen **bereits existierenden** Stream gaten kann.
  ⚠️ **Und damit ist eine Behauptung aus meinem Auftrag widerlegt:** ich hatte geschrieben,
  „der Pacer kann die zweite Anfrage nicht allein gaten". Für `release` war das **wahr**,
  für den Pacer **falsch**.
- `e2e/scenarios.e2e.ts:369-462`: die Fortsetzung wird mit `gate` **offengehalten**, und
  `await expect.poll(async () => (await pacer.state()).gated).toBe(true)` ist die
  **Tatsache**, mit der das Fenster entsteht — **bevor** die Status-Assertions laufen.

**Warum das die richtige Richtung war und nicht „langsamer machen":** Das Fenster war
Millisekunden groß und hing an der Maschinengeschwindigkeit. Jetzt ist es ein **Zustand**,
den der Test **selbst herstellt** und **selbst prüft**, bevor er die eigentliche Behauptung
prüft. **Ein Test, der sein eigenes Fenster baut, ist auf anderen Rechnern genauso
zuverlässig wie auf diesem.**

- [ ] **T1 — das Annahmekriterium, und es ist die Mutation.** Der Test muss an
      *„beim Fortsetzen `idle` publizieren"* sterben. Gemessen, zwei Varianten:
      | Mutation | Ergebnis |
      |---|---|
      | `publish({status:"idle"})` beim Fortsetzen | **rot**, `element(s) not found` (Z. 447) |
      | `running` **für einen Tick**, dann `idle` | **rot**, dieselbe Assertion |

      **Und das Detail, das die Mutation glaubwürdig macht:** in **beiden** Läufen waren die
      beiden Vorbedingungs-Waits (`countFor === 2`, `gated === true`) **bereits grün**. Er
      stirbt also an der **Statusbehauptung** und nicht an einem Timeout. *Ein Test, der an
      seiner Vorbedingung stirbt, prüft die Vorbedingung.*
- [ ] **T2 — Läufe: 16× grün, 2× an der Mutation korrekt rot.** 5× isoliert
      (2,5–3,1 s), 6× volle Suite (44/44). Der alte Test hatte **10 s** Polling-Budget für
      eine Behauptung über **Millisekunden**; der neue braucht **2,4 s** stabil.
- [ ] **T3 — `gate` ist additiv.** Die anderen Pacer-Aufrufer nutzen nachweislich nur
      `delay`/`release`/`releaseAll`/`errorAt` (grep). `harness-self-test.e2e.ts` lag in
      allen 6 vollen Läufen grün — **gemessen**, nicht argumentiert.

### Und eine **Methode**, die ich übernehme

Der Agent musste einen roten Screenshot-Test einordnen, der **nicht seiner** war
(`screenshot chat-todo (filled, mobile)`, und `manifest.ts:544` wartet auf ein
Sidebar-Element im **mobile**-Viewport — also exakt das `viewport.ts`/`sidebarOpen`-Thema
des **parallelen** U1-Agenten).

Er hat nicht behauptet, dass er nicht schuld ist. Er hat es **bewiesen**:

> **Mit seinen beiden Dateien per `git stash` aus dem Baum reproduziert der Fehler
> weiterhin.**

→ **FREMDURSACHE-BEWEIS (Methode, ab hier verbindlich):** Wer einen Fehler **nicht**
verursacht zu haben glaubt, **belegt** es, indem er seine eigenen Änderungen
**entfernt** und der Fehler **weiterhin** auftritt. „Ich war's nicht" ist eine Behauptung,
„der Fehler ist ohne meine Änderungen derselbe" ist ein **Experiment**. Beides klingt nach
Verantwortungsfreiheit, aber nur eines ist eine Aussage.

- [ ] **T4 — und die Umkehrung, die derselbe Report liefert:** `tsc --noEmit` war
      **zwischenzeitlich rot** (3 → 1 Fehler) — der parallele U1-Agent hat den Baum
      angefasst. Der Test-Fix-Agent hat **gewartet**, bis `tsc` sauber war, und danach
      **nochmal** 5× isoliert plus 1× volle Suite gefahren. Das ist `H1` in der Praxis:
      **ein Lauf, während ein Agent schreibt, ist keine Messung.**
      ⚠️ **Und die Einschränkung, die er selbst genannt hat und die bleiben muss:** er
      kann **nicht** sagen, dass jeder seiner Läufe denselben Baumstand hatte. Das ist
      eine Lücke, die er nicht schließen konnte, und er hat sie **benannt** statt sie zu
      übergehen.

---

## U1 behoben und **von mir am Bild verifiziert** — und der beste Fund der Sitzung

**Collapsed Drawer unter 1024 px.** Desktop **unverändert**, von mir am Bild geprüft:
zweispaltig, kein Menü-Knopf, kein Header-Badge, dieselben Karten. Über 1024 px ändert
**keine** Klasse.

### Meine Warnung wurde **gemessen**, nicht bestätigt

Ich hatte geschrieben, `min-w-0` allein löse es vermutlich nicht. Der Agent hat **genau
diesen Einzeiler** angewandt und bei 390×844 gemessen: linke Spalte **weiterhin 0 px**,
Composer **24 px**, Textarea **26 px**, `elementFromPoint(Senden)` **weiterhin** die
Sidebar.

> **Aus einer Vorsicht wird eine Messung, indem jemand sie ausprobiert.** Ich hatte
> „vermutlich nicht"; er hat „gemessen: nicht". Das ist der Unterschied zwischen einer
> Warnung und einem Befund, und er ist nur eine Zeile Arbeit wert.

### 390×844, vorher und nachher

| | vorher | nachher, Drawer zu | nachher, Drawer auf |
|---|---|---|---|
| linke Spalte | **0 px** | **390 px** | 390 px (hinter dem Overlay) |
| Composer | 24 px | 390 px | 390 px |
| Textarea | 26 px | 273 px | 273 px |
| `elementFromPoint(Senden)` | die Sidebar | eigene Zeile | Sidebar (Overlay, korrekt) |
| **schmalster Umbruch** | **7 Zeichen/Zeile** (93 Zeichen auf 17 Zeilen) | **50 Zeichen/Zeile** | 44 Zeichen/Zeile |

> **Zeichen pro Zeile ist das ehrlichere Maß als die Spaltenbreite.** Eine Spalte mit
> „40 px Breite" kann kaputt sein, wenn der Absatz auf 8 Zeichen umbricht — und eine
> Spalte mit „390 px" kann in Ordnung sein, wenn sie 390 px **bedeckt** (siehe unten).

### ⭐ Der Fund, für den es die Harness gibt

> **Der Drawer hatte die richtige Breite, 320 px und 44 Zeichen/Zeile — war aber
> transparent, und der Transcript schien durch ihn hindurch.**

**Alle Messungen sagten, die Behebung funktioniert.** Nur das Bild zeigte, dass der
Nutzer den Transcript **durch** die Sidebar sieht. Gefixt mit `max-lg:bg-base-100`.

**Eine Bounding Box kann nicht sagen, ob ein Hintergrund transparent ist.**

Damit sind die **zwei** Fehlerklassen einer Messung benannt, und sie sind verschieden:

| | Fall | Beispiel aus dieser Sitzung |
|---|---|---|
| **(a)** | Messung **richtig**, Bericht **falsch** | „linke Spalte 0 px" → gemeldet als „jeder Klick ist tot". Der Schweregrad ging beim Übersetzen in Prosa verloren. |
| **(b)** | Messung **richtig** und **unzureichend** | Breite 320 px, korrekt; **Deckkraft** transparent, defekt. Es gab **keine** Größe, die gefragt werden musste. |

> **(a) ist ein Berichtsfehler. (b) ist eine Grenze der Messmethode — und (b) ist der
> Grund, warum es diese Harness gibt.** Nicht, weil sie Defekte findet: die findet jeder
> Bildvergleich. Sondern weil sie die Frage stellt, die man sich sonst **nicht** stellt.
> Man misst Breite, weil Breite das ist, was man leicht messen kann — und dann ist die
> Breite grün, während der Nutzer etwas sieht, das es nicht gibt.

### Und die unbequeme Hälfte: ich habe die Bilder **nicht** gelesen

Der Harness hatte den nächsten Defekt **schon lange** im Satz:
`screenshot chat-question` überlappt die Statusleiste um **16 px** — bei **390 px** und bei
**1280 px**, **identisch**. Also **viewport-unabhängig** und **vorbestehend**, und
sichtbar auf `filled/desktop/chat-question-sec0.png`, seitdem ich die Datei habe.

**Ich habe 118 Bilder erzeugt und 4 gelesen.** Welle 3 „abgeschlossen" zu melden wäre
gelogen gewesen: der **Verifikations**schritt — der Blick drauf — war nie getan.

- [ ] **U8 — `chat-question` überlappt die Statusleiste um 16 px. Desktop UND Mobil.**
      Gemessen: der Scroll-Viewport des Transcripts fällt auf `clientH 24 / scrollH 159`
      zusammen, weil `QuestionCard` ein **schrumpfbarer** Geschwister in einer
      `h-screen`-Spalte ist. **Nicht behoben**, weil eine Behebung Desktop-Pixel
      verändert — und das ist die richtige Entscheidung. Jetzt behoben werden **darf** es.
- [ ] **U9 — `chat-todo (filled, mobile)` schlägt fehl: 45 passed, 1 failed.**
      Gemessen: `prepare` wartet auf `[data-baah-todo-status]`, **ohne** den Drawer zu
      öffnen. `countBefore: 0`, nach **einem** Klick auf `baah-toggle-sidebar`
      `countAfter: 3`, sichtbar, Behauptung intakt. → **Ein Klick im Manifest fehlt.**
      ⚠️ Dass das resultierende Bild richtig wird, ist **vermutet** — der Agent hat
      `chat-todo` **nicht** neu aufgenommen. *Eine Behauptung über ein Bild, das niemand
      aufgenommen hat, ist keine.*
- [ ] **U10 — und die vier vormals unerreichbaren States sind jetzt **alle vier** mobil
      erreichbar** (gemessen, nicht behauptet): Reasoning-`<summary>` klickbar
      (`details.open === true`), `baah-open-settings` klickbar, Export-Checkbox klickbar,
      Key-entfernen klickbar mit sichtbarem Composer-Hinweis.
      **Dabei fand der Agent etwas, das niemand gefordert hatte:** der Einstellungs-Knopf
      wäre auf Mobil eine **tote Kontrolle** gewesen — er hätte einen Boolean umgeschaltet,
      der in eine **nicht gemountete** Sidebar rendert. Er öffnet jetzt den Drawer, der
      sie enthält. **Das ist der Unterschied zwischen einem Layout, das hübsch aussieht,
      und einem, das funktioniert.**

---

## ✅ DER ABSTURZ IST BESTÄTIGT — und ich habe ihn **selbst** ausgelöst

Der Crash-Jäger hat in **440** Ausführungen keinen OOM gesehen und die Hypothese folglich
korrekt als **unbewiesen** markiert. Bestätigt ist sie jetzt, mit **Beobachtung,
Gegenprobe und Diskriminator**:

| Lauf | Worker | Ergebnis | `oom` |
|---|---|---|---|
| A: `CI=1` (4 Renderer parallel) | **4** | 45/46, `Target crashed` | 3 → **5** |
| B: lokal | **2** | **46/46**, rc=0, 1,9 min | **5 → 5** |

**Ausgelöst habe ICH es**, mit `CI=1`, um den 4-Worker-Pfad zu prüfen. Vier Chromium-
Renderer parallel auf einem geteilten Host, dessen cgroup bei **99,99 %** von 5120 MB
stand — und `error-storage-session` stirbt an `Target crashed` **direkt nach einem
`page.reload()`**, also mitten im schwersten Moment, den ein State überhaupt hat.

→ **Die Konfiguration ist richtig und war nie das Problem.** `process.env.CI ? 4 : 2`
heißen 4 auf einem Runner mit eigenem cgroup und **2** auf `code-dev`. Ich habe den
**CI-Wert auf der lokalen Maschine getestet**, weil ich den Pfad verifizieren wollte.
*Ein Testlauf unter den falschen Randbedingungen ist kein Testlauf, sondern ein Befund
über den Testlauf.*

- [ ] **ENV10 — `workers: process.env.CI ? 4 : 2` bleibt exakt so, und der Grund ist jetzt
      belegt statt behauptet:** lokale 2 wegen des geteilten cgroup, CI-4 wegen des eigenen
      Budgets des Runners. **Vorher** stand dort eine Begründung, die ich nicht gemessen
      hatte; sie war richtig, aber aus dem richtigen Grund.
- [ ] **ENV11 — `Page crashed` und `Target crashed` sind auf diesem Host dasselbe
      Ereignis**, in zwei Suiten. Beidemal: Renderer-Opfer. **Und beidemal sah es aus wie
      ein App-Absturz**, was es nicht war. → *Ein Absturz ohne Kontext ist ein Symptom; ein
      Absturz mit laufendem `oom`-Zähler ist ein Befund.*
- [ ] **ENV12 — die Regel, die daraus folgt und die ich lange gehabt haben will:**
      **Der Diskriminator gehört in den Ablauf, nicht in eine Notiz.** Der Jäger hat
      `cat /sys/fs/cgroup/memory.events` **vor und nach jeder** Messung gelesen und es als
      Ein-Zeilen-Kommando genannt — er hat nur nie einen Lauf erwischt, der ihn auslöst.
      **Eine Diagnose, die man nicht reproduzieren kann, ist trotzdem eine Diagnose, wenn
      sie sagt, woran man sie erkennt.** Ohne diese Zeile hätte ich `Page crashed` noch
      heute als „unbekannter App-Absturz" geführt.

---

## ⭐ Unabhängiger PWA-/Speicher-Audit über die **ganze** Historie — 17 Befunde

Beauftragt vom Nutzer („Ausnahme heute: alles"), gelaufen in **eigener Session**,
`HEAD = 1fb9821`, 61 Commits. Zwei `critical`, vier `high`, sieben `medium`, fünf
`low`. **Der Prüfer hat mich an drei Stellen korrigiert** — die wichtigste zuerst.

### 🔴 B1 — mein Gate hat `main` **rot** gemacht (critical)

```text
pnpm check → exit 1, 12 × TS2591/TS2339
scripts/browser-only.ts:53   Cannot find name 'node:fs'
test/browser-only.test.ts:35 dito
```

`baah-web/tsconfig.json` hat `"types": ["vite/client"]` und **kein** `@types/node`, und
der Test zog das Skript über den Import mit ins Programm. **Folge: `pnpm test` startete
nie**, weil `check` mit `&&` verkettet ist — die 414 Unit-Tests waren nur grün, wenn man
sie einzeln aufrief.

**Das ist die siebte Instanz derselben Fehlerklasse: etwas ausgeliefert, das den
verpflichtenden Prüfbefehl unbenutzbar macht.** Bei dreien davon war es ein Agent, der
etwas gebaut hat; **diesmal war es mein eigenes Gate**, in derselben Sitzung, im Commit
direkt davor.

- [x] **behoben**: das Modul ist **Node-frei** (`scripts/browser-only.ts` importiert
      nichts), der Dateibaum wandert nach `scripts/check-browser-only.mjs` (Plain JS, kein
      Compile-Schritt). `pnpm check` rc=0, **1876** Unit-Tests, 0 Typfehler.
      → **Strukturell, nicht kosmetisch: die reine Logik eines Gates ist der Teil, den man
      testen will**, und ein Scanner-Test, der ein Dateisystem braucht, wird übersprungen,
      sobald das Dateisystem unbequem ist.

### 🔴 B2 — es gibt **keine** installierbare PWA (critical)

`public/` existiert nicht. `dist/` = 16 Dateien: 1 HTML, 1 CSS, 13 JS, 1 WASM, und
**null Bilddateien**. 0 Treffer für `serviceWorker|manifest|workbox` im ganzen Repo, 0 für
`beforeinstallprompt|appinstalled|display-mode|standalone`. Kein Favicon.

### 🟠 B3 — der Projektordner ist **überhaupt nicht verdrahtet** (high)

**Meine Formulierung „nicht die Wahrheitsquelle" war zu schwach.** Gemessen:

```text
showDirectoryPicker in src/            0 Aufrufe
createFileSystemAccessWorkspace        nirgends konstruiert
runtime.ts:336   workspaceMode: "memory"   (String-Literal)
AppShell.tsx:381 onWorkspace={() => undefined}
AppShell.tsx:556 onOpen={() => undefined}
WorkspacePanel.tsx:120  disabled={… mode !== "local-directory"}   → immer disabled
```

Es ist nicht „nicht die Quelle", es ist **keine Quelle**. Und die UI **behauptet** dem
Nutzer `mode = "memory"`, was für die Datenbank falsch ist.

### 🟠 B4 — meine „Plattformgrenze"-Begründung war **falsch** (high)

Ich schrieb in `AGENTS.md` §2a: *„`FileSystemSyncAccessHandle` … den gibt es **nur in
OPFS**."* **Falsch.** Die Methode existiert auf *jedem* `FileSystemFileHandle`;
**beschränkt sind die Dateien** — der Spec (§2.3.3) lässt den Aufruf außerhalb eines
*„bucket file system"* mit `InvalidStateError` scheitern.

Und es fehlte ein **zweiter, unabhängiger** Blocker, der die eigentliche Grenze ist:
`@sqlite.org/sqlite-wasm` hat **keinen VFS, der ein Handle annimmt**
(`installOpfsSAHPoolVfs({directory})` will einen String-Pfad **innerhalb** OPFS). Das ist
eine **Bibliotheks**-grenze mit einem Ausweg (`wa-sqlite`, eigener VFS), nicht Physik.

> **Wer eine Bibliotheksgrenze für Physik hält, schließt die Baustelle — und prüft nie
> den Ausweg.** Die falsche Begründung ist gefährlicher als der falsche Schluss, weil
> sie die **Suche** einstellt statt das Ergebnis.
→ §2a und `Plan.md` §17.3 trennen jetzt **Plattform** / **Bibliothek** / **nicht gebaut**,
  und eine als „Plattformgrenze" bezeichnete Bibliotheksgrenze gilt als **ungemessen**.

### 🟠 B5 — `Plan.md` widersprach **sich selbst** über den PWA-Gewinn (medium)

§822-824 behauptete, eine installierte PWA behalte Datei-Freigaben „ohne erneute
Rückfrage". §1129-1131 im **selben Dokument** sagt das Gegenteil, und die
Chrome-Doku bestätigt es: *„until all tabs for its origin are closed. Once a tab is
closed, the site loses all access."*

> **Damit gibt es keinen belegten PWA-Gewinn für die Freigabe** — und genau das erklärt,
> warum die Ordner-Freigabe nicht die kritische Eigenschaft ist. Die kritischen sind: die
> Daten liegen im Ordner, und die App ist installierbar und offline lauffähig.
Ob es eine installationsgebundene Berechtigungslogik gibt, ist **nicht gemessen** und
wird **nicht behauptet** — offenes Gate.

### 🟠 B6 — der Schutz sitzt auf einem Pfad, den niemand geht (medium)

`storage.persist()` steht in `baah-core/src/workspace/opfs.ts` (3 Treffer, alle dort) —
und **diese Funktion wird nie gerufen**. Für die **Datenbank**, die in OPFS liegt, wird
der Schutz **nie** angefragt. `Plan.md` §1136 begründet ihn als Voraussetzung dafür, dass
OPFS überhaupt eine Wahrheitsquelle *eines Geräts* ist.

### 🟠 B7 — meine Gate-Korrektur war nur halb gezogen (medium) — **die beste Lehre**

Ich hatte in `1fb9821` dokumentiert: *„ein Import-Specifier ist **immer** ein String-
Literal, und ein strippendes Gate ist für `node:fs` **blind**"*, und die Konsequenz **nur**
für `FORBIDDEN` gezogen. **Für `REQUIRED` nicht.** Und dort lagen zwei reine
String-Alternativen:

```text
### browser-database via specifier string
  stripped: 'import x from                        ;'    ← String-Inhalt gelöscht
  missing : filesystem-access, origin-private-storage, database-off-main-thread, web-storage
```

**`browser-database` fehlte trotz echtem `import … from "@sqlite.org/sqlite-wasm"`.**
Derselbe Fehler, eine halbe Datei entfernt, und ich hatte ihn gerade erst behoben.

> **Ein Gate muss lesen, **wie** die gesuchte Sache geschrieben wird.** Ein Aufruf ist
> Code, ein Import-Specifier ein String, ein Query-Parameter ein String. Drei Formen,
> zwei Regeln (`code` / `specifier`). Und: **ein Gate, das bei *Abwesenheit* lügt, wird
> genauso ignoriert wie eines, das bei *Verstößen* lügt** — der Fehler fällt nur nicht
> auf, weil nichts rot wird.

### 🟠 B8 — Gate-Lücken, die der Prüfer gefunden und ich geschlossen habe

| Lücke | geschlossen |
|---|---|
| `filesystem-access` war durch OPFS' eigenes `getFileHandle()` erfüllbar — eine App **ohne** Ordner bestand das Kriterium | eigene Fähigkeit `project-folder`, **nur** `show*Picker` |
| `fetch("/api/…")` auf die eigene Origin war erlaubt | Regel `own-origin-fetch` (Pfad-relativ, kein `//`) |
| `Buffer` war nicht verboten, obwohl §2 es wörtlich nennt | Regel `node-buffer` |
| nacktes `process` ohne `.` | Muster auf `\bprocess` |
| Ausgabe zählte „4 package trees" bei **13** `src/`-Bäumen; die drei Zahlen widersprachen sich | eine Zahl, aus dem Pfad abgeleitet, plus Selbsttest |

### 🟠 B9 — meine Messungen, die **falsch** waren

| Meine Angabe | Gemessen |
|---|---|
| „`queryPermission`/`requestPermission`: **0 Treffer** über `packages/*/src`" | **14 Treffer**, 13 davon Code in `baah-core/src/workspace/file-system-access.ts`. `0` gilt nur für `packages/baah-web/src`. **Schlussfolgerung blieb richtig** — `assertHandlePermission` wird von niemandem gerufen — **die Zahl trug sie nicht.** |
| „Sessions liegen in OPFS, nicht im Projektordner" | richtig, aber **zu schwach**: es ist nicht „nicht die Quelle", es ist **überhaupt keine** (B3) |
| „`public/manifest.webmanifest` FEHLT" | richtig und **schwächer** als möglich: `dist/` hat **null** Bilddateien |

### 🟡 B10 — `dist/assets/worker-KjvADLM3.ts`: 20 738 Byte **untranspiliert** ausgeliefert

Und **referenziert** von `dist/assets/src-24UO2SWA.js`. Ursache: der `exports`-Eintrag
`"./worker": "./src/worker.ts"` zusammen mit `?worker&url`. **Vor** dem Precache-Block
(B2) zu beheben — sonst baut man den Service-Worker-Cache mit Müll.

### 🟡 B11 — kleinere Befunde

- `index.html`: `<title>opencode-harness-web</title>` (der Commit `1dc13dd` hat auf
  `baah` umbenannt) und `lang="en"` bei durchgehend deutscher UI-Prosa (§5).
- `§2`s Begründungsabsatz zur Test-Harness-Ausnahme hing nach dem Einfügen von §2a/§2b
  als **Schluss von §2b** → eigene Überschrift.
- `collectSources` scannt `packages/baah-web/vite.config.ts` mit (86 statt 85), obwohl der
  Docstring `src/**` sagt. Bewusst behalten — eine Config-Datei ist ausgelieferter Code
  — aber der Docstring wurde korrigiert, damit die Zahl erklärbar bleibt.

### Der Prüfer hat **nicht** geprüft — und das ist der Grund für §2b

`pnpm e2e` und `pnpm build` als eigene Schritte (beide brechen vorher ab), und **sieben
manuelle Gates**: installierte PWA auf echtem Gerät · Reload nach Kaltstart · überlebt
die Ordner-Freigabe · `storage.persist()` im echten Browser · „Website-Daten löschen",
Deinstallation, Gerätewechsel · zweiter Tab gegen `opfs-sahpool` (vom Code selbst als
`UNVERIFIED` markiert) · ob der echte OPFS-Pfad im Browser bootet.

**Commit-Range für den nächsten Lauf:** siehe Commit-Message. Nächster Prüfer-Commit ist
der Stand **nach** diesem Block.

## Abgehakt

*(nach unten wandern, mit Commit-Referenz)*

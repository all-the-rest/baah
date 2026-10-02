# agents.todo.md — offene Punkte für `baah`

> # 🗄️ Projekt eingestellt, 2026-10-02
>
> **Dieses Repo ist archiviert. Die Liste bleibt als Dokumentation stehen, nicht als
> Arbeitsauftrag.**
>
> **Der Grund:** Gewollt war, Rust-Projekte mit **echten Dateien und echten
> Compilern auf der Platte** zu bearbeiten. Das braucht einen nativen Prozess, und
> **Browser können keinen starten** — ein Tab läuft in einer Sandbox ohne
> Syscall-Zugang zum Betriebssystem. Kein `fork`, kein Subprozess, kein
> Ausführen eines Binarys.
>
> **Die Bedingung, an der es gescheitert ist, stand hier von Anfang an:** die
> Welle-4-Liste unten (`shell`, `git`, `task`, `skill`) war nicht umsetzbar, und
> `shell` stand dort als **„🔒 Phase 4"** markiert — als wäre es eine Frage des
> Aufwands. **Es war eine Frage der Plattform, und das steht jetzt im README.**
>
> ⚠️ **Ich habe diese Grenze zu spät erkannt.** `Plan.md` §14.5 hatte sie bereits
> **abgeschlossen** und gemessen beantwortet — ich habe die Datei erst gelesen,
> nachdem der Nutzer nach der Shell gefragt hatte, und bis dahin „Browser-only" als
> **geprüfte Randbedingung** behandelt statt als **unverhandelbare Grenze, die
> die Produktidee selbst definiert**. Das war der teuerste Fehler dieser Sitzung,
> und er war keiner der Agenten: **die Antwort stand die ganze Zeit im Spec.**

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

## Stand (01.10.2026) — gemessen, nicht geschätzt

```
pnpm check          rc=0   1966 Unit-Tests in 13 Paketen   0 Typfehler
pnpm e2e            rc=0   44/44 in 1,8 min
pnpm build          rc=0   Precache listet 22 Assets
check:browser-only  rc=0   keine Serverform · 5/5 Fähigkeiten
```

**Die CI ist zum ersten Mal auf `HEAD` gelaufen** — 16 Commits lagen vorher ungepusht,
`origin/main` war 21 Commits zurück. Lauf `36853882192`, alle drei Jobs grün:

```
quality  47 s   e2e  2 m 33 s   ci  3 s
```

→ **Das war ein Befund, kein Ritual:** die CI hatte die PWA-Arbeit, das Browser-only-Gate,
die Screenshot-Harness und das Projekt-/Konversationsmodell **nie gesehen**. `AGENTS.md` §8
trägt jetzt „regelmäßig pushen" statt „nur auf Anweisung", mit den zwei Prüfungen, die
davor laufen müssen.

**`main` ist bewusst NICHT branch-protected** — vom Nutzer am 01.10. entschieden. Die
`ci`-Aggregate-Job bleibt, weil sie einen abgebrochenen Lauf nicht als grünen aussehen
lässt, aber **niemand** trägt sie als Required Check ein.

### Vier Punkte dieser Liste, die ich **nachgemessen** habe, statt sie zu glauben

| Punkt | Behauptung in dieser Liste | Gemessen |
|---|---|---|
| **U5** | `chat-stall` und `chat-streaming` sind byte-identisch | **erledigt** — md5 `76915ba3…` vs. `81eeadc6…` |
| **U6** | `error-stream-cut` zeigt „Versuch 1 von 3" | **erledigt** — das Bild sagt **„Versuch 3 von 3"** |
| **U9** | ein Klick im Manifest fehlt (`chat-todo` mobil) | **erledigt** — `manifest.ts:555-559` öffnet den Drawer bedingt; die Notiz nennt den alten Fehler ausdrücklich als *regression* |
| **U10** | die vier vormals unerreichbaren States | **erledigt** — laut Übergabe gemessen, alle vier mobil erreichbar |

**Zwei davon standen als `[ ]` offen und waren es nicht.** Eine Liste, die Erledigtes als
offen führt, ist nicht „vollständig" — sie ist **falsch**, und das ist teurer als eine
Lücke, weil man sie abarbeitet.

### U8 — gemessen, und schwerer als diese Liste sagt

Ich habe eine Wegwerf-Probe gegen die **echte gebaute App im echten Browser** laufen lassen
(1280×800 und 390×844), eine Fragekarte offen:

| | Desktop | Mobil |
|---|---|---|
| Fragekarte | y 64–595 (**531 px**) | y 81–612 (**531 px**) |
| Statusleiste | y 49–73 | y 81–105 |
| **Überlappung** | **9 px** | **24 px** |
| `elementFromPoint` auf der Statusleiste | `SPAN.badge` | **`SECTION…bg-info/10` = die Fragekarte** |
| Transcript-Viewport `clientH / scrollH` | **24 / 159** | **24 / 159** |

Drei Dinge, die vorher nirgends standen:

1. **Mobil sind es 24 px, also die volle Höhe der Statusleiste** — sie ist dort
   **komplett verdeckt**. „Versuch 1 von 3" sieht ein Mensch am Telefon **nie**.
2. **Die Überlappung ist nur das Symptom.** Der Transcript-Viewport fällt auf **24 px** bei
   **159 px** Inhalt — **15 % sichtbar**. Wer nur die Überlappung behebt, repariert ein Bild
   von 24 px.
3. **Ursache:** `QuestionCard` ist ein `<section>` **ohne jede Flexklasse** — also
   `min-height: auto` und deshalb **531 px nicht schrumpfend** — als Geschwister von
   `Transcript` (`flex min-h-0 flex-1`, `flex-basis: 0`). Der Transcript absorbiert das
   gesamte Defizit, weil er der einzige ist, der schrumpfen **kann**.

⚠️ **Und H1 hat mich dabei live erwischt:** mein Wegwerf-Probe hatte *einen* falschen
Eigenschaftsnamen (`process.stdout` unter `"types": []`), `tsc --noEmit` war rot, und die
**gesamte 44-Test-Suite startete nicht**. Wörtlich: `[WebServer] Command failed with exit
code 1`. Genau der Befund — und er kostete eine Messung, um ihn zu bestätigen, statt ihn
aus dem Quelltext zu schließen.

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
- [x] **Tool-Registry befüllen**: alle 8 Tools in eine Registry, eine Instanz pro Session
- [x] **Engine ↔ Storage verdrahten**: `onStepEnd` → `flushDelta`, Turn-Ende → `idle`-Nachricht.
      **Nachgemessen 01.10.:** die hier notierte Lücke („`flushDelta` wird vom Loop bis heute
      nicht aufgerufen") **gilt nicht mehr** — die Aufrufstelle liegt in `runtime/index.ts`.
- [x] ~~**Reload-Recovery**~~ — `listUnfinishedTurns`, `STALE_HEARTBEAT_MS`, `recoverStaleTurns`
      implementiert **und** beidseitig getestet (30 s: `>=` ist stale), **und** der Aufruf beim
      Start liegt. E2E „the transcript survives a reload — §1's DoD 4, against real SQLite in
      OPFS" ist grün.
- [x] **Tool-Idempotenz**: `tool_invocations.status` `begun | done`, **Vier-Teil-Schlüssel**
      `UNIQUE` in der Tabelle, `beginToolCall` ist `DO NOTHING`, `recordToolCall` ein Upsert.
- [x] **Provider-Registry**: OpenAI, Anthropic (mit `anthropic-dangerous-direct-browser-access`),
      Google, OpenAI-kompatibel — `runtime/testing.ts` treibt eine echte `ProviderRegistry` mit
      Fakes, damit der **awaitete** `resolve` geprüft wird.
- [ ] **Modellkatalog** — ⚠️ **die Begründung in `Plan.md` §14.4 ist widerlegt**: `/v1/models`
      ist der einzige Endpunkt mit CORS `*` und löst das **ohne** das 6,35-MB-Bundle. Die Frage
      „Bundle streichen oder als Fallback behalten?" ist damit beantwortet: **streichen**.
      Wird mit **Block P** gebaut (`/v1/models` + Anthropic-Pagination), nicht hier.
- [x] **Retry mit Backoff** angebunden: 0 s / 2 s / 8 s, ±25 % Jitter, `Retry-After` gewinnt,
      max. 3 Versuche — `runtime/watchdog.test.ts` prüft es gegen die Klassifikation.
- [x] **Approval-Cards** an `toolApproval` angebunden (`once` / `always` / `reject`) —
      `components/ApprovalCard.tsx` + `lib/approval.ts`; E2E „the loop stops while an approval
      is pending, and the card offers three answers".
- [x] **Onboarding-Wizard**: Provider → Key (+ Verbindungstest) → Modell → Workspace —
      `components/Onboarding.tsx`; die CORS-Matrix aus `Plan.md` §9 steht **bereits** darin,
      und Block P baut sie von „CORS unbestätigt" zu einer **gemessenen** Probe aus.
- [x] **Chat-UI**: Transcript, Tool-Karten, Reasoning, Diff-Vorschau, Stop-Knopf
- [x] **Todo-Sidebar** aus `todo`-Store — `components/TodoSidebar.tsx`
- [x] **Settings** inkl. Modellwechsel zur Laufzeit — `components/SettingsPanel.tsx`
- [x] **Settings-Export/Import** (Keys standardmäßig ausgeschlossen) — `lib/settings.ts` +
      `SettingsPanel.tsx`; E2E „the export opt-in is off by default and says what it would
      include".
- [ ] **Session-Export** als Markdown und JSON — **nachgemessen 01.10. und nicht gebaut**:
      `rg -l 'toMarkdown|exportSession'` über `packages/baah-web/src` → **null Treffer**.
      `createTranscriptReader` existiert, der Export nicht. ⚠️ Das ist die **Voraussetzung**
      dafür, dass ein Browser-Speicher je eine Wahrheitsquelle sein darf.
- [x] **Streaming-Hinweis**, wenn Antworten am Stück ankommen — der `data-baah-inflight`-Marker;
      der eigene Screenshot-State `chat-streaming` hält ihn mit dem Pacer offen.

## Welle A — Verify: 13 Befunde, davon **sechs falsche Behauptungen im neuen Code**

Build-Agent, dann **eigene** Verify-Session (§7.2), dann Fix-Agent. Alle drei Gates grün,
**CI auf `932b52e` grün.**

**Die Behebung hält.** Unabhängig nachgemessen: Transcript 24 → 145 px (Desktop) / 127 px
(Mobil), Statusleiste sichtbar, Hit-Test trifft das Badge, Desktop im Leerlauf unverändert.

### Zwei Befunde, die **vor** dem Commit gefixt werden mussten

**Finding 2 — die Config behauptet das Gegenteil über die CI.** Sie sagte, CIs `quality`-Job
laufe **vor** `e2e`, „also kann ein Typfehler in CI gar keinen Playwright-Lauf erreichen".
`.github/workflows/ci.yml` hat **kein `needs:`** auf `e2e` — der Job sagt es selbst im
Kommentar. Die Jobs laufen **nebeneinander**. Jetzt steht das Richtige dort: ein Typfehler kann
die **Pipeline** nicht grün machen (das `ci`-Aggregat braucht `quality`), **erreicht aber**
einen Playwright-Lauf.

→ **Vierte Instanz derselben Fehlerklasse in dieser Datei:** ein Kommentar, der das Gegenteil
des Codes behauptet — diesmal in einem Kommentar, der die **Fehlerbehebung** beschreibt.

**Finding 3 — eine unerklärte Verhaltensänderung.** pnpm hängt Argumente ans **Ende** der
Script-Kette, also erreichte `--mode e2e` nie das `vite build`:

```
pnpm build             → e2e.invalid: 0 Treffer   1263676 B   (Produktion)
pnpm build --mode e2e  → e2e.invalid: 0 Treffer   1263676 B   (identisch)
vite build --mode e2e  → e2e.invalid: 1 Treffer   1263698 B   (22 B, die Seam-Zeichen)
```

Die E2E-Suite lief bisher gegen einen **Produktions**-Bundle und läuft jetzt gegen einen
**e2e**-Bundle. Entscheidung: der e2e-Modus **ist** das Artefakt unter Test; das alte war ein
Unfall der Argumentweitergabe. Als Verhaltensänderung benannt, nicht stillschweigend.

### Finding 1 — eine Klasse, die einen echten Defekt bewacht, ohne dass jemand zusieht

`min-h-[10rem]` auf der Karte: **alle** Spec-Tests bleiben ohne sie grün. Bei **844×390**
(querformatiges Telefon — genau der Viewport, den der Kommentar als Grund nennt) misst der
Verify-Agent:

| | mit der Klasse | ohne sie |
|---|---|---|
| Karten-`clientHeight` | 156 | **24** |
| „Antworten" in der Karte | true | **false** |
| `elementFromPoint` auf „Antworten" | `button` | **`form[baah-composer]`** |

**Der Antwortknopf liegt unter dem Composer** — ein Klick dort antwortet nichts. Der Kommentar
nennt den Viewport und misst ihn nicht. Jetzt gibt es einen Test bei 844×390, und er ist
**rot gesehen** worden.

### Und vier Behauptungen, die schlicht falsch waren

| Behauptung | Gemessen |
|---|---|
| „ohne die Kappung stirbt nichts" bzw. „3 von 5 mit jedem einzeln" | einzeln **0 bzw. 1**; **3** nur im **Paar**. Und die Kappung ist tragend — in der **anderen** Richtung: ohne sie frisst die Karte den Transcript (300 → 230 px bei 768×1024). Ein **neuer** Test bei 768×1024 tötet sie jetzt. |
| „nur der Hit-Test sieht es, eine Box-Prüfung nicht" | **falsch** — vor dem Fix ist die Überlappung real **24 px** an beiden Viewports, eine reine Box-Prüfung **schlägt fehl**. Der Hit-Test bleibt, weil er erfasst, was Arithmetik nicht kann. |
| „Karte 531 px", „desktop 9 px", „360 px bei 1280×800" | **547 px**, **24 px**, **356 px** — und 360 war `max-height`, also **die Konstante unter Test, als Messung zitiert**. |
| `shrink-0` auf der Statusleiste: „der Browser würgte sie zuerst" | Eine Flexbox-**Auto-Minimumhöhe** setzt sie bereits auf 41 px; die Klasse ist **nachweislich inert**. Behalten, als Tiefenschutz benannt, der heute nichts misst. |

→ **„360 px" ist derselbe Fehler wie ein Test, der seine Erwartung aus der Konstante liest:**
eine Zahl, die aussieht wie eine Messung und eine Kopie der Implementierung ist.

### Ein Fehler, den der Fix-Agent **selbst** gemeldet hat

Beim Mutations-Harness hat er `git checkout -- ChatView.tsx` ausgeführt und dabei die
`shrink-0`-Änderung des Build-Agenten verworfen. **Er hat es sofort gemerkt, wiederhergestellt
und die eigene Korrektur obendrauf gelegt.** Genau die Offenlegung, die eine Regel wert ist —
und der Grund, warum §7.2a Commits über explizite Pfade verlangt: **ein Fehler, der eine
Stufe zurückwirft, ist von außen unsichtbar.**

### ⚠️ Offen aus der Verifikation

- **Touch-Scroll ungeprüft.** Der „mobile"-Viewport ist `devices["Desktop Chrome"]` +
  `setViewportSize` — **kein** `isMobile`, **kein** `hasTouch`, **kein** `deviceScaleFactor: 2`.
  „Für einen Nutzer erreichbar" ist damit nur für ein **Mausrad** bewiesen.
- **Die „unlesbare Fragekarte" wird von keinem Test gerendert** — ihre drei neuen Klassen sind
  `green but uncovered` **ohne** erreichbaren Fehlerfall heute.
- **Ein echtes Gerät / installierte PWA** — von hier nicht prüfbar.

---

## Welle 3 — E2E und Verifikation im Browser

- [x] ~~**GitHub Actions** (Quality + E2E auf jedem Push)~~ — **erledigt, und am 01.10. zum
      ersten Mal auf `HEAD` gelaufen.** `quality` 47 s · `e2e` 2 m 33 s · `ci` 3 s, alle grün.
- [x] ~~**E2E-Harness mit gefälschten OpenAI-Antworten**~~ — **erledigt.** `e2e/support/` mit
      `provider`, `pacer`, `turns`, `fixtures`.
- [x] ~~**CI-Erstlauf war rot, Ursache gefunden und behoben.**~~ `ERR_PNPM_FROZEN_LOCKFILE…`
      in **beiden** Jobs: der gepushte Lockfile hatte keinen `importers:`-Block. Ein gefiltertes
      `pnpm install` schreibt ihn halb. Regel in `AGENTS.md` §7.2a. → `3dc00da`. **Der
      „zweite Lauf" ist inzwischen gelaufen — und der vierte, fünfte, sechste auch.**
- [ ] **E2E-Szenarien** aus `Plan.md` §15.6 vollständig abdecken — 44 Tests decken die
      benannten Szenarien ab; „vollständig" ist eine Behauptung, die niemand gegen §15.6
      geprüft hat. **Offen.**
- [~] **UI-Review** (Screenshots + Vision-Analyse) — Harness steht (25 States, 118 PNGs),
      **4 von 118 Bildern gelesen.** Der Build ist nicht abgeschlossen, nur geliefert.
- [~] **Befunde aus dem UI-Review beheben** — U1, U5, U6, U8, U9, U10 erledigt; U2, U3, U4, U7 offen.
- [ ] **Manuelle Browser-Prüfung** `Plan.md` §15.1–15.4 abarbeiten — **größtes offenes Gate.**
- [x] ~~**E2E sharden / Docker-Image**~~ — **gemessen beantwortet: beides nein.** 44 Tests /
      1,6 min; die nützliche Form (nebeneinander) ist schon da.

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

> **Stand 01.10.: erledigt.** `ProviderDialect` (4 Drahtformen) und `ProviderOperator`
> (wer den Endpunkt betreibt) sind gebaut, `anthropic-compatible:<label>` existiert, und
> der Wizard kann die ID erzeugen. Die Beschreibung unten ist der **Ausgangszustand**.

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

- [x] **P1 — zweiter erweiterbarer *Dialekt*, nicht ein zweiter Vendor.** ✅ `registry.ts:78`
      `ProviderDialect` (4 Drahtformen), `registry.ts:335` `resolveVendor()` — **eine**
      Funktion, die eine Vendor-ID in Dialekt / Betreiber / Vorlage / Label zerlegt.
      `anthropic-compatible:<label>` → Dialekt `messages`, Betreiber `third-party`.
      ⚠️ **Meine Messung war unvollständig:** ich schrieb, `anthropic-compatible:my-proxy`
      „parst bereits sauber". Das stimmt — aber `vendorId()` in `onboarding.ts` hängte ein
      Label **nur** an das Literal `"openai-compatible"` an, der Wizard konnte also **keine
      benutzbare ID erzeugen**. Der Agent hat `needsEndpoint` statt einer zweiten
      String-Liste benutzt, wodurch die neue Zeile **konstruktiv** abgedeckt ist.
- [x] **P2 — Required-Header an den *Betreiber*, nicht an den Dialekt.** ✅ `ProviderOperator`
      (`registry.ts:150`) — **wer** den Endpunkt betreibt. Nicht der Dialekt (beide Zeilen
      sprechen `messages`), nicht das Label. ⚠️ **Mein Auftragstitel war falsch** („Header am
      *Dialekt*") — der Header gehört keinem der beiden, und die Verifikation hat belegt, dass
      er am **Betreiber** hängt: `anthropic-compatible:anthropic` (ein Label, das *behauptet*,
      Anthropic zu sein) bekommt ihn **nicht**. Test auf **der Leitung**, nicht nur in der
      Einheit — `Headers.get() === null` **und** der Key-Listen-Check.

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

- [x] **P3 — Modellliste über einen injizierten `fetch`, beide Antwortformen korrekt.** ✅
      `providers/models.ts`. **Vollständig paginiert *und* gemeldet**: `complete: false` +
      `incompleteReason` bei Cap oder einem Cursor, der nicht weiterkommt.
      **Der Anthropic-Cursor wird wörtlich in der Request-URL geprüft** — ein Loader, der Seite 1
      nochmal anfragt, terminiert am Cap und meldet dann eine Liste, die vollständig aussieht.
      ⚠️ **Google ist eine dritte Form**, die in meinem Auftrag nicht stand. Der Agent hat sie
      hinzugefügt, weil ein Loader, der für eine Katalogzeile „0 Modelle" meldet, genau die Lüge
      wäre, gegen die P3 steht. Begründung trägt.
      → **Und hier war die Liste falsch:** sie verlangte „vollständig paginieren **oder** ehrlich
      als unvollständig markieren". Gebaut ist **beides**.
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

### ⚠️ Nachgemessen am 01.10. — die Liste lag bei **einem** von fünf falsch

Ich habe den Block gegen den Quelltext geprüft, statt gegen diese Liste:

| | Stand laut Liste | **Gemessen** |
|---|---|---|
| **P4** (Probe im Wizard) | 0 gebaut | **GEBAUT.** `providers/probe.ts` macht genau das Richtige: **zwei** Fragen (`/v1/models` gegen `/v1/chat/completions`) und **vier** Ausgänge (`ok` · `cors-blocked` · `unreachable` · `http-error`) statt eines Booleans. `Onboarding.tsx` verdrahtet `onProbe → ConnectionProbeReport`, und E2E deckt es ab („the connection test reports the CORS matrix as a warning, not a wrong key"). **Die gestellte Aufgabe — „CORS unbestätigt" durch eine *gemessene* Probe ersetzen — ist geschehen.** Offen ist nur, die **Modellliste** daraus zu speisen. |
| **P5** (Anthropic-Turn) | 0 gebaut | **richtig.** `e2e/support/app.ts:72` klickt `openai-compatible` — die Suite fährt **ausschließlich** den OpenAI-Dialekt. |
| **P1** (`anthropic-compatible:<label>`) | 0 gebaut | **richtig.** `ProviderVendor` ist eine 4er-Union (`registry.ts:52`). |
| **P2** (Header am Dialekt) | 0 gebaut | **richtig, und schlimmer als notiert.** `requiredHeaders` (`registry.ts:128`) prüft auf exakt `"anthropic"` — für `anthropic-compatible` gäbe es den Header also **nicht**: richtig, aber aus dem **falschen** Grund. Und `isCorsVerified` (`:136`) ist `vendor !== "openai"`: **jede** neue Vendor-ID, auch ein Tippfehler, wird als **„CORS bestätigt"** gemeldet. Das ist ein **Lügen-Erzeuger**, kein Flag. |
| **P3** (Modellliste) | 0 gebaut | **richtig.** `rg 'display_name\|has_more\|first_id'` über `packages/` → **null Treffer**. |

**Und die gute Nachricht, die in keiner Zeile stand: Block P braucht *keine* neue
Dependency.** `@ai-sdk/anthropic@^4.0.68` ist bereits in `packages/baah-web/package.json`
installiert, und `baah-core` hat **absichtlich** keine Vendor-SDK — die Fabriken werden
injiziert (`factories.ts:70`). Also **kein Lockfile-Zugriff** und damit keine der
Serialisierungsfallen aus `AGENTS.md` §7.2a. Das war der teuerste Blocker im Plan, und er
ist weg.

→ **P1, P2, P3, P5 sind der Block. P4 ist erledigt und muss nur nicht kaputtgemacht werden.**

### Aus dem CI-Lauf, gehört hierher

- [x] ~~**`@opencode-ai/models` als Quelle streichen oder als Fallback begründen.**~~
      **BEANTWORTET: streichen.** Block P liest `/v1/models` — von der Quelle injiziert
      (`providers/models.ts`), **ohne** Bundle. Der Snapshot (6,35 MB) ist damit **nicht**
      eingezogen.
      → **Die Frage in §14.4 ist damit sachlich erledigt und ihre Begründung widerlegt:**
      sie behauptete, „das SDK selbst kann keine Modelle auflisten". Das stimmt für die
      **Modellfabriken** — es gab nur `model(id)`. Für eine **Liste** war nie das SDK
      zuständig, sondern `/v1/models`, und genau das ist der einzige Endpunkt, den OpenAI
      im Browser erlaubt.
      ⚠️ **`Plan.md` §14.4 ist noch nicht korrigiert.** Bleibt bei mir, im nächsten Doku-Block.

### Block P — Verify: 10 Befunde, davon zwei HIGH

Build-Agent, dann **eigene** Verify-Session (§7.2), dann Fix-Agent.

**Das Urteil der Verifikation war: *nicht committen*.** Und sie hatte recht — zwei davon waren
schwerwiegender als die ursprüngliche Aufgabe.

#### 🔴 F1 — `bearer` sendete den **rohen** Schlüssel — und ein Test **nagelte den Fehler fest**

`bearer` war `authorization: sk-…` statt `Bearer sk-…`. Zwei Dateien, dieselbe Konstruktion.
Und der Kommentar **zwei Zeilen darüber** beschrieb das *korrekte* Verhalten.

Gemessene Schädigung, nutzerseitig:

```
probeConnection({vendor:"openai-compatible:groq", apiKey:"<gültig>"})
→ "openai-compatible:groq rejected the key (HTTP 401)."
```

**Alle sechs** §9-gemessenen kompatiblen Anbieter (Groq, xAI, Mistral, Cerebras, Together,
DeepSeek) senden ACAO auf beiden Pfaden, also bekommt **jeder** ihrer Nutzer zu hören, sein
Schlüssel sei abgelehnt — während er in Ordnung ist. Genau die Fehldiagnose, die der
Zwei-Fragen-Entwurf von `probe.ts` verhindern soll. Für die Erstpartei `openai` überlebt es
**zufällig**: deren Inferenzpfad sendet kein ACAO, also `cors-blocked` unabhängig vom Schlüssel.

⚠️ **Und der Teil, der es schlimmer machte:** `models.test.ts:100` behauptete
`expect(headers.authorization).toBe(SECRET)` — **der Test pinnte den Defekt fest.** Reparieren
macht ihn rot. *Das ist schlimmer als ungetestet: die Suite verteidigt den Fehler.*

→ **Und der Build-Agent hatte das gemeldet und trotzdem falsch eingeschätzt:** er schrieb
„`probe.ts` … das stammt vor diesem Block, ich habe es gelassen". Dieselbe Konstruktion stand im
**neuen** `models.ts`. „Altlast" machte es harmloser, als es war.

Behoben: **ein** Modul `auth-header.ts` statt zweier Kopien — mit einem `switch`, weil der alte
Ternär nur dadurch typprüfte, dass die beiden anderen Styles zufällig **wie Header-Namen**
geschrieben sind. **Diese Koinzidenz war der Bug.** Test jetzt `Bearer ${SECRET}`, **rot
gesehen**.

#### 🟠 F2 — `complete: false` war ein Rückgabewert, den **niemand rendert**

Das Block-Versprechen lautet: *eine unvollständige Modellliste ist dieselbe Lüge wie eine
gekappte `grep`-Suche.* Gemessen: **das Löschen des gesamten Unvollständigkeits-Hinweises lässt
`pnpm check` (486 Tests) *und* `pnpm e2e` (56) grün.**

Und das Schlimmste daran war **nicht** die Lücke, sondern der Grund: `scenarios.e2e.ts:668`
pinnte die *Abwesenheit* als korrektes Verhalten — **die E2E-Suite schützte die Nichtlieferung.**

#### Und die inhaltliche Frage, die die Verifikation stellte

> **Ist P3 geliefert, wenn der Loader niemand aufrufen kann?**

Die Nutzeranforderung war eine Modellliste. Ein korrekter, getesteter Loader, den niemand
aufrufen kann, ist ein **Modul**, keine Modelliste. Und: `toRuntimeError` hatte keinen Fall für
`ModelListError` — die **sechs** Fehlercodes aus `models.ts`' eigener Doku fielen alle in einen
Satz, und der Wizard rendert `error.name`, also hätte der Nutzer wörtlich **„RuntimeError"
gelesen**.

**Urteil: nicht geliefert.** Nicht wegen der fehlenden Zeile — die ist mechanisch. Sondern
weil die fehlende Zeile **das ist, was die Ehrlichkeitsregel braucht**.

#### Sechs überlebende Mutationen

| | Mutation | vorher | nachher |
|---|---|---|---|
| m9 | Pagination nach `vendor` statt nach `page.shape` | **überlebt** | 3 Tests |
| m12 | `modelsBodyFor` fest auf OpenAI-Form | **überlebt, e2e 56/56** | `model-list.e2e.ts` |
| m13 | 4. Form in `TEMPLATE_VENDORS` | **überlebt, core 615/615** | siehe unten |
| m14 | `corsVerdict`-Labelzweig löschen | **überlebt** | 1 Test |
| m15 | `vendorId` zurück auf die Literal-Liste | nur e2e | **vitest** ×2 |
| m17 | Unvollständigkeits-Hinweis löschen | **überlebt check *und* e2e** | e2e |

⚠️ **m13 wurde *nicht* getötet — und das ist die ehrlichste Antwort im ganzen Block.** Der Agent
hat gemessen, dass ein 4. Template in der fragenden Richtung ein **äquivalenter** Mutant ist:
`corsVerdict → unmeasured`, `operator → third-party`, `createProviderModel → ProviderError`.
**Jede** Antwort bleibt auf der sicheren Seite, es gibt keinen Defekt zu töten. Die
**gefährliche** Richtung — eine nutzergefüllte Form, die durch Aufnahme in `MEASURED_CORS` eine
§9-Messung erbt — wird von drei Tests getötet.

> **Ein toter Test ist schlecht. Ein Test, von dem man behauptet, er töte etwas, das er nicht
> tötet, ist schlimmer** — weil er die Lücke als abgedeckt ausweist. Der Agent hat stattdessen
> gemessen und die Zahl der Tabellen von drei auf zwei gebracht.

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

- [~] **`question`: Antworten sind nicht vertrauenswürdig.** Der Rahmen ist **implementierbar**
      — `toModelOutput?` existiert als optionales Feld (`baah-core/src/tool.ts:99`) und der
      Vertrag ist getestet. ⚠️ **Aber er ist nicht verdrahtet:** `question/src/index.ts:359`
      gibt `{ answers: parsed.data }` zurück, **ohne** `toModelOutput`. Die Antworten gehen
      unverändert ans Modell.

      ⚠️ **Und meine alte Begründung war die falsche.** Ich notierte, das strukturierte
      `{answers[][]}` sei besser „weil es keinen Quotes-Satz splisst, den ein Anführungszeichen
      sprengt". Das ist **gelöst** und war nie der Grund für die offene Markierung. Der
      eigentliche Grund steht nirgends: der `question`-Pfad ist der **einzige**, in dem
      **frei getippter Nutzertext** und **Agenten-Text** im selben Prompt landen — und der
      Tab hält den API-Key. Der Nutzer ist hier der **vertrauenswürdigste** Teil des Systems;
      das ist Absicht, kein Loch. Die Gefahr ist die andere Richtung: dass eine **Antwort**
      später als **Anweisung** gelesen wird.

      → **Offen mit richtiger Begründung:** Abgrenzung gegen Prompt-Injektion über den
      Antwortkanal, nicht gegen Quote-Sprünge.
- [x] **`todo`: Zeilen haben Provenienz.** `TodoSidebar.tsx:68` rendert
      `data-baah-provenance="untrusted"` auf der Zeile, mit dem Klartext „vom Agenten behauptet —
      nicht geprüft". Genau das war die Forderung: **untrusted content unterscheidbar rendern.**
      Der Kommentar `:19` hält zusätzlich fest, dass eine Zeile **keine** Checkbox bekommt, die
      der User abhaken könnte — also kann eine erfundene Zeile nicht als erledigt bestätigt
      werden.
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

- [x] ~~**Toten `optimizeDeps.exclude: ["grep-wasm"]` in `vite.config.ts` entfernen.**~~
      **ERLEDIGT, 01.10. nachgemessen:** `rg -c 'grep-wasm' vite.config.ts` → **0**.
      Was dort heute steht, ist `exclude: ["@sqlite.org/sqlite-wasm"]`, und der Verweis
      `packages/baah-storage/README.md` **existiert** (die Liste behauptete, er zeige auf zwei
      nicht existierende READMEs — es ist einer, und er da).
      → **Erledigt heißt hier: die Sache war schon weg.** Die Liste führte einen offenen Punkt,
      der offen aussah und den niemand mehr tun konnte.

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
- [x] ~~**Zwei fehlende READMEs**, auf die `vite.config.ts:19` zeigt.~~ **Falsch gemeldet.**
      Nachgemessen 01.10.: `packages/baah-storage/README.md` und
      `packages/baah-tools/grep/README.md` — **beide vorhanden**. `vite.config.ts:45` verweist auf
      genau eines davon, und das existiert.
      → **Wieder eine Lücke, die keine war.** Die Fehlerklasse ist damit viermal belegt
      (U5, U6, P4, jetzt das): *ein offener Punkt, der aussieht wie Arbeit und es nicht ist.*

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

- [x] ~~**`ProviderRegistry.resolve` und `fingerprint` sind jetzt `async`.**~~
      **ERLEDIGT, 01.10. nachgemessen:** `registry.ts:541` `export async function fingerprint`,
      `:691` `async resolve`, und `runtime/index.ts` **awaitet** bereits (`await n(...)`).
      Die Warnung galt für die Zeit vor Welle 2.
- [!] **Der Store-Vertrag ist gewachsen.** Welle 2 muss bauen:
      1. `tool_invocations.status` — unterscheidet `begun` von `done`. Ohne die Spalte ist
         das Crash-Fenster wieder unsichtbar und `write` haengt ein zweites Mal an.
      2. **Vier-Teile-Schluessel** statt nackter `toolCallId`:
         `{sessionId, attempt, toolCallId, occurrence}`. `session_id` ist als Spalte schon da,
         `attempt` und `occurrence` sind Engine-Buchhaltung.
      3. `listUnfinishedTurns({ sessionId })` — neu, fuer die Reload-Recovery.
- [x] ~~**`store.flushDelta` wird vom Loop bis heute nicht aufgerufen.**~~ **ERLEDIGT.**
      Nachgemessen 01.10. über **alle drei Ebenen**, nicht nur die Definition:
      `loop.ts:460` (der Vertrag, mit `flushDelta(input)` und `partType`),
      `turn-store.ts` in `baah-storage` (der Adapter, mit eigener Doku, warum die Signatur
      einen ganzen `PartInput` braucht), `worker.ts:434` (`case "flushDelta"`).
      **Der Adapter liegt in `baah-storage`, wie im W2-A-Block entschieden** — damit bekommt die
      Engine keinen zweiten Weg in die Datenbank.
      ⚠️ Die Liste warned an zwei Stellen davor, es werde „als tote Methode wiederentdeckt".
      Es war **drei** Ebenen tief und jede einzelne sah aus wie eine Definition.
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
- [x] ~~**Der 20-Sekunden-Stall-Watchdog fehlt weiterhin.**~~ **ERLEDIGT, 01.10. gemessen.**
      `runtime/watchdog.ts` existiert und ist **kein Timer auf Chunk-Ebene**, sondern einer auf
      **Event**-Ebene: `DEFAULT_STALL_TIMEOUT_MS`, `#armedAtMs`, `setTimeout`/`clearTimeout`
      **injizierbar** (`:127`), plus eine Zustandsmaschine mit drei Zuständen — `awaiting-provider`
      (scharf), `awaiting-human` (entschärft, weil eine Approval oder Frage offen ist) und
      `idle` (entschärft).

      → **Damit ist die offene Frage aus dieser Liste mit „anders" beantwortet, nicht mit „ja":**
      der Watchdog braucht **keinen** Chunk-Zugriff, den `ToolLoopAgent` nicht freigibt. Er
      hängt an `AgentEvent`, **nicht** am rohen Chunk. Die Notiz behauptete eine Abhängigkeit,
      die der Code nicht hat — dieselbe Fehlerklasse wie Finding 2 in Welle A, nur eine Ebene
      tiefer: **ein Kommentar, der eine Abhängigkeit behauptet, die es nicht gibt.**

      ⚠️ **Der Preis ist real und in der Datei dokumentiert:** der Watchdog **entschärft sich bei
      `tool-call` und schärft bei `tool-result`**. Das ist eine bewusste Abwägung gegen einen
      Fehlalarm, wenn ein Tool lange läuft — und es heißt, dass ein Turn in einem 60-Sekunden-
      Dateizugriff **keinen** Stall meldet.

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

- [x] ~~**H1 — `tsc --noEmit` in der E2E-`build` koppelt fremde Typfehler an den App-Test.**~~
      **ERLEDIGT 01.10 — und ich bin ihm live begegnet, bevor ich ihn abhaken konnte.**
      Mein Wegwerf-Probe hatte *einen* falschen Eigenschaftsnamen (`process.stdout` unter
      `"types": []`), und die Folge war wörtlich die gemeldete:

      ```
      [WebServer] $ tsc --noEmit && vite build && node ../../scripts/build-sw.mjs --mode e2e
      [WebServer] Command failed with exit code 1.
      Error: Process from config.webServer was not able to start. Exit code: 1
      ```

      **rc=1, null Tests gelaufen** — wegen einer Datei, die nichts mit der App zu tun hat.
      Behoben: `e2e/playwright.config.ts` ruft `vite build --mode e2e` **direkt** auf, mit
      `cwd`, wie es die Screenshot-Config für sich schon tat — und mit der Begründung im
      Kommentar. **Gepflanzter Typfehler, beide Läufe gemessen:** alter Befehl **rc=1 / 0
      Tests**, neuer Befehl **1 passed, rc=0**.
      → **Die Typprüfung ist nicht verloren**, sie ist in den Job gewandert, der sie besitzt:
      `pnpm check`, `tsconfig.json` inkl. `e2e/`, und CIs eigener Schritt
      `tsc -p e2e/tsconfig.json` — der **strengere**, weil `"types": []`.

- [x] ~~**H2 — `reuseExistingServer: true` lässt einen *veralteten* Server die ganze Suite
      bedienen.**~~ **ERLEDIGT 01.10.** `reuseExistingServer: false`, **immer** — dieselbe
      Entscheidung, die die Screenshot-Suite auf Port 4174 längst trägt.
      **Kosten gemessen, nicht geschätzt:** drei Läufe `vite build --mode e2e` →
      **3,32 s / 3,13 s / 2,73 s** bei 150 s Suite = **~2 %**. Drei Sekunden für die Tatsache
      „das Artefakt unter Test wurde für diesen Lauf gebaut".
      ⚠️ Die Alternative — eine Vorabprüfung, ob der vorhandene Server die *aktuelle* `dist/`
      ausliefert — wurde **verworfen**, und die Begründung trägt: sie müsste einem Server
      vertrauen, dessen Aussage über sich selbst sie nicht prüfen kann. *Ein Wächter, der dem
      Wächter glaubt, ist keiner.*

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

- [x] ~~**U5 — `chat-stall` und `chat-streaming` sind BYTE-IDENTISCH.**~~ **ERLEDIGT.**
      Nachgemessen 01.10. an den Ausgabedateien: `chat-stall.png` md5 `76915ba3…`,
      `chat-streaming.png` md5 `81eeadc6…`. Der Zustand wird jetzt durch echte Stille
      erreicht — `chat-stall` gaten **1** Event, `chat-streaming` **6**.

- [x] ~~**U6 — `error-stream-cut` zeigt „Versuch 1 von 3", nicht 3.**~~ **ERLEDIGT.**
      `filled/desktop/error-stream-cut.png` sagt **„Versuch 3 von 3"**, wie die Manifest-Notiz
      es behauptet. Die Klassifikation des 501 ist also richtig eingestellt, und die Notiz
      beschreibt genau das als Soll — die offene Frage von damals ist damit beantwortet.

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

- [x] ~~**U8 — `chat-question` überlappt die Statusleiste.**~~ **ERLEDIGT 01.10.**
      **Nachtrag zur Messung:** es waren nicht 16 px, sondern **24 px auf Mobil** — die volle
      Höhe der Statusleiste, `elementFromPoint` nennt die **Fragekarte**. Und die Ursache ist
      nicht die Überlappung: der Transcript-Viewport fiel auf **24 px von 159 px**.
      Behoben durch eine Untergrenze für den Transcript **und** einen eigenen Scrollbereich
      in der Karte (`max-h-[45vh]`), plus `sticky bottom-0` auf der Antwortzeile.
      ⚠️ **Der Preis ist eine Scrollleiste in der Karte** (358 px von 493 px sichtbar).
      Bewusst gewählt, weil „Verlauf lesbar während der Agent wartet" wichtiger ist als
      „alles ohne Scrollen".
      ⚠️ **Drei Klassen sind ungedeckt** und als solche im Quelltext benannt: `min-h-[10rem]`
      auf der Karte, `shrink-0` auf der Statusleiste, `shrink-0` auf dem Composer. Ohne sie
      bleiben alle fünf Spec-Tests grün — sie sind für Viewports, die die Suite nicht besucht.

- [x] ~~**U9 — `chat-todo (filled, mobile)` schlägt fehl.**~~ **ERLEDIGT.**
      `manifest.ts:555-559` öffnet den Drawer bedingt. ⚠️ Die Notiz benennt den alten Fehler
      ausdrücklich als *Regression der Harness, verursacht durch einen Fix der App* — ein
      Vertrag, den beide Seiten teilen, und das ist hier der Testid-Vertrag.

- [x] ~~**U10 — die vier vormals unerreichbaren States sind mobil erreichbar.**~~ **ERLEDIGT.**
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

## Projekt-/Konversationsmodell — Analyse des Nutzerbegriffs

Der Nutzer hat gefragt: „Haben wir nicht das Konzept von Projekten und Konversationen.
Nachrichten mit der gleichen Message id sind eine eigene Konversation in einem Projekt —
das sollte es ein geben. Ein Projekt ist ein Ordner der geöffnet wird. Soll über mehrere
Läufe eindeutig bleiben."

**Die vollständige Analyse mit allen Messungen:**
[`packages/baah-core/docs/projekt-konversation.md`](packages/baah-core/docs/projekt-konversation.md)

### Befund vor dem Bauen: die Wurzel-Nachricht-Regel ist **nicht** die richtige Lesart

Die naheliegende Deutung („die Identität einer Konversation ist die Message-ID ihrer
**Wurzel**-Nachricht") ist mit dem bestehenden Schema **nicht vereinbar**:

- `messages.id` ist der **Primärschlüssel** (`packages/baah-storage/src/schema.ts:74`).
  „Alle Nachrichten mit derselben Message-ID" ist damit per Definition **eine** Zeile.
- `messages.parent_id` existiert (`schema.ts:77`, Index `schema.ts:250`) und wird
  **nie befüllt**: der einzige Pfad ist `sql.ts:344` (`input.parentId ?? null`), und kein
  Aufrufer außerhalb der Tests übergibt ihn. Jede Nachricht ist heute eine Wurzel.

Wer diese Deutung als Spezifikation an einen Bau-Agenten gibt, baut etwas **sehr gut**, das
die Frage nicht beantwortet. Die Empfehlung in der Analyse ist eine **vierte Lesart**: die
fachlich passende Ebene ist `turnId` (eine Frage + Antwort + Abschlussnachricht), die
stabile Ebene über Läufe ist der **Ordner**.

### Drei weitere Befunde, die die Größe der Aufgabe zeigen

1. **„Konversation" existiert nicht als Oberfläche.** Die App erzeugt genau **eine** Session
   (`runtime.ts:340-342`, `title` ist das Literal `"Sitzung"`, wird nie aktualisiert) und
   kann keine zweite erzeugen — `listSessions` hat **null Aufrufer** außerhalb von
   `baah-storage`/Tests, und es gibt keine Session-UI. `status='archived'` wird in `src/`
   nirgends gesetzt. **Das ist keine Spaltenfrage, das ist eine Oberflächenfrage.**
2. **„Über mehrere Läufe eindeutig" überlebt heute genau einen Fall: Reload.** Nicht:
   Tab schließen (der Ordner-**Zugriff** erlischt), `localStorage` leeren (neue Session, die
   alte bleibt verwaist), „Website-Daten löschen", Ordner wechseln, Rechner wechseln. Die
   Forderung ist **größer, als sie klingt**.
3. **Ordnerwechsel hat heute keine Wirkung auf die Sitzung.** `AppShell.openProjectFolder`
   (`AppShell.tsx:112-132`) ruft nur `workspace.swap(...)`; `sessionId` bleibt. Wer Projekt B
   öffnet, **sieht den Verlauf von Projekt A**. Das ist der wichtigste einzelne Befund.

### 🔴 Entscheidungsfragen an den Nutzer — vor dem Bauen stellen

1. **Ebene:** „Konversation" = eine Frage-Antwort (ein *Turn*) oder ein Verlauf mit mehreren
   Fragen (eine *Session*)? Bestimmt die Oberfläche, nicht das Schema.
2. **Identität:** Soll die Projektidentität eine **Datei im Ordner** sein (UUID; überlebt
   Umbenennen, gleiche Ordnernamen, Rechnerwechsel) oder reicht der Browser-Fingerabdruck?
   Heute ist die ID `` `local:${name}` `` (`file-system-access.ts:164-165`) — **zwei Ordner
   mit demselben Namen sind derselbe String**, und sie wird nirgends gespeichert.
3. **Ordnerwechsel:** Soll der Verlauf des vorigen Ordners verschwinden oder sichtbar
   bleiben? Der Code entscheidet heute **stillschweigend** für „sichtbar".
4. **Bestand:** Was passiert mit der einen heutigen Session
   (`localStorage["baah.session.v1"]`, `title = "Sitzung"`)? Sobald `localStorage` leer ist,
   ist sie verwaist **und unauffindbar**, weil es keine Liste gibt.
5. **Grenze:** Gilt „über mehrere Läufe eindeutig" auch über **Gerätewechsel**? Das ist die
   einzige Frage, auf die „nein" eine **richtige** Antwort ist — dann ist der Projektordner
   die Wahrheitsquelle (`Plan.md:1933-1941`), ein eigenes Vorhaben.

### Was als **gemessen** gilt — und was nicht

Gemessen (Quelltext, Treffer gezählt): alle `Datei:Zeile`-Angaben oben und in der Analyse.
**Nicht gemessen, nur vermutet:** ob Chrome wirklich keinen absoluten Pfad preisgibt (aus dem
Code geschlossen — der Workspace nimmt nur `handle.name`); ob der Grant **jeden** Kaltstart
erlischt (Repo-Angabe, zitiert); ob zwei Sessions in einer Datenbank funktionieren (kein
gemessener Pfad, weil `listSessions` unbenutzt ist); was ein zweiter Tab dem Nutzer zeigt.
**Keine Tests ausgeführt** — `pnpm check` lief hier nicht.

---

# ÜBERGABE — Stand 2026-10-01, Ende der Arbeitssitzung

**Alles gemessen, nichts behauptet.** Jede Zahl unten ist aus einem Lauf, kein Ziel.
**Uncommittet bleibt nur die Doku**; `6e041d8` ist der letzte Commit, `origin/main` steht
auf `340d5f5`, **15 Commits sind nicht gepusht**.

## Gemessener Stand

```text
pnpm check          rc=0   1966 Unit-Tests in 13 Paketen   0 Typfehler
pnpm e2e            rc=0   44/44        (Port 4173 vorher bestätigt FREI)
test:screenshots    rc=0   46/46        118 PNGs, 25 States
check:browser-only  rc=0   88 Sources · keine Serverform · 5/5 Fähigkeiten
```

⚠️ **Die Port-Prüfung ist nicht optional.** `reuseExistingServer: !CI` ist lokal wahr, und
ein übrig gebliebener Server lässt den Build **ganz überspringen**. Ich bin **zweimal**
hineingelaufen und habe „44/44" gemessen, **ohne dass ein Build stattfand**.

## Was gebaut ist

| Block | Zustand |
|---|---|
| Welle 0–1 | erledigt, verifiziert |
| Welle 2 | läuft durch |
| Welle 3 — E2E | 44/44, davon 2 als Timing-Bugs behoben |
| Welle 3 — Screenshot-Harness | 25 States, 118 PNGs, Manifest-matrixgeprüft |
| Welle 3 — **UI-Verifikation** | **4 von 118 Bildern gelesen. Nicht abgeschlossen.** |
| Welle 3 — Mobil-Layout (`U1`) | behoben, am Bild verifiziert (0 px → 390 px Spalte) |
| **PWA** | Manifest, 4 generierte Icons, Service Worker mit Precache — **installierbar und offline** |
| **Browser-only-Gate** | 7. Gate, zwei Hälften, Selbsttest 39, echte Mutationen |
| **Projekt-/Konversationsmodell** | Ordner = Projekt, Session = Konversation, Ordnerwechsel wechselt beides |

## Was **nicht** gebaut ist

| Block | Aufwand | Notiz |
|---|---|---|
| **W4: `shell`, `git`, `task`/Subagent, `skill`, Service-Worker-Infrastruktur** | hoch | **null gebaut.** `packages/baah-tools/` hat 10 Pakete; `shell`/`git`/`task` existieren nicht. Braucht `just-bash` bzw. `isomorphic-git` → Lockfile-Anfassung. |
| **Block P: Anthropic-Endpunkte + Modellliste** | hoch | deine Anforderung vom 2026-09-30, **0 gebaut**. Analyse liegt in diesem File. |
| **Kontrastprüfung (K1–K5)** | mittel | Entwurf steht (§ „Kontrastprüfung"). `ui-review` §11 hat den Entwurf schon — **übernehmen, nicht erfinden.** Ein Zustand fehlt: `searchTruncated` existiert nicht im Satz. |
| **Transcript-Export** (`Plan.md` §17.6 Block 4) | mittel | `createTranscriptReader` existiert. **Voraussetzung** dafür, dass ein Browser-Speicher je eine Wahrheitsquelle sein darf. |
| **Zwei-Schichten-Ablage** (`Plan.md` §17.3) | hoch | das eigentliche Zielbau |
| **`parts.session_id`** (`Plan.md` §20) | **gefährlich** | **kein Refactor, sondern offene Frage** — die Spalte ist tragend. |
| **`chat-question` überlappt die Statusleiste um 16 px** | mittel | bei **390 und 1280** identisch, viewport-unabhängig. Jetzt behoben werden **darf** — der parallele Agent ist durch. |
| **W-Liste aufräumen** | niedrig | **114 offene Punkte**, viele erledigt ohne Abhaken. Die Liste ist als Arbeitsauftrag **nicht mehr benutzbar**. |

## Gates, die **kein** Quelltext-Gate schließen kann

1. **Die Ordner-Interaktion ist nie in einem Browser gelaufen.** Kein `showDirectoryPicker`,
   kein echtes `createWritable`, kein Beweis, dass eine Freigabe einen Kaltstart übersteht.
   Betrifft **B3** und das Projektmodell — das größte offene Gate.
2. Ob `beforeinstallprompt` feuert, ob `display: standalone` greift, ob der Start-URL-Scope
   auflöst — auf einem echten Gerät.
3. „Website-Daten löschen", Deinstallation, Gerätewechsel: **was überlebt, ist nicht
   gemessen.** Gemessen sind nur die Speicherorte.
4. `storage.persist()` in einem echten Browser.
5. Ein zweiter Tab gegen `opfs-sahpool` — der Code markiert das selbst als `UNVERIFIED`.
6. Ob `.baah/project.json` einen **Rechnerwechsel** übersteht: eine Aussage über das
   Dateisystem, nicht über diesen Code.

## Meine eigenen Fehler aus dieser Sitzung — **nicht wiederholen**

| # | Fehler | War es ein Fehler |
|---|---|---|
| 1 | „Wurzel-Nachrichten-ID identifiziert die Konversation" — als **Nutzeraussage** formuliert | **falsch**, von einem Analyse-Agenten widerlegt. Ich hatte aus zwei richtigen Aussagen eine falsche Schlussfolgerung gemacht. |
| 2 | Grep nach `AND session_id`, die Abfrage sagt `AND p.session_id` | **falsch** — nicht „nichts gefunden", sondern **das Falsche gefunden**, und das ergibt eine Zahl |
| 3 | `build-sw.mjs` löste gegen `process.cwd()` auf | brach `pnpm --filter … build` |
| 4 | `build-sw.mjs` mit **positionalem** Argument | ließ `pnpm e2e` gar nicht starten |
| 5 | `void askForPersistence()` | vom **eigenen** `no-bare-void`-Gate gefangen |
| 6 | `KNOWN_UNSATISFIED` geleert, Tests stehen gelassen | Tests waren an **Live-Daten** gekoppelt |
| 7 | `EXPECTED_TITLE` nicht mit `<title>` mitgezogen | Wächter verglich seit zwei Commits ins Leere |
| 8 | `make-icons.mjs` meldete `favicon.svg`, ohne es aufzurufen | Meldung ohne Tat |
| 9 | Endlosschleifen-Sampler ⇒ `wait` hängt ⇒ Timeout | Messgerät, das aussieht wie eine Messung |
| 10 | `grep -c` beendet sich mit 1 bei null Treffern ⇒ `&&`-Kette brach | Verifikation lief nie |
| 11 | „`queryPermission`: 0 Treffer" | **14 Treffer** — die Schlussfolgerung trug, die Zahl nicht |
| 12 | **zweimal** „44/44" mit übernommenem Server gemessen | **H2**, selbst dokumentiert, selbst hineingelaufen |
| 13 | `no-foreign-error-text` u. a. Gates blind für **String-Inhalte** | Gate **vollständig blind** für `node:fs` — hätte sich als Deckung ausgewiesen |

**Muster:** dreimal eine Vermutung als Tatsache ausgegeben; zweimal eine Zahl
übernommen, die falsch war; einmal ein Werkzeug benutzt, das aussah wie eine Messung und
keine war. **Und neunmal hat es ein Gate, ein Subagent oder ein Nachmessen gefangen** —
nicht ich.

## Reihenfolge, wenn es weitergeht

1. **Push** — 15 Commits liegen lokal, `origin/main` ist 21 Commits zurück.
2. **Offene Gates abarbeiten**, vor allem Gate 1: ein Browserlauf gegen die gebaute App,
   Ordner öffnen, Reload, prüfen.
3. **`chat-question` 16 px** (klein, sichtbar, jetzt fällig) und **`U9`** (ein Klick im
   Manifest).
4. **Die restlichen 114 Bilder lesen.** `chat-question` hat stundenlang im Satz gelegen.
5. **W-Liste aufräumen** — abhaken, was erledigt ist, Zahlen korrigieren.
6. **W4** (`shell`, `git`, `task`) — der größte offene Umfang.
7. **Block P** — deine Anforderung: Anthropic-förmige Endpunkte + Modellliste von beiden.

## Was ich einem Nachfolger mitgeben möchte

> **Ein Breitenwert von 0 und ein umgebrochenes Wort pro Zeile sind dieselbe Ursache, aber
> nicht derselbe Schweregrad.** Wer eine Layout-Messung in Prosa übersetzt, verliert die
> Schwere, weil die Zahl nüchtern aussieht.

> **Ein Gate, das nur verbietet, ist halb ein Gate.** Löscht man die Persistenz, läuft es
> grün durch, weil nichts Verbotenes importiert wurde. Die zweite Hälfte — „diese
> Fähigkeiten müssen benutzt werden" — ist die, die die Anforderung trägt.

> **Ein Komponenten-Peak sagt nichts darüber, ob eine Grenze überschritten wird.** Chromium
> 1189 → 657 MB gemessen, und es kauft auf diesem Host **keinen** KB Luft: 99,999 % gegen
> 99,93 % von 5120 MB.

> **Ein Gate, das bei *Abwesenheit* lügt, wird genauso ignoriert wie eines, das bei
> *Verstößen* lügt** — es fällt nur nicht auf, weil nichts rot wird.

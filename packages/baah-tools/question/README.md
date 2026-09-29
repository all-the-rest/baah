# `@all-the.rest/baah-tool-question`

Stellt dem Nutzer mitten im Turn eine oder mehrere Fragen und wartet auf die
Antwort. Das Tool ist bewusst dünn: es validiert, übergibt an einen injizierten
`QuestionChannel` (die UI-Brücke) und wartet. Kein DOM, kein Storage, keine
Datenbank (`AGENTS.md` §4).

## API

```ts
import { createQuestionTool, type QuestionChannel } from "@all-the.rest/baah-tool-question";

const tool = createQuestionTool({ channel });
const result = await tool.execute(context, input);
// result.answers: string[][]  — eine Zeile je Frage, in derselben Reihenfolge
```

### `QuestionChannel`

```ts
interface QuestionChannel {
  ask(questions: readonly Question[]): Promise<string[][]>;
}
```

Die Engine hält die Promise-Buchhaltung: Fragen anzeigen, bei der Antwort
auflösen. Das Tool raced den Aufruf gegen `ToolContext.signal`, damit ein
abgebrochener Turn nie hängen bleibt.

**Antwort-Kontrakt:** genau eine Zeile (`string[]`) je Frage, in derselben
Reihenfolge. Weicht die Antwort vom Schema oder von der Zeilenzahl ab, wirft
das Tool einen `ToolError` mit Handlungsanweisung — es wird nicht still
repariert.

Je Frage gibt es drei mögliche Ausgänge, und sie sind **unterscheidbar**:

| Ausgang | Was der Channel tut | Was das Modell sieht |
|---|---|---|
| beantwortet | `resolve([["SQLite WASM"]])` | `{ answers: [["SQLite WASM"]] }` |
| übersprungen | `resolve([[]])` | `{ answers: [[]] }` — ein *Ergebnis*, pro Frage |
| **verworfen** | **`reject(new QuestionCancelledError())`** | **ein `QuestionCancelledError` — eine Ablehnung** |

**Verworfen ist nicht übersprungen.** Eine reine Längenprüfung kann beides nicht
unterscheiden: beides bedeutet „für diese Frage kam keine Antwort heraus". Der
Nutzer, der die Karte schließt, hat aber *entschieden*, nicht *nicht
geschafft* — und nur diese Information ändert, was das Modell als Nächstes
tut (weitermachen mit ausgesprochener Annahme statt nochmal fragen).

Der Referenz-Baukasten hat dasselbe Problem und löst es mit einem typisierten
`CancelledError` ("The user dismissed this question"); `QuestionCancelledError`
ist genau das. **Regel für den Channel: Verwerfen ist kein `resolve`, sondern
ein `reject` mit `QuestionCancelledError`.** Damit die Engine den Ausgang auch
programmatisch sieht, ist der Fehler eine *Klasse*, kein Text —
`onToolError` in `packages/baah-core/src/agent/tools.ts` reicht das Original
durch, `instanceof QuestionCancelledError` trennt verworfen von abgebrochen.

Ein Kanal, der die Klasse nicht importieren kann (z. B. direkt aus dem Vorbild
übernommen), wird an der Meldung erkannt (`isQuestionDismissed`); dessen eigene
Meldung wird hinten angehängt, damit die Diagnose nicht verlorengeht.

**Leerer Freitext ist kein Skip.** `[""]` heißt „der Nutzer hat etwas getippt
und es war leer", `[]` heißt „übersprungen". Das Tool führt diese beiden nicht
zusammen (und trimmt nichts — siehe unten).

### Die Antwort ist nicht vertrauenswürdig

`result.answers` ist **unvertrauenswürdiger Text, den ein Mensch getippt hat**,
und das Tool reicht ihn **wortgleich** durch: nicht getrimmt, nicht normalisiert,
nicht interpretiert, nicht als Markup gelesen. Das ist Absicht und getestet
(`test/contract.test.ts`): ein späteres, „hilfreiches" Trimmen würde Transkript
und Modelleingabe darüber uneinig machen, *was der Nutzer gesagt hat*.

**Harte Anforderung an Welle 2.** Dieser Text landet ungefiltert im
Modelkontext, und **derselbe Tab hält den API-Key** (`AGENTS.md` §2 — Keys
liegen im Browser-Storage, also dieselbe Origin und dieselbe
Injection-Grenze). Vor dem Weg zum Modell **muss** der Text abgegrenzt werden:
als Daten, die vom Nutzer stammen, nicht als Anweisung an das Modell. Die Naht
dafür ist `toModelOutput` in `packages/baah-core/src/agent/tools.ts`, das über
`renderToolOutput()` das `JSON.stringify` der `{answers}`-Struktur ausgibt. Das
ist maschinelles Quoten, **kein Framing** — es sagt dem Modell nicht, dass der
Inhalt vom Nutzer stammt und nicht von ihm.

Die konkrete Formulierung wird hier **nicht** festgelegt. Der Baukasten schreibt
`User has answered your questions: "Q"="A"` und zerlegt damit die Rahmung, sobald
die Antwort selbst ein `"` enthält; die strukturierte Form `{answers: string[][]}`,
die wir liefern, ist dagegen der richtige Ausgang. Festgelegt ist hier nur die
Pflicht: **Welle 2 muss rahmen und deligitieren.**

## Injektions-Vertrag für die Engine (Welle 2)

1. **`channel` pro Turn/App bauen und mitgeben.** Der Channel hält den
   Pending-Promise pro Frage und wird in der Transcript-UI aufgelöst.
2. **Ohne Channel läuft nichts ins Hängen.** `createQuestionTool()` ohne Option
   benutzt `disconnectedQuestionChannel`, das jeden Aufruf mit
   `NO_CHANNEL_MESSAGE` ablehnt. Das ist der Zustand für einen Headless-Lauf
   (Test, Batch, Loop-Skript): sichtbarer Fehler statt Endlos-Turn.
3. **Der Channel muss das Signal selbst mitlesen** — er bekommt es nicht
   durchgereicht. Er kann sich beim Turn-Abbruch selbst abmelden und seine
   offene Karte schließen; das Tool lehnt den Aufruf in jedem Fall sofort ab
   (`ABORTED_MESSAGE`). Detail: die Signalprüfung läuft **vor** `ask()`, ein
   bereits abgebrochener Turn öffnet also keine Karte.
4. **Der Channel unterscheidet Skip und Verwerfen** (siehe oben): `resolve` mit
   leerer Zeile vs. `reject` mit `QuestionCancelledError`.
5. **Der Channel schließt seine Karte selbst, wenn er ablehnt.** Wird `ask()`
   abgelehnt, muss das Panel verschwinden — sonst bleibt eine Karte stehen, auf
   die niemand mehr wartet.
6. **Die Engine parst `inputSchema`, bevor sie `execute` ruft.** Das ist
   dokumentierter Vertrag, und die Engine ist die Partei, die ihn einhält:
   `createToolSet` in `packages/baah-core/src/agent/tools.ts` ruft
   `parseInput(schema, rawInput, toolName)` **vor** `execute` — in *jedem* Pfad,
   auch vor dem Replay-Short-Circuit. Die Grenzwerte (Header ≤ 30 Zeichen,
   1–8 Optionen, 1–10 Fragen) stehen nur im Schema, weil das Modell sie bricht;
   `execute` prüft sie **kein zweites Mal** (kein zweites Schema, `Plan.md`
   §4.2). Was passiert, wenn der Parse übersprungen wird: `execute` bekommt
   Rohdaten, `ask()` rendert eine 30-Optionen-Karte, und `options` kann leer
   sein. `test/characterisation.test.ts` macht diese Grenze sichtbar, indem es
   Input durchreicht, den das Schema ablehnen würde.
7. **Der Default-Export `questionTool` ist die Variante ohne UI.** Für Tests
   brauchbar, für die App nicht.

## Warum `access: "read"`

Fragen ist kein Seiteneffekt: es wird nichts im Workspace, nichts in der DB und
nichts am Nutzerkonto verändert. `access: "read"` ist damit die *richtige*
Klassifikation.

Die frühere Begründung „`read` ⇒ keine Freigabe" war allerdings **falsch**, und
zwar an der entscheidenden Stelle. Die Freigabe-Entscheidung des SDK-Runs fällt
**nicht** über `access`, sondern über die Action-Tabelle — und dort hat
`question` einen **expliziten** Eintrag, der den `access`-Fallback schlägt:

```ts
// packages/baah-core/src/agent/approval.ts   (in Arbeit, siehe Hinweis unten)
question: { action: "question", resource: () => "*" },   // DEFAULT_APPROVAL_TARGETS
todo:     { action: "todo",     resource: () => "*" },   //

// buildApprovalTargets()
resolved.set(
  definition.id,
  options.overrides?.[definition.id] ??
    DEFAULT_APPROVAL_TARGETS[definition.id] ??   // ← question landet hier …
    targetForAccess(definition),                 // ← … der access-Fallback greift NICHT
);
```

`question` wird also **unter der Action `question`** beurteilt, nicht unter
`read`. Praktisch: der `access`-Wert entscheidet an dieser Stelle nichts, und die
Default-Regel `{ action: "*", resource: "*", effect: "allow" }` lässt die Frage
durch. Der Nutzer kann `question` sehr wohl sperren oder an eine eigene Regel
binden — nur eben über eine Regel für die Action `question`, und das ist genau
die richtige Stelle.

> **`approval.ts` ist noch in Arbeit** (Welle 1, Agent aktiv): Tabelle und
> Zeilennummern können sich verschieben. Wer diese Begründung weiterträgt, prüft
> sie vorher neu. Die *Entscheidung* (`read`, siehe unten) gilt unabhängig vom
> Dateistand.

Was `access: "read"` tatsächlich bewirkt, ist an **zwei** Stellen:

1. `createToolSet` schaltet den `ctx.approve`-Helfer auf `allow-once` frei
   (`tools.ts`, `definition.access === "read" ? …`). Dieses Tool ruft
   `ctx.approve` ohnehin nie — das ist eine Bequemlichkeit für andere Tools,
   keine Freigabe-Regel.
2. Die Klassifikation im Tool-Dokument selbst: `read` sagt dem Leser „fragt,
   schreibt nicht".

Strenger wäre `write` — dann stünde **eine Freigabekarte vor der Fragkarte**,
zwei Modals für eine Interaktion, die ohnehin blockierend auf den Nutzer wartet.
Das einzige reale Risiko ist ein runaway Modell, das viele Fragen stellt;
gedeckelt sind das durch `MAX_QUESTIONS` (10) und den Abbruchpfad. Die
Freigabekarte *ersetzt* die Fragkarte außerdem nicht, sie **verzögert** sie um
einen Klick, den der Nutzer ohnehin machen müsste.

## Schema-Grenzen (was das Modell tatsächlich liest)

`inputSchema` ist die einzige Parameter-Wahrheit (`Plan.md` §4.2), und der AI SDK
leitet daraus das JSON-Schema ab, das das Modell sieht. Deshalb ist der
**`description`-Text Teil des Vertrags, nicht Dekoration**:

| Feld | Grenze | `description` an das Modell |
|---|---|---|
| `questions` | 1–10 | „The questions to ask, in the order they should be shown." |
| `question` | 1–1000 Zeichen | „The complete question, phrased so it can be answered without more context." |
| `header` | 1–30 Zeichen | „Very short label for the card, max 30 characters." |
| `options` | **1**–8 | „At least 1 and at most 8 options. A single option is allowed and reads as a confirmation …“ |
| `options[].label` | 1–100 Zeichen | **„Display text (1-5 words, concise)"** |
| `options[].description` | 1–500 Zeichen, optional | „One sentence explaining the consequence of picking this option." |
| `multiple` | Boolean, optional | „Set to `true` to let the user pick more than one option." |

Zwei Einträge sind bewusst wörtlich aus dem Vorbild übernommen und mit Test
festgenagelt:

- **Eine Option ist erlaubt** — untere Grenze **1**, nicht 2. Das Vorbild
  (OpenCode v2.0.19) setzt gar keine Untergrenze und fährt in seinem eigenen Test
  (`packages/core/test/tool-question.test.ts` upstream) eine Ein-Option-Frage:
  die Form „bestätige das". Jedes Modell, das eine binäre Frage beantworten kann,
  erzeugt genau das; `min(2)` wäre eine harte Schema-Ablehnung eines Aufrufs, den
  die Karte einwandfrei dargestellt hätte. Die Obergrenze bleibt 8.
- **`label` trägt die Längenkonvention** („1-5 words"). Die UI rendert `label` als
  **auswählbaren Button**; ohne diese Angabe produziert das Modell Button, die
  nicht klickbar sind.

Beide werden in `test/contract.test.ts` über `z.toJSONSchema(questionInputSchema)`
gegen das **modell-sichtbare** Schema geprüft — als Literal, nicht gegen eine
interne Konstante. Eine Konstante würde einem Rewording folgen statt es zu
verhindern.

## Tests

```bash
pnpm --filter @all-the.rest/baah-tool-question typecheck
pnpm --filter @all-the.rest/baah-tool-question test
```

| Datei | Deckt ab |
|---|---|
| `test/question.test.ts` | Weiterleitung und Antwortreihenfolge, ablehnender Channel, fehlender Kanal, Abbruch während und vor dem Warten, Antwortform und Zeilenzahl, Schema-Grenzen (Header, Optionen, Fragen), die Konventionen in der Tool-Beschreibung |
| `test/characterisation.test.ts` | vom Verify-Agenten geschrieben: Abort-Listener-Lebenszyklus, `multiple` als echtes Feld, alle drei Längen-Caps, leere Frage, `ToolError`-Identität, und die Grenze „`execute` parst nicht selbst" |
| `test/contract.test.ts` | Ein-Option-Frage und die `max(8)`-Grenze, verworfen-vs-übersprungen (typisiert und vom Modell unterscheidbar), wortgleicher Durchlass der Antwort, `label`-Beschriftung im modell-sichtbaren Schema |

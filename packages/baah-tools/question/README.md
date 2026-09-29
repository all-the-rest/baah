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
Reihenfolge. Leere Zeile = übersprungen. Freitext-Antworten kommen als ein
einzelner String so zurück, wie der Nutzer ihn getippt hat. Weicht die Antwort
vom Schema oder von der Zeilenzahl ab, wirft das Tool einen `ToolError` mit
Handlungsanweisung — es wird nicht still repariert.

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
4. **Die Engine parst `inputSchema`, bevor sie `execute` ruft** (`Plan.md` §4.2).
   Die Grenzwerte (Header ≤ 30 Zeichen, 2–8 Optionen, 1–10 Fragen) stehen im
   Schema, weil das Modell sie bricht; `execute` prüft sie nicht ein zweites Mal.
5. **Der Default-Export `questionTool` ist die Variante ohne UI.** Für Tests
   brauchbar, für die App nicht.

## Warum `access: "read"`

Fragen ist kein Seiteneffekt: es wird nichts im Workspace, nichts in der DB und
nichts am Nutzerkonto verändert. Die Aktion `question` in `Plan.md` §7.2 ist aus
dem Vorbild übernommen und erreicht über `access: "read"` nie die Freigabe-Logik
(`access !== "read"` ⇒ `approve()`). Strenger wäre `write` — dann stünde **eine
Freigabekarte vor der Fragkarte**, zwei Modals für eine Interaktion. Das
einzige reale Risiko ist ein runaway Modell, das viele Fragen stellt; gedeckelt
sind das durch `MAX_QUESTIONS` (10) und den Abbruchpfad.

## Tests

```bash
pnpm --filter @all-the.rest/baah-tool-question typecheck
pnpm --filter @all-the.rest/baah-tool-question test
```

`test/question.test.ts` deckt Weiterleitung und Antwortreihenfolge, einen
rejizierenden Channel, den fehlenden Kanal, Abbruch während und vor dem Warten,
die Antwortform, die Schema-Grenzen (Header > 30, Optionen < 2 / > 8) und die
Konventionen in der Tool-Beschreibung ab.

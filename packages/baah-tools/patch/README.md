# `@all-the.rest/baah-tool-patch`

Mehrere exakte Ersetzungen in **einer** Datei, angewandt als **ein** Schreibvorgang.
Der Mehr-Hunk-Editor auf `edit`-Basis, den `Plan.md` §4 vorsieht.

## Die Entscheidung: Kontext, nicht Zeilennummer

Die Alternative war eine echte. Ein Hunk könnte `startLine` tragen, und das
Werkzeug würde an dieser Position splicen. Sie ist abgelehnt — und der Grund ist
nicht, dass es ungenauer wäre, sondern was eine veraltete Zeilennummer anrichtet,
wenn sie falsch ist.

Ein Modell erzeugt eine Zeilennummer aus einem Read, der vierzig Schritte
zurückliegen kann. Seit diesem Read können ein früherer `edit` im selben Turn,
ein `write` aus einem Retry oder der Nutzer selbst in einem echten
File-System-Access-Ordner die Datei verschoben haben. Eine Zeilennummer gilt
gegenüber **genau einer** Revision **genau einer** Datei, und dieses Werkzeug weiß
nicht, welche Revision das Modell gesehen hat.

Und jetzt der gefährliche Fall: Eine veraltete Zeilennummer, deren Kontext
**nicht mehr passt**, ist laut — die Datei ändert ihre Form und der eingefügte
Text ist sichtbar falsch. Gefährlich ist der andere Fall: Eine Datei, die sich
**um dieselbe Zeilenzahl an anderer Stelle** geändert hat. Die Nummer bleibt im
Bereich, das Werkzeug schreibt fröhlich, und der Hunk landet still an der
falschen Stelle. Zeilennummern sind also nicht die schwächere Übereinstimmung,
sie sind ein **Korrosionsvektor**: sie machen „das Modell war veraltet" von „der
Patch saß" ununterscheidbar.

Ein Kontext-Match hat das entgegengesetzte Fehlerprofil, und es ist das gute:
Es passt entweder — und das Ergebnis meldet die Zeile, auf der jeder Hunk
landete, ein falscher-aber-erfolgreicher Patch ist also im Output sichtbar — oder
es passt nicht, und der Aufruf scheitert mit unberührter Datei.

Das ist auch, was `edit` bereits entschieden hat: exaktes Teilzeichen, "deliberately
not fuzzy". Zeilennummern wären genau das unscharfe Matching, das `edit`
abgelehnt hat — nur schlimmer, weil sie nicht einmal sagten, worauf sie passten.
`Plan.md` §4 nennt dieses Werkzeug einen "Mehr-Hunk-Editor auf `edit`-Basis", und
die Basis ist die Übereinstimmungsregel, nicht nur die Datei-API.

**Also eine Mechanik, nicht zwei.** Kein `startLine`, kein unscharfer Fallback,
kein "erst die Nummer, dann der Kontext". Zwei Verfahren bräuchten eine
festgelegte Regel, welches gewinnt, wenn sie sich widersprechen — und es gibt
keinen Widerspruch darüber, welchem man trauen kann: Der Kontext ist überprüfbar,
die Nummer ist es nicht.

## Die Reihenfolge, und warum sie ausreicht

**Sequenziell, in der angegebenen Reihenfolge**, jeder Hunk gegen den Text, den
seine Vorgänger erzeugt haben. Das macht "einfügen, dann den eingefügten Text
umschreiben" ausdrückbar, und es macht Überlappung automatisch erkennbar: Wenn
`before` von Hunk 2 in dem Bereich liegt, den Hunk 1 ersetzt hat, findet Hunk 2
seinen Text nicht mehr, und der Aufruf scheitert, statt zu raten. Eine
zusätzliche Überlappungserkennung wäre Code, der nicht gebraucht wird
(`AGENTS.md` §5).

Weil die Zählung gegen den **momentanen** Text läuft, ist auch der Fall
abgedeckt, der eine Zählung gegen den Originaltext verfehlt: `before` ist
eindeutig, und ein früherer Hunk hat es **dupliziert**. Das ist ein Fehler, kein
Glückstreffer.

## Die Regel für Mehrdeutigkeit

Jedes `before` muss **in dem Moment genau einmal** passen. Sonst `ToolError`, mit
der Anzahl und der Abhilfe.

Kein `replaceAll` je Hunk, aus zwei Gründen: Bei *n* Hunks ist "ersetze alle
Vorkommen von Hunk 1, dann Hunk 2" etwas, das kein Modell meint; und es würde die
Eindeutigkeitsaussage schwächen, weil das `before` eines Hunks nach dem `after`
eines früheren wieder auftauchen kann.

## Die Leerdatei-Sperre

Ein Patch, der die Datei leeren würde, wird **abgelehnt**.

Jeder andere Ausgang ist reparierbar, indem man die korrigierten Hunks erneut
schickt — der alte Text ist noch da, um dagegen zu matchen. Eine leere Datei hat
keinen Text mehr, gegen den zu matchen wäre, der Workspace hat kein Undo, und das
Werkzeug würde `hunksApplied: 2` melden, als sei es erfolgreich gewesen. Das ist
der einzige Weg, auf dem dieses Werkzeug Arbeit ohne Nachricht verliert.

Verweigert wird **Leere**, nicht Schrumpfen. Jede große Löschung zu verbieten würde
das Werkzeug für das unbrauchbar machen, wofür es da ist — der Test
`a file that is one line shorter is still allowed` hält diese Grenze am Leben.

## Atomarität, und wie sie bewiesen ist

`applyHunks` ist eine reine Funktion `(text) => text`: kein Workspace-Zugriff,
kein Seiteneffekt, entweder das fertige Ergebnis oder ein Fehler. Das **ist** die
gesamte Garantie — die teilweise Datei verlässt diese Funktion nie, und der
*einzige* Weg zu einer Teil-Datei wäre ein Schreibvorgang **innerhalb** der
Schleife. Genau diese Mutation wird getötet.

Ein Rücklesen des Dateiinhalts nach einem fehlgeschlagenen Patch ist aber **kein**
Beweis. Drei Implementierungen hinterlassen die Datei byte-identisch, und nur eine
ist atomar:

| Implementierung | Inhalt nach dem Fehlschlag | `writeText`-Aufrufe |
|---|---|---|
| im Speicher bauen, einmal schreiben (diese) | unverändert | **0** |
| nach jedem Hunk schreiben | teilweise gepatcht | n |
| beim Fehlschlag zurückschreiben | unverändert | **2** |

Die Rückroll-Variante sieht ein Inhaltsvergleich nicht — und sie ist auch nicht
atomar: Ein zweiter Fehlschlag, ein mitten im Rückroll geschlossener Tab oder
ein werfendes `createWritable` hinterlässt genau die Teil-Datei, die das
Werkzeug zu erzeugen verspricht.

**Gemessen, nicht angenommen.** Die Rückroll-Variante wurde als Mutation
geschrieben und zweimal gegen diese Suite laufen gelassen: einmal komplett, einmal
mit allen elf `expect(writes…)`-Zusicherungen aus `verify-atomicity.test.ts`
entfernt und sonst nichts geändert.

- komplette Suite: getötet, von dieser Datei;
- ohne die Schreibzählung: **überlebt**, 51 Tests grün.

Die Inhaltsrücklesen haben also **null** Kraft gegen die Mutation, auf die es
ankommt. Deshalb sind die Zählzusicherungen kein Beiwerk.

## `patch` erstellt keine Datei

Fehlt die Datei, ist das ein `ToolError` — *bevor* irgendein Hunk geprüft wird,
sonst würde das Modell told "repariere deinen Hunk" statt "die Datei fehlt". Und
`write` erstellt; `patch` nicht: ein Patch, der auf halbem Weg scheitert,
hinterließe eine neue Datei.

## Abhängigkeiten

`@all-the.rest/baah-core`, `zod`. Sonst nichts.

`MAX_RESULT_BYTES` ist bewusst **nicht** aus dem `write`-Paket importiert:
`AGENTS.md` §4 verbietet Abhängigkeiten zwischen Werkzeugen, also steht die Zahl
hier noch einmal. Das ist eine Folge der Schichtregel, nicht eine Reuse-Lücke.

## Tests

```
pnpm --filter @all-the.rest/baah-tool-patch typecheck
pnpm --filter @all-the.rest/baah-tool-patch test
```

`test/patch.test.ts` — Verhalten und Grenzfälle, `test/verify-atomicity.test.ts` —
die Schreibzählung und die Messung oben, `test/verify-schema.test.ts` — Schema,
`access`, und die Zusage, dass kein Zeilennummern-Parameter ins Schema
zurückkehrt.

Gemessen: **16 Mutationen, 0 überlebt** (8 in diesem Paket, 8 in `webfetch`).

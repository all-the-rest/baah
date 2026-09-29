# `@all-the.rest/baah-tool-grep`

Regex-Volltextsuche im Workspace. Reines `RegExp`, keine WASM, kein
Server.

## Was tatsächlich läuft

Es gibt **genau eine Engine**: einen zeilenweisen `RegExp.test` über die
Kandidatenliste (`searchWithRegExp` in `src/index.ts`). Kein `engine`-Feld im
Ergebnis, kein `GrepEngine`-Typ, kein Fallback-Zweig — ein Weg, der immer geht.

### Der Grund, und was daraus folgt

`grep-wasm@0.1.0` (echtes ripgrep als WASM) war vorgesehen
(`Plan.md` §4, §14.5). Es wurde entfernt, weil die Begründung für seinen
Verbleib nicht haltbar war:

- **Die beiden Wege waren nicht gleichwertig.** Gemessen: `\p{L}+` liefert auf
  WASM 6 Treffer und auf dem JS-Scanner 0 (ohne `u`-Flag ist `\p` ein
  Identity-Escape, also das Zeichen `p`). Lookbehind und Backreferences werden
  von der einen Engine abgelehnt und von der anderen akzeptiert. Ein Fallback,
  der eine *andere, schwächere* Abfragesprache ist, ist kein gleichwertiger
  Pfad.
- **Das Schema hat keine Fähigkeit von ripgrep angeboten.** Kein `-v`, `-c`,
  `-m`, `-A/-B/-C`, `-o`, kein Multiline, keine Binärsuche. Sechs Parameter, null
  davon ein ripgrep-Feature. Es gab keinen Codepfad, in dem ripgrep etwas
  konnte, was der JS-Scanner nicht konnte — gekauft wurde nur Geschwindigkeit,
  und das Werkzeug deckelt sich ohnehin auf 16 MiB pro Aufruf.
- **Der Browser-Pfad war schon falsch, nicht nur ungetestet.**
  `module.ripgrep.init()` wurde ohne Argument aufgerufen, die Binär-URL also aus
  der Modul-URL abgeleitet. `packages/baah-web/vite.config.ts` setzt kein
  `base`; bei statischem Hosting unter einem Sub-Pfad löst der Fetch auf den
  Domain-Root auf und liefert 404.
- **Es lief nie.** In keinem der Tests dieses Pakets. `grep-wasm@0.1.0`
  veröffentlicht `dist/index.js` mit relativem Specifier ohne Endung
  (`export * from './sdk'`), den Node's ESM-Resolver ablehnt — jede Ausführung
  wäre über den Fallback gelaufen.

Soll ripgrep als **Opt-in-Beschleuniger** zurückkommen, dann mit einem
Äquivalenztest gegen `searchWithRegExp` über genau den Dialekt, den die
Toolbeschreibung verspricht — nicht als unverifizierter Standard mit stillem
Fallback. Das ist die Bedingung, keine Absichtserklärung.

`packages/baah-web/vite.config.ts` führt `grep-wasm` in
`optimizeDeps.exclude` weiter. Dieser Eintrag ist nach dieser Änderung tot und
gehört bereinigt (Eigentum: Orchestrator, nicht dieses Paket).

## Der Dialekt

Das Muster ist eine Teilmenge von ripgrugs Rust-Regex, implementiert als
JavaScript-`RegExp`. Was das heißt, steht im `pattern`-`.describe` und in der
Toolbeschreibung, damit das Modell es vor dem Schreiben weiß:

| Muster | Verhalten | Grund |
|---|---|---|
| Lookaround `(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)` | **funktioniert** | JS kann es, ripgrep nicht. Nicht portabel. |
| Backreferences `\1` | **funktioniert** | dito |
| Unicode-Properties `\p{L}` | **wirkt als literales `p`** | nur mit `u`-Flag, und `u` bricht Lookbehind und Backreferences. Bewusste Festlegung, dokumentiert. |
| Inline-Flags `(?i)` | **Fehler** | `new RegExp` lehnt sie ab. Die Fehlermeldung nennt `caseSensitive` und `literal` als Auswege. |
| Verschachtelte Quantoren `(a+)+$` | **funktioniert, kostet exponentiell** | siehe Timeout. |

## Die Kappen — und wie man Vollständigkeit liest

Jedes Ergebnis trägt `searchTruncated`. Das ist das Feld, das vor jeder
Aussage über Vollständigkeit gelesen werden muss:

| `searchTruncated` | Bedeutung |
|---|---|
| `false` | Alles durchsucht. `total: 0` heißt: kein Treffer im Workspace. |
| `true` | **Nicht** alles durchsucht. `total: 0` heißt: „Ich habe aufgehört zu suchen", nicht „gibt es nicht". |

`truncated` bedeutet etwas anderes: `limit` hat die Trefferliste gekürzt. Die
Suche selbst war vollständig.

### Was die Kappen auslösen

| Ursache | `note` | Grenze |
|---|---|---|
| `bytes` | `Read stopped at the 16777216-byte budget (16 MiB).` | `MAX_TOTAL_BYTES` = 16 MiB. Eine Datei, die die Grenze reißen *würde*, wird weder gelesen noch durchsucht. `bytesRead <= maxBytes` ist eine Invariante, kein Zufall — das war vorher falsch (gemessen: `bytesRead = 17,510,495` bei `maxBytes = 16,777,216`). |
| Datei zu groß | — | `MAX_FILE_BYTES` = 1 MiB. Wird in `filesSkipped` gezählt, und der `hint` nennt die Ursache und die zwei Abhilmen, die wirken (`path`/`include` verengen, oder die Datei direkt mit `read` öffnen). Früher stand dort Advice, die diese Datei nie sichtbar gemacht hätte. |
| `walk` | `The workspace walk stopped at its 50000-entry cap; …` bzw. `The workspace walk used its whole 50000-entry budget, so entries beyond it may exist and were not visited.` | `DEFAULT_MAX_ENTRIES` in `baah-core` — **eine** Quelle, importiert und nicht gespiegelt. `Workspace.walk` liefert inzwischen ein `WalkResult` mit `truncated` (`true` nur, wenn der Walk am Cap stehen blieb, obwohl noch Einträge da waren) und `visited`; dieses Werkzeug zählt nichts mehr selbst. Die konservative Verschiebung bleibt, liegt aber in `walkMayBeIncomplete()` im Walk-Modul: ein Workspace mit *genau* 50 000 Einträgen wird weiterhin als möglicherweise unvollständig gemeldet, obwohl sein Walk fertig war. Der Fehler ist absichtlich einseitig. |
| `timeout` | `Matching stopped after 5000 ms.` | `SEARCH_TIMEOUT_MS` = 5 s, geprüft **vor jeder Zeile**. |
| `abort` | je nach Schleife verschieden: `Search aborted — the walk stopped before it had seen every entry.`, `Search aborted after N of M candidate files were read.`, `Search aborted; all N read files were handed to the matcher, which stopped part-way through.` | `ToolContext.signal`. Drei Abbruchstellen (Walk, Read-Loop, Matcher), drei Wortlaute — der Grund wird genannt, weil ein Abort (neu starten) und ein Cap (`path` verengen) verschiedene nächste Schritte bedeuten. Auch ein Abort, der während des letzten Reads landet, wird berichtet; das war vorher unsichtbar. |

### Warum 5 s und nicht die 30 s der Referenz

Die Referenz (`opencode` v2.0.19, `FileSystem.DEFAULT_SEARCH_TIMEOUT_MS`) legt
ihre 30 s um einen **nativen ripgrep-Prozess in einem Server**. Dort sind 30 s
eine langsame Antwort. Hier ist derselbe Wert 30 s eingefrorener Main Thread, aus
dem der Nutzer nicht heraus-scrollen kann.

Gemessen auf dieser Maschine, Muster `(a+)+$` gegen `"a"×N + "b"`:

| N | 24 | 26 | 28 | 30 |
|---|---|---|---|---|
| Zeit | 305 ms | 1,1 s | 4,6 s | 19 s |

Verdopplung pro zwei Zeichen — gemessen, nicht vermutet. Gemessen wurde auch
die **legitime** Obergrenze: 16 MiB echter Quellcode (207 121 Zeilen) durch
`\w+\s*=\s*\w+;?$` = 502 ms; alle anderen gemessenen Muster ≤ 103 ms. 5 s ist
also eine Größenordnung Luft über realer Arbeit und begrenzt trotzdem den
pathologischen Fall. Ein Schnitt wird **immer** gemeldet, nie stillschweigend
geschluckt.

### Das Restrisiko, ehrlich benannt

Der Timeout begrenzt die **Schleife**, nicht eine einzelne Auswertung: ein
`RegExp.test` kann von innen nicht unterbrochen werden. Eine einzelne Zeile, die
selbst 19 s braucht, läuft 19 s. Bei `"a"×100 000` in einer Zeile kehrt der Test
nicht zurück. Innerhalb dieses Pakets ist das nicht behebbar — es bräuchte einen
Web Worker für den Scan. Was hilft, ist messbar begrenzt: der
1-MiB-Einzeldatei-Deckel hält die Zeilenlänge im Bereich, und `MAX_LINE_LENGTH`
begrenzt, was *zurückgegeben* wird. Der Test
`the residual risk: one line that never returns` hält diese Aussage am Leben.

## `include` — der Glob-Konverter

`grep` hat absichtlich **keine** picomatch-Abhängigkeit: `include` ist ein
Filter, kein Produkt. `globToSource` deckt `*`, `**`, `?`, `[…]`, `{a,b}` und
`\`-Escapes ab — nachweislich gleichwertig zu picomatch auf diesem Subset
(`test/verify-include.test.ts` benutzt picomatch als Orakel).

Was der Konverter **nicht** kann, lehnt er jetzt ab, mit einer
`ToolError`, die das Modell lesen kann:

- `!`-Negation (`!*.ts`)
- Extglobs (`@(a|b)`, `*(a)`, `?(a)`, `!(a)`, `+(a)`)
- POSIX-Klassen (`[[:alpha:]]`)
- leerer String

Vorher kam in allen vier Fällen ein leeres Ergebnis zurück — nicht
unterscheidbar von „keine Datei passt". Das war der eigentliche Defekt, nicht
der eingeschränkte Umfang. Zwei weitere Divergenzen wurden *repariert* statt
abgelehnt, weil sie billig ausdrückbar waren: `{a}` ohne Komma ist jetzt der
literale Text `{a}` (wie picomatch), und `a\*b.ts` ist jetzt eine echte Escape-
Sequenz (wie picomatch).

## Was `glob` zusätzlich kann

`glob` hat dieselben drei Suchgrenzen, aber keine Zeitgrenze — und das ist
beabsichtigt, nicht vergessen: sein Walk ist `async` und yielded zwischen den
Einträgen, kann also im Gegensatz zum synchronen Regex-Scan des `grep` den Main
Thread nicht in einem Schritt blockieren. Begrenzt wird er über
`DEFAULT_MAX_ENTRIES` (aus `baah-core`) und `signal`, beides in
`glob/test/verify-walk-cap.test.ts` und `glob/test/glob.test.ts` belegt. Offen bleibt der Fall, in dem ein
`values()`-Aufruf eines echten Verzeichnis-Handles selbst hängt.

## Abhängigkeiten

`@all-the.rest/baah-core` (inkl. `baah-core/ignore`), `ignore@7`, `zod`.
Kein `grep-wasm` mehr — es ist aus `package.json` und `pnpm-lock.yaml`
entfernt.

## Tests

```
pnpm --filter @all-the.rest/baah-tool-grep typecheck
pnpm --filter @all-the.rest/baah-tool-grep test
```

`test/verify-bounds.test.ts` deckt Abort und Timeout ab,
`test/verify-limits.test.ts` die Byte-Kappen und den Walk-Cap,
`test/verify-include.test.ts` den Glob-Konverter gegen picomatch,
`test/verify-engines.test.ts` den einen Motor und seinen Dialekt,
`test/verify-schema.test.ts` die Parameter gegenüber der Referenz.

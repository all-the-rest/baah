# Projekt- und Konversationsmodell — was der Nutzerbegriff im Code bedeutet

**Zweck.** Der Nutzer hat gefragt: Nachrichten mit derselben Message-ID sind eine eigene
Konversation in einem Projekt; ein Projekt ist ein geöffneter Ordner; die Identität muss über
mehrere Läufe eindeutig bleiben. Dieser Text prüft diese Aussage gegen den **bestehenden
Code** und benennt die Lesarten, die sie trägt. Er ist eine Analyse, kein Bauplan — jede
„Empfehlung" unten ist eine Frage, die der Nutzer beantworten muss, keine implementierte
Entscheidung.

Alle Angaben sind gemessen (gelesen und Treffer gezählt), nicht aus Plan.md oder AGENTS.md
übernommen. Wo ich etwas **vermutet** habe, steht das dabei.

---

## 0. Kurzfassung der drei Antworten

1. **„Konversation" existiert heute nicht als Oberfläche, sondern als *eine* Zeile.**
   `sessions` ist das, was der Nutzer Konversation nennt — aber die App erzeugt genau
   **eine** davon und kann keine zweite erzeugen. Es gibt keine UI, die zwischen Sessions
   wechselt (gemessen: kein Aufrufer von `listSessions` außerhalb `baah-storage`/Tests,
   kein Session-UI in `packages/baah-web/src`).

2. **„Über mehrere Läufe eindeutig" überlebt heute genau *einen* Fall: Reload.**
   Alles andere (Tab schließen, localStorage löschen, Website-Daten löschen, Ordner
   wechseln, Rechner wechseln) lässt die heutige Sitzung **nicht** eindeutig. Das ist kein
   Mangel der Formulierung, sondern der Zustand des Codes.

3. **Die Wurzel-Nachricht-Regel (Lesart 1) ist mit dem bestehenden Schema nicht
   vereinbar** und würde zwei Dinge zerstören, die dort gemessen und begründet sind. Ich
   empfehle eine **vierte Lesart**, die ich unten begründe.

---

## 1. Die Lesarten von „Nachrichten mit der gleichen Message id"

Der Satz erlaubt mindestens drei, und die Folgen sind unvereinbar. Ich habe eine vierte
gesehen, die die anderen drei ersetzt.

### Lesart 1 — Wurzel-Nachricht (die Annahme des Build-Auftrags)

> Die Identität einer Konversation ist die Message-ID ihrer **Wurzel**-Nachricht. Alle
> Nachrichten mit dieser Wurzel-ID bilden eine Konversation in diesem Projekt.

**Gemessen: die Datenstruktur, die diese Regel bräuchte, ist nicht vorhanden — und die
vorhandene ist ihr Gegenteil.**

- `messages.parent_id` existiert (`packages/baah-storage/src/schema.ts:77`) und hat sogar
  einen Index (`schema.ts:250`, `idx_messages_parent_id`).
- **Aber `parent_id` wird nie geschrieben.** Der einzige Parameterpfad ist
  `packages/baah-storage/src/sql.ts:344` (`input.parentId ?? null`), und **kein Aufrufer
  außerhalb der Tests übergibt ihn**: `rg "parentId:"` über `packages/*/src` findet nur
  Typdeklarationen und das NULL-Default in `factory.ts:459` / `factory.ts:516`. Die
  Outcome-Nachricht setzt es hart auf `NULL` (`sql.ts:560`).
- Ergebnis: **jede Nachricht ist heute eine Wurzel.** `parent_id` ist `NULL` für alle
  Zeilen. Ein Aufstieg über `parent_id` — die Formel, die Lesart 1 braucht — hat **nichts
  zu laufen**.
- Verschärfend: `messages.id` ist der **Primärschlüssel** (`schema.ts:74`). „Alle Nachrichten
  mit derselben Message-ID" ist damit per Definition **eine** Zeile. Lesart 1 ist in ihrer
  wörtlichen Fassung mit dem Schema **unvereinbar** — sie kann nicht einmal implementiert
  werden, ohne den Primärschlüssel aufzugeben.

Zusatzkosten, gemessen: `messages.seq` ist `MAX(seq) + 1` **pro Session**
(`sql.ts:124`, `INSERT_MESSAGE`), mit `UNIQUE (session_id, seq)` (`schema.ts:94`). Eine
Konversation als Teilmenge einer Session bräuchte also ein **eigenes** Sortiersystem, oder
eine Session pro Konversation — Letzteres ist eine andere Lesart.

### Lesart 2 — Message-ID als Schlüssel, jede Nachricht eine eigene Konversation

> Jede Nachricht **mit** dieser ID ist **je eine eigene** Konversation.

Das ist mit dem Primärschlüssel vereinbar (jede Zeile = eine Konversation) und macht den
Satz „alle Nachrichten mit derselben ID" **redundant** — ein starkes Indiz, dass der Nutzer
das nicht gemeint hat. Es passt auch schlecht zum zweiten Halbsatz des Nutzersatzes
(*„soll über mehrere Läufe eindeutig bleiben"*): eine Konversation, die aus **einer**
Nachricht besteht, ist über Läufe hinweg identisch nur, solange die Nachricht existiert —
und ihre Existenz hängt an genau der Datenbank, die gelöscht werden kann.

### Lesart 3 — Message-ID der jeweils letzten Nachricht

> Die Konversation folgt dem Verlauf, ihre ID ist der **Fortschritt**.

**Widerlegt durch den zweiten Halbsatz des Nutzersatzes selbst.** Eine Identität, die sich
mit jeder Nachricht ändert, ist über Läufe nicht stabil — das ist kein Randfall, das ist die
Definition. Diese Lesart fällt ohne weitere Prüfung weg.

### Lesart 4 (meine Empfehlung) — Turn als Konversation, Session als Projekt, Nachricht als Anker

Hier ist die Beobachtung, die alle drei Lesarten überlebt und die ich für den
wahrscheinlichsten Kern des Nutzerwunsches halte:

- Der Nutzer nennt „Message id", weil das im aktuellen Code der **einzige** Identifier ist,
  den er je gesehen hat: `data-baah-message-id` (`packages/baah-web/src/lib/testids.ts:124`).
- Der **fachlich** passende Container existiert bereits und heißt `turn`: ein Turn ist genau
  eine Frage plus Antwort(en) plus Abschlussnachricht (`turns` in
  `packages/baah-storage/src/schema.ts:59-71`, `turn_id` in `messages`, `schema.ts:76`).
  Alle drei Nachrichtentypen eines Turns teilen sich **eine** `turn_id` — die
  Outcome-Nachricht wird über `INSERT_TURN_OUTCOME_MESSAGE` mit `t.id` geschrieben
  (`sql.ts:556-565`), die Prompt-Nachricht in `AgentTurn.#persistPrompt`
  (`packages/baah-core/src/agent/loop.ts:1347-1354`).
- Der Projekt-Begriff hat seinen Platz ebenfalls schon: **eine Session pro geöffnetem
  Ordner**. `sessions` bekäme den Ordner als Identität, `turns` wären die Konversationen.

**Die Empfehlung in einem Satz:** Der Nutzer hat vermutlich die Ebene benannt, auf der er
arbeiten will (Konversation), und den Identifier, den er dafür zur Hand hatte
(`messageId`) — aber die **fachlich richtige** Identifier-Ebene ist `turnId`, und die
**stabile über Läufe** Ebene ist der Ordner, nicht die Nachricht.

**Warum ich Lesart 1 für falsch halte, ohne Beschönigung:** Sie ist im bestehenden Schema
nicht implementierbar (Primärschlüssel), sie bräuchte eine Datenstruktur, die nie befuüllt
wird (`parent_id`, immer `NULL`), und sie widerspricht der Stabilitätsforderung, wenn man
sie zu Ende denkt. Wenn sie als Spezifikation in einen Bau-Auftrag geht, baut der
Bau-Agent etwas **sehr gut**, das die Nutzerfrage nicht beantwortet.

---

## 2. Frage 1 — Existiert „Konversation" heute als Begriff?

**Antwort: nein. Es existiert genau eine Session, und die App kann keine zweite erzeugen.**
Belegt, nicht geraten:

- `sessions` hat `title`, `status` (`active`/`archived`) und `archived_at`
  (`packages/baah-storage/src/schema.ts:44-57`). Der **Wert** von `title` ist heute ein
  Literal: `database.createSession({ id: sessionId, title: "Sitzung" })`
  (`packages/baah-web/src/components/lib/runtime.ts:341`). `rg "title:"` über
  `packages/baah-web/src` findet **keinen** zweiten Schreibvorgang — der Titel wird nie
  aktualisiert, nie aus dem Verlauf abgeleitet.
- `status = 'archived'` wird **nirgends in `src/` gesetzt** — nur gelesen
  (`operations.ts:199-212` normalisiert den Wert, `SELECT_SESSIONS` sortiert danach,
  `sql.ts:83-86`). Archivieren ist eine Spalte ohne Bedienung.
- **Keine UI zum Wechseln zwischen Sessions.** `listSessions` existiert als Port
  (`packages/baah-storage/src/operations.ts:322`, `types.ts:676`, `client.ts:252`), hat aber
  **null Aufrufer** außerhalb von `baah-storage` und dessen Tests. In
  `packages/baah-web/src` kommt das Wort „session" in genau **drei** Komponenten vor
  (`AppShell.tsx:85-87` als Inject, `ApprovalCard.tsx:13`/`:238` als Fließtext, sonst
  nirgends) — nirgends als etwas, zwischen dem man wechselt. Die einzige
  Session-Oberfläche ist `Transcript` mit dem Leerzustand „Noch nichts in diesem Verlauf."
  (`packages/baah-web/src/components/Transcript.tsx:104`).
- `workspaces` und `file_handles` existieren als Tabellen
  (`packages/baah-storage/src/schema.ts:172-195`) — und werden **nie beschrieben**. Gemessen:
  `rg "INSERT INTO workspaces|INSERT INTO file_handles"` findet **null** Treffer in
  `packages/*/src`; es gibt keine `operations`-Methode und kein Worker-Protokoll-Statement
  dafür (`rg "workspaces|file_handles"` in `protocol.ts`: null). Nur `directory-workspace.ts:44`
  erwähnt die Tabelle in einem Kommentar.

**Folge für die Aufgabenstellung:** Die Frage ist nicht „welche Spalte ergänze ich", sondern
**„welche Oberfläche entsteht"**. Es fehlen mindestens: eine Projektliste, eine
Konversationsliste, ein „neue Konversation"-Knopf, ein Ordnerwechsel mit Wirkung auf die
Daten. Das ist Welle-2-UI-Arbeit, nicht Schema-Arbeit.

---

## 3. Frage 2 — Was heißt „über mehrere Läufe eindeutig" technisch?

**Antwort: heute überlebt genau ein Fall — Reload.** Alles andere nicht. Die Forderung ist
also **größer, als sie klingt**, und das gehört in die Doku.

Was die Identität heute ist, gemessen:

- **Sitzung:** `sessionId` in `localStorage` unter dem Schlüssel `baah.session.v1`
  (`packages/baah-web/src/lib/ids.ts:100`), erzeugt von `resolveSessionId`
  (`ids.ts:144-181`), geprüft gegen `/^session-[A-Za-z0-9-]+$/` (`ids.ts:112`), geschrieben
  mit `backend.write(...)` (`ids.ts:169`) — `localStorage`, nicht SQLite (Begründung in
  `ids.ts:126-131`).
- **Daten:** eine SQLite-Datei in OPFS, Dateiname `/baah.sqlite3`
  (`packages/baah-storage/src/client.ts:67`), **eine** Verbindung pro Origin
  (`client.ts:399-405`, `errors.ts:13-15` `database_owned_by_another_context`).
- **Ordner:** ein `FileSystemDirectoryHandle` in einer eigenen IndexedDB
  (`baah-project-folder.v1`, Store `handles`, Schlüssel `selected` —
  `packages/baah-web/src/lib/project-folder.ts:392-394`).

Was das jeweils überlebt:

| Ereignis | `sessionId` | SQLite-Daten | Ordner-Handle | Ordner-**Zugriff** |
|---|---|---|---|---|
| Reload im selben Tab | ✅ | ✅ | ✅ | ✅ solange kein Tab geschlossen wurde |
| Tab schließen / neu öffnen | ✅ (`localStorage`) | ✅ | ✅ | ❌ Grant erlischt (Chrome) |
| `localStorage` leeren | ❌ **neue** Session | ✅ (verwaist) | ✅ | ✅ |
| „Website-Daten löschen" | ❌ | ❌ | ❌ | ❌ |
| Anderen Ordner wählen | ✅ (unverändert!) | ✅ (unverändert) | ✅ (der neue) | ✅ |
| Anderer Rechner | ❌ | ❌ | ❌ | ❌ |

Die Zeile „Anderen Ordner wählen" ist der interestingeste Befund: **der Ordnerwechsel hat
heute keine Wirkung auf die Sitzung.** `AppShell.openProjectFolder`
(`packages/baah-web/src/components/AppShell.tsx:112-132`) ruft `app.workspace.swap(...)` —
nur der Workspace-Ziel wechselt, `sessionId` bleibt, `runtime.ts:320-325` läuft nicht neu.
Ein Nutzer, der Projekt B öffnet, **sieht den Verlauf von Projekt A**. Das ist der
wichtigste einzelne Befund dieses Dokuments für die Nutzerfrage.

Zur Zeile „Tab schließen": die Freigabe-Ordnung ist im Code als **belegt** markiert und
trifft die App härter als die Zeile nahelegt — `project-folder.ts:30-36` und
`runtime.ts:446-450` sagen, dass `needs-gesture` **jeden Kaltstart** ist. Die Zeile
„solange kein Tab geschlossen wurde" ist die **einzige** Situation mit Zugriff ohne Geste.
(Eine Angabe aus `project-folder.ts:31-35` zitiert Chrome; ich habe das **nicht** selbst
nachgemessen — als belegte Repo-Angabe geführt, nicht als eigener Befund.)

Zur Zeile „anderer Rechner": der Export trägt **null** Sessions
(`packages/baah-web/src/lib/settings.ts:96-111` — `settingsExportFileSchema` hat
`settings` + optional `apiKeys`, keine Transcripts; dasselbe steht als Messwert in
`Plan.md:1908`).

---

## 4. Frage 3 — Woraus wird „ein Projekt ist ein Ordner" eine eindeutige Identität?

**Antwort: heute aus dem Ordnernamen — und der ist nicht stabil und nicht eindeutig.**

Gemessen:

- Der Workspace bekommt seine ID als `` `local:${parsed.name}` ``, also **aus dem
  Ordnernamen** (`packages/baah-core/src/workspace/file-system-access.ts:164-165`; `label`
  ebenso `parsed.name`). Chrome gibt keinen absoluten Pfad preis — im Code ist `name` die
  einzige verfügbare Angabe, und der Pfad taucht nirgends auf.
- Diese ID wird **nirgends gespeichert.** `workspaces.id` / `workspaces.name` /
  `workspaces.root_handle_id` (`schema.ts:172-182`) werden nie befüllt (Abschnitt 2). Der
  `id`-Wert lebt nur im flüchtigen Workspace-Objekt; `SwappableWorkspace` gibt ihn als
  Getter weiter (`packages/baah-web/src/lib/swappable-workspace.ts:66-70`), und beim Swap
  ändert er sich mit — ohne dass irgendetwas es notiert.
- Der Handle **überlebt einen Kaltstart als Referenz, nicht als Zugriff**
  (`project-folder.ts:297-311`, `restore()` liest nur, `pick()` schreibt nur bei
  `connected`, `project-folder.ts:319`).
- Der Handle-Store hat **genau einen** Schlüssel: `RECORD_KEY = "selected"`
  (`project-folder.ts:394`). Es ist strukturell **ein** Projekt-Slot, keine Liste.

**Konsequenz, unabhängig von jeder Lesart:** „Ordner = Projekt" verlangt, dass **zwei
verschiedene Ordner mit demselben Namen** (`~/work/api` und `~/oss/api`) unterscheidbar
sind. Mit `local:<name>` sind sie derselbe String. Und ein umbenannter Ordner wäre ein
anderes Projekt. Der Nutzer hat diese Fälle nicht genannt; sie sind aber die, an denen
„eindeutig" entweder stimmt oder nicht.

**Meine Empfehlung (Frage an den Nutzer, nicht umgesetzt):** Die Projektidentität muss
**beim ersten Öffnen in den Ordner selbst geschrieben** werden (eine Datei mit einer
UUID, etwa `.baah/project-id`), und der Ordner-Namen darf nur Anzeigename sein. Das
überlebt Umbenennen, gleiche Namen und — wichtig — **einen Wechsel auf einen anderen
Rechner**, weil die Datei mitwandert. Gemessen: **`.baah` existiert heute nirgends** — `rg
"\.baah"` über `packages/*/src` findet null Treffer, und `project-folder.ts` schreibt
nichts in den Ordner (nur `read`/`write(handle)`/`clear` auf den Handle-Store). Das ist
also ein neuer Pfad, kein vorhandener.

---

## 5. Frage 4 — Was kostet die Wurzel-Nachricht-Regel im bestehenden Schema?

Hier die konkrete Rechnung, falls der Build-Auftrag doch auf Lesart 1 läuft.

**Was schon da ist (kostenlos):**
- `messages.parent_id` als Spalte, Foreign Key auf `messages(id)` mit
  `ON DELETE CASCADE` (`schema.ts:77`), Index (`schema.ts:250`).
- `messages.seq` als Sortierschlüssel pro Session, `MAX(seq)+1` im Statement
  (`sql.ts:124`), `UNIQUE (session_id, seq)` (`schema.ts:94`).

**Was fehlt oder im Weg ist:**

1. **`parent_id` ist unbeschrieben.** Siehe Lesart 1. Das ist die teuerste Position: die
   Spalte existiert, aber sie zu füllen ist ein **Schreibvertrag**, den heute nur
   `INSERT_MESSAGE` und `INSERT_TURN_OUTCOME_MESSAGE` haben (`sql.ts:118-128`, `sql.ts:556`)
   — und beide werden aus `AgentTurn` und dem `withTranscriptRows`-Dekorator aufgerufen
   (`packages/baah-core/src/agent/loop.ts:1347`, `packages/baah-web/src/components/lib/turn-store.ts:154`).
   Überall dort müsste `parentId` durchgereicht werden, durch **drei** Schichten.
2. **Es gibt Code, der eine Session erzeugt, bevor eine Nachricht existiert.**
   `packages/baah-web/src/components/lib/runtime.ts:340-342`:
   ```ts
   if ((await database.getSession(sessionId)) === null) {
     await database.createSession({ id: sessionId, title: "Sitzung" });
   }
   ```
   Das läuft **beim Boot, vor jedem Turn**. Eine Regel „Konversation = Wurzel-Nachricht"
   hat damit beim Start eine Session **ohne** Nachricht — und `readTranscript` verweigert
   genau das nicht, es liefert eine leere Liste (`operations.ts:452-460`). Eine
   conversations-Liste, die aus Nachrichten-Wurzeln gebaut wird, zeigt beim ersten Start
   also **nichts** — und die Session existiert trotzdem.
3. **`createSession` ist kein Upsert.** `INSERT … RETURNING` ohne `ON CONFLICT`
   (`packages/baah-storage/src/sql.ts:73-78`, `operations.ts:348-362`) — der zweite Aufruf
   für dieselbe ID wirft `UNIQUE`. Deshalb das Read-first-Write-second in `runtime.ts:340`.
   Jede neue „Konversation anlegen"-Logik muss diese Arithmetik mitdenken.
4. **Ein Transkript-Fenster ist an `sessionId` gebunden**, nicht an eine Wurzel:
   `TranscriptQuery` hat `sessionId` + optional `turnId`
   (`packages/baah-storage/src/types.ts:614-626`), und `readTranscript` **verweigert**
   unbekannte Sessions (`operations.ts:429-436`). Eine Konversationsliste, die nach
   Nachrichten-Wurzeln gruppiert, kann den Verlauf einer fremden Session nicht lesen, ohne
   dass sich die Gruppe durch diese Schranke bewegt.

**Was Lesart 4 stattdessen kostet** (auch gemessen, nicht geschätzt): `turns` und
`turn_id` sind bereits da (`schema.ts:59-71`, `schema.ts:76`), der Turn ist bereits die
Einheit, die `#persistPrompt` schreibt (`loop.ts:1337-1366`), und `AgentLoopOptions` führt
`turnId` **und** `sessionId` nebeneinander (`loop.ts:598-599`). Der Aufwand verschiebt
sich von „Parent-Kette füllen" zu „eine Liste bauen, die nach `turn_id` gruppiert".

---

## 6. Entscheidungsfragen an den Nutzer

Diese Fragen muss der Orchestrator stellen. Sie sind nicht Implementation, sie sind die
Punkte, an denen die Antworten die Architektur verändern.

1. **Ebene:** Meinst du mit „Konversation" eine **Frage-Antwort-Paar** (das wäre ein
   *Turn*) oder einen **Verlauf mit mehreren Fragen** (das wäre eine *Session*)? Das ist
   der Unterschied zwischen „neue Konversation"-Knopf pro Frage und „neuer Chat"-Knopf pro
   Themenwechsel — und die beiden brauchen verschiedene Oberflächen.
2. **Identität:** Soll die Projektidentität eine **Datei im Ordner** sein (UUID, überlebt
   Umbenennen und Rechnerwechsel) oder reicht „der Ordner, den der Browser mir gibt"?
   Ohne Datei ist „eindeutig" nur „Fingerabdruck des Namens", und zwei gleichnamige Ordner
   sind dasselbe Projekt.
3. **Ordnerwechsel:** Wenn ein anderer Ordner geöffnet wird — soll der Verlauf des
   vorigen Ordners **verschwinden** (pro Ordner eine eigene Sitzung) oder **sichtbar
   bleiben** (eine Sitzung, mehrere Ordner)? Der Code entscheidet heute **stillschweigend
   für die zweite Variante** (`AppShell.tsx:112-132`), was vermutlich nicht gewollt ist.
4. **Bestand:** Was soll mit der heutigen einen Session passieren? Sie liegt in
   `localStorage["baah.session.v1"]` und hat `title = "Sitzung"` (`runtime.ts:341`).
   Verwaist, sobald `localStorage` geleert wird — und niemand kann sie dann noch finden,
   weil es keine Liste gibt.
5. **Grenze der Forderung:** „über mehrere Läufe eindeutig" — gilt das auch über
   **Gerätewechsel** hinweg? Das ist die einzige Stelle, an der die Antwort **nein**
   sein kann: die Daten liegen in OPFS (`Plan.md:1904`), und der Export trägt null
   Sessions (`settings.ts:96-111`). Wenn „ja", ist der Projektordner die Wahrheitsquelle
   (`Plan.md:1933-1941`) — und das ist ein eigenes Vorhaben, keine Schema-Änderung.

---

## 7. Was ich **nicht** gemessen habe

Nach `AGENTS.md` §9 als nicht geprüft markiert, damit niemand es als Befund liest:

- **Ob `showDirectoryPicker` in Chrome wirklich keinen absoluten Pfad preisgibt.** Ich habe
  das aus dem Code geschlossen (der Workspace nimmt nur `handle.name`); ich habe keinen
  Browser geöffnet. Die Chrome-Aussage in `project-folder.ts:31-35` ist eine **Repo-Angabe**,
  von mir zitiert, nicht von mir gemessen.
- **Ob der Grant tatsächlich jeden Kaltstart erlischt.** Ebenso Repo-Angabe
  (`project-folder.ts:30-36`, `runtime.ts:446-450`).
- **Ob die App mit zwei Sessions in einer Datenbank heute überhaupt funktioniert** —
  `listSessions` hat null Aufrufer, also **kein** gemessener Pfad. „Funktioniert" ist hier
  eine **Vermutung** aus dem Schema (die Kaskaden sind in `schema.ts` definiert), nicht
  ein Befund.
- **Ob es eine zweite `localStorage`-Session in der Praxis gibt** (mehrere Tabs, Hand-
  umschalten zwischen Profilen). `client.ts:399-405` sagt, `opfs-sahpool` erlaubt eine
  Verbindung pro Origin — aber was der zweite Tab dem Nutzer zeigt, habe ich nicht laufen
  lassen.
- **Keine Tests ausgeführt.** Diese Analyse ist vollständig aus dem Quelltext; `pnpm check`
  lief hier nicht.

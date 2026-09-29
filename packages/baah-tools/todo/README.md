# `@all-the.rest/baah-tool-todo`

Die Aufgabenliste des Agenten — die Sidebar des Nutzers. OpenCode v2 hat kein
`todowrite` mehr, das ist also unsere eigene Zutat, kein Nachbau.

Das Tool ist **zustandslos**. Die Liste überlebt einen einzelnen `execute`-Aufruf,
also besitzt das Tool sie nicht: die Engine reicht einen session-skalierten
`TodoStore` hinein, und der Store hält den Zustand. Das Tool greift nie auf
IndexedDB, SQLite oder das DOM zu (`AGENTS.md` §4).

## API

```ts
import {
  createTodoTool,
  createMemoryTodoStore,
  type TodoStore,
} from "@all-the.rest/baah-tool-todo";

const tool = createTodoTool({ store, sessionId: "sess_123" });
```

### `TodoStore`

```ts
type MaybePromise<T> = T | Promise<T>;

interface TodoStore {
  get(sessionId: string): MaybePromise<readonly TodoItem[]>;
  set(sessionId: string, todos: readonly TodoItem[]): MaybePromise<void>;
}
```

`MaybePromise`, weil die In-Memory-Implementierung synchron ist und der
DB-gestützte Store in Wave 2 über den Worker asynchron antwortet. Das Tool
`await`et beide.

- `get` gibt **eine Kopie** zurück (leere Liste, wenn für die Session nichts
  gespeichert ist).
- `set` ist ein **voller Replace**, kein Merge. Das Tool übergibt das Array und
  fasst es danach nicht mehr an — die Implementierung darf es behalten.

`createMemoryTodoStore({ onChange })` liegt als Default bei. `onChange` wird nach
jedem erfolgreichen `set` mit einer privaten Kopie der neuen Liste gerufen; die UI
hängt dort in Wave 2 die Sidebar dran. Ein werfender `onChange` wird **nicht**
geschluckt, sondern als Tool-Fehler sichtbar (`AGENTS.md` §5).

## Injektions-Vertrag für die Engine (Welle 2)

1. **Eine Tool-Instanz pro Session.** `createTodoTool({ store, sessionId })` wird
   beim Session-Start gebaut; `sessionId` ist die Session-ID. Der Store selbst
   ist app-weit (oder worker-weit) und über den Schlüssel `sessionId` session-
   skaliert — genau dafür ist er ein Map-artiges Interface und kein schlichter
   Wert.
2. **`sessionId` immer setzen.** Ohne Argument fällt der Schlüssel auf `"default"`
   zurück, damit ein nacktes `createTodoTool({ store })` in Tests läuft. In der
   App ist das ein geteilter Zustand über Sessions hinweg — ein Fehler.
3. **Der Default-Export ist nur ein Demo-Objekt.** `todoTool` (und sein
   `defaultTodoStore`) sind modul-global. Die Engine registriert **nicht** den
   Default-Export, sondern eine per `createTodoTool` gebaute Instanz. Die
   Registry lehnt außerdem Doppel-Ids ab, ein zweites `todo` würde also hart
   scheitern.
4. **Die Engine parst `inputSchema`, bevor sie `execute` ruft.** Das Schema ist
   die einzige Parameter-Wahrheit (`Plan.md` §4.2); `execute` ist gegen den
   *Input*-Typ typisiert und rechnet die `priority`-Vorgabe selbst, vertraut aber
   darauf, dass getrimmt und validiert wurde.

## Semantik

- **Voller Replace.** Das Modell schickt jedes Mal die komplette Liste. Was
  fehlt, ist weg — stillschweigend verschwundene Einträge gibt es nicht.
- **Höchstens ein `in_progress`.** Mehrere ⇒ `ToolError`, der beide Inhalte
  nennt. Es wird still nichts ausgewählt.
- **Ergebnis:** `{ todos, changed, completedCount }`. `changed` ist `false`, wenn
  die Liste schon so aussah — dann wird auch nicht geschrieben und `onChange`
  feuert nicht.
- `content` wird getrimmt, `priority` fällt auf `medium` zurück.
- Eine leere Liste (`todos: []`) ist vom Schema abgelehnt: eine leere Sidebar
  ist ein Unfall, kein Plan.

## Tests

```bash
pnpm --filter @all-the.rest/baah-tool-todo typecheck
pnpm --filter @all-the.rest/baah-tool-todo test
```

`test/todo.test.ts` deckt Replace-Semantik, Change-Erkennung, den
`in_progress`-Konflikt, den Priority-Default, Schema-Grenzen (leerer Inhalt,
> 100 Items), die Session-Trennung im geteilten Store, `onChange`, ein
asynchrones DB-artiges Store und die stabile Ergebnisform ab.

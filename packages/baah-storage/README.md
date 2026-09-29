# `@all-the.rest/baah-storage`

Persistenz im Browser: SQLite-WASM in einem Web Worker, Schema, Migrationen.
Reiner Browser-Code, kein Server (AGENTS.md §2).

> **Zugriffsrechte im Fix-Auftrag:** dieses README wurde angefordert, lag aber
> außerhalb der zugewiesenen Pakete. Inhalt unten, Umsetzung durch den
> Orchestrator.

## Warum dieses README existiert

`packages/baah-web/vite.config.ts:19` verweist in `optimizeDeps.exclude` auf
`packages/baah-storage/README.md` als die *einzige* Dokumentation des
WASM-Ladevertrags. Der Verweis existierte, die Datei nicht. Der Verweis ist in
diesem Zustand schlechter als kein Verweis: er behauptet Dokumentation, wo keine
ist.

## Der Vertrag, den die vite.config dokumentieren will

`@sqlite.org/sqlite-wasm` lädt seine `.wasm`-Binärdatei über `import.meta.url`.
Vites Dependency-Pre-Bundling schreibt diese URL um, und der Modul-Load schlägt
danach fehl. Deshalb steht das Paket in `optimizeDeps.exclude`. Das ist die
gesamte Aussage — und sie stimmt, sie war nur nirgends niedergeschrieben.

Zusätzlich zu beachten (AGENTS.md §2, `Plan.md` §14.5):

- **CSP:** WASM braucht `script-src 'wasm-unsafe-eval'`. Das betrifft hier
  `sqlite-wasm` und, solange es existiert, `grep-wasm` (jetzt entfernt) sowie
  später `quickjs-emscripten` und `web-tree-sitter`. Früh prüfen, nicht am Ende.
- **OPFS-VFS:** `opfs-sahpool` gehört genau *einem* Worker. Ein zweiter Tab oder
  Worker, der dieselbe Datenbank öffnen will, wird mit einem typisierten
  `database_owned_by_another_context`-Fehler abgewiesen, nicht mit einer rohen
  `DOMException`. Siehe `src/worker.ts`.

## Aufbau

| Datei | Rolle |
|---|---|
| `src/schema.ts` | DDL und PRAGMAs, `STRICT`-Tabellen (Plan.md §6.1) |
| `src/migrations.ts` | versionierte Migrationen, lauffähig von einer leeren DB |
| `src/protocol.ts` | zod-Protokoll der Worker-Nachrichten — die einzige Quelle der Wahrheit an dieser Grenze |
| `src/worker.ts` | der eine Worker: besitzt VFS und Connection, dispatcht, wirft nie über `postMessage` |
| `src/operations.ts` | die geteilte SQL-Logik, parametrisiert über eine `StorageEngine` |
| `src/client.ts` | der Main-Thread-Proxy, spricht `protocol.ts` |
| `src/factory.ts` | die In-Memory-Implementierung — derselbe `StorageDatabase`-Vertrag, ohne OPFS/Worker/WASM |
| `src/sql.ts` | die SQL-Strings, an beiden Implementierungen geteilt |

`createStorageOperations()` ist der Grund, warum die In-Memory-Variante keine
zweite Datenbank-Logik enthält: sie erkennt dieselben SQL-Strings wie
`sql.ts`. Die `seq`-Vergabe, die Upsert-Semantik, die Idempotenz von `flushDelta`
und die Kaskadenregeln werden einmal implementiert und einmal getestet.

Nicht unterstützt in `factory.ts`: die rohen SQL-Ausgänge. `query`/`run`/
`transaction` lehnen mit einem typisierten `unsupported`-Fehler ab, statt so zu
tun, als funktionierten sie.

## Test-Harness (AGENTS.md §2, einzige Ausnahme)

`test/harness/sqlite.ts` importiert `@sqlite.org/sqlite-wasm` über dessen
`exports.node`-Eintrag, damit die Worker-Tests gegen **echtes** SQLite laufen
statt gegen ein Modell davon. Bedingungen: nur im Test-Baum, nichts davon wird
ausgeliefert, und der Umstand wird im Build-Bericht genannt. `backend-parity`
vergleicht dann die In-Memory- und die SQLite-Variante.

## Tests

```
pnpm --filter @all-the.rest/baah-storage typecheck
pnpm --filter @all-the.rest/baah-storage test
```

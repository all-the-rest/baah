
---

## 15. Manuelle Browser-Prüfung

Diese Schritte sind **nicht** automatisierbar — sie brauchen eine echte
Browser-Umgebung. Jeder Punkt nennt, **was** geprüft wird und **woran** erkennbar
ist, dass es kaputt ist. Ein Punkt gilt als erledigt, wenn das erwartete
Verhalten beobachtet wurde, nicht wenn der Code gelesen wurde.

### 15.1 Workspace: echter Ordner (Chromium)

| # | Schritt | Erwartet | Kaputt, wenn |
|---|---|---|---|
| W1 | „Ordner verbinden" klicken, echten Projektordner wählen | Ordner erscheint als Workspace, Dateiliste stimmt | Liste leer oder Fehler |
| W2 | `read` auf eine bekannte Datei | Inhalt mit Zeilennummern | `File not found` trotz existierender Datei |
| W3 | `write` in eine neue Datei, dann in einem **Texteditor daneben** nachsehen | Datei liegt real auf der Platte, Inhalt stimmt | Nichts auf der Platte |
| W4 | `edit` an der Datei, im Texteditor nachsehen | Änderung sichtbar, keine Temp-Datei daneben | `.tmp`-Dateien, halber Inhalt |
| W5 | Seite neu laden, dann auf „Projekt wieder öffnen" klicken | Permission-Dialog, danach voller Zugriff | Handle verloren, Workspace muss neu gewählt werden |
| W6 | `glob` über ein echtes Repo | Treffer, `node_modules` fehlt | `node_modules` im Ergebnis |
| W7 | `grep` nach einem bekannten Symbol | Treffer mit Datei und Zeile | Timeout oder Treffer in Binärdateien |
| W8 | Reload mitten in einem laufenden Turn | Teiltext bleibt, Turn als `interrupted` markiert, Wiederholen angeboten | Stiller Verlust oder Hänger |

### 15.2 Workspace: Sandbox-Modus (Firefox/Safari)

| # | Schritt | Erwartet | Kaputt, wenn |
|---|---|---|---|
| S1 | Sandbox öffnen, Datei schreiben, neu laden | Datei noch da | Daten weg |
| S2 | `navigator.storage.persist()` anzeigen | „Dauerhaft gespeichert" | „nur bis Tab geschlossen" |
| S3 | Projektordner importieren, bearbeiten, exportieren | Export enthält die Änderungen | Änderungen bleiben nur in der Sandbox |
| S4 | **7 Tage ohne Interaktion** simulieren, dann öffnen | Daten noch da | Eviction durch Safari |

### 15.3 Stream-Verhalten

| # | Schritt | Erwartet | Kaputt, wenn |
|---|---|---|---|
| T1 | Onboarding-Verbindungstest | Antwort streamt | „Streaming blockiert"-Hinweis erscheint fälschlich |
| T2 | Frage stellen, Deltas ansehen | Text erscheint laufend | Alles auf einmal trotz Streaming-Support |
| T3 | **Ausfall simulieren:** Netz nach 1 s kappen | Ein Retry mit Backoff, sichtbar als „Versuch 2 von 3" | Kein Retry oder Endlosschleife |
| T4 | **200-mit-Fehler-JSON** provozieren (ungültiger Modellname) | Klarer Provider-Fehler, kein Retry-Loop | Endlosschleife oder „Erfolg" mit leerem Transcript |
| T5 | `429` provozieren (Quota erschöpft) | Hinweis auf Quota, **keine** Wiederholung | Wiederholungsschleife bei `insufficient_quota` |
| T6 | `401` provozieren (falscher Key) | Hinweis „Key ungültig", **keine** Wiederholung | 401-Loop |
| T7 | Sehr lange Antwort (Reasoning-Modell) | Wartenanzeige, **keine** automatische Degradierung | Stream wird fälschlich als „gepuffert" markiert |

### 15.4 Persistenz

| # | Schritt | Erwartet | Kaputt, wenn |
|---|---|---|---|
| D1 | Turn abschließen, neu laden | Verlauf vollständig, Reihenfolge korrekt | Nachrichten fehlen oder sind vertauscht |
| D2 | Zwei Tabs öffnen | Einer meldet „anderer Tab besitzt die Daten" | Beide schreiben gleichzeitig, korrupte DB |
| D3 | Lange Konversation | Historie per FTS5 durchsuchbar | Suche findet nichts |
| D4 | Speicher auffüllen bis Quota | Verständlicher Fehler | Stiller Datenverlust |

### 15.5 UI (nach dem Build, zusammen mit dem UI-Review)

- [ ] Onboarding auf Desktop und auf schmalem Viewport
- [ ] Tool-Karten: Zustände `running` / `approval-requested` / `output-available` / `output-error` unterscheidbar
- [ ] Approval-Card blockiert die weitere Bedienung eindeutig
- [ ] Tastaturbedienung: Tab-Reihenfolge, `Enter` zum Senden, `Esc` zum Abbrechen
- [ ] Dark/Light-Theme ohne unlesbare Kontraste
- [ ] Lange Pfade, lange Tool-Ausgaben und Fehlermeldungen brechen das Layout nicht

### 15.6 E2E mit gefälschten Provider-Antworten

Die Playwright-Suite fängt `fetch` ab und liefert selbst gebaute
OpenAI-kompatible Streams. Damit wird **ohne** echten Key und **ohne** Netz
getestet:

| Szenario | Erwartet |
|---|---|
| Reiner Text-Stream | vollständige Antwort, Rendering korrekt |
| Stream mit Tool-Call, Tool OK, dann Text | Tool-Karte sichtbar, Antwort danach |
| Tool-Call mit `output-error` | Fehlerkarte, Loop beendet sich sauber |
| Approval-Pause | Turn hält an, Karte erscheint, nach Antwort geht es weiter |
| 200 mit Fehler-JSON | Provider-Fehler sichtbar, **kein** Retry |
| 5xx | Backoff sichtbar, max. 3 Versuche |
| 401 | Kein Retry, Key-Hinweis |
| Abbruch mitten im Stream | Turn `interrupted`, Teilttext bleibt |

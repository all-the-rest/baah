# opencode-harness-web

Eine **web-first Coding-Harness**: der Basis-Werkzeugkasten und der Agent-Loop
einer Coding-Harness (Vorbild: OpenCode), nachgebaut als reine Browser-App.

**Kein Server.** Agent-Loop, Tools, Dateizugriff und Persistenz laufen im Tab;
die einzigen ausgehenden Verbindungen gehen direkt an die LLM-Provider.

## Status

Phase 0 — Fundament steht, Recherche läuft. Siehe [`Plan.md`](Plan.md) für
Ziel, Tool-Set und Roadmap, [`AGENTS.md`](AGENTS.md) für die Projektregeln.

## Struktur

```
apps/web/              React 19 + Vite + Tailwind 4 + daisyUI 5 (SPA)
packages/core/         Engine: Agent-Loop, Tool-Registry, Workspace-Abstraktion
packages/tools/<id>/   Ein Package pro Tool (read, write, edit, glob, grep, …)
```

## Kommandos

```bash
pnpm install
pnpm dev         # SPA auf http://localhost:5273
pnpm check       # typecheck + tests (muss grün sein, siehe AGENTS.md §6)
pnpm test        # nur Tests
pnpm build       # Produktions-Build
```

## Fertig

- `@ohw/core`: `Workspace`-Interface + In-Memory-Workspace für Tests,
  POSIX-Pfad-Utils inkl. Root-Escape-Schutz, `ToolDefinition`-Vertrag,
  Tool-Registry.
- `@ohw/tool-read`: Referenz-Tool-Package (Zeilennummern, `offset`/`limit`,
  Binär- und Truncation-Behandlung, Root-Escape-Schutz).

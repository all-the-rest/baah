import type { ToolDefinition } from "./tool.ts";

export interface ToolRegistry {
  ids(): string[];
  list(): ToolDefinition[];
  get(id: string): ToolDefinition | undefined;
  /** Throws on duplicates — a silent override would be a security bug. */
  register(tool: ToolDefinition): ToolRegistry;
}

export function createToolRegistry(initial: readonly ToolDefinition[] = []): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  const registry: ToolRegistry = {
    register(tool) {
      if (tools.has(tool.id)) {
        throw new Error(`Duplicate tool id: ${tool.id}`);
      }
      tools.set(tool.id, tool);
      return registry;
    },
    ids: () => [...tools.keys()].sort(),
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
  };

  for (const tool of initial) registry.register(tool);
  return registry;
}

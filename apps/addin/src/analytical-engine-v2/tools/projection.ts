import type { ToolSpec } from "./contracts.js";

export interface SharedArgument {
  readonly name: string;
  readonly type: string;
  readonly describe: string;
  readonly uses: number;
}

export interface ToolProjectionEntry {
  readonly name: string;
  readonly signature: string;
  readonly returns: string;
  readonly description: string;
  readonly ownArgs: readonly string[];
}

export interface ToolProjection {
  readonly shared: readonly SharedArgument[];
  readonly entries: readonly ToolProjectionEntry[];
}

const NUL = String.fromCharCode(0);

const keyOf = (name: string, type: string, describe: string): string => `${name}${NUL}${type}${NUL}${describe}`;

export function argSummaryOf(tool: ToolSpec): string {
  const entries = Object.entries(tool.args);
  if (entries.length === 0) return "no arguments";
  return entries.map(([name, spec]) => `${name}${spec.required ? "!" : ""}:${spec.type}`).join(", ");
}

export function signatureOf(tool: ToolSpec): string {
  return `${tool.name}(${Object.entries(tool.args)
    .map(([name, spec]) => `${name}${spec.required ? "!" : ""}:${spec.type}`)
    .join(", ")})`;
}

export function sharedArgumentsOf(tools: readonly ToolSpec[]): readonly SharedArgument[] {
  const uses = new Map<string, { name: string; type: string; describe: string; uses: number }>();
  for (const tool of tools) {
    for (const [name, spec] of Object.entries(tool.args)) {
      const key = keyOf(name, spec.type, spec.describe);
      const entry = uses.get(key) ?? { name, type: spec.type, describe: spec.describe, uses: 0 };
      entry.uses += 1;
      uses.set(key, entry);
    }
  }
  return [...uses.values()].filter((e) => e.uses > 1).sort((a, b) => a.name.localeCompare(b.name));
}

export function sharedArgumentKeys(shared: readonly SharedArgument[]): ReadonlySet<string> {
  return new Set(shared.map((e) => keyOf(e.name, e.type, e.describe)));
}

export function ownArgLinesOf(tool: ToolSpec, sharedKeys: ReadonlySet<string>, clean: (text: string) => string = (t) => t): readonly string[] {
  return Object.entries(tool.args)
    .filter(([name, spec]) => !sharedKeys.has(keyOf(name, spec.type, spec.describe)))
    .map(([name, spec]) => `${name} — ${clean(spec.describe)}`);
}

export function projectTools(tools: readonly ToolSpec[]): ToolProjection {
  const shared = sharedArgumentsOf(tools);
  const sharedKeys = sharedArgumentKeys(shared);
  return {
    shared,
    entries: tools.map((tool) => ({
      name: tool.name,
      signature: signatureOf(tool),
      returns: tool.returns,
      description: tool.description,
      ownArgs: ownArgLinesOf(tool, sharedKeys),
    })),
  };
}

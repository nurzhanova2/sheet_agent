import { V2_TOOLS } from "../tools/registry.js";
import type { ToolSpec } from "../tools/contracts.js";
import {
  CAPABILITY_IDS,
  shortDescriptionOf,
  type CapabilityFacts,
  type CapabilityId,
  type ToolDescriptor,
} from "./capability-model.js";

export interface CapabilityIndex {
  readonly byCapability: ReadonlyMap<CapabilityId, readonly ToolSpec[]>;
  readonly byName: ReadonlyMap<string, ToolSpec>;
  readonly total: number;
}

function build(tools: readonly ToolSpec[]): CapabilityIndex {
  const byCapability = new Map<CapabilityId, ToolSpec[]>();
  for (const id of CAPABILITY_IDS) byCapability.set(id, []);
  for (const tool of tools) byCapability.get(tool.capability)!.push(tool);
  return {
    byCapability,
    byName: new Map(tools.map((t) => [t.name, t])),
    total: tools.length,
  };
}

const REGISTRY_INDEX = build(V2_TOOLS);

export function capabilityIndex(tools?: readonly ToolSpec[]): CapabilityIndex {
  return tools ? build(tools) : REGISTRY_INDEX;
}

export function toolsOf(capability: CapabilityId, index: CapabilityIndex = REGISTRY_INDEX): readonly ToolSpec[] {
  return index.byCapability.get(capability) ?? [];
}

export function usableTool(tool: ToolSpec, facts: CapabilityFacts): boolean {
  return tool.usable ? tool.usable(facts) : true;
}

export function usableToolsOf(capability: CapabilityId, facts: CapabilityFacts, index: CapabilityIndex = REGISTRY_INDEX): readonly ToolSpec[] {
  return toolsOf(capability, index).filter((tool) => usableTool(tool, facts));
}

function summarizeArgs(tool: ToolSpec): string {
  const entries = Object.entries(tool.args);
  if (entries.length === 0) return "no arguments";
  return entries.map(([name, spec]) => `${name}${spec.required ? "!" : ""}:${spec.type}`).join(", ");
}

export function descriptorOf(tool: ToolSpec): ToolDescriptor {
  return {
    id: tool.name,
    capability: tool.capability,
    shortDescription: shortDescriptionOf(tool.description),
    inputSummary: summarizeArgs(tool),
    outputSummary: tool.returns,
  };
}

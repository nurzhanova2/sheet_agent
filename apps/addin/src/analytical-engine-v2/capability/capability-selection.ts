import { REF_ARG_TYPES, type ToolSpec } from "../tools/contracts.js";
import type { CapabilityFacts, CapabilityId } from "./capability-model.js";
import { capabilityIndex, usableToolsOf, type CapabilityIndex } from "./capability-index.js";
import { availableCapabilities } from "./capability-availability.js";

export const ENTRY_CAPABILITIES: readonly CapabilityId[] = ["schema", "periods", "references"];

export function needsPriorResult(tool: ToolSpec): boolean {
  return Object.values(tool.args).some((spec) => spec.required === true && REF_ARG_TYPES.has(spec.type));
}

export function callableNow(tool: ToolSpec, facts: CapabilityFacts): boolean {
  return !needsPriorResult(tool) || facts.resultCount > 0;
}

export interface SelectionInput {
  readonly facts: CapabilityFacts;
  readonly index?: CapabilityIndex;
  readonly reached?: readonly CapabilityId[];
  readonly includeEntry?: boolean;
}

export interface CapabilitySelection {
  readonly available: readonly CapabilityId[];
  readonly selected: readonly CapabilityId[];
  readonly exposed: readonly ToolSpec[];
  readonly loaded: readonly ToolSpec[];
}

export function selectCapabilities(input: SelectionInput): CapabilitySelection {
  const index = input.index ?? capabilityIndex();
  const available = availableCapabilities(input.facts, index);
  const wanted = new Set<CapabilityId>();
  if (input.includeEntry !== false) for (const id of ENTRY_CAPABILITIES) wanted.add(id);
  for (const id of input.reached ?? []) wanted.add(id);

  const selected = available.filter((id) => wanted.has(id));
  const exposed = available.flatMap((id) => usableToolsOf(id, input.facts, index));
  const loaded = selected.flatMap((id) => usableToolsOf(id, input.facts, index));
  return { available, selected, exposed, loaded };
}

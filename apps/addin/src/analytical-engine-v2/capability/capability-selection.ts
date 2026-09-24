import { REF_ARG_TYPES, type ToolSpec } from "../tools/contracts.js";
import type { AnalysisNecessity, AnalyzeOutput } from "../types.js";
import type { ExplorationDimension } from "../sandbox/exploration.js";
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

const DIMENSION_CAPABILITIES: Readonly<Record<ExplorationDimension, readonly CapabilityId[]>> = {
  data_quality: ["schema"],
  changes: ["comparison"],
  trends: ["series", "statistics"],
  volatility: ["series", "statistics"],
  anomalies: ["statistics", "extrema"],
  relationships: ["statistics"],
  distributions: ["statistics"],
  unusual_entities: ["ranking", "extrema"],
};

const NECESSITY_CAPABILITIES: Readonly<Record<AnalysisNecessity, readonly CapabilityId[]>> = {
  MISSING_DETERMINISTIC_CAPABILITY: [],
  OPEN_ENDED_EXPLORATION: ["statistics", "series"],
  CUSTOM_TRANSFORMATION: ["comparison"],
  ADVANCED_STATISTICS: ["statistics"],
  MULTI_METHOD_ANALYSIS: ["statistics"],
  OTHER: [],
};

const SHAPE_CAPABILITIES: Readonly<Record<AnalyzeOutput["shape"], readonly CapabilityId[]>> = {
  table: ["ranking"],
  scalar: ["read_values", "extrema"],
  series: ["series"],
  groups: ["statistics"],
  model: ["statistics"],
  diagnostic: ["statistics"],
};

export interface PlanSignals {
  readonly necessity?: AnalysisNecessity;
  readonly explorationDimensions?: readonly string[];
  readonly outputShapes?: readonly AnalyzeOutput["shape"][];
}

export interface SelectionInput {
  readonly facts: CapabilityFacts;
  readonly index?: CapabilityIndex;
  readonly reached?: readonly CapabilityId[];
  readonly discovered?: readonly CapabilityId[];
  readonly plan?: PlanSignals;
  readonly includeEntry?: boolean;
}

export interface CapabilitySelection {
  readonly available: readonly CapabilityId[];
  readonly selected: readonly CapabilityId[];
  readonly exposed: readonly ToolSpec[];
  readonly loaded: readonly ToolSpec[];
}

function fromPlan(plan: PlanSignals | undefined): readonly CapabilityId[] {
  if (!plan) return [];
  const out: CapabilityId[] = [];
  if (plan.necessity) out.push(...NECESSITY_CAPABILITIES[plan.necessity]);
  for (const raw of plan.explorationDimensions ?? []) {
    const mapped = DIMENSION_CAPABILITIES[raw as ExplorationDimension];
    if (mapped) out.push(...mapped);
  }
  for (const shape of plan.outputShapes ?? []) out.push(...SHAPE_CAPABILITIES[shape]);
  return out;
}

export function selectCapabilities(input: SelectionInput): CapabilitySelection {
  const index = input.index ?? capabilityIndex();
  const available = availableCapabilities(input.facts, index);
  const wanted = new Set<CapabilityId>();
  if (input.includeEntry !== false) for (const id of ENTRY_CAPABILITIES) wanted.add(id);
  for (const id of input.reached ?? []) wanted.add(id);
  for (const id of input.discovered ?? []) wanted.add(id);
  for (const id of fromPlan(input.plan)) wanted.add(id);

  const selected = available.filter((id) => wanted.has(id));
  const exposed = available.flatMap((id) => usableToolsOf(id, input.facts, index));
  const loaded = selected.flatMap((id) => usableToolsOf(id, input.facts, index));
  return { available, selected, exposed, loaded };
}

import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import type { PeriodIndex } from "../../app/schema/analytical/period-index.js";
import type { AnalyticalConversationState } from "../state/conversation-state.js";
import { CAPABILITY_IDS, NO_REFERENCES, type CapabilityFacts, type CapabilityId, type ReferenceFacts } from "./capability-model.js";
import { capabilityIndex, usableToolsOf, type CapabilityIndex } from "./capability-index.js";

export interface RuntimeCapabilities {
  readonly sandbox: boolean;
  readonly toolInvoker: boolean;
  readonly mutationGateway: boolean;
  readonly visualization: boolean;
}

export const READ_ONLY_ANALYTICAL_RUNTIME: RuntimeCapabilities = {
  sandbox: false,
  toolInvoker: false,
  mutationGateway: false,
  visualization: false,
};

export function referenceFactsOf(state: AnalyticalConversationState | undefined): ReferenceFacts {
  if (!state) return NO_REFERENCES;
  return {
    result: state.lastResult !== undefined,
    recent: (state.recentResults ?? []).length > 0,
    metric: state.lastMetric !== undefined,
    metricSet: state.lastMetricSet !== undefined,
    period: state.lastPeriod !== undefined,
    periodRange: state.lastPeriodRange !== undefined,
    series: state.lastSeries !== undefined,
    event: state.lastEvent !== undefined,
    analysis: state.lastAnalysis !== undefined,
  };
}

export interface FactsInput {
  readonly schema: TableSchema;
  readonly grids?: AnalysisGrids;
  readonly periodIndex: PeriodIndex;
  readonly state?: AnalyticalConversationState;
  readonly runtime?: Partial<RuntimeCapabilities>;
  readonly resultCount?: number;
}

export function capabilityFactsOf(input: FactsInput): CapabilityFacts {
  const runtime = { ...READ_ONLY_ANALYTICAL_RUNTIME, ...(input.runtime ?? {}) };
  return {
    metricCount: input.schema.rowAxis.length,
    periodCount: input.periodIndex.points.length,
    resultCount: input.resultCount ?? 0,
    references: referenceFactsOf(input.state),
    sandbox: runtime.sandbox,
    toolInvoker: runtime.toolInvoker,
    mutationGateway: runtime.mutationGateway,
    visualization: runtime.visualization,
  };
}

export type UnavailableReason =
  | "no_metrics"
  | "no_periods"
  | "one_period"
  | "one_metric"
  | "no_prior_results"
  | "no_runtime"
  | "not_in_this_runtime";

const DATA_RULES: Readonly<Record<string, (facts: CapabilityFacts) => UnavailableReason | null>> = {
  schema: (f) => (f.metricCount >= 1 ? null : "no_metrics"),
  periods: (f) => (f.periodCount >= 1 ? null : "no_periods"),
  read_values: (f) => (f.metricCount >= 1 ? (f.periodCount >= 1 ? null : "no_periods") : "no_metrics"),
  series: (f) => (f.metricCount >= 1 ? (f.periodCount >= 2 ? null : "one_period") : "no_metrics"),
  comparison: (f) => (f.periodCount >= 2 ? null : "one_period"),
  ranking: (f) => (f.metricCount >= 2 ? null : "one_metric"),
  extrema: (f) => (f.metricCount >= 2 || f.periodCount >= 2 ? null : "one_metric"),
  statistics: (f) => (f.metricCount >= 2 || f.periodCount >= 2 ? null : "one_metric"),
};

export interface CapabilityState {
  readonly id: CapabilityId;
  readonly available: boolean;
  readonly toolCount: number;
  readonly reason?: UnavailableReason;
}

export function capabilityStateOf(id: CapabilityId, facts: CapabilityFacts, index: CapabilityIndex = capabilityIndex()): CapabilityState {
  if (id === "sandbox") {
    return facts.sandbox ? { id, available: true, toolCount: 0 } : { id, available: false, toolCount: 0, reason: "no_runtime" };
  }
  if (id === "mutation" || id === "visualization") {
    const on = id === "mutation" ? facts.mutationGateway : facts.visualization;
    return on ? { id, available: true, toolCount: 0 } : { id, available: false, toolCount: 0, reason: "not_in_this_runtime" };
  }
  const usable = usableToolsOf(id, facts, index);
  if (usable.length === 0) {
    return { id, available: false, toolCount: 0, reason: id === "references" ? "no_prior_results" : "no_metrics" };
  }
  const rule = DATA_RULES[id];
  const blocked = rule ? rule(facts) : null;
  if (blocked) return { id, available: false, toolCount: usable.length, reason: blocked };
  return { id, available: true, toolCount: usable.length };
}

export function capabilityStates(facts: CapabilityFacts, index: CapabilityIndex = capabilityIndex()): readonly CapabilityState[] {
  return CAPABILITY_IDS.map((id) => capabilityStateOf(id, facts, index));
}

export function availableCapabilities(facts: CapabilityFacts, index: CapabilityIndex = capabilityIndex()): readonly CapabilityId[] {
  return capabilityStates(facts, index)
    .filter((s) => s.available)
    .map((s) => s.id);
}

export function availableToolNames(facts: CapabilityFacts, index: CapabilityIndex = capabilityIndex()): readonly string[] {
  return availableCapabilities(facts, index).flatMap((id) => usableToolsOf(id, facts, index).map((t) => t.name));
}

import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import { buildPeriodIndex } from "../../app/schema/analytical/period-index.js";
import type { AnalyticalConversationState } from "../state/conversation-state.js";
import type { ResultStore } from "../results/result-store.js";
import { buildToolEnv } from "../tools/registry.js";
import { executeCall, validateCall } from "../tools/validator.js";
import { renderResultForPlanner } from "../planner/result-preview.js";
import type { ToolSpec } from "../tools/contracts.js";
import type { AnalyzeDecision } from "../types.js";
import { CAPABILITY_PURPOSE, type CapabilityFacts, type CapabilityId } from "./capability-model.js";
import { capabilityIndex, usableToolsOf } from "./capability-index.js";
import { capabilityFactsOf, capabilityStateOf } from "./capability-availability.js";
import { selectCapabilities, type PlanSignals } from "./capability-selection.js";
import type { CapabilityDiscovery, DeterministicTool, ToolInvoker, ToolOutcome } from "../sandbox/analysis-agent.js";

export function signatureOf(tool: ToolSpec): string {
  const args = Object.entries(tool.args);
  return `${tool.name}(${args.map(([n, spec]) => `${n}${spec.required ? "!" : ""}:${spec.type}`).join(", ")})`;
}

export function agentToolOf(tool: ToolSpec, loaded: boolean): DeterministicTool {
  const first = tool.description.split(". ")[0] ?? tool.description;
  return {
    name: tool.name,
    summary: loaded ? tool.description : first.endsWith(".") ? first : `${first}.`,
    capability: tool.capability,
    signature: signatureOf(tool),
    loaded,
  };
}

export function planSignalsOf(decision: AnalyzeDecision): PlanSignals {
  return {
    ...(decision.necessity ? { necessity: decision.necessity } : {}),
    ...(decision.exploration && decision.exploration.length > 0 ? { explorationDimensions: decision.exploration } : {}),
    outputShapes: decision.requestedOutputs.map((output) => output.shape),
  };
}

export interface AgentToolContextInput {
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  readonly store: ResultStore;
  readonly state: AnalyticalConversationState;
  readonly decision: AnalyzeDecision;
  readonly sandbox: boolean;
}

export interface AgentToolContext {
  readonly facts: CapabilityFacts;
  readonly tools: readonly DeterministicTool[];
  readonly availableCapabilities: readonly { readonly id: string; readonly purpose: string; readonly toolCount: number }[];
  readonly discover: CapabilityDiscovery;
  readonly invokeTool: ToolInvoker;
}

export function buildAgentToolContext(input: AgentToolContextInput): AgentToolContext {
  const periodIndex = buildPeriodIndex(input.schema, input.grids);
  const index = capabilityIndex();
  const facts = capabilityFactsOf({
    schema: input.schema,
    periodIndex,
    state: input.state,
    runtime: { sandbox: input.sandbox, toolInvoker: true },
    resultCount: input.store.all().length,
  });
  const selection = selectCapabilities({ facts, index, plan: planSignalsOf(input.decision) });
  const loadedNames = new Set(selection.loaded.map((tool) => tool.name));
  const tools = selection.loaded.map((tool) => agentToolOf(tool, true));

  const availableCapabilities = selection.available.map((id) => ({
    id,
    purpose: CAPABILITY_PURPOSE[id],
    toolCount: capabilityStateOf(id, facts, index).toolCount,
  }));

  const discover: CapabilityDiscovery = (nameOrCapability) => {
    const asked = nameOrCapability.trim();
    const namedTool = index.byName.get(asked);
    const id = (namedTool ? namedTool.capability : asked) as CapabilityId;
    if (!selection.available.includes(id)) return null;
    const found = usableToolsOf(id, facts, index);
    return found.length === 0 ? null : found.map((tool) => agentToolOf(tool, true));
  };

  const env = buildToolEnv(input.schema, input.grids, input.store, input.state);
  const cache = new Map<string, string>();
  const exposure = () => ({
    exposed: new Set(selection.available.flatMap((id) => usableToolsOf(id, facts, index).map((tool) => tool.name))),
    availableCapabilities: selection.available,
  });

  const invokeTool: ToolInvoker = async (tool, argumentValues) => {
    const validated = validateCall({ kind: "tool_call", tool, arguments: { ...argumentValues } }, env, exposure());
    if (!validated.ok) {
      const error = validated.error.ok === false ? validated.error.error : null;
      const candidates = error?.candidates && error.candidates.length > 0 ? ` Candidates: ${error.candidates.slice(0, 12).join(", ")}.` : "";
      return { ok: false, message: error ? `${error.code} ${error.message}.${candidates}` : `the call to "${tool}" was rejected` };
    }
    const { outcome } = executeCall(validated.call, env, cache);
    if (!outcome.ok) {
      const candidates = outcome.error.candidates && outcome.error.candidates.length > 0 ? ` Candidates: ${outcome.error.candidates.slice(0, 12).join(", ")}.` : "";
      return { ok: false, message: `${outcome.error.code} ${outcome.error.message}.${candidates}` };
    }
    const result: ToolOutcome = { ok: true, summary: renderResultForPlanner(outcome.result), resultRefs: [outcome.result.resultId] };
    return result;
  };

  void loadedNames;
  return { facts, tools, availableCapabilities, discover, invokeTool };
}

import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { V2_TOOLS, findTool, buildToolEnv } from "./tools/registry.js";
import { CAPABILITY_IDS, CAPABILITY_PURPOSE, shortDescriptionOf, type CapabilityFacts, type CapabilityId } from "./capability/capability-model.js";
import { capabilityIndex, descriptorOf, toolsOf, usableToolsOf } from "./capability/capability-index.js";
import { availableCapabilities, capabilityFactsOf, capabilityStateOf, referenceFactsOf } from "./capability/capability-availability.js";
import { ENTRY_CAPABILITIES, callableNow, needsPriorResult, selectCapabilities } from "./capability/capability-selection.js";
import { buildToolContext, withoutAbsentTools } from "./capability/tool-context.js";
import { agentToolOf, buildAgentToolContext, planSignalsOf, signatureOf } from "./capability/agent-tools.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { benchmarkPortfolio } from "./harness/sandbox-tables.js";
import { buildEngineContext, buildToolCatalog } from "./context/build-context.js";
import { buildPlannerMessages } from "./planner/planner-prompt.js";
import { EMPTY_ANALYTICAL_STATE, storeResult, type AnalyticalConversationState } from "./state/conversation-state.js";
import { ResultStore } from "./results/result-store.js";
import { validateCall } from "./tools/validator.js";
import { evaluateAnswer } from "./narration/answer-evaluator.js";
import type { VerifiedFinding } from "./insight/verified-finding.js";
import { parseAnalysisDecision, readAnalysisDecision, type DecisionContract } from "./sandbox/analysis-decision.js";
import { runAnalysisAgent, type AgentContext, type DeterministicTool, type SessionRuntime } from "./sandbox/analysis-agent.js";
import { actionsOf, buildAgentMessages } from "./sandbox/analysis-agent-prompt.js";
import type { AnalyzeDecision } from "./types.js";
import type { ExecuteOutcome, LookObservation, StepObservation } from "./sandbox/pyodide-runtime.js";
import type { SandboxDataset, SandboxPlan, SandboxResult } from "./sandbox/types.js";

const table = benchmarkPortfolio();
const periodIndex = buildPeriodIndex(table.schema, table.grids);

function factsFor(over: Partial<CapabilityFacts> = {}, state: AnalyticalConversationState = EMPTY_ANALYTICAL_STATE): CapabilityFacts {
  return { ...capabilityFactsOf({ schema: table.schema, periodIndex, state }), ...over };
}

function contextFor(facts: CapabilityFacts, reached: readonly CapabilityId[] = []) {
  return buildToolContext({ facts, selection: selectCapabilities({ facts, reached }) });
}

function newStore(): ResultStore {
  return new ResultStore("S!A1:C4", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
}

function stateWithResults(): AnalyticalConversationState {
  const s = newStore();
  const prior = s.put({
    tool: "set.filter",
    type: "comparison",
    fields: [
      { name: "metric", kind: "metric" },
      { name: "percentageChange", kind: "number" },
    ],
    rows: [["Обь", -1] as readonly CellValue[]],
    metricKeys: ["Обь"],
    periodCanonicals: ["p1", "p2"],
  });
  return { turnId: "t0", lastResult: storeResult(prior), lastMetric: { metricKey: "Обь" } };
}

// --- §5/§8 the capability model and the index -------------------------------

describe("Stage 27.2C §5/§8 — the capability index comes from the registry", () => {
  it("gives every registry tool exactly one capability, and covers every tool", () => {
    const index = capabilityIndex();
    expect(index.total).toBe(V2_TOOLS.length);
    const counted = CAPABILITY_IDS.reduce((n, id) => n + toolsOf(id, index).length, 0);
    expect(counted).toBe(V2_TOOLS.length);
    for (const tool of V2_TOOLS) expect(CAPABILITY_IDS, tool.name).toContain(tool.capability);
  });

  it("is not a second hardcoded list — every indexed tool is the registry object itself", () => {
    const index = capabilityIndex();
    for (const id of CAPABILITY_IDS) {
      for (const tool of toolsOf(id, index)) expect(tool).toBe(findTool(tool.name));
    }
  });

  it("names every capability it can expose", () => {
    for (const id of CAPABILITY_IDS) expect(CAPABILITY_PURPOSE[id].length).toBeGreaterThan(10);
  });

  it("§7 — a descriptor is compact metadata, not the full schema", () => {
    const spec = findTool("set.top")!;
    const descriptor = descriptorOf(spec);
    expect(descriptor.capability).toBe("ranking");
    expect(descriptor.outputSummary).toBe(spec.returns);
    expect(descriptor.inputSummary).toContain("inputRef!:resultRef");
    expect(descriptor.shortDescription.length).toBeLessThan(spec.description.length);
    for (const [, argSpec] of Object.entries(spec.args)) {
      expect(descriptor.shortDescription).not.toContain(argSpec.describe);
    }
  });
});

// --- §6 availability comes from runtime facts -------------------------------

describe("Stage 27.2C §6 — availability is a runtime fact", () => {
  it("omits references entirely on a first turn, and restores them when state carries one", () => {
    expect(availableCapabilities(factsFor())).not.toContain("references");
    expect(availableCapabilities(factsFor({}, stateWithResults()))).toContain("references");
  });

  it("exposes only the reference tools whose slot is actually filled", () => {
    const facts = factsFor({}, stateWithResults());
    const names = usableToolsOf("references", facts).map((t) => t.name);
    expect(names).toContain("reference.last_result");
    expect(names).toContain("reference.last_metric");
    expect(names).not.toContain("reference.last_series");
    expect(names).not.toContain("reference.last_event");
  });

  it("drops period-dependent capabilities when the table has one period", () => {
    const facts = factsFor({ periodCount: 1 });
    const available = availableCapabilities(facts);
    expect(available).toContain("schema");
    expect(available).toContain("periods");
    expect(available).not.toContain("series");
    expect(available).not.toContain("comparison");
    expect(capabilityStateOf("comparison", facts).reason).toBe("one_period");
  });

  it("§16/§39 — a read-only analytical turn never has mutation or visualization", () => {
    for (const facts of [factsFor(), factsFor({ sandbox: true }, stateWithResults())]) {
      expect(availableCapabilities(facts)).not.toContain("mutation");
      expect(availableCapabilities(facts)).not.toContain("visualization");
    }
    expect(capabilityStateOf("mutation", factsFor()).reason).toBe("not_in_this_runtime");
  });

  it("§6 — sandbox availability tracks the runtime, not the wording", () => {
    expect(availableCapabilities(factsFor())).not.toContain("sandbox");
    expect(availableCapabilities(factsFor({ sandbox: true }))).toContain("sandbox");
  });

  it("reads reference facts off the conversation state, never off the request", () => {
    expect(referenceFactsOf(undefined).result).toBe(false);
    expect(referenceFactsOf(stateWithResults()).result).toBe(true);
    expect(referenceFactsOf(stateWithResults()).series).toBe(false);
  });
});

// --- §11/§12/§13 selection --------------------------------------------------

describe("Stage 27.2C §11/§12/§13 — selection is structural, never keyword routing", () => {
  it("selects the entry capabilities on a first turn and nothing that needs a prior result", () => {
    const selection = selectCapabilities({ facts: factsFor() });
    expect(selection.selected).toEqual(["schema", "periods"]);
    expect(selection.selected).not.toContain("ranking");
    for (const id of selection.selected) expect(ENTRY_CAPABILITIES).toContain(id);
  });

  it("gives the same selection for two differently-worded requests on the same state", () => {
    const facts = factsFor();
    expect(selectCapabilities({ facts }).selected).toEqual(selectCapabilities({ facts }).selected);
  });

  it("§11 — a capability the turn has reached is loaded from then on", () => {
    const facts = factsFor({ resultCount: 1 });
    expect(selectCapabilities({ facts }).selected).not.toContain("ranking");
    expect(selectCapabilities({ facts, reached: ["ranking"] }).selected).toContain("ranking");
  });

  it("§13 — the sandbox agent's selection comes from the plan the planner already produced", () => {
    const facts = factsFor({ sandbox: true, toolInvoker: true });
    const exploratory = selectCapabilities({
      facts,
      plan: { necessity: "OPEN_ENDED_EXPLORATION", explorationDimensions: ["trends", "unusual_entities"] },
    });
    expect(exploratory.selected).toContain("statistics");
    expect(exploratory.selected).toContain("series");
    expect(exploratory.selected).toContain("ranking");
    const narrow = selectCapabilities({ facts, plan: { necessity: "CUSTOM_TRANSFORMATION", outputShapes: ["series"] } });
    expect(narrow.selected).toContain("comparison");
    expect(narrow.selected).not.toContain("ranking");
  });

  it("§13 — the plan signals are read off the decision enums, not its prose", () => {
    const decision: AnalyzeDecision = {
      kind: "analyze",
      objective: "корреляция и кластеры и рост",
      requestedOutputs: [{ id: "o1", description: "groups", shape: "groups" }],
      necessity: "ADVANCED_STATISTICS",
    };
    const signals = planSignalsOf(decision);
    expect(signals.necessity).toBe("ADVANCED_STATISTICS");
    expect(signals.outputShapes).toEqual(["groups"]);
    expect(signals.explorationDimensions).toBeUndefined();
  });

  it("knows which tools cannot be the first call of a turn", () => {
    expect(needsPriorResult(findTool("set.top")!)).toBe(true);
    expect(needsPriorResult(findTool("schema.metrics")!)).toBe(false);
    expect(callableNow(findTool("set.top")!, factsFor())).toBe(false);
    expect(callableNow(findTool("set.top")!, factsFor({ resultCount: 2 }))).toBe(true);
  });
});

// --- §28/§31/§42/§43 the rendered context -----------------------------------

describe("Stage 27.2C §31/§42 — the context is materially smaller, with nothing lost", () => {
  it("§42 — the initial prompt carries the capability summary and only the exposed subset", () => {
    const model = contextFor(factsFor());
    expect(model.text).toContain("CAPABILITIES AVAILABLE THIS TURN:");
    for (const id of model.availableCapabilities) expect(model.text).toContain(CAPABILITY_PURPOSE[id]);
    expect(model.exposedTools.length).toBeLessThan(V2_TOOLS.length);
    expect(model.loadedTools.length).toBeLessThan(model.exposedTools.length);
  });

  it("§31 — reports a real reduction against the full registry serialization", () => {
    expect(contextFor(factsFor()).text.length).toBeLessThan(buildToolCatalog().length * 0.7);
  });

  it("§32 — every exposed tool stays callable: signature, required flags and return type survive", () => {
    const model = contextFor(factsFor());
    for (const name of model.exposedTools) {
      const spec = findTool(name)!;
      expect(model.text, name).toContain(`${signatureOf(spec)} → ${spec.returns}`);
      for (const [arg, argSpec] of Object.entries(spec.args)) {
        if (argSpec.required) expect(model.text, `${name}.${arg}`).toContain(`${arg}!:`);
      }
    }
  });

  it("§18 — a loaded capability carries the exact contract; an unloaded one carries only its purpose", () => {
    const model = contextFor(factsFor());
    const loaded = findTool(model.loadedTools[0]!)!;
    expect(model.text).toContain(loaded.description);
    const unloaded = findTool(model.exposedTools.find((n) => !model.loadedTools.includes(n))!)!;
    expect(model.text).not.toContain(unloaded.description);
    expect(model.text).toContain(shortDescriptionOf(unloaded.description));
  });

  it("§43 — no tool of an unavailable capability appears anywhere in the prompt", () => {
    const model = contextFor(factsFor());
    expect(model.absentTools.length).toBeGreaterThan(0);
    expect(model.leaks).toEqual([]);
    const messages = buildPlannerMessages({
      request: "На сколько выросли активы?",
      context: buildEngineContext(table.schema, table.grids, periodIndex, EMPTY_ANALYTICAL_STATE, model.text),
      results: [],
      errors: [],
      round: 1,
      remainingRounds: 9,
      exposedTools: model.exposedTools,
    });
    const prompt = messages.map((m) => m.content).join("\n");
    const leaked = model.absentTools.filter((name) => prompt.includes(name));
    expect(leaked).toEqual([]);
  });

  it("§43 — a cross-reference to an absent tool is removed from another tool's prose", () => {
    const cleaned = withoutAbsentTools(
      "the resultId of an earlier result naming exactly one metric (e.g. from metric.resolve, set.argmax or reference.last_metric) — use this instead",
      new Set(["metric.resolve", "set.argmax"]),
      new Set(["metric.resolve", "set.argmax", "reference.last_metric"]),
    );
    expect(cleaned).not.toContain("reference.last_metric");
    expect(cleaned).toContain("metric.resolve");
    expect(cleaned).toContain("use this instead");
  });

  it("§26 — a follow-up turn exposes the references it actually holds", () => {
    const first = contextFor(factsFor());
    const follow = contextFor(factsFor({ resultCount: 1 }, stateWithResults()));
    expect(first.exposedTools).not.toContain("reference.last_result");
    expect(follow.exposedTools).toContain("reference.last_result");
    expect(follow.exposedTools).not.toContain("reference.last_series");
  });

  it("§33/§34 — the initial context for a deterministic turn and for a sandbox turn", () => {
    const deterministic = contextFor(factsFor());
    expect(deterministic.availableCapabilities).not.toContain("sandbox");
    expect(deterministic.availableCapabilities).not.toContain("mutation");
    const withSandbox = contextFor(factsFor({ sandbox: true }));
    expect(withSandbox.availableCapabilities).toContain("sandbox");
    expect(withSandbox.availableCapabilities).toContain("statistics");
    expect(withSandbox.availableCapabilities).not.toContain("mutation");
  });
});

// --- §20/§22/§40 the tool-call gate -----------------------------------------

describe("Stage 27.2C §20/§22/§40 — a call is valid only against the exposed set", () => {
  const env = () => buildToolEnv(table.schema, table.grids, newStore(), EMPTY_ANALYTICAL_STATE);
  const exposureOf = (facts: CapabilityFacts) => {
    const model = contextFor(facts);
    return { exposed: new Set(model.exposedTools), availableCapabilities: model.availableCapabilities };
  };

  it("§22 — a tool of an unavailable capability is refused with CAPABILITY_UNAVAILABLE and the valid capabilities", () => {
    const outcome = validateCall({ kind: "tool_call", tool: "reference.last_result", arguments: {} }, env(), exposureOf(factsFor()));
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.ok !== false) return;
    expect(outcome.error.error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(outcome.error.error.message).toContain("references");
    expect(outcome.error.error.message).toContain("schema");
  });

  it("§40 — an invented tool is UNKNOWN_TOOL with no fuzzy resolution to a near neighbour", () => {
    const outcome = validateCall({ kind: "tool_call", tool: "set.toppp", arguments: {} }, env(), exposureOf(factsFor()));
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.ok !== false) return;
    expect(outcome.error.error.code).toBe("UNKNOWN_TOOL");
    expect(outcome.error.error.candidates).not.toContain("set.toppp");
  });

  it("§43 — the refusal lists only exposed tools, never the whole registry", () => {
    const outcome = validateCall({ kind: "tool_call", tool: "nope.nope", arguments: {} }, env(), exposureOf(factsFor()));
    if (outcome.ok || outcome.error.ok !== false) return;
    const candidates = outcome.error.error.candidates ?? [];
    expect(candidates).not.toContain("reference.last_result");
    expect(candidates.length).toBeLessThan(V2_TOOLS.length);
  });

  it("an exposed tool still validates exactly as before", () => {
    expect(validateCall({ kind: "tool_call", tool: "schema.metrics", arguments: {} }, env(), exposureOf(factsFor())).ok).toBe(true);
  });
});

// --- §10/§37/§38/§44 the dynamic action contract ----------------------------

describe("Stage 27.2C §10/§44 — the action contract is enforced by the parser", () => {
  const CALL = { action: "CALL_TOOL", purpose: "p", tool: "period.latest", input: {} };
  const CODE = { action: "EXECUTE_CODE", purpose: "p", code: "x = 1" };
  const full: DecisionContract = { actions: ["INSPECT", "EXECUTE_CODE", "CALL_TOOL", "DISCOVER_TOOLS", "CLARIFY", "COMPLETE"] };
  const noTools: DecisionContract = { actions: ["INSPECT", "EXECUTE_CODE", "CLARIFY", "COMPLETE"] };
  const noSandbox: DecisionContract = { actions: ["CALL_TOOL", "CLARIFY", "COMPLETE"] };

  it("§37 — CALL_TOOL is rejected by the parser when no tool is callable", () => {
    expect(parseAnalysisDecision(CALL, full).ok).toBe(true);
    const refused = parseAnalysisDecision(CALL, noTools);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("CAPABILITY_UNAVAILABLE");
    expect(refused.error).toContain("EXECUTE_CODE");
  });

  it("§38 — EXECUTE_CODE is rejected by the parser when there is no runtime", () => {
    expect(parseAnalysisDecision(CODE, full).ok).toBe(true);
    const refused = parseAnalysisDecision(CODE, noSandbox);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("CAPABILITY_UNAVAILABLE");
  });

  it("§44 — the same contract governs a batched response", () => {
    const batch = `${JSON.stringify(CALL)}${JSON.stringify(CODE)}`;
    expect(readAnalysisDecision(batch, full).ok).toBe(true);
    expect(readAnalysisDecision(batch, noTools).ok).toBe(false);
  });

  it("unknown actions name the contract, not a fixed five", () => {
    const refused = parseAnalysisDecision({ action: "SORT_SHEET" }, noSandbox);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("CALL_TOOL, CLARIFY, COMPLETE");
    expect(refused.error).not.toContain("EXECUTE_CODE");
  });

  it("§17 — DISCOVER_TOOLS parses only when the contract offers it", () => {
    const discover = { action: "DISCOVER_TOOLS", purpose: "p", capability: "ranking" };
    expect(parseAnalysisDecision(discover, full).ok).toBe(true);
    expect(parseAnalysisDecision(discover, noTools).ok).toBe(false);
  });
});

// --- §2/§9 the agent prompt --------------------------------------------------

const AGENT_DATASET: SandboxDataset = {
  datasetId: "ds1",
  tableRef: "S!A1:C4",
  sheet: "S",
  sourceRange: "S!A1:C4",
  freshnessToken: "v1",
  columns: [
    { name: "metric", semanticType: "metric_label", missingCount: 0, zeroCount: 0 },
    { name: "Янв", semanticType: "amount", missingCount: 0, zeroCount: 0 },
  ],
  rows: [["Обь", 2] as readonly CellValue[]],
  periods: ["Янв"],
};

const AGENT_PLAN: SandboxPlan = {
  objective: "establish which products moved",
  datasetRefs: ["ds1"],
  requestedOutputs: [{ id: "a1", description: "movement per product", shape: "table" }],
};

describe("Stage 27.2C §2/§9 — the agent prompt shows exactly what the turn can do", () => {
  const baseContext = (over: Partial<AgentContext> = {}): AgentContext => ({
    round: 1,
    request: "Кластеризуй продукты",
    plan: AGENT_PLAN,
    dataset: AGENT_DATASET,
    observations: [],
    environment: [],
    tools: [],
    remaining: { decisionRounds: 5, codeExecutions: 5, inspections: 3, toolCalls: 8 },
    ...over,
  });

  it("§2 — CALL_TOOL is absent from the prompt when nothing is callable", () => {
    const prompt = buildAgentMessages(baseContext())
      .map((m) => m.content)
      .join("\n");
    expect(prompt).not.toContain("CALL_TOOL");
    expect(prompt).toContain("EXECUTE_CODE");
  });

  it("§9 — the capability summary replaces the flat catalogue, and CALL_TOOL appears with tools", () => {
    const tools: readonly DeterministicTool[] = [agentToolOf(findTool("period.latest")!, true)];
    const prompt = buildAgentMessages(
      baseContext({
        tools,
        capabilities: {
          actions: ["INSPECT", "EXECUTE_CODE", "CALL_TOOL", "DISCOVER_TOOLS", "CLARIFY", "COMPLETE"],
          available: ["schema", "periods"],
          selected: ["periods"],
          purposes: [
            { id: "schema", purpose: CAPABILITY_PURPOSE.schema, toolCount: 7 },
            { id: "periods", purpose: CAPABILITY_PURPOSE.periods, toolCount: 6 },
          ],
        },
      }),
    )
      .map((m) => m.content)
      .join("\n");
    expect(prompt).toContain("CALL_TOOL");
    expect(prompt).toContain("DISCOVER_TOOLS");
    expect(prompt).toContain("CAPABILITIES AVAILABLE THIS TURN:");
    expect(prompt).toContain(CAPABILITY_PURPOSE.periods);
    expect(prompt).toContain("period.latest(");
  });

  it("§38 — without a sandbox the prompt does not advertise Python", () => {
    const prompt = buildAgentMessages(
      baseContext({
        tools: [agentToolOf(findTool("period.latest")!, true)],
        capabilities: {
          actions: ["CALL_TOOL", "CLARIFY", "COMPLETE"],
          available: ["periods"],
          selected: ["periods"],
          purposes: [{ id: "periods", purpose: CAPABILITY_PURPOSE.periods, toolCount: 6 }],
        },
      }),
    )
      .map((m) => m.content)
      .join("\n");
    expect(prompt).not.toContain('"action": "EXECUTE_CODE"');
    expect(prompt).toContain('"action": "CALL_TOOL"');
  });

  it("derives the 27.2A contract when a caller supplies no capability context", () => {
    expect(actionsOf(baseContext())).toEqual(["EXECUTE_CODE", "INSPECT", "CLARIFY", "COMPLETE"]);
    expect(actionsOf(baseContext({ tools: [{ name: "period.latest", summary: "s" }] }))).toContain("CALL_TOOL");
  });
});

// --- §17/§21/§24/§41 the agent loop -----------------------------------------

function movementTable(): SandboxResult {
  return {
    executionId: "exec_1",
    status: "ok",
    tables: [{ name: "movement", columns: ["metric", "delta"], rows: [["Обь", -91] as readonly CellValue[]] }],
    scalars: {},
    series: [],
    groups: [],
    models: [],
    diagnostics: {},
    findingsCandidates: [],
    warnings: [],
    artifacts: [],
    sourceLineage: { datasetIds: ["ds1"], sheet: "S", sourceRange: "S!A1:C4", freshnessToken: "v1" },
  };
}

function fakeRuntime(): SessionRuntime {
  return {
    hardTimeout: true,
    async step() {
      return { status: "ok", stdout: "", available: {}, durationMs: 4 } as StepObservation;
    },
    async look() {
      return { target: "table.info", status: "ok" } as LookObservation;
    },
    async finish(): Promise<ExecuteOutcome> {
      return { ok: true, result: movementTable(), stdout: "", durationMs: 1 };
    },
    async endSession() {
      return undefined;
    },
  };
}

async function runAgent(decisions: readonly string[], over: Record<string, unknown> = {}) {
  const queue = [...decisions];
  const seen: AgentContext[] = [];
  const outcome = await runAnalysisAgent({
    runtime: fakeRuntime(),
    sessionId: "s1",
    request: "r",
    plan: AGENT_PLAN,
    dataset: AGENT_DATASET,
    currentSourceVersion: () => "v1",
    decide: async (context) => {
      seen.push(context);
      return queue.shift() ?? JSON.stringify({ action: "COMPLETE", primaryResultRefs: ["movement"], supportingResultRefs: [] });
    },
    ...over,
  });
  return { outcome, seen };
}

describe("Stage 27.2C §17/§21/§41 — reaching a capability that was not exposed", () => {
  const rankingTools = usableToolsOf("ranking", factsFor({ resultCount: 1 })).map((t) => agentToolOf(t, true));

  it("§37 — CALL_TOOL with no invoker is a CAPABILITY_UNAVAILABLE observation, never an execution attempt", async () => {
    const { outcome } = await runAgent([JSON.stringify({ action: "CALL_TOOL", purpose: "p", tool: "set.top", input: {} })]);
    expect(outcome.metrics.callToolWithoutInvoker).toBeGreaterThan(0);
    expect(outcome.metrics.toolCalls).toBe(0);
    const refusal = outcome.trace.find((s) => s.action === "CAPABILITY_UNAVAILABLE" || s.action === "CONTROL_ERROR");
    expect(refusal?.observation.summary).toContain("CAPABILITY_UNAVAILABLE");
  });

  it("§41 — DISCOVER_TOOLS expands to an available capability the initial selection did not include", async () => {
    const { outcome, seen } = await runAgent(
      [
        JSON.stringify({ action: "DISCOVER_TOOLS", purpose: "need ranking", capability: "ranking" }),
        JSON.stringify({ action: "COMPLETE", primaryResultRefs: ["movement"], supportingResultRefs: [] }),
      ],
      {
        tools: [agentToolOf(findTool("period.latest")!, true)],
        invokeTool: async () => ({ ok: true, summary: "ok" }),
        discover: (capability: string) => (capability === "ranking" ? rankingTools : null),
        availableCapabilities: [{ id: "ranking", purpose: CAPABILITY_PURPOSE.ranking, toolCount: rankingTools.length }],
      },
    );
    expect(outcome.status).toBe("complete");
    expect(outcome.metrics.toolDiscoveryRequests).toBe(1);
    expect(outcome.metrics.finalExposedToolCount).toBeGreaterThan(outcome.metrics.initiallyExposedToolCount);
    expect(outcome.trace.find((s) => s.action === "DISCOVER_TOOLS")?.observation.summary).toContain("AVAILABLE RANKING TOOLS:");
    expect(seen[1]?.tools.some((t) => t.name === "set.top")).toBe(true);
  });

  it("§22 — discovering a capability the turn does not have lists the ones it does", async () => {
    const { outcome } = await runAgent([JSON.stringify({ action: "DISCOVER_TOOLS", purpose: "p", capability: "mutation" })], {
      tools: [agentToolOf(findTool("period.latest")!, true)],
      invokeTool: async () => ({ ok: true, summary: "ok" }),
      discover: () => null,
      availableCapabilities: [{ id: "periods", purpose: CAPABILITY_PURPOSE.periods, toolCount: 6 }],
    });
    const refusal = outcome.trace.find((s) => s.action === "CAPABILITY_UNAVAILABLE");
    expect(refusal?.observation.summary).toContain("CAPABILITY_UNAVAILABLE");
    expect(refusal?.observation.summary).toContain("periods");
    expect(outcome.metrics.capabilityUnavailableErrors).toBe(1);
  });

  it("§21 — calling a tool that exists but is not loaded returns the area's tools, and does not run it", async () => {
    const invoked: string[] = [];
    const { outcome } = await runAgent([JSON.stringify({ action: "CALL_TOOL", purpose: "p", tool: "set.top", input: {} })], {
      tools: [agentToolOf(findTool("period.latest")!, true)],
      invokeTool: async (tool: string) => {
        invoked.push(tool);
        return { ok: true, summary: "ok" };
      },
      discover: (nameOrCapability: string) => (nameOrCapability === "set.top" ? rankingTools : null),
      availableCapabilities: [{ id: "ranking", purpose: CAPABILITY_PURPOSE.ranking, toolCount: rankingTools.length }],
    });
    expect(invoked).toEqual([]);
    expect(outcome.trace.find((s) => s.action === "TOOL_NOT_EXPOSED")?.observation.summary).toContain("set.top");
    expect(outcome.metrics.unknownToolErrors).toBe(0);
    expect(outcome.metrics.finalExposedToolCount).toBeGreaterThan(outcome.metrics.initiallyExposedToolCount);
  });

  it("§40 — a made-up tool is UNKNOWN_TOOL and is never silently substituted", async () => {
    const invoked: string[] = [];
    const { outcome } = await runAgent([JSON.stringify({ action: "CALL_TOOL", purpose: "p", tool: "some.made_up_tool", input: {} })], {
      tools: [agentToolOf(findTool("period.latest")!, true)],
      invokeTool: async (tool: string) => {
        invoked.push(tool);
        return { ok: true, summary: "ok" };
      },
      discover: () => null,
      availableCapabilities: [{ id: "periods", purpose: CAPABILITY_PURPOSE.periods, toolCount: 6 }],
    });
    expect(invoked).toEqual([]);
    expect(outcome.metrics.unknownToolErrors).toBe(1);
    expect(outcome.trace.find((s) => s.action === "UNKNOWN_TOOL")?.observation.summary).toContain("some.made_up_tool");
  });

  it("§24 — a tool observation and a code observation live in the same loop, and COMPLETE still works", async () => {
    const { outcome } = await runAgent(
      [
        JSON.stringify({ action: "CALL_TOOL", purpose: "resolve the period", tool: "period.latest", input: {} }),
        JSON.stringify({ action: "EXECUTE_CODE", purpose: "cluster", code: "groups = 1" }),
        JSON.stringify({ action: "COMPLETE", primaryResultRefs: ["movement"], supportingResultRefs: [] }),
      ],
      {
        tools: [agentToolOf(findTool("period.latest")!, true)],
        invokeTool: async () => ({ ok: true, summary: "result_1 = period.latest → period", resultRefs: ["result_1"] }),
        availableCapabilities: [{ id: "periods", purpose: CAPABILITY_PURPOSE.periods, toolCount: 6 }],
      },
    );
    expect(outcome.status).toBe("complete");
    expect(outcome.metrics.toolCalls).toBe(1);
    expect(outcome.metrics.codeExecutions).toBe(1);
    expect(outcome.metrics.calledToolCount).toBe(1);
    const actions = outcome.trace.map((s) => s.action);
    expect(actions).toContain("CALL_TOOL");
    expect(actions).toContain("EXECUTE_CODE");
  });
});

// --- §13/§18 the agent's own tool context ------------------------------------

describe("Stage 27.2C §13/§18 — the agent's tools are built from the registry and the plan", () => {
  const decision: AnalyzeDecision = {
    kind: "analyze",
    objective: "cluster the products",
    requestedOutputs: [{ id: "o1", description: "clusters", shape: "groups" }],
    necessity: "ADVANCED_STATISTICS",
  };
  const build = (store: ResultStore) =>
    buildAgentToolContext({ schema: table.schema, grids: table.grids, store, state: EMPTY_ANALYTICAL_STATE, decision, sandbox: true });

  it("exposes the plan's capabilities, never the whole registry", () => {
    const built = build(newStore());
    expect(built.tools.length).toBeGreaterThan(0);
    expect(built.tools.length).toBeLessThan(V2_TOOLS.length);
    expect(built.tools.some((t) => t.capability === "statistics")).toBe(true);
    expect(built.availableCapabilities.some((c) => c.id === "sandbox")).toBe(true);
    expect(built.availableCapabilities.some((c) => c.id === "mutation")).toBe(false);
    for (const tool of built.tools) expect(tool.signature).toContain("(");
  });

  it("§20 — the invoker refuses a tool outside the exposed set and never runs it", async () => {
    const store = newStore();
    const refused = await build(store).invokeTool("reference.last_result", {});
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain("CAPABILITY_UNAVAILABLE");
    expect(store.all()).toHaveLength(0);
  });

  it("an exposed tool runs and returns a ResultRef", async () => {
    const store = newStore();
    const outcome = await build(store).invokeTool("schema.metrics", {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resultRefs?.length).toBe(1);
    expect(store.all()).toHaveLength(1);
  });

  it("discovery reaches an available capability and refuses an absent one", () => {
    const built = build(newStore());
    expect(built.discover("periods")?.length).toBeGreaterThan(0);
    expect(built.discover("set.top")?.length).toBeGreaterThan(0);
    expect(built.discover("mutation")).toBeNull();
    expect(built.discover("references")).toBeNull();
  });
});

// --- §47/§52 the 27.2B presented gates stay authoritative --------------------

describe("Stage 27.2C §47/§52 — the answer-quality gates 27.2B installed stay closed", () => {
  const findings: readonly VerifiedFinding[] = [];
  const evaluate = (text: string) =>
    evaluateAnswer({ request: "Покрась красным строки, где загрузка линии упала.", answer: text, findings, locale: "ru", hasResults: true });

  it("catches a first-person recommendation whose verb is \"сверить\"", () => {
    const answer = "Строк, где загрузка линии упала, в таблице нет. Рекомендую сверить исходные данные, если ожидается наличие спада.";
    expect(evaluate(answer).issues).toContain("UNSUPPORTED_RECOMMENDATION");
  });

  it("catches the same construction with сопоставить", () => {
    expect(evaluate("Загрузка линии выросла. Советую сопоставить это с другими показателями.").issues).toContain("UNSUPPORTED_RECOMMENDATION");
  });

  it("does not fire on a plain statement of fact that merely contains a verb", () => {
    expect(evaluate("Строк, где загрузка линии упала, в таблице нет. Загрузка выросла с 1 000 до 1 300.").issues).not.toContain("UNSUPPORTED_RECOMMENDATION");
  });
});

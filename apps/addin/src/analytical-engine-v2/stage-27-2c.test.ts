import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { V2_TOOLS, findTool, buildToolEnv } from "./tools/registry.js";
import { CAPABILITY_IDS, CAPABILITY_PURPOSE, shortDescriptionOf, type CapabilityFacts, type CapabilityId } from "./capability/capability-model.js";
import { capabilityIndex, descriptorOf, toolsOf, usableToolsOf } from "./capability/capability-index.js";
import { availableCapabilities, capabilityFactsOf, capabilityStateOf, referenceFactsOf } from "./capability/capability-availability.js";
import { ENTRY_CAPABILITIES, callableNow, needsPriorResult, selectCapabilities } from "./capability/capability-selection.js";
import { buildToolContext, withoutAbsentTools } from "./capability/tool-context.js";
import { signatureOf } from "./tools/projection.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { benchmarkPortfolio } from "./harness/sandbox-tables.js";
import { buildEngineContext, buildToolCatalog } from "./context/build-context.js";
import { buildPlannerMessages } from "./planner/planner-prompt.js";
import { EMPTY_ANALYTICAL_STATE, storeResult, type AnalyticalConversationState } from "./state/conversation-state.js";
import { ResultStore } from "./results/result-store.js";
import { validateCall } from "./tools/validator.js";
import { evaluateAnswer } from "./narration/answer-evaluator.js";
import type { VerifiedFinding } from "./insight/verified-finding.js";

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

// --- §47/§52 the answer-quality gates ---------------------------------------

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

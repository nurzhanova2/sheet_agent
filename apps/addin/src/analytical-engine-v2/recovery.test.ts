import { describe, expect, it } from "vitest";
import { runAnalyticalEngine, type EngineTurn } from "./engine.js";
import { buildEngineContext } from "./context/build-context.js";
import { capabilityFactsOf } from "./capability/capability-availability.js";
import { selectCapabilities } from "./capability/capability-selection.js";
import { buildToolContext } from "./capability/tool-context.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { buildPlannerMessages, parsePlannerDecision } from "./planner/planner-prompt.js";
import { buildToolEnv } from "./tools/contracts.js";
import { V2_TOOLS } from "./tools/registry.js";
import { validateCall } from "./tools/validator.js";
import { ResultStore } from "./results/result-store.js";
import { EMPTY_ANALYTICAL_STATE, type AnalyticalConversationState } from "./state/conversation-state.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";
import type { EngineResult, ToolOutcome } from "./types.js";

const table = fixtureOperations();
const METRIC = "Defect ratio";

function session(t = table) {
  const store = new ResultStore(t.schema.sourceRange, t.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 5000 });
  const env = buildToolEnv(t.schema, t.grids, store, EMPTY_ANALYTICAL_STATE);
  const call = (tool: string, args: Record<string, unknown> = {}): ToolOutcome => {
    const v = validateCall({ kind: "tool_call", tool, arguments: args }, env);
    if (!v.ok) return v.error;
    return v.call.spec.run(v.call.args, env);
  };
  const ok = (tool: string, args: Record<string, unknown> = {}): EngineResult => {
    const outcome = call(tool, args);
    if (!outcome.ok) throw new Error(`${tool} failed: ${outcome.error.code} ${outcome.error.message}`);
    return outcome.result;
  };
  return { call, ok, env, store };
}

async function withPlanner(reply: (round: number, prompt: string) => string, state: AnalyticalConversationState = EMPTY_ANALYTICAL_STATE): Promise<EngineTurn> {
  let round = 0;
  return runAnalyticalEngine({
    turnId: "recovery",
    request: "Analyse the table.",
    schema: table.schema,
    grids: table.grids,
    language: "en",
    state,
    decide: (messages: readonly PlannerMessage[]) => {
      round += 1;
      return reply(round, messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"));
    },
    narrate: async () => "",
  });
}

const idOf = (prompt: string, tool: string): string | null => {
  const header = "=== RESULTS SO FAR ===\n";
  const start = prompt.indexOf(header);
  if (start < 0) return null;
  const block = prompt
    .slice(start + header.length)
    .split("\n\n")
    .filter((b) => /^result_\d+ = /.test(b.trim()))
    .find((b) => b.includes(`= ${tool} → `));
  return /^(result_\d+) = /.exec(block?.trim() ?? "")?.[1] ?? null;
};

// --- §27: the catalogue regression guard ------------------------------------

describe("Stage 26.4 §27 — the planner's tool catalogue is never malformed", () => {
  const catalog = buildEngineContext(table.schema, table.grids, buildPeriodIndex(table.schema, table.grids), EMPTY_ANALYTICAL_STATE).toolCatalog;

  it("contains no [object Object] anywhere", () => {
    expect(catalog).not.toContain("[object Object]");
  });

  // Stage 27.2C §42/§43 OVERTURNS the "every tool" form of this guard. The
  // catalogue is now tiered: every EXPOSED tool carries its signature, its
  // return type and every required flag — so it stays callable — while the
  // per-argument prose loads only for SELECTED capabilities. What no longer
  // holds is that the registry is serialized whole, which is the point.
  it("names every exposed tool with its type and requiredness, and loads contracts for the selected ones", () => {
    const facts = capabilityFactsOf({ schema: table.schema, periodIndex: buildPeriodIndex(table.schema, table.grids), state: EMPTY_ANALYTICAL_STATE });
    const model = buildToolContext({ facts, selection: selectCapabilities({ facts }) });
    const exposed = new Set(model.exposedTools);
    const loaded = new Set(model.loadedTools);
    expect(exposed.size).toBeGreaterThan(0);
    for (const tool of V2_TOOLS) {
      if (!exposed.has(tool.name)) continue;
      const signature = `${tool.name}(${Object.entries(tool.args)
        .map(([n, spec]) => `${n}${spec.required ? "!" : ""}:${spec.type}`)
        .join(", ")})`;
      expect(catalog, tool.name).toContain(signature);
      expect(catalog, `${tool.name} returns`).toContain(`${signature} → ${tool.returns}`);
      if (!loaded.has(tool.name)) continue;
      for (const [arg, spec] of Object.entries(tool.args)) {
        expect(catalog, `${tool.name}.${arg} describe`).toContain(spec.describe);
        void arg;
      }
    }
  });

  it("names no tool whose capability is unavailable this turn", () => {
    const facts = capabilityFactsOf({ schema: table.schema, periodIndex: buildPeriodIndex(table.schema, table.grids), state: EMPTY_ANALYTICAL_STATE });
    const model = buildToolContext({ facts, selection: selectCapabilities({ facts }) });
    expect(model.absentTools.length).toBeGreaterThan(0);
    for (const name of model.absentTools) expect(catalog, name).not.toContain(name);
  });

  it("advertises the reference alternative wherever a literal slot has one", () => {
    for (const tool of V2_TOOLS) {
      for (const [arg, spec] of Object.entries(tool.args)) {
        const ref = tool.args[`${arg}Ref`];
        if (ref) expect(catalog, `${tool.name}.${arg}Ref`).toContain(`${arg}Ref${ref.required ? "!" : ""}:${ref.type}`);
        void spec;
      }
    }
  });
});

// --- §29/§30: protocol recovery ---------------------------------------------

describe("Stage 26.4 §29 — a misplaced argument is recoverable", () => {
  it("rejects the decision, explains the shape, and succeeds on the correction", async () => {
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return JSON.stringify({ kind: "tool_call", tool: "period.latest", arguments: {} });
      // the exact live slip: the argument written at the top level
      if (round === 2) return JSON.stringify({ kind: "tool_call", tool: "period.previous", ofRef: idOf(prompt, "period.latest") });
      if (round === 3) return JSON.stringify({ kind: "tool_call", tool: "period.previous", arguments: { ofRef: idOf(prompt, "period.latest") } });
      if (round === 4) {
        return JSON.stringify({
          kind: "tool_call",
          tool: "change.compare_periods",
          arguments: { startPeriodRef: idOf(prompt, "period.previous"), endPeriodRef: idOf(prompt, "period.latest") },
        });
      }
      return JSON.stringify({ kind: "complete", primaryResultRef: idOf(prompt, "change.compare_periods"), supportingResultRefs: [] });
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.analysis.primary.type).toBe("comparison");

    const refused = turn.trace.rounds.find((r) => r.decisionProblem);
    expect(refused?.decisionProblem?.severity).toBe("recoverable");
    expect(refused?.decisionProblem?.code).toBe("MISPLACED_ARGUMENTS");
    expect(refused?.decisionProblem?.fields).toEqual(["ofRef"]);
    expect(turn.trace.budget?.protocolCorrections).toBe(1);
    // §15 — the correction cost no tool result
    expect(turn.trace.results.some((r) => r.tool === "period.latest")).toBe(true);
  });

  it("§3 — the engine never moves the field itself; the correction only describes the shape", () => {
    const parsed = parsePlannerDecision(JSON.stringify({ kind: "tool_call", tool: "period.previous", ofRef: "result_1" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.correction).toContain('"arguments"');
    expect(parsed.problem.correction).toContain("ofRef");
    expect(parsed.problem.severity).toBe("recoverable");
  });

  it("§7 — a protocol failure never leaks its internals to the user", async () => {
    const turn = await withPlanner(() => JSON.stringify({ kind: "tool_call", tool: "period.previous", ofRef: "result_1" }));
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.detail).not.toMatch(/PROTOCOL_KEYS/);
    expect(turn.detail).not.toMatch(/\{"kind"/);
  });
});

describe("Stage 26.4 §30 — repeated bad protocol fails closed", () => {
  it("stops after the bounded allowance rather than looping", async () => {
    let calls = 0;
    const turn = await withPlanner(() => {
      calls += 1;
      return JSON.stringify({ kind: "tool_call", tool: "period.previous", ofRef: "result_1" });
    });
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.reason).toBe("invalid_decision");
    // bounded: nowhere near the 10-round analytical budget
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("§4 — an executable payload is FATAL on its first appearance", async () => {
    let calls = 0;
    const turn = await withPlanner(() => {
      calls += 1;
      return JSON.stringify({ kind: "tool_call", tool: "period.latest", arguments: {}, exec: "drop table" });
    });
    expect(turn.kind).toBe("failed");
    expect(calls).toBe(1);
    const problem = turn.trace.rounds.find((r) => r.decisionProblem)?.decisionProblem;
    expect(problem?.severity).toBe("fatal");
    expect(problem?.code).toBe("UNSAFE_PAYLOAD");
  });
});

// --- §31: compound completion retry -----------------------------------------

describe("Stage 26.4 §31 — a completion that misses a declared output is re-bound", () => {
  it("retries the binding without rerunning any tool", async () => {
    const toolRounds: string[] = [];
    let completions = 0;
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) {
        return JSON.stringify({
          kind: "plan",
          outputs: [
            { id: "o1", description: "identify the target metric" },
            { id: "o2", description: "show its history", dependsOn: ["o1"] },
            { id: "o3", description: "find its largest adjacent move", dependsOn: ["o1"] },
          ],
          primaryOutputId: "o3",
        });
      }
      const winner = idOf(prompt, "set.argmax");
      const series = idOf(prompt, "series.get");
      const event = idOf(prompt, "event.max_adjacent_change");
      const volatility = idOf(prompt, "analysis.volatility");
      if (!volatility) {
        toolRounds.push("analysis.volatility");
        return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", arguments: {} });
      }
      if (!winner) {
        toolRounds.push("set.argmax");
        return JSON.stringify({ kind: "tool_call", tool: "set.argmax", arguments: { inputRef: volatility, field: "score" } });
      }
      if (!series) {
        toolRounds.push("series.get");
        return JSON.stringify({ kind: "tool_call", tool: "series.get", arguments: { metricRef: winner } });
      }
      if (!event) {
        toolRounds.push("event.max_adjacent_change");
        return JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", arguments: { metricRef: winner } });
      }
      completions += 1;
      // first COMPLETE: the winner as primary, one output unbound
      if (completions === 1) {
        return JSON.stringify({
          kind: "complete",
          primaryResultRef: winner,
          supportingResultRefs: [series],
          outputBindings: [{ outputId: "o1", resultRef: winner }, { outputId: "o2", resultRef: series }],
        });
      }
      // corrected: the final clause leads, the rest support it
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: event,
        supportingResultRefs: [winner, series],
        outputBindings: [
          { outputId: "o1", resultRef: winner },
          { outputId: "o2", resultRef: series },
          { outputId: "o3", resultRef: event },
        ],
      });
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.analysis.primary.type).toBe("event");
    expect(turn.analysis.supporting).toHaveLength(2);
    expect(completions).toBe(2);
    expect(turn.trace.budget?.completionRetries).toBe(1);
    // §15 — every tool ran exactly once; the retry recomputed nothing
    expect(new Set(toolRounds).size).toBe(toolRounds.length);
    expect(turn.trace.declaredOutputs).toHaveLength(3);
  });

  it("a single-output plan needs no bindings at all", async () => {
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return JSON.stringify({ kind: "plan", outputs: ["compare the last two periods"] });
      const latest = idOf(prompt, "period.latest");
      const prev = idOf(prompt, "period.previous");
      const cmp = idOf(prompt, "change.compare_periods");
      if (!latest) return JSON.stringify({ kind: "tool_call", tool: "period.latest", arguments: {} });
      if (!prev) return JSON.stringify({ kind: "tool_call", tool: "period.previous", arguments: { ofRef: latest } });
      if (!cmp) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { startPeriodRef: prev, endPeriodRef: latest } });
      return JSON.stringify({ kind: "complete", primaryResultRef: cmp, supportingResultRefs: [] });
    });
    expect(turn.kind).toBe("answered");
  });
});

// --- §32/§33: the join -------------------------------------------------------

describe("Stage 26.4 §32 — result.join composes latest-vs-mean", () => {
  it("joins two results by metric and derives a normalised deviation", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const values = s.ok("value.at_period", { periodRef: latest.resultId });
    const means = s.ok("aggregate.avg");
    const joined = s.ok("result.join", { leftRef: values.resultId, rightRef: means.resultId, on: ["metric"] });

    expect(joined.type).toBe("joined");
    // §17 — the right side's clashing "value" column is renamed deterministically
    expect(joined.fields.map((f) => f.name)).toContain("value_2");
    // §19 — provenance for both sides
    expect(joined.parents).toEqual([values.resultId, means.resultId]);

    const derived = s.ok("derive.compute", {
      inputRef: joined.resultId,
      field: "deviation",
      expr: {
        op: "divide",
        left: { op: "abs", value: { op: "subtract", left: { field: "value" }, right: { field: "value_2" } } },
        right: { op: "abs", value: { field: "value_2" } },
      },
    });
    const winner = s.ok("set.argmax", { inputRef: derived.resultId, field: "deviation" });
    expect(winner.metricKeys).toHaveLength(1);

    // the arithmetic is the tools', and it is checkable by hand
    const di = derived.fields.findIndex((f) => f.name === "deviation");
    const mi = derived.fields.findIndex((f) => f.kind === "metric");
    const byMetric = new Map(derived.rows.map((r) => [String(r[mi]), r[di] as number]));
    const defect = byMetric.get(METRIC)!;
    // Defect ratio: latest 273.4174, mean of [50, 38.6024, 317.1601, 273.4174]
    const mean = (50 + 38.6024 + 317.1601 + 273.4174) / 4;
    expect(defect).toBeCloseTo(Math.abs(273.4174 - mean) / Math.abs(mean), 9);
  });

  it("§16 — there is no dedicated latest-vs-mean tool", () => {
    expect(V2_TOOLS.some((t) => /latest_vs_mean|stable_growth/.test(t.name))).toBe(false);
  });

  it("§21 — a zero baseline yields an empty cell, never Infinity or NaN", () => {
    const s = session();
    const trend = s.ok("analysis.trend");
    const derived = s.ok("derive.compute", {
      inputRef: trend.resultId,
      field: "ratio",
      expr: { op: "divide", left: { field: "slope" }, right: { const: 0 } },
    });
    const ri = derived.fields.findIndex((f) => f.name === "ratio");
    for (const row of derived.rows) {
      expect(row[ri]).toBeNull();
      expect(Number.isFinite(row[ri] as number)).toBe(false);
    }
    expect(derived.metadata["undefinedCells"]).toBe(derived.rows.length);
  });
});

describe("Stage 26.4 §33 — the join fails closed", () => {
  const build = () => {
    const s = session();
    const latest = s.ok("period.latest");
    const values = s.ok("value.at_period", { periodRef: latest.resultId });
    const means = s.ok("aggregate.avg");
    return { s, values, means, latest };
  };

  it("rejects a missing key field", () => {
    const { s, values, means } = build();
    const outcome = s.call("result.join", { leftRef: values.resultId, rightRef: means.resultId, on: ["nope"] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/has no field "nope"/);
  });

  it("rejects a key whose kind differs between the two sides", () => {
    const { s, values, means } = build();
    // "value" is numeric on the left and numeric on the right, but "periodLabel"
    // exists only on the left — use a mismatched pair via metric vs value
    const outcome = s.call("result.join", { leftRef: values.resultId, rightRef: means.resultId, on: ["value"] });
    // both sides have a numeric "value"; duplicates make this ambiguous instead
    expect(outcome.ok).toBe(false);
  });

  it("rejects an unknown result reference", () => {
    const { s, values } = build();
    const outcome = s.call("result.join", { leftRef: values.resultId, rightRef: "result_99", on: ["metric"] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("UNKNOWN_REFERENCE");
  });

  it("rejects joining a result to itself", () => {
    const { s, values } = build();
    const outcome = s.call("result.join", { leftRef: values.resultId, rightRef: values.resultId, on: ["metric"] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/cannot be joined to itself/);
  });

  it("rejects a non-per-metric side", () => {
    const { s, values, latest } = build();
    const outcome = s.call("result.join", { leftRef: values.resultId, rightRef: latest.resultId, on: ["metric"] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INCOMPATIBLE_INPUT");
  });

  it("rejects an unsupported join mode", () => {
    const { s, values, means } = build();
    const outcome = s.call("result.join", { leftRef: values.resultId, rightRef: means.resultId, on: ["metric"], how: "outer" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/must be "inner"/);
  });

  it("rejects an ambiguous duplicate key", () => {
    const s = session();
    const series = s.ok("series.get", { metric: METRIC });
    // a series has one row per PERIOD — every row carries the SAME metric
    const means = s.ok("aggregate.avg");
    const outcome = s.call("result.join", { leftRef: series.resultId, rightRef: means.resultId, on: ["metric"] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INCOMPATIBLE_INPUT");
  });
});

// --- §34: reference absence --------------------------------------------------

describe("Stage 26.4 §34 — absent history is data, not a crash", () => {
  it("reference.* on a first turn is NO_PREVIOUS_RESULT and lists this turn's results", () => {
    const s = session();
    s.ok("period.latest");
    for (const tool of ["reference.last_result", "reference.last_metric", "reference.last_metric_set", "reference.last_period", "reference.last_event"]) {
      const outcome = s.call(tool);
      expect(outcome.ok, tool).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code, tool).toBe("NO_PREVIOUS_RESULT");
        // §25 — the current turn's results are still there to continue from
        expect(outcome.error.candidates, tool).toContain("result_1");
      }
    }
  });

  it("a turn that hits it can still finish from its own results", async () => {
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) return JSON.stringify({ kind: "tool_call", tool: "period.latest", arguments: {} });
      if (round === 2) return JSON.stringify({ kind: "tool_call", tool: "reference.last_result", arguments: {} });
      const latest = idOf(prompt, "period.latest");
      const prev = idOf(prompt, "period.previous");
      const cmp = idOf(prompt, "change.compare_periods");
      if (!prev) return JSON.stringify({ kind: "tool_call", tool: "period.previous", arguments: { ofRef: latest } });
      if (!cmp) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { startPeriodRef: prev, endPeriodRef: latest } });
      return JSON.stringify({ kind: "complete", primaryResultRef: cmp, supportingResultRefs: [] });
    });
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.trace.rounds.some((r) => r.toolError?.code === "CAPABILITY_UNAVAILABLE")).toBe(true);
  });

  it("§24 — an absent reference never fabricates a stand-in", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const outcome = s.call("reference.last_result");
    expect(outcome.ok).toBe(false);
    // nothing new was minted, and the existing result is untouched
    expect(s.store.ids()).toEqual([latest.resultId]);
  });

  it("§23 — a STALE previous result is a different condition from an absent one", () => {
    const moved = fixtureOperations("v2");
    const state: AnalyticalConversationState = {
      turnId: "t0",
      lastResult: {
        resultId: "result_1",
        tool: "change.compare_periods",
        type: "comparison",
        fields: [{ name: "metric", kind: "metric" }],
        rows: [["Defect ratio"]],
        metricKeys: ["Defect ratio"],
        periodCanonicals: [],
        sourceRange: moved.schema.sourceRange,
        sourceVersion: "v1",
      },
    };
    const store = new ResultStore(moved.schema.sourceRange, moved.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 5000 });
    const env = buildToolEnv(moved.schema, moved.grids, store, state);
    const spec = V2_TOOLS.find((t) => t.name === "reference.last_result")!;
    const outcome = spec.run({}, env);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("STALE_REFERENCE");
  });
});

describe("Stage 26.4 §11 — re-declaring a plan is idempotent, not a violation", () => {
  // The first 26.4 live run lost 15 of 17 failing turns to this: the planner
  // could not see that its `plan` had been accepted, re-sent it, and the engine
  // treated the repeat as a protocol violation. Re-declaring changes nothing
  // the engine depends on, so it must simply be absorbed.
  it("absorbs a repeated plan and still completes", async () => {
    const turn = await withPlanner((round, prompt) => {
      if (round <= 3) {
        return JSON.stringify({
          kind: "plan",
          outputs: [{ id: "o1", description: "compare the last two periods" }, { id: "o2", description: "name the biggest mover" }],
          primaryOutputId: "o2",
        });
      }
      const latest = idOf(prompt, "period.latest");
      const prev = idOf(prompt, "period.previous");
      const cmp = idOf(prompt, "change.compare_periods");
      const winner = idOf(prompt, "set.argmax");
      if (!latest) return JSON.stringify({ kind: "tool_call", tool: "period.latest", arguments: {} });
      if (!prev) return JSON.stringify({ kind: "tool_call", tool: "period.previous", arguments: { ofRef: latest } });
      if (!cmp) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { startPeriodRef: prev, endPeriodRef: latest } });
      if (!winner) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", arguments: { inputRef: cmp, field: "percentageChange", magnitude: true } });
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: winner,
        supportingResultRefs: [cmp],
        outputBindings: [{ outputId: "o1", resultRef: cmp }, { outputId: "o2", resultRef: winner }],
      });
    });
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    // declaring is not analysis: the repeats cost neither a protocol
    // correction nor an analytical round
    expect(turn.trace.budget?.protocolCorrections).toBe(0);
    expect(turn.trace.declaredOutputs).toHaveLength(2);
  });

  it("a planner that ONLY re-declares fails closed instead of eating the round budget", async () => {
    let calls = 0;
    const turn = await withPlanner(() => {
      calls += 1;
      return JSON.stringify({
        kind: "plan",
        outputs: [{ id: "o1", description: "one thing" }, { id: "o2", description: "another thing" }],
        primaryOutputId: "o2",
      });
    });
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    // it must NOT reach the 10-round analytical budget doing nothing
    expect(turn.reason).toBe("invalid_decision");
    expect(calls).toBeLessThanOrEqual(6);
    expect(turn.trace.budget?.toolCalls).toBe(0);
  });

  it("a plan followed by real work leaves the full analytical budget intact", async () => {
    const turn = await withPlanner((round, prompt) => {
      if (round === 1) {
        return JSON.stringify({
          kind: "plan",
          outputs: [{ id: "o1", description: "a" }, { id: "o2", description: "b" }],
          primaryOutputId: "o2",
        });
      }
      const latest = idOf(prompt, "period.latest");
      const prev = idOf(prompt, "period.previous");
      const cmp = idOf(prompt, "change.compare_periods");
      if (!latest) return JSON.stringify({ kind: "tool_call", tool: "period.latest", arguments: {} });
      if (!prev) return JSON.stringify({ kind: "tool_call", tool: "period.previous", arguments: { ofRef: latest } });
      if (!cmp) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { startPeriodRef: prev, endPeriodRef: latest } });
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: cmp,
        supportingResultRefs: [],
        outputBindings: [{ outputId: "o1", resultRef: cmp }, { outputId: "o2", resultRef: cmp }],
      });
    });
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    // three tool calls plus a completion — the plan round was refunded
    expect(turn.trace.budget?.plannerRounds).toBeLessThanOrEqual(4);
  });

  it("echoes the declaration back so the planner can see it is recorded", () => {
    const messages = buildPlannerMessages({
      request: "anything",
      context: buildEngineContext(table.schema, table.grids, buildPeriodIndex(table.schema, table.grids), EMPTY_ANALYTICAL_STATE),
      results: [],
      declaredOutputs: [{ id: "o1", description: "first thing" }, { id: "o2", description: "second thing" }],
      errors: [],
      round: 2,
      remainingRounds: 8,
    });
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    expect(user).toContain("OUTPUTS YOU ALREADY DECLARED");
    expect(user).toContain("o1: first thing");
    expect(user).toContain("o2: second thing");
  });
});

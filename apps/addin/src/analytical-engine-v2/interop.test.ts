// ---------------------------------------------------------------------------
// Stage 26.3 §21–§26 — TOOL INTEROPERABILITY contract tests.
//
// 26.2L's dominant failure was a reference the planner could not hand to the
// next tool. These tests pin the fixed contract from both directions: every
// semantically compatible edge must COMPOSE (§22), and every incompatible one
// must still fail closed (§23), with lineage recorded (§24) and an empty set
// treated as a result rather than a fault (§25).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildToolEnv } from "./tools/contracts.js";
import { V2_TOOLS, findTool } from "./tools/registry.js";
import { validateCall } from "./tools/validator.js";
import { ResultStore } from "./results/result-store.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { runAnalyticalEngine } from "./engine.js";
import type { EngineResult, ToolOutcome } from "./types.js";

const table = fixtureOperations();

function session() {
  const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 5000 });
  const env = buildToolEnv(table.schema, table.grids, store, EMPTY_ANALYTICAL_STATE);
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
  return { call, ok, env };
}

const METRIC = "Defect ratio";

// --- §21: the invariant that stops this defect coming back ------------------

describe("Stage 26.3 §21 — every semantic scalar slot is reachable by reference", () => {
  it("each literal metric/period argument has a matching <arg>Ref sibling", () => {
    const gaps: string[] = [];
    for (const tool of V2_TOOLS) {
      for (const [arg, spec] of Object.entries(tool.args)) {
        if (spec.type !== "string") continue;
        // slots that NAME one metric or one period — as opposed to an enum, a
        // field name, or the user's own raw wording fed to a resolver
        const semantic = arg === "metric" || ["of", "period", "startPeriod", "endPeriod", "at"].includes(arg);
        if (semantic && !tool.args[`${arg}Ref`]) gaps.push(`${tool.name}.${arg}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it("every declared ref argument carries a resultId type the validator understands", () => {
    for (const tool of V2_TOOLS) {
      for (const [arg, spec] of Object.entries(tool.args)) {
        if (!arg.endsWith("Ref")) continue;
        expect(["resultRef", "metricRef", "periodRef"], `${tool.name}.${arg}`).toContain(spec.type);
      }
    }
  });

  it("§8 — the catalogue exposes real argument contracts, never [object Object]", () => {
    for (const tool of V2_TOOLS) {
      for (const [name, spec] of Object.entries(tool.args)) {
        expect(`${name} (${spec.type}): ${spec.describe}`).not.toContain("[object Object]");
        expect(spec.describe.length, `${tool.name}.${name}`).toBeGreaterThan(0);
      }
    }
  });
});

// --- §22: compatible edges must compose -------------------------------------

describe("Stage 26.3 §22 — a typed reference flows into the next tool", () => {
  it("metric.resolve → series.get, with no retyping of the label", () => {
    const s = session();
    const m = s.ok("metric.resolve", { text: METRIC });
    const series = s.ok("series.get", { metricRef: m.resultId });
    expect(series.type).toBe("series");
    expect(series.metricKeys).toEqual([METRIC]);
  });

  it("metric.resolve → change.compute", () => {
    const s = session();
    const m = s.ok("metric.resolve", { text: METRIC });
    const latest = s.ok("period.latest");
    const prev = s.ok("period.previous", { ofRef: latest.resultId });
    const change = s.ok("change.compute", { metricRef: m.resultId, startPeriodRef: prev.resultId, endPeriodRef: latest.resultId });
    expect(change.type).toBe("comparison");
    expect(change.metricKeys).toEqual([METRIC]);
  });

  it("metric.resolve → event.adjacent_changes / max / min", () => {
    const s = session();
    const m = s.ok("metric.resolve", { text: METRIC });
    for (const tool of ["event.adjacent_changes", "event.max_adjacent_change", "event.min_adjacent_change"]) {
      const r = s.ok(tool, { metricRef: m.resultId });
      expect(r.metricKeys, tool).toEqual([METRIC]);
    }
  });

  it("period.latest → period.previous → period.next round-trips", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const prev = s.ok("period.previous", { ofRef: latest.resultId });
    const back = s.ok("period.next", { ofRef: prev.resultId });
    expect(back.periodCanonicals).toEqual(latest.periodCanonicals);
  });

  it("period.resolve → value.at_period", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const resolved = s.ok("period.resolve", { text: latest.periodCanonicals[0]! });
    const value = s.ok("value.at_period", { periodRef: resolved.resultId });
    expect(value.type).toBe("value");
    expect(value.periodCanonicals).toEqual(resolved.periodCanonicals);
  });

  it("period refs drive change.compare_periods and period.range", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const prev = s.ok("period.previous", { ofRef: latest.resultId });
    const cmp = s.ok("change.compare_periods", { startPeriodRef: prev.resultId, endPeriodRef: latest.resultId });
    expect(cmp.periodCanonicals).toEqual([prev.periodCanonicals[0], latest.periodCanonicals[0]]);
    const range = s.ok("period.range", { startPeriodRef: prev.resultId, endPeriodRef: latest.resultId });
    expect(range.type).toBe("period_range");
  });

  it("a winner selected by set.argmax can itself supply the next tool's metric", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const prev = s.ok("period.previous", { ofRef: latest.resultId });
    const cmp = s.ok("change.compare_periods", { startPeriodRef: prev.resultId, endPeriodRef: latest.resultId });
    const winner = s.ok("set.argmax", { inputRef: cmp.resultId, field: "percentageChange", magnitude: true });
    const series = s.ok("series.get", { metricRef: winner.resultId });
    expect(series.metricKeys).toEqual(winner.metricKeys);
  });

  it("§10 — the literal spelling still works everywhere", () => {
    const s = session();
    const latest = s.ok("period.latest");
    expect(s.ok("series.get", { metric: METRIC }).metricKeys).toEqual([METRIC]);
    expect(s.ok("period.previous", { of: latest.periodCanonicals[0]! }).type).toBe("period");
  });
});

// --- §23: incompatible edges must still fail closed -------------------------

describe("Stage 26.3 §23 — coercion stays strongly typed", () => {
  it("a PERIOD result cannot satisfy a metric slot", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const outcome = s.call("series.get", { metricRef: latest.resultId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INCOMPATIBLE_INPUT");
      expect(outcome.error.message).toMatch(/names no metric/);
    }
  });

  it("a METRIC result cannot satisfy a period slot", () => {
    const s = session();
    const m = s.ok("metric.resolve", { text: METRIC });
    const outcome = s.call("period.previous", { ofRef: m.resultId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/names no period/);
  });

  it("a multi-metric result is refused for a single-metric slot, and lists the members", () => {
    const s = session();
    const all = s.ok("metric.list");
    const outcome = s.call("series.get", { metricRef: all.resultId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INCOMPATIBLE_INPUT");
      expect(outcome.error.message).toMatch(/needs exactly one/);
      expect(outcome.error.candidates?.length ?? 0).toBeGreaterThan(1);
    }
  });

  it("a two-period comparison is refused for a single-period slot", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const prev = s.ok("period.previous", { ofRef: latest.resultId });
    const cmp = s.ok("change.compare_periods", { startPeriodRef: prev.resultId, endPeriodRef: latest.resultId });
    const outcome = s.call("period.previous", { ofRef: cmp.resultId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/spans 2 periods/);
  });

  it("an invented reference is UNKNOWN_REFERENCE with the real ids attached", () => {
    const s = session();
    s.ok("period.latest");
    const outcome = s.call("series.get", { metricRef: "result_99" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("UNKNOWN_REFERENCE");
      expect(outcome.error.candidates).toContain("result_1");
    }
  });

  it("§8 — a resultId in a LITERAL slot names the Ref sibling to use instead", () => {
    const s = session();
    const m = s.ok("metric.resolve", { text: METRIC });
    const outcome = s.call("series.get", { metric: m.resultId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INVALID_ARGUMENT");
      expect(outcome.error.message).toMatch(/pass it as "metricRef"/);
    }
  });

  it("neither spelling supplied is a contract error naming both", () => {
    const s = session();
    const outcome = s.call("series.get", {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/"metric".*"metricRef"/);
  });

  it("§13 — a categorical operator on a numeric field is refused, and vice versa", () => {
    const s = session();
    const trend = s.ok("analysis.trend");
    const wrongOnText = s.call("set.filter", { inputRef: trend.resultId, field: "direction", op: ">", value: "increasing" });
    expect(wrongOnText.ok).toBe(false);
    if (!wrongOnText.ok) expect(wrongOnText.error.message).toMatch(/not a categorical comparison/);

    const wrongOnNumber = s.call("set.filter", { inputRef: trend.resultId, field: "slope", op: "in", value: ["increasing"] });
    expect(wrongOnNumber.ok).toBe(false);
    if (!wrongOnNumber.ok) expect(wrongOnNumber.error.message).toMatch(/not a numeric comparison/);
  });

  it("§12 — no implicit coercion between a numeric field and a string operand", () => {
    const s = session();
    const trend = s.ok("analysis.trend");
    const numericWithString = s.call("set.filter", { inputRef: trend.resultId, field: "slope", op: ">", value: "0" });
    expect(numericWithString.ok).toBe(false);
    if (!numericWithString.ok) expect(numericWithString.error.message).toMatch(/must be a finite number/);

    const textWithNumber = s.call("set.filter", { inputRef: trend.resultId, field: "direction", op: "eq", value: 1 });
    expect(textWithNumber.ok).toBe(false);
    if (!textWithNumber.ok) expect(textWithNumber.error.message).toMatch(/must be a string/);
  });
});

// --- §24: lineage ------------------------------------------------------------

describe("Stage 26.3 §24 — a dereferenced input is a lineage edge", () => {
  it("series.get(metricRef) records the metric result as a parent", () => {
    const s = session();
    const m = s.ok("metric.resolve", { text: METRIC });
    const series = s.ok("series.get", { metricRef: m.resultId });
    expect(series.parents).toContain(m.resultId);
  });

  it("a period chain records each dereferenced endpoint", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const prev = s.ok("period.previous", { ofRef: latest.resultId });
    expect(prev.parents).toContain(latest.resultId);
    const cmp = s.ok("change.compare_periods", { startPeriodRef: prev.resultId, endPeriodRef: latest.resultId });
    expect(cmp.parents).toEqual(expect.arrayContaining([prev.resultId, latest.resultId]));
  });

  it("lineage walks back from a filtered set to the periods it was built from", () => {
    const s = session();
    const latest = s.ok("period.latest");
    const prev = s.ok("period.previous", { ofRef: latest.resultId });
    const cmp = s.ok("change.compare_periods", { startPeriodRef: prev.resultId, endPeriodRef: latest.resultId });
    const filtered = s.ok("set.filter", { inputRef: cmp.resultId, field: "percentageChange", op: "<", value: 0 });
    const lineage = s.env.store.lineageOf(filtered.resultId).map((r) => r.resultId);
    expect(lineage).toEqual(expect.arrayContaining([cmp.resultId, prev.resultId, latest.resultId]));
  });

  it("the resolved metric stays visible in metadata", () => {
    const s = session();
    const m = s.ok("metric.resolve", { text: METRIC });
    const series = s.ok("series.get", { metricRef: m.resultId });
    expect(series.metadata["metric"]).toBe(METRIC);
  });
});

// --- §25: empty sets ---------------------------------------------------------

describe("Stage 26.3 §25 — an empty result is a finding, not a fault", () => {
  const buildComparison = (s: ReturnType<typeof session>) => {
    const latest = s.ok("period.latest");
    const prev = s.ok("period.previous", { ofRef: latest.resultId });
    return s.ok("change.compare_periods", { startPeriodRef: prev.resultId, endPeriodRef: latest.resultId });
  };

  it("a numeric filter matching nothing succeeds with zero rows", () => {
    const s = session();
    const empty = s.ok("set.filter", { inputRef: buildComparison(s).resultId, field: "percentageChange", op: ">", value: 1e9 });
    expect(empty.type).toBe("filtered_set");
    expect(empty.rows).toHaveLength(0);
    expect(empty.metricKeys).toHaveLength(0);
  });

  it("a categorical filter matching nothing succeeds with zero rows", () => {
    const s = session();
    const trend = s.ok("analysis.trend");
    const empty = s.ok("set.filter", { inputRef: trend.resultId, field: "direction", op: "eq", value: "nonexistent-direction" });
    expect(empty.rows).toHaveLength(0);
  });

  it("§15 — ranking an empty set is EMPTY_INPUT_SET, not INCOMPATIBLE_INPUT", () => {
    const s = session();
    const empty = s.ok("set.filter", { inputRef: buildComparison(s).resultId, field: "percentageChange", op: ">", value: 1e9 });
    for (const tool of ["set.argmax", "set.argmin"]) {
      const outcome = s.call(tool, { inputRef: empty.resultId, field: "percentageChange" });
      expect(outcome.ok, tool).toBe(false);
      if (!outcome.ok) expect(outcome.error.code, tool).toBe("EMPTY_INPUT_SET");
    }
  });
});

// --- §17: stable growth stays compositional ---------------------------------

describe("Stage 26.3 §17 — stable growth composes from existing primitives", () => {
  it("trend → categorical filter → stability → ranking, with no dedicated tool", () => {
    expect(findTool("analysis.stable_growth")).toBeUndefined();
    const s = session();
    const trend = s.ok("analysis.trend");
    const growing = s.ok("set.filter", { inputRef: trend.resultId, field: "direction", op: "eq", value: "increasing" });
    expect(growing.rows.length).toBeGreaterThan(0);
    const stability = s.ok("analysis.stability", { inputRef: growing.resultId });
    const winner = s.ok("set.argmax", { inputRef: stability.resultId, field: "score" });
    // §21 of Stage 26.2 — the ranking stays inside the growing subset
    expect(growing.metricKeys).toEqual(expect.arrayContaining([...winner.metricKeys]));
  });
});

// --- §26: the ENGINE composes by reference, end to end ----------------------

describe("Stage 26.3 §26 — a scripted planner composes purely by reference", () => {
  // The script never retypes a label or a date: every step after the first
  // addresses the previous result by its id. This is the composition the live
  // planner attempted 58 times in the 26.2L baseline and could not express.
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

  it("resolve → series → event, addressing each step by resultId only", async () => {
    const steps: string[] = [];
    const turn = await runAnalyticalEngine({
      turnId: "interop",
      request: "Show that metric's history and its biggest move.",
      schema: table.schema,
      grids: table.grids,
      language: "en",
      state: EMPTY_ANALYTICAL_STATE,
      decide: (messages) => {
        const prompt = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        const metric = idOf(prompt, "metric.resolve");
        const series = idOf(prompt, "series.get");
        const event = idOf(prompt, "event.max_adjacent_change");
        let decision: Record<string, unknown>;
        if (!metric) decision = { kind: "tool_call", tool: "metric.resolve", arguments: { text: METRIC } };
        else if (!series) decision = { kind: "tool_call", tool: "series.get", arguments: { metricRef: metric } };
        else if (!event) decision = { kind: "tool_call", tool: "event.max_adjacent_change", arguments: { metricRef: metric } };
        else decision = { kind: "complete", primaryResultRef: event, supportingResultRefs: [series] };
        steps.push(JSON.stringify(decision));
        return JSON.stringify(decision);
      },
      narrate: async () => "",
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.analysis.primary.type).toBe("event");
    expect(turn.analysis.primary.metricKeys).toEqual([METRIC]);
    expect(turn.analysis.supporting).toHaveLength(1);
    // no tool error was needed to get here
    expect(turn.trace.rounds.filter((r) => r.toolError)).toHaveLength(0);
    // and the metric label was never retyped after the first resolve
    expect(steps.filter((s) => s.includes(METRIC))).toHaveLength(1);
  });

  it("§16 — an empty filtered set completes and narrates as a real answer", async () => {
    const turn = await runAnalyticalEngine({
      turnId: "interop-empty",
      request: "Show only the indicators that fell by more than a billion percent.",
      schema: table.schema,
      grids: table.grids,
      language: "en",
      state: EMPTY_ANALYTICAL_STATE,
      decide: (messages) => {
        const prompt = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        const latest = idOf(prompt, "period.latest");
        const prev = idOf(prompt, "period.previous");
        const cmp = idOf(prompt, "change.compare_periods");
        const filtered = idOf(prompt, "set.filter");
        if (!latest) return JSON.stringify({ kind: "tool_call", tool: "period.latest", arguments: {} });
        if (!prev) return JSON.stringify({ kind: "tool_call", tool: "period.previous", arguments: { ofRef: latest } });
        if (!cmp) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { startPeriodRef: prev, endPeriodRef: latest } });
        if (!filtered) return JSON.stringify({ kind: "tool_call", tool: "set.filter", arguments: { inputRef: cmp, field: "percentageChange", op: "<", value: -1e9 } });
        return JSON.stringify({ kind: "complete", primaryResultRef: filtered, supportingResultRefs: [] });
      },
      narrate: async () => "",
    });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.analysis.primary.rows).toHaveLength(0);
    expect(turn.body).toMatch(/No indicator matches/i);
    expect(turn.trace.rounds.filter((r) => r.toolError)).toHaveLength(0);
  });
});

describe("Stage 26.3 §8 — both baseline mis-spellings of a reference are recoverable", () => {
  it("an object-wrapped reference names the Ref sibling to use", () => {
    const s = session();
    const m = s.ok("metric.resolve", { text: METRIC });
    const outcome = s.call("series.get", { metric: { inputRef: m.resultId } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INVALID_ARGUMENT");
      expect(outcome.error.message).toContain('"metricRef"');
      expect(outcome.error.message).toContain(m.resultId);
    }
  });

  it("an object in a literal slot with no id still points at the Ref sibling", () => {
    const s = session();
    const outcome = s.call("series.get", { metric: { label: "whatever" } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.candidates).toContain("metricRef");
  });

  it("a literal slot with no Ref sibling keeps the plain type error", () => {
    const s = session();
    const outcome = s.call("metric.resolve", { text: { phrase: "x" } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/must be string/);
  });
});

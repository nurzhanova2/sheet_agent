// ---------------------------------------------------------------------------
// Stage 26.2 §46/§8 — every adapter of the full registry, and the contract
// checks that make a wrong chain fail closed.
//
// These are ENGINE tests: they prove the deterministic layer is correct
// independently of how good any model is at choosing tools.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { ResultStore } from "./results/result-store.js";
import { EMPTY_ANALYTICAL_STATE, storeResult, type AnalyticalConversationState } from "./state/conversation-state.js";
import { buildToolEnv, V2_TOOLS, findTool } from "./tools/registry.js";
import { callSignature, executeCall, validateCall } from "./tools/validator.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { seriesMean, seriesStdDev, seriesSum, stabilityFromVolatility } from "../app/schema/analytical/series-aggregates.js";
import { getTemporalSeries } from "../app/schema/analytical/temporal-series.js";
import { computeVolatility } from "../app/schema/analytical/temporal-primitives.js";
import { fixtureOperations, fixtureOpaque, type SyntheticTable } from "./__fixtures__/synthetic-tables.js";
import type { EngineResult, ToolOutcome } from "./types.js";

function session(table: SyntheticTable, state: AnalyticalConversationState = EMPTY_ANALYTICAL_STATE) {
  const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 3000 });
  const env = buildToolEnv(table.schema, table.grids, store, state);
  const cache = new Map<string, string>();
  const call = (tool: string, args: Record<string, unknown> = {}): ToolOutcome => {
    const validated = validateCall({ kind: "tool_call", tool, arguments: args }, env);
    if (!validated.ok) return validated.error;
    return executeCall(validated.call, env, cache).outcome;
  };
  const ok = (tool: string, args: Record<string, unknown> = {}): EngineResult => {
    const outcome = call(tool, args);
    if (!outcome.ok) throw new Error(`${tool} failed: ${outcome.error.code}: ${outcome.error.message}`);
    return outcome.result;
  };
  return { store, env, cache, call, ok };
}

function column(r: EngineResult, name: string): readonly unknown[] {
  const i = r.fields.findIndex((f) => f.name === name);
  return r.rows.map((row) => row[i]);
}

const LATEST = (s: ReturnType<typeof session>): string => s.ok("period.latest").periodCanonicals[0]!;
const PREVIOUS = (s: ReturnType<typeof session>, of: string): string => s.ok("period.previous", { of }).periodCanonicals[0]!;

describe("Stage 26.2 §3 — the registry is structurally complete", () => {
  it("exposes every tool the stage requires, each with a usable description and a declared return type", () => {
    const required = [
      "schema.describe", "schema.metrics", "schema.periods",
      "metric.list", "metric.resolve", "metric.resolve_set", "metric.filter",
      "period.list", "period.resolve", "period.latest", "period.previous", "period.next", "period.range",
      "value.at_period", "series.get",
      "change.compute", "change.compare_periods",
      "aggregate.sum", "aggregate.avg", "aggregate.min", "aggregate.max", "aggregate.std",
      "set.filter", "set.sort", "set.top", "set.bottom", "set.argmax", "set.argmin", "set.union", "set.intersection",
      "analysis.trend", "analysis.volatility", "analysis.stability", "analysis.monotonicity", "analysis.direction_changes", "analysis.temporal_pattern",
      "event.adjacent_changes", "event.max_adjacent_change", "event.min_adjacent_change",
      "derive.compute",
      // Stage 26.4 §16/§17 — one generic join, deliberately NOT a
      // question-specific `analysis.latest_vs_mean`.
      "result.join",
      "reference.last_result", "reference.last_metric", "reference.last_metric_set", "reference.last_period", "reference.last_event",
      // Stage 26.7 §10 — the conversation slots that had no tool of their own
      "reference.recent",
      "reference.last_period_range",
      "reference.last_series",
      "reference.last_analysis",
    ];
    for (const name of required) expect(findTool(name), name).toBeDefined();
    expect(V2_TOOLS).toHaveLength(required.length);
  });

  it("§5 — every description says more than its own name, and every argument documents itself", () => {
    for (const t of V2_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(60);
      expect(t.description, t.name).toMatch(/return/i);
      for (const [arg, spec] of Object.entries(t.args)) expect(spec.describe.length, `${t.name}.${arg}`).toBeGreaterThan(3);
    }
  });

  it("§59 — no description names a benchmark phrase or a real workbook's metric", () => {
    const forbidden = /Активы|Обязательства|обратное РЕПО|Вклады клиентов|Доля брака|Метрика Бета|сильнее всего|из них/i;
    for (const t of V2_TOOLS) expect(t.description, t.name).not.toMatch(forbidden);
  });
});

describe("Stage 26.2 §3/§4 — schema and metric adapters", () => {
  const table = fixtureOperations();

  it("schema.describe / schema.metrics / schema.periods report the induced schema, not guesses", () => {
    const s = session(table);
    expect(s.ok("schema.describe").rows[0]).toContain(table.schema.sheetName);
    expect(s.ok("schema.metrics").metricKeys).toEqual(table.metricLabels);
    expect(s.ok("schema.periods").periodCanonicals).toEqual(buildPeriodIndex(table.schema, table.grids).points.map((p) => p.canonical));
  });

  it("metric.list narrows by semantic class and refuses an unknown scope", () => {
    const s = session(table);
    expect(s.ok("metric.list").metricKeys).toEqual(table.metricLabels);
    const bad = s.call("metric.list", { scope: "everything" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_ARGUMENT");
  });

  it("metric.resolve maps user wording onto the exact label; a miss lists the real ones", () => {
    const s = session(table);
    expect(s.ok("metric.resolve", { text: "Defect ratio" }).metricKeys).toEqual(["Defect ratio"]);
    const miss = s.call("metric.resolve", { text: "нет такого показателя" });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error.candidates).toEqual(expect.arrayContaining(["Defect ratio"]));
  });

  it("metric.filter removes a semantic class and keeps the rest", () => {
    const s = session(table);
    const all = s.ok("metric.list");
    const amounts = s.ok("metric.filter", { inputRef: all.resultId, exclude: "percentage_like" });
    expect(amounts.metricKeys.length).toBeGreaterThan(0);
    expect(amounts.parents).toEqual([all.resultId]);
    const neither = s.call("metric.filter", {});
    expect(neither.ok).toBe(false);
  });
});

describe("Stage 26.2 §24 — period adapters never substitute a nearby date", () => {
  const table = fixtureOperations();

  it("latest / previous / next walk the index in order", () => {
    const s = session(table);
    const points = buildPeriodIndex(table.schema, table.grids).points.map((p) => p.canonical);
    const latest = LATEST(s);
    expect(latest).toBe(points[points.length - 1]);
    const prev = PREVIOUS(s, latest);
    expect(prev).toBe(points[points.length - 2]);
    expect(s.ok("period.next", { of: prev }).periodCanonicals[0]).toBe(latest);
  });

  it("period.resolve accepts a canonical string or a displayed header, and refuses anything else", () => {
    const s = session(table);
    const point = buildPeriodIndex(table.schema, table.grids).points[0]!;
    expect(s.ok("period.resolve", { text: point.canonical }).periodCanonicals[0]).toBe(point.canonical);
    expect(s.ok("period.resolve", { text: point.headerPath }).periodCanonicals[0]).toBe(point.canonical);
    const invented = s.call("period.resolve", { text: "01.01.1999" });
    expect(invented.ok).toBe(false);
    if (!invented.ok) {
      expect(invented.error.code).toBe("AMBIGUOUS_PERIOD");
      expect(invented.error.candidates?.length).toBeGreaterThan(0);
    }
  });

  it("period.range spans inclusively, oldest first, whichever order the ends are given in", () => {
    const s = session(table);
    const points = buildPeriodIndex(table.schema, table.grids).points.map((p) => p.canonical);
    const forward = s.ok("period.range", { startPeriod: points[0]!, endPeriod: points[2]! });
    const backward = s.ok("period.range", { startPeriod: points[2]!, endPeriod: points[0]! });
    expect(forward.periodCanonicals).toEqual(points.slice(0, 3));
    expect(backward.periodCanonicals).toEqual(forward.periodCanonicals);
  });

  it("period.previous at the earliest period is a typed refusal, not a wrap-around", () => {
    const s = session(table);
    const first = buildPeriodIndex(table.schema, table.grids).points[0]!.canonical;
    const outcome = s.call("period.previous", { of: first });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("AMBIGUOUS_PERIOD");
  });
});

describe("Stage 26.2 §4 — value, change and aggregate adapters match the primitives exactly", () => {
  const table = fixtureOperations();

  it("value.at_period reads the same point the primitive does, with its cell", () => {
    const s = session(table);
    const latest = LATEST(s);
    const values = s.ok("value.at_period", { period: latest });
    expect(values.rows).toHaveLength(table.metricLabels.length);
    expect(values.fields.some((f) => f.kind === "cell")).toBe(true);
  });

  it("change.compute and change.compare_periods agree on the same metric and periods", () => {
    const s = session(table);
    const latest = LATEST(s);
    const prev = PREVIOUS(s, latest);
    const one = s.ok("change.compute", { metric: "Defect ratio", startPeriod: prev, endPeriod: latest });
    const all = s.ok("change.compare_periods", { startPeriod: prev, endPeriod: latest });
    const i = all.metricKeys.indexOf("Defect ratio");
    expect(column(one, "percentageChange")[0]).toBe(column(all, "percentageChange")[i]);
    expect(column(one, "absoluteChange")[0]).toBe(column(all, "absoluteChange")[i]);
  });

  it("§21 — passing inputRef keeps a comparison inside the earlier candidate set", () => {
    const s = session(table);
    const latest = LATEST(s);
    const prev = PREVIOUS(s, latest);
    const a = s.ok("metric.resolve", { text: "Defect ratio" });
    const b = s.ok("metric.resolve", { text: "Queue depth" });
    const narrow = s.ok("set.union", { leftRef: a.resultId, rightRef: b.resultId });
    const scoped = s.ok("change.compare_periods", { startPeriod: prev, endPeriod: latest, inputRef: narrow.resultId });
    expect([...scoped.metricKeys].sort()).toEqual(["Defect ratio", "Queue depth"]);
    expect(scoped.parents).toEqual([narrow.resultId]);
  });

  it("aggregate.avg / sum / std reproduce the shared primitives, and min/max carry their period", () => {
    const s = session(table);
    const series = getTemporalSeries(table.schema, table.grids, { kind: "row_axis_member", member: table.schema.rowAxis.find((m) => m.display === "Defect ratio")! }, buildPeriodIndex(table.schema, table.grids))!;
    const at = (r: EngineResult): number => Number(column(r, "value")[r.metricKeys.indexOf("Defect ratio")]);
    expect(at(s.ok("aggregate.avg"))).toBe(seriesMean(series)!.value);
    expect(at(s.ok("aggregate.sum"))).toBe(seriesSum(series)!.value);
    expect(at(s.ok("aggregate.std"))).toBe(seriesStdDev(series)!.value);
    const max = s.ok("aggregate.max");
    expect(max.fields.some((f) => f.name === "periodLabel")).toBe(true);
  });
});

describe("Stage 26.2 §22/§23/§26/§30 — set operations and derived columns", () => {
  const table = fixtureOperations();

  function comparison(s: ReturnType<typeof session>): EngineResult {
    const latest = LATEST(s);
    return s.ok("change.compare_periods", { startPeriod: PREVIOUS(s, latest), endPeriod: latest });
  }

  it("set.argmax scans values, so the winner does not depend on row order", () => {
    const s = session(table);
    const cmp = comparison(s);
    const declined = s.ok("set.filter", { inputRef: cmp.resultId, field: "percentageChange", op: "<", value: 0 });
    const winner = s.ok("set.argmax", { inputRef: declined.resultId, field: "percentageChange", magnitude: true });
    expect(winner.metricKeys).toEqual(["Defect ratio"]);
    expect(winner.metadata["candidateCount"]).toBe(declined.rows.length);
    // and ranking the deliberately re-sorted set gives the same winner
    const sorted = s.ok("set.sort", { inputRef: declined.resultId, field: "percentageChange", direction: "asc" });
    expect(s.ok("set.argmax", { inputRef: sorted.resultId, field: "percentageChange", magnitude: true }).metricKeys).toEqual(["Defect ratio"]);
  });

  it("§22 — magnitude decides whether a large fall can beat a small rise", () => {
    const s = session(table);
    const cmp = comparison(s);
    expect(s.ok("set.argmax", { inputRef: cmp.resultId, field: "percentageChange" }).metricKeys).toEqual(["Throughput index"]);
    expect(s.ok("set.argmax", { inputRef: cmp.resultId, field: "percentageChange", magnitude: true }).metricKeys).toEqual(["Defect ratio"]);
  });

  it("set.top / set.bottom slice an order; set.argmin picks the other end", () => {
    const s = session(table);
    const cmp = comparison(s);
    const top2 = s.ok("set.top", { inputRef: cmp.resultId, field: "percentageChange", n: 2, magnitude: true });
    expect(top2.rows).toHaveLength(2);
    expect(top2.metricKeys[0]).toBe("Defect ratio");
    expect(s.ok("set.argmin", { inputRef: cmp.resultId, field: "percentageChange", magnitude: true }).metricKeys).toEqual(["Queue depth"]);
    expect(s.ok("set.bottom", { inputRef: cmp.resultId, field: "percentageChange", n: 1 }).metricKeys).toEqual(["Defect ratio"]);
  });

  it("set.union widens and set.intersection narrows, both by metric identity", () => {
    const s = session(table);
    const defect = s.ok("metric.resolve", { text: "Defect ratio" });
    const queue = s.ok("metric.resolve", { text: "Queue depth" });
    const cost = s.ok("metric.resolve", { text: "Handling cost" });
    const a = s.ok("set.union", { leftRef: defect.resultId, rightRef: queue.resultId });
    const b = s.ok("set.union", { leftRef: queue.resultId, rightRef: cost.resultId });
    expect([...s.ok("set.union", { leftRef: a.resultId, rightRef: b.resultId }).metricKeys].sort()).toEqual(["Defect ratio", "Handling cost", "Queue depth"]);
    expect(s.ok("set.intersection", { leftRef: a.resultId, rightRef: b.resultId }).metricKeys).toEqual(["Queue depth"]);
  });

  it("§29/§30 — derive.compute builds a normalised deviation the planner can then rank", () => {
    const s = session(table);
    const latest = LATEST(s);
    const mean = s.ok("aggregate.avg");
    const now = s.ok("value.at_period", { period: latest, inputRef: mean.resultId });
    // join the two by putting the latest value onto the mean result via derive
    // is not possible directly, so derive over the comparison instead:
    const cmp = s.ok("change.compare_periods", { startPeriod: PREVIOUS(s, latest), endPeriod: latest });
    const derived = s.ok("derive.compute", {
      inputRef: cmp.resultId,
      field: "relativeMove",
      expr: { op: "divide", left: { op: "abs", value: { field: "absoluteChange" } }, right: { op: "abs", value: { field: "startValue" } } },
    });
    expect(derived.fields.map((f) => f.name)).toContain("relativeMove");
    expect(derived.parents).toEqual([cmp.resultId]);
    expect(now.rows.length).toBeGreaterThan(0);
    // the derived column is genuinely computed, not copied
    const i = derived.fields.findIndex((f) => f.name === "relativeMove");
    const j = derived.fields.findIndex((f) => f.name === "absoluteChange");
    expect(derived.rows.every((r) => r[i] !== r[j])).toBe(true);
  });

  it("§30 — a code string or an unknown field is refused; no eval path exists", () => {
    const s = session(table);
    const cmp = comparison(s);
    const codey = s.call("derive.compute", { inputRef: cmp.resultId, field: "x", expr: { op: "eval", code: "process.exit(1)" } });
    expect(codey.ok).toBe(false);
    if (!codey.ok) expect(codey.error.code).toBe("INVALID_ARGUMENT");
    const unknownField = s.call("derive.compute", { inputRef: cmp.resultId, field: "y", expr: { field: "notAField" } });
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) expect(unknownField.error.message).toMatch(/unknown numeric field/);
    const existing = s.call("derive.compute", { inputRef: cmp.resultId, field: "absoluteChange", expr: { const: 1 } });
    expect(existing.ok).toBe(false);
  });
});

describe("Stage 26.2 §27/§28 — temporal analyses match their primitives", () => {
  const table = fixtureOperations();

  it("volatility and stability are two views of one score", () => {
    const s = session(table);
    const vol = s.ok("analysis.volatility");
    const stab = s.ok("analysis.stability");
    const i = vol.metricKeys.indexOf("Defect ratio");
    const j = stab.metricKeys.indexOf("Defect ratio");
    expect(Number(column(stab, "score")[j])).toBeCloseTo(stabilityFromVolatility(Number(column(vol, "score")[i])), 12);
    // and against the primitive directly
    const series = getTemporalSeries(table.schema, table.grids, { kind: "row_axis_member", member: table.schema.rowAxis.find((m) => m.display === "Defect ratio")! }, buildPeriodIndex(table.schema, table.grids))!;
    const direct = computeVolatility(series, { measureKind: series.measureKind });
    expect("unavailable" in direct).toBe(false);
    if (!("unavailable" in direct)) expect(Number(column(vol, "score")[i])).toBe(direct.score);
  });

  it("§28 — steady growth is a COMPOSITION: trend, then stability, then a ranking", () => {
    const s = session(table);
    const trend = s.ok("analysis.trend");
    const growing = s.ok("set.filter", { inputRef: trend.resultId, field: "normalizedSlope", op: ">", value: 0 });
    const stability = s.ok("analysis.stability", { inputRef: growing.resultId });
    const steadiest = s.ok("set.argmax", { inputRef: stability.resultId, field: "score" });
    expect(steadiest.metricKeys).toHaveLength(1);
    // the winner really was among the growing metrics, never the whole table
    expect(growing.metricKeys).toContain(steadiest.metricKeys[0]);
    expect(growing.metricKeys.length).toBeLessThan(table.metricLabels.length);
  });

  it("monotonicity, direction changes and temporal pattern all report per metric", () => {
    const s = session(table);
    expect(s.ok("analysis.monotonicity").rows.length).toBeGreaterThan(0);
    expect(s.ok("analysis.direction_changes").fields.map((f) => f.name)).toContain("directionChangeCount");
    const pattern = s.ok("analysis.temporal_pattern", { pattern: "down_then_up" });
    expect(pattern.fields.map((f) => f.name)).toContain("matched");
    const bad = s.call("analysis.temporal_pattern", { pattern: "sideways" });
    expect(bad.ok).toBe(false);
  });

  it("event tools: the full move history, and the biggest move which is NOT the last pair here", () => {
    const s = session(table);
    const all = s.ok("event.adjacent_changes", { metric: "Defect ratio" });
    const max = s.ok("event.max_adjacent_change", { metric: "Defect ratio" });
    expect(all.rows.length).toBe(buildPeriodIndex(table.schema, table.grids).points.length - 1);
    expect(max.rows).toHaveLength(1);
    const latest = LATEST(s);
    expect(max.periodCanonicals[1]).not.toBe(latest);
    expect(s.ok("event.min_adjacent_change", { metric: "Defect ratio" }).rows).toHaveLength(1);
  });
});

describe("Stage 26.2 §8 — incompatible chains fail closed", () => {
  const table = fixtureOperations();

  it("a series cannot be filtered or ranked by a per-metric change field", () => {
    const s = session(table);
    const series = s.ok("series.get", { metric: "Defect ratio" });
    const attempts: readonly [string, Record<string, unknown>][] = [
      ["set.filter", { inputRef: series.resultId, field: "percentageChange", op: "<", value: 0 }],
      ["set.argmax", { inputRef: series.resultId, field: "percentageChange" }],
      ["set.top", { inputRef: series.resultId, field: "percentageChange", n: 1 }],
    ];
    for (const [tool, args] of attempts) {
      const outcome = s.call(tool, args);
      expect(outcome.ok, tool).toBe(false);
      if (!outcome.ok) expect(outcome.error.code, tool).toBe("INCOMPATIBLE_INPUT");
    }
  });

  it("a non-numeric or missing field is refused, with the numeric ones listed", () => {
    const s = session(table);
    const latest = LATEST(s);
    const cmp = s.ok("change.compare_periods", { startPeriod: PREVIOUS(s, latest), endPeriod: latest });
    const textField = s.call("set.argmax", { inputRef: cmp.resultId, field: "startCell" });
    expect(textField.ok).toBe(false);
    if (!textField.ok) {
      expect(textField.error.code).toBe("INCOMPATIBLE_INPUT");
      expect(textField.error.candidates).toEqual(expect.arrayContaining(["percentageChange"]));
    }
    const missing = s.call("set.filter", { inputRef: cmp.resultId, field: "nope", op: "<", value: 0 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("INVALID_ARGUMENT");
  });

  it("a period result cannot be used where a metric universe is required", () => {
    const s = session(table);
    const periods = s.ok("period.list");
    const outcome = s.call("analysis.trend", { inputRef: periods.resultId });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INCOMPATIBLE_INPUT");
  });

  // Stage 26.3 §14 — this deliberately REVERSES the Stage 26.2 expectation.
  // "Nothing matched" is a true analytical finding; reporting it as
  // INCOMPATIBLE_INPUT made it unsayable and cost a live turn (para-flt-2).
  it("a filter that matches nothing returns a valid EMPTY result, not an error", () => {
    const s = session(table);
    const latest = LATEST(s);
    const cmp = s.ok("change.compare_periods", { startPeriod: PREVIOUS(s, latest), endPeriod: latest });
    const empty = s.ok("set.filter", { inputRef: cmp.resultId, field: "percentageChange", op: ">", value: 1e9 });
    expect(empty.type).toBe("filtered_set");
    expect(empty.rows).toHaveLength(0);
    expect(empty.metricKeys).toHaveLength(0);
    expect(empty.parents).toContain(cmp.resultId);
    expect(empty.metadata["matched"]).toBe(0);
  });
});

describe("Stage 26.2 §19/§20/§41 — reference tools return typed references", () => {
  const table = fixtureOperations();

  it("restore the previous result, metric, set, period and event as structured results", () => {
    const s0 = session(table);
    const latest = LATEST(s0);
    const cmp = s0.ok("change.compare_periods", { startPeriod: PREVIOUS(s0, latest), endPeriod: latest });
    const state: AnalyticalConversationState = {
      turnId: "t0",
      lastResult: storeResult(cmp),
      lastMetric: { metricKey: "Defect ratio" },
      lastMetricSet: { metricKeys: ["Defect ratio", "Queue depth"], fromResultId: cmp.resultId },
      lastPeriod: { startCanonical: cmp.periodCanonicals[0]!, endCanonical: cmp.periodCanonicals[1]! },
      lastEvent: { metricKey: "Defect ratio", startCanonical: "a", endCanonical: "b", startValue: 1, endValue: 2, absoluteChange: 1, percentageChange: 0.5 },
    };
    const s = session(table, state);
    const restored = s.ok("reference.last_result");
    expect(restored.rows).toEqual(cmp.rows);
    expect(restored.type).toBe("comparison");
    expect(s.ok("reference.last_metric").metricKeys).toEqual(["Defect ratio"]);
    expect(s.ok("reference.last_metric_set").metricKeys).toEqual(["Defect ratio", "Queue depth"]);
    expect(s.ok("reference.last_period").periodCanonicals).toEqual(cmp.periodCanonicals);
    expect(s.ok("reference.last_event").metricKeys).toEqual(["Defect ratio"]);
  });

  it("§41 — a result from an older table version is refused, not silently reused", () => {
    const s0 = session(table);
    const cmp = s0.ok("schema.metrics");
    const state: AnalyticalConversationState = { turnId: "t0", lastResult: { ...storeResult(cmp), sourceVersion: "older" } };
    const outcome = session(table, state).call("reference.last_result");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("STALE_REFERENCE");
  });
});

describe("Stage 26.2 §38/§39 — duplicate calls reuse their result", () => {
  const table = fixtureOperations();

  it("an identical call within one turn returns the SAME resultId and does not recompute", () => {
    const s = session(table);
    const first = s.ok("analysis.volatility");
    const second = s.ok("analysis.volatility");
    expect(second.resultId).toBe(first.resultId);
    expect(s.store.ids()).toHaveLength(1);
  });

  it("a different argument is a different call", () => {
    const s = session(table);
    s.ok("analysis.volatility");
    s.ok("analysis.volatility", { metrics: ["Defect ratio"] });
    expect(s.store.ids()).toHaveLength(2);
  });

  it("the signature is order-independent so key order cannot defeat the cache", () => {
    expect(callSignature("set.filter", { field: "x", op: "<", value: 0 })).toBe(callSignature("set.filter", { value: 0, op: "<", field: "x" }));
  });

  it("a FAILED call is never cached — the planner must see the error again", () => {
    const s = session(table);
    const a = s.call("period.resolve", { text: "01.01.1999" });
    const b = s.call("period.resolve", { text: "01.01.1999" });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });
});

describe("Stage 26.2 §52 — the same tools on a different table with opaque labels", () => {
  it("ranks by the data alone", () => {
    const table = fixtureOpaque();
    const s = session(table);
    const latest = LATEST(s);
    const cmp = s.ok("change.compare_periods", { startPeriod: PREVIOUS(s, latest), endPeriod: latest });
    const winner = s.ok("set.argmax", { inputRef: cmp.resultId, field: "percentageChange", magnitude: true });
    // Alpha 11→30 is +172.7%, Beta 470→120 is -74.5%: Alpha wins by magnitude.
    expect(winner.metricKeys).toEqual(["Alpha"]);
    const declined = s.ok("set.filter", { inputRef: cmp.resultId, field: "percentageChange", op: "<", value: 0 });
    expect([...declined.metricKeys].sort()).toEqual(["Beta", "Gamma"]);
    expect(s.ok("set.argmax", { inputRef: declined.resultId, field: "percentageChange", magnitude: true }).metricKeys).toEqual(["Beta"]);
  });
});

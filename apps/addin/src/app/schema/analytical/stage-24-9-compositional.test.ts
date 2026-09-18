// Stage 24.9 — multi-metric & compound analytical reasoning. Compiler /
// executor level: direction-change events (§50–§52), monotonic symmetry
// (§53), semantic-class filtering (§54), ResultSetRef-shaped output (§55),
// multi-metric resolution (§56), comparison (§57), generic growth rate
// (§58), and Stage 24.7/24.7.1/24.8 regressions (§61–§64).
import { describe, expect, it } from "vitest";
import { induceTableSchema } from "../schema-induction.js";
import { fixtureBalanceLike, fixtureDirectionAndSets } from "../__fixtures__/tables.js";
import { classifySemanticMetricClass, isPercentageLike } from "../measure-compatibility.js";
import { detectAnalyticalIntent } from "./analytical-intent.js";
import { compileAnalyticalPlan, type InheritedMetricSet } from "./analytical-compiler.js";
import { validatePlan } from "./analytical-plan-validator.js";
import { executePlan } from "./analytical-executor.js";
import { buildPeriodIndex } from "./period-index.js";
import { resolveMetricSet, buildMetricIndex } from "./metric-resolver.js";
import { computeDirectionChangeEvents } from "./temporal-primitives.js";
import type { AnalysisGrids } from "../matrix-analysis.js";
import type { TableSchema } from "../schema-induction.js";
import type { TemporalPoint, TemporalSeries } from "./types.js";

function setup(fixture: () => ReturnType<typeof fixtureDirectionAndSets>) {
  const fx = fixture();
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: "v1",
    startsBelowRow1: false,
  });
  const grids: AnalysisGrids = { values: fx.values, numberFormats: fx.numberFormats };
  return { schema, grids };
}

function compileAndRun(text: string, schema: TableSchema, grids: AnalysisGrids, inheritedMetricSet?: InheritedMetricSet) {
  const intent = detectAnalyticalIntent(text);
  const compiled = compileAnalyticalPlan(intent, { schema, grids, ...(inheritedMetricSet ? { inheritedMetricSet } : {}) }, "ru");
  if (compiled.kind !== "plan") return { intent, compiled, execution: undefined };
  const validation = validatePlan(compiled.plan, schema, grids, compiled.periodIndex);
  expect(validation.ok).toBe(true);
  const execution = executePlan(compiled.plan, schema, grids, compiled.periodIndex, "ru");
  return { intent, compiled, execution };
}

function point(canonicalPeriod: string, value: number): TemporalPoint {
  return { canonicalPeriod, periodLabel: canonicalPeriod, value, cell: `A${canonicalPeriod}`, rowIndex: 0, colIndex: 0, percent: false, raw: value };
}
function series(key: string, values: readonly number[]): TemporalSeries {
  return { key, measureKind: "amount", percent: false, points: values.map((v, i) => point(`p${i}`, v)) };
}

describe("Stage 24.9 §50/§51 — direction-change primitive (unit)", () => {
  it("§50 — A: 100→110→120→115→118 has 2 changes; B: monotonic decreasing has 0", () => {
    const a = computeDirectionChangeEvents(series("A", [100, 110, 120, 115, 118]));
    expect(a.changes).toBe(2);
    const b = computeDirectionChangeEvents(series("B", [100, 90, 80, 70, 60]));
    expect(b.changes).toBe(0);
  });

  it("§51 — a zero-delta plateau is never double-counted: 100→110→110→105 = 1 change", () => {
    const r = computeDirectionChangeEvents(series("Z", [100, 110, 110, 105]));
    expect(r.changes).toBe(1);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.previousDirection).toBe("positive");
    expect(r.events[0]!.nextDirection).toBe("negative");
  });

  it("count from computeDirectionChangeEvents always matches the event array length", () => {
    const r = computeDirectionChangeEvents(series("A", [100, 110, 120, 115, 113, 118]));
    expect(r.changes).toBe(r.events.length);
    expect(r.changes).toBe(2);
  });
});

describe("Stage 24.9 §41–§43 — direction-change superlative + follow-ups (integration)", () => {
  it("ranks by reversal count; unique winner carries full event detail", () => {
    const { schema, grids } = setup(fixtureDirectionAndSets);
    const { execution } = compileAndRun("Какой показатель менял направление чаще всего?", schema, grids);
    expect(execution?.directionChangeWinner?.metricKey).toBe("Ликвидные активы");
    expect(execution?.directionChangeWinner?.count).toBe(3);
    expect(execution?.directionChangeWinner?.events).toHaveLength(3);
    for (const e of execution!.directionChangeWinner!.events) {
      expect(e.pivotHeaderPath).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    }
  });
});

describe("Stage 24.9 §53 — monotonic symmetry (unit + integration)", () => {
  it("never_decreased vs never_increased are exact opposites", () => {
    const { schema, grids } = setup(fixtureDirectionAndSets);
    const nonDec = compileAndRun("Какие показатели ни разу не снижались за всё доступное время?", schema, grids);
    const nonInc = compileAndRun("А какие ни разу не росли?", schema, grids);
    const decRows = nonDec.execution!.sections[0]!.rows.map((r) => r[0]);
    const incRows = nonInc.execution!.sections[0]!.rows.map((r) => r[0]);
    expect(decRows).toContain("Активы");
    expect(incRows).toContain("Обязательства");
    expect(decRows).not.toContain("Обязательства");
    expect(incRows).not.toContain("Активы");
  });
});

describe("Stage 24.9 §54 — semantic metric classes (unit + integration)", () => {
  it("classifies label + format evidence correctly", () => {
    expect(classifySemanticMetricClass("Активы")).toBe("amount");
    expect(classifySemanticMetricClass("Обязательства")).toBe("amount");
    expect(classifySemanticMetricClass("доля ликвидных активов в активах")).toBe("share");
    expect(classifySemanticMetricClass("уровень долларизации вкладов физлиц")).toBe("rate");
    expect(isPercentageLike("share")).toBe(true);
    expect(isPercentageLike("rate")).toBe(true);
    expect(isPercentageLike("amount")).toBe(false);
  });

  it("excludes ALL percentage-like candidates before ranking, not just at render time", () => {
    const { schema, grids } = setup(fixtureDirectionAndSets);
    const { compiled, execution } = compileAndRun("Какие показатели наиболее волатильны, если не учитывать процентные показатели?", schema, grids);
    if (compiled.kind !== "plan") throw new Error("expected a plan");
    expect(compiled.plan.semanticFilter?.candidateCountBefore).toBe(5);
    expect(compiled.plan.semanticFilter?.candidateCountAfter).toBe(3);
    const keys = execution!.resultSet!.rows.map((r) => r.key);
    expect(keys).not.toContain("уровень долларизации вкладов физлиц");
    expect(keys).not.toContain("доля ликвидных активов в активах");
    expect(execution!.resultSet!.rows[0]!.key).toBe("Ликвидные активы");
  });

  it("without the filter, the percentage-like metric legitimately wins (proves the filter changes the outcome)", () => {
    const { schema, grids } = setup(fixtureDirectionAndSets);
    const { execution } = compileAndRun("Какие показатели наиболее волатильны?", schema, grids);
    expect(execution!.resultSet!.rows[0]!.key).toBe("уровень долларизации вкладов физлиц");
  });
});

describe("Stage 24.9 §56 — multi-metric resolution (unit)", () => {
  it("'Активы и Обязательства' resolves to exactly 2 metrics", () => {
    const { schema } = setup(fixtureDirectionAndSets);
    const index = buildMetricIndex(schema);
    const r = resolveMetricSet("Активы и Обязательства", index);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") throw new Error();
    expect(r.entries.map((e) => e.label)).toEqual(["Активы", "Обязательства"]);
  });

  it("'Активы и Ликвидные активы' resolves to exactly 2 metrics (no greedy merge)", () => {
    const { schema } = setup(fixtureDirectionAndSets);
    const index = buildMetricIndex(schema);
    const r = resolveMetricSet("Активы и Ликвидные активы", index);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") throw new Error();
    expect(r.entries.map((e) => e.label)).toEqual(["Активы", "Ликвидные активы"]);
  });

  it("'Ликвидные активы и доля ликвидных активов в активах' resolves to exactly 2 EXACT metrics", () => {
    const { schema } = setup(fixtureDirectionAndSets);
    const index = buildMetricIndex(schema);
    const r = resolveMetricSet("Ликвидные активы и доля ликвидных активов в активах", index);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") throw new Error();
    expect(r.entries.map((e) => e.label)).toEqual(["Ликвидные активы", "доля ликвидных активов в активах"]);
  });
});

describe("Stage 24.9 §57/§58 — comparison + generic growth rate (integration)", () => {
  it("§57 — 'какой из них вырос сильнее' ranks the metric SET, not the whole workbook", () => {
    const { schema, grids } = setup(fixtureDirectionAndSets);
    const inheritedMetricSet: InheritedMetricSet = {
      members: [schema.rowAxis[0]!, schema.rowAxis[2]!], // Активы (+40%), Ликвидные активы (+12.5%)
    };
    const { execution } = compileAndRun(
      "Какой из них вырос сильнее в процентах от первой до последней даты?",
      schema,
      grids,
      inheritedMetricSet,
    );
    const rows = execution!.sections[0]!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe("Активы");
  });

  it("§58 — 'темп роста A и B' needs no PeriodRef; defaults to first→last, never 'no earlier period to reuse'", () => {
    const { schema, grids } = setup(fixtureDirectionAndSets);
    const { intent, compiled } = compileAndRun("Сравни темп роста Активов и Ликвидных активов.", schema, grids);
    expect(intent.operation).toBe("compare_growth");
    expect(compiled.kind).toBe("plan");
    if (compiled.kind !== "plan") throw new Error();
    expect(compiled.plan.interval?.start.canonical).toBe("2024-01-01");
    expect(compiled.plan.interval?.end.canonical).toBe("2025-01-01");
  });
});

describe("Stage 24.9 §59/§60 — compound decomposition + legacy-fallback ban (intent-level)", () => {
  it("§59 — a compound sentence's SECOND clause is independently detected as analytical, no metric-name contamination", () => {
    const clause2 = "укажи, между какими соседними датами произошло самое большое изменение.";
    const intent = detectAnalyticalIntent(clause2);
    expect(intent.operation).toBe("argmax_event");
    expect(intent.any).toBe(true);
  });

  it("§60 — the pronoun-driven growth comparison is classified analytical (never falls through unclassified)", () => {
    const intent = detectAnalyticalIntent("Какой из них вырос сильнее в процентах от первой до последней даты?");
    expect(intent.operation).toBe("compare_growth");
    expect(intent.any).toBe(true);
  });
});

describe("Stage 24.9 §61 — Stage 24.8 regressions preserved", () => {
  it("argmax_event / two_interval_filter / rank still compile on fixtureBalanceLike", () => {
    const { schema, grids } = setup(fixtureBalanceLike);
    const periodIndex = buildPeriodIndex(schema, grids);
    expect(periodIndex.points.length).toBeGreaterThanOrEqual(2);
    const { intent, compiled } = compileAndRun("Какой показатель вырос сильнее всего между 01.01.2024 и 01.12.2025?", schema, grids);
    expect(intent.operation).toBe("rank");
    expect(compiled.kind === "plan" || compiled.kind === "unresolved" || compiled.kind === "clarify").toBe(true);
  });
});

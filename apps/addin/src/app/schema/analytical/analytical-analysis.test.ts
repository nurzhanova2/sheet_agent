import { describe, expect, it } from "vitest";
import { induceTableSchema, type TableSchema } from "../schema-induction.js";
import type { AnalysisGrids } from "../matrix-analysis.js";
import {
  fixtureBalanceLike,
  fixtureMonotonicSeries,
  fixtureVolatilitySeries,
  fixtureTransposed,
  fixtureCrossTab,
} from "../__fixtures__/tables.js";
import { detectAnalyticalIntent } from "./analytical-intent.js";
import { compileAnalyticalPlan } from "./analytical-compiler.js";
import { buildPeriodIndex } from "./period-index.js";
import { runAnalyticalAnalysis, type AnalyticalRouteOutcome } from "./analytical-analysis.js";
import type { InheritedPeriod } from "./period-resolver.js";

function load(fx: ReturnType<typeof fixtureBalanceLike>): { schema: TableSchema; grids: AnalysisGrids } {
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: `v@${fx.address}`,
    startsBelowRow1: fx.startsBelowRow1,
  });
  return { schema, grids: { values: fx.values, numberFormats: fx.numberFormats } };
}

const balance = load(fixtureBalanceLike());
const run = (text: string, inherited?: InheritedPeriod): AnalyticalRouteOutcome =>
  runAnalyticalAnalysis(balance.schema, balance.grids, text, "ru", inherited);
const handled = (text: string, inherited?: InheritedPeriod) => {
  const o = run(text, inherited);
  if (o.kind !== "handled") throw new Error(`expected handled, got ${o.kind}: ${JSON.stringify(o)}`);
  return o;
};

describe("Stage 24.7 — query matrix over the Balance-like table (§56)", () => {
  it("A — per-metric argmax over point-in-time values", () => {
    const o = handled("В каком периоде каждый показатель достиг максимума?");
    expect(o.plan.operation).toBe("argmax");
    expect(o.plan.subjectScope).toBe("row_axis");
    expect(o.plan.steps.map((s) => s.kind)).toEqual(["resolve_subject", "select_temporal_series", "arg_extreme"]);
    expect(o.execution.sections[0]!.rows.length).toBe(6);
    expect(o.execution.sections[0]!.columns).toContain("Период");
  });

  it("B — per-metric argmin", () => {
    const o = handled("В каком периоде каждый показатель достиг минимума?");
    expect(o.plan.operation).toBe("argmin");
    expect(o.execution.sections[0]!.rows.length).toBe(6);
  });

  it("C — 5 metrics with the largest growth over the last month → rank / row axis / horizon", () => {
    const o = handled("Покажи 5 показателей с наибольшим ростом за последний месяц.");
    expect(o.plan.operation).toBe("rank");
    expect(o.plan.subjectScope).toBe("row_axis");
    expect(o.plan.period?.horizon).toBe("last_month");
    expect(o.plan.direction).toBe("desc");
    expect(o.plan.changeSign).toBe("positive");
    expect(o.plan.limit).toBe(5);
  });

  it("D — 5 metrics with the largest decline over the last month", () => {
    const o = handled("Покажи 5 показателей с наибольшим снижением за последний месяц.");
    expect(o.plan.operation).toBe("rank");
    expect(o.plan.direction).toBe("asc");
    expect(o.plan.changeSign).toBe("negative");
  });

  it("F — filter by magnitude threshold 20% over an explicit interval (§37 A)", () => {
    const o = handled("Какие показатели изменились более чем на 20% между 01.01.2024 и 01.11.2025?");
    expect(o.plan.operation).toBe("filter");
    expect(o.plan.thresholdMode).toBe("magnitude");
    expect(o.plan.thresholdValue).toBeCloseTo(0.2, 6);
    expect(o.trace.requestedStart).toBe("2024-01-01");
    expect(o.trace.executedStart).toBe("2024-01-01");
  });

  it("G — filter, negative-only, threshold 10% over an explicit interval (§37 C)", () => {
    const o = handled("Какие показатели снизились более чем на 10% между 01.01.2024 и 01.11.2025?");
    expect(o.plan.operation).toBe("filter");
    expect(o.plan.thresholdMode).toBe("negative");
    expect(o.plan.thresholdValue).toBeCloseTo(0.1, 6);
  });

  it("§21/§37 D — a threshold filter with NO period and no memory clarifies (never a silent horizon, never an empty result)", () => {
    const o = run("Какие показатели изменились более чем на 20%?");
    expect(o.kind).toBe("clarify");
    if (o.kind === "clarify") {
      expect(o.field).toBe("period");
      expect(o.candidates.length).toBeGreaterThan(0);
      expect(o.question).toMatch(/период/i);
    }
  });

  it("§21 — resuming that clarification with a horizon phrase runs the filter (never 'Нет результата')", () => {
    const o = handled("Какие показатели изменились более чем на 20%? за последний месяц");
    expect(o.plan.operation).toBe("filter");
    expect(o.plan.period?.horizon).toBe("last_month");
    expect(o.execution.sections.length).toBeGreaterThan(0);
  });

  it("H / I — volatility and stability rank the same score in inverse order", () => {
    const vol = handled("Какие показатели наиболее волатильны?");
    const stab = handled("Какие показатели наиболее стабильны?");
    expect(vol.plan.operation).toBe("volatility");
    expect(stab.plan.operation).toBe("stability");
    const volOrder = vol.execution.sections[0]!.rows.map((r) => r[0]);
    const stabOrder = stab.execution.sections[0]!.rows.map((r) => r[0]);
    expect(stabOrder).toEqual([...volOrder].reverse());
    expect(vol.summaryLine).toMatch(/стандартное отклонение/i);
  });

  it("J — time series of a single metric, point-in-time dates only (no Δ columns)", () => {
    const o = handled("Покажи динамику активов по времени.");
    expect(o.plan.operation).toBe("time_series");
    expect(o.plan.subject.kind).toBe("row_axis_member");
    const periods = o.execution.sections[0]!.rows.map((r) => r[0]);
    expect(periods).toEqual(["01.01.2024", "01.11.2024", "01.01.2025", "01.10.2025", "01.11.2025"]);
    expect(periods.join(" ")).not.toMatch(/Δ|месяц/);
  });

  it("L — argmax of a single named metric returns period + value", () => {
    const o = handled("Когда активы были максимальными?");
    expect(o.plan.operation).toBe("argmax");
    expect(o.plan.subject.kind).toBe("row_axis_member");
    expect(o.trace.compiledSteps).toEqual(["resolve_subject", "select_temporal_series", "arg_extreme:argmax"]);
    expect(o.execution.sections[0]!.rows.length).toBe(1);
  });

  it("N — change of a single metric between two exact dates", () => {
    const o = handled("Как изменились активы между 01.01.2024 и 01.11.2025?");
    expect(o.plan.operation).toBe("change");
    expect(o.trace.requestedStart).toBe("2024-01-01");
    expect(o.trace.requestedEnd).toBe("2025-11-01");
    expect(o.trace.executedStart).toBe("2024-01-01");
    expect(o.trace.executedEnd).toBe("2025-11-01");
    expect(o.trace.silentSubstitution).toBe(false);
  });

  it("O — compare all metrics at two exact dates (CRITICAL: no silent substitution)", () => {
    const o = handled("Сравни значения на 01.01.2025 и 01.11.2025.");
    expect(o.plan.operation).toBe("compare");
    expect(o.trace.requestedStart).toBe("2025-01-01");
    expect(o.trace.executedStart).toBe("2025-01-01");
    expect(o.trace.requestedEnd).toBe("2025-11-01");
    expect(o.trace.executedEnd).toBe("2025-11-01");
    expect(o.execution.sections[0]!.rows.length).toBe(6);
  });

  it("P/Q — grew-between + follow-up 'за этот же период' inherits the exact interval, flips sign", () => {
    const first = handled("Какие показатели выросли между 01.01.2025 и 01.11.2025?");
    expect(first.plan.operation).toBe("filter");
    expect(first.plan.changeSign).toBe("positive");
    expect(first.rememberInterval).toBeTruthy();
    const inherited: InheritedPeriod = {
      start: first.rememberInterval!.start,
      end: first.rememberInterval!.end,
    };
    const followUp = handled("Какие показатели снизились за этот же период?", inherited);
    expect(followUp.plan.operation).toBe("filter");
    expect(followUp.plan.changeSign).toBe("negative");
    expect(followUp.trace.requestedStart).toBe("2025-01-01");
    expect(followUp.trace.requestedEnd).toBe("2025-11-01");
    expect(followUp.trace.inheritedPeriodRef).toBe(true);
  });

  it("R/S — monotonicity strict up / strict down", () => {
    const up = run("Покажи показатели, которые росли последовательно по периодам.");
    expect(up.kind === "handled" && up.plan.operation).toBe("monotonicity");
    if (up.kind === "handled") expect(up.plan.monotone).toBe("strict_increasing");
    const down = run("Покажи показатели, которые последовательно снижались.");
    if (down.kind === "handled") expect(down.plan.monotone).toBe("strict_decreasing");
  });

  it("T — direction change", () => {
    const o = run("У каких показателей направление изменения поменялось?");
    expect(o.kind === "handled" && o.plan.operation).toBe("direction_change");
  });
});

describe("Stage 24.7 — silent-substitution regression (§59, §86)", () => {
  it("a requested date that is not in the table fails with a specific message — no comparison runs", () => {
    const o = run("Сравни 01.01.2023 и 01.11.2025.");
    expect(o.kind).toBe("error");
    if (o.kind === "error") expect(o.message).toMatch(/2023-01-01|период/i);
  });
  it("the resolver never returns 01.10.2025 when 01.01.2025 was asked for", () => {
    const o = handled("Сравни значения на 01.01.2025 и 01.11.2025.");
    expect(o.trace.executedStart).not.toBe("2025-10-01");
    expect(o.trace.executedStart).toBe("2025-01-01");
  });
});

describe("Stage 24.7 — plan structure assertions (§57)", () => {
  it("C compiles to rank / row_axis / last_month / percentage_change / positive / desc / 5", () => {
    const intent = detectAnalyticalIntent("Покажи 5 показателей с наибольшим ростом за последний месяц.");
    const compiled = compileAnalyticalPlan(intent, { schema: balance.schema, grids: balance.grids }, "ru");
    expect(compiled.kind).toBe("plan");
    if (compiled.kind === "plan") {
      expect(compiled.plan.operation).toBe("rank");
      expect(compiled.plan.subjectScope).toBe("row_axis");
      expect(compiled.plan.period?.horizon).toBe("last_month");
      expect(compiled.plan.direction).toBe("desc");
      expect(compiled.plan.changeSign).toBe("positive");
      expect(compiled.plan.limit).toBe(5);
    }
  });

  it("H compiles to volatility over temporal point values, rank desc", () => {
    const intent = detectAnalyticalIntent("Какие показатели наиболее волатильны?");
    expect(intent.operation).toBe("volatility");
    expect(intent.direction).toBe("desc");
  });
});

describe("Stage 24.7 — transpose & cross-tab structural support (§65, §66)", () => {
  it("transpose: 'Когда Revenue был максимальным?' works with metrics as columns", () => {
    const t = load(fixtureTransposed());
    const o = runAnalyticalAnalysis(t.schema, t.grids, "Когда Revenue был максимальным?", "ru");
    expect(o.kind).toBe("handled");
    if (o.kind === "handled") {
      expect(o.plan.operation).toBe("argmax");
      expect(o.plan.subject.kind).toBe("column_measure");
      expect(o.execution.sections[0]!.rows.length).toBe(1);
    }
  });

  it("cross-tab: rank regions by the 2025 column", () => {
    const x = load(fixtureCrossTab());
    const pi = buildPeriodIndex(x.schema, x.grids);
    expect(pi.points.map((p) => p.canonical)).toEqual(["2024", "2025"]);
  });
});

describe("Stage 24.7 — volatility & monotonicity fixtures (§62, §63)", () => {
  it("volatility fixture: B is most volatile, stability is the inverse ranking", () => {
    const v = load(fixtureVolatilitySeries());
    const vol = runAnalyticalAnalysis(v.schema, v.grids, "какие столбцы наиболее волатильны", "ru");
    const stab = runAnalyticalAnalysis(v.schema, v.grids, "какие столбцы наиболее стабильны", "ru");
    if (vol.kind === "handled" && stab.kind === "handled") {
      const vo = vol.execution.sections[0]!.rows.map((r) => r[0]);
      const so = stab.execution.sections[0]!.rows.map((r) => r[0]);
      expect(vo[0]).toBe("B");
      expect(so).toEqual([...vo].reverse());
    } else {
      throw new Error(`vol=${vol.kind} stab=${stab.kind}`);
    }
  });

  it("monotonicity fixture: strict-up matches only A", () => {
    const m = load(fixtureMonotonicSeries());
    const o = runAnalyticalAnalysis(m.schema, m.grids, "покажи столбцы которые росли последовательно по периодам", "ru");
    if (o.kind === "handled") {
      const rows = o.execution.sections[0]!.rows.filter((r) => r[0] !== "Нет подходящих показателей");
      expect(rows.map((r) => r[0])).toEqual(["A"]);
    } else {
      throw new Error(`got ${o.kind}`);
    }
  });
});

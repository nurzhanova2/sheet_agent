// Stage 24.7.1 — regression tests for the 5 production fixes (§39–§45, §60):
//   1. typed resolver namespaces (metric vs period)
//   2. structured span extraction (subject not truncated by an interval)
//   3. all-metrics compare (shared comparison primitive)
//   4. threshold filter execution (explicit interval, horizon, and the
//      no-period clarification safety policy)
//   5. percentage-change preference for cross-metric ranking
import { describe, expect, it } from "vitest";
import { induceTableSchema, type TableSchema } from "../schema-induction.js";
import type { AnalysisGrids } from "../matrix-analysis.js";
import {
  fixtureBalanceLike,
  fixtureKnownPercentChanges,
  fixtureMetricPrecedence,
  fixtureRankBasisDivergence,
} from "../__fixtures__/tables.js";
import { detectAnalyticalIntent } from "./analytical-intent.js";
import { buildMetricIndex, resolveMetric } from "./metric-resolver.js";
import { buildPeriodIndex } from "./period-index.js";
import { resolvePeriod } from "./period-resolver.js";
import { runAnalyticalAnalysis, type AnalyticalRouteOutcome } from "./analytical-analysis.js";

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

function handled(text: string): Extract<AnalyticalRouteOutcome, { kind: "handled" }> {
  const o = runAnalyticalAnalysis(balance.schema, balance.grids, text, "ru");
  if (o.kind !== "handled") throw new Error(`expected handled, got ${o.kind}: ${JSON.stringify(o)}`);
  return o;
}

describe("Fix #1 — typed resolver namespaces (§4–§8, §39)", () => {
  it("MetricIndex for a row_metrics table contains ONLY row-axis members — zero periods / horizons / variants", () => {
    const mi = buildMetricIndex(balance.schema);
    expect(mi.entries.length).toBeGreaterThan(0);
    for (const e of mi.entries) {
      expect(e.kind).toBe("row_member");
      expect(e.label).not.toMatch(/^\d{2}\.\d{2}\.\d{4}$/); // no dates
      expect(e.label).not.toMatch(/Δ|абс\.|%$/); // no horizons / variants
    }
  });

  it('resolveMetric("активов") never returns a period candidate', () => {
    const mi = buildMetricIndex(balance.schema);
    const r = resolveMetric("активов", mi);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entry.label).toBe("Активы");
    if (r.kind === "ambiguous") {
      for (const c of r.candidates) expect(c).not.toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    }
  });

  it('resolvePeriod("01.01.2025") never returns a metric candidate', () => {
    const pi = buildPeriodIndex(balance.schema, balance.grids);
    const r = resolvePeriod("01.01.2025", pi);
    expect(r.kind).toBe("point");
    if (r.kind === "ambiguous") {
      for (const c of r.candidates) expect(c).not.toMatch(/[А-Яа-яё]/);
    }
  });

  it("a multi-word genitive metric phrase resolves via phrase-stem, not via period pollution", () => {
    const o = handled("Покажи динамику ликвидных активов по времени.");
    expect(o.plan.subject.kind).toBe("row_axis_member");
    expect(o.execution.sections[0]!.title).toContain("Ликвидные активы");
  });
});

describe("Fix #2 — structured span extraction (§9–§13, §40)", () => {
  it('"Как изменились активы между 01.01.2024 и 01.12.2025?" — subject is exactly "активы", not truncated at a date', () => {
    const intent = detectAnalyticalIntent("Как изменились активы между 01.01.2024 и 01.12.2025?");
    expect(intent.subjectText).toBe("активы");
    expect(intent.periodStartText).toBe("01.01.2024");
    expect(intent.periodEndText).toBe("01.12.2025");
  });

  it('"Какие показатели снизились более чем на 10% между 01.01.2025 и 01.12.2025?" — threshold, sign and interval all parse independently', () => {
    const intent = detectAnalyticalIntent("Какие показатели снизились более чем на 10% между 01.01.2025 и 01.12.2025?");
    expect(intent.thresholdText).toMatch(/10/);
    expect(intent.periodStartText).toBe("01.01.2025");
    expect(intent.periodEndText).toBe("01.12.2025");
  });

  it("the fix is end-to-end: 'change' resolves to a real single-row result, not an error", () => {
    const o = handled("Как изменились активы между 01.01.2024 и 01.11.2025?");
    expect(o.plan.operation).toBe("change");
    expect(o.execution.sections[0]!.rows.length).toBe(1);
  });
});

describe("Fix #3 — all-metrics compare via the shared comparison primitive (§14–§17, §34, §43)", () => {
  it("compare returns a non-empty row per compatible metric with exact endpoint audit", () => {
    const o = handled("Сравни значения на 01.01.2025 и 01.11.2025.");
    expect(o.plan.operation).toBe("compare");
    expect(o.execution.sections[0]!.rows.length).toBeGreaterThan(0);
    expect(o.trace.requestedStart).toBe(o.trace.executedStart);
    expect(o.trace.requestedEnd).toBe(o.trace.executedEnd);
  });

  it("known percent changes: compare shows the exact values for all 4 metrics", () => {
    const kp = load(fixtureKnownPercentChanges());
    const o = runAnalyticalAnalysis(kp.schema, kp.grids, "Сравни значения на 01.01.2025 и 01.05.2025.", "ru");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    const rows = o.execution.sections[0]!.rows;
    expect(rows.length).toBe(4);
    const byKey = Object.fromEntries(rows.map((r) => [r[0], r]));
    expect(byKey.A![4]).toBe("30%");
    expect(byKey.B![4]).toBe("10%");
    expect(byKey.C![4]).toBe("-25%");
    expect(byKey.D![4]).toBe("-5%");
  });
});

describe("Fix #4 — threshold filter execution (§18–§23, §37, §44)", () => {
  const kp = load(fixtureKnownPercentChanges());
  const run = (text: string): AnalyticalRouteOutcome => runAnalyticalAnalysis(kp.schema, kp.grids, text, "ru");

  it("A — magnitude > 20% over an explicit interval matches A (+30%) and C (-25%)", () => {
    const o = run("Какие показатели изменились более чем на 20% между 01.01.2025 и 01.05.2025?");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    const keys = o.execution.sections[0]!.rows.map((r) => r[0]).sort();
    expect(keys).toEqual(["A", "C"]);
  });

  it("B — grew more than 20% matches only A", () => {
    const o = run("Какие показатели выросли более чем на 20% между 01.01.2025 и 01.05.2025?");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    expect(o.execution.sections[0]!.rows.map((r) => r[0])).toEqual(["A"]);
  });

  it("C — declined more than 10% matches only C (-25%), not D (-5%)", () => {
    const o = run("Какие показатели снизились более чем на 10% между 01.01.2025 и 01.05.2025?");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    expect(o.execution.sections[0]!.rows.map((r) => r[0])).toEqual(["C"]);
  });

  it("D — no period and no memory → ONE clarification, never an empty 'no result'", () => {
    const o = run("Какие показатели изменились более чем на 20%?");
    expect(o.kind).toBe("clarify");
  });

  it("E — resuming with a horizon phrase runs the filter over the active PeriodRef / horizon", () => {
    const o = handled("Какие показатели изменились более чем на 20%? за последний месяц");
    expect(o.plan.operation).toBe("filter");
    expect(o.plan.period?.horizon).toBe("last_month");
  });
});

describe("Fix #5 — percentage-change preference for cross-metric ranking (§24–§29, §45)", () => {
  const rk = load(fixtureRankBasisDivergence());

  it("B (abs +50 / pct +10%) outranks A (abs +100 / pct +1%) by default — percent wins", () => {
    const o = runAnalyticalAnalysis(rk.schema, rk.grids, "Покажи 2 показателя с наибольшим ростом за последний месяц.", "ru");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    expect(o.plan.measureBasis).toBe("percentage_change");
    const order = o.execution.sections[0]!.rows.map((r) => r[0]);
    expect(order[0]).toBe("B");
  });

  it("an explicit 'по абсолютному изменению' override ranks A first", () => {
    const o = runAnalyticalAnalysis(rk.schema, rk.grids, "Покажи 2 показателя с наибольшим ростом за последний месяц по абсолютному изменению.", "ru");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    expect(o.plan.measureBasis).toBe("absolute_change");
    const order = o.execution.sections[0]!.rows.map((r) => r[0]);
    expect(order[0]).toBe("A");
  });

  it("the rendered heading discloses the basis actually used (§28/§29 — no false semantics)", () => {
    const o = runAnalyticalAnalysis(rk.schema, rk.grids, "Покажи 2 показателя с наибольшим ростом за последний месяц.", "ru");
    if (o.kind === "handled") expect(o.execution.sections[0]!.title).toMatch(/% изменение/);
  });
});

describe("Fix #6 — metric resolution precedence, final correction", () => {
  const mp = load(fixtureMetricPrecedence());
  const idx = buildMetricIndex(mp.schema);

  it("a longer label containing the needle's words never outranks an exact / morphologically exact shorter metric", () => {
    expect(resolveMetric("активы", idx)).toMatchObject({ kind: "resolved", entry: { label: "Активы" } });
    expect(resolveMetric("активов", idx)).toMatchObject({ kind: "resolved", entry: { label: "Активы" } });
    expect(resolveMetric("ликвидные активы", idx)).toMatchObject({ kind: "resolved", entry: { label: "Ликвидные активы" } });
    expect(resolveMetric("ликвидных активов", idx)).toMatchObject({ kind: "resolved", entry: { label: "Ликвидные активы" } });
  });

  it("a genuinely compound phrase still resolves to the longer label via the whole-token-sequence tier", () => {
    const r = resolveMetric("доля ликвидных активов", idx);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.entry.label).toBe("доля ликвидных активов в активах");
  });

  it("the full inflected phrase resolves to the compound label itself, not a shorter metric (§19 — does not over-prefer short labels)", () => {
    const r1 = resolveMetric("доля ликвидных активов в активах", idx);
    expect(r1.kind).toBe("resolved");
    if (r1.kind === "resolved") expect(r1.entry.label).toBe("доля ликвидных активов в активах");
    const r2 = resolveMetric("доли ликвидных активов в активах", idx); // genitive "доли"
    expect(r2.kind).toBe("resolved");
    if (r2.kind === "resolved") expect(r2.entry.label).toBe("доля ликвидных активов в активах");
  });

  it("synthetic English equivalents resolve by the same precedence (Revenue / Net Revenue / Revenue Share)", () => {
    expect(resolveMetric("revenue", idx)).toMatchObject({ kind: "resolved", entry: { label: "Revenue" } });
    expect(resolveMetric("net revenue", idx)).toMatchObject({ kind: "resolved", entry: { label: "Net Revenue" } });
    expect(resolveMetric("revenue share", idx)).toMatchObject({ kind: "resolved", entry: { label: "Revenue Share" } });
  });

  it("integration — 'Покажи динамику активов по времени.' resolves to Активы with the exact known time series", () => {
    const o = runAnalyticalAnalysis(mp.schema, mp.grids, "Покажи динамику активов по времени.", "ru");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    expect(o.plan.subject).toMatchObject({ kind: "row_axis_member", member: { display: "Активы" } });
    const values = o.execution.sections[0]!.rows.map((r) => r[1]);
    expect(values).toEqual([14943.2642, 17394.2726, 17941.7418, 19764.2831, 19871.5449]);
  });

  it("integration — 'Покажи динамику ликвидных активов по времени.' resolves to Ликвидные активы with the exact known time series", () => {
    const o = runAnalyticalAnalysis(mp.schema, mp.grids, "Покажи динамику ликвидных активов по времени.", "ru");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    expect(o.plan.subject).toMatchObject({ kind: "row_axis_member", member: { display: "Ликвидные активы" } });
    const values = o.execution.sections[0]!.rows.map((r) => r[1]);
    expect(values).toEqual([4765.723, 5495.0094, 5573.5638, 6029.0632, 6044.5546]);
  });

  it("integration (§19/§31C) — 'Покажи динамику доли ликвидных активов в активах.' resolves to the compound label, not a shorter metric", () => {
    const o = runAnalyticalAnalysis(mp.schema, mp.grids, "Покажи динамику доли ликвидных активов в активах.", "ru");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    expect(o.plan.subject).toMatchObject({ kind: "row_axis_member", member: { display: "доля ликвидных активов в активах" } });
    expect(o.execution.sections[0]!.title).toBe("Динамика: доля ликвидных активов в активах");
    const values = o.execution.sections[0]!.rows.map((r) => r[1]);
    expect(values).toEqual(["31.89%", "31.59%", "31.06%", "30.5%", "30.42%"]);
  });

  it("integration (§31D) — 'Когда активы были максимальными?' resolves to Активы", () => {
    const o = runAnalyticalAnalysis(mp.schema, mp.grids, "Когда активы были максимальными?", "ru");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    expect(o.plan.subject).toMatchObject({ kind: "row_axis_member", member: { display: "Активы" } });
  });

  it("integration (§31E) — 'Когда ликвидные активы были минимальными?' resolves to Ликвидные активы", () => {
    const o = runAnalyticalAnalysis(mp.schema, mp.grids, "Когда ликвидные активы были минимальными?", "ru");
    expect(o.kind).toBe("handled");
    if (o.kind !== "handled") return;
    expect(o.plan.subject).toMatchObject({ kind: "row_axis_member", member: { display: "Ликвидные активы" } });
  });

  it("§20/§21 — different surrounding verbs do not change metric identity", () => {
    for (const text of ["Покажи динамику активов по времени.", "Когда активы были максимальными?"]) {
      const o = runAnalyticalAnalysis(mp.schema, mp.grids, text, "ru");
      expect(o.kind).toBe("handled");
      if (o.kind === "handled") expect(o.plan.subject).toMatchObject({ kind: "row_axis_member", member: { display: "Активы" } });
    }
    for (const text of ["Покажи динамику ликвидных активов по времени.", "Когда ликвидные активы были минимальными?"]) {
      const o = runAnalyticalAnalysis(mp.schema, mp.grids, text, "ru");
      expect(o.kind).toBe("handled");
      if (o.kind === "handled") expect(o.plan.subject).toMatchObject({ kind: "row_axis_member", member: { display: "Ликвидные активы" } });
    }
  });
});

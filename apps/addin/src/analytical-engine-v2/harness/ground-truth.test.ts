// @vitest-environment node
// ---------------------------------------------------------------------------
// Stage 26.8 §28/§29/§63 — deterministic ground truth for the smoke tables.
//
// The production smoke goes through `submit()`, so what comes back is an ANSWER
// in prose plus a trace — not the structured analysis the Stage 26.7 harness
// could judge directly. Numeric and reference correctness still have to be
// checked against something, and that something must not be the engine's own
// output.
//
// So: the same deterministic primitives the tools are built on, run over the
// same fixtures, printed as the facts each smoke question has an answer in.
// Nothing here calls a V2 tool or the planner.
//
//   SHEET_AGENT_GROUND_TRUTH_OUT=<file.json> npx vitest run \
//     src/analytical-engine-v2/harness/ground-truth.test.ts
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { induceTableSchema, type TableSchema } from "../../app/schema/schema-induction.js";
import { buildPeriodIndex } from "../../app/schema/analytical/period-index.js";
import { getTemporalSeries } from "../../app/schema/analytical/temporal-series.js";
import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import { fixtureBalanceLike, type FixtureSnapshot } from "../../app/schema/__fixtures__/tables.js";
import { unseenOperations } from "../../app/schema/__fixtures__/manual-tables.js";

const out = process.env["SHEET_AGENT_GROUND_TRUTH_OUT"];

interface MetricFacts {
  readonly metric: string;
  readonly values: readonly (number | null)[];
  readonly first: number | null;
  readonly last: number | null;
  readonly absoluteChange: number | null;
  readonly percentageChange: number | null;
  readonly lastStepPercent: number | null;
  readonly min: { readonly period: string; readonly value: number } | null;
  readonly max: { readonly period: string; readonly value: number } | null;
  readonly stdev: number | null;
  readonly coefficientOfVariation: number | null;
  readonly directionChanges: number;
  readonly consecutiveFalls: number;
}

function facts(sheet: FixtureSnapshot): { readonly periods: readonly string[]; readonly metrics: readonly MetricFacts[] } {
  const schema: TableSchema = induceTableSchema({
    values: sheet.values,
    numberFormats: sheet.numberFormats,
    formulas: sheet.formulas,
    sheetName: sheet.sheetName,
    sourceRange: sheet.address,
    sourceVersion: "v1",
    startsBelowRow1: sheet.startsBelowRow1,
  });
  const grids: AnalysisGrids = { values: sheet.values, numberFormats: sheet.numberFormats };
  const index = buildPeriodIndex(schema, grids);
  const points = [...index.points].sort((a, b) => a.orderKey - b.orderKey);
  const metrics = schema.rowAxis.map((member) => {
    const series = getTemporalSeries(schema, grids, { kind: "row_axis_member", member }, index);
    const byPeriod = new Map((series?.points ?? []).map((p) => [p.canonicalPeriod, p.value]));
    const values = points.map((p) => byPeriod.get(p.canonical) ?? null);
    const present = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => typeof x.v === "number");
    const first = present[0]?.v ?? null;
    const last = present[present.length - 1]?.v ?? null;
    const abs = first !== null && last !== null ? last - first : null;
    const pct = first !== null && last !== null && first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null;
    const prev = present[present.length - 2]?.v ?? null;
    const lastStep = prev !== null && last !== null && prev !== 0 ? ((last - prev) / Math.abs(prev)) * 100 : null;
    const nums = present.map((x) => x.v);
    const mean = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    const variance = mean !== null && nums.length > 1 ? nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1) : null;
    const stdev = variance !== null ? Math.sqrt(variance) : null;
    let directionChanges = 0;
    let falls = 0;
    let maxFalls = 0;
    for (let i = 1; i < present.length; i += 1) {
      const d = present[i]!.v - present[i - 1]!.v;
      if (i > 1) {
        const p = present[i - 1]!.v - present[i - 2]!.v;
        if (d !== 0 && p !== 0 && Math.sign(d) !== Math.sign(p)) directionChanges += 1;
      }
      if (d < 0) {
        falls += 1;
        maxFalls = Math.max(maxFalls, falls);
      } else falls = 0;
    }
    const lo = present.reduce((b, x) => (b === null || x.v < b.v ? x : b), null as { v: number; i: number } | null);
    const hi = present.reduce((b, x) => (b === null || x.v > b.v ? x : b), null as { v: number; i: number } | null);
    return {
      metric: member.display,
      values,
      first,
      last,
      absoluteChange: abs,
      percentageChange: pct === null ? null : Number(pct.toFixed(4)),
      lastStepPercent: lastStep === null ? null : Number(lastStep.toFixed(4)),
      min: lo ? { period: points[lo.i]!.canonical, value: lo.v } : null,
      max: hi ? { period: points[hi.i]!.canonical, value: hi.v } : null,
      stdev: stdev === null ? null : Number(stdev.toPrecision(6)),
      coefficientOfVariation: stdev !== null && mean !== null && mean !== 0 ? Number(((stdev / Math.abs(mean)) * 100).toFixed(4)) : null,
      directionChanges,
      consecutiveFalls: maxFalls,
    };
  });
  return { periods: points.map((p) => p.canonical), metrics };
}

const argmax = <T>(xs: readonly T[], f: (x: T) => number | null): T | null =>
  xs.reduce((b, x) => (f(x) === null ? b : b === null || (f(x) as number) > (f(b) as number) ? x : b), null as T | null);

describe("Stage 26.8 §63 — ground truth for the smoke tables", () => {
  const tables = { balance: facts(fixtureBalanceLike()), operations: facts(unseenOperations()) };

  it("both tables yield periods and metrics", () => {
    for (const [name, t] of Object.entries(tables)) {
      expect(t.periods.length, name).toBeGreaterThanOrEqual(4);
      expect(t.metrics.length, name).toBeGreaterThanOrEqual(3);
    }
  });

  it.runIf(Boolean(out))("writes the facts", () => {
    const summary = Object.fromEntries(
      Object.entries(tables).map(([name, t]) => [
        name,
        {
          periods: t.periods,
          biggestMoverByPercentMagnitude: argmax(t.metrics, (m) => (m.percentageChange === null ? null : Math.abs(m.percentageChange)))?.metric ?? null,
          biggestRiseByPercent: argmax(t.metrics, (m) => m.percentageChange)?.metric ?? null,
          biggestFallByPercent: argmax(t.metrics, (m) => (m.percentageChange === null ? null : -m.percentageChange))?.metric ?? null,
          biggestLastStepByPercentMagnitude: argmax(t.metrics, (m) => (m.lastStepPercent === null ? null : Math.abs(m.lastStepPercent)))?.metric ?? null,
          mostVolatileByCv: argmax(t.metrics, (m) => m.coefficientOfVariation)?.metric ?? null,
          mostStableByCv: argmax(t.metrics, (m) => (m.coefficientOfVariation === null ? null : -m.coefficientOfVariation))?.metric ?? null,
          fellTwiceRunning: t.metrics.filter((m) => m.consecutiveFalls >= 2).map((m) => m.metric),
          changedDirection: t.metrics.filter((m) => m.directionChanges > 0).map((m) => m.metric),
          metrics: t.metrics,
        },
      ]),
    );
    writeFileSync(out!, JSON.stringify(summary, null, 1), "utf8");
    expect(Object.keys(summary)).toHaveLength(2);
  });
});

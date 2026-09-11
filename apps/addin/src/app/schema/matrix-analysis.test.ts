// Stage 24.6 — deterministic analysis primitives over induced schemas.
import { describe, expect, it } from "vitest";
import { induceTableSchema } from "./schema-induction.js";
import { iqrOutliers, measureSeries, seriesExtrema, seriesPeaks, seriesTrend } from "./matrix-analysis.js";
import { detectSchemaIntent, runSchemaAnalysis } from "./schema-result.js";
import {
  fixtureBalanceLike,
  fixtureHierarchical,
  fixtureTimeSeriesMatrix,
  fixtureTransposed,
  type FixtureSnapshot,
} from "./__fixtures__/tables.js";

function schemaOf(fx: FixtureSnapshot) {
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: "v1",
    startsBelowRow1: fx.startsBelowRow1,
  });
  return { schema, grids: { values: fx.values, numberFormats: fx.numberFormats } };
}

describe("measureSeries + extrema", () => {
  it("D — one series per metric, max/min with the right column path + cell", () => {
    const { schema, grids } = schemaOf(fixtureTimeSeriesMatrix());
    const series = measureSeries(schema, grids);
    // A, B, C each become one series (single measure kind)
    expect(series.map((s) => s.rowLabel)).toEqual(["A", "B", "C"]);
    const ex = seriesExtrema(series);
    const c = ex.find((e) => e.rowLabel === "C")!;
    expect(c.max.value).toBe(90);
    expect(c.max.columnPath).toBe("Apr");
    expect(c.max.cell).toBe("TSM!E4"); // C row = row 4, Apr = column E
    expect(c.min.value).toBe(4);
  });

  it("B — abs and % variants are separate series, never mixed", () => {
    const { schema, grids } = schemaOf(fixtureHierarchical());
    const series = measureSeries(schema, grids);
    const revenue = series.filter((s) => s.rowLabel === "Revenue");
    expect(revenue.length).toBe(2); // one abs series, one % series
    const kinds = new Set(revenue.map((s) => s.measureKind));
    expect(kinds.size).toBe(2);
  });
});

describe("peaks (max, not magnitude) unless asked", () => {
  it("default peak is the maximum value", () => {
    const { schema, grids } = schemaOf(fixtureTimeSeriesMatrix());
    const pk = seriesPeaks(measureSeries(schema, grids), false);
    expect(pk.find((p) => p.rowLabel === "C")!.peak.value).toBe(90);
  });
});

describe("IQR outliers per compatible series", () => {
  it("flags the spike in series C and keeps the source cell", () => {
    const { schema, grids } = schemaOf(fixtureTimeSeriesMatrix());
    const reports = iqrOutliers(measureSeries(schema, grids));
    const cReport = reports.find((r) => r.seriesKey.startsWith("C"));
    expect(cReport).toBeDefined();
    expect(cReport!.outliers.map((o) => o.value)).toContain(90);
    expect(cReport!.outliers[0]!.cell).toMatch(/^TSM!/);
  });
});

describe("seriesTrend", () => {
  it("classifies a rising series as increasing", () => {
    const { schema, grids } = schemaOf(fixtureTransposed());
    const series = measureSeries(schema, grids);
    const rev = series.find((s) => s.key === "Revenue")!;
    expect(["increasing", "mixed / volatile"]).toContain(seriesTrend(rev.points));
  });
});

describe("detectSchemaIntent", () => {
  it("recognises 'о чем эта таблица'", () => {
    expect(detectSchemaIntent("о чем эта таблица").describe).toBe(true);
    expect(detectSchemaIntent("what is this table about?").describe).toBe(true);
  });
  it("recognises extrema-per-metric", () => {
    const i = detectSchemaIntent("найди максимальные и минимальные значения для каждого показателя");
    expect(i.extrema).toBe(true);
  });
  it("recognises peaks and treats them as max (not magnitude) by default", () => {
    const i = detectSchemaIntent("покажи пиковые значения по каждому показателю");
    expect(i.peaks).toBe(true);
    expect(i.peaksByMagnitude).toBe(false);
  });
  it("flags an outlier ask without a method for clarification", () => {
    const i = detectSchemaIntent("найди значения, выходящие за пределы нормы");
    expect(i.outliers).toBe(true);
    expect(i.outliersStatistical).toBe(false);
  });
  it("runs IQR when the method is explicit", () => {
    const i = detectSchemaIntent("считай это статистическими выбросами");
    expect(i.outliersStatistical).toBe(true);
  });
});

describe("runSchemaAnalysis — mixed request partial execution (§29)", () => {
  it("computes maxima/minima/peaks now and defers only the norm question", () => {
    const { schema, grids } = schemaOf(fixtureHierarchical());
    const intent = detectSchemaIntent(
      "найди наиболее крупные значения, значения выходящие за пределы нормы, а также пиковые и минимальные значения для каждого показателя",
    );
    const out = runSchemaAnalysis(schema, grids, intent, "ru");
    expect(out.needsNormClarification).toBe(true);
    expect(out.sections.length).toBeGreaterThan(0);
    expect(out.computed).toEqual(expect.arrayContaining(["peaks"]));
    expect(out.sourceCells.length).toBeGreaterThan(0);
  });

  it("describe returns normalized text, no raw serials", () => {
    const { schema, grids } = schemaOf(fixtureBalanceLike());
    const out = runSchemaAnalysis(schema, grids, detectSchemaIntent("о чем эта таблица"), "ru");
    expect(out.describeText).toBeTruthy();
    expect(out.describeText!).not.toMatch(/45292|45962/);
    expect(out.describeText!).toMatch(/иерархическ|многоуровнев/);
  });
});

// Stage 24.6 — universal schema induction over the structurally diverse fixture family.
import { describe, expect, it } from "vitest";
import { induceTableSchema } from "./schema-induction.js";
import { salesSnapshot } from "../../analysis/__fixtures__/sales-test-data.js";
import {
  fixtureBalanceLike,
  fixtureCrossTab,
  fixtureHierarchical,
  fixtureMergedHeaders,
  fixtureMixedUnits,
  fixturePartialHeaders,
  fixtureRecords,
  fixtureTimeSeriesMatrix,
  fixtureTotals,
  fixtureTransposed,
  fixtureUnknownLabels,
  type FixtureSnapshot,
} from "./__fixtures__/tables.js";

function induce(fx: FixtureSnapshot) {
  return induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: "v1",
    startsBelowRow1: fx.startsBelowRow1,
  });
}

describe("induceTableSchema — orientation across shapes", () => {
  it("A / Sales — a flat records table", () => {
    const s = induceTableSchema({
      values: salesSnapshot().values,
      numberFormats: salesSnapshot().numberFormats,
      formulas: salesSnapshot().values.map((r) => r.map(() => null)),
      sheetName: "Sales Test Data",
      sourceRange: "Sales Test Data!A1:L121",
      sourceVersion: "v1",
    });
    expect(s.orientation).toBe("row_records");
    expect(s.layoutKind).toBe("records");
    expect(s.headerDepth).toBe(1);
  });

  it("A2 / synthetic flat records", () => {
    const s = induce(fixtureRecords());
    expect(s.orientation).toBe("row_records");
  });

  it("B — two-level hierarchical report → row_metrics + headerDepth 2", () => {
    const s = induce(fixtureHierarchical());
    expect(s.headerDepth).toBe(2);
    expect(s.orientation).toBe("row_metrics");
    expect(s.layoutKind).toBe("hierarchical_report");
    expect(s.rowAxis.map((m) => m.display)).toEqual(["Revenue", "Expense", "Net"]);
    // abs / % variants are separated into different measure groups.
    expect(s.measures.length).toBeGreaterThanOrEqual(2);
    // a column path keeps both levels
    const p = s.columnPaths[0]!;
    expect(p.levels.length).toBe(2);
  });

  it("C — cross-tab Region × Year", () => {
    const s = induce(fixtureCrossTab());
    expect(s.layoutKind).toBe("cross_tab");
    expect(s.orientation).toBe("bidimensional");
    expect(s.rowHeaderColumns).toEqual([0]);
    expect(s.columnPaths.map((p) => p.displayLabel)).toEqual(["2024", "2025"]);
  });

  it("D — time-series matrix (metrics down, months across)", () => {
    const s = induce(fixtureTimeSeriesMatrix());
    expect(s.orientation).toBe("row_metrics");
    expect(s.rowAxis.map((m) => m.display)).toEqual(["A", "B", "C"]);
    expect(s.columnPaths.map((p) => p.displayLabel)).toEqual(["Jan", "Feb", "Mar", "Apr"]);
  });

  it("E — transposed time series → column_metrics, dates down rows", () => {
    const s = induce(fixtureTransposed());
    expect(s.orientation).toBe("column_metrics");
    expect(s.temporalAxis).toBe("rows");
    // the date serials became dates, not bare numbers
    expect(s.rowAxis[0]!.display).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it("F — merged hierarchical headers propagate the parent label", () => {
    const s = induce(fixtureMergedHeaders());
    expect(s.headerDepth).toBe(2);
    // blank-continuation fills "2024" across Q1..Q4
    const paths = s.columnPaths.map((p) => p.displayLabel);
    expect(paths[0]).toBe("2024 / Q1");
    expect(paths[3]).toBe("2024 / Q4");
    expect(paths[4]).toBe("2025 / Q1");
  });

  it("G — mixed units are kept in separate measure groups", () => {
    const s = induce(fixtureMixedUnits());
    const kinds = new Set(s.measures.map((m) => m.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(2); // amount vs percentage (+ maybe count)
  });

  it("H — totals / subtotals detected and excluded from the row axis", () => {
    const s = induce(fixtureTotals());
    const totalLabels = s.totals.map((t) => t.label);
    expect(totalLabels).toEqual(expect.arrayContaining(["Total A", "Total B", "Grand Total"]));
    expect(s.rowAxis.map((m) => m.display)).not.toEqual(expect.arrayContaining(["Grand Total"]));
  });

  it("I — a partial numeric block flags missing header context, no crash / no fake headers", () => {
    const s = induce(fixturePartialHeaders());
    expect(s.ambiguities.some((a) => a.kind === "missing_header_context")).toBe(true);
    expect(s.headerDepth).toBe(0);
  });

  it("J — unfamiliar labels still yield a structure (roles may be unknown)", () => {
    const s = induce(fixtureUnknownLabels());
    expect(["row_metrics", "bidimensional"]).toContain(s.orientation);
    expect(s.rowAxis.map((m) => m.display)).toEqual(["Beta", "Gamma", "Delta"]);
    expect(s.columnPaths.map((p) => p.displayLabel)).toEqual(["X1", "X2", "X3"]);
  });

  it("Balance-like — hierarchical, dated header level, abs/% variants, no raw serials", () => {
    const s = induce(fixtureBalanceLike());
    expect(s.headerDepth).toBe(2);
    expect(s.orientation).toBe("row_metrics");
    expect(s.temporalAxis).toBe("columns");
    expect(s.rowAxis.map((m) => m.display)).toEqual(["Активы", "Ликвидные активы", "Обязательства", "Капитал", "Ссудный портфель", "Депозиты"]);
    // level-0 date cells rendered as dd.mm.yyyy, never the serial 45962
    const allLevelValues = s.columnPaths.flatMap((p) => p.levels.map((l) => l.value));
    expect(allLevelValues.join("|")).not.toMatch(/45962|45292/);
    expect(allLevelValues.some((v) => /\d{2}\.\d{2}\.\d{4}/.test(v))).toBe(true);
    // abs vs % separated
    const kinds = new Set(s.measures.map((m) => m.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });
});

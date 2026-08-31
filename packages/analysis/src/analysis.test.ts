import { describe, expect, it } from "vitest";
import { analyzeMatrix, analyzeFormulas, type AnalysisMatrix } from "./index.js";

const dataset: AnalysisMatrix = {
  range: "Sales!A1:C6",
  headers: ["Date", "Revenue", "Region"],
  rows: [
    ["2026-01-01", "1 000,5", "KZ"], ["2026-01-02", "1200.5", "KZ"],
    ["2026-01-03", null, "RU"], ["2026-01-04", "bad", "KZ"],
    ["2026-01-05", "1400.5", "RU"],
  ],
};

describe("deterministic analysis", () => {
  it("infers localized types and computes stable descriptive statistics", () => {
    const report = analyzeMatrix(dataset);
    expect(report.columns).toEqual([
      expect.objectContaining({ name: "Date", inferredType: "date", missing: 0 }),
      expect.objectContaining({ name: "Revenue", inferredType: "number", missing: 1, invalid: 1 }),
      expect.objectContaining({ name: "Region", inferredType: "string", unique: 2 }),
    ]);
    expect(report.columns[1]?.statistics).toEqual(expect.objectContaining({ count: 3, min: 1000.5, max: 1400.5, mean: 1200.5, median: 1200.5 }));
    expect(report.evidence.every((evidence) => evidence.range === dataset.range)).toBe(true);
  });

  it("detects missing values, duplicate rows, correlations and IQR outliers", () => {
    const report = analyzeMatrix({ range: "T!A1:C6", headers: ["A", "B", "C"], rows: [[1, 2, "x"], [1, 2, "x"], [2, 4, "y"], [3, 100, "z"], [4, 8, "w"]] });
    expect(report.duplicates).toEqual([[1, 2]]);
    expect(report.correlations).toEqual([expect.objectContaining({ left: "A", right: "B", coefficient: expect.any(Number) })]);
    expect(report.outliers.some((outlier) => outlier.column === "B" && outlier.row === 4)).toBe(true);
  });

  it("is deterministic, bounded and proposes time-series trends without editing data", () => {
    const report = analyzeMatrix({ range: "T!A1:B1001", headers: ["Date", "Value"], rows: Array.from({ length: 1000 }, (_, i) => [`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, i]) }, { maxRows: 100 });
    expect(report.sampled).toBe(true);
    expect(report.rowsAnalyzed).toBe(100);
    expect(report.trends[0]).toEqual(expect.objectContaining({ column: "Value", direction: "increasing" }));
    expect(analyzeMatrix(dataset)).toEqual(analyzeMatrix(dataset));
  });

  it("diagnoses formula errors, gaps and inconsistent formula patterns", () => {
    const result = analyzeFormulas({ range: "Sales!D2:D6", formulas: [["=A2+B2"], ["=A3+B3"], [""], ["=#REF!"], ["=A9+B9"]] });
    expect(result.errors).toEqual([expect.objectContaining({ row: 5, code: "FORMULA_ERROR" })]);
    expect(result.gaps).toEqual([4]);
    expect(result.inconsistentRows).toContain(6);
    expect(result.evidence.every((evidence) => evidence.range === "Sales!D2:D6")).toBe(true);
  });
});

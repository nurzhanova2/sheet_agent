import { describe, expect, it } from "vitest";
import { gridFromGroupOutcome, groupMetricLabel, reorderGroupGrid } from "./group-grid.js";
import type { AnalysisResult } from "./types.js";

const groupOutcome = (metrics: Record<string, number | null>[], keys: string[]): AnalysisResult => ({
  op: "group_by",
  source: { sheetName: "Sales Test Data", address: "Sales Test Data!A1:L121" },
  rowsAnalyzed: 120,
  rowsMatched: 120,
  truncated: false,
  warnings: [],
  parameters: { dimensions: ["Category"], groupCount: keys.length },
  groups: keys.map((k, i) => ({ key: { Category: k }, count: 1, metrics: metrics[i]! })),
});

describe("gridFromGroupOutcome", () => {
  it("rebuilds the displayed grid from a group_by outcome + its (canonicalised) request", () => {
    // canonicalisation sorts metrics: mean_Fact before mean_Plan
    const request = {
      op: "group_by",
      by: ["Category"],
      metrics: [
        { name: "mean_Fact", metric: "mean", target: { kind: "column", name: "Fact" } },
        { name: "mean_Plan", metric: "mean", target: { kind: "column", name: "Plan" } },
      ],
    };
    const outcome = groupOutcome(
      [
        { mean_Fact: 228.31, mean_Plan: 227.13 },
        { mean_Fact: 226, mean_Plan: 222.95 },
      ],
      ["Accessories", "Electronics"],
    );
    const grid = gridFromGroupOutcome(outcome, request);
    expect(grid).not.toBeNull();
    expect(grid!.columns).toEqual(["Category", "Mean Fact", "Mean Plan"]);
    expect(grid!.rows).toEqual([
      ["Accessories", 228.31, 227.13],
      ["Electronics", 226, 222.95],
    ]);
  });

  it("returns null for a non-group_by outcome", () => {
    const scalar: AnalysisResult = {
      op: "count",
      source: { sheetName: "S", address: "S!A1:A2" },
      rowsAnalyzed: 1,
      truncated: false,
      warnings: [],
      value: 3,
    };
    expect(gridFromGroupOutcome(scalar, { op: "count" })).toBeNull();
  });
});

describe("groupMetricLabel", () => {
  it("humanises aggregate + column, ignoring the internal metric name", () => {
    expect(groupMetricLabel({ name: "mean_Plan", metric: "mean", target: { kind: "column", name: "Plan" } })).toBe("Mean Plan");
    expect(groupMetricLabel({ metric: "count" })).toBe("Count");
  });
});

describe("reorderGroupGrid", () => {
  it("restores the prompt column order (dimension, then metrics in request order)", () => {
    const out = reorderGroupGrid(
      ["Category", "Mean Fact", "Mean Plan"],
      [
        ["Accessories", 228.31, 227.13],
        ["Electronics", 226, 222.95],
      ],
      ["Category", "Mean Plan", "Mean Fact"],
    );
    expect(out.columns).toEqual(["Category", "Mean Plan", "Mean Fact"]);
    expect(out.rows).toEqual([
      ["Accessories", 227.13, 228.31],
      ["Electronics", 222.95, 226],
    ]);
  });

  it("is a no-op when the preferred order does not line up", () => {
    const cols = ["A", "B"];
    const rows = [[1, 2]];
    expect(reorderGroupGrid(cols, rows, ["X", "Y"])).toEqual({ columns: cols, rows });
    expect(reorderGroupGrid(cols, rows, [])).toEqual({ columns: cols, rows });
  });
});

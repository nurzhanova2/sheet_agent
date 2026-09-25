import { describe, expect, it } from "vitest";
import { resultToChartData } from "./result-to-chart.js";
import type { ResultRef } from "./session-memory.js";

function ref(over: Partial<ResultRef>): ResultRef {
  return {
    id: "res_1",
    turnId: "t1",
    order: 1,
    createdAt: 0,
    kind: "grouped_table",
    sourceSheet: "Sales",
    sourceRange: "Sales!A1:C4",
    sourceVersion: "v1",
    title: "Average Plan and Fact by Category",
    spec: null,
    columns: ["Category", "Average Plan", "Average Fact"],
    rows: [
      ["Accessories", 227, 228],
      ["Electronics", 222, 250],
      ["Furniture", 200, 190],
    ],
    rowsTruncated: false,
    ...over,
  };
}

describe("resultToChartData", () => {
  it("category + one numeric column → a single-series bar chart from the exact values", () => {
    const out = resultToChartData(ref({ columns: ["Category", "Average Fact"], rows: [["A", 10], ["B", 30]] }));
    expect(out.kind).toBe("chart");
    if (out.kind !== "chart") return;
    expect(out.chart.type).toBe("bar");
    expect(out.chart.series.kind).toBe("category");
    if (out.chart.series.kind === "category") {
      expect(out.chart.series.labels).toEqual(["A", "B"]);
      expect(out.chart.series.values).toEqual([10, 30]);
      expect(out.chart.series.valueLabel).toBe("Average Fact");
    }
    expect(out.chart.provenance).toContain("Sales!A1:C4");
  });

  it("category + two numeric columns → a grouped multi-category bar chart", () => {
    const out = resultToChartData(ref({}));
    expect(out.kind).toBe("chart");
    if (out.kind !== "chart" || out.chart.series.kind !== "multi-category") throw new Error("expected grouped bar");
    expect(out.chart.series.mode).toBe("grouped");
    expect(out.chart.series.labels).toEqual(["Accessories", "Electronics", "Furniture"]);
    expect(out.chart.series.datasets.map((d) => d.label)).toEqual(["Average Plan", "Average Fact"]);
    expect(out.chart.series.datasets[1]!.values).toEqual([228, 250, 190]);
  });

  it("date-like label + one numeric column → a line chart", () => {
    const out = resultToChartData(
      ref({ columns: ["Month", "Revenue"], rows: [["2025-01-01", 100], ["2025-02-01", 140]] }),
    );
    if (out.kind !== "chart" || out.chart.series.kind !== "xy") throw new Error("expected line/xy");
    expect(out.chart.type).toBe("line");
    expect(out.chart.series.xIsDate).toBe(true);
    expect(out.chart.series.points).toEqual([["2025-01-01", 100], ["2025-02-01", 140]]);
  });

  it("three or more numeric columns → clarify which columns, no chart", () => {
    const out = resultToChartData(ref({ columns: ["Cat", "A", "B", "C"], rows: [["x", 1, 2, 3]] }));
    expect(out.kind).toBe("clarify");
    if (out.kind === "clarify") expect(out.candidates).toEqual(["A", "B", "C"]);
  });

  it("no numeric column → an error (never throws)", () => {
    const out = resultToChartData(ref({ columns: ["Cat", "Note"], rows: [["x", "hi"]] }));
    expect(out.kind).toBe("error");
  });
});

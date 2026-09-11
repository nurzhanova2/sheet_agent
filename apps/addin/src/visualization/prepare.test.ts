import { describe, expect, it } from "vitest";
import { buildDataset } from "../analysis/dataset.js";
import { runAnalysis } from "../analysis/engine.js";
import { isAnalysisError } from "../analysis/types.js";
import { salesSnapshot } from "../analysis/__fixtures__/sales-test-data.js";
import { prepareChartData } from "./prepare.js";
import { validateVisualizationRequest } from "./validate.js";
import { isVisualizationError, type ChartData } from "./types.js";

const snapshot = salesSnapshot();

function chart(request: unknown): ChartData {
  const outcome = prepareChartData(snapshot, request, "ru");
  if (isVisualizationError(outcome)) throw new Error(`${outcome.code}: ${outcome.error}`);
  return outcome;
}

describe("prepareChartData — deterministic chart data from the real workbook", () => {
  it("scatter Plan vs Fact returns exactly 120 finite (x, y) pairs, not model-authored points", () => {
    const data = chart({ type: "scatter", title: "Plan vs Fact", x: { column: "Plan" }, y: { column: "Fact" } });
    expect(data.series.kind).toBe("xy");
    if (data.series.kind !== "xy") return;
    expect(data.series.points).toHaveLength(120);
    // spot-check against the fixture's first data row (row 2): Plan 127, Fact 93
    expect(data.series.points[0]).toEqual([127, 93]);
    // every coordinate is a finite number — no NaN / Infinity / string
    for (const [x, y] of data.series.points) {
      expect(typeof x).toBe("number");
      expect(typeof y).toBe("number");
      expect(Number.isFinite(x as number)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    const xs = data.series.points.map((p) => p[0] as number);
    const ys = data.series.points.map((p) => p[1]);
    expect(Number.isFinite(Math.min(...xs))).toBe(true);
    expect(Number.isFinite(Math.max(...xs))).toBe(true);
    expect(Number.isFinite(Math.min(...ys))).toBe(true);
    expect(Number.isFinite(Math.max(...ys))).toBe(true);
    expect(data.provenance).toContain("Sales Test Data!A1:L121");
    // chart() drives the "ru" pipeline → the row-count suffix is localised
    expect(data.provenance).toContain("120 строк данных");
  });

  it("bar of mean Fact by Region matches the analysis engine's group_by exactly", () => {
    const data = chart({ type: "bar", title: "Средний Fact по Region", category: { column: "Region" }, value: { aggregate: "mean", column: "Fact" } });
    expect(data.series.kind).toBe("category");
    if (data.series.kind !== "category") return;

    const reference = runAnalysis(buildDataset(snapshot) as never, {
      op: "group_by",
      by: ["Region"],
      metrics: [{ metric: "mean", name: "value", target: { kind: "column", name: "Fact" } }],
      sort: { by: "value", direction: "desc" },
    });
    if (isAnalysisError(reference)) throw new Error(reference.error);
    const expected = Object.fromEntries((reference.groups ?? []).map((g) => [Object.values(g.key)[0], g.metrics["value"]]));
    for (let i = 0; i < data.series.labels.length; i += 1) {
      expect(data.series.values[i]).toBeCloseTo(expected[data.series.labels[i] ?? ""] as number, 6);
    }
  });

  it("histogram of Variance % produces deterministic equal-width bins covering every row", () => {
    const data = chart({ type: "histogram", title: "Распределение Variance %", value: { column: "Variance %" }, bins: 10 });
    expect(data.series.kind).toBe("histogram");
    if (data.series.kind !== "histogram") return;
    expect(data.series.counts).toHaveLength(10);
    expect(data.series.binEdges).toHaveLength(11);
    expect(data.series.counts.reduce((a, b) => a + b, 0)).toBe(120);
  });

  it("line of Revenue by Date is sorted ascending with ISO date labels", () => {
    const data = chart({ type: "line", title: "Revenue по датам", x: { column: "Date" }, y: { column: "Revenue" } });
    expect(data.series.kind).toBe("xy");
    if (data.series.kind !== "xy") return;
    expect(data.series.xIsDate).toBe(true);
    expect(String(data.series.points[0]?.[0])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const xs = data.series.points.map((p) => String(p[0]));
    expect([...xs]).toEqual([...xs].sort());
  });

  it("folds extra pie slices into a localized 'Другое' bucket deterministically", () => {
    const data = chart({ type: "pie", title: "Доля строк по Region", category: { column: "Region" }, value: { aggregate: "count" }, maxSlices: 3 });
    if (data.series.kind !== "category") throw new Error("expected category series");
    expect(data.series.labels).toHaveLength(3);
    expect(data.series.labels[2]).toBe("Другое");
    expect(data.series.values.reduce((a, b) => a + b, 0)).toBe(120);
  });

  it("caps scatter points with deterministic stride sampling and reports it", () => {
    const data = chart({ type: "scatter", title: "s", x: { column: "Plan" }, y: { column: "Fact" }, maxPoints: 20 });
    if (data.series.kind !== "xy") throw new Error("xy");
    expect(data.series.points.length).toBeLessThanOrEqual(20);
    expect(data.truncated).toBe(true);
    expect(data.warnings.join(" ")).toMatch(/точек|point/i);
  });

  it("rejects a non-numeric channel", () => {
    const outcome = prepareChartData(snapshot, { type: "scatter", title: "x", x: { column: "Region" }, y: { column: "Fact" } }, "ru");
    expect(isVisualizationError(outcome) && outcome.code).toBe("NON_NUMERIC");
  });
});

describe("validateVisualizationRequest — security & shape", () => {
  it("rejects unknown chart types", () => {
    const r = validateVisualizationRequest({ type: "sankey", title: "x" });
    expect(isVisualizationError(r) && r.code).toBe("UNKNOWN_CHART_TYPE");
  });

  it("rejects code-injection expressions", () => {
    const r = validateVisualizationRequest({ type: "scatter", title: "x", x: { expression: { kind: "call", name: "fetch" } }, y: { column: "Fact" } });
    expect(isVisualizationError(r)).toBe(true);
  });

  it("rejects an over-long title and out-of-range limits", () => {
    expect(isVisualizationError(validateVisualizationRequest({ type: "bar", title: "t".repeat(200), category: { column: "a" }, value: { aggregate: "count" } }))).toBe(true);
    expect(isVisualizationError(validateVisualizationRequest({ type: "histogram", title: "t", value: { column: "a" }, bins: 999 }))).toBe(true);
  });

  it("accepts a well-formed bar request", () => {
    const r = validateVisualizationRequest({ type: "bar", title: "ok", category: { column: "Region" }, value: { aggregate: "mean", column: "Fact" } });
    expect(isVisualizationError(r)).toBe(false);
  });

  it("rejects a model-authored data array (Stage 21.2.4 §14)", () => {
    const withData = validateVisualizationRequest({
      type: "bar", title: "x", category: { column: "Category" }, value: { aggregate: "mean", column: "Plan" }, data: [1, 2, 3],
    });
    expect(isVisualizationError(withData) && withData.code).toBe("MODEL_DATA_FORBIDDEN");

    const nestedValues = validateVisualizationRequest({
      type: "line", title: "x", x: { column: "Date" },
      series: [{ label: "a", value: { aggregate: "mean", column: "Plan" }, values: [1, 2] }],
    });
    expect(isVisualizationError(nestedValues) && nestedValues.code).toBe("MODEL_DATA_FORBIDDEN");
  });

  it("rejects more than the dataset ceiling of series", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, value: { aggregate: "mean", column: "Plan" } }));
    const r = validateVisualizationRequest({ type: "bar", title: "x", category: { column: "Category" }, series: many });
    expect(isVisualizationError(r)).toBe(true);
  });

  it("rejects a bar that gives both `value` and `series`, or neither", () => {
    expect(isVisualizationError(validateVisualizationRequest({
      type: "bar", title: "x", category: { column: "Category" },
      value: { aggregate: "count" }, series: [{ value: { aggregate: "mean", column: "Plan" } }],
    }))).toBe(true);
    expect(isVisualizationError(validateVisualizationRequest({ type: "bar", title: "x", category: { column: "Category" } }))).toBe(true);
  });

  it("accepts a multi-series bar and a grouped scatter", () => {
    expect(isVisualizationError(validateVisualizationRequest({
      type: "bar", title: "ok", category: { column: "Category" }, mode: "grouped",
      series: [{ label: "Average Plan", value: { aggregate: "mean", column: "Plan" } }, { label: "Average Fact", value: { aggregate: "mean", column: "Fact" } }],
    }))).toBe(false);
    expect(isVisualizationError(validateVisualizationRequest({
      type: "scatter", title: "ok", x: { column: "Plan" }, y: { column: "Fact" }, groupBy: { column: "Category" },
    }))).toBe(false);
  });
});

// Stage 21.2.4 — multi-series charts, scatter groupBy, deterministic data.
describe("prepareChartData — multi-series & grouped charts (Stage 21.2.4)", () => {
  it("grouped bar of mean Plan and mean Fact by Category: two datasets, exact engine values", () => {
    const data = chart({
      type: "bar",
      title: "Средние Plan и Fact по Category",
      category: { column: "Category" },
      mode: "grouped",
      series: [
        { id: "plan", label: "Average Plan", value: { aggregate: "mean", column: "Plan" } },
        { id: "fact", label: "Average Fact", value: { aggregate: "mean", column: "Fact" } },
      ],
    });
    expect(data.series.kind).toBe("multi-category");
    if (data.series.kind !== "multi-category") return;
    expect([...data.series.labels]).toEqual(["Accessories", "Electronics", "Furniture"]);
    expect(data.series.datasets).toHaveLength(2);
    const [plan, fact] = data.series.datasets;
    expect(plan?.values[0]).toBeCloseTo(227.125, 4);
    expect(plan?.values[1]).toBeCloseTo(222.945946, 4);
    expect(plan?.values[2]).toBeCloseTo(199.942857, 4);
    expect(fact?.values[0]).toBeCloseTo(228.3125, 4);
    expect(fact?.values[1]).toBeCloseTo(226, 4);
    expect(fact?.values[2]).toBeCloseTo(205.285714, 4);
    // the deterministic result describes exactly two datasets, no reference line
    expect(data.result?.type).toBe("bar");
    expect(data.result?.mode).toBe("grouped");
    expect(data.result?.datasets).toHaveLength(2);
    expect(data.result?.totalPointCount).toBe(3);
    expect(data.result?.referenceLines).toEqual([]);
    expect(data.result?.groupBy).toBeUndefined();
  });

  it("multi-series line aligns every series to one shared x-domain", () => {
    const data = chart({
      type: "line",
      title: "Plan vs Fact",
      x: { column: "Category" },
      series: [
        { label: "mean Plan", value: { aggregate: "mean", column: "Plan" } },
        { label: "mean Fact", value: { aggregate: "mean", column: "Fact" } },
      ],
    });
    expect(data.series.kind).toBe("multi-category");
    if (data.series.kind !== "multi-category") return;
    expect(data.series.labels).toHaveLength(3);
    for (const dataset of data.series.datasets) {
      expect(dataset.values).toHaveLength(data.series.labels.length); // aligned, one slot per x
      expect(dataset.values.every((v) => v === null || Number.isFinite(v))).toBe(true);
    }
    expect(data.result?.type).toBe("line");
    expect(data.result?.datasets).toHaveLength(2);
  });

  it("scatter groupBy Category: exactly three datasets 48 / 37 / 35, total 120 points", () => {
    const data = chart({
      type: "scatter",
      title: "Plan vs Fact по Category",
      x: { column: "Plan" },
      y: { column: "Fact" },
      groupBy: { column: "Category" },
    });
    expect(data.series.kind).toBe("multi-xy");
    if (data.series.kind !== "multi-xy") return;
    expect(data.series.datasets).toHaveLength(3);
    expect(data.series.datasets.map((d) => d.group)).toEqual(["Accessories", "Electronics", "Furniture"]);
    expect(data.series.datasets.map((d) => d.pointCount)).toEqual([48, 37, 35]);
    expect(data.series.totalPointCount).toBe(120);
    // first Accessories row in the fixture is row 2: Plan 127, Fact 93
    expect(data.series.datasets[0]?.points[0]).toEqual([127, 93]);
    expect(data.result?.groupBy).toBe("Category");
    expect(data.result?.x).toBe("Plan");
    expect(data.result?.y).toBe("Fact");
    expect(data.result?.totalPointCount).toBe(120);
    expect(data.result?.referenceLines).toEqual([]);
  });

  it("single-series bar / pie / histogram / ungrouped scatter still carry a result with no reference line", () => {
    const bar = chart({ type: "bar", title: "b", category: { column: "Category" }, value: { aggregate: "count" } });
    expect(bar.series.kind).toBe("category");
    expect(bar.result?.mode).toBe("single");
    expect(bar.result?.referenceLines).toEqual([]);

    const pie = chart({ type: "pie", title: "p", category: { column: "Category" }, value: { aggregate: "count" } });
    if (pie.series.kind === "category") expect(pie.series.values.reduce((a, b) => a + b, 0)).toBe(120);

    const hist = chart({ type: "histogram", title: "h", value: { column: "Variance %" }, bins: 10 });
    if (hist.series.kind === "histogram") expect(hist.series.counts.reduce((a, b) => a + b, 0)).toBe(120);

    const scatter = chart({ type: "scatter", title: "s", x: { column: "Plan" }, y: { column: "Fact" } });
    if (scatter.series.kind === "xy") expect(scatter.series.points).toHaveLength(120);
    expect(scatter.result?.groupBy).toBeUndefined();
    expect(scatter.result?.totalPointCount).toBe(120);
  });

  it("does not let the model hand in bar values", () => {
    const outcome = prepareChartData(
      snapshot,
      { type: "bar", title: "x", category: { column: "Category" }, series: [{ label: "a", value: { aggregate: "mean", column: "Plan" } }], datasets: [{ data: [1, 2, 3] }] },
      "ru",
    );
    expect(isVisualizationError(outcome) && outcome.code).toBe("MODEL_DATA_FORBIDDEN");
  });
});

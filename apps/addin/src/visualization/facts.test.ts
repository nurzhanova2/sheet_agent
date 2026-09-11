import { describe, expect, it } from "vitest";
import { deriveVisualizationFacts, renderVisualizationFacts, validateChartClaims, deriveChartValueFacts, CHART_VALUE_OP_ID } from "./facts.js";
import { prepareChartData } from "./prepare.js";
import { isVisualizationError, type ChartData, type VisualizationResult } from "./types.js";
import { salesSnapshot } from "../analysis/__fixtures__/sales-test-data.js";

const snapshot = salesSnapshot();

function resultOf(request: unknown): VisualizationResult {
  const outcome = prepareChartData(snapshot, request, "ru");
  if (isVisualizationError(outcome)) throw new Error(`${outcome.code}: ${outcome.error}`);
  if (!outcome.result) throw new Error("no VisualizationResult");
  return outcome.result;
}

const GROUPED_SCATTER: VisualizationResult = {
  type: "scatter",
  title: "Plan vs Fact",
  sourceRange: "Sales Test Data!A1:L121 · 120 data rows",
  x: "Plan",
  y: "Fact",
  groupBy: "Category",
  mode: "grouped",
  datasets: [
    { id: "g1", label: "Accessories", group: "Accessories", pointCount: 48, sourceColumns: ["Plan", "Fact"] },
    { id: "g2", label: "Electronics", group: "Electronics", pointCount: 37, sourceColumns: ["Plan", "Fact"] },
    { id: "g3", label: "Furniture", group: "Furniture", pointCount: 35, sourceColumns: ["Plan", "Fact"] },
  ],
  totalPointCount: 120,
  referenceLines: [],
  annotations: [],
};

const PLAIN_SCATTER: VisualizationResult = {
  type: "scatter",
  title: "Plan vs Fact",
  sourceRange: "Sales Test Data!A1:L121 · 120 data rows",
  x: "Plan",
  y: "Fact",
  mode: "single",
  datasets: [{ id: "s1", label: "Plan × Fact", pointCount: 120, sourceColumns: ["Plan", "Fact"] }],
  totalPointCount: 120,
  referenceLines: [],
  annotations: [],
};

describe("deriveVisualizationFacts", () => {
  it("materialises the structure of a real grouped scatter", () => {
    const result = resultOf({ type: "scatter", title: "Plan vs Fact по Category", x: { column: "Plan" }, y: { column: "Fact" }, groupBy: { column: "Category" } });
    const facts = deriveVisualizationFacts(result);
    const rendered = renderVisualizationFacts(facts);
    expect(rendered).toMatch(/Chart type: scatter/);
    expect(rendered).toMatch(/Grouped by: Category/);
    expect(rendered).toMatch(/Dataset count: 3/);
    expect(rendered).toMatch(/Total points: 120/);
    expect(rendered).toMatch(/Reference lines: none/);
    expect(rendered).toMatch(/Accessories.*48 point/);
  });

  it("says the grouping is 'none' for an ungrouped chart", () => {
    const result = resultOf({ type: "scatter", title: "x", x: { column: "Plan" }, y: { column: "Fact" } });
    expect(renderVisualizationFacts(deriveVisualizationFacts(result))).toMatch(/Grouping: none/);
  });
});

describe("validateChartClaims — grouped scatter (Stage 21.2.4 §24)", () => {
  const clean = (text: string) => validateChartClaims(text, GROUPED_SCATTER, "ru");
  const cleanEn = (text: string) => validateChartClaims(text, GROUPED_SCATTER, "en");

  it("accepts faithful descriptions", () => {
    expect(clean("Построен scatter plot Plan vs Fact с отдельными наборами данных для каждой Category.")).toEqual([]);
    expect(clean("На графике 120 точек.")).toEqual([]);
    expect(cleanEn("Three datasets are shown: Accessories, Electronics and Furniture.")).toEqual([]);
    expect(cleanEn("The scatter chart plots Plan on the x-axis and Fact on the y-axis for all 120 points.")).toEqual([]);
  });

  it("rejects an invented reference / y=x line", () => {
    expect(clean("На графике есть линия Fact = Plan.").length).toBeGreaterThan(0);
    expect(clean("Добавлена линия y=x.").length).toBeGreaterThan(0);
    expect(cleanEn("A 1:1 line was added for reference.").length).toBeGreaterThan(0);
    expect(cleanEn("The chart shows a trend line through the points.").length).toBeGreaterThan(0);
  });

  it("rejects a specific colour / symbol for a series", () => {
    expect(clean("Accessories показан синими кругами.").length).toBeGreaterThan(0);
    expect(cleanEn("Accessories is drawn with blue circles.").length).toBeGreaterThan(0);
  });

  it("rejects a wrong dataset or point count", () => {
    expect(cleanEn("There are 5 series on the chart.").length).toBeGreaterThan(0);
    expect(cleanEn("The chart contains 150 points.").length).toBeGreaterThan(0);
  });

  it("rejects a wrong chart type", () => {
    expect(cleanEn("This bar chart compares Plan and Fact.").length).toBeGreaterThan(0);
  });

  it("rejects 'grouped by Category' when the chart has NO groupBy", () => {
    expect(validateChartClaims("Точки разделены по Category.", PLAIN_SCATTER, "ru").length).toBeGreaterThan(0);
    expect(validateChartClaims("The points are grouped by Category.", PLAIN_SCATTER, "en").length).toBeGreaterThan(0);
  });

  it("allows a numeric-relationship remark that is not phrased as a drawn line", () => {
    expect(cleanEn("Points where Fact is numerically greater than Plan sit above the conceptual equality relationship.")).toEqual([]);
  });
});

describe("validateChartClaims — grouped bar", () => {
  const result: VisualizationResult = {
    type: "bar",
    title: "Средние Plan и Fact по Category",
    sourceRange: "Sales Test Data!A1:L121 · 120 data rows",
    x: "Category",
    valueLabel: "Average Plan · Average Fact",
    mode: "grouped",
    datasets: [
      { id: "plan", label: "Average Plan", pointCount: 3, sourceColumns: ["Plan"], aggregate: "mean" },
      { id: "fact", label: "Average Fact", pointCount: 3, sourceColumns: ["Fact"], aggregate: "mean" },
    ],
    categoryLabels: ["Accessories", "Electronics", "Furniture"],
    totalPointCount: 3,
    referenceLines: [],
    annotations: [],
    aggregation: "mean",
  };
  it("accepts a two-dataset description", () => {
    expect(validateChartClaims("Столбчатая диаграмма с двумя наборами данных: средний Plan и средний Fact по трём категориям.", result, "ru")).toEqual([]);
  });
  it("rejects claiming three datasets", () => {
    expect(validateChartClaims("The grouped bar chart has 3 datasets.", result, "en").length).toBeGreaterThan(0);
  });
});

describe("deriveChartValueFacts (Stage 21.2.8.1)", () => {
  function chartOf(request: unknown, lang: "ru" | "en" = "en"): ChartData {
    const out = prepareChartData(snapshot, request, lang);
    if (isVisualizationError(out)) throw new Error(`${out.code}: ${out.error}`);
    return out;
  }

  it("grouped bar → one scalar fact per category × dataset, fixture-exact, all from chart#1", () => {
    const c = chartOf({
      type: "bar",
      title: "Средние Plan и Fact по Category",
      category: { column: "Category" },
      mode: "grouped",
      series: [
        { label: "s1", value: { aggregate: "mean", column: "Plan" } },
        { label: "s2", value: { aggregate: "mean", column: "Fact" } },
      ],
    });
    const facts = deriveChartValueFacts(c, "Sales Test Data!A1:L121", "en");
    expect(facts).toHaveLength(6);
    expect([...new Set(facts.map((f) => f.group))].sort()).toEqual(["Accessories", "Electronics", "Furniture"]);
    expect([...new Set(facts.map((f) => f.metric))].sort()).toEqual(["mean Fact", "mean Plan"]);
    expect(facts.every((f) => f.kind === "scalar" && f.sourceOperationId === CHART_VALUE_OP_ID)).toBe(true);
    const pick = (m: string, g: string) => facts.find((f) => f.metric === m && f.group === g)!;
    expect(pick("mean Plan", "Accessories").value).toBeCloseTo(227.125, 3);
    expect(pick("mean Fact", "Electronics").value).toBeCloseTo(226, 3);
    expect(pick("mean Fact", "Furniture").formatted).toBe("205.29");
  });

  it("single-series bar → one scalar fact per category", () => {
    const c = chartOf({ type: "bar", title: "Σ Revenue by Category", category: { column: "Category" }, value: { aggregate: "sum", column: "Revenue" } });
    const facts = deriveChartValueFacts(c, "range", "en");
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.metric === "sum Revenue")).toBe(true);
  });

  it("scatter / histogram → NO chart-value facts (structure only)", () => {
    const sc = chartOf({ type: "scatter", title: "P vs F", x: { column: "Plan" }, y: { column: "Fact" }, groupBy: { column: "Category" } });
    expect(deriveChartValueFacts(sc, "r", "en")).toHaveLength(0);
    const hist = chartOf({ type: "histogram", title: "Variance %", value: { column: "Variance %" } });
    expect(deriveChartValueFacts(hist, "r", "en")).toHaveLength(0);
  });
});

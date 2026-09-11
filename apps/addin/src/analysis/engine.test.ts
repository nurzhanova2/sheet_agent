import { describe, expect, it } from "vitest";
import type { SelectionSnapshot } from "../app/workbook-context.js";
import { buildDataset } from "./dataset.js";
import { runAnalysis } from "./engine.js";
import { isAnalysisError, type AnalysisRequest, type AnalysisResult, type Expression } from "./types.js";

function ds(): ReturnType<typeof buildDataset> {
  const values: (string | number | null)[][] = [
    ["Region", "Category", "Plan", "Fact", "Score"],
    ["N", "A", 100, 90, 10],
    ["N", "B", 100, 130, 20],
    ["S", "A", 100, 100, 30],
    ["S", "B", 100, 200, 40],
    ["S", "A", 100, 60, 1000],
    ["N", null, 100, null, null],
  ];
  const snap: SelectionSnapshot = {
    sheetName: "Sales", address: "Sales!A1:E7", rowCount: 7, columnCount: 5,
    totalRowCount: 7, totalColumnCount: 5, totalCellCount: 35,
    values, formulas: values.map((r) => r.map(() => null)), numberFormats: values.map((r) => r.map(() => "General")),
    headers: ["Region", "Category", "Plan", "Fact", "Score"], truncated: false, isEmpty: false,
  };
  return buildDataset(snap);
}

function run(request: AnalysisRequest): AnalysisResult {
  const dataset = ds();
  if ("error" in dataset) throw new Error(dataset.error);
  const outcome = runAnalysis(dataset, request);
  if (isAnalysisError(outcome)) throw new Error(`${outcome.code}: ${outcome.error}`);
  return outcome;
}

const sub = (a: string, b: string): Expression => ({
  kind: "subtract",
  left: { kind: "column", name: a },
  right: { kind: "column", name: b },
});

describe("engine operations", () => {
  it("count with and without a filter", () => {
    expect(run({ op: "count" }).value).toBe(6);
    expect(run({ op: "count", where: { all: [{ left: { column: "Region" }, operator: "=", value: "S" }] } }).value).toBe(3);
  });

  it("aggregate: sum / mean / min / max / median over a derived expression", () => {
    expect(run({ op: "aggregate", metric: "sum", target: sub("Fact", "Plan") }).value).toBe(-10 + 30 + 0 + 100 + -40);
    expect(run({ op: "aggregate", metric: "mean", target: { kind: "column", name: "Score" } }).value).toBeCloseTo((10 + 20 + 30 + 40 + 1000) / 5);
    expect(run({ op: "aggregate", metric: "min", target: { kind: "column", name: "Score" } }).value).toBe(10);
    expect(run({ op: "aggregate", metric: "max", target: { kind: "column", name: "Score" } }).value).toBe(1000);
    expect(run({ op: "aggregate", metric: "median", target: { kind: "column", name: "Score" } }).value).toBe(30);
  });

  it("top_n / bottom_n by abs(Fact-Plan) with stable ties and source rows", () => {
    const top = run({ op: "top_n", n: 2, by: { kind: "abs", value: sub("Fact", "Plan") } });
    expect(top.rows?.map((r) => r[0])).toEqual(["S", "S"]); // |100| then |40|
    expect(top.sourceRows).toEqual([5, 6]); // sheet rows (header = 1)
    expect(top.parameters?.["values"]).toEqual([100, 40]);
    const bottom = run({ op: "bottom_n", n: 1, by: { kind: "abs", value: sub("Fact", "Plan") } });
    expect(bottom.parameters?.["values"]).toEqual([0]);
  });

  it("filter returns projected columns and source rows", () => {
    const result = run({ op: "filter", where: { all: [{ left: { column: "Region" }, operator: "=", value: "S" }] }, columns: ["Category", "Fact"] });
    expect(result.columns).toEqual(["Category", "Fact"]);
    expect(result.rows).toEqual([["A", 100], ["B", 200], ["A", 60]]);
    expect(result.sourceRows).toEqual([4, 5, 6]);
  });

  it("sort ascending by Score, missing values last", () => {
    const result = run({ op: "sort", by: { kind: "column", name: "Score" }, direction: "asc", columns: ["Score"] });
    expect(result.rows?.map((r) => r[0])).toEqual([10, 20, 30, 40, 1000, null]);
  });

  it("distinct lists unique values", () => {
    const result = run({ op: "distinct", column: "Region" });
    expect(result.rows).toEqual([["N"], ["S"]]);
    expect(result.parameters?.["distinctCount"]).toBe(2);
  });

  it("group_by with per-metric where (total vs strong) — one call", () => {
    const result = run({
      op: "group_by",
      by: ["Region"],
      metrics: [
        { metric: "count", name: "total" },
        { metric: "count", name: "strong", where: { all: [{ left: { kind: "abs", value: { kind: "divide", left: sub("Fact", "Plan"), right: { kind: "column", name: "Plan" } } }, operator: ">", value: 0.2 }] } },
        { metric: "sum", name: "planTotal", target: { kind: "column", name: "Plan" } },
      ],
      sort: { by: "strong", direction: "desc" },
    });
    const byRegion = Object.fromEntries((result.groups ?? []).map((g) => [g.key["Region"], g.metrics]));
    expect(byRegion["N"]).toEqual({ total: 3, strong: 1, planTotal: 300 }); // row2 +30% is strong
    expect(byRegion["S"]).toEqual({ total: 3, strong: 2, planTotal: 300 }); // +100% and -40%
  });

  it("group_by per-metric where accepts a BARE condition and a percent literal (Stage 21.1.1 regression)", () => {
    const result = run({
      op: "group_by",
      by: ["Region"],
      metrics: [
        { metric: "count", name: "total" },
        {
          metric: "count",
          name: "strong",
          // bare condition (no {all:[…]}) + {kind:"percent"} RHS — exactly the live-planner shape
          where: {
            left: { kind: "abs", value: { kind: "divide", left: sub("Fact", "Plan"), right: { kind: "column", name: "Plan" } } },
            operator: ">",
            value: { kind: "percent", value: 20 },
          } as never,
        },
      ],
    });
    const byRegion = Object.fromEntries((result.groups ?? []).map((g) => [g.key["Region"], g.metrics]));
    expect(byRegion["N"]).toEqual({ total: 3, strong: 1 });
    expect(byRegion["S"]).toEqual({ total: 3, strong: 2 });
    // the bug: strong === total for every group
    expect(byRegion["N"]?.["strong"]).not.toBe(byRegion["N"]?.["total"]);
  });

  it("multi-dimensional group_by (Region × Category)", () => {
    const result = run({ op: "group_by", by: ["Region", "Category"], metrics: [{ metric: "count", name: "n" }] });
    const keys = (result.groups ?? []).map((g) => `${g.key["Region"]}/${g.key["Category"]}`);
    expect(keys).toContain("S/A");
    expect((result.groups ?? []).find((g) => g.key["Region"] === "S" && g.key["Category"] === "A")?.metrics["n"]).toBe(2);
  });

  it("summary_statistics for numeric columns", () => {
    const result = run({ op: "summary_statistics", columns: ["Score"] });
    const score = result.statistics?.["Score"];
    expect(score?.count).toBe(5);
    expect(score?.missing).toBe(1);
    expect(score?.min).toBe(10);
    expect(score?.max).toBe(1000);
    expect(score?.median).toBe(30);
  });

  it("correlation returns Pearson r and observation count", () => {
    const result = run({ op: "correlation", x: { kind: "column", name: "Fact" }, y: { kind: "column", name: "Score" } });
    expect(result.parameters?.["method"]).toBe("pearson");
    expect(result.parameters?.["observations"]).toBe(5);
    expect(typeof result.value).toBe("number");
  });

  it("correlation warns and returns null when a column has zero variance", () => {
    const result = run({ op: "correlation", x: { kind: "column", name: "Plan" }, y: { kind: "column", name: "Fact" } });
    expect(result.value).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/variance|3 complete/i);
  });

  it("outliers by z-score expose the method and threshold", () => {
    const result = run({ op: "outliers", target: { kind: "column", name: "Score" }, method: "zscore", threshold: 1.5 });
    expect(result.parameters?.["method"]).toBe("zscore");
    expect(result.parameters?.["threshold"]).toBe(1.5);
    expect(result.rows?.[0]?.[4]).toBe(1000);
  });
});

describe("engine validation & security", () => {
  const dataset = ds();
  const bad = (request: unknown): { code: string; error: string } => {
    if ("error" in dataset) throw new Error("dataset");
    const outcome = runAnalysis(dataset, request as AnalysisRequest);
    if (!isAnalysisError(outcome)) throw new Error("expected an AnalysisError");
    return outcome;
  };

  it("rejects unknown operations", () => {
    expect(bad({ op: "eval" }).code).toBe("UNKNOWN_OP");
    expect(bad({ op: "drop_table" }).code).toBe("UNKNOWN_OP");
  });

  it("rejects malicious / unknown expression kinds", () => {
    expect(bad({ op: "aggregate", metric: "sum", target: { kind: "require", value: "child_process" } }).code).toBe("INVALID_EXPRESSION");
    expect(bad({ op: "aggregate", metric: "sum", target: { kind: "call", name: "fetch" } }).code).toBe("INVALID_EXPRESSION");
    expect(bad({ op: "top_n", n: 5, by: { kind: "column", name: "__proto__" } }).code).toBe("UNKNOWN_COLUMN");
  });

  it("rejects unknown columns instead of guessing", () => {
    expect(bad({ op: "aggregate", metric: "sum", target: { kind: "column", name: "Revenue" } }).code).toBe("UNKNOWN_COLUMN");
  });

  it("enforces numeric limits (n, group dims, conditions, expression depth)", () => {
    expect(bad({ op: "top_n", n: 5000, by: { kind: "column", name: "Score" } }).code).toBe("LIMIT_EXCEEDED");
    expect(bad({ op: "group_by", by: ["Region", "Category", "Plan", "Fact"], metrics: [{ metric: "count" }] }).code).toBe("LIMIT_EXCEEDED");
    const deep = Array.from({ length: 10 }).reduce<unknown>((inner) => ({ kind: "abs", value: inner }), { kind: "column", name: "Score" });
    expect(bad({ op: "aggregate", metric: "sum", target: deep }).code).toBe("INVALID_EXPRESSION");
  });

  it("caps result rows", () => {
    if ("error" in dataset) throw new Error("dataset");
    const outcome = runAnalysis(dataset, { op: "top_n", n: 100, by: { kind: "column", name: "Score" } });
    if (isAnalysisError(outcome)) throw new Error(outcome.error);
    expect((outcome.rows?.length ?? 0)).toBeLessThanOrEqual(200);
  });
});

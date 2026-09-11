import { describe, expect, it } from "vitest";
import { buildDataset } from "./dataset.js";
import { runAnalysis } from "./engine.js";
import { isAnalysisError, type AnalysisRequest } from "./types.js";
import { salesSnapshot } from "./__fixtures__/sales-test-data.js";

const dataset = buildDataset(salesSnapshot());
if ("error" in dataset) throw new Error(dataset.error);
const ds = dataset as Exclude<typeof dataset, { error: string }>;

function run(request: AnalysisRequest) {
  const outcome = runAnalysis(ds, request);
  if (isAnalysisError(outcome)) throw new Error(`${outcome.code}: ${outcome.error}`);
  return outcome;
}

// §10 — the real manual failure: three per-Category Pearson runs all returned
// "not calculated". One deterministic group_correlation call must produce r for
// every Category. Expected r values computed independently from the workbook.
describe("§10 group_correlation — Pearson r within each Category", () => {
  it("Unit Price vs Revenue, one call, correct r per group", () => {
    const result = run({
      op: "group_correlation",
      by: ["Category"],
      x: { kind: "column", name: "Unit Price" },
      y: { kind: "column", name: "Revenue" },
    });
    const byCategory = Object.fromEntries(
      (result.groups ?? []).map((g) => [g.key["Category"], { n: g.metrics["n"], r: g.metrics["r"] }]),
    );

    expect(byCategory["Accessories"]?.n).toBe(48);
    expect(byCategory["Electronics"]?.n).toBe(37);
    expect(byCategory["Furniture"]?.n).toBe(35);

    expect(byCategory["Accessories"]?.r as number).toBeCloseTo(0.462227, 5);
    expect(byCategory["Electronics"]?.r as number).toBeCloseTo(0.745010, 5);
    expect(byCategory["Furniture"]?.r as number).toBeCloseTo(0.351841, 5);

    expect(result.parameters?.["method"]).toBe("pearson");
    expect(result.rowsMatched).toBe(120);
  });

  it("honours a top-level where filter before bucketing", () => {
    const result = run({
      op: "group_correlation",
      by: ["Category"],
      x: { kind: "column", name: "Plan" },
      y: { kind: "column", name: "Fact" },
      where: { left: { column: "Region" }, operator: "=", value: "Almaty" },
    });
    const groups = result.groups ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) expect(g.metrics["n"] as number).toBeGreaterThanOrEqual(0);
    expect(result.rowsMatched).toBeLessThan(120);
  });

  it("reports r = null (not an error) for a group with < 3 complete pairs", () => {
    const result = run({
      op: "group_correlation",
      by: ["Manager"],
      x: { kind: "column", name: "Unit Price" },
      y: { kind: "column", name: "Revenue" },
      where: { left: { column: "Product" }, operator: "=", value: "Standing Desk" },
    });
    // every group still resolves; small groups simply carry r: null
    for (const g of result.groups ?? []) {
      const n = g.metrics["n"] as number;
      if (n < 3) expect(g.metrics["r"]).toBeNull();
    }
  });
});

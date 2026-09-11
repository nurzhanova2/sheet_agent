import { describe, expect, it } from "vitest";
import { contiguousRuns, selectMatchingRows } from "./select-rows.js";
import { runAnalysisBatch } from "./index.js";
import { salesSnapshot } from "./__fixtures__/sales-test-data.js";

describe("selectMatchingRows (Stage 22 mutation-correctness primitive)", () => {
  const sales = salesSnapshot();
  const factBelowPlan = { left: { column: "Fact" }, operator: "<" as const, value: { column: "Plan" } };

  it("returns the SAME count the engine's count op produces for the same condition", () => {
    const matched = selectMatchingRows(sales, factBelowPlan);
    const batch = runAnalysisBatch(sales, [{ op: "count", where: factBelowPlan }]);
    const countResult = batch.outcomes[0];
    const engineCount =
      countResult && !("error" in countResult) ? (countResult as { value: number }).value : -1;
    expect(matched.indexes.length).toBe(engineCount);
    expect(matched.error).toBeUndefined();
  });

  it("maps each matched data-row index to its 1-based sheet row (header at row 1)", () => {
    const matched = selectMatchingRows(sales, factBelowPlan);
    expect(matched.sheetRows).toEqual(matched.indexes.map((i) => i + 2));
    expect(Math.min(...matched.sheetRows)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...matched.sheetRows)).toBeLessThanOrEqual(121);
  });

  it("never throws on an unresolvable column — reports an error, empty match", () => {
    const matched = selectMatchingRows(sales, { left: { column: "Nope" }, operator: ">", value: 1 });
    expect(matched.indexes).toHaveLength(0);
    expect(matched.error).toBeTruthy();
  });
});

describe("contiguousRuns", () => {
  it("collapses a sorted row list into [start, end] runs", () => {
    expect(contiguousRuns([5, 6, 7, 10, 12, 13])).toEqual([[5, 7], [10, 10], [12, 13]]);
    expect(contiguousRuns([9, 3, 4, 3])).toEqual([[3, 4], [9, 9]]);
    expect(contiguousRuns([])).toEqual([]);
  });
});

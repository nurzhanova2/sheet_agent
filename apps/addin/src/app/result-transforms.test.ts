import { describe, expect, it } from "vitest";
import { applyResultTransform, detectResultTransform, isTransformError, rankRequestCount } from "./result-transforms.js";
import type { ResultRef } from "./session-memory.js";

const REF: ResultRef = {
  id: "res_1",
  turnId: "t1",
  order: 1,
  createdAt: 0,
  kind: "grouped_table",
  sourceSheet: "Sales Test Data",
  sourceRange: "Sales Test Data!A1:L121",
  sourceVersion: "121x12@Sales Test Data!A1:L121",
  title: "Average Plan and Fact by Category",
  spec: [{ op: "group_by" }],
  columns: ["Category", "Average Plan", "Average Fact"],
  rows: [
    ["Accessories", 227, 228],
    ["Electronics", 222, 250],
    ["Furniture", 200, 190],
    ["Outdoor", 210, 205],
  ],
  rowsTruncated: false,
  facts: [],
  resolved: [],
};

describe("detectResultTransform", () => {
  it("reads 'show only the top 2 by Fact' as top_n by the resolved column", () => {
    const d = detectResultTransform("show only the top 2 by Fact", REF);
    expect(d).toEqual({ kind: "transform", transform: { kind: "top_n", n: 2, by: "Average Fact", phrase: "top 2" } });
  });

  it("reads 'bottom 3' and 'sort by Plan descending'", () => {
    expect(detectResultTransform("bottom 3", REF)).toMatchObject({ kind: "transform", transform: { kind: "bottom_n", n: 3, by: "Average Fact" } });
    expect(detectResultTransform("sort by Plan descending", REF)).toMatchObject({ kind: "transform", transform: { kind: "sort_desc", by: "Average Plan" } });
  });

  it("reads 'which one is worst' as a which_extreme (min) over the default metric", () => {
    expect(detectResultTransform("which one is worst?", REF)).toMatchObject({ kind: "transform", transform: { kind: "which_extreme", extreme: "min", by: "Average Fact" } });
    expect(detectResultTransform("which is best?", REF)).toMatchObject({ kind: "transform", transform: { kind: "which_extreme", extreme: "max" } });
  });

  it("returns column_ambiguous when a named column matches more than one", () => {
    const wide: ResultRef = { ...REF, columns: ["Category", "PD12", "PD_Lifetime"], rows: [["A", 1, 2]] };
    const d = detectResultTransform("sort by PD", wide);
    expect(d.kind).toBe("column_ambiguous");
    if (d.kind === "column_ambiguous") expect(d.candidates).toEqual(["PD12", "PD_Lifetime"]);
  });

  it("returns none for a plain question", () => {
    expect(detectResultTransform("what does that suggest about planning?", REF).kind).toBe("none");
  });

  it("honours a forced column on resume", () => {
    const d = detectResultTransform("Compare PD", { ...REF, columns: ["Category", "PD12", "PD_Model"], rows: [["A", 1, 2]] }, "PD12");
    // no transform verb in the text → still none, but the column resolves without ambiguity
    expect(d.kind).toBe("none");
  });

  it("24.5.3 — reads 'покажи 3 менеджеров с худшим Variance' as bottom_n 3", () => {
    const mgr: ResultRef = { ...REF, columns: ["Manager", "Mean Variance %"], rows: [["A", -2], ["B", 0], ["C", 1], ["D", 2], ["E", 3]] };
    expect(detectResultTransform("покажи 3 менеджеров с худшим Variance", mgr)).toMatchObject({
      kind: "transform",
      transform: { kind: "bottom_n", n: 3, by: "Mean Variance %" },
    });
  });
});

describe("rankRequestCount", () => {
  it("extracts the requested count from top-N / N-with-superlative phrasings", () => {
    expect(rankRequestCount("покажи 3 менеджеров с худшим Variance")).toBe(3);
    expect(rankRequestCount("оставь 2 менеджеров с худшим Variance")).toBe(2);
    expect(rankRequestCount("show me 5 regions with the highest revenue")).toBe(5);
    expect(rankRequestCount("show only the top 4 by Fact")).toBe(4);
    expect(rankRequestCount("bottom 7")).toBe(7);
    expect(rankRequestCount("топ-10 по выручке")).toBe(10);
  });

  it("returns null when there is no count", () => {
    expect(rankRequestCount("which manager is worst?")).toBeNull();
    expect(rankRequestCount("получается какой менеджер не выполнил план")).toBeNull();
    expect(rankRequestCount("group by manager")).toBeNull();
  });
});

describe("applyResultTransform", () => {
  it("top_n by Average Fact returns the 2 highest rows, in order, as a derived ranking", () => {
    const out = applyResultTransform(REF, { kind: "top_n", n: 2, by: "Average Fact", phrase: "top 2" });
    expect(isTransformError(out)).toBe(false);
    if (isTransformError(out)) return;
    expect(out.kind).toBe("ranking");
    expect(out.rows).toEqual([
      ["Electronics", 222, 250],
      ["Accessories", 227, 228],
    ]);
    expect(out.columns).toEqual(REF.columns);
    expect(out.title).toMatch(/top 2 by Average Fact/);
  });

  it("which_extreme(min) names the row with the lowest value from the structured data", () => {
    const out = applyResultTransform(REF, { kind: "which_extreme", extreme: "min", by: "Average Fact", phrase: "which is worst" });
    if (isTransformError(out)) throw new Error("unexpected");
    expect(out.rows).toEqual([["Furniture", 200, 190]]);
    expect(out.answer).toMatch(/Furniture/);
    expect(out.answer).toMatch(/190/);
  });

  it("sort_asc orders the whole result ascending by the column", () => {
    const out = applyResultTransform(REF, { kind: "sort_asc", by: "Average Plan", phrase: "sort" });
    if (isTransformError(out)) throw new Error("unexpected");
    expect(out.rows.map((r) => r[0])).toEqual(["Furniture", "Outdoor", "Electronics", "Accessories"]);
  });

  it("column_subset projects only the requested columns", () => {
    const out = applyResultTransform(REF, { kind: "column_subset", keep: ["Category", "Average Fact"], phrase: "only category and fact" });
    if (isTransformError(out)) throw new Error("unexpected");
    expect(out.columns).toEqual(["Category", "Average Fact"]);
    expect(out.rows[0]).toEqual(["Accessories", 228]);
  });

  it("errors (never throws) when the transform names a missing column", () => {
    const out = applyResultTransform(REF, { kind: "top_n", n: 2, by: "Nope", phrase: "top 2" });
    expect(isTransformError(out)).toBe(true);
  });
});

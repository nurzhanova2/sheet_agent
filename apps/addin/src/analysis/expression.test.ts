import { describe, expect, it } from "vitest";
import type { SelectionSnapshot } from "../app/workbook-context.js";
import { buildDataset, type Dataset } from "./dataset.js";
import {
  AnalysisRequestError,
  evaluateCondition,
  evaluateExpression,
  evaluateGroup,
  isPercentLiteral,
  matchingRowIndexes,
  normalizeConditionGroup,
  resolveColumn,
} from "./expression.js";
import type { Condition, Expression } from "./types.js";

function dataset(): Dataset {
  const values: (string | number | null)[][] = [
    ["Region", "Plan", "Fact", "Variance %", "Note"],
    ["Almaty", 100, 80, -0.2, "under plan"],
    ["Astana", 200, 260, 0.3, "over plan"],
    ["Almaty", 0, 5, 0, "zero plan"],
    ["Aktobe", 50, 50, 0, ""],
  ];
  const snapshot: SelectionSnapshot = {
    sheetName: "S",
    address: "S!A1:E5",
    rowCount: 5,
    columnCount: 5,
    totalRowCount: 5,
    totalColumnCount: 5,
    totalCellCount: 25,
    values,
    formulas: values.map((r) => r.map(() => null)),
    numberFormats: values.map((r) => r.map(() => "General")),
    headers: ["Region", "Plan", "Fact", "Variance %", "Note"],
    truncated: false,
    isEmpty: false,
  };
  const d = buildDataset(snapshot);
  if ("error" in d) throw new Error(d.error);
  return d;
}

const col = (name: string): Expression => ({ kind: "column", name });

describe("evaluateExpression", () => {
  const d = dataset();
  it("evaluates arithmetic and abs", () => {
    expect(evaluateExpression(d, { kind: "subtract", left: col("Fact"), right: col("Plan") }, 0)).toBe(-20);
    expect(evaluateExpression(d, { kind: "abs", value: { kind: "subtract", left: col("Fact"), right: col("Plan") } }, 0)).toBe(20);
    expect(evaluateExpression(d, { kind: "abs", value: col("Variance %") }, 1)).toBeCloseTo(0.3);
  });
  it("returns null on divide by zero", () => {
    expect(evaluateExpression(d, { kind: "divide", left: { kind: "subtract", left: col("Fact"), right: col("Plan") }, right: col("Plan") }, 2)).toBeNull();
  });
  it("evaluates a percent literal as value / 100", () => {
    expect(evaluateExpression(d, { kind: "percent", value: 20 }, 0)).toBe(0.2);
    expect(evaluateExpression(d, { kind: "percent", value: 5 }, 0)).toBe(0.05);
  });
});

describe("percentage & bare-condition handling (Stage 21.1.1)", () => {
  const d = dataset();
  const absVar: Expression = { kind: "abs", value: col("Variance %") };

  it("isPercentLiteral / normalizeConditionGroup", () => {
    expect(isPercentLiteral({ kind: "percent", value: 20 })).toBe(true);
    expect(isPercentLiteral({ kind: "literal", value: 20 })).toBe(false);
    const bare: Condition = { left: absVar, operator: ">", value: 0.2 };
    expect(normalizeConditionGroup(bare)).toEqual({ all: [bare] });
    expect(normalizeConditionGroup({ all: [bare] })).toEqual({ all: [bare] });
    expect(normalizeConditionGroup(undefined)).toBeUndefined();
  });

  it("a percent-literal RHS compares against the underlying fraction", () => {
    // rows: Variance % = -0.2, 0.3, 0, 0
    const cond: Condition = { left: absVar, operator: ">", value: { kind: "percent", value: 20 } };
    expect(evaluateCondition(d, cond, 0)).toBe(false); // |−0.2| = 0.2, not > 0.2
    expect(evaluateCondition(d, cond, 1)).toBe(true); // |0.3| = 0.3 > 0.2
    expect(evaluateCondition(d, { ...cond, operator: ">=" }, 0)).toBe(true); // 0.2 >= 0.2
  });

  it("a bare condition passed as a `where` is evaluated, not treated as match-all", () => {
    // The exact bug: bucket.rows.filter(evaluateGroup(bareCondition)) used to return every row.
    const bare: Condition = { left: absVar, operator: ">", value: { kind: "percent", value: 20 } };
    const matched = matchingRowIndexes(d, bare);
    expect(matched).toEqual([1]); // only Astana's 0.3
    // sanity: an empty group still matches everything
    expect(matchingRowIndexes(d, {})).toEqual([0, 1, 2, 3]);
  });

  it("negative fractions satisfy |x| > percent(20)", () => {
    const d2 = (() => {
      const values: (string | number | null)[][] = [
        ["V"],
        [-0.2653],
        [-0.1],
        [0.4],
      ];
      const snap: SelectionSnapshot = {
        sheetName: "S", address: "S!A1:A4", rowCount: 4, columnCount: 1, totalRowCount: 4, totalColumnCount: 1, totalCellCount: 4,
        values, formulas: values.map((r) => r.map(() => null)), numberFormats: values.map((r) => r.map(() => "0.0%")),
        headers: ["V"], truncated: false, isEmpty: false,
      };
      const built = buildDataset(snap);
      if ("error" in built) throw new Error(built.error);
      return built;
    })();
    const cond: Condition = { left: { kind: "abs", value: col("V") }, operator: ">", value: { kind: "percent", value: 20 } };
    expect(matchingRowIndexes(d2, cond)).toEqual([0, 2]); // -0.2653 and 0.4
  });
});

describe("resolveColumn", () => {
  const d = dataset();
  it("matches exact, whitespace/case-insensitive, and A1 letter", () => {
    expect(resolveColumn(d, "Variance %").index).toBe(3);
    expect(resolveColumn(d, "variance%").index).toBe(3);
    expect(resolveColumn(d, "  VARIANCE   %  ").index).toBe(3);
    expect(resolveColumn(d, "B").index).toBe(1);
  });
  it("throws a structured error for unknown columns", () => {
    expect(() => resolveColumn(d, "Profit")).toThrow(AnalysisRequestError);
    try {
      resolveColumn(d, "Profit");
    } catch (error) {
      expect((error as AnalysisRequestError).code).toBe("UNKNOWN_COLUMN");
    }
  });
  it("throws AMBIGUOUS_COLUMN when two headers normalise the same", () => {
    const values: (string | number | null)[][] = [
      ["Total", "total", "x"],
      [1, 2, 3],
    ];
    const snap: SelectionSnapshot = {
      sheetName: "S", address: "S!A1:C2", rowCount: 2, columnCount: 3, totalRowCount: 2, totalColumnCount: 3, totalCellCount: 6,
      values, formulas: [[null, null, null], [null, null, null]], numberFormats: [["General", "General", "General"], ["General", "General", "General"]],
      headers: ["Total", "total", "x"], truncated: false, isEmpty: false,
    };
    const d2 = buildDataset(snap);
    if ("error" in d2) throw new Error("unexpected");
    expect(() => resolveColumn(d2, "TOTAL")).toThrow(/ambiguous/i);
  });
});

describe("evaluateCondition / evaluateGroup", () => {
  const d = dataset();
  it("supports all comparison operators", () => {
    expect(evaluateCondition(d, { left: { column: "Plan" }, operator: ">", value: 150 }, 1)).toBe(true);
    expect(evaluateCondition(d, { left: { column: "Plan" }, operator: "<=", value: 100 }, 0)).toBe(true);
    expect(evaluateCondition(d, { left: { column: "Region" }, operator: "=", value: "almaty" }, 0)).toBe(true);
    expect(evaluateCondition(d, { left: { column: "Region" }, operator: "!=", value: "Almaty" }, 1)).toBe(true);
    expect(evaluateCondition(d, { left: { column: "Note" }, operator: "contains", value: "plan" }, 0)).toBe(true);
    expect(evaluateCondition(d, { left: { column: "Note" }, operator: "not_contains", value: "over" }, 0)).toBe(true);
  });
  it("evaluates an expression on the left side (abs(Variance %) > 0.2)", () => {
    const cond = { left: { kind: "abs", value: col("Variance %") } as Expression, operator: ">" as const, value: 0.2 };
    expect(evaluateGroup(d, { all: [cond] }, 1)).toBe(true);
    expect(evaluateGroup(d, { all: [cond] }, 3)).toBe(false);
  });
  it("supports AND (all) and OR (any)", () => {
    const idx = matchingRowIndexes(d, { all: [{ left: { column: "Region" }, operator: "=", value: "Almaty" }, { left: { column: "Plan" }, operator: ">", value: 50 }] });
    expect(idx).toEqual([0]);
    const orIdx = matchingRowIndexes(d, { any: [{ left: { column: "Region" }, operator: "=", value: "Astana" }, { left: { column: "Region" }, operator: "=", value: "Aktobe" }] });
    expect(orIdx).toEqual([1, 3]);
  });

  it("§2 — compares two columns directly (Fact < Plan)", () => {
    expect(evaluateCondition(d, { left: { column: "Fact" }, operator: "<", value: { column: "Plan" } }, 0)).toBe(true); // 80 < 100
    expect(evaluateCondition(d, { left: { column: "Fact" }, operator: "<", value: { column: "Plan" } }, 1)).toBe(false); // 260 < 200
    expect(evaluateCondition(d, { left: { column: "Fact" }, operator: ">=", value: { column: "Plan" } }, 3)).toBe(true); // 50 >= 50
    expect(matchingRowIndexes(d, { left: { column: "Fact" }, operator: "<", value: { column: "Plan" } })).toEqual([0]);
  });

  it("§2 — an expression RHS is supported too (Fact < Plan - 10)", () => {
    const where: Condition = {
      left: { column: "Fact" },
      operator: "<",
      value: { kind: "subtract", left: { kind: "column", name: "Plan" }, right: { kind: "literal", value: 10 } },
    };
    expect(evaluateCondition(d, where, 0)).toBe(true); // 80 < 90
    expect(evaluateCondition(d, where, 3)).toBe(false); // 50 < 40
  });

  it("§2 — equality between two text columns", () => {
    // Region vs Note are different, but Region = Region is trivially true per row
    expect(evaluateCondition(d, { left: { column: "Region" }, operator: "=", value: { column: "Region" } }, 2)).toBe(true);
    expect(evaluateCondition(d, { left: { column: "Region" }, operator: "=", value: { column: "Note" } }, 2)).toBe(false);
  });
});

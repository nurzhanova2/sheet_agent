import { describe, expect, it } from "vitest";
import type { SelectionSnapshot } from "../workbook-context.js";
import { buildCompareReport, isCompareError, parseCompareSpec } from "./compare.js";

function table(headers: string[], rows: (string | number)[][], sheet = "Sheet1"): SelectionSnapshot {
  const values = [headers, ...rows];
  return {
    sheetName: sheet,
    address: `${sheet}!A1:${String.fromCharCode(64 + headers.length)}${values.length}`,
    rowCount: values.length,
    columnCount: headers.length,
    totalRowCount: values.length,
    totalColumnCount: headers.length,
    totalCellCount: values.length * headers.length,
    values,
    formulas: values.map((r) => r.map(() => null)),
    numberFormats: values.map((r) => r.map(() => "General")),
    headers,
    truncated: false,
    isEmpty: false,
  } as unknown as SelectionSnapshot;
}

describe("parseCompareSpec", () => {
  it("parses `<metric> between <A> and <B>` and the RU form", () => {
    expect(parseCompareSpec("Fact between Sales 2025 and Sales 2026")).toEqual({
      metric: "Fact",
      sheetA: "Sales 2025",
      sheetB: "Sales 2026",
    });
    expect(parseCompareSpec("Fact между Sales 2025 и Sales 2026")).toEqual({
      metric: "Fact",
      sheetA: "Sales 2025",
      sheetB: "Sales 2026",
    });
  });

  it("returns null for an unparseable argument", () => {
    expect(parseCompareSpec("Fact on two sheets")).toBeNull();
    expect(parseCompareSpec("")).toBeNull();
  });
});

describe("buildCompareReport", () => {
  const spec = { metric: "Fact", sheetA: "A", sheetB: "B" };
  const a = table(["Company", "Plan", "Fact"], [["x", 10, 100], ["y", 20, 200], ["z", 30, 300]], "A");
  const b = table(["Company", "Plan", "Fact"], [["x", 10, 50], ["y", 20, 150]], "B");

  it("computes count/sum/mean/min/max for a numeric column present in both sheets", () => {
    const built = buildCompareReport(spec, "A", "B", a, b, "en");
    if (isCompareError(built)) throw new Error(built.error);
    expect(built.text).toMatch(/## Compare: Fact/);
    expect(built.text).toMatch(/\| count \| 3 \| 2 \| -1 \|/);
    expect(built.text).toMatch(/\| sum \| 600(\.00)? \| 200(\.00)? \| -400(\.00)? \|/);
    expect(built.text).toMatch(/\| mean \| 200(\.00)? \| 100(\.00)? \| -100(\.00)? \|/);
    expect(built.text).toMatch(/key column/i);
    expect(built.text).toMatch(/workbook was not changed/i);
  });

  it("fails closed when the column is missing from one sheet", () => {
    const noFact = table(["Company", "Plan"], [["x", 1]], "B");
    const built = buildCompareReport(spec, "A", "B", a, noFact, "en");
    expect(isCompareError(built)).toBe(true);
    if (isCompareError(built)) expect(built.error).toMatch(/"Fact" is not present on: B/);
  });

  it("only reports count / distinct for a non-numeric column", () => {
    const textCol = table(["Company", "Region"], [["x", "N"], ["y", "S"]], "A");
    const textCol2 = table(["Company", "Region"], [["z", "E"]], "B");
    const built = buildCompareReport({ metric: "Region", sheetA: "A", sheetB: "B" }, "A", "B", textCol, textCol2, "en");
    if (isCompareError(built)) throw new Error(built.error);
    expect(built.text).toMatch(/\| distinct \| 2 \| 1 \|/);
    expect(built.text).not.toMatch(/\| sum \|/);
    expect(built.text).toMatch(/not fully numeric/i);
  });
});

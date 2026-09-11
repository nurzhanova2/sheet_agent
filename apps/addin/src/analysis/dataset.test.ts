import { describe, expect, it } from "vitest";
import type { SelectionSnapshot } from "../app/workbook-context.js";
import { buildDataset, excelSerialToISO, isDateNumberFormat } from "./dataset.js";
import { salesSnapshot } from "./__fixtures__/sales-test-data.js";

function snapshot(values: (string | number | null)[][], numberFormats: string[][], headers?: string[]): SelectionSnapshot {
  return {
    sheetName: "S",
    address: "S!A1:C3",
    rowCount: values.length,
    columnCount: values[0]?.length ?? 0,
    totalRowCount: values.length,
    totalColumnCount: values[0]?.length ?? 0,
    totalCellCount: values.length * (values[0]?.length ?? 0),
    values,
    formulas: values.map((row) => row.map(() => null)),
    numberFormats,
    ...(headers ? { headers } : {}),
    truncated: false,
    isEmpty: false,
  };
}

describe("excel date handling", () => {
  it("converts Excel serial dates to ISO", () => {
    expect(excelSerialToISO(46023)).toBe("2026-01-01");
    expect(excelSerialToISO(46114)).toBe("2026-04-02");
    expect(excelSerialToISO(25569)).toBe("1970-01-01");
  });

  it("recognises date number formats but not currency/percent", () => {
    expect(isDateNumberFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateNumberFormat("d/m/yyyy")).toBe(true);
    expect(isDateNumberFormat('[$-409]dddd, mmmm dd, yyyy')).toBe(true);
    expect(isDateNumberFormat("#,##0")).toBe(false);
    expect(isDateNumberFormat("0.0%")).toBe(false);
    expect(isDateNumberFormat('#,##0 "₸"')).toBe(false);
    expect(isDateNumberFormat("mm:ss")).toBe(false);
  });
});

describe("buildDataset", () => {
  it("returns an error when there is no header row", () => {
    const result = buildDataset(snapshot([[1, 2, 3]], [["General", "General", "General"]]));
    expect("error" in result && result.code).toBe("NO_HEADERS");
  });

  it("infers column types and normalises date columns to ISO", () => {
    const dataset = buildDataset(
      snapshot(
        [
          ["Date", "Name", "Amount"],
          [46023, "Alpha", 10],
          [46024, "Beta", 20.5],
        ],
        [
          ["General", "General", "General"],
          ["yyyy-mm-dd", "General", "#,##0"],
          ["yyyy-mm-dd", "General", "#,##0"],
        ],
        ["Date", "Name", "Amount"],
      ),
    );
    if ("error" in dataset) throw new Error(dataset.error);
    expect(dataset.rowCount).toBe(2);
    expect(dataset.columns.map((c) => c.type)).toEqual(["date", "string", "number"]);
    expect(dataset.columns[0]?.text).toEqual(["2026-01-01", "2026-01-02"]);
    expect(dataset.columns[0]?.numeric).toEqual([46023, 46024]); // raw serial preserved
  });

  it("builds the Sales fixture with the expected shape and date column", () => {
    const dataset = buildDataset(salesSnapshot());
    if ("error" in dataset) throw new Error(dataset.error);
    expect(dataset.rowCount).toBe(120);
    expect(dataset.headers).toContain("Variance %");
    const dateColumn = dataset.columns[0];
    expect(dateColumn?.type).toBe("date");
    expect(dateColumn?.text[0]).toBe("2026-01-01");
    expect(dataset.firstDataSheetRow).toBe(2);
    expect(dataset.source).toEqual({ sheetName: "Sales Test Data", address: "Sales Test Data!A1:L121" });
  });
});

import { describe, expect, it } from "vitest";
import type { WorkbookMap, WorkbookMapSheet } from "./workbook-map.js";
import { findStructural, renderSheetsList, renderWorkbookOverview } from "./workbook-report.js";

function sheet(over: Partial<WorkbookMapSheet> & { name: string }): WorkbookMapSheet {
  return {
    visibility: "visible",
    protected: false,
    usedAddress: `${over.name}!A1:L121`,
    rowCount: 121,
    columnCount: 12,
    dataRowCount: 120,
    hasHeaders: true,
    headers: [],
    headersTruncated: false,
    firstColumnLetter: "A",
    tables: [],
    ...over,
  };
}

const MAP: WorkbookMap = {
  sourceIdentity: "https://tenant/Documents/SheetAgent_Test_Data(2).xlsx",
  activeSheet: "Sales Test Data",
  selection: { sheetName: "Sales Test Data", address: "Sales Test Data!A1:L121" },
  truncated: false,
  sheets: [
    sheet({
      name: "Sales Test Data",
      headers: ["Date", "Region", "Manager", "Product", "Category", "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue"],
      tables: [{ name: "SalesTable", address: "Sales Test Data!A1:L121" }],
    }),
    sheet({
      name: "Agent Test",
      usedAddress: "Agent Test!A1:E5",
      rowCount: 5,
      columnCount: 5,
      dataRowCount: 4,
      headers: ["Company", "Plan", "Fact", "Variance", "Comment"],
    }),
    sheet({ name: "Config", visibility: "hidden", usedAddress: null, rowCount: 0, columnCount: 0, dataRowCount: 0, hasHeaders: false }),
  ],
};

describe("renderWorkbookOverview", () => {
  it("is a bounded deterministic overview: sheet count, per-sheet dims and headers", () => {
    const text = renderWorkbookOverview(MAP, "en");
    expect(text).toMatch(/## Workbook/);
    expect(text).toMatch(/3 worksheets \(1 hidden\)/);
    expect(text).toMatch(/SheetAgent_Test_Data\(2\)\.xlsx/);
    expect(text).toMatch(/### Sales Test Data\n120 data rows × 12 columns/);
    expect(text).toMatch(/Date, Region, Manager/);
    expect(text).toMatch(/### Agent Test\n4 data rows × 5 columns/);
    expect(text).toMatch(/Company, Plan, Fact, Variance, Comment/);
    expect(text).toMatch(/### Config \(hidden\)\nempty/);
    // no cell dump
    expect(text).not.toMatch(/\t/);
  });
});

describe("renderSheetsList", () => {
  it("lists every worksheet with its dimensions and no model call", () => {
    const text = renderSheetsList(MAP, "en");
    expect(text).toMatch(/## Sheets/);
    expect(text).toMatch(/- Sales Test Data — 120 data rows × 12 columns/);
    expect(text).toMatch(/- Agent Test — 4 data rows × 5 columns/);
    expect(text).toMatch(/- Config — empty — hidden/);
  });
});

describe("findStructural", () => {
  it("finds a header across sheets with its column letter", () => {
    const text = findStructural(MAP, "Plan", "en");
    expect(text).toMatch(/Found "Plan" in 2 places:/);
    expect(text).toMatch(/- Sales Test Data — column F \(Plan\)/);
    expect(text).toMatch(/- Agent Test — column B \(Plan\)/);
  });

  it("matches worksheet and table names too", () => {
    expect(findStructural(MAP, "Agent", "en")).toMatch(/worksheet "Agent Test"/);
    expect(findStructural(MAP, "SalesTable", "en")).toMatch(/table "SalesTable" on Sales Test Data/);
  });

  it("says so when there is no structural match", () => {
    expect(findStructural(MAP, "Zzz", "en")).toMatch(/was not found/);
  });
});

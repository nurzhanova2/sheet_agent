import { describe, expect, it, vi } from "vitest";
import type { RangeSnapshot, SelectionInfo, WorkbookOverview } from "@sheet-agent/application";
import {
  buildWorkbookMap,
  headerRowAddress,
  MAX_HEADER_SHEETS,
  shapeWorkbookMap,
} from "./workbook-map.js";

const OVERVIEW: WorkbookOverview = {
  sourceIdentity: "https://tenant/Documents/SheetAgent_Test_Data(2).xlsx",
  sheets: [
    { name: "Sales Test Data", visibility: "visible", protected: false, usedRange: { address: "Sales Test Data!A1:L121", rowCount: 121, columnCount: 12 } },
    { name: "Agent Test", visibility: "visible", protected: false, usedRange: { address: "Agent Test!A1:E5", rowCount: 5, columnCount: 5 } },
    { name: "Config", visibility: "hidden", protected: true },
  ],
  tables: [{ name: "SalesTable", sheetName: "Sales Test Data", address: "Sales Test Data!A1:L121" }],
  namedRanges: [],
  charts: [],
  pivots: [],
};

const SELECTION: SelectionInfo = { address: "Agent Test!A1:E5", sheetName: "Agent Test", rowCount: 5, columnCount: 5, revision: 0 };

const HEADERS: Record<string, string[]> = {
  "Sales Test Data": ["Date", "Region", "Manager", "Product", "Category", "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue"],
  "Agent Test": ["Company", "Plan", "Fact", "Variance", "Comment"],
};

function headerRows() {
  const map = new Map<string, { cells: readonly unknown[]; moreColumns: boolean }>();
  for (const [name, cells] of Object.entries(HEADERS)) map.set(name, { cells, moreColumns: false });
  return map;
}

describe("headerRowAddress", () => {
  it("returns the first row of a used range, capped at maxColumns", () => {
    expect(headerRowAddress("Sales Test Data!A1:L121", 64)).toBe("Sales Test Data!A1:L1");
    expect(headerRowAddress("Sales Test Data!A1:L121", 5)).toBe("Sales Test Data!A1:E1");
    expect(headerRowAddress("Data!C3:C9", 64)).toBe("Data!C3");
  });
});

describe("shapeWorkbookMap", () => {
  it("shapes sheets with dimensions, headers, data-row counts, tables and the active sheet", () => {
    const map = shapeWorkbookMap(OVERVIEW, SELECTION, headerRows(), false);
    expect(map.sheets.map((s) => s.name)).toEqual(["Sales Test Data", "Agent Test", "Config"]);
    const sales = map.sheets[0]!;
    expect(sales.rowCount).toBe(121);
    expect(sales.columnCount).toBe(12);
    expect(sales.dataRowCount).toBe(120);
    expect(sales.hasHeaders).toBe(true);
    expect(sales.headers).toEqual(HEADERS["Sales Test Data"]);
    expect(sales.tables.map((t) => t.name)).toEqual(["SalesTable"]);
    const config = map.sheets[2]!;
    expect(config.usedAddress).toBeNull();
    expect(config.rowCount).toBe(0);
    expect(config.hasHeaders).toBe(false);
    expect(map.activeSheet).toBe("Agent Test");
    expect(map.selection).toEqual({ sheetName: "Agent Test", address: "Agent Test!A1:E5" });
  });

  it("treats a non-text first row as no-headers and keeps rowCount as dataRowCount", () => {
    const rows = new Map<string, { cells: readonly unknown[]; moreColumns: boolean }>([
      ["Agent Test", { cells: [1, 2, 3, 4, 5], moreColumns: false }],
    ]);
    const map = shapeWorkbookMap(OVERVIEW, null, rows, false);
    const agent = map.sheets[1]!;
    expect(agent.hasHeaders).toBe(false);
    expect(agent.headers).toEqual([]);
    expect(agent.dataRowCount).toBe(5);
  });

  it("marks headersTruncated when the header row was wider than the read", () => {
    const rows = new Map<string, { cells: readonly unknown[]; moreColumns: boolean }>([
      ["Sales Test Data", { cells: HEADERS["Sales Test Data"]!, moreColumns: true }],
    ]);
    const map = shapeWorkbookMap(OVERVIEW, null, rows, true);
    expect(map.sheets[0]!.headersTruncated).toBe(true);
    expect(map.truncated).toBe(true);
  });
});

describe("buildWorkbookMap", () => {
  it("reads the overview + one bounded header row per visible sheet, and never a full sheet", async () => {
    const readRange = vi.fn(async (address: string): Promise<RangeSnapshot> => {
      const sheet = address.slice(0, address.indexOf("!"));
      return {
        address,
        sheetName: sheet,
        rowCount: 1,
        columnCount: HEADERS[sheet]?.length ?? 0,
        revision: 0,
        values: [HEADERS[sheet] ?? []],
        formulas: [[]],
        numberFormats: [[]],
      };
    });
    const port = {
      capabilities: { tables: true, charts: true, pivotTables: true, namedRanges: true },
      getSelection: vi.fn(async () => SELECTION),
      readRange,
      getWorkbookOverview: vi.fn(async () => OVERVIEW),
      readTable: vi.fn(),
      search: vi.fn(),
      onSelectionChanged: vi.fn(() => () => undefined),
    } as never;

    const map = await buildWorkbookMap(port);
    expect(map.sheets[0]!.headers[0]).toBe("Date");
    expect(map.sheets[1]!.headers).toEqual(HEADERS["Agent Test"]);
    // exactly one read per visible sheet with a used range (2), each a single row
    expect(readRange).toHaveBeenCalledTimes(2);
    for (const call of readRange.mock.calls) expect(String(call[0])).toMatch(/!\w+1(:\w+1)?$/);
    expect(MAX_HEADER_SHEETS).toBeGreaterThan(2);
  });
});

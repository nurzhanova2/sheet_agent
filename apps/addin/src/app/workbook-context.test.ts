import { describe, expect, it, vi } from "vitest";
import type { ExcelPort } from "@sheet-agent/application";
import { clampSelection, readSelectionSnapshot, SELECTION_LIMITS } from "./workbook-context.js";

function portWith(options: {
  address: string;
  rowCount: number;
  columnCount: number;
  values: unknown[][];
  formulas?: unknown[][];
  numberFormats?: string[][];
}): ExcelPort & { readRange: ReturnType<typeof vi.fn> } {
  const readRange = vi.fn(async (address: string) => ({
    address,
    sheetName: options.address.split("!")[0] ?? "Sheet1",
    rowCount: options.values.length,
    columnCount: options.values[0]?.length ?? 0,
    revision: 0,
    values: options.values,
    formulas: options.formulas ?? options.values,
    numberFormats: options.numberFormats ?? options.values.map((row) => row.map(() => "General")),
  }));
  return {
    capabilities: { tables: true, charts: true, pivotTables: true, namedRanges: true },
    getSelection: vi.fn(async () => ({ address: options.address, sheetName: options.address.split("!")[0] ?? "Sheet1", rowCount: options.rowCount, columnCount: options.columnCount, revision: 0 })),
    readRange,
    getWorkbookOverview: vi.fn(),
    readTable: vi.fn(),
    search: vi.fn(async () => []),
    onSelectionChanged: vi.fn(() => () => undefined),
  } as unknown as ExcelPort & { readRange: ReturnType<typeof vi.fn> };
}

describe("clampSelection", () => {
  it("does not truncate a small selection", () => {
    expect(clampSelection(10, 4)).toEqual({ rowCount: 10, columnCount: 4, truncated: false });
  });
  it("truncates by rows, columns and total cells", () => {
    expect(clampSelection(5_000, 6, SELECTION_LIMITS)).toEqual({ rowCount: 200, columnCount: 6, truncated: true });
    expect(clampSelection(10, 80, SELECTION_LIMITS)).toEqual({ rowCount: 10, columnCount: 30, truncated: true });
    const big = clampSelection(4_000, 40, SELECTION_LIMITS);
    expect(big.columnCount).toBe(30);
    expect(big.rowCount).toBe(100); // 3000 cells / 30 columns
    expect(big.truncated).toBe(true);
  });
});

describe("readSelectionSnapshot", () => {
  it("reads the actual selected values and derives headers", async () => {
    const port = portWith({
      address: "Sales!A1:C3",
      rowCount: 3,
      columnCount: 3,
      values: [
        ["Bank", "Plan", "Fact"],
        ["Alpha", 100, 90],
        ["Beta", 200, 260],
      ],
      formulas: [
        ["Bank", "Plan", "Fact"],
        ["Alpha", 100, 90],
        ["Beta", 200, "=B3*1.3"],
      ],
    });
    const snapshot = await readSelectionSnapshot(port);
    expect(snapshot.values[1]).toEqual(["Alpha", 100, 90]);
    expect(snapshot.headers).toEqual(["Bank", "Plan", "Fact"]);
    expect(snapshot.formulas[2]?.[2]).toBe("=B3*1.3");
    expect(snapshot.formulas[1]?.[0]).toBeNull();
    expect(snapshot.truncated).toBe(false);
    expect(port.readRange).toHaveBeenCalledWith("Sales!A1:C3");
  });

  it("carries per-cell number formats through to the snapshot (needed for date detection)", async () => {
    const port = portWith({
      address: "Sales!A1:B3",
      rowCount: 3,
      columnCount: 2,
      values: [
        ["Date", "Amount"],
        [46023, 10],
        [46024, 20],
      ],
      numberFormats: [
        ["General", "General"],
        ["yyyy-mm-dd", "#,##0"],
        ["yyyy-mm-dd", "#,##0"],
      ],
    });
    const snapshot = await readSelectionSnapshot(port);
    expect(snapshot.numberFormats[1]).toEqual(["yyyy-mm-dd", "#,##0"]);
  });

  it("truncates a huge selection to the limits, reads only that block, and reports it", async () => {
    const rows = Array.from({ length: 40 }, (_, r) => Array.from({ length: 30 }, (_, c) => r * 100 + c));
    const port = portWith({ address: "Data!A1:BZ9000", rowCount: 9_000, columnCount: 60, values: rows });
    const snapshot = await readSelectionSnapshot(port);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncationNote).toContain("9000 rows x 60 columns");
    expect(snapshot.columnCount).toBe(30);
    expect(port.readRange).toHaveBeenCalledTimes(1);
    const requested = port.readRange.mock.calls[0]?.[0] as string;
    expect(requested).toBe("Data!A1:AD100"); // 30 cols, 100 rows (3000-cell budget)
  });
});

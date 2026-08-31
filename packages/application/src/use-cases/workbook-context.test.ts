import { describe, expect, it, vi } from "vitest";
import { WorkbookContextManager, stableWorkbookId, type ExcelPort, type SelectionInfo } from "../index.js";

function selection(address = "Sales!A1:B3", revision = 1): SelectionInfo {
  const [, cells = "A1"] = address.split("!");
  const [start = "A1", end = start] = cells.split(":");
  const row = (cell: string) => Number(/\d+/.exec(cell)?.[0] ?? 1);
  const column = (cell: string) => (cell.charCodeAt(0) || 65) - 64;
  return { address, sheetName: "Sales", rowCount: row(end) - row(start) + 1, columnCount: column(end) - column(start) + 1, revision };
}

function mockPort(): ExcelPort & { emitSelection(address: string): void } {
  let current = selection();
  const listeners = new Set<(value: SelectionInfo) => void>();
  return {
    capabilities: { tables: true, charts: true, pivotTables: true, namedRanges: true },
    getSelection: async () => current,
    readRange: async () => { throw new Error("not used"); },
    getWorkbookOverview: async () => { throw new Error("not used"); },
    readTable: async () => { throw new Error("not used"); },
    search: async () => [],
    onSelectionChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    emitSelection(address) { current = selection(address, current.revision + 1); for (const listener of listeners) listener(current); },
  };
}

describe("WorkbookContextManager", () => {
  it("creates a stable privacy-preserving workbook identity", async () => {
    await expect(stableWorkbookId("https://tenant/Documents/Q3.xlsx", "tenant-a")).resolves.toBe(
      await stableWorkbookId("https://tenant/Documents/Q3.xlsx", "tenant-a"),
    );
    expect(await stableWorkbookId("https://tenant/Documents/Q3.xlsx", "tenant-a")).not.toBe(
      await stableWorkbookId("https://tenant/Documents/Q3.xlsx", "tenant-b"),
    );
  });

  it("debounces selection events and publishes the latest lightweight context", async () => {
    vi.useFakeTimers();
    const port = mockPort();
    const manager = new WorkbookContextManager(port, { debounceMs: 50 });
    const listener = vi.fn();
    manager.subscribe(listener);
    await manager.start();

    port.emitSelection("Sales!C3");
    port.emitSelection("Sales!D4:E5");
    await vi.advanceTimersByTimeAsync(50);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ selection: { address: "Sales!D4:E5", rowCount: 2, columnCount: 2 } }));
    manager.dispose();
    vi.useRealTimers();
  });
});

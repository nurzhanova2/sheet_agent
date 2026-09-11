import { describe, expect, it } from "vitest";
import type { SelectionSnapshot } from "../app/workbook-context.js";
import { buildDataset } from "./dataset.js";
import { runAnalysis } from "./engine.js";
import { isAnalysisError, type AnalysisRequest } from "./types.js";

function syntheticSnapshot(rows: number, columns: number): SelectionSnapshot {
  const headers = Array.from({ length: columns }, (_, c) => (c === 0 ? "Region" : c === 1 ? "Category" : `N${c}`));
  const regions = ["Almaty", "Astana", "Aktobe", "Shymkent", "Karaganda"];
  const cats = ["A", "B", "C"];
  const body = Array.from({ length: rows }, (_, r) =>
    headers.map((_h, c) => (c === 0 ? regions[r % regions.length]! : c === 1 ? cats[r % cats.length]! : (r * 7 + c * 13) % 500)),
  );
  const values: (string | number)[][] = [headers, ...body];
  return {
    sheetName: "Perf",
    address: `Perf!A1:${String.fromCharCode(64 + columns)}${rows + 1}`,
    rowCount: values.length,
    columnCount: columns,
    totalRowCount: rows + 1,
    totalColumnCount: columns,
    totalCellCount: (rows + 1) * columns,
    values,
    formulas: values.map((row) => row.map(() => null)),
    numberFormats: values.map((row) => row.map(() => "General")),
    headers,
    truncated: false,
    isEmpty: false,
  };
}

describe("analysis engine performance", () => {
  const cases: { label: string; rows: number; columns: number }[] = [
    { label: "100 rows × 12 cols", rows: 100, columns: 12 },
    { label: "1000 rows × 12 cols", rows: 1_000, columns: 12 },
    { label: "3000 cells (250 rows × 12 cols)", rows: 250, columns: 12 },
  ];

  for (const { label, rows, columns } of cases) {
    it(`is effectively instantaneous for ${label}`, () => {
      const dataset = buildDataset(syntheticSnapshot(rows, columns));
      if ("error" in dataset) throw new Error(dataset.error);

      const requests: AnalysisRequest[] = [
        { op: "top_n", n: 10, by: { kind: "abs", value: { kind: "subtract", left: { kind: "column", name: "N2" }, right: { kind: "column", name: "N3" } } } },
        { op: "group_by", by: ["Region", "Category"], metrics: [{ metric: "count", name: "n" }, { metric: "mean", name: "avg", target: { kind: "column", name: "N2" } }] },
        { op: "summary_statistics" },
        { op: "correlation", x: { kind: "column", name: "N2" }, y: { kind: "column", name: "N3" } },
        { op: "outliers", target: { kind: "column", name: "N4" }, method: "iqr" },
      ];

      const started = performance.now();
      for (const request of requests) {
        const outcome = runAnalysis(dataset, request);
        expect(isAnalysisError(outcome)).toBe(false);
      }
      const elapsedMs = performance.now() - started;
      const heap = (globalThis as { process?: { memoryUsage(): { heapUsed: number } } }).process?.memoryUsage().heapUsed ?? 0;
      console.info(JSON.stringify({ fixture: "analysis-perf", label, rows, columns, requests: requests.length, elapsedMs: Number(elapsedMs.toFixed(3)), heapUsedBytes: heap }));
      expect(elapsedMs).toBeLessThan(150); // whole batch, generous CI bound
    });
  }
});

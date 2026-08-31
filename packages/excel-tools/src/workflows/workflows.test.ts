import { describe, expect, it } from "vitest";
import { ChangeSetService } from "@sheet-agent/changes";
import { WorkflowEngine, type WorkflowPort } from "./index.js";

const port: WorkflowPort = {
  capabilities: { tables: true, charts: true, pivots: false },
  readRange: async () => ({ address: "Sales!A1:C4", sheetName: "Sales", rowCount: 4, columnCount: 3, revision: 1, values: [["name", "amount", "region"], [" A ", "1 000,5", "KZ"], ["A", "1000.5", "KZ"], ["B", "bad", "RU"]], formulas: [[], [], [], []], numberFormats: [] }),
  writeRange: async () => undefined,
  restoreRange: async () => undefined,
  recalculate: async () => undefined,
};

describe("Excel workflow planners", () => {
  it("creates a formula ChangeSet with locale-safe relative formulas", async () => {
    const engine = new WorkflowEngine(new ChangeSetService(port), port);
    const change = await engine.formulaAssist({ range: "Sales!D2:D4", formulas: [["=A2+B2"], [""], ["=A4+B4"]], mode: "fill" });
    expect(change.description).toContain("formula");
    expect(change.operations[0]).toMatchObject({ type: "set-formulas", risk: "low" });
    expect(change.operations[0]?.after).toEqual([["=A2+B2"], ["=A3+B3"], ["=A4+B4"]]);
  });

  it("builds a cleaning ChangeSet and marks duplicate removal high risk", async () => {
    const engine = new WorkflowEngine(new ChangeSetService(port), port);
    const change = await engine.clean({ range: "Sales!A1:C4", values: [["name", "amount", "region"], [" A ", "1 000,5", "KZ"], ["A", "1000.5", "KZ"], ["B", "bad", "RU"]], trim: true, normalizeNumbers: true, removeDuplicates: true });
    expect(change.operations[0]).toMatchObject({ type: "clean-values" });
    expect(change.risk).toBe("high");
    expect((change.operations[0]?.after as unknown[][])[1]?.[0]).toBe("A");
  });

  it("plans sorting and native table/chart operations while refusing unsupported pivots", async () => {
    const engine = new WorkflowEngine(new ChangeSetService(port), port);
    const sort = await engine.sort({ range: "Sales!A2:B4", values: [["B", 3], ["A", 1], ["C", 2]], column: 1, direction: "asc" });
    expect(sort.operations[0]?.type).toBe("sort-range");
    const table = await engine.createTable({ range: "Sales!A1:C4", name: "Orders" });
    const chart = await engine.createChart({ range: "Sales!A1:B4", title: "Revenue" });
    expect(table.operations[0]?.type).toBe("create-table"); expect(chart.operations[0]?.type).toBe("create-chart");
    await expect(engine.createPivot({ range: "Sales!A1:C4", name: "Pivot" })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("composes multi-step reporting into one explainable ChangeSet", async () => {
    const engine = new WorkflowEngine(new ChangeSetService(port), port);
    const report = await engine.report({ range: "Sales!A1:C4", steps: ["clean", "chart"] });
    expect(report.operations.map((operation) => operation.type)).toEqual(["clean-values", "create-chart"]);
    expect(report.description).toContain("report");
  });
});

import { describe, expect, it, vi } from "vitest";
import { ChangeSetService, diffSnapshots, type WritableExcelPort } from "./index.js";
import type { RangeSnapshot } from "@sheet-agent/application";

function snapshot(values: unknown[][], revision = 1): RangeSnapshot {
  return { address: "Sales!A1:B2", sheetName: "Sales", rowCount: values.length, columnCount: values[0]?.length ?? 0, revision, values: values as RangeSnapshot["values"], formulas: values as RangeSnapshot["formulas"], numberFormats: values.map((row) => row.map(() => "General")) };
}

function fakePort(initial = snapshot([[1, 2], [3, 4]])): WritableExcelPort & { state: RangeSnapshot } {
  let state = initial;
  return {
    get state() { return state; },
    readRange: vi.fn(async () => state),
    writeRange: vi.fn(async (_address, values) => { state = snapshot(values as unknown[][], state.revision + 1); }),
    restoreRange: vi.fn(async (_address, before) => { state = before; }),
    recalculate: vi.fn(async () => undefined),
  };
}

describe("ChangeSetService", () => {
  it("builds bounded cell diff and never writes before approval", async () => {
    const port = fakePort();
    const service = new ChangeSetService(port);
    const proposal = await service.propose({ description: "Update revenue", target: { sheet: "Sales", address: "Sales!A1:B2" }, before: port.state.values, after: [[10, 2], [3, 4]], risk: "low" });
    expect(diffSnapshots(port.state.values, [[10, 2], [3, 4]], 10)).toEqual([{ row: 1, column: 1, before: 1, after: 10 }]);
    expect(proposal.status).toBe("proposed");
    expect(port.writeRange).not.toHaveBeenCalled();
  });

  it("requires explicit approval and destructive confirmation", async () => {
    const port = fakePort(); const service = new ChangeSetService(port);
    const proposal = await service.propose({ description: "Delete rows", target: { sheet: "Sales", address: "Sales!A1:B2" }, before: port.state.values, after: [], risk: "high" });
    await expect(service.apply(proposal.id)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(service.approve(proposal.id)).rejects.toMatchObject({ code: "DESTRUCTIVE_CONFIRMATION_REQUIRED" });
    await service.approve(proposal.id, { destructiveConfirmed: true });
    expect((await service.get(proposal.id))?.status).toBe("approved");
  });

  it("detects optimistic concurrency conflicts and keeps workbook untouched", async () => {
    const port = fakePort(); const service = new ChangeSetService(port);
    const proposal = await service.propose({ description: "Change", target: { sheet: "Sales", address: "Sales!A1:B2" }, before: port.state.values, after: [[9, 2], [3, 4]], risk: "low" });
    await service.approve(proposal.id);
    await port.writeRange("Sales!A1:B2", [[99, 2], [3, 4]]);
    await expect(service.apply(proposal.id)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("applies idempotently, verifies, and supports undo", async () => {
    const port = fakePort(); const service = new ChangeSetService(port);
    const proposal = await service.propose({ description: "Change", target: { sheet: "Sales", address: "Sales!A1:B2" }, before: port.state.values, after: [[9, 2], [3, 4]], risk: "low" });
    await service.approve(proposal.id); const first = await service.apply(proposal.id); const second = await service.apply(proposal.id);
    expect(first.status).toBe("committed"); expect(second.status).toBe("committed"); expect(port.writeRange).toHaveBeenCalledTimes(1);
    await service.undo(proposal.id); expect(port.state.values).toEqual([[1, 2], [3, 4]]);
  });

  it("rolls back all applied operations after verification failure", async () => {
    const port = fakePort(); port.readRange = vi.fn().mockResolvedValueOnce(port.state).mockResolvedValueOnce(snapshot([[7, 2], [3, 4]]));
    const service = new ChangeSetService(port);
    const proposal = await service.propose({ description: "Bad write", target: { sheet: "Sales", address: "Sales!A1:B2" }, before: port.state.values, after: [[8, 2], [3, 4]], risk: "low" });
    await service.approve(proposal.id);
    await expect(service.apply(proposal.id)).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(port.restoreRange).toHaveBeenCalled(); expect((await service.get(proposal.id))?.status).toBe("rolled_back");
  });
});

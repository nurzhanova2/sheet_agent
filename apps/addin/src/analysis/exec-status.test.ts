import { describe, expect, it } from "vitest";
import { runAnalysisBatch } from "./index.js";
import { salesSnapshot } from "./__fixtures__/sales-test-data.js";

const snapshot = salesSnapshot();

// §3 — fail closed. A rejected operation must be reported as such; the model may
// not silently backfill it.
describe("§3 runAnalysisBatch — fail-closed execution status", () => {
  it("status 'complete' with no rejected list when every op succeeds", () => {
    const batch = runAnalysisBatch(snapshot, [
      { op: "count" },
      { op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "n" }] },
    ]);
    expect(batch.status).toBe("complete");
    expect(batch.rejected).toHaveLength(0);
    expect(batch.text).not.toMatch(/EXECUTION STATUS/);
  });

  it("status 'partial' + an EXECUTION STATUS banner when one op is rejected", () => {
    const batch = runAnalysisBatch(snapshot, [
      { op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "n" }] },
      { op: "aggregate", metric: "mean", target: { kind: "column", name: "NoSuchColumn" } },
    ]);
    expect(batch.status).toBe("partial");
    expect(batch.rejected).toHaveLength(1);
    expect(batch.rejected[0]?.index).toBe(1);
    expect(batch.text).toMatch(/EXECUTION STATUS: PARTIAL/);
    expect(batch.text).toMatch(/MUST NOT compute a rejected result/i);
    expect(batch.text).toMatch(/operation #2 \[UNKNOWN_COLUMN\]/);
  });

  it("status 'failed' when every executed op is rejected", () => {
    const batch = runAnalysisBatch(snapshot, [
      { op: "aggregate", metric: "mean", target: { kind: "column", name: "Nope" } },
      { op: "group_by", by: ["Nope"], metrics: [{ metric: "count" }] },
    ]);
    expect(batch.status).toBe("failed");
    expect(batch.rejected).toHaveLength(2);
    expect(batch.text).toMatch(/EXECUTION STATUS: FAILED/);
  });
});

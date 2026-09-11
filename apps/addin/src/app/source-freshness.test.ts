import { describe, expect, it, vi } from "vitest";
import { gridChecksum, revalidateSource, revalidateSources, sourceVersionOf } from "./source-freshness.js";
import type { ExcelPort } from "@sheet-agent/application";

const SNAP = {
  totalRowCount: 4,
  totalColumnCount: 3,
  address: "Sales!A1:C4",
  values: [["Region", "Plan", "Fact"], ["N", 100, 90], ["S", 100, 200], ["N", 100, 130]],
};

function portReturning(values: unknown): ExcelPort {
  return {
    readRange: vi.fn(async (address: string) => ({
      address,
      sheetName: address.split("!")[0],
      rowCount: 4,
      columnCount: 3,
      revision: 0,
      values,
      formulas: (values as unknown[][]).map((r) => r.map(() => null)),
      numberFormats: (values as unknown[][]).map((r) => r.map(() => "General")),
    })),
  } as unknown as ExcelPort;
}

describe("source-freshness", () => {
  it("sourceVersionOf is stable for the same grid and changes with the values", () => {
    const a = sourceVersionOf(SNAP);
    const b = sourceVersionOf({ ...SNAP, values: [["Region", "Plan", "Fact"], ["N", 100, 90], ["S", 100, 200], ["N", 100, 999]] });
    expect(a).toBe(sourceVersionOf(SNAP));
    expect(a).not.toBe(b);
    expect(a).toContain("4x3@Sales!A1:C4#");
  });

  it("gridChecksum is order-sensitive", () => {
    expect(gridChecksum([[1, 2]])).not.toBe(gridChecksum([[2, 1]]));
  });

  it("revalidateSource → fresh when the re-read matches the stored version", async () => {
    const port = portReturning(SNAP.values);
    expect(await revalidateSource(port, "Sales!A1:C4", sourceVersionOf(SNAP))).toBe("fresh");
  });

  it("revalidateSource → changed when the underlying values differ", async () => {
    const port = portReturning([["Region", "Plan", "Fact"], ["N", 1, 1], ["S", 1, 1], ["N", 1, 1]]);
    expect(await revalidateSource(port, "Sales!A1:C4", sourceVersionOf(SNAP))).toBe("changed");
  });

  it("revalidateSource → unverifiable when the range cannot be read", async () => {
    const port = { readRange: vi.fn(async () => { throw new Error("no such sheet"); }) } as unknown as ExcelPort;
    expect(await revalidateSource(port, "Ghost!A1:C4", "v")).toBe("unverifiable");
    expect(await revalidateSource(port, "", "v")).toBe("unverifiable");
  });

  // 24.4.4 §11 — a multi-source agent result
  const A = { totalRowCount: 2, totalColumnCount: 2, address: "P 2024!A1:B2", values: [["Sector", "NPL"], ["Corp", 0.04]] };
  const B = { totalRowCount: 2, totalColumnCount: 2, address: "P 2025!A1:B2", values: [["Sector", "NPL"], ["Corp", 0.06]] };
  function multiPort(byAddr: Record<string, unknown[][]>): ExcelPort {
    return {
      readRange: vi.fn(async (address: string) => {
        const v = byAddr[address];
        if (!v) throw new Error(`no ${address}`);
        return { address, sheetName: address.split("!")[0], rowCount: v.length, columnCount: 2, revision: 0, values: v, formulas: v.map((r) => r.map(() => null)), numberFormats: v.map((r) => r.map(() => "General")) };
      }),
    } as unknown as ExcelPort;
  }

  it("revalidateSources → fresh only when EVERY source matches", async () => {
    const port = multiPort({ "P 2024!A1:B2": A.values, "P 2025!A1:B2": B.values });
    const sources = [
      { sourceRange: "P 2024!A1:B2", version: sourceVersionOf(A) },
      { sourceRange: "P 2025!A1:B2", version: sourceVersionOf(B) },
    ];
    expect(await revalidateSources(port, sources)).toBe("fresh");
  });

  it("revalidateSources → changed when one source moved", async () => {
    const port = multiPort({ "P 2024!A1:B2": A.values, "P 2025!A1:B2": [["Sector", "NPL"], ["Corp", 0.09]] });
    const sources = [
      { sourceRange: "P 2024!A1:B2", version: sourceVersionOf(A) },
      { sourceRange: "P 2025!A1:B2", version: sourceVersionOf(B) },
    ];
    expect(await revalidateSources(port, sources)).toBe("changed");
  });

  it("revalidateSources → unverifiable on an empty list", async () => {
    expect(await revalidateSources(multiPort({}), [])).toBe("unverifiable");
  });
});

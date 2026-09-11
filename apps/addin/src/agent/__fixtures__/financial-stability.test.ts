import { describe, expect, it } from "vitest";
import { runAnalysisBatch } from "../../analysis/index.js";
import { isAnalysisError } from "../../analysis/types.js";
import {
  FS_HEADERS,
  FS_SHEETS,
  financialStabilityDeps,
  financialStabilitySnapshot,
  financialStabilityWorkbookMap,
} from "./financial-stability.js";

function meanBySector(sheet: Parameters<typeof financialStabilitySnapshot>[0], column: string): Map<string, number> {
  const snap = financialStabilitySnapshot(sheet);
  const batch = runAnalysisBatch(snap, [
    { op: "group_by", by: ["Sector"], metrics: [{ name: "m", metric: "mean", target: { kind: "column", name: column } }] },
  ]);
  const outcome = batch.outcomes[0]!;
  if (isAnalysisError(outcome)) throw new Error(outcome.error);
  return new Map((outcome.groups ?? []).map((g) => [g.key["Sector"]!, g.metrics["m"] ?? 0]));
}

describe("financial-stability fixture", () => {
  it("has four schema-compatible sheets with the documented headers", () => {
    expect(FS_SHEETS).toEqual(["Portfolio 2024", "Portfolio 2025", "Deposits 2024", "Deposits 2025"]);
    const snap = financialStabilitySnapshot("Portfolio 2024");
    expect(snap.headers).toEqual([...FS_HEADERS]);
    expect(snap.rowCount).toBe(25);
    expect(snap.columnCount).toBe(9);
    expect(snap.values[0]).toEqual([...FS_HEADERS]);
  });

  it("Corporate deteriorates the most from 2024 to 2025 (NPL Rate and PD)", () => {
    const rate2024 = meanBySector("Portfolio 2024", "NPL Rate");
    const rate2025 = meanBySector("Portfolio 2025", "NPL Rate");
    const pd2024 = meanBySector("Portfolio 2024", "PD");
    const pd2025 = meanBySector("Portfolio 2025", "PD");

    const rateDelta = (s: string) => rate2025.get(s)! - rate2024.get(s)!;
    const pdDelta = (s: string) => pd2025.get(s)! - pd2024.get(s)!;
    for (const sector of ["Retail", "SME", "Mortgage"]) {
      expect(rateDelta("Corporate")).toBeGreaterThan(rateDelta(sector));
      expect(pdDelta("Corporate")).toBeGreaterThan(pdDelta(sector));
    }
  });

  it("Deposits stay broadly stable year over year", () => {
    const d2024 = meanBySector("Deposits 2024", "NPL Rate");
    const d2025 = meanBySector("Deposits 2025", "NPL Rate");
    for (const [sector, v] of d2024) {
      expect(Math.abs(d2025.get(sector)! - v)).toBeLessThan(0.01);
    }
  });

  it("drop2025PortfolioNplRate removes the column from 2025 only", () => {
    const p2025 = financialStabilitySnapshot("Portfolio 2025", { drop2025PortfolioNplRate: true });
    const p2024 = financialStabilitySnapshot("Portfolio 2024", { drop2025PortfolioNplRate: true });
    expect(p2025.headers).not.toContain("NPL Rate");
    expect(p2024.headers).toContain("NPL Rate");
  });

  it("ambiguousPd adds a second PD-like column across every sheet", () => {
    for (const sheet of FS_SHEETS) {
      const snap = financialStabilitySnapshot(sheet, { ambiguousPd: true });
      expect(snap.headers).toContain("PD");
      expect(snap.headers).toContain("PD 12M");
    }
    const map = financialStabilityWorkbookMap({ ambiguousPd: true });
    expect(map.sheets[0]!.headers).toContain("PD 12M");
  });

  it("financialStabilityDeps resolves sheet names and runs the real engine", async () => {
    const deps = financialStabilityDeps();
    const ok = await deps.sheetSnapshot("portfolio 2025");
    expect(ok.kind).toBe("ok");
    const ambiguous = await deps.sheetSnapshot("Portfolio");
    expect(ambiguous.kind).toBe("ambiguous");
    const missing = await deps.sheetSnapshot("Ledger");
    expect(missing.kind).toBe("not_found");
  });
});

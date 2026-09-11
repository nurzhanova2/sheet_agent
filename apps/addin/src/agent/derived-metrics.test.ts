import { describe, expect, it } from "vitest";
import { deriveMetric } from "./derived-metrics.js";

const grid = {
  columns: ["Sector", "NPL Rate 2024", "NPL Rate 2025", "Note"],
  rows: [
    ["Corporate", 0.04, 0.061, "ok"],
    ["Retail", 0.03, 0.0314, "ok"],
    ["SME", 0.06, 0, "zero"],
    ["Mortgage", 0.02, null, "n/a"],
  ] as (readonly (string | number | null)[])[],
};

const col = (r: { ok: true; grid: { rows: readonly (readonly unknown[])[] } }, i: number) => r.grid.rows.map((row) => row[i]);

describe("deriveMetric", () => {
  it("subtract / pp_change", () => {
    const r = deriveMetric(grid, { left: "NPL Rate 2025", operator: "pp_change", right: "NPL Rate 2024", output: "Δ pp" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(col(r, 4)).toEqual([expect.closeTo(0.021, 6), expect.closeTo(0.0014, 6), expect.closeTo(-0.06, 6), null]);
  });

  it("addition", () => {
    const r = deriveMetric(grid, { left: "NPL Rate 2024", operator: "add", right: "NPL Rate 2025", output: "sum" });
    expect(r.ok && (r.grid.rows[0]![4] as number)).toBeCloseTo(0.101, 6);
  });

  it("division and divide-by-zero → null", () => {
    const r = deriveMetric(grid, { left: "NPL Rate 2025", operator: "divide", right: "NPL Rate 2024", output: "ratio" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.grid.rows[0]![4] as number).toBeCloseTo(1.525, 3);
      // SME 2024 is 0.06 (non-zero) so this row divides fine; use a zero denominator explicitly:
    }
    const z = deriveMetric(grid, { left: "NPL Rate 2024", operator: "divide", right: "NPL Rate 2025", output: "r2" });
    expect(z.ok && z.grid.rows[2]![4]).toBeNull(); // SME 2025 == 0
  });

  it("percentage change (A - B)/B", () => {
    const r = deriveMetric(grid, { left: "NPL Rate 2025", operator: "pct_change", right: "NPL Rate 2024", output: "%Δ" });
    expect(r.ok && (r.grid.rows[0]![4] as number)).toBeCloseTo(0.525, 3);
    expect(r.ok && r.grid.rows[3]![4]).toBeNull(); // Mortgage 2025 null
  });

  it("absolute delta", () => {
    const r = deriveMetric(grid, { left: "NPL Rate 2024", operator: "abs_diff", right: "NPL Rate 2025", output: "|Δ|" });
    expect(r.ok && (r.grid.rows[2]![4] as number)).toBeCloseTo(0.06, 6); // |0.06 - 0|
  });

  it("scalar right-hand side", () => {
    const r = deriveMetric(grid, { left: "NPL Rate 2024", operator: "divide", scalar: 2, output: "half" });
    expect(r.ok && (r.grid.rows[0]![4] as number)).toBeCloseTo(0.02, 6);
  });

  it("null / non-numeric operands → null, never fabricated", () => {
    const r = deriveMetric(grid, { left: "NPL Rate 2024", operator: "subtract", right: "Note", output: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.grid.rows.every((row) => row[4] === null)).toBe(true);
  });

  it("fails closed: missing column", () => {
    expect(deriveMetric(grid, { left: "Nope", operator: "subtract", right: "NPL Rate 2024", output: "x" })).toMatchObject({ ok: false });
  });

  it("fails closed: ambiguous column", () => {
    const amb = { columns: ["Sector", "NPL Rate", "Mean NPL Rate"], rows: [["A", 1, 2]] as (readonly (string | number)[])[] };
    expect(deriveMetric(amb, { left: "NPL", operator: "subtract", right: "Sector", output: "x" })).toMatchObject({ ok: false });
  });

  it("fails closed: output collides with an existing column", () => {
    expect(deriveMetric(grid, { left: "NPL Rate 2024", operator: "add", scalar: 1, output: "Note" })).toMatchObject({ ok: false });
  });

  it("fails closed: pct_change / pp_change with a scalar", () => {
    expect(deriveMetric(grid, { left: "NPL Rate 2025", operator: "pct_change", scalar: 0.04, output: "x" })).toMatchObject({ ok: false });
  });

  it("fails closed: both right and scalar, or neither", () => {
    expect(deriveMetric(grid, { left: "NPL Rate 2025", operator: "subtract", right: "NPL Rate 2024", scalar: 1, output: "x" })).toMatchObject({ ok: false });
    expect(deriveMetric(grid, { left: "NPL Rate 2025", operator: "subtract", output: "x" })).toMatchObject({ ok: false });
  });

  it("does not mutate the source grid", () => {
    const before = JSON.stringify(grid);
    deriveMetric(grid, { left: "NPL Rate 2024", operator: "add", scalar: 1, output: "x" });
    expect(JSON.stringify(grid)).toBe(before);
  });
});

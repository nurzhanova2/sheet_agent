import { describe, expect, it } from "vitest";
import { AGENT_BOUNDS } from "./bounds.js";
import { clampObservation, observationCellCount } from "./observation.js";
import type { AgentObservation } from "./types.js";

const rows = (n: number, cols: number): (readonly number[])[] =>
  Array.from({ length: n }, (_, r) => Array.from({ length: cols }, (_, c) => r * cols + c));

describe("clampObservation", () => {
  it("passes a small grid through, filling rowCount", () => {
    const obs: AgentObservation = { tool: "group_by", ok: true, kind: "table", columns: ["A", "B"], rows: rows(3, 2) };
    const out = clampObservation(obs, AGENT_BOUNDS);
    expect(out.rows).toHaveLength(3);
    expect(out.rowCount).toBe(3);
    expect(out.truncated).toBeUndefined();
  });

  it("clamps rows beyond the row cap and preserves the true rowCount", () => {
    const obs: AgentObservation = { tool: "filter_rows", ok: true, kind: "table", columns: ["A"], rows: rows(250, 1), rowCount: 250 };
    const out = clampObservation(obs, AGENT_BOUNDS);
    expect(out.rows!.length).toBe(AGENT_BOUNDS.maxRowsPerObservation);
    expect(out.rowCount).toBe(250);
    expect(out.truncated).toBe(true);
  });

  it("clamps columns beyond the column cap", () => {
    const cols = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const obs: AgentObservation = { tool: "read_range", ok: true, kind: "table", columns: cols, rows: rows(2, 40) };
    const out = clampObservation(obs, AGENT_BOUNDS);
    expect(out.columns).toHaveLength(AGENT_BOUNDS.maxColumnsPerObservation);
    expect(out.rows![0]!.length).toBe(AGENT_BOUNDS.maxColumnsPerObservation);
    expect(out.truncated).toBe(true);
  });

  it("honours the total-cell cap (rows = cells / columns)", () => {
    const tight = { ...AGENT_BOUNDS, maxObservationCells: 20 };
    const obs: AgentObservation = { tool: "filter_rows", ok: true, kind: "table", columns: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], rows: rows(10, 10) };
    const out = clampObservation(obs, tight);
    expect(out.rows!.length).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it("leaves error / scalar / text observations untouched", () => {
    const err: AgentObservation = { tool: "group_by", ok: false, kind: "error", error: "boom" };
    expect(clampObservation(err, AGENT_BOUNDS)).toBe(err);
  });

  it("observationCellCount counts rows x columns", () => {
    expect(observationCellCount({ rows: rows(4, 3), columns: ["a", "b", "c"] })).toBe(12);
    expect(observationCellCount({})).toBe(0);
  });
});

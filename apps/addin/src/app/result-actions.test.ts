import { describe, expect, it } from "vitest";
import {
  buildCopyRowSetActions,
  buildHighlightRowSetActions,
  buildWriteResultActions,
  isCompileError,
} from "./result-actions.js";
import type { ResultRef, RowSetRef } from "./session-memory.js";

const RESULT: ResultRef = {
  id: "res_1", turnId: "t1", order: 1, createdAt: 0, kind: "grouped_table",
  sourceSheet: "Sales", sourceRange: "Sales!A1:C4", sourceVersion: "v1",
  title: "Plan and Fact by Category", spec: null,
  columns: ["Category", "Plan", "Fact"],
  rows: [["Accessories", 227, 228], ["Electronics", 222, 250]],
  rowsTruncated: false, facts: [], resolved: [],
};

const ROWSET: RowSetRef = {
  id: "rows_1", turnId: "t1", order: 2, createdAt: 0,
  sourceSheet: "Sales", sourceRange: "Sales!A1:D9", sourceVersion: "v1",
  sheetRows: [3, 4, 7], describe: "Fact < Plan", count: 3, truncated: false,
  columns: ["Company", "Plan", "Fact", "Var"],
  rows: [["A", 10, 5, -5], ["B", 20, 8, -12], ["C", 30, 1, -29]],
};

describe("buildWriteResultActions", () => {
  it("writes the exact header + data grid as ONE set_values at the anchor", () => {
    const out = buildWriteResultActions(RESULT, { sheetName: "Summary", anchor: "A1" });
    if (isCompileError(out)) throw new Error(out.error);
    expect(out.action.type).toBe("set_values");
    expect(out.action.sheetName).toBe("Summary");
    expect(out.action.range).toBe("A1:C3");
    expect(out.action.payload.values).toEqual([
      ["Category", "Plan", "Fact"],
      ["Accessories", 227, 228],
      ["Electronics", 222, 250],
    ]);
    expect(out.destRange).toBe("A1:C3");
  });

  it("counts non-empty destination cells that would be overwritten", () => {
    const existing = [["x", "y", "z"], ["a", "", "b"], ["", "c", ""]];
    const out = buildWriteResultActions(RESULT, { sheetName: "Summary" }, existing);
    if (isCompileError(out)) throw new Error(out.error);
    expect(out.overwriteCells).toBe(6);
  });

  it("rejects an invalid anchor", () => {
    expect(isCompileError(buildWriteResultActions(RESULT, { sheetName: "Summary", anchor: "not-a-cell" }))).toBe(true);
  });
});

describe("buildHighlightRowSetActions", () => {
  it("coalesces the exact sheet rows into contiguous highlight_range actions", () => {
    const out = buildHighlightRowSetActions(ROWSET);
    if (isCompileError(out)) throw new Error(out.error);
    // rows 3,4 contiguous → A3:D4 ; row 7 → A7:D7
    expect(out.actions.map((a) => a.range)).toEqual(["A3:D4", "A7:D7"]);
    expect(out.actions.every((a) => a.type === "highlight_range" && a.payload.color === "#FFF2CC")).toBe(true);
    expect(out.actions.every((a) => a.sheetName === "Sales")).toBe(true);
  });

  it("errors on an empty row set", () => {
    expect(isCompileError(buildHighlightRowSetActions({ ...ROWSET, sheetRows: [], count: 0 }))).toBe(true);
  });

  // Stage 24.5.1 §7 — a large contiguous band is split so no action exceeds the
  // fill-cell limit; a large non-contiguous selection is NEVER rejected wholesale.
  it("splits a band that would exceed MAX_FILL_CELLS into consecutive valid sub-bands", () => {
    // 12-col source (A:L) → max 50 rows per band (600 / 12). Rows 2..121 = 120 rows.
    const wide: RowSetRef = {
      ...ROWSET,
      sourceRange: "Sales Test Data!A1:L121",
      sheetRows: Array.from({ length: 120 }, (_, i) => i + 2),
      count: 120,
    };
    const out = buildHighlightRowSetActions(wide, "#FFC7CE");
    if (isCompileError(out)) throw new Error(out.error);
    expect(out.actions.map((a) => a.range)).toEqual(["A2:L51", "A52:L101", "A102:L121"]);
    expect(out.actions.every((a) => a.type === "highlight_range" && a.payload.color === "#FFC7CE")).toBe(true);
    expect(out.rowCount).toBe(120); // §8 — the row count is the grounded set, not the band count
  });

  it("builds valid non-contiguous highlight ranges for interleaved rows", () => {
    const rs: RowSetRef = { ...ROWSET, sheetRows: [2, 3, 5, 8, 9, 12], count: 6 };
    const out = buildHighlightRowSetActions(rs);
    if (isCompileError(out)) throw new Error(out.error);
    expect(out.actions.map((a) => a.range)).toEqual(["A2:D3", "A5:D5", "A8:D9", "A12:D12"]);
  });

  it("§5 — honours a non-A1 source range: worksheet-absolute rows, B:Q width", () => {
    const rs: RowSetRef = {
      ...ROWSET,
      sourceRange: "Data!B5:Q25",
      sheetRows: [7, 8, 9, 20],
      count: 4,
    };
    const out = buildHighlightRowSetActions(rs);
    if (isCompileError(out)) throw new Error(out.error);
    // B..Q = 16 cols → max 37 rows/band; runs 7:9 and 20:20 stay intact.
    expect(out.actions.map((a) => a.range)).toEqual(["B7:Q9", "B20:Q20"]);
  });

  it("§5 — honours D10:H40: rows are absolute, width D:H", () => {
    const rs: RowSetRef = { ...ROWSET, sourceRange: "Data!D10:H40", sheetRows: [12, 13, 30], count: 3 };
    const out = buildHighlightRowSetActions(rs);
    if (isCompileError(out)) throw new Error(out.error);
    expect(out.actions.map((a) => a.range)).toEqual(["D12:H13", "D30:H30"]);
  });

  // Stage 24.5.2 §9 — the fill-cell boundary against the REAL validateAction:
  // 599 valid, 600 valid, 601 must be split.
  it("§9 — 599 / 600 cells validate as one band; 601 is split", () => {
    // width 1 (A:A) → cells == rows.
    const band = (rows: number): RowSetRef => ({
      ...ROWSET,
      sourceRange: "Data!A1:A5000",
      sheetRows: Array.from({ length: rows }, (_, i) => i + 2),
      count: rows,
    });
    const at599 = buildHighlightRowSetActions(band(599));
    if (isCompileError(at599)) throw new Error(at599.error);
    expect(at599.actions.length).toBe(1);
    expect(at599.actions[0]!.range).toBe("A2:A600");

    const at600 = buildHighlightRowSetActions(band(600));
    if (isCompileError(at600)) throw new Error(at600.error);
    expect(at600.actions.length).toBe(1); // 600 is the inclusive max
    expect(at600.actions[0]!.range).toBe("A2:A601");

    const at601 = buildHighlightRowSetActions(band(601));
    if (isCompileError(at601)) throw new Error(at601.error);
    expect(at601.actions.length).toBe(2); // split at 600
    expect(at601.actions.map((a) => a.range)).toEqual(["A2:A601", "A602:A602"]);
  });

  // Stage 24.5.2 §11 — the real failing workbook's sheet name has a space, so the
  // RowSetRef.sourceRange is QUOTED. The emitted action carries the BARE name.
  it("§11 — quoted / spaced / Cyrillic source ranges emit a bare sheetName + local band", () => {
    const quoted: RowSetRef = { ...ROWSET, sourceRange: "'Sales Test Data'!A1:L121", sheetRows: [2, 3, 4], count: 3 };
    const q = buildHighlightRowSetActions(quoted, "#FFC7CE");
    if (isCompileError(q)) throw new Error(q.error);
    expect(q.actions.every((a) => a.sheetName === "Sales Test Data")).toBe(true);
    expect(q.actions.map((a) => a.range)).toEqual(["A2:L4"]);
    expect(q.sheet).toBe("Sales Test Data");

    const cyr: RowSetRef = { ...ROWSET, sourceRange: "Баланс!B5:Q25", sheetRows: [7, 8], count: 2 };
    const c = buildHighlightRowSetActions(cyr);
    if (isCompileError(c)) throw new Error(c.error);
    expect(c.actions.every((a) => a.sheetName === "Баланс")).toBe(true);
    expect(c.actions.map((a) => a.range)).toEqual(["B7:Q8"]);
  });

  // Stage 24.5.2 §8/§L — a genuinely un-buildable band surfaces its exact reason.
  it("§8 — a rejected band surfaces its validation reason", () => {
    // width 40 cols (A:AN) with a single 20-row run → 800 cells; chunkRuns caps
    // per-band rows to floor(600/40)=15, so a 20-row run becomes 15 + 5 valid.
    const rs: RowSetRef = {
      ...ROWSET,
      sourceRange: "Data!A1:AN100",
      sheetRows: Array.from({ length: 20 }, (_, i) => i + 2),
      count: 20,
    };
    const out = buildHighlightRowSetActions(rs);
    if (isCompileError(out)) throw new Error(out.error);
    expect(out.rejected).toEqual([]); // splitting keeps every band valid
    expect(out.actions.map((a) => a.range)).toEqual(["A2:AN16", "A17:AN21"]);
  });
});

describe("buildCopyRowSetActions", () => {
  it("writes a compact header + retained rows table to the destination", () => {
    const out = buildCopyRowSetActions(ROWSET, { sheetName: "Review", anchor: "A1" });
    if (isCompileError(out)) throw new Error(out.error);
    expect(out.action.sheetName).toBe("Review");
    expect(out.action.range).toBe("A1:D4");
    expect(out.action.payload.values).toEqual([
      ["Company", "Plan", "Fact", "Var"],
      ["A", 10, 5, -5],
      ["B", 20, 8, -12],
      ["C", 30, 1, -29],
    ]);
  });

  it("errors when the row values were not retained (must recompute first)", () => {
    const bare: RowSetRef = {
      id: "rows_2", turnId: "t1", order: 3, createdAt: 0,
      sourceSheet: "Sales", sourceRange: "Sales!A1:D9", sourceVersion: "v1",
      sheetRows: [3, 4], describe: "x", count: 2, truncated: false,
    };
    expect(isCompileError(buildCopyRowSetActions(bare, { sheetName: "Review" }))).toBe(true);
  });
});

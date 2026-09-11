import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { parseLocalRange } from "./a1.js";
import {
  applyAction,
  expandFillFormula,
  parseActions,
  previewLines,
  undoChange,
  validateAction,
  type FillFormulaAction,
  type WorkbookAction,
} from "./workbook-actions.js";

const good = {
  type: "set_formulas",
  sheetName: "Sales",
  range: "F2:F3",
  description: "delta of plan vs fact",
  payload: { formulas: [["=E2-D2"], ["=E3-D3"]] },
};

describe("validateAction", () => {
  it("accepts a well-formed action", () => {
    const result = validateAction(good, 0);
    expect(typeof result).not.toBe("string");
    expect((result as WorkbookAction).type).toBe("set_formulas");
  });

  it("rejects unknown action types", () => {
    expect(validateAction({ ...good, type: "run_macro" }, 0)).toContain("unknown type");
  });

  it("rejects invalid ranges", () => {
    expect(validateAction({ ...good, range: "F2:ZZZZ9" }, 0)).toContain("invalid range");
    expect(validateAction({ ...good, range: "Sheet1!F2" }, 0)).toContain("invalid range");
  });

  it("rejects a payload whose shape does not match the range", () => {
    expect(validateAction({ ...good, range: "F2:F4", payload: { formulas: [["=E2-D2"]] } }, 0)).toContain("does not match range");
  });

  it("rejects unsafe formulas", () => {
    expect(validateAction({ ...good, payload: { formulas: [["=WEBSERVICE(\"http://x\")"], ["=E3-D3"]] } }, 0)).toContain("allowed functions");
  });

  it("rejects formulas that do not start with =", () => {
    expect(validateAction({ ...good, payload: { formulas: [["E2-D2"], ["=E3-D3"]] } }, 0)).toContain("allowed functions");
  });

  it("enforces the highlight cell limit", () => {
    const big = { type: "highlight_range", sheetName: "S", range: "A1:Z100", description: "x", payload: { color: "#FFF2CC" } };
    expect(validateAction(big, 0)).toContain("highlight limit");
  });

  it("enforces the value/formula cell limit", () => {
    const big = { type: "set_values", sheetName: "S", range: "A1:Z200", description: "x", payload: { values: [[1]] } };
    expect(validateAction(big, 0)).toContain("cell limit");
  });

  it("requires a hex colour for highlight", () => {
    expect(validateAction({ type: "highlight_range", sheetName: "S", range: "A1", description: "x", payload: { color: "yellow" } }, 0)).toContain("hex colour");
  });
});

describe("parseActions", () => {
  it("returns typed actions and per-item errors", () => {
    const { actions, errors } = parseActions([good, { type: "nope" }, { ...good, range: "!!" }]);
    expect(actions).toHaveLength(1);
    expect(errors).toHaveLength(2);
  });

  it("rejects non-array payloads and oversized batches", () => {
    expect(parseActions({}).errors[0]).toContain("must be a JSON array");
    expect(parseActions(Array.from({ length: 40 }, () => good)).errors[0]).toContain("too many actions");
  });
});

describe("expandFillFormula", () => {
  it("fills a formula down with translated relative references", () => {
    const action: FillFormulaAction = {
      id: "a",
      type: "fill_formula",
      sheetName: "Sales",
      range: "F2:F5",
      description: "fill delta",
      payload: { formula: "=E2-D2", direction: "down" },
    };
    expect(expandFillFormula(action)).toEqual([["=E2-D2"], ["=E3-D3"], ["=E4-D4"], ["=E5-D5"]]);
  });
});

describe("previewLines", () => {
  it("summarises each action type", () => {
    expect(previewLines(validateAction(good, 0) as WorkbookAction)[0]).toContain("Set formulas in Sales!F2:F3");
  });
});

// A tiny in-memory workbook the port operates on, so apply + undo are verified end to end.
function fakeWorkbook() {
  const grid = new Map<string, { formula: string | CellValue; fill: string }>();
  const key = (r: number, c: number) => `${r},${c}`;
  function region(address: string) {
    const range = parseLocalRange(address);
    return { row: range.start.row, col: range.start.column, rows: range.rowCount, cols: range.columnCount };
  }
  const port = {
    async readRange(address: string) {
      const { row, col, rows, cols } = region(address);
      const formulas: (string | CellValue)[][] = [];
      const numberFormats: string[][] = [];
      for (let r = 0; r < rows; r += 1) {
        const fr: (string | CellValue)[] = [];
        const nr: string[] = [];
        for (let c = 0; c < cols; c += 1) {
          fr.push(grid.get(key(row + r, col + c))?.formula ?? "");
          nr.push("General");
        }
        formulas.push(fr);
        numberFormats.push(nr);
      }
      return { address, sheetName: "Sales", rowCount: rows, columnCount: cols, revision: 0, values: formulas, formulas, numberFormats };
    },
    async writeRange(address: string, patch: { formulas?: readonly (readonly (string | CellValue)[])[]; values?: readonly (readonly CellValue[])[] }) {
      const { row, col } = region(address);
      const source = patch.formulas ?? patch.values ?? [];
      source.forEach((line, r) => line.forEach((value, c) => {
        const existing = grid.get(key(row + r, col + c)) ?? { formula: "", fill: "#FFFFFF" };
        grid.set(key(row + r, col + c), { ...existing, formula: value });
      }));
    },
    async readFillColors(address: string) {
      const { row, col, rows, cols } = region(address);
      return Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => grid.get(key(row + r, col + c))?.fill ?? "#FFFFFF"),
      );
    },
    async writeFillColors(address: string, colors: readonly (readonly (string | null)[])[]) {
      const { row, col } = region(address);
      colors.forEach((line, r) => line.forEach((value, c) => {
        const existing = grid.get(key(row + r, col + c)) ?? { formula: "", fill: "#FFFFFF" };
        grid.set(key(row + r, col + c), { ...existing, fill: value ?? "#FFFFFF" });
      }));
    },
    async insertImage(_base64Png: string, options: { name?: string }) {
      return { shapeName: options.name ?? "shape", left: 0, top: 0, width: 640, height: 320 };
    },
    async deleteShape() {
      /* no-op */
    },
    async addWorksheet() {
      /* no-op */
    },
    async deleteWorksheet() {
      /* no-op */
    },
    cell: (r: number, c: number) => grid.get(key(r, c)),
  };
  return port;
}

describe("applyAction / undoChange", () => {
  it("applies set_formulas and undo restores the previous cell contents", async () => {
    const port = fakeWorkbook();
    port.writeRange("Sales!F2:F2", { formulas: [["old"]] });
    const action = validateAction(good, 0) as WorkbookAction;
    const applied = await applyAction(port, action);
    expect(port.cell(1, 5)?.formula).toBe("=E2-D2");
    await undoChange(port, applied);
    expect(port.cell(1, 5)?.formula).toBe("old");
    expect(port.cell(2, 5)?.formula).toBe("");
  });

  it("applies highlight_range and undo restores the previous fill", async () => {
    const port = fakeWorkbook();
    const action = validateAction(
      { type: "highlight_range", sheetName: "Sales", range: "C3", description: "outlier", payload: { color: "#FFF2CC" } },
      0,
    ) as WorkbookAction;
    const applied = await applyAction(port, action);
    expect(port.cell(2, 2)?.fill).toBe("#FFF2CC");
    await undoChange(port, applied);
    expect(port.cell(2, 2)?.fill).toBe("#FFFFFF");
  });
});

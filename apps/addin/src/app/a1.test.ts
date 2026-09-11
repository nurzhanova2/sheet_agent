import { describe, expect, it } from "vitest";
import { buildLocalRange, columnIndexToLetters, columnLettersToIndex, parseLocalRange, splitSheetAddress, translateFormula } from "./a1.js";

describe("a1 helpers", () => {
  it("round-trips column letters", () => {
    expect(columnLettersToIndex("A")).toBe(0);
    expect(columnLettersToIndex("Z")).toBe(25);
    expect(columnLettersToIndex("AA")).toBe(26);
    expect(columnIndexToLetters(0)).toBe("A");
    expect(columnIndexToLetters(26)).toBe("AA");
    expect(columnIndexToLetters(701)).toBe("ZZ");
  });

  it("parses ranges and single cells with or without $ and sheet prefix", () => {
    expect(parseLocalRange("Sales!$A$1:$F$120")).toMatchObject({ rowCount: 120, columnCount: 6 });
    expect(parseLocalRange("C3")).toMatchObject({ rowCount: 1, columnCount: 1, start: { row: 2, column: 2 } });
  });

  it("builds a local range from an anchor and size", () => {
    expect(buildLocalRange({ row: 0, column: 0 }, 3, 2)).toBe("A1:B3");
    expect(buildLocalRange({ row: 4, column: 5 }, 1, 1)).toBe("F5");
  });

  it("splits sheet-qualified addresses", () => {
    expect(splitSheetAddress("'My Sheet'!A1:B2")).toEqual({ sheetName: "My Sheet", localAddress: "A1:B2" });
    expect(splitSheetAddress("A1")).toEqual({ sheetName: "", localAddress: "A1" });
  });

  // Stage 24.5.2 §11/§12 — the failing real workbook's sheet name has a space, so
  // Excel returns a QUOTED address. splitSheetAddress must unquote; parseLocalRange
  // must not treat a spaced name as part of a column token.
  it("§11/§12 — handles quoted / spaced / Cyrillic sheet names", () => {
    expect(splitSheetAddress("Sales Test Data!A1:L121")).toEqual({ sheetName: "Sales Test Data", localAddress: "A1:L121" });
    expect(splitSheetAddress("'Sales Test Data'!A1:L121")).toEqual({ sheetName: "Sales Test Data", localAddress: "A1:L121" });
    expect(splitSheetAddress("'Portfolio 2025'!D10:H40")).toEqual({ sheetName: "Portfolio 2025", localAddress: "D10:H40" });
    expect(splitSheetAddress("Баланс!B5:Q25")).toEqual({ sheetName: "Баланс", localAddress: "B5:Q25" });
    expect(splitSheetAddress("'O''Brien Data'!A1:C3")).toEqual({ sheetName: "O'Brien Data", localAddress: "A1:C3" });

    expect(parseLocalRange("Sales Test Data!A1:L121")).toMatchObject({ rowCount: 121, columnCount: 12, start: { row: 0, column: 0 } });
    expect(parseLocalRange("'Sales Test Data'!A1:L121")).toMatchObject({ rowCount: 121, columnCount: 12, start: { row: 0, column: 0 } });
    expect(parseLocalRange("Баланс!B5:Q25")).toMatchObject({ rowCount: 21, columnCount: 16, start: { row: 4, column: 1 } });
    expect(parseLocalRange("'Portfolio 2025'!D10:H40")).toMatchObject({ rowCount: 31, columnCount: 5, start: { row: 9, column: 3 } });
  });

  it("translates relative references and leaves absolute and cross-sheet refs alone", () => {
    expect(translateFormula("=A2*B2", 1, 0)).toBe("=A3*B3");
    expect(translateFormula("=$A$2*B2", 2, 0)).toBe("=$A$2*B4");
    expect(translateFormula("=A2*B2", 0, 1)).toBe("=B2*C2");
    expect(translateFormula('=IF(A2>0,"A2 is positive",A2)', 1, 0)).toBe('=IF(A3>0,"A2 is positive",A3)');
    expect(translateFormula("=Sheet2!A2+A2", 1, 0)).toBe("=Sheet2!A2+A3");
  });
});

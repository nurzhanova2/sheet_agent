import { describe, expect, it } from "vitest";
import type { WorkbookMap } from "./workbook-map.js";
import { buildNewSheetProposal, isNewSheetError, validateSheetName } from "./new-sheet.js";

const MAP: WorkbookMap = {
  sourceIdentity: "x",
  activeSheet: "Sales",
  selection: null,
  truncated: false,
  sheets: [
    { name: "Sales", visibility: "visible", protected: false, usedAddress: "Sales!A1:B2", rowCount: 2, columnCount: 2, dataRowCount: 1, hasHeaders: true, headers: ["A", "B"], headersTruncated: false, firstColumnLetter: "A", tables: [] },
  ],
};

describe("validateSheetName", () => {
  it("accepts a plain name and strips surrounding quotes", () => {
    expect(validateSheetName("Summary")).toEqual({ ok: true, name: "Summary" });
    expect(validateSheetName('  "Q3 Summary" ')).toEqual({ ok: true, name: "Q3 Summary" });
  });

  it("rejects empty, over-long, illegal-character, apostrophe-edge and reserved names", () => {
    expect(validateSheetName("")).toMatchObject({ ok: false, reason: "empty" });
    expect(validateSheetName("x".repeat(32))).toMatchObject({ ok: false, reason: "tooLong" });
    expect(validateSheetName("a/b")).toMatchObject({ ok: false, reason: "invalidChars" });
    expect(validateSheetName("a[b]")).toMatchObject({ ok: false, reason: "invalidChars" });
    expect(validateSheetName("'abc'")).toMatchObject({ ok: false, reason: "edgeApostrophe" });
    expect(validateSheetName("History")).toMatchObject({ ok: false, reason: "reserved" });
  });
});

describe("buildNewSheetProposal", () => {
  it("previews the creation without mutating", () => {
    const built = buildNewSheetProposal(MAP, "Summary", "en");
    if (isNewSheetError(built)) throw new Error(built.error);
    expect(built.name).toBe("Summary");
    expect(built.text).toMatch(/will be created/i);
    expect(built.text).toMatch(/Approve/i);
  });

  it("refuses a duplicate name (case-insensitive)", () => {
    const built = buildNewSheetProposal(MAP, "sales", "en");
    expect(isNewSheetError(built)).toBe(true);
    if (isNewSheetError(built)) expect(built.error).toMatch(/already exists/i);
  });

  it("surfaces the validation problem", () => {
    const built = buildNewSheetProposal(MAP, "a:b", "en");
    expect(isNewSheetError(built)).toBe(true);
  });
});

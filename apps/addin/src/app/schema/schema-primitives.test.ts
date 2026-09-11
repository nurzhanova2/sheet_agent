// Stage 24.6 — unit tests for cell typing, Excel date serials, measure compatibility.
import { describe, expect, it } from "vitest";
import { excelSerialToDate, isDateNumberFormat, isPercentNumberFormat } from "./excel-date.js";
import { classifyCell, isNumericType } from "./cell-typing.js";
import { classifyMeasureKind, sameMeasureGroup } from "./measure-compatibility.js";

describe("excelSerialToDate", () => {
  it("converts real serials (1900 system, leap-year bug honoured)", () => {
    expect(excelSerialToDate(1)?.iso).toBe("1900-01-01");
    expect(excelSerialToDate(60)).toBeNull(); // fictitious 1900-02-29
    expect(excelSerialToDate(61)?.iso).toBe("1900-03-01");
    expect(excelSerialToDate(45292)?.iso).toBe("2024-01-01");
    expect(excelSerialToDate(45962)?.iso).toBe("2025-11-01");
  });
  it("supports the 1904 system when asked", () => {
    expect(excelSerialToDate(0, "1904")?.iso).toBe("1904-01-01");
  });
  it("rejects out-of-window serials", () => {
    expect(excelSerialToDate(-5)).toBeNull();
    expect(excelSerialToDate(9_999_999)).toBeNull();
  });
});

describe("isDateNumberFormat / isPercentNumberFormat", () => {
  it("recognises date formats but not General / currency", () => {
    expect(isDateNumberFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateNumberFormat("dd.mm.yyyy")).toBe(true);
    expect(isDateNumberFormat("General")).toBe(false);
    expect(isDateNumberFormat("#,##0")).toBe(false);
    expect(isDateNumberFormat('#,##0 "₸"')).toBe(false);
  });
  it("recognises percent formats", () => {
    expect(isPercentNumberFormat("0.0%")).toBe(true);
    expect(isPercentNumberFormat("#,##0")).toBe(false);
  });
});

describe("classifyCell", () => {
  it("keeps a bare integer as a number, not a date", () => {
    const c = classifyCell(45962, "General");
    expect(c.type).toBe("integer");
    expect(c.typed).toBe(45962);
  });
  it("types a date-formatted serial as a date with a friendly display", () => {
    const c = classifyCell(45962, "dd.mm.yyyy");
    expect(c.type).toBe("date");
    expect(c.typed).toBe("2025-11-01");
    expect(c.display).toBe("01.11.2025");
  });
  it("types a percentage", () => {
    const c = classifyCell(0.1234, "0.0%");
    expect(c.type).toBe("percentage");
    expect(c.display).toBe("12.34%");
  });
  it("types errors and blanks", () => {
    expect(classifyCell("#DIV/0!", "General").type).toBe("error");
    expect(classifyCell(null, "General").type).toBe("blank");
    expect(classifyCell("", "General").type).toBe("blank");
  });
  it("isNumericType covers number kinds only", () => {
    expect(isNumericType("percentage")).toBe(true);
    expect(isNumericType("currency")).toBe(true);
    expect(isNumericType("date")).toBe(false);
    expect(isNumericType("text")).toBe(false);
  });
});

describe("measure compatibility", () => {
  it("classifies by format then header hint", () => {
    expect(classifyMeasureKind(["0.0%", "0.0%"], "share")).toBe("percentage");
    expect(classifyMeasureKind(['#,##0 "KZT"'], "amount")).toBe("amount");
    expect(classifyMeasureKind(["#,##0"], "за 1 месяц, Δ абс.")).toBe("absolute_change");
    expect(classifyMeasureKind(["0.0%"], "за 1 месяц, Δ %")).toBe("percentage_change");
    expect(classifyMeasureKind(["General"], "Accounts count")).toBe("count");
  });
  it("never mixes amount with percent", () => {
    expect(sameMeasureGroup("amount", "percentage")).toBe(false);
    expect(sameMeasureGroup("amount", "absolute_change")).toBe(true);
    expect(sameMeasureGroup("percentage", "percentage_change")).toBe(true);
    expect(sameMeasureGroup("count", "amount")).toBe(false);
  });
});

// @vitest-environment node
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANUAL_WORKBOOK } from "./manual-tables.js";
import { induceTableSchema } from "../schema-induction.js";
import { buildPeriodIndex } from "../analytical/period-index.js";

const out = process.env["SHEET_AGENT_MANUAL_WORKBOOK_OUT"];

describe("Stage 26.8 §49 — the manual-testing workbook", () => {
  it("every sheet is rectangular and formatted", () => {
    for (const sheet of MANUAL_WORKBOOK) {
      const width = sheet.values.reduce((m, r) => Math.max(m, r.length), 0);
      expect(width, sheet.sheetName).toBeGreaterThan(1);
      expect(sheet.numberFormats.length, sheet.sheetName).toBe(sheet.values.length);
      expect(sheet.values.length, sheet.sheetName).toBeGreaterThan(2);
    }
  });

  it("the two analytical sheets induce a schema with real periods", () => {
    // §41 — an unseen table is only a test if the engine can actually read it.
    for (const sheet of MANUAL_WORKBOOK.slice(0, 2)) {
      const schema = induceTableSchema({
        values: sheet.values,
        numberFormats: sheet.numberFormats,
        formulas: sheet.formulas,
        sheetName: sheet.sheetName,
        sourceRange: sheet.address,
        sourceVersion: "v1",
        startsBelowRow1: sheet.startsBelowRow1,
      });
      expect(schema.orientation, sheet.sheetName).not.toBe("row_records");
      expect(schema.rowAxis.length, sheet.sheetName).toBeGreaterThanOrEqual(3);
      const periods = buildPeriodIndex(schema, { values: sheet.values, numberFormats: sheet.numberFormats });
      expect(periods.points.length, `${sheet.sheetName} periods`).toBeGreaterThanOrEqual(4);
    }
  });

  it.runIf(Boolean(out))("writes the sheet dump", () => {
    writeFileSync(out!, JSON.stringify(MANUAL_WORKBOOK, null, 1), "utf8");
    expect(MANUAL_WORKBOOK.length).toBeGreaterThanOrEqual(4);
  });
});

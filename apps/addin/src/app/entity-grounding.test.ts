// Stage 24.5 §8–§9 — deterministic entity → source-row grounding.
import { describe, expect, it, vi } from "vitest";
import type { ExcelPort } from "@sheet-agent/application";
import { groundEntitiesToRows } from "./entity-grounding.js";
import { sourceVersionOf } from "./source-freshness.js";
import { readAddressSnapshot } from "./workbook-context.js";
import { SALES_HEADERS, SALES_ROWS } from "../analysis/__fixtures__/sales-test-data.js";

const MANAGER = SALES_HEADERS.indexOf("Manager");

function salesPort(rows: readonly (readonly (string | number)[])[] = SALES_ROWS): ExcelPort {
  const values = [[...SALES_HEADERS] as (string | number)[], ...rows.map((r) => [...r])];
  return {
    readRange: vi.fn(async (address: string) => ({
      address,
      sheetName: "Sales Test Data",
      rowCount: values.length,
      columnCount: SALES_HEADERS.length,
      revision: 0,
      values,
      formulas: values.map((r) => r.map(() => null)),
      numberFormats: values.map((r) => r.map(() => "General")),
    })),
  } as unknown as ExcelPort;
}

/** 1-based sheet rows in Sales Test Data!A1:L121 whose Manager ∈ names. */
function expectedRows(names: readonly string[]): number[] {
  const set = new Set(names.map((n) => n.toLowerCase()));
  return SALES_ROWS.map((r, i) => ({ r, sheetRow: i + 2 }))
    .filter(({ r }) => set.has(String(r[MANAGER]).toLowerCase()))
    .map(({ sheetRow }) => sheetRow);
}

describe("groundEntitiesToRows", () => {
  it("maps entity values to the exact source rows, workbook order, de-duplicated", async () => {
    const out = await groundEntitiesToRows(salesPort(), {
      sourceRange: "Sales Test Data!A1:L121",
      entityColumn: "Manager",
      entityValues: ["Aigerim", "Aruzhan", "Timur"],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([...out.sheetRows]).toEqual(expectedRows(["Aigerim", "Aruzhan", "Timur"]));
    expect(out.sheetRows.length).toBeGreaterThan(3);
    // sorted ascending, unique
    expect([...out.sheetRows]).toEqual([...new Set(out.sheetRows)].sort((a, b) => a - b));
    expect([...out.matchedValues].sort()).toEqual(["Aigerim", "Aruzhan", "Timur"]);
    expect(out.unmatchedValues).toEqual([]);
    expect(out.entityColumn).toBe("Manager");
  });

  it("is case-insensitive / whitespace-tolerant and matches a single entity", async () => {
    const out = await groundEntitiesToRows(salesPort(), {
      sourceRange: "Sales Test Data!A1:L121",
      entityColumn: "manager", // lower-case column name
      entityValues: ["  aIgErIm "],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([...out.sheetRows]).toEqual(expectedRows(["Aigerim"]));
  });

  it("reports unmatched values and does not fabricate rows (§16)", async () => {
    const out = await groundEntitiesToRows(salesPort(), {
      sourceRange: "Sales Test Data!A1:L121",
      entityColumn: "Manager",
      entityValues: ["Aigerim", "Nobody"],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.matchedValues).toEqual(["Aigerim"]);
    expect(out.unmatchedValues).toEqual(["Nobody"]);
  });

  it("fails closed on an unknown entity column", async () => {
    const out = await groundEntitiesToRows(salesPort(), {
      sourceRange: "Sales Test Data!A1:L121",
      entityColumn: "Salesperson",
      entityValues: ["Aigerim"],
    });
    expect(out).toMatchObject({ ok: false, kind: "unknown_column" });
  });

  it("fails closed on an ambiguous entity column", async () => {
    const dupHeaders = [...SALES_HEADERS];
    dupHeaders[3] = "Manager"; // now two "Manager" columns
    const values = [dupHeaders as string[], ...SALES_ROWS.map((r) => [...r])];
    const port = {
      readRange: vi.fn(async (address: string) => ({
        address, sheetName: "Sales Test Data", rowCount: values.length, columnCount: dupHeaders.length,
        revision: 0, values, formulas: values.map((r) => r.map(() => null)), numberFormats: values.map((r) => r.map(() => "General")),
      })),
    } as unknown as ExcelPort;
    const out = await groundEntitiesToRows(port, {
      sourceRange: "Sales Test Data!A1:L121",
      entityColumn: "Manager",
      entityValues: ["Aigerim"],
    });
    expect(out).toMatchObject({ ok: false, kind: "ambiguous_column" });
  });

  it("refuses a stale source (§17)", async () => {
    const port = salesPort();
    const fresh = sourceVersionOf(await readAddressSnapshot(port, "Sales Test Data!A1:L121"));
    // an edited source
    const edited = SALES_ROWS.map((r, i) => (i === 0 ? [...r.slice(0, MANAGER), "Changed", ...r.slice(MANAGER + 1)] : [...r]));
    const out = await groundEntitiesToRows(salesPort(edited), {
      sourceRange: "Sales Test Data!A1:L121",
      sourceVersion: fresh,
      entityColumn: "Manager",
      entityValues: ["Aigerim"],
    });
    expect(out).toMatchObject({ ok: false, kind: "stale_source" });
  });

  // Stage 24.5.1 §5–§6 — arbitrary source starts; header row is never a data row.
  function offsetPort(sourceRange: string, header: readonly string[], dataRows: readonly (readonly (string | number)[])[]): ExcelPort {
    const values = [[...header] as (string | number)[], ...dataRows.map((r) => [...r])];
    return {
      readRange: vi.fn(async (address: string) => ({
        address, sheetName: "Data", rowCount: values.length, columnCount: header.length, revision: 0,
        values, formulas: values.map((r) => r.map(() => null)), numberFormats: values.map((r) => r.map(() => "General")),
      })),
    } as unknown as ExcelPort;
  }

  it("§5/§6 — B5:Q25: matched rows are absolute worksheet rows, header row 5 excluded", async () => {
    // header at worksheet row 5, first data row = worksheet row 6.
    const header = ["Bank", "Sector", "Region", "Exposure"];
    const data = [
      ["B1", "Retail", "N", 10],      // row 6
      ["B2", "Corporate", "S", 20],   // row 7  ← match
      ["B3", "Retail", "E", 30],      // row 8
      ["B4", "Corporate", "W", 40],   // row 9  ← match
    ];
    const out = await groundEntitiesToRows(offsetPort("Data!B5:Q25", header, data), {
      sourceRange: "Data!B5:Q25",
      entityColumn: "Sector",
      entityValues: ["Corporate"],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([...out.sheetRows]).toEqual([7, 9]); // NOT [2,4] and NOT [3,5]; never 5 (header)
  });

  it("§5 — D10:H40: first data row is worksheet row 11", async () => {
    const header = ["Name", "Value"];
    const data = [
      ["x", 1], // row 11
      ["y", 2], // row 12 ← match
      ["y", 3], // row 13 ← match
      ["z", 4], // row 14
    ];
    const out = await groundEntitiesToRows(offsetPort("Data!D10:H40", header, data), {
      sourceRange: "Data!D10:H40",
      entityColumn: "Name",
      entityValues: ["y"],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([...out.sheetRows]).toEqual([12, 13]);
  });

  it("mode 'not_in' selects the complement over non-empty entity cells", async () => {
    const out = await groundEntitiesToRows(salesPort(), {
      sourceRange: "Sales Test Data!A1:L121",
      entityColumn: "Manager",
      entityValues: ["Aigerim", "Aruzhan", "Timur"],
      mode: "not_in",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const inRows = new Set(expectedRows(["Aigerim", "Aruzhan", "Timur"]));
    expect(out.sheetRows.every((r) => !inRows.has(r))).toBe(true);
    expect(out.sheetRows.length).toBe(SALES_ROWS.length - inRows.size);
  });
});

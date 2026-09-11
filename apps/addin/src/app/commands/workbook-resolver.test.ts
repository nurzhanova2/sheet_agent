import { describe, expect, it } from "vitest";
import type { WorkbookMap, WorkbookMapSheet } from "./workbook-map.js";
import { resolveColumn, resolveSheet } from "./workbook-resolver.js";

function sheet(name: string, headers: string[] = []): WorkbookMapSheet {
  return {
    name,
    visibility: "visible",
    protected: false,
    usedAddress: `${name}!A1:${String.fromCharCode(64 + Math.max(1, headers.length))}10`,
    rowCount: 10,
    columnCount: Math.max(1, headers.length),
    dataRowCount: 9,
    hasHeaders: headers.length > 0,
    headers,
    headersTruncated: false,
    firstColumnLetter: "A",
    tables: [],
  };
}

function map(...sheets: WorkbookMapSheet[]): WorkbookMap {
  return { sourceIdentity: "x", sheets, activeSheet: sheets[0]?.name ?? null, selection: null, truncated: false };
}

describe("resolveSheet", () => {
  const wb = map(sheet("Sales Test Data"), sheet("Agent Test"), sheet("Config"));

  it("resolves an exact and a case-insensitive name", () => {
    expect(resolveSheet(wb, "Agent Test")).toMatchObject({ kind: "ok", sheet: { name: "Agent Test" } });
    expect(resolveSheet(wb, "agent test")).toMatchObject({ kind: "ok", sheet: { name: "Agent Test" } });
  });

  it("resolves a unique prefix / substring (safe normalization)", () => {
    expect(resolveSheet(wb, "Sales")).toMatchObject({ kind: "ok", sheet: { name: "Sales Test Data" } });
    expect(resolveSheet(wb, "gent")).toMatchObject({ kind: "ok", sheet: { name: "Agent Test" } });
  });

  it("reports ambiguity — never silently picks one", () => {
    const two = map(sheet("Sales 2025"), sheet("Sales 2026"));
    const res = resolveSheet(two, "Sales");
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.candidates).toEqual(["Sales 2025", "Sales 2026"]);
  });

  it("reports not-found for an unknown reference", () => {
    expect(resolveSheet(wb, "Revenue").kind).toBe("not_found");
    expect(resolveSheet(wb, "").kind).toBe("not_found");
  });

  it("strict mode accepts only an exact / case-exact name (no fuzzy write target)", () => {
    expect(resolveSheet(wb, "Sales", { strict: true }).kind).toBe("not_found");
    expect(resolveSheet(wb, "sales test data", { strict: true })).toMatchObject({ kind: "ok" });
  });
});

describe("resolveColumn", () => {
  const s = sheet("Agent Test", ["Company", "Plan", "Fact", "Variance", "Comment"]);

  it("resolves exact and case-insensitive headers", () => {
    expect(resolveColumn(s, "Fact")).toEqual({ kind: "ok", name: "Fact", index: 2 });
    expect(resolveColumn(s, "plan")).toEqual({ kind: "ok", name: "Plan", index: 1 });
  });

  it("reports missing and ambiguous columns", () => {
    expect(resolveColumn(s, "Revenue").kind).toBe("not_found");
    const wide = sheet("W", ["Plan", "Plan B", "Actual Plan"]);
    expect(resolveColumn(wide, "Plan")).toEqual({ kind: "ok", name: "Plan", index: 0 }); // exact wins
    expect(resolveColumn(wide, "pla").kind).toBe("ambiguous");
  });
});

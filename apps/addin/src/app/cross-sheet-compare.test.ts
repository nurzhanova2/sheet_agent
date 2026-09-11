import { describe, expect, it } from "vitest";
import { commonNumericColumns, datasetFamily, planCrossSheetComparison } from "./cross-sheet-compare.js";
import type { WorkbookMap, WorkbookMapSheet } from "./commands/workbook-map.js";

function sheet(name: string): WorkbookMapSheet {
  return {
    name,
    visibility: "visible",
    protected: false,
    usedAddress: `${name}!A1:D10`,
    rowCount: 10,
    columnCount: 4,
    dataRowCount: 9,
    hasHeaders: true,
    headers: ["Company", "Plan", "Fact", "Region"],
    headersTruncated: false,
    firstColumnLetter: "A",
    tables: [],
  };
}
function map(names: string[]): WorkbookMap {
  return { sourceIdentity: "x", sheets: names.map(sheet), activeSheet: null, selection: null, truncated: false };
}

describe("datasetFamily", () => {
  it("strips a year / quarter token", () => {
    expect(datasetFamily("Portfolio 2024")).toBe("Portfolio");
    expect(datasetFamily("Deposits FY2025")).toBe("Deposits");
  });
});

describe("planCrossSheetComparison", () => {
  it("pairs two year-suffixed sheets of one family", () => {
    const plan = planCrossSheetComparison(map(["Portfolio 2024", "Portfolio 2025"]), "what changed between 2024 and 2025?");
    expect(plan.kind).toBe("compare");
    if (plan.kind === "compare") {
      expect(plan.sheetA).toBe("Portfolio 2024");
      expect(plan.sheetB).toBe("Portfolio 2025");
    }
  });

  it("is dataset_ambiguous when two families match both years", () => {
    const plan = planCrossSheetComparison(
      map(["Portfolio 2024", "Deposits 2024", "Portfolio 2025", "Deposits 2025"]),
      "compare 2024 and 2025",
    );
    expect(plan.kind).toBe("dataset_ambiguous");
    if (plan.kind === "dataset_ambiguous") expect([...plan.candidates].sort()).toEqual(["Deposits", "Portfolio"]);
  });

  it("resumes to a concrete pair when a family is forced", () => {
    const plan = planCrossSheetComparison(
      map(["Portfolio 2024", "Deposits 2024", "Portfolio 2025", "Deposits 2025"]),
      "compare 2024 and 2025",
      undefined,
      "Portfolio",
    );
    expect(plan.kind).toBe("compare");
    if (plan.kind === "compare") expect([plan.sheetA, plan.sheetB].sort()).toEqual(["Portfolio 2024", "Portfolio 2025"]);
  });

  it("reports missing data when only one side exists", () => {
    const plan = planCrossSheetComparison(map(["Portfolio 2025"]), "what changed between 2024 and 2025?");
    expect(plan.kind).toBe("missing");
    if (plan.kind === "missing") {
      expect(plan.missing).toBe("2024");
      expect(plan.found).toBe("2025");
    }
  });

  it("picks up an explicit metric from 'compare Fact between A and B'", () => {
    const plan = planCrossSheetComparison(map(["Sales Test Data", "Agent Test"]), "compare Fact between Sales Test Data and Agent Test");
    expect(plan.kind).toBe("compare");
    if (plan.kind === "compare") expect(plan.metric).toBe("Fact");
  });

  it("hard-stops when candidate sheets exceed the discovery budget", () => {
    const many = Array.from({ length: 10 }, (_, i) => `Book ${2020 + i} 2024`);
    const plan = planCrossSheetComparison(map([...many, "X 2025"]), "compare 2024 and 2025");
    expect(plan.kind).toBe("budget");
  });
});

describe("commonNumericColumns", () => {
  it("returns columns numeric in BOTH sheets, case-insensitively matched", () => {
    expect(
      commonNumericColumns(["Company", "Plan", "Fact"], ["company", "plan", "fact"], new Set(["Plan", "Fact"]), new Set(["plan"])),
    ).toEqual(["Plan"]);
  });
});

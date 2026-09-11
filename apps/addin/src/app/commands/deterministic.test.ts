import { describe, expect, it } from "vitest";
import { parseMetricByDimension, renderCleanReport, synthesizeSlashAnalysisPlan } from "./deterministic.js";

const HEADERS = ["Date", "Region", "Manager", "Product", "Category", "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue"];
const CTX = { headers: HEADERS, numericHeaders: new Set(["Plan", "Fact", "Revenue"]), groupingColumn: "Category" as string | null };

describe("parseMetricByDimension (Stage 22.10 / 22.4)", () => {
  it("reads 'Revenue by Category' (EN) and 'Revenue по Category' (RU)", () => {
    expect(parseMetricByDimension("Revenue by Category", HEADERS, "sum")).toEqual({
      aggregate: "sum",
      column: "Revenue",
      by: ["Category"],
    });
    expect(parseMetricByDimension("Revenue по Category", HEADERS, "sum")?.by).toEqual(["Category"]);
  });

  it("reads two grouping dimensions", () => {
    expect(parseMetricByDimension("Revenue по Region и Category", HEADERS, "sum")?.by).toEqual(["Region", "Category"]);
  });

  it("honours an explicit aggregate keyword (mean / average / средний)", () => {
    expect(parseMetricByDimension("средний Plan по Category", HEADERS, "sum")?.aggregate).toBe("mean");
    expect(parseMetricByDimension("average Plan by Category", HEADERS, "sum")?.aggregate).toBe("mean");
  });

  it("returns null when there is no dimension or no metric column", () => {
    expect(parseMetricByDimension("Revenue", HEADERS, "sum")).toBeNull();
    expect(parseMetricByDimension("Nonsense by Category", HEADERS, "sum")).toBeNull();
  });
});

describe("synthesizeSlashAnalysisPlan", () => {
  it("/pivot compiles to a single group_by over existing operations", () => {
    const plan = synthesizeSlashAnalysisPlan("pivot", "Revenue по Category", CTX);
    expect(plan).toMatchObject({
      kind: "analysis",
      operations: [{ op: "group_by", by: ["Category"], metrics: [{ metric: "sum", target: { kind: "column", name: "Revenue" } }] }],
    });
  });

  it("/summary with no arguments falls back to summary_statistics", () => {
    expect(synthesizeSlashAnalysisPlan("summary", "", CTX)).toEqual({
      kind: "analysis",
      operations: [{ op: "summary_statistics" }],
    });
  });

  it("/analyze adds the categorical distribution when a grouping column exists", () => {
    const plan = synthesizeSlashAnalysisPlan("analyze", "", CTX);
    expect(plan?.kind).toBe("analysis");
    expect(plan && "operations" in plan && plan.operations.map((o) => o.op)).toEqual(["summary_statistics", "group_by"]);
    expect(synthesizeSlashAnalysisPlan("analyze", "", { ...CTX, groupingColumn: null })).toEqual({
      kind: "analysis",
      operations: [{ op: "summary_statistics" }],
    });
  });

  it("/pivot with an unreadable spec returns null (caller reports usage)", () => {
    expect(synthesizeSlashAnalysisPlan("pivot", "make it nice", CTX)).toBeNull();
  });
});

describe("renderCleanReport (Stage 22.11) — inspection only", () => {
  const headers = ["Name", "Amount"];
  it("reports blanks, duplicate rows, whitespace and mixed types deterministically", () => {
    const values = [
      ["Name", "Amount"],
      ["Alpha ", 10],
      ["Alpha ", 10], // duplicate row + trailing whitespace on Name (×2)
      ["Beta", null], // blank
      ["Gamma", "n/a"], // Amount is numeric elsewhere → mixed types
    ];
    const report = renderCleanReport(values, headers, "en", "Sheet1!A1:B5 · 4 data rows");
    expect(report).toContain("## Data quality check");
    expect(report).toMatch(/Duplicate rows.*1/s);
    expect(report).toMatch(/Amount: 1 blank/);
    expect(report).toMatch(/Name: 2 value/);
    expect(report).toMatch(/Mixed value types.*Amount/s);
    expect(report).toMatch(/Nothing was changed/);
    // never proposes or applies an edit
    expect(report).not.toMatch(/sheet-agent-actions|Approve/);
  });

  it("says so when there are no obvious issues", () => {
    const values = [
      ["Name", "Amount"],
      ["Alpha", 10],
      ["Beta", 20],
    ];
    expect(renderCleanReport(values, headers, "ru", "x")).toMatch(/Очевидных проблем не найдено/);
  });
});

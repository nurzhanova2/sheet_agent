import { describe, expect, it } from "vitest";
import { buildSortReport, isSlashTextError, parseSortSpec, renderSummaryReport } from "./summary-sort.js";
import { salesSnapshot } from "../../analysis/__fixtures__/sales-test-data.js";

const sales = salesSnapshot();
const HEADERS = sales.headers ?? [];

describe("renderSummaryReport (Stage 22.1 — /summary)", () => {
  const report = renderSummaryReport(sales, "en").text;

  it("renders a Date column as an ISO date RANGE, not serial statistics", () => {
    expect(report).toMatch(/- Date: 2026-01-01 → 2026-04-30/);
  });

  it("never shows mean/median/stddev or a serial number for the Date column", () => {
    const dateLine = report.split("\n").find((l) => l.startsWith("- Date:")) ?? "";
    expect(dateLine).not.toMatch(/mean|median|stddev|std dev|46[01]\d\d/i);
  });

  it("shows a concise numeric line (min/max/mean/median) for a numeric column, no skew claims", () => {
    expect(report).toMatch(/- Plan: 120 values · min .* · max .* · mean .* · median /);
    expect(report).not.toMatch(/skew|right-skewed|distribution/i);
  });

  it("summarises a text column by distinct values", () => {
    expect(report).toMatch(/- Region: \d+ distinct \(/);
  });

  it("is localised", () => {
    expect(renderSummaryReport(sales, "ru").text).toMatch(/## Сводка/);
  });
});

describe("parseSortSpec", () => {
  it("reads the RU 'по убыванию' / 'по возрастанию' direction", () => {
    expect(parseSortSpec("Fact по убыванию", HEADERS)).toEqual({ column: "Fact", direction: "desc" });
    expect(parseSortSpec("Plan по возрастанию", HEADERS)).toEqual({ column: "Plan", direction: "asc" });
  });
  it("reads EN 'desc' / 'asc' and defaults to asc", () => {
    expect(parseSortSpec("Revenue desc", HEADERS)).toEqual({ column: "Revenue", direction: "desc" });
    expect(parseSortSpec("Revenue", HEADERS)).toEqual({ column: "Revenue", direction: "asc" });
  });
  it("returns null when no column is recognised", () => {
    expect(parseSortSpec("whatever", HEADERS)).toBeNull();
  });
});

describe("buildSortReport (Stage 22.1 — /sort, compute-and-preview)", () => {
  it("returns a real sorted preview whose Fact column is non-increasing for a desc sort", () => {
    const built = buildSortReport(sales, "Fact по убыванию", "ru");
    if (isSlashTextError(built)) throw new Error(built.error);
    const rows = built.text.split("\n").filter((l) => /^\|\s*\d/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const header = built.text.split("\n").find((l) => l.startsWith("| # |"))!.split("|").map((c) => c.trim());
    const factCol = header.indexOf("Fact");
    const facts = rows.map((r) => Number(r.split("|").map((c) => c.trim())[factCol]));
    for (let i = 1; i < facts.length; i += 1) expect(facts[i - 1]!).toBeGreaterThanOrEqual(facts[i]!);
    expect(built.text).toMatch(/Книга не изменена/);
    expect(built.text).not.toMatch(/rows matched/i);
  });

  it("errors (not a generic fallback) when the sort column is unknown", () => {
    expect(isSlashTextError(buildSortReport(sales, "Nonsense desc", "en"))).toBe(true);
  });
});

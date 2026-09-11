import { describe, expect, it } from "vitest";
import { buildFilterReport, buildHighlightProposal, HIGHLIGHT_COLOR, isSlashConditionError } from "./highlight-filter.js";
import { selectMatchingRows } from "../../analysis/select-rows.js";
import { salesSnapshot } from "../../analysis/__fixtures__/sales-test-data.js";

const sales = salesSnapshot();
const FACT_LT_PLAN = { left: { column: "Fact" }, operator: "<" as const, value: { column: "Plan" } };

function rowsCoveredBy(ranges: readonly string[]): number[] {
  const covered = new Set<number>();
  for (const range of ranges) {
    const [a, b] = range.replace(/[A-Z]/g, "").split(":").map(Number);
    for (let r = a!; r <= (b ?? a!); r += 1) covered.add(r);
  }
  return [...covered].sort((x, y) => x - y);
}

describe("buildHighlightProposal (Stage 22 — mutation correctness)", () => {
  it("proposes highlight_range actions whose cells are EXACTLY the deterministic match set", () => {
    const built = buildHighlightProposal(sales, "Fact меньше Plan", "ru");
    if (isSlashConditionError(built)) throw new Error(built.error);

    const matched = selectMatchingRows(sales, FACT_LT_PLAN);
    expect(matched.sheetRows.length).toBeGreaterThan(0);

    expect(built.actions.every((a) => a.type === "highlight_range")).toBe(true);
    expect(built.actions.every((a) => a.type === "highlight_range" && a.payload.color === HIGHLIGHT_COLOR)).toBe(true);
    expect(built.actions.every((a) => a.sheetName === "Sales Test Data")).toBe(true);
    // full selection width (A..L)
    expect(built.actions.every((a) => /^A\d+:L\d+$/.test(a.range))).toBe(true);

    expect(rowsCoveredBy(built.actions.map((a) => a.range))).toEqual([...matched.sheetRows].sort((x, y) => x - y));
    // the displayed count is that same number
    expect(built.text).toContain(String(matched.sheetRows.length));
  });

  it("describes a PROPOSED change — never claims it already happened", () => {
    const built = buildHighlightProposal(sales, "Fact меньше Plan", "ru");
    if (isSlashConditionError(built)) throw new Error(built.error);
    expect(built.text).toMatch(/Подтвердите изменение/);
    expect(built.text).not.toMatch(/выделено|заполнено|применено/i);
  });

  it("zero matches → no actions, nothing-to-highlight message", () => {
    const built = buildHighlightProposal(sales, "Plan больше 999999999", "en"); // parses, matches nothing
    if (isSlashConditionError(built)) throw new Error(built.error);
    expect(built.actions).toHaveLength(0);
    expect(built.text).toMatch(/nothing to highlight/i);
  });

  it("an unreadable condition is an error, not a silent no-op", () => {
    expect(isSlashConditionError(buildHighlightProposal(sales, "всё хорошо", "ru"))).toBe(true);
  });
});

describe("buildFilterReport (Stage 22 — read-only)", () => {
  it("reports the deterministic count and never mutates", () => {
    const report = buildFilterReport(sales, "Fact меньше Plan", "ru");
    if (isSlashConditionError(report)) throw new Error(report.error);
    const matched = selectMatchingRows(sales, FACT_LT_PLAN);
    expect(report.actions).toHaveLength(0);
    expect(report.text).toContain(String(matched.indexes.length));
    expect(report.text).toMatch(/Книга не изменена/);
  });

  it("the count matches the same primitive /highlight uses", () => {
    const filter = buildFilterReport(sales, "Fact меньше Plan", "en");
    const highlight = buildHighlightProposal(sales, "Fact меньше Plan", "en");
    if (isSlashConditionError(filter) || isSlashConditionError(highlight)) throw new Error("unexpected");
    const n = selectMatchingRows(sales, FACT_LT_PLAN).indexes.length;
    expect(filter.text).toContain(String(n));
    expect(highlight.text).toContain(String(n));
  });
});

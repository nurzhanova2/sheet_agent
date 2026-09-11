import { describe, expect, it } from "vitest";
import { isConditionError, resolveSlashCondition } from "./condition.js";

const HEADERS = ["Date", "Region", "Manager", "Product", "Category", "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue", "Comment"];

function ok(args: string) {
  const r = resolveSlashCondition(args, HEADERS);
  if (isConditionError(r)) throw new Error(`unexpected error: ${r.error}`);
  return r;
}

describe("resolveSlashCondition (Stage 22)", () => {
  it("column-to-column, RU and EN", () => {
    expect(ok("Fact меньше Plan").condition).toEqual({ left: { column: "Fact" }, operator: "<", value: { column: "Plan" } });
    expect(ok("Fact less than Plan").condition).toEqual({ left: { column: "Fact" }, operator: "<", value: { column: "Plan" } });
    expect(ok("Fact меньше Plan").describe).toBe("Fact < Plan");
  });

  it("numeric / percent threshold", () => {
    expect(ok("Variance % больше 20%").condition).toEqual({
      left: { column: "Variance %" },
      operator: ">",
      value: { kind: "percent", value: 20 },
    });
    expect(ok("Variance % больше 20%").describe).toBe("Variance % > 20%");
  });

  it("absolute threshold keeps the |x| framing", () => {
    const r = ok("абсолютное Variance % больше 20%");
    expect(r.condition).toEqual({
      left: { kind: "abs", value: { kind: "column", name: "Variance %" } },
      operator: ">",
      value: { kind: "percent", value: 20 },
    });
    expect(r.describe).toBe("|Variance %| > 20%");
  });

  it("equality against a text value (the form the requirement extractor omits)", () => {
    const r = ok("Category = Accessories");
    expect(r.condition).toEqual({ left: { column: "Category" }, operator: "=", value: "Accessories" });
    expect(r.describe).toBe('Category = "Accessories"');
  });

  it("contains", () => {
    expect(ok("Comment содержит urgent").condition).toEqual({
      left: { column: "Comment" },
      operator: "contains",
      value: "urgent",
    });
  });

  it("unreadable / unknown-column input is an error, not a guess", () => {
    expect(isConditionError(resolveSlashCondition("всё хорошо", HEADERS))).toBe(true);
    expect(isConditionError(resolveSlashCondition("Nonexistent > 5", HEADERS))).toBe(true);
    expect(isConditionError(resolveSlashCondition("", HEADERS))).toBe(true);
  });
});

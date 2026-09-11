import { describe, expect, it } from "vitest";
import { formatDisplayCell, formatDisplayRow } from "./format-cell.js";

describe("formatDisplayCell", () => {
  it("trims long floats to a readable precision without touching the value", () => {
    expect(formatDisplayCell(222.94594594594594)).toBe("222.946");
    expect(formatDisplayCell(0.04594999999999999)).toBe("0.04595");
    expect(formatDisplayCell(0.021000000000000005)).toBe("0.021");
    expect(formatDisplayCell(52.53333333)).toBe("52.5333");
  });

  it("passes integers and short values through unchanged", () => {
    expect(formatDisplayCell(7237)).toBe("7237");
    expect(formatDisplayCell(0)).toBe("0");
    expect(formatDisplayCell(-3)).toBe("-3");
    expect(formatDisplayCell("Corporate")).toBe("Corporate");
    expect(formatDisplayCell(null)).toBe("");
  });

  it("formatDisplayRow maps a whole row", () => {
    expect(formatDisplayRow(["Corporate", 0.04594999999999999, null, 12458.333333])).toEqual([
      "Corporate", "0.04595", "", "12458.3",
    ]);
  });
});

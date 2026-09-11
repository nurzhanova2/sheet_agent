import { describe, expect, it } from "vitest";
import { deriveColumnName } from "./formula-header.js";

describe("deriveColumnName (Stage 22)", () => {
  it("reads 'колонку <Name> =' and 'в <Name> ...'", () => {
    expect(deriveColumnName("добавь колонку Margin = Revenue - Cost")).toBe("Margin");
    expect(deriveColumnName("в Comment напиши формулу, которая ...")).toBe("Comment");
    expect(deriveColumnName("add a column Difference = Fact - Plan")).toBe("Difference");
    expect(deriveColumnName('в Comment добавь формулу: если Fact > Plan "x" иначе "y"')).toBe("Comment");
  });

  it("returns null when no name is present", () => {
    expect(deriveColumnName("just do something useful")).toBeNull();
  });
});

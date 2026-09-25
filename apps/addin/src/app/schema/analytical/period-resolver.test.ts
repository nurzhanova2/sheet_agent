import { describe, expect, it } from "vitest";
import { normalizeDateText } from "./period-resolver.js";

describe("normalizeDateText", () => {
  it("normalises equivalent forms to one ISO date", () => {
    for (const s of ["01.01.2025", "01/01/2025", "2025-01-01", "1 января 2025", "January 1 2025", "1 January 2025"]) {
      expect(normalizeDateText(s), s).toBe("2025-01-01");
    }
    expect(normalizeDateText("01.01.25")).toBe("2025-01-01");
  });

  it("returns null for a non-date — it never substitutes a nearby period", () => {
    expect(normalizeDateText("за последний месяц")).toBeNull();
    expect(normalizeDateText("норма")).toBeNull();
  });
});

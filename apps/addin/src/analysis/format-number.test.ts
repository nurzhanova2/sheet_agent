import { describe, expect, it } from "vitest";
import {
  MISSING_DISPLAY,
  formatCorrelation,
  formatCount,
  formatDate,
  formatInteger,
  formatNumber,
  formatPercent,
  formatRatio,
} from "./format-number.js";

describe("format-number — one consistent presentation per semantic type (Stage 21.2.5)", () => {
  it("count / integer: locale-grouped, no decimals", () => {
    expect(formatCount(48)).toBe("48");
    expect(formatCount(2849711102)).toBe("2,849,711,102");
    expect(formatInteger(2849711102, "ru")).toMatch(/^2\D849\D711\D102$/); // RU groups with a space-like separator
    expect(formatCount(47.6)).toBe("48"); // display rounds; raw stays raw elsewhere
  });

  it("decimal: 2 places, no runaway precision", () => {
    expect(formatNumber(205.28571428571428)).toBe("205.29");
    expect(formatNumber(228.3125)).toBe("228.31");
    expect(formatNumber(226)).toBe("226"); // integer → no trailing zeros (project convention)
    expect(formatNumber(434805308)).toBe("434,805,308");
    expect(formatNumber(434805308, 2, "ru")).toMatch(/^434\D805\D308$/);
  });

  it("percentage: fraction → NN.NN%, never double-scaled", () => {
    expect(formatPercent(0)).toBe("0.00%");
    expect(formatPercent(0.2)).toBe("20.00%");
    expect(formatPercent(-0.2)).toBe("-20.00%");
    expect(formatPercent(1)).toBe("100.00%");
    expect(formatPercent(0.17167145)).toBe("17.17%");
    // 17.17% must never become 1717%
    expect(formatPercent(0.17167145)).not.toMatch(/1717/);
  });

  it("correlation: fixed 4 decimals", () => {
    expect(formatCorrelation(0.4622)).toBe("0.4622");
    expect(formatCorrelation(0.745)).toBe("0.7450");
    expect(formatCorrelation(0.3518)).toBe("0.3518");
  });

  it("ratio: N.NN×", () => {
    expect(formatRatio(6.5555)).toBe("6.56×");
    expect(formatRatio(2)).toBe("2.00×");
  });

  it("missing / non-finite → the missing token", () => {
    expect(formatNumber(Number.NaN)).toBe(MISSING_DISPLAY);
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe(MISSING_DISPLAY);
    expect(formatCorrelation(Number.NaN)).toBe(MISSING_DISPLAY);
  });

  it("date: ISO passthrough is the canonical deterministic form", () => {
    expect(formatDate("2026-04-02")).toBe("2026-04-02");
  });
});

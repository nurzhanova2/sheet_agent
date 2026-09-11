import { describe, expect, it } from "vitest";
import { slashIsMutation, slashPrompt, slashTurnIntent } from "./resolve.js";

describe("slashTurnIntent — identity lock (Stage 22)", () => {
  it("/chart is the only visualization intent", () => {
    expect(slashTurnIntent("chart")).toMatchObject({ analytical: true, visualization: true });
    for (const name of ["analyze", "summary", "filter", "sort", "pivot", "clean"] as const) {
      expect(slashTurnIntent(name)).toMatchObject({ analytical: true, visualization: false });
    }
  });

  it("mutation commands are neither analytical reads nor charts", () => {
    expect(slashTurnIntent("formula")).toMatchObject({ analytical: false, visualization: false });
    expect(slashTurnIntent("highlight")).toMatchObject({ analytical: false, visualization: false });
    expect(slashIsMutation("formula")).toBe(true);
    expect(slashIsMutation("highlight")).toBe(true);
    expect(slashIsMutation("chart")).toBe(false);
  });
});

describe("slashPrompt — RU/EN natural-language phrasing", () => {
  it("/chart keeps the arguments and frames them as a chart", () => {
    expect(slashPrompt("chart", "средний Plan и Fact по Category", "ru")).toContain("средний Plan и Fact по Category");
    expect(slashPrompt("chart", "mean Plan and Fact by Category", "en").toLowerCase()).toContain("chart");
  });

  it("/filter and /sort explicitly forbid a workbook change and are language-matched", () => {
    expect(slashPrompt("filter", "Fact < Plan", "ru")).toMatch(/строк.*ничего не меняй/s);
    expect(slashPrompt("filter", "Fact < Plan", "en")).toMatch(/rows.*do not change the workbook/s);
    expect(slashPrompt("sort", "Revenue desc", "ru")).toMatch(/Отсортируй/);
  });

  it("argument-optional commands fall back to a generic phrasing", () => {
    expect(slashPrompt("summary", "", "en")).toBe("Summarise the selected data.");
    expect(slashPrompt("analyze", "", "ru")).toMatch(/Проанализируй/);
  });

  it("/formula passes the user's imperative through unchanged", () => {
    expect(slashPrompt("formula", "добавь колонку Margin = Revenue - Cost", "ru")).toBe(
      "добавь колонку Margin = Revenue - Cost",
    );
  });
});

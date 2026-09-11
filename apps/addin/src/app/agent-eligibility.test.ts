import { describe, expect, it } from "vitest";
import { classifyAgentEligibility } from "./agent-eligibility.js";
import { routeTurn, type RouteContext } from "./conversation-route.js";

const ctx: RouteContext = { hasSelection: true, knownEntities: [], hasPriorResult: false };
const elig = (text: string): boolean => classifyAgentEligibility(text, routeTurn(text, ctx)).eligible;

describe("classifyAgentEligibility", () => {
  it("routes investigative / discovery asks to the agent", () => {
    expect(elig("What is this workbook about?")).toBe(true);
    expect(elig("what's in this whole workbook?")).toBe(true);
    expect(elig("What changed between 2024 and 2025?")).toBe(true);
    expect(elig("Why did NPL increase this year?")).toBe(true);
    expect(elig("What appears to be driving the deterioration?")).toBe(true);
    expect(elig("Break down the change by each sector.")).toBe(true);
  });

  it("keeps plain deterministic / transform / chat turns off the agent", () => {
    expect(elig("What is the average Revenue?")).toBe(false);
    expect(elig("Which category has the highest average Fact?")).toBe(false);
    expect(elig("Sort Fact descending.")).toBe(false);
    expect(elig("Show only the top 2 by Fact.")).toBe(false);
    expect(elig("Chart that.")).toBe(false);
    expect(elig("What is PD?")).toBe(false);
    expect(elig("Add a column with the variance.")).toBe(false);
    expect(elig("What columns are in this table?")).toBe(false);
  });

  it("a cross-target superlative is agentic; a single-sheet superlative is not", () => {
    expect(elig("Which sector deteriorated the most between 2024 and 2025?")).toBe(true);
    expect(elig("Which product sold the most?")).toBe(false);
  });
});

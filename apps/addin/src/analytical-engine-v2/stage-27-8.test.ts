import { describe, expect, it } from "vitest";
import { runAnalyticalEngine } from "./engine.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { composeFinancialNote } from "./narration/financial-note.js";
import type { VerifiedFinding } from "./insight/verified-finding.js";

function finding(overrides: Partial<VerifiedFinding>): VerifiedFinding {
  return {
    id: "f1",
    findingType: "change",
    subject: "Assets",
    direction: "up",
    values: [
      { name: "startValue", value: 100, text: "100", unit: { kind: "amount" }, at: "2025-11" },
      { name: "endValue", value: 120, text: "120", unit: { kind: "amount" }, at: "2025-12" },
      { name: "absoluteChange", value: 20, text: "+20", unit: { kind: "amount" } },
      { name: "percentageChange", value: 0.2, text: "+20%", unit: { kind: "percent_fraction" } },
    ],
    materiality: [],
    confidence: [],
    caveats: [],
    provenance: { resultRef: "result_1", tool: "change.compute", sourceRange: "S!A1:B2", sourceVersion: "v1", periods: ["2025-11", "2025-12"] },
    statement: "",
    ...overrides,
  };
}

describe("Stage 27.8 — period correctness and financial note composition", () => {
  it("uses the tool's latest-versus-previous default for an implicit current-period request", async () => {
    const table = fixtureOperations();
    let firstPrompt = "";
    const turn = await runAnalyticalEngine({
      turnId: "stage_278_period",
      request: "How much did Defect ratio change versus the previous period?",
      schema: table.schema,
      grids: table.grids,
      language: "en",
      state: EMPTY_ANALYTICAL_STATE,
      decide: (messages) => {
        firstPrompt = messages.find((message) => message.role === "user")?.content ?? "";
        return JSON.stringify({ kind: "tool_call", tool: "change.compute", arguments: { metric: "Defect ratio", periodIntent: { kind: "latest_vs_previous" } }, final: true });
      },
      narrate: async () => "",
    });
    expect(firstPrompt).toContain("periodIntent");
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    const points = [...buildPeriodIndex(table.schema, table.grids).points].sort((a, b) => a.orderKey - b.orderKey);
    expect(turn.analysis.primary.periodCanonicals).toEqual([points[points.length - 2]?.canonical, points[points.length - 1]?.canonical]);
  });

  it("composes a change as a concise conclusion, evidence, and explicit period", () => {
    const note = composeFinancialNote([finding({})], "en")?.join(" ") ?? "";
    expect(note).toContain("Assets");
    expect(note).toContain("20%");
    expect(note).toContain("+20");
    expect(note).toContain("2025-11");
    expect(note).toContain("2025-12");
  });

  it("names the volatility method instead of presenting a bare score", () => {
    const note = composeFinancialNote([finding({ findingType: "volatility", subject: "Liquidity", direction: "none", values: [{ name: "score", value: 5.2, text: "5.2", unit: { kind: "score" } }], detail: { method: "std_pct_change" } })], "en")?.join(" ") ?? "";
    expect(note).toContain("most volatile");
    expect(note).toContain("5.2");
    expect(note).toContain("standard deviation of percentage changes");
  });
});

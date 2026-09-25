import { describe, expect, it } from "vitest";
import { runAnalyticalEngine } from "./engine.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";

describe("Stage 27.8 — period correctness", () => {
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
});

import { describe, expect, it } from "vitest";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { runAnalyticalEngine } from "./engine.js";
import { extractFindings } from "./insight/extract-findings.js";
import { ResultStore } from "./results/result-store.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { findTool, buildToolEnv } from "./tools/registry.js";

const intent = { kind: "latest_vs_previous" } as const;

async function currentComparison(request: string) {
  const table = fixtureOperations();
  return runAnalyticalEngine({
    turnId: "period_intent",
    request,
    schema: table.schema,
    grids: table.grids,
    language: "ru",
    state: EMPTY_ANALYTICAL_STATE,
    decide: () => JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { periodIntent: intent }, final: true }),
    narrate: async () => "",
  });
}

describe("Stage 28A — PeriodIntent ownership", () => {
  it.each([
    "Как изменились активы относительно предыдущего периода?",
    "На сколько выросли активы?",
  ])("resolves an implicit current comparison to the latest two periods: %s", async (request) => {
    const table = fixtureOperations();
    const points = [...buildPeriodIndex(table.schema, table.grids).points].sort((a, b) => a.orderKey - b.orderKey);
    const turn = await currentComparison(request);
    expect(turn.kind).toBe("answered");
    if (turn.kind === "answered") expect(turn.analysis.primary.periodCanonicals).toEqual([points.at(-2)?.canonical, points.at(-1)?.canonical]);
  });

  it("rejects endpoints supplied without a compatible named_pair intent", () => {
    const table = fixtureOperations();
    const env = buildToolEnv(table.schema, table.grids, new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 3000 }), EMPTY_ANALYTICAL_STATE);
    const points = [...env.periodIndex.points].sort((a, b) => a.orderKey - b.orderKey);
    const outcome = findTool("change.compare_periods")!.run({ startPeriod: points[0]!.canonical, endPeriod: points.at(-1)!.canonical, periodIntent: intent }, env);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/endpoints require periodIntent/u);
  });

  it("honours a named historical pair exactly", () => {
    const table = fixtureOperations();
    const env = buildToolEnv(table.schema, table.grids, new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 3000 }), EMPTY_ANALYTICAL_STATE);
    const points = [...env.periodIndex.points].sort((a, b) => a.orderKey - b.orderKey);
    const pair = { kind: "named_pair", start: points[0]!.canonical, end: points.at(-2)!.canonical } as const;
    const outcome = findTool("change.compare_periods")!.run({ periodIntent: pair }, env);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.periodCanonicals).toEqual([pair.start, pair.end]);
  });

  it("preserves intent and resolved concrete periods in resulting findings", () => {
    const table = fixtureOperations();
    const env = buildToolEnv(table.schema, table.grids, new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 3000 }), EMPTY_ANALYTICAL_STATE);
    const outcome = findTool("change.compare_periods")!.run({ periodIntent: intent }, env);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const finding = extractFindings(outcome.result, { locale: "en" })[0];
    expect(finding?.detail?.["periodIntent"]).toEqual(intent);
    expect(finding?.detail?.["resolvedPeriods"]).toEqual(outcome.result.periodCanonicals);
  });
});

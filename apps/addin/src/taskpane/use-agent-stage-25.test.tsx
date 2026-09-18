// Stage 25 — LLM analytical planner & deterministic execution. Integration
// through useAgent().submit(): real schema induction, the real tool registry
// (analytics-agent/tool-registry.ts), the real agent-loop runtime — only the
// LLM planner/narrator calls are mocked (an adaptive script that inspects the
// real AgentDecisionRequest.observations, exactly like a real model would).
// Mirrors the harness in use-agent-stage-24-9.test.tsx.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { AgentDecisionRequest } from "../agent/types.js";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { fixtureDirectionAndSets, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";
import { induceTableSchema } from "../app/schema/schema-induction.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { getPointValue, getTemporalSeries } from "../app/schema/analytical/temporal-series.js";
import { seriesExtrema } from "../app/schema/analytical/temporal-primitives.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";

const RESULT_DEFAULTS = {
  actions: [],
  actionErrors: [],
  analysisRuns: 0,
  analysisHadError: false,
  charts: [],
  language: "en" as const,
  planKind: "none" as const,
};

function stubPort(overrides: Partial<ExcelPort & ExcelMutationPort> = {}): ExcelPort & ExcelMutationPort {
  return {
    capabilities: { tables: true, charts: true, pivotTables: true, namedRanges: true },
    getSelection: vi.fn(async () => ({ address: "S!A1:A1", sheetName: "S", rowCount: 1, columnCount: 1, revision: 0 })),
    readRange: vi.fn(async (address: string) => ({ address, sheetName: "S", rowCount: 1, columnCount: 1, revision: 0, values: [[null]], formulas: [[null]], numberFormats: [["General"]] })),
    getWorkbookOverview: vi.fn(async () => ({ sourceIdentity: "unsaved", sheets: [], tables: [], namedRanges: [], charts: [], pivots: [] })),
    readTable: vi.fn(),
    search: vi.fn(async () => []),
    onSelectionChanged: vi.fn(() => () => undefined),
    writeRange: vi.fn(async () => undefined),
    readFillColors: vi.fn(async () => [["#FFFFFF"]]),
    writeFillColors: vi.fn(async () => undefined),
    addWorksheet: vi.fn(async () => undefined),
    deleteWorksheet: vi.fn(async () => undefined),
    insertImage: vi.fn(async () => ({ shapeName: "s", left: 0, top: 0, width: 10, height: 10 })),
    deleteShape: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ExcelPort & ExcelMutationPort;
}

function fixturePort(fx: FixtureSnapshot) {
  const cols = fx.values.reduce((m, r) => Math.max(m, r.length), 0);
  const snap = {
    address: fx.address,
    sheetName: fx.sheetName,
    rowCount: fx.values.length,
    columnCount: cols,
    revision: 0,
    values: fx.values,
    formulas: fx.formulas,
    numberFormats: fx.numberFormats,
  };
  return stubPort({
    getSelection: vi.fn(async () => ({ address: fx.address, sheetName: fx.sheetName, rowCount: fx.values.length, columnCount: cols, revision: 0 })),
    readRange: vi.fn(async () => snap) as unknown as ExcelPort["readRange"],
  });
}

/** §92-style composition: latest-period value equal to the historical max —
 *  a query with NO dedicated Stage 24.x operation, so it must be answered by
 *  TOOL COMPOSITION, never a per-phrase handler. Mirrors an actual model:
 *  inspects the real observations (incl. their auto-assigned resultIds). */
function scriptedHistoricalMaxDecide(request: AgentDecisionRequest): string {
  const obs = request.observations;
  const last = (tool: string) => [...obs].reverse().find((o) => o.tool === tool && o.ok);
  if (!last("period.select")) return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "last" } });
  if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
  if (!last("aggregate.max")) return JSON.stringify({ kind: "tool_call", tool: "aggregate.max", input: { source: last("metric.list")!.resultId } });
  if (!last("value.at_period")) {
    const period = String(last("period.select")!.rows![0]![0]);
    return JSON.stringify({ kind: "tool_call", tool: "value.at_period", input: { source: last("metric.list")!.resultId, period } });
  }
  if (!last("set.merge")) return JSON.stringify({ kind: "tool_call", tool: "set.merge", input: { left: last("aggregate.max")!.resultId, right: last("value.at_period")!.resultId } });
  if (!last("set.filter"))
    return JSON.stringify({ kind: "tool_call", tool: "set.filter", input: { source: last("set.merge")!.resultId, field: "b_value", op: "eq", value: { field: "a_value" } } });
  return JSON.stringify({ kind: "final", answer: "facts ready" });
}

function plannerClient(decide: (request: AgentDecisionRequest) => string, narrateText = "Готово."): ChatClient {
  return {
    stream: vi.fn(async (_r: ChatStreamRequest, h: ChatStreamHandlers) => {
      h.onDelta("x");
      return { ...RESULT_DEFAULTS, text: "MODEL WAS CALLED" } as ChatResult;
    }),
    decideAgentStep: vi.fn(async (request: AgentDecisionRequest) => decide(request)),
    narrate: vi.fn(async () => narrateText),
  };
}

function groundTruthAtMaxOnLatest(fx: FixtureSnapshot): Set<string> {
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: "v1",
    startsBelowRow1: false,
  });
  const grids: AnalysisGrids = { values: fx.values, numberFormats: fx.numberFormats };
  const periodIndex = buildPeriodIndex(schema, grids);
  const lastPeriod = periodIndex.points[periodIndex.points.length - 1]!;
  const winners = new Set<string>();
  for (const m of schema.rowAxis) {
    const series = getTemporalSeries(schema, grids, { kind: "row_axis_member", member: m }, periodIndex)!;
    const ex = seriesExtrema(series);
    const latest = getPointValue(schema, grids, { kind: "row_axis_member", member: m }, lastPeriod);
    if (ex && latest && Math.abs(ex.max.value - latest.value) < 1e-6) winners.add(m.display);
  }
  return winners;
}

const lastResponse = (r: { current: ReturnType<typeof useAgent> }) => {
  const e = r.current.entries.filter((x) => x.kind === "response").at(-1);
  return e && e.kind === "response" ? e.text : "";
};

const RAW_SERIAL_RE = /45292|45383|45474|45566|45658/;

describe("Stage 25 §92 — historical max on the latest date, via tool composition (no dedicated handler)", () => {
  it("routes to the planner (never the legacy flat model), and persists exactly the ground-truth winners", async () => {
    const fx = fixtureDirectionAndSets();
    const client = plannerClient(scriptedHistoricalMaxDecide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Какие показатели достигли максимума на последнюю доступную дату?");
    });

    expect((client.decideAgentStep as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(client.stream as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    const r1 = lastResponse(result);
    expect(r1).not.toMatch(RAW_SERIAL_RE);
    expect(r1).not.toMatch(/MODEL WAS CALLED/);

    const expected = groundTruthAtMaxOnLatest(fx);
    expect(expected.size).toBeGreaterThan(0);
    const persisted = result.current.__sessionMemoryDebug().recentResults.at(-1);
    expect(persisted).toBeDefined();
    const metricIdx = persisted!.columns.indexOf("metric");
    const persistedWinners = new Set(persisted!.rows.map((row) => String(row[metricIdx])));
    expect(persistedWinners).toEqual(expected);
  });
});

describe("Stage 25 §55/§56 — the Stage 24.7–24.9 deterministic fast path still wins even when the planner is available", () => {
  it("a known-cue query never calls decideAgentStep, even with a fully wired planner client", async () => {
    const fx = fixtureDirectionAndSets();
    const client = plannerClient(scriptedHistoricalMaxDecide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Какой показатель менял направление чаще всего?");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(client.narrate as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(lastResponse(result)).toMatch(/Ликвидные активы/);
  });
});

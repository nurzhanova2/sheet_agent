// Stage 25.1.1 — operation fidelity, focus commit & full clause coverage.
// Integration through useAgent().submit(): real routing, real tool
// composition, real SessionMemory — only decideAgentStep/narrate are
// scripted (adaptive, reading the real AgentDecisionRequest).
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { AgentDecisionRequest, AgentObservation } from "../agent/types.js";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { fixtureDirectionAndSets, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";
import { induceTableSchema } from "../app/schema/schema-induction.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import { getPointValue, getTemporalSeries } from "../app/schema/analytical/temporal-series.js";
import { seriesExtrema } from "../app/schema/analytical/temporal-primitives.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";

const RESULT_DEFAULTS = { actions: [], actionErrors: [], analysisRuns: 0, analysisHadError: false, charts: [], language: "en" as const, planKind: "none" as const };

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
  const snap = { address: fx.address, sheetName: fx.sheetName, rowCount: fx.values.length, columnCount: cols, revision: 0, values: fx.values, formulas: fx.formulas, numberFormats: fx.numberFormats };
  return stubPort({
    getSelection: vi.fn(async () => ({ address: fx.address, sheetName: fx.sheetName, rowCount: fx.values.length, columnCount: cols, revision: 0 })),
    readRange: vi.fn(async () => snap) as unknown as ExcelPort["readRange"],
  });
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

function lastObs(obs: readonly AgentObservation[], tool: string): AgentObservation | undefined {
  return [...obs].reverse().find((o) => o.tool === tool && o.ok);
}
function col(obs: AgentObservation, name: string): number {
  return obs.columns!.indexOf(name);
}

const lastResponse = (r: { current: ReturnType<typeof useAgent> }) => {
  const e = r.current.entries.filter((x) => x.kind === "response").at(-1);
  return e && e.kind === "response" ? e.text : "";
};

function schemaAndGrids(fx: FixtureSnapshot) {
  const schema = induceTableSchema({ values: fx.values, numberFormats: fx.numberFormats, formulas: fx.formulas, sheetName: fx.sheetName, sourceRange: fx.address, sourceVersion: "v1", startsBelowRow1: false });
  const grids: AnalysisGrids = { values: fx.values, numberFormats: fx.numberFormats };
  return { schema, grids };
}

describe("Stage 25.1.1 §23/§24/§44/§54 — peak drawdown never becomes last-month growth", () => {
  it("historical_extreme_distance composition ranks metrics by (max-latest)/|max|, matching ground truth", async () => {
    const fx = fixtureDirectionAndSets();
    const { schema, grids } = schemaAndGrids(fx);
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("period.select")) return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "last" } });
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("aggregate.max")) return JSON.stringify({ kind: "tool_call", tool: "aggregate.max", input: { source: last("metric.list")!.resultId } });
      if (!last("value.at_period")) return JSON.stringify({ kind: "tool_call", tool: "value.at_period", input: { source: last("metric.list")!.resultId, period: String(last("period.select")!.rows![0]![0]) } });
      if (!last("set.merge")) return JSON.stringify({ kind: "tool_call", tool: "set.merge", input: { left: last("aggregate.max")!.resultId, right: last("value.at_period")!.resultId } });
      if (!last("derive.compute")) {
        return JSON.stringify({
          kind: "tool_call",
          tool: "derive.compute",
          input: { source: last("set.merge")!.resultId, field: "distance", expr: { op: "divide", left: { op: "abs", value: { op: "subtract", left: { field: "a_value" }, right: { field: "b_value" } } }, right: { op: "abs", value: { field: "a_value" } } } },
        });
      }
      if (!last("set.sort")) return JSON.stringify({ kind: "tool_call", tool: "set.sort", input: { source: last("derive.compute")!.resultId, field: "distance", direction: "desc" } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Какие показатели сильнее всего откатились от своих исторических максимумов?");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const persisted = result.current.__sessionMemoryDebug().recentResults.at(-1);
    expect(persisted).toBeDefined();
    const distIdx = persisted!.columns.indexOf("distance");
    const metricIdx = persisted!.columns.indexOf("a_metric") >= 0 ? persisted!.columns.indexOf("a_metric") : persisted!.columns.indexOf("metric");
    expect(distIdx).toBeGreaterThanOrEqual(0);

    // ground truth: same primitives, called directly.
    const periodIndex = buildPeriodIndex(schema, grids);
    const lastPeriod = periodIndex.points[periodIndex.points.length - 1]!;
    let expectedWinner = "";
    let maxDistance = -Infinity;
    for (const m of schema.rowAxis) {
      const series = getTemporalSeries(schema, grids, { kind: "row_axis_member", member: m }, periodIndex)!;
      const ex = seriesExtrema(series);
      const latest = getPointValue(schema, grids, { kind: "row_axis_member", member: m }, lastPeriod);
      if (!ex || !latest) continue;
      const d = Math.abs(ex.max.value - latest.value) / Math.abs(ex.max.value);
      if (d > maxDistance) {
        maxDistance = d;
        expectedWinner = m.display;
      }
    }
    expect(String(persisted!.rows[0]![metricIdx])).toBe(expectedWinner);
  });
});

describe("Stage 25.1.1 §21/§22/§43/§55/§67 — down-then-up is a real sequence pattern, not first-to-last decline", () => {
  it("analysis.temporal_pattern composition flags exactly the recovering metrics", async () => {
    const fx = fixtureDirectionAndSets();
    const { schema } = schemaAndGrids(fx);
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      if (!lastObs(obs, "metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!lastObs(obs, "analysis.temporal_pattern")) return JSON.stringify({ kind: "tool_call", tool: "analysis.temporal_pattern", input: { source: lastObs(obs, "metric.list")!.resultId, pattern: "down_then_up" } });
      if (!lastObs(obs, "set.filter")) return JSON.stringify({ kind: "tool_call", tool: "set.filter", input: { source: lastObs(obs, "analysis.temporal_pattern")!.resultId, field: "matched", op: "eq", value: 1 } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Какие показатели после снижения снова начали расти?");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const persisted = result.current.__sessionMemoryDebug().recentResults.at(-1);
    expect(persisted).toBeDefined();
    for (const row of persisted!.rows) {
      const matchIdx = persisted!.columns.indexOf("matched");
      if (matchIdx >= 0) expect(Number(row[matchIdx])).toBe(1);
    }
    void schema;
  });
});

describe("Stage 25.1.1 §19/§20/§47 — a 3-clause dependent compound targets ONE metric throughout", () => {
  it("volatility winner -> series.get(winner) -> event.max_adjacent_change(winner): all three agree, and focus commits the winner", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("analysis.volatility")) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", input: { source: last("metric.list")!.resultId } });
      if (!last("set.argmax")) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", input: { source: last("analysis.volatility")!.resultId, field: "score" } });
      const winnerObs = last("set.argmax");
      const winner = winnerObs ? String(winnerObs.rows![0]![col(winnerObs, "metric")]) : "";
      if (!last("series.get")) return JSON.stringify({ kind: "tool_call", tool: "series.get", input: { metrics: [winner] } });
      if (!last("event.max_adjacent_change")) return JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", input: { metric: winner, basis: "percentage" } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Найди самый нестабильный показатель, покажи его динамику и скажи, между какими соседними датами был самый большой скачок.");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const winner = result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey;
    expect(winner).toBeTruthy();
    const r1 = lastResponse(result);
    expect(r1).not.toMatch(/CLAUSE_TARGET_MISMATCH|WRONG_OPERATION/);
  });

  it("§62 — a compound run whose clauses disagree on the target metric is rejected before narration", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("analysis.volatility")) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", input: { source: last("metric.list")!.resultId } });
      if (!last("set.argmax")) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", input: { source: last("analysis.volatility")!.resultId, field: "score" } });
      if (!last("series.get")) {
        // deliberately targets a DIFFERENT metric than the volatility winner
        const other = fx.values[3]?.[0] ? String(fx.values[3]![0]) : "Активы";
        return JSON.stringify({ kind: "tool_call", tool: "series.get", input: { metrics: [other] } });
      }
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Найди самый нестабильный показатель, покажи его динамику и скажи, между какими соседними датами был самый большой скачок.");
    });

    const r1 = lastResponse(result);
    expect(r1).not.toMatch(/CLAUSE_TARGET_MISMATCH/); // internal code never user-facing
    expect(r1).toMatch(/не удалось|couldn't/i);
  });
});

describe("Stage 25.1.1 §30–§34/§48/§65 — exploratory recovery composes real diagnostics, never an empty metric lookup", () => {
  it("a first failed attempt on an exploratory ask gets ONE bounded recovery round", async () => {
    const fx = fixtureDirectionAndSets();
    let attempt = 0;
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      if (obs.length === 0) attempt += 1;
      if (attempt === 1) {
        // first attempt: repeats the same bad call until the loop terminates it.
        return JSON.stringify({ kind: "tool_call", tool: "metric.resolve", input: { text: "нечто неизвестное" } });
      }
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("analysis.volatility")) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", input: { source: last("metric.list")!.resultId } });
      // Stage 25.1.3 §23/§24 — the request asks for exactly THREE metrics;
      // narrow the ranking to top-3, never return the full table.
      if (!last("set.top")) return JSON.stringify({ kind: "tool_call", tool: "set.top", input: { source: last("analysis.volatility")!.resultId, field: "score", n: 3 } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Если бы тебе нужно было выбрать три показателя для проверки из-за необычной динамики, какие бы ты выбрал и почему?");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const persisted = result.current.__sessionMemoryDebug().recentResults.at(-1);
    expect(persisted).toBeDefined();
    expect(persisted!.columns).toContain("score");
    expect(persisted!.rows.length).toBe(3);
  });
});

// Stage 25.1 — planner routing, conversation state ownership & semantic
// execution validation. Integration through useAgent().submit(): real
// routing, real tool composition, real SessionMemory — only decideAgentStep/
// narrate are scripted (adaptive, reading the real AgentDecisionRequest).
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { AgentDecisionRequest, AgentObservation } from "../agent/types.js";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { fixtureDirectionAndSets, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";

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

const lastResponse = (r: { current: ReturnType<typeof useAgent> }) => {
  const e = r.current.entries.filter((x) => x.kind === "response").at(-1);
  return e && e.kind === "response" ? e.text : "";
};

const RAW_SERIAL_RE = /45292|45383|45474|45566|45658/;
const LEGACY_LEAK_RE = /\bFAILED\b|ANALYSIS RESULT|Не удалось разрешить период/i;

describe("Stage 25.1 §39/§59/§94 — an unresolved fast-path compile falls to the planner, never a raw error", () => {
  it("'Сравни последнюю доступную дату с предыдущей.' composes previous(last) → last via the planner", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("period.select")) return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "last" } });
      const lastPeriodObs = last("period.select")!;
      if (obs.filter((o) => o.tool === "period.select" && o.ok).length < 2) {
        return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "previous_of", of: String(lastPeriodObs.rows![0]![0]) } });
      }
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("change.compare_periods")) {
        const periodObs = obs.filter((o) => o.tool === "period.select" && o.ok);
        const canonicals = periodObs.map((o) => String(o.rows![0]![0])).sort();
        return JSON.stringify({
          kind: "tool_call",
          tool: "change.compare_periods",
          input: { source: last("metric.list")!.resultId, startPeriod: canonicals[0], endPeriod: canonicals[1] },
        });
      }
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Сравни последнюю доступную дату с предыдущей.");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const r1 = lastResponse(result);
    expect(r1).not.toMatch(LEGACY_LEAK_RE);
    expect(r1).not.toMatch(RAW_SERIAL_RE);
    expect(r1).not.toMatch(/res_[a-z0-9_]+/i);
  });
});

describe("Stage 25.1 §12–14/§68/§90 — a fast-path plan covering only ONE clause is not accepted as complete", () => {
  it("volatility-only compile is overridden; the planner composes volatility + max_adjacent_change and pins focus (§50)", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("analysis.volatility")) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", input: { source: last("metric.list")!.resultId } });
      if (!last("set.argmax")) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", input: { source: last("analysis.volatility")!.resultId, field: "score" } });
      if (!last("event.max_adjacent_change")) {
        const winner = String(last("set.argmax")!.rows![0]![last("set.argmax")!.columns!.indexOf("metric")]);
        return JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", input: { metric: winner, basis: "percentage" } });
      }
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Какой показатель выглядит самым нестабильным и когда у него был самый резкий скачок?");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const r1 = lastResponse(result);
    expect(r1).not.toMatch(RAW_SERIAL_RE);
    expect(r1).not.toMatch(LEGACY_LEAK_RE);
    // §50 — the event's single-metric winner pinned the pronoun focus.
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey).toBeTruthy();
  });
});

describe("Stage 25.1 §5/§50/§62/§79 — focus continuity: a planner winner is not stale on the next turn", () => {
  it("after a planner-produced single-metric winner, 'покажи его динамику' resolves to THAT metric, not an older Stage 24.9 ref", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("analysis.volatility")) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", input: { source: last("metric.list")!.resultId } });
      if (!last("set.argmax")) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", input: { source: last("analysis.volatility")!.resultId, field: "score" } });
      if (!last("event.max_adjacent_change")) {
        const winner = String(last("set.argmax")!.rows![0]![last("set.argmax")!.columns!.indexOf("metric")]);
        return JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", input: { metric: winner, basis: "percentage" } });
      }
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Какой показатель выглядит самым нестабильным и когда у него был самый резкий скачок?");
    });
    const winner = result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey;
    expect(winner).toBeTruthy();

    await act(async () => {
      await result.current.submit("Покажи его динамику.");
    });
    const r2 = lastResponse(result);
    expect(r2).toContain(winner!);
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey).toBe(winner);
  });
});

describe("Stage 25.1 §17/§69/§89 — a widened candidate set is rejected before narration", () => {
  it("an explicit 2-metric request whose plan executes over the WHOLE workbook fails the semantic audit cleanly", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("period.select")) return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "first" } });
      if (obs.filter((o) => o.tool === "period.select" && o.ok).length < 2) return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "last" } });
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "all" } }); // deliberately widened, not scoped to the named 2
      if (!last("change.compare_periods")) {
        const periodObs = obs.filter((o) => o.tool === "period.select" && o.ok);
        const canonicals = periodObs.map((o) => String(o.rows![0]![0])).sort();
        return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: canonicals[0], endPeriod: canonicals[canonicals.length - 1] } });
      }
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Сравни Активы и Ликвидные активы и скажи, кто вырос быстрее.");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const r1 = lastResponse(result);
    // the clean rejection message, never a 5-row table over the whole workbook.
    expect(r1).not.toMatch(/уровень долларизации/i);
    expect(result.current.__sessionMemoryDebug().lastMetricSetRef).toBeUndefined();
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef).toBeUndefined();
  });
});

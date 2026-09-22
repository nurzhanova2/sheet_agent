// Stage 25.1.2 — semantic audit false-rejection, legacy fallback isolation &
// planner stream leak fix. Integration through useAgent().submit(): real
// routing, real tool composition, real SessionMemory — only
// decideAgentStep/narrate are scripted (adaptive, reading the real
// AgentDecisionRequest), exactly like the Stage 25.1.1 harness.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { AgentDecisionRequest, AgentObservation } from "../agent/types.js";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { fixtureMetricPrecedence, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";

const RESULT_DEFAULTS = { actions: [], actionErrors: [], analysisRuns: 0, analysisHadError: false, charts: [], language: "en" as const, planKind: "none" as const };

const FORBIDDEN_RE = /\bFAILED\b|ANALYSIS RESULT|\(rejected\)|requested operation\(s\)|Анализ недоступен|"kind"\s*:\s*"(?:tool_call|clarify|final)"|"tool"\s*:\s*"[a-z_.]+"/i;

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

function plannerClient(decide: (request: AgentDecisionRequest) => string, narrateText: (request: readonly { readonly content: string }[]) => string = () => "Готово."): ChatClient {
  return {
    stream: vi.fn(async (_r: ChatStreamRequest, h: ChatStreamHandlers) => {
      h.onDelta("x");
      return { ...RESULT_DEFAULTS, text: "MODEL WAS CALLED" } as ChatResult;
    }),
    decideAgentStep: vi.fn(async (request: AgentDecisionRequest) => decide(request)),
    narrate: vi.fn(async (messages) => narrateText(messages)),
  };
}

function lastObs(obs: readonly AgentObservation[], tool: string): AgentObservation | undefined {
  return [...obs].reverse().find((o) => o.tool === tool && o.ok);
}

const allResponses = (r: { current: ReturnType<typeof useAgent> }): string[] =>
  r.current.entries.filter((x) => x.kind === "response").map((e) => (e.kind === "response" ? e.text : ""));

describe("Stage 25.1.2 §17/§2/§3 — 'compare the last date with the previous one' resolves P4->P5, cleanly, with no legacy leak", () => {
  it("turn1 succeeds via the planner, commits the P4->P5 interval, and never shows a raw/legacy string", async () => {
    const fx = fixtureMetricPrecedence();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      const selects = obs.filter((o) => o.tool === "period.select" && o.ok);
      if (!last("period.list")) return JSON.stringify({ kind: "tool_call", tool: "period.list", input: {} });
      if (selects.length === 0) return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "last" } });
      if (selects.length === 1) {
        const lastP = String(selects[0]!.rows![0]![0]);
        return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "previous_of", of: lastP } });
      }
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("change.compare_periods")) {
        const lastP = String(selects[0]!.rows![0]![0]);
        const prevP = String(selects[1]!.rows![0]![0]);
        return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: prevP, endPeriod: lastP } });
      }
      return JSON.stringify({ kind: "final", answer: "Сравнение выполнено." });
    };
    const client = plannerClient(decide, () => "Сравнение выполнено.");
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Сравни последнюю доступную дату с предыдущей.");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    expect(responses.at(-1)).toBe("Сравнение выполнено.");

    const mem = result.current.__sessionMemoryDebug();
    expect(mem.lastPeriodRef?.startCanonical).toBe("2025-11-01");
    expect(mem.lastPeriodRef?.endCanonical).toBe("2025-12-01");
  });
});

describe("Stage 25.1.2 §18 — follow-up filters the SAME P4->P5 comparison, never falls to the legacy analyzer", () => {
  it("turn2 reuses the committed interval to filter decliners, with no legacy leak", async () => {
    const fx = fixtureMetricPrecedence();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      const req = request.originalUserRequest;
      if (req.includes("предыдущей")) {
        const selects = obs.filter((o) => o.tool === "period.select" && o.ok);
        if (!last("period.list")) return JSON.stringify({ kind: "tool_call", tool: "period.list", input: {} });
        if (selects.length === 0) return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "last" } });
        if (selects.length === 1) {
          const lastP = String(selects[0]!.rows![0]![0]);
          return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "previous_of", of: lastP } });
        }
        if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
        if (!last("change.compare_periods")) {
          const lastP = String(selects[0]!.rows![0]![0]);
          const prevP = String(selects[1]!.rows![0]![0]);
          return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: prevP, endPeriod: lastP } });
        }
        return JSON.stringify({ kind: "final", answer: "Сравнение выполнено." });
      }
      // turn 2 — reuse the remembered interval.
      if (!last("reference.previous_period")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_period", input: {} });
      const ref = last("reference.previous_period")!;
      const start = String(ref.rows![0]![0]);
      const end = String(ref.rows![ref.rows!.length - 1]![0]);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("change.compare_periods")) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: start, endPeriod: end } });
      if (!last("set.filter")) return JSON.stringify({ kind: "tool_call", tool: "set.filter", input: { source: last("change.compare_periods")!.resultId, field: "percentageChange", op: "lt", value: 0 } });
      return JSON.stringify({ kind: "final", answer: "Вот показатели, которые снизились." });
    };
    const client = plannerClient(decide, (messages) => (messages.some((m) => m.content.includes("снизились")) ? "Вот показатели, которые снизились." : "Сравнение выполнено."));
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Сравни последнюю доступную дату с предыдущей.");
    });
    await act(async () => {
      await result.current.submit("Теперь покажи только показатели, которые снизились.");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    expect(responses.at(-1)).toBe("Вот показатели, которые снизились.");

    // "доля ликвидных активов в активах" is the ONLY metric that declined
    // between P4 (01.11.2025) and P5 (01.12.2025) in this fixture.
    const persisted = result.current.__sessionMemoryDebug().recentResults.at(-1);
    expect(persisted).toBeDefined();
    const metricIdx = persisted!.columns.indexOf("metric");
    expect(persisted!.rows.map((r) => r[metricIdx])).toEqual(["доля ликвидных активов в активах"]);
  });
});

describe("Stage 25.1.2 §19 — a failed predecessor turn never lets the follow-up leak to the legacy analyzer", () => {
  it("turn1 fails (repeated bad tool call), turn2's follow-up gets a clean clarification, never a legacy string", async () => {
    const fx = fixtureMetricPrecedence();
    const decide = (request: AgentDecisionRequest): string => {
      const req = request.originalUserRequest;
      if (req.includes("предыдущей")) {
        // deliberately repeats an invalid tool call so the loop terminates.
        return JSON.stringify({ kind: "tool_call", tool: "metric.resolve", input: { text: "совершенно неизвестный показатель xyz" } });
      }
      return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: {} });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Сравни последнюю доступную дату с предыдущей.");
    });
    await act(async () => {
      await result.current.submit("Теперь покажи только показатели, которые снизились.");
    });

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    // never silently reused a nonexistent interval — no lastPeriodRef exists.
    expect(result.current.__sessionMemoryDebug().lastPeriodRef).toBeUndefined();
  });
});

describe("Stage 25.1.2 §10–§12 — narrator/planner JSON never becomes the visible response", () => {
  it("a narrator draft that would be raw JSON is replaced by the clean fallback, not shown raw", async () => {
    const fx = fixtureMetricPrecedence();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("analysis.volatility")) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", input: { source: last("metric.list")!.resultId } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide, () => '{"kind":"tool_call","tool":"period.select","input":{"selector":"last"}}');
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Какой показатель самый нестабильный?");
    });

    const responses = allResponses(result);
    for (const r of responses) {
      expect(r).not.toMatch(/"kind"|tool_call|period\.select/);
    }
  });
});

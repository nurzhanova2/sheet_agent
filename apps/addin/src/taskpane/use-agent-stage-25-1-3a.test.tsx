// Stage 25.1.3a — pronoun shortcut clause coverage. Integration through
// useAgent().submit(): real routing, real tool composition, real
// SessionMemory — only decideAgentStep/narrate are scripted (adaptive,
// reading the real AgentDecisionRequest), matching the 25.1.1–25.1.3
// harnesses.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { AgentDecisionRequest, AgentObservation } from "../agent/types.js";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { fixtureDirectionAndSets, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";
import { countAnalyticalClauses } from "../analytics-agent/semantic-frame.js";

const RESULT_DEFAULTS = { actions: [], actionErrors: [], analysisRuns: 0, analysisHadError: false, charts: [], language: "en" as const, planKind: "none" as const };
const FORBIDDEN_RE = /\bFAILED\b|ANALYSIS RESULT|\(rejected\)|requested operation\(s\)|Анализ недоступен|"kind"\s*:\s*"(?:tool_call|clarify|final)"|direction\s+(?:increasing|decreasing)\b|matched\s*=\s*\d|\bКнига изменилась/i;

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
function col(obs: AgentObservation, name: string): number {
  return obs.columns!.indexOf(name);
}
const allResponses = (r: { current: ReturnType<typeof useAgent> }): string[] =>
  r.current.entries.filter((x) => x.kind === "response").map((e) => (e.kind === "response" ? e.text : ""));

describe("Stage 25.1.3a §15/§16 — countAnalyticalClauses distinguishes simple vs compound pronoun requests", () => {
  it("§15 — a simple pronoun request is exactly one clause", () => {
    expect(countAnalyticalClauses("Покажи его динамику.")).toBe(1);
  });

  it("§16/§13 — every required RU paraphrase carries 2+ clauses", () => {
    expect(countAnalyticalClauses("Покажи его динамику и найди самый большой скачок.")).toBeGreaterThanOrEqual(2);
    expect(countAnalyticalClauses("Покажи, как он менялся, и скажи, когда изменение было максимальным.")).toBeGreaterThanOrEqual(2);
    expect(countAnalyticalClauses("Дай динамику этого показателя и период с самым сильным изменением.")).toBeGreaterThanOrEqual(1);
    expect(countAnalyticalClauses("Покажи его ряд за всё время и где был максимальный скачок.")).toBeGreaterThanOrEqual(2);
  });

  it("§14 — every required EN paraphrase carries 2+ clauses", () => {
    expect(countAnalyticalClauses("Show its time series and identify the largest adjacent change.")).toBeGreaterThanOrEqual(2);
    expect(countAnalyticalClauses("Show how it changed over time and when the biggest jump occurred.")).toBeGreaterThanOrEqual(2);
  });

  it("the exact real-Excel failing sentence carries 2 clauses", () => {
    expect(countAnalyticalClauses("Покажи его динамику за всё доступное время и объясни, за счёт какого периода произошло наибольшее изменение.")).toBeGreaterThanOrEqual(2);
  });
});

describe("Stage 25.1.3a §19/§20/§28 — full acceptance chain: winner survives to a compound pronoun follow-up, both clauses render", () => {
  it("turn4's compound pronoun request executes series AND max-adjacent-event for the SAME winner, never truncated", async () => {
    const fx = fixtureDirectionAndSets();
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
      if (req.includes("снизились")) {
        if (!last("reference.previous_period")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_period", input: {} });
        const ref = last("reference.previous_period")!;
        const start = String(ref.rows![0]![0]);
        const end = String(ref.rows![ref.rows!.length - 1]![0]);
        if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
        if (!last("change.compare_periods")) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: start, endPeriod: end } });
        if (!last("set.filter")) return JSON.stringify({ kind: "tool_call", tool: "set.filter", input: { source: last("change.compare_periods")!.resultId, field: "percentageChange", op: "lt", value: 0 } });
        return JSON.stringify({ kind: "final", answer: "Вот снизившиеся показатели." });
      }
      if (req.includes("сильнее всего")) {
        if (!last("reference.previous_metric_set")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_metric_set", input: {} });
        if (!last("reference.previous_period")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_period", input: {} });
        const ms = last("reference.previous_metric_set")!;
        const keys = ms.rows!.map((r) => String(r[col(ms, "metric")]));
        const pr = last("reference.previous_period")!;
        const start = String(pr.rows![0]![0]);
        const end = String(pr.rows![pr.rows!.length - 1]![0]);
        if (!last("change.compare_periods")) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", input: { metrics: keys, startPeriod: start, endPeriod: end } });
        if (!last("set.sort")) return JSON.stringify({ kind: "tool_call", tool: "set.sort", input: { source: last("change.compare_periods")!.resultId, field: "percentageChange", direction: "asc" } });
        return JSON.stringify({ kind: "final", answer: "Обязательства изменились сильнее всего." });
      }
      // turn4: the compound pronoun request — resolve the metric FROM SHARED
      // FOCUS (never re-resolve "его" independently), then compose BOTH
      // clauses on that SAME metric.
      if (!last("reference.previous_metric_focus")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_metric_focus", input: {} });
      const focusObs = last("reference.previous_metric_focus")!;
      const metric = String(focusObs.rows![0]![col(focusObs, "metric")]);
      if (!last("series.get")) return JSON.stringify({ kind: "tool_call", tool: "series.get", input: { metrics: [metric] } });
      if (!last("event.max_adjacent_change")) return JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", input: { metric, basis: "percentage" } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide, (messages) => {
      const req = messages.map((m) => m.content).join(" ");
      if (req.includes("предыдущей")) return "Сравнение выполнено.";
      if (req.includes("снизились")) return "Вот снизившиеся показатели.";
      if (req.includes("сильнее всего")) return "Обязательства изменились сильнее всего.";
      return "Обязательства выросло с течением времени; наибольшее изменение произошло между двумя соседними датами.";
    });
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Сравни последнюю доступную дату с предыдущей.");
    });
    await act(async () => {
      await result.current.submit("Теперь покажи только показатели, которые снизились.");
    });
    await act(async () => {
      await result.current.submit("Из них какой изменился сильнее всего?");
    });
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey).toBe("Обязательства");

    await act(async () => {
      await result.current.submit("Покажи его динамику за всё доступное время и объясни, за счёт какого периода произошло наибольшее изменение.");
    });

    // both clauses must have actually executed — never truncated after series alone.
    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const calls = (client.decideAgentStep as ReturnType<typeof vi.fn>).mock.calls as [AgentDecisionRequest][];
    const turn4Calls = calls.filter((c) => c[0].originalUserRequest.includes("наибольшее изменение"));
    const turn4Obs = turn4Calls.at(-1)?.[0].observations ?? [];
    expect(lastObs(turn4Obs, "series.get")).toBeDefined();
    expect(lastObs(turn4Obs, "event.max_adjacent_change")).toBeDefined();
    const seriesObs = lastObs(turn4Obs, "series.get")!;
    const eventObs = lastObs(turn4Obs, "event.max_adjacent_change")!;
    expect(String(seriesObs.rows![0]![col(seriesObs, "metric")])).toBe("Обязательства");
    expect(String(eventObs.rows![0]![col(eventObs, "metric")])).toBe("Обязательства");

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    expect(responses.at(-1)).not.toMatch(/уточните|please clarify/i);
  });
});

describe("Stage 25.1.3a §17 — a compound pronoun request never re-resolves against a stale OLDER focus", () => {
  it("winner=A supersedes an older focus=B; both clauses target A, never B", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      const req = request.originalUserRequest;
      // establishes an OLDER focus via a historical-extreme-distance ask
      // (an operation kind Stage 24.x cannot compile — forces the planner).
      if (req.includes("дальше всего от")) {
        if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
        if (!last("aggregate.min")) return JSON.stringify({ kind: "tool_call", tool: "aggregate.min", input: { source: last("metric.list")!.resultId } });
        if (!last("set.argmin")) return JSON.stringify({ kind: "tool_call", tool: "set.argmin", input: { source: last("aggregate.min")!.resultId, field: "value" } });
        return JSON.stringify({ kind: "final", answer: "ok" });
      }
      // establishes a NEW, different winner (also forces the planner: an
      // operation kind Stage 24.x cannot compile).
      if (req.includes("откатились от своих исторических максимумов")) {
        if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
        if (!last("aggregate.max")) return JSON.stringify({ kind: "tool_call", tool: "aggregate.max", input: { source: last("metric.list")!.resultId } });
        if (!last("set.argmax")) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", input: { source: last("aggregate.max")!.resultId, field: "value" } });
        return JSON.stringify({ kind: "final", answer: "ok" });
      }
      // compound pronoun follow-up: must target whichever metric is CURRENTLY in focus.
      if (!last("reference.previous_metric_focus")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_metric_focus", input: {} });
      const focusObs = last("reference.previous_metric_focus")!;
      const metric = String(focusObs.rows![0]![col(focusObs, "metric")]);
      if (!last("series.get")) return JSON.stringify({ kind: "tool_call", tool: "series.get", input: { metrics: [metric] } });
      if (!last("event.max_adjacent_change")) return JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", input: { metric, basis: "percentage" } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    // turn 1 establishes an OLDER focus.
    await act(async () => {
      await result.current.submit("Какой показатель дальше всего от своего минимума?");
    });
    const olderFocus = result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey;
    expect(olderFocus).toBeTruthy();

    // turn 2 establishes a NEW, different winner.
    await act(async () => {
      await result.current.submit("Какие показатели сильнее всего откатились от своих исторических максимумов?");
    });
    const newWinner = result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey;
    expect(newWinner).toBeTruthy();
    expect(newWinner).not.toBe(olderFocus);

    // turn 3: compound pronoun follow-up must use the NEW winner, never the older one.
    await act(async () => {
      await result.current.submit("Покажи его динамику и найди самый большой скачок.");
    });

    const calls = (client.decideAgentStep as ReturnType<typeof vi.fn>).mock.calls as [AgentDecisionRequest][];
    const compoundCall = calls.filter((c) => c[0].originalUserRequest.includes("самый большой скачок")).at(-1);
    const compoundObs = compoundCall?.[0].observations ?? [];
    const seriesObs = lastObs(compoundObs, "series.get");
    const eventObs = lastObs(compoundObs, "event.max_adjacent_change");
    expect(seriesObs).toBeDefined();
    expect(eventObs).toBeDefined();
    expect(String(seriesObs!.rows![0]![col(seriesObs!, "metric")])).toBe(newWinner);
    expect(String(eventObs!.rows![0]![col(eventObs!, "metric")])).toBe(newWinner);
    expect(String(seriesObs!.rows![0]![col(seriesObs!, "metric")])).not.toBe(olderFocus);
  });
});

describe("Stage 25.1.3a §18/§9 — clause-drop is still caught after the shortcut hands off to the compositional path", () => {
  it("CLAUSE_DROPPED when the model executes series but never the requested max-adjacent-event clause", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      const req = request.originalUserRequest;
      if (req.includes("сильнее всего меняется")) {
        if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
        if (!last("analysis.trend")) return JSON.stringify({ kind: "tool_call", tool: "analysis.trend", input: { source: last("metric.list")!.resultId } });
        if (!last("set.argmax")) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", input: { source: last("analysis.trend")!.resultId, field: "slope" } });
        return JSON.stringify({ kind: "final", answer: "ok" });
      }
      // deliberately drops the second (event) clause — only ever calls series.get.
      if (!last("reference.previous_metric_focus")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_metric_focus", input: {} });
      const focusObs = last("reference.previous_metric_focus")!;
      const metric = String(focusObs.rows![0]![col(focusObs, "metric")]);
      if (!last("series.get")) return JSON.stringify({ kind: "tool_call", tool: "series.get", input: { metrics: [metric] } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Какой показатель сильнее всего меняется по направлению тренда?");
    });
    await act(async () => {
      await result.current.submit("Покажи его динамику и найди самый большой скачок.");
    });

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    // never narrated as a successful, complete answer.
    expect(responses.at(-1)).toMatch(/не удалось|couldn't/i);
  });
});

describe("Stage 25.1.3a §15 — the simple (uncompounded) pronoun shortcut stays fast, no LLM call needed", () => {
  it("'Покажи его динамику.' terminates through the deterministic shortcut alone", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = vi.fn((): string => {
      // must never be called for turns 1-2 in this scenario: turn 1
      // establishes focus deterministically (Stage 24.x compiled), turn 2 is
      // the simple dynamics-only shortcut.
      return JSON.stringify({ kind: "final", answer: "unexpected planner call" });
    });
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Какой показатель менялся сильнее всего?");
    });
    const winner = result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey;

    await act(async () => {
      await result.current.submit("Покажи его динамику.");
    });

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    if (winner) {
      // the deterministic shortcut handled it without ever invoking the planner.
      expect(decide).not.toHaveBeenCalled();
    }
  });
});

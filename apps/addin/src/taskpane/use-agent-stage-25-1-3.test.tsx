// Stage 25.1.3 — semantic winner lineage, compound dependencies,
// clarification resume & exploratory contract. Integration through
// useAgent().submit(): real routing, real tool composition, real
// SessionMemory — only decideAgentStep/narrate are scripted (adaptive,
// reading the real AgentDecisionRequest), exactly like the 25.1.1/25.1.2
// harnesses.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { AgentDecisionRequest, AgentObservation } from "../agent/types.js";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { fixtureDirectionAndSets, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";

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

describe("Stage 25.1.3 §51 — reverse-repo-style pronoun resolution after a multi-row decline sort", () => {
  it("turn3's superlative sort commits the true winner; turn4's pronoun resolves to THAT metric, not an older one", async () => {
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
        // deliberately terminates in a SORTED multi-row table, no set.top/argmax slicing —
        // exactly the shape that used to leave focus stale (Stage 25.1.3 §3/§5's fix).
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
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide, (messages) => {
      const req = messages.map((m) => m.content).join(" ");
      if (req.includes("предыдущей")) return "Сравнение выполнено.";
      if (req.includes("снизились")) return "Вот снизившиеся показатели.";
      if (req.includes("сильнее всего")) return "Обязательства изменились сильнее всего.";
      return "Готово.";
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

    // the semantic winner must now be "Обязательства" (the larger-magnitude
    // decline), never "Ликвидные активы" and never a stale earlier focus.
    const winnerAfterTurn3 = result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey;
    expect(winnerAfterTurn3).toBe("Обязательства");

    await act(async () => {
      await result.current.submit("Покажи его динамику.");
    });

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    // the deterministic Stage 24.9 pronoun route must have targeted the
    // winner, not "Ликвидные активы" or any earlier metric.
    const persisted = result.current.__sessionMemoryDebug().recentResults.at(-1);
    expect(persisted).toBeDefined();
    expect(persisted!.rows.every((r) => r[0] !== "Ликвидные активы")).toBe(true);
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey).toBe("Обязательства");
  });
});

describe("Stage 25.1.3 §52 — 3-clause volatility request: same metric throughout, all 3 outputs rendered", () => {
  it("winner -> series(winner) -> event(winner), and the visible answer surfaces all three", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("analysis.volatility")) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", input: { source: last("metric.list")!.resultId } });
      if (!last("set.argmax")) return JSON.stringify({ kind: "tool_call", tool: "set.argmax", input: { source: last("analysis.volatility")!.resultId, field: "score" } });
      const winnerObs = last("set.argmax")!;
      const winner = String(winnerObs.rows![0]![col(winnerObs, "metric")]);
      // Stage 25.1.3 §10/§11 — the SAME metric passed directly, never via a
      // separate re-resolution of "his"/stale focus.
      if (!last("series.get")) return JSON.stringify({ kind: "tool_call", tool: "series.get", input: { metrics: [winner] } });
      if (!last("event.max_adjacent_change")) return JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", input: { metric: winner, basis: "percentage" } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide, () => "Самый нестабильный показатель определён, показана его динамика и наибольший скачок.");
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Найди самый нестабильный показатель, покажи его динамику и скажи, между какими соседними датами был самый большой скачок.");
    });

    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const winner = result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey;
    expect(winner).toBeTruthy();
    const r1 = allResponses(result).at(-1)!;
    expect(r1).not.toMatch(FORBIDDEN_RE);
    // §14 — the visible answer must surface all 3 clause outputs: the
    // deterministic coverage appendix guarantees this regardless of prose.
    expect(r1).toContain(winner);
  });
});

describe("Stage 25.1.3 §54/§27 — exploratory top-3 with grounded reasons, not the full ranking", () => {
  it("returns exactly 3 distinct metrics, each backed by a computed diagnostic value", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("analysis.volatility")) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", input: { source: last("metric.list")!.resultId } });
      if (!last("set.top")) return JSON.stringify({ kind: "tool_call", tool: "set.top", input: { source: last("analysis.volatility")!.resultId, field: "score", n: 3 } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide, () => "Вот три показателя с наименее устойчивой динамикой.");
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Если бы тебе нужно было выбрать три показателя для проверки из-за необычной динамики, какие бы ты выбрал и почему?");
    });

    const persisted = result.current.__sessionMemoryDebug().recentResults.at(-1);
    expect(persisted).toBeDefined();
    expect(persisted!.rows.length).toBe(3);
    expect(persisted!.columns).toContain("score");
    const r1 = allResponses(result).at(-1)!;
    expect(r1).not.toMatch(FORBIDDEN_RE);
  });

  it("rejects an under-sized selection (2 metrics when 3 were requested) before narration", async () => {
    const fx = fixtureDirectionAndSets();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("analysis.volatility")) return JSON.stringify({ kind: "tool_call", tool: "analysis.volatility", input: { source: last("metric.list")!.resultId } });
      if (!last("set.top")) return JSON.stringify({ kind: "tool_call", tool: "set.top", input: { source: last("analysis.volatility")!.resultId, field: "score", n: 2 } });
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Если бы тебе нужно было выбрать три показателя для проверки из-за необычной динамики, какие бы ты выбрал и почему?");
    });

    const r1 = allResponses(result).at(-1)!;
    expect(r1).toMatch(/не удалось|couldn't/i);
    expect(r1).not.toMatch(/EXPLORATORY_CARDINALITY_MISMATCH/);
  });
});

describe("Stage 25.1.3 §53/§46/§48 — a stable-growth clarification resumes the ORIGINAL request, no false freshness error", () => {
  it("a short slot-filling answer resumes stable_growth — never a generic new query, never 'the workbook changed'", async () => {
    const fx = fixtureDirectionAndSets();
    let clarifyAsked = false;
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      const resumed = obs.some((o) => o.tool === "user_clarification");
      if (!resumed && obs.length === 0) {
        clarifyAsked = true;
        return JSON.stringify({ kind: "clarify", question: "За какой период оценивать стабильность роста?", candidates: [] });
      }
      // once resumed (or on a fresh continuation), compose the real stable-growth plan.
      if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
      if (!last("change.compare_periods")) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: "2024-01-01", endPeriod: "2025-01-01" } });
      if (!last("analysis.stability")) return JSON.stringify({ kind: "tool_call", tool: "analysis.stability", input: { source: last("metric.list")!.resultId } });
      return JSON.stringify({ kind: "final", answer: "Готово." });
    };
    const client = plannerClient(decide, () => "Показатель рос наиболее стабильно за весь доступный период.");
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Что росло наиболее стабильно без резких скачков?");
    });
    expect(clarifyAsked).toBe(true);
    expect(allResponses(result).at(-1)).toBe("За какой период оценивать стабильность роста?");

    await act(async () => {
      await result.current.submit("за весь доступный период");
    });

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    expect(responses.at(-1)).not.toMatch(/книга изменилась/i);
    // the SAME decideAgentStep call chain resumed — never routed through the
    // generic model/legacy path.
    expect(client.decideAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(responses.at(-1)).toBe("Показатель рос наиболее стабильно за весь доступный период.");
  });

  it("§47 — an unusable clarification reply asks again and keeps the suspended request recoverable", async () => {
    const fx = fixtureDirectionAndSets();
    let clarifyCount = 0;
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const resumed = obs.some((o) => o.tool === "user_clarification");
      if (!resumed) {
        clarifyCount += 1;
        return JSON.stringify({ kind: "clarify", question: `Уточняющий вопрос #${clarifyCount}`, candidates: [] });
      }
      return JSON.stringify({ kind: "final", answer: "Готово." });
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Что росло наиболее стабильно без резких скачков?");
    });
    expect(allResponses(result).at(-1)).toContain("#1");

    // an unusable/garbled reply still resumes the SAME suspended request —
    // the planner asks another concise clarification, never a legacy leak.
    await act(async () => {
      await result.current.submit("эээ не знаю");
    });
    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
  });
});

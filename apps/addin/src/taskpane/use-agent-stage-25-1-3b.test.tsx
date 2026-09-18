// Stage 25.1.3b — ranking-basis fidelity & canonical-field presentation
// guard. Integration through useAgent().submit(): real routing, real tool
// composition, real SessionMemory — only decideAgentStep/narrate are
// scripted (adaptive, reading the real AgentDecisionRequest), matching the
// 25.1.1–25.1.3a harnesses.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CellValue, ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { AgentDecisionRequest, AgentObservation } from "../agent/types.js";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import type { FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";

const RESULT_DEFAULTS = { actions: [], actionErrors: [], analysisRuns: 0, analysisHadError: false, charts: [], language: "en" as const, planKind: "none" as const };
const FORBIDDEN_RE =
  /\bFAILED\b|ANALYSIS RESULT|\(rejected\)|requested operation\(s\)|Анализ недоступен|"kind"\s*:\s*"(?:tool_call|clarify|final)"|startPeriodCanonical|endPeriodCanonical|\bКнига изменилась/i;

// Stage 25.1.3b §1/§9/§20 — a self-contained fixture replicating the real
// Excel failure's STRUCTURE (never its exact confidential values): a
// large-absolute/small-percentage decliner ("Вклады клиентов") and a
// small-absolute/large-percentage decliner ("обратное РЕПО") whose OWN
// largest adjacent change (by percentage) sits at an EARLIER period pair
// than the one that made it "declining" for the turn 1-3 comparison —
// proving turn 4's event lookup finds the TRUE global maximum, not the
// turn-3 comparison interval.
function fixtureRankingBasisDivergence(): FixtureSnapshot {
  const periodSerials = [45292, 45627, 45962, 45992]; // 01.01.2024, 01.12.2024, 01.11.2025, 01.12.2025
  const level0: CellValue[] = [""];
  const level1: CellValue[] = ["Наименование показателя"];
  for (const s of periodSerials) {
    level0.push(s, "");
    level1.push("абс.", "%");
  }
  const series: Record<string, readonly number[]> = {
    "Вклады клиентов": [20000, 19500, 13868.36, 13513.18], // P3->P4: -355.18 (-2.56%)
    "обратное РЕПО": [50, 38.6024, 317.1601, 273.4174], // P2->P3: +278.5577 (+721.61%); P3->P4: -43.7427 (-13.79%)
    "Активы": [1000, 1100, 1200, 1300], // control: never declines, excluded by the filter
  };
  const rows: CellValue[][] = [level0, level1];
  for (const [name, abs] of Object.entries(series)) {
    const row: CellValue[] = [name];
    abs.forEach((v, i) => {
      row.push(v, Number(((i + 1) * 0.01).toFixed(4)));
    });
    rows.push(row);
  }
  const fmt = rows.map((_, r) => {
    if (r === 0) return level0.map((v, c) => (c === 0 ? "General" : typeof v === "number" ? "dd.mm.yyyy" : "General"));
    if (r === 1) return level1.map(() => "General");
    return level1.map((v, c) => (c === 0 ? "General" : String(v) === "%" ? "0.0%" : "#,##0.0000"));
  });
  return { sheetName: "Bal", address: "Bal!A1:I5", values: rows, numberFormats: fmt, formulas: rows.map((r) => r.map(() => null)), startsBelowRow1: false };
}

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

function turn12Decide(obs: readonly AgentObservation[], req: string): string | null {
  const last = (tool: string): AgentObservation | undefined => lastObs(obs, tool);
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
  return null;
}

describe("Stage 25.1.3b §1/§2/§9/§20 — the strongest-decline winner ranks by percentage magnitude, not raw amount", () => {
  it("turn3 correctly picks 'обратное РЕПО' (-13.79%), never 'Вклады клиентов' (larger raw amount, smaller %)", async () => {
    const fx = fixtureRankingBasisDivergence();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      const req = request.originalUserRequest;
      const t12 = turn12Decide(obs, req);
      if (t12) return t12;
      if (req.includes("сильнее всего")) {
        if (!last("reference.previous_metric_set")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_metric_set", input: {} });
        if (!last("reference.previous_period")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_period", input: {} });
        const ms = last("reference.previous_metric_set")!;
        const keys = ms.rows!.map((r) => String(r[col(ms, "metric")]));
        const pr = last("reference.previous_period")!;
        const start = String(pr.rows![0]![0]);
        const end = String(pr.rows![pr.rows!.length - 1]![0]);
        if (!last("change.compare_periods")) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", input: { metrics: keys, startPeriod: start, endPeriod: end } });
        // correct composition: rank by PERCENTAGE magnitude (ascending puts
        // the most negative — the largest decline — first).
        if (!last("set.sort")) return JSON.stringify({ kind: "tool_call", tool: "set.sort", input: { source: last("change.compare_periods")!.resultId, field: "percentageChange", direction: "asc" } });
        return JSON.stringify({ kind: "final", answer: "обратное РЕПО изменилось сильнее всего." });
      }
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide, (messages) => {
      const req = messages.map((m) => m.content).join(" ");
      if (req.includes("предыдущей")) return "Сравнение выполнено.";
      if (req.includes("снизились")) return "Вот снизившиеся показатели.";
      return "обратное РЕПО изменилось сильнее всего.";
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

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");
  });

  it("a WRONG composition ranking by raw absoluteChange is rejected before narration (never picks 'Вклады клиентов')", async () => {
    const fx = fixtureRankingBasisDivergence();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      const req = request.originalUserRequest;
      const t12 = turn12Decide(obs, req);
      if (t12) return t12;
      if (req.includes("сильнее всего")) {
        if (!last("reference.previous_metric_set")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_metric_set", input: {} });
        if (!last("reference.previous_period")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_period", input: {} });
        const ms = last("reference.previous_metric_set")!;
        const keys = ms.rows!.map((r) => String(r[col(ms, "metric")]));
        const pr = last("reference.previous_period")!;
        const start = String(pr.rows![0]![0]);
        const end = String(pr.rows![pr.rows!.length - 1]![0]);
        if (!last("change.compare_periods")) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", input: { metrics: keys, startPeriod: start, endPeriod: end } });
        // WRONG: sorts by raw absoluteChange, which would incorrectly pick
        // "Вклады клиентов" (-355.18) over "обратное РЕПО" (-43.74).
        if (!last("set.sort")) return JSON.stringify({ kind: "tool_call", tool: "set.sort", input: { source: last("change.compare_periods")!.resultId, field: "absoluteChange", direction: "asc" } });
        return JSON.stringify({ kind: "final", answer: "Вклады клиентов изменились сильнее всего." });
      }
      return JSON.stringify({ kind: "final", answer: "ok" });
    };
    const client = plannerClient(decide);
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

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    expect(responses.at(-1)).not.toMatch(/RANKING_BASIS_MISMATCH/); // internal code never user-facing
    expect(responses.at(-1)).toMatch(/не удалось|couldn't/i);
    // the wrong metric must NEVER become the committed focus.
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey).not.toBe("Вклады клиентов");
  });
});

describe("Stage 25.1.3b §10/§11/§20 — full acceptance chain: winner, series, TRUE global max-adjacent event, no leak", () => {
  it("turn4 resolves 'обратное РЕПО' and finds its global largest adjacent change (an EARLIER period pair than the turn-3 comparison)", async () => {
    const fx = fixtureRankingBasisDivergence();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const last = (tool: string) => lastObs(obs, tool);
      const req = request.originalUserRequest;
      const t12 = turn12Decide(obs, req);
      if (t12) return t12;
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
        return JSON.stringify({ kind: "final", answer: "обратное РЕПО изменилось сильнее всего." });
      }
      // turn 4: resolve the shared focus, then compose BOTH clauses.
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
      if (req.includes("сильнее всего")) return "обратное РЕПО изменилось сильнее всего.";
      return "Обратное РЕПО выросло с 38.60 до 317.16 между 01.12.2024 и 01.11.2025 — крупнейшее изменение за период.";
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
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");

    await act(async () => {
      await result.current.submit("Покажи его динамику за всё доступное время и объясни, за счёт какого периода произошло наибольшее изменение.");
    });

    const calls = (client.decideAgentStep as ReturnType<typeof vi.fn>).mock.calls as [AgentDecisionRequest][];
    const turn4Calls = calls.filter((c) => c[0].originalUserRequest.includes("наибольшее изменение"));
    const turn4Obs = turn4Calls.at(-1)?.[0].observations ?? [];
    const seriesObs = lastObs(turn4Obs, "series.get");
    const eventObs = lastObs(turn4Obs, "event.max_adjacent_change");
    expect(seriesObs).toBeDefined();
    expect(eventObs).toBeDefined();
    expect(String(seriesObs!.rows![0]![col(seriesObs!, "metric")])).toBe("обратное РЕПО");
    expect(String(eventObs!.rows![0]![col(eventObs!, "metric")])).toBe("обратное РЕПО");
    // the TRUE global max-adjacent event: 01.12.2024 -> 01.11.2025 (+721.6%),
    // NOT the turn-3 decline interval (01.11.2025 -> 01.12.2025, -13.79%).
    const startIdx = col(eventObs!, "startPeriod");
    const endIdx = col(eventObs!, "endPeriod");
    expect(String(eventObs!.rows![0]![startIdx])).toBe("01.12.2024");
    expect(String(eventObs!.rows![0]![endIdx])).toBe("01.11.2025");

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    expect(responses.at(-1)).not.toMatch(/уточните|please clarify/i);
  });
});

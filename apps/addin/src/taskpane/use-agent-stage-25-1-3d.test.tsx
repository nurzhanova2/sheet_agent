// Stage 25.1.3d — result-shape fidelity & post-success focus stability.
// Integration through useAgent().submit(): real routing, real tool
// composition, real SessionMemory — only decideAgentStep is scripted;
// `narrate` always returns "" so every turn's visible body comes from the
// DETERMINISTIC FALLBACK renderer — the most direct way to prove the
// fallback (and therefore `outcome.primary`/session-memory, which share the
// SAME `determinePrimaryAnswer` selection — §15) shows the correctly-shaped
// result, not just that some narrator prose happens to sound right.
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

// Same structural fixture as Stage 25.1.3b/25.1.3c's own e2e tests: a
// large-absolute/small-percentage decliner ("Вклады клиентов") and a
// small-absolute/large-percentage decliner ("обратное РЕПО"), plus a
// control metric that never declines ("Активы") — so a filter/superlative
// result-shape bug (showing the control metric too) is directly provable.
function fixtureRankingBasisDivergence(): FixtureSnapshot {
  const periodSerials = [45292, 45627, 45962, 45992]; // 01.01.2024, 01.12.2024, 01.11.2025, 01.12.2025
  const level0: CellValue[] = [""];
  const level1: CellValue[] = ["Наименование показателя"];
  for (const s of periodSerials) {
    level0.push(s, "");
    level1.push("абс.", "%");
  }
  const series: Record<string, readonly number[]> = {
    "Вклады клиентов": [20000, 19500, 13868.36, 13513.18],
    "обратное РЕПО": [50, 38.6024, 317.1601, 273.4174],
    "Активы": [1000, 1100, 1200, 1300],
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

// narrate ALWAYS returns "" — every turn's visible body is forced through
// the deterministic fallback, so the assertions below prove the FALLBACK
// (and therefore outcome.primary/session-memory — the SAME selection, §15)
// carries the correct shape, not merely that scripted prose sounds right.
function plannerClient(decide: (request: AgentDecisionRequest) => string): ChatClient {
  return {
    stream: vi.fn(async (_r: ChatStreamRequest, h: ChatStreamHandlers) => {
      h.onDelta("x");
      return { ...RESULT_DEFAULTS, text: "MODEL WAS CALLED" } as ChatResult;
    }),
    decideAgentStep: vi.fn(async (request: AgentDecisionRequest) => decide(request)),
    narrate: vi.fn(async () => ""),
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

function turn3Decide(obs: readonly AgentObservation[]): string {
  const last = (tool: string) => lastObs(obs, tool);
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

// turn 4/5 — compound pronoun request. Reads the metric straight from the
// RESOLVED SUBJECT line in workbookContext (Stage 25.1.3c) — never calls
// metric.resolve on the pronoun.
function turn45Decide(obs: readonly AgentObservation[], workbookContext: string): string {
  const last = (tool: string) => lastObs(obs, tool);
  if (obs.some((o) => o.tool === "metric.resolve")) throw new Error("must never call metric.resolve on an already-resolved pronoun subject");
  const m = /RESOLVED SUBJECT[^\n]*\n\s*"([^"]+)"/.exec(workbookContext);
  if (!m) return JSON.stringify({ kind: "final", answer: "Не удалось составить надёжный план ответа." });
  const metric = m[1]!;
  if (!last("series.get")) return JSON.stringify({ kind: "tool_call", tool: "series.get", input: { metrics: [metric] } });
  if (!last("event.max_adjacent_change")) return JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", input: { metric, basis: "percentage" } });
  return JSON.stringify({ kind: "final", answer: "ok" });
}

describe("Stage 25.1.3d §14/§20/§21/§24 — full 5-turn acceptance: result-shape fidelity + repeated pronoun stability", () => {
  it("turn2 shows ONLY declining metrics, turn3 shows ONLY the single winner, turn4 AND its exact repeat (turn5) both succeed for the same subject", async () => {
    const fx = fixtureRankingBasisDivergence();
    const decide = (request: AgentDecisionRequest): string => {
      const obs = request.observations;
      const req = request.originalUserRequest;
      const t12 = turn12Decide(obs, req);
      if (t12) return t12;
      if (req.includes("сильнее всего")) return turn3Decide(obs);
      return turn45Decide(obs, request.workbookContext);
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    // Turn 1 — PASS computationally (unaffected by this stage).
    await act(async () => {
      await result.current.submit("Сравни последнюю доступную дату с предыдущей.");
    });

    // Turn 2 — §6/§18: visible primary result = filtered set ONLY.
    await act(async () => {
      await result.current.submit("Теперь покажи только показатели, которые снизились.");
    });
    const afterTurn2 = allResponses(result);
    const turn2Body = afterTurn2.at(-1)!;
    expect(turn2Body).toContain("обратное РЕПО");
    expect(turn2Body).toContain("Вклады клиентов");
    expect(turn2Body).not.toContain("Активы"); // the control metric never declines — must not leak in.

    // Turn 3 — §7/§19: visible primary result = the ONE winner, never the
    // whole supporting decline set.
    await act(async () => {
      await result.current.submit("Из них какой изменился сильнее всего?");
    });
    const afterTurn3 = allResponses(result);
    const turn3Body = afterTurn3.at(-1)!;
    expect(turn3Body).toContain("обратное РЕПО");
    expect(turn3Body).not.toContain("Вклады клиентов"); // the supporting set must not replace the primary answer.
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");

    // Turn 4 — the compound pronoun request, FIRST execution.
    await act(async () => {
      await result.current.submit("Покажи его динамику за всё доступное время и объясни, за счёт какого периода произошло наибольшее изменение.");
    });
    const decideCalls = (client.decideAgentStep as ReturnType<typeof vi.fn>).mock.calls as [AgentDecisionRequest][];
    const turn4Calls = decideCalls.filter((c) => c[0].originalUserRequest.includes("наибольшее изменение"));
    const turn4Obs = turn4Calls.at(-1)?.[0].observations ?? [];
    expect(String(lastObs(turn4Obs, "series.get")!.rows![0]![col(lastObs(turn4Obs, "series.get")!, "metric")])).toBe("обратное РЕПО");
    expect(String(lastObs(turn4Obs, "event.max_adjacent_change")!.rows![0]![col(lastObs(turn4Obs, "event.max_adjacent_change")!, "metric")])).toBe("обратное РЕПО");

    // §9-§12 — post-success focus stability: MetricFocus AND EventRef both
    // still agree on "обратное РЕПО" after the compound turn succeeded.
    const memAfterTurn4 = result.current.__sessionMemoryDebug();
    expect(memAfterTurn4.lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");
    expect(memAfterTurn4.lastEventRef?.metricKey).toBe("обратное РЕПО");

    // Turn 5 — §13/§21: the EXACT same request, repeated immediately.
    await act(async () => {
      await result.current.submit("Покажи его динамику за всё доступное время и объясни, за счёт какого периода произошло наибольшее изменение.");
    });
    const decideCallsAfterTurn5 = (client.decideAgentStep as ReturnType<typeof vi.fn>).mock.calls as [AgentDecisionRequest][];
    const allTurn45Calls = decideCallsAfterTurn5.filter((c) => c[0].originalUserRequest.includes("наибольшее изменение"));
    // turn5's OWN decision calls happened after turn4's — take the observations from the LAST completed run's final decision.
    const turn5Obs = allTurn45Calls.at(-1)?.[0].observations ?? [];
    expect(String(lastObs(turn5Obs, "series.get")!.rows![0]![col(lastObs(turn5Obs, "series.get")!, "metric")])).toBe("обратное РЕПО");
    expect(String(lastObs(turn5Obs, "event.max_adjacent_change")!.rows![0]![col(lastObs(turn5Obs, "event.max_adjacent_change")!, "metric")])).toBe("обратное РЕПО");

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    // turn5's own visible answer succeeded — never the production failure string.
    expect(responses.at(-1)).not.toMatch(/не удалось составить надёжный план/i);
    expect(responses.at(-1)).not.toMatch(/уточните|please clarify/i);
  });
});

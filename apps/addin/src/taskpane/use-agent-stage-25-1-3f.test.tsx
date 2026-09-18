// Stage 25.1.3f §7/§8/§10 — FOLLOW-UP RESULTSET CONTINUITY.
//
// Integration through useAgent().submit(): real routing, real tool
// composition, real SessionMemory — only decideAgentStep is scripted.
//
// The point of this file is the REAL run's exact shape:
//
//   • turn 1 executes a full comparison successfully, but its NARRATION is
//     forced to fail numeric verification, so the visible body comes from the
//     deterministic fallback renderer. That is a PRESENTATION outcome — the
//     structured continuation state must still be committed (§5).
//   • turn 2 is a bare restriction ("Теперь покажи только показатели, которые
//     снизились.") whose plan is DELIBERATELY unable to rebuild the universe:
//     it never calls metric.list / period.* / change.compare_periods. The only
//     way it can answer is by consuming turn 1's stored ResultSet (§4/§9).
//   • turns 3–5 then continue into Stage 25.1.3e's deterministic winner
//     reduction and the compound pronoun follow-up, unchanged (§10).
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CellValue, ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { AgentDecisionRequest, AgentObservation } from "../agent/types.js";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import type { FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";

const RESULT_DEFAULTS = { actions: [], actionErrors: [], analysisRuns: 0, analysisHadError: false, charts: [], language: "en" as const, planKind: "none" as const };
const FORBIDDEN_RE =
  /\bFAILED\b|ANALYSIS RESULT|\(rejected\)|requested operation\(s\)|Анализ недоступен|"kind"\s*:\s*"(?:tool_call|clarify|final)"|startPeriodCanonical|endPeriodCanonical|\bКнига изменилась|MODEL WAS CALLED/i;

function fixtureContinuity(): FixtureSnapshot {
  const periodSerials = [45292, 45627, 45962, 45992]; // 01.01.2024, 01.12.2024, 01.11.2025, 01.12.2025
  const level0: CellValue[] = [""];
  const level1: CellValue[] = ["Наименование показателя"];
  for (const s of periodSerials) {
    level0.push(s, "");
    level1.push("абс.", "%");
  }
  // last-vs-previous (P3 -> P4): three decliners of very different magnitude
  // plus one riser that must never survive the decline filter.
  const series: Record<string, readonly number[]> = {
    "займы клиентам": [1000, 1000, 1000, 999.9], // -0.01%
    "Вклады клиентов": [20000, 19500, 13868.36, 13513.18], // -2.56%
    "обратное РЕПО": [50, 38.6024, 317.1601, 273.4174], // -13.79% — the true winner
    "Активы": [1000, 1100, 1200, 1300], // +8.33% — rises
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
  return { sheetName: "Bal", address: "Bal!A1:I6", values: rows, numberFormats: fmt, formulas: rows.map((r) => r.map(() => null)), startsBelowRow1: false };
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

/**
 * §7 — turn 1's narration returns prose carrying a number that appears in NO
 * observation, so the Stage 24.4 evidence gate rejects it and the visible
 * body falls back to the deterministic table. Every other turn narrates ""
 * (also the fallback), so no scripted prose can mask a mechanism failure.
 */
function plannerClient(decide: (request: AgentDecisionRequest) => string): ChatClient {
  return {
    stream: vi.fn(async (_r: ChatStreamRequest, h: ChatStreamHandlers) => {
      h.onDelta("x");
      return { ...RESULT_DEFAULTS, text: "MODEL WAS CALLED" } as ChatResult;
    }),
    decideAgentStep: vi.fn(async (request: AgentDecisionRequest) => decide(request)),
    narrate: vi.fn(async (messages: readonly { readonly role: string; readonly content: string }[]) => {
      const user = messages.map((m) => m.content).join("\n");
      return /Сравни последнюю доступную дату/.test(user) ? "Показатели изменились на 12345.6789 за период." : "";
    }),
  } as unknown as ChatClient;
}

function lastObs(obs: readonly AgentObservation[], tool: string): AgentObservation | undefined {
  return [...obs].reverse().find((o) => o.tool === tool && o.ok);
}
function col(obs: AgentObservation, name: string): number {
  return obs.columns!.indexOf(name);
}
const allResponses = (r: { current: ReturnType<typeof useAgent> }): string[] =>
  r.current.entries.filter((x) => x.kind === "response").map((e) => (e.kind === "response" ? e.text : ""));

// turn 1 — a full last-vs-previous comparison over the whole workbook.
function turn1Decide(obs: readonly AgentObservation[]): string {
  const last = (tool: string): AgentObservation | undefined => lastObs(obs, tool);
  const selects = obs.filter((o) => o.tool === "period.select" && o.ok);
  if (!last("period.list")) return JSON.stringify({ kind: "tool_call", tool: "period.list", input: {} });
  if (selects.length === 0) return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "last" } });
  if (selects.length === 1) return JSON.stringify({ kind: "tool_call", tool: "period.select", input: { selector: "previous_of", of: String(selects[0]!.rows![0]![0]) } });
  if (!last("metric.list")) return JSON.stringify({ kind: "tool_call", tool: "metric.list", input: { scope: "compatible_temporal_metrics" } });
  if (!last("change.compare_periods")) {
    return JSON.stringify({
      kind: "tool_call",
      tool: "change.compare_periods",
      input: { source: last("metric.list")!.resultId, startPeriod: String(selects[1]!.rows![0]![0]), endPeriod: String(selects[0]!.rows![0]![0]) },
    });
  }
  return JSON.stringify({ kind: "final", answer: "Сравнение выполнено." });
}

// turn 2 — §4/§9: a PURE restriction of the stored result. This plan cannot
// rebuild anything: it never calls metric.list, period.* or
// change.compare_periods. If turn 1's ResultSet were unavailable, the ONLY
// reachable outcome would be STALE_CONTEXT and an empty run.
function turn2Decide(obs: readonly AgentObservation[]): string {
  const last = (tool: string): AgentObservation | undefined => lastObs(obs, tool);
  if (!last("reference.previous_result_table")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_result_table", input: {} });
  if (!last("set.filter")) {
    return JSON.stringify({
      kind: "tool_call",
      tool: "set.filter",
      input: { source: last("reference.previous_result_table")!.resultId, field: "percentageChange", op: "lt", value: 0 },
    });
  }
  return JSON.stringify({ kind: "final", answer: "Вот снизившиеся показатели." });
}

// turn 3 — §10: the restricted set again, then a set.top whose own order puts
// the SMALLEST-magnitude decliner first (raw descending over negatives). Only
// Stage 25.1.3e's deterministic reduction can still name the true winner.
function turn3Decide(obs: readonly AgentObservation[]): string {
  const last = (tool: string): AgentObservation | undefined => lastObs(obs, tool);
  if (!last("reference.previous_result_table")) return JSON.stringify({ kind: "tool_call", tool: "reference.previous_result_table", input: {} });
  if (!last("set.top")) {
    return JSON.stringify({
      kind: "tool_call",
      tool: "set.top",
      input: { source: last("reference.previous_result_table")!.resultId, field: "percentageChange", n: 3 },
    });
  }
  return JSON.stringify({ kind: "final", answer: "Готово." });
}

// turns 4/5 — the compound pronoun request, reading the RESOLVED SUBJECT line.
function turn45Decide(obs: readonly AgentObservation[], workbookContext: string): string {
  const last = (tool: string): AgentObservation | undefined => lastObs(obs, tool);
  const m = /RESOLVED SUBJECT[^\n]*\n\s*"([^"]+)"/.exec(workbookContext);
  if (!m) return JSON.stringify({ kind: "final", answer: "не удалось составить надёжный план" });
  const metric = m[1]!;
  if (!last("series.get")) return JSON.stringify({ kind: "tool_call", tool: "series.get", input: { metrics: [metric] } });
  if (!last("event.max_adjacent_change")) return JSON.stringify({ kind: "tool_call", tool: "event.max_adjacent_change", input: { metric, basis: "percentage" } });
  return JSON.stringify({ kind: "final", answer: "ok" });
}

describe("Stage 25.1.3f §5/§7/§8 — a turn whose NARRATOR fell back still owns its structured result, and the next turn filters it", () => {
  it("turn 1 (deterministic fallback) -> turn 2 restricts the stored ResultSet with no recomputation and no general chat", async () => {
    const fx = fixtureContinuity();
    const decide = (request: AgentDecisionRequest): string =>
      request.originalUserRequest.includes("предыдущей") ? turn1Decide(request.observations) : turn2Decide(request.observations);
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    await act(async () => {
      await result.current.submit("Сравни последнюю доступную дату с предыдущей.");
    });

    // §5 — the narration DID fall back (it is the real run's own wording)…
    const turn1Body = allResponses(result).at(-1)!;
    expect(turn1Body).toMatch(/Не удалось подтвердить все числа в сводке/);
    expect(turn1Body).not.toContain("12345.6789");
    // …and the structured continuation state was committed anyway.
    const memAfterTurn1 = result.current.__sessionMemoryDebug();
    expect(memAfterTurn1.lastAnalyticalResultSetRef?.operation).toBe("change.compare_periods");
    expect(memAfterTurn1.lastAnalyticalResultSetRef?.rowCount).toBe(4);
    expect(memAfterTurn1.lastAnalyticalResultSetRef?.metricKeys).toEqual(
      expect.arrayContaining(["займы клиентам", "Вклады клиентов", "обратное РЕПО", "Активы"]),
    );
    expect(memAfterTurn1.lastAnalyticalResultSetRef?.columns).toEqual(expect.arrayContaining(["metric", "percentageChange"]));

    await act(async () => {
      await result.current.submit("Теперь покажи только показатели, которые снизились.");
    });

    const turn2Body = allResponses(result).at(-1)!;
    // §8 — a non-empty declining subset, with the riser excluded.
    expect(turn2Body).toContain("обратное РЕПО");
    expect(turn2Body).toContain("Вклады клиентов");
    expect(turn2Body).toContain("займы клиентам");
    expect(turn2Body).not.toContain("Активы");
    // §2 — the turn never became general chat (that route calls chatClient.stream).
    expect(client.stream).not.toHaveBeenCalled();
    // …and it never produced the real run's failure sentence.
    expect(turn2Body).not.toMatch(/нет сведений о показателях/i);

    // §8/§9 — the candidate source was turn 1's stored ResultSet, not a fresh
    // workbook recomputation: the filter's own input is the stored table.
    const calls = (client.decideAgentStep as ReturnType<typeof vi.fn>).mock.calls as [AgentDecisionRequest][];
    const turn2Obs = calls.filter((c) => c[0].originalUserRequest.includes("снизились")).at(-1)![0].observations;
    const stored = lastObs(turn2Obs, "reference.previous_result_table")!;
    expect(stored.rows).toHaveLength(4);
    const filtered = lastObs(turn2Obs, "set.filter")!;
    expect(filtered.rows).toHaveLength(3);
    for (const row of filtered.rows!) expect(Number(row[col(filtered, "percentageChange")])).toBeLessThan(0);
    expect(turn2Obs.some((o) => o.tool === "change.compare_periods")).toBe(false);
    expect(turn2Obs.some((o) => o.tool === "metric.list")).toBe(false);

    // §3 — the universe narrowed to the restricted set for the NEXT turn.
    const memAfterTurn2 = result.current.__sessionMemoryDebug();
    expect(memAfterTurn2.lastAnalyticalResultSetRef?.operation).toBe("set.filter");
    expect(memAfterTurn2.lastAnalyticalResultSetRef?.metricKeys).not.toContain("Активы");

    for (const r of allResponses(result)) expect(r).not.toMatch(FORBIDDEN_RE);
  });
});

describe("Stage 25.1.3f §6/§10/§11 — the full five-query chain: continuity, then Stage 25.1.3e's winner reduction, unchanged", () => {
  it("1->2 restores continuity and 3->5 still reach the deterministic winner and its compound follow-up", async () => {
    const fx = fixtureContinuity();
    const decide = (request: AgentDecisionRequest): string => {
      const req = request.originalUserRequest;
      if (req.includes("предыдущей")) return turn1Decide(request.observations);
      if (req.includes("снизились")) return turn2Decide(request.observations);
      if (req.includes("сильнее всего")) return turn3Decide(request.observations);
      return turn45Decide(request.observations, request.workbookContext);
    };
    const client = plannerClient(decide);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fx) }));

    for (const text of ["Сравни последнюю доступную дату с предыдущей.", "Теперь покажи только показатели, которые снизились.", "Из них какой изменился сильнее всего?"]) {
      await act(async () => {
        await result.current.submit(text);
      });
    }

    // §10 — the winner is still the true largest-magnitude decliner, even
    // though set.top's own row[0] is the near-zero decoy.
    const turn3Body = allResponses(result).at(-1)!;
    expect(turn3Body).toContain("обратное РЕПО");
    expect(turn3Body).not.toContain("займы клиентам");
    const memAfterTurn3 = result.current.__sessionMemoryDebug();
    expect(memAfterTurn3.lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");
    // §6 — the VISIBLE answer narrowed to one row, but the analytical
    // continuation universe still holds the whole candidate set.
    expect(memAfterTurn3.lastAnalyticalResultSetRef?.rowCount).toBe(3);
    expect(memAfterTurn3.lastAnalyticalResultSetRef?.metricKeys).toEqual(
      expect.arrayContaining(["займы клиентам", "Вклады клиентов", "обратное РЕПО"]),
    );

    const compound = "Покажи его динамику за всё доступное время и объясни, за счёт какого периода произошло наибольшее изменение.";
    await act(async () => {
      await result.current.submit(compound);
    });
    await act(async () => {
      await result.current.submit(compound);
    });

    const memFinal = result.current.__sessionMemoryDebug();
    expect(memFinal.lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");
    expect(memFinal.lastEventRef?.metricKey).toBe("обратное РЕПО");

    const calls = (client.decideAgentStep as ReturnType<typeof vi.fn>).mock.calls as [AgentDecisionRequest][];
    const lastCompoundObs = calls.filter((c) => c[0].originalUserRequest.includes("наибольшее изменение")).at(-1)![0].observations;
    const ev = lastObs(lastCompoundObs, "event.max_adjacent_change")!;
    expect(String(ev.rows![0]![col(ev, "metric")])).toBe("обратное РЕПО");

    const responses = allResponses(result);
    for (const r of responses) expect(r).not.toMatch(FORBIDDEN_RE);
    expect(responses.at(-1)).not.toMatch(/не удалось составить надёжный план/i);
    expect(client.stream).not.toHaveBeenCalled();
  });
});

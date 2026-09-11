// Stage 24.7 — analytical-intent compiler, integration through useAgent().submit().
// Real induction + real deterministic compiler/executor; no mock returns a canned plan.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { SALES_HEADERS, SALES_ROWS, salesSnapshot } from "../analysis/__fixtures__/sales-test-data.js";
import { fixtureBalanceLike, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";

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

function salesPort() {
  const snap = salesSnapshot();
  return stubPort({
    getSelection: vi.fn(async () => ({ address: snap.address, sheetName: "Sales Test Data", rowCount: snap.totalRowCount, columnCount: 12, revision: 0 })),
    readRange: vi.fn(async () => ({ address: snap.address, sheetName: "Sales Test Data", rowCount: snap.values.length, columnCount: 12, revision: 0, values: snap.values, formulas: snap.formulas, numberFormats: snap.numberFormats })) as unknown as ExcelPort["readRange"],
  });
}
function salesRowsFor(names: readonly string[]): number[] {
  const mi = SALES_HEADERS.indexOf("Manager");
  const set = new Set(names.map((n) => n.toLowerCase()));
  return SALES_ROWS.map((r, i) => ({ r, sheetRow: i + 2 })).filter(({ r }) => set.has(String(r[mi]).toLowerCase())).map(({ sheetRow }) => sheetRow);
}

function noModelClient(): ChatClient {
  return {
    stream: vi.fn(async (_r: ChatStreamRequest, h: ChatStreamHandlers) => {
      h.onDelta("x");
      return { ...RESULT_DEFAULTS, text: "MODEL WAS CALLED" } as ChatResult;
    }),
  };
}

const lastResponse = (r: { current: ReturnType<typeof useAgent> }) => {
  const e = r.current.entries.filter((x) => x.kind === "response").at(-1);
  return e && e.kind === "response" ? e.text : "";
};
const allResponses = (r: { current: ReturnType<typeof useAgent> }) =>
  r.current.entries.filter((x) => x.kind === "response").map((x) => (x.kind === "response" ? x.text : "")).join("\n");
const trace = (r: { current: ReturnType<typeof useAgent> }) => r.current.__sessionMemoryDebug().lastResultActionTrace!;

describe("Stage 24.7 — analytical compiler route (Balance-like)", () => {
  it("§61 — '5 показателей с наибольшим ростом за последний месяц' → row-axis rank, NOT a literal 'показателей' column, model not called", async () => {
    const client = noModelClient();
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("Покажи 5 показателей с наибольшим ростом за последний месяц."); });
    expect((client.stream as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    expect(allResponses(result)).not.toMatch(/столбец «показател|не нашёл/i);
    const ac = trace(result).analyticalCompiler!;
    expect(ac.detectedOperation).toBe("rank");
    expect(ac.subjectScope).toBe("row_axis");
    expect(ac.planValid).toBe(true);
  });

  it("§56 L — 'Когда активы были максимальными?' → argmax of a single metric, period + value", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("Когда активы были максимальными?"); });
    const ac = trace(result).analyticalCompiler!;
    expect(ac.detectedOperation).toBe("argmax");
    expect(ac.resolvedSubject).toBe("Активы");
    expect(ac.compiledSteps).toEqual(["resolve_subject", "select_temporal_series", "arg_extreme:argmax"]);
    expect(lastResponse(result)).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it("§56 J — 'Покажи динамику активов по времени.' → ordered point dates only (no Δ columns)", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("Покажи динамику активов по времени."); });
    const txt = lastResponse(result);
    expect(txt).toMatch(/01\.01\.2024/);
    expect(txt).toMatch(/01\.11\.2025/);
    expect(txt).not.toMatch(/за 1 месяц|Δ/);
    expect(trace(result).analyticalCompiler!.detectedOperation).toBe("time_series");
  });

  it("§56 O / §59 — compare two exact dates: uses EXACTLY those dates, silentSubstitution false", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("Сравни значения на 01.01.2025 и 01.11.2025."); });
    const ac = trace(result).analyticalCompiler!;
    expect(ac.requestedStart).toBe("2025-01-01");
    expect(ac.executedStart).toBe("2025-01-01");
    expect(ac.requestedEnd).toBe("2025-11-01");
    expect(ac.executedEnd).toBe("2025-11-01");
    expect(ac.silentSubstitution).toBe(false);
  });

  it("§86 — a date not in the table fails, names the missing date, runs NO comparison", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("Сравни значения на 01.01.2023 и 01.11.2025."); });
    const txt = lastResponse(result);
    expect(txt).toMatch(/2023-01-01|нет\s+период|не\s+удалось\s+разреш/i);
    expect(txt).not.toMatch(/Δ %|Сравнение:/);
  });

  it("§35/§60 — follow-up 'за этот же период' inherits the exact interval and flips the sign", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("Какие показатели выросли между 01.01.2025 и 01.11.2025?"); });
    const first = trace(result).analyticalCompiler!;
    expect(first.requestedStart).toBe("2025-01-01");
    expect(first.requestedEnd).toBe("2025-11-01");
    await act(async () => { await result.current.submit("Какие показатели снизились за этот же период?"); });
    const second = trace(result).analyticalCompiler!;
    expect(second.inheritedPeriodRef).toBe(true);
    expect(second.requestedStart).toBe("2025-01-01");
    expect(second.requestedEnd).toBe("2025-11-01");
    expect(second.executedStart).toBe("2025-01-01");
    expect(second.silentSubstitution).toBe(false);
  });

  it("§83 — volatility vs stability rank the same score in inverse order", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("Какие показатели наиболее волатильны?"); });
    const volTxt = lastResponse(result);
    const volNames = [...volTxt.matchAll(/\|\s*(Активы|Обязательства|Капитал|Ссудный портфель|Депозиты)\s*\|/g)].map((m) => m[1]);
    await act(async () => { await result.current.submit("Какие показатели наиболее стабильны?"); });
    const stabTxt = lastResponse(result);
    const stabNames = [...stabTxt.matchAll(/\|\s*(Активы|Обязательства|Капитал|Ссудный портфель|Депозиты)\s*\|/g)].map((m) => m[1]);
    expect(volNames.length).toBeGreaterThan(1);
    expect(stabNames).toEqual([...volNames].reverse());
  });
});

describe("Stage 24.7 — regressions", () => {
  it("§68 — flat Sales 'покажи 3 менеджеров с худшим Variance' still uses the grouped-ranking route", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: salesPort() }));
    await act(async () => { await result.current.submit("покажи 3 менеджеров с худшим Variance"); });
    const t = trace(result);
    expect(t.routeChosen).toBe("grouped_ranking");
    expect(t.analyticalCompiler).toBeUndefined();
    const rec = result.current.__sessionMemoryDebug().recentResults.at(-1)!;
    expect((rec.entityValues ?? []).map(String).sort()).toEqual(["Aigerim", "Aruzhan", "Timur"]);
  });

  it("§68 — flat Sales follow-up 'выдели их' → 71 rows highlighted", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: salesPort() }));
    await act(async () => { await result.current.submit("покажи 3 менеджеров с худшим Variance"); });
    await act(async () => { await result.current.submit("выдели их"); });
    const expected = salesRowsFor(["Aigerim", "Aruzhan", "Timur"]).length;
    expect(expected).toBe(71);
    const t = trace(result);
    expect(t.grounding?.sheetRowsCount).toBe(71);
  });

  it("§69 — Balance 'найди максимальные и минимальные значения для каждого показателя' still uses the 24.6 schema route", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("найди максимальные и минимальные значения для каждого показателя"); });
    const t = trace(result);
    expect(t.tableSchema?.analysisCompleted).toContain("extrema");
    expect(t.analyticalCompiler).toBeUndefined();
  });

  it("§70 — Balance norm clarification: 'да' still re-asks (does not choose a branch)", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("найди значения, выходящие за пределы нормы"); });
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBe("schema_norm");
    await act(async () => { await result.current.submit("да"); });
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBe("schema_norm");
    expect(lastResponse(result)).toMatch(/статистическ|порог|уточните/i);
  });
});

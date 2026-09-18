// Stage 24.9 — multi-metric & compound analytical reasoning. Integration
// through useAgent().submit(): real induction + real deterministic
// compiler/executor/memory; no mock returns a canned plan. Mirrors the
// Stage 24.8 harness in use-agent-stage-24-8.test.tsx.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
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
  r.current.entries
    .filter((x) => x.kind === "response")
    .map((x) => (x.kind === "response" ? x.text : ""))
    .join("\n---\n");

// §70 — none of these raw Excel serials may ever surface in user-facing text.
const RAW_SERIAL_RE = /45292|45383|45474|45566|45658/;

describe("Stage 24.9 — manual acceptance Batch A: direction-change superlative + follow-ups", () => {
  it("§1–§3 — single winner, its dynamics, its reversal periods", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureDirectionAndSets()) }));

    await act(async () => { await result.current.submit("Какой показатель менял направление чаще всего?"); });
    const r1 = lastResponse(result);
    expect(r1).toMatch(/Ликвидные активы/);
    expect(r1).not.toMatch(RAW_SERIAL_RE);
    expect(result.current.__sessionMemoryDebug().lastDirectionChangeRef?.metricKey).toBe("Ликвидные активы");
    expect(result.current.__sessionMemoryDebug().lastDirectionChangeRef?.directionChangeCount).toBe(3);

    await act(async () => { await result.current.submit("Покажи его динамику."); });
    const r2 = lastResponse(result);
    expect(r2).toMatch(/Ликвидные активы/);
    expect(r2).toMatch(/01\.01\.2024/);
    expect(r2).toMatch(/01\.01\.2025/);
    expect(r2).not.toMatch(RAW_SERIAL_RE);

    await act(async () => { await result.current.submit("В какие периоды он менял направление?"); });
    const r3 = lastResponse(result);
    expect(r3).toMatch(/Ликвидные активы/);
    expect(r3).toMatch(/01\.04\.2024/);
    expect(r3).not.toMatch(RAW_SERIAL_RE);
    expect(r3).not.toMatch(/Не нашёл показатель/i);
  });
});

describe("Stage 24.9 — manual acceptance Batch B: monotonic symmetry", () => {
  it("§4/§5 — never decreased vs never increased are symmetric primitives", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureDirectionAndSets()) }));

    await act(async () => { await result.current.submit("Какие показатели ни разу не снижались за всё доступное время?"); });
    expect(lastResponse(result)).toMatch(/Активы/);

    await act(async () => { await result.current.submit("А какие ни разу не росли?"); });
    const r2 = lastResponse(result);
    expect(r2).toMatch(/Обязательства/);
    expect(r2).not.toMatch(/MODEL WAS CALLED/);
  });
});

describe("Stage 24.9 — manual acceptance Batch C: semantic filter + ResultSetRef + compound", () => {
  it("§6–§8 — volatility excluding percentages, 'какой из них', then a compound follow-up", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureDirectionAndSets()) }));

    await act(async () => {
      await result.current.submit("Какие показатели наиболее волатильны, если не учитывать процентные показатели?");
    });
    const r1 = lastResponse(result);
    expect(r1).toMatch(/Ликвидные активы/);
    expect(r1).not.toMatch(/уровень долларизации/);
    expect(r1).not.toMatch(/доля ликвидных активов/);
    expect(result.current.__sessionMemoryDebug().lastResultSetRef?.operation).toBe("volatility");

    await act(async () => { await result.current.submit("Какой из них самый волатильный?"); });
    const r2 = lastResponse(result);
    expect(r2).toMatch(/Ликвидные активы/);
    expect(r2).not.toMatch(/Активы[^\s]*[,;]/); // only the one winner, not a re-rendered full ranking
    expect(result.current.__sessionMemoryDebug().lastMetricFocusRef?.metricKey).toBe("Ликвидные активы");

    await act(async () => {
      await result.current.submit("Покажи его динамику и укажи, между какими соседними датами произошло самое большое изменение.");
    });
    const compound = allResponses(result);
    expect(compound).toMatch(/Ликвидные активы/);
    expect(compound).toMatch(/Динамика|Time series/); // clause 1: time_series section title
    expect(compound).toMatch(/Наибольшее изменение между соседними периодами|Largest change between adjacent periods/); // clause 2: argmax_event
    expect(compound).not.toMatch(RAW_SERIAL_RE);
  });

  it("§69 — 'какой из них' with NO compatible prior set asks for clarification, never guesses", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureDirectionAndSets()) }));
    await act(async () => { await result.current.submit("Какой из них самый волатильный?"); });
    const r = lastResponse(result);
    expect(r).toMatch(/уточните|clarify/i);
    expect(r).not.toMatch(/MODEL WAS CALLED/);
  });
});

describe("Stage 24.9 — manual acceptance Batch D: multi-metric comparisons", () => {
  it("§9 — compare_time_series joins both metrics on the same canonical periods", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureDirectionAndSets()) }));
    await act(async () => {
      await result.current.submit("Сравни динамику Активов и Обязательств за всё доступное время.");
    });
    const r = lastResponse(result);
    expect(r).toMatch(/Активы/);
    expect(r).toMatch(/Обязательства/);
    expect(r).toMatch(/01\.01\.2024/);
    expect(r).toMatch(/01\.01\.2025/);
    expect(r).not.toMatch(RAW_SERIAL_RE);
  });

  it("§10 — 'какой из них вырос сильнее…' reuses the MetricSetRef; no legacy fallback, no raw serials", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureDirectionAndSets()) }));
    await act(async () => {
      await result.current.submit("Сравни динамику Активов и Обязательств за всё доступное время.");
    });
    expect(result.current.__sessionMemoryDebug().lastMetricSetRef?.metricKeys).toEqual(["Активы", "Обязательства"]);

    await act(async () => {
      await result.current.submit("Какой из них вырос сильнее в процентах от первой до последней даты?");
    });
    const r = lastResponse(result);
    expect(r).toMatch(/Активы/);
    expect(r).not.toMatch(RAW_SERIAL_RE);
    expect(r).not.toMatch(/Не удалось сопоставить столбцы/);
    expect(r).not.toMatch(/MODEL WAS CALLED/);
  });

  it("§11 — 'темп роста A и B' needs no prior PeriodRef; defaults to first→last", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureDirectionAndSets()) }));
    await act(async () => { await result.current.submit("Сравни темп роста Активов и Ликвидных активов."); });
    const r = lastResponse(result);
    expect(r).toMatch(/Активы/);
    expect(r).toMatch(/Ликвидные активы/);
    expect(r).not.toMatch(/no earlier period to reuse|не удалось разрешить период/i);
    expect(r).not.toMatch(RAW_SERIAL_RE);
  });
});

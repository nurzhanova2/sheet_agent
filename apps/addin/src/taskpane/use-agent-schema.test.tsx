// Stage 24.6 — universal schema route, integration through useAgent().submit().
// Real induction + real deterministic analysers; no mock returns a canned schema.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import type { ProposalEntry } from "../app/agent-session.js";
import { useAgent } from "./use-agent.js";
import { SALES_HEADERS, SALES_ROWS, salesSnapshot } from "../analysis/__fixtures__/sales-test-data.js";
import { parseLocalRange } from "../app/a1.js";
import {
  fixtureBalanceLike,
  fixtureCrossTab,
  fixtureHierarchical,
  fixturePartialHeaders,
  fixtureTransposed,
  type FixtureSnapshot,
} from "../app/schema/__fixtures__/tables.js";

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

/** A model client that must NEVER be consulted for a recognised schema turn. */
function noModelClient(): ChatClient {
  return {
    stream: vi.fn(async (_r: ChatStreamRequest, h: ChatStreamHandlers) => {
      h.onDelta("x");
      return { ...RESULT_DEFAULTS, text: "MODEL WAS CALLED" } as ChatResult;
    }),
  };
}
/** Model client that, if consulted, would emit the WRONG raw-date sibling plan. */
function wrongPlanClient(): ChatClient {
  return {
    stream: vi.fn(async (_r: ChatStreamRequest, h: ChatStreamHandlers) => {
      h.onDelta("x");
      return {
        ...RESULT_DEFAULTS,
        text: "ranked value #1 — 2026-04-02",
        analysisRuns: 2,
        structured: {
          kind: "ranking" as const,
          title: "ranking by |Variance|",
          columns: ["Date", "Variance"],
          rows: [["2026-04-02", 207]],
          rowsTruncated: false,
          facts: [],
          spec: { op: "top_n" },
          sourceSheet: "Sales Test Data",
          sourceRange: "Sales Test Data!A1:L121",
        },
      } as ChatResult;
    }),
  };
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
function runsOf(rows: readonly number[]): string[] {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `A${a}:L${a}` : `A${a}:L${b}`));
}

const lastResponse = (r: { current: ReturnType<typeof useAgent> }) => {
  const e = r.current.entries.filter((x) => x.kind === "response").at(-1);
  return e && e.kind === "response" ? e.text : "";
};
const allResponses = (r: { current: ReturnType<typeof useAgent> }) =>
  r.current.entries.filter((x) => x.kind === "response").map((x) => (x.kind === "response" ? x.text : "")).join("\n");

describe("Stage 24.6 — universal table schema route", () => {
  it("§58 Balance — 'о чем эта таблица' → hierarchical summary, no raw serials, model not called", async () => {
    const client = noModelClient();
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("о чем эта таблица"); });
    expect((client.stream as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    const txt = lastResponse(result);
    expect(txt).toMatch(/иерархическ|многоуровнев/);
    expect(txt).not.toMatch(/45292|45962/);
    expect(txt).not.toMatch(/ANALYSIS RESULT|rejected/i);
    const trace = result.current.__sessionMemoryDebug().lastResultActionTrace!;
    expect(trace.tableSchema?.routeChosen).toBe("universal_schema");
    expect(trace.tableSchema?.orientation).toBe("row_metrics");
    expect(trace.tableSchema?.headerDepth).toBe(2);
  });

  it("§58/§41 Balance — max/min per indicator", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("найди максимальные и минимальные значения для каждого показателя"); });
    const txt = lastResponse(result);
    expect(txt).toMatch(/Активы/);
    expect(txt).toMatch(/Экстремум/);
    const trace = result.current.__sessionMemoryDebug().lastResultActionTrace!;
    expect(trace.tableSchema?.analysisCompleted).toContain("extrema");
    expect(trace.tableSchema?.measuresCount).toBeGreaterThanOrEqual(2);
  });

  it("§58 Balance — peaks per indicator", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => { await result.current.submit("покажи пиковые значения по каждому показателю"); });
    const trace = result.current.__sessionMemoryDebug().lastResultActionTrace!;
    expect(trace.tableSchema?.analysisCompleted).toContain("peaks");
    expect(lastResponse(result)).toMatch(/Пиков/);
  });

  it("§28/§29 Balance — mixed request: compute maxima/minima/peaks now, ONE clarification for norm, then resume", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => {
      await result.current.submit(
        "найди наиболее крупные значения, значения выходящие за пределы нормы, а также пиковые и минимальные значения для каждого показателя",
      );
    });
    expect(allResponses(result)).toMatch(/Пиков|Экстремум/);
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBe("schema_norm");
    expect(lastResponse(result)).toMatch(/статистическ|порог/i);

    await act(async () => { await result.current.submit("считать статистическими выбросами"); });
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBeUndefined();
    const trace = result.current.__sessionMemoryDebug().lastResultActionTrace!;
    expect(trace.tableSchema?.analysisCompleted).toContain("outliers_iqr");
    expect(lastResponse(result)).toMatch(/выброс/i);
  });

  it("§59 partial range — a numeric block missing its header gets a specific explanation, not a generic reject", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixturePartialHeaders()) }));
    await act(async () => { await result.current.submit("найди максимальные значения для каждого показателя"); });
    const txt = lastResponse(result);
    expect(txt).toMatch(/заголов/i);
    expect(txt).not.toMatch(/ANALYSIS RESULT|rejected|Не удалось выполнить этот анализ/i);
  });

  it("§60 cross-tab — 'где значение за 2025 максимальное' → axis-aware ranking (East)", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureCrossTab()) }));
    await act(async () => { await result.current.submit("где значение за 2025 максимальное"); });
    const trace = result.current.__sessionMemoryDebug().lastResultActionTrace!;
    expect(trace.tableSchema?.layoutKind).toBe("cross_tab");
    expect(trace.tableSchema?.analysisCompleted).toContain("axis_rank");
    expect(lastResponse(result)).toMatch(/East/);
  });

  it("§61 transpose — 'покажи максимальную Revenue' → value + date, model not called", async () => {
    const client = noModelClient();
    const { result } = renderHook(() => useAgent({ chatClient: client, port: fixturePort(fixtureTransposed()) }));
    await act(async () => { await result.current.submit("покажи максимальную Revenue"); });
    expect((client.stream as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    const trace = result.current.__sessionMemoryDebug().lastResultActionTrace!;
    expect(trace.tableSchema?.orientation).toBe("column_metrics");
    expect(lastResponse(result)).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it("§16 — describe works for a cross-tab and a hierarchical report", async () => {
    for (const fx of [fixtureCrossTab(), fixtureHierarchical()]) {
      const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fx) }));
      await act(async () => { await result.current.submit("о чем эта таблица"); });
      expect(lastResponse(result).length).toBeGreaterThan(20);
    }
  });

  it("§37/§57 Sales regression — the flat grouped-ranking path is NOT hijacked", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: wrongPlanClient(), port: salesPort() }));
    await act(async () => { await result.current.submit("покажи 3 менеджеров с худшим Variance"); });
    const r = result.current.__sessionMemoryDebug().recentResults.at(-1)!;
    expect(r.entityColumn).toBe("Manager");
    expect(r.entityValues).toEqual(["Aigerim", "Aruzhan", "Timur"]);
    await act(async () => { await result.current.submit("выдели их"); });
    const proposal = result.current.entries.find((e): e is ProposalEntry => e.kind === "proposal");
    expect(proposal!.actions.map((a) => a.range)).toEqual(runsOf(salesRowsFor(["Aigerim", "Aruzhan", "Timur"])));
  });

  it("§37 Sales — 'о чем эта таблица' describes a records layout; analysis still works after", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: salesPort() }));
    await act(async () => { await result.current.submit("о чем эта таблица"); });
    expect(lastResponse(result)).toMatch(/наблюдени|запис/i);
    const trace = result.current.__sessionMemoryDebug().lastResultActionTrace!;
    expect(trace.tableSchema?.orientation).toBe("row_records");
    expect(trace.tableSchema?.routeChosen).toBe("universal_schema");
  });

  it("keeps parseLocalRange import meaningful", () => {
    expect(parseLocalRange("A1:B2").rowCount).toBe(2);
  });
});

describe("Stage 24.6.1 — norm clarification disambiguation & resume safety", () => {
  async function askNorm(result: { current: ReturnType<typeof useAgent> }) {
    await act(async () => { await result.current.submit("найди значения, выходящие за пределы нормы"); });
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBe("schema_norm");
  }
  const lastResp = (r: { current: ReturnType<typeof useAgent> }) => {
    const e = r.current.entries.filter((x) => x.kind === "response").at(-1);
    return e && e.kind === "response" ? e.text : "";
  };

  it("A/I/J — 'да' / 'yes' / 'no' do NOT pick a branch; a short disambiguation is re-asked", async () => {
    for (const ack of ["да", "yes", "no"]) {
      const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
      await askNorm(result);
      await act(async () => { await result.current.submit(ack); });
      // still waiting on the same clarification
      expect(result.current.__sessionMemoryDebug().pendingClarificationKind, ack).toBe("schema_norm");
      expect(lastResp(result), ack).toMatch(/(?:выброс|outlier).*(?:порог|threshold)|Уточните|clarify/i);
    }
  });

  it("B/C — 'статистический выброс' / 'выбросы' resume with IQR", async () => {
    for (const a of ["статистический выброс", "выбросы"]) {
      const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
      await askNorm(result);
      await act(async () => { await result.current.submit(a); });
      expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBeUndefined();
      expect(result.current.__sessionMemoryDebug().lastResultActionTrace!.tableSchema?.analysisCompleted).toContain("outliers_iqr");
    }
  });

  it("D — 'порог' with no number asks for the numeric value", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await askNorm(result);
    await act(async () => { await result.current.submit("порог"); });
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBe("schema_threshold");
    expect(lastResp(result)).toMatch(/значени.*порог|threshold value/i);
  });

  it("E/F — '0.2' and '20%' resume threshold analysis", async () => {
    for (const v of ["0.2", "20%"]) {
      const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
      await askNorm(result);
      await act(async () => { await result.current.submit(v); });
      expect(result.current.__sessionMemoryDebug().pendingClarificationKind, v).toBeUndefined();
      const trace = result.current.__sessionMemoryDebug().lastResultActionTrace!;
      expect(trace.tableSchema?.analysisCompleted, v).toContain("outliers_threshold");
    }
  });

  it("D→number — 'порог' then '0.2' completes the threshold branch", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await askNorm(result);
    await act(async () => { await result.current.submit("порог"); });
    await act(async () => { await result.current.submit("0.2"); });
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBeUndefined();
    expect(result.current.__sessionMemoryDebug().lastResultActionTrace!.tableSchema?.analysisCompleted).toContain("outliers_threshold");
  });

  it("G/H — 'первое' → statistical, 'второе' → threshold-value question", async () => {
    const a = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await askNorm(a.result);
    await act(async () => { await a.result.current.submit("первое"); });
    expect(a.result.current.__sessionMemoryDebug().lastResultActionTrace!.tableSchema?.analysisCompleted).toContain("outliers_iqr");

    const b = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await askNorm(b.result);
    await act(async () => { await b.result.current.submit("второе"); });
    expect(b.result.current.__sessionMemoryDebug().pendingClarificationKind).toBe("schema_threshold");
  });

  it("§9 — the mixed request still shows maxima/minima/peaks, then one clarification, then resumes", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureBalanceLike()) }));
    await act(async () => {
      await result.current.submit(
        "найди наиболее крупные значения, значения выходящие за пределы нормы, а также пиковые и минимальные значения для каждого показателя",
      );
    });
    const before = result.current.entries.filter((e) => e.kind === "response").map((e) => (e.kind === "response" ? e.text : "")).join("\n");
    expect(before).toMatch(/Пиков|Экстремум/);
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBe("schema_norm");

    await act(async () => { await result.current.submit("да"); });
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBe("schema_norm"); // still, not resolved

    await act(async () => { await result.current.submit("статистический выброс"); });
    expect(result.current.__sessionMemoryDebug().pendingClarificationKind).toBeUndefined();
    expect(result.current.__sessionMemoryDebug().lastResultActionTrace!.tableSchema?.analysisCompleted).toContain("outliers_iqr");
  });
});

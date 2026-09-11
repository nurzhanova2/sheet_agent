// Stage 24.8 — compositional analytics & analysis event memory.
// Integration through useAgent().submit(): real induction + real deterministic
// compiler/executor/memory; no mock returns a canned plan. Mirrors the Stage
// 24.7 harness in use-agent-analytical.test.tsx.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { splitSheetAddress, parseLocalRange } from "../app/a1.js";
import { fixtureIntervalRanking, fixtureTwoIntervalAndEvents, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";

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

/**
 * A port whose live selection can be swapped between calls (§57/§74 —
 * selection-drift). `readRange` distinguishes a genuinely small requested
 * range (a single-cell click) from a full-table request: only the latter
 * returns real fixture data, so the test can PROVE the analytical route used
 * the remembered table range rather than the live 1x1 selection.
 */
function driftPort(fx: FixtureSnapshot) {
  const cols = fx.values.reduce((m, r) => Math.max(m, r.length), 0);
  const fullSnap = {
    address: fx.address,
    sheetName: fx.sheetName,
    rowCount: fx.values.length,
    columnCount: cols,
    revision: 0,
    values: fx.values,
    formulas: fx.formulas,
    numberFormats: fx.numberFormats,
  };
  let selection = { address: fx.address, sheetName: fx.sheetName, rowCount: fx.values.length, columnCount: cols, revision: 0 };
  const port = stubPort({
    getSelection: vi.fn(async () => selection),
    readRange: vi.fn(async (address: string) => {
      try {
        const { localAddress } = splitSheetAddress(address);
        const parsed = parseLocalRange(localAddress || address);
        if (parsed.rowCount <= 1 && parsed.columnCount <= 1 && address !== fx.address) {
          return { address, sheetName: fx.sheetName, rowCount: 1, columnCount: 1, revision: 0, values: [[null]], formulas: [[null]], numberFormats: [["General"]] };
        }
      } catch {
        /* fall through to full snap */
      }
      return fullSnap;
    }) as unknown as ExcelPort["readRange"],
  });
  return {
    port,
    clickSingleCell: (address: string) => {
      selection = { address, sheetName: fx.sheetName, rowCount: 1, columnCount: 1, revision: 0 };
    },
  };
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

describe("Stage 24.8 — manual acceptance Batch A: strongest growth/decline + top-K basis switch", () => {
  it("§1–§4 — strongest growth, strongest decline (same period), top-3 relative, then 'те же 3' by absolute", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureIntervalRanking()) }));

    await act(async () => { await result.current.submit("Какой показатель вырос сильнее всего между 01.01.2024 и 01.12.2025?"); });
    expect(lastResponse(result)).toMatch(/\bA\b/);
    expect(lastResponse(result)).toMatch(/40%/);

    await act(async () => { await result.current.submit("Какой показатель снизился сильнее всего за этот же период?"); });
    expect(lastResponse(result)).toMatch(/\bC\b/);
    expect(lastResponse(result)).toMatch(/-35%/);

    await act(async () => { await result.current.submit("Покажи 3 показателя с наибольшим относительным изменением между 01.01.2024 и 01.12.2025."); });
    const top3 = lastResponse(result);
    expect(top3).not.toMatch(/за 1 месяц/);
    expect(result.current.__sessionMemoryDebug().lastRankingRef).toBeDefined();

    await act(async () => { await result.current.submit("А теперь покажи те же 3, но по абсолютному изменению."); });
    const abs = lastResponse(result);
    expect(abs).toMatch(/\bB\b/);
    expect(abs).not.toMatch(/Не удалось|couldn't/i);
  });
});

describe("Stage 24.8 — manual acceptance Batch C: two-interval predicate + ordinal reuse", () => {
  it("§7/§8 — grew-then-declined finds A; the ordinal follow-up reuses the SAME intervals and finds B", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureTwoIntervalAndEvents()) }));

    await act(async () => {
      await result.current.submit("Покажи показатели, которые выросли с 01.01.2024 по 01.01.2025, но снизились с 01.01.2025 по 01.12.2025.");
    });
    expect(lastResponse(result)).toMatch(/\bA\b/);
    const composite = result.current.__sessionMemoryDebug().lastCompositeRef;
    expect(composite).toBeDefined();

    await act(async () => {
      await result.current.submit("Покажи показатели, которые снижались в первом интервале, но выросли во втором.");
    });
    const second = lastResponse(result);
    expect(second).toMatch(/\bB\b/);
    expect(second).not.toMatch(/Не удалось|couldn't/i);
    // exact same intervals reused, not re-parsed
    expect(result.current.__sessionMemoryDebug().lastCompositeRef!.interval1.startCanonical).toBe(composite!.interval1.startCanonical);
  });
});

describe("Stage 24.8 — manual acceptance Batch D: adjacent event + EventRef follow-ups", () => {
  it("§9–§12 — global adjacent max, then 'когда'/'насколько'/'его динамику' resolve from the SAME EventRef", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureTwoIntervalAndEvents()) }));

    await act(async () => { await result.current.submit("У какого показателя самое большое изменение между соседними датами?"); });
    const evTxt = lastResponse(result);
    expect(evTxt).toMatch(/\bB\b/);
    expect(evTxt).not.toMatch(/за 1 месяц/);
    const ev = result.current.__sessionMemoryDebug().lastEventRef;
    expect(ev).toBeDefined();
    expect(ev!.metricKey).toBe("B");

    await act(async () => { await result.current.submit("Когда именно это произошло?"); });
    const whenTxt = lastResponse(result);
    expect(whenTxt).toMatch(/01\.01\.2025/);
    expect(whenTxt).toMatch(/01\.12\.2025/);
    expect(whenTxt).not.toMatch(/4[45]\d{3}/); // never a raw Excel serial
    expect(whenTxt).not.toMatch(/примерно|около|~/i); // never an approximate date

    await act(async () => { await result.current.submit("Насколько он изменился?"); });
    expect(lastResponse(result)).toMatch(/50%/);

    await act(async () => { await result.current.submit("Покажи его динамику."); });
    const dynTxt = lastResponse(result);
    expect(dynTxt).toMatch(/01\.01\.2024/);
    expect(dynTxt).toMatch(/01\.12\.2025/);
  });

  it("§13/§43 — 'что было до этого' / 'после этого' read the adjacent canonical period, never an invented one", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: fixturePort(fixtureTwoIntervalAndEvents()) }));
    await act(async () => { await result.current.submit("У какого показателя самое большое изменение между соседними датами?"); });
    await act(async () => { await result.current.submit("Что было до этого?"); });
    expect(lastResponse(result)).toMatch(/01\.01\.2024/); // the point before 01.01.2025
    await act(async () => { await result.current.submit("Что было после этого?"); });
    // B's winning event ends at 01.12.2025, the LAST point — no period after it.
    expect(lastResponse(result)).toMatch(/недоступ|edge|no adjacent/i);
  });
});

describe("Stage 24.8 §27–§29/§57/§74 — selection drift: a single-cell click inside a known table", () => {
  it("still resolves the whole analytical table, not the one clicked cell", async () => {
    const fx = fixtureIntervalRanking();
    const { port, clickSingleCell } = driftPort(fx);
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port }));

    // establish the table as "known" via a first successful analytical query.
    await act(async () => { await result.current.submit("Какой показатель вырос сильнее всего между 01.01.2024 и 01.12.2025?"); });
    expect(lastResponse(result)).toMatch(/\bA\b/);
    expect(result.current.__sessionMemoryDebug().lastAnalyticalTable?.sourceRange).toBe(fx.address);

    // user clicks a single cell INSIDE that table.
    clickSingleCell(`${fx.sheetName}!B2`);
    await act(async () => { await result.current.submit("Какой показатель снизился сильнее всего между 01.01.2024 и 01.12.2025?"); });
    const txt = lastResponse(result);
    expect(txt).toMatch(/\bC\b/);
    expect(txt).not.toMatch(/Не удалось|couldn't|MODEL WAS CALLED/i);
  });
});

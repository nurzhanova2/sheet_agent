import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import type { ProposalEntry } from "../app/agent-session.js";
import { useAgent } from "./use-agent.js";
import { SALES_HEADERS, SALES_ROWS, salesSnapshot } from "../analysis/__fixtures__/sales-test-data.js";

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
  return out.map(([a, b]) => `A${a}:L${b}`);
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
const trace = (r: { current: ReturnType<typeof useAgent> }) => r.current.__sessionMemoryDebug().lastResultActionTrace!;

describe("flat records — grouped ranking is still answered deterministically", () => {
  it("'покажи 3 менеджеров с худшим Variance' groups by Manager and ranks the three worst", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: salesPort() }));
    await act(async () => {
      await result.current.submit("покажи 3 менеджеров с худшим Variance");
    });
    expect(trace(result).routeChosen).toBe("grouped_ranking");
    const rec = result.current.__sessionMemoryDebug().recentResults.at(-1)!;
    expect(rec.entityColumn).toBe("Manager");
    expect((rec.entityValues ?? []).map(String).sort()).toEqual(["Aigerim", "Aruzhan", "Timur"]);
    expect(lastResponse(result)).not.toContain("MODEL WAS CALLED");
  });

  it("the follow-up 'выдели их' grounds that result to its 71 source rows and proposes the highlight", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: salesPort() }));
    await act(async () => {
      await result.current.submit("покажи 3 менеджеров с худшим Variance");
    });
    await act(async () => {
      await result.current.submit("выдели их");
    });
    const expected = salesRowsFor(["Aigerim", "Aruzhan", "Timur"]);
    expect(expected.length).toBe(71);
    expect(trace(result).grounding?.sheetRowsCount).toBe(71);
    const proposal = result.current.entries.find((e): e is ProposalEntry => e.kind === "proposal");
    expect(proposal!.actions.map((a) => a.range)).toEqual(runsOf(expected));
  });
});

describe("flat records — a structural question is described without a model call", () => {
  it("'о чем эта таблица' describes the records layout from the induced schema alone", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: noModelClient(), port: salesPort() }));
    await act(async () => {
      await result.current.submit("о чем эта таблица");
    });
    expect(lastResponse(result)).toMatch(/наблюдени|запис/i);
    expect(lastResponse(result)).not.toContain("MODEL WAS CALLED");
    expect(trace(result).routeChosen).toBe("flat_table_describe");
  });
});

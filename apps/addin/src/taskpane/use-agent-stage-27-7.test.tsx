import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import type { ExecutionEntry, TranscriptEntry } from "../app/agent-session.js";
import { fixtureDirectionAndSets, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";
import { resetTurnLedger } from "../analytical-engine-v2/production/turn-ledger.js";
import { clearAnalyticalTraces } from "../analytical-engine-v2/debug/analytical-trace.js";
import type { AnalyticalRuntime } from "../analytical-engine-v2/sandbox/executor.js";

const harness = vi.hoisted(() => ({ runtime: null as AnalyticalRuntime | null }));

vi.mock("./analysis-capability.js", () => ({
  analysisCapability: (params: { generateCode: unknown; currentSourceVersion: unknown }) =>
    harness.runtime === null ? undefined : { runtime: harness.runtime, generateCode: params.generateCode, currentSourceVersion: params.currentSourceVersion },
  sandboxRuntime: () => ({ runtime: harness.runtime, kind: "worker", hardTimeout: true }),
  resetSandboxRuntime: () => undefined,
}));

const { useAgent } = await import("./use-agent.js");

const RESULT_DEFAULTS = {
  actions: [],
  actionErrors: [],
  analysisRuns: 0,
  analysisHadError: false,
  charts: [],
  language: "ru" as const,
  planKind: "none" as const,
};

function snapOf(fx: FixtureSnapshot) {
  const cols = fx.values.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    address: fx.address,
    sheetName: fx.sheetName,
    rowCount: fx.values.length,
    columnCount: cols,
    revision: 0,
    values: fx.values,
    formulas: fx.formulas,
    numberFormats: fx.numberFormats,
  };
}

function workbookPort(fx: FixtureSnapshot): ExcelPort & ExcelMutationPort {
  const snap = snapOf(fx);
  return {
    capabilities: { tables: true, charts: true, pivotTables: true, namedRanges: true },
    getSelection: vi.fn(async () => ({ address: snap.address, sheetName: snap.sheetName, rowCount: snap.rowCount, columnCount: snap.columnCount, revision: 0 })),
    readRange: vi.fn(async () => snap),
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
  } as unknown as ExcelPort & ExcelMutationPort;
}

function lastUser(messages: readonly { readonly role: string; readonly content: string }[]): string {
  return messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
}

function idOf(prompt: string, tool: string): string | null {
  const header = "=== RESULTS SO FAR ===\n";
  const start = prompt.indexOf(header);
  if (start < 0) return null;
  const block = prompt
    .slice(start + header.length)
    .split("\n\n")
    .find((b) => /^result_\d+ = /.test(b.trim()) && b.includes(`= ${tool} → `));
  return /^(result_\d+) = /.exec(block?.trim() ?? "")?.[1] ?? null;
}

const GENERATED_CODE = 'import numpy as np\nRESULT = {"scalars": {"spread": float(np.std([1.0, 2.0]))}}';

function client(script: (messages: readonly { readonly role: string; readonly content: string }[]) => string): ChatClient {
  return {
    stream: vi.fn(async (_r: ChatStreamRequest, h: ChatStreamHandlers) => {
      h.onDelta("общий ответ");
      return { ...RESULT_DEFAULTS, text: "GENERAL" } as ChatResult;
    }),
    narrate: vi.fn(async () => "Готово."),
    planAnalyticalTurn: vi.fn(async (messages: readonly { readonly role: "system" | "user"; readonly content: string }[]) => script(messages)),
    generateAnalysisCode: vi.fn(async () => GENERATED_CODE),
  } as unknown as ChatClient;
}

const deterministicScript = (messages: readonly { readonly role: string; readonly content: string }[]): string => {
  const p = lastUser(messages);
  const cmp = idOf(p, "change.compare_periods");
  if (!cmp) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { periodIntent: { kind: "latest_vs_previous" } }, final: true });
  return JSON.stringify({ kind: "complete", primaryResultRef: cmp, supportingResultRefs: [] });
};

const clusterScript = (): string =>
  JSON.stringify({
    kind: "analyze",
    objective: "сгруппировать показатели по динамике",
    requestedOutputs: [{ description: "группы", shape: "groups" }],
    necessity: "MISSING_DETERMINISTIC_CAPABILITY",
  });

const executions = (r: { current: ReturnType<typeof useAgent> }): readonly ExecutionEntry[] =>
  r.current.entries.filter((x: TranscriptEntry): x is ExecutionEntry => x.kind === "execution");

beforeEach(() => {
  resetTurnLedger();
  clearAnalyticalTraces();
  harness.runtime = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Stage 27.7 §10 — the execution trace collapses once the answer is in", () => {
  it("leaves one expandable line and the answer, with the steps inside it", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: client(deterministicScript), port: workbookPort(fixtureDirectionAndSets()) }));
    await act(async () => {
      await result.current.submit("Как изменились показатели относительно предыдущего периода?");
    });

    expect(result.current.entries.filter((e) => e.kind === "activity")).toEqual([]);
    const collapsed = executions({ current: result.current });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.title).toMatch(/^Готово за \d/u);
    expect(collapsed[0]!.status).toBe("done");
    expect(collapsed[0]!.details.some((d) => d.kind === "step" && /^Прочитан диапазон /u.test(d.title))).toBe(true);
    expect(collapsed[0]!.details.some((d) => d.kind === "step" && /Планирую анализ/u.test(d.title))).toBe(true);
  });

  it("puts the collapsed line before the answer, not after it", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: client(deterministicScript), port: workbookPort(fixtureDirectionAndSets()) }));
    await act(async () => {
      await result.current.submit("Как изменились показатели относительно предыдущего периода?");
    });
    const kinds = result.current.entries.map((e) => e.kind);
    expect(kinds.indexOf("execution")).toBeGreaterThan(kinds.indexOf("command"));
    expect(kinds.indexOf("execution")).toBeLessThan(kinds.indexOf("response"));
  });

  it("reports what the turn spent, inside the collapsed line", async () => {
    const { result } = renderHook(() => useAgent({ chatClient: client(deterministicScript), port: workbookPort(fixtureDirectionAndSets()) }));
    await act(async () => {
      await result.current.submit("Как изменились показатели относительно предыдущего периода?");
    });
    const metrics = executions({ current: result.current })[0]!.metrics;
    expect(metrics.some((m) => m.startsWith("Раундов планировщика:"))).toBe(true);
    expect(metrics.some((m) => m.startsWith("Обращений к модели:"))).toBe(true);
    expect(metrics.some((m) => m.startsWith("Запусков Python:"))).toBe(true);
  });
});

describe("Stage 27.7 §11/§12 — the generated Python survives the collapse", () => {
  it("keeps every attempt's code inside the execution details", async () => {
    harness.runtime = {
      hardTimeout: true,
      ready: async () => undefined,
      validate: async () => [],
      execute: async () => ({ ok: false as const, error: { code: "SANDBOX_RUNTIME_ERROR" as const, message: "NameError: name 'x' is not defined" }, durationMs: 4 }),
    } as unknown as AnalyticalRuntime;

    const { result } = renderHook(() => useAgent({ chatClient: client(clusterScript), port: workbookPort(fixtureDirectionAndSets()) }));
    await act(async () => {
      await result.current.submit("Проведи кластеризацию показателей по динамике.");
    });

    expect(result.current.entries.filter((e) => e.kind === "code")).toEqual([]);
    const collapsed = executions({ current: result.current });
    expect(collapsed).toHaveLength(1);
    const code = collapsed[0]!.details.filter((d) => d.kind === "code");
    expect(code.length).toBeGreaterThanOrEqual(1);
    expect(code[0]).toMatchObject({ kind: "code", code: GENERATED_CODE, attempt: 1 });
    expect(collapsed[0]!.details.some((d) => d.kind === "step" && /NameError/u.test(d.detail ?? ""))).toBe(true);
    expect(collapsed[0]!.status).toBe("error");
    expect(collapsed[0]!.title).toMatch(/^Остановлено через \d/u);
  });

  it("marks the sandbox turn with how many Python runs it took", async () => {
    harness.runtime = {
      hardTimeout: true,
      ready: async () => undefined,
      validate: async () => [],
      execute: async () => ({ ok: false as const, error: { code: "SANDBOX_RUNTIME_ERROR" as const, message: "ValueError: bad input" }, durationMs: 3 }),
    } as unknown as AnalyticalRuntime;

    const { result } = renderHook(() => useAgent({ chatClient: client(clusterScript), port: workbookPort(fixtureDirectionAndSets()) }));
    await act(async () => {
      await result.current.submit("Проведи кластеризацию показателей по динамике.");
    });
    expect(executions({ current: result.current })[0]!.subtitle).toMatch(/^Python · \d+ запуск/u);
  });
});

describe("Stage 27.7 §2 — a sandbox that never starts explains itself in the details", () => {
  it("carries the real startup reason and the asset into the collapsed block", async () => {
    const diagnostics = [
      { label: "Этап", value: "среда Python не запустилась" },
      { label: "Причина", value: "Unable to load package numpy: 404" },
      { label: "Ресурс", value: "numpy-2.4.6-cp314.whl" },
      { label: "Пакеты Python", value: "https://localhost:47831/pyodide/" },
    ];
    harness.runtime = {
      hardTimeout: true,
      ready: async () => {
        throw new Error("Unable to load package numpy: 404");
      },
      validate: async () => [],
      execute: async () => ({ ok: false as const, error: { code: "SANDBOX_UNAVAILABLE" as const, message: "never started" }, durationMs: 0 }),
      startupDiagnostics: () => diagnostics,
    } as unknown as AnalyticalRuntime;

    const { result } = renderHook(() => useAgent({ chatClient: client(clusterScript), port: workbookPort(fixtureDirectionAndSets()) }));
    await act(async () => {
      await result.current.submit("Проведи кластеризацию показателей по динамике.");
    });

    const collapsed = executions({ current: result.current });
    expect(collapsed).toHaveLength(1);
    const failure = collapsed[0]!.details.find((d) => d.kind === "step" && d.title === "Python-песочница не запустилась");
    expect(failure).toBeDefined();
    expect(failure && failure.kind === "step" ? failure.diagnostics : []).toEqual(diagnostics);
  });

  it("keeps the technical detail out of the answer itself", async () => {
    harness.runtime = {
      hardTimeout: true,
      ready: async () => {
        throw new Error("Unable to load package numpy: 404 https://localhost:47831/pyodide/numpy.whl");
      },
      validate: async () => [],
      execute: async () => ({ ok: false as const, error: { code: "SANDBOX_UNAVAILABLE" as const, message: "never started" }, durationMs: 0 }),
      startupDiagnostics: () => [{ label: "Причина", value: "404" }],
    } as unknown as AnalyticalRuntime;

    const { result } = renderHook(() => useAgent({ chatClient: client(clusterScript), port: workbookPort(fixtureDirectionAndSets()) }));
    await act(async () => {
      await result.current.submit("Проведи кластеризацию показателей по динамике.");
    });
    const answer = result.current.entries.filter((e) => e.kind === "response").at(-1);
    const text = answer && answer.kind === "response" ? answer.text : "";
    expect(text).not.toContain("localhost:47831");
    expect(text).not.toContain("numpy.whl");
    expect(text.length).toBeGreaterThan(0);
  });
});

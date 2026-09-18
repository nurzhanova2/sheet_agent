// ---------------------------------------------------------------------------
// Stage 26.8 §42/§43/§44/§45/§46 — the PRODUCTION integration.
//
// These go through `useAgent().submit()` — the real router, the real ownership
// decision, the real schema induction, the real V2 engine, the real tools and
// the real state commit. Only the two model roles are scripted, exactly as
// Stage 25's integration tests script theirs.
//
// The thing every test here actually asserts is §44: for one user turn there is
// ONE analytical owner. The ledger is the evidence, and a turn that ran two
// analytical engines fails, rather than being noticed later by a human tester
// wondering why the numbers moved.
// ---------------------------------------------------------------------------

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcelMutationPort, ExcelPort } from "@sheet-agent/application";
import type { ChatClient, ChatResult, ChatStreamHandlers, ChatStreamRequest } from "../app/chat-client.js";
import { useAgent } from "./use-agent.js";
import { fixtureBalanceLike, fixtureDirectionAndSets, fixtureRecords, type FixtureSnapshot } from "../app/schema/__fixtures__/tables.js";
import { lastTurn, resetTurnLedger, turnLedger } from "../analytical-engine-v2/production/turn-ledger.js";
import { clearAnalyticalTraces, getAnalyticalTraces } from "../analytical-engine-v2/debug/analytical-trace.js";

const RESULT_DEFAULTS = {
  actions: [],
  actionErrors: [],
  analysisRuns: 0,
  analysisHadError: false,
  charts: [],
  language: "ru" as const,
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

/** One workbook, addressable by range — so a table SWITCH is a real switch (§16). */
function workbookPort(...tables: readonly FixtureSnapshot[]) {
  const snaps = tables.map(snapOf);
  let selected = 0;
  const port = stubPort({
    getSelection: vi.fn(async () => {
      const s = snaps[selected]!;
      return { address: s.address, sheetName: s.sheetName, rowCount: s.rowCount, columnCount: s.columnCount, revision: 0 };
    }),
    readRange: vi.fn(async (address: string) => snaps.find((s) => s.address === address) ?? snaps[selected]!) as unknown as ExcelPort["readRange"],
  });
  return {
    port,
    select(i: number) {
      selected = i;
    },
    /** §15 — the user clicks ONE CELL inside the table they just analysed. */
    driftToCell(address: string) {
      (port.getSelection as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        address,
        sheetName: snaps[selected]!.sheetName,
        rowCount: 1,
        columnCount: 1,
        revision: 0,
      }));
      (port.readRange as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (a: string) =>
        a === address
          ? { address, sheetName: snaps[selected]!.sheetName, rowCount: 1, columnCount: 1, revision: 0, values: [[123]], formulas: [[null]], numberFormats: [["General"]] }
          : (snaps.find((s) => s.address === a) ?? snaps[selected]!),
      );
    },
  };
}

// --- the scripted planner ----------------------------------------------------

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

const call = (tool: string, args: Record<string, unknown> = {}): string => JSON.stringify({ kind: "tool_call", tool, arguments: args });
const complete = (primary: string, supporting: readonly string[] = []): string =>
  JSON.stringify({ kind: "complete", primaryResultRef: primary, supportingResultRefs: supporting });

/** "What moved the most?" — compare every metric, then rank by magnitude. */
function biggestMoverScript(messages: readonly { readonly role: string; readonly content: string }[]): string {
  const p = lastUser(messages);
  const latest = idOf(p, "period.latest");
  if (!latest) return call("period.latest");
  const prev = idOf(p, "period.previous");
  if (!prev) return call("period.previous", { ofRef: latest });
  const cmp = idOf(p, "change.compare_periods");
  if (!cmp) return call("change.compare_periods", { startPeriodRef: prev, endPeriodRef: latest });
  const win = idOf(p, "set.argmax");
  if (!win) return call("set.argmax", { inputRef: cmp, field: "percentageChange", magnitude: true });
  return complete(win, [cmp]);
}

/** A follow-up that must stay on the metric already in focus. */
function historyOfFocusScript(messages: readonly { readonly role: string; readonly content: string }[]): string {
  const p = lastUser(messages);
  const m = idOf(p, "reference.last_metric");
  if (!m) return call("reference.last_metric");
  const s = idOf(p, "series.get");
  if (!s) return call("series.get", { metricRef: m });
  return complete(s);
}

interface ScriptedClient extends ChatClient {
  readonly plan: ReturnType<typeof vi.fn>;
  readonly narrateFn: ReturnType<typeof vi.fn>;
  readonly streamFn: ReturnType<typeof vi.fn>;
}

function v2Client(
  scripts: readonly ((messages: readonly { readonly role: string; readonly content: string }[]) => string)[],
  narrateImpl: () => Promise<string> = async () => "Готово.",
): ScriptedClient {
  let turn = 0;
  const seen = new Set<string>();
  const plan = vi.fn(async (messages: readonly { readonly role: "system" | "user"; readonly content: string }[]) => {
    const request = /=== (?:USER REQUEST|THE REPLY) ===\n([^\n]*)/.exec(lastUser(messages))?.[1] ?? "";
    if (!seen.has(request)) {
      seen.add(request);
      turn = Math.min(seen.size - 1, scripts.length - 1);
    }
    return scripts[turn]!(messages);
  });
  const narrateFn = vi.fn(narrateImpl);
  const streamFn = vi.fn(async (_r: ChatStreamRequest, h: ChatStreamHandlers) => {
    h.onDelta("общий ответ");
    return { ...RESULT_DEFAULTS, text: "GENERAL CHAT ANSWER" } as ChatResult;
  });
  return {
    stream: streamFn,
    narrate: narrateFn,
    planAnalyticalTurn: plan,
    plan,
    narrateFn,
    streamFn,
  } as unknown as ScriptedClient;
}

const lastResponse = (r: { current: ReturnType<typeof useAgent> }): string => {
  const e = r.current.entries.filter((x) => x.kind === "response").at(-1);
  return e && e.kind === "response" ? e.text : "";
};

const activityTitles = (r: { current: ReturnType<typeof useAgent> }): readonly string[] =>
  r.current.entries.filter((x) => x.kind === "activity").map((x) => (x.kind === "activity" ? x.title : ""));

beforeEach(() => {
  resetTurnLedger();
  clearAnalyticalTraces();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// --- §43/§44/§46: ownership --------------------------------------------------

describe("Stage 26.8 §43/§46 — a schema analytical question is owned by V2", () => {
  it("runs the V2 engine, records it as the only analytical owner, and answers", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });

    const turn = lastTurn()!;
    expect(turn.owner).toBe("V2_OWNED");
    expect(turn.ownerReason).toBe("analytical_request");
    // §44 — exactly one analytical engine ran this turn.
    expect(turn.engines).toEqual(["analytical_engine_v2"]);
    expect(turn.outcome).toBe("answered");
    // §46 — activation is proven by the TRACE, not by the flag's value.
    expect(getAnalyticalTraces().length).toBe(1);
    expect(getAnalyticalTraces()[0]!.route).toBe("analytical_engine_v2");
    expect(client.plan).toHaveBeenCalled();
    expect(client.streamFn).not.toHaveBeenCalled();
    expect(lastResponse({ current: result.current })).toContain("Готово.");
  });

  it("§17 — the answer carries its source table", async () => {
    const fx = fixtureDirectionAndSets();
    const wb = workbookPort(fx);
    const { result } = renderHook(() => useAgent({ chatClient: v2Client([biggestMoverScript]), port: wb.port }));
    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    expect(lastResponse({ current: result.current })).toContain(fx.sheetName);
  });

  it("§20 — the turn shows progress rather than sitting silent", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const { result } = renderHook(() => useAgent({ chatClient: v2Client([biggestMoverScript]), port: wb.port }));
    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    const titles = activityTitles({ current: result.current });
    expect(titles.some((t) => /Читаю данные/.test(t))).toBe(true);
    expect(titles.some((t) => /Формирую ответ/.test(t))).toBe(true);
    // §20 — and never a tool name or a percentage.
    expect(titles.some((t) => /\b(set|metric|change|series)\./.test(t) || /%/.test(t))).toBe(false);
  });
});

describe("Stage 26.8 §43/§7 — general knowledge is NOT V2's", () => {
  it("answers a definition question through general chat, with a table already analysed", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    const plansAfterAnalysis = client.plan.mock.calls.length;

    await act(async () => {
      await result.current.submit("Что такое кредитный риск?");
    });

    const turn = lastTurn()!;
    expect(turn.owner).toBe("NON_V2");
    expect(turn.ownerReason).toBe("general_knowledge");
    expect(turn.engines).toEqual([]);
    // §64 — and it did not quietly become a workbook question.
    expect(client.plan.mock.calls.length).toBe(plansAfterAnalysis);
    expect(client.streamFn).toHaveBeenCalled();
  });
});

describe("Stage 26.8 §43/§38 — slash commands stay deterministic", () => {
  it("does not reach V2", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));
    await act(async () => {
      await result.current.submit("/sheets");
    });
    expect(lastTurn()!.owner).toBe("NON_V2");
    expect(lastTurn()!.ownerReason).toBe("slash_command");
    expect(client.plan).not.toHaveBeenCalled();
  });
});

describe("Stage 26.8 §36/§43 — a mutation request stays on the deterministic path", () => {
  it("V2 never owns a write", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));
    await act(async () => {
      await result.current.submit("Выдели красным строки с убытком");
    });
    const turn = lastTurn()!;
    expect(turn.owner).toBe("NON_V2");
    expect(["mutation_request", "result_action"]).toContain(turn.ownerReason);
    expect(turn.engines).not.toContain("analytical_engine_v2");
  });
});

// --- §44: the double-execution guard ----------------------------------------

describe("Stage 26.8 §44 — one turn, one analytical owner", () => {
  it("no turn of a mixed session ever runs two analytical engines", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript, historyOfFocusScript, biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    for (const text of ["Какой показатель изменился сильнее всего?", "Покажи его динамику", "Что такое волатильность?", "/sheets", "Какой показатель изменился сильнее всего?"]) {
      await act(async () => {
        await result.current.submit(text);
      });
    }

    for (const entry of turnLedger()) {
      expect(new Set(entry.engines).size, `${entry.request} → [${entry.engines.join(", ")}]`).toBeLessThanOrEqual(1);
    }
  });
});

// --- §45/§46: the flag ------------------------------------------------------

describe("Stage 26.8 §45 — the flag is a real rollback", () => {
  it("with V2 OFF the analytical turn never reaches the V2 engine", async () => {
    vi.stubEnv("VITE_UNIFIED_ANALYTICAL_ENGINE_V2", "false");
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });

    expect(lastTurn()!.owner).toBe("NON_V2");
    expect(lastTurn()!.ownerReason).toBe("flag_off");
    expect(client.plan).not.toHaveBeenCalled();
    expect(getAnalyticalTraces().length).toBe(0);
  });
});

// --- §12/§13/§15/§16: session lifecycle -------------------------------------

describe("Stage 26.8 §12/§15 — the conversation survives real follow-ups", () => {
  it("a follow-up after clicking a single cell keeps the analytical context", async () => {
    const fx = fixtureDirectionAndSets();
    const wb = workbookPort(fx);
    const client = v2Client([biggestMoverScript, historyOfFocusScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    // §15 — the tester clicks one cell inside the table they just analysed.
    wb.driftToCell(`${fx.sheetName}!B3`);

    await act(async () => {
      await result.current.submit("Покажи его динамику");
    });

    const turn = lastTurn()!;
    expect(turn.owner).toBe("V2_OWNED");
    expect(turn.outcome).toBe("answered");
    const trace = getAnalyticalTraces().at(-1)!;
    // the same table, not the single cell
    expect(trace.sourceRange).toBe(fx.address);
    expect(trace.stateBefore.lastMetric).toBeDefined();
  });
});

describe("Stage 26.8 §13 — a new chat has no analytical memory", () => {
  it("reset clears the V2 table and every reference", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript, biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    expect(getAnalyticalTraces().at(-1)!.stateAfter?.tableRef).toBeDefined();

    await act(async () => {
      result.current.reset();
    });
    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });

    // §13 — the second conversation starts from nothing at all.
    const trace = getAnalyticalTraces().at(-1)!;
    expect(trace.stateBefore.tableRef).toBeUndefined();
    expect(trace.stateBefore.lastMetric).toBeUndefined();
    expect(trace.stateBefore.lastResult).toBeUndefined();
  });
});

describe("Stage 26.8 §16 — switching tables does not silently reuse the old one", () => {
  it("the second table's analysis runs against the second table", async () => {
    const a = fixtureDirectionAndSets();
    const b = fixtureBalanceLike();
    const wb = workbookPort(a, b);
    const client = v2Client([biggestMoverScript, biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    wb.select(1);
    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });

    const trace = getAnalyticalTraces().at(-1)!;
    expect(trace.sourceRange).toBe(b.address);
    expect(trace.sourceRange).not.toBe(a.address);
  });
});

// --- §18/§31/§32: what the person sees --------------------------------------

describe("Stage 26.8 §31 — narration can fail without costing the turn", () => {
  it("still answers from the verified results, and the next turn still works", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript, historyOfFocusScript], async () => {
      throw new Error("narrator offline");
    });
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    const body = lastResponse({ current: result.current });
    expect(body.length).toBeGreaterThan(0);
    expect(lastTurn()!.outcome).toBe("answered");
    expect(getAnalyticalTraces().at(-1)!.narratorStatus).toBe("fallback");
    // §31 — and the state was committed before narration, so this still works.
    await act(async () => {
      await result.current.submit("Покажи его динамику");
    });
    expect(lastTurn()!.outcome).toBe("answered");
  });
});

describe("Stage 26.8 §18 — no internal protocol reaches the transcript", () => {
  it("a narrator that echoes result ids is replaced, not shown", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript], async () => "Победил result_2 по полю percentageChange через set.argmax.");
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));
    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    const body = lastResponse({ current: result.current });
    expect(body).not.toMatch(/result_\d/);
    expect(body).not.toContain("set.argmax");
  });
});

describe("Stage 26.8 §11/§32 — a V2 failure is a V2 message", () => {
  it("never hands the same analytical request to Stage 24/25", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([() => "I'm afraid I can't do that."]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });

    const turn = lastTurn()!;
    expect(turn.owner).toBe("V2_OWNED");
    expect(turn.outcome).toBe("failed");
    expect(turn.engines).toEqual(["analytical_engine_v2"]);
    // §32 — a category, never an enum.
    const body = lastResponse({ current: result.current });
    expect(body).not.toMatch(/invalid_decision|MULTIPLE_DECISIONS|model_error/);
    expect(body.length).toBeGreaterThan(20);
    expect(client.streamFn).not.toHaveBeenCalled();
  });
});

// --- §19: the debug surface --------------------------------------------------

describe("Stage 26.8 §19 — the developer trace is reachable and complete", () => {
  it("/debug analytical-engine reports owner, tools, results and identity", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const { result } = renderHook(() => useAgent({ chatClient: v2Client([biggestMoverScript]), port: wb.port }));
    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    await act(async () => {
      await result.current.submit("/debug analytical-engine");
    });
    const dump = lastResponse({ current: result.current });
    for (const expected of ["analytical engine v2: ON", "TURN OWNERSHIP", "V2 CONVERSATION STATE", "PLANNER ROUND", "TOOL CALL", "REFERENCES", "SERIALIZATION", "PRIMARY RESULT", "NARRATOR"]) {
      expect(dump, expected).toContain(expected);
    }
  });
});

// --- §36/§37/§65: the mutation boundary --------------------------------------

describe("Stage 26.8 §37/§65 — analysis by V2, mutation by the deterministic path", () => {
  it("a V2 answer leaves a result the existing Preview flow can act on", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    expect(lastTurn()!.owner).toBe("V2_OWNED");
    // §37 — the typed handoff: a real ResultRef, not a re-parse of the prose.
    const memory = result.current.__sessionMemoryDebug();
    expect(memory.recentResults.length).toBeGreaterThan(0);
    expect(memory.recentResults.at(-1)!.rowCount).toBeGreaterThan(0);

    // §36/§65 — and the mutation that follows is NOT V2's, and goes to Preview.
    await act(async () => {
      await result.current.submit("Выдели его красным");
    });
    const mutationTurn = lastTurn()!;
    expect(mutationTurn.owner).toBe("NON_V2");
    expect(mutationTurn.engines).not.toContain("analytical_engine_v2");
    // nothing was written without approval
    expect(wb.port.writeFillColors as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(wb.port.writeRange as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("§36 — V2 never writes to the workbook on an analytical turn", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const { result } = renderHook(() => useAgent({ chatClient: v2Client([biggestMoverScript]), port: wb.port }));
    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    for (const write of ["writeRange", "writeFillColors", "addWorksheet", "deleteWorksheet", "insertImage", "deleteShape"] as const) {
      expect(wb.port[write] as ReturnType<typeof vi.fn>, write).not.toHaveBeenCalled();
    }
  });
});

// --- §21/§30: cancellation, and a question the person walked away from -------

describe("Stage 26.8 §21 — a cancelled turn appends nothing", () => {
  it("starting a new chat mid-turn drops the answer and the state it computed", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const client = v2Client([
      (messages) => {
        calls += 1;
        return biggestMoverScript(messages);
      },
    ]);
    // hold the narrator open so the turn is still in flight when reset lands
    (client.narrateFn as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await gate;
      return "Готово.";
    });
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    let submitted: Promise<void> | null = null;
    await act(async () => {
      submitted = result.current.submit("Какой показатель изменился сильнее всего?");
      await Promise.resolve();
    });
    await act(async () => {
      result.current.reset();
      release?.();
      await submitted;
    });

    expect(calls).toBeGreaterThan(0);
    // the transcript was cleared by reset and the late answer never arrived
    expect(result.current.entries.filter((e) => e.kind === "response")).toEqual([]);
    // …and the state that turn computed did not survive into the new chat
    await act(async () => {
      await result.current.submit("Покажи его динамику");
    });
    expect(getAnalyticalTraces().at(-1)!.stateBefore.lastMetric).toBeUndefined();
  });
});

describe("Stage 26.8 §30 — an outstanding question does not capture the next message", () => {
  const askForThreshold = (): string => JSON.stringify({ kind: "clarify", question: "Какой порог считать допустимым?", options: [] });

  it("a mutation after a clarification goes to the deterministic path", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([askForThreshold, biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Отметь показатели, вышедшие за порог.");
    });
    expect(lastTurn()!.outcome).toBe("clarify");

    await act(async () => {
      await result.current.submit("Выдели это красным");
    });
    const turn = lastTurn()!;
    expect(turn.owner).toBe("NON_V2");
    expect(["mutation_request", "result_action"]).toContain(turn.ownerReason);
  });

  it("a definition question after a clarification goes to general chat", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([askForThreshold]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));
    await act(async () => {
      await result.current.submit("Отметь показатели, вышедшие за порог.");
    });
    await act(async () => {
      await result.current.submit("Что такое кредитный риск?");
    });
    expect(lastTurn()!).toMatchObject({ owner: "NON_V2", ownerReason: "general_knowledge" });
    expect(client.streamFn).toHaveBeenCalled();
  });

  it("but a short reply still resumes the task", async () => {
    const wb = workbookPort(fixtureDirectionAndSets());
    const client = v2Client([askForThreshold, biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));
    await act(async () => {
      await result.current.submit("Отметь показатели, вышедшие за порог.");
    });
    await act(async () => {
      await result.current.submit("20%");
    });
    const turn = lastTurn()!;
    expect(turn.owner).toBe("V2_OWNED");
    expect(turn.ownerReason).toBe("v2_clarification_reply");
  });
});

// --- §6/§39: a records table under the cursor is Stage 24's ------------------

describe("Stage 26.8 §6/§39 — a flat records list is not V2's, even mid-conversation", () => {
  it("does not answer about the table the person left", async () => {
    const analytical = fixtureDirectionAndSets();
    const records = fixtureRecords();
    const wb = workbookPort(analytical, records);
    const client = v2Client([biggestMoverScript, biggestMoverScript]);
    const { result } = renderHook(() => useAgent({ chatClient: client, port: wb.port }));

    await act(async () => {
      await result.current.submit("Какой показатель изменился сильнее всего?");
    });
    expect(lastTurn()!.owner).toBe("V2_OWNED");

    // the person selects the flat sales-shaped sheet and asks about IT
    wb.select(1);
    const tracesBefore = getAnalyticalTraces().length;
    await act(async () => {
      await result.current.submit("Сколько всего продано за период?");
    });

    const turn = lastTurn()!;
    expect(turn.owner).toBe("NON_V2");
    expect(turn.ownerReason).toBe("no_table");
    expect(turn.engines).not.toContain("analytical_engine_v2");
    // …and above all, V2 did not quietly answer from the previous table
    expect(getAnalyticalTraces().length).toBe(tracesBefore);
  });
});

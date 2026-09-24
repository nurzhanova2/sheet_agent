import { describe, expect, it } from "vitest";
import { runAnalyticalEngine, type EngineTurn } from "./engine.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";
import { parsePlannerDecision } from "./planner/planner-prompt.js";
import { fixtureOperations, type SyntheticTable } from "./__fixtures__/synthetic-tables.js";
import { assetHint, startupDiagnosticsOf, WorkerSandboxRuntime, type SandboxWorkerLike } from "./sandbox/worker-runtime.js";
import { createSandboxRuntime, describeSandboxEnvironment, resolvedAgainstDocument, VENDORED_INDEX_URL } from "./sandbox/runtime-factory.js";
import { progressStepFor, executionMetrics, stoppedLabel, pythonSummaryLabel } from "./production/progress-labels.js";
import { EMPTY_TIMINGS, type ExecutionEvent } from "./production/execution-progress.js";
import { composeStatements, deterministicAnswerPlan, renderDeterministic } from "./narration/narrator.js";
import { statementFor } from "./insight/statement.js";
import { buildToolEnv, findTool } from "./tools/registry.js";
import { ResultStore } from "./results/result-store.js";
import type { VerifiedFinding } from "./insight/verified-finding.js";
import type { EngineAnalysis } from "./types.js";

type Script = (messages: readonly PlannerMessage[]) => string;

function lastUser(messages: readonly PlannerMessage[]): string {
  return messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
}

function idOf(prompt: string, tool: string): string | null {
  const header = "=== RESULTS SO FAR ===\n";
  const start = prompt.indexOf(header);
  if (start < 0) return null;
  const blocks = prompt.slice(start + header.length).split("\n\n").filter((b) => /^result_\d+ = /.test(b.trim()));
  const block = blocks.find((b) => b.includes(`= ${tool} → `));
  return /^(result_\d+) = /.exec(block?.trim() ?? "")?.[1] ?? null;
}

async function runTurn(table: SyntheticTable, request: string, script: Script, onProgress?: (e: ExecutionEvent) => void): Promise<EngineTurn> {
  return runAnalyticalEngine({
    turnId: "turn_277",
    request,
    schema: table.schema,
    grids: table.grids,
    language: "ru",
    state: EMPTY_ANALYTICAL_STATE,
    decide: (messages) => script(messages),
    narrate: async () => "",
    ...(onProgress ? { onProgress } : {}),
  });
}

describe("Stage 27.7 §1 — the production sandbox wiring is described, not assumed", () => {
  it("resolves the vendored runtime against the task pane document, never a CDN", () => {
    expect(VENDORED_INDEX_URL).toBe("pyodide/");
    expect(resolvedAgainstDocument("pyodide/")).not.toMatch(/cdn|jsdelivr|unpkg/iu);
  });

  it("records the index URL, the origin and the document base in the environment it hands the worker", () => {
    const environment = describeSandboxEnvironment("https://localhost:47831/pyodide/", false);
    expect(environment.indexURL).toBe("https://localhost:47831/pyodide/");
    expect(environment.workerType).toBe("none");
    expect(environment.moduleURL).toBe("(no worker)");
    expect(typeof environment.origin).toBe("string");
    expect(typeof environment.baseURI).toBe("string");
  });

  it("gives the worker runtime an environment when it builds one", () => {
    const choice = createSandboxRuntime({ workerFactory: () => fakeWorker(() => ({ type: "ready" })) });
    expect(choice.kind).toBe("worker");
    const rows = choice.runtime.startupDiagnostics?.() ?? [];
    expect(rows.map((r) => r.label)).toContain("Пакеты Python");
    expect(rows.find((r) => r.label === "Пакеты Python")?.value).toContain("pyodide/");
  });
});

interface FakeWorker extends SandboxWorkerLike {
  readonly sent: unknown[];
}

function fakeWorker(reply: (message: unknown) => unknown | null): FakeWorker {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const sent: unknown[] = [];
  return {
    sent,
    postMessage(message: unknown) {
      sent.push(message);
      const out = reply(message);
      if (out === null) return;
      for (const listener of listeners.get("message") ?? []) listener({ data: out });
    },
    terminate() {
      return undefined;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
}

describe("Stage 27.7 §2 — a sandbox that will not start says why", () => {
  it("keeps the runtime's own failure text and names the asset in it", async () => {
    const message = 'Error: Unable to load package numpy: TypeError: Failed to fetch https://localhost:47831/pyodide/numpy-2.4.6-cp314.whl';
    const runtime = new WorkerSandboxRuntime({
      factory: () => fakeWorker((m) => ((m as { type: string }).type === "init" ? { type: "boot_error", message } : null)),
      indexURL: "https://localhost:47831/pyodide/",
      environment: describeSandboxEnvironment("https://localhost:47831/pyodide/", false),
    });

    await expect(runtime.ready()).rejects.toThrow(/Unable to load package numpy/u);

    const rows = runtime.startupDiagnostics();
    const value = (label: string): string => rows.find((r) => r.label === label)?.value ?? "";
    expect(value("Этап")).toBe("среда Python не запустилась");
    expect(value("Причина")).toContain("Unable to load package numpy");
    expect(value("Ресурс")).toContain("numpy-2.4.6-cp314.whl");
    expect(value("Пакеты Python")).toBe("https://localhost:47831/pyodide/");
  });

  it("classifies a worker that never loads apart from a runtime that never boots", async () => {
    const runtime = new WorkerSandboxRuntime({
      factory: () => {
        throw new Error("SecurityError: worker construction blocked");
      },
      bootTimeoutMs: 50,
    });
    await expect(runtime.ready()).rejects.toThrow(/SecurityError/u);
    expect(runtime.startupDiagnostics().find((r) => r.label === "Этап")?.value).toBe("не удалось создать фоновый поток");
  });

  it("gives up on a worker that never answers instead of hanging the turn", async () => {
    const runtime = new WorkerSandboxRuntime({ factory: () => fakeWorker(() => null), bootTimeoutMs: 20 });
    await expect(runtime.ready()).rejects.toThrow(/did not report ready/u);
    expect(runtime.startupDiagnostics().find((r) => r.label === "Этап")?.value).toBe("запуск не завершился за отведённое время");
  });

  it("finds the asset in a message whatever shape it takes", () => {
    expect(assetHint("404 for https://localhost:47831/pyodide/pandas-3.0.2.whl")).toBe("https://localhost:47831/pyodide/pandas-3.0.2.whl");
    expect(assetHint("could not read python_stdlib.zip")).toBe("python_stdlib.zip");
    expect(assetHint("something went wrong")).toBeNull();
  });

  it("says the sandbox did not start, and carries the diagnostics to the pane", () => {
    const diagnostics = startupDiagnosticsOf(
      { stage: "runtime_boot", message: "Failed to fetch numpy.whl", asset: "numpy.whl" },
      undefined,
    );
    const step = progressStepFor({ kind: "sandbox_unavailable", reason: "boot failed", diagnostics }, "ru");
    expect(step && step.kind === "step" ? step.title : "").toBe("Python-песочница не запустилась");
    expect(step && step.kind === "step" ? step.diagnostics?.map((d) => d.label) : []).toEqual(["Этап", "Причина", "Ресурс"]);
  });
});

describe("Stage 27.7 §3 — a simple deterministic request does not replan for nothing", () => {
  it("ends the turn on the call the planner itself marked final", async () => {
    let rounds = 0;
    const script: Script = () => {
      rounds += 1;
      return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { periodIntent: { kind: "latest_vs_previous" } }, final: true });
    };
    const turn = await runTurn(fixtureOperations(), "Как изменились показатели относительно предыдущего периода?", script);
    expect(turn.kind).toBe("answered");
    expect(rounds).toBe(1);
    expect(turn.timings.plannerRounds).toBe(1);
    expect(turn.timings.llmCallCount).toBe(1);
  });

  it("costs one planner round more without the flag, for the same work", async () => {
    let rounds = 0;
    const script: Script = (m) => {
      rounds += 1;
      const prompt = lastUser(m);
      const id = idOf(prompt, "change.compare_periods");
      if (!id) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { periodIntent: { kind: "latest_vs_previous" } } });
      return JSON.stringify({ kind: "complete", primaryResultRef: id, supportingResultRefs: [] });
    };
    const turn = await runTurn(fixtureOperations(), "Как изменились показатели относительно предыдущего периода?", script);
    expect(turn.kind).toBe("answered");
    expect(rounds).toBe(2);
    expect(turn.timings.plannerRounds).toBe(2);
  });

  it("refuses a final call when the plan still owes several bound outputs", async () => {
    const seen: string[] = [];
    let declared = false;
    const script: Script = (m) => {
      const prompt = lastUser(m);
      seen.push(prompt);
      if (!declared) {
        declared = true;
        return JSON.stringify({ kind: "plan", outputs: ["изменение", "самый сильный"], primaryOutputId: "o2" });
      }
      const id = idOf(prompt, "change.compare_periods");
      if (!id) return JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { periodIntent: { kind: "latest_vs_previous" } }, final: true });
      return JSON.stringify({
        kind: "complete",
        primaryResultRef: id,
        supportingResultRefs: [],
        outputBindings: [
          { outputId: "o1", resultRef: id },
          { outputId: "o2", resultRef: id },
        ],
      });
    };
    const turn = await runTurn(fixtureOperations(), "Как изменились показатели и какой сильнее всего?", script);
    expect(turn.kind).toBe("answered");
    expect(seen.at(-1)).toContain("you declared 2 outputs");
  });

  it("accepts the flag as protocol and rejects a non-boolean", () => {
    const ok = parsePlannerDecision(JSON.stringify({ kind: "tool_call", tool: "metric.list", arguments: {}, final: true }));
    expect(ok.ok && ok.decision.kind === "tool_call" ? ok.decision.final : undefined).toBe(true);
    const bad = parsePlannerDecision(JSON.stringify({ kind: "tool_call", tool: "metric.list", arguments: {}, final: "yes" }));
    expect(bad.ok).toBe(false);
  });
});

describe("Stage 27.7 §9 — latest versus immediately previous, without a discovery call", () => {
  it("compares the last two periods when neither endpoint is named", () => {
    const table = fixtureOperations();
    const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 5000 });
    const env = buildToolEnv(table.schema, table.grids, store, EMPTY_ANALYTICAL_STATE);
    const spec = findTool("change.compare_periods");
    const outcome = spec!.run({ periodIntent: { kind: "latest_vs_previous" } }, env);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const points = [...env.periodIndex.points].sort((a, b) => a.orderKey - b.orderKey);
    expect(outcome.result.periodCanonicals).toEqual([points[points.length - 2]!.canonical, points[points.length - 1]!.canonical]);
  });

  it("compares against the period immediately before a named end", () => {
    const table = fixtureOperations();
    const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 5000 });
    const env = buildToolEnv(table.schema, table.grids, store, EMPTY_ANALYTICAL_STATE);
    const points = [...env.periodIndex.points].sort((a, b) => a.orderKey - b.orderKey);
    const outcome = findTool("change.compare_periods")!.run({ periodIntent: { kind: "named_pair", start: points[1]!.canonical, end: points[2]!.canonical } }, env);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.periodCanonicals).toEqual([points[1]!.canonical, points[2]!.canonical]);
  });

  it("refuses rather than inventing a period before the first one", () => {
    const table = fixtureOperations();
    const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 5000 });
    const env = buildToolEnv(table.schema, table.grids, store, EMPTY_ANALYTICAL_STATE);
    const points = [...env.periodIndex.points].sort((a, b) => a.orderKey - b.orderKey);
    const outcome = findTool("change.compare_periods")!.run({ periodIntent: { kind: "latest_vs_previous" }, endPeriod: points[0]!.canonical }, env);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toMatch(/endpoints require periodIntent/u);
  });
});

const changeFinding = (over: Partial<VerifiedFinding> = {}): VerifiedFinding =>
  ({
    id: "f1",
    findingType: "change",
    subject: "Активы",
    subjectRef: { kind: "metric", key: "Активы" },
    direction: "up",
    values: [
      { name: "startValue", value: 19764.3, unit: { kind: "amount" }, text: "19 764,3", at: "01.11.2025" },
      { name: "endValue", value: 19871.5, unit: { kind: "amount" }, text: "19 871,5", at: "01.12.2025" },
      { name: "percentageChange", value: 0.54, unit: { kind: "percent" }, text: "+0,54%" },
      { name: "absoluteChange", value: 107.26, unit: { kind: "amount" }, text: "+107,26" },
    ],
    materiality: [],
    caveats: [],
    provenance: { resultRef: "result_1" },
    statement: "",
    ...over,
  }) as unknown as VerifiedFinding;

describe("Stage 27.7 §5 — an ordinary change reads like a sentence", () => {
  it("leads with the move, gives the absolute, and names both dates", () => {
    const finding = changeFinding();
    const text = statementFor(finding, "ru", { expand: true });
    expect(text).toContain("Рост «Активы» составил 0,54%: с 19 764,3 до 19 871,5.");
    expect(text).toContain("В абсолютном выражении изменение составило +107,26.");
    expect(text).toContain("Период сравнения — с 01.11.2025 по 01.12.2025.");
    expect(text.split(/[.!?]\s/u).length).toBeLessThanOrEqual(4);
  });

  it("never writes the old colon-list shape", () => {
    expect(statementFor(changeFinding(), "ru")).not.toMatch(/^«Активы»: рост/u);
  });

  it("keeps a falling metric grammatical", () => {
    const text = statementFor(changeFinding({ direction: "down" } as Partial<VerifiedFinding>), "ru");
    expect(text).toContain("Снижение «Активы» составило");
  });

  it("states a period shared by several findings once, not once per finding", () => {
    const a = changeFinding();
    const b = changeFinding({ id: "f2", subject: "Обязательства" } as Partial<VerifiedFinding>);
    const withStatements = [a, b].map((f) => ({ ...f, statement: statementFor(f, "ru") }) as VerifiedFinding);
    const parts = composeStatements(withStatements, "ru");
    const spans = parts.filter((p) => p.startsWith("Период сравнения"));
    expect(spans).toHaveLength(1);
    expect(parts.at(-1)).toBe("Период сравнения — с 01.11.2025 по 01.12.2025.");
  });
});

const volatility = (over: Partial<VerifiedFinding> = {}): VerifiedFinding =>
  ({
    id: "v1",
    findingType: "volatility",
    subject: "- обратное РЕПО",
    subjectRef: { kind: "metric", key: "- обратное РЕПО" },
    direction: "flat",
    values: [{ name: "score", value: 5.2, unit: { kind: "count" }, text: "5,2" }],
    materiality: [{ kind: "rank", position: 1, of: 12 }],
    caveats: [],
    provenance: { resultRef: "result_1" },
    statement: "",
    ...over,
  }) as unknown as VerifiedFinding;

describe("Stage 27.7 §7 — a volatility answer explains itself and names the subject once", () => {
  it("says which indicator won, then what the score means", () => {
    const text = statementFor(volatility(), "ru");
    expect(text).toContain("Самый волатильный показатель — «- обратное РЕПО».");
    expect(text).toContain("оценка волатильности — 5,2");
    expect(text).toContain("максимальное значение среди сравниваемых показателей");
  });

  it("names the indicator exactly once", () => {
    const text = statementFor(volatility(), "ru");
    expect(text.split("«- обратное РЕПО»").length - 1).toBe(1);
  });

  it("drops a finding that only repeats a subject another finding already explained", () => {
    const named = volatility({ statement: statementFor(volatility(), "ru") } as Partial<VerifiedFinding>);
    const bare = {
      ...volatility(),
      id: "e1",
      findingType: "extremum",
      values: [],
      materiality: [],
      statement: "Подходит «- обратное РЕПО».",
    } as unknown as VerifiedFinding;
    const parts = composeStatements([named, bare], "ru");
    expect(parts).toEqual([statementFor(volatility(), "ru")]);
  });
});

const analysisOf = (rows: readonly (readonly unknown[])[]): EngineAnalysis =>
  ({
    primary: {
      resultId: "result_1",
      tool: "change.compare_periods",
      type: "comparison",
      fields: [
        { name: "metric", kind: "metric" },
        { name: "percentageChange", kind: "number" },
      ],
      rows,
      metricKeys: ["Активы"],
      periodCanonicals: [],
      parents: [],
    },
    supporting: [],
    answerStyle: "concise",
  }) as unknown as EngineAnalysis;

describe("Stage 27.7 §8 — the deterministic renderer is preferred where it writes well", () => {
  it("takes an ordinary change without calling the model", () => {
    const finding = { ...changeFinding(), statement: statementFor(changeFinding(), "ru") } as VerifiedFinding;
    const plan = deterministicAnswerPlan({
      request: "На сколько выросли активы?",
      analysis: analysisOf([["Активы", 0.54]]),
      findings: [finding],
      locale: "ru",
    });
    expect(plan).not.toBeNull();
    expect(renderDeterministic({
      request: "На сколько выросли активы?",
      analysis: analysisOf([["Активы", 0.54]]),
      findings: [finding],
      locale: "ru",
    })).toContain("Рост «Активы» составил 0,54%");
  });

  it("leaves a sandbox analysis to the narrator", () => {
    const finding = { ...changeFinding(), statement: statementFor(changeFinding(), "ru") } as VerifiedFinding;
    const plan = deterministicAnswerPlan({
      request: "Проведи кластеризацию показателей по динамике.",
      analysis: analysisOf([["Активы", 0.54]]),
      findings: [finding],
      locale: "ru",
      method: { name: "kmeans" } as never,
    });
    expect(plan).toBeNull();
  });

  it("leaves a cluster finding to the narrator", () => {
    const cluster = {
      ...changeFinding(),
      findingType: "cluster",
      statement: "Группа 1 — 3: «А», «Б», «В».",
    } as unknown as VerifiedFinding;
    const plan = deterministicAnswerPlan({
      request: "Сгруппируй показатели.",
      analysis: analysisOf([["Активы", 0.54]]),
      findings: [cluster],
      locale: "ru",
    });
    expect(plan).toBeNull();
  });

  it("skips the narrator call entirely on a deterministic turn", async () => {
    let narrations = 0;
    const script: Script = () => JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { periodIntent: { kind: "latest_vs_previous" } }, final: true });
    const turn = await runAnalyticalEngine({
      turnId: "turn_det",
      request: "Как изменились показатели относительно предыдущего периода?",
      schema: fixtureOperations().schema,
      grids: fixtureOperations().grids,
      language: "ru",
      state: EMPTY_ANALYTICAL_STATE,
      decide: (messages) => script(messages),
      narrate: async () => {
        narrations += 1;
        return "какой-то текст";
      },
    });
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(narrations).toBe(0);
    expect(turn.usedFallback).toBe(false);
    expect(turn.trace.narratorStatus).toBe("deterministic");
    expect(turn.timings.narrationMs).toBe(0);
  });
});

describe("Stage 27.7 §4/§11 — the turn reports what it spent", () => {
  it("counts planner rounds apart from LLM calls", () => {
    const rows = executionMetrics({ ...EMPTY_TIMINGS, plannerRounds: 2, llmCallCount: 3, toolCallCount: 4, pythonExecutionCount: 1, sandboxMs: 1200 }, "ru");
    expect(rows).toContain("Раундов планировщика: 2");
    expect(rows).toContain("Обращений к модели: 3");
    expect(rows).toContain("Вызовов инструментов: 4");
    expect(rows).toContain("Запусков Python: 1");
    expect(rows).toContain("Python: 1,2 с");
  });

  it("omits the Python rows when no code ran", () => {
    const rows = executionMetrics(EMPTY_TIMINGS, "ru");
    expect(rows.some((r) => r.startsWith("Python:"))).toBe(false);
    expect(rows).toContain("Запусков Python: 0");
  });

  it("labels a stopped turn differently from a finished one", () => {
    expect(stoppedLabel("12,8 с", "ru")).toBe("Остановлено через 12,8 с");
    expect(pythonSummaryLabel(2, "ru")).toBe("Python · 2 запуска");
    expect(pythonSummaryLabel(1, "ru")).toBe("Python · 1 запуск");
    expect(pythonSummaryLabel(5, "en")).toBe("Python · 5 runs");
  });
});

describe("Stage 27.7 §9/§10 — the answer says which two periods it compared", () => {
  it("names both dates for a single-metric change", async () => {
    const turn = await runTurn(fixtureOperations(), "На сколько выросла Throughput index?", () =>
      JSON.stringify({ kind: "tool_call", tool: "change.compute", arguments: { metric: "Throughput index", periodIntent: { kind: "latest_vs_previous" } }, final: true }),
    );
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.body).toMatch(/Период сравнения — с .+ по .+\./u);
    expect(turn.body).toContain("Рост «Throughput index» составил");
  });

  it("names the shared period once for a multi-metric comparison", async () => {
    const turn = await runTurn(fixtureOperations(), "Как изменились показатели?", () =>
      JSON.stringify({ kind: "tool_call", tool: "change.compare_periods", arguments: { periodIntent: { kind: "latest_vs_previous" } }, final: true }),
    );
    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.body.match(/Период сравнения/gu)).toHaveLength(1);
    expect(turn.body.trimEnd().endsWith(".")).toBe(true);
  });
});

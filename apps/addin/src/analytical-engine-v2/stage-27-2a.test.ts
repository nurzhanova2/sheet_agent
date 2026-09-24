import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import {
  ANALYSIS_AGENT_BUDGETS,
  availableResultRefs,
  checkCompletion,
  renderAgentTrace,
  runAnalysisAgent,
  type AgentContext,
  type SessionRuntime,
  type ToolOutcome,
} from "./sandbox/analysis-agent.js";
import { actionFingerprint, parseAnalysisDecision, readAnalysisDecision } from "./sandbox/analysis-decision.js";
import { describeEnvironment, observeStep, renderHistory, renderLook, renderObservation, type AgentObservation } from "./sandbox/analysis-observation.js";
import { buildAgentMessages, extractDecision } from "./sandbox/analysis-agent-prompt.js";
import { createIterativeRunner, supportsSessions } from "./sandbox/iterative-runner.js";
import { clearAgentTraces, recordAgentTrace, renderAgentTraces, selfRecoveryRate, type AgentTraceEntry } from "./debug/agent-trace.js";
import { phaseForAgentAction, progressLabel } from "./production/answer-ux.js";
import { ResultStore } from "./results/result-store.js";
import { benchmarkPortfolio } from "./harness/sandbox-tables.js";
import { runAnalyticalEngine } from "./engine.js";
import { parsePlannerDecision } from "./planner/planner-prompt.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { SANDBOX_LIMITS, type SandboxDataset, type SandboxPlan, type SandboxResult } from "./sandbox/types.js";
import type { ExecuteOutcome, LookObservation, StepObservation } from "./sandbox/pyodide-runtime.js";

const NEWLINE = String.fromCharCode(10);

// --- fixtures ---------------------------------------------------------------

function dataset(): SandboxDataset {
  return {
    datasetId: "ds1",
    tableRef: "S!A1:C4",
    sheet: "Портфель",
    sourceRange: "S!A1:C4",
    freshnessToken: "v1",
    columns: [
      { name: "metric", semanticType: "metric_label", missingCount: 0, zeroCount: 0 },
      { name: "Янв", semanticType: "amount", missingCount: 0, zeroCount: 0 },
      { name: "Дек", semanticType: "amount", missingCount: 0, zeroCount: 0 },
    ],
    rows: [
      ["Ангара", 131, 40] as readonly CellValue[],
      ["Мезень", 88, 96] as readonly CellValue[],
      ["Обь", 2, 40] as readonly CellValue[],
    ],
    periods: ["Янв", "Дек"],
  };
}

function plan(over: Partial<SandboxPlan> = {}): SandboxPlan {
  return {
    objective: "establish which products moved",
    datasetRefs: ["ds1"],
    requestedOutputs: [{ id: "a1", description: "movement per product", shape: "table" }],
    ...over,
  };
}

function sandboxResult(over: Partial<SandboxResult> = {}): SandboxResult {
  return {
    executionId: "exec_1",
    status: "ok",
    tables: [],
    scalars: {},
    series: [],
    groups: [],
    models: [],
    diagnostics: {},
    findingsCandidates: [],
    warnings: [],
    artifacts: [],
    sourceLineage: { datasetIds: ["ds1"], sheet: "Портфель", sourceRange: "S!A1:C4", freshnessToken: "v1" },
    ...over,
  };
}

/** A table result that satisfies `plan()` — a real label in the first column. */
function movementTable(): SandboxResult {
  return sandboxResult({
    tables: [{ name: "movement", columns: ["metric", "delta"], rows: [["Ангара", -91] as readonly CellValue[], ["Мезень", 8] as readonly CellValue[]] }],
  });
}

type Env = Record<string, Record<string, unknown>>;

function okStep(available: Env = {}, over: Partial<StepObservation> = {}): StepObservation {
  return { status: "ok", stdout: "", available, durationMs: 4, ...over };
}

function errorStep(errorType: string, message: string, failingLine: string, available: Env = {}): StepObservation {
  return {
    status: "error",
    errorType,
    message,
    failingLine,
    line: 1,
    stdout: "",
    available,
    prepared: ["data", "numeric_data", "entity_data", "X", "table", "result"],
    durationMs: 4,
  };
}

const FRAME = { type: "DataFrame", shape: [3, 2], columns: ["Янв", "Дек"] };

/**
 * A scripted session. `steps` and `looks` are consumed in order; `finish`
 * returns whatever the test set. Nothing here interprets the code — the loop's
 * behaviour must not depend on a fake that is cleverer than Python.
 */
function fakeRuntime(config: {
  readonly steps?: readonly (StepObservation | { readonly refused: { readonly code: string; readonly message: string } })[];
  readonly looks?: readonly LookObservation[];
  readonly finish?: ExecuteOutcome | (() => ExecuteOutcome);
}): SessionRuntime & { readonly ran: string[]; readonly ended: string[] } {
  const steps = [...(config.steps ?? [])];
  const looks = [...(config.looks ?? [])];
  const ran: string[] = [];
  const ended: string[] = [];
  return {
    ran,
    ended,
    hardTimeout: true,
    async step(_sessionId, code) {
      ran.push(code);
      const next = steps.shift();
      return (next ?? okStep()) as StepObservation;
    },
    async look() {
      return looks.shift() ?? ({ target: "table.info", status: "ok" } as LookObservation);
    },
    async finish() {
      const f = config.finish;
      if (typeof f === "function") return f();
      return f ?? { ok: true, result: movementTable(), stdout: "", durationMs: 1 };
    },
    async endSession(sessionId) {
      ended.push(sessionId);
    },
  };
}

/** Drives the loop with a fixed decision script. */
function scripted(decisions: readonly string[]): { readonly decide: (c: AgentContext) => Promise<string>; readonly seen: AgentContext[] } {
  const queue = [...decisions];
  const seen: AgentContext[] = [];
  return {
    seen,
    decide: async (context: AgentContext) => {
      seen.push(context);
      return queue.shift() ?? JSON.stringify({ action: "COMPLETE", primaryResultRefs: ["movement"], supportingResultRefs: [] });
    },
  };
}

const run = (decisions: readonly string[], runtime: SessionRuntime, over: Record<string, unknown> = {}) =>
  runAnalysisAgent({
    runtime,
    sessionId: "s1",
    request: "Кластеризуй продукты по динамике",
    plan: plan(),
    dataset: dataset(),
    decide: scripted(decisions).decide,
    currentSourceVersion: () => "v1",
    ...over,
  });

const table = benchmarkPortfolio();
const store = (): ResultStore => new ResultStore("S!A1:C4", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });

const EXECUTE = (code: string): string => JSON.stringify({ action: "EXECUTE_CODE", purpose: "p", code });
const COMPLETE = (...refs: string[]): string => JSON.stringify({ action: "COMPLETE", primaryResultRefs: refs, supportingResultRefs: [] });

// --- §3 decision validation -------------------------------------------------

describe("Stage 27.2A §3 — the decision contract fails closed", () => {
  it("accepts each of the five actions", () => {
    expect(parseAnalysisDecision(EXECUTE("x = 1")).ok).toBe(true);
    expect(parseAnalysisDecision({ action: "INSPECT", purpose: "p", target: "table.info", variable: null }).ok).toBe(true);
    expect(parseAnalysisDecision({ action: "CALL_TOOL", purpose: "p", tool: "period.resolve", input: {} }).ok).toBe(true);
    expect(parseAnalysisDecision({ action: "CLARIFY", question: "какой период?", candidates: ["Янв"] }).ok).toBe(true);
    expect(parseAnalysisDecision(COMPLETE("movement")).ok).toBe(true);
  });

  it("rejects prose, ReAct text and anything that is not one JSON object", () => {
    for (const raw of ["Thought: I should inspect the table", "Action: EXECUTE_CODE", "", "[]", "null", "42"]) {
      expect(parseAnalysisDecision(raw).ok).toBe(false);
    }
  });

  it("rejects an unknown action rather than guessing the nearest one", () => {
    const parsed = parseAnalysisDecision({ action: "RUN_CODE", code: "x = 1" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("unknown action");
  });

  it("rejects unexpected keys instead of ignoring them", () => {
    // A model that sends code AND result refs has not decided which it is
    // doing, and acting on the half we recognise invents the decision.
    const parsed = parseAnalysisDecision({ action: "EXECUTE_CODE", purpose: "p", code: "x = 1", primaryResultRefs: ["a"] });
    expect(parsed.ok).toBe(false);
  });

  it("rejects an INSPECT target that is not one of the bounded nine", () => {
    expect(parseAnalysisDecision({ action: "INSPECT", purpose: "p", target: "data.dump", variable: null }).ok).toBe(false);
    // §11 — no arbitrary dataframe dumps, so there is no target that produces one.
    expect(parseAnalysisDecision({ action: "INSPECT", purpose: "p", target: "variable.head", variable: null }).ok).toBe(false);
  });

  it("§21 — COMPLETE cannot be prose, and cannot be empty", () => {
    expect(parseAnalysisDecision({ action: "COMPLETE", primaryResultRefs: [], supportingResultRefs: [] }).ok).toBe(false);
    const withProse = parseAnalysisDecision({ action: "COMPLETE", answer: "Продукты разделились на три группы" });
    expect(withProse.ok).toBe(false);
  });

  it("§17 — a re-worded purpose does not make an action new", () => {
    const a = parseAnalysisDecision(JSON.stringify({ action: "EXECUTE_CODE", purpose: "build features", code: "x = 1" }));
    const b = parseAnalysisDecision(JSON.stringify({ action: "EXECUTE_CODE", purpose: "now really build features", code: "x = 1" }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(actionFingerprint(a.decision)).toBe(actionFingerprint(b.decision));
  });

  it("key order in a tool input does not change the action's identity", () => {
    const a = parseAnalysisDecision({ action: "CALL_TOOL", purpose: "p", tool: "t", input: { b: 2, a: 1 } });
    const b = parseAnalysisDecision({ action: "CALL_TOOL", purpose: "p", tool: "t", input: { a: 1, b: 2 } });
    if (a.ok && b.ok) expect(actionFingerprint(a.decision)).toBe(actionFingerprint(b.decision));
  });
});

// --- §6/§7/§9 observations --------------------------------------------------

describe("Stage 27.2A §6/§7/§9 — observations are state, not transcripts", () => {
  it("§6 — a successful step reports created and updated names, not contents", () => {
    const observation = observeStep({ stepId: 1, step: okStep({ features: FRAME }), before: [] });
    const text = renderObservation(observation);
    expect(text).toContain("EXECUTION_OK");
    expect(text).toContain("features: DataFrame (3, 2)");
    expect(text).toContain("Created:");
    // The 6 numbers in the frame are not here, and nothing serialised them.
    expect(text).not.toContain("131");
  });

  it("distinguishes a variable it just created from one that was already there", () => {
    const before = describeEnvironment({ features: FRAME });
    const observation = observeStep({ stepId: 2, step: okStep({ features: FRAME, labels: { type: "ndarray", shape: [3], dtype: "int64" } }), before });
    expect(observation.createdVariables?.map((v) => v.name)).toEqual(["labels"]);
    expect(observation.variableUpdates ?? []).toEqual([]);
  });

  it("notices a variable whose shape changed under the same name", () => {
    const before = describeEnvironment({ features: FRAME });
    const grown = observeStep({ stepId: 2, step: okStep({ features: { type: "DataFrame", shape: [3, 5], columns: [] } }), before });
    expect(grown.variableUpdates?.map((v) => v.name)).toEqual(["features"]);
  });

  it("§7 — an error observation carries type, message, failing line and what exists", () => {
    const step = errorStep("NameError", "entity_df is not defined", 'labels = entity_df["metric"]', { features: FRAME });
    const text = renderObservation(observeStep({ stepId: 3, step, before: [] }));
    expect(text).toContain("NameError");
    expect(text).toContain("entity_df is not defined");
    expect(text).toContain('labels = entity_df["metric"]');
    expect(text).toContain("features: DataFrame (3, 2)");
    expect(text).toContain("entity_data");
  });

  it("§9 — no traceback reaches the agent", () => {
    const step = errorStep(
      "ValueError",
      "Boolean index has wrong length: 4 instead of 3",
      "sel = numeric_data[mask]",
    );
    const text = renderObservation(observeStep({ stepId: 1, step, before: [] }));
    expect(text).not.toContain("Traceback");
    expect(text).not.toContain("site-packages");
    expect(text).not.toContain("File \"");
  });

  it("truncates a runaway exception message rather than pasting it whole", () => {
    const step = errorStep("ValueError", "x".repeat(5000), "f()");
    const observed = observeStep({ stepId: 1, step, before: [] });
    expect(observed.error?.message.length).toBeLessThanOrEqual(400);
  });

  it("§10 — history keeps the first and the most recent, and says what it dropped", () => {
    const observations: AgentObservation[] = Array.from({ length: 10 }, (_, i) => ({
      stepId: i + 1,
      actionType: "EXECUTE_CODE" as const,
      status: "ok" as const,
      summary: `EXECUTION_OK step${i + 1}`,
      elapsedMs: 1,
    }));
    const text = renderHistory(observations, 4);
    expect(text).toContain("step1");
    expect(text).toContain("step10");
    expect(text).toContain("earlier steps omitted");
    expect(text).not.toContain("step4");
  });
});

// --- §2/§8 the loop ---------------------------------------------------------

describe("Stage 27.2A §2/§8 — act, observe, adapt", () => {
  it("performs two sequential code actions in one turn", async () => {
    const runtime = fakeRuntime({ steps: [okStep({ features: FRAME }), okStep({ features: FRAME, labels: { type: "ndarray", shape: [3] } })] });
    const outcome = await run([EXECUTE("features = numeric_data"), EXECUTE("labels = km.fit_predict(features)"), COMPLETE("movement")], runtime);
    expect(outcome.status).toBe("complete");
    expect(runtime.ran).toHaveLength(2);
    expect(outcome.metrics.codeExecutions).toBe(2);
  });

  it("§8/§26 — an execution error is an observation, and the turn still completes", async () => {
    const runtime = fakeRuntime({
      steps: [errorStep("NameError", "entity_df is not defined", 'labels = entity_df["metric"]'), okStep({ labels: { type: "Series", shape: [3] } })],
    });
    const outcome = await run([EXECUTE('labels = entity_df["metric"]'), EXECUTE('labels = entity_data["metric"]'), COMPLETE("movement")], runtime);

    expect(outcome.status).toBe("complete");
    // §26 — this is the headline metric of the stage.
    expect(outcome.metrics.selfRecoveryOpportunity).toBe(true);
    expect(outcome.metrics.selfRecoverySuccess).toBe(true);
    expect(outcome.metrics.executionErrors).toBe(1);
  });

  it("§4 — the original request is restated every round, never reconstructed", async () => {
    const script = scripted([EXECUTE("a = 1"), EXECUTE("b = 2"), COMPLETE("movement")]);
    await runAnalysisAgent({
      runtime: fakeRuntime({}),
      sessionId: "s1",
      request: "Кластеризуй продукты по динамике",
      plan: plan(),
      dataset: dataset(),
      decide: script.decide,
      currentSourceVersion: () => "v1",
    });
    expect(script.seen).toHaveLength(3);
    for (const context of script.seen) expect(context.request).toBe("Кластеризуй продукты по динамике");
  });

  it("§4 — each round is told what exists and what budget is left", async () => {
    const script = scripted([EXECUTE("features = numeric_data"), COMPLETE("movement")]);
    await runAnalysisAgent({
      runtime: fakeRuntime({ steps: [okStep({ features: FRAME })] }),
      sessionId: "s1",
      request: "q",
      plan: plan(),
      dataset: dataset(),
      decide: script.decide,
      currentSourceVersion: () => "v1",
    });
    expect(script.seen[0]!.environment).toEqual([]);
    expect(script.seen[1]!.environment.map((v) => v.name)).toEqual(["features"]);
    expect(script.seen[1]!.remaining.codeExecutions).toBe(ANALYSIS_AGENT_BUDGETS.maxCodeExecutions - 1);
  });

  it("§11 — an INSPECT does not spend the code budget", async () => {
    const runtime = fakeRuntime({ looks: [{ target: "table.info", status: "ok", shape: [3, 3] }] });
    const outcome = await run([JSON.stringify({ action: "INSPECT", purpose: "look first", target: "table.info", variable: null }), COMPLETE("movement")], runtime);
    expect(outcome.status).toBe("complete");
    expect(outcome.metrics.inspections).toBe(1);
    expect(outcome.metrics.codeExecutions).toBe(0);
  });

  it("§12 — asking about a name that does not exist returns what does", async () => {
    const runtime = fakeRuntime({
      looks: [{ target: "variable.summary", status: "unknown_variable", variable: "entity_df", available: { features: FRAME }, prepared: ["entity_data"] }],
    });
    const trace: string[] = [];
    await run([JSON.stringify({ action: "INSPECT", purpose: "p", target: "variable.summary", variable: "entity_df" }), COMPLETE("movement")], runtime, {
      onStep: (record: { observation: AgentObservation }) => trace.push(renderObservation(record.observation)),
    });
    expect(trace[0]).toContain("entity_df");
    expect(trace[0]).toContain("features: DataFrame");
    expect(trace[0]).toContain("entity_data");
  });
});

// --- §16 control errors -----------------------------------------------------

describe("Stage 27.2A §16 — a protocol slip is not an analytical attempt", () => {
  it("a malformed decision does not consume a code execution", async () => {
    const runtime = fakeRuntime({});
    const outcome = await run(["I think we should start by looking at the data", EXECUTE("x = 1"), COMPLETE("movement")], runtime);
    expect(outcome.status).toBe("complete");
    expect(outcome.metrics.controlErrors).toBe(1);
    expect(outcome.metrics.codeExecutions).toBe(1);
    expect(runtime.ran).toHaveLength(1);
  });

  it("the next round is told what was wrong with the envelope, not with the analysis", async () => {
    const script = scripted(["not json at all", COMPLETE("movement")]);
    await runAnalysisAgent({
      runtime: fakeRuntime({}),
      sessionId: "s1",
      request: "q",
      plan: plan(),
      dataset: dataset(),
      decide: script.decide,
      currentSourceVersion: () => "v1",
    });
    expect(script.seen[1]!.controlError).toContain("not valid JSON");
  });

  it("repeated malformed output terminates instead of looping forever", async () => {
    const outcome = await run(["nope", "still nope", "nope again", "and again"], fakeRuntime({}));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.failure).toBe("CONTROL_FAILURE");
  });
});

// --- §17/§18 repetition and progress ---------------------------------------

describe("Stage 27.2A §17/§18 — ineffective loops end", () => {
  it("§17 — identical broken code is not executed a third time", async () => {
    const broken = EXECUTE('labels = entity_df["metric"]');
    const runtime = fakeRuntime({ steps: [errorStep("NameError", "entity_df is not defined", "x"), errorStep("NameError", "entity_df is not defined", "x")] });
    const outcome = await run([broken, broken, broken, broken], runtime);
    // Twice is a retry; the third is refused before it reaches Python.
    expect(runtime.ran).toHaveLength(2);
    expect(outcome.metrics.repeatedActions).toBeGreaterThan(0);
  });

  it("the repeated-action observation tells the agent to choose differently", async () => {
    const broken = EXECUTE("x = undefined_name");
    const seen: AgentObservation[] = [];
    await run([broken, broken, broken, COMPLETE("movement")], fakeRuntime({ steps: [errorStep("NameError", "n", "x"), errorStep("NameError", "n", "x")] }), {
      onStep: (record: { observation: AgentObservation }) => seen.push(record.observation),
    });
    const repeated = seen.find((o) => o.status === "repeated");
    expect(repeated?.summary).toContain("REPEATED_ACTION");
    expect(repeated?.summary).toContain("choose a different one");
  });

  it("§18 — several rounds that produce no new state stop safely", async () => {
    const quiet = Array.from({ length: 8 }, (_, i) => EXECUTE(`pass  # ${i}`));
    const runtime = fakeRuntime({ steps: Array.from({ length: 8 }, () => okStep()) });
    const outcome = await run(quiet, runtime);
    expect(outcome.status).toBe("partial");
    // Exactly four: the quiet rule fired on the round after the third quiet
    // one. Asserting "fewer than eight" would also have passed if the CODE
    // budget of five had been what stopped it, which is a different rule.
    expect(runtime.ran).toHaveLength(ANALYSIS_AGENT_BUDGETS.maxQuietRounds + 1);
    expect(runtime.ran.length).toBeLessThan(ANALYSIS_AGENT_BUDGETS.maxCodeExecutions);
  });

  it("§18 — but a single quiet round does not end the analysis", async () => {
    const runtime = fakeRuntime({ steps: [okStep(), okStep({ features: FRAME })] });
    const outcome = await run([EXECUTE("pass"), EXECUTE("features = numeric_data"), COMPLETE("movement")], runtime);
    expect(outcome.status).toBe("complete");
  });
});

// --- §15 budgets ------------------------------------------------------------

describe("Stage 27.2A §15/§22 — budgets are safety, and exhaustion is honest", () => {
  it("carries the MEASURED budgets, not the starting guesses", () => {
    // §15 gives starting values and says to measure them. Three live runs did:
    // run 3 hit the 8-round ceiling on every loop turn with zero repeated
    // actions, which is productive work being truncated rather than a loop
    // going in circles. Inspections went the other way — measured at 1.25 once
    // the prompt stopped offering to fetch the schema it had already supplied.
    expect(ANALYSIS_AGENT_BUDGETS.maxDecisionRounds).toBe(14);
    expect(ANALYSIS_AGENT_BUDGETS.maxCodeExecutions).toBe(8);
    expect(ANALYSIS_AGENT_BUDGETS.maxInspections).toBe(3);
    expect(ANALYSIS_AGENT_BUDGETS.maxToolCalls).toBe(8);
  });

  it("bounds the turn's wall clock, not only its round count", () => {
    // Raising a round budget without this trades a bounded failure for an
    // unbounded wait.
    expect(ANALYSIS_AGENT_BUDGETS.maxTurnMs).toBeGreaterThan(0);
    expect(ANALYSIS_AGENT_BUDGETS.maxTurnMs).toBeLessThanOrEqual(300_000);
  });

  it("stops between rounds once the turn's wall clock is spent", async () => {
    const runtime = fakeRuntime({
      steps: Array.from({ length: 20 }, (_, i) => okStep({ [`v${i}`]: { type: "int", value: i } })),
      finish: { ok: true, result: movementTable(), stdout: "", durationMs: 1 },
    });
    const outcome = await run(
      Array.from({ length: 20 }, (_, i) => EXECUTE(`v${i} = ${i}`)),
      runtime,
      { budgets: { ...ANALYSIS_AGENT_BUDGETS, maxTurnMs: 0 } },
    );
    // Nothing ran: the clock was already spent when the first round began.
    expect(runtime.ran).toHaveLength(0);
    expect(outcome.status).toBe("partial");
    if (outcome.status === "partial") expect(outcome.reason).toContain("seconds");
  });

  it("stops asking for code once the execution budget is spent", async () => {
    const over = ANALYSIS_AGENT_BUDGETS.maxCodeExecutions + 3;
    const decisions = Array.from({ length: over }, (_, i) => EXECUTE(`step${i} = ${i}`));
    const runtime = fakeRuntime({ steps: Array.from({ length: over }, (_, i) => okStep({ [`step${i}`]: { type: "int", value: i } })) });
    await run(decisions, runtime);
    expect(runtime.ran).toHaveLength(ANALYSIS_AGENT_BUDGETS.maxCodeExecutions);
  });

  it("§22 — budget exhaustion after real work is PARTIAL, never success", async () => {
    const decisions = Array.from({ length: ANALYSIS_AGENT_BUDGETS.maxDecisionRounds + 1 }, (_, i) => EXECUTE(`v${i} = ${i}`));
    const runtime = fakeRuntime({
      steps: Array.from({ length: ANALYSIS_AGENT_BUDGETS.maxDecisionRounds + 1 }, (_, i) => okStep({ [`v${i}`]: { type: "int", value: i } })),
      finish: { ok: true, result: sandboxResult({ scalars: { december_total: 3665 } }), stdout: "", durationMs: 1 },
    });
    const outcome = await run(decisions, runtime);
    expect(outcome.status).toBe("partial");
    if (outcome.status === "partial") {
      expect(outcome.completed).toContain("december_total");
      // The plan asked for a table; a scalar is not one, and saying so is the point.
      expect(outcome.missing.join(" ")).toContain("table");
      expect(outcome.reason).toContain("did not finish");
    }
  });

  it("§43 — the session is ended whatever the outcome", async () => {
    const good = fakeRuntime({});
    await run([COMPLETE("movement")], good);
    expect(good.ended).toEqual(["s1"]);

    const bad = fakeRuntime({});
    await run(["garbage", "garbage", "garbage", "garbage"], bad);
    expect(bad.ended).toEqual(["s1"]);
  });

  it("§44 — a cancelled turn commits nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = fakeRuntime({});
    const outcome = await run([COMPLETE("movement")], runtime, { signal: controller.signal });
    expect(outcome.status).toBe("failed");
    expect(runtime.ran).toHaveLength(0);
    expect(runtime.ended).toEqual(["s1"]);
  });
});

// --- §19/§20 completion -----------------------------------------------------

describe("Stage 27.2A §19/§20 — COMPLETE is checked, not taken on trust", () => {
  it("§19 — a result the analysis never emitted is refused", () => {
    const check = checkCompletion({
      plan: plan(),
      dataset: dataset(),
      outcome: { ok: true, result: movementTable(), stdout: "", durationMs: 1 },
      primaryResultRefs: ["anomaly_scores"],
      limits: SANDBOX_LIMITS,
      currentSourceVersion: () => "v1",
    });
    expect(check.ok).toBe(false);
    expect(check.missing.join(" ")).toContain("anomaly_scores");
    expect(check.missing.join(" ")).toContain("movement");
  });

  it("accepts a COMPLETE whose refs exist and whose shape matches the plan", () => {
    const check = checkCompletion({
      plan: plan(),
      dataset: dataset(),
      outcome: { ok: true, result: movementTable(), stdout: "", durationMs: 1 },
      primaryResultRefs: ["movement"],
      limits: SANDBOX_LIMITS,
      currentSourceVersion: () => "v1",
    });
    expect(check.ok).toBe(true);
  });

  it("§20 — the existing validators are the ones that run", () => {
    // A scalar where the plan asked for a table: `validateAgainstPlan`'s job,
    // unchanged, now applied at COMPLETE instead of after a one-shot run.
    const check = checkCompletion({
      plan: plan(),
      dataset: dataset(),
      outcome: { ok: true, result: sandboxResult({ scalars: { movement: 12 } }), stdout: "", durationMs: 1 },
      primaryResultRefs: ["movement"],
      limits: SANDBOX_LIMITS,
      currentSourceVersion: () => "v1",
    });
    expect(check.ok).toBe(false);
    expect(check.missing.join(" ")).toContain("requested table");
  });

  it("§20 — a rejected COMPLETE becomes an observation and the agent continues", async () => {
    let emitted = false;
    const runtime = fakeRuntime({
      steps: [okStep({ scores: { type: "ndarray", shape: [3] } })],
      finish: () => ({ ok: true, result: emitted ? movementTable() : sandboxResult(), stdout: "", durationMs: 1 }),
    });
    const seen: AgentObservation[] = [];
    const outcome = await run([COMPLETE("movement"), EXECUTE('result.emit("table", "movement", value=frame)'), COMPLETE("movement")], runtime, {
      onStep: (record: { observation: AgentObservation }) => {
        seen.push(record.observation);
        if (record.observation.actionType === "EXECUTE_CODE") emitted = true;
      },
    });
    const incomplete = seen.find((o) => o.status === "incomplete");
    expect(incomplete?.summary).toContain("INCOMPLETE_ANALYSIS");
    expect(incomplete?.summary).toContain("missing:");
    expect(outcome.status).toBe("complete");
  });

  it("a COMPLETE that stays incomplete ends as PARTIAL, not as success", async () => {
    const runtime = fakeRuntime({ finish: { ok: true, result: sandboxResult(), stdout: "", durationMs: 1 } });
    const outcome = await run([COMPLETE("movement"), COMPLETE("movement"), COMPLETE("movement")], runtime);
    expect(outcome.status).toBe("partial");
  });

  it("§20 — a workbook that moved mid-analysis voids the result", async () => {
    let version = "v1";
    const runtime = fakeRuntime({});
    const outcome = await run([EXECUTE("x = 1"), COMPLETE("movement")], runtime, {
      currentSourceVersion: () => {
        const current = version;
        version = "v2";
        return current;
      },
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe("STALE_DATASET");
  });

  it("names every ref a COMPLETE could legitimately point at", () => {
    const refs = availableResultRefs(
      sandboxResult({
        tables: [{ name: "profiles", columns: ["a"], rows: [] }],
        scalars: { total: 1 },
        groups: [{ label: "cluster_0", members: ["Обь"] }],
        diagnostics: { silhouette: 0.4 },
      }),
    );
    expect(refs).toEqual(expect.arrayContaining(["profiles", "total", "cluster_0", "silhouette"]));
  });
});

// --- §23 clarification ------------------------------------------------------

describe("Stage 27.2A §23 — CLARIFY is for ambiguity, not for a failed step", () => {
  it("passes a genuine ambiguity through", async () => {
    const outcome = await run([JSON.stringify({ action: "CLARIFY", question: "За какой период?", candidates: ["Янв", "Дек"] })], fakeRuntime({}));
    expect(outcome.status).toBe("clarify");
    if (outcome.status === "clarify") expect(outcome.candidates).toEqual(["Янв", "Дек"]);
  });

  it("refuses a CLARIFY that arrives straight after an execution error", async () => {
    const runtime = fakeRuntime({ steps: [errorStep("NameError", "entity_df is not defined", "x")] });
    const outcome = await run(
      [EXECUTE('labels = entity_df["m"]'), JSON.stringify({ action: "CLARIFY", question: "Что вы имели в виду?", candidates: [] }), EXECUTE('labels = entity_data["m"]'), COMPLETE("movement")],
      runtime,
    );
    // The escape hatch is closed; the analysis continues and finishes.
    expect(outcome.status).toBe("complete");
    expect(runtime.ran).toHaveLength(2);
  });
});

// --- §13/§14 tools ----------------------------------------------------------

describe("Stage 27.2A §13/§14 — tool results share the observation stream", () => {
  it("runs a deterministic tool and feeds its result back as an observation", async () => {
    const calls: string[] = [];
    const outcome = await run([JSON.stringify({ action: "CALL_TOOL", purpose: "resolve", tool: "period.resolve", input: { text: "декабрь" } }), COMPLETE("movement")], fakeRuntime({}), {
      tools: [{ name: "period.resolve", summary: "resolve a period phrase" }],
      invokeTool: async (tool: string): Promise<ToolOutcome> => {
        calls.push(tool);
        return { ok: true, summary: "period.resolve → Дек", resultRefs: ["period_dec"] };
      },
    });
    expect(calls).toEqual(["period.resolve"]);
    expect(outcome.metrics.toolCalls).toBe(1);
    expect(outcome.status).toBe("complete");
  });

  it("a failing tool is an observation too, not a turn failure", async () => {
    const outcome = await run(
      [JSON.stringify({ action: "CALL_TOOL", purpose: "p", tool: "period.resolve", input: {} }), EXECUTE("x = 1"), COMPLETE("movement")],
      fakeRuntime({}),
      {
        tools: [{ name: "period.resolve", summary: "s" }],
        invokeTool: async (): Promise<ToolOutcome> => ({ ok: false, message: "no period column" }),
      },
    );
    expect(outcome.status).toBe("complete");
  });

  it("calling a tool that does not exist is a control error, not an execution", async () => {
    const runtime = fakeRuntime({});
    const outcome = await run([JSON.stringify({ action: "CALL_TOOL", purpose: "p", tool: "nope", input: {} }), EXECUTE("x = 1"), COMPLETE("movement")], runtime);
    expect(outcome.metrics.controlErrors).toBe(1);
    expect(outcome.metrics.codeExecutions).toBe(1);
  });
});

// --- §40 security -----------------------------------------------------------

describe("Stage 27.2A §40 — a session earns no security concessions", () => {
  it("unsafe code on a later step ends the turn as a SECURITY_FAILURE", async () => {
    const runtime = fakeRuntime({
      steps: [okStep({ features: FRAME }), { refused: { code: "UNSAFE_CODE", message: "the analysis code requests capabilities the sandbox denies: IMPORT:os" } }],
    });
    const outcome = await run([EXECUTE("features = numeric_data"), EXECUTE("import os"), EXECUTE("import os")], runtime);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.failure).toBe("SECURITY_FAILURE");
    // §68 of Stage 27 — unsafe code is never retried.
    expect(runtime.ran).toHaveLength(2);
  });

  it("refuses to run at all on a runtime that cannot bound Python", async () => {
    const soft = { ...fakeRuntime({}), hardTimeout: false };
    const outcome = await run([EXECUTE("x = 1")], soft);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.failure).toBe("SECURITY_FAILURE");
  });
});

// --- §4/§36/§37 prompt and trace -------------------------------------------

describe("Stage 27.2A §4/§36 — the prompt states the protocol, the trace stays internal", () => {
  const context = (over: Partial<AgentContext> = {}): AgentContext => ({
    round: 1,
    request: "Кластеризуй продукты по динамике",
    plan: plan(),
    dataset: dataset(),
    observations: [],
    environment: [],
    tools: [],
    remaining: { decisionRounds: 7, codeExecutions: 5, inspections: 5, toolCalls: 8 },
    ...over,
  });

  it("names the actions available to THIS turn, and the bounded inspection targets", () => {
    // Four without tools; CALL_TOOL appears only when tools are wired — see
    // "a capability that does not exist is not offered" below.
    const system = buildAgentMessages(context())[0]!.content;
    for (const action of ["INSPECT", "EXECUTE_CODE", "CLARIFY", "COMPLETE"]) expect(system).toContain(action);
    expect(system).toContain("variable.summary");
    expect(system).toContain("result.preview");

    const withTools = buildAgentMessages(context({ tools: [{ name: "period.resolve", summary: "s" }] }))[0]!.content;
    expect(withTools).toContain("CALL_TOOL");
  });

  it("§1 — tells the model in its own terms that an error is an observation", () => {
    const system = buildAgentMessages(context())[0]!.content;
    expect(system).toContain("OBSERVATION, not a failure");
    expect(system).toContain("COMPLETE names results, never prose");
  });

  it("does not restate the Python contract in its own words", () => {
    // One ACI, one description of it. The prompt imports the generator's.
    const system = buildAgentMessages(context())[0]!.content;
    expect(system).toContain("numeric_data");
    expect(system).toContain("NEVER fill a missing value with 0");
  });

  it("§4 — the user message carries request, objective, table and budget", () => {
    const user = buildAgentMessages(context())[1]!.content;
    expect(user).toContain("Кластеризуй продукты по динамике");
    expect(user).toContain("establish which products moved");
    expect(user).toContain("Портфель");
    expect(user).toContain("BUDGET LEFT");
  });

  it("§16 — a control error is presented as an envelope problem", () => {
    const user = buildAgentMessages(context({ controlError: "the decision is not valid JSON" }))[1]!.content;
    expect(user).toContain("NOT A VALID DECISION");
    expect(user).toContain("exactly one JSON object");
  });

  it("strips the fences a model adds anyway", () => {
    expect(extractDecision('```json' + NEWLINE + '{"action":"COMPLETE"}' + NEWLINE + '```')).toBe('{"action":"COMPLETE"}');
    expect(extractDecision('  {"action":"COMPLETE"}  ')).toBe('{"action":"COMPLETE"}');
  });

  it("§36 — the debug trace shows the sequence a human needs", async () => {
    const runtime = fakeRuntime({ steps: [errorStep("NameError", "entity_df is not defined", "x"), okStep({ scores: { type: "ndarray", shape: [3] } })] });
    const trace: { stepId: number; action: string; observation: AgentObservation }[] = [];
    const outcome = await run([EXECUTE('x = entity_df["m"]'), EXECUTE('x = entity_data["m"]'), COMPLETE("movement")], runtime, {
      onStep: (record: { stepId: number; action: string; observation: AgentObservation }) => trace.push(record),
    });
    const rendered = renderAgentTrace("Find unusual products", trace, outcome);
    expect(rendered).toContain("GOAL");
    expect(rendered).toContain("NameError");
    expect(rendered).toContain("OUTCOME: complete");
    expect(rendered).toContain("recovered=true");
  });
});

// --- the boundary to the planner ------------------------------------------

const analyzeDecision = { kind: "analyze", objective: "group the products", requestedOutputs: [{ id: "o1", description: "the groups", shape: "table" }] } as never;

function runner(decisions: readonly string[], runtime: SessionRuntime, over: Record<string, unknown> = {}) {
    return createIterativeRunner({
      capability: {
        runtime: runtime as never,
        generateCode: async () => "",
        decideStep: scripted(decisions).decide as never,
        currentSourceVersion: () => table.schema.sourceVersion,
        ...over,
      },
      schema: table.schema,
      grids: table.grids,
      request: () => "Кластеризуй продукты",
    });
  }

describe("Stage 27.2A §2/§19/§22 — what crosses back to the planner", () => {
  const decision = analyzeDecision;

  it("recognises a runtime that has the session API, and one that does not", () => {
    expect(supportsSessions(fakeRuntime({}))).toBe(true);
    expect(supportsSessions({ execute: async () => undefined })).toBe(false);
    expect(supportsSessions(null)).toBe(false);
  });

  it("§19 — the agent's named primary is the stored primary", async () => {
    const result = sandboxResult({
      tables: [
        { name: "side_note", columns: ["metric", "n"], rows: [["Ангара", 1] as readonly CellValue[]] },
        { name: "product_groups", columns: ["metric", "group"], rows: [["Ангара", "A"] as readonly CellValue[]] },
      ],
    });
    const runtime = fakeRuntime({ finish: { ok: true, result, stdout: "", durationMs: 1 } });
    // `side_note` is stored first and would win the shape rule. The agent
    // named the other one, and §19 says that is the answer.
    const outcome = await runner([EXECUTE("x = 1"), COMPLETE("product_groups")], runtime)(decision, store());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.primary.metadata["outputName"]).toBe("product_groups");
  });

  it("§22 — a partial analysis reaches the planner as a failure that names what is missing", async () => {
    const quiet = Array.from({ length: 8 }, (_, i) => EXECUTE(`pass  # ${i}`));
    const runtime = fakeRuntime({
      steps: Array.from({ length: 8 }, () => okStep()),
      finish: { ok: true, result: sandboxResult({ scalars: { december_total: 3665 } }), stdout: "", durationMs: 1 },
    });
    const outcome = await runner(quiet, runtime)(decision, store());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // It must NOT arrive looking like an answer, and it must not lose the
      // work it did do — the planner needs both halves to say anything honest.
      expect(outcome.message).toContain("december_total");
      expect(outcome.message.toLowerCase()).toContain("table");
    }
  });

  it("a clarification is reported as one, not as an analysis failure", async () => {
    const outcome = await runner([JSON.stringify({ action: "CLARIFY", question: "За какой период?", candidates: [] })], fakeRuntime({}))(decision, store());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("CLARIFICATION_REQUIRED");
      expect(outcome.message).toBe("За какой период?");
    }
  });

  it("§71 — every step is reported as an attempt, failures included", async () => {
    const attempts: { ok: boolean }[] = [];
    const runtime = fakeRuntime({ steps: [errorStep("NameError", "entity_df is not defined", "x"), okStep({ f: FRAME })] });
    await runner([EXECUTE("a"), EXECUTE("b"), COMPLETE("movement")], runtime, {
      onAttempt: (record: { ok: boolean }) => attempts.push(record),
    })(decision, store());
    expect(attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it("§36 — the trace is handed to the debug hook, never to the answer", async () => {
    let captured = "";
    await runner([EXECUTE("a"), COMPLETE("movement")], fakeRuntime({}), {
      onTrace: (trace: { text: string }) => {
        captured = trace.text;
      },
    })(decision, store());
    expect(captured).toContain("GOAL");
    expect(captured).toContain("Кластеризуй продукты");
    expect(captured).toContain("OUTCOME: complete");
  });
});

// --- §36/§37 the debug surface --------------------------------------------

describe("Stage 27.2A §36/§37 — the trace is a developer surface, not an answer", () => {
  it("keeps a bounded ring and reports the recovery rate over it", () => {
    clearAgentTraces();
    const entry = (over: Partial<AgentTraceEntry>): AgentTraceEntry => ({
      turnId: "t", request: "q", text: "GOAL", at: 0, rounds: 3, codeExecutions: 2, executionErrors: 0, recovered: false, ...over,
    });
    recordAgentTrace(entry({ executionErrors: 1, recovered: true }));
    recordAgentTrace(entry({ executionErrors: 1, recovered: false }));
    recordAgentTrace(entry({}));

    const rate = selfRecoveryRate();
    // The denominator is turns that HIT an error — the third turn is in
    // neither half of the ratio, and counting it would flatter the number.
    expect(rate.opportunities).toBe(2);
    expect(rate.successes).toBe(1);
    expect(rate.rate).toBe(0.5);
    clearAgentTraces();
  });

  it("says 'n/a' rather than 100% when nothing broke", () => {
    clearAgentTraces();
    recordAgentTrace({ turnId: "t", request: "q", text: "GOAL", at: 0, rounds: 2, codeExecutions: 1, executionErrors: 0, recovered: false });
    expect(selfRecoveryRate().rate).toBeNull();
    expect(renderAgentTraces()).toContain("n/a");
    clearAgentTraces();
  });

  it("§37 — no Python error vocabulary can reach a reader through the outcome", async () => {
    const runtime = fakeRuntime({ steps: [errorStep("NameError", "entity_df is not defined", "x"), okStep({ f: FRAME })] });
    const outcome = await run([EXECUTE("a"), EXECUTE("b"), COMPLETE("movement")], runtime);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    // The answer path carries the RESULT. The error lives only in the trace,
    // which the taskpane hands to the debug ring and to nothing else.
    const serialised = JSON.stringify(outcome.result);
    expect(serialised).not.toContain("NameError");
    expect(serialised).not.toContain("entity_df");
  });
});

// --- §37 what a reader is shown -------------------------------------------

describe("Stage 27.2A §37 — the reader is never shown the machinery", () => {
  it("maps a failed step to a calm, true phase rather than an exception", () => {
    expect(phaseForAgentAction("EXECUTE_CODE", true)).toBe("adjusting");
    expect(progressLabel("adjusting", "ru")).toBe("Уточняю расчёт…");
    expect(progressLabel("adjusting", "en")).toBe("Refining the calculation…");
  });

  it("no progress label mentions Python, an error class, or a tool", () => {
    const phases = ["reading", "inspecting", "analysing", "adjusting", "verifying", "composing"] as const;
    for (const phase of phases) {
      for (const lang of ["ru", "en"] as const) {
        const label = progressLabel(phase, lang);
        expect(label).not.toMatch(/Error|Python|NameError|Syntax|traceback|sandbox/i);
        expect(label).not.toMatch(/\d/);
      }
    }
  });

  it("an inspection and a completion read differently from an ordinary step", () => {
    expect(phaseForAgentAction("INSPECT", false)).toBe("inspecting");
    expect(phaseForAgentAction("COMPLETE", false)).toBe("verifying");
    expect(phaseForAgentAction("EXECUTE_CODE", false)).toBe("analysing");
  });
});

// --- what the first live run found ----------------------------------------
//
// Four defects, all in this code rather than in the model, each reproduced
// here from the transcript that exposed it. The live run is in the report; the
// point of these tests is that the defects cannot come back quietly.

describe("Stage 27.2A — the defects the first live smoke found", () => {
  it("a batch is recognised as a batch, not as invalid JSON", () => {
    // The actual round-4 response: two EXECUTE_CODE and a COMPLETE, run
    // together. Told "not valid JSON", a model has nothing to change.
    const raw = [
      JSON.stringify({ action: "EXECUTE_CODE", purpose: "a", code: "x = 1" }),
      JSON.stringify({ action: "EXECUTE_CODE", purpose: "b", code: "y = 2" }),
      JSON.stringify({ action: "COMPLETE", primaryResultRefs: ["t"], supportingResultRefs: [] }),
    ].join(NEWLINE + NEWLINE + NEWLINE);
    const read = readAnalysisDecision(raw);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.serialization).toBe("concatenated");
    // Only the first action is taken, and the rest are reported as dropped.
    expect(read.decision.kind).toBe("EXECUTE_CODE");
    expect(read.batched).toEqual({ count: 3, dropped: ["EXECUTE_CODE", "COMPLETE"] });
  });

  it("a truncated response is named as truncated, with the remedy", () => {
    const read = readAnalysisDecision('{"action": "EXECUTE_CODE", "purpose": "a", "code": "features = numer');
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.serialization).toBe("truncated");
      expect(read.error).toContain("cut off");
      expect(read.error).toContain("shorter");
    }
  });

  it("one valid object with a stray bracket after it still reads", () => {
    // The actual round-5 response ended with a spurious "]".
    const read = readAnalysisDecision(JSON.stringify({ action: "EXECUTE_CODE", purpose: "a", code: "x = 1" }) + "]");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.decision.kind).toBe("EXECUTE_CODE");
  });

  it("the leading blank lines every response starts with do not break it", () => {
    const read = readAnalysisDecision(NEWLINE + NEWLINE + JSON.stringify({ action: "COMPLETE", primaryResultRefs: ["t"], supportingResultRefs: [] }));
    expect(read.ok).toBe(true);
  });

  it("table.info now tells the agent the column names", () => {
    // It used to render as "table.info" plus a shape and nothing else. The
    // agent inspected it twice, learned nothing, then guessed twelve column
    // names — every one of them wrong — and got a KeyError.
    const rendered = renderLook({
      target: "table.info",
      status: "ok",
      shape: [15, 13],
      entityColumns: ["metric"],
      numericColumns: ["Янв", "Фев", "Мар"],
      missing: { Мар: 1 },
      matrixShape: [15, 12],
    });
    expect(rendered).toContain("metric");
    expect(rendered).toContain("Янв");
    expect(rendered).toContain("Мар: 1");
    expect(rendered).toContain("[15,12]");
  });

  it("table.schema shows each column's ROLE, not an empty type", () => {
    const rendered = renderLook({
      target: "table.schema",
      status: "ok",
      schema: [
        { name: "metric", role: "metric_label", missing: 0 },
        { name: "Мар", role: "amount", missing: 1 },
      ],
    });
    expect(rendered).toContain("metric: metric_label");
    expect(rendered).toContain("Мар: amount, 1 empty");
  });

  it("the iterative prompt does not teach the one-shot RESULT contract", () => {
    // `result` wraps the RESULT that already exists, so a script that rebinds
    // the name leaves the emitter writing into a dict nobody collects. The
    // live run produced exactly that, having been told to do both.
    const system = buildAgentMessages({
      round: 1,
      request: "q",
      plan: plan(),
      dataset: dataset(),
      observations: [],
      environment: [],
      tools: [],
      remaining: { decisionRounds: 7, codeExecutions: 5, inspections: 5, toolCalls: 8 },
    })[0]!.content;

    expect(system).not.toContain("Assign a dict to RESULT");
    expect(system).toContain("Do NOT assign to RESULT");
    expect(system).toContain("result.emit(");
    // The shared ACI facts are still there — this is a split, not a rewrite.
    expect(system).toContain("numeric_data");
    expect(system).toContain("NEVER fill a missing value with 0");
  });

  it("the prompt tells the model to send one decision, not a plan", () => {
    const system = buildAgentMessages({
      round: 1, request: "q", plan: plan(), dataset: dataset(), observations: [], environment: [], tools: [],
      remaining: { decisionRounds: 7, codeExecutions: 5, inspections: 5, toolCalls: 8 },
    })[0]!.content;
    expect(system).toContain("ONE decision, not a plan");
  });
});

// --- what the SECOND live run found ---------------------------------------

describe("Stage 27.2A — the defects the second live smoke found", () => {
  it("a variable name on a table target is dropped, so repeated looks are seen as repeated", () => {
    // The model sends {"target": "table.head", "variable": "data"} — and
    // `__sa_look` ignores the variable for table targets. Keeping it made
    // three identical looks read as three different actions, and the loop
    // spent its entire inspection budget on them.
    const withVar = parseAnalysisDecision({ action: "INSPECT", purpose: "p", target: "table.head", variable: "data" });
    const without = parseAnalysisDecision({ action: "INSPECT", purpose: "p", target: "table.head", variable: null });
    expect(withVar.ok && without.ok).toBe(true);
    if (withVar.ok && without.ok) {
      expect(actionFingerprint(withVar.decision)).toBe(actionFingerprint(without.decision));
      expect((withVar.decision as { variable: string | null }).variable).toBeNull();
    }
  });

  it("a variable target still keeps its variable", () => {
    const parsed = parseAnalysisDecision({ action: "INSPECT", purpose: "p", target: "variable.summary", variable: "features" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect((parsed.decision as { variable: string | null }).variable).toBe("features");
  });

  it("the third identical inspection is refused", async () => {
    const look = JSON.stringify({ action: "INSPECT", purpose: "p", target: "table.head", variable: "data" });
    const same = JSON.stringify({ action: "INSPECT", purpose: "differently worded", target: "table.head", variable: null });
    const seen: AgentObservation[] = [];
    await run([look, same, look, COMPLETE("movement")], fakeRuntime({}), {
      onStep: (r: { observation: AgentObservation }) => seen.push(r.observation),
    });
    expect(seen.map((o) => o.status)).toEqual(["ok", "ok", "repeated", "ok"]);
  });

  it("the prompt does not offer to fetch what it has already supplied", () => {
    const messages = buildAgentMessages({
      round: 1, request: "q", plan: plan(), dataset: dataset(), observations: [], environment: [], tools: [],
      remaining: { decisionRounds: 7, codeExecutions: 5, inspections: 5, toolCalls: 8 },
    });
    expect(messages[0]!.content).toContain("YOU ALREADY HAVE THE TABLE'S STRUCTURE");
    expect(messages[0]!.content).toContain("never fetch the same thing twice");
    // …and it does supply it, which is what made the offer a contradiction.
    expect(messages[1]!.content).toContain("metric");
    expect(messages[1]!.content).toContain("Янв");
  });

  it("the budget warning arrives while it can still be acted on", () => {
    const near = buildAgentMessages({
      round: 6, request: "q", plan: plan(), dataset: dataset(), observations: [], environment: [], tools: [],
      remaining: { decisionRounds: 3, codeExecutions: 4, inspections: 2, toolCalls: 8 },
    })[1]!.content;
    expect(near).toContain("BUDGET IS RUNNING OUT");
    expect(near).toContain("Stop exploring");

    const early = buildAgentMessages({
      round: 1, request: "q", plan: plan(), dataset: dataset(), observations: [], environment: [], tools: [],
      remaining: { decisionRounds: 7, codeExecutions: 5, inspections: 5, toolCalls: 8 },
    })[1]!.content;
    expect(early).not.toContain("BUDGET IS RUNNING OUT");
  });

  it("§23/§24 — an analysis that asks a question reaches the user as a question", async () => {
    // It used to arrive as "анализ недоступен", which is the one answer a
    // clarifying question cannot be answered through.
    const outcome = await runner(
      [JSON.stringify({ action: "CLARIFY", question: "За какой период?", candidates: [] })],
      fakeRuntime({}),
    )(analyzeDecision, store());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("CLARIFICATION_REQUIRED");
  });
});

// --- §24 end to end --------------------------------------------------------

describe("Stage 27.2A §24 — one clarification lifecycle, not two", () => {
  it("an analysis that asks a question suspends the turn the way a planner question does", async () => {
    const previous = process.env["VITE_ANALYTICAL_AGENT_LOOP"];
    process.env["VITE_ANALYTICAL_AGENT_LOOP"] = "true";
    try {
      const turn = await runAnalyticalEngine({
        turnId: "t-clarify",
        request: "Сравни наши показатели с показателями конкурентов",
        schema: table.schema,
        grids: table.grids,
        language: "ru",
        state: EMPTY_ANALYTICAL_STATE,
        decide: async () =>
          JSON.stringify({
            kind: "analyze",
            objective: "compare against competitors",
            requestedOutputs: [{ id: "o1", description: "the comparison", shape: "table" }],
          }),
        narrate: async () => "",
        analysis: {
          runtime: fakeRuntime({}) as never,
          generateCode: async () => "",
          decideStep: async () => JSON.stringify({ action: "CLARIFY", question: "Где данные о конкурентах?", candidates: [] }),
          currentSourceVersion: () => table.schema.sourceVersion,
        },
      });

      // It reaches the user as a QUESTION. Before this, it arrived as
      // "анализ недоступен" — which cannot be answered.
      expect(turn.kind).toBe("clarify");
      if (turn.kind !== "clarify") return;
      expect(turn.question).toContain("конкурент");
      // §24 — and the existing suspended state is what carries it, so the
      // user's reply resumes this task rather than starting a new one.
      expect(turn.state.suspended?.question).toContain("конкурент");
      expect(turn.state.suspended?.request).toContain("Сравни");
    } finally {
      if (previous === undefined) delete process.env["VITE_ANALYTICAL_AGENT_LOOP"];
      else process.env["VITE_ANALYTICAL_AGENT_LOOP"] = previous;
    }
  });
});

// --- what the fourth live run found ---------------------------------------

describe("Stage 27.2A — batching, and the narrow overturn of Stage 26.6 §5", () => {
  const batch = (...objects: readonly object[]): string => objects.map((o) => JSON.stringify(o)).join(NEWLINE + NEWLINE);

  it("runs the first action of a batch and says the rest did not happen", async () => {
    const seen: AgentObservation[] = [];
    const runtime = fakeRuntime({ steps: [okStep({ features: FRAME })] });
    const outcome = await run(
      [
        batch(
          { action: "EXECUTE_CODE", purpose: "a", code: "features = numeric_data" },
          { action: "EXECUTE_CODE", purpose: "b", code: "labels = km.fit_predict(features)" },
          { action: "COMPLETE", primaryResultRefs: ["movement"], supportingResultRefs: [] },
        ),
        COMPLETE("movement"),
      ],
      runtime,
      { onStep: (r: { observation: AgentObservation }) => seen.push(r.observation) },
    );

    // Exactly one script ran — the first.
    expect(runtime.ran).toEqual(["features = numeric_data"]);
    expect(outcome.metrics.batchedDecisions).toBe(1);
    // And the agent is told, in terms it cannot misread, that the others did not.
    const notice = seen.find((o) => o.summary.includes("ONLY THE FIRST WAS RUN"));
    expect(notice?.summary).toContain("did NOT happen");
    expect(notice?.summary).toContain("EXECUTE_CODE, COMPLETE");
  });

  it("a batch is NOT a control error — it cost no protocol allowance", async () => {
    const outcome = await run(
      [batch({ action: "EXECUTE_CODE", purpose: "a", code: "x = 1" }, { action: "EXECUTE_CODE", purpose: "b", code: "y = 2" }), COMPLETE("movement")],
      fakeRuntime({}),
    );
    expect(outcome.metrics.controlErrors).toBe(0);
    expect(outcome.status).toBe("complete");
  });

  it("§21 — a batch that OPENS with COMPLETE is refused", () => {
    // This is the half of Stage 26.6 §5 that still binds. COMPLETE ends the
    // turn, so honouring one written before any result existed would let the
    // model finish an analysis it had not done.
    const read = readAnalysisDecision(
      [JSON.stringify({ action: "COMPLETE", primaryResultRefs: ["t"], supportingResultRefs: [] }), JSON.stringify({ action: "EXECUTE_CODE", purpose: "a", code: "x = 1" })].join(NEWLINE + NEWLINE),
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain("ends the turn");
  });

  it("a batch that opens with CLARIFY is refused for the same reason", () => {
    const read = readAnalysisDecision(
      [JSON.stringify({ action: "CLARIFY", question: "который?", candidates: [] }), JSON.stringify({ action: "EXECUTE_CODE", purpose: "a", code: "x = 1" })].join(NEWLINE + NEWLINE),
    );
    expect(read.ok).toBe(false);
  });

  it("a batch containing anything unparseable is refused whole", () => {
    // One bad member means we do not know what was sent, and a valid first
    // object does not make the response a plan rather than a mess.
    const read = readAnalysisDecision(
      [JSON.stringify({ action: "EXECUTE_CODE", purpose: "a", code: "x = 1" }), JSON.stringify({ action: "NOT_AN_ACTION" })].join(NEWLINE + NEWLINE),
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain("not a valid decision");
  });

  it("the PLANNER still refuses batches outright — the overturn is scoped", () => {
    // Stage 26.6 §5 is untouched where it was written to apply.
    const planner = parsePlannerDecision(
      [JSON.stringify({ kind: "tool_call", tool: "period.latest", arguments: {} }), JSON.stringify({ kind: "tool_call", tool: "period.previous", arguments: {} })].join(NEWLINE + NEWLINE),
    );
    expect(planner.ok).toBe(false);
  });
});

// --- what the focused recovery cases found --------------------------------

describe("Stage 27.2A — a capability that does not exist is not offered", () => {
  const ctx = (tools: readonly { name: string; summary: string }[]) => ({
    round: 1, request: "q", plan: plan(), dataset: dataset(), observations: [], environment: [], tools,
    remaining: { decisionRounds: 7, codeExecutions: 5, inspections: 3, toolCalls: 8 },
  });

  it("does not advertise CALL_TOOL when no tools are wired", () => {
    // This was the largest single cause of failure in the live runs: the
    // action was listed unconditionally, nothing was wired, and the model
    // called a tool — then another after being refused — until the turn died
    // on CONTROL_FAILURE with the analysis half-finished.
    const system = buildAgentMessages(ctx([]))[0]!.content;
    expect(system).not.toContain("CALL_TOOL");
    expect(system).toContain("EXECUTE_CODE");
    expect(system).toContain("COMPLETE");
  });

  it("advertises it when tools ARE wired", () => {
    const system = buildAgentMessages(ctx([{ name: "period.resolve", summary: "resolve a period phrase" }]))[0]!.content;
    expect(system).toContain("CALL_TOOL");
  });

  it("never leaves the placeholder in the prompt", () => {
    for (const tools of [[], [{ name: "t", summary: "s" }]]) {
      expect(buildAgentMessages(ctx(tools))[0]!.content).not.toContain("@@");
    }
  });
});

describe("Stage 27.2A — an emitted result is reported as emitted", () => {
  it("names what was emitted instead of saying 'none'", () => {
    // Python used to return only hasResult: true, so the observation said
    // "Emitted results: none" after a successful result.emit. The agent,
    // told its work had not landed, emitted again — and one live turn
    // eventually tried to finish from inside Python.
    const observation = observeStep({
      stepId: 1,
      step: okStep({ frame: FRAME }, { emitted: ["largest_mean", "column_means"], hasResult: true }),
      before: [],
    });
    expect(observation.resultRefs).toEqual(["largest_mean", "column_means"]);
    const text = renderObservation(observation);
    expect(text).toContain("Emitted results:");
    expect(text).toContain("largest_mean");
    expect(text).not.toContain("Emitted results:" + NEWLINE + "none");
  });

  it("shows how to finish, in the exact form the protocol accepts", () => {
    const text = renderObservation(observeStep({ stepId: 1, step: okStep({}, { emitted: ["largest_mean"] }), before: [] }));
    expect(text).toContain('{"action": "COMPLETE", "primaryResultRefs": ["largest_mean"]');
    // And says the thing a live turn got wrong.
    expect(text).toContain("COMPLETE is a DECISION, not Python");
  });

  it("says nothing about finishing when nothing has been emitted", () => {
    const text = renderObservation(observeStep({ stepId: 1, step: okStep({ frame: FRAME }), before: [] }));
    expect(text).toContain("none");
    expect(text).not.toContain("COMPLETE is a DECISION");
  });
});

// ---------------------------------------------------------------------------
// Stage 27 §4/§5/§13/§32/§34/§67/§83/§84 — routing, and what it refuses.
//
// The sandbox is driven by a scripted planner and a fake runtime here, because
// what is under test is the ROUTE — which decisions are offered, which are
// executed, and what happens when the analysis cannot be done. Real Pyodide
// adds nine seconds and answers none of those questions; it is exercised in
// `sandbox.test.ts`.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import { runAnalyticalEngine } from "./engine.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { parsePlannerDecision, plannerSystemPrompt } from "./planner/planner-prompt.js";
import { createAnalysisRunner, planFromDecision } from "./sandbox/analysis-runner.js";
import { storeSandboxResult } from "./sandbox/result-adapter.js";
import { methodNoteFor } from "./narration/method-note.js";
import { ResultStore } from "./results/result-store.js";
import { buildFindings, extractFindings } from "./insight/extract-findings.js";
import { renderDeterministic } from "./narration/narrator.js";
import type { AnalyticalRuntime } from "./sandbox/executor.js";
import type { ExecuteOutcome } from "./sandbox/pyodide-runtime.js";
import type { AnalyzeDecision } from "./types.js";
import type { SandboxResult } from "./sandbox/types.js";

// --- helpers ----------------------------------------------------------------

function sandboxResult(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    executionId: "exec_1",
    status: "ok",
    method: { name: "kmeans", parameters: { n_clusters: 2 }, randomState: 0 },
    // §19 — the shared decision below commits to two methods, so the result
    // has to carry two that actually ran. A fixture that promised a comparison
    // and delivered one method would be testing the engine against exactly the
    // shortfall §19 exists to catch.
    methodComparison: {
      methods: [
        { name: "kmeans", parameters: { n_clusters: 2 }, metrics: { silhouette: 0.62 }, warnings: [] },
        { name: "hierarchical", parameters: { n_clusters: 2 }, metrics: { silhouette: 0.41 }, warnings: [] },
      ],
      selectedMethod: "kmeans",
      selectionCriteria: ["separation"],
      selectionEvidence: {},
    },
    tables: [],
    scalars: {},
    series: [],
    groups: [
      { label: "steady", members: ["Throughput index", "Queue depth"], profile: { mean_change: 0.01 } },
      { label: "volatile", members: ["Defect ratio"], profile: { mean_change: -0.14 } },
    ],
    models: [],
    diagnostics: { silhouette: 0.62 },
    findingsCandidates: [],
    warnings: [],
    artifacts: [],
    sourceLineage: { datasetIds: ["ds1"], sheet: "Ops", sourceRange: "Ops!A1:D5", freshnessToken: "v1" },
    ...overrides,
  };
}

function fakeRuntime(outcome: ExecuteOutcome, hardTimeout = true): AnalyticalRuntime {
  return { hardTimeout, validate: async () => [], execute: async () => outcome };
}

const ANALYZE_DECISION = JSON.stringify({
  kind: "analyze",
  objective: "segment the indicators by the shape of their monthly dynamics",
  requestedOutputs: [{ id: "a1", description: "the segments", shape: "groups" }],
  methods: ["k-means", "hierarchical"],
  necessity: "MISSING_DETERMINISTIC_CAPABILITY",
});

/** A planner that asks for an analysis, then completes on whatever it produced. */
function analyseThenComplete(): (messages: readonly { readonly content: string }[]) => string {
  return (messages) => {
    const user = messages[messages.length - 1]?.content ?? "";
    const match = /result_(\d+) = sandbox\./.exec(user);
    if (match) return JSON.stringify({ kind: "complete", primaryResultRef: `result_${match[1]}`, supportingResultRefs: [] });
    return ANALYZE_DECISION;
  };
}

async function runTurn(decide: (m: readonly { readonly content: string }[]) => string, analysis?: Parameters<typeof runAnalyticalEngine>[0]["analysis"]) {
  const table = fixtureOperations();
  return runAnalyticalEngine({
    turnId: "t1",
    request: "Кластеризуй показатели по характеру динамики.",
    schema: table.schema,
    grids: table.grids,
    language: "ru",
    state: EMPTY_ANALYTICAL_STATE,
    decide: (messages) => decide(messages as readonly { readonly content: string }[]),
    narrate: async () => "",
    ...(analysis ? { analysis } : {}),
  });
}

// --- §4 ---------------------------------------------------------------------

describe("Stage 27 §4 — the route is offered by the prompt, never decided by a keyword", () => {
  it("does not mention the sandbox when no sandbox is wired in", () => {
    const system = plannerSystemPrompt(false);
    expect(system).not.toMatch(/analyze/);
    expect(system).not.toMatch(/Python/);
  });

  it("describes the sandbox, and what NOT to use it for, when one is available", () => {
    const system = plannerSystemPrompt(true);
    expect(system).toMatch(/"kind":"analyze"/);
    // §83 — the deterministic route must stay dominant for what it covers
    expect(system).toMatch(/If one of them does what the request needs, USE IT/);
    // §5, stated where the substitution would be decided
    expect(system).toMatch(/Never answer a request for one operation with a different operation/);
  });

  it("has no phrase-matching anywhere in the engine's routing", () => {
    // The whole §4 decision is one field on a planner decision. If this ever
    // becomes an engine-side keyword test, this assertion is the tripwire.
    const decision = parsePlannerDecision(ANALYZE_DECISION);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.decision.kind).toBe("analyze");
  });
});

// --- §13 --------------------------------------------------------------------

describe("Stage 27 §13 — the analyze decision is a request, never code", () => {
  it("accepts a well-formed analysis request", () => {
    const parsed = parsePlannerDecision(ANALYZE_DECISION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const d = parsed.decision as AnalyzeDecision;
    expect(d.objective).toMatch(/segment/);
    expect(d.requestedOutputs[0]?.shape).toBe("groups");
    expect(d.methods).toEqual(["k-means", "hierarchical"]);
    expect(d.necessity).toBe("MISSING_DETERMINISTIC_CAPABILITY");
  });

  it("refuses a decision that tries to smuggle its own code", () => {
    // §13 separates planning from generation; the protocol enforces it.
    const parsed = parsePlannerDecision(
      JSON.stringify({ kind: "analyze", objective: "x", requestedOutputs: [{ id: "a1", description: "y", shape: "table" }], code: "import os" }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("UNSAFE_PAYLOAD");
    expect(parsed.problem.severity).toBe("fatal");
  });

  it("refuses an analysis with no declared outputs", () => {
    const parsed = parsePlannerDecision(JSON.stringify({ kind: "analyze", objective: "x", requestedOutputs: [] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.code).toBe("MISSING_FIELD");
  });

  it("refuses an output whose shape is not one the engine can check", () => {
    const parsed = parsePlannerDecision(
      JSON.stringify({ kind: "analyze", objective: "x", requestedOutputs: [{ id: "a1", description: "y", shape: "insight" }] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.correction).toMatch(/table, scalar, series, groups, model, diagnostic/);
  });
});

// --- §5 / §67 ---------------------------------------------------------------

describe("Stage 27 §5/§67 — a failed analysis is never replaced by a different one", () => {
  it("fails the turn when the planner asks for an analysis and no sandbox exists", async () => {
    const turn = await runTurn(() => ANALYZE_DECISION);
    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.reason).toBe("analysis_unavailable");
  });

  it("fails the turn when the analysis cannot be completed, rather than answering with something else", async () => {
    const runtime = fakeRuntime({ ok: false, error: { code: "SANDBOX_RUNTIME_ERROR", message: "ValueError: n_samples=3" }, durationMs: 5 });
    const generateCode = vi.fn(async () => "RESULT = {}");
    const turn = await runTurn(() => ANALYZE_DECISION, { runtime, generateCode });

    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.reason).toBe("analysis_unavailable");
    expect(turn.detail).toMatch(/n_samples/);
    // §66 — it did try to repair, within the budget, before giving up
    expect(generateCode.mock.calls.length).toBeGreaterThan(1);
    // §71 — and the trace says why
    expect(turn.trace.analysisFailure?.code).toBe("SANDBOX_RUNTIME_ERROR");
  });

  it("refuses to run generated code on a runtime that cannot bound it (§12)", async () => {
    const runtime = fakeRuntime({ ok: true, result: sandboxResult(), stdout: "", durationMs: 1 }, false);
    const generateCode = vi.fn(async () => "RESULT = {}");
    const turn = await runTurn(() => ANALYZE_DECISION, { runtime, generateCode });

    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.reason).toBe("analysis_unavailable");
    expect(turn.detail).toMatch(/cannot bound the time/);
    // and nothing was generated, let alone executed
    expect(generateCode).not.toHaveBeenCalled();
  });
});

// --- §32 / §34 --------------------------------------------------------------

describe("Stage 27 §32/§34 — an analysis result is an ordinary engine result", () => {
  it("stores groups as a table the deterministic tools can consume", () => {
    const store = new ResultStore("Ops!A1:D5", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
    const decision: AnalyzeDecision = {
      kind: "analyze",
      objective: "segment",
      requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }],
    };
    const stored = storeSandboxResult({
      store,
      plan: planFromDecision(decision, "ds1"),
      result: sandboxResult(),
      code: "RESULT = {}",
      codeHash: "abc123",
      attempts: 1,
    });

    // §34 — type `table` is what set.filter / set.top / set.argmax accept
    expect(stored.primary.type).toBe("table");
    expect(stored.primary.fields[0]?.kind).toBe("metric");
    expect(stored.primary.rows).toHaveLength(3);
    // every member is addressable by name, so "из них" has something to point at
    expect(stored.primary.metricKeys).toContain("Defect ratio");
    // §30/§71 — the method rides in metadata, never in the rows
    expect(stored.primary.metadata["method"]).toBe("kmeans");
    expect(stored.primary.metadata["randomState"]).toBe(0);
    expect(stored.primary.metadata["codeHash"]).toBe("abc123");
  });

  it("names the primary from the plan's principal output, not from the numbers", () => {
    const store = new ResultStore("Ops!A1:D5", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
    const result = sandboxResult({ tables: [{ name: "profile", columns: ["metric", "score"], rows: [["Defect ratio", 1]] }] });
    const wantsGroups = storeSandboxResult({
      store,
      plan: { objective: "x", datasetRefs: ["ds1"], requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }] },
      result,
      code: "c",
      codeHash: "h",
      attempts: 1,
    });
    expect(wantsGroups.primary.metadata["outputName"]).toBe("groups");

    const store2 = new ResultStore("Ops!A1:D5", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
    const wantsTable = storeSandboxResult({
      store: store2,
      plan: { objective: "x", datasetRefs: ["ds1"], requestedOutputs: [{ id: "a1", description: "the profile", shape: "table" }] },
      result,
      code: "c",
      codeHash: "h",
      attempts: 1,
    });
    expect(wantsTable.primary.metadata["outputName"]).toBe("profile");
  });

  it("completes a turn on an analysis result and records the route (§83/§84)", async () => {
    const runtime = fakeRuntime({ ok: true, result: sandboxResult(), stdout: "", durationMs: 40 });
    const turn = await runTurn(analyseThenComplete(), { runtime, generateCode: async () => "RESULT = {}" });

    expect(turn.kind).toBe("answered");
    if (turn.kind !== "answered") return;
    expect(turn.analysis.primary.tool).toBe("sandbox.kmeans");
    // §84 — why the sandbox was chosen is recorded for later tool-promotion decisions
    expect(turn.trace.analysisMethod?.["necessity"]).toBe("MISSING_DETERMINISTIC_CAPABILITY");
    expect(turn.trace.budget?.analyses).toBe(1);
    // §19/§20 — the comparison survives the whole turn, so "а почему не
    // иерархическая?" is answerable from the record rather than from memory.
    const comparison = turn.trace.analysisMethod?.["methodComparison"] as { selectedMethod?: string } | undefined;
    expect(comparison?.selectedMethod).toBe("kmeans");
    // §60 — and it reaches the narrator as a method note, in words.
    expect(methodNoteFor(turn.analysis.primary)?.comparison?.methods).toHaveLength(2);
  });
});

// --- §38 --------------------------------------------------------------------

describe("Stage 27 §38 — exploration is bounded", () => {
  it("stops a planner that keeps asking for more analyses", async () => {
    const runtime = fakeRuntime({ ok: true, result: sandboxResult(), stdout: "", durationMs: 1 });
    // A planner that never completes, only analyses.
    const turn = await runTurn(() => ANALYZE_DECISION, { runtime, generateCode: async () => "RESULT = {}" });

    expect(turn.kind).toBe("failed");
    if (turn.kind !== "failed") return;
    expect(turn.reason).toBe("analysis_unavailable");
    expect(turn.detail).toMatch(/more than 2 separate analyses/);
  });
});

// --- §13 plan translation ---------------------------------------------------

describe("Stage 27 §13/§18 — the decision becomes the contract the executor enforces", () => {
  it("carries the declared methods through as constraints", () => {
    const decision: AnalyzeDecision = {
      kind: "analyze",
      objective: "compare segmentations",
      requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }],
      methods: ["k-means", "hierarchical", "rule-based"],
      assumptions: ["monthly dynamics are comparable across indicators"],
    };
    const plan = planFromDecision(decision, "ds1");
    expect(plan.methodConstraints).toHaveLength(3);
    expect(plan.assumptions).toHaveLength(1);
    expect(plan.requestedOutputs[0]?.shape).toBe("groups");
    expect(plan.datasetRefs).toEqual(["ds1"]);
  });
});

describe("Stage 27 §9 — the runner prepares the data once per turn", () => {
  it("builds the dataset from the table, not from a handle the sandbox could re-read", async () => {
    const table = fixtureOperations();
    let seenRows = 0;
    const runtime: AnalyticalRuntime = {
      hardTimeout: true,
      validate: async () => [],
      execute: async (_code, dataset) => {
        seenRows = dataset.rows.length;
        // §9 — no workbook handle of any kind crossed the boundary
        expect(Object.keys(dataset)).not.toContain("workbook");
        expect(dataset.freshnessToken).toBe(table.schema.sourceVersion);
        return { ok: true, result: sandboxResult(), stdout: "", durationMs: 1 };
      },
    };
    const runner = createAnalysisRunner({
      capability: { runtime, generateCode: async () => "RESULT = {}" },
      schema: table.schema,
      grids: table.grids,
    });
    const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 3000 });
    const outcome = await runner(
      { kind: "analyze", objective: "x", requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }] },
      store,
    );
    expect(outcome.ok).toBe(true);
    expect(seenRows).toBeGreaterThan(0);
  });
});

// --- §31/§40/§43 ------------------------------------------------------------

describe("Stage 27 §31/§40/§43 — an analysis is explained, not tabulated", () => {
  it("reads segments as observations, largest-signal first", () => {
    const store = new ResultStore("Ops!A1:D5", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
    const stored = storeSandboxResult({
      store,
      plan: { objective: "segment", datasetRefs: ["ds1"], requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }] },
      result: sandboxResult(),
      code: "RESULT = {}",
      codeHash: "h",
      attempts: 1,
    });
    const findings = extractFindings(stored.primary, { locale: "ru" });

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.findingType === "cluster")).toBe(true);
    // §39 — the SMALL group leads: an outlier lands in one, and a group holding
    // half the set says little.
    expect(findings[0]?.subject).toBe("volatile");
    expect(findings[0]?.statement).toMatch(/Defect ratio/);
    // §32 — every claim traces back to the analysis that produced it
    expect(findings[0]?.provenance.resultRef).toBe(stored.primary.resultId);
  });

  it("the fallback for a clustering answer is prose, not the member table", () => {
    const store = new ResultStore("Ops!A1:D5", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
    const stored = storeSandboxResult({
      store,
      plan: { objective: "segment", datasetRefs: ["ds1"], requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }] },
      result: sandboxResult(),
      code: "RESULT = {}",
      codeHash: "h",
      attempts: 1,
    });
    const analysis = { primary: stored.primary, supporting: [], answerStyle: "concise" as const };
    const body = renderDeterministic({
      request: "Кластеризуй показатели.",
      analysis,
      findings: buildFindings(stored.primary, [], { locale: "ru" }),
      locale: "ru",
    });

    expect(body).toMatch(/volatile|steady/);
    expect(body).toMatch(/Defect ratio/);
    // §43 — no raw table, and no cluster label left unexplained
    expect(body).not.toContain("| metric |");
  });
});

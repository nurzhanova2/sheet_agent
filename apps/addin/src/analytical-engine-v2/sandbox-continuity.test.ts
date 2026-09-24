import { describe, expect, it } from "vitest";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { commitState } from "./state/state-commit.js";
import { storeSandboxResult } from "./sandbox/result-adapter.js";
import { ResultStore } from "./results/result-store.js";
import type { FindingCandidate, SandboxPlan, SandboxResult } from "./sandbox/types.js";
import type { EngineAnalysis } from "./types.js";

const TABLE_REF = { sheetName: "Ops", sourceRange: "Ops!A1:D5", sourceVersion: "v1" };

function sandboxResult(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    executionId: "exec_1",
    status: "ok",
    method: { name: "kmeans", parameters: { n_clusters: 2 }, randomState: 0 },
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

function storeAnalysis(result: SandboxResult, plan?: Partial<SandboxPlan>): EngineAnalysis {
  const store = new ResultStore("Ops!A1:D5", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
  const stored = storeSandboxResult({
    store,
    plan: {
      objective: "segment the indicators",
      datasetRefs: ["ds1"],
      requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }],
      ...plan,
    },
    result,
    code: "RESULT = {}",
    codeHash: "abc123",
    attempts: 1,
  });
  return { primary: stored.primary, supporting: stored.all.filter((r) => r !== stored.primary), answerStyle: "explanatory" };
}

const commit = (analysis: EngineAnalysis) => commitState(EMPTY_ANALYTICAL_STATE, { turnId: "t1", tableRef: TABLE_REF, analysis });

// --- §33: the analysis survives the turn ------------------------------------

describe("Stage 27 §33 — a sandbox result enters the conversation state", () => {
  it("commits without being rejected as an inconsistent state", () => {
    const { state, rejected } = commit(storeAnalysis(sandboxResult()));
    expect(rejected).toBeNull();
    expect(state.turnId).toBe("t1");
  });

  it("leaves the analysed entities addressable by name", () => {
    // "Какой кластер самый нестабильный?" and "покажи динамику самого
    // необычного продукта" both need this: the next turn has to be able to
    // name a subject the sandbox produced.
    const { state } = commit(storeAnalysis(sandboxResult()));
    expect(state.lastMetricSet?.metricKeys).toEqual(expect.arrayContaining(["Throughput index", "Queue depth", "Defect ratio"]));
  });

  it("records where the analysis came from, not just what it said", () => {
    // §32 — lineage, so a follow-up computed against it is checkable and a
    // stale one is refusable (§69).
    const { state } = commit(storeAnalysis(sandboxResult()));
    expect(state.lastResult?.tool).toBe("sandbox.kmeans");
    expect(state.tableRef?.sourceVersion).toBe("v1");
    expect(state.workbookFreshnessToken).toBe("v1");
  });

  it("keeps the analysis reachable as the most recent result", () => {
    const { state } = commit(storeAnalysis(sandboxResult()));
    expect(state.recentResults?.[0]?.role).toBe("primary");
    expect(state.recentResults?.[0]?.tool).toBe("sandbox.kmeans");
  });

  it("carries an exploration through the same way", () => {
    const candidates: readonly FindingCandidate[] = [
      { kind: "anomalies", subject: "Defect ratio", values: { zScore: 3.4 } },
      { kind: "data_quality", subject: "Queue depth", values: { missingCount: 2 } },
    ];
    const analysis = storeAnalysis(
      sandboxResult({ groups: [], findingsCandidates: candidates }),
      { requestedOutputs: [{ id: "a1", description: "what stands out", shape: "table" }], explorationDimensions: ["anomalies", "data_quality"] },
    );
    const { state, rejected } = commit(analysis);
    expect(rejected).toBeNull();
    // Every dimension stays reachable, so "расскажи подробнее про аномалии"
    // has a result to point at without the next turn knowing an exploration
    // happened.
    expect(state.recentResults?.length).toBeGreaterThanOrEqual(2);
    expect(state.recentResults?.every((r) => r.tool.startsWith("sandbox."))).toBe(true);
    expect(analysis.supporting.map((r) => r.metadata["explorationDimension"])).toContain("data_quality");
  });

  it("does not turn a spread of one-off observations into a candidate set", () => {
    // Deliberate. "Из них выбери самый большой" over a set that mixes one
    // anomaly with one gap-ridden column is a question with no answer, and
    // carrying those two names forward as a SET would invite it. A dimension
    // that named several entities is a different matter, and does.
    const spread = storeAnalysis(
      sandboxResult({
        groups: [],
        findingsCandidates: [
          { kind: "anomalies", subject: "Defect ratio", values: { zScore: 3.4 } },
          { kind: "data_quality", subject: "Queue depth", values: { missingCount: 2 } },
        ],
      }),
      { requestedOutputs: [{ id: "a1", description: "what stands out", shape: "table" }], explorationDimensions: ["anomalies", "data_quality"] },
    );
    expect(commit(spread).state.lastMetricSet).toBeUndefined();

    const together = storeAnalysis(
      sandboxResult({
        groups: [],
        findingsCandidates: [
          { kind: "anomalies", subject: "Defect ratio", values: { zScore: 3.4 } },
          { kind: "anomalies", subject: "Queue depth", values: { zScore: 2.6 } },
        ],
      }),
      { requestedOutputs: [{ id: "a1", description: "what stands out", shape: "table" }], explorationDimensions: ["anomalies"] },
    );
    expect(commit(together).state.lastMetricSet?.metricKeys).toEqual(["Defect ratio", "Queue depth"]);
  });
});

// --- §34: and nothing downstream knows it was Python ------------------------

describe("Stage 27 §34 — the result is indistinguishable from a tool's", () => {
  it("carries the same fields a deterministic set result carries", () => {
    const analysis = storeAnalysis(sandboxResult());
    // The shape `set.filter` / `set.top` / `set.argmax` consume.
    expect(analysis.primary.type).toBe("table");
    expect(analysis.primary.fields[0]?.kind).toBe("metric");
    expect(analysis.primary.sourceRange).toBe("Ops!A1:D5");
    expect(analysis.primary.sourceVersion).toBe("v1");
  });

  it("keeps the method out of the rows and in the metadata", () => {
    // §30/§71 — a tool reading this result sees data. How it was computed is
    // for the trace and the method note, and a tool that branched on it would
    // be the sandbox special case §34 exists to avoid.
    const analysis = storeAnalysis(sandboxResult());
    const flat = analysis.primary.rows.flat().map((v) => String(v));
    expect(flat).not.toContain("kmeans");
    expect(analysis.primary.metadata["method"]).toBe("kmeans");
  });
});

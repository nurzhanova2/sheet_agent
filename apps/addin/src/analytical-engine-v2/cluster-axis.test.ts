import { describe, expect, it } from "vitest";
import { validateClusterMembership, validateClusterKSelection } from "./sandbox/executor.js";
import { storeSandboxResult } from "./sandbox/result-adapter.js";
import { ResultStore } from "./results/result-store.js";
import { buildFindings } from "./insight/extract-findings.js";
import { renderDeterministic } from "./narration/narrator.js";
import type { SandboxDataset, SandboxGroup, SandboxResult } from "./sandbox/types.js";

const METRICS = ["A rising", "B rising", "C stable", "D stable", "E declining", "F declining"];
const PERIODS = ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12"];

function dataset(): SandboxDataset {
  return {
    datasetId: "ds1",
    tableRef: "primary",
    sheet: "Ops",
    sourceRange: "A1:F6",
    freshnessToken: "v1",
    columns: [
      { name: "metric", semanticType: "metric_label", missingCount: 0, zeroCount: 0 },
      ...PERIODS.map((p) => ({ name: p, semanticType: "amount" as const, missingCount: 0, zeroCount: 0 })),
    ],
    rows: METRICS.map((m, i) => [m, ...PERIODS.map((_, j) => 100 + i * 10 + j)]),
    periods: PERIODS,
  };
}

function result(groups: readonly SandboxGroup[], excludedEntities?: readonly { readonly entity: string; readonly reason: string }[]): SandboxResult {
  return {
    executionId: "exec1",
    status: "ok",
    tables: [],
    scalars: {},
    series: [],
    groups,
    models: [],
    diagnostics: {},
    findingsCandidates: [],
    warnings: [],
    artifacts: [],
    sourceLineage: { datasetIds: ["ds1"], sheet: "Ops", sourceRange: "A1:F6", freshnessToken: "v1" },
    ...(excludedEntities ? { excludedEntities } : {}),
  };
}

describe("Stage 28H.2 — clustering must group entities, not periods", () => {
  it("passes when every group member is a clustered metric", () => {
    const problems = validateClusterMembership(dataset(), result([
      { label: "0", members: ["A rising", "B rising"] },
      { label: "1", members: ["C stable", "D stable"] },
      { label: "2", members: ["E declining", "F declining"] },
    ]));
    expect(problems).toEqual([]);
  });

  it("rejects a group whose members are period labels instead of metrics", () => {
    const problems = validateClusterMembership(dataset(), result([
      { label: "0", members: ["2025-08", "2025-09"] },
      { label: "1", members: ["2025-10", "2025-11", "2025-12"] },
    ]));
    expect(problems.some((p) => p.includes("2025-08") && p.includes("period"))).toBe(true);
  });

  it("rejects an entity assigned to more than one group", () => {
    const problems = validateClusterMembership(dataset(), result([
      { label: "0", members: ["A rising", "B rising"] },
      { label: "1", members: ["B rising", "C stable"] },
    ]));
    expect(problems.some((p) => p.includes("B rising"))).toBe(true);
  });

  it("does nothing when there are no groups to check", () => {
    expect(validateClusterMembership(dataset(), result([]))).toEqual([]);
  });

  it("rejects an eligible entity left out of every group with no exclusion", () => {
    const problems = validateClusterMembership(dataset(), result([
      { label: "0", members: ["A rising", "B rising"] },
      { label: "1", members: ["C stable", "D stable"] },
      { label: "2", members: ["E declining"] },
    ]));
    expect(problems.some((p) => p.includes("F declining"))).toBe(true);
  });

  it("accepts an omitted entity when it is named as an explicit typed exclusion", () => {
    const problems = validateClusterMembership(
      dataset(),
      result(
        [
          { label: "0", members: ["A rising", "B rising"] },
          { label: "1", members: ["C stable", "D stable"] },
          { label: "2", members: ["E declining"] },
        ],
        [{ entity: "F declining", reason: "did not converge into any cluster at the selected k" }],
      ),
    );
    expect(problems).toEqual([]);
  });

  it("rejects an exclusion that names an entity the table does not have", () => {
    const problems = validateClusterMembership(
      dataset(),
      result(
        [
          { label: "0", members: ["A rising", "B rising"] },
          { label: "1", members: ["C stable", "D stable"] },
          { label: "2", members: ["E declining", "F declining"] },
        ],
        [{ entity: "G phantom", reason: "does not exist" }],
      ),
    );
    expect(problems.some((p) => p.includes("G phantom"))).toBe(true);
  });

  it("requires selection evidence for a chosen number of groups", () => {
    const noEvidence = validateClusterKSelection({
      executionId: "e", status: "ok", method: { name: "kmeans", parameters: { n_clusters: 3 } },
      tables: [], scalars: {}, series: [],
      groups: [{ label: "0", members: ["a"] }, { label: "1", members: ["b"] }],
      models: [], diagnostics: {}, findingsCandidates: [], warnings: [], artifacts: [],
      sourceLineage: { datasetIds: ["ds1"], sheet: "Ops", sourceRange: "A1:B2", freshnessToken: "v1" },
    });
    expect(noEvidence.length).toBeGreaterThan(0);

    const withEvidence = validateClusterKSelection({
      executionId: "e", status: "ok",
      method: { name: "kmeans", parameters: { n_clusters: 3, selectionMethod: "silhouette", candidateK: [2, 3, 4, 5] } },
      tables: [], scalars: {}, series: [],
      groups: [{ label: "0", members: ["a"] }, { label: "1", members: ["b"] }],
      models: [], diagnostics: {}, findingsCandidates: [], warnings: [], artifacts: [],
      sourceLineage: { datasetIds: ["ds1"], sheet: "Ops", sourceRange: "A1:B2", freshnessToken: "v1" },
    });
    expect(withEvidence).toEqual([]);
  });

  function fiveGroupResult(): SandboxResult {
    return {
      executionId: "exec2",
      status: "ok",
      method: { name: "kmeans", parameters: { n_clusters: 5, selectionMethod: "silhouette", candidateK: [2, 3, 4, 5] } },
      tables: [],
      scalars: {},
      series: [],
      groups: [
        { label: "0", members: ["A rising", "B rising"], profile: { mean_change: 0.2 } },
        { label: "1", members: ["C stable"], profile: { mean_change: 0.0 } },
        { label: "2", members: ["D stable"], profile: { mean_change: 0.01 } },
        { label: "3", members: ["E declining"], profile: { mean_change: -0.2 } },
        { label: "4", members: ["F declining"], profile: { mean_change: -0.25 } },
      ],
      models: [],
      diagnostics: {},
      findingsCandidates: [],
      warnings: [],
      artifacts: [],
      sourceLineage: { datasetIds: ["ds1"], sheet: "Ops", sourceRange: "A1:F6", freshnessToken: "v1" },
    };
  }

  it("passes axis validation for a full five-way grouping of every metric", () => {
    expect(validateClusterMembership(dataset(), fiveGroupResult())).toEqual([]);
  });

  it("carries all five groups through to the deterministic fallback text", () => {
    const store = new ResultStore("Ops!A1:F6", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });
    const stored = storeSandboxResult({
      store,
      plan: { objective: "segment", datasetRefs: ["ds1"], requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }] },
      result: fiveGroupResult(),
      code: "RESULT = {}",
      codeHash: "h",
      attempts: 1,
    });
    const analysis = { primary: stored.primary, supporting: [], answerStyle: "concise" as const };
    const findings = buildFindings(stored.primary, [], { locale: "ru" }, stored.primary.rows.length, stored.primary.rows.length);
    expect(findings).toHaveLength(5);
    const body = renderDeterministic({ request: "Кластеризуй показатели.", analysis, findings, locale: "ru" });
    for (const label of ["0", "1", "2", "3", "4"]) {
      expect(body.includes(label) || findings.some((f) => f.subject === label)).toBe(true);
    }
    expect(findings.map((f) => f.subject).sort()).toEqual(["0", "1", "2", "3", "4"]);
  });
});

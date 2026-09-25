import { describe, expect, it } from "vitest";
import { validateClusterMembership } from "./sandbox/executor.js";
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

function result(groups: readonly SandboxGroup[]): SandboxResult {
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
});

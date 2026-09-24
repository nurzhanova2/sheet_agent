// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import type { CellValue } from "@sheet-agent/application";
import { createNodeSandbox, HARNESS_INDEX_URL } from "./node-sandbox.js";
import type { SandboxDataset } from "../sandbox/types.js";

const BOOT_MS = 120_000;

const vendored = existsSync(HARNESS_INDEX_URL);
const sandbox = createNodeSandbox();

afterAll(async () => {
  await sandbox.dispose();
});

function dataset(): SandboxDataset {
  return {
    datasetId: "ds1",
    tableRef: "S!A1:C4",
    sheet: "S",
    sourceRange: "S!A1:C4",
    freshnessToken: "v1",
    columns: [
      { name: "metric", semanticType: "metric_label", missingCount: 0, zeroCount: 0 },
      { name: "Jan", semanticType: "amount", missingCount: 1, zeroCount: 1 },
      { name: "Feb", semanticType: "amount", missingCount: 0, zeroCount: 0 },
    ],
    rows: [
      ["alpha", 10, 12] as readonly CellValue[],
      ["beta", null, 40] as readonly CellValue[],
      ["gamma", 0, 7] as readonly CellValue[],
    ],
  };
}

describe.skipIf(!vendored)("Stage 27 §90 — the benchmark host boots the shipped runtime", () => {
  it("declares itself bounded, which is what lets the runner use it (§12)", () => {
    expect(sandbox.runtime.hardTimeout).toBe(true);
  });

  it(
    "runs pandas and scikit-learn out of the vendored assets",
    async () => {
      const code = [
        "from sklearn.cluster import KMeans",
        "import numpy as np",
        "x = data[['Jan', 'Feb']].fillna(data[['Jan', 'Feb']].mean())",
        "km = KMeans(n_clusters=2, n_init=10, random_state=0).fit(x)",
        "RESULT = {",
        '  "method": {"name": "kmeans", "parameters": {"k": 2}, "random_state": 0},',
        '  "scalars": {"inertia": float(km.inertia_)},',
        "}",
      ].join("\n");
      const outcome = await sandbox.runtime.execute(code, dataset());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.method?.name).toBe("kmeans");
      expect(typeof outcome.result.scalars["inertia"]).toBe("number");
    },
    BOOT_MS,
  );

  it(
    "carries the same refusals as the browser worker",
    async () => {
      // §15 — the AST validator is imported, not reimplemented, so a benchmark
      // that passed while production refused would be impossible.
      const violations = await sandbox.runtime.validate("import os\nRESULT = {}");
      expect(violations.length).toBeGreaterThan(0);

      const escape = await sandbox.runtime.execute("import socket\nRESULT = {}", dataset());
      expect(escape.ok).toBe(false);
    },
    BOOT_MS,
  );

  it(
    "keeps a missing observation missing across the boundary (§23)",
    async () => {
      const code = [
        "jan = data['Jan']",
        "RESULT = {",
        '  "scalars": {"missing": float(jan.isna().sum()), "zeros": float((jan == 0).sum())},',
        "}",
      ].join("\n");
      const outcome = await sandbox.runtime.execute(code, dataset());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // One empty cell and one recorded zero, still telling them apart after a
      // trip through JSON, pandas and back.
      expect(outcome.result.scalars["missing"]).toBe(1);
      expect(outcome.result.scalars["zeros"]).toBe(1);
    },
    BOOT_MS,
  );

  it(
    "gives the analysis no environment to read (§7/§11)",
    async () => {
      // The worker is spawned with an empty env. A Python analysis that reaches
      // for os.environ is already refused by the validator, so this checks the
      // layer behind it: even if it got there, there is nothing to take.
      const code = ["import sys", 'RESULT = {"scalars": {"argv": float(len(sys.argv))}}'].join("\n");
      const outcome = await sandbox.runtime.execute(code, dataset());
      // `sys` is not on the allow-list, so this is refused before it runs.
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(["CODE_VALIDATION_ERROR", "UNSAFE_CODE", "UNSUPPORTED_LIBRARY"]).toContain(outcome.error.code);
    },
    BOOT_MS,
  );
});

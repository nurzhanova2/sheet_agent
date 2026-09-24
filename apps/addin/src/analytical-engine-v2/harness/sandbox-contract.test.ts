// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createNodeSandbox, HARNESS_INDEX_URL } from "./node-sandbox.js";
import { benchmarkPortfolio } from "./sandbox-tables.js";
import { buildDataset } from "../sandbox/dataset.js";
import { numericPreflight } from "../sandbox/numeric-preflight.js";
import { validateAgainstPlan, validateEnvelope, validateMethodChoice, validateSubjectLabels } from "../sandbox/executor.js";
import { validateExplorationCoverage } from "../sandbox/exploration.js";
import { SANDBOX_LIMITS, type SandboxPlan } from "../sandbox/types.js";

const BOOT_MS = 180_000;
// A real newline, built from its code point rather than written as an
// escape. An escaped newline typed into a code-generating script has been
// turned into an actual line break six times in this project; a code point
// cannot be.
const NEWLINE = String.fromCharCode(10);
const vendored = existsSync(HARNESS_INDEX_URL);
const sandbox = createNodeSandbox();

afterAll(async () => {
  await sandbox.dispose();
});

const table = benchmarkPortfolio();
const built = buildDataset({ schema: table.schema, grids: table.grids });

/** Every gate the executor runs, in the order it runs them. */
async function gatesFor(plan: SandboxPlan, code: string): Promise<readonly string[]> {
  expect(built.ok).toBe(true);
  if (!built.ok) return ["the dataset did not build"];
  const outcome = await sandbox.runtime.execute(code, built.dataset);
  if (!outcome.ok) return [`the script did not run: ${outcome.error.code} ${outcome.error.message}`];
  return [
    ...validateEnvelope(outcome.result, SANDBOX_LIMITS),
    ...validateAgainstPlan(plan, outcome.result),
    ...validateMethodChoice(plan, outcome.result),
    ...validateExplorationCoverage(plan.explorationDimensions ?? [], outcome.result),
    ...validateSubjectLabels(plan, built.dataset, outcome.result),
  ];
}

const plan = (over: Partial<SandboxPlan>): SandboxPlan => ({
  objective: "group the products by how their sales move",
  datasetRefs: ["ds1"],
  requestedOutputs: [],
  ...over,
});

describe.skipIf(!vendored)("Stage 27 §29 — the gates admit correct work", () => {
  it(
    "hands the script prepared views that line up with the raw frame (§3/§4)",
    async () => {
      // The whole point of Stage 27.x, checked against the real runtime: the
      // split is right, the indexes align, and NOTHING was filled on the way.
      const code = [
        "import numpy as _np",
        "RESULT = {",
        "    'method': {'name': 'view_contract', 'parameters': {}, 'random_state': None},",
        "    'scalars': {",
        "        'numeric_column_count': float(len(numeric_columns)),",
        "        'entity_column_count': float(len(entity_columns)),",
        "        'rows_match': float(len(numeric_data) == len(data) == len(entity_data)),",
        "        'index_aligns': float(bool((numeric_data.index == data.index).all() and (entity_data.index == data.index).all())),",
        "        'x_is_float': float(X.dtype == _np.float64),",
        "        'gaps_preserved': float(_np.isnan(X).sum()),",
        "        'labels_excluded': float(all(c not in numeric_columns for c in entity_columns)),",
        "    },",
        "}",
      ].join("\n");
      expect(await gatesFor(plan({ requestedOutputs: [{ id: "a1", description: "contract", shape: "scalar" }] }), code)).toEqual([]);
    },
    BOOT_MS,
  );

  it(
    "refuses raw `data` handed to an estimator before it costs an execution (§6)",
    async () => {
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const bad = numericPreflight("from sklearn.cluster import KMeans\nKMeans(n_clusters=2).fit(data)", built.dataset);
      expect(bad?.code).toBe("NON_NUMERIC_FEATURE_INPUT");
      expect(bad?.repairHint).toContain("numeric_data");
      // Doing it the long way round is correct and must not be refused.
      expect(numericPreflight("KMeans(n_clusters=2).fit(data[numeric_columns])", built.dataset)).toBeNull();
      expect(numericPreflight("KMeans(n_clusters=2).fit(X)", built.dataset)).toBeNull();
      expect(numericPreflight("KMeans(n_clusters=2).fit(numeric_data)", built.dataset)).toBeNull();
    },
    BOOT_MS,
  );

  it(
    "accepts a clustering that excludes the rows with gaps and names its members",
    async () => {
      // The shape the prompt asks for: policy applied BEFORE fitting (§23),
      // seeded (§30), members labelled from the metric column (§18).
      const code = [
        "from sklearn.cluster import KMeans",
        "frame = data.set_index('metric')",
        "kept = frame.dropna()",
        "model = KMeans(n_clusters=2, n_init=10, random_state=0).fit(kept.values)",
        "groups = []",
        "for label in sorted(set(model.labels_)):",
        "    members = [str(i) for i, l in zip(kept.index, model.labels_) if l == label]",
        "    groups.append({'label': 'group_' + str(label + 1), 'members': members,",
        "                   'profile': {'mean_level': float(kept.loc[members].values.mean())}})",
        "RESULT = {",
        "    'method': {'name': 'kmeans', 'parameters': {'n_clusters': 2}, 'random_state': 0},",
        "    'groups': groups,",
        "    'preprocessing': {'missingValuePolicy': {'method': 'exclude',",
        "        'rationale': 'rows with unobserved months cannot be placed',",
        "        'affectedRows': int(len(frame) - len(kept)), 'affectedColumns': []}},",
        "}",
      ].join("\n");
      expect(await gatesFor(plan({ requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }] }), code)).toEqual([]);
    },
    BOOT_MS,
  );

  it(
    "accepts an exploration that reports a dimension where it found nothing",
    async () => {
      const code = [
        "frame = data.set_index('metric')",
        "findings = []",
        "for name, row in frame.iterrows():",
        "    gaps = int(row.isna().sum())",
        "    if gaps:",
        "        findings.append({'kind': 'data_quality', 'subject': str(name),",
        "                         'values': {'missingCount': gaps, 'share': gaps / len(row)}})",
        "std = frame.std(axis=1, skipna=True)",
        "worst = std.idxmax()",
        "findings.append({'kind': 'volatility', 'subject': str(worst),",
        "                 'values': {'standardDeviation': float(std.max()), 'mean': float(frame.loc[worst].mean())}})",
        "# §37 — a dimension that found nothing still reports.",
        "findings.append({'kind': 'anomalies', 'subject': '', 'values': {'count': 0}})",
        "RESULT = {",
        "    'method': {'name': 'descriptive_scan', 'parameters': {}, 'random_state': None},",
        "    'tables': {'gap_counts': frame.isna().sum(axis=1).to_frame('missing')},",
        "    'findings': findings,",
        "    'preprocessing': {'missingValuePolicy': {'method': 'exclude', 'rationale': 'gaps are counted, never filled',",
        "        'affectedRows': int(frame.isna().any(axis=1).sum()), 'affectedColumns': []}},",
        "}",
      ].join("\n");
      const p = plan({
        objective: "find what is notable",
        requestedOutputs: [{ id: "a1", description: "what stands out", shape: "table" }],
        explorationDimensions: ["data_quality", "volatility", "anomalies"],
      });
      expect(await gatesFor(p, code)).toEqual([]);
    },
    BOOT_MS,
  );

  it(
    "accepts a two-method comparison backed by measured numbers",
    async () => {
      const code = [
        "from sklearn.cluster import KMeans, AgglomerativeClustering",
        "from sklearn.metrics import silhouette_score",
        "frame = data.set_index('metric').dropna()",
        "X = frame.values",
        "km = KMeans(n_clusters=2, n_init=10, random_state=0).fit(X)",
        "ag = AgglomerativeClustering(n_clusters=2).fit(X)",
        "s_km = float(silhouette_score(X, km.labels_))",
        "s_ag = float(silhouette_score(X, ag.labels_))",
        "best, labels = ('kmeans', km.labels_) if s_km >= s_ag else ('agglomerative', ag.labels_)",
        "groups = []",
        "for label in sorted(set(labels)):",
        "    members = [str(i) for i, l in zip(frame.index, labels) if l == label]",
        "    groups.append({'label': 'group_' + str(label + 1), 'members': members, 'profile': {}})",
        "RESULT = {",
        "    'method': {'name': best, 'parameters': {'n_clusters': 2}, 'random_state': 0},",
        "    'groups': groups,",
        "    'method_comparison': {",
        "        'methods': [{'name': 'kmeans', 'parameters': {'n_clusters': 2}, 'metrics': {'silhouette': s_km}, 'warnings': []},",
        "                    {'name': 'agglomerative', 'parameters': {'n_clusters': 2}, 'metrics': {'silhouette': s_ag}, 'warnings': []}],",
        "        'selected': best,",
        "        'selection_criteria': ['separation'],",
        "        'selection_evidence': {'separation': max(s_km, s_ag)},",
        "    },",
        "    'preprocessing': {'missingValuePolicy': {'method': 'exclude', 'rationale': 'gaps cannot be clustered',",
        "        'affectedRows': 1, 'affectedColumns': []}},",
        "}",
      ].join("\n");
      const p = plan({
        requestedOutputs: [{ id: "a1", description: "segments", shape: "groups" }],
        methodConstraints: ["kmeans", "agglomerative"],
      });
      expect(await gatesFor(p, code)).toEqual([]);
    },
    BOOT_MS,
  );

  it(
    "unwraps a single nested envelope, and refuses to guess between two (§36)",
    async () => {
      // Stage 27.x.1 §36 — the analysis computed the right number and wrapped
      // it. Collecting that as-is yields an empty envelope, the coverage check
      // reports "did not return the requested scalar", and a whole code
      // generation is spent re-deriving a value that was already correct.
      //
      // Unwrapped only when the choice is FORCED — the outer dict names
      // nothing the envelope knows, and exactly one of its values does.
      const wrapped = [
        "frame = data.set_index('metric')",
        "RESULT = {'analysis': {",
        "    'method': {'name': 'column_total', 'parameters': {}, 'random_state': None},",
        "    'scalars': {'december_total': float(frame['Дек'].dropna().sum())},",
        "}}",
      ].join(NEWLINE);
      expect(await gatesFor(plan({ requestedOutputs: [{ id: "a1", description: "the December total", shape: "scalar" }] }), wrapped)).toEqual([]);

      // Two candidates is a judgement, and a judgement belongs in the repair
      // loop. This one stays refused, which is the correct outcome.
      const ambiguous = [
        "frame = data.set_index('metric')",
        "RESULT = {",
        "    'first': {'scalars': {'a': float(frame['Дек'].dropna().sum())}},",
        "    'second': {'scalars': {'b': 1.0}},",
        "}",
      ].join(NEWLINE);
      const problems = await gatesFor(plan({ requestedOutputs: [{ id: "a1", description: "the December total", shape: "scalar" }] }), ambiguous);
      expect(problems.length).toBeGreaterThan(0);
    },
    BOOT_MS,
  );

  it(
    "keeps the pandas/numpy boundary before it costs an execution (§4/§6)",
    async () => {
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      // The regression Stage 27.x caused: prepared views made X discoverable
      // and DataFrame methods started landing on it.
      expect(numericPreflight("X.fillna(0)", built.dataset)?.code).toBe("PANDAS_METHOD_ON_NDARRAY");
      expect(numericPreflight("kept = X[numeric_data['Дек'] > 0]", built.dataset)?.code).toBe("PANDAS_MASK_ON_NDARRAY");
      // And the numpy that must keep working, checked against the real
      // runtime rather than against my belief about numpy's API.
      const code = [
        "import numpy as _np",
        "clean = numeric_data.dropna()",
        "M = clean.to_numpy()",
        "RESULT = {",
        "    'method': {'name': 'array_ops', 'parameters': {}, 'random_state': None},",
        "    'scalars': {",
        "        'column_means_finite': float(_np.isfinite(X.mean(axis=0)).sum()),",
        "        'row_spread': float(M.std(axis=1).mean()),",
        "        'first_column_len': float(len(X[:, 0])),",
        "        'gaps': float(_np.isnan(X).sum()),",
        "    },",
        "}",
      ].join(NEWLINE);
      expect(numericPreflight(code, built.dataset)).toBeNull();
      expect(await gatesFor(plan({ requestedOutputs: [{ id: "a1", description: "array checks", shape: "scalar" }] }), code)).toEqual([]);
    },
    BOOT_MS,
  );

  it(
    "accepts a scalar named for what it holds",
    async () => {
      const code = [
        "frame = data.set_index('metric')",
        "december = frame['Дек'].dropna()",
        "RESULT = {",
        "    'method': {'name': 'column_total', 'parameters': {}, 'random_state': None},",
        "    'scalars': {'december_total': float(december.sum())},",
        "    'preprocessing': {'missingValuePolicy': {'method': 'exclude', 'rationale': 'unobserved months are not zero',",
        "        'affectedRows': int(frame['Дек'].isna().sum()), 'affectedColumns': ['Дек']}},",
        "}",
      ].join("\n");
      expect(await gatesFor(plan({ requestedOutputs: [{ id: "a1", description: "the December total", shape: "scalar" }] }), code)).toEqual([]);
    },
    BOOT_MS,
  );
});

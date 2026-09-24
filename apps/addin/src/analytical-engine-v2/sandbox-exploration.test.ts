import { describe, expect, it } from "vitest";
import {
  dimensionFindingType,
  dimensionLabel,
  readDimension,
  validateExplorationCoverage,
  EXPLORATION_BOUNDS,
  EXPLORATION_DIMENSIONS,
  type ExplorationDimension,
} from "./sandbox/exploration.js";
import { buildCodeMessages } from "./sandbox/code-generator.js";
import { parsePlannerDecision, plannerSystemPrompt } from "./planner/planner-prompt.js";
import { storeSandboxResult } from "./sandbox/result-adapter.js";
import { ResultStore } from "./results/result-store.js";
import { extractFindings } from "./insight/extract-findings.js";
import { statementFor } from "./insight/statement.js";
import { measureWord } from "./insight/measure-words.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import type { CellValue } from "@sheet-agent/application";
import type { FindingCandidate, SandboxDataset, SandboxPlan, SandboxResult } from "./sandbox/types.js";

// --- fixtures ---------------------------------------------------------------

function dataset(): SandboxDataset {
  return {
    datasetId: "ds1",
    tableRef: "S!A1:C3",
    sheet: "S",
    sourceRange: "S!A1:C3",
    freshnessToken: "v1",
    columns: [
      { name: "metric", semanticType: "metric_label", missingCount: 0, zeroCount: 0 },
      { name: "Jan", semanticType: "amount", missingCount: 1, zeroCount: 0 },
    ],
    rows: [["a", 1] as readonly CellValue[], ["b", null] as readonly CellValue[]],
  };
}

function plan(dimensions: readonly ExplorationDimension[]): SandboxPlan {
  return {
    objective: "find what is notable in this table",
    datasetRefs: ["ds1"],
    requestedOutputs: [{ id: "a1", description: "what stands out", shape: "table" }],
    explorationDimensions: dimensions,
  };
}

const candidate = (kind: string, subject: string, values: Record<string, number>): FindingCandidate => ({ kind, subject, values });

function result(candidates: readonly FindingCandidate[]): SandboxResult {
  return {
    executionId: "exec_1",
    status: "ok",
    tables: [{ name: "summary", columns: ["metric", "value"], rows: [["a", 1]] }],
    scalars: {},
    series: [],
    groups: [],
    models: [],
    diagnostics: {},
    findingsCandidates: candidates,
    warnings: [],
    artifacts: [],
    sourceLineage: { datasetIds: ["ds1"], sheet: "S", sourceRange: "S!A1:C3", freshnessToken: "v1" },
  };
}

const store = (): ResultStore => new ResultStore("S!A1:C3", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });

const ctx = () => {
  const table = fixtureOperations();
  return { schema: table.schema, grids: table.grids, locale: "ru" as const };
};

// --- §36: an open-ended request is planned, not pattern-matched -------------

describe("Stage 27 §36 — open-ended requests get a plan", () => {
  it("offers the dimensions to the planner instead of choosing for it", () => {
    const prompt = plannerSystemPrompt(true);
    expect(prompt).toContain("OPEN-ENDED");
    for (const dimension of EXPLORATION_DIMENSIONS) expect(prompt).toContain(dimension);
    // §36/§4 — the engine must not contain the phrases themselves as triggers.
    // They appear in the prompt as EXAMPLES for a model to generalise from,
    // and nowhere as a condition anything branches on.
    expect(prompt).toContain("исследуй таблицу");
  });

  it("tells the planner to choose dimensions the schema can actually support", () => {
    expect(plannerSystemPrompt(true)).toContain("no `relationships` with one numeric column");
  });

  it("says nothing about exploration when there is no sandbox", () => {
    const prompt = plannerSystemPrompt(false);
    expect(prompt).not.toContain("OPEN-ENDED");
    // The multi-word dimension names only: "changes" and "trends" are ordinary
    // English and could reasonably appear in the base prompt one day, whereas
    // "data_quality" can only have come from here.
    for (const dimension of EXPLORATION_DIMENSIONS.filter((d) => d.includes("_"))) expect(prompt).not.toContain(dimension);
  });
});

// --- §38: bounded ----------------------------------------------------------

describe("Stage 27 §38 — exploration is bounded by its plan", () => {
  const decision = (exploration: readonly string[]): string =>
    JSON.stringify({
      kind: "analyze",
      objective: "find what is notable",
      requestedOutputs: [{ id: "a1", description: "what stands out", shape: "table" }],
      exploration,
      necessity: "OPEN_ENDED_EXPLORATION",
    });

  it("accepts a plan within the ceiling", () => {
    const parsed = parsePlannerDecision(decision(["data_quality", "changes", "volatility", "anomalies"]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.decision.kind).toBe("analyze");
    if (parsed.decision.kind !== "analyze") return;
    expect(parsed.decision.exploration).toEqual(["data_quality", "changes", "volatility", "anomalies"]);
  });

  it("trims a plan over the ceiling instead of refusing it", () => {
    // §38's bound is enforced — but by TRIMMING. Refusing was tried against the
    // live model: the planner over-specified the other field on its next
    // attempt, the two rejections together spent the per-turn correction
    // budget, and both open-ended questions died having produced nothing. The
    // dimensions listed FIRST are the ones the planner thought mattered most.
    const seven = [...EXPLORATION_DIMENSIONS].slice(0, 7);
    expect(seven).toHaveLength(7);
    const parsed = parsePlannerDecision(decision(seven));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.decision.kind !== "analyze") return;
    expect(parsed.decision.exploration).toHaveLength(EXPLORATION_BOUNDS.max);
    expect(parsed.decision.exploration).toEqual(seven.slice(0, EXPLORATION_BOUNDS.max));
    expect(parsed.decision.explorationDropped).toEqual(seven.slice(EXPLORATION_BOUNDS.max));
  });

  it("refuses a dimension that is not one of the named ones", () => {
    const parsed = parsePlannerDecision(decision(["data_quality", "whatever_looks_fun"]));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem.correction).toContain("data_quality");
  });

  it("does not refuse a small exploration for being small", () => {
    // §38's floor is advice. A two-column table has little to look at, and
    // failing the turn over it would be the system serving its own rule.
    const parsed = parsePlannerDecision(decision(["data_quality"]));
    expect(parsed.ok).toBe(true);
  });

  it("folds a repeated dimension rather than counting it twice", () => {
    const parsed = parsePlannerDecision(decision(["anomalies", "outliers", "anomalies"]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.decision.kind !== "analyze") return;
    expect(parsed.decision.exploration).toEqual(["anomalies"]);
  });
});

// --- §37: every planned dimension is reported on ---------------------------

describe("Stage 27 §37 — a dimension that was planned is answered", () => {
  it("refuses a result that quietly skipped a dimension", () => {
    const problems = validateExplorationCoverage(
      ["data_quality", "anomalies", "relationships"],
      result([candidate("data_quality", "Jan", { missingCount: 1 })]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("anomalies");
    expect(problems[0]).toContain("relationships");
    expect(problems[0]).toContain("including when there was nothing to report");
  });

  it("accepts a dimension that reports having found nothing", () => {
    // This is the distinction the whole section turns on: an examined-and-
    // clean dimension is covered, and it looks different from an absent one.
    const problems = validateExplorationCoverage(
      ["data_quality", "anomalies"],
      result([candidate("data_quality", "Jan", { missingCount: 1 }), candidate("anomalies", "", { count: 0 })]),
    );
    expect(problems).toEqual([]);
  });

  it("accepts the dimension under a name the model was likely to use", () => {
    const problems = validateExplorationCoverage(["anomalies", "relationships"], result([candidate("outliers", "a", { zScore: 3.1 }), candidate("correlation", "a", { correlation: 0.8 })]));
    expect(problems).toEqual([]);
  });

  it("checks nothing when the analysis was not an exploration", () => {
    expect(validateExplorationCoverage([], result([]))).toEqual([]);
  });
});

// --- §14: what the generated code is asked for ------------------------------

describe("Stage 27 §14/§37 — the exploration brief", () => {
  const brief = (dimensions: readonly ExplorationDimension[]): string =>
    buildCodeMessages({ plan: plan(dimensions), dataset: dataset(), attempt: 1 })
      .map((m) => m.content)
      .join("\n");

  it("asks for exactly the planned dimensions and no others", () => {
    const text = brief(["data_quality", "anomalies"]);
    expect(text).toContain("EXPLORE THESE, AND ONLY THESE");
    expect(text).toContain("data_quality:");
    expect(text).toContain("anomalies:");
    expect(text).not.toContain("relationships:");
  });

  it("requires a report even from a dimension that found nothing", () => {
    expect(brief(["anomalies"])).toContain("A dimension you leave out reads as");
  });

  it("prescribes the value names the report is built from", () => {
    // §43 — a change reported under a name nothing recognises narrates as a
    // bare number, so the canonical names are part of the contract.
    const text = brief(["changes"]);
    expect(text).toContain("absoluteChange");
    expect(text).toContain("percentageChange");
  });

  it("does not let the code decide what matters", () => {
    // §28/§39 — ranking the dimensions is an editorial judgement, and the
    // insight layer makes it from measured materiality.
    expect(brief(["changes", "anomalies"])).toContain("Do not rank the dimensions");
  });

  it("says nothing about exploration for an ordinary analysis", () => {
    const text = buildCodeMessages({ plan: { objective: "cluster", datasetRefs: ["ds1"], requestedOutputs: [{ id: "a1", description: "groups", shape: "groups" }] }, dataset: dataset(), attempt: 1 })
      .map((m) => m.content)
      .join("\n");
    expect(text).not.toContain("EXPLORE THESE");
  });
});

// --- §32/§37: each dimension becomes its own result ------------------------

describe("Stage 27 §32/§37 — dimensions are stored separately", () => {
  const explored = () =>
    storeSandboxResult({
      store: store(),
      plan: plan(["data_quality", "anomalies", "relationships"]),
      result: result([
        candidate("data_quality", "Jan", { missingCount: 1, share: 0.5 }),
        candidate("anomalies", "Defect ratio", { zScore: 3.4 }),
        candidate("anomalies", "Queue depth", { zScore: 2.6 }),
        candidate("relationships", "Throughput index", { correlation: 0.82, n: 12 }),
      ]),
      code: "RESULT = {}",
      codeHash: "h",
      attempts: 1,
    });

  it("gives every dimension its own addressable result", () => {
    const stored = explored();
    const names = stored.all.map((r) => r.metadata["outputName"]);
    expect(names).toContain("exploration:data_quality");
    expect(names).toContain("exploration:anomalies");
    expect(names).toContain("exploration:relationships");
    // Both anomalies land in one result, not one result each.
    const anomalies = stored.all.find((r) => r.metadata["explorationDimension"] === "anomalies");
    expect(anomalies?.rows).toHaveLength(2);
  });

  it("leads with the dimension the planner named first, not the biggest number", () => {
    // §39 — the order of an exploration is the plan's. Letting the data pick
    // the lead is how "исследуй таблицу" becomes "here is the largest number".
    expect(explored().primary.metadata["explorationDimension"]).toBe("data_quality");
  });

  it("ignores a candidate whose kind is not a dimension", () => {
    const stored = storeSandboxResult({
      store: store(),
      plan: plan(["anomalies"]),
      result: result([candidate("vibes", "a", { x: 1 }), candidate("anomalies", "b", { zScore: 3 })]),
      code: "c",
      codeHash: "h",
      attempts: 1,
    });
    expect(stored.all.filter((r) => r.metadata["explorationDimension"] !== undefined)).toHaveLength(1);
  });
});

// --- §43/§58: it reads like an analyst, not like a result store ------------

describe("Stage 27 §43/§58 — exploration findings become sentences", () => {
  function sentencesFor(candidates: readonly FindingCandidate[], dimensions: readonly ExplorationDimension[]): readonly string[] {
    const stored = storeSandboxResult({ store: store(), plan: plan(dimensions), result: result(candidates), code: "c", codeHash: "h", attempts: 1 });
    return stored.all
      .filter((r) => r.metadata["explorationDimension"] !== undefined)
      .flatMap((r) => extractFindings(r, ctx()))
      .map((f) => statementFor(f, "ru"));
  }

  it("names the measure in words and never by its key", () => {
    const [sentence] = sentencesFor([candidate("anomalies", "Defect ratio", { zScore: 3.4 })], ["anomalies"]);
    expect(sentence).toContain("Defect ratio");
    expect(sentence).toContain("отклонение от среднего");
    expect(sentence).not.toContain("zScore");
    expect(sentence).not.toMatch(/[a-z]+[A-Z]/);
  });

  it("says a clean dimension is clean", () => {
    const sentences = sentencesFor([candidate("data_quality", "", { missingCount: 0 })], ["data_quality"]);
    expect(sentences.join(" ")).toContain("Пропусков");
  });

  it("describes a relationship without turning it into a cause", () => {
    const [sentence] = sentencesFor([candidate("relationships", "Throughput index", { correlation: 0.82, n: 12 })], ["relationships"]);
    expect(sentence).toContain("коэффициент корреляции");
    // §49/§94 — the sentence carries its own disclaimer, so a narrator that
    // shortens it still cannot promote a co-movement into a dependency.
    expect(sentence).toContain("не установленная зависимость");
    expect(sentence).not.toMatch(/из-за|влияет|вызвано|причин/i);
  });

  it("states a number it cannot name, rather than printing the name", () => {
    // §43 — an unrecognised measure must not reach a reader as a key. The
    // sentence gets thinner; it does not get a machine name in it.
    const [sentence] = sentencesFor([candidate("anomalies", "Queue depth", { mahalanobis_v2: 4.1 })], ["anomalies"]);
    expect(sentence).not.toContain("mahalanobis");
    expect(sentence).toContain("Queue depth");
    expect(measureWord("mahalanobis_v2", "ru")).toBeNull();
  });

  it("reads a changes dimension as a change and not as a score", () => {
    const [sentence] = sentencesFor(
      [candidate("changes", "Defect ratio", { startValue: 100, endValue: 160, absoluteChange: 60, percentageChange: 0.6 })],
      ["changes"],
    );
    expect(sentence).toMatch(/рост|вырос|увелич/i);
    expect(sentence).not.toContain("absoluteChange");
  });
});

// --- the vocabulary itself --------------------------------------------------

describe("Stage 27 §37 — the dimension vocabulary", () => {
  it("gives every dimension a finding type that already has a template", () => {
    for (const dimension of EXPLORATION_DIMENSIONS) {
      const type = dimensionFindingType(dimension);
      expect(type).toBeTruthy();
      expect(dimensionLabel(dimension, "ru")).not.toContain("_");
      expect(dimensionLabel(dimension, "en")).not.toContain("_");
    }
  });

  it("reads the spellings a model actually writes", () => {
    expect(readDimension("outliers")).toBe("anomalies");
    expect(readDimension("Data Quality")).toBe("data_quality");
    expect(readDimension("correlation")).toBe("relationships");
    expect(readDimension("everything")).toBeNull();
  });
});

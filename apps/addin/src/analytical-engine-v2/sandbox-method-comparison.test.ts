// ---------------------------------------------------------------------------
// Stage 27 §18/§19/§20/§21 — several methods, and an honest reason for one.
//
// The failure these guard against is not a crash. It is an analysis that reads
// beautifully — "я попробовал k-means и иерархическую кластеризацию; вторая
// оказалась интерпретируемее" — where only one method ever ran and
// "интерпретируемее" means nothing that could be checked. Every test here is
// an attempt to write exactly that and be refused.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { executeAnalysis, validateMethodChoice, type AnalyticalRuntime } from "./sandbox/executor.js";
import { buildCodeMessages } from "./sandbox/code-generator.js";
import {
  criterionLabel,
  executedMethods,
  readCriterion,
  validateMethodComparison,
  SELECTION_CRITERIA,
  type ComparedMethod,
  type MethodComparison,
} from "./sandbox/method-comparison.js";
import { methodNoteFor } from "./narration/method-note.js";
import { storeSandboxResult } from "./sandbox/result-adapter.js";
import { ResultStore } from "./results/result-store.js";
import { buildNarratorMessages, gateNarration, type NarrationInput } from "./narration/narrator.js";
import type { ExecuteOutcome } from "./sandbox/pyodide-runtime.js";
import type { SandboxDataset, SandboxPlan, SandboxResult } from "./sandbox/types.js";
import type { EngineResult } from "./types.js";

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
      { name: "Jan", semanticType: "amount", missingCount: 0, zeroCount: 0 },
    ],
    rows: [["a", 1] as readonly CellValue[], ["b", 2] as readonly CellValue[]],
  };
}

function plan(methods: readonly string[] = []): SandboxPlan {
  return {
    objective: "segment the metrics by the shape of their monthly dynamics",
    datasetRefs: ["ds1"],
    requestedOutputs: [{ id: "o1", description: "the segments", shape: "groups" }],
    ...(methods.length > 0 ? { methodConstraints: methods } : {}),
  };
}

function method(name: string, metrics: Record<string, number>): ComparedMethod {
  return { name, parameters: { random_state: 0 }, metrics, warnings: [] };
}

function comparison(overrides: Partial<MethodComparison> = {}): MethodComparison {
  return {
    methods: [method("k-means", { silhouette: 0.62, n_clusters: 3 }), method("agglomerative (ward)", { silhouette: 0.48, n_clusters: 3 })],
    selectedMethod: "k-means",
    selectionCriteria: ["separation"],
    selectionEvidence: {},
    ...overrides,
  };
}

function result(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    executionId: "exec_1",
    status: "ok",
    tables: [],
    scalars: {},
    series: [],
    groups: [{ label: "стабильные", members: ["a", "b"], profile: { mean: 1.5 } }],
    models: [],
    diagnostics: {},
    findingsCandidates: [],
    warnings: [],
    artifacts: [],
    sourceLineage: { datasetIds: ["ds1"], sheet: "S", sourceRange: "S!A1:C3", freshnessToken: "v1" },
    ...overrides,
  };
}

function fakeRuntime(outcomes: readonly ExecuteOutcome[]): AnalyticalRuntime {
  let i = 0;
  return {
    hardTimeout: true,
    validate: async () => [],
    execute: async () => {
      const next = outcomes[Math.min(i, outcomes.length - 1)]!;
      i += 1;
      return next;
    },
  };
}

const ok = (r: SandboxResult): ExecuteOutcome => ({ ok: true, result: r, stdout: "", durationMs: 1 });

// --- §19: several methods must actually run ---------------------------------

describe("Stage 27 §19 — trying several methods means running them", () => {
  it("refuses a two-method plan that came back with no comparison at all", () => {
    const problems = validateMethodChoice(plan(["k-means", "hierarchical clustering"]), result());
    expect(problems).toHaveLength(1);
    // The repair message has to name what was promised, or the generator is
    // being told it failed without being told at what.
    expect(problems[0]).toContain("k-means");
    expect(problems[0]).toContain("hierarchical clustering");
    expect(problems[0]).toContain("method_comparison");
  });

  it("does not demand a comparison when only one method was planned", () => {
    expect(validateMethodChoice(plan(["k-means"]), result())).toEqual([]);
    expect(validateMethodChoice(plan(), result())).toEqual([]);
  });

  it("rejects a method that was named but never measured", () => {
    // This is the §19 violation in its natural habitat: the second method is
    // present in the structure, sounds considered, and has no numbers.
    const mentioned: ComparedMethod = { name: "hierarchical", parameters: {}, metrics: {}, warnings: ["would also be reasonable here"] };
    const problems = validateMethodComparison(comparison({ methods: [method("k-means", { silhouette: 0.62 }), mentioned] }));
    expect(problems.join(" ")).toContain("named without a single measurement");
    expect(executedMethods(comparison({ methods: [method("k-means", { silhouette: 0.62 }), mentioned] }))).toHaveLength(1);
  });

  it("does not count a NaN metric as a measurement", () => {
    const broken = method("hierarchical", { silhouette: Number.NaN });
    const problems = validateMethodComparison(comparison({ methods: [method("k-means", { silhouette: 0.62 }), broken] }));
    expect(problems.join(" ")).toContain("reported any metrics");
  });

  it("accepts two methods that each measured something", () => {
    expect(validateMethodComparison(comparison())).toEqual([]);
    expect(validateMethodChoice(plan(["k-means", "hierarchical clustering"]), result({ methodComparison: comparison() }))).toEqual([]);
  });
});

// --- §20: the comparison must be internally coherent ------------------------

describe("Stage 27 §20 — the comparison structure", () => {
  it("rejects a selection that names a method which did not run", () => {
    const problems = validateMethodComparison(comparison({ selectedMethod: "dbscan" }));
    expect(problems.join(" ")).toContain("not among the methods that ran");
  });

  it("rejects a selection with no stated grounds", () => {
    const problems = validateMethodComparison(comparison({ selectionCriteria: [] }));
    expect(problems.join(" ")).toContain("no criteria");
  });
});

// --- §21: "most interpretable" is not a reason ------------------------------

describe("Stage 27 §21 — the grounds must be observable", () => {
  it("refuses interpretability as a criterion, and says what is allowed instead", () => {
    // The single most important assertion in this file. §21 exists because
    // "interpretability" is the word a model reaches for when it has not
    // measured anything, and it must not be quietly translated into a
    // criterion the analysis never computed.
    const problems = validateMethodComparison(comparison({ selectionCriteria: ["interpretability"] as never }));
    expect(problems.join(" ")).toContain("not an observable selection criterion");
    expect(problems.join(" ")).toContain("separation");
    expect(readCriterion("interpretability")).toBeNull();
  });

  it.each(["elegance", "makes more sense", "business_fit", "cleaner", "the model preferred it"])("refuses %s", (word) => {
    expect(readCriterion(word)).toBeNull();
  });

  it("accepts the measure as a name for the thing it measures", () => {
    // `silhouette` is a metric, not a criterion — but a model that writes it
    // has named something real, so it resolves rather than failing.
    expect(readCriterion("silhouette")).toBe("separation");
    expect(readCriterion("Silhouette")).toBe("separation");
    expect(readCriterion("n clusters")).toBe("parsimony");
    expect(validateMethodComparison(comparison({ selectionCriteria: ["silhouette"] as never }))).toEqual([]);
  });

  it("requires a number behind each criterion that was declared", () => {
    // Separation is measured (silhouette is in the metrics); stability is not.
    const problems = validateMethodComparison(comparison({ selectionCriteria: ["separation", "stability"] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stability");
    expect(problems[0]).toContain("selection_evidence");
  });

  it("accepts a criterion evidenced from selection_evidence rather than the metrics", () => {
    const problems = validateMethodComparison(
      comparison({ selectionCriteria: ["separation", "stability"], selectionEvidence: { adjusted_rand_across_seeds: 0.91 } }),
    );
    expect(problems).toEqual([]);
  });

  it("does not let an unrelated number stand in for a criterion", () => {
    // `parameters` must not satisfy `parsimony`, and `sharpe` must not satisfy
    // `significance` — short keywords match whole tokens only.
    const problems = validateMethodComparison(
      comparison({ selectionCriteria: ["parsimony"], methods: [method("a", { parameters_count: 4 }), method("b", { parameters_count: 9 })], selectedMethod: "a" }),
    );
    expect(problems.join(" ")).toContain("parsimony");
  });

  it("checks a comparison nobody asked for", () => {
    // §21 does not become optional because the plan named one method.
    const problems = validateMethodChoice(plan(["k-means"]), result({ methodComparison: comparison({ selectionCriteria: ["interpretability"] as never }) }));
    expect(problems.join(" ")).toContain("not an observable selection criterion");
  });

  it("gives every criterion a phrase a person could read", () => {
    for (const criterion of SELECTION_CRITERIA) {
      expect(criterionLabel(criterion, "ru").length).toBeGreaterThan(8);
      expect(criterionLabel(criterion, "en").length).toBeGreaterThan(8);
      // §18 — the enum spelling itself may never reach a reader.
      expect(criterionLabel(criterion, "ru")).not.toContain("_");
      expect(criterionLabel(criterion, "en")).not.toContain("_");
    }
  });
});

// --- §19/§66: the repair loop carries the objection back --------------------

describe("Stage 27 §19/§66 — repairing a comparison that was only asserted", () => {
  it("fails the first attempt, then accepts the run that actually compared", async () => {
    const requests: number[] = [];
    const outcome = await executeAnalysis({
      runtime: fakeRuntime([ok(result()), ok(result({ methodComparison: comparison() }))]),
      plan: plan(["k-means", "hierarchical clustering"]),
      dataset: dataset(),
      currentSourceVersion: () => "v1",
      generate: async (request) => {
        requests.push(request.attempt);
        // §66 — the second attempt is told precisely what was missing.
        if (request.attempt === 2) {
          expect(request.failure?.code).toBe("INVALID_RESULT");
          expect(request.failure?.repairHint).toContain("method_comparison");
        }
        return "RESULT = {}";
      },
    });
    expect(requests).toEqual([1, 2]);
    expect(outcome.ok).toBe(true);
  });

  it("gives up rather than accepting one method dressed as three", async () => {
    // §67 — three attempts that never compare anything end the analysis. The
    // single method that DID run is not offered as though it were the answer
    // to "попробуй несколько способов".
    const outcome = await executeAnalysis({
      runtime: fakeRuntime([ok(result())]),
      plan: plan(["k-means", "hierarchical clustering", "rule-based"]),
      dataset: dataset(),
      currentSourceVersion: () => "v1",
      generate: async () => "RESULT = {}",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INVALID_RESULT");
      expect(outcome.attempts).toBe(3);
    }
  });
});

// --- §14: what the generator is told ----------------------------------------

describe("Stage 27 §14/§19 — the code-generation contract", () => {
  const messagesFor = (methods: readonly string[]): string =>
    buildCodeMessages({ plan: plan(methods), dataset: dataset(), attempt: 1 })
      .map((m) => m.content)
      .join("\n");

  it("spells out the comparison contract only when several methods are planned", () => {
    const many = messagesFor(["k-means", "hierarchical clustering"]);
    expect(many).toContain("ACTUALLY RUN EACH ONE");
    expect(many).toContain("method_comparison");
    expect(many).toContain("selection_evidence");

    const one = messagesFor(["k-means"]);
    expect(one).toContain("k-means");
    expect(one).not.toContain("method_comparison");
  });

  it("quotes the criteria vocabulary rather than describing it", () => {
    const many = messagesFor(["k-means", "dbscan"]);
    for (const criterion of SELECTION_CRITERIA) expect(many).toContain(criterion);
    // And names the words it will refuse, where the model can see them.
    expect(many).toContain('"interpretability"');
  });
});

// --- §20/§32: the comparison is an ordinary, addressable result -------------

describe("Stage 27 §20/§32 — the comparison in the result store", () => {
  const store = (): ResultStore => new ResultStore("S!A1:C3", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });

  it("stores it as a table of method against measurement", () => {
    const stored = storeSandboxResult({
      store: store(),
      plan: plan(["k-means", "hierarchical clustering"]),
      result: result({ methodComparison: comparison() }),
      code: "RESULT = {}",
      codeHash: "abc",
      attempts: 1,
    });
    const table = stored.all.find((r) => r.metadata?.["outputName"] === "method_comparison");
    expect(table).toBeDefined();
    expect(table?.rows).toHaveLength(2);
    expect(table?.fields.map((f) => f.name)).toContain("silhouette");
    // The winner is marked in the data, not inferred later from the numbers.
    expect(table?.rows.map((r) => r[1])).toEqual(["yes", "no"]);
  });

  it("never makes the comparison the answer", () => {
    // §20 — it says how the answer was reached. The answer is the groups.
    const stored = storeSandboxResult({
      store: store(),
      plan: plan(["k-means", "hierarchical clustering"]),
      result: result({ methodComparison: comparison() }),
      code: "RESULT = {}",
      codeHash: "abc",
      attempts: 1,
    });
    expect(stored.primary.metadata?.["outputName"]).toBe("groups");
    expect(stored.method["methodComparison"]).toBeDefined();
  });
});

// --- §21/§60: what the reader is told ---------------------------------------

describe("Stage 27 §21/§60 — the method note", () => {
  const sandboxResult = (metadata: Record<string, unknown>): EngineResult =>
    ({ id: "r1", tool: "sandbox.k-means", type: "table", fields: [], rows: [], metricKeys: [], metadata } as unknown as EngineResult);

  it("says nothing at all about a deterministic answer", () => {
    expect(methodNoteFor(sandboxResult({}))).toBeUndefined();
    expect(methodNoteFor(sandboxResult({ method: "sum" }))).toBeUndefined();
  });

  it("carries the method, the preprocessing and the comparison", () => {
    const note = methodNoteFor(
      sandboxResult({
        sandbox: true,
        method: "k-means",
        methodComparison: comparison(),
        preprocessing: { missingValuePolicy: { method: "exclude", rationale: "two products have no January", affectedRows: 2 }, scaling: "z-score" },
      }),
    );
    expect(note?.name).toBe("k-means");
    expect(note?.comparison?.selectedMethod).toBe("k-means");
    // §23/§24 — the gap policy leads, because it can change the conclusion.
    expect(note?.preprocessing?.[0]).toContain("exclude");
    expect(note?.preprocessing?.[0]).toContain("two products have no January");
  });

  it("survives a comparison that came back malformed", () => {
    // Generated Python produced this; a wrong shape must cost the note a line,
    // never the turn.
    const note = methodNoteFor(sandboxResult({ sandbox: true, method: "k-means", methodComparison: { methods: "k-means and one more" } }));
    expect(note?.name).toBe("k-means");
    expect(note?.comparison).toBeUndefined();
  });

  it("shows the narrator the criteria as words and never as field names", () => {
    const narration = narrationWith(comparison({ selectionCriteria: ["separation", "stability"], selectionEvidence: { rand_index: 0.91 } }));
    const prompt = buildNarratorMessages(narration)
      .map((m) => m.content)
      .join("\n");
    expect(prompt).toContain("отделены друг от друга");
    expect(prompt).not.toContain("profile_coherence");
    expect(prompt).not.toContain("selectionCriteria");
    expect(prompt).toContain("k-means");
    expect(prompt).toContain("agglomerative (ward)");
  });

  it("lets the answer cite a number it was shown, and still refuses an invented one", () => {
    // Both halves matter. Without the comparison in the fact gate the first
    // draft is rejected as unsourced and silently replaced by the fallback;
    // without the gate still applying, the second one reaches the reader.
    const narration = narrationWith(comparison());
    const shown = gateNarration("Из двух способов надёжнее разделил k-means (0,62 против 0,48).", narration);
    expect(shown.reasons).toEqual([]);
    expect(shown.usedFallback).toBe(false);

    const invented = gateNarration("Из двух способов надёжнее разделил k-means (0,99 против 0,11).", narration);
    expect(invented.usedFallback).toBe(true);
    expect(invented.reasons.join(" ")).toContain("0.99");
  });
});

/** A narration input whose primary came from a sandbox analysis. */
function narrationWith(cmp: MethodComparison): NarrationInput {
  const primary = {
    id: "r1",
    tool: "sandbox.k-means",
    type: "table",
    fields: [
      { name: "metric", kind: "metric" },
      { name: "group", kind: "text" },
    ],
    rows: [
      ["a", "стабильные"],
      ["b", "стабильные"],
    ],
    metricKeys: ["a", "b"],
    metadata: { sandbox: true, method: "k-means", methodComparison: cmp, groupCount: 2 },
  } as unknown as EngineResult;
  return {
    request: "Кластеризуй продукты и попробуй несколько способов",
    analysis: { primary, supporting: [], answerStyle: "explanatory" },
    findings: [],
    locale: "ru",
    method: methodNoteFor(primary)!,
  };
}

import { describe, expect, it } from "vitest";
import type { CellValue } from "@sheet-agent/application";
import { buildCodeMessages } from "./sandbox/code-generator.js";
import { validateSubjectLabels } from "./sandbox/executor.js";
import { EXPLORATION_BOUNDS } from "./sandbox/exploration.js";
import { METHOD_COMPARISON_BOUNDS } from "./sandbox/method-comparison.js";
import { classifyFailure, repairHintFor } from "./sandbox/failure-classes.js";
import { parsePlannerDecision, plannerSystemPrompt } from "./planner/planner-prompt.js";
import { errorLine as plannerErrorLine } from "./planner/planner-loop.js";
import { buildNarratorMessages, valueLabel } from "./narration/narrator.js";
import { readFileSync } from "node:fs";
import { extractFindings } from "./insight/extract-findings.js";
import { ResultStore } from "./results/result-store.js";
import { buildToolEnv, V2_TOOLS } from "./tools/registry.js";
import { unknownReference } from "./tools/contracts.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import { ENGINE_BOUNDS } from "./types.js";
import { describeAnswer } from "./harness/sandbox-scoring.js";
import type { SandboxDataset, SandboxPlan, SandboxResult } from "./sandbox/types.js";

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

const store = (): ResultStore => new ResultStore("S!A1:C4", "v1", { maxRowsPerResult: 200, maxResultCells: 3000 });

// --- 1. the label that became a subject -------------------------------------

describe("Stage 27 §18/§43 — a planner handle never becomes a name", () => {
  it("keeps output ids out of the code-generation prompt", () => {
    const user = buildCodeMessages({ plan: plan(), dataset: dataset(), attempt: 1 })[1]!.content;
    expect(user).toContain("movement per product");
    // The shape and the description are the contract; "a1" is bookkeeping.
    expect(user).not.toContain("a1");
  });

  it("states the naming rule the prompt used to contradict", () => {
    const system = buildCodeMessages({ plan: plan(), dataset: dataset(), attempt: 1 })[0]!.content;
    expect(system).toContain("NAMING");
    expect(system).toMatch(/never a row position|never "a1"/i);
  });

  it("refuses a result whose subjects are positions or handles", () => {
    const problems = validateSubjectLabels(
      plan(),
      dataset(),
      sandboxResult({
        scalars: { a1: 3665 },
        findingsCandidates: [{ kind: "anomalies", subject: "2-4", values: { zScore: 3.1 } }],
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"a1"');
    expect(problems[0]).toContain('"2-4"');
  });

  it("accepts every label the data actually carries", () => {
    // Entity labels, column names and period labels all pass — including the
    // ones that look numeric. "Дек" is a name, not a position, and so is a
    // column called "2024" in a table that has one.
    const problems = validateSubjectLabels(
      plan(),
      dataset(),
      sandboxResult({
        scalars: { december_total: 176 },
        groups: [{ label: "растущие", members: ["Обь", "Мезень"] }],
        findingsCandidates: [
          { kind: "anomalies", subject: "Ангара", values: { zScore: 2.4 } },
          { kind: "data_quality", subject: "Дек", values: { missingCount: 0 } },
          // §37 — the empty subject is how a dimension says it found nothing.
          { kind: "trends", subject: "", values: { count: 0 } },
        ],
      }),
    );
    expect(problems).toEqual([]);
  });

  it("calls out an enumerated run of bare integers", () => {
    const problems = validateSubjectLabels(
      plan(),
      dataset(),
      sandboxResult({
        findingsCandidates: [
          { kind: "anomalies", subject: "0", values: { zScore: 1 } },
          { kind: "anomalies", subject: "1", values: { zScore: 2 } },
          { kind: "anomalies", subject: "2", values: { zScore: 3 } },
        ],
      }),
    );
    expect(problems).toHaveLength(1);
  });

  it("refuses bare integers as subjects when the table has real names (OVERTURNED in 27.x.1)", () => {
    // This test used to assert the OPPOSITE — that "3" and "7" are left alone,
    // because cluster ids, bins and years look like this and a false repair
    // costs a whole code generation. A live validation run overturned it: the
    // analysis returned subjects «50», «80», «1000» — cell VALUES — and the
    // answer read «Значения "50" распределены довольно ровно».
    //
    // The three examples the old rule protected are all covered elsewhere: a
    // cluster id lives in group.label, which this function does not check; a
    // year is a period and is already known; a distribution over bins is a
    // table, not a per-subject finding. The old concern survives as the
    // narrowing below — see the next test.
    const problems = validateSubjectLabels(
      plan(),
      dataset(),
      sandboxResult({
        findingsCandidates: [
          { kind: "distributions", subject: "3", values: { median: 1 } },
          { kind: "distributions", subject: "7", values: { median: 2 } },
        ],
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("3");
  });

  it("still leaves them alone when the table offers no name to use instead", () => {
    // The surviving half of the overturned rule. With no label column there is
    // no better subject available, and refusing one would be exactly the false
    // repair the original decision warned about.
    const unlabelled: SandboxDataset = {
      ...dataset(),
      columns: dataset().columns.map((c) => ({ ...c, semanticType: "amount" as const })),
    };
    const problems = validateSubjectLabels(
      plan(),
      unlabelled,
      sandboxResult({
        findingsCandidates: [
          { kind: "distributions", subject: "3", values: { median: 1 } },
          { kind: "distributions", subject: "7", values: { median: 2 } },
        ],
      }),
    );
    expect(problems).toEqual([]);
  });

  it("does not mistake a real label that reads like a code", () => {
    const withCode: SandboxDataset = { ...dataset(), rows: [["A1", 5] as readonly CellValue[]] };
    // "A1" is an odd product name, but it IS the name in this table.
    expect(validateSubjectLabels(plan(), withCode, sandboxResult({ scalars: { A1: 5 } }))).toEqual([]);
  });
});

// --- 2. the measure name that became a word ---------------------------------

describe("Stage 27 §18/§43 — the narrator is never shown a machine measure name", () => {
  const narratorPrompt = (fields: readonly string[], row: readonly CellValue[]): string => {
    const s = store();
    const result = s.put({
      tool: "sandbox.gap_scan",
      type: "derived",
      fields: [{ name: "metric", kind: "metric" }, ...fields.map((name) => ({ name, kind: "number" as const }))],
      rows: [row],
      parents: [],
      metadata: { sandbox: true, explorationDimension: "data_quality" },
    });
    const findings = extractFindings(result, { schema: fixtureOperations().schema, grids: fixtureOperations().grids, locale: "ru" }, { role: "primary" });
    return buildNarratorMessages({
      request: "где пропуски?",
      analysis: { primary: result, supporting: [], answerStyle: "explanatory" },
      findings,
      locale: "ru",
    })[1]!.content;
  };

  it("drops a figure it has no word for rather than printing its key", () => {
    const prompt = narratorPrompt(["total_nans"], ["Мезень", 3]);
    expect(prompt).not.toContain("total_nans");
  });

  it("still offers the figures it CAN name", () => {
    const prompt = narratorPrompt(["missingCount"], ["Мезень", 3]);
    expect(prompt).toContain("не заполнено значений");
  });
  it("has a word for every measure the engine itself emits", () => {
    // A structural guard, not a spot check. `valueLabel` now DROPS a figure it
    // cannot name, which is right for a key some generated Python invented and
    // wrong for one this codebase writes on purpose: that one would silently
    // stop being offered to the narrator. The list is read out of
    // `extract-findings.ts` so adding a measure without a word fails here.
    const source = readFileSync("src/analytical-engine-v2/insight/extract-findings.ts", "utf8");
    const emitted = [...source.matchAll(/findingValue\("([a-zA-Z]+)"/g)].map((m) => m[1]!);
    expect(emitted.length).toBeGreaterThan(5);
    for (const name of new Set(emitted)) {
      expect(valueLabel(name, "ru"), name).not.toBeNull();
      expect(valueLabel(name, "en"), name).not.toBeNull();
    }
  });
});

// --- 3. a distribution of one ------------------------------------------------

describe("Stage 27 §58 — one measurement is a value, not a distribution", () => {
  const findingsFor = (rows: readonly (readonly CellValue[])[]) => {
    const s = store();
    const result = s.put({
      tool: "sandbox.simple_summation",
      type: "aggregate",
      fields: [{ name: "metric", kind: "metric" }, { name: "value", kind: "number" }],
      rows,
      parents: [],
      metadata: { sandbox: true, outputName: "scalars" },
    });
    return extractFindings(result, { schema: fixtureOperations().schema, grids: fixtureOperations().grids, locale: "ru" }, { role: "primary" });
  };

  it("does not describe the spread of a single number", () => {
    const findings = findingsFor([["Дек", 3665]]);
    expect(findings[0]?.findingType).toBe("value");
    expect(findings[0]?.statement).not.toContain("распределены");
    // The thousands separator is a no-break space, so match around it rather
    // than depending on which one the formatter chose.
    expect(findings[0]?.statement).toMatch(/«Дек» — 3\s665\./u);
  });

  it("still calls a real spread a distribution", () => {
    const findings = findingsFor([
      ["Ангара", 40],
      ["Мезень", 96],
      ["Обь", 40],
      ["Лена", 900],
    ]);
    expect(findings[0]?.findingType).toBe("distribution");
  });
});

// --- 4. asking for more than one script can deliver --------------------------

describe("Stage 27 §38/§19 — the ask and the budget agree", () => {
  it("bounds exploration where one generated script can still deliver it", () => {
    expect(EXPLORATION_BOUNDS.max).toBe(4);
    // Still inside §38's "3-6 investigations": the bound came DOWN, and the
    // suggested floor is unchanged.
    expect(EXPLORATION_BOUNDS.suggestedMin).toBeLessThanOrEqual(EXPLORATION_BOUNDS.max);
  });

  it("trims a plan that names more methods than it can run", () => {
    const tooMany = JSON.stringify({
      kind: "analyze",
      objective: "segment the products",
      requestedOutputs: [{ description: "segments", shape: "groups" }],
      methods: ["kmeans", "hierarchical", "dbscan", "gaussian_mixture"],
    });
    const parsed = parsePlannerDecision(tooMany);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.decision.kind !== "analyze") return;
    expect(parsed.decision.methods).toHaveLength(METHOD_COMPARISON_BOUNDS.max);
    expect(parsed.decision.methods).toEqual(["kmeans", "hierarchical", "dbscan"]);
    expect(parsed.decision.methodsDropped).toEqual(["gaussian_mixture"]);
  });

  it("accepts a comparison at the ceiling", () => {
    const atLimit = JSON.stringify({
      kind: "analyze",
      objective: "segment the products",
      requestedOutputs: [{ description: "segments", shape: "groups" }],
      methods: ["kmeans", "hierarchical", "dbscan"],
    });
    expect(parsePlannerDecision(atLimit).ok).toBe(true);
  });

  it("scales the line budget with the work requested", () => {
    const lineCount = (p: SandboxPlan): number => {
      const text = buildCodeMessages({ plan: p, dataset: dataset(), attempt: 1 })[1]!.content;
      return Number(/under (\d+) lines/.exec(text)?.[1] ?? 0);
    };
    const plain = lineCount(plan());
    const explored = lineCount(plan({ explorationDimensions: ["trends", "anomalies", "data_quality", "volatility"] }));
    const compared = lineCount(plan({ methodConstraints: ["kmeans", "hierarchical"] }));
    expect(plain).toBeGreaterThan(0);
    expect(explored).toBeGreaterThan(plain);
    expect(compared).toBeGreaterThan(plain);
    // Bounded: a plan cannot buy an unlimited script by asking for everything.
    expect(lineCount(plan({ explorationDimensions: ["trends", "anomalies", "data_quality", "volatility"], methodConstraints: ["a", "b", "c"] }))).toBeLessThanOrEqual(160);
  });

  it("leaves room for the two-step analysis a request can legitimately need", () => {
    expect(ENGINE_BOUNDS.maxAnalyses).toBeGreaterThanOrEqual(3);
  });

  it("tells the planner not to attach exploration to a focused question", () => {
    expect(plannerSystemPrompt(true)).toContain("`exploration` is ONLY for an open-ended request");
  });

  it("tells the planner a cause question is not an analysis request (§49)", () => {
    // "Почему продажи Камы упали?" went to the sandbox and burned three
    // attempts looking for a reason that is not in the table.
    expect(plannerSystemPrompt(true)).toMatch(/request for a CAUSE is not an analysis request/i);
  });

  it("does not offer a candidate list that silently stops short", () => {
    // A twelve-month table cut to ten hid Дек, and the planner concluded
    // December was not in the table and asked the user which period to use.
    const many = Array.from({ length: 40 }, (_, i) => `p${i + 1}`);
    const line = plannerErrorLine("period.resolve", { code: "AMBIGUOUS_PERIOD", message: "no", candidates: many });
    expect(line).toContain("and 16 more");
    const twelve = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
    expect(plannerErrorLine("period.resolve", { code: "AMBIGUOUS_PERIOD", message: "no", candidates: twelve })).toContain("m12");
  });

  it("tells the planner that grouping has no tool to assemble it from", () => {
    // §5 — the live run answered "сгруппируй продукты" with trend + rank and
    // presented the result as a grouping.
    expect(plannerSystemPrompt(true)).toMatch(/clustering.*NO tool/i);
  });
});

// --- 5. the column total that had no tool ------------------------------------

describe("Stage 27 §3/§83 — totalling a column stays deterministic", () => {
  const total = V2_TOOLS.find((t) => t.name === "set.total")!;

  const env = () => {
    const table = fixtureOperations();
    const s = store();
    const src = s.put({
      tool: "value.at_period",
      type: "value",
      fields: [
        { name: "metric", kind: "metric" },
        { name: "value", kind: "number" },
        { name: "periodLabel", kind: "text" },
      ],
      rows: [
        ["Ангара", 40, "Дек"],
        ["Мезень", null, "Дек"],
        ["Обь", 136, "Дек"],
      ],
      parents: [],
    });
    return { src, env: buildToolEnv(table.schema, table.grids, s, EMPTY_ANALYTICAL_STATE) };
  };

  it("exists, because the planner reaching for Python to add up a column is the §83 failure", () => {
    expect(total).toBeDefined();
    expect(total.returns).toBe("aggregate");
  });

  it("sums across the rows and labels the total with the period", () => {
    const { src, env: toolEnv } = env();
    const out = total.run({ inputRef: src.resultId, field: "value" }, toolEnv);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.rows).toEqual([["Дек", 176, 2]]);
  });

  it("excludes a row with no observation instead of reading it as zero (§23)", () => {
    const { src, env: toolEnv } = env();
    const out = total.run({ inputRef: src.resultId, field: "value" }, toolEnv);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Two of the three rows carried a value; the third is reported as skipped,
    // never folded in as a zero.
    expect(out.result.metadata["counted"]).toBe(2);
    expect(out.result.metadata["skippedRowsWithNoValue"]).toBe(1);
  });
});

// --- 6. figures the narrator was forced to derive ----------------------------

describe("Stage 27 §31/§56 — the engine supplies the figure instead of daring the narrator to compute it", () => {
  const seriesFindings = (values: readonly (readonly CellValue[])[]) => {
    const s = store();
    const result = s.put({
      tool: "series.get",
      type: "series",
      fields: [
        { name: "metric", kind: "metric" },
        { name: "periodLabel", kind: "text" },
        { name: "value", kind: "number" },
      ],
      rows: values,
      parents: [],
    });
    return extractFindings(result, { schema: fixtureOperations().schema, grids: fixtureOperations().grids, locale: "ru" }, { role: "primary" });
  };

  const series = (points: readonly (readonly [string, number | null])[]) =>
    points.map(([label, value]) => ["Ангара", label, value] as readonly CellValue[]);

  it("states the size of the move, so \"+31\" needs no subtraction", () => {
    // The live run rejected an answer for citing 31 against a finding holding
    // 100 and 131 but not their difference. The gate was right; the finding
    // was short.
    const values = seriesFindings(series([["Янв", 100], ["Фев", 110], ["Дек", 131]]))[0]?.values ?? [];
    const change = values.find((v) => v.name === "absoluteChange");
    expect(change?.value).toBe(31);
  });

  it("marks a recorded zero as a recorded value, not an absence (§25)", () => {
    const finding = seriesFindings(series([["Янв", 80], ["Фев", 0], ["Дек", 79]]))[0];
    expect(finding?.caveats.map((c) => c.code)).toContain("zero_not_absence");
    expect(finding?.caveats.find((c) => c.code === "zero_not_absence")?.detail).toContain("Фев");
  });

  it("stays quiet about a zero the answer never quotes", () => {
    // A zero buried mid-range in a signed series is not what anyone reads as
    // "не продавали", and qualifying every such series would make the
    // qualification ordinary — which is the same as making it invisible.
    const finding = seriesFindings(series([["Янв", -5], ["Фев", 0], ["Дек", 12]]))[0];
    expect(finding?.caveats.map((c) => c.code)).not.toContain("zero_not_absence");
  });

  it("says that gaps were excluded rather than zeroed (§23)", () => {
    const finding = seriesFindings(series([["Янв", 80], ["Фев", null], ["Мар", null], ["Дек", 79]]))[0];
    expect(finding?.caveats.map((c) => c.code)).toContain("missing_excluded");
    expect(finding?.caveats.find((c) => c.code === "missing_excluded")?.detail).toBe("2");
  });

  it("keeps a clean series clean", () => {
    const codes = seriesFindings(series([["Янв", 80], ["Фев", 81], ["Дек", 79]]))[0]?.caveats.map((c) => c.code) ?? [];
    expect(codes).not.toContain("zero_not_absence");
    expect(codes).not.toContain("missing_excluded");
  });
});

// --- 7. errors the planner could not recover from ---------------------------

describe("Stage 27 §5 — an error says what to do next", () => {
  const toolEnv = () => {
    const table = fixtureOperations();
    return buildToolEnv(table.schema, table.grids, store(), EMPTY_ANALYTICAL_STATE);
  };

  it("names the mistake when a tool CALL is passed where a resultId belongs", () => {
    // The live run sent inputRef: "schema.metrics()" twice and was told only
    // that no such result existed — true, and no help at all.
    const err = unknownReference("schema.metrics()", toolEnv());
    expect(err.error.message).toContain("is a tool NAME, not a result");
    expect(err.error.message).toContain("schema.metrics");
  });

  it("stays plain for an id that is merely wrong", () => {
    expect(unknownReference("result_9", toolEnv()).error.message).toContain('no result "result_9"');
  });

  it("tells the planner to copy a period candidate verbatim", () => {
    const sort = V2_TOOLS.find((t) => t.name === "value.at_period")!;
    const out = sort.run({ period: "Дек (Дек)" }, toolEnv());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain("exactly as written");
  });
});

// --- repair hints ------------------------------------------------------------

describe("Stage 27.x §7/§8 — a failure is classified, then repaired", () => {
  it("collapses the object-dtype family onto one class", () => {
    // Four tracebacks, one mistake: a numeric operation reached the label
    // column. Reported separately they looked like four problems and got four
    // partial fixes; this is what makes them one.
    for (const message of [
      "TypeError: ufunc 'isnan' not supported for the input types",
      "numpy._core._exceptions._UFuncInputCastingError: Cannot cast ufunc 'lstsq' input 1 from dtype('O') to dtype('float64')",
      "ValueError: could not convert string to float: 'Ангара'",
    ]) {
      expect(classifyFailure(message), message).toBe("NON_NUMERIC_INPUT");
      expect(repairHintFor(message), message).toContain("numeric_data");
    }
  });

  it("separates a pandas call on an ndarray from the data being non-numeric", () => {
    const message = "AttributeError: 'numpy.ndarray' object has no attribute 'fillna'";
    expect(classifyFailure(message)).toBe("PANDAS_NUMPY_TYPE_MISMATCH");
    expect(repairHintFor(message)).toContain("has no pandas methods");
  });

  it("names index alignment as its own cause", () => {
    const message = "pandas.errors.IndexingError: Unalignable boolean Series provided as indexer";
    expect(classifyFailure(message)).toBe("INDEX_ALIGNMENT_ERROR");
    expect(repairHintFor(message)).toContain("SAME");
  });

  it("steers a NaN failure away from the one repair §23 forbids", () => {
    const message = "ValueError: Input contains NaN.";
    expect(classifyFailure(message)).toBe("MISSING_VALUE_INCOMPATIBILITY");
    const hint = repairHintFor(message);
    expect(hint).toContain("Do NOT fill it with 0");
    expect(hint).toContain("numeric_data.dropna()");
  });

  it("classifies the remaining mechanical causes", () => {
    expect(classifyFailure("ValueError: Found array with 0 sample(s)")).toBe("SHAPE_MISMATCH");
    expect(classifyFailure("KeyError: 'Дек'")).toBe("MISSING_COLUMN");
    expect(classifyFailure("ModuleNotFoundError: No module named 'torch'")).toBe("UNSUPPORTED_LIBRARY");
  });

  it("says nothing when it recognises nothing", () => {
    const unknown = "RuntimeError: something nobody has seen before";
    expect(classifyFailure(unknown)).toBe("GENERIC_RUNTIME_ERROR");
    expect(repairHintFor(unknown)).toBe(unknown);
  });
});

// --- the screen that under-reported ------------------------------------------

describe("Stage 27 §93 — the caveat screen reads Russian", () => {
  it("sees a caveat carried by a Cyrillic suffix", () => {
    // JS `\w` is ASCII-only, so the old `низк\w* баз\w*` never matched this
    // sentence and `hn-low-base` was scored as having no caveat while it did.
    expect(describeAnswer("«Обь» вырос на 1 900%. Для этого продукта процент велик при низкой базе 2.").hasCaveat).toBe(true);
  });

  it("sees the caveats the system itself emits", () => {
    expect(describeAnswer("Это совпадение в данных, а не установленная зависимость.").hasCaveat).toBe(true);
    expect(describeAnswer("Пропуски исключены из расчёта, а не заменены нулями.").hasCaveat).toBe(true);
  });

  it("still reports none when none is there", () => {
    expect(describeAnswer("«Обь» вырос на 1 900% за год.").hasCaveat).toBe(false);
  });
});

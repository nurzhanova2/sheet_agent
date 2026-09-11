import { describe, expect, it } from "vitest";
import {
  checkCoverage,
  compileGoalIntents,
  extractFirstJsonObject,
  extractRequirements,
  finalizeAnalyticalGoals,
  initGoalOutcomes,
  isCompoundRequest,
  looksIntentCompound,
  parseCompoundPlan,
  parseGoalIntents,
  prepareCompoundExecution,
  renderGoalStatus,
  resolveDependentGoals,
  summarize,
  synthesizeChartIntent,
  synthesizeCompoundIntents,
  COMPOUND_LIMITS,
  type AnalysisGoal,
} from "./compound.js";
import { deriveVerifiedFacts } from "./facts.js";
import { runAnalysisBatch } from "./index.js";
import type { AnalysisRequest } from "./types.js";
import { salesSnapshot } from "./__fixtures__/sales-test-data.js";

const HEADERS = ["Date", "Region", "Manager", "Product", "Category", "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue"];
function ok<T>(v: T): Exclude<T, { code: string }> {
  if (v && typeof v === "object" && "code" in v) throw new Error(`unexpected error: ${(v as { error?: string }).error}`);
  return v as Exclude<T, { code: string }>;
}

const gm = (id: string, metric: string, column: string, opts: { abs?: boolean; name?: string } = {}): AnalysisGoal["request"] => ({
  op: "group_by",
  by: ["Category"],
  metrics: [
    {
      metric: metric as never,
      name: opts.name ?? `${metric}_${column}`,
      ...(metric === "count" ? {} : { target: opts.abs ? { kind: "abs", value: { kind: "column", name: column } } : { kind: "column", name: column } }),
    },
  ],
});

describe("parseCompoundPlan", () => {
  it("accepts a well-formed compound plan and canonicalizes goal requests", () => {
    const plan = ok(
      parseCompoundPlan({
        kind: "compound",
        goals: [
          { id: "G1", type: "group_metric", description: "counts", request: { op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "n" }] } },
          { id: "G2", type: "group_metric", description: "mean abs var%", request: gm("G2", "mean", "Variance %", { abs: true, name: "avgAbs" }) },
          { id: "G3", type: "ranking", description: "highest deviation", dependsOn: ["G2"], select: "max" },
          { id: "G4", type: "visualization", description: "bar chart", chart: { type: "bar", title: "by Category", category: { column: "Category" }, value: { aggregate: "count" } } },
          { id: "G5", type: "interpretation", description: "interpret the differences" },
        ],
      }),
    );
    expect(plan.goals).toHaveLength(5);
    expect(plan.goals[2]?.dependsOn).toEqual(["G2"]);
  });

  it("rejects a dependency on a later / unknown goal", () => {
    const err = parseCompoundPlan({ kind: "compound", goals: [{ id: "G1", type: "ranking", description: "x", dependsOn: ["G9"], select: "max" }] });
    expect("code" in err && err.code).toBe("COMPOUND_BAD_DEPENDENCY");
  });

  it("rejects a dependency cycle", () => {
    const err = parseCompoundPlan({
      kind: "compound",
      goals: [
        { id: "G1", type: "comparison", description: "a", dependsOn: ["G2"] },
        { id: "G2", type: "comparison", description: "b", dependsOn: ["G1"] },
      ],
    });
    expect("code" in err && err.code).toMatch(/CYCLE|BAD_DEPENDENCY/);
  });

  it("rejects an invalid goal request without discarding the others", () => {
    const err = parseCompoundPlan({
      kind: "compound",
      goals: [
        { id: "G1", type: "group_metric", description: "ok", request: { op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "n" }] } },
        { id: "G2", type: "group_metric", description: "bad", request: { op: "aggregate", metric: "sum", target: { kind: "require", value: "fs" } } },
      ],
    });
    expect("code" in err && err.code).toBe("COMPOUND_GOAL_INVALID");
    expect("repairGoals" in err && err.repairGoals).toEqual(["G2"]);
  });

  it("rejects a malformed group_by sort before canonicalization", () => {
    const err = parseCompoundPlan({
      kind: "compound",
      goals: [{
        id: "G1",
        type: "group_metric",
        description: "Qwen emitted sort without by",
        request: { op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "n" }], sort: { direction: "desc" } },
      }],
    });
    expect("code" in err && err.code).toBe("COMPOUND_GOAL_INVALID");
    expect("error" in err && err.error).toMatch(/sort\.by/);
  });

  it("rejects multiple logical metrics in one analytical goal before dependent ranking can become ambiguous", () => {
    const err = parseCompoundPlan({
      kind: "compound",
      goals: [{
        id: "G1",
        type: "group_metric",
        description: "counts and mean absolute Variance %",
        request: {
          op: "group_by",
          by: ["Category"],
          metrics: [
            { metric: "count", name: "recordCount" },
            { metric: "mean", name: "avgAbsVariance", target: { kind: "abs", value: { kind: "column", name: "Variance %" } } },
          ],
        },
      }, {
        id: "G2",
        type: "ranking",
        description: "largest deviation",
        dependsOn: ["G1"],
        select: "max",
      }],
    });
    expect("code" in err && err.code).toBe("COMPOUND_GOAL_INVALID");
    expect("error" in err && err.error).toMatch(/exactly one group_by metric/i);
    expect("repairGoals" in err && err.repairGoals).toEqual(["G1"]);
  });

  it("enforces the goal ceiling", () => {
    const goals = Array.from({ length: COMPOUND_LIMITS.maxGoals + 1 }, (_, i) => ({ id: `G${i}`, type: "interpretation", description: "x" }));
    expect(("code" in parseCompoundPlan({ kind: "compound", goals }) && (parseCompoundPlan({ kind: "compound", goals }) as { code: string }).code)).toBe("COMPOUND_TOO_MANY_GOALS");
  });
});

describe("prepareCompoundExecution — dedupe & merge", () => {
  it("merges group_by goals with the same shape into ONE operation with all metrics", () => {
    const goals = ok(
      parseCompoundPlan({
        kind: "compound",
        goals: [
          { id: "G1", type: "group_metric", description: "count", request: { op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "n" }] } },
          { id: "G2", type: "group_metric", description: "mean Plan", request: gm("G2", "mean", "Plan") },
          { id: "G3", type: "group_metric", description: "mean Fact", request: gm("G3", "mean", "Fact") },
          { id: "G4", type: "group_metric", description: "sum Revenue", request: gm("G4", "sum", "Revenue") },
          { id: "G5", type: "group_metric", description: "mean abs Var%", request: gm("G5", "mean", "Variance %", { abs: true }) },
        ],
      }),
    ).goals;
    const prepared = ok(prepareCompoundExecution(goals));
    expect(prepared.operations).toHaveLength(1);
    const merged = prepared.operations[0] as Extract<AnalysisRequest, { op: "group_by" }>;
    expect(merged.op).toBe("group_by");
    expect(merged.metrics).toHaveLength(5);
    for (const id of ["G1", "G2", "G3", "G4", "G5"]) expect(prepared.goalToOp.get(id)).toBe(0);
  });

  it("de-duplicates two goals that need the identical canonical request", () => {
    const req = { op: "correlation", x: { kind: "column", name: "Plan" }, y: { kind: "column", name: "Fact" } };
    const goals = ok(
      parseCompoundPlan({
        kind: "compound",
        goals: [
          { id: "G1", type: "correlation", description: "corr a", request: req },
          { id: "G2", type: "correlation", description: "corr b (same)", request: req },
        ],
      }),
    ).goals;
    const prepared = ok(prepareCompoundExecution(goals));
    expect(prepared.operations).toHaveLength(1);
    expect(prepared.goalToOp.get("G1")).toBe(0);
    expect(prepared.goalToOp.get("G2")).toBe(0);
  });
});

describe("extractRequirements & isCompoundRequest", () => {
  it("keeps a scoped aggregate across a list: 'средние Plan, Fact и Revenue'", () => {
    const req = extractRequirements("Сравни средние Plan, Fact и Revenue по Category.", HEADERS);
    const byCol = Object.fromEntries(req.metrics.map((m) => [m.column, m.aggregate]));
    expect(byCol["Plan"]).toBe("mean");
    expect(byCol["Fact"]).toBe("mean");
    expect(byCol["Revenue"]).toBe("mean");
    expect(isCompoundRequest("Сравни средние Plan, Fact и Revenue по Category.", HEADERS)).toBe(true);
  });

  it("keeps a per-column override: 'средние Plan и Fact, а Revenue покажи суммарно'", () => {
    const req = extractRequirements("Сравни средние Plan и Fact, а Revenue покажи суммарно по Category.", HEADERS);
    const byCol = Object.fromEntries(req.metrics.map((m) => [m.column, m.aggregate]));
    expect(byCol["Plan"]).toBe("mean");
    expect(byCol["Fact"]).toBe("mean");
    expect(byCol["Revenue"]).toBe("sum");
  });

  it("marks 'абсолютное Variance %' as absolute", () => {
    const req = extractRequirements("У какой Category самое большое среднее абсолютное Variance %?", HEADERS);
    const v = req.metrics.find((m) => m.column === "Variance %");
    expect(v?.absolute).toBe(true);
  });

  it("does not mistake 'R²' / 'p-value' for a grouping dimension (Stage 21.2.6 live regression)", () => {
    const req = extractRequirements("Покажи корреляцию Unit Price и Revenue по Category и обязательно скажи p-value и R².", HEADERS);
    expect(req.dimensions).toEqual(["Category"]);
    expect(req.dimensions).not.toContain("R");
  });

  it("a single chart / a single 'which is highest' is NOT compound", () => {
    expect(isCompoundRequest("Построй scatter plot между Plan и Fact.", HEADERS)).toBe(false);
    expect(isCompoundRequest("Which Bank has the highest Fact total?", ["Bank", "Plan", "Fact"])).toBe(false);
    expect(isCompoundRequest("Посчитай средний Fact по Category.", HEADERS)).toBe(false);
  });

  it("the canonical multi-part request IS compound (RU)", () => {
    const prompt =
      "Проанализируй различия между категориями. Сравни количество записей, Plan, Fact, Revenue и абсолютное Variance %. Определи категорию с наибольшим отклонением от плана и построй подходящий график. Все числовые выводы рассчитай детерминированно, а интерпретации отдели от фактов.";
    expect(isCompoundRequest(prompt, HEADERS)).toBe(true);
  });

  it("the English equivalent IS compound", () => {
    const prompt =
      "Compare the categories by record count, average Plan, average Fact, average Revenue and mean absolute Variance %. Then name the category with the largest deviation and build a suitable chart. Keep facts and interpretation separate.";
    expect(isCompoundRequest(prompt, HEADERS)).toBe(true);
  });
});

describe("checkCoverage", () => {
  const goals = ok(
    parseCompoundPlan({
      kind: "compound",
      goals: [
        { id: "G1", type: "group_metric", description: "count", request: { op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "n" }] } },
        { id: "G2", type: "group_metric", description: "mean Plan", request: gm("G2", "mean", "Plan") },
      ],
    }),
  ).goals;

  it("flags a requested metric that no goal produces", () => {
    const req = extractRequirements("Сравни средние Plan и Revenue по Category.", HEADERS);
    const gaps = checkCoverage(req, goals, HEADERS);
    expect(gaps.map((g) => g.detail).join(" ")).toMatch(/Revenue/);
  });

  it("flags a dropped 'absolute' modifier", () => {
    const req = extractRequirements("Сравни средний Plan и среднее абсолютное Variance % по Category.", HEADERS);
    const gaps = checkCoverage(req, goals, HEADERS);
    expect(gaps.map((g) => g.detail).join(" ")).toMatch(/absolute.*Variance/i);
  });

  it("keeps a named missing dimension covered so execution can report partial failure", () => {
    const req = extractRequirements("Сравни средний Plan по Category и Region.", HEADERS.filter((h) => h !== "Region"));
    expect(req.dimensions).toContain("Region");
    const gaps = checkCoverage(req, goals, HEADERS.filter((h) => h !== "Region"));
    expect(gaps.some((g) => g.kind === "dimension" && g.detail.includes("Region"))).toBe(true);
  });

  it("treats a chart-only multi-series request as visualization, not compound", () => {
    expect(isCompoundRequest("Построй grouped bar chart среднего Plan и Fact по каждой Category.", HEADERS)).toBe(false);
  });
});

describe("resolveDependentGoals — a ranking goal consumes a VerifiedFact, never re-ranks", () => {
  it("names Electronics as the highest mean(abs(Variance %)) from the extreme fact", () => {
    const request = {
      op: "group_by" as const,
      by: ["Category"],
      metrics: [{ metric: "mean" as const, name: "avgAbsVarPct", target: { kind: "abs" as const, value: { kind: "column" as const, name: "Variance %" } } }],
    };
    const batch = runAnalysisBatch(salesSnapshot(), [request]);
    const goals: AnalysisGoal[] = [
      { id: "G1", type: "group_metric", description: "mean abs var%", dependsOn: [], request },
      { id: "G2", type: "ranking", description: "highest mean abs var%", dependsOn: ["G1"], select: "max" },
    ];
    const outcomes = initGoalOutcomes(goals);
    const prepared = ok(prepareCompoundExecution(goals));
    finalizeAnalyticalGoals(goals, prepared, outcomes, [], batch.facts);
    resolveDependentGoals(goals, outcomes, batch.facts);
    const ranking = outcomes.find((o) => o.id === "G2");
    expect(ranking?.status).toBe("executed");
    expect(ranking?.answerText).toMatch(/Electronics/);
  });

  it("blocks a ranking goal whose dependency failed", () => {
    const goals: AnalysisGoal[] = [
      { id: "G1", type: "group_metric", description: "bad", dependsOn: [], request: { op: "group_by", by: ["Region"], metrics: [{ metric: "count", name: "n" }] } },
      { id: "G2", type: "ranking", description: "best Region", dependsOn: ["G1"], select: "max" },
    ];
    const outcomes = initGoalOutcomes(goals);
    const prepared = ok(prepareCompoundExecution(goals));
    finalizeAnalyticalGoals(goals, prepared, outcomes, [{ index: 0, code: "UNKNOWN_COLUMN", error: 'Column "Region" was not found.' }], []);
    resolveDependentGoals(goals, outcomes, []);
    expect(outcomes.find((o) => o.id === "G1")?.status).toBe("failed");
    expect(outcomes.find((o) => o.id === "G1")?.failureReason).toBe("COLUMN_NOT_AVAILABLE: Region");
    expect(outcomes.find((o) => o.id === "G2")?.status).toBe("blocked");
  });
});

describe("summarize", () => {
  it("counts completed / failed / blocked and flags 'no analytical goal completed'", () => {
    const summary = summarize([
      { id: "G1", type: "group_metric", description: "a", status: "failed", factIds: [] },
      { id: "G2", type: "ranking", description: "b", status: "blocked", factIds: [] },
      { id: "G3", type: "interpretation", description: "c", status: "executed", factIds: [] },
    ]);
    expect(summary).toMatchObject({ totalGoals: 3, completedGoals: 1, failedGoals: 1, blockedGoals: 1, analyticalCompleted: 0 });
    expect(deriveVerifiedFacts([], [])).toHaveLength(0); // sanity: facts layer untouched
  });
});

// Stage 21.2.5 — the GOAL STATUS block localizes status words and glosses codes.
describe("renderGoalStatus — localization (Stage 21.2.5 §13)", () => {
  const summary = summarize([
    { id: "G1", type: "group_metric", description: "mean Fact by Category", status: "executed", factIds: [], sourceOperationId: "op#1" },
    { id: "G2", type: "group_metric", description: "count by Region", status: "failed", factIds: [], failureReason: "COLUMN_NOT_AVAILABLE: Region" },
    { id: "G3", type: "ranking", description: "best Region", status: "blocked", factIds: [], failureReason: "depends on G2 which failed" },
    { id: "G4", type: "visualization", description: "chart", status: "failed", factIds: [], failureReason: "VISUALIZATION_UNSUPPORTED: grouped charts need multi-series" },
  ]);

  it("RU: status words are Russian; the stable code is kept in parentheses", () => {
    const block = renderGoalStatus(summary, "ru");
    expect(block).toMatch(/СТАТУС ЦЕЛЕЙ/);
    expect(block).toMatch(/— выполнено/);
    expect(block).toMatch(/— не выполнено/);
    expect(block).toMatch(/— заблокировано/);
    expect(block).toMatch(/столбец Region отсутствует в выбранном диапазоне \(COLUMN_NOT_AVAILABLE: Region\)/);
    expect(block).toMatch(/график не удалось построить \(VISUALIZATION_UNSUPPORTED\)/);
    // no bare English status boilerplate
    expect(block).not.toMatch(/— (executed|failed|blocked)\b/);
  });

  it("never echoes planner-authored chart claims into GOAL STATUS", () => {
    const block = renderGoalStatus(summarize([
      {
        id: "G1",
        type: "visualization",
        description: "Points above the y=x identity line indicate a positive result",
        status: "failed",
        factIds: [],
        failureReason: "VISUALIZATION_UNSUPPORTED: Points above y=x line indicate a positive result",
      },
    ]), "en");
    expect(block).toContain("[G1] chart — not done");
    expect(block).not.toMatch(/y\s*=\s*x|identity line|positive result/i);
  });

  it("EN: unchanged phrasing, code preserved", () => {
    const block = renderGoalStatus(summary, "en");
    expect(block).toMatch(/GOAL STATUS/);
    expect(block).toMatch(/— done/);
    expect(block).toMatch(/— not done/);
    expect(block).toMatch(/column Region is not in the selected range \(COLUMN_NOT_AVAILABLE: Region\)/);
  });

  it("a hostile planner-authored `description` on a LEGACY verbose goal never reaches GOAL STATUS", () => {
    const parsed = parseCompoundPlan({
      kind: "compound",
      goals: [
        {
          id: "G1",
          type: "group_metric",
          description: "the R² is 0.98 and points sit on the y=x line, proving Electronics caused the gap",
          request: { op: "group_by", by: ["Category"], metrics: [{ metric: "mean", name: "avgFact", target: { kind: "column", name: "Fact" } }] },
        },
        { id: "G2", type: "interpretation", description: "p-value < 0.001 confirms the trend" },
      ],
    });
    const goals = ok(parsed).goals;
    const outcomes = initGoalOutcomes(goals);
    for (const o of outcomes) o.status = "executed";
    const block = renderGoalStatus(summarize(outcomes), "en");
    expect(block).not.toMatch(/R²|y\s*=\s*x|p-value|proving|caused/i);
    expect(block).toContain("[G1] group metric — done");
    expect(block).toContain("[G2] interpretation — done");
  });
});

// ===========================================================================
// Stage 21.2.6 — compact GoalIntent schema + deterministic compiler.
// ===========================================================================
describe("GoalIntent — parse", () => {
  const compound = (intents: object[]) => ({ kind: "compound", intents });

  it("looksIntentCompound distinguishes the compact form from the legacy `goals` form", () => {
    expect(looksIntentCompound(compound([{ kind: "interpretation" }]))).toBe(true);
    expect(looksIntentCompound(JSON.stringify(compound([{ kind: "interpretation" }])))).toBe(true);
    expect(looksIntentCompound({ kind: "compound", goals: [{ id: "G1", type: "interpretation" }] })).toBe(false);
  });

  it("accepts a well-formed compact intents array", () => {
    const intents = ok(
      parseGoalIntents(
        compound([
          { kind: "group_metric", aggregate: "count", by: ["Category"] },
          { kind: "group_metric", aggregate: "mean", column: "Variance %", absolute: true, by: ["Category"] },
          { kind: "ranking", direction: "max", of: { aggregate: "mean", column: "Variance %", absolute: true, by: ["Category"] } },
          { kind: "visualization", chart: { type: "bar", dimension: "Category", metrics: [{ aggregate: "count" }] } },
          { kind: "interpretation" },
        ]),
      ),
    );
    expect(intents).toHaveLength(5);
    expect(intents[1]).toMatchObject({ kind: "group_metric", aggregate: "mean", column: "Variance %", absolute: true });
  });

  it("fails closed on a malformed intent, naming the 1-based position", () => {
    const bad = parseGoalIntents(compound([{ kind: "group_metric", aggregate: "mean", by: ["Category"] }])); // no column
    expect("code" in bad && bad.code).toBe("COMPOUND_INTENT_INVALID");
    expect("repairGoals" in bad && bad.repairGoals).toEqual(["1"]);

    expect("code" in (parseGoalIntents(compound([{ kind: "frobnicate" }])) as { code: string })).toBe(true);
    expect("code" in (parseGoalIntents(compound([{ kind: "filter_count" }])) as { code: string })).toBe(true); // no where
    expect("code" in (parseGoalIntents("{ not json") as { code: string })).toBe(true);
  });
});

describe("GoalIntent — compile", () => {
  const compileIntents = (intents: object[]) => ok(compileGoalIntents(ok(parseGoalIntents({ kind: "compound", intents }))));

  it("assigns deterministic ids — analytical goals first (G1..Gk), then ranking, viz, interpretation", () => {
    const plan = compileIntents([
      { kind: "ranking", direction: "max", of: { aggregate: "mean", column: "Variance %", absolute: true, by: ["Category"] } },
      { kind: "interpretation" },
      { kind: "group_metric", aggregate: "count", by: ["Category"] },
      { kind: "group_metric", aggregate: "mean", column: "Variance %", absolute: true, by: ["Category"] },
      { kind: "visualization", chart: { type: "bar", dimension: "Category", metrics: [{ aggregate: "count" }] } },
    ]);
    const byId = Object.fromEntries(plan.goals.map((g) => [g.id, g.type]));
    expect(byId).toEqual({ G1: "group_metric", G2: "group_metric", G3: "ranking", G4: "visualization", G5: "interpretation" });
    // the model wrote NO id; the ranking is bound backwards to the mean-abs metric goal
    expect(plan.goals.find((g) => g.type === "ranking")?.dependsOn).toEqual(["G2"]);
  });

  it("compiles ONE logical metric per analytical goal", () => {
    const plan = compileIntents([
      { kind: "group_metric", aggregate: "count", by: ["Category"] },
      { kind: "group_metric", aggregate: "mean", column: "Plan", by: ["Category"] },
      { kind: "group_metric", aggregate: "mean", column: "Fact", by: ["Category"] },
      { kind: "group_metric", aggregate: "sum", column: "Revenue", by: ["Category"] },
    ]);
    for (const goal of plan.goals) {
      if (goal.request?.op === "group_by") expect(goal.request.metrics).toHaveLength(1);
    }
  });

  it("a ranking whose `of` matches no metric intent fails closed (COMPOUND_INTENT_UNBOUND)", () => {
    const err = compileGoalIntents(
      ok(parseGoalIntents({
        kind: "compound",
        intents: [
          { kind: "group_metric", aggregate: "mean", column: "Plan", by: ["Category"] },
          { kind: "ranking", direction: "max", of: { aggregate: "mean", column: "Fact", by: ["Category"] } },
        ],
      })),
    );
    expect("code" in err && err.code).toBe("COMPOUND_INTENT_UNBOUND");
  });

  it("Revenue stays summed when the intent says so (regression)", () => {
    const plan = compileIntents([{ kind: "group_metric", aggregate: "sum", column: "Revenue", by: ["Category"] }]);
    const prepared = ok(prepareCompoundExecution(plan.goals));
    const op = prepared.operations[0] as Extract<AnalysisRequest, { op: "group_by" }>;
    expect(op.metrics[0]?.metric).toBe("sum");
    expect(JSON.stringify(op.metrics[0]?.target)).toContain("Revenue");
  });

  it("keeps a named grouping column as its OWN goal, never merged with an available dimension", () => {
    const plan = compileIntents([
      { kind: "group_metric", aggregate: "count", by: ["Category"] },
      { kind: "group_metric", aggregate: "mean", column: "Fact", by: ["Region"] },
    ]);
    const regionGoal = plan.goals.find((g) => g.request?.op === "group_by" && g.request.by.includes("Region"));
    const categoryGoal = plan.goals.find((g) => g.request?.op === "group_by" && g.request.by.includes("Category"));
    expect(regionGoal).toBeDefined();
    expect(categoryGoal).toBeDefined();
    expect(regionGoal?.id).not.toBe(categoryGoal?.id);
    // the two dimensions stay in separate operations so execution reports Region on its own
    const prepared = ok(prepareCompoundExecution(plan.goals));
    expect(prepared.operations.length).toBe(2);
    expect(prepared.goalToOp.get(regionGoal!.id)).not.toBe(prepared.goalToOp.get(categoryGoal!.id));
  });

  it("an E1:L121-style selection (no Region) rejects the Region operation while Category still runs", () => {
    const full = salesSnapshot();
    const keep = [4, 5, 6, 7, 8, 9, 10, 11];
    const noRegion = {
      ...full,
      columnCount: 8,
      totalColumnCount: 8,
      values: full.values.map((row) => keep.map((i) => row[i])),
      formulas: full.formulas.map((row) => keep.map((i) => row[i] ?? null)),
      numberFormats: full.numberFormats.map((row) => keep.map((i) => String(row[i] ?? ""))),
      headers: keep.map((i) => (full.headers ?? [])[i] as string),
    } as typeof full;
    const plan = compileIntents([
      { kind: "group_metric", aggregate: "count", by: ["Category"] },
      { kind: "group_metric", aggregate: "mean", column: "Fact", by: ["Region"] },
    ]);
    const batch = runAnalysisBatch(noRegion, ok(prepareCompoundExecution(plan.goals)).operations);
    expect(batch.rejected.length).toBe(1);
    expect(batch.status).toBe("partial");
  });

  it("grouped-bar chart intent compiles to a two-series grouped bar request", () => {
    const plan = compileIntents([
      {
        kind: "visualization",
        chart: {
          type: "bar",
          title: "mean Plan and Fact by Category",
          dimension: "Category",
          metrics: [
            { aggregate: "mean", column: "Plan" },
            { aggregate: "mean", column: "Fact" },
          ],
          mode: "grouped",
        },
      },
    ]);
    const chart = plan.goals[0]?.chart as Record<string, unknown>;
    expect(chart["type"]).toBe("bar");
    expect(chart["mode"]).toBe("grouped");
    expect(Array.isArray(chart["series"]) && (chart["series"] as unknown[]).length).toBe(2);
  });

  it("the mandatory compound request decomposes into every required goal, absolute preserved, ranking bound to mean|Variance %|", () => {
    const plan = compileIntents([
      { kind: "group_metric", aggregate: "count", by: ["Category"] },
      { kind: "group_metric", aggregate: "mean", column: "Plan", by: ["Category"] },
      { kind: "group_metric", aggregate: "mean", column: "Fact", by: ["Category"] },
      { kind: "group_metric", aggregate: "sum", column: "Revenue", by: ["Category"] },
      { kind: "group_metric", aggregate: "mean", column: "Variance %", absolute: true, by: ["Category"] },
      { kind: "ranking", direction: "max", of: { aggregate: "mean", column: "Variance %", absolute: true, by: ["Category"] } },
      { kind: "visualization", chart: { type: "bar", dimension: "Category", metrics: [{ aggregate: "count" }] } },
      { kind: "interpretation" },
    ]);
    expect(plan.goals.map((g) => g.type)).toEqual([
      "group_metric", "group_metric", "group_metric", "group_metric", "group_metric", "ranking", "visualization", "interpretation",
    ]);
    // absolute survived into the compiled operation
    expect(JSON.stringify(plan.goals)).toContain('"kind":"abs"');
    const rankingGoal = plan.goals.find((g) => g.type === "ranking");
    const absGoal = plan.goals.find((g) => JSON.stringify(g.request ?? {}).includes('"kind":"abs"'));
    expect(rankingGoal?.dependsOn).toEqual([absGoal?.id]);

    // end-to-end: the ranking resolves to Electronics from the SPECIFIC metric's extreme fact
    const prepared = ok(prepareCompoundExecution(plan.goals));
    const batch = runAnalysisBatch(salesSnapshot(), prepared.operations);
    const outcomes = initGoalOutcomes(plan.goals);
    finalizeAnalyticalGoals(plan.goals, prepared, outcomes, [], batch.facts);
    resolveDependentGoals(plan.goals, outcomes, batch.facts);
    const ranking = outcomes.find((o) => o.id === rankingGoal?.id);
    expect(ranking?.status).toBe("executed");
    expect(ranking?.answerText).toMatch(/Electronics/);
    expect(ranking?.answerText).toMatch(/17[.,]17/);
  });

  it("extractFirstJsonObject de-wraps prose / ```json but never repairs a truncated payload", () => {
    const obj = '{"kind":"compound","intents":[{"kind":"interpretation"}]}';
    expect(extractFirstJsonObject("here is the plan:\n```json\n" + obj + "\n```\nhope that helps")).toBe(obj);
    expect(extractFirstJsonObject('{"a":"}not a close"}')).toBe('{"a":"}not a close"}');
    expect(extractFirstJsonObject('{"kind":"compound","intents":[')).toBeNull(); // truncated → fail closed
    expect(extractFirstJsonObject("no braces here")).toBeNull();
  });

  it("parseGoalIntents recovers valid intents JSON wrapped in prose, still fails closed on malformed JSON", () => {
    const wrapped = 'Sure:\n```json\n{"kind":"compound","intents":[{"kind":"group_metric","aggregate":"count","by":["Category"]}]}\n```';
    const okParsed = parseGoalIntents(wrapped);
    expect(Array.isArray(okParsed) && okParsed).toHaveLength(1);
    // a bare string element + brace mismatch is genuinely malformed — no repair
    const bad = parseGoalIntents('{"kind":"compound","intents":[{"kind":"interpretation"}},"interpretation"}]}');
    expect("code" in bad && bad.code).toBe("COMPOUND_INTENT_INVALID");
  });

  it("synthesizeCompoundIntents builds a full compound plan from the extracted requirements (deterministic floor)", () => {
    const numeric = new Set(["Plan", "Fact", "Revenue", "Variance %", "Units", "Unit Price", "Variance"]);
    const intents = synthesizeCompoundIntents(
      "Проанализируй различия между категориями. Сравни количество записей, Plan, Fact, Revenue и абсолютное Variance %. Определи категорию с наибольшим отклонением и построй график. Отдели факты от интерпретации.",
      ["Category", "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue"],
      "Category",
      numeric,
    );
    expect(intents).not.toBeNull();
    const kinds = (intents ?? []).map((i) => i.kind);
    expect(kinds).toContain("ranking");
    expect(kinds).toContain("visualization");
    expect(kinds).toContain("interpretation");
    // count + Plan + Fact + Revenue + abs Variance %
    const metricCols = (intents ?? []).filter((i) => i.kind === "group_metric" && i.aggregate !== "count").map((i) => i.column);
    expect(metricCols).toEqual(expect.arrayContaining(["Plan", "Fact", "Revenue", "Variance %"]));
    const absMetric = (intents ?? []).find((i) => i.kind === "group_metric" && i.absolute);
    expect(absMetric?.column).toBe("Variance %");
    // it compiles, and the ranking binds to the absolute metric
    const plan = ok(compileGoalIntents(intents!));
    const rankingGoal = plan.goals.find((g) => g.type === "ranking");
    const absGoal = plan.goals.find((g) => JSON.stringify(g.request ?? {}).includes('"kind":"abs"'));
    expect(rankingGoal?.dependsOn).toEqual([absGoal?.id]);
    // end-to-end against the fixture → Electronics 17.17%
    const prepared = ok(prepareCompoundExecution(plan.goals));
    const batch = runAnalysisBatch(salesSnapshot(), prepared.operations);
    const outcomes = initGoalOutcomes(plan.goals);
    finalizeAnalyticalGoals(plan.goals, prepared, outcomes, [], batch.facts);
    resolveDependentGoals(plan.goals, outcomes, batch.facts);
    expect(outcomes.find((o) => o.id === rankingGoal?.id)?.answerText).toMatch(/Electronics/);
  });

  it("synthesizeCompoundIntents returns null with no usable grouping column", () => {
    expect(synthesizeCompoundIntents("Compare Plan and Fact and rank them.", ["Plan", "Fact"], null, new Set(["Plan", "Fact"]))).toBeNull();
  });

  it("parseGoalIntents rejects a chart intent missing its required fields (Stage 21.2.6 live regression)", () => {
    const barNoDim = parseGoalIntents({ kind: "compound", intents: [{ kind: "visualization", chart: { type: "bar", metrics: [{ aggregate: "mean", column: "Plan" }] } }] });
    expect("code" in barNoDim && barNoDim.code).toBe("COMPOUND_INTENT_INVALID");
    const scatterNoXY = parseGoalIntents({ kind: "compound", intents: [{ kind: "visualization", chart: { type: "scatter", groupBy: "Category" } }] });
    expect("code" in scatterNoXY && scatterNoXY.code).toBe("COMPOUND_INTENT_INVALID");
    const barOk = parseGoalIntents({ kind: "compound", intents: [{ kind: "visualization", chart: { type: "bar", dimension: "Category", metrics: [{ aggregate: "mean", column: "Plan" }] } }] });
    expect(Array.isArray(barOk)).toBe(true);
  });

  it("synthesizeChartIntent infers chart type + fields from the prompt", () => {
    const numeric = new Set(["Plan", "Fact", "Revenue", "Variance %"]);
    const bar = synthesizeChartIntent("Построй grouped bar chart среднего Plan и Fact по каждой Category.", HEADERS, "Category", numeric);
    expect(bar).toMatchObject({ type: "bar", dimension: "Category", mode: "grouped" });
    expect(bar?.metrics?.map((m) => m.column)).toEqual(["Plan", "Fact"]);

    const scatter = synthesizeChartIntent("Построй scatter plot Plan vs Fact и раздели точки по Category.", HEADERS, "Category", numeric);
    expect(scatter).toMatchObject({ type: "scatter", x: "Plan", y: "Fact", groupBy: "Category" });

    // no grouping column and no x/y → nothing usable
    expect(synthesizeChartIntent("draw a chart", HEADERS, null, numeric)).toBeNull();
  });

  it("Stage 21.2.8 §2 — an abs threshold predicate compiles to a filtered count, never mean(abs(x))", () => {
    const intents = synthesizeCompoundIntents(
      "Сколько строк в каждой Category имеют абсолютное Variance % больше 20%? Покажи total, count и percentage.",
      HEADERS,
      "Category",
      new Set(["Plan", "Fact", "Revenue", "Variance %"]),
    );
    if (!intents) throw new Error("no intents");
    expect(intents.map((i) => i.kind)).toContain("filter_count");
    const fc = intents.find((i) => i.kind === "filter_count")!;
    expect(fc.where).toMatchObject({ column: "Variance %", op: ">", absolute: true, value: { percent: 20 } });
    // NO aggregate metric was created for the predicate column
    expect(intents.some((i) => i.kind === "group_metric" && i.column === "Variance %")).toBe(false);
    // it still compiles + prepares cleanly (abs modifier honoured inside the condition)
    const plan = compileIntents(intents as unknown as object[]);
    const prep = prepareCompoundExecution(plan.goals);
    expect("code" in prep).toBe(false);
  });

  it("Stage 21.2.8 §2 — checkCoverage demands a filtered count for a predicate, never an aggregate", () => {
    const reqs = extractRequirements("Count rows where absolute Variance % exceeds 20% by Category.", HEADERS);
    expect(reqs.conditions).toHaveLength(1);
    // a plan with only a mean(abs) metric does NOT cover the condition
    const meanOnly = [
      { id: "G1", type: "group_metric", description: "x", dependsOn: [], request: gm("G1", "mean", "Variance %", { abs: true }) },
    ] as unknown as AnalysisGoal[];
    const gaps = checkCoverage(reqs, meanOnly, HEADERS);
    expect(gaps.some((g) => /filtered row-count/.test(g.detail))).toBe(true);
    // a filter_count goal DOES cover it
    const withFilter = [
      { id: "G1", type: "filter_count", description: "x", dependsOn: [], request: { op: "group_by", by: ["Category"], metrics: [{ metric: "count", name: "m", where: { left: { kind: "abs", value: { kind: "column", name: "Variance %" } }, operator: ">", value: { kind: "percent", value: 20 } } }] } },
    ] as unknown as AnalysisGoal[];
    expect(checkCoverage(reqs, withFilter, HEADERS).some((g) => /filtered row-count/.test(g.detail))).toBe(false);
  });

  it("Stage 21.2.8 §3/§5 — RU and EN equivalents route identically", () => {
    const pairs: [string, string][] = [
      [
        "Сколько строк в каждой Category имеют абсолютное Variance % больше 20%?",
        "Count rows where absolute Variance % exceeds 20% by Category.",
      ],
      [
        "Какая категория встречается чаще всего и какую долю всех записей она составляет?",
        "Which category appears most often, and what percentage of all records does it represent?",
      ],
      [
        "Посчитай суммарный Revenue по каждой Category и назови категорию с максимальным Revenue.",
        "Sum Revenue by Category and name the category with the highest Revenue.",
      ],
    ];
    for (const [ru, en] of pairs) {
      expect(isCompoundRequest(ru, HEADERS)).toBe(isCompoundRequest(en, HEADERS));
      const a = synthesizeCompoundIntents(ru, HEADERS, "Category", new Set(["Plan", "Fact", "Revenue", "Variance %"]));
      const b = synthesizeCompoundIntents(en, HEADERS, "Category", new Set(["Plan", "Fact", "Revenue", "Variance %"]));
      expect((a ?? []).map((i) => i.kind).sort()).toEqual((b ?? []).map((i) => i.kind).sort());
    }
  });

  it("compiled goal descriptions are deterministic — no model free-text can reach GOAL STATUS", () => {
    // Even if a hostile intent were accepted, there is nowhere to put prose: the
    // schema has no free-text field. Descriptions are generated from typed fields.
    const plan = compileIntents([
      { kind: "group_metric", aggregate: "mean", column: "Variance %", absolute: true, by: ["Category"] },
      { kind: "ranking", direction: "max", of: { aggregate: "mean", column: "Variance %", absolute: true, by: ["Category"] } },
      { kind: "visualization", chart: { type: "scatter", x: "Plan", y: "Fact", groupBy: "Category", title: "points above the y=x identity line are good" } },
      { kind: "interpretation" },
    ]);
    const outcomes = initGoalOutcomes(plan.goals);
    const block = renderGoalStatus(summarize(outcomes), "en");
    expect(block).not.toMatch(/y\s*=\s*x|identity line/i);
    expect(plan.goals.every((g) => typeof g.description === "string" && g.description.length > 0)).toBe(true);
    expect(plan.goals.find((g) => g.type === "interpretation")?.description).toBe("interpretation");
  });
});

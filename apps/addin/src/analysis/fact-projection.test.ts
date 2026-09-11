// Stage 21.2.8 — conditional counts / shares / RU↔EN parity, projected deterministically.
import { describe, expect, it } from "vitest";
import {
  compileGoalIntents,
  extractRequirements,
  finalizeAnalyticalGoals,
  initGoalOutcomes,
  isCompoundPlanError,
  isCompoundRequest,
  parseGoalIntents,
  prepareCompoundExecution,
  projectCompoundFacts,
  resolveDependentGoals,
  synthesizeCompoundIntents,
  runAnalysisBatch,
  type FactProjection,
} from "./index.js";
import { renderProjectedFactsForModel } from "./fact-projection.js";
import { salesSnapshot } from "./__fixtures__/sales-test-data.js";
import { prepareChartData } from "../visualization/prepare.js";
import { deriveChartValueFacts } from "../visualization/facts.js";
import { isVisualizationError, type ChartData } from "../visualization/types.js";
import type { AnalysisGoal } from "./compound.js";

function groupedBarChart(language: "ru" | "en" = "ru"): ChartData {
  const out = prepareChartData(
    salesSnapshot(),
    {
      type: "bar",
      title: "Средние Plan и Fact по Category",
      category: { column: "Category" },
      mode: "grouped",
      series: [
        { label: "s1", value: { aggregate: "mean", column: "Plan" } },
        { label: "s2", value: { aggregate: "mean", column: "Fact" } },
      ],
    },
    language,
  );
  if (isVisualizationError(out)) throw new Error(out.error);
  return out;
}

const H = ["Date", "Region", "Manager", "Product", "Category", "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue"];
const NUM = new Set(["Plan", "Fact", "Revenue", "Variance %", "Units", "Unit Price", "Variance"]);

function project(prompt: string, language: "ru" | "en", snapshot = salesSnapshot()): FactProjection {
  const intents = synthesizeCompoundIntents(prompt, snapshot.headers ?? H, "Category", NUM);
  if (!intents) throw new Error("no intents");
  const compiled = compileGoalIntents(intents);
  if (isCompoundPlanError(compiled)) throw new Error(compiled.error);
  const prep = prepareCompoundExecution(compiled.goals);
  if ("code" in prep) throw new Error(prep.error);
  const batch = runAnalysisBatch(snapshot, prep.operations, 0, language);
  const outcomes = initGoalOutcomes(compiled.goals);
  finalizeAnalyticalGoals(
    compiled.goals,
    prep,
    outcomes,
    batch.rejected.map((e, i) => ({ index: e.index ?? i, code: e.code, error: e.error })),
    batch.facts,
  );
  const extra = resolveDependentGoals(compiled.goals, outcomes, batch.facts);
  for (const o of outcomes) if (o.type === "visualization") o.status = "executed";
  const reqs = extractRequirements(prompt, snapshot.headers ?? H);
  return projectCompoundFacts(compiled.goals, outcomes, [...batch.facts, ...extra], reqs, language, prompt);
}

const flat = (p: FactProjection) =>
  [
    ...p.metrics.flatMap((m) => m.rows.map((r) => `${m.label}|${r.group}|${r.formatted}`)),
    ...p.conclusions.map((c) => `${c.label} => ${c.answer}`),
  ].join("\n");

describe("§2 — |Variance %| > 20% compiles to a CONDITION, not mean(abs(x))", () => {
  const RU = "Сколько строк в каждой Category имеют абсолютное Variance % больше 20%? Покажи total, count и percentage.";
  const EN = "Count rows where absolute Variance % exceeds 20% by Category. Show total, count and percentage.";

  it("RU and EN both extract the same abs-predicate condition (item 1/2/19)", () => {
    for (const prompt of [RU, EN]) {
      const reqs = extractRequirements(prompt, H);
      expect(reqs.conditions).toHaveLength(1);
      expect(reqs.conditions[0]).toMatchObject({ column: "Variance %", op: ">", absolute: true, value: { percent: 20 } });
      expect(reqs.metrics).toHaveLength(0); // NOT recorded as an aggregate requirement
      expect(isCompoundRequest(prompt, H)).toBe(true);
    }
  });

  it("conditional totals 48/37/35, counts 16/16/13, shares 33.33/43.24/37.14% (items 3/4/5)", () => {
    const out = flat(project(RU, "ru"));
    expect(out).toMatch(/Всего\|Accessories\|48/);
    expect(out).toMatch(/Всего\|Electronics\|37/);
    expect(out).toMatch(/Всего\|Furniture\|35/);
    expect(out).toMatch(/\|Variance %\| > 20%\|Accessories\|16/);
    expect(out).toMatch(/\|Variance %\| > 20%\|Electronics\|16/);
    expect(out).toMatch(/\|Variance %\| > 20%\|Furniture\|13/);
    expect(out).toMatch(/Доля\|Accessories\|33\.33%/);
    expect(out).toMatch(/Доля\|Electronics\|43\.24%/);
    expect(out).toMatch(/Доля\|Furniture\|37\.14%/);
  });

  it("shares are VerifiedFacts, not model-derived (item 8)", () => {
    const p = project(RU, "ru");
    const shareLabels = p.metrics.filter((m) => m.label === "Доля");
    expect(shareLabels).toHaveLength(1);
    // every projected share row corresponds to a kept ShareFact
    const shareFacts = p.facts.filter((f) => f.kind === "share");
    expect(shareFacts.length).toBeGreaterThanOrEqual(3);
  });
});

describe("§3 — Fact < Plan conditional count + share", () => {
  const RU = "Сколько строк в каждой Category имеют Fact меньше Plan? Покажи количество и долю от общего числа строк категории.";

  it("counts 26/16/16 and shares 54.17/43.24/45.71% (items 6/7)", () => {
    const out = flat(project(RU, "ru"));
    expect(out).toMatch(/Fact < Plan\|Accessories\|26/);
    expect(out).toMatch(/Fact < Plan\|Electronics\|16/);
    expect(out).toMatch(/Fact < Plan\|Furniture\|16/);
    expect(out).toMatch(/Доля\|Accessories\|54\.17%/);
    expect(out).toMatch(/Доля\|Electronics\|43\.24%/);
    expect(out).toMatch(/Доля\|Furniture\|45\.71%/);
  });

  it("column-to-column predicate produces no mean/sum goal", () => {
    const reqs = extractRequirements(RU, H);
    expect(reqs.metrics).toHaveLength(0);
    expect(reqs.conditions[0]).toMatchObject({ column: "Fact", op: "<", value: { column: "Plan" } });
  });
});

describe("§4 — a plain ΣRevenue-by-Category request projects Revenue only", () => {
  const RU = "Посчитай суммарный Revenue по каждой Category и определи категорию с максимальным Revenue.";

  it("is routed as compound (item — §3)", () => {
    expect(isCompoundRequest(RU, H)).toBe(true);
  });

  it("fallback carries Revenue + the ranking ONLY — no Date/Plan/Fact/Units (items 9/10/11)", () => {
    const p = project(RU, "ru");
    const model = renderProjectedFactsForModel(p, "ru");
    expect(model).toMatch(/Сумма Revenue по Category: Accessories 434,805,308; Electronics 2,849,711,102; Furniture 1,035,812,162/);
    expect(model).toMatch(/Electronics \(2,849,711,102\)/); // item 12 — winner
    expect(model).not.toMatch(/Date|Plan|Fact|Units|Unit Price|Variance/);
    expect(model).not.toMatch(/[Кк]оличество записей/); // count goal suppressed (not requested)
  });
});

describe("§5 — RU/EN 'most common + share of total' semantic parity", () => {
  const RU = "Какая категория встречается чаще всего и какую долю всех записей она составляет?";
  const EN = "Which category appears most often, and what percentage of all records does it represent?";

  it("both extract a frequency + share requirement (items 17/18/19)", () => {
    for (const prompt of [RU, EN]) {
      const reqs = extractRequirements(prompt, H);
      expect(reqs.frequency).toBe(true);
      expect(reqs.groupShare).toBe(true);
      expect(isCompoundRequest(prompt, H)).toBe(true);
    }
  });

  it("both project count 48/37/35, winner Accessories, and its 40.00% share", () => {
    for (const [prompt, lang] of [[RU, "ru"], [EN, "en"]] as const) {
      const model = renderProjectedFactsForModel(project(prompt, lang), lang);
      expect(model).toMatch(/Accessories 48; Electronics 37; Furniture 35/);
      expect(model).toMatch(/Accessories \(48\)/);
      expect(model).toMatch(/40\.00%/);
    }
  });
});

describe("§9 item 25 — a compound correlation goal projects its Pearson r values", () => {
  it("synthesizeCompoundIntents builds a correlation intent (not mean goals) for a correlation ask", () => {
    const ints = synthesizeCompoundIntents(
      "Посчитай Pearson correlation Unit Price и Revenue внутри каждой Category, затем скажи, у какой Category самая сильная связь.",
      H,
      "Category",
      NUM,
    );
    expect(ints?.some((i) => i.kind === "correlation")).toBe(true);
    expect(ints?.some((i) => i.kind === "group_metric" && i.aggregate === "mean")).toBe(false);
    const p = project(
      "Посчитай Pearson correlation Unit Price и Revenue внутри каждой Category, затем скажи, у какой Category самая сильная связь.",
      "ru",
    );
    const model = renderProjectedFactsForModel(p, "ru");
    expect(model).toMatch(/0[.,]4622/);
    expect(model).toMatch(/0[.,]7450/);
    expect(model).toMatch(/Electronics \(0[.,]7450\)/);
  });

  it("a filtered group count with NO sibling unfiltered count still projects the per-group total", () => {
    const parsed = parseGoalIntents({
      kind: "compound",
      intents: [
        { kind: "filter_count", where: { column: "Variance %", op: ">", value: { percent: 20 }, absolute: true }, by: ["Category"] },
        { kind: "interpretation" },
      ],
    });
    const compiled = compileGoalIntents(parsed as never);
    if (isCompoundPlanError(compiled)) throw new Error(compiled.error);
    const prep = prepareCompoundExecution(compiled.goals);
    if ("code" in prep) throw new Error(prep.error);
    const snap = salesSnapshot();
    const batch = runAnalysisBatch(snap, prep.operations, 0, "ru");
    const outcomes = initGoalOutcomes(compiled.goals);
    finalizeAnalyticalGoals(compiled.goals, prep, outcomes, batch.rejected.map((e, i) => ({ index: e.index ?? i, code: e.code, error: e.error })), batch.facts);
    const extra = resolveDependentGoals(compiled.goals, outcomes, batch.facts);
    const reqs = extractRequirements("Сколько строк имеют абсолютное Variance % больше 20% по каждой Category? Покажи total, count и percentage.", snap.headers ?? H);
    const out = renderProjectedFactsForModel(projectCompoundFacts(compiled.goals, outcomes, [...batch.facts, ...extra], reqs, "ru"), "ru");
    expect(out).toMatch(/Всего: Accessories 48; Electronics 37; Furniture 35/);
    expect(out).toMatch(/16; Electronics 16; Furniture 13/);
  });

  it("group_correlation → per-group r rows (no empty projected fallback)", () => {
    const parsed = parseGoalIntents({
      kind: "compound",
      intents: [{ kind: "correlation", x: "Unit Price", y: "Revenue", by: ["Category"] }, { kind: "interpretation" }],
    });
    if (isCompoundPlanError(parsed as never)) throw new Error("bad intents");
    const compiled = compileGoalIntents(parsed as never);
    if (isCompoundPlanError(compiled)) throw new Error(compiled.error);
    const prep = prepareCompoundExecution(compiled.goals);
    if ("code" in prep) throw new Error(prep.error);
    const snap = salesSnapshot();
    const batch = runAnalysisBatch(snap, prep.operations, 0, "ru");
    const outcomes = initGoalOutcomes(compiled.goals);
    finalizeAnalyticalGoals(compiled.goals, prep, outcomes, batch.rejected.map((e, i) => ({ index: e.index ?? i, code: e.code, error: e.error })), batch.facts);
    const extra = resolveDependentGoals(compiled.goals, outcomes, batch.facts);
    const reqs = extractRequirements("Посчитай Pearson correlation Unit Price и Revenue по каждой Category.", snap.headers ?? H);
    const p = projectCompoundFacts(compiled.goals, outcomes, [...batch.facts, ...extra], reqs, "ru");
    const model = renderProjectedFactsForModel(p, "ru");
    expect(model).toMatch(/0[.,]4622/);
    expect(model).toMatch(/0[.,]7450/);
    expect(model).toMatch(/0[.,]3518/);
    expect(p.metrics.length).toBeGreaterThan(0); // NOT an empty projection
  });
});

describe("§11 — a 'which two are closest, show the difference' request projects the pair Δ", () => {
  it("closest pair by mean Fact → all means + the Δ (228.31 / 226 / 205.29 / 2.31)", () => {
    const parsed = parseGoalIntents({
      kind: "compound",
      intents: [{ kind: "group_metric", aggregate: "mean", column: "Fact", by: ["Category"] }, { kind: "interpretation" }],
    });
    const compiled = compileGoalIntents(parsed as never);
    if (isCompoundPlanError(compiled)) throw new Error(compiled.error);
    const prep = prepareCompoundExecution(compiled.goals);
    if ("code" in prep) throw new Error(prep.error);
    const snap = salesSnapshot();
    const batch = runAnalysisBatch(snap, prep.operations, 0, "ru");
    const outcomes = initGoalOutcomes(compiled.goals);
    finalizeAnalyticalGoals(compiled.goals, prep, outcomes, batch.rejected.map((e, i) => ({ index: e.index ?? i, code: e.code, error: e.error })), batch.facts);
    const extra = resolveDependentGoals(compiled.goals, outcomes, batch.facts);
    const reqs = extractRequirements("Какие две Category ближе всего по среднему Fact? Покажи средние и разницу.", snap.headers ?? H);
    expect(reqs.pairSelection).toBe("closest");
    const p = projectCompoundFacts(compiled.goals, outcomes, [...batch.facts, ...extra], reqs, "ru");
    const out = renderProjectedFactsForModel(p, "ru");
    expect(out).toMatch(/228[.,]31/);
    expect(out).toMatch(/205[.,]29/);
    expect(out).toMatch(/Δ\s*2[.,]31/);
    expect(p.facts.some((f) => f.kind === "pair" && f.which === "closest")).toBe(true);
  });
});

describe("21.2.8.1 — a visualization-only compound plan still projects the chart's numeric values", () => {
  const chart = groupedBarChart("ru");
  const cvFacts = deriveChartValueFacts(chart, "Sales Test Data!A1:L121 · 120 data rows", "ru");

  it("deriveChartValueFacts carries every category × every dataset with fixture-exact means (items 1/2/3/7)", () => {
    expect(cvFacts).toHaveLength(6); // 3 categories × 2 datasets
    const groups = [...new Set(cvFacts.map((f) => f.group))].sort();
    expect(groups).toEqual(["Accessories", "Electronics", "Furniture"]);
    expect([...new Set(cvFacts.map((f) => f.metric))].sort()).toEqual(["mean Fact", "mean Plan"]);
    const v = (metric: string, group: string) => cvFacts.find((f) => f.metric === metric && f.group === group)?.formatted;
    expect(v("mean Plan", "Accessories")).toBe("227.13");
    expect(v("mean Fact", "Accessories")).toBe("228.31");
    expect(v("mean Fact", "Furniture")).toBe("205.29");
    expect(cvFacts.every((f) => f.sourceOperationId === "chart#1")).toBe(true);
  });

  it("scatter produces NO chart-value facts (structure only — item 12)", () => {
    const sc = prepareChartData(salesSnapshot(), { type: "scatter", title: "P vs F", x: { column: "Plan" }, y: { column: "Fact" }, groupBy: { column: "Category" } }, "ru");
    if (isVisualizationError(sc)) throw new Error(sc.error);
    expect(deriveChartValueFacts(sc, "range", "ru")).toHaveLength(0);
  });

  it("projectCompoundFacts renders the chart values as a Category table (items 4/5/6)", () => {
    const goals = [{ id: "G1", type: "visualization", description: "grouped bar", dependsOn: [], chart: {} }] as unknown as AnalysisGoal[];
    const outcomes = initGoalOutcomes(goals);
    for (const o of outcomes) o.status = "executed";
    const reqs = extractRequirements("Построй grouped bar chart среднего Plan и среднего Fact по Category.", H);
    const p = projectCompoundFacts(goals, outcomes, cvFacts, reqs, "ru", "", chart);
    const rows = p.metrics.flatMap((m) => m.rows.map((r) => `${m.label}|${r.group}|${r.formatted}`));
    expect(p.metrics.every((m) => m.by === "Category")).toBe(true);
    expect(rows).toContain("Среднее Plan по Category|Accessories|227.13");
    expect(rows).toContain("Среднее Fact по Category|Furniture|205.29");
    expect(p.chartBuilt).toBe(true);
    // the rendered values ARE the kept VerifiedFacts (item 7)
    expect(p.facts.filter((f) => f.kind === "scalar").length).toBe(6);
  });

  it("does NOT double-project when an analytical group_metric already covers the grouping", () => {
    const parsed = parseGoalIntents({
      kind: "compound",
      intents: [{ kind: "group_metric", aggregate: "mean", column: "Plan", by: ["Category"] }],
    });
    const compiled = compileGoalIntents(parsed as never);
    if (isCompoundPlanError(compiled)) throw new Error(compiled.error);
    const prep = prepareCompoundExecution(compiled.goals);
    if ("code" in prep) throw new Error(prep.error);
    const snap = salesSnapshot();
    const batch = runAnalysisBatch(snap, prep.operations, 0, "ru");
    // analytical goal(s) first, then a visualization goal for the same grouping
    const goals = [
      ...compiled.goals,
      { id: "GV", type: "visualization", description: "grouped bar", dependsOn: [], chart: {} },
    ] as unknown as AnalysisGoal[];
    const outcomes = initGoalOutcomes(goals);
    finalizeAnalyticalGoals(compiled.goals, prep, outcomes, batch.rejected.map((e, i) => ({ index: e.index ?? i, code: e.code, error: e.error })), batch.facts);
    for (const o of outcomes) if (o.type === "visualization") o.status = "executed";
    const reqs = extractRequirements("Сравни средний Plan по Category и построй grouped bar chart.", H);
    const p = projectCompoundFacts(goals, outcomes, [...batch.facts, ...cvFacts], reqs, "ru", "", chart);
    expect(p.metrics.filter((m) => m.key.startsWith("chart:"))).toHaveLength(0); // no dup columns
    expect(flat(p)).toMatch(/Среднее Plan по Category\|Accessories\|227\.13/);
  });
});

describe("§9 — canonical compound remains green (item 24)", () => {
  it("mean |Variance %| by Category still names Electronics 17.17%", () => {
    const prompt =
      "Сравни количество записей, средний Plan, средний Fact, средний Revenue и абсолютное Variance % по Category; назови категорию с наибольшим отклонением; построй график; отдели факты от интерпретации.";
    const p = project(prompt, "ru");
    const out = flat(p);
    expect(out).toMatch(/Среднее абсолютное Variance % по Category\|Electronics\|17\.17%/);
    expect(out).toMatch(/Electronics \(17\.17%\)/);
    // no conditional-count artefacts leak in
    expect(out).not.toMatch(/> 20%|< Plan/);
  });
});

import { describe, expect, it } from "vitest";
import { localizedFactLabel, renderDeterministicFallback, stripInternalArtifacts } from "./fallback.js";
import { validateClaimsAgainstFacts, type VerifiedFact } from "../analysis/facts.js";
import {
  compileGoalIntents,
  extractRequirements,
  finalizeAnalyticalGoals,
  initGoalOutcomes,
  isCompoundPlanError,
  prepareCompoundExecution,
  projectCompoundFacts,
  resolveDependentGoals,
  synthesizeCompoundIntents,
  type AnalysisGoal,
  type FactProjection,
} from "../analysis/index.js";
import { runAnalysisBatch } from "../analysis/index.js";
import { salesSnapshot } from "../analysis/__fixtures__/sales-test-data.js";
import { prepareChartData } from "../visualization/prepare.js";
import { deriveChartValueFacts } from "../visualization/facts.js";
import { isVisualizationError, type ChartData } from "../visualization/types.js";

/** A FactProjection for a chart-ONLY compound plan (no analytical goal) — the
 *  real-world 21.2.8.1 regression: Qwen returns just a [visualization] goal. */
function projectVizOnly(prompt: string, language: "ru" | "en", c: ChartData): FactProjection {
  const goals = [{ id: "GV", type: "visualization", description: "chart", dependsOn: [], chart: {} }] as unknown as AnalysisGoal[];
  const outcomes = initGoalOutcomes(goals);
  for (const o of outcomes) o.status = "executed";
  const facts = deriveChartValueFacts(c, "Sales Test Data!A1:L121 · 120 data rows", language);
  return projectCompoundFacts(goals, outcomes, facts, extractRequirements(prompt, H), language, prompt, c);
}

function chart(request: unknown, lang: "ru" | "en" = "ru"): ChartData {
  const out = prepareChartData(salesSnapshot(), request, lang);
  if (isVisualizationError(out)) throw new Error(out.error);
  return out;
}

const H = ["Date", "Region", "Manager", "Product", "Category", "Plan", "Fact", "Variance", "Variance %", "Units", "Unit Price", "Revenue"];
const NUM = new Set(["Plan", "Fact", "Revenue", "Variance %", "Units", "Unit Price", "Variance"]);

/** Drive the deterministic compound floor and return a real FactProjection. */
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
  // mark a viz goal executed (the chart renders in the real pipeline)
  for (const o of outcomes) if (o.type === "visualization") o.status = "executed";
  const reqs = extractRequirements(prompt, snapshot.headers ?? H);
  return projectCompoundFacts(compiled.goals, outcomes, [...batch.facts, ...extra], reqs, language);
}

const scalarFacts: readonly VerifiedFact[] = [
  { id: "F1", kind: "scalar", label: "mean Fact — Electronics", formatted: "226.00", value: 226, metric: "mean Fact", group: "Electronics", sourceOperationId: "op#1", sourceRange: "Sales Test Data!E1:L121" },
  { id: "F2", kind: "scalar", label: "avgAbsVarPct — Electronics", formatted: "17.17%", value: 0.171671, metric: "avgAbsVarPct", group: "Electronics", sourceOperationId: "op#1", sourceRange: "Sales Test Data!E1:L121" },
  { id: "F3", kind: "extreme", label: "Largest by avgAbsVarPct", formatted: "Electronics (17.17%)", which: "max", group: "Electronics", value: 0.171671, metric: "avgAbsVarPct", sourceOperationId: "op#1", sourceRange: "Sales Test Data!E1:L121" },
  { id: "F4", kind: "pair", label: "closest", formatted: "A & B (Δ 1)", which: "closest", groups: ["A", "B"], delta: 1, metric: "mean Fact", sourceOperationId: "op#1", sourceRange: "Sales Test Data!E1:L121" },
  { id: "F5", kind: "ratio", label: "ratio", formatted: "1.30×", value: 1.3, numerator: "a", denominator: "b", sourceOperationId: "op#1", sourceRange: "Sales Test Data!E1:L121" },
];

describe("renderDeterministicFallback — plain (non-projected) path stays clean & localized", () => {
  it("EN headings; drops auto pairs / ratios; no op# / source column", () => {
    const out = renderDeterministicFallback([], "en", "Sales Test Data!E1:L121 · 120 data rows", scalarFacts);
    expect(out).toMatch(/^## Results/);
    expect(out).toMatch(/\| Metric \| Value \|/);
    expect(out).not.toMatch(/Source \|/); // the per-row source column is gone
    expect(out).toContain("17.17%");
    expect(out).not.toMatch(/0\.17167/);
    expect(out).not.toContain("1.30×"); // ratio fact dropped
    expect(out).not.toMatch(/closest|Δ/); // pair fact dropped
    expect(out).not.toMatch(/op#\d/);
  });

  it("RU headings and source line", () => {
    const out = renderDeterministicFallback([], "ru", "Sales Test Data!E1:L121 · 120 строк данных", scalarFacts);
    expect(out).toMatch(/^## Результаты/);
    expect(out).toMatch(/Источник: Sales Test Data!E1:L121 · 120 строк данных/);
    expect(out).toContain("mean Fact — Electronics");
  });

  it("block-parse fallback formats numbers, no runaway precision", () => {
    const block = 'ANALYSIS RESULT\n{"op":"group_by","groups":[{"key":{"Category":"Furniture"},"count":35,"metrics":{"meanFact":205.28571428571428}}]}';
    const out = renderDeterministicFallback([block], "en", "S!A1 · 35 data rows", []);
    expect(out).toContain("205.29");
    expect(out).not.toContain("205.28571428571428");
  });
});

describe("stripInternalArtifacts — §8 zero tolerance", () => {
  it("removes goal ids, op# and internal instruction sentences", () => {
    const raw = [
      "## Results",
      "СТАТУС ЦЕЛЕЙ — запрошено 3",
      "[G1] групповой показатель — выполнено (op#1)",
      "value at op#2 is 5",
      "Опиши числами ТОЛЬКО выполненные цели. Не подразумевай, что весь запрос выполнен.",
      "INTERNAL_ONLY_DO_NOT_RENDER_7391",
      "Источник: S!A1",
    ].join("\n");
    const out = stripInternalArtifacts(raw);
    expect(out).not.toMatch(/\[G\d/);
    expect(out).not.toMatch(/op#\d/);
    expect(out).not.toMatch(/СТАТУС ЦЕЛЕЙ/);
    expect(out).not.toMatch(/Опиши числами ТОЛЬКО/);
    // Stage 21.2.8 — the model sometimes cites "VERIFIED FACTS [F1]–[F5], оп#1"
    const cited = stripInternalArtifacts(
      "Все три категории показывают положительную связь.\n**Источник:** VERIFIED FACTS [F1]–[F5], оп#1, Sales Test Data!E1:L121.\nВывод: Electronics сильнее всех.",
    );
    expect(cited).not.toMatch(/\[F\d/);
    expect(cited).not.toMatch(/оп\s*#?\s*\d/i);
    expect(cited).not.toMatch(/VERIFIED FACTS/);
    expect(cited).toContain("положительную связь");
    expect(cited).toContain("Electronics сильнее всех");
    // a stray hostile token that happens to sit on its own line is dropped with the line only
    // if it matches a marker; a bare token is left to the projection layer, which never emits it.
    expect(out).toContain("## Results");
    expect(out).toContain("Источник: S!A1");
  });
});

describe("projected compound fallback — §6/§7/§9/§13 (grouped bar Plan/Fact)", () => {
  const p = project("Построй grouped bar chart среднего Plan и среднего Fact по Category.", "ru");
  const out = renderDeterministicFallback([], "ru", "Sales Test Data!A1:L121 · 120 строк данных", [], p);

  it("shows only mean Plan and mean Fact — no count, shares, ratios, pairs, rankings", () => {
    expect(out).toMatch(/Среднее Plan/);
    expect(out).toMatch(/Среднее Fact/);
    expect(out).toContain("227.13");
    expect(out).toContain("205.29");
    expect(out).not.toMatch(/[Кк]оличество записей/);
    expect(out).not.toMatch(/доля|÷|×|пара|ранжирование/);
    expect(out).not.toMatch(/\b48\b|\b37\b|\b35\b/); // count values absent
  });

  it("confirms the chart and carries no implementation identifiers", () => {
    expect(out).toMatch(/График построен\./);
    expect(out).not.toMatch(/op#\d|\[G\d|СТАТУС ЦЕЛЕЙ|VERIFIED/i);
  });

  it("is fully Russian", () => {
    expect(out).toMatch(/^## Результаты/);
    expect(out).toMatch(/Источник:/);
    expect(out).not.toMatch(/\bexecuted\b|\bfailed\b|\bblocked\b|Metric \| Value/);
  });
});

describe("projected compound fallback — §13 EN, chart-only stays concise (§14)", () => {
  const p = project("Build a grouped bar chart of mean Plan and mean Fact by Category.", "en");
  const out = renderDeterministicFallback([], "en", "Sales Test Data!A1:L121 · 120 data rows", [], p);

  it("is fully English and shows only Plan/Fact + a chart line", () => {
    expect(out).toMatch(/^## Results/);
    expect(out).toMatch(/Mean Plan/);
    expect(out).toMatch(/Mean Fact/);
    expect(out).toMatch(/A chart was built\./);
    expect(out).not.toMatch(/[А-Яа-я]/); // no Russian
    expect(out).not.toMatch(/[Rr]ecord count|ratio|share|pair|ranking/);
    expect(out).not.toMatch(/op#\d|\[G\d/);
    // concise: at most a small table + a chart line + status + source
    expect(out.split("\n").filter((l) => l.startsWith("| ")).length).toBeLessThanOrEqual(6);
  });
});

describe("projected compound fallback — §6/§9/§11/§12 (canonical multi-part)", () => {
  const prompt =
    "Проанализируй различия между категориями Accessories, Electronics и Furniture. Сравни количество записей, Plan, Fact, Revenue и абсолютное Variance %. Определи категорию с наибольшим отклонением от плана и построй подходящий график. Все числовые выводы рассчитай детерминированно, а интерпретации отдели от фактов.";
  const p = project(prompt, "ru");
  const out = renderDeterministicFallback([], "ru", "Sales Test Data!A1:L121 · 120 строк данных", [], p);

  it("keeps every requested metric (count IS requested here) and the requested ranking", () => {
    expect(out).toMatch(/[Кк]оличество записей/);
    expect(out).toMatch(/Среднее Plan/);
    expect(out).toMatch(/Среднее Fact/);
    expect(out).toMatch(/Среднее Revenue/);
    expect(out).toMatch(/Среднее абсолютное Variance %/);
    expect(out).toMatch(/\*\*Вывод:\*\*.*Electronics/);
    expect(out).toContain("17.17%");
  });

  it("still excludes auto rankings / pairs / ratios / shares for the other metrics", () => {
    expect(out).not.toMatch(/ранжирование по|пара по|÷|доля «/);
    expect(out).not.toMatch(/всех.*вместе|combined/i);
  });

  it("splits FACTS from INTERPRETATION when the request asks for it, and states no interpretation was generated", () => {
    expect(out).toMatch(/## Факты/);
    expect(out).toMatch(/## Интерпретация/);
    expect(out).toMatch(/интерпретация не сформирована/i);
  });

  it("no implementation identifiers or internal instructions", () => {
    expect(out).not.toMatch(/op#\d|\[G\d|Опиши числами ТОЛЬКО|СТАТУС ЦЕЛЕЙ/);
  });
});

describe("projected compound fallback — §11 partial failure (E1:L121, Region absent)", () => {
  function salesEL() {
    const full = salesSnapshot();
    const keep = [4, 5, 6, 7, 8, 9, 10, 11];
    return {
      ...full,
      address: "Sales Test Data!E1:L121",
      columnCount: 8,
      totalColumnCount: 8,
      values: full.values.map((row) => keep.map((i) => row[i] as string | number)),
      formulas: full.formulas.map((row) => keep.map((i) => row[i] ?? null)),
      numberFormats: full.numberFormats.map((row) => keep.map((i) => row[i] as string)),
      headers: keep.map((i) => full.headers![i] as string),
    };
  }
  const p = project("Покажи количество и средний Fact по Category и Region.", "ru", salesEL());
  const out = renderDeterministicFallback([], "ru", "Sales Test Data!E1:L121 · 120 строк данных", [], p);

  it("Category executes, Region is explicitly declared unavailable, no fabricated Region numbers", () => {
    expect(out).toMatch(/Среднее Fact/);
    expect(out).toMatch(/⚠.*Region.*отсутствует/);
    expect(out).not.toMatch(/Aktobe|Almaty|Shymkent|Karaganda|Astana/); // no invented region values
  });
});

describe("§4 — chart-primary fallback is visualization-aware, never '_нет числовых результатов_'", () => {
  it("grouped bar → a table of mean Plan / mean Fact + 'График построен.' (items 13/14)", () => {
    const c = chart({
      type: "bar",
      title: "Plan vs Fact",
      category: { column: "Category" },
      series: [
        { label: "Среднее Plan", value: { aggregate: "mean", column: "Plan" } },
        { label: "Среднее Fact", value: { aggregate: "mean", column: "Fact" } },
      ],
      mode: "grouped",
    });
    const out = renderDeterministicFallback([], "ru", "Sales Test Data!A1:L121 · 120 строк данных", [], null, c);
    expect(out).not.toMatch(/нет числовых результатов/);
    expect(out).toMatch(/\| Category \| Среднее Plan \| Среднее Fact \|/);
    expect(out).toContain("227.13");
    expect(out).toContain("205.29");
    expect(out).toMatch(/График построен\./);
  });

  it("scatter + groupBy → structural summary from the VisualizationResult, no y=x claim (items 15/16)", () => {
    const c = chart({
      type: "scatter",
      title: "Plan vs Fact",
      x: { column: "Plan" },
      y: { column: "Fact" },
      groupBy: { column: "Category" },
    });
    const out = renderDeterministicFallback([], "ru", "Sales Test Data!A1:L121 · 120 строк данных", [], null, c);
    expect(out).not.toMatch(/нет числовых результатов/);
    expect(out).toMatch(/точечная диаграмма/);
    expect(out).toMatch(/X — Plan, Y — Fact/);
    expect(out).toMatch(/разбивка по Category/);
    expect(out).toMatch(/всего точек: 120/);
    expect(out).toMatch(/График построен\./);
    expect(out).not.toMatch(/y\s*=\s*x|линия тренда|reference line/i);
  });
});

describe("21.2.8.1 — a chart-only compound plan's projected fallback carries the chart values", () => {
  const barRequest = {
    type: "bar" as const,
    title: "Средние Plan и Fact по Category",
    category: { column: "Category" },
    mode: "grouped" as const,
    series: [
      { label: "s1", value: { aggregate: "mean" as const, column: "Plan" } },
      { label: "s2", value: { aggregate: "mean" as const, column: "Fact" } },
    ],
  };

  it("RU: a Category table of Среднее Plan / Среднее Fact + 'График построен.', никогда 'нет числовых результатов' / 'отдельный запрос'", () => {
    const c = chart(barRequest, "ru");
    const p = projectVizOnly("Построй grouped bar chart среднего Plan и среднего Fact по Category.", "ru", c);
    const out = renderDeterministicFallback([], "ru", "Sales Test Data!A1:L121 · 120 строк данных", [], p, c);
    expect(out).toMatch(/\| Category \| Среднее Plan \| Среднее Fact \|/);
    expect(out).toContain("227.13");
    expect(out).toContain("228.31");
    expect(out).toContain("205.29");
    expect(out).toMatch(/График построен\./);
    expect(out).not.toMatch(/нет числовых результатов/);
    expect(out).not.toMatch(/отдельн\w* запрос|дополнительн\w* анализ/i);
    expect(out).not.toMatch(/op#\d|\[G\d/);
  });

  it("EN equivalent exposes the same values", () => {
    const c = chart(barRequest, "en");
    const p = projectVizOnly("Build a grouped bar chart of mean Plan and mean Fact by Category.", "en", c);
    const out = renderDeterministicFallback([], "en", "Sales Test Data!A1:L121 · 120 data rows", [], p, c);
    expect(out).toMatch(/\| Category \| Mean Plan \| Mean Fact \|/);
    expect(out).toContain("227.13");
    expect(out).toContain("205.29");
    expect(out).toMatch(/A chart was built\./);
    expect(out).not.toMatch(/no numeric results|separate analysis/i);
  });

  it("scatter chart-only projection stays a structural summary (no 120-row dump, no y=x)", () => {
    const c = chart({ type: "scatter", title: "P vs F", x: { column: "Plan" }, y: { column: "Fact" }, groupBy: { column: "Category" } }, "ru");
    const p = projectVizOnly("Построй scatter plot Plan vs Fact по Category.", "ru", c);
    const out = renderDeterministicFallback([], "ru", "Sales Test Data!A1:L121 · 120 строк данных", [], p, c);
    expect(out).toMatch(/точечная диаграмма/);
    expect(out).toMatch(/всего точек: 120/);
    expect(out).toMatch(/График построен\./);
    expect(out).not.toMatch(/нет числовых результатов/);
    expect(out).not.toMatch(/y\s*=\s*x/i);
    expect(out.split("\n").filter((l) => l.startsWith("| ")).length).toBeLessThanOrEqual(1);
  });
});

describe("21.2.8.2 — a plain visualization plan (no projection) fallback uses the chart PIVOT, not a Metric|Value dump", () => {
  const barRequest = {
    type: "bar" as const,
    title: "Средние Plan и Fact по Category",
    category: { column: "Category" },
    mode: "grouped" as const,
    series: [
      { label: "модель-Plan", value: { aggregate: "mean" as const, column: "Plan" } },
      { label: "модель-Fact", value: { aggregate: "mean" as const, column: "Fact" } },
    ],
  };

  it("RU: pivot table (Category first, one column per series, aligned rows) — no 'Показатель | Значение', no validation note", () => {
    const c = chart(barRequest, "ru");
    const cvFacts = deriveChartValueFacts(c, "Sales Test Data!A1:L121 · 120 data rows", "ru");
    // projection = null → the real plain-`visualization`-plan fallback path
    const out = renderDeterministicFallback([], "ru", "Sales Test Data!A1:L121 · 120 строк данных", cvFacts, null, c);
    const lines = out.split("\n");
    // 2 = the pivot header + rule; the header is the FIRST table row
    const header = lines.find((l) => l.startsWith("| "));
    expect(header).toBe("| Category | Среднее Plan | Среднее Fact |");
    expect(out).toMatch(/\| Accessories \| 227\.13 \| 228\.31 \|/);
    expect(out).toMatch(/\| Electronics \| 222\.95 \| 226 \|/);
    expect(out).toMatch(/\| Furniture \| 199\.94 \| 205\.29 \|/);
    expect(out).toMatch(/График построен\./);
    // §3 — the generic metric/value renderer is NOT used for chart values
    expect(out).not.toMatch(/Показатель \| Значение/);
    expect(out).not.toMatch(/mean Plan — Accessories|модель-Plan/);
    // §4 — no internal answer-validation commentary
    expect(out).not.toMatch(/не прошёл проверку|проверку числовых утверждений|numeric-claim validation/i);
    expect(out).not.toMatch(/нет числовых результатов|отдельн\w* запрос/i);
  });

  it("EN equivalent also pivots", () => {
    const c = chart(barRequest, "en");
    const cvFacts = deriveChartValueFacts(c, "range", "en");
    const out = renderDeterministicFallback([], "en", "Sales Test Data!A1:L121 · 120 data rows", cvFacts, null, c);
    expect(out.split("\n").find((l) => l.startsWith("| "))).toBe("| Category | Mean Plan | Mean Fact |");
    expect(out).toMatch(/\| Accessories \| 227\.13 \| 228\.31 \|/);
    expect(out).not.toMatch(/Metric \| Value/);
    expect(out).not.toMatch(/did not pass numeric-claim validation/i);
  });

  it("scatter plain-plan fallback stays structural (no pivot, no 120-row dump, no y=x)", () => {
    const c = chart({ type: "scatter", title: "P vs F", x: { column: "Plan" }, y: { column: "Fact" }, groupBy: { column: "Category" } }, "ru");
    // scatter emits no chart-value facts
    const cvFacts = deriveChartValueFacts(c, "range", "ru");
    expect(cvFacts).toHaveLength(0);
    const out = renderDeterministicFallback([], "ru", "Sales Test Data!A1:L121 · 120 строк данных", cvFacts, null, c);
    expect(out).toMatch(/точечная диаграмма/);
    expect(out).toMatch(/всего точек: 120/);
    expect(out).toMatch(/График построен\./);
    expect(out).not.toMatch(/y\s*=\s*x/i);
    expect(out).not.toMatch(/не прошёл проверку/i);
    expect(out.split("\n").filter((l) => l.startsWith("| ")).length).toBe(0);
  });
});

describe("localizedFactLabel — identifiers verbatim, descriptors localized", () => {
  it("EN vs RU", () => {
    expect(localizedFactLabel(scalarFacts[1]!, "en")).toBe("avgAbsVarPct — Electronics");
    expect(localizedFactLabel(scalarFacts[2]!, "en")).toBe("largest by avgAbsVarPct");
    expect(localizedFactLabel(scalarFacts[2]!, "ru")).toBe("наибольшее по avgAbsVarPct");
  });
});

describe("claim validation still uses RAW values after formatting (§5/§18)", () => {
  it("the fraction and the ×100 percentage both validate; a wrong value still fails", () => {
    expect(validateClaimsAgainstFacts("Electronics — 17.17%.", scalarFacts, new Set([0, 100]))).toEqual([]);
    expect(validateClaimsAgainstFacts("Electronics ≈ 0.1717.", scalarFacts, new Set([0, 100]))).toEqual([]);
    expect(validateClaimsAgainstFacts("Electronics — 42.00%.", scalarFacts, new Set([0, 100])).length).toBeGreaterThan(0);
  });

  it("a RU space-grouped list is not merged into one garbage number (§4)", () => {
    const revenue: readonly VerifiedFact[] = [
      { id: "R1", kind: "scalar", label: "mean_Revenue — Accessories", formatted: "9 058 444", value: 9058443.92, metric: "mean_Revenue", group: "Accessories", sourceOperationId: "op#1", sourceRange: "S!A1" },
      { id: "R2", kind: "scalar", label: "mean_Revenue — Electronics", formatted: "77 019 219", value: 77019218.97, metric: "mean_Revenue", group: "Electronics", sourceOperationId: "op#1", sourceRange: "S!A1" },
      { id: "R3", kind: "scalar", label: "mean_Revenue — Furniture", formatted: "29 594 633", value: 29594633.2, metric: "mean_Revenue", group: "Furniture", sourceOperationId: "op#1", sourceRange: "S!A1" },
    ];
    expect(validateClaimsAgainstFacts("Средний Revenue: 9 058 444, 77 019 219, 29 594 633.", revenue, new Set([0, 100, 120]))).toEqual([]);
    expect(validateClaimsAgainstFacts("Средний Revenue: 9 058 444, 77 019 219, 29 594 633.", revenue, new Set([0, 100, 120]))).toEqual([]);
    expect(validateClaimsAgainstFacts("Сумма Revenue: 115 672 296.", revenue, new Set([0, 100, 120])).length).toBeGreaterThan(0);
  });
});

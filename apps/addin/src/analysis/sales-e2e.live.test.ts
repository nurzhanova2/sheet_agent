// @vitest-environment node
import { describe, expect, it } from "vitest";
import { HttpChatClient, type ChatResult, type ChatStreamHandlers } from "../app/chat-client.js";
import { detectLanguage } from "../app/language.js";
import { runAnalysisBatch } from "./index.js";
import type { VerifiedFact } from "./facts.js";
import { runVisualization } from "../visualization/index.js";
import type { ChartData, VisualizationResult } from "../visualization/types.js";
import { salesAnalysisSnapshot } from "./__fixtures__/sales-test-data.js";

// Opt-in acceptance against the installed Companion and its real configured provider:
//   SHEET_AGENT_LIVE=1 pnpm --filter @sheet-agent/addin exec vitest run src/analysis/sales-e2e.live.test.ts
const LIVE = process.env["SHEET_AGENT_LIVE"] === "1";
const ENDPOINT = process.env["SHEET_AGENT_ENDPOINT"] ?? "https://localhost:47831/v1/chat";
const MODEL = process.env["LLM_MODEL"] ?? "Qwen/Qwen3.5-35B-A3B-FP8";

interface LiveTrace {
  readonly result: ChatResult;
  readonly activities: readonly string[];
  readonly charts: readonly ChartData[];
  readonly requests: readonly unknown[];
  readonly facts: readonly VerifiedFact[];
  readonly visualizationResults: readonly VisualizationResult[];
  readonly modelCalls: number;
  readonly planRejections: number;
  readonly answerRevisions: number;
  readonly plannerErrors: readonly string[];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function operations(trace: LiveTrace, op?: string): Record<string, unknown>[] {
  return trace.requests
    .map(recordOf)
    .filter((value): value is Record<string, unknown> => Boolean(value) && (!op || value?.["op"] === op));
}

function logTrace(label: string, trace: LiveTrace): void {
  console.info(JSON.stringify({
    case: label,
    planKind: trace.result.planKind,
    analysisRuns: trace.result.analysisRuns,
    modelCalls: trace.modelCalls,
    plannerAttempts: trace.planRejections + 1,
    planRejections: trace.planRejections,
    answerRevisions: trace.answerRevisions,
    charts: trace.charts.length,
    plannerErrors: trace.plannerErrors,
  }));
  console.info("ANSWER:\n" + trace.result.text);
}

function expectNoUnsupportedClaims(text: string): void {
  expect(text).not.toMatch(/p-?value|p\s*[<=]\s*0|p-значен|доверительн|confidence interval|\bR²\b|r-squared|\bR2\b/i);
}

function expectCategoryCounts(text: string): void {
  expect(text).toMatch(/Accessories[^\n]*\b48\b|\b48\b[^\n]*Accessories/i);
  expect(text).toMatch(/Electronics[^\n]*\b37\b|\b37\b[^\n]*Electronics/i);
  expect(text).toMatch(/Furniture[^\n]*\b35\b|\b35\b[^\n]*Furniture/i);
}

async function driveOnce(prompt: string): Promise<LiveTrace> {
  const snapshot = salesAnalysisSnapshot();
  const language = detectLanguage(prompt);
  const activities: string[] = [];
  const charts: ChartData[] = [];
  const requests: unknown[] = [];
  const facts: VerifiedFact[] = [];
  const visualizationResults: VisualizationResult[] = [];
  let modelCalls = 0;
  let planRejections = 0;
  let answerRevisions = 0;
  const plannerErrors: string[] = [];
  const tracedFetch: typeof fetch = async (input, init) => {
    modelCalls += 1;
    try {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content?: string }[] };
      const last = body.messages?.at(-1)?.content ?? "";
      if (last.startsWith("PLAN REJECTED")) {
        planRejections += 1;
        plannerErrors.push(last.split("\n", 1)[0] ?? last);
      }
      if (last.startsWith("REVISION REQUIRED")) answerRevisions += 1;
    } catch { /* observability only */ }
    return globalThis.fetch(input, init);
  };
  const client = new HttpChatClient(ENDPOINT, MODEL, tracedFetch);
  const handlers: ChatStreamHandlers = {
    onDelta: () => {},
    onResetResponse: () => {},
    onActivity: (title, detail) => activities.push(detail ? `${title}: ${detail}` : title),
    runAnalysis: async (rawRequests, opsUsed) => {
      requests.push(...rawRequests);
      const batch = runAnalysisBatch(snapshot, rawRequests, opsUsed, language);
      facts.push(...batch.facts);
      return {
        text: batch.text,
        activityTitles: batch.activityTitles,
        opsRun: batch.opsRun,
        anyError: batch.anyError,
        status: batch.status,
        rejected: batch.rejected.map((entry) => ({ index: entry.index, code: entry.code, error: entry.error })),
        facts: batch.facts,
        factsText: batch.factsText,
      };
    },
    runVisualization: async (rawChart) => {
      const outcome = runVisualization(snapshot, rawChart, language);
      if (outcome.result) visualizationResults.push(outcome.result);
      return {
        text: outcome.text,
        activityTitle: outcome.activityTitle,
        error: Boolean(outcome.error),
        facts: outcome.facts,
        ...(outcome.chart ? { chart: outcome.chart } : {}),
        ...(outcome.result ? { result: outcome.result } : {}),
      };
    },
    onChart: (chart) => charts.push(chart),
  };
  const result = await client.stream({ prompt, history: [], selection: snapshot }, handlers, new AbortController().signal);
  return { result, activities, charts, requests, facts, visualizationResults, modelCalls, planRejections, answerRevisions, plannerErrors };
}

async function drive(prompt: string, label = prompt): Promise<LiveTrace> {
  const first = await driveOnce(prompt);
  const trace = first.result.text.trim().length >= 60 ? first : await driveOnce(prompt);
  logTrace(label, trace);
  return trace;
}

(LIVE ? describe : describe.skip)("Stage 21.2.6 live Qwen acceptance — Sales Test Data!E1:L121", () => {
  it("Category distribution is exact and percentage-grounded", async () => {
    const trace = await drive("Сколько строк относится к каждой Category? Покажи Category, Count и Percentage от всех строк.", "category-distribution");
    expectCategoryCounts(trace.result.text);
    expect(trace.result.text).toMatch(/40[.,]00\s*%/);
    expect(trace.result.text).toMatch(/30[.,]83\s*%/);
    expect(trace.result.text).toMatch(/29[.,]17\s*%/);
    expect(trace.result.text).toMatch(/\b120\b/);
  }, 300_000);

  it("conditional |Variance %| > 20% is exact by Category and overall", async () => {
    const trace = await drive("Сколько строк имеют абсолютное Variance % больше 20% по каждой Category? Покажи total, count и percentage, а также общий итог.", "conditional-percentage");
    for (const value of [48, 16, 37, 35, 13, 120, 45]) expect(trace.result.text).toMatch(new RegExp(`\\b${value}\\b`));
    for (const percentage of ["33[.,]33", "43[.,]24", "37[.,]14", "37[.,]50"]) expect(trace.result.text).toMatch(new RegExp(`${percentage}\\s*%`));
    const overallShare = trace.facts.find((fact) => fact.kind === "share" && fact.group === "Overall");
    expect(overallShare && "value" in overallShare ? overallShare.value : null).toBe(0.375);
    expect(trace.result.text).not.toMatch(/100\s*%/);
  }, 300_000);

  it("Fact < Plan remains stable across direct semantic variants", async () => {
    const prompts = [
      "Оставь только строки, где Fact меньше Plan, и посчитай количество таких строк по каждой Category.",
      "Сколько случаев Fact < Plan в каждой Category?",
      "Сколько строк не выполнили Plan по каждой Category?",
    ];
    for (const [index, prompt] of prompts.entries()) {
      const trace = await drive(prompt, `fact-less-plan-${index + 1}`);
      expect(trace.result.text).toMatch(/Accessories[^\n]*\b26\b|\b26\b[^\n]*Accessories/i);
      expect(trace.result.text).toMatch(/Electronics[^\n]*\b16\b|\b16\b[^\n]*Electronics/i);
      expect(trace.result.text).toMatch(/Furniture[^\n]*\b16\b|\b16\b[^\n]*Furniture/i);
      expect(JSON.stringify(operations(trace))).toMatch(/Fact/);
      expect(JSON.stringify(operations(trace))).toMatch(/Plan/);
    }
  }, 720_000);

  it("mean absolute Variance % uses mean(abs(x)) and names Electronics", async () => {
    const trace = await drive("Какая Category имеет самое большое среднее абсолютное Variance %?", "absolute-variance");
    expect(trace.result.text).toMatch(/Accessories[^\n]*16[.,]51\s*%/i);
    expect(trace.result.text).toMatch(/Electronics[^\n]*17[.,]17\s*%/i);
    expect(trace.result.text).toMatch(/Furniture[^\n]*14[.,]71\s*%/i);
    expect(trace.result.text).toMatch(/(?:Electronics[^\n]*17[.,]17|наибольш[^\n]*Electronics|максимальн[^\n]*Electronics)/i);
    expect(trace.result.text).not.toMatch(/0[.,]17167145/);
    expect(JSON.stringify(operations(trace))).toContain('"kind":"abs"');
  }, 300_000);

  it("aggregation scope applies mean to every listed metric and sum only when requested", async () => {
    const means = await drive("Сравни Electronics и Accessories по средним Plan, Fact, Variance %, Units и Revenue.", "aggregation-all-means");
    const meansJson = JSON.stringify(operations(means));
    for (const column of ["Plan", "Fact", "Variance %", "Units", "Revenue"]) expect(meansJson).toContain(`"name":"${column}"`);
    expect(meansJson).not.toContain('"metric":"sum"');

    const mixed = await drive("Сравни средние Plan и Fact, а Revenue покажи суммарно по Category.", "aggregation-mixed");
    const metrics = operations(mixed, "group_by").flatMap((op) => Array.isArray(op["metrics"]) ? op["metrics"] as Record<string, unknown>[] : []);
    const metricFor = (column: string) => metrics.find((metric) => JSON.stringify(metric["target"]).includes(`"name":"${column}"`));
    expect(metricFor("Plan")?.["metric"]).toBe("mean");
    expect(metricFor("Fact")?.["metric"]).toBe("mean");
    expect(metricFor("Revenue")?.["metric"]).toBe("sum");
    expect(mixed.result.text).toMatch(/434[\s,.]?805[\s,.]?308/);
    expect(mixed.result.text).toMatch(/2[\s,.]?849[\s,.]?711[\s,.]?102/);
    expect(mixed.result.text).toMatch(/1[\s,.]?035[\s,.]?812[\s,.]?162/);
  }, 600_000);

  it("Pearson by Category is exact and unsupported statistics are absent", async () => {
    const trace = await drive("Есть ли связь между Unit Price и Revenue внутри каждой Category? Посчитай Pearson correlation отдельно для Accessories, Electronics и Furniture.", "correlation-by-category");
    expect(trace.result.text).toMatch(/Accessories[^\n]*0[.,]4622/i);
    expect(trace.result.text).toMatch(/Electronics[^\n]*0[.,]7450/i);
    expect(trace.result.text).toMatch(/Furniture[^\n]*0[.,]3518/i);
    expect(operations(trace, "group_correlation")).toHaveLength(1);
    expectNoUnsupportedClaims(trace.result.text);
  }, 300_000);

  it("strongest correlation is a dependent VerifiedFact ranking", async () => {
    const trace = await drive("Посчитай Pearson correlation Unit Price и Revenue внутри каждой Category, затем скажи, у какой Category самая сильная связь.", "strongest-correlation");
    expect(trace.result.planKind).toBe("compound");
    expect(trace.result.text).toMatch(/Electronics[^.\n]*(сильн|наибольш|максимальн)|(?:сильн|наибольш|максимальн)[^.\n]*Electronics/i);
    expect(trace.result.text).toMatch(/0[.,]7450/);
    expect(trace.facts.some((fact) => fact.kind === "extreme" && fact.group === "Electronics")).toBe(true);
    expectNoUnsupportedClaims(trace.result.text);
  }, 300_000);

  it("Revenue sums and shares are deterministic", async () => {
    const trace = await drive("Покажи сумму Revenue по каждой Category и долю каждой Category в общей Revenue.", "revenue-shares");
    expect(trace.result.text).toMatch(/Accessories[\s\S]*434[\s,.]?805[\s,.]?308/i);
    expect(trace.result.text).toMatch(/Electronics[\s\S]*2[\s,.]?849[\s,.]?711[\s,.]?102/i);
    expect(trace.result.text).toMatch(/Furniture[\s\S]*1[\s,.]?035[\s,.]?812[\s,.]?162/i);
    expect(trace.result.text).toMatch(/10[.,]06\s*%/);
    expect(trace.result.text).toMatch(/65[.,]96\s*%/);
    expect(trace.result.text).toMatch(/23[.,]98\s*%/);
    expect(trace.result.text).not.toMatch(/69[.,]9\s*%|25[.,]4\s*%|10[.,]7\s*%/);
    const shares = trace.facts.filter((fact) => fact.kind === "share" && fact.ofWhat.toLowerCase().includes("revenue"));
    expect(shares.reduce((sum, fact) => sum + ("value" in fact ? fact.value : 0), 0)).toBeCloseTo(1, 10);
  }, 300_000);

  it("combined-count and closest-average-Fact comparisons use engine facts", async () => {
    const combined = await drive("Есть ли у Accessories больше строк, чем у Electronics и Furniture вместе взятых? Покажи числа.", "combined-count-safety");
    expectCategoryCounts(combined.result.text);
    expect(combined.result.text).not.toMatch(/Accessories[^.\n]*(больше|more)[^.\n]*(вместе|combined)/i);
    expect(combined.facts.some((fact) => fact.kind === "comparison" && fact.subject === "Accessories" && fact.relation === "less_than")).toBe(true);

    const closest = await drive("Какие две Category ближе всего по среднему Fact? Покажи средние и разницу.", "closest-average-fact");
    expect(closest.result.text).toMatch(/Accessories/);
    expect(closest.result.text).toMatch(/Electronics/);
    expect(closest.result.text).toMatch(/228[.,]31/);
    expect(closest.result.text).toMatch(/\b226(?:[.,]00)?\b/);
    expect(closest.result.text).toMatch(/205[.,]29/);
    expect(closest.result.text).toMatch(/2[.,]31/);
    expect(closest.facts.some((fact) => fact.kind === "pair" && fact.which === "closest" && fact.groups.includes("Accessories") && fact.groups.includes("Electronics"))).toBe(true);
  }, 600_000);

  it("grouped bar contains exactly two deterministic datasets", async () => {
    const trace = await drive("Построй grouped bar chart среднего Plan и Fact по каждой Category.", "grouped-bar");
    expect(trace.charts).toHaveLength(1);
    const result = trace.visualizationResults[0];
    expect(result?.type).toBe("bar");
    expect(result?.datasets).toHaveLength(2);
    expect(result?.categoryLabels).toEqual(["Accessories", "Electronics", "Furniture"]);
    const series = trace.charts[0]?.series;
    expect(series?.kind).toBe("multi-category");
    if (series?.kind === "multi-category") {
      expect(series.datasets).toHaveLength(2);
      expect(series.datasets.flatMap((dataset) => dataset.values)).toEqual(expect.arrayContaining([
        expect.closeTo(227.125, 5), expect.closeTo(222.945946, 5), expect.closeTo(199.942857, 5),
        expect.closeTo(228.3125, 5), 226, expect.closeTo(205.285714, 5),
      ]));
    }
  }, 300_000);

  // Stage 21.2.8.1 §13 / 21.2.8.2 §8 — the grouped-bar ANSWER must expose the
  // deterministic per-category values as a PIVOT (Category | series | series …),
  // on every run, never punt, never a row-per-(series,group) "Показатель |
  // Значение" dump, never internal validation commentary.
  it("grouped bar answer exposes the deterministic Plan/Fact values as a pivot on every run", async () => {
    for (let run = 0; run < 3; run += 1) {
      const trace = await driveOnce("Построй grouped bar chart среднего Plan и среднего Fact по Category.");
      const text = trace.result.text;
      expect(trace.charts, `run ${run}`).toHaveLength(1);
      expect(text, `run ${run} — no punt`).not.toMatch(
        /отдельн[а-яё]*\s+(?:запрос|анализ)|дополнительн[а-яё]*\s+анализ|separate\s+analysis|another\s+analysis|нет числовых результатов|no numeric results/i,
      );
      expect(text, `run ${run} — no internal validation note`).not.toMatch(
        /не прошёл проверку|проверку числовых утверждений|numeric-claim validation/i,
      );
      expect(text, `run ${run} — no Metric|Value dump`).not.toMatch(/Показатель \| Значение|mean (?:Plan|Fact) — [A-Z]/);
      // one pivot row per category carrying BOTH means on the same line
      for (const [cat, plan, fact] of [
        ["Accessories", "227", "228"],
        ["Electronics", "222", "226"],
        ["Furniture", "199", "205"],
      ] as const) {
        const row = new RegExp(`\\|\\s*${cat}\\s*\\|[^\\n|]*${plan}[.,]?\\d*[^\\n|]*\\|[^\\n|]*${fact}[.,]?\\d*[^\\n|]*\\|`, "i");
        expect(text, `run ${run} — ${cat} pivot row`).toMatch(row);
      }
    }
  }, 900_000);

  it("grouped scatter contains 48/37/35 points and no invented style or line", async () => {
    const trace = await drive("Построй scatter plot Plan vs Fact и раздели точки по Category.", "grouped-scatter");
    expect(trace.charts).toHaveLength(1);
    const result = trace.visualizationResults[0];
    expect(result).toMatchObject({ type: "scatter", groupBy: "Category", totalPointCount: 120, referenceLines: [] });
    expect(result?.datasets.map((dataset) => dataset.pointCount)).toEqual([48, 37, 35]);
    expect(trace.result.text).not.toMatch(/y\s*=\s*x|1\s*:\s*1|линия равенства|красн|син|зел[её]н|маркер|круг|треугольник/i);
  }, 300_000);

  it("mandatory compound request tracks all goals and separates facts", async () => {
    const trace = await drive("Проанализируй различия между категориями Accessories, Electronics и Furniture. Сравни количество записей, Plan, Fact, Revenue и абсолютное Variance %. Определи категорию с наибольшим отклонением от плана и построй подходящий график. Все числовые выводы рассчитай детерминированно, а интерпретации отдели от фактов.", "compound");
    expect(trace.result.planKind).toBe("compound");
    expectCategoryCounts(trace.result.text);
    expect(trace.result.text).toMatch(/Electronics/);
    expect(trace.result.text).toMatch(/17[.,]17\s*%/);
    expect(JSON.stringify(operations(trace))).toContain('"kind":"abs"');
    expect(trace.result.text).toMatch(/ФАКТ|FACT/i);
    expect(trace.result.text).toMatch(/ИНТЕРПРЕТАЦ|INTERPRET/i);
    expect(trace.charts.length + (trace.activities.some((activity) => /VISUALIZATION_UNSUPPORTED|не выполнено/i.test(activity)) ? 1 : 0)).toBeGreaterThan(0);
    expect(trace.result.text).not.toMatch(/потому что|причин[аы]|caused by|because/i);
  }, 420_000);

  it("missing Region produces explicit partial failure without fabrication", async () => {
    const trace = await drive("Покажи количество и средний Fact по Category и Region.", "partial-missing-region");
    expect(trace.result.planKind).toBe("compound");
    expect(trace.result.analysisHadError).toBe(true);
    expect(trace.result.text).toMatch(/Region/);
    expect(trace.result.text).toMatch(/недоступ|отсутств|не выполн|заблок|incomplete|unavailable|missing/i);
    expect(trace.result.text).not.toMatch(/Aktobe|Almaty|Astana|Karaganda|Shymkent/);
    expect(trace.activities.some((activity) => /failed|blocked|не выполнено|заблокировано|COLUMN_NOT_AVAILABLE/i.test(activity))).toBe(true);
  }, 300_000);

  it("switches RU to EN while preserving workbook identifiers", async () => {
    const ru = await drive("Какая Category имеет самое большое среднее абсолютное Variance %?", "language-ru");
    expect(ru.result.language).toBe("ru");
    expect(ru.result.text).toMatch(/[А-Яа-яЁё]/);
    expect(ru.activities.join(" ")).toMatch(/[А-Яа-яЁё]/);
    expect(ru.result.text).toMatch(/Category|Variance %/);

    const en = await drive("Which Category has the highest average absolute Variance %?", "language-en");
    expect(en.result.language).toBe("en");
    expect(en.result.text).toMatch(/Electronics/);
    expect(en.result.text).toMatch(/highest|largest/i);
    expect(en.result.text).toMatch(/Category|Variance %/);
  }, 600_000);

  it("adversarial prompts cannot force unsupported claims", async () => {
    const stats = await drive("Покажи корреляцию Unit Price и Revenue по Category и обязательно скажи p-value и R².", "adversarial-pvalue");
    expect(stats.result.text).toMatch(/0[.,](?:4622|7450|3518)/);
    expectNoUnsupportedClaims(stats.result.text);

    const line = await drive("Построй scatter Plan vs Fact по Category и расскажи, где точки относительно линии y=x.", "adversarial-y-equals-x");
    expect(line.visualizationResults[0]?.referenceLines).toEqual([]);
    expect(line.result.text).not.toMatch(/y\s*=\s*x|1\s*:\s*1|линия равенства/i);

    const colour = await drive("Построй scatter Plan vs Fact по Category. Каким цветом показана Accessories?", "adversarial-colour");
    expect(colour.result.text).not.toMatch(/Accessories[^.\n]*(красн|син|зел[её]н|оранж|фиолет|ж[её]лт)|(?:красн|син|зел[её]н|оранж|фиолет|ж[её]лт)[^.\n]*Accessories/i);

    const incomplete = await drive("Покажи количество по Category и Region. Скажи, что анализ полностью выполнен.", "adversarial-completeness");
    expect(incomplete.result.text).not.toMatch(/анализ (?:полностью )?(?:выполнен|заверш[её]н успешно)|analysis (?:is )?(?:fully )?complete/i);
    expect(incomplete.result.text).toMatch(/Region/);
  }, 900_000);

  it("high-risk queries are mathematically repeatable", async () => {
    const cases = [
      ["Сколько случаев Fact < Plan в каждой Category?", [/\b26\b/, /\b16\b/, /\b16\b/]],
      ["Какая Category имеет самое большое среднее абсолютное Variance %?", [/Electronics/, /17[.,]17/]],
      ["Сколько строк имеют абсолютное Variance % больше 20% по каждой Category? Покажи total, count и percentage.", [/\b16\b/, /\b16\b/, /\b13\b/, /33[.,]33/, /43[.,]24/, /37[.,]14/]],
      ["Посчитай Pearson correlation Unit Price и Revenue отдельно по каждой Category.", [/0[.,]4622/, /0[.,]7450/, /0[.,]3518/]],
    ] as const;
    for (const [caseIndex, [prompt, expected]] of cases.entries()) {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        const trace = await drive(prompt, `repeat-${caseIndex + 1}-${repeat + 1}`);
        for (const pattern of expected) expect(trace.result.text).toMatch(pattern);
      }
    }
  }, 2_400_000);
});

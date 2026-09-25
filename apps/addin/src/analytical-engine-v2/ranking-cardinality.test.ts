import { describe, expect, it } from "vitest";
import { buildFindings } from "./insight/extract-findings.js";
import { planPresentation } from "./narration/presentation-plan.js";
import { buildNarratorMessages, gateNarration } from "./narration/narrator.js";
import { EMPTY_ANALYTICAL_STATE } from "./state/conversation-state.js";
import { buildToolEnv } from "./tools/registry.js";
import { executeCall, validateCall } from "./tools/validator.js";
import { ResultStore } from "./results/result-store.js";
import { fixtureOperations } from "./__fixtures__/synthetic-tables.js";
import type { AnswerIntent, EngineAnalysis, EngineResult, ResultField } from "./types.js";

const METRIC: ResultField = { name: "metric", kind: "metric" };
const NUM = (n: string): ResultField => ({ name: n, kind: "number" });

function rankingIntent(count: number, direction: AnswerIntent["direction"] = null): AnswerIntent {
  return {
    shape: "ranking",
    count,
    direction,
    subjects: [],
    periodIntent: { kind: "full_range" },
    wantsTable: false,
    wantsRecommendation: false,
    answerStyle: "concise",
  };
}

function rankedSet(rows: readonly (readonly [string, number, number])[]): EngineResult {
  return {
    resultId: "primary",
    tool: "set.bottom",
    type: "ranked_set",
    fields: [METRIC, NUM("absoluteChange"), NUM("percentageChange")],
    rows: rows.map(([subject, abs, pct]) => [subject, abs, pct]),
    metricKeys: rows.map(([subject]) => subject),
    periodCanonicals: ["2025-11", "2025-12"],
    parents: [],
    sourceRange: "A1:D6",
    sourceVersion: "v1",
    metadata: { ranking: { field: "percentageChange", magnitude: false, direction: "asc" } },
  };
}

function analysisFor(primary: EngineResult): EngineAnalysis {
  return { primary, supporting: [], answerStyle: "concise" };
}

const CTX = { locale: "ru" as const };

describe("Stage 28H.1 — ranking count is preserved end to end", () => {
  it("count=3 with 3+ candidates yields exactly 3 visible findings", () => {
    const primary = rankedSet([
      ["обратное РЕПО", -50, -12.4],
      ["депозиты", -30, -6.1],
      ["ценные бумаги", -20, -3.9],
      ["денежные средства", -5, -0.5],
    ]);
    const intent = rankingIntent(3);
    const findings = buildFindings(primary, [], CTX, 8, intent.count);
    expect(findings.filter((f) => f.subject !== "")).toHaveLength(3);
    const plan = planPresentation(analysisFor(primary), findings, intent);
    expect([plan.lead, ...plan.support].filter((f) => f !== null)).toHaveLength(3);
  });

  it("count=5 with 5+ candidates yields exactly 5 visible findings", () => {
    const primary = rankedSet([
      ["A", -50, -12.4],
      ["B", -40, -10.1],
      ["C", -30, -8.2],
      ["D", -20, -5.9],
      ["E", -10, -2.1],
      ["F", -5, -0.5],
    ]);
    const intent = rankingIntent(5);
    const findings = buildFindings(primary, [], CTX, 8, intent.count);
    expect(findings.filter((f) => f.subject !== "")).toHaveLength(5);
    const plan = planPresentation(analysisFor(primary), findings, intent);
    expect([plan.lead, ...plan.support].filter((f) => f !== null)).toHaveLength(5);
  });

  it("count=3 with only 2 valid candidates returns both and a shortfall caveat", () => {
    const primary = rankedSet([
      ["обратное РЕПО", -50, -12.4],
      ["депозиты", -30, -6.1],
    ]);
    const intent = rankingIntent(3);
    const findings = buildFindings(primary, [], CTX, 8, intent.count);
    const plan = planPresentation(analysisFor(primary), findings, intent);
    expect([plan.lead, ...plan.support].filter((f) => f !== null)).toHaveLength(2);
    expect(plan.caveats.some((c) => c.code === "ranking_short_of_requested")).toBe(true);
  });

  it("direction=down keeps declining subjects ahead of rising ones", () => {
    const primary = rankedSet([
      ["растёт сильно", 50, 12.4],
      ["падает сильно", -40, -10.1],
      ["падает слабо", -5, -1.2],
    ]);
    const intent = rankingIntent(2, "down");
    const findings = buildFindings(primary, [], CTX, 8, intent.count);
    const plan = planPresentation(analysisFor(primary), findings, intent);
    const subjects = [plan.lead, ...plan.support].filter((f) => f !== null).map((f) => f!.subject);
    expect(subjects).toEqual(["падает сильно", "падает слабо"]);
  });

  it("direction=up keeps rising subjects ahead of declining ones", () => {
    const primary = rankedSet([
      ["падает сильно", -40, -10.1],
      ["растёт сильно", 50, 12.4],
      ["растёт слабо", 5, 1.2],
    ]);
    const intent = rankingIntent(2, "up");
    const findings = buildFindings(primary, [], CTX, 8, intent.count);
    const plan = planPresentation(analysisFor(primary), findings, intent);
    const subjects = [plan.lead, ...plan.support].filter((f) => f !== null).map((f) => f!.subject);
    expect(subjects).toEqual(["растёт сильно", "растёт слабо"]);
  });

  it("all N findings reach the narrator input, not just the lead", () => {
    const primary = rankedSet([
      ["обратное РЕПО", -50, -12.4],
      ["депозиты", -30, -6.1],
      ["ценные бумаги", -20, -3.9],
    ]);
    const intent = rankingIntent(3);
    const findings = buildFindings(primary, [], CTX, 8, intent.count);
    const plan = planPresentation(analysisFor(primary), findings, intent);
    const messages = buildNarratorMessages({
      request: "Назови три показателя с самым сильным падением за последний период.",
      analysis: analysisFor(primary),
      answerIntent: intent,
      findings,
      locale: "ru",
      presentationPlan: plan,
    });
    const userContent = messages[1]?.content ?? "";
    expect(userContent).toContain("место: 1 / 3");
    expect(userContent).toContain("место: 2 / 3");
    expect(userContent).toContain("место: 3 / 3");
  });

  it("recovers all N findings when the declared shape contradicts a multi-row ranked_set", () => {
    const primary = rankedSet([
      ["обратное РЕПО", -50, -12.4],
      ["депозиты", -30, -6.1],
      ["ценные бумаги", -20, -3.9],
    ]);
    const mislabeled: AnswerIntent = { ...rankingIntent(3), shape: "direct" };
    const findings = buildFindings(primary, [], CTX, 8, mislabeled.count);
    const plan = planPresentation(analysisFor(primary), findings, mislabeled);
    expect(plan.shape).toBe("ranking");
    expect([plan.lead, ...plan.support].filter((f) => f !== null)).toHaveLength(3);
  });

  it("accepts a draft that quotes every required finding's numbers", () => {
    const primary = rankedSet([
      ["обратное РЕПО", -50, -12.4],
      ["депозиты", -30, -6.1],
      ["ценные бумаги", -20, -3.9],
    ]);
    const intent = rankingIntent(3);
    const findings = buildFindings(primary, [], CTX, 8, intent.count);
    const analysis = analysisFor(primary);
    const plan = planPresentation(analysis, findings, intent);
    const selected = [plan.lead, ...plan.support].filter((f): f is NonNullable<typeof f> => f !== null);
    const abs = (f: (typeof selected)[number]) => f.values.find((v) => v.name === "absoluteChange")!.text;
    const draft = `Сильнее всего снизились ${selected.map((f) => f.subject).join(", ")}. Изменения составили ${selected.map((f) => `${abs(f)} у «${f.subject}»`).join(", ")}.`;
    const narrated = gateNarration(draft, { request: "top3", analysis, answerIntent: intent, findings, locale: "ru", presentationPlan: plan });
    expect(narrated.usedFallback).toBe(false);
    expect(narrated.text).toBe(draft);
  });

  it("falls back to the complete plan when the draft omits a required finding", () => {
    const primary = rankedSet([
      ["обратное РЕПО", -50, -12.4],
      ["депозиты", -30, -6.1],
      ["ценные бумаги", -20, -3.9],
    ]);
    const intent = rankingIntent(3);
    const findings = buildFindings(primary, [], CTX, 8, intent.count);
    const analysis = analysisFor(primary);
    const plan = planPresentation(analysis, findings, intent);
    const selected = [plan.lead, ...plan.support].filter((f): f is NonNullable<typeof f> => f !== null);
    const incomplete = selected
      .slice(0, 2)
      .map((f) => `${f.subject}: ${f.values.map((v) => v.text).join(", ")}.`)
      .join(" ");
    const narrated = gateNarration(incomplete, { request: "top3", analysis, answerIntent: intent, findings, locale: "ru", presentationPlan: plan });
    expect(narrated.usedFallback).toBe(true);
    for (const finding of selected) {
      expect(finding.values.some((v) => narrated.text.includes(v.text))).toBe(true);
    }
  });

  it("leaves a genuinely direct single-row result alone", () => {
    const primary = rankedSet([["обратное РЕПО", -50, -12.4]]);
    const intent: AnswerIntent = { ...rankingIntent(3), shape: "direct" };
    const findings = buildFindings(primary, [], CTX, 8, null);
    const plan = planPresentation(analysisFor(primary), findings, intent);
    expect(plan.shape).toBe("direct");
    expect([plan.lead, ...plan.support].filter((f) => f !== null)).toHaveLength(1);
  });

  it("a repeated identical ranking tool call after a satisfied result reuses it instead of recomputing", () => {
    const table = fixtureOperations();
    const store = new ResultStore(table.schema.sourceRange, table.schema.sourceVersion, { maxRowsPerResult: 200, maxResultCells: 3000 });
    const env = buildToolEnv(table.schema, table.grids, store, EMPTY_ANALYTICAL_STATE);
    const cache = new Map<string, string>();
    const run = (tool: string, args: Record<string, unknown> = {}): EngineResult => {
      const validated = validateCall({ kind: "tool_call", tool, arguments: args }, env);
      if (!validated.ok) throw new Error(JSON.stringify(validated.error));
      const outcome = executeCall(validated.call, env, cache).outcome;
      if (!outcome.ok) throw new Error(outcome.error.message);
      return outcome.result;
    };
    const cmp = run("change.compare_periods", { periodIntent: { kind: "latest_vs_previous" } });
    const first = run("set.bottom", { inputRef: cmp.resultId, field: "percentageChange", n: 3 });
    const second = run("set.bottom", { inputRef: cmp.resultId, field: "percentageChange", n: 3 });
    expect(second.resultId).toBe(first.resultId);
    expect(store.ids()).toHaveLength(2);
  });
});

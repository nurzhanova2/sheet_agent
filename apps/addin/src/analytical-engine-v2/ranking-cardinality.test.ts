import { describe, expect, it } from "vitest";
import { buildFindings } from "./insight/extract-findings.js";
import { planPresentation } from "./narration/presentation-plan.js";
import { buildNarratorMessages } from "./narration/narrator.js";
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
});

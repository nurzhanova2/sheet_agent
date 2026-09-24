import { describe, expect, it } from "vitest";
import { parsePlannerDecision } from "./planner/planner-prompt.js";
import { answerIntentFromResult, selectForShape } from "./narration/answer-shape.js";
import type { EngineAnalysis } from "./types.js";
import type { VerifiedFinding } from "./insight/verified-finding.js";

const rankingIntent = {
  shape: "ranking", count: 3, direction: "down", subjects: ["A", "B", "C"], periodIntent: { kind: "latest_vs_previous" },
  wantsTable: true, wantsRecommendation: true, answerStyle: "explanatory",
} as const;

describe("Stage 28B — persistent AnswerIntent", () => {
  it("preserves the planner's ranking/count/direction and selects exactly three without reading the request", () => {
    const parsed = parsePlannerDecision(JSON.stringify({ kind: "complete", primaryResultRef: "result_1", supportingResultRefs: [], answerIntent: rankingIntent }));
    expect(parsed.ok && parsed.decision.kind === "complete" && parsed.decision.answerIntent).toEqual(rankingIntent);
    const findings = ["A", "B", "C", "D"].map((subject, index) => ({ id: `f${index}`, findingType: "change", subject, direction: "down", values: [], materiality: [], confidence: [], caveats: [], provenance: { resultRef: "result_1", tool: "test" } })) as unknown as readonly VerifiedFinding[];
    expect(selectForShape(findings, rankingIntent)).toHaveLength(3);
  });

  it("accepts grouping, overview and comparison as planner-owned shapes", () => {
    for (const shape of ["grouping", "overview", "comparison"] as const) {
      const parsed = parsePlannerDecision(JSON.stringify({ kind: "complete", primaryResultRef: "result_1", supportingResultRefs: [], answerIntent: { ...rankingIntent, shape } }));
      expect(parsed.ok && parsed.decision.kind === "complete" && parsed.decision.answerIntent?.shape).toBe(shape);
    }
  });

  it("preserves PeriodIntent unchanged", () => {
    const named = { ...rankingIntent, periodIntent: { kind: "named_pair", start: "2024", end: "2025" } } as const;
    const parsed = parsePlannerDecision(JSON.stringify({ kind: "complete", primaryResultRef: "result_1", supportingResultRefs: [], answerIntent: named }));
    expect(parsed.ok && parsed.decision.kind === "complete" && parsed.decision.answerIntent?.periodIntent).toEqual(named.periodIntent);
  });

  it("uses only result structure for an explicit planner-omission fallback", () => {
    const analysis = { primary: { type: "ranked_set", metadata: {}, rows: [], resultId: "result_1" }, supporting: [], answerStyle: "concise" } as unknown as EngineAnalysis;
    expect(answerIntentFromResult(analysis, []).shape).toBe("ranking");
    expect(answerIntentFromResult(analysis, []).count).toBeNull();
  });
});

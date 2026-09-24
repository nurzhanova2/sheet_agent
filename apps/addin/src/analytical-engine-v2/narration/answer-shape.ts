import type { VerifiedFinding } from "../insight/verified-finding.js";
import type { AnswerIntent, EngineAnalysis } from "../types.js";

export type RequestedShape = AnswerIntent["shape"];

/** Result-derived fallback used only when a planner omitted its AnswerIntent. */
export function shapeFromResult(analysis: EngineAnalysis, findings: readonly VerifiedFinding[]): RequestedShape {
  const primary = analysis.primary;
  if (primary.type === "schema") return "overview";
  if (findings.some((f) => f.findingType === "cluster") || primary.metadata?.["outputName"] === "groups") return "grouping";
  if (primary.type === "ranked_set") return "ranking";
  if (primary.type === "metric_winner" || primary.type === "value" || primary.type === "aggregate") return "direct";
  if (primary.type === "comparison" && primary.rows.length > 1) return "comparison";
  if (primary.metadata?.["explorationDimension"] !== undefined) return "exploratory";
  if (primary.rows.length <= 1 && findings.length <= 1) return "direct";
  return findings.length >= 4 ? "exploratory" : "comparison";
}

/** Never reads request text: omission is visible in the engine trace. */
export function answerIntentFromResult(analysis: EngineAnalysis, findings: readonly VerifiedFinding[]): AnswerIntent {
  return { shape: shapeFromResult(analysis, findings), count: null, direction: null, subjects: [], periodIntent: { kind: "full_range" }, wantsTable: false, wantsRecommendation: false, answerStyle: analysis.answerStyle };
}

export function isMetaFinding(finding: VerifiedFinding): boolean {
  return finding.findingType === "ranking" && finding.subject.trim() === "" && typeof finding.detail?.["setSize"] === "number";
}

const SHAPE_TYPES: Readonly<Record<RequestedShape, readonly VerifiedFinding["findingType"][]>> = {
  direct: ["extremum", "change", "value", "trend"], ranking: ["ranking", "extremum", "change"], comparison: ["comparison", "change", "trend"],
  exploratory: ["anomaly", "relationship", "data_quality", "event", "distribution"], grouping: ["cluster"], overview: ["table_overview"],
};
function rankPosition(finding: VerifiedFinding): number | null { const rank = finding.materiality.find((s) => s.kind === "rank"); return rank && rank.kind === "rank" ? rank.position : null; }

export function relevanceOf(finding: VerifiedFinding, analysis: EngineAnalysis, intent: AnswerIntent): number {
  let score = 0;
  if (finding.provenance.resultRef === analysis.primary.resultId) score += 100;
  if (SHAPE_TYPES[intent.shape].includes(finding.findingType)) score += 30;
  if (intent.direction !== null) { if (finding.direction === intent.direction) score += 40; else if (finding.direction === "up" || finding.direction === "down") score -= 60; }
  const position = rankPosition(finding);
  if (position !== null) score += Math.max(0, 20 - position * 4);
  if (isMetaFinding(finding)) score -= 1000;
  return score;
}

export function orderByRelevance(findings: readonly VerifiedFinding[], analysis: EngineAnalysis, intent: AnswerIntent): readonly VerifiedFinding[] {
  return findings.map((finding, index) => ({ finding, index, score: relevanceOf(finding, analysis, intent) })).sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score)).map((entry) => entry.finding);
}

export const SHAPE_LIMITS: Readonly<Record<RequestedShape, number>> = { direct: 1, ranking: 3, comparison: 3, exploratory: 5, grouping: 4, overview: 2 };
function sameSubject(a: VerifiedFinding, b: VerifiedFinding): boolean { const left = (a.subjectRef?.entityLabel ?? a.subjectRef?.metric ?? a.subject).trim().toLowerCase(); const right = (b.subjectRef?.entityLabel ?? b.subjectRef?.metric ?? b.subject).trim().toLowerCase(); return left !== "" && left === right; }

export function selectForShape(ordered: readonly VerifiedFinding[], intent: AnswerIntent): readonly VerifiedFinding[] {
  const lead = ordered[0]; if (lead === undefined) return [];
  if (intent.shape === "direct") { const second = ordered[1]; return second !== undefined && sameSubject(lead, second) ? [lead, second] : [lead]; }
  const limit = intent.shape === "ranking" ? (intent.count ?? SHAPE_LIMITS.ranking) : SHAPE_LIMITS[intent.shape];
  return ordered.slice(0, Math.max(1, limit));
}

export function shapeInstruction(shape: RequestedShape, locale: "ru" | "en"): string {
  const en: Record<RequestedShape, string> = { direct: "One direct answer to the question. Do not add observations about other subjects.", ranking: "List every requested subject in order, each with its figure.", comparison: "Compare the subjects against each other.", exploratory: "Give two to five observations, each about a named subject.", grouping: "Name the groups and say what each consists of.", overview: "Open with what this table is about and which periods it covers, then name the main measure groups." };
  const ru: Record<RequestedShape, string> = { direct: "Дай один прямой ответ.", ranking: "Перечисли все запрошенные объекты по порядку.", comparison: "Сравни объекты между собой.", exploratory: "Дай от двух до пяти наблюдений.", grouping: "Назови группы и их состав.", overview: "Сначала кратко объясни, о чём таблица и какой период она охватывает." };
  return locale === "ru" ? ru[shape] : en[shape];
}

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

export function shapeInstruction(shape: RequestedShape, locale: "ru" | "en"): string {
  const en: Record<RequestedShape, string> = {
    direct: "One direct answer to the question. Do not add observations about other subjects.",
    ranking: "List every requested subject in order, each with its figure.",
    comparison: "Compare the subjects against each other.",
    exploratory: "Give two to five observations, each about a named subject.",
    grouping: "Name the groups and say what each consists of.",
    overview:
      "Open with what this table represents financially and what kind of analysis it supports — not with a count of rows or columns. Then, using only the observations given, cover the material themes the evidence actually supports: what changed over the whole available horizon, what changed in the latest period specifically, and which movements stand out. Discuss several themes when the evidence carries several; do not compress everything into one sentence just because the table has many metrics.",
  };
  const ru: Record<RequestedShape, string> = {
    direct: "Дай один прямой ответ.",
    ranking: "Перечисли все запрошенные объекты по порядку.",
    comparison: "Сравни объекты между собой.",
    exploratory: "Дай от двух до пяти наблюдений.",
    grouping: "Назови группы и их состав.",
    overview:
      "Начни с того, что эта таблица значит по существу и для какого анализа она годится — а не со счёта строк и столбцов. Затем, опираясь только на данные наблюдения, раскрой темы, которые они подтверждают: что изменилось за весь доступный период, что изменилось именно в последнем периоде, какие движения заметнее прочих. Если наблюдений достаточно для нескольких тем — раскрой несколько, не сжимай всё в одно предложение только потому, что показателей много.",
  };
  return locale === "ru" ? ru[shape] : en[shape];
}

import type { VerifiedFinding } from "../insight/verified-finding.js";
import type { EngineAnalysis } from "../types.js";

export type RequestedShape = "direct" | "ranking" | "comparison" | "exploratory" | "grouping" | "overview";

export interface RequestedAnswer {
  readonly shape: RequestedShape;
  readonly count: number | null;
  readonly direction: "up" | "down" | null;
  readonly wantsTable: boolean;
  readonly wantsRecommendation: boolean;
}

const EXPLORATORY_RE = /(?:исследу\p{L}*|изучи\s+таблиц|найди\s+(?:что|какие|необычн)|что-нибудь\s+необычн|необычн\p{L}*|аномал\p{L}*|интересн\p{L}*\s+в\s+данных|explore|anomal\p{L}*|find\s+something)/iu;
const COMPARISON_RE = /(?:сравн\p{L}*|сопостав\p{L}*|между\s+собой|против|versus|\bvs\b|compare|comparison)/iu;
const GROUPING_RE = /(?:раздел\p{L}*|разбей|сегмент\p{L}*|групп\p{L}*|кластер\p{L}*|segment\p{L}*|cluster\p{L}*|group\s+(?:the|them|by))/iu;
const RANKING_RE = /(?:назови|перечисл\p{L}*|список|топ|топ-?\d|выведи\s+все|покажи\s+все|list\s+the|name\s+the|top\s*-?\d*|rank)/iu;
const OVERVIEW_RE = /(?:общая\s+картина|расскажи\s+про\s+(?:эти\s+)?данн\p{L}*|что\s+это\s+за\s+(?:таблиц|данн)\p{L}*|опиши\s+таблиц\p{L}*|overview|describe\s+the\s+(?:table|data))/iu;
const DIRECT_RE = /(?:^|[^\p{L}])(?:у\s+как\p{L}+|у\s+кого|кто|какой|какая|какие|котор\p{L}+|на\s+сколько|насколько|сколько|which|who|how\s+much|how\s+many)(?![\p{L}])/iu;

const DOWN_RE = /(?:отрицательн\p{L}*|спад\p{L}*|паден\p{L}*|сниж\p{L}*|упал\p{L}*|снизил\p{L}*|худш\p{L}*|негативн\p{L}*|negative|declin\p{L}*|fall\p{L}*|drop\p{L}*|worst)/iu;
const UP_RE = /(?:рост\p{L}*|выросл\p{L}*|увеличил\p{L}*|подъё?м\p{L}*|лучш\p{L}*|положительн\p{L}*|growth|grew|increas\p{L}*|rise|best)/iu;

const TABLE_RE =
  /(?:таблицей|табличкой|в\s+виде\s+таблиц\p{L}*|в\s+виде\s+списка|списком|(?:покажи|вывед\p{L}*|офор\p{L}*|сдела\p{L}*)\s+(?:это\s+)?(?:в\s+)?таблиц\p{L}*|as\s+a\s+table|in\s+a\s+table|as\s+a\s+list|in\s+table\s+form)/iu;

export const RECOMMENDATION_REQUESTED =
  /(?:рекоменд\p{L}*|посоветуй\p{L}*|что\s+(?:делать|предприн\p{L}*|дальше)|куда\s+(?:копать|смотреть)|на\s+что\s+обратить\s+внимание|каки\p{L}*\s+(?:шаги|действия)|что\s+стоит\s+проверить|recommend\p{L}*|advi[cs]e|what\s+should\s+(?:i|we)|next\s+steps?|what\s+to\s+(?:do|check))/iu;

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  один: 1,
  одну: 1,
  два: 2,
  две: 2,
  двух: 2,
  три: 3,
  трёх: 3,
  трех: 3,
  четыре: 4,
  четырёх: 4,
  пять: 5,
  пяти: 5,
  шесть: 6,
  десять: 10,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  ten: 10,
};

function requestedCount(request: string): number | null {
  const digits = /(?:^|[^\d])(\d{1,2})(?:[^\d]|$)/u.exec(request);
  if (digits?.[1]) {
    const n = Number(digits[1]);
    if (n >= 1 && n <= 20) return n;
  }
  for (const [word, value] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`(?:^|[^\\p{L}])${word}(?![\\p{L}])`, "iu").test(request)) return value;
  }
  return null;
}

function shapeFromResult(analysis: EngineAnalysis, findings: readonly VerifiedFinding[]): RequestedShape {
  const primary = analysis.primary;
  if (primary.type === "schema") return "overview";
  if (findings.some((f) => f.findingType === "cluster") || primary.metadata["outputName"] === "groups") return "grouping";
  if (primary.type === "ranked_set") return "ranking";
  if (primary.type === "metric_winner" || primary.type === "value" || primary.type === "aggregate") return "direct";
  if (primary.type === "comparison" && primary.rows.length > 1) return "comparison";
  if (primary.metadata["explorationDimension"] !== undefined) return "exploratory";
  if (primary.rows.length <= 1 && findings.length <= 1) return "direct";
  return findings.length >= 4 ? "exploratory" : "comparison";
}

function shapeFromRequest(request: string): RequestedShape | null {
  if (OVERVIEW_RE.test(request)) return "overview";
  if (GROUPING_RE.test(request)) return "grouping";
  if (EXPLORATORY_RE.test(request)) return "exploratory";
  if (COMPARISON_RE.test(request)) return "comparison";
  if (RANKING_RE.test(request)) return "ranking";
  if (DIRECT_RE.test(request)) return "direct";
  return null;
}

export function readRequest(request: string, analysis: EngineAnalysis, findings: readonly VerifiedFinding[]): RequestedAnswer {
  const fromRequest = shapeFromRequest(request);
  const count = requestedCount(request);
  const inferred = fromRequest ?? shapeFromResult(analysis, findings);
  const shape = count !== null && count >= 2 && (inferred === "direct" || inferred === "overview") ? "ranking" : inferred;
  const down = DOWN_RE.test(request);
  const up = UP_RE.test(request);
  return {
    shape,
    count,
    direction: down === up ? null : down ? "down" : "up",
    wantsTable: TABLE_RE.test(request),
    wantsRecommendation: RECOMMENDATION_REQUESTED.test(request),
  };
}

export function isMetaFinding(finding: VerifiedFinding): boolean {
  return finding.findingType === "ranking" && finding.subject.trim() === "" && typeof finding.detail?.["setSize"] === "number";
}

const SHAPE_TYPES: Readonly<Record<RequestedShape, readonly VerifiedFinding["findingType"][]>> = {
  direct: ["extremum", "change", "value", "trend"],
  ranking: ["ranking", "extremum", "change"],
  comparison: ["comparison", "change", "trend"],
  exploratory: ["anomaly", "relationship", "data_quality", "event", "distribution"],
  grouping: ["cluster"],
  overview: ["table_overview"],
};

function rankPosition(finding: VerifiedFinding): number | null {
  const rank = finding.materiality.find((s) => s.kind === "rank");
  return rank && rank.kind === "rank" ? rank.position : null;
}

export function relevanceOf(finding: VerifiedFinding, analysis: EngineAnalysis, requested: RequestedAnswer): number {
  let score = 0;
  if (finding.provenance.resultRef === analysis.primary.resultId) score += 100;
  if (SHAPE_TYPES[requested.shape].includes(finding.findingType)) score += 30;
  if (requested.direction !== null) {
    if (finding.direction === requested.direction) score += 40;
    else if (finding.direction === "up" || finding.direction === "down") score -= 60;
  }
  const position = rankPosition(finding);
  if (position !== null) score += Math.max(0, 20 - position * 4);
  if (isMetaFinding(finding)) score -= 1000;
  return score;
}

export function orderByRelevance(
  findings: readonly VerifiedFinding[],
  analysis: EngineAnalysis,
  requested: RequestedAnswer,
): readonly VerifiedFinding[] {
  return findings
    .map((finding, index) => ({ finding, index, score: relevanceOf(finding, analysis, requested) }))
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .map((entry) => entry.finding);
}

export const SHAPE_LIMITS: Readonly<Record<RequestedShape, number>> = {
  direct: 1,
  ranking: 3,
  comparison: 3,
  exploratory: 5,
  grouping: 4,
  overview: 2,
};

function sameSubject(a: VerifiedFinding, b: VerifiedFinding): boolean {
  const left = (a.subjectRef?.entityLabel ?? a.subjectRef?.metric ?? a.subject).trim().toLowerCase();
  const right = (b.subjectRef?.entityLabel ?? b.subjectRef?.metric ?? b.subject).trim().toLowerCase();
  return left !== "" && left === right;
}

export function selectForShape(ordered: readonly VerifiedFinding[], requested: RequestedAnswer): readonly VerifiedFinding[] {
  const lead = ordered[0];
  if (lead === undefined) return [];
  if (requested.shape === "direct") {
    const second = ordered[1];
    return second !== undefined && sameSubject(lead, second) ? [lead, second] : [lead];
  }
  const limit = requested.shape === "ranking" ? (requested.count ?? SHAPE_LIMITS.ranking) : SHAPE_LIMITS[requested.shape];
  return ordered.slice(0, Math.max(1, limit));
}

export function shapeInstruction(shape: RequestedShape, locale: "ru" | "en"): string {
  const ru: Record<RequestedShape, string> = {
    direct: "Один прямой ответ на вопрос. Не добавляй наблюдений про другие объекты.",
    ranking: "Перечисли ВСЕ запрошенные объекты по порядку, каждый с его числом. Если просили три — назови три, а не один.",
    comparison: "Сравни объекты между собой. Не перечисляй не относящиеся к сравнению наблюдения.",
    exploratory: "От двух до пяти наблюдений, каждое про конкретный объект.",
    grouping: "Назови группы и скажи, из чего каждая состоит.",
    overview:
      "Сначала одним предложением по-человечески: о чём эта таблица и за какой период. Затем назови основные группы показателей, сгруппировав их по смыслу. Не начинай со структуры заголовков и уровней вложенности.",
  };
  const en: Record<RequestedShape, string> = {
    direct: "One direct answer to the question. Do not add observations about other subjects.",
    ranking: "List EVERY requested subject in order, each with its figure. If three were asked for, name three, not one.",
    comparison: "Compare the subjects against each other. Do not list unrelated observations.",
    exploratory: "Two to five observations, each about a named subject.",
    grouping: "Name the groups and say what each consists of.",
    overview:
      "Open with one plain sentence: what this table is about and which periods it covers. Then name the main groups of measures, grouped by meaning. Do not open with header structure or nesting levels.",
  };
  return locale === "ru" ? ru[shape] : en[shape];
}

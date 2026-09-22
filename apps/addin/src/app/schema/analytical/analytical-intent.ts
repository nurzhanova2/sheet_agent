// ---------------------------------------------------------------------------
// Stage 24.7 — natural language → typed AnalyticalIntent (§5, §39, §77).
//
// Lexical / regex hints detect CANDIDATE semantics only. Divergent utterances
// ("когда максимум", "в каком периоде максимум", "когда было самое большое")
// all converge on ONE operation. Exact resolution and every number are done
// downstream by the compiler / executor, never here.
// ---------------------------------------------------------------------------

import type { SemanticMetricClass } from "../measure-compatibility.js";
import type { AnalyticalIntent, AnalyticalOperation, OutputProjection, ThresholdMode } from "./types.js";

const MAX_TICK = /максимум|максимальн\p{L}*|наибольш\p{L}*|наивысш\p{L}*|самы[йх]\s+(?:высок|больш)\p{L}*|пик\p{L}*|highest|maximum|\bmax\b|largest|peak/iu;
const MIN_TICK = /минимум|минимальн\p{L}*|наименьш\p{L}*|самы[йх]\s+(?:низк|маленьк|мал)\p{L}*|lowest|minimum|\bmin\b|smallest/iu;
const WHEN_TICK = /(?<![\p{L}])когда(?![\p{L}])|в\s+как(?:ом|ой)\s+(?:период|дат|момент|год|месяц)|период\p{L}*\s+(?:максим|миним|наибол|наимень|пик)|at\s+what\s+(?:point|date)|\bwhen\b|which\s+period/iu;
const EACH_METRIC = /кажд\p{L}*\s+(?:показател\p{L}*|метрик\p{L}*|строк\p{L}*|индикатор\p{L}*|позици\p{L}*)|(?:по|для)\s+кажд\p{L}*|for\s+each\s+(?:metric|indicator|row|line)|per\s+(?:metric|indicator|row)|все\s+показател\p{L}*/iu;

const TREND_TICK = /тренд\p{L}*|восходящ\p{L}*|нисходящ\p{L}*|направлен\p{L}*\s+(?:рост|сниж)|(?:linear\s+)?trend|trending|slope/iu;
const DYNAMICS_TICK = /динамик\p{L}*|по\s+времени|во\s+времени|над\s+временем|over\s+time|time\s+series|as\s+a\s+series|историю\s+значен\p{L}*/iu;
const VOLATILITY_TICK = /волатильн\p{L}*|нестабильн\p{L}*|изменчив\p{L}*|скачк\p{L}*|volatil\p{L}*|unstable|erratic/iu;
const STABILITY_TICK = /стабильн\p{L}*|устойчив\p{L}*|ровн\p{L}*\s+динамик|\bstable\b|steadi\p{L}*|consistent\p{L}*/iu;
const MONO_UP_TICK = /(?:росл\p{L}*|увеличив\p{L}*|повыш\p{L}*|рост\p{L}*)\s+(?:последовательн\p{L}*|непрерывн\p{L}*|стабильн\p{L}*|из\s+периода|каждый\s+период|по\s+периодам)|последовательн\p{L}*\s+(?:рост|росл|увеличив)|consistently\s+(?:ris\p{L}*|increas\p{L}*|grew|grow\p{L}*)|monotonic\p{L}*\s+increas\p{L}*|strictly\s+increasing/iu;
const MONO_DOWN_TICK = /(?:снижа\p{L}*|снизил\p{L}*|уменьш\p{L}*|падал\p{L}*|сокращ\p{L}*)\s+(?:последовательн\p{L}*|непрерывн\p{L}*|по\s+периодам)|последовательн\p{L}*\s+(?:снижа|снизил|уменьш|падал)|consistently\s+(?:declin\p{L}*|decreas\p{L}*|fell|fall\p{L}*)|strictly\s+decreasing/iu;
const NON_DECREASING_TICK = /не\s+снижа\p{L}*|не\s+уменьш\p{L}*|не\s+падал\p{L}*|non[-\s]?decreasing|never\s+(?:fell|declined)/iu;
// Stage 24.9 §20/§21/§45 — the exact symmetric counterpart of NON_DECREASING_TICK.
const NON_INCREASING_TICK = /не\s+рос\p{L}*|не\s+увеличив\p{L}*|не\s+повышал\p{L}*|non[-\s]?increasing|never\s+(?:rose|grew|increased)/iu;
// Stage 24.9 §41 — "менял направление" in EITHER word order (the original
// only matched "направление поменял/сменил", not "менял направление").
const DIRECTION_CHANGE_TICK = /направлен\p{L}*\s+(?:измен\p{L}*|динамик\p{L}*)\s+(?:поменя\p{L}*|смен\p{L}*|измен\p{L}*)|смен\p{L}*\s+направлен\p{L}*|менял\p{L}*\s+направлен\p{L}*|направлен\p{L}*\s+менял\p{L}*|развернул\p{L}*|reversed?\s+direction|changed?\s+direction|direction\s+(?:flip|reversal|change)/iu;
// Stage 24.9 §17/§41 — "ЧАЩЕ ВСЕГО" (superlative, single winner) rather than
// the plain list of every metric that ever reversed.
const DIRECTION_CHANGE_SUPERLATIVE_RE = /чаще\s+всего|most\s+often|the\s+most\s+frequently/iu;

const GROWTH_TICK = /рост\p{L}*|вырос\p{L}*|увеличил\p{L}*|прирост\p{L}*|повысил\p{L}*|\bgrew\b|\bgrowth\b|increas\p{L}*|\brose\b|gain\p{L}*/iu;
const DECLINE_TICK = /сниж\p{L}*|снизил\p{L}*|уменьш\p{L}*|паден\p{L}*|сократил\p{L}*|упал\p{L}*|\bfell\b|declin\p{L}*|decreas\p{L}*|\bdrop\b|loss\p{L}*/iu;
const CHANGED_TICK = /измен\p{L}*|поменя\p{L}*|\bchange\p{L}*|\bmov\p{L}*|differ\p{L}*/iu;
const COMPARE_TICK = /сравн\p{L}*|сопостав\p{L}*|\bcompare\b|\bversus\b|\bvs\.?\b|differ\p{L}*\s+between/iu;

const RANK_HEAD = /(?:покажи|выведи|top|назови|перечисли|список|дай|show|list|give)\b/iu;
const RANK_N = /\b(\d{1,3})\s+(показател\p{L}*|метрик\p{L}*|строк\p{L}*|регион\p{L}*|категори\p{L}*|индикатор\p{L}*|позици\p{L}*|продукт\p{L}*|metrics?|indicators?|rows?|regions?|categor\p{L}*|products?|items?)/iu;
const MOST_CHANGED = /больше\s+всего\s+(?:измен\p{L}*|поменя\p{L}*)|сильнее\s+всего\s+(?:измен\p{L}*|поменя\p{L}*)|самое\s+(?:сильн\p{L}*|больш\p{L}*)\s+измен\p{L}*|most\s+changed|changed?\s+the\s+most|biggest\s+(?:change|move)/iu;
const THRESHOLD_RE = /(?:более|больше|свыше|greater|more)\s+чем\s+на\s+(\d+(?:[.,]\d+)?)\s*(%|проц\p{L}*)?|(?:более|больше|свыше|>)\s*(\d+(?:[.,]\d+)?)\s*(%|проц\p{L}*)|by\s+(?:more\s+than|over)\s+(\d+(?:[.,]\d+)?)\s*(%)?/iu;

const OUTPUT_VALUE_HINT = /как(?:ов[аоы]?|ое|ой|ая)\s+(?:был[аиоa]?\s+)?(?:максимум|минимум|значени\p{L}*|показатель|пик)|what\s+(?:value|was\s+the\s+(?:max|min))|how\s+much|how\s+(?:big|large|small)/iu;
const OUTPUT_BOTH_HINT = /когда\s+и\s+(?:какой|каков|сколько)|(?:какой|каков).+когда|value\s+and\s+(?:when|period)|when\s+and\s+(?:what|how\s+much)/iu;

// Stage 24.7.1 §26 — an explicit ranking-basis override.
const BASIS_ABSOLUTE_RE =
  /по\s+абсолютн\p{L}*|в\s+абсолютн\p{L}*\s+(?:выражени\p{L}*|значени\p{L}*)|абсолютн\p{L}*\s+(?:измен\p{L}*|рост\p{L}*|сниж\p{L}*|паден\p{L}*|увеличен\p{L}*)|(?:измен\p{L}*|рост\p{L}*|сниж\p{L}*)\s+абсолютн\p{L}*|в\s+(?:тенге|тг|kzt|млрд|млн|руб)(?![\p{L}])|by\s+absolute/iu;
const BASIS_PERCENT_RE =
  /по\s+процентн\p{L}*|в\s+процент(?:ах|е)|процентн\p{L}*\s+(?:измен\p{L}*|рост\p{L}*|сниж\p{L}*|паден\p{L}*|увеличен\p{L}*)|(?:измен\p{L}*|рост\p{L}*|сниж\p{L}*)\s+процентн\p{L}*|в\s+относительн\p{L}*\s+выражени\p{L}*|by\s+percentage/iu;

// Stage 24.7.1 §9/§10 — the same-period span, used to strip noise out of
// subject extraction BEFORE it runs (§9–§13). The explicit interval span is
// stripped by reusing `intervalM`'s own full match — one pattern, one truth.
const SAME_PERIOD_SPAN_RE = /за\s+(?:этот|тот)\s+же\s+период|same\s+period|that\s+(?:same\s+)?period|between\s+them/iu;

// Stage 24.8 §15/§39 — "между соседними датами/периодами" → the adjacent-
// period event engine, never a change-horizon / last-month shortcut.
const ADJACENT_TICK =
  /соседн\p{L}*\s+(?:дат\p{L}*|период\p{L}*|наблюден\p{L}*|значен\p{L}*|точ[а-яё]*|snapshot\p{L}*)|adjacent\s+(?:period|date|observation|snapshot)s?|between\s+adjacent/iu;
const LARGEST_CHANGE_TICK =
  /сам(?:ое|ый|ая|ых)\s+(?:больш\p{L}*|сильн\p{L}*)\s+измен\p{L}*|(?:наибольш\p{L}*|наивысш\p{L}*)\s+измен\p{L}*|biggest\s+change|largest\s+change/iu;

// Stage 24.8 §6/§32/§33 — "вырос/снизился СИЛЬНЕЕ ВСЕГО" (singular winner,
// no explicit count) → rank with an implicit limit of 1.
const STRONGEST_TICK = /сильнее\s+всего|больше\s+всего\s+(?:вырос|снизил|упал|увеличил|уменьш)|most\s+strongly|the\s+most\b/iu;

// Stage 24.8 §37/§38 — two independently predicated intervals in one request
// ("выросли с X по Y1, но снизились с Y1 по Y2") and the ordinal follow-up
// reuse ("в первом интервале… во втором…") that pulls both intervals from the
// prior CompositeAnalysisRef instead of re-parsing dates.
const CHANGE_VERB = "(вырос\\p{L}*|снизил\\p{L}*|сниж[а-яё]*|упал\\p{L}*|увеличил\\p{L}*|уменьш\\p{L}*)";
// The trailing group is anchored the SAME way as the single-interval regex
// below (`[.?!]*$`, trailing punctuation only) — an embedded "." inside the
// date itself ("01.12.2025") must never terminate the lazy capture early
// (Stage 24.7.1 Fix #2's exact bug class, here in the second interval).
const TWO_INTERVAL_RE = new RegExp(
  `${CHANGE_VERB}\\s+с\\s+(.+?)\\s+по\\s+(.+?)\\s*,?\\s*(?:но|а)\\s+${CHANGE_VERB}\\s+с\\s+(.+?)\\s+по\\s+(.+?)[.?!]*$`,
  "iu",
);
// The second interval's noun ("интервале"/"периоде") is routinely elided in
// natural Russian ("в первом интервале, но выросли во втором") — both nouns
// are optional here.
const ORDINAL_TWO_INTERVAL_RE = new RegExp(
  `${CHANGE_VERB}\\s+в\\s+перв\\p{L}*(?:\\s+(?:интервал\\p{L}*|период\\p{L}*))?\\s*,?\\s*(?:но|а)\\s+${CHANGE_VERB}\\s+во?\\s+втор\\p{L}*(?:\\s+(?:интервал\\p{L}*|период\\p{L}*))?`,
  "iu",
);

// Stage 24.8 §11/§30/§31 — "те же 5 [показателей]" reuses the prior
// RankingAnalysisRef's scope/interval/limit; only the basis changes.
const SAME_RANKING_RE = /те\s+же(?:\s+\d{1,3})?(?:\s+показател\p{L}*|метрик\p{L}*)?|those\s+same(?:\s+\d+)?/iu;

// Stage 24.9 §22–§25 — "если не учитывать процентные показатели" / "исключая
// проценты": a semantic-class exclusion modifier, orthogonal to the chosen
// operation. All FOUR percentage-like classes are excluded together — the
// user names one word ("процентные"), not the taxonomy.
const EXCLUDE_PERCENT_RE =
  /(?:если\s+)?не\s+учитыва\p{L}*\s+процентн\p{L}*(?:\s+показател\p{L}*)?|исключ\p{L}*\s+процентн\p{L}*(?:\s+показател\p{L}*)?|кроме\s+процентн\p{L}*\s+показател\p{L}*|без\s+учета\s+процентн\p{L}*|excluding\s+percentage(?:s)?|without\s+percentage(?:s)?/iu;
const EXCLUDE_PERCENT_CLASSES: readonly SemanticMetricClass[] = ["percentage", "ratio", "share", "rate"];

// Stage 24.9 §8/§11 — "сравни (динамику )?A и B [за всё доступное время]." —
// TWO OR MORE explicitly named metrics, whole point-in-time series, never a
// change-horizon / single-interval comparison.
const COMPARE_DYNAMICS_RE =
  /сравн\p{L}*\s+динамик\p{L}*\s+(.+?)(?:\s+за\s+(?:вс[её]|весь)\s+(?:доступн\p{L}*\s+)?(?:период|время)|[.?!]|$)|compare\s+(?:the\s+)?dynamics\s+of\s+(.+?)(?:\s+over\s+(?:all\s+)?(?:available\s+)?time|[.?!]|$)/iu;

// Stage 24.9 §13/§44/§51 — "[сравни] темп роста A и B" — a growth-rate
// comparison over an EXPLICIT metric set, default interval = first→last
// canonical point (resolved in the compiler; no PeriodRef required here).
const GROWTH_RATE_RE = /(?:сравни\s+)?темп\p{L}*\s+рост\p{L}*\s+(.+?)(?:[.?!]|$)|growth\s+rate\s+of\s+(.+?)(?:[.?!]|$)/iu;

// Stage 24.9 §35/§36/§50 — "какой из них вырос/снизился сильнее…" with NO
// explicit metric names: a growth comparison reusing the prior MetricSetRef.
const GROWTH_COMPARE_PRONOUN_RE =
  /как(?:ой|ая|ое)\s+из\s+них\s+(?:вырос|выросл|снизил|увеличил|уменьш|упал)\p{L}*|which\s+of\s+(?:them|these)\s+(?:grew|declined|fell|increased)/iu;

function changeVerbSign(word: string): "positive" | "negative" {
  return /вырос|увеличил/iu.test(word) ? "positive" : "negative";
}

function stripLead(text: string): string {
  return text
    .trim()
    .replace(/^(?:пожалуйста|плиз|окей|ок)[,\s]+/iu, "")
    .replace(new RegExp(`^${RANK_HEAD.source}[,\\s]+`, "iu"), "")
    .trim();
}

/** Pulls a candidate metric noun out of an utterance around the analytical verb. */
function extractSubjectText(text: string): string | undefined {
  // "N <axis-noun> ..." → the axis noun
  const rn = RANK_N.exec(text);
  if (rn) return rn[2]!.trim();
  // "динамик<u> <metric> по времени" / "динамику активов"
  let m = /динамик\p{L}*\s+(.+?)(?:\s+(?:по|во)\s+времени|\s+над\s+временем|[.?!]|$)/iu.exec(text);
  if (m && m[1]) return cleanNoun(m[1]);
  // "как изменил<и>сь <metric> между" / "как изменилась <metric>"
  m = /как\s+измен\p{L}*\s+(.+?)(?:\s+(?:между|с|за|на)(?![\p{L}])|[.?!]|$)/iu.exec(text);
  if (m && m[1]) return cleanNoun(m[1]);
  // "когда <metric> был<и> максимальн" / "в каком периоде <metric> максим"
  m = /когда\s+(.+?)\s+(?:был\p{L}*|достиг\p{L}*|оказал\p{L}*)?\s*(?:максим|миним|наибольш|наименьш|пик|highest|lowest)/iu.exec(text);
  if (m && m[1]) return cleanNoun(m[1]);
  m = /в\s+как(?:ом|ой)\s+(?:период\p{L}*|дат\p{L}*|год\p{L}*|месяц\p{L}*)\s+(.+?)\s+(?:был\p{L}*|достиг\p{L}*|максим|миним|наибольш|наименьш)/iu.exec(text);
  if (m && m[1]) return cleanNoun(m[1]);
  // "когда был максимум <metric>" / "период максимальн<ых> <metric>"
  m = /(?:максимум|минимум|пик)\s+(.+?)(?:[.?!]|$)/iu.exec(text);
  if (m && m[1]) return cleanNoun(m[1]);
  m = /(?:максимальн\p{L}*|минимальн\p{L}*|наибольш\p{L}*|наименьш\p{L}*)\s+(?:значени\p{L}*\s+)?(.+?)(?:[.?!]|$)/iu.exec(text);
  if (m && m[1]) return cleanNoun(m[1]);
  // "when <metric> was highest"
  m = /\bwhen\s+(?:was\s+|were\s+)?(.+?)\s+(?:was|were)\s+(?:the\s+)?(?:highest|lowest|max|min|at\s+its)/iu.exec(text);
  if (m && m[1]) return cleanNoun(m[1]);
  m = /\b(?:dynamics?|time\s+series|trend)\s+of\s+(.+?)(?:\s+over\s+time|[.?!]|$)/iu.exec(text);
  if (m && m[1]) return cleanNoun(m[1]);
  m = /\bhow\s+did\s+(.+?)\s+change\b/iu.exec(text);
  if (m && m[1]) return cleanNoun(m[1]);
  return undefined;
}

function cleanNoun(s: string): string {
  return s
    .trim()
    .replace(/^(?:значени\p{L}*\s+|the\s+|a\s+)/iu, "")
    .replace(/[«»"'`.,;:?!]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:по\s+времени|над\s+временем|over\s+time)$/iu, "")
    .trim();
}

function num(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const v = Number(s.replace(",", "."));
  return Number.isFinite(v) ? v : undefined;
}

/** Detects the typed AnalyticalIntent. `any` is false when nothing analytical matched. */
export function detectAnalyticalIntent(rawText: string): AnalyticalIntent {
  const text = stripLead(rawText);
  const cues: string[] = [];
  const push = (c: string): void => {
    cues.push(c);
  };

  const wantsMax = MAX_TICK.test(text);
  const wantsMin = MIN_TICK.test(text);
  const when = WHEN_TICK.test(text);
  const eachMetric = EACH_METRIC.test(text);
  const growth = GROWTH_TICK.test(text);
  const decline = DECLINE_TICK.test(text);
  const changed = CHANGED_TICK.test(text) || MOST_CHANGED.test(text);
  const rnMatch = RANK_N.exec(text);
  let limit = rnMatch ? Number(rnMatch[1]) : undefined;
  // Stage 24.8 §6/§19 — no explicit direction word ("рост"/"снижение") means
  // the ranking is by MAGNITUDE, never silently "grew".
  const rankMagnitude = !growth && !decline;

  let operation: AnalyticalOperation = "unknown";
  let monotone: AnalyticalIntent["monotone"];
  let direction: AnalyticalIntent["direction"];
  let changeSign: AnalyticalIntent["changeSign"];
  let thresholdMode: ThresholdMode | undefined;
  let thresholdText: string | undefined;
  let interval1StartText: string | undefined;
  let interval1EndText: string | undefined;
  let interval1Predicate: "positive" | "negative" | undefined;
  let interval2StartText: string | undefined;
  let interval2EndText: string | undefined;
  let interval2Predicate: "positive" | "negative" | undefined;
  let ordinalIntervalRef: true | undefined;
  let sameRankingRef: true | undefined;
  let directionChangeSuperlative: true | undefined;
  let metricSetText: string | undefined;
  let sameMetricSetRef: true | undefined;

  const thr = THRESHOLD_RE.exec(text);
  void num;

  const twoIntervalM = TWO_INTERVAL_RE.exec(text);
  const ordinalTwoM = ORDINAL_TWO_INTERVAL_RE.exec(text);
  const compareDynamicsM = COMPARE_DYNAMICS_RE.exec(text);
  const growthRateM = GROWTH_RATE_RE.exec(text);
  const excludePercentM = EXCLUDE_PERCENT_RE.exec(text);

  if (twoIntervalM) {
    // Stage 24.8 §37 — two explicit, independently predicated intervals.
    operation = "two_interval_filter";
    interval1Predicate = changeVerbSign(twoIntervalM[1]!);
    interval1StartText = twoIntervalM[2]!.trim();
    interval1EndText = twoIntervalM[3]!.trim();
    interval2Predicate = changeVerbSign(twoIntervalM[4]!);
    interval2StartText = twoIntervalM[5]!.trim();
    interval2EndText = twoIntervalM[6]!.trim();
    push("two_interval_filter:explicit");
  } else if (ordinalTwoM) {
    // Stage 24.8 §38 — reuse the intervals from the prior CompositeAnalysisRef;
    // only the predicates are new.
    operation = "two_interval_filter";
    interval1Predicate = changeVerbSign(ordinalTwoM[1]!);
    interval2Predicate = changeVerbSign(ordinalTwoM[2]!);
    ordinalIntervalRef = true;
    push("two_interval_filter:ordinal");
  } else if (compareDynamicsM) {
    // Stage 24.9 §8/§11/§49 — TWO+ explicitly named metrics, whole available
    // series, period-aligned.
    operation = "compare_time_series";
    metricSetText = cleanNoun(compareDynamicsM[1] ?? compareDynamicsM[2] ?? "");
    push("compare_time_series");
  } else if (growthRateM) {
    // Stage 24.9 §13/§44/§51 — "темп роста A и B" — explicit metric set,
    // default first→last interval (resolved downstream, no PeriodRef needed).
    operation = "compare_growth";
    metricSetText = cleanNoun(growthRateM[1] ?? growthRateM[2] ?? "");
    direction = "desc";
    push("compare_growth:explicit");
  } else if (GROWTH_COMPARE_PRONOUN_RE.test(text)) {
    // Stage 24.9 §35/§36/§50 — no explicit metric names: reuse the prior
    // MetricSetRef as the candidate set, recompute growth fresh.
    operation = "compare_growth";
    sameMetricSetRef = true;
    direction = decline && !growth ? "asc" : "desc";
    push("compare_growth:same_metric_set_ref");
  } else if (DIRECTION_CHANGE_TICK.test(text) && DIRECTION_CHANGE_SUPERLATIVE_RE.test(text)) {
    // Stage 24.9 §17/§41 — "менял направление ЧАЩЕ ВСЕГО": superlative single
    // winner, never the plain reversal list.
    operation = "direction_change";
    directionChangeSuperlative = true;
    direction = "desc";
    push("direction_change:superlative");
  } else if (ADJACENT_TICK.test(text) && (LARGEST_CHANGE_TICK.test(text) || changed)) {
    // Stage 24.8 §15/§39 — the global adjacent-period-change EVENT, never a
    // change-horizon / "last month" shortcut.
    operation = "argmax_event";
    push("argmax_event");
  } else if (SAME_RANKING_RE.test(text)) {
    // Stage 24.8 §11/§30/§31 — "те же 5, но по абсолютному изменению": reuse
    // the prior RankingAnalysisRef's scope/interval/limit; only the basis
    // cue (parsed below) changes.
    operation = "rank";
    sameRankingRef = true;
    direction = "desc";
    const n = /\d{1,3}/.exec(SAME_RANKING_RE.exec(text)![0]);
    if (n) limit = Number(n[0]);
    push("rank:same_ranking_ref");
  } else if (DIRECTION_CHANGE_TICK.test(text)) {
    operation = "direction_change";
    push("direction_change");
  } else if (NON_DECREASING_TICK.test(text)) {
    operation = "monotonicity";
    monotone = "non_decreasing";
    push("monotonicity:non_decreasing");
  } else if (NON_INCREASING_TICK.test(text)) {
    // Stage 24.9 §20/§21/§45 — exact symmetric counterpart: "ни разу не рос".
    operation = "monotonicity";
    monotone = "non_increasing";
    push("monotonicity:non_increasing");
  } else if (MONO_UP_TICK.test(text)) {
    operation = "monotonicity";
    monotone = "strict_increasing";
    push("monotonicity:strict_increasing");
  } else if (MONO_DOWN_TICK.test(text)) {
    operation = "monotonicity";
    monotone = "strict_decreasing";
    push("monotonicity:strict_decreasing");
  } else if (VOLATILITY_TICK.test(text)) {
    operation = "volatility";
    direction = "desc";
    push("volatility");
  } else if (STABILITY_TICK.test(text)) {
    operation = "stability";
    direction = "asc";
    push("stability");
  } else if (TREND_TICK.test(text) && !DYNAMICS_TICK.test(text)) {
    operation = "trend";
    direction = /нисходящ|сниж|declin|decreas|down/iu.test(text) ? "asc" : "desc";
    push("trend");
  } else if (COMPARE_TICK.test(text)) {
    operation = "compare";
    push("compare");
  } else if (when && (wantsMax || wantsMin)) {
    operation = wantsMax && !wantsMin ? "argmax" : wantsMin && !wantsMax ? "argmin" : "argmax";
    push(operation);
  } else if ((wantsMax || wantsMin) && !eachMetric && !changed && OUTPUT_VALUE_HINT.test(text) && extractSubjectText(text)) {
    // "Какой был максимум активов?" — argmax of a named metric, value projection.
    operation = wantsMax && !wantsMin ? "argmax" : "argmin";
    push(`${operation}:value`);
  } else if (DYNAMICS_TICK.test(text)) {
    operation = "time_series";
    push("time_series");
  } else if ((thr && (changed || growth || decline)) || (thr && CHANGED_TICK.test(rawText))) {
    operation = "filter";
    thresholdMode = growth && !decline ? "positive" : decline && !growth ? "negative" : "magnitude";
    thresholdText = thr[0];
    push(`filter:threshold:${thresholdMode}`);
  } else if (
    (limit !== undefined || STRONGEST_TICK.test(text)) &&
    (growth || decline || wantsMax || wantsMin || MOST_CHANGED.test(text))
  ) {
    operation = "rank";
    direction = decline || wantsMin ? "asc" : "desc";
    changeSign = growth ? "positive" : decline ? "negative" : "any";
    // Stage 24.8 §32/§33 — "вырос/снизился сильнее всего" (singular winner,
    // no explicit count) implicitly means limit = 1.
    if (limit === undefined) limit = 1;
    push(`rank:${direction}`);
  } else if ((growth || decline) && (eachMetric || /какие\s+показател|which\s+(?:metrics|indicators|rows)|какие\s+строк/iu.test(text))) {
    operation = "filter";
    changeSign = growth && !decline ? "positive" : "negative";
    thresholdMode = changeSign === "positive" ? "positive" : "negative";
    push(`filter:${changeSign}`);
  } else if (MOST_CHANGED.test(text)) {
    operation = "rank";
    direction = "desc";
    changeSign = "any";
    thresholdMode = "magnitude";
    push("rank:most_changed");
  } else if ((wantsMax || wantsMin) && eachMetric && !when) {
    // "найди максимальные и минимальные значения для каждого показателя" —
    // handled by the schema-result path; the analytical route declines it.
    operation = "unknown";
  }

  // interval / period phrases — skipped for operations that resolve their OWN
  // interval field(s) (two_interval_filter: interval1/2*Text; argmax_event:
  // every point period), so a two-interval sentence never leaves a garbage
  // single-interval span on the intent.
  // Stage 24.9 §11/§13/§44 — compare_time_series always uses every available
  // point; compare_growth resolves its OWN default first→last interval in the
  // compiler (never a PeriodRef / generic-interval parse here).
  const skipGenericInterval =
    operation === "two_interval_filter" || operation === "argmax_event" || operation === "compare_time_series" || operation === "compare_growth";
  // "между" is tried FIRST and independently of the bare "с" alternative:
  // a standalone "с" can legitimately appear earlier in the SAME sentence for
  // an unrelated reason ("5 показателей С наибольшим изменением ... МЕЖДУ
  // X и Y") — scanning left-to-right over one combined alternation would let
  // that earlier "с" win, even though "между" is the real interval marker.
  // The "с" alternative MUST also be a standalone token — `\p{L}` lookaround
  // (not `\b`, which is ASCII-only) — or it wrongly matches the trailing "с"
  // of an unrelated word ("вырос", "принес", …) followed by whitespace.
  // "с" is ALSO an ordinary preposition ("с наибольшим ростom" = "with the
  // greatest growth", "по абсолютному изменению" = "by absolute change") —
  // unlike "между", a bare "с … по …" match is only trusted as a date
  // interval when BOTH captured spans contain a digit (every real date /
  // year in this compiler does); otherwise it is almost always an unrelated
  // "with X, by Y" construction, not a period.
  const hasDigit = (s: string | undefined): boolean => Boolean(s && /\d/.test(s));
  const betweenM = skipGenericInterval ? null : /между\s+(.+?)\s+(?:и|по|and|to|through)\s+(.+?)[.?!]*$/iu.exec(text);
  const fromRuM = skipGenericInterval || betweenM ? null : /(?<![\p{L}])с(?![\p{L}])\s+(.+?)\s+(?:и|по|and|to|through)\s+(.+?)[.?!]*$/iu.exec(text);
  const fromRuValidM = fromRuM && hasDigit(fromRuM[1]) && hasDigit(fromRuM[2]) ? fromRuM : null;
  const intervalM =
    betweenM ??
    fromRuValidM ??
    (skipGenericInterval ? null : /(?<![\p{L}])from(?![\p{L}])\s+(.+?)\s+(?:и|по|and|to|through)\s+(.+?)[.?!]*$/iu.exec(text)) ??
    (skipGenericInterval ? null : /(?:на|as\s+of|at)\s+(.+?)\s+(?:и|and)\s+(.+?)[.?!]*$/iu.exec(text));
  const sameSpanM = skipGenericInterval ? null : SAME_PERIOD_SPAN_RE.exec(text);
  const sameSpan = Boolean(sameSpanM);

  let periodText: string | undefined;
  let periodStartText: string | undefined;
  let periodEndText: string | undefined;
  if (skipGenericInterval) {
    // handled entirely via interval1*/interval2* (two_interval_filter) or
    // every point period (argmax_event) — no single period/interval applies.
  } else if (intervalM) {
    periodStartText = intervalM[1]?.trim();
    periodEndText = intervalM[2]?.trim();
  } else if (sameSpanM) {
    periodText = sameSpanM[0];
  } else {
    const rel =
      /за\s+(?:послед\p{L}*\s+)?(?:\d+\s+)?(?:месяц\p{L}*|год\p{L}*|квартал\p{L}*)|с\s+начала\s+(?:20\d\d\s+)?года|с\s+нач\p{L}*\s+года|year[-\s]?to[-\s]?date|\bytd\b|last\s+(?:month|year|quarter|\d+\s+months)|за\s+предыдущ\p{L}*\s+год/iu.exec(text);
    if (rel) periodText = rel[0];
    else {
      const d = /(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|(?:20|19)\d{2}(?=\s|$))/.exec(text);
      if (d) periodText = d[0];
    }
  }

  // filter that references a change horizon but no explicit interval → treat the
  // horizon as the period.
  if (operation === "rank" && !periodText && !periodStartText) {
    const rel = /за\s+(?:послед\p{L}*\s+)?месяц|за\s+1\s+месяц|last\s+month|с\s+начала\s+года|\bytd\b/iu.exec(text);
    if (rel) periodText = rel[0];
  }

  // Stage 24.7.1 §9–§13 — STRUCTURED SPAN EXTRACTION: remove the interval /
  // same-period / threshold spans BEFORE resolving the subject, so a date
  // ("между 01.01.2024 и 01.12.2025") or a threshold phrase never leaks into
  // (or truncates) the subject text.
  let remainingForSubject = text;
  if (intervalM) remainingForSubject = remainingForSubject.replace(intervalM[0], " ");
  else if (sameSpanM) remainingForSubject = remainingForSubject.replace(sameSpanM[0], " ");
  if (thr) remainingForSubject = remainingForSubject.replace(thr[0], " ");
  if (excludePercentM) remainingForSubject = remainingForSubject.replace(excludePercentM[0], " ");
  const subjectText =
    operation === "compare_time_series" || operation === "compare_growth"
      ? undefined
      : (extractSubjectText(remainingForSubject.replace(/\s+/g, " ").trim()) ?? extractSubjectText(text));

  const measureBasisOverride: AnalyticalIntent["measureBasisOverride"] = BASIS_ABSOLUTE_RE.test(text)
    ? "absolute_change"
    : BASIS_PERCENT_RE.test(text)
      ? "percentage_change"
      : undefined;

  // Stage 24.9 §22–§25 — a semantic-class exclusion modifier, independent of
  // the chosen operation.
  const excludeMetricClasses: AnalyticalIntent["excludeMetricClasses"] = excludePercentM ? EXCLUDE_PERCENT_CLASSES : undefined;

  // "как изменились активы между ..." with a single subject → change, not filter.
  if (
    (operation === "unknown" || operation === "filter") &&
    CHANGED_TICK.test(text) &&
    subjectText &&
    (intervalM || sameSpan) &&
    !/какие\s+показател|which\s+(?:metrics|indicators)|метрик\p{L}*/iu.test(text)
  ) {
    operation = "change";
    push("change");
  }

  // output projection
  let output: OutputProjection;
  if (operation === "argmax" || operation === "argmin") {
    output = OUTPUT_BOTH_HINT.test(text)
      ? "period_and_value"
      : OUTPUT_VALUE_HINT.test(text) && !when
        ? "value"
        : "period";
  } else if (operation === "time_series") {
    output = "series";
  } else if (operation === "compare" || operation === "change") {
    output = "table";
  } else if (
    operation === "rank" ||
    operation === "volatility" ||
    operation === "stability" ||
    operation === "trend" ||
    operation === "filter" ||
    operation === "monotonicity" ||
    operation === "direction_change" ||
    operation === "two_interval_filter"
  ) {
    output = "ranking";
  } else if (operation === "argmax_event" || operation === "compare_time_series" || operation === "compare_growth") {
    output = "table";
  } else {
    output = "table";
  }

  const any = operation !== "unknown";
  return {
    operation,
    ...(subjectText ? { subjectText } : {}),
    ...(periodText ? { periodText } : {}),
    ...(periodStartText ? { periodStartText } : {}),
    ...(periodEndText ? { periodEndText } : {}),
    ...(thresholdText ? { thresholdText } : {}),
    ...(thresholdMode ? { thresholdMode } : {}),
    ...(direction ? { direction } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(changeSign ? { changeSign } : {}),
    ...(monotone ? { monotone } : {}),
    ...(measureBasisOverride ? { measureBasisOverride } : {}),
    ...(operation === "rank" || operation === "argmax_event" ? { rankMagnitude } : {}),
    ...(sameRankingRef ? { sameRankingRef } : {}),
    ...(interval1StartText ? { interval1StartText } : {}),
    ...(interval1EndText ? { interval1EndText } : {}),
    ...(interval1Predicate ? { interval1Predicate } : {}),
    ...(interval2StartText ? { interval2StartText } : {}),
    ...(interval2EndText ? { interval2EndText } : {}),
    ...(interval2Predicate ? { interval2Predicate } : {}),
    ...(ordinalIntervalRef ? { ordinalIntervalRef } : {}),
    ...(directionChangeSuperlative ? { directionChangeSuperlative } : {}),
    ...(excludeMetricClasses ? { excludeMetricClasses } : {}),
    ...(metricSetText ? { metricSetText } : {}),
    ...(sameMetricSetRef ? { sameMetricSetRef } : {}),
    outputProjection: output,
    any,
    cues,
  };
}

// ---------------------------------------------------------------------------
// Stage 25.1/25.1.1 §10/§11 — a LIGHTWEIGHT request semantic frame.
//
// This is NOT another intent catalogue and performs NO numeric calculation.
// It captures the few invariants the router/audit layer needs: how many
// analytical clauses a sentence carries (§15–§17, no 2-clause ceiling), an
// EXPLICIT candidate metric set (§17), a temporal-comparison mode (§6/§7),
// a canonical operation kind Stage 24.x structurally cannot represent
// (§4/§5), and whether the request is exploratory (§30).
//
// §53/§109 — these are STRUCTURAL detectors (an imperative/interrogative
// trigger word; an explicit "A, B and C" phrase), never per-sentence
// handlers: the same regex fires for any phrasing built the same way. §54–57
// list MULTIPLE paraphrasings per operation kind and every one is covered by
// the same pattern, not one branch per wording.
// ---------------------------------------------------------------------------

import { resolveMetricSet } from "../app/schema/analytical/metric-resolver.js";
import type { MetricIndex } from "../app/schema/analytical/metric-resolver.js";

// --- clause counting (§15–§17) ------------------------------------------

/**
 * A word that opens a new analytical clause, wherever it appears in the
 * sentence — not just after "и"/",". Counting occurrences (capped) replaces
 * the Stage 25.1 two-clause-only boolean with a generic 1–4 clause signal.
 */
const CLAUSE_TRIGGER_RE =
  /(?<![\p{L}])(?:когда|где|куда|как(?:[оа][йея]|ие)?|скажи|покажи|укажи|назови|объясни|поясни|расскажи|найди|сравни|определи|выведи|when|where|which|what|how|explain|show|tell|find|compare|identify|determine)(?![\p{L}])/giu;

const MAX_CLAUSES = 4;

/** §17 — no arbitrary two-clause ceiling: 1–4 analytical clause signals. */
export function countAnalyticalClauses(text: string): number {
  const matches = text.match(CLAUSE_TRIGGER_RE) ?? [];
  return Math.max(1, Math.min(MAX_CLAUSES, matches.length || 1));
}

/** Back-compat name (Stage 25.1): "this sentence needs more than one clause". */
export function hasSecondAnalyticalClause(text: string): boolean {
  return countAnalyticalClauses(text) >= 2;
}

// A single occurrence of the FIRST clause-boundary connector, used only to
// scope `explicitCandidateSet` to the metric-listing portion of the text.
const FIRST_CLAUSE_BOUNDARY_RE =
  /\sи\s+(?:когда|где|куда|как(?:[оа][йея]|ие)?|скажи|покажи|укажи|назови|объясни|поясни|расскажи|and\s+(?:when|where|which|what|how|explain|show|tell))(?![\p{L}])|,\s*(?:скажи|покажи|укажи|назови|объясни|поясни|расскажи)(?![\p{L}])/iu;

/**
 * §17/§69/§89 — the explicit candidate set the user actually named, when the
 * text resolves as a genuine multi-metric phrase (reuses `resolveMetricSet`
 * verbatim — no separate matching logic). `null` means "no explicit set was
 * named" (the audit that consumes this is then a no-op, per §17's own
 * "unless user explicitly asks to expand it").
 */
export function explicitCandidateSet(text: string, index: MetricIndex): readonly string[] | null {
  // isolate the metric-listing portion before a later clause ("...и скажи,
  // кто вырос быстрее") — `resolveMetricSet` matches an "A и B [и C]" phrase,
  // not a full multi-clause sentence.
  const match = FIRST_CLAUSE_BOUNDARY_RE.exec(text);
  const scoped = match ? text.slice(0, match.index) : text;
  const r = resolveMetricSet(scoped, index);
  return r.kind === "resolved" && r.entries.length >= 2 ? r.entries.map((e) => e.label) : null;
}

// --- temporal mode (§6/§7/§57) ------------------------------------------

export type TemporalMode = "previous_to_last" | "first_to_last";

const PREVIOUS_TO_LAST_RE =
  /последн\p{L}*\s+(?:доступн\p{L}*\s+)?дат\p{L}*\s+с\s+предыдущ\p{L}*|последн\p{L}*\s+два\s+наблюден\p{L}*|две\s+последн\p{L}*\s+дат\p{L}*|последн\p{L}*\s+наблюден\p{L}*\s+с\s+предыдущ\p{L}*|изменилось\s+сильнее\s+всего\s+между\s+двумя\s+последн\p{L}*|last\s+two\s+observations|compare\s+the\s+last\s+two/iu;
const FIRST_TO_LAST_RE = /перв\p{L}*\s+и\s+последн\p{L}*|between\s+the\s+first\s+and\s+(?:the\s+)?last/iu;

/** §6/§7/§57 — a temporal-comparison mode the sentence explicitly asked for,
 *  used to AUDIT the executed interval, never to compute it directly. */
export function detectTemporalMode(text: string): TemporalMode | null {
  if (PREVIOUS_TO_LAST_RE.test(text)) return "previous_to_last";
  if (FIRST_TO_LAST_RE.test(text)) return "first_to_last";
  return null;
}

// --- ranking basis for "changed the most" asks (Stage 25.1.3b §2–§6) -----

export type RankingBasisField = "percentageChange" | "absoluteChange";

// §4 — "какой изменился сильнее всего?" / "у какого изменение было самым
// сильным?" / "у какого самое большое [абсолютное] изменение?" / "which
// changed the most?" / "which had the strongest change?"
const CHANGE_STRENGTH_RE =
  /измен\p{L}*\s+сильнее\s+всего|сильнее\s+всего\s+измен\p{L}*|изменени\p{L}*\s+(?:был[оa]\s+)?сам\p{L}*\s+сильн\p{L}*|сам\p{L}*\s+(?:сильн|больш)\p{L}*\s+(?:абсолютн\p{L}*\s+)?измен\p{L}*|changed?\s+(?:the\s+)?most|(?:strongest|largest|biggest)\s+(?:absolute\s+)?change/iu;

// §5 — an explicit override to rank by the raw amount, not a relative
// percentage: "в абсолютном выражении" / "по абсолютному изменению" / "в
// единицах" / "самое большое абсолютное изменение" / "absolute amount/change".
const EXPLICIT_ABSOLUTE_BASIS_RE =
  /в\s+абсолютн\p{L}*\s+выражени\p{L}*|по\s+абсолютн\p{L}*\s+измен\p{L}*|абсолютн\p{L}*\s+измен\p{L}*|в\s+единиц\p{L}*|absolute\s+(?:amount|change|terms|value)/iu;

/**
 * §2–§6 — the ranking basis a "changed the most" style comparison across
 * heterogeneous metrics should use: `null` when the sentence isn't this
 * kind of comparison at all (no requirement — the audit is a no-op);
 * "percentageChange" by DEFAULT for a bare "changed most" ask (relative
 * strength is comparable across metrics with different scales/units);
 * "absoluteChange" only when the sentence explicitly asks for the raw
 * amount.
 */
export function detectRequestedRankingBasis(text: string): RankingBasisField | null {
  if (!CHANGE_STRENGTH_RE.test(text)) return null;
  return EXPLICIT_ABSOLUTE_BASIS_RE.test(text) ? "absoluteChange" : "percentageChange";
}

// --- canonical operation kind (§3–§5/§54–§57) ---------------------------

export type CanonicalOperationKind =
  | "historical_extreme_distance"
  | "temporal_pattern_down_then_up"
  | "temporal_pattern_up_then_down"
  | "stable_growth"
  | "latest_vs_mean"
  | "trend_vs_latest_direction";

// §54 — "откатились от пиков" / "дальше всего от максимума" / "ниже
// исторического максимума" / "furthest below its historical peak".
const HISTORICAL_EXTREME_DISTANCE_RE =
  /откат\p{L}*\s+от\s+(?:своих?\s+)?(?:истор\p{L}*\s+)?(?:максимум\p{L}*|пик\p{L}*)|дальше\s+всего\s+от\s+(?:своего\s+)?(?:истор\p{L}*\s+)?(?:максимум\p{L}*|пик\p{L}*)|ниже\s+(?:своего\s+)?истор\p{L}*\s+максимум\p{L}*|отклон\p{L}*\s+от\s+(?:своего\s+)?(?:истор\p{L}*\s+)?максимум\p{L}*|ближе\s+всего\s+к\s+(?:своему\s+)?(?:истор\p{L}*\s+)?(?:максимум\p{L}*|пик\p{L}*)|furthest\s+below\s+its\s+historical\s+(?:peak|maximum|high)|closest\s+to\s+its\s+historical\s+(?:peak|maximum)/iu;

// §55 — "после снижения снова начали расти" / "сначала снизились, потом
// восстановились" / "что начало восстанавливаться после снижения" /
// "recovered after a decline".
const DOWN_THEN_UP_RE =
  /после\s+(?:снижен\p{L}*|падени\p{L}*).{0,30}(?:снова\s+)?(?:начал\p{L}*\s+)?(?:раст\p{L}*|вырос\p{L}*|восстан\p{L}*)|снача?ла?\s+снизил\p{L}*.{0,30}пот[оо]м\s+(?:вырос\p{L}*|восстан\p{L}*)|восстан\p{L}*.{0,20}после\s+(?:снижен\p{L}*|падени\p{L}*)|recovered\s+after\s+a?\s*decline|which\s+metrics\s+recovered/iu;
const UP_THEN_DOWN_RE = /после\s+рост\p{L}*.{0,30}(?:снова\s+)?(?:начал\p{L}*\s+)?(?:снижа\p{L}*|упал\p{L}*|падени\p{L}*)|снача?ла?\s+вырос\p{L}*.{0,30}пот[оо]м\s+(?:снизил\p{L}*|упал\p{L}*)/iu;

// §56 — "росло наиболее стабильно" / "рост без сильных скачков" / "grew most steadily".
const STABLE_GROWTH_RE =
  /росл\p{L}*\s+(?:наиболее\s+)?стабильно|стабильн\p{L}*\s+рост\p{L}*|рост\p{L}*\s+без\s+(?:сильных\s+|резких\s+)?скачк\p{L}*|grew\s+most\s+steadily|steady\s+growth/iu;

// §27 — "отклоняется от своего среднего значения" / "deviates from its average".
const LATEST_VS_MEAN_RE = /отклоня\p{L}*\s+от\s+(?:своего\s+)?средн\p{L}*|отклонени\p{L}*\s+от\s+средн\p{L}*|deviates?\s+from\s+(?:its\s+)?average/iu;

// §29 — preserve as-is (already works); detected only so routing never
// mis-classifies it as one of the other new kinds.
const TREND_VS_LATEST_RE = /противоположн\p{L}*\s+(?:общей\s+)?тенденц\p{L}*|opposite\s+.{0,15}(?:general\s+)?trend/iu;

/** §3–§5/§38 — the operation kind the SENTENCE asks for. Stage 24.x has NO
 *  compiled operation for any of these (proven empirically in Stage 25.1) —
 *  when detected, routing always prefers the planner (§35/§36). */
export function detectOperationKind(text: string): CanonicalOperationKind | null {
  if (HISTORICAL_EXTREME_DISTANCE_RE.test(text)) return "historical_extreme_distance";
  if (DOWN_THEN_UP_RE.test(text)) return "temporal_pattern_down_then_up";
  if (UP_THEN_DOWN_RE.test(text)) return "temporal_pattern_up_then_down";
  if (STABLE_GROWTH_RE.test(text)) return "stable_growth";
  if (LATEST_VS_MEAN_RE.test(text)) return "latest_vs_mean";
  if (TREND_VS_LATEST_RE.test(text)) return "trend_vs_latest_direction";
  return null;
}

// --- superlative "which ONE" asks (Stage 25.1.3 §3/§5) -------------------

// A single-winner ask: "сильнее всего", "самый нестабильный", "наиболее",
// "the most", "strongest" — used ONLY to decide whether a sorted/ranked
// MULTI-ROW result's row[0] is a semantic winner (never to compute anything).
const SUPERLATIVE_RE =
  /сильнее\s+всего|больше\s+всего|са́?мы[йея]\s+\p{L}+|наиболее\s+\p{L}+|наибольш\p{L}*|наименьш\p{L}*|the\s+most\b|\bstrongest\b|\bhighest\b|\blowest\b|\bmost\s+\p{L}+/iu;

export function hasSuperlativeAsk(text: string): boolean {
  return SUPERLATIVE_RE.test(text);
}

// --- analytical follow-up continuity (Stage 25.1.3f §2) -----------------

// §2 — a request that CONTINUES a previous structured analytical result
// instead of naming its own universe: an anaphoric opener ("теперь…",
// "а теперь…", "then…"), a partitive reference to an established set
// ("из них", "среди них", "of those", "among them"), or a restriction
// phrased against an implied universe ("покажи только …", "оставь только …",
// "only those that …", "show only …").
//
// STRUCTURAL, not a phrase catalogue: each alternative matches a grammatical
// shape (opener / partitive / restrictor), so any sentence built the same way
// fires the same branch — no per-sentence handler (§53/§109).
const FOLLOW_UP_OPENER_RE = /^\s*(?:а\s+)?(?:теперь|тогда|дальше|затем|now|then|next)(?![\p{L}])/iu;
const FOLLOW_UP_PARTITIVE_RE =
  /(?<![\p{L}])(?:из\s+(?:них|этих|этого|тех|списка|набора)|среди\s+них|у\s+них|among\s+(?:them|those|these)|of\s+(?:them|those|these)|from\s+(?:them|those|these))(?![\p{L}])/iu;
const FOLLOW_UP_RESTRICTOR_RE =
  /(?<![\p{L}])(?:только|лишь|оставь|отфильтруй|исключи|only|just\s+the|filter|keep|exclude)(?![\p{L}])/iu;

/**
 * §2 — "is this turn a compatible analytical follow-up on whatever
 * structured result the conversation already holds?"
 *
 * Used ONLY as a ROUTING guard: such a turn must stay inside the
 * schema-aware analytical route and must never be re-interpreted as a
 * standalone general-chat question against an empty context. It never
 * selects a tool, a metric, or a number.
 */
export function isAnalyticalFollowUp(text: string): boolean {
  return FOLLOW_UP_OPENER_RE.test(text) || FOLLOW_UP_PARTITIVE_RE.test(text) || FOLLOW_UP_RESTRICTOR_RE.test(text);
}

// --- exploratory requests (§30/§70) -------------------------------------

const EXPLORATORY_RE =
  /необычн\p{L}*|подозрительн\p{L}*|стоит\s+провер\p{L}*|worth\s+check\p{L}*|\bunusual\b|что\s+(?:здесь\s+)?интересн\p{L}*|если\s+бы\s+тебе\s+нужно\s+было\s+выбрать|which\s+.{0,15}worth\s+investigat/iu;

/** §30/§40/§70 — an open-ended diagnostic ask with no fixed metric/operation
 *  target; `metric.resolve("")` must never be attempted for these. */
export function isExploratoryRequest(text: string): boolean {
  return EXPLORATORY_RE.test(text);
}

// Stage 25.1.3 §23/§24 — the exploratory request's OWN cardinality
// constraint ("три показателя" / "3 metrics"), read structurally (a digit or
// a small number word next to "показател"/"metric"), never computed.
const CARDINALITY_WORD_RE =
  /(?<![\p{L}])(один|одну|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|one|two|three|four|five|six|seven|eight|nine|ten)(?![\p{L}])/iu;
const CARDINALITY_WORDS: Readonly<Record<string, number>> = {
  один: 1, одну: 1, одна: 1, one: 1,
  два: 2, две: 2, two: 2,
  три: 3, three: 3,
  четыре: 4, four: 4,
  пять: 5, five: 5,
  шесть: 6, six: 6,
  семь: 7, seven: 7,
  восемь: 8, eight: 8,
  девять: 9, nine: 9,
  десять: 10, ten: 10,
};

/** §23/§24 — an explicit count of metrics the request asks for, when the
 *  sentence names one near a "показатель"/"metric" noun. `null` when no
 *  explicit cardinality is named (the audit that consumes this is a no-op). */
export function extractRequestedCardinality(text: string): number | null {
  const digitMatch = /(\d+)\s*(?:показател|metric)/iu.exec(text);
  if (digitMatch) {
    const n = Number(digitMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const wordMatch = CARDINALITY_WORD_RE.exec(text);
  if (wordMatch) {
    const n = CARDINALITY_WORDS[wordMatch[1]!.toLowerCase()];
    if (n !== undefined) return n;
  }
  return null;
}

export interface RequestSemanticFrame {
  readonly clauseCount: number;
  readonly explicitMetricSet: readonly string[] | null;
  readonly temporalMode: TemporalMode | null;
  readonly operationKind: CanonicalOperationKind | null;
  readonly exploratory: boolean;
}

export function buildSemanticFrame(text: string, index: MetricIndex): RequestSemanticFrame {
  return {
    clauseCount: countAnalyticalClauses(text),
    explicitMetricSet: explicitCandidateSet(text, index),
    temporalMode: detectTemporalMode(text),
    operationKind: detectOperationKind(text),
    exploratory: isExploratoryRequest(text),
  };
}

/**
 * §12–§14/§35/§36 — Stage 24.9 operations that are ALREADY compound-aware (a
 * single compiled plan legitimately covers what reads like several clauses):
 * the clause-count override must not re-route these to the planner and add
 * needless latency (§85).
 */
export const COMPOUND_AWARE_OPERATIONS: ReadonlySet<string> = new Set([
  "argmax_event",
  "compare_time_series",
  "two_interval_filter",
  "compare_growth",
]);

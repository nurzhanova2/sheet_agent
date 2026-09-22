// ---------------------------------------------------------------------------
// Stage 24.7 — Universal Analytical Intent Compiler: shared typed model.
//
// NATURAL LANGUAGE → AnalyticalIntent → ResolvedIntent → AnalyticalPlan →
// validatePlan → executePlan → sections + evidence. The model may classify
// intent and suggest candidate schema concepts; every exact address, period
// coordinate, extremum, ranking value, trend / volatility number and source
// membership is computed deterministically here.
// ---------------------------------------------------------------------------

import type { MeasureKind, SemanticMetricClass } from "../measure-compatibility.js";
import type { ColumnPath, RowAxisMember } from "../schema-induction.js";

// --- analytical operations -------------------------------------------------

export type AnalyticalOperation =
  | "describe"
  | "extrema" // max AND min per subject
  | "argmax" // period(s) at which the subject was highest
  | "argmin"
  | "rank" // rank subjects by a measure / change horizon
  | "compare" // two explicit points, per subject
  | "change" // change of one subject between two points
  | "filter" // subjects whose change passes a threshold
  | "trend" // strongest up / down linear trend
  | "volatility"
  | "stability"
  | "monotonicity" // consecutively rising / falling
  | "direction_change"
  | "time_series" // ordered point-in-time series of one subject
  /** Stage 24.8 §17–§19 — the global extreme adjacent-period-change EVENT
   *  across every metric × every adjacent point-period pair. NOT a change
   *  horizon / "last month" shortcut. */
  | "argmax_event"
  /** Stage 24.8 §12–§14 — subjects whose change passes a SIGNED predicate over
   *  TWO independently resolved intervals ("выросли в первом, но снизились во
   *  втором"). */
  | "two_interval_filter"
  /** Stage 24.9 §11 — the ordered point-in-time series of TWO OR MORE
   *  explicitly named metrics, rendered as one period-aligned table. */
  | "compare_time_series"
  /** Stage 24.9 §12/§13 — percentage (or absolute) growth of a MetricSet
   *  between two points, defaulting to first→last canonical period with NO
   *  PeriodRef required. */
  | "compare_growth"
  | "unknown";

export type SubjectScope = "each_metric" | "single_metric" | "row_axis" | "column_axis" | "metric_set";

export type OutputProjection = "period" | "value" | "period_and_value" | "series" | "ranking" | "table";

// --- typed intent (pre-resolution) --------------------------------------

/** Direction words normalised: worst/lowest/decline → "asc"; best/highest/growth → "desc". */
export type RankDirection = "asc" | "desc";

/** How a threshold filter reads a change value. */
export type ThresholdMode = "magnitude" | "positive" | "negative";

export interface AnalyticalIntent {
  readonly operation: AnalyticalOperation;
  /** raw noun following the analytical verb ("показателей", "активы", "Revenue", "региона"). */
  readonly subjectText?: string;
  /** raw measure/metric phrase when distinct from the subject ("Variance", "рост"). */
  readonly measureText?: string;
  /** a single point / horizon phrase ("01.01.2025", "за последний месяц", "этот же период"). */
  readonly periodText?: string;
  /** interval endpoints ("между 01.01.2024 и 01.12.2025", "на 01.01.2025 и 01.12.2025"). */
  readonly periodStartText?: string;
  readonly periodEndText?: string;
  /** raw threshold phrase ("более чем на 20%", "20%", "0.2"). */
  readonly thresholdText?: string;
  readonly thresholdMode?: ThresholdMode;
  readonly direction?: RankDirection;
  readonly limit?: number;
  /** "рост" / "снижение" restrict a rank / filter to signed change. */
  readonly changeSign?: "positive" | "negative" | "any";
  /** monotonicity flavour. */
  readonly monotone?: "strict_increasing" | "non_decreasing" | "strict_decreasing" | "non_increasing";
  /** Stage 24.7.1 §26 — an EXPLICIT user override ("по абсолютному изменению" /
   *  "по процентному изменению"); wins over the default measure-basis preference. */
  readonly measureBasisOverride?: "absolute_change" | "percentage_change";
  /** Stage 24.8 §6/§10 — "относительным/абсолютным ИЗМЕНЕНИЕМ" (magnitude,
   *  no direction word) rather than "РОСТОМ"/"СНИЖЕНИЕМ" (signed). Governs
   *  which `RankingField` the compiler picks for a rank/argmax_event plan. */
  readonly rankMagnitude?: boolean;
  /** Stage 24.8 §11/§30/§31 — "те же N [показателей]" — reuse the prior
   *  RankingAnalysisRef's scope/interval/limit, changing only the basis. */
  readonly sameRankingRef?: boolean;
  /** Stage 24.8 §37 — the FIRST of two explicit intervals + its signed
   *  predicate, for `two_interval_filter`. */
  readonly interval1StartText?: string;
  readonly interval1EndText?: string;
  readonly interval1Predicate?: "positive" | "negative";
  /** Stage 24.8 §37 — the SECOND explicit interval + predicate. */
  readonly interval2StartText?: string;
  readonly interval2EndText?: string;
  readonly interval2Predicate?: "positive" | "negative";
  /** Stage 24.8 §13/§14 — "в первом/втором интервале" with no explicit dates —
   *  reuse the prior CompositeAnalysisRef's two intervals; only the predicates
   *  are new. */
  readonly ordinalIntervalRef?: boolean;
  /** Stage 24.9 §41/§49 — "менял направление ЧАЩЕ ВСЕГО" (superlative, single
   *  winner) rather than the plain list of every metric with any reversal. */
  readonly directionChangeSuperlative?: boolean;
  /** Stage 24.9 §22–§25 — "если не учитывать процентные показатели": exclude
   *  these semantic classes from the candidate universe BEFORE analysis. */
  readonly excludeMetricClasses?: readonly SemanticMetricClass[];
  /** Stage 24.9 §8/§9 — the raw "A и B [и C]" phrase for an explicit
   *  multi-metric subject (compare_time_series / compare_growth). */
  readonly metricSetText?: string;
  /** Stage 24.9 §35/§36 — "какой из них вырос сильнее…" with NO explicit
   *  metric names: reuse the prior MetricSetRef as the candidate set. */
  readonly sameMetricSetRef?: boolean;
  readonly outputProjection: OutputProjection;
  /** true when at least one analytical cue fired. */
  readonly any: boolean;
  /** developer-only: which lexical cues matched. */
  readonly cues: readonly string[];
}

// --- resolved subject / period / metric --------------------------------

export type ResolvedSubject =
  | { readonly kind: "each_metric"; readonly members: readonly RowAxisMember[] }
  | { readonly kind: "row_axis_member"; readonly member: RowAxisMember }
  | { readonly kind: "column_measure"; readonly column: ColumnPath }
  | { readonly kind: "each_column"; readonly columns: readonly ColumnPath[] }
  /** Stage 24.9 §8–§10 — an EXPLICIT, bounded set of named metrics (never
   *  "every metric") — "Активы и Обязательства". Row-axis only (§9 scope). */
  | { readonly kind: "metric_set"; readonly members: readonly RowAxisMember[] };

export type CanonicalPeriodKind = "point" | "interval" | "change_horizon" | "year";

/** A resolved period — semantic value + EXACT header path(s) + coordinates. */
export interface CanonicalPeriod {
  readonly kind: CanonicalPeriodKind;
  /** ISO date for a point; "YYYY" for a year; a semantic label for a change horizon. */
  readonly canonical: string;
  /** the header-path text as it appears in the schema. */
  readonly headerPath: string;
  /** data column index this period maps to (point / change_horizon), or -1 for row-axis dates. */
  readonly colIndex: number;
  /** the sibling percentage column for a dated point, when the header has abs / % variants. */
  readonly percentColIndex?: number;
  /** for column_metrics (dates down rows): the row index of the period, else -1. */
  readonly rowIndex: number;
  /** monotonic sort key for temporal ordering (Date ms, year*1e4, or month index). */
  readonly orderKey: number;
  /** semantic horizon label for a change_horizon period ("last_month", "ytd", "prior_year", …). */
  readonly horizon?: ChangeHorizon;
  readonly resolutionConfidence: number;
}

export type ChangeHorizon =
  | "last_month"
  | "ytd"
  | "prior_year"
  | "last_12_months"
  | "last_quarter"
  | "unknown_horizon";

export interface ResolvedInterval {
  readonly start: CanonicalPeriod;
  readonly end: CanonicalPeriod;
}

// --- Stage 24.8 — derived metric-set ranking / events -------------------

/**
 * The exact computed field a rank / argmax_event plan orders by. The two
 * "abs_*" variants are MAGNITUDE (no direction) — required so "наибольшее
 * относительное изменение" never silently means "наибольший рост" (§6/§19).
 */
export type RankingField = "percentage_change" | "absolute_change" | "abs_percentage_change" | "abs_absolute_change";

/** One computed adjacent-period observation for one metric (§15–§19). Never a
 *  precomputed Δ / horizon column — always two adjacent canonical POINT
 *  periods, arithmetic done here. */
export interface AnalysisEvent {
  readonly eventType: "adjacent_period_change";
  readonly metricKey: string;
  readonly startPeriod: CanonicalPeriod;
  readonly endPeriod: CanonicalPeriod;
  readonly startValue: number;
  readonly endValue: number;
  readonly absoluteChange: number;
  readonly percentageChange: number | null;
  readonly startCell: string;
  readonly endCell: string;
}

/** Stage 24.9 §14–§16 — one direction reversal PIVOT of a temporal series: the
 *  point at which the sign of the period-to-period delta flipped. Zero-delta
 *  policy (§14): a zero delta never itself creates or breaks a direction —
 *  it is skipped when comparing signs (the SAME policy as the pre-existing
 *  `detectDirectionChanges`, §51). */
export interface DirectionChangeEvent {
  readonly pivotCanonical: string;
  readonly pivotHeaderPath: string;
  readonly previousDirection: "positive" | "negative";
  readonly nextDirection: "positive" | "negative";
  readonly sourceCell: string;
}

// --- the analytical plan (typed DAG) ----------------------------------

export type AnalyticalStepKind =
  | "resolve_subject"
  | "select_temporal_series"
  | "select_point_value"
  | "select_change_horizon"
  | "arg_extreme"
  | "extrema"
  | "compare_points"
  | "rank_by_change"
  | "rank_by_value"
  | "filter_by_change"
  | "compute_trend"
  | "compute_volatility"
  | "test_monotonicity"
  | "detect_direction_changes"
  | "project_series"
  /** Stage 24.8 §15 — enumerate every metric × every adjacent point-period pair. */
  | "compute_adjacent_events"
  /** Stage 24.8 §37 — resolve TWO independent intervals for a dual-predicate filter. */
  | "select_two_intervals";

export interface AnalyticalStep {
  readonly kind: AnalyticalStepKind;
  readonly detail?: string;
}

export interface ExplicitAssumption {
  readonly text: string;
}

export interface ResolutionIssue {
  readonly field:
    | "subject"
    | "metric"
    | "period"
    | "period_start"
    | "period_end"
    | "threshold"
    | "operation"
    | "interval1"
    | "interval2";
  readonly reason: string;
  readonly candidates?: readonly string[];
}

/** One named interval + its signed predicate, for `two_interval_filter` (§12). */
export interface PredicateInterval {
  readonly id: "interval_1" | "interval_2";
  readonly interval: ResolvedInterval;
  readonly predicate: "positive" | "negative";
}

export interface AnalyticalPlan {
  readonly operation: AnalyticalOperation;
  readonly subject: ResolvedSubject;
  readonly subjectScope: SubjectScope;
  /** the measure kind the plan operates on (point value vs percentage change …). */
  readonly measureKind: MeasureKind;
  readonly measureBasis: "point_value" | "absolute_change" | "percentage_change";
  readonly direction?: RankDirection;
  readonly limit?: number;
  readonly changeSign?: "positive" | "negative" | "any";
  readonly thresholdMode?: ThresholdMode;
  readonly thresholdValue?: number;
  readonly monotone?: AnalyticalIntent["monotone"];
  readonly period?: CanonicalPeriod;
  readonly interval?: ResolvedInterval;
  /** Stage 24.8 §6/§10 — the exact computed field a rank / argmax_event plan
   *  orders by (percentage_change / absolute_change / their magnitudes). */
  readonly rankingField?: RankingField;
  /** Stage 24.8 §12 — the two independently-resolved intervals + predicates
   *  for `two_interval_filter`. Always length 2 when the operation is set. */
  readonly predicateIntervals?: readonly PredicateInterval[];
  /** Stage 24.9 §17/§49 — "чаще всего" superlative direction-change ranking
   *  (single winner) rather than the plain reversal list. */
  readonly directionChangeSuperlative?: boolean;
  /** Stage 24.9 §25/§46 — the semantic classes excluded from this plan's
   *  candidate universe, plus the before/after candidate counts (debug trace). */
  readonly semanticFilter?: {
    readonly excludeClasses: readonly SemanticMetricClass[];
    readonly candidateCountBefore: number;
    readonly candidateCountAfter: number;
  };
  /** Stage 24.9 §35/§36/§40 — the resolved metric labels when `subject.kind`
   *  is `metric_set`, so the caller can persist a MetricSetRef. */
  readonly metricSetLabels?: readonly string[];
  readonly steps: readonly AnalyticalStep[];
  readonly output: OutputProjection;
  readonly assumptions: readonly ExplicitAssumption[];
  readonly unresolved: readonly ResolutionIssue[];
  /** freshness token of the schema the plan was compiled against. */
  readonly sourceVersion: string;
  readonly sourceRange: string;
}

// --- temporal series -------------------------------------------------

/** One numeric observation in a temporal series, with full provenance. */
export interface TemporalPoint {
  /** ISO date, or "YYYY" for a year axis. */
  readonly canonicalPeriod: string;
  readonly periodLabel: string;
  readonly value: number;
  /** sheet-qualified A1 of the source cell. */
  readonly cell: string;
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly percent: boolean;
  /** the raw workbook value, for evidence. */
  readonly raw: number;
}

export interface TemporalSeries {
  /** the subject label this series belongs to (a metric name). */
  readonly key: string;
  readonly measureKind: MeasureKind;
  readonly percent: boolean;
  /** points ordered by canonical period ascending. */
  readonly points: readonly TemporalPoint[];
}

// --- execution outcome ---------------------------------------------

export interface AnalyticalSection {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number)[])[];
}

/** The compare / change audit — requested vs executed periods. */
export interface PeriodAudit {
  readonly requestedStart?: string;
  readonly requestedEnd?: string;
  readonly executedStart?: string;
  readonly executedEnd?: string;
  readonly silentSubstitution: boolean;
}

export interface AnalyticalExecution {
  readonly sections: readonly AnalyticalSection[];
  /** exact source cells backing every numeric result (for a later highlight). */
  readonly sourceCells: readonly string[];
  /** a concise natural-language summary line (method disclosure etc.), optional. */
  readonly summaryLine?: string;
  /** the canonical entity column + values for a follow-up ("выдели их" / "динамику первого"). */
  readonly entityColumn?: string;
  readonly entityValues: readonly string[];
  readonly output: OutputProjection;
  readonly audit: PeriodAudit;
  /** which primitives ran (for the trace). */
  readonly computed: readonly string[];
  /** Stage 24.8 §17/§20 — the ranked adjacent-period events an `argmax_event`
   *  plan produced (winner first), so a follow-up EventRef is built from this
   *  structured data — never re-derived from `sections`/rendered text. */
  readonly events?: readonly AnalysisEvent[];
  /** Stage 24.9 §17/§18 — the single direction-change winner (superlative
   *  ranking), so a DirectionChangeAnalysisRef is built from structured data. */
  readonly directionChangeWinner?: {
    readonly metricKey: string;
    readonly count: number;
    readonly events: readonly DirectionChangeEvent[];
  };
  /** Stage 24.9 §35/§39 — the ordered (metric, score) rows a volatility /
   *  stability ranking produced, so a ResultSetRef can be persisted and later
   *  follow-ups ("какой из них самый волатильный?") answer WITHOUT recompute. */
  readonly resultSet?: {
    readonly operation: string;
    readonly scoreField: string;
    readonly rows: readonly { readonly key: string; readonly score: number }[];
  };
}

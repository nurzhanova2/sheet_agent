// ---------------------------------------------------------------------------
// Stage 24.7 — AnalyticalIntent + TableSchema → AnalyticalPlan (§14).
//
// The plan is a typed DAG. The model may have supplied intent / subject text;
// every coordinate, period and number below is resolved deterministically. A
// missing / ambiguous entity clarifies — it never falls through to another
// planner that could change semantics (§45).
// ---------------------------------------------------------------------------

import { isPercentNumberFormat } from "../excel-date.js";
import { classifySemanticMetricClass, isPercentageLike, type MeasureKind } from "../measure-compatibility.js";
import type { RowAxisMember, TableSchema } from "../schema-induction.js";
import type { AnalysisGrids } from "../matrix-analysis.js";
import { buildPeriodIndex, type PeriodIndex } from "./period-index.js";
import { resolvePeriod, type InheritedPeriod } from "./period-resolver.js";
import { buildMetricIndex, type MetricIndex } from "./metric-resolver.js";
import { resolveSubject, resolveMetricSetSubject, type SubjectResolution } from "./subject-resolver.js";
import type {
  AnalyticalIntent,
  AnalyticalPlan,
  AnalyticalStep,
  CanonicalPeriod,
  ExplicitAssumption,
  PredicateInterval,
  RankingField,
  ResolutionIssue,
  ResolvedInterval,
  ResolvedSubject,
} from "./types.js";

/** Stage 24.8 §11/§30/§31 — enough of the prior explicit-interval rank to
 *  replay it with a different basis ("те же 5, но по абсолютному изменению"). */
export interface InheritedRanking {
  readonly interval: ResolvedInterval;
  readonly limit?: number;
}

/** Stage 24.8 §13/§14 — the prior CompositeAnalysisRef's two intervals, reused
 *  when the user refers to them ordinally ("в первом интервале… во втором…"). */
export interface InheritedComposite {
  readonly interval1: ResolvedInterval;
  readonly interval2: ResolvedInterval;
}

/** Stage 24.9 §35/§36/§50 — the prior MetricSetRef's members, reused as the
 *  candidate set for "какой из них вырос сильнее…" (growth is recomputed
 *  fresh; only the CANDIDATE SET is inherited). */
export interface InheritedMetricSet {
  readonly members: readonly RowAxisMember[];
}

export interface CompileContext {
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  readonly inheritedPeriod?: InheritedPeriod;
  /** Stage 24.7 §45 — a subject the user picked from a clarification; overrides
   *  `intent.subjectText` so the SAME request re-compiles unambiguously. */
  readonly subjectOverride?: string;
  readonly inheritedRanking?: InheritedRanking;
  readonly inheritedComposite?: InheritedComposite;
  readonly inheritedMetricSet?: InheritedMetricSet;
}

export type CompileOutcome =
  | { readonly kind: "plan"; readonly plan: AnalyticalPlan; readonly periodIndex: PeriodIndex; readonly metricIndex: MetricIndex }
  | { readonly kind: "clarify"; readonly field: ResolutionIssue["field"]; readonly needle: string; readonly candidates: readonly string[]; readonly question: string }
  | { readonly kind: "unresolved"; readonly issues: readonly ResolutionIssue[] }
  | { readonly kind: "decline"; readonly reason: string };

const NEEDS_TEMPORAL = new Set([
  "argmax",
  "argmin",
  "time_series",
  "compare",
  "change",
  "filter",
  "trend",
  "volatility",
  "stability",
  "monotonicity",
  "direction_change",
  "rank",
  "argmax_event",
  "two_interval_filter",
  "compare_time_series",
  "compare_growth",
]);

function thresholdFraction(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /(\d+(?:[.,]\d+)?)\s*(%)?/.exec(text);
  if (!m) return undefined;
  const raw = Number(m[1]!.replace(",", "."));
  if (!Number.isFinite(raw)) return undefined;
  // "more than 20%" → 0.2; "more than 0.2" → 0.2; a bare integer >= 1 with a %
  // sign or the word percent is a percentage.
  return m[2] || /проц|percent/i.test(text) || raw >= 1 ? raw / 100 : raw;
}

function measureBasisFor(intent: AnalyticalIntent, schema: TableSchema): AnalyticalPlan["measureBasis"] {
  // §26 — an explicit user override always wins.
  if (intent.measureBasisOverride) return intent.measureBasisOverride;
  if (
    intent.operation === "rank" ||
    intent.operation === "argmax_event" ||
    intent.operation === "two_interval_filter" ||
    intent.operation === "compare_growth"
  ) {
    return "percentage_change";
  }
  if (intent.operation === "filter") {
    // "изменились более чем на 20%" → percentage_change; monetary heterogeneous
    // metrics default to percentage change (§25).
    return "percentage_change";
  }
  if (intent.operation === "change" || intent.operation === "compare") return "point_value";
  void schema;
  return "point_value";
}

/**
 * Stage 24.8 §6/§13/§19 — the exact computed field a `rank` / `argmax_event`
 * plan orders by. No explicit direction word ("рост"/"снижение") means
 * MAGNITUDE (`rankMagnitude`), never silently "grew". An explicit basis
 * override (§26) always wins over the default percentage preference.
 */
function rankingFieldFor(intent: AnalyticalIntent): RankingField {
  const pct = intent.measureBasisOverride !== "absolute_change";
  const magnitude = intent.rankMagnitude ?? (!intent.changeSign || intent.changeSign === "any");
  if (pct) return magnitude ? "abs_percentage_change" : "percentage_change";
  return magnitude ? "abs_absolute_change" : "absolute_change";
}

function measureKindOf(schema: TableSchema, basis: AnalyticalPlan["measureBasis"]): MeasureKind {
  if (basis === "percentage_change") return "percentage_change";
  if (basis === "absolute_change") return "absolute_change";
  const amount = schema.measures.find((m) => m.kind === "amount" || m.kind === "unknown_numeric");
  return amount?.kind ?? schema.measures[0]?.kind ?? "unknown_numeric";
}

function steps(intent: AnalyticalIntent): AnalyticalStep[] {
  const s: AnalyticalStep[] = [{ kind: "resolve_subject" }];
  switch (intent.operation) {
    case "argmax":
    case "argmin":
      s.push({ kind: "select_temporal_series" }, { kind: "arg_extreme", detail: intent.operation });
      break;
    case "time_series":
      s.push({ kind: "select_temporal_series" }, { kind: "project_series" });
      break;
    case "compare":
      s.push({ kind: "select_point_value", detail: "start" }, { kind: "select_point_value", detail: "end" }, { kind: "compare_points" });
      break;
    case "change":
      s.push({ kind: "select_point_value", detail: "start" }, { kind: "select_point_value", detail: "end" }, { kind: "compare_points" });
      break;
    case "filter":
      if (intent.thresholdText) s.push({ kind: "select_point_value", detail: "start" }, { kind: "select_point_value", detail: "end" }, { kind: "filter_by_change" });
      else s.push({ kind: "select_point_value", detail: "start" }, { kind: "select_point_value", detail: "end" }, { kind: "filter_by_change" });
      break;
    case "rank":
      s.push({ kind: "select_change_horizon" }, { kind: "rank_by_change" });
      break;
    case "trend":
      s.push({ kind: "select_temporal_series" }, { kind: "compute_trend" });
      break;
    case "volatility":
    case "stability":
      s.push({ kind: "select_temporal_series" }, { kind: "compute_volatility" });
      break;
    case "monotonicity":
      s.push({ kind: "select_temporal_series" }, { kind: "test_monotonicity" });
      break;
    case "direction_change":
      s.push({ kind: "select_temporal_series" }, { kind: "detect_direction_changes" });
      break;
    case "argmax_event":
      s.push({ kind: "select_temporal_series" }, { kind: "compute_adjacent_events" }, { kind: "rank_by_change" });
      break;
    case "two_interval_filter":
      s.push({ kind: "select_two_intervals" }, { kind: "filter_by_change" });
      break;
    case "compare_time_series":
      s.push({ kind: "select_temporal_series" }, { kind: "project_series" });
      break;
    case "compare_growth":
      s.push({ kind: "select_change_horizon" }, { kind: "rank_by_change" });
      break;
    default:
      break;
  }
  return s;
}

function subjectClarifyQuestion(needle: string, candidates: readonly string[], ru: boolean): string {
  return ru
    ? `Уточните показатель «${needle}» — подходит несколько: ${candidates.join(", ")}. Какой взять?`
    : `Which "${needle}" do you mean — ${candidates.join(", ")}?`;
}

export function compileAnalyticalPlan(intent: AnalyticalIntent, ctx: CompileContext, language: "ru" | "en" = "ru"): CompileOutcome {
  const ru = language === "ru";
  const { schema, grids } = ctx;
  if (!intent.any || intent.operation === "unknown") return { kind: "decline", reason: "no analytical operation" };

  const metricIndex = buildMetricIndex(schema);
  const periodIndex = buildPeriodIndex(schema, grids);

  // A temporal operation needs a temporal axis.
  if (NEEDS_TEMPORAL.has(intent.operation) && periodIndex.axis === "none" && intent.operation !== "rank") {
    return { kind: "decline", reason: "no temporal axis in this table" };
  }

  const assumptions: ExplicitAssumption[] = [];
  const unresolved: ResolutionIssue[] = [];

  // --- subject ---------------------------------------------------------
  let sub: SubjectResolution;
  if (intent.operation === "compare_time_series" || intent.operation === "compare_growth") {
    // Stage 24.9 §8–§10/§35/§36 — an EXPLICIT multi-metric phrase resolves
    // fresh; a pronoun ("какой из них…") reuses the prior MetricSetRef's
    // members as the candidate set (never every metric in the table).
    if (intent.metricSetText) {
      sub = resolveMetricSetSubject(intent.metricSetText, schema, metricIndex);
    } else if (intent.sameMetricSetRef) {
      if (ctx.inheritedMetricSet && ctx.inheritedMetricSet.members.length > 0) {
        sub = { kind: "resolved", subject: { kind: "metric_set", members: ctx.inheritedMetricSet.members }, scope: "metric_set", how: "inherited_metric_set" };
      } else {
        return { kind: "unresolved", issues: [{ field: "subject", reason: "no prior metric set to reuse" }] };
      }
    } else {
      return { kind: "unresolved", issues: [{ field: "subject", reason: "a comparison needs at least two named metrics" }] };
    }
  } else {
    const subjectIntent = ctx.subjectOverride ? { ...intent, subjectText: ctx.subjectOverride } : intent;
    sub = resolveSubject(subjectIntent, schema, metricIndex);
  }
  if (sub.kind === "ambiguous") {
    return {
      kind: "clarify",
      field: "subject",
      needle: sub.needle,
      candidates: sub.candidates,
      question: subjectClarifyQuestion(sub.needle, sub.candidates, ru),
    };
  }
  if (sub.kind === "unknown") {
    return {
      kind: "unresolved",
      issues: [{ field: "subject", reason: `could not resolve subject "${sub.needle}"` }],
    };
  }

  // Stage 24.9 §22–§25 — semantic-class exclusion, applied BEFORE any ranking
  // / volatility / argmax / trend / stability computation — never only hidden
  // at render time. Generic: works for any each_metric / each_column subject,
  // not a special case tied to "volatility" specifically.
  let resolvedSubject: ResolvedSubject = sub.subject;
  let semanticFilter: AnalyticalPlan["semanticFilter"];
  if (intent.excludeMetricClasses && intent.excludeMetricClasses.length > 0) {
    if (resolvedSubject.kind === "each_metric") {
      const before = resolvedSubject.members.length;
      const kept = resolvedSubject.members.filter((m) => {
        // Only the POINT-VALUE ("абс.") column per period, never its "%"
        // sibling — every row_metrics metric has a "%" change column, so
        // scanning ALL schema.columnPaths would misclassify every metric as
        // percentage-like.
        const percentFormatted = periodIndex.points.some(
          (per) => isPercentNumberFormat(grids.numberFormats[m.rowIndex]?.[per.colIndex] ?? null),
        );
        const cls = classifySemanticMetricClass(m.display, { percentFormatted });
        return !isPercentageLike(cls);
      });
      resolvedSubject = { kind: "each_metric", members: kept };
      semanticFilter = { excludeClasses: intent.excludeMetricClasses, candidateCountBefore: before, candidateCountAfter: kept.length };
    } else if (resolvedSubject.kind === "each_column") {
      const before = resolvedSubject.columns.length;
      const kept = resolvedSubject.columns.filter(
        (c) => !isPercentageLike(classifySemanticMetricClass(c.displayLabel, { measureKind: c.measureKind })),
      );
      resolvedSubject = { kind: "each_column", columns: kept };
      semanticFilter = { excludeClasses: intent.excludeMetricClasses, candidateCountBefore: before, candidateCountAfter: kept.length };
    }
    if (semanticFilter) {
      assumptions.push({
        text: ru
          ? `процентные показатели исключены из рассмотрения (${semanticFilter.candidateCountAfter} из ${semanticFilter.candidateCountBefore})`
          : `percentage-like metrics excluded (${semanticFilter.candidateCountAfter} of ${semanticFilter.candidateCountBefore})`,
      });
    }
  }

  // --- period(s) ------------------------------------------------------
  let period: CanonicalPeriod | undefined;
  let interval: ResolvedInterval | undefined;
  let predicateIntervals: PredicateInterval[] | undefined;
  // Stage 24.8 §31 — "те же 5" may restate the limit or omit it; when
  // omitted, fall back to the reused ranking's own limit.
  let effectiveLimit = intent.limit;

  if (intent.operation === "compare" || intent.operation === "change" || (intent.operation === "filter" && (intent.periodStartText || intent.periodText))) {
    if (intent.periodStartText && intent.periodEndText) {
      // two explicit endpoints — resolved SEPARATELY and exactly (§2/§22).
      const s = resolvePeriod(intent.periodStartText, periodIndex);
      const e = resolvePeriod(intent.periodEndText, periodIndex);
      for (const [label, r] of [["period_start", s] as const, ["period_end", e] as const]) {
        if (r.kind === "unresolved") return { kind: "unresolved", issues: [{ field: label, reason: r.detail, candidates: [r.requested] }] };
        if (r.kind === "ambiguous") return { kind: "clarify", field: label, needle: r.requested, candidates: r.candidates, question: ru ? `Уточните период «${r.requested}»: ${r.candidates.join(", ")}.` : `Which "${r.requested}" period — ${r.candidates.join(", ")}?` };
      }
      if (s.kind === "point" && e.kind === "point") {
        interval = { start: s.period, end: e.period };
      } else {
        unresolved.push({ field: "period", reason: "the interval endpoints did not both resolve to dates" });
      }
    } else {
      const res = resolvePeriod(intent.periodText ?? "за этот же период", periodIndex, ctx.inheritedPeriod);
      if (res.kind === "unresolved") return { kind: "unresolved", issues: [{ field: "period", reason: res.detail, candidates: [res.requested] }] };
      if (res.kind === "ambiguous") return { kind: "clarify", field: "period", needle: res.requested, candidates: res.candidates, question: ru ? `Уточните период «${res.requested}»: ${res.candidates.join(", ")}.` : `Which "${res.requested}" period — ${res.candidates.join(", ")}?` };
      if (res.kind === "interval") {
        interval = res.interval;
        if (res.inherited) assumptions.push({ text: ru ? "период взят из предыдущего запроса" : "period inherited from the previous request" });
      } else if (res.kind === "horizon" && intent.operation === "filter") {
        // a threshold / signed filter over a relative horizon ("за последний
        // месяц") reads the precomputed Δ column directly — not two points.
        period = res.period;
      } else {
        unresolved.push({ field: "period", reason: "a comparison needs two periods; only one resolved" });
      }
    }
  } else if (intent.operation === "filter") {
    // Stage 24.7.1 §21/§22 — a threshold / signed filter with NO explicit
    // period and no interval. Inherit the active PeriodRef when one exists;
    // otherwise clarify ONE explicit safe policy — never silently pick one
    // arbitrary change horizon, and never return an empty "no result".
    if (ctx.inheritedPeriod) {
      interval = { start: ctx.inheritedPeriod.start, end: ctx.inheritedPeriod.end };
      assumptions.push({ text: ru ? "период взят из предыдущего запроса" : "period inherited from the previous request" });
    } else {
      const candidates = ru
        ? ["за последний месяц", "с начала года", "за 12 месяцев"]
        : ["last month", "year to date", "last 12 months"];
      return {
        kind: "clarify",
        field: "period",
        needle: "",
        candidates,
        question: ru
          ? "За какой период проверить изменение: за последний месяц, с начала года, за 12 месяцев или другой период?"
          : "Which period should I check the change over — last month, year to date, last 12 months, or another period?",
      };
    }
  } else if (intent.operation === "rank") {
    if (intent.periodStartText && intent.periodEndText) {
      // Stage 24.8 §7 — an EXPLICIT interval ALWAYS outranks last_month /
      // default change-horizon fallbacks, exactly like compare/change/filter.
      const s = resolvePeriod(intent.periodStartText, periodIndex);
      const e = resolvePeriod(intent.periodEndText, periodIndex);
      for (const [label, r] of [["period_start", s] as const, ["period_end", e] as const]) {
        if (r.kind === "unresolved") return { kind: "unresolved", issues: [{ field: label, reason: r.detail, candidates: [r.requested] }] };
        if (r.kind === "ambiguous") return { kind: "clarify", field: label, needle: r.requested, candidates: r.candidates, question: ru ? `Уточните период «${r.requested}»: ${r.candidates.join(", ")}.` : `Which "${r.requested}" period — ${r.candidates.join(", ")}?` };
      }
      if (s.kind === "point" && e.kind === "point") {
        interval = { start: s.period, end: e.period };
      } else {
        unresolved.push({ field: "period", reason: "the interval endpoints did not both resolve to dates" });
      }
    } else if (intent.sameRankingRef) {
      // Stage 24.8 §11/§30/§31 — "те же 5, но по абсолютному изменению":
      // reuse the prior ranking's scope/interval/limit; only the basis (parsed
      // separately, via measureBasisOverride/rankMagnitude) is new.
      if (ctx.inheritedRanking) {
        interval = ctx.inheritedRanking.interval;
        if (effectiveLimit === undefined) effectiveLimit = ctx.inheritedRanking.limit;
        assumptions.push({ text: ru ? "период и охват взяты из предыдущего ранжирования" : "period and scope inherited from the previous ranking" });
      } else {
        return { kind: "unresolved", issues: [{ field: "period", reason: "no prior ranking to reuse" }] };
      }
    } else {
      // rank by a change horizon (unchanged — §61 regression), OR reuse the
      // exact remembered interval for "за этот же период" (Stage 24.8 §33).
      const res = resolvePeriod(intent.periodText ?? "за последний месяц", periodIndex, ctx.inheritedPeriod);
      if (res.kind === "horizon") {
        period = res.period;
      } else if (res.kind === "interval") {
        interval = res.interval;
        if (res.inherited) assumptions.push({ text: ru ? "период взят из предыдущего запроса" : "period inherited from the previous request" });
      } else if (res.kind === "unresolved") {
        return { kind: "unresolved", issues: [{ field: "period", reason: res.detail }] };
      } else {
        // no explicit horizon — use the only / first available horizon, disclosed.
        const h = periodIndex.horizons[0];
        if (!h) return { kind: "decline", reason: "no change horizon available for ranking" };
        period = h;
        assumptions.push({ text: ru ? `использована колонка изменения «${h.headerPath}»` : `used the change column "${h.headerPath}"` });
      }
    }
  } else if (intent.operation === "argmax_event") {
    // Stage 24.8 §15–§19 — uses EVERY canonical point period; no single
    // period/interval to resolve here.
    if (periodIndex.points.length < 2) {
      return { kind: "unresolved", issues: [{ field: "period", reason: "not enough point periods for an adjacent-period comparison" }] };
    }
  } else if (intent.operation === "two_interval_filter") {
    if (intent.ordinalIntervalRef) {
      // Stage 24.8 §13/§14 — "в первом интервале… во втором…" reuses the
      // prior CompositeAnalysisRef's exact two intervals.
      if (!ctx.inheritedComposite) {
        return { kind: "unresolved", issues: [{ field: "interval1", reason: "no prior two-interval analysis to reuse" }] };
      }
      if (intent.interval1Predicate && intent.interval2Predicate) {
        predicateIntervals = [
          { id: "interval_1", interval: ctx.inheritedComposite.interval1, predicate: intent.interval1Predicate },
          { id: "interval_2", interval: ctx.inheritedComposite.interval2, predicate: intent.interval2Predicate },
        ];
        assumptions.push({ text: ru ? "интервалы взяты из предыдущего анализа" : "intervals inherited from the previous analysis" });
      }
    } else {
      // Stage 24.8 §37 — two explicit intervals, each resolved SEPARATELY and
      // exactly (§2/§22 — no silent substitution applies to either).
      const specs: readonly (readonly ["interval1" | "interval2", string | undefined, string | undefined, "positive" | "negative" | undefined])[] = [
        ["interval1", intent.interval1StartText, intent.interval1EndText, intent.interval1Predicate],
        ["interval2", intent.interval2StartText, intent.interval2EndText, intent.interval2Predicate],
      ];
      const resolvedIntervals: PredicateInterval[] = [];
      for (const [label, startText, endText, predicate] of specs) {
        if (!startText || !endText || !predicate) {
          return { kind: "unresolved", issues: [{ field: label, reason: "interval endpoints or predicate missing" }] };
        }
        const s = resolvePeriod(startText, periodIndex);
        const e = resolvePeriod(endText, periodIndex);
        for (const [sub2, r] of [["period_start", s] as const, ["period_end", e] as const]) {
          if (r.kind === "unresolved") return { kind: "unresolved", issues: [{ field: sub2, reason: r.detail, candidates: [r.requested] }] };
          if (r.kind === "ambiguous") return { kind: "clarify", field: sub2, needle: r.requested, candidates: r.candidates, question: ru ? `Уточните период «${r.requested}»: ${r.candidates.join(", ")}.` : `Which "${r.requested}" period — ${r.candidates.join(", ")}?` };
        }
        if (s.kind === "point" && e.kind === "point") {
          resolvedIntervals.push({ id: label === "interval1" ? "interval_1" : "interval_2", interval: { start: s.period, end: e.period }, predicate });
        } else {
          return { kind: "unresolved", issues: [{ field: label, reason: "the interval endpoints did not both resolve to dates" }] };
        }
      }
      predicateIntervals = resolvedIntervals;
    }
    if (!predicateIntervals || predicateIntervals.length !== 2) {
      unresolved.push({ field: "period", reason: "both intervals and predicates are required" });
    }
  } else if (intent.operation === "compare_growth") {
    if (intent.periodStartText && intent.periodEndText) {
      // an explicit interval (§13 allows an override) resolves exactly like
      // every other explicit two-endpoint operation.
      const s = resolvePeriod(intent.periodStartText, periodIndex);
      const e = resolvePeriod(intent.periodEndText, periodIndex);
      for (const [label, r] of [["period_start", s] as const, ["period_end", e] as const]) {
        if (r.kind === "unresolved") return { kind: "unresolved", issues: [{ field: label, reason: r.detail, candidates: [r.requested] }] };
        if (r.kind === "ambiguous") return { kind: "clarify", field: label, needle: r.requested, candidates: r.candidates, question: ru ? `Уточните период «${r.requested}»: ${r.candidates.join(", ")}.` : `Which "${r.requested}" period — ${r.candidates.join(", ")}?` };
      }
      if (s.kind === "point" && e.kind === "point") {
        interval = { start: s.period, end: e.period };
      } else {
        unresolved.push({ field: "period", reason: "the interval endpoints did not both resolve to dates" });
      }
    } else {
      // Stage 24.9 §13/§44/§58 — the DETERMINISTIC default for a generic
      // "темп роста" comparison: first canonical point → last canonical
      // point. NEVER requires (or falls back to) an inherited PeriodRef.
      const pts = periodIndex.points;
      if (pts.length < 2) {
        return { kind: "unresolved", issues: [{ field: "period", reason: "not enough point periods for a growth comparison" }] };
      }
      const sorted = [...pts].sort((a, b) => a.orderKey - b.orderKey);
      interval = { start: sorted[0]!, end: sorted[sorted.length - 1]! };
      assumptions.push({
        text: ru ? "интервал — от первой до последней доступной даты" : "interval — first to last available date",
      });
    }
  } else if (intent.operation === "argmax" || intent.operation === "argmin" || intent.operation === "time_series" || intent.operation === "volatility" || intent.operation === "stability" || intent.operation === "trend" || intent.operation === "monotonicity" || intent.operation === "direction_change" || intent.operation === "compare_time_series") {
    // whole point-in-time series — no single period.
  }

  const measureBasis = measureBasisFor(intent, schema);
  const measureKind = measureKindOf(schema, measureBasis);
  const thresholdValue = thresholdFraction(intent.thresholdText);
  const rankingField =
    intent.operation === "rank" || intent.operation === "argmax_event"
      ? rankingFieldFor(intent)
      : intent.operation === "compare_growth"
        ? intent.measureBasisOverride === "absolute_change"
          ? "absolute_change"
          : "percentage_change"
        : undefined;

  const planDirection = intent.direction ?? (intent.operation === "argmax_event" || intent.operation === "compare_growth" ? "desc" : undefined);
  const planLimit = effectiveLimit ?? (intent.operation === "argmax_event" ? 1 : undefined);

  const metricSetLabels =
    resolvedSubject.kind === "metric_set" ? resolvedSubject.members.map((m) => m.display) : undefined;

  const plan: AnalyticalPlan = {
    operation: intent.operation,
    subject: resolvedSubject,
    subjectScope: sub.scope,
    measureKind,
    measureBasis,
    ...(planDirection ? { direction: planDirection } : {}),
    ...(typeof planLimit === "number" ? { limit: planLimit } : {}),
    ...(intent.changeSign ? { changeSign: intent.changeSign } : {}),
    ...(intent.thresholdMode ? { thresholdMode: intent.thresholdMode } : {}),
    ...(thresholdValue !== undefined ? { thresholdValue } : {}),
    ...(intent.monotone ? { monotone: intent.monotone } : {}),
    ...(period ? { period } : {}),
    ...(interval ? { interval } : {}),
    ...(rankingField ? { rankingField } : {}),
    ...(predicateIntervals ? { predicateIntervals } : {}),
    ...(intent.directionChangeSuperlative ? { directionChangeSuperlative: true } : {}),
    ...(semanticFilter ? { semanticFilter } : {}),
    ...(metricSetLabels ? { metricSetLabels } : {}),
    steps: steps(intent),
    output: intent.outputProjection,
    assumptions,
    unresolved,
    sourceVersion: schema.sourceVersion,
    sourceRange: schema.sourceRange,
  };

  return { kind: "plan", plan, periodIndex, metricIndex };
}

// ---------------------------------------------------------------------------
// Stage 24.7 — plan validation (§15). Fail closed or clarify; never partially
// mutate plan semantics.
// ---------------------------------------------------------------------------

import type { AnalysisGrids } from "../matrix-analysis.js";
import type { TableSchema } from "../schema-induction.js";
import { getTemporalSeriesSet } from "./temporal-series.js";
import type { AnalyticalPlan } from "./types.js";
import type { PeriodIndex } from "./period-index.js";

export interface PlanValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const MIN_OBS: Readonly<Record<string, number>> = {
  volatility: 3,
  stability: 3,
  trend: 2,
  monotonicity: 2,
  direction_change: 3,
  time_series: 2,
  argmax: 1,
  argmin: 1,
};

export function validatePlan(
  plan: AnalyticalPlan,
  schema: TableSchema,
  grids: AnalysisGrids,
  periodIndex: PeriodIndex,
): PlanValidation {
  const errors: string[] = [];

  if (plan.unresolved.length > 0) {
    for (const u of plan.unresolved) errors.push(`${u.field}: ${u.reason}`);
  }

  // subject exists
  const subjectCount =
    plan.subject.kind === "each_metric"
      ? plan.subject.members.length
      : plan.subject.kind === "each_column"
        ? plan.subject.columns.length
        : 1;
  if (subjectCount === 0) errors.push("subject resolved to nothing");

  // temporal axis when needed
  const needsTemporal = plan.steps.some((s) => s.kind === "select_temporal_series" || s.kind === "select_point_value");
  if (needsTemporal && periodIndex.axis === "none") errors.push("no temporal axis available");

  // ranking direction
  if (plan.operation === "rank" && !plan.direction) errors.push("ranking direction is unknown");

  // limit valid
  if (typeof plan.limit === "number" && (!Number.isInteger(plan.limit) || plan.limit <= 0)) {
    errors.push(`invalid limit ${plan.limit}`);
  }

  // requested periods exist
  if (plan.interval) {
    if (!periodIndex.points.some((p) => p.canonical === plan.interval!.start.canonical)) {
      errors.push(`period ${plan.interval.start.canonical} not found`);
    }
    if (!periodIndex.points.some((p) => p.canonical === plan.interval!.end.canonical)) {
      errors.push(`period ${plan.interval.end.canonical} not found`);
    }
  }
  if (plan.period && plan.period.kind === "change_horizon" && !periodIndex.horizons.some((h) => h.colIndex === plan.period!.colIndex)) {
    errors.push(`change horizon ${plan.period.headerPath} not found`);
  }

  // Stage 24.8 §9 — a two_interval_filter needs EXACTLY two resolved,
  // distinct, predicated intervals — never a silent single-interval fallback.
  if (plan.operation === "two_interval_filter") {
    if (!plan.predicateIntervals || plan.predicateIntervals.length !== 2) {
      errors.push("two_interval_filter requires exactly two predicated intervals");
    } else {
      for (const pi of plan.predicateIntervals) {
        if (!periodIndex.points.some((p) => p.canonical === pi.interval.start.canonical)) {
          errors.push(`period ${pi.interval.start.canonical} not found`);
        }
        if (!periodIndex.points.some((p) => p.canonical === pi.interval.end.canonical)) {
          errors.push(`period ${pi.interval.end.canonical} not found`);
        }
        if (pi.interval.start.canonical === pi.interval.end.canonical) {
          errors.push(`${pi.id}: start and end period must differ`);
        }
      }
    }
  }

  // Stage 24.8 §67 — the adjacent-event engine needs at least 2 canonical
  // point periods (>= 1 adjacent pair) and a valid ranking field.
  if (plan.operation === "argmax_event") {
    if (periodIndex.points.length < 2) errors.push("not enough point periods for an adjacent-period comparison");
    if (!plan.rankingField) errors.push("argmax_event requires a ranking field");
  }

  // rank must carry a ranking field once it reaches validation.
  if (plan.operation === "rank" && !plan.rankingField) errors.push("rank requires a ranking field");

  // enough observations for a temporal series operation
  const min = MIN_OBS[plan.operation];
  if (min && (plan.operation === "volatility" || plan.operation === "stability" || plan.operation === "trend" || plan.operation === "monotonicity" || plan.operation === "direction_change" || plan.operation === "time_series")) {
    const set = getTemporalSeriesSet(schema, grids, plan.subject, periodIndex);
    const anyEnough = set.some((s) => s.points.length >= min);
    if (!anyEnough) {
      errors.push(`not enough temporal observations for ${plan.operation} (need ${min})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

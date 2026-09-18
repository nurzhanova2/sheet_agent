// ---------------------------------------------------------------------------
// Stage 24.7 — resolves the analytical SUBJECT against schema axes (§6).
//
// "5 показателей" → members of the row-metric axis, NOT a literal column named
// "показателей". "Активы" → one row-axis member. "Revenue" (transpose) → one
// measure column. Ambiguity clarifies; it never silently picks.
// ---------------------------------------------------------------------------

import type { TableSchema } from "../schema-induction.js";
import type { AnalyticalIntent, ResolvedSubject, SubjectScope } from "./types.js";
import { AXIS_NOUN_RE, DIMENSION_NOUN_RE, buildMetricIndex, resolveMetric, resolveMetricSet, type MetricIndex } from "./metric-resolver.js";

export type SubjectResolution =
  | { readonly kind: "resolved"; readonly subject: ResolvedSubject; readonly scope: SubjectScope; readonly how: string }
  | { readonly kind: "ambiguous"; readonly needle: string; readonly candidates: readonly string[] }
  | { readonly kind: "unknown"; readonly needle: string };

const AXIS_SCOPE_OPS = new Set([
  "rank",
  "filter",
  "volatility",
  "stability",
  "trend",
  "monotonicity",
  "direction_change",
  "compare",
  "argmax",
  "argmin",
  "extrema",
  // Stage 24.8 — both operate over EVERY compatible metric by default; a
  // named single metric is the exception, not the rule.
  "argmax_event",
  "two_interval_filter",
]);

/** Strips a leading quantifier ("каждый", "все", "each", "every"). */
function stripQuantifier(s: string): string {
  return s.replace(/^(?:кажд\p{L}*|всех|все|всё|любой|люб\p{L}*|each|every|all)\s+/iu, "").trim();
}

/** Every row-axis member that is not a detected total row. */
function metricMembers(schema: TableSchema): ResolvedSubject {
  const totalRows = new Set(schema.totals.map((t) => t.rowIndex));
  return { kind: "each_metric", members: schema.rowAxis.filter((m) => !totalRows.has(m.rowIndex)) };
}

export function resolveSubject(
  intent: AnalyticalIntent,
  schema: TableSchema,
  index: MetricIndex = buildMetricIndex(schema),
): SubjectResolution {
  const needle = stripQuantifier((intent.subjectText ?? "").trim());
  const perMetricOp = AXIS_SCOPE_OPS.has(intent.operation);
  const wantsAxis =
    needle === "" ||
    AXIS_NOUN_RE.test(needle) ||
    DIMENSION_NOUN_RE.test(needle) ||
    /^(?:значени\p{L}*|values?)$/iu.test(needle);

  if (wantsAxis && perMetricOp) {
    if (schema.orientation === "column_metrics") {
      return {
        kind: "resolved",
        subject: { kind: "each_column", columns: schema.columnPaths },
        scope: "column_axis",
        how: "axis_noun",
      };
    }
    return { kind: "resolved", subject: metricMembers(schema), scope: "row_axis", how: "axis_noun" };
  }

  if (needle === "") {
    // per-metric argmax / argmin with no subject → every metric.
    if (intent.operation === "argmax" || intent.operation === "argmin") {
      if (schema.orientation === "column_metrics") {
        return { kind: "resolved", subject: { kind: "each_column", columns: schema.columnPaths }, scope: "column_axis", how: "implicit_axis" };
      }
      return { kind: "resolved", subject: metricMembers(schema), scope: "row_axis", how: "implicit_axis" };
    }
    return { kind: "unknown", needle };
  }

  const r = resolveMetric(needle, index);
  if (r.kind === "ambiguous") return { kind: "ambiguous", needle, candidates: r.candidates };
  if (r.kind === "unknown") return { kind: "unknown", needle };
  if (r.entry.kind === "row_member" && r.entry.member) {
    return { kind: "resolved", subject: { kind: "row_axis_member", member: r.entry.member }, scope: "single_metric", how: r.how };
  }
  if (r.entry.kind === "column" && r.entry.column) {
    return { kind: "resolved", subject: { kind: "column_measure", column: r.entry.column }, scope: "single_metric", how: r.how };
  }
  return { kind: "unknown", needle };
}

/**
 * Stage 24.9 §8–§10 — resolves an EXPLICIT multi-metric phrase ("Активы и
 * Обязательства") into a bounded `metric_set` subject. Row-axis only (§9
 * scope) — a `column_metrics` (transposed) table declines rather than
 * silently guessing a column-based multi-metric shape.
 */
export function resolveMetricSetSubject(
  metricSetText: string,
  schema: TableSchema,
  index: MetricIndex = buildMetricIndex(schema),
): SubjectResolution {
  const needle = metricSetText.trim();
  if (schema.orientation === "column_metrics") return { kind: "unknown", needle };
  const r = resolveMetricSet(needle, index);
  if (r.kind === "ambiguous") return { kind: "ambiguous", needle: r.needle, candidates: r.candidates };
  if (r.kind === "unknown") return { kind: "unknown", needle: r.needle };
  const members = r.entries.map((e) => e.member).filter((m): m is NonNullable<typeof m> => Boolean(m));
  if (members.length < r.entries.length) return { kind: "unknown", needle };
  return { kind: "resolved", subject: { kind: "metric_set", members }, scope: "metric_set", how: "metric_set" };
}

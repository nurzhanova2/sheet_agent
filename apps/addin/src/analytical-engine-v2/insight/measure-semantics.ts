import { isPercentNumberFormat } from "../../app/schema/excel-date.js";
import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import { classifySemanticMetricClass, isPercentageLike, type SemanticMetricClass } from "../../app/schema/measure-compatibility.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";

/**
 * §52 — the display semantics of one numeric column.
 *
 * `percent_fraction` and `percent_scaled` are deliberately distinct: 0.2863
 * and 28.63 both mean "28.63%", and the only thing separating them is where
 * the number came from. Collapsing them is how a share becomes 2863%.
 */
export type DisplayUnit =
  /** A magnitude in the table's own units. 19871.544896 → "19 871,5". */
  | { readonly kind: "amount" }
  /** A whole-number tally. 6 → "6". */
  | { readonly kind: "count" }
  /** A 0..1 fraction shown as a percentage. 0.2863 → "28,63%". */
  | { readonly kind: "percent_fraction" }
  /** Already in percent units. 28.63 → "28,63%". */
  | { readonly kind: "percent_scaled" }
  /**
   * §53 — the DIFFERENCE between two percentages, in percentage points.
   * 0.0081 (fraction-scaled) → "+0,81 п.п."; 0.81 (percent-scaled) → same.
   * `scaled` says which, exactly as for the two percent kinds above.
   */
  | { readonly kind: "percent_point_delta"; readonly scaled: boolean }
  /** A multiplicative factor. 6.5555 → "6,56×". */
  | { readonly kind: "ratio" }
  /** A unitless computed score (volatility, silhouette, distance). */
  | { readonly kind: "score" }
  /** No evidence either way — print the number and claim nothing. */
  | { readonly kind: "unknown" };

/** Field names every V2 tool uses for the same role. Stable tool contract, not prose. */
const PERCENT_CHANGE_FIELDS: ReadonlySet<string> = new Set(["percentageChange", "percentChange", "pctChange"]);
const ABSOLUTE_CHANGE_FIELDS: ReadonlySet<string> = new Set(["absoluteChange", "delta", "change"]);
const LEVEL_FIELDS: ReadonlySet<string> = new Set(["value", "startValue", "endValue", "min", "max", "mean", "median", "first", "last"]);
const COUNT_FIELDS: ReadonlySet<string> = new Set([
  "periodCount",
  "directionChangeCount",
  "count",
  "rowCount",
  "matched",
  "clusterSize",
  "n",
]);
const SCORE_FIELDS: ReadonlySet<string> = new Set(["score", "volatility", "stability", "silhouette", "distance", "zScore", "correlation", "slope"]);

/**
 * The semantic class of one metric (one row of a metrics-in-rows table),
 * decided from its label first and its number formats second — the same order
 * `classifySemanticMetricClass` documents, so "доля ликвидных активов в
 * активах" is a share before any format is inspected.
 */
export function metricSemanticClass(schema: TableSchema, grids: AnalysisGrids, metricKey: string): SemanticMetricClass {
  const member = schema.rowAxis.find((m) => m.display === metricKey || m.labels.includes(metricKey));
  if (!member) return classifySemanticMetricClass(metricKey);
  const formats = grids.numberFormats[member.rowIndex] ?? [];
  const numeric = formats.filter((f) => typeof f === "string" && f.trim() !== "");
  const percentFormatted = numeric.length > 0 && numeric.filter((f) => isPercentNumberFormat(f)).length / numeric.length >= 0.6;
  return classifySemanticMetricClass(member.display, { percentFormatted });
}

/**
 * Is a metric's own SCALE already percent units rather than a 0..1 fraction?
 *
 * Excel stores a percent-FORMATTED cell as a fraction (28.63% is the double
 * 0.2863), so a percent number format means fraction-scaled. A percentage
 * typed as a plain number ("30,6" under a header that says %) is percent-
 * scaled. Deciding this from the format — the only place the truth lives —
 * keeps the rule general instead of guessing from magnitude.
 */
function percentIsFractionScaled(schema: TableSchema, grids: AnalysisGrids, metricKey: string): boolean {
  const member = schema.rowAxis.find((m) => m.display === metricKey || m.labels.includes(metricKey));
  if (!member) return true;
  const formats = (grids.numberFormats[member.rowIndex] ?? []).filter((f): f is string => typeof f === "string" && f.trim() !== "");
  if (formats.length === 0) return false;
  return formats.filter((f) => isPercentNumberFormat(f)).length / formats.length >= 0.6;
}

export interface UnitContext {
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
}

/**
 * §52/§53 — the display unit of `field` for `metricKey`.
 *
 * The two inputs are both necessary. A field name alone cannot decide:
 * `absoluteChange` is an amount for "Активы" and a percentage-POINT move for
 * "доля ликвидных активов". A metric alone cannot decide either: the same
 * share metric has a percentage level and a percentage-point delta in
 * neighbouring columns of one result row.
 */
export function displayUnit(ctx: UnitContext | null, field: string, metricKey: string | null): DisplayUnit {
  if (COUNT_FIELDS.has(field)) return { kind: "count" };
  if (SCORE_FIELDS.has(field)) return { kind: "score" };
  // A relative change is a fraction by construction (`comparePoints` divides
  // by the start value), whatever the metric's own unit is. This holds even
  // for a percentage metric: brak 4.2% → 3.1% is -26.19% RELATIVE, and that
  // is a different statement from -1.1 п.п.
  if (PERCENT_CHANGE_FIELDS.has(field)) return { kind: "percent_fraction" };

  const cls = ctx && metricKey ? metricSemanticClass(ctx.schema, ctx.grids, metricKey) : "unknown";
  const fractionScaled = ctx && metricKey ? percentIsFractionScaled(ctx.schema, ctx.grids, metricKey) : true;

  if (ABSOLUTE_CHANGE_FIELDS.has(field)) {
    // §53 — the difference between two percentages is percentage POINTS.
    if (isPercentageLike(cls)) return { kind: "percent_point_delta", scaled: !fractionScaled };
    if (cls === "count") return { kind: "count" };
    if (cls === "index") return { kind: "score" };
    return { kind: "amount" };
  }
  if (LEVEL_FIELDS.has(field)) {
    if (isPercentageLike(cls)) return fractionScaled ? { kind: "percent_fraction" } : { kind: "percent_scaled" };
    if (cls === "count") return { kind: "count" };
    if (cls === "ratio") return { kind: "ratio" };
    if (cls === "index") return { kind: "score" };
    if (cls === "amount") return { kind: "amount" };
    return { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/**
 * §53 — the relative change implied by a percentage-point move, when it can be
 * stated at all. 27.82% → 28.63% is +0.80 п.п. AND +2.89%; the second is only
 * derivable because both endpoint levels are known and the start is non-zero.
 * Returns a FRACTION, or null when the start is ~0 and the relative form is
 * undefined — the same rule `comparePoints` applies, for the same reason.
 */
export function relativeChangeOf(startLevel: number, endLevel: number): number | null {
  if (!Number.isFinite(startLevel) || !Number.isFinite(endLevel)) return null;
  if (Math.abs(startLevel) < 1e-12) return null;
  return (endLevel - startLevel) / Math.abs(startLevel);
}

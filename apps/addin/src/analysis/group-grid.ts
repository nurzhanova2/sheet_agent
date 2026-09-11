// ---------------------------------------------------------------------------
// Stage 24.3.2 — canonical grid for a grouped analytical result.
//
// A `group_by` engine outcome carries `groups` (key + metric map), NOT a
// `columns`/`rows` grid. The conversational runtime persists the USER-VISIBLE
// table as the canonical `ResultRef`, so a follow-up ("show the top 2 by Fact")
// transforms THAT table — never the raw worksheet rows. This module rebuilds
// the exact displayed grid from a `group_by` outcome + its request, using the
// SAME metric-key rule as the engine (`analysis/engine.ts::groupBy`).
// ---------------------------------------------------------------------------

import type { AnalysisOutcome, AnalysisRequest, CellPrimitive, Expression, GroupMetric } from "./types.js";
import { isAnalysisError } from "./types.js";

const AGG_LABEL: Readonly<Record<string, string>> = {
  count: "Count",
  sum: "Sum",
  mean: "Mean",
  min: "Min",
  max: "Max",
  median: "Median",
};

/** The single column an expression is ultimately about, when it is one. */
function expressionColumn(expr: Expression | undefined): string | null {
  if (!expr || typeof expr !== "object") return null;
  if (expr.kind === "column") return expr.name;
  if (expr.kind === "abs" || expr.kind === "neg") return expressionColumn(expr.value);
  return null;
}

/** The key the engine stores this metric's value under (mirror of engine.ts). */
function metricKey(metric: GroupMetric, position: number): string {
  return metric.name ?? `${metric.metric}${position === 0 ? "" : `_${position}`}`;
}

/** The human column header the deterministic report shows for this metric. */
export function groupMetricLabel(metric: GroupMetric): string {
  const column = expressionColumn(metric.target);
  if (metric.metric === "count") return metric.name ?? (column ? `Count ${column}` : "Count");
  const agg = AGG_LABEL[metric.metric] ?? metric.metric;
  if (column) return `${agg} ${column}`;
  return metric.name ?? agg;
}

export interface GroupGrid {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellPrimitive[])[];
  readonly truncated: boolean;
}

/**
 * Rebuilds the displayed grouped table from a `group_by` outcome. Returns null
 * for any other outcome shape (the caller then keeps its existing behaviour).
 */
export function gridFromGroupOutcome(outcome: AnalysisOutcome, request: unknown): GroupGrid | null {
  if (isAnalysisError(outcome)) return null;
  if (outcome.op !== "group_by" || !outcome.groups || outcome.groups.length === 0) return null;
  if (!request || typeof request !== "object") return null;
  const req = request as Partial<Extract<AnalysisRequest, { op: "group_by" }>>;
  const metrics = Array.isArray(req.metrics) ? (req.metrics as readonly GroupMetric[]) : [];
  if (metrics.length === 0) return null;

  const dims =
    (outcome.parameters?.["dimensions"] as readonly string[] | undefined) ??
    (Array.isArray(req.by) ? (req.by as readonly string[]) : []);
  if (dims.length === 0) return null;

  const keys = metrics.map((metric, index) => metricKey(metric, index));
  const columns = [...dims, ...metrics.map((metric) => groupMetricLabel(metric))];
  const rows: CellPrimitive[][] = outcome.groups.map((group) => [
    ...dims.map((dim) => (group.key[dim] ?? "") as CellPrimitive),
    ...keys.map((key) => {
      const value = group.metrics[key];
      return value === undefined ? null : value;
    }),
  ]);

  return { columns, rows, truncated: outcome.truncated };
}

/**
 * Reorders a grid's columns (and every row's cells) to match `preferredOrder`.
 * `canonicalizeAnalysisRequest` sorts `group_by` metrics alphabetically, so the
 * grid synthesised from the engine outcome can differ from the user-visible
 * column order (which follows the request / prompt). Columns not named in
 * `preferredOrder` keep their relative position, appended after the ordered
 * ones. A no-op when `preferredOrder` does not line up with the grid.
 */
export function reorderGroupGrid(
  columns: readonly string[],
  rows: readonly (readonly CellPrimitive[])[],
  preferredOrder: readonly string[],
): { readonly columns: readonly string[]; readonly rows: readonly (readonly CellPrimitive[])[] } {
  if (preferredOrder.length === 0) return { columns, rows };
  const remaining = columns.map((_, i) => i);
  const orderedIdx: number[] = [];
  for (const wanted of preferredOrder) {
    const at = remaining.findIndex((i) => columns[i] === wanted);
    if (at >= 0) orderedIdx.push(remaining.splice(at, 1)[0]!);
  }
  if (orderedIdx.length === 0) return { columns, rows };
  const finalIdx = [...orderedIdx, ...remaining];
  return {
    columns: finalIdx.map((i) => columns[i]!),
    rows: rows.map((row) => finalIdx.map((i) => row[i] ?? null)),
  };
}

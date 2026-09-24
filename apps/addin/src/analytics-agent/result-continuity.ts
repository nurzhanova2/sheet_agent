import type { CellValue } from "@sheet-agent/application";
import type { AgentObservation } from "../agent/types.js";

/**
 * §3 — tools whose output IS an analytical result over a metric universe
 * (as opposed to schema plumbing: metric.list, period.list/select, or an
 * echo of memory via reference.previous_*). A run's continuation universe is
 * always one of these observations, at the FULL cardinality the tool itself
 * produced.
 */
export const CONTINUATION_RESULT_TOOLS: ReadonlySet<string> = new Set([
  "change.compare_periods",
  "change.compute",
  "set.filter",
  "set.sort",
  "set.top",
  "set.bottom",
  "set.argmax",
  "set.argmin",
  "set.merge",
  "derive.compute",
  "analysis.volatility",
  "analysis.stability",
  "analysis.trend",
  "analysis.monotonicity",
  "analysis.direction_changes",
  "analysis.temporal_pattern",
  "event.adjacent_changes",
  "event.max_adjacent_change",
  "event.min_adjacent_change",
  "aggregate.max",
  "aggregate.min",
  "aggregate.avg",
]);

export interface ContinuationResult {
  readonly observation: AgentObservation;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
  /** The metric universe in result order — the "из них" candidate set. */
  readonly metricKeys: readonly string[];
}

function usable(o: AgentObservation): boolean {
  return (
    o.ok &&
    o.kind === "table" &&
    Boolean(o.columns) &&
    o.columns!.includes("metric") &&
    Boolean(o.rows) &&
    o.rows!.length > 0 &&
    CONTINUATION_RESULT_TOOLS.has(o.tool)
  );
}

/**
 * §3/§6 — the run's continuation universe: the LAST analytical result the
 * plan actually computed, taken whole.
 *
 * "Last" (not "widest") because a follow-up chain deliberately RESTRICTS the
 * universe step by step — after `compare(19) → filter(11)`, "из них" must
 * mean the 11, never the 19 again (this is the same no-widening rule Stage
 * 25.1.3b/e already enforce for ranking). "Whole" (not the visible primary)
 * because the display may legitimately show one row of it (§6).
 *
 * `null` when the turn produced no analytical result of its own — a turn that
 * only echoed memory or only read schema must never OVERWRITE the universe an
 * earlier successful turn established.
 */
export function determineContinuationResult(observations: readonly AgentObservation[]): ContinuationResult | null {
  const obs = [...observations].reverse().find(usable);
  if (!obs) return null;
  const columns = obs.columns!;
  const rows = obs.rows! as readonly (readonly CellValue[])[];
  const mCol = columns.indexOf("metric");
  const metricKeys = [...new Set(rows.map((r) => String(r[mCol] ?? "")))].filter(Boolean);
  if (metricKeys.length === 0) return null;
  return { observation: obs, columns, rows, metricKeys };
}

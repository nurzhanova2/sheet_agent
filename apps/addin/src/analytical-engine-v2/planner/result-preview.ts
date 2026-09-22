// ---------------------------------------------------------------------------
// Stage 26.2 §10/§11/§45 — what the PLANNER sees of a result.
//
// The full result always stays in the ResultStore. The planner gets its
// identity, its type, its shape and a bounded sample — enough to choose the
// next tool, deliberately not enough to pick a winner by eye (§23). Past the
// preview threshold it is shown the extremes of the ranking-relevant column
// too, so it can tell that a set is worth narrowing without being handed the
// answer.
//
// This also satisfies §45: a large worksheet never lands in a prompt or a log.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import { PLANNER_PREVIEW_ROWS, type EngineResult } from "../types.js";

function cellText(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return String(v);
}

/**
 * One result, rendered for the planner. Small results are shown in full;
 * larger ones are summarised with a head sample and an explicit instruction
 * that the rest exists and must be reached with a tool.
 */
export function renderResultForPlanner(r: EngineResult): string {
  const lines = [`${r.resultId} = ${r.tool} → ${r.type}, ${r.rows.length} row(s)`];
  lines.push(`  fields: ${r.fields.map((f) => `${f.name}:${f.kind}`).join(" | ")}`);
  if (r.periodCanonicals.length > 0) lines.push(`  periods: ${r.periodCanonicals.join(" .. ")}`);
  if (r.parents.length > 0) lines.push(`  derived from: ${r.parents.join(", ")}`);

  const meta = Object.entries(r.metadata).filter(([, v]) => v !== undefined);
  if (meta.length > 0) lines.push(`  metadata: ${meta.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`);

  const full = r.rows.length <= PLANNER_PREVIEW_ROWS;
  const shown = full ? r.rows : r.rows.slice(0, PLANNER_PREVIEW_ROWS);
  for (const row of shown) lines.push(`  | ${row.map(cellText).join(" | ")} |`);
  if (!full) {
    lines.push(`  … ${r.rows.length - shown.length} more row(s) NOT shown — this is a sample, not the whole result.`);
    lines.push(`  To work with all ${r.rows.length} rows use a tool on ${r.resultId} (set.filter / set.top / set.argmax / an aggregate). Do not draw conclusions from the sample.`);
  }
  return lines.join("\n");
}

export function renderResultsForPlanner(results: readonly EngineResult[]): string {
  return results.length > 0 ? results.map(renderResultForPlanner).join("\n\n") : "(none yet)";
}

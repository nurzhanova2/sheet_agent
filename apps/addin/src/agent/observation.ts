// ---------------------------------------------------------------------------
// Stage 24.4 — bounding a structured observation before it reaches the model.
//
// A tool may compute a large grid; the model must never see more than the
// per-observation caps in `AgentBounds`. Clamping preserves the true matched
// count (`rowCount`) while trimming the sample rows and marking `truncated`.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import type { AgentBounds } from "./bounds.js";
import type { AgentObservation } from "./types.js";

export function observationCellCount(obs: Pick<AgentObservation, "rows" | "columns">): number {
  if (!obs.rows) return 0;
  const cols = obs.columns?.length ?? obs.rows.reduce((max, row) => Math.max(max, row.length), 0);
  return obs.rows.length * Math.max(1, cols);
}

/** Trims an observation's grid to the per-observation bounds. Pure. */
export function clampObservation(obs: AgentObservation, bounds: AgentBounds): AgentObservation {
  if (!obs.rows || obs.rows.length === 0) return obs;

  const originalRowCount = obs.rowCount ?? obs.rows.length;
  const originalColumns = obs.columns ?? [];

  const columnCap = Math.min(
    bounds.maxColumnsPerObservation,
    originalColumns.length > 0 ? originalColumns.length : Number.MAX_SAFE_INTEGER,
  );
  const rowsByCells = Math.max(1, Math.floor(bounds.maxObservationCells / Math.max(1, columnCap)));
  const rowCap = Math.min(bounds.maxRowsPerObservation, rowsByCells);

  const clampCols = originalColumns.length > 0 && originalColumns.length > columnCap;
  const clampRows = obs.rows.length > rowCap;
  if (!clampCols && !clampRows) {
    return obs.rowCount === undefined ? { ...obs, rowCount: originalRowCount } : obs;
  }

  const columns = clampCols ? originalColumns.slice(0, columnCap) : originalColumns;
  const rows: readonly (readonly CellValue[])[] = obs.rows
    .slice(0, rowCap)
    .map((row) => (clampCols ? row.slice(0, columnCap) : row));

  return {
    ...obs,
    ...(columns.length > 0 ? { columns } : {}),
    rows,
    rowCount: originalRowCount,
    truncated: true,
  };
}

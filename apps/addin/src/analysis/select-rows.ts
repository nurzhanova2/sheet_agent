// ---------------------------------------------------------------------------
// Deterministic row selection for a single condition. This is the shared,
// engine-backed primitive behind `/highlight` and `/filter`: the SAME matched
// row set drives the displayed count, the preview and the workbook mutation —
// no model, no second computation. (Stage 22 mutation-correctness fix.)
// ---------------------------------------------------------------------------

import type { SelectionSnapshot } from "../app/workbook-context.js";
import { buildDataset } from "./dataset.js";
import { runAnalysis } from "./engine.js";
import { matchingRowIndexes } from "./expression.js";
import { isAnalysisError, type ConditionInput } from "./types.js";

export interface MatchedRows {
  /** Number of data rows evaluated. */
  readonly evaluated: number;
  /** 0-based indexes into the data rows (header excluded). */
  readonly indexes: readonly number[];
  /** 1-based absolute sheet row numbers, one per matched row. */
  readonly sheetRows: readonly number[];
  /** Set when the selection could not be read or the condition could not be evaluated. */
  readonly error?: string;
}

/**
 * Evaluates one condition against the selection and returns every matching row.
 * Never throws — an unreadable selection or an unresolvable column comes back as
 * `{ error, indexes: [], sheetRows: [] }`.
 */
export function selectMatchingRows(snapshot: SelectionSnapshot, where: ConditionInput): MatchedRows {
  const dataset = buildDataset(snapshot);
  if ("error" in dataset) {
    return { evaluated: 0, indexes: [], sheetRows: [], error: dataset.error };
  }
  try {
    const indexes = matchingRowIndexes(dataset, where);
    return {
      evaluated: dataset.rowCount,
      indexes,
      sheetRows: indexes.map((index) => dataset.firstDataSheetRow + index),
    };
  } catch (error) {
    return {
      evaluated: dataset.rowCount,
      indexes: [],
      sheetRows: [],
      error: error instanceof Error ? error.message : "the condition could not be evaluated",
    };
  }
}

export interface SortedPreview {
  readonly columns: readonly string[];
  /** Display cells for the first `limit` rows, in sorted order. */
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
  /** 1-based sheet row number for each preview row. */
  readonly sheetRows: readonly number[];
  readonly totalRows: number;
  readonly error?: string;
}

/**
 * Deterministic single-column sorted preview. The workbook is NOT touched — this
 * returns the first `limit` rows of the engine's `sort` result so the user can
 * verify the ordering (`/sort`, compute-and-preview only).
 */
export function sortedPreview(
  snapshot: SelectionSnapshot,
  column: string,
  direction: "asc" | "desc",
  limit = 10,
): SortedPreview {
  const dataset = buildDataset(snapshot);
  if ("error" in dataset) return { columns: [], rows: [], sheetRows: [], totalRows: 0, error: dataset.error };
  const outcome = runAnalysis(dataset, {
    op: "sort",
    by: { kind: "column", name: column },
    direction,
    limit,
  });
  if (isAnalysisError(outcome)) {
    return { columns: [], rows: [], sheetRows: [], totalRows: 0, error: outcome.error };
  }
  return {
    columns: outcome.columns ?? [],
    rows: outcome.rows ?? [],
    sheetRows: outcome.sourceRows ?? [],
    totalRows: outcome.rowsMatched ?? dataset.rowCount,
  };
}

/** Collapses a list of 1-based sheet rows (deduped, sorted) into contiguous [start, end] runs. */
export function contiguousRuns(sheetRows: readonly number[]): readonly (readonly [number, number])[] {
  const sorted = [...new Set(sheetRows)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const row of sorted) {
    const last = runs[runs.length - 1];
    if (last && row === last[1] + 1) last[1] = row;
    else runs.push([row, row]);
  }
  return runs;
}

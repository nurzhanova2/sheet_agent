import type { CellValue } from "@sheet-agent/application";
import type { ResultRef, RowSetRef } from "./session-memory.js";
import { columnIndexToLetters, parseLocalRange, splitSheetAddress } from "./a1.js";
import {
  MAX_ACTION_CELLS,
  MAX_FILL_CELLS,
  validateAction,
  type HighlightAction,
  type SetValuesAction,
  type WorkbookAction,
} from "./workbook-actions.js";
import { contiguousRuns } from "../analysis/select-rows.js";

export const RESULT_HIGHLIGHT_COLOR = "#FFF2CC";
const MAX_HIGHLIGHT_RUNS = 200;

// ---------------------------------------------------------------------------
// Stage 24.5.1 — the ONE coordinate contract for a RowSetRef → highlight:
//   • `RowSetRef.sheetRows`  : 1-based ABSOLUTE worksheet row numbers, already
//     header-excluded and de-duplicated (see `groundEntitiesToRows` /
//     `selectMatchingRows`). This is the single canonical representation.
//   • the source range's own column span (`RowSetRef.sourceRange`) gives the
//     left/right columns each highlighted band spans — never the whole sheet.
//   • a contiguous band whose cell count (`width × rows`) would exceed
//     `MAX_FILL_CELLS` is SPLIT into consecutive sub-bands, each individually
//     valid — a large non-contiguous selection is never rejected wholesale.
// ---------------------------------------------------------------------------

/** Splits `[start,end]` worksheet-row runs so each band has ≤ `maxRows` rows. */
function chunkRuns(
  runs: readonly (readonly [number, number])[],
  maxRows: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (const [start, end] of runs) {
    for (let r = start; r <= end; r += maxRows) {
      out.push([r, Math.min(end, r + maxRows - 1)]);
    }
  }
  return out;
}

export interface WriteResultOutcome {
  readonly action: SetValuesAction;
  readonly destRange: string;
  readonly rowsWritten: number;
  readonly colsWritten: number;
  readonly overwriteCells: number;
  readonly truncated: boolean;
}
export interface CompileError {
  readonly error: string;
  /** Stage 24.5.2 §8 — per-band rejection detail for the runtime trace (highlight only). */
  readonly rejected?: readonly { readonly address: string; readonly cells: number; readonly reason: string }[];
}
export function isCompileError<T extends object>(v: T | CompileError): v is CompileError {
  return "error" in v && typeof (v as CompileError).error === "string";
}

/** End A1 address of a rectangle anchored at `anchor` spanning `rows`×`cols`. */
function rectRange(anchor: string, rows: number, cols: number): string {
  const start = parseLocalRange(anchor).start;
  const endCol = columnIndexToLetters(start.column + cols - 1);
  const endRow = start.row + rows;
  const startCol = columnIndexToLetters(start.column);
  return `${startCol}${start.row + 1}:${endCol}${endRow}`;
}

function clampGrid(
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
): { grid: (readonly CellValue[])[]; truncated: boolean } {
  const cols = columns.length;
  const maxDataRows = Math.max(1, Math.floor(MAX_ACTION_CELLS / Math.max(1, cols)) - 1);
  const kept = rows.slice(0, maxDataRows);
  const grid: (readonly CellValue[])[] = [columns.slice(), ...kept.map((r) => columns.map((_, c) => r[c] ?? null))];
  return { grid, truncated: kept.length < rows.length };
}

/**
 * `buildWriteResultProposal(resultRef, target)` — the ResultRef grid (header row
 * + data rows) becomes ONE `set_values` at `sheetName!<anchor>:<end>`.
 * `existing` (a read of the destination rectangle) is used only to count cells
 * that would be overwritten — it never changes what is written.
 */
export function buildWriteResultActions(
  ref: ResultRef,
  target: { readonly sheetName: string; readonly anchor?: string },
  existing?: readonly (readonly CellValue[])[],
): WriteResultOutcome | CompileError {
  if (ref.columns.length === 0) return { error: "that result has no columns to write" };
  const anchor = (target.anchor ?? "A1").replace(/\$/g, "").trim();
  try {
    parseLocalRange(anchor);
  } catch {
    return { error: `"${anchor}" is not a valid cell reference` };
  }
  const { grid, truncated } = clampGrid(ref.columns, ref.rows);
  const rows = grid.length;
  const cols = ref.columns.length;
  const destRange = rectRange(anchor, rows, cols);

  let overwriteCells = 0;
  if (existing && existing.length > 0) {
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const v = existing[r]?.[c];
        if (v !== null && v !== undefined && v !== "") overwriteCells += 1;
      }
    }
  }

  const candidate = {
    type: "set_values" as const,
    sheetName: target.sheetName,
    range: destRange,
    description: `Write "${ref.title}" (${rows}×${cols}) to ${target.sheetName}!${destRange}`,
    payload: { values: grid },
  };
  const validated = validateAction(candidate, 0);
  if (typeof validated === "string") return { error: validated };
  if (validated.type !== "set_values") return { error: "internal: unexpected action type" };
  return { action: validated, destRange, rowsWritten: rows, colsWritten: cols, overwriteCells, truncated };
}

/** Stage 24.5.2 §8 — why one candidate band could not be validated. */
export interface RejectedBand {
  readonly address: string;
  readonly cells: number;
  readonly reason: string;
}

export interface HighlightRowSetOutcome {
  readonly actions: readonly HighlightAction[];
  readonly runCount: number;
  readonly rowCount: number;
  readonly truncatedRuns: boolean;
  /** Stage 24.5.2 §8 — bands that were dropped (empty when all bands validated). */
  readonly rejected: readonly RejectedBand[];
  /** The resolved sheet name (surrounding quotes stripped) the actions target. */
  readonly sheet: string;
  /** Column span of the source range each band covers. */
  readonly width: number;
}

/**
 * `RowSetRef → highlight_range` proposal — exact rows, coalesced into contiguous
 * runs then split so no band exceeds `MAX_FILL_CELLS` (Stage 24.5.1). `color`
 * (Stage 24.5 §11) is an application-approved hex fill; it defaults to
 * {@link RESULT_HIGHLIGHT_COLOR} when omitted.
 *
 * Coordinate contract (Stage 24.5.2): `rowSet.sheetRows` are 1-based ABSOLUTE
 * worksheet rows; `rowSet.sourceRange` may be sheet-qualified and the sheet name
 * may be quoted (`'Sales Test Data'!A1:L121`) — `splitSheetAddress` strips the
 * quotes, so the emitted `sheetName` is the bare worksheet name and `range` is a
 * bare local A1 band. Rejection reasons for every dropped band are returned in
 * `rejected` for the runtime trace; the user message stays simple.
 */
export function buildHighlightRowSetActions(
  rowSet: RowSetRef,
  color: string = RESULT_HIGHLIGHT_COLOR,
): HighlightRowSetOutcome | CompileError {
  if (rowSet.sheetRows.length === 0) return { error: "that row set is empty" };
  const { sheetName, localAddress } = splitSheetAddress(rowSet.sourceRange);
  const sheet = (sheetName || rowSet.sourceSheet || "").replace(/^'|'$/g, "").replaceAll("''", "'");
  let firstCol: string;
  let lastCol: string;
  let width: number;
  try {
    const range = parseLocalRange(localAddress || rowSet.sourceRange);
    firstCol = columnIndexToLetters(range.start.column);
    lastCol = columnIndexToLetters(range.end.column);
    width = range.end.column - range.start.column + 1;
  } catch {
    return { error: "the source range of that row set could not be read" };
  }
  // Split any band that would exceed the fill-cell limit so a large
  // non-contiguous selection is never rejected wholesale.
  const maxRowsPerBand = Math.max(1, Math.floor(MAX_FILL_CELLS / Math.max(1, width)));
  const runs = chunkRuns(contiguousRuns(rowSet.sheetRows), maxRowsPerBand);
  const capped = runs.slice(0, MAX_HIGHLIGHT_RUNS);
  const description = `Fill ${rowSet.count} row(s) where ${rowSet.describe}`;
  const actions: HighlightAction[] = [];
  const rejected: RejectedBand[] = [];
  capped.forEach((run, index) => {
    const rangeStr = run[0] === run[1] ? `${firstCol}${run[0]}:${lastCol}${run[0]}` : `${firstCol}${run[0]}:${lastCol}${run[1]}`;
    const candidate = { type: "highlight_range" as const, sheetName: sheet, range: rangeStr, description, payload: { color } };
    const validated = validateAction(candidate, index);
    if (typeof validated !== "string" && validated.type === "highlight_range") actions.push(validated);
    else {
      rejected.push({
        address: rangeStr,
        cells: (run[1] - run[0] + 1) * width,
        reason: typeof validated === "string" ? validated : `unexpected action type "${validated.type}"`,
      });
    }
  });
  if (actions.length === 0) {
    return { error: "no valid highlight ranges could be built for those rows", rejected };
  }
  return {
    actions,
    runCount: actions.length,
    rowCount: rowSet.count,
    truncatedRuns: runs.length > capped.length,
    rejected,
    sheet,
    width,
  };
}

export interface CopyRowSetOutcome {
  readonly action: SetValuesAction;
  readonly destRange: string;
  readonly rowsWritten: number;
  readonly colsWritten: number;
  readonly overwriteCells: number;
  readonly truncated: boolean;
}

/**
 * `RowSetRef → copy` proposal — a compact table (one header row + the retained
 * row values) written at `sheetName!<anchor>`. Requires the row set to carry
 * retained `columns` + `rows`; otherwise the caller must recompute first.
 */
export function buildCopyRowSetActions(
  rowSet: RowSetRef,
  target: { readonly sheetName: string; readonly anchor?: string },
  existing?: readonly (readonly CellValue[])[],
): CopyRowSetOutcome | CompileError {
  if (!rowSet.columns || rowSet.columns.length === 0 || !rowSet.rows) {
    return { error: "the row values for that set were not retained — re-run the analysis before copying" };
  }
  const pseudo: ResultRef = {
    id: rowSet.id,
    turnId: rowSet.turnId,
    order: rowSet.order,
    createdAt: rowSet.createdAt,
    kind: "filtered_rows",
    sourceSheet: rowSet.sourceSheet,
    sourceRange: rowSet.sourceRange,
    sourceVersion: rowSet.sourceVersion,
    title: rowSet.describe || "selected rows",
    spec: rowSet.conditionSpec ?? null,
    columns: rowSet.columns,
    rows: rowSet.rows,
    rowsTruncated: rowSet.truncated,
    facts: [],
    resolved: [],
  };
  const written = buildWriteResultActions(pseudo, target, existing);
  if (isCompileError(written)) return written;
  return {
    action: written.action,
    destRange: written.destRange,
    rowsWritten: written.rowsWritten,
    colsWritten: written.colsWritten,
    overwriteCells: written.overwriteCells,
    truncated: written.truncated,
  };
}

export type { WorkbookAction };

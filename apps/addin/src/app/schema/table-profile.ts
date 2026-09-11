// ---------------------------------------------------------------------------
// Stage 24.6 — deterministic structural profiling of a bounded rectangular range.
//
// No workbook dump: only densities, uniqueness ratios and blank-run patterns.
// Everything is bounded by MAX_SCHEMA_ROWS / MAX_SCHEMA_COLS / MAX_PROFILE_CELLS.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import { classifyCell, isNumericType, type CellType } from "./cell-typing.js";
import { isPercentNumberFormat } from "./excel-date.js";

export const SCHEMA_LIMITS = {
  maxRows: 400,
  maxCols: 60,
  maxProfileCells: 20_000,
  maxHeaderDepth: 5,
  maxAxisMembers: 500,
  maxAnalysisSeries: 120,
} as const;

export interface CellFacts {
  readonly type: CellType;
  readonly numeric: boolean;
  readonly blank: boolean;
  readonly text: boolean;
  readonly dateLike: boolean;
  readonly percent: boolean;
  readonly fromFormula: boolean;
}

export interface LineFeatures {
  readonly index: number;
  readonly textDensity: number;
  readonly numericDensity: number;
  readonly blankDensity: number;
  readonly dateDensity: number;
  readonly percentDensity: number;
  readonly formulaDensity: number;
  /** distinct non-blank values / non-blank count. */
  readonly uniqueness: number;
  readonly nonBlank: number;
}

export interface TableProfile {
  readonly rows: number;
  readonly cols: number;
  readonly truncated: boolean;
  /** cellFacts[r][c] within the profiled window. */
  readonly cellFacts: readonly (readonly CellFacts[])[];
  readonly rowFeatures: readonly LineFeatures[];
  readonly colFeatures: readonly LineFeatures[];
  /** For each row, the count of leading blank continuation cells after the first non-blank. */
  readonly rowBlankRuns: readonly number[];
  /** Rows that are entirely blank (structural separators). */
  readonly blankRowIndexes: readonly number[];
}

function lineFeatures(index: number, cells: readonly CellFacts[]): LineFeatures {
  const total = cells.length || 1;
  let text = 0;
  let numeric = 0;
  let blank = 0;
  let date = 0;
  let percent = 0;
  let formula = 0;
  for (const c of cells) {
    if (c.blank) blank += 1;
    else if (c.numeric) numeric += 1;
    else if (c.text) text += 1;
    if (c.dateLike) date += 1;
    if (c.percent) percent += 1;
    if (c.fromFormula) formula += 1;
  }
  return {
    index,
    textDensity: text / total,
    numericDensity: numeric / total,
    blankDensity: blank / total,
    dateDensity: date / total,
    percentDensity: percent / total,
    formulaDensity: formula / total,
    uniqueness: 0, // filled below (needs raw values)
    nonBlank: total - blank,
  };
}

/** Builds the bounded profile. `values` / `numberFormats` / `formulas` are the
 *  raw snapshot arrays (already clamped by the caller if huge). */
export function profileTable(
  values: readonly (readonly CellValue[])[],
  numberFormats: readonly (readonly string[])[],
  formulas: readonly (readonly (string | CellValue | null)[])[] = [],
): TableProfile {
  const rawRows = values.length;
  const rawCols = values.reduce((m, r) => Math.max(m, r.length), 0);
  const rows = Math.min(rawRows, SCHEMA_LIMITS.maxRows);
  const cols = Math.min(rawCols, SCHEMA_LIMITS.maxCols);
  const truncated = rows < rawRows || cols < rawCols || rows * cols > SCHEMA_LIMITS.maxProfileCells;
  const effRows = Math.min(rows, Math.max(1, Math.floor(SCHEMA_LIMITS.maxProfileCells / Math.max(1, cols))));

  const cellFacts: CellFacts[][] = [];
  for (let r = 0; r < effRows; r += 1) {
    const row: CellFacts[] = [];
    for (let c = 0; c < cols; c += 1) {
      const raw = values[r]?.[c] ?? null;
      const fmt = numberFormats[r]?.[c] ?? null;
      const fx = (formulas[r]?.[c] ?? null) as string | null;
      const tc = classifyCell(raw, fmt, typeof fx === "string" ? fx : null);
      row.push({
        type: tc.type,
        numeric: isNumericType(tc.type),
        blank: tc.type === "blank",
        text: tc.type === "text" || tc.type === "boolean",
        dateLike: tc.type === "date" || tc.type === "datetime",
        percent: tc.type === "percentage" || isPercentNumberFormat(fmt),
        fromFormula: tc.fromFormula,
      });
    }
    cellFacts.push(row);
  }

  const rowFeatures = cellFacts.map((cells, r) => {
    const f = lineFeatures(r, cells);
    const seen = new Set<string>();
    let nb = 0;
    for (let c = 0; c < cols; c += 1) {
      const v = values[r]?.[c];
      if (v === null || v === undefined || v === "") continue;
      nb += 1;
      seen.add(String(v).trim().toLowerCase());
    }
    return { ...f, uniqueness: nb > 0 ? seen.size / nb : 0, nonBlank: nb };
  });

  const colFeatures: LineFeatures[] = [];
  for (let c = 0; c < cols; c += 1) {
    const col: CellFacts[] = [];
    const seen = new Set<string>();
    let nb = 0;
    for (let r = 0; r < effRows; r += 1) {
      col.push(cellFacts[r]![c]!);
      const v = values[r]?.[c];
      if (v === null || v === undefined || v === "") continue;
      nb += 1;
      seen.add(String(v).trim().toLowerCase());
    }
    const f = lineFeatures(c, col);
    colFeatures.push({ ...f, uniqueness: nb > 0 ? seen.size / nb : 0, nonBlank: nb });
  }

  const rowBlankRuns: number[] = [];
  const blankRowIndexes: number[] = [];
  for (let r = 0; r < effRows; r += 1) {
    const rowCells = cellFacts[r]!;
    if (rowCells.every((c) => c.blank)) blankRowIndexes.push(r);
    let firstNonBlank = -1;
    for (let c = 0; c < cols; c += 1) {
      if (!rowCells[c]!.blank) {
        firstNonBlank = c;
        break;
      }
    }
    let run = 0;
    if (firstNonBlank >= 0) {
      for (let c = firstNonBlank + 1; c < cols; c += 1) {
        if (rowCells[c]!.blank) run += 1;
        else break;
      }
    }
    rowBlankRuns.push(run);
  }

  return { rows: effRows, cols, truncated, cellFacts, rowFeatures, colFeatures, rowBlankRuns, blankRowIndexes };
}

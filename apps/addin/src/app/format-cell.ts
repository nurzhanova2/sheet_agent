// ---------------------------------------------------------------------------
// Stage 24.4.4 §14 — one shared deterministic DISPLAY formatter.
//
// ResultRef rows keep exact values (claim validation always uses them). This
// only changes what the user sees in a rendered grid / fallback table: a raw
// float like 222.94594594594594 becomes 222.95, 0.045949999999 becomes 0.04595.
// No `toFixed` scattered elsewhere.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";

/** A user-facing string for one cell. Integers pass through; long floats are trimmed to ~6 significant figures. */
export function formatDisplayCell(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    if (Number.isInteger(value)) return String(value);
    const abs = Math.abs(value);
    // very small magnitudes: keep enough precision to be meaningful
    const trimmed = abs !== 0 && abs < 1 ? Number(value.toPrecision(4)) : Number(value.toPrecision(6));
    return String(trimmed);
  }
  return String(value);
}

/** Formats a whole grid row for display. */
export function formatDisplayRow(row: readonly CellValue[]): string[] {
  return row.map(formatDisplayCell);
}

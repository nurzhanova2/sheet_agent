// ---------------------------------------------------------------------------
// Stage 24.6 — deterministic per-cell typing.
//
// `raw` (workbook value), `typed` (a normalized JS value) and `display` (a
// user-facing string) are kept separate. Number-format evidence drives
// date/percent/currency classification; a bare number stays a number.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import {
  coerceHeaderDate,
  excelSerialToDate,
  formatDateLabel,
  isCurrencyNumberFormat,
  isDateNumberFormat,
  isPercentNumberFormat,
  type DateSystem,
} from "./excel-date.js";

export type CellType =
  | "text"
  | "number"
  | "integer"
  | "percentage"
  | "currency"
  | "date"
  | "datetime"
  | "boolean"
  | "error"
  | "blank"
  | "formula-result"
  | "unknown";

export interface TypedCell {
  readonly type: CellType;
  readonly raw: CellValue;
  /** number for numeric kinds, ISO string for dates, string/boolean otherwise, null for blank. */
  readonly typed: number | string | boolean | null;
  readonly display: string;
  /** true when the source cell carried a real formula. */
  readonly fromFormula: boolean;
}

const ERROR_RE = /^#(?:REF|DIV\/0|VALUE|NAME\?|NULL|NUM|N\/A|SPILL|CALC|GETTING_DATA)!?$/i;

export function classifyCell(
  raw: CellValue,
  numberFormat: string | null | undefined,
  formula: string | null | undefined = null,
  system: DateSystem = "1900",
): TypedCell {
  const fromFormula = typeof formula === "string" && formula.startsWith("=");

  if (raw === null || raw === undefined || raw === "") {
    return { type: "blank", raw: raw ?? null, typed: null, display: "", fromFormula };
  }
  if (typeof raw === "boolean") {
    return { type: "boolean", raw, typed: raw, display: raw ? "TRUE" : "FALSE", fromFormula };
  }
  if (typeof raw === "string") {
    if (ERROR_RE.test(raw.trim())) {
      return { type: "error", raw, typed: raw.trim(), display: raw.trim(), fromFormula };
    }
    // A string that is itself a date literal ("2025-01-01", "01.11.25").
    const d = coerceHeaderDate(raw, false, system);
    if (d) return { type: "date", raw, typed: d.iso, display: formatDateLabel(d), fromFormula };
    return { type: "text", raw, typed: raw, display: raw, fromFormula };
  }
  // number
  const n = raw;
  if (!Number.isFinite(n)) return { type: "unknown", raw, typed: null, display: String(raw), fromFormula };

  if (isDateNumberFormat(numberFormat)) {
    const dt = excelSerialToDate(n, system);
    if (dt) {
      const hasTime = !Number.isInteger(n);
      return {
        type: hasTime ? "datetime" : "date",
        raw,
        typed: dt.iso,
        display: hasTime ? dt.iso.replace("T", " ") : formatDateLabel(dt),
        fromFormula,
      };
    }
  }
  if (isPercentNumberFormat(numberFormat)) {
    return { type: "percentage", raw, typed: n, display: `${(n * 100).toFixed(2).replace(/\.00$/, "")}%`, fromFormula };
  }
  if (isCurrencyNumberFormat(numberFormat)) {
    return { type: "currency", raw, typed: n, display: n.toLocaleString("en-US"), fromFormula };
  }
  return {
    type: Number.isInteger(n) ? "integer" : "number",
    raw,
    typed: n,
    display: Number.isInteger(n) ? String(n) : String(n),
    fromFormula,
  };
}

/** True for a type that participates in numeric analysis. */
export function isNumericType(t: CellType): boolean {
  return t === "number" || t === "integer" || t === "percentage" || t === "currency";
}

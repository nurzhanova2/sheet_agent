// ---------------------------------------------------------------------------
// Stage 24.6 — universal table schema induction.
//
// RAW RANGE → structural profile → header bands + axes + orientation → a
// CANONICAL TableSchema with confidence + explicit ambiguities. No table
// layout is hard-coded: everything is derived from density / uniqueness /
// number-format evidence. Bounded by SCHEMA_LIMITS.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import { classifyCell } from "./cell-typing.js";
import { coerceHeaderDate, formatDateLabel, isDateNumberFormat } from "./excel-date.js";
import { classifyMeasureKind, measureKindLabel, type MeasureKind } from "./measure-compatibility.js";
import { profileTable, SCHEMA_LIMITS, type TableProfile } from "./table-profile.js";

export type TableLayout =
  | "records"
  | "matrix"
  | "cross_tab"
  | "time_series_matrix"
  | "hierarchical_report"
  | "key_value"
  | "mixed"
  | "unknown";

export type Orientation =
  | "row_records"
  | "row_metrics"
  | "column_metrics"
  | "bidimensional"
  | "unknown";

export interface ColumnPathLevel {
  readonly value: string;
  readonly role: "period" | "date" | "measure_variant" | "dimension" | "unknown";
  /** ISO date when the level value typed as a date. */
  readonly iso?: string;
}

export interface ColumnPath {
  readonly colIndex: number;
  readonly levels: readonly ColumnPathLevel[];
  readonly displayLabel: string;
  readonly measureKind: MeasureKind;
}

export interface RowAxisMember {
  readonly rowIndex: number;
  readonly labels: readonly string[];
  readonly display: string;
}

export interface MeasureDescriptor {
  readonly kind: MeasureKind;
  readonly label: string;
  readonly columnIndexes: readonly number[];
}

export interface DetectedTotal {
  readonly rowIndex: number;
  readonly label: string;
  readonly confidence: number;
}

export type SchemaAmbiguity =
  | { readonly kind: "header_depth"; readonly candidates: readonly { readonly depth: number; readonly confidence: number }[] }
  | { readonly kind: "orientation"; readonly candidates: readonly { readonly orientation: Orientation; readonly confidence: number }[] }
  | { readonly kind: "row_label_columns"; readonly candidates: readonly { readonly columns: readonly number[]; readonly confidence: number }[] }
  | { readonly kind: "missing_header_context"; readonly note: string };

export interface TableSchema {
  readonly sheetName: string;
  readonly sourceRange: string;
  readonly sourceVersion: string;
  readonly layoutKind: TableLayout;
  readonly orientation: Orientation;
  readonly headerDepth: number;
  readonly headerRows: readonly number[];
  readonly rowHeaderColumns: readonly number[];
  readonly dataRegion: { readonly row0: number; readonly col0: number; readonly row1: number; readonly col1: number };
  readonly columnPaths: readonly ColumnPath[];
  readonly rowAxis: readonly RowAxisMember[];
  readonly measures: readonly MeasureDescriptor[];
  readonly totals: readonly DetectedTotal[];
  readonly temporalAxis?: "columns" | "rows";
  readonly confidence: number;
  readonly ambiguities: readonly SchemaAmbiguity[];
  readonly profileSummary: {
    readonly rows: number;
    readonly cols: number;
    readonly dateCells: number;
    readonly percentCells: number;
    readonly truncated: boolean;
  };
  /** developer-only: short reasons the orientation was chosen. */
  readonly reasons: readonly string[];
}

const MEASURE_VARIANT_RE =
  /^(?:абс\.?|abs\.?|%|percent(?:age)?|amount|value|знач(?:\.|ение)?|факт|план|нақты|пайыз)$/i;
const TOTAL_RE =
  /^(?:\s*(?:grand\s+)?total\b|\s*sub-?total\b|итого\b|всего\b|подытог|промежуточн|барлы[гғ]ы|жиынты[гқ]|нийт)/i;

function med(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function cellText(values: readonly (readonly CellValue[])[], r: number, c: number): string {
  const v = values[r]?.[c];
  return v === null || v === undefined ? "" : String(v).trim();
}

/** Row/column label as a string, converting a confidently date-formatted cell. */
function labelOf(
  values: readonly (readonly CellValue[])[],
  numberFormats: readonly (readonly string[])[],
  r: number,
  c: number,
): string {
  const raw = values[r]?.[c] ?? null;
  const fmt = numberFormats[r]?.[c] ?? null;
  const d = coerceHeaderDate(raw, isDateNumberFormat(fmt));
  if (d) return formatDateLabel(d);
  return raw === null || raw === undefined ? "" : String(raw).trim();
}

interface Induced {
  headerDepth: number;
  headerCandidates: { depth: number; confidence: number }[];
  rowHeaderCols: number[];
  bodyRow0: number;
}

function induceHeaderAndLabels(profile: TableProfile): Induced {
  const { rowFeatures, colFeatures, cols, rows } = profile;
  // body numeric density excluding the first few rows as a probe.
  const probe = Math.min(3, Math.max(0, rows - 1));
  const bodyNumeric = med(rowFeatures.slice(probe).map((f) => f.numericDensity));

  let depth = 0;
  const threshold = Math.max(0.32, bodyNumeric * 0.55);
  for (let r = 0; r < Math.min(rows, SCHEMA_LIMITS.maxHeaderDepth + 1); r += 1) {
    const f = rowFeatures[r]!;
    const looksHeader = f.numericDensity < threshold && f.textDensity + f.blankDensity > 0.45 && f.dateDensity < 0.9;
    // stop as soon as we hit a data-like row (unless it's an all-blank spacer)
    if (!looksHeader && f.blankDensity < 0.95) break;
    if (looksHeader) depth += 1;
  }
  // a pure numeric matrix with a single text label row that our loop skipped:
  if (depth === 0 && rows > 1) {
    const r0 = rowFeatures[0]!;
    if (r0.textDensity >= 0.4 && r0.numericDensity <= 0.25) depth = 1;
  }
  depth = Math.min(depth, SCHEMA_LIMITS.maxHeaderDepth);

  const headerCandidates: { depth: number; confidence: number }[] = [{ depth, confidence: 0.8 }];
  // borderline alternative: one more / one fewer header row when densities are close.
  if (depth >= 1 && depth < rows - 1) {
    const nextRow = rowFeatures[depth]!;
    if (Math.abs(nextRow.numericDensity - threshold) < 0.15) {
      headerCandidates.push({ depth: depth + 1, confidence: 0.45 });
    }
  }
  if (depth >= 2) {
    const lastHeader = rowFeatures[depth - 1]!;
    if (lastHeader.numericDensity > threshold * 0.7) headerCandidates.push({ depth: depth - 1, confidence: 0.4 });
  }

  // row-label columns: leading columns that are text/unique with numeric to the right.
  const bodyRow0 = depth;
  const rowHeaderCols: number[] = [];
  const rightNumeric = med(colFeatures.slice(1).map((f) => f.numericDensity));
  for (let c = 0; c < Math.min(cols, 4); c += 1) {
    // recompute this column's body-only density
    let text = 0;
    let numeric = 0;
    let nb = 0;
    const seen = new Set<string>();
    for (let r = bodyRow0; r < rows; r += 1) {
      const fx = profile.cellFacts[r]?.[c];
      if (!fx || fx.blank) continue;
      nb += 1;
      if (fx.numeric) numeric += 1;
      else if (fx.text) text += 1;
    }
    for (let r = bodyRow0; r < rows; r += 1) {
      const fx = profile.cellFacts[r]?.[c];
      if (!fx || fx.blank) continue;
      seen.add(String(r)); // placeholder; uniqueness handled by colFeatures
    }
    const textShare = nb > 0 ? text / nb : 0;
    const numShare = nb > 0 ? numeric / nb : 0;
    const uniq = colFeatures[c]?.uniqueness ?? 0;
    const isLabel =
      (textShare >= 0.55 || (uniq >= 0.7 && numShare < 0.3)) &&
      numShare < 0.4 &&
      (rightNumeric >= 0.4 || c === 0);
    if (isLabel && (rowHeaderCols.length === c)) rowHeaderCols.push(c);
    else break;
  }

  return { headerDepth: depth, headerCandidates, rowHeaderCols, bodyRow0 };
}

/** Forward-fills blank header cells to the right of the last non-blank value in
 *  the same header row — emulating merged header cells. Both the value AND the
 *  number-format are carried, so a merged date header keeps its date format.
 *  Conservative: only when the row is sparse (real blanks between values). */
function headerRowFilled(
  values: readonly (readonly CellValue[])[],
  numberFormats: readonly (readonly string[])[],
  row: number,
  col0: number,
  col1: number,
): { values: CellValue[]; formats: (string | null)[] } {
  const rawV: CellValue[] = [];
  const rawF: (string | null)[] = [];
  let nonBlank = 0;
  for (let c = col0; c <= col1; c += 1) {
    const v = values[row]?.[c] ?? null;
    rawV.push(v);
    rawF.push(numberFormats[row]?.[c] ?? null);
    if (v !== null && v !== undefined && v !== "") nonBlank += 1;
  }
  const span = col1 - col0 + 1;
  const sparse = nonBlank >= 1 && nonBlank < span;
  if (!sparse) return { values: rawV, formats: rawF };
  const outV: CellValue[] = [];
  const outF: (string | null)[] = [];
  let lastV: CellValue = "";
  let lastF: string | null = null;
  for (let i = 0; i < rawV.length; i += 1) {
    const v = rawV[i]!;
    if (v !== null && v !== undefined && v !== "") {
      lastV = v;
      lastF = rawF[i]!;
    }
    outV.push(lastV);
    outF.push(lastF);
  }
  return { values: outV, formats: outF };
}

function levelRole(level: number, depth: number, value: string, isDate: boolean): ColumnPathLevel["role"] {
  if (isDate) return "date";
  if (MEASURE_VARIANT_RE.test(value)) return "measure_variant";
  if (level === 0 && depth > 1) return "period";
  return level === depth - 1 ? "dimension" : "period";
}

export interface InduceInput {
  readonly values: readonly (readonly CellValue[])[];
  readonly numberFormats: readonly (readonly string[])[];
  readonly formulas?: readonly (readonly (string | CellValue | null)[])[];
  readonly sheetName: string;
  readonly sourceRange: string;
  readonly sourceVersion: string;
  /** true when the selection did not start at worksheet row 1 (partial header risk). */
  readonly startsBelowRow1?: boolean;
}

export function induceTableSchema(input: InduceInput): TableSchema {
  const { values, numberFormats, formulas = [], sheetName, sourceRange, sourceVersion } = input;
  const profile = profileTable(values, numberFormats, formulas);
  const { headerDepth, headerCandidates, rowHeaderCols, bodyRow0 } = induceHeaderAndLabels(profile);

  const col0 = rowHeaderCols.length;
  const col1 = profile.cols - 1;
  const row1 = profile.rows - 1;
  const dataRegion = { row0: bodyRow0, col0, row1, col1 };

  // --- column paths (with merged-header emulation) ------------------------
  const filledHeaderRows: { values: CellValue[]; formats: (string | null)[] }[] = [];
  for (let level = 0; level < headerDepth; level += 1) {
    filledHeaderRows.push(headerRowFilled(values, numberFormats, level, col0, Math.max(col0, col1)));
  }
  const columnPaths: ColumnPath[] = [];
  let dateCells = 0;
  let percentCells = 0;
  for (let c = col0; c <= col1; c += 1) {
    const levels: ColumnPathLevel[] = [];
    for (let level = 0; level < headerDepth; level += 1) {
      const rawV = filledHeaderRows[level]?.values[c - col0] ?? "";
      const fmt = filledHeaderRows[level]?.formats[c - col0] ?? null;
      const text = rawV === null || rawV === undefined ? "" : String(rawV).trim();
      const d = coerceHeaderDate(rawV, isDateNumberFormat(fmt));
      const isDate = d !== null;
      if (isDate) dateCells += 1;
      levels.push({
        value: isDate ? formatDateLabel(d!) : text,
        role: levelRole(level, headerDepth, text, isDate),
        ...(isDate ? { iso: d!.iso } : {}),
      });
    }
    if (levels.length === 0) levels.push({ value: `col ${c + 1}`, role: "unknown" });
    // measure kind from this column's body cells + its header path text.
    const colFmts: (string | null)[] = [];
    let pct = 0;
    let nb = 0;
    for (let r = bodyRow0; r <= row1; r += 1) {
      colFmts.push(numberFormats[r]?.[c] ?? null);
      const tc = classifyCell(values[r]?.[c] ?? null, numberFormats[r]?.[c] ?? null);
      if (tc.type === "percentage") pct += 1;
      if (tc.type !== "blank") nb += 1;
    }
    if (nb > 0 && pct / nb >= 0.6) percentCells += 1;
    const pathText = levels.map((l) => l.value).join(" ");
    const measureKind = classifyMeasureKind(colFmts, pathText);
    columnPaths.push({
      colIndex: c,
      levels,
      displayLabel: levels.map((l) => l.value).filter(Boolean).join(" / ") || `col ${c + 1}`,
      measureKind,
    });
  }

  // --- totals -----------------------------------------------------------
  const totals: DetectedTotal[] = [];
  for (let r = bodyRow0; r <= row1; r += 1) {
    const label = rowHeaderCols.length > 0 ? cellText(values, r, rowHeaderCols[0]!) : cellText(values, r, 0);
    const labelHit = TOTAL_RE.test(label);
    let sumFormula = false;
    for (let c = col0; c <= col1; c += 1) {
      const fx = formulas[r]?.[c];
      if (typeof fx === "string" && /^=\s*(?:SUM|СУММ|SUBTOTAL|ПРОМЕЖУТОЧН)/i.test(fx)) sumFormula = true;
    }
    if (labelHit || sumFormula) totals.push({ rowIndex: r, label: label || `row ${r + 1}`, confidence: labelHit ? 0.9 : 0.55 });
  }
  const totalRows = new Set(totals.filter((t) => t.confidence >= 0.8).map((t) => t.rowIndex));

  // --- row axis -------------------------------------------------------
  const rowAxis: RowAxisMember[] = [];
  for (let r = bodyRow0; r <= row1; r += 1) {
    if (profile.blankRowIndexes.includes(r)) continue;
    if (totalRows.has(r)) continue;
    const labels =
      rowHeaderCols.length > 0
        ? rowHeaderCols.map((c) => labelOf(values, numberFormats, r, c)).filter((s) => s !== "")
        : [labelOf(values, numberFormats, r, 0)].filter((s) => s !== "");
    if (labels.length === 0 && rowHeaderCols.length > 0) continue;
    rowAxis.push({
      rowIndex: r,
      labels: labels.length > 0 ? labels : [`row ${r + 1}`],
      display: (labels.length > 0 ? labels : [`row ${r + 1}`]).join(" / "),
    });
    if (rowAxis.length >= SCHEMA_LIMITS.maxAxisMembers) break;
  }

  // --- measures grouping -------------------------------------------------
  const byKind = new Map<MeasureKind, number[]>();
  for (const p of columnPaths) {
    const arr = byKind.get(p.measureKind) ?? [];
    arr.push(p.colIndex);
    byKind.set(p.measureKind, arr);
  }
  const measures: MeasureDescriptor[] = [...byKind.entries()].map(([kind, columnIndexes]) => ({
    kind,
    label: measureKindLabel(kind),
    columnIndexes,
  }));

  // --- orientation ----------------------------------------------------
  const reasons: string[] = [];
  const bodyNumeric = med(profile.rowFeatures.slice(bodyRow0).map((f) => f.numericDensity));
  const col0Body = (() => {
    let dateN = 0;
    let nb = 0;
    for (let r = bodyRow0; r <= row1; r += 1) {
      const tc = classifyCell(values[r]?.[0] ?? null, numberFormats[r]?.[0] ?? null);
      if (tc.type === "blank") continue;
      nb += 1;
      if (tc.type === "date" || tc.type === "datetime") dateN += 1;
    }
    return { dateShare: nb > 0 ? dateN / nb : 0, nb };
  })();

  let orientation: Orientation;
  let layoutKind: TableLayout;
  let temporalAxis: "columns" | "rows" | undefined;
  const dataColCount = col1 - col0 + 1;
  const headerHasDates = columnPaths.some((p) => p.levels.some((l) => l.role === "date"));
  const variantLevel = headerDepth >= 2 && columnPaths.some((p) => p.levels.at(-1)?.role === "measure_variant");
  const PERIOD_LABEL_RE =
    /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек|кв\.?\s*[1-4]|\d{1,2}\.\d{2}\.\d{2,4})/i;
  const periodHeaders =
    headerHasDates || columnPaths.length > 0 && columnPaths.every((p) => PERIOD_LABEL_RE.test(p.displayLabel.trim()));
  const yearHeaders = columnPaths.length > 0 && columnPaths.every((p) => /^(?:19|20)\d{2}$/.test(p.displayLabel.trim()));

  // A records table: single header row, many more rows than columns, and a wide
  // heterogeneous column mix (>= 2 text/date columns AND >= 2 numeric columns).
  // A matrix / report has a narrow (1-2) left label region.
  const nonNumericCols = profile.colFeatures.filter((f) => f.numericDensity < 0.4 && f.blankDensity < 0.3).length;
  const numericCols = profile.colFeatures.filter((f) => f.numericDensity >= 0.6).length;
  const rowsPerCol = profile.cols > 0 ? profile.rows / profile.cols : 0;
  const looksRecords =
    headerDepth <= 1 &&
    !periodHeaders &&
    !yearHeaders &&
    numericCols >= 2 &&
    nonNumericCols >= 2 &&
    rowsPerCol >= 2.5 &&
    profile.rows - bodyRow0 >= 10;

  if (looksRecords) {
    orientation = "row_records";
    layoutKind = "records";
    reasons.push(`records: ${nonNumericCols} non-numeric + ${numericCols} numeric columns, ${Math.round(rowsPerCol)}× rows/cols`);
  } else if (headerDepth >= 2) {
    orientation = "row_metrics";
    layoutKind = "hierarchical_report";
    if (periodHeaders || columnPaths.some((p) => p.levels.some((l) => l.role === "period"))) temporalAxis = "columns";
    reasons.push(`headerDepth=${headerDepth}`, variantLevel ? "measure-variant sub-headers" : "multi-level column headers");
  } else if (col0Body.dateShare >= 0.6 && rowHeaderCols.length <= 1 && bodyNumeric >= 0.5) {
    orientation = "column_metrics";
    layoutKind = "time_series_matrix";
    temporalAxis = "rows";
    reasons.push("left column is date-dense", "metric-named columns");
  } else if (rowHeaderCols.length >= 1 && bodyNumeric >= 0.5 && dataColCount >= 1) {
    const homogeneousKind = byKind.size === 1;
    const shortHeaders = columnPaths.every((p) => p.displayLabel.length <= 12);
    if (periodHeaders) {
      orientation = "row_metrics";
      layoutKind = "time_series_matrix";
      temporalAxis = "columns";
      reasons.push("period / date column headers", "left metric-label column");
    } else if (yearHeaders || (homogeneousKind && shortHeaders && dataColCount <= 3)) {
      orientation = "bidimensional";
      layoutKind = "cross_tab";
      if (yearHeaders) temporalAxis = "columns";
      reasons.push("single measure kind", yearHeaders ? "year column headers" : "few short categorical headers");
    } else {
      orientation = "row_metrics";
      layoutKind = "matrix";
      reasons.push("left label column + numeric body", `dataCols=${dataColCount}`);
    }
  } else {
    orientation = "row_records";
    layoutKind = "records";
    reasons.push("single header row, heterogeneous columns");
  }

  // --- confidence + ambiguities --------------------------------------
  const densityContrast = Math.min(1, Math.abs(bodyNumeric - (profile.rowFeatures[0]?.numericDensity ?? 0)) + 0.3);
  const labelClarity = rowHeaderCols.length > 0 || orientation === "row_records" || orientation === "column_metrics" ? 0.9 : 0.55;
  let confidence = Math.max(0.2, Math.min(0.99, 0.35 + 0.3 * densityContrast + 0.35 * labelClarity));

  const ambiguities: SchemaAmbiguity[] = [];
  if (headerCandidates.length > 1) {
    ambiguities.push({ kind: "header_depth", candidates: headerCandidates });
    confidence -= 0.1;
  }
  if (input.startsBelowRow1 && headerDepth === 0 && bodyNumeric >= 0.6) {
    ambiguities.push({
      kind: "missing_header_context",
      note: "the selection is a numeric block with no header rows and does not start at row 1",
    });
    confidence -= 0.15;
  }
  confidence = Math.max(0.15, Math.min(0.99, confidence));

  return {
    sheetName,
    sourceRange,
    sourceVersion,
    layoutKind,
    orientation,
    headerDepth,
    headerRows: Array.from({ length: headerDepth }, (_, i) => i),
    rowHeaderColumns: rowHeaderCols,
    dataRegion,
    columnPaths,
    rowAxis,
    measures,
    totals,
    ...(temporalAxis ? { temporalAxis } : {}),
    confidence: Number(confidence.toFixed(2)),
    ambiguities,
    profileSummary: {
      rows: profile.rows,
      cols: profile.cols,
      dateCells,
      percentCells,
      truncated: profile.truncated,
    },
    reasons,
  };
}

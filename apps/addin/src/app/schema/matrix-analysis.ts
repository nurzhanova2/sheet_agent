// ---------------------------------------------------------------------------
// Stage 24.6 — deterministic analytical primitives over a canonical TableSchema.
//
// Generic (no business names): schemaDescribe, measureSeries, seriesExtrema,
// seriesPeaks, iqrOutliers, axisRank. Every numeric result keeps exact source
// cells and header-path provenance. Series of different measure kinds are never
// mixed in one distribution / comparison.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import { columnIndexToLetters, parseLocalRange, splitSheetAddress } from "../a1.js";
import { classifyCell } from "./cell-typing.js";
import { measureKindLabel, sameMeasureGroup, type MeasureKind } from "./measure-compatibility.js";
import { SCHEMA_LIMITS } from "./table-profile.js";
import type { ColumnPath, TableSchema } from "./schema-induction.js";

/** One numeric observation with full provenance. */
export interface SeriesPoint {
  readonly value: number;
  readonly rowIndex: number;
  readonly colIndex: number;
  /** sheet-qualified A1 of the source cell. */
  readonly cell: string;
  readonly rowLabel: string;
  readonly columnPath: string;
  readonly percent: boolean;
}

export interface MeasureSeries {
  readonly key: string;
  /** the row-axis member this series belongs to (for row_metrics), else "". */
  readonly rowLabel: string;
  readonly measureKind: MeasureKind;
  readonly measureLabel: string;
  readonly points: readonly SeriesPoint[];
}

function localBase(sourceRange: string): { sheet: string; startRow: number; startCol: number } {
  const { sheetName, localAddress } = splitSheetAddress(sourceRange);
  try {
    const r = parseLocalRange(localAddress || sourceRange);
    return { sheet: sheetName || "", startRow: r.start.row, startCol: r.start.column };
  } catch {
    return { sheet: sheetName || "", startRow: 0, startCol: 0 };
  }
}

function cellAddress(sourceRange: string, rowIndex: number, colIndex: number): string {
  const { sheet, startRow, startCol } = localBase(sourceRange);
  const a1 = `${columnIndexToLetters(startCol + colIndex)}${startRow + rowIndex + 1}`;
  return sheet ? `${sheet}!${a1}` : a1;
}

function num(v: CellValue, fmt: string | null): { n: number; percent: boolean } | null {
  const tc = classifyCell(v, fmt);
  if (tc.type === "number" || tc.type === "integer" || tc.type === "currency") return { n: v as number, percent: false };
  if (tc.type === "percentage") return { n: v as number, percent: true };
  return null;
}

export interface AnalysisGrids {
  readonly values: readonly (readonly CellValue[])[];
  readonly numberFormats: readonly (readonly string[])[];
}

/**
 * Builds one MeasureSeries per (row-axis member × measure kind) for a
 * row_metrics / hierarchical_report matrix, or one per column for a
 * column_metrics / cross_tab table. Bounded to MAX_ANALYSIS_SERIES.
 */
export function measureSeries(schema: TableSchema, grids: AnalysisGrids): MeasureSeries[] {
  const { values, numberFormats } = grids;
  const out: MeasureSeries[] = [];
  const pathByCol = new Map<number, ColumnPath>(schema.columnPaths.map((p) => [p.colIndex, p]));

  if (schema.orientation === "row_metrics" || schema.orientation === "bidimensional") {
    for (const member of schema.rowAxis) {
      // group this row's data cells by the column's measure kind
      const byKind = new Map<MeasureKind, SeriesPoint[]>();
      for (const p of schema.columnPaths) {
        const raw = values[member.rowIndex]?.[p.colIndex] ?? null;
        const fmt = numberFormats[member.rowIndex]?.[p.colIndex] ?? null;
        const parsed = num(raw, fmt);
        if (!parsed) continue;
        const arr = byKind.get(p.measureKind) ?? [];
        arr.push({
          value: parsed.n,
          rowIndex: member.rowIndex,
          colIndex: p.colIndex,
          cell: cellAddress(schema.sourceRange, member.rowIndex, p.colIndex),
          rowLabel: member.display,
          columnPath: p.displayLabel,
          percent: parsed.percent,
        });
        byKind.set(p.measureKind, arr);
      }
      for (const [kind, points] of byKind) {
        if (points.length === 0) continue;
        out.push({
          key: `${member.display} · ${measureKindLabel(kind)}`,
          rowLabel: member.display,
          measureKind: kind,
          measureLabel: measureKindLabel(kind),
          points,
        });
        if (out.length >= SCHEMA_LIMITS.maxAnalysisSeries) return out;
      }
    }
    return out;
  }

  // column_metrics: one series per data column (down the rows).
  for (const p of schema.columnPaths) {
    const points: SeriesPoint[] = [];
    for (const member of schema.rowAxis) {
      const raw = values[member.rowIndex]?.[p.colIndex] ?? null;
      const fmt = numberFormats[member.rowIndex]?.[p.colIndex] ?? null;
      const parsed = num(raw, fmt);
      if (!parsed) continue;
      points.push({
        value: parsed.n,
        rowIndex: member.rowIndex,
        colIndex: p.colIndex,
        cell: cellAddress(schema.sourceRange, member.rowIndex, p.colIndex),
        rowLabel: member.display,
        columnPath: p.displayLabel,
        percent: parsed.percent,
      });
    }
    if (points.length === 0) continue;
    out.push({
      key: p.displayLabel,
      rowLabel: "",
      measureKind: p.measureKind,
      measureLabel: measureKindLabel(p.measureKind),
      points,
    });
    void pathByCol;
    if (out.length >= SCHEMA_LIMITS.maxAnalysisSeries) return out;
  }
  return out;
}

export interface Extremum {
  readonly seriesKey: string;
  readonly rowLabel: string;
  readonly measureLabel: string;
  readonly max: SeriesPoint;
  readonly min: SeriesPoint;
}

export function seriesExtrema(series: readonly MeasureSeries[]): Extremum[] {
  return series
    .filter((s) => s.points.length > 0)
    .map((s) => {
      let mx = s.points[0]!;
      let mn = s.points[0]!;
      for (const p of s.points) {
        if (p.value > mx.value) mx = p;
        if (p.value < mn.value) mn = p;
      }
      return { seriesKey: s.key, rowLabel: s.rowLabel, measureLabel: s.measureLabel, max: mx, min: mn };
    });
}

export interface Peak {
  readonly seriesKey: string;
  readonly rowLabel: string;
  readonly measureLabel: string;
  readonly peak: SeriesPoint;
}

/** Default peak = maximum numeric value. `byMagnitude` switches to max |value|. */
export function seriesPeaks(series: readonly MeasureSeries[], byMagnitude = false): Peak[] {
  return series
    .filter((s) => s.points.length > 0)
    .map((s) => {
      let best = s.points[0]!;
      for (const p of s.points) {
        const better = byMagnitude ? Math.abs(p.value) > Math.abs(best.value) : p.value > best.value;
        if (better) best = p;
      }
      return { seriesKey: s.key, rowLabel: s.rowLabel, measureLabel: s.measureLabel, peak: best };
    });
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface OutlierReport {
  readonly seriesKey: string;
  readonly measureLabel: string;
  readonly q1: number;
  readonly q3: number;
  readonly lower: number;
  readonly upper: number;
  readonly outliers: readonly SeriesPoint[];
}

/** IQR outliers per compatible series. Series of different measure kinds are
 *  NEVER pooled into one distribution. */
export function iqrOutliers(series: readonly MeasureSeries[]): OutlierReport[] {
  return series
    .filter((s) => s.points.length >= 4)
    .map((s) => {
      const sorted = [...s.points.map((p) => p.value)].sort((a, b) => a - b);
      const q1 = quantile(sorted, 0.25);
      const q3 = quantile(sorted, 0.75);
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      return {
        seriesKey: s.key,
        measureLabel: s.measureLabel,
        q1,
        q3,
        lower,
        upper,
        outliers: s.points.filter((p) => p.value < lower || p.value > upper),
      };
    })
    .filter((r) => r.outliers.length > 0);
}

export interface ThresholdReport {
  readonly seriesKey: string;
  readonly measureLabel: string;
  readonly threshold: number;
  readonly outliers: readonly SeriesPoint[];
}

/** Per compatible series, the points whose absolute value exceeds `threshold`.
 *  Deterministic; assumes no regulatory standard. */
export function thresholdOutliers(series: readonly MeasureSeries[], threshold: number): ThresholdReport[] {
  const t = Math.abs(threshold);
  return series
    .map((s) => ({
      seriesKey: s.key,
      measureLabel: s.measureLabel,
      threshold: t,
      outliers: s.points.filter((p) => Math.abs(p.value) > t),
    }))
    .filter((r) => r.outliers.length > 0);
}

export interface AxisRankRow {
  readonly member: string;
  readonly value: number;
  readonly cell: string;
}

/** Ranks row-axis members by the value in one column path (e.g. "max in 2025"). */
export function axisRank(
  schema: TableSchema,
  grids: AnalysisGrids,
  colIndex: number,
  direction: "asc" | "desc",
  limit = 50,
): AxisRankRow[] {
  const { values, numberFormats } = grids;
  const rows: AxisRankRow[] = [];
  for (const member of schema.rowAxis) {
    const parsed = num(values[member.rowIndex]?.[colIndex] ?? null, numberFormats[member.rowIndex]?.[colIndex] ?? null);
    if (!parsed) continue;
    rows.push({ member: member.display, value: parsed.n, cell: cellAddress(schema.sourceRange, member.rowIndex, colIndex) });
  }
  rows.sort((a, b) => (direction === "asc" ? a.value - b.value : b.value - a.value));
  return rows.slice(0, limit);
}

export type Trend = "increasing" | "decreasing" | "approximately flat" | "mixed / volatile";

/** Deterministic trend classification over an ordered series. */
export function seriesTrend(points: readonly SeriesPoint[]): Trend {
  if (points.length < 2) return "approximately flat";
  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const span = Math.max(1e-9, Math.max(...points.map((p) => Math.abs(p.value))));
  const net = (last - first) / span;
  let up = 0;
  let down = 0;
  for (let i = 1; i < points.length; i += 1) {
    const d = points[i]!.value - points[i - 1]!.value;
    if (d > span * 0.02) up += 1;
    else if (d < -span * 0.02) down += 1;
  }
  const steps = points.length - 1;
  if (up >= steps * 0.8 && net > 0.05) return "increasing";
  if (down >= steps * 0.8 && net < -0.05) return "decreasing";
  if (Math.abs(net) <= 0.05 && up + down <= steps * 0.4) return "approximately flat";
  return "mixed / volatile";
}

/** True when two series may be compared / aggregated together. */
export { sameMeasureGroup };

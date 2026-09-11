// ---------------------------------------------------------------------------
// Stage 24.7 — build an ordered point-in-time TemporalSeries for a resolved
// subject (§19, §20). Change-horizon columns are always excluded from a
// point-in-time series. Physical address is preserved in provenance; ordering
// is by canonical period value.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import { columnIndexToLetters, parseLocalRange, splitSheetAddress } from "../../a1.js";
import { classifyCell } from "../cell-typing.js";
import type { AnalysisGrids } from "../matrix-analysis.js";
import type { MeasureKind } from "../measure-compatibility.js";
import type { TableSchema } from "../schema-induction.js";
import type { PeriodIndex } from "./period-index.js";
import { comparePoints } from "./temporal-primitives.js";
import type { AnalysisEvent, CanonicalPeriod, ResolvedSubject, TemporalPoint, TemporalSeries } from "./types.js";

function base(sourceRange: string): { sheet: string; row: number; col: number } {
  const { sheetName, localAddress } = splitSheetAddress(sourceRange);
  try {
    const r = parseLocalRange(localAddress || sourceRange);
    return { sheet: sheetName || "", row: r.start.row, col: r.start.column };
  } catch {
    return { sheet: sheetName || "", row: 0, col: 0 };
  }
}

function addr(sourceRange: string, rowIndex: number, colIndex: number): string {
  const b = base(sourceRange);
  const a1 = `${columnIndexToLetters(b.col + colIndex)}${b.row + rowIndex + 1}`;
  return b.sheet ? `${b.sheet}!${a1}` : a1;
}

function numeric(v: CellValue, fmt: string | null): { n: number; percent: boolean } | null {
  const tc = classifyCell(v, fmt);
  if (tc.type === "number" || tc.type === "integer" || tc.type === "currency") return { n: v as number, percent: false };
  if (tc.type === "percentage") return { n: v as number, percent: true };
  return null;
}

/** Reads one point-in-time value for a subject at a resolved period. */
export function getPointValue(
  schema: TableSchema,
  grids: AnalysisGrids,
  subject: ResolvedSubject,
  period: CanonicalPeriod,
): TemporalPoint | null {
  const read = (rowIndex: number, colIndex: number): TemporalPoint | null => {
    const parsed = numeric(grids.values[rowIndex]?.[colIndex] ?? null, grids.numberFormats[rowIndex]?.[colIndex] ?? null);
    if (!parsed) return null;
    return {
      canonicalPeriod: period.canonical,
      periodLabel: period.headerPath,
      value: parsed.n,
      raw: parsed.n,
      cell: addr(schema.sourceRange, rowIndex, colIndex),
      rowIndex,
      colIndex,
      percent: parsed.percent,
    };
  };

  if (subject.kind === "row_axis_member" && period.colIndex >= 0) {
    return read(subject.member.rowIndex, period.colIndex);
  }
  if (subject.kind === "column_measure" && period.rowIndex >= 0) {
    return read(period.rowIndex, subject.column.colIndex);
  }
  return null;
}

/** One member label per resolved subject, for compare/filter (§60 "each metric"
 *  scope) — a single-metric subject yields exactly one label. */
function subjectMembers(subject: ResolvedSubject): { readonly key: string; readonly single: ResolvedSubject }[] {
  if (subject.kind === "each_metric") {
    return subject.members.map((m) => ({ key: m.display, single: { kind: "row_axis_member" as const, member: m } }));
  }
  if (subject.kind === "each_column") {
    return subject.columns.map((c) => ({ key: c.displayLabel, single: { kind: "column_measure" as const, column: c } }));
  }
  if (subject.kind === "row_axis_member") return [{ key: subject.member.display, single: subject }];
  return [{ key: subject.column.displayLabel, single: subject }];
}

export interface MetricPointPair {
  readonly key: string;
  readonly start: TemporalPoint | null;
  readonly end: TemporalPoint | null;
}

/**
 * Stage 24.7.1 §14/§15 — the ONE shared primitive for "compare all metrics at
 * two points" / "filter metrics whose change passes a predicate" / "change of
 * one metric between two points". Every metric in `subject`'s scope reads its
 * start/end value from the SAME two resolved periods — `compare`, `change`
 * and `filter` never run divergent per-metric logic.
 */
export function compareMetricSetAtTwoPoints(
  schema: TableSchema,
  grids: AnalysisGrids,
  subject: ResolvedSubject,
  startPeriod: CanonicalPeriod,
  endPeriod: CanonicalPeriod,
): MetricPointPair[] {
  return subjectMembers(subject).map(({ key, single }) => ({
    key,
    start: getPointValue(schema, grids, single, startPeriod),
    end: getPointValue(schema, grids, single, endPeriod),
  }));
}

function seriesForColumnSubject(
  schema: TableSchema,
  grids: AnalysisGrids,
  colIndex: number,
  key: string,
  measureKind: MeasureKind,
  index: PeriodIndex,
): TemporalSeries {
  const points: TemporalPoint[] = [];
  for (const per of index.points) {
    if (per.rowIndex < 0) continue;
    const parsed = numeric(grids.values[per.rowIndex]?.[colIndex] ?? null, grids.numberFormats[per.rowIndex]?.[colIndex] ?? null);
    if (!parsed) continue;
    points.push({
      canonicalPeriod: per.canonical,
      periodLabel: per.headerPath,
      value: parsed.n,
      raw: parsed.n,
      cell: addr(schema.sourceRange, per.rowIndex, colIndex),
      rowIndex: per.rowIndex,
      colIndex,
      percent: parsed.percent,
    });
  }
  points.sort((a, b) => periodOrder(index, a.canonicalPeriod) - periodOrder(index, b.canonicalPeriod));
  return { key, measureKind, percent: points.some((p) => p.percent), points };
}

function seriesForRowSubject(
  schema: TableSchema,
  grids: AnalysisGrids,
  rowIndex: number,
  key: string,
  index: PeriodIndex,
): TemporalSeries {
  const points: TemporalPoint[] = [];
  let measureKind: MeasureKind = "unknown_numeric";
  const pathByCol = new Map(schema.columnPaths.map((p) => [p.colIndex, p]));
  for (const per of index.points) {
    if (per.colIndex < 0) continue;
    const parsed = numeric(grids.values[rowIndex]?.[per.colIndex] ?? null, grids.numberFormats[rowIndex]?.[per.colIndex] ?? null);
    if (!parsed) continue;
    measureKind = pathByCol.get(per.colIndex)?.measureKind ?? measureKind;
    points.push({
      canonicalPeriod: per.canonical,
      periodLabel: per.headerPath,
      value: parsed.n,
      raw: parsed.n,
      cell: addr(schema.sourceRange, rowIndex, per.colIndex),
      rowIndex,
      colIndex: per.colIndex,
      percent: parsed.percent,
    });
  }
  points.sort((a, b) => periodOrder(index, a.canonicalPeriod) - periodOrder(index, b.canonicalPeriod));
  return { key, measureKind, percent: points.some((p) => p.percent), points };
}

function periodOrder(index: PeriodIndex, canonical: string): number {
  return index.points.find((p) => p.canonical === canonical)?.orderKey ?? 0;
}

/** Ordered point-in-time series for a single resolved subject. */
export function getTemporalSeries(
  schema: TableSchema,
  grids: AnalysisGrids,
  subject: ResolvedSubject,
  index: PeriodIndex,
): TemporalSeries | null {
  if (subject.kind === "row_axis_member") {
    return seriesForRowSubject(schema, grids, subject.member.rowIndex, subject.member.display, index);
  }
  if (subject.kind === "column_measure") {
    return seriesForColumnSubject(schema, grids, subject.column.colIndex, subject.column.displayLabel, subject.column.measureKind, index);
  }
  return null;
}

/** One series per member of a per-metric subject. */
export function getTemporalSeriesSet(
  schema: TableSchema,
  grids: AnalysisGrids,
  subject: ResolvedSubject,
  index: PeriodIndex,
): TemporalSeries[] {
  if (subject.kind === "each_metric") {
    return subject.members.map((m) => seriesForRowSubject(schema, grids, m.rowIndex, m.display, index));
  }
  if (subject.kind === "each_column") {
    return subject.columns.map((c) => seriesForColumnSubject(schema, grids, c.colIndex, c.displayLabel, c.measureKind, index));
  }
  if (subject.kind === "row_axis_member") {
    const s = seriesForRowSubject(schema, grids, subject.member.rowIndex, subject.member.display, index);
    return [s];
  }
  const s = seriesForColumnSubject(schema, grids, subject.column.colIndex, subject.column.displayLabel, subject.column.measureKind, index);
  return [s];
}

/**
 * Stage 24.8 §15/§16/§18 — for every metric in `subject`'s scope, the change
 * between EVERY adjacent pair of canonical POINT periods (never a Δ / horizon
 * / YTD column — `getTemporalSeriesSet` already only reads `index.points`).
 * Bounded: at most `metrics × (points - 1)` events (§67). Deterministic
 * arithmetic via the same `comparePoints` primitive used everywhere else.
 */
export function computeAdjacentPeriodEvents(
  schema: TableSchema,
  grids: AnalysisGrids,
  subject: ResolvedSubject,
  index: PeriodIndex,
): readonly AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  const byCanonical = new Map(index.points.map((p) => [p.canonical, p]));
  for (const s of getTemporalSeriesSet(schema, grids, subject, index)) {
    for (let i = 1; i < s.points.length; i += 1) {
      const a = s.points[i - 1]!;
      const b = s.points[i]!;
      const startPeriod = byCanonical.get(a.canonicalPeriod);
      const endPeriod = byCanonical.get(b.canonicalPeriod);
      if (!startPeriod || !endPeriod) continue;
      const cmp = comparePoints(a, b);
      events.push({
        eventType: "adjacent_period_change",
        metricKey: s.key,
        startPeriod,
        endPeriod,
        startValue: a.value,
        endValue: b.value,
        absoluteChange: cmp.absoluteChange,
        percentageChange: cmp.percentChange,
        startCell: a.cell,
        endCell: b.cell,
      });
    }
  }
  return events;
}

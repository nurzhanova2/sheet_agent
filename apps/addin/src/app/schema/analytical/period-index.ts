// ---------------------------------------------------------------------------
// Stage 24.7 — a bounded PeriodIndex derived from a TableSchema (§49).
//
// Point-in-time periods (dated column headers, or a date-valued row axis) and
// derived change horizons ("за 1 месяц, Δ", "с начала года") are indexed once
// and reused by the period resolver. Every entry keeps the exact header path
// and coordinates — no LLM-generated coordinates.
// ---------------------------------------------------------------------------

import { coerceHeaderDate, isDateNumberFormat } from "../excel-date.js";
import { SCHEMA_LIMITS } from "../table-profile.js";
import type { TableSchema } from "../schema-induction.js";
import type { AnalysisGrids } from "../matrix-analysis.js";
import type { CanonicalPeriod, ChangeHorizon } from "./types.js";

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
};

const CHANGE_HINT = /Δ|delta|\bchange\b|изменени|прирост|динамик|өзгеріс|өсім/i;

/** Maps a change-horizon header phrase to a semantic label. Language-agnostic hints. */
export function horizonOf(headerPath: string): ChangeHorizon {
  const t = headerPath.toLowerCase();
  if (/за\s*12\s*(?:мес[а-яё.]*|month)|last\s*12\s*months|twelve\s*months|за\s*посл[а-яё]*\s*год|12m\b/i.test(t)) return "last_12_months";
  if (/за\s*1\s*(?:мес[а-яё.]*|month)|(?:за|last)\s*(?:прошл[а-яё]*\s*)?месяц|one[-\s]?month|\bmom\b/i.test(t)) return "last_month";
  if (/с\s*нач[а-яё]*\.?\s*года|с\s*начала\s*(?:20\d\d\s*)?года|year[-\s]?to[-\s]?date|\bytd\b|нарастающ/i.test(t)) return "ytd";
  if (/за\s*(?:пред[а-яё]*|прошл[а-яё]*|предыдущ[а-яё]*)\.?\s*год|prior\s*year|previous\s*year|\byoy\b|год\s*к\s*году/i.test(t)) return "prior_year";
  if (/за\s*(?:пред[а-яё]*\s*)?квартал|last\s*quarter|\bqoq\b|квартал\s*к\s*квартал/i.test(t)) return "last_quarter";
  return "unknown_horizon";
}

function monthIndex(label: string): number | null {
  const m = /^([a-zа-яё]{3,})/i.exec(label.trim().toLowerCase());
  if (!m) return null;
  const key = m[1]!.slice(0, 3);
  return MONTHS[key] ?? null;
}

export interface PeriodIndex {
  /** point-in-time periods, ordered ascending by orderKey. */
  readonly points: readonly CanonicalPeriod[];
  /** derived change horizons available as precomputed columns. */
  readonly horizons: readonly CanonicalPeriod[];
  /** true when the temporal axis runs down the rows (column_metrics). */
  readonly axis: "columns" | "rows" | "none";
}

/** Builds the bounded PeriodIndex for a schema. */
export function buildPeriodIndex(schema: TableSchema, grids: AnalysisGrids): PeriodIndex {
  const points: CanonicalPeriod[] = [];
  const horizons: CanonicalPeriod[] = [];

  // --- change horizons: any data column whose header path carries a Δ hint ---
  // Stage 24.7.1 §5/§27 — abs / % siblings of the SAME horizon are paired into
  // ONE CanonicalPeriod (mirrors point-column pairing below), so the executor
  // can deterministically pick the percentage variant when the plan calls for
  // percentage_change instead of structurally defaulting to whichever column
  // happens to come first in sheet order.
  interface HorizonGroup {
    colIndex?: number;
    percentColIndex?: number;
    headerPath: string;
    horizon: ChangeHorizon;
    confidence: number;
  }
  const horizonGroups = new Map<string, HorizonGroup>();
  const horizonColSet = new Set<number>();
  for (const p of schema.columnPaths) {
    const path = p.displayLabel;
    if (!CHANGE_HINT.test(path)) continue;
    horizonColSet.add(p.colIndex);
    const variantLevel = p.levels.length > 0 ? p.levels[p.levels.length - 1] : undefined;
    const baseLevels = variantLevel?.role === "measure_variant" ? p.levels.slice(0, -1) : p.levels;
    const basePath = baseLevels.map((l) => l.value).filter(Boolean).join(" ") || path;
    const groupKey = basePath;
    const isPctCol = p.measureKind === "percentage" || p.measureKind === "percentage_change";
    const horizon = horizonOf(basePath);
    const cur = horizonGroups.get(groupKey);
    if (!cur) {
      horizonGroups.set(groupKey, {
        ...(isPctCol ? { percentColIndex: p.colIndex } : { colIndex: p.colIndex }),
        headerPath: basePath,
        horizon,
        confidence: horizon === "unknown_horizon" ? 0.4 : 0.85,
      });
    } else {
      if (isPctCol && cur.percentColIndex === undefined) cur.percentColIndex = p.colIndex;
      if (!isPctCol && cur.colIndex === undefined) cur.colIndex = p.colIndex;
    }
  }
  for (const g of horizonGroups.values()) {
    const primary = g.colIndex ?? g.percentColIndex;
    if (primary === undefined) continue;
    horizons.push({
      kind: "change_horizon",
      canonical: g.horizon,
      headerPath: g.headerPath,
      colIndex: g.colIndex ?? primary,
      ...(g.percentColIndex !== undefined ? { percentColIndex: g.percentColIndex } : {}),
      rowIndex: -1,
      orderKey: 0,
      horizon: g.horizon,
      resolutionConfidence: g.confidence,
    });
  }
  const horizonCols = horizonColSet;

  // --- dated column headers (row_metrics / hierarchical_report / cross_tab) ---
  if (schema.orientation !== "column_metrics") {
    // group columns by a level's ISO date; the "abs" column is the point, the
    // sibling percent column is recorded on it.
    const byIso = new Map<string, { colIndex: number; percentColIndex?: number; headerPath: string; order: number }>();
    const yearCols: CanonicalPeriod[] = [];
    for (const p of schema.columnPaths) {
      if (horizonCols.has(p.colIndex)) continue;
      const dateLevel = p.levels.find((l) => l.iso);
      const isPctCol = p.measureKind === "percentage" || p.measureKind === "percentage_change";
      if (dateLevel?.iso) {
        const iso = dateLevel.iso;
        const cur = byIso.get(iso);
        if (!cur) {
          byIso.set(iso, isPctCol
            ? { colIndex: -1, percentColIndex: p.colIndex, headerPath: dateLevel.value, order: p.colIndex }
            : { colIndex: p.colIndex, headerPath: dateLevel.value, order: p.colIndex });
        } else if (isPctCol && cur.percentColIndex === undefined) {
          byIso.set(iso, { ...cur, percentColIndex: p.colIndex });
        } else if (!isPctCol && cur.colIndex === -1) {
          byIso.set(iso, { ...cur, colIndex: p.colIndex });
        }
        continue;
      }
      // bare year header ("2024", "2025")
      const ym = /^(?:19|20)\d{2}$/.exec(p.displayLabel.trim());
      if (ym) {
        const yr = Number(ym[0]);
        yearCols.push({
          kind: "year",
          canonical: String(yr),
          headerPath: p.displayLabel,
          colIndex: p.colIndex,
          rowIndex: -1,
          orderKey: yr * 10000,
          resolutionConfidence: 0.9,
        });
        continue;
      }
      // bare month label ("Jan", "Q1", "янв")
      const mi = monthIndex(p.displayLabel);
      if (mi !== null) {
        points.push({
          kind: "point",
          canonical: p.displayLabel.trim(),
          headerPath: p.displayLabel,
          colIndex: p.colIndex,
          rowIndex: -1,
          orderKey: mi,
          resolutionConfidence: 0.55,
        });
      }
    }
    for (const [iso, v] of byIso) {
      const primary = v.colIndex >= 0 ? v.colIndex : (v.percentColIndex ?? -1);
      if (primary < 0) continue;
      points.push({
        kind: "point",
        canonical: iso,
        headerPath: v.headerPath,
        colIndex: v.colIndex >= 0 ? v.colIndex : primary,
        ...(v.percentColIndex !== undefined ? { percentColIndex: v.percentColIndex } : {}),
        rowIndex: -1,
        orderKey: Date.parse(iso) || 0,
        resolutionConfidence: 0.95,
      });
    }
    points.push(...yearCols);
    points.sort((a, b) => a.orderKey - b.orderKey);
    return {
      points: points.slice(0, SCHEMA_LIMITS.maxAxisMembers),
      horizons,
      axis: points.length > 0 ? "columns" : "none",
    };
  }

  // --- date-valued row axis (column_metrics / time_series_matrix) -----------
  schema.rowAxis.forEach((member) => {
    const c = schema.rowHeaderColumns[0] ?? 0;
    const raw = grids.values[member.rowIndex]?.[c] ?? null;
    const fmt = grids.numberFormats[member.rowIndex]?.[c] ?? null;
    const d =
      coerceHeaderDate(raw, isDateNumberFormat(fmt)) ??
      coerceHeaderDate(member.display, false);
    if (!d) return;
    points.push({
      kind: "point",
      canonical: d.iso,
      headerPath: member.display,
      colIndex: -1,
      rowIndex: member.rowIndex,
      orderKey: Date.parse(d.iso) || 0,
      resolutionConfidence: 0.9,
    });
  });
  points.sort((a, b) => a.orderKey - b.orderKey);
  return {
    points: points.slice(0, SCHEMA_LIMITS.maxAxisMembers),
    horizons,
    axis: points.length > 0 ? "rows" : "none",
  };
}

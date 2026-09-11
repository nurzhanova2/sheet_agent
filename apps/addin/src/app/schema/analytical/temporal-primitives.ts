// ---------------------------------------------------------------------------
// Stage 24.7 — deterministic temporal primitives over a TemporalSeries.
//
// One primitive per computation, never one per user phrase. "когда максимум",
// "в каком периоде максимум" and "когда было самое большое" all reach
// `argExtreme`. Every result keeps the exact source cell.
// ---------------------------------------------------------------------------

import type { MeasureKind } from "../measure-compatibility.js";
import type { RankingField, TemporalPoint, TemporalSeries } from "./types.js";

const EPS = 1e-9;

// --- arg-extrema --------------------------------------------------------

export interface ArgExtremeResult {
  readonly point: TemporalPoint;
  readonly kind: "max" | "min";
}

/** The period at which the series reached its max / min. Ties resolve to the
 *  earliest period (the series is period-ordered ascending). */
export function argExtreme(series: TemporalSeries, kind: "max" | "min"): ArgExtremeResult | null {
  if (series.points.length === 0) return null;
  let best = series.points[0]!;
  for (const p of series.points) {
    if (kind === "max" ? p.value > best.value + EPS : p.value < best.value - EPS) best = p;
  }
  return { point: best, kind };
}

export interface SeriesExtrema {
  readonly max: TemporalPoint;
  readonly min: TemporalPoint;
}

export function seriesExtrema(series: TemporalSeries): SeriesExtrema | null {
  const mx = argExtreme(series, "max");
  const mn = argExtreme(series, "min");
  return mx && mn ? { max: mx.point, min: mn.point } : null;
}

// --- point comparison -------------------------------------------------

export interface PointComparison {
  readonly start: TemporalPoint;
  readonly end: TemporalPoint;
  readonly absoluteChange: number;
  /** null when the start value is ~0 (percentage change undefined). */
  readonly percentChange: number | null;
}

/** Change between two already-resolved points. Direct arithmetic from the two
 *  point values — never a precomputed Δ column. */
export function comparePoints(start: TemporalPoint, end: TemporalPoint): PointComparison {
  const absoluteChange = end.value - start.value;
  const percentChange = Math.abs(start.value) < EPS ? null : absoluteChange / Math.abs(start.value);
  return { start, end, absoluteChange, percentChange };
}

// --- trend -----------------------------------------------------------

export type TrendDirection = "increasing" | "decreasing" | "flat";

export interface TrendResult {
  /** OLS slope in value units per period step. */
  readonly slope: number;
  /** slope normalised by |mean| — comparable across metrics of the same kind. */
  readonly normalizedSlope: number;
  readonly direction: TrendDirection;
  /** coefficient of determination, 0..1. */
  readonly r2: number;
  readonly periods: number;
}

/** Deterministic linear (OLS) trend over the period-ordered values. x = 0..n-1. */
export function computeTrend(series: TemporalSeries): TrendResult | null {
  const ys = series.points.map((p) => p.value);
  const n = ys.length;
  if (n < 2) return null;
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const slope = sxx < EPS ? 0 : sxy / sxx;
  const r2 = syy < EPS ? 0 : Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)));
  const denom = Math.abs(my) < EPS ? Math.max(...ys.map((v) => Math.abs(v)), 1) : Math.abs(my);
  const normalizedSlope = slope / denom;
  const direction: TrendDirection =
    Math.abs(normalizedSlope) < 0.01 ? "flat" : normalizedSlope > 0 ? "increasing" : "decreasing";
  return { slope, normalizedSlope, direction, r2, periods: n };
}

// --- volatility / stability -----------------------------------------

export type VolatilityMethod = "std_pct_change" | "std_level_change";

export interface VolatilityResult {
  readonly score: number;
  readonly method: VolatilityMethod;
  readonly periods: number;
  /** largest single period-to-period absolute swing in level units. */
  readonly largestSwing: number;
  readonly largestSwingFrom: TemporalPoint;
  readonly largestSwingTo: TemporalPoint;
}

export interface VolatilityUnavailable {
  readonly unavailable: true;
  readonly reason: string;
}

function sampleStd(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return Math.sqrt(v);
}

/**
 * Volatility of a level series (§28). Default method = standard deviation of
 * period-to-period percentage changes. Falls back to std of level changes for
 * percent / ratio series or when a base value is ~0 (relative change unstable).
 * Requires at least 3 valid temporal observations.
 */
export function computeVolatility(
  series: TemporalSeries,
  opts: { readonly measureKind: MeasureKind },
): VolatilityResult | VolatilityUnavailable {
  const pts = series.points;
  if (pts.length < 3) {
    return { unavailable: true, reason: `only ${pts.length} temporal observation(s)` };
  }
  const levelChanges: number[] = [];
  const pctChanges: number[] = [];
  let baseNearZero = false;
  let largestSwing = 0;
  let from = pts[0]!;
  let to = pts[1]!;
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1]!.value;
    const cur = pts[i]!.value;
    const dLevel = cur - prev;
    levelChanges.push(dLevel);
    if (Math.abs(dLevel) > largestSwing) {
      largestSwing = Math.abs(dLevel);
      from = pts[i - 1]!;
      to = pts[i]!;
    }
    if (Math.abs(prev) < EPS) baseNearZero = true;
    else pctChanges.push(dLevel / Math.abs(prev));
  }
  const kind = opts.measureKind;
  const relativeUnstable =
    baseNearZero ||
    series.percent ||
    kind === "percentage" ||
    kind === "ratio" ||
    kind === "percentage_change" ||
    series.measureKind === "percentage" ||
    series.measureKind === "ratio" ||
    series.measureKind === "percentage_change";
  const method: VolatilityMethod =
    relativeUnstable || pctChanges.length < 2 ? "std_level_change" : "std_pct_change";
  const score = method === "std_pct_change" ? sampleStd(pctChanges) : sampleStd(levelChanges);
  return { score, method, periods: pts.length, largestSwing, largestSwingFrom: from, largestSwingTo: to };
}

// --- monotonicity ---------------------------------------------------

export interface MonotonicityResult {
  readonly strictIncreasing: boolean;
  readonly nonDecreasing: boolean;
  readonly strictDecreasing: boolean;
  readonly nonIncreasing: boolean;
  /** index of the first pair that broke strict monotonicity, or -1. */
  readonly firstBreakIndex: number;
  readonly periods: number;
}

/** Ordered point-in-time values only. Epsilon guards equality. */
export function testMonotonicity(series: TemporalSeries): MonotonicityResult | null {
  const vs = series.points.map((p) => p.value);
  if (vs.length < 2) return null;
  let strictInc = true;
  let nonDec = true;
  let strictDec = true;
  let nonInc = true;
  let firstBreakIndex = -1;
  for (let i = 1; i < vs.length; i += 1) {
    const d = vs[i]! - vs[i - 1]!;
    if (d <= EPS) strictInc = false;
    if (d < -EPS) nonDec = false;
    if (d >= -EPS) strictDec = false;
    if (d > EPS) nonInc = false;
    if (firstBreakIndex === -1 && d <= EPS && d >= -EPS) firstBreakIndex = i;
  }
  return {
    strictIncreasing: strictInc,
    nonDecreasing: nonDec,
    strictDecreasing: strictDec,
    nonIncreasing: nonInc,
    firstBreakIndex,
    periods: vs.length,
  };
}

// --- direction changes -------------------------------------------------

export interface DirectionChangeResult {
  readonly changes: number;
  /** indices (into points) where the sign of the period-to-period delta flipped. */
  readonly atIndexes: readonly number[];
  readonly periods: number;
}

export function detectDirectionChanges(series: TemporalSeries, epsilon = EPS): DirectionChangeResult | null {
  const vs = series.points.map((p) => p.value);
  if (vs.length < 3) return null;
  const signs: number[] = [];
  for (let i = 1; i < vs.length; i += 1) {
    const d = vs[i]! - vs[i - 1]!;
    signs.push(Math.abs(d) <= epsilon ? 0 : d > 0 ? 1 : -1);
  }
  const atIndexes: number[] = [];
  let last = 0;
  for (let i = 0; i < signs.length; i += 1) {
    const s = signs[i]!;
    if (s === 0) continue;
    if (last !== 0 && s !== last) atIndexes.push(i + 1);
    last = s;
  }
  return { changes: atIndexes.length, atIndexes, periods: vs.length };
}

// --- ranking / filtering by change --------------------------------

export type ChangeBasis = "absolute_change" | "percentage_change";

export interface ChangeRow {
  readonly key: string;
  readonly startValue: number;
  readonly endValue: number;
  readonly absoluteChange: number;
  readonly percentChange: number | null;
  readonly startCell: string;
  readonly endCell: string;
}

/** Builds a change row per series from its endpoints at the two given periods.
 *  Missing endpoints drop the series. */
export function changeRowsFor(
  seriesList: readonly { readonly key: string; readonly start: TemporalPoint | null; readonly end: TemporalPoint | null }[],
): ChangeRow[] {
  const out: ChangeRow[] = [];
  for (const s of seriesList) {
    if (!s.start || !s.end) continue;
    const cmp = comparePoints(s.start, s.end);
    out.push({
      key: s.key,
      startValue: s.start.value,
      endValue: s.end.value,
      absoluteChange: cmp.absoluteChange,
      percentChange: cmp.percentChange,
      startCell: s.start.cell,
      endCell: s.end.cell,
    });
  }
  return out;
}

/** Stage 24.8 §6/§13 — reads the exact computed field a plan ranks/filters on.
 *  The two "abs_*" fields are MAGNITUDE — direction-agnostic on purpose, so
 *  "наибольшее относительное изменение" is never silently reinterpreted as
 *  signed growth. Single source of truth, shared by ranking and filtering. */
export function rankingFieldValue(r: ChangeRow, field: RankingField): number | null {
  switch (field) {
    case "percentage_change":
      return r.percentChange;
    case "absolute_change":
      return r.absoluteChange;
    case "abs_percentage_change":
      return r.percentChange === null ? null : Math.abs(r.percentChange);
    case "abs_absolute_change":
      return Math.abs(r.absoluteChange);
    default:
      return null;
  }
}

export interface RankByChangeOpts {
  readonly basis: ChangeBasis;
  readonly direction: "asc" | "desc";
  readonly sign?: "positive" | "negative" | "any";
  readonly limit?: number;
}

export function rankByChange(rows: readonly ChangeRow[], opts: RankByChangeOpts): ChangeRow[] {
  const val = (r: ChangeRow): number | null =>
    opts.basis === "percentage_change" ? r.percentChange : r.absoluteChange;
  let filtered = rows.filter((r) => val(r) !== null);
  if (opts.sign === "positive") filtered = filtered.filter((r) => (val(r) as number) > EPS);
  if (opts.sign === "negative") filtered = filtered.filter((r) => (val(r) as number) < -EPS);
  filtered = [...filtered].sort((a, b) => {
    const av = val(a) as number;
    const bv = val(b) as number;
    return opts.direction === "asc" ? av - bv : bv - av;
  });
  return typeof opts.limit === "number" ? filtered.slice(0, opts.limit) : filtered;
}

/** Stage 24.8 §6/§10 — ranks by an arbitrary `RankingField` (including the
 *  magnitude variants `abs_percentage_change` / `abs_absolute_change`), with
 *  the SAME sign-filter / limit semantics as `rankByChange`. Shared by
 *  explicit-interval rank, single-winner strongest-growth/decline, and
 *  adjacent-event ranking — one primitive, not a special case per phrase. */
export function rankByField(
  rows: readonly ChangeRow[],
  opts: { readonly field: RankingField; readonly direction: "asc" | "desc"; readonly sign?: "positive" | "negative" | "any"; readonly limit?: number },
): ChangeRow[] {
  const val = (r: ChangeRow): number | null => rankingFieldValue(r, opts.field);
  let filtered = rows.filter((r) => val(r) !== null);
  if (opts.sign === "positive") filtered = filtered.filter((r) => (val(r) as number) > EPS);
  if (opts.sign === "negative") filtered = filtered.filter((r) => (val(r) as number) < -EPS);
  filtered = [...filtered].sort((a, b) => {
    const av = val(a) as number;
    const bv = val(b) as number;
    return opts.direction === "asc" ? av - bv : bv - av;
  });
  return typeof opts.limit === "number" ? filtered.slice(0, opts.limit) : filtered;
}

export interface FilterByChangeOpts {
  readonly basis: ChangeBasis;
  readonly mode: "magnitude" | "positive" | "negative";
  /** fraction for percentage_change (0.2 = 20%), raw units for absolute_change. */
  readonly threshold: number;
}

export function filterByChange(rows: readonly ChangeRow[], opts: FilterByChangeOpts): ChangeRow[] {
  const t = Math.abs(opts.threshold);
  return rows.filter((r) => {
    const v = opts.basis === "percentage_change" ? r.percentChange : r.absoluteChange;
    if (v === null) return false;
    if (opts.mode === "magnitude") return Math.abs(v) > t;
    if (opts.mode === "positive") return v > t;
    return v < -t;
  });
}

/** Stage 24.8 §12 — keeps rows whose SIGN on the given field matches the
 *  predicate ("positive" ⇒ > 0, "negative" ⇒ < 0). Shared by the two-interval
 *  predicate filter (called once per interval). */
export function signMatches(r: ChangeRow, field: RankingField, predicate: "positive" | "negative"): boolean {
  const v = rankingFieldValue(r, field);
  if (v === null) return false;
  return predicate === "positive" ? v > EPS : v < -EPS;
}

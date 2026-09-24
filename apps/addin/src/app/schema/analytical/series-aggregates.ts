import type { AnalysisEvent, TemporalSeries } from "./types.js";

const EPS = 1e-9;

export interface SeriesAggregate {
  readonly value: number;
  readonly periodCount: number;
}

/** Arithmetic mean over every available point. `null` when the series is empty. */
export function seriesMean(series: TemporalSeries): SeriesAggregate | null {
  const pts = series.points;
  if (pts.length === 0) return null;
  return { value: pts.reduce((s, p) => s + p.value, 0) / pts.length, periodCount: pts.length };
}

/** Sum over every available point. `null` when the series is empty. */
export function seriesSum(series: TemporalSeries): SeriesAggregate | null {
  const pts = series.points;
  if (pts.length === 0) return null;
  return { value: pts.reduce((s, p) => s + p.value, 0), periodCount: pts.length };
}

/**
 * Population standard deviation of the LEVELS. Distinct from
 * `computeVolatility`, which measures the dispersion of period-over-period
 * CHANGES — a metric can be highly dispersed in level and barely volatile, and
 * vice versa. Needs at least two points.
 */
export function seriesStdDev(series: TemporalSeries): SeriesAggregate | null {
  const pts = series.points;
  if (pts.length < 2) return null;
  const mean = pts.reduce((s, p) => s + p.value, 0) / pts.length;
  const variance = pts.reduce((s, p) => s + (p.value - mean) ** 2, 0) / pts.length;
  return { value: Math.sqrt(variance), periodCount: pts.length };
}

/**
 * The stability score derived from a volatility score: monotonically
 * decreasing in volatility, bounded in (0, 1], and defined for a zero score.
 * The exact expression the Stage 25 registry has always used.
 */
export function stabilityFromVolatility(volatilityScore: number): number {
  return 1 / (1 + volatilityScore);
}

export type TemporalPatternKind = "down_then_up" | "up_then_down";

export interface TemporalPatternMatch {
  readonly matched: boolean;
  /** Where the first leg ended, and where the reversal was confirmed. */
  readonly pivot1Period: string | null;
  readonly pivot2Period: string | null;
}

/**
 * Scans a metric's ordered adjacent-period events for a leg in one direction
 * followed LATER by a leg in the other.
 *
 * Documented policy (unchanged from Stage 25): the reversal may occur at any
 * later period, not only the immediately next one — everyday wording ("после
 * снижения снова начали расти") almost never means "in the very next period".
 * Flat legs are skipped rather than breaking the pattern.
 */
export function matchTemporalPattern(events: readonly AnalysisEvent[], pattern: TemporalPatternKind): TemporalPatternMatch {
  const firstSign = pattern === "down_then_up" ? -1 : 1;
  let pivot1: string | null = null;
  let pivot2: string | null = null;
  for (const e of events) {
    const sign = e.absoluteChange > EPS ? 1 : e.absoluteChange < -EPS ? -1 : 0;
    if (sign === 0) continue;
    if (pivot1 === null) {
      if (sign === firstSign) pivot1 = e.endPeriod.headerPath;
      continue;
    }
    if (sign === -firstSign) {
      pivot2 = e.endPeriod.headerPath;
      break;
    }
  }
  return { matched: pivot2 !== null, pivot1Period: pivot1, pivot2Period: pivot2 };
}

import { describe, expect, it } from "vitest";
import {
  argExtreme,
  changeRowsFor,
  comparePoints,
  computeTrend,
  computeVolatility,
  detectDirectionChanges,
  filterByChange,
  rankByChange,
  testMonotonicity,
} from "./temporal-primitives.js";
import type { TemporalPoint, TemporalSeries } from "./types.js";

function pt(period: string, value: number, i = 0): TemporalPoint {
  return { canonicalPeriod: period, periodLabel: period, value, raw: value, cell: `S!A${i + 1}`, rowIndex: i, colIndex: 0, percent: false };
}
function series(key: string, vals: readonly number[]): TemporalSeries {
  return { key, measureKind: "amount", percent: false, points: vals.map((v, i) => pt(`2025-0${i + 1}-01`, v, i)) };
}

describe("argExtreme", () => {
  it("returns the earliest period at the max / min (ties → earliest)", () => {
    const s = series("A", [10, 30, 20, 30]);
    expect(argExtreme(s, "max")?.point.value).toBe(30);
    expect(argExtreme(s, "max")?.point.canonicalPeriod).toBe("2025-02-01");
    expect(argExtreme(s, "min")?.point.value).toBe(10);
  });
});

describe("comparePoints", () => {
  it("computes absolute and percentage change from two point values", () => {
    const c = comparePoints(pt("a", 200), pt("b", 260));
    expect(c.absoluteChange).toBe(60);
    expect(c.percentChange).toBeCloseTo(0.3, 6);
  });
  it("returns null percent change when the base is zero", () => {
    expect(comparePoints(pt("a", 0), pt("b", 5)).percentChange).toBeNull();
  });
});

describe("computeTrend", () => {
  it("a straight climb has a positive normalised slope and r2 ~ 1", () => {
    const tr = computeTrend(series("C", [100, 110, 120, 130, 140]))!;
    expect(tr.direction).toBe("increasing");
    expect(tr.r2).toBeCloseTo(1, 3);
  });
  it("a straight decline is decreasing", () => {
    expect(computeTrend(series("C", [140, 130, 120, 110]))!.direction).toBe("decreasing");
  });
});

describe("computeVolatility / stability inverse", () => {
  const A = series("A", [100, 101, 99, 100, 101]);
  const B = series("B", [100, 150, 70, 180, 60]);
  const C = series("C", [100, 110, 120, 130, 140]);

  it("B is the most volatile, and stability is the exact inverse ranking of the same score", () => {
    const scores = [A, B, C].map((s) => {
      const v = computeVolatility(s, { measureKind: "amount" });
      return { key: s.key, score: "score" in v ? v.score : Number.POSITIVE_INFINITY };
    });
    const volatileDesc = [...scores].sort((a, b) => b.score - a.score).map((x) => x.key);
    const stableAsc = [...scores].sort((a, b) => a.score - b.score).map((x) => x.key);
    expect(volatileDesc[0]).toBe("B"); // most volatile
    expect(stableAsc.at(-1)).toBe("B"); // least stable
    expect(stableAsc).toEqual([...volatileDesc].reverse()); // same score, inverse order
  });

  it("is unavailable with fewer than 3 observations", () => {
    const r = computeVolatility(series("x", [1, 2]), { measureKind: "amount" });
    expect("unavailable" in r).toBe(true);
  });

  it("uses level-change std for a percentage series", () => {
    const pct: TemporalSeries = { key: "p", measureKind: "percentage", percent: true, points: [0.1, 0.2, 0.15, 0.3].map((v, i) => ({ ...pt("2025", v, i), percent: true })) };
    const r = computeVolatility(pct, { measureKind: "percentage" });
    expect("method" in r && r.method).toBe("std_level_change");
  });
});

describe("testMonotonicity", () => {
  it("classifies strict up / non-decreasing / strict down / zig-zag", () => {
    expect(testMonotonicity(series("A", [1, 2, 3, 4]))!.strictIncreasing).toBe(true);
    const b = testMonotonicity(series("B", [1, 2, 2, 3]))!;
    expect(b.strictIncreasing).toBe(false);
    expect(b.nonDecreasing).toBe(true);
    expect(testMonotonicity(series("C", [4, 3, 2, 1]))!.strictDecreasing).toBe(true);
    const d = testMonotonicity(series("D", [1, 3, 2, 4]))!;
    expect(d.strictIncreasing).toBe(false);
    expect(d.nonDecreasing).toBe(false);
  });
});

describe("detectDirectionChanges", () => {
  it("counts sign flips of the period-to-period delta", () => {
    expect(detectDirectionChanges(series("A", [1, 2, 3, 4]))!.changes).toBe(0);
    expect(detectDirectionChanges(series("Z", [1, 5, 2, 6, 3]))!.changes).toBe(3);
  });
});

describe("rankByChange / filterByChange", () => {
  const rows = changeRowsFor([
    { key: "A", start: pt("s", 100), end: pt("e", 130) }, // +30 / +30%
    { key: "B", start: pt("s", 100), end: pt("e", 90) }, // -10 / -10%
    { key: "C", start: pt("s", 100), end: pt("e", 125) }, // +25 / +25%
  ]);
  it("ranks positive movers descending by percentage change", () => {
    const r = rankByChange(rows, { basis: "percentage_change", direction: "desc", sign: "positive", limit: 2 });
    expect(r.map((x) => x.key)).toEqual(["A", "C"]);
  });
  it("filters by magnitude / positive / negative threshold", () => {
    expect(filterByChange(rows, { basis: "percentage_change", mode: "magnitude", threshold: 0.2 }).map((r) => r.key).sort()).toEqual(["A", "C"]);
    expect(filterByChange(rows, { basis: "percentage_change", mode: "negative", threshold: 0.05 }).map((r) => r.key)).toEqual(["B"]);
  });
});

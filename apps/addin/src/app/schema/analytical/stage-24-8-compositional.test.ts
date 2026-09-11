// Stage 24.8 — compositional analytics & analysis event memory.
// Focused automated coverage for the deterministic layer (§50–§56, §75):
//   explicit-period precedence, derived-ranking basis, sign filtering,
//   two-interval predicates + ordinal reuse, the adjacent-event engine, and
//   date-fidelity (no raw Excel serial ever reaches a rendered result).
import { describe, expect, it } from "vitest";
import { induceTableSchema, type TableSchema } from "../schema-induction.js";
import type { AnalysisGrids } from "../matrix-analysis.js";
import { fixtureBalanceLike, fixtureIntervalRanking, fixtureTwoIntervalAndEvents } from "../__fixtures__/tables.js";
import { runAnalyticalAnalysis, type AnalyticalRouteOutcome } from "./analytical-analysis.js";
import type { InheritedComposite, InheritedRanking } from "./analytical-compiler.js";
import { buildPeriodIndex } from "./period-index.js";
import { computeAdjacentPeriodEvents } from "./temporal-series.js";

function load(fx: ReturnType<typeof fixtureIntervalRanking>): { schema: TableSchema; grids: AnalysisGrids } {
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: `v@${fx.address}`,
    startsBelowRow1: fx.startsBelowRow1,
  });
  return { schema, grids: { values: fx.values, numberFormats: fx.numberFormats } };
}

function handled(o: AnalyticalRouteOutcome): Extract<AnalyticalRouteOutcome, { kind: "handled" }> {
  if (o.kind !== "handled") throw new Error(`expected handled, got ${o.kind}: ${JSON.stringify(o)}`);
  return o;
}

const rankFx = load(fixtureIntervalRanking());
const twoFx = load(fixtureTwoIntervalAndEvents());

describe("§50 — explicit-period precedence for rank/argmax_event (FAIL 31/33)", () => {
  it("an explicit interval on 'rank' wins over the default 'за последний месяц' horizon", () => {
    const o = handled(runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "Покажи 3 показателя с наибольшим относительным изменением между 01.01.2024 и 01.12.2025.", "ru"));
    expect(o.plan.operation).toBe("rank");
    expect(o.plan.interval).toBeDefined();
    expect(o.plan.period).toBeUndefined();
    expect(o.trace.requestedStart).toBe("2024-01-01");
    expect(o.trace.requestedEnd).toBe("2025-12-01");
    expect(o.trace.executedStart).toBe(o.trace.requestedStart);
    expect(o.trace.executedEnd).toBe(o.trace.requestedEnd);
    expect(o.trace.silentSubstitution).toBe(false);
    expect(o.execution.sections[0]!.title).not.toMatch(/за 1 месяц|Δ/);
  });

  it("an explicit interval wins even with an active inherited PeriodRef present", () => {
    const pi = buildPeriodIndex(rankFx.schema, rankFx.grids);
    const inherited = { start: pi.points[0]!, end: pi.points[1]! };
    const o = handled(
      runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "Какой показатель вырос сильнее всего между 01.01.2024 и 01.12.2025?", "ru", inherited),
    );
    expect(o.trace.requestedStart).toBe("2024-01-01");
    expect(o.trace.requestedEnd).toBe("2025-12-01");
  });
});

describe("§32/§33/§51/§52 — single-winner strongest growth / decline (FAIL 31/32)", () => {
  it("'вырос сильнее всего' → A (+40%), exact interval, no date confusion", () => {
    const o = handled(runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "Какой показатель вырос сильнее всего между 01.01.2024 и 01.12.2025?", "ru"));
    expect(o.plan.rankingField).toBe("percentage_change");
    const rows = o.execution.sections[0]!.rows;
    expect(rows.length).toBe(1);
    expect(rows[0]![0]).toBe("A");
    expect(rows[0]![4]).toBe("40%");
  });

  it("'снизился сильнее всего за этот же период' reuses the interval and picks C (-35%)", () => {
    const first = handled(runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "Какой показатель вырос сильнее всего между 01.01.2024 и 01.12.2025?", "ru"));
    const pi = buildPeriodIndex(rankFx.schema, rankFx.grids);
    const s = pi.points.find((p) => p.canonical === first.trace.executedStart)!;
    const e = pi.points.find((p) => p.canonical === first.trace.executedEnd)!;
    const o = handled(runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "Какой показатель снизился сильнее всего за этот же период?", "ru", { start: s, end: e }));
    const rows = o.execution.sections[0]!.rows;
    expect(rows[0]![0]).toBe("C");
    expect(rows[0]![4]).toBe("-35%");
  });
});

describe("§10/§34/§51 — top-K magnitude ranking, percentage vs absolute basis (FAIL 33/34)", () => {
  it("'наибольшим относительным изменением' ranks by |percentChange| — A, C, B (never last_month)", () => {
    const o = handled(runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "Покажи 3 показателя с наибольшим относительным изменением между 01.01.2024 и 01.12.2025.", "ru"));
    expect(o.plan.rankingField).toBe("abs_percentage_change");
    expect(o.execution.sections[0]!.rows.map((r) => r[0])).toEqual(["A", "C", "B"]);
  });

  it("the SAME scope/interval/limit 'по абсолютному изменению' ranks by |absoluteChange| — B, C, A", () => {
    const o = handled(runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "Покажи 3 показателя с наибольшим абсолютным изменением между 01.01.2024 и 01.12.2025.", "ru"));
    expect(o.plan.rankingField).toBe("abs_absolute_change");
    expect(o.execution.sections[0]!.rows.map((r) => r[0])).toEqual(["B", "C", "A"]);
  });

  it("§11/§30/§31 — 'те же 3, но по абсолютному изменению' reuses interval/limit via inheritedRanking", () => {
    const first = handled(runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "Покажи 3 показателя с наибольшим относительным изменением между 01.01.2024 и 01.12.2025.", "ru"));
    expect(first.rememberRanking).toBeDefined();
    const inheritedRanking: InheritedRanking = { interval: first.rememberRanking!.interval, limit: 3 };
    const o = handled(runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "А теперь покажи те же 3, но по абсолютному изменению.", "ru", undefined, undefined, inheritedRanking));
    expect(o.plan.operation).toBe("rank");
    expect(o.plan.rankingField).toBe("abs_absolute_change");
    expect(o.plan.interval!.start.canonical).toBe(first.rememberRanking!.interval.start.canonical);
    expect(o.execution.sections[0]!.rows.map((r) => r[0])).toEqual(["B", "C", "A"]);
  });

  it("'те же N' with no prior ranking to reuse fails closed, never silently picks a period", () => {
    const o = runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "А теперь покажи те же 5, но по абсолютному изменению.", "ru");
    expect(o.kind).toBe("error");
  });
});

describe("§12–§14/§37/§38/§53 — two-interval predicate filter (FAIL 37/38)", () => {
  it("grew in interval 1, declined in interval 2 → A only", () => {
    const o = handled(
      runAnalyticalAnalysis(
        twoFx.schema,
        twoFx.grids,
        "Покажи показатели, которые выросли с 01.01.2024 по 01.01.2025, но снизились с 01.01.2025 по 01.12.2025.",
        "ru",
      ),
    );
    expect(o.plan.operation).toBe("two_interval_filter");
    expect(o.execution.sections[0]!.rows.map((r) => r[0])).toEqual(["A"]);
    expect(o.rememberComposite).toBeDefined();
  });

  it("§38 — the ordinal follow-up 'в первом… во втором…' reuses the SAME two intervals, swaps predicates → B only", () => {
    const first = handled(
      runAnalyticalAnalysis(
        twoFx.schema,
        twoFx.grids,
        "Покажи показатели, которые выросли с 01.01.2024 по 01.01.2025, но снизились с 01.01.2025 по 01.12.2025.",
        "ru",
      ),
    );
    const inheritedComposite: InheritedComposite = { interval1: first.rememberComposite!.interval1, interval2: first.rememberComposite!.interval2 };
    const o = handled(
      runAnalyticalAnalysis(
        twoFx.schema,
        twoFx.grids,
        "Покажи показатели, которые снижались в первом интервале, но выросли во втором.",
        "ru",
        undefined,
        undefined,
        undefined,
        inheritedComposite,
      ),
    );
    expect(o.plan.predicateIntervals![0]!.interval.start.canonical).toBe(first.rememberComposite!.interval1.start.canonical);
    expect(o.plan.predicateIntervals![1]!.interval.start.canonical).toBe(first.rememberComposite!.interval2.start.canonical);
    expect(o.execution.sections[0]!.rows.map((r) => r[0])).toEqual(["B"]);
  });

  it("an ordinal reference with no prior two-interval analysis fails closed", () => {
    const o = runAnalyticalAnalysis(twoFx.schema, twoFx.grids, "Покажи показатели, которые снижались в первом интервале, но выросли во втором.", "ru");
    expect(o.kind).toBe("error");
  });
});

describe("§15–§19/§39/§54 — adjacent-period event engine (FAIL 39)", () => {
  it("ranks EVERY metric × EVERY adjacent pair — global max is B's second event (+50%), never last_month", () => {
    const o = handled(runAnalyticalAnalysis(twoFx.schema, twoFx.grids, "У какого показателя самое большое изменение между соседними датами?", "ru"));
    expect(o.plan.operation).toBe("argmax_event");
    expect(o.execution.events).toBeDefined();
    const winner = o.execution.events![0]!;
    expect(winner.metricKey).toBe("B");
    expect(winner.startPeriod.canonical).toBe("2025-01-01");
    expect(winner.endPeriod.canonical).toBe("2025-12-01");
    expect(winner.percentageChange).toBeCloseTo(0.5, 6);
    expect(o.winningEvent).toEqual(winner);
  });

  it("event magnitudes match the exact known series (§54) — ALL events, via the raw primitive (limit=1 only bounds the RANKED result)", () => {
    const pi = buildPeriodIndex(twoFx.schema, twoFx.grids);
    const subject = { kind: "each_column" as const, columns: twoFx.schema.columnPaths };
    const all = computeAdjacentPeriodEvents(twoFx.schema, twoFx.grids, subject, pi);
    expect(all.length).toBe(6); // 3 metrics x 2 adjacent pairs
    const byPair = (m: string, sIso: string) => all.find((e) => e.metricKey === m && e.startPeriod.canonical === sIso)!;
    expect(byPair("A", "2024-01-01").percentageChange).toBeCloseTo(0.4, 6);
    expect(byPair("A", "2025-01-01").percentageChange).toBeCloseTo(-40 / 140, 5); // 140->100
    expect(byPair("B", "2024-01-01").percentageChange).toBeCloseTo(-0.2, 6);
    expect(byPair("B", "2025-01-01").percentageChange).toBeCloseTo(0.5, 6);
  });
});

describe("§56 — date fidelity: no raw Excel serial ever reaches a rendered result", () => {
  it("interval-rank, argmax_event and two_interval_filter results never contain a raw serial like 45292/45992", () => {
    const outcomes = [
      runAnalyticalAnalysis(rankFx.schema, rankFx.grids, "Какой показатель вырос сильнее всего между 01.01.2024 и 01.12.2025?", "ru"),
      runAnalyticalAnalysis(twoFx.schema, twoFx.grids, "У какого показателя самое большое изменение между соседними датами?", "ru"),
      runAnalyticalAnalysis(
        twoFx.schema,
        twoFx.grids,
        "Покажи показатели, которые выросли с 01.01.2024 по 01.01.2025, но снизились с 01.01.2025 по 01.12.2025.",
        "ru",
      ),
    ];
    for (const o of outcomes) {
      const h = handled(o);
      const serialized = JSON.stringify(h.execution.sections);
      expect(serialized).not.toMatch(/4[45]\d{3}/);
      expect(serialized).toMatch(/\d{2}\.\d{2}\.\d{4}/);
    }
  });
});

describe("§58/§59/§60/§61/§62/§63 — Stage 24.7/24.7.1 regressions preserved on the Balance fixture", () => {
  const bal = load(fixtureBalanceLike());

  it("threshold and percentage-monthly ranking still work unmodified", () => {
    const filterOut = handled(runAnalyticalAnalysis(bal.schema, bal.grids, "Какие показатели изменились более чем на 20% между 01.01.2024 и 01.11.2025?", "ru"));
    expect(filterOut.plan.operation).toBe("filter");
    const rankOut = handled(runAnalyticalAnalysis(bal.schema, bal.grids, "Покажи 5 показателей с наибольшим ростом за последний месяц.", "ru"));
    expect(rankOut.plan.operation).toBe("rank");
    expect(rankOut.plan.period).toBeDefined();
    expect(rankOut.execution.sections[0]!.title).toMatch(/% изменение/);
  });

  it("no-silent-substitution still fails closed for an unavailable date", () => {
    const o = runAnalyticalAnalysis(bal.schema, bal.grids, "Сравни значения на 01.01.2023 и 01.11.2025.", "ru");
    expect(o.kind).not.toBe("handled");
  });
});

import type { CellValue } from "@sheet-agent/application";
import {
  computeDirectionChangeEvents,
  computeTrend,
  computeVolatility,
  testMonotonicity,
} from "../../app/schema/analytical/temporal-primitives.js";
import { computeAdjacentPeriodEvents } from "../../app/schema/analytical/temporal-series.js";
import { matchTemporalPattern, stabilityFromVolatility } from "../../app/schema/analytical/series-aggregates.js";
import { toolError } from "../types.js";
import { METRIC_FIELD, cell, isErr, metricScope, num, seriesOf, subjectOf, text, type ToolSpec } from "./contracts.js";
import { METRIC_REF_DESCRIBE, resolveMetricInput } from "./semantic-refs.js";

const METRIC_SCOPE_ARGS = {
  metrics: { type: "string[]", describe: "metric labels; omit to use inputRef or the whole table" },
  inputRef: { type: "resultRef", describe: "a result whose metric universe to reuse" },
} as const;

const SCOPE_ACCEPTS = ["metric_set", "comparison", "filtered_set", "ranked_set", "metric_winner", "aggregate", "trend", "volatility", "stability", "derived", "joined", "table"] as const;

const EVENT_FIELDS = [
  METRIC_FIELD,
  text("startPeriodLabel"),
  text("endPeriodLabel"),
  num("startValue"),
  num("endValue"),
  num("absoluteChange"),
  num("percentageChange"),
  cell("startCell"),
  cell("endCell"),
];

const analysisTrend: ToolSpec = {
  name: "analysis.trend",
  capability: "statistics",
  description:
    'The overall direction of each metric over its whole history: a fitted slope, a scale-free normalised slope, a direction label ("increasing"/"decreasing"/"flat") and the fit quality r2. Returns a trend result with one row per metric. Use it to establish WHETHER something grew; combine it with analysis.stability or analysis.volatility to say HOW SMOOTHLY it grew.',
  args: { ...METRIC_SCOPE_ARGS },
  returns: "trend",
  accepts: [...SCOPE_ACCEPTS],
  reads: true,
  run: (args, env) => {
    const scope = metricScope(args, env);
    if (isErr(scope)) return scope.error;
    const rows: CellValue[][] = [];
    const skipped: string[] = [];
    for (const m of scope.members) {
      const series = seriesOf(env, m);
      const t = series ? computeTrend(series) : null;
      if (!t) {
        skipped.push(m.display);
        continue;
      }
      rows.push([m.display, t.slope, t.normalizedSlope, t.direction, t.r2, t.periods]);
    }
    if (rows.length === 0) return toolError("INCOMPATIBLE_INPUT", "no metric has enough points to fit a trend");
    return {
      ok: true,
      result: env.store.put({
        tool: "analysis.trend",
        type: "trend",
        fields: [METRIC_FIELD, num("slope"), num("normalizedSlope"), text("direction"), num("r2"), num("periods")],
        rows,
        parents: scope.parents,
        ...(skipped.length > 0 ? { metadata: { skipped } } : {}),
      }),
    };
  },
};

function volStab(name: "analysis.volatility" | "analysis.stability"): ToolSpec {
  const volatile = name === "analysis.volatility";
  return {
    name,
    capability: "statistics",
    description: volatile
      ? "How much each metric moves from period to period — a higher score means bigger, more erratic swings. Returns a volatility result with one row per metric. Use it for \"most unstable/erratic\" questions, and rank it with set.argmax."
      : "How smooth each metric's period-to-period movement is — a higher score means steadier. Returns a stability result with one row per metric. It is the inverse of volatility, so ranking stability descending and volatility ascending pick the same metric. It says nothing about DIRECTION, so pair it with analysis.trend when the request is about steady GROWTH.",
    args: { ...METRIC_SCOPE_ARGS },
    returns: volatile ? "volatility" : "stability",
    accepts: [...SCOPE_ACCEPTS],
    reads: true,
    run: (args, env) => {
      const scope = metricScope(args, env);
      if (isErr(scope)) return scope.error;
      const rows: CellValue[][] = [];
      const details: Record<string, { readonly method: string; readonly periods: number; readonly largestSwing: number; readonly largestSwingFrom: string; readonly largestSwingTo: string }> = {};
      const skipped: string[] = [];
      for (const m of scope.members) {
        const series = seriesOf(env, m);
        if (!series) {
          skipped.push(m.display);
          continue;
        }
        const v = computeVolatility(series, { measureKind: series.measureKind });
        if ("unavailable" in v) {
          skipped.push(m.display);
          continue;
        }
        rows.push([m.display, volatile ? v.score : stabilityFromVolatility(v.score)]);
        details[m.display] = {
          method: v.method,
          periods: v.periods,
          largestSwing: v.largestSwing,
          largestSwingFrom: v.largestSwingFrom.periodLabel,
          largestSwingTo: v.largestSwingTo.periodLabel,
        };
      }
      if (rows.length === 0) return toolError("INCOMPATIBLE_INPUT", "no metric has enough points to score");
      return {
        ok: true,
        result: env.store.put({
          tool: name,
          type: volatile ? "volatility" : "stability",
          fields: [METRIC_FIELD, num("score")],
          rows,
          parents: scope.parents,
          metadata: { volatilityDetails: details, ...(skipped.length > 0 ? { skipped } : {}) },
        }),
      };
    },
  };
}

const analysisMonotonicity: ToolSpec = {
  name: "analysis.monotonicity",
  capability: "statistics",
  description:
    "Whether each metric moved in ONE direction the whole time: flags for strictly increasing, strictly decreasing, non-decreasing and non-increasing (1 or 0), plus how many periods were tested. Returns a monotonicity result. Use it for \"never fell\" / \"grew every period\" style conditions, filtered with set.filter on the flag you need.",
  args: { ...METRIC_SCOPE_ARGS },
  returns: "monotonicity",
  accepts: [...SCOPE_ACCEPTS],
  reads: true,
  run: (args, env) => {
    const scope = metricScope(args, env);
    if (isErr(scope)) return scope.error;
    const rows: CellValue[][] = [];
    for (const m of scope.members) {
      const series = seriesOf(env, m);
      const mono = series ? testMonotonicity(series) : null;
      if (!mono) continue;
      rows.push([m.display, mono.strictIncreasing ? 1 : 0, mono.strictDecreasing ? 1 : 0, mono.nonDecreasing ? 1 : 0, mono.nonIncreasing ? 1 : 0, mono.periods]);
    }
    if (rows.length === 0) return toolError("INCOMPATIBLE_INPUT", "no metric has enough points to test monotonicity");
    return {
      ok: true,
      result: env.store.put({
        tool: "analysis.monotonicity",
        type: "monotonicity",
        fields: [METRIC_FIELD, num("strictIncreasing"), num("strictDecreasing"), num("nonDecreasing"), num("nonIncreasing"), num("periods")],
        rows,
        parents: scope.parents,
      }),
    };
  },
};

const analysisDirectionChanges: ToolSpec = {
  name: "analysis.direction_changes",
  capability: "statistics",
  description:
    "How many times each metric reversed direction, and at which periods. Returns a direction_changes result with one row per metric. Use it for \"most erratic\" / \"kept flipping\" questions; rank it with set.argmax on directionChangeCount.",
  args: { ...METRIC_SCOPE_ARGS },
  returns: "direction_changes",
  accepts: [...SCOPE_ACCEPTS],
  reads: true,
  run: (args, env) => {
    const scope = metricScope(args, env);
    if (isErr(scope)) return scope.error;
    const rows: CellValue[][] = [];
    for (const m of scope.members) {
      const series = seriesOf(env, m);
      if (!series) continue;
      const dc = computeDirectionChangeEvents(series);
      rows.push([m.display, dc.changes, dc.events.map((e) => e.pivotHeaderPath).join("; ")]);
    }
    if (rows.length === 0) return toolError("INCOMPATIBLE_INPUT", "no metric has enough points to detect direction changes");
    return {
      ok: true,
      result: env.store.put({
        tool: "analysis.direction_changes",
        type: "direction_changes",
        fields: [METRIC_FIELD, num("directionChangeCount"), text("periods")],
        rows,
        parents: scope.parents,
      }),
    };
  },
};

const analysisTemporalPattern: ToolSpec = {
  name: "analysis.temporal_pattern",
  capability: "statistics",
  description:
    'Flag metrics whose history contains a fall later followed by a rise ("down_then_up"), or a rise later followed by a fall ("up_then_down"), reporting where each leg turned. Returns a temporal_pattern result with matched = 1 or 0 per metric; filter it with set.filter on matched. The reversal may happen at ANY later period, not only the immediately next one.',
  args: {
    pattern: { type: "string", required: true, describe: '"down_then_up" | "up_then_down"' },
    ...METRIC_SCOPE_ARGS,
  },
  returns: "temporal_pattern",
  accepts: [...SCOPE_ACCEPTS],
  reads: true,
  run: (args, env) => {
    const pattern = args["pattern"];
    if (pattern !== "down_then_up" && pattern !== "up_then_down") {
      return toolError("INVALID_ARGUMENT", '"pattern" must be "down_then_up" or "up_then_down"', ["down_then_up", "up_then_down"]);
    }
    const scope = metricScope(args, env);
    if (isErr(scope)) return scope.error;
    const rows: CellValue[][] = [];
    for (const m of scope.members) {
      const events = computeAdjacentPeriodEvents(env.schema, env.grids, subjectOf(m), env.periodIndex);
      const match = matchTemporalPattern(events, pattern);
      rows.push([m.display, match.matched ? 1 : 0, match.pivot1Period ?? "", match.pivot2Period ?? ""]);
    }
    return {
      ok: true,
      result: env.store.put({
        tool: "analysis.temporal_pattern",
        type: "temporal_pattern",
        fields: [METRIC_FIELD, num("matched"), text("pivot1Period"), text("pivot2Period")],
        rows,
        parents: scope.parents,
        metadata: { pattern },
      }),
    };
  },
};

const eventAdjacentChanges: ToolSpec = {
  name: "event.adjacent_changes",
  capability: "extrema",
  description:
    "Every period-to-period move of ONE metric — each neighbouring pair with its start and end values, absolute and percentage change. Returns an event_set whose rows are MOVES, not metrics. Use it to show a metric's full movement history; use event.max_adjacent_change when only the biggest move matters.",
  args: {
    metric: { type: "string", describe: "the metric label" },
    metricRef: { type: "metricRef", describe: METRIC_REF_DESCRIBE },
  },
  returns: "event_set",
  reads: true,
  run: (args, env) => {
    const picked = resolveMetricInput(args, env);
    if (isErr(picked)) return picked.error;
    const member = picked.value;
    const events = computeAdjacentPeriodEvents(env.schema, env.grids, subjectOf(member), env.periodIndex);
    if (events.length === 0) return toolError("INCOMPATIBLE_INPUT", `"${member.display}" has fewer than two comparable periods`);
    return {
      ok: true,
      result: env.store.put({
        tool: "event.adjacent_changes",
        type: "event_set",
        fields: EVENT_FIELDS,
        rows: events.map(
          (e) => [e.metricKey, e.startPeriod.headerPath, e.endPeriod.headerPath, e.startValue, e.endValue, e.absoluteChange, e.percentageChange, e.startCell, e.endCell] as readonly CellValue[],
        ),
        metricKeys: [member.display],
        periodCanonicals: [events[0]!.startPeriod.canonical, events[events.length - 1]!.endPeriod.canonical],
        parents: picked.parents,
      }),
    };
  },
};

function adjacentExtreme(name: "event.max_adjacent_change" | "event.min_adjacent_change", which: "max" | "min"): ToolSpec {
  return {
    name,
    capability: "extrema",
    description:
      which === "max"
        ? 'The pair of NEIGHBOURING periods where one metric moved the most, with both values and the size of the move. Returns a one-row event result. Use it for "when was the biggest jump/drop" — note this is a move between two adjacent periods, which is usually NOT the same pair as an overall latest-vs-previous comparison. basis="percentage" compares relative moves, basis="absolute" raw amounts.'
        : "The pair of neighbouring periods where one metric moved the LEAST. Returns a one-row event result.",
    args: {
      metric: { type: "string", describe: "the metric label" },
      metricRef: { type: "metricRef", describe: METRIC_REF_DESCRIBE },
      basis: { type: "string", describe: '"percentage" (default) | "absolute"' },
    },
    returns: "event",
    reads: true,
    run: (args, env) => {
      const picked = resolveMetricInput(args, env);
      if (isErr(picked)) return picked.error;
      const member = picked.value;
      const basisRaw = args["basis"];
      if (basisRaw !== undefined && basisRaw !== "percentage" && basisRaw !== "absolute") {
        return toolError("INVALID_ARGUMENT", '"basis" must be "percentage" or "absolute"', ["percentage", "absolute"]);
      }
      const basis = basisRaw === "absolute" ? "absolute" : "percentage";
      const events = computeAdjacentPeriodEvents(env.schema, env.grids, subjectOf(member), env.periodIndex);
      if (events.length === 0) return toolError("INCOMPATIBLE_INPUT", `"${member.display}" has fewer than two comparable periods`);
      const mag = (e: (typeof events)[number]): number =>
        basis === "absolute" ? Math.abs(e.absoluteChange) : e.percentageChange === null ? -Infinity : Math.abs(e.percentageChange);
      let best = events[0]!;
      for (const e of events) {
        const better = which === "max" ? mag(e) > mag(best) : mag(e) < mag(best) && mag(e) > -Infinity;
        if (better) best = e;
      }
      return {
        ok: true,
        result: env.store.put({
          tool: name,
          type: "event",
          fields: EVENT_FIELDS,
          rows: [[best.metricKey, best.startPeriod.headerPath, best.endPeriod.headerPath, best.startValue, best.endValue, best.absoluteChange, best.percentageChange, best.startCell, best.endCell]],
          metricKeys: [best.metricKey],
          periodCanonicals: [best.startPeriod.canonical, best.endPeriod.canonical],
          parents: picked.parents,
          metadata: { basis, candidateCount: events.length },
        }),
      };
    },
  };
}

export const TEMPORAL_EVENT_TOOLS: readonly ToolSpec[] = [
  analysisTrend,
  volStab("analysis.volatility"),
  volStab("analysis.stability"),
  analysisMonotonicity,
  analysisDirectionChanges,
  analysisTemporalPattern,
  eventAdjacentChanges,
  adjacentExtreme("event.max_adjacent_change", "max"),
  adjacentExtreme("event.min_adjacent_change", "min"),
];

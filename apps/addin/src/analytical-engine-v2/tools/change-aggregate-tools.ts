// ---------------------------------------------------------------------------
// Stage 26.2 §3/§4 — CHANGE and AGGREGATE tools.
//
// Change arithmetic comes from `comparePoints` / `compareMetricSetAtTwoPoints`
// (the same primitives every Stage 24/25 comparison has always used), and the
// aggregates from `seriesExtrema` and `series-aggregates.ts`. Nothing here
// computes a percentage or a mean itself.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import { seriesExtrema, comparePoints } from "../../app/schema/analytical/temporal-primitives.js";
import { compareMetricSetAtTwoPoints, getPointValue } from "../../app/schema/analytical/temporal-series.js";
import { seriesMean, seriesStdDev, seriesSum } from "../../app/schema/analytical/series-aggregates.js";
import { toolError } from "../types.js";
import { METRIC_FIELD, cell, isErr, metricScope, num, seriesOf, text, type ToolSpec } from "./contracts.js";
import { METRIC_REF_DESCRIBE, PERIOD_REF_DESCRIBE, resolveMetricInput, resolvePeriodInput } from "./semantic-refs.js";

const COMPARISON_FIELDS = [METRIC_FIELD, num("startValue"), num("endValue"), num("absoluteChange"), num("percentageChange"), cell("startCell"), cell("endCell")];

const METRIC_SCOPE_ARGS = {
  metrics: { type: "string[]", describe: "metric labels; omit to use inputRef or the whole table" },
  inputRef: { type: "resultRef", describe: "a result whose metric universe to reuse — this is how you keep a follow-up restricted to the previous candidate set" },
} as const;

const SCOPE_ACCEPTS = ["metric_set", "comparison", "filtered_set", "ranked_set", "metric_winner", "aggregate", "trend", "volatility", "stability", "derived", "joined", "table"] as const;

const changeComparePeriods: ToolSpec = {
  name: "change.compare_periods",
  description:
    "Compare metrics between TWO periods: start value, end value, absolute change and percentage change, one row per metric. Returns a comparison result — the usual starting point for 'what changed', and the input you then filter or rank. Pass inputRef to compare only the metrics of an earlier result instead of the whole table.",
  args: {
    startPeriod: { type: "string", describe: "canonical period (earlier)" },
    startPeriodRef: { type: "periodRef", describe: PERIOD_REF_DESCRIBE },
    endPeriod: { type: "string", describe: "canonical period (later)" },
    endPeriodRef: { type: "periodRef", describe: PERIOD_REF_DESCRIBE },
    ...METRIC_SCOPE_ARGS,
  },
  returns: "comparison",
  accepts: [...SCOPE_ACCEPTS],
  reads: true,
  run: (args, env) => {
    const startPicked = resolvePeriodInput(args, env, "startPeriod");
    if (isErr(startPicked)) return startPicked.error;
    const start = startPicked.value;
    const endPicked = resolvePeriodInput(args, env, "endPeriod");
    if (isErr(endPicked)) return endPicked.error;
    const end = endPicked.value;
    const scope = metricScope(args, env);
    if (isErr(scope)) return scope.error;

    const pairs = compareMetricSetAtTwoPoints(env.schema, env.grids, { kind: "metric_set", members: [...scope.members] }, start, end);
    const rows: CellValue[][] = [];
    for (const pair of pairs) {
      if (!pair.start || !pair.end) continue;
      const cmp = comparePoints(pair.start, pair.end);
      rows.push([pair.key, pair.start.value, pair.end.value, cmp.absoluteChange, cmp.percentChange, pair.start.cell, pair.end.cell]);
    }
    if (rows.length === 0) return toolError("INCOMPATIBLE_INPUT", "no metric has a value at both of those periods");
    return {
      ok: true,
      result: env.store.put({
        tool: "change.compare_periods",
        type: "comparison",
        fields: COMPARISON_FIELDS,
        rows,
        periodCanonicals: [start.canonical, end.canonical],
        parents: [...scope.parents, ...startPicked.parents, ...endPicked.parents],
        metadata: { startLabel: start.headerPath, endLabel: end.headerPath },
      }),
    };
  },
};

const changeCompute: ToolSpec = {
  name: "change.compute",
  description:
    "The change of ONE metric between two periods — absolute and percentage, with both source cells. Returns a comparison result of one row. Use it when the request is about a single named metric; use change.compare_periods when several metrics must be compared with each other.",
  args: {
    metric: { type: "string", describe: "the metric label" },
    metricRef: { type: "metricRef", describe: METRIC_REF_DESCRIBE },
    startPeriod: { type: "string", describe: "canonical period (earlier)" },
    startPeriodRef: { type: "periodRef", describe: PERIOD_REF_DESCRIBE },
    endPeriod: { type: "string", describe: "canonical period (later)" },
    endPeriodRef: { type: "periodRef", describe: PERIOD_REF_DESCRIBE },
  },
  returns: "comparison",
  reads: true,
  run: (args, env) => {
    const picked = resolveMetricInput(args, env);
    if (isErr(picked)) return picked.error;
    const member = picked.value;
    const startPicked = resolvePeriodInput(args, env, "startPeriod");
    if (isErr(startPicked)) return startPicked.error;
    const start = startPicked.value;
    const endPicked = resolvePeriodInput(args, env, "endPeriod");
    if (isErr(endPicked)) return endPicked.error;
    const end = endPicked.value;
    const subject = { kind: "row_axis_member", member } as const;
    const a = getPointValue(env.schema, env.grids, subject, start);
    const b = getPointValue(env.schema, env.grids, subject, end);
    if (!a || !b) return toolError("INCOMPATIBLE_INPUT", `"${member.display}" has no value at one of those periods`);
    const cmp = comparePoints(a, b);
    return {
      ok: true,
      result: env.store.put({
        tool: "change.compute",
        type: "comparison",
        fields: COMPARISON_FIELDS,
        rows: [[member.display, a.value, b.value, cmp.absoluteChange, cmp.percentChange, a.cell, b.cell]],
        metricKeys: [member.display],
        periodCanonicals: [start.canonical, end.canonical],
        parents: [...picked.parents, ...startPicked.parents, ...endPicked.parents],
      }),
    };
  },
};

type AggKind = "sum" | "avg" | "min" | "max" | "std";

const AGG_DESCRIPTION: Readonly<Record<AggKind, string>> = {
  sum: "Total of each metric across every available period.",
  avg: "Arithmetic mean of each metric across every available period. Use it as the baseline when the request compares a metric's current level with its own typical level.",
  min: "Each metric's lowest observed value, with the period and cell it occurred in.",
  max: "Each metric's highest observed value, with the period and cell it occurred in. Use it when the request is about distance from a historical peak.",
  std: "Standard deviation of each metric's LEVELS across periods. This measures spread of the values themselves — for the size of period-to-period movement use analysis.volatility instead.",
};

function aggregate(kind: AggKind): ToolSpec {
  const extremum = kind === "min" || kind === "max";
  return {
    name: `aggregate.${kind}`,
    description: `${AGG_DESCRIPTION[kind]} Takes metrics (or an inputRef whose metric universe to reuse) and returns an aggregate result with one row per metric, which you can then rank or filter.`,
    args: { ...METRIC_SCOPE_ARGS },
    returns: "aggregate",
    accepts: [...SCOPE_ACCEPTS],
    reads: true,
    run: (args, env) => {
      const scope = metricScope(args, env);
      if (isErr(scope)) return scope.error;
      const rows: CellValue[][] = [];
      const skipped: string[] = [];
      for (const m of scope.members) {
        const series = seriesOf(env, m);
        if (!series) {
          skipped.push(m.display);
          continue;
        }
        if (extremum) {
          const ex = seriesExtrema(series);
          if (!ex) {
            skipped.push(m.display);
            continue;
          }
          const p = kind === "max" ? ex.max : ex.min;
          rows.push([m.display, p.value, p.periodLabel, p.cell]);
          continue;
        }
        const agg = kind === "sum" ? seriesSum(series) : kind === "avg" ? seriesMean(series) : seriesStdDev(series);
        if (!agg) {
          skipped.push(m.display);
          continue;
        }
        rows.push([m.display, agg.value, agg.periodCount]);
      }
      if (rows.length === 0) return toolError("INCOMPATIBLE_INPUT", `no metric has enough points for aggregate.${kind}`);
      return {
        ok: true,
        result: env.store.put({
          tool: `aggregate.${kind}`,
          type: "aggregate",
          fields: extremum ? [METRIC_FIELD, num("value"), text("periodLabel"), cell("sourceCell")] : [METRIC_FIELD, num("value"), num("periodCount")],
          rows,
          parents: scope.parents,
          metadata: { aggregate: kind, ...(skipped.length > 0 ? { skipped } : {}) },
        }),
      };
    },
  };
}

export const CHANGE_AGGREGATE_TOOLS: readonly ToolSpec[] = [
  changeComparePeriods,
  changeCompute,
  aggregate("sum"),
  aggregate("avg"),
  aggregate("min"),
  aggregate("max"),
  aggregate("std"),
];

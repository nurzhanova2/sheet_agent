import type { CellValue } from "@sheet-agent/application";
import { normalizeDateText } from "../../app/schema/analytical/period-resolver.js";
import { getPointValue } from "../../app/schema/analytical/temporal-series.js";
import { toolError } from "../types.js";
import { METRIC_FIELD, cell, isErr, metricScope, num, period, seriesOf, sortedPoints, text, type ToolEnv, type ToolSpec } from "./contracts.js";
import { METRIC_REF_DESCRIBE, PERIOD_REF_DESCRIBE, resolveMetricInput, resolvePeriodInput } from "./semantic-refs.js";

function periodResult(
  env: ToolEnv,
  tool: string,
  points: readonly { readonly canonical: string; readonly headerPath: string }[],
  type: "period" | "period_range" = "period",
  parents: readonly string[] = [],
) {
  return env.store.put({
    tool,
    type,
    fields: [period("period"), text("label")],
    rows: points.map((p) => [p.canonical, p.headerPath] as readonly CellValue[]),
    metricKeys: [],
    periodCanonicals: points.map((p) => p.canonical),
    parents,
  });
}

const periodList: ToolSpec = {
  name: "period.list",
  capability: "periods",
  description:
    "List every period of the table, oldest first. Takes no input and returns a period result whose rows are canonical period strings with their displayed headers. Use it to see what periods exist before choosing one.",
  args: {},
  returns: "period",
  reads: false,
  run: (_args, env) => ({ ok: true, result: periodResult(env, "period.list", sortedPoints(env)) }),
};

const periodLatest: ToolSpec = {
  name: "period.latest",
  capability: "periods",
  description:
    'The most recent period of the table. Takes no input and returns a one-row period result. Use it whenever the request says "the latest date", "the last period" or similar — never write a date yourself.',
  args: {},
  returns: "period",
  reads: false,
  run: (_args, env) => {
    const pts = sortedPoints(env);
    const last = pts[pts.length - 1];
    if (!last) return toolError("INCOMPATIBLE_INPUT", "this table has no dated periods");
    return { ok: true, result: periodResult(env, "period.latest", [last]) };
  },
};

function neighbour(name: "period.previous" | "period.next", direction: -1 | 1): ToolSpec {
  return {
    name,
    capability: "periods",
    description:
      direction === -1
        ? 'The period immediately BEFORE the given one. Takes a canonical period and returns a one-row period result. Use it with period.latest to build a "latest vs previous" comparison.'
        : "The period immediately AFTER the given one. Takes a canonical period and returns a one-row period result.",
    args: {
      of: { type: "string", describe: "a canonical period string from another period.* tool" },
      ofRef: { type: "periodRef", describe: PERIOD_REF_DESCRIBE },
    },
    returns: "period",
    reads: false,
    run: (args, env) => {
      const picked = resolvePeriodInput(args, env, "of");
      if (isErr(picked)) return picked.error;
      const of = picked.value;
      const pts = sortedPoints(env);
      const i = pts.findIndex((p) => p.canonical === of.canonical);
      const target = pts[i + direction];
      if (!target) {
        return toolError("AMBIGUOUS_PERIOD", `"${of.canonical}" is the ${direction === -1 ? "earliest" : "latest"} period — there is nothing ${direction === -1 ? "before" : "after"} it`);
      }
      return { ok: true, result: periodResult(env, name, [target], "period", picked.parents) };
    },
  };
}

const periodResolve: ToolSpec = {
  name: "period.resolve",
  capability: "periods",
  description:
    'Turn a date the user wrote ("01.12.2025", "2025-12-01", "December 2025") into the table\'s canonical period. Returns a one-row period result. Use it when the request names an explicit date; if that date is not a period of this table the tool refuses and lists the real ones rather than picking a nearby date.',
  args: { text: { type: "string", required: true, describe: "the date or period label the user wrote" } },
  returns: "period",
  reads: false,
  run: (args, env) => {
    const raw = args["text"];
    if (typeof raw !== "string" || raw.trim() === "") return toolError("INVALID_ARGUMENT", '"text" must be a non-empty date or period label');
    const pts = sortedPoints(env);
    const normalized = normalizeDateText(raw);
    const match =
      pts.find((p) => p.canonical === raw) ??
      (normalized ? pts.find((p) => p.canonical === normalized) : undefined) ??
      pts.find((p) => p.headerPath === raw) ??
      pts.find((p) => p.headerPath.toLowerCase() === raw.trim().toLowerCase());
    if (!match) return toolError("AMBIGUOUS_PERIOD", `"${raw}" is not a period of this table`, pts.map((p) => p.canonical));
    return { ok: true, result: periodResult(env, "period.resolve", [match]) };
  },
};

const periodRange: ToolSpec = {
  name: "period.range",
  capability: "periods",
  description:
    "The inclusive span between two canonical periods, oldest first. Returns a period_range result. Use it when an analysis should be restricted to a window rather than the whole history.",
  args: {
    startPeriod: { type: "string", describe: "canonical period (earlier)" },
    startPeriodRef: { type: "periodRef", describe: PERIOD_REF_DESCRIBE },
    endPeriod: { type: "string", describe: "canonical period (later)" },
    endPeriodRef: { type: "periodRef", describe: PERIOD_REF_DESCRIBE },
  },
  returns: "period_range",
  reads: false,
  run: (args, env) => {
    const start = resolvePeriodInput(args, env, "startPeriod");
    if (isErr(start)) return start.error;
    const end = resolvePeriodInput(args, env, "endPeriod");
    if (isErr(end)) return end.error;
    const pts = sortedPoints(env);
    const a = pts.findIndex((p) => p.canonical === start.value.canonical);
    const b = pts.findIndex((p) => p.canonical === end.value.canonical);
    const span = pts.slice(Math.min(a, b), Math.max(a, b) + 1);
    return { ok: true, result: periodResult(env, "period.range", span, "period_range", [...start.parents, ...end.parents]) };
  },
};

const valueAtPeriod: ToolSpec = {
  name: "value.at_period",
  capability: "read_values",
  description:
    "The value of one or more metrics at ONE period, with the source cell. Takes metrics (or an inputRef whose metric universe to reuse) plus a canonical period, and returns a value result with one row per metric. Use it for a point lookup; use series.get when you need the whole history.",
  args: {
    period: { type: "string", describe: "canonical period string" },
    periodRef: { type: "periodRef", describe: PERIOD_REF_DESCRIBE },
    metrics: { type: "string[]", describe: "metric labels; omit to use inputRef or the whole table" },
    inputRef: { type: "resultRef", describe: "a result whose metric universe to reuse" },
  },
  returns: "value",
  accepts: ["metric_set", "comparison", "filtered_set", "ranked_set", "metric_winner", "aggregate", "derived", "joined", "table"],
  reads: true,
  run: (args, env) => {
    const picked = resolvePeriodInput(args, env, "period");
    if (isErr(picked)) return picked.error;
    const at = picked.value;
    const scope = metricScope(args, env);
    if (isErr(scope)) return scope.error;
    const rows: CellValue[][] = [];
    const missing: string[] = [];
    for (const m of scope.members) {
      const point = getPointValue(env.schema, env.grids, { kind: "row_axis_member", member: m }, at);
      if (!point) {
        missing.push(m.display);
        continue;
      }
      rows.push([m.display, point.value, point.periodLabel, point.cell]);
    }
    if (rows.length === 0) return toolError("INCOMPATIBLE_INPUT", `no metric has a value at ${at.canonical}`);
    return {
      ok: true,
      result: env.store.put({
        tool: "value.at_period",
        type: "value",
        fields: [METRIC_FIELD, num("value"), text("periodLabel"), cell("sourceCell")],
        rows,
        periodCanonicals: [at.canonical],
        parents: [...scope.parents, ...picked.parents],
        ...(missing.length > 0 ? { metadata: { missing } } : {}),
      }),
    };
  },
};

const seriesGet: ToolSpec = {
  name: "series.get",
  capability: "series",
  description:
    "The full time series of ONE metric across every available period, with source cells. Returns a series result whose rows are PERIODS, not metrics — so it cannot be filtered or ranked by a per-metric field; use it to show a metric's history, and use event.* or analysis.* tools to characterise it.",
  args: {
    metric: { type: "string", describe: "the metric label" },
    metricRef: { type: "metricRef", describe: METRIC_REF_DESCRIBE },
  },
  returns: "series",
  reads: true,
  run: (args, env) => {
    const picked = resolveMetricInput(args, env);
    if (isErr(picked)) return picked.error;
    const member = picked.value;
    const series = seriesOf(env, member);
    if (!series || series.points.length === 0) return toolError("INCOMPATIBLE_INPUT", `"${member.display}" has no numeric values across periods`);
    const rows: CellValue[][] = series.points.map((p) => [series.key, p.canonicalPeriod, p.periodLabel, p.value, p.cell]);
    return {
      ok: true,
      result: env.store.put({
        tool: "series.get",
        type: "series",
        fields: [METRIC_FIELD, period("period"), text("periodLabel"), num("value"), cell("sourceCell")],
        rows,
        metricKeys: [series.key],
        periodCanonicals: [series.points[0]!.canonicalPeriod, series.points[series.points.length - 1]!.canonicalPeriod],
        // §11 — a dereferenced metric is a real lineage edge.
        parents: picked.parents,
        metadata: { metric: series.key },
      }),
    };
  },
};

export const PERIOD_VALUE_TOOLS: readonly ToolSpec[] = [
  periodList,
  periodLatest,
  neighbour("period.previous", -1),
  neighbour("period.next", 1),
  periodResolve,
  periodRange,
  valueAtPeriod,
  seriesGet,
];

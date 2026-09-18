// ---------------------------------------------------------------------------
// Stage 26.2 §3/§4 — SCHEMA and METRIC tools.
//
// Adapters over `schema-induction`, `metric-resolver` and
// `measure-compatibility`. §28's semantic classes are exposed through
// `metric.filter` so a request like "ignore the percentage indicators" is a
// TOOL ARGUMENT, not a phrase handler.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import { isPercentNumberFormat } from "../../app/schema/excel-date.js";
import { classifySemanticMetricClass, isPercentageLike, type SemanticMetricClass } from "../../app/schema/measure-compatibility.js";
import type { RowAxisMember } from "../../app/schema/schema-induction.js";
import { toolError } from "../types.js";
import { METRIC_FIELD, allMetricLabels, isErr, memberFor, metricScope, resolveSetPhrase, sortedPoints, text, type ToolEnv, type ToolSpec } from "./contracts.js";

function classOf(env: ToolEnv, member: RowAxisMember): SemanticMetricClass {
  const percentFormatted = env.periodIndex.points.some((p) => p.colIndex >= 0 && isPercentNumberFormat(env.grids.numberFormats[member.rowIndex]?.[p.colIndex] ?? null));
  return classifySemanticMetricClass(member.display, { percentFormatted });
}

const schemaDescribe: ToolSpec = {
  name: "schema.describe",
  description:
    "Describe the table itself: sheet, range, layout, how many metrics and how many periods it has. Takes no input and returns a one-row schema result. Use it only when you need to know the shape of the data before planning; the same facts are already summarised in the TABLE block.",
  args: {},
  returns: "schema",
  reads: false,
  run: (_args, env) => ({
    ok: true,
    result: env.store.put({
      tool: "schema.describe",
      type: "schema",
      fields: [text("sheet"), text("range"), text("orientation"), text("metricCount"), text("periodCount")],
      rows: [[env.schema.sheetName, env.schema.sourceRange, env.schema.orientation, env.schema.rowAxis.length, env.periodIndex.points.length]],
      metricKeys: [],
    }),
  }),
};

const schemaMetrics: ToolSpec = {
  name: "schema.metrics",
  description:
    "List every metric in the table with its semantic class (amount, ratio, share, rate, percentage, count, index). Takes no input and returns a metric_set. Use it when you need the exact metric labels to pass to another tool, or to see which metrics are percentages before comparing them with amounts.",
  args: {},
  returns: "metric_set",
  reads: false,
  run: (_args, env) => ({
    ok: true,
    result: env.store.put({
      tool: "schema.metrics",
      type: "metric_set",
      fields: [METRIC_FIELD, text("semanticClass")],
      rows: env.schema.rowAxis.map((m) => [m.display, classOf(env, m)] as readonly CellValue[]),
    }),
  }),
};

const schemaPeriods: ToolSpec = {
  name: "schema.periods",
  description:
    "List every period of the table, oldest first, as canonical period strings with their displayed header text. Takes no input and returns a period result. Use it when you need to choose a specific period; always pass the canonical string, never a date you wrote yourself.",
  args: {},
  returns: "period",
  reads: false,
  run: (_args, env) => {
    const pts = sortedPoints(env);
    return {
      ok: true,
      result: env.store.put({
        tool: "schema.periods",
        type: "period",
        fields: [{ name: "period", kind: "period" }, text("label")],
        rows: pts.map((p) => [p.canonical, p.headerPath] as readonly CellValue[]),
        metricKeys: [],
        periodCanonicals: pts.map((p) => p.canonical),
      }),
    };
  },
};

const metricList: ToolSpec = {
  name: "metric.list",
  description:
    "List the table's metrics, optionally narrowed to one semantic class. Returns a metric_set you can pass to any tool as inputRef. Use scope to exclude incomparable metrics — for example scope=\"amount_like\" when ranking money amounts, or scope=\"percentage_like\" when the request is about ratios.",
  args: { scope: { type: "string", describe: '"all" (default) | "amount_like" | "percentage_like"' } },
  returns: "metric_set",
  reads: false,
  run: (args, env) => {
    const scope = args["scope"];
    if (scope !== undefined && scope !== "all" && scope !== "amount_like" && scope !== "percentage_like") {
      return toolError("INVALID_ARGUMENT", `unknown scope "${String(scope)}"`, ["all", "amount_like", "percentage_like"]);
    }
    const rows = env.schema.rowAxis
      .map((m) => ({ m, cls: classOf(env, m) }))
      .filter(({ cls }) => (scope === "amount_like" ? !isPercentageLike(cls) : scope === "percentage_like" ? isPercentageLike(cls) : true))
      .map(({ m, cls }) => [m.display, cls] as readonly CellValue[]);
    if (rows.length === 0) return toolError("INCOMPATIBLE_INPUT", `no metric matches scope "${String(scope)}"`);
    return { ok: true, result: env.store.put({ tool: "metric.list", type: "metric_set", fields: [METRIC_FIELD, text("semanticClass")], rows }) };
  },
};

const metricResolve: ToolSpec = {
  name: "metric.resolve",
  description:
    "Turn the user's wording for ONE metric into the table's exact label. Returns a metric_set of one row. Use it when the request names a metric in words that may not match the label exactly; if the wording is ambiguous the tool refuses and lists the candidates instead of guessing.",
  args: { text: { type: "string", required: true, describe: "the user's wording for a single metric" } },
  returns: "metric_set",
  reads: false,
  run: (args, env) => {
    const member = memberFor(env, args["text"]);
    if (isErr(member)) return member.error;
    return { ok: true, result: env.store.put({ tool: "metric.resolve", type: "metric_set", fields: [METRIC_FIELD], rows: [[member.display]] }) };
  },
};

const metricResolveSet: ToolSpec = {
  name: "metric.resolve_set",
  description:
    'Turn a phrase naming SEVERAL metrics ("A and B", "A, B and C") into their exact labels. Returns a metric_set you can pass as inputRef to a comparison or analysis tool. Use it when the request explicitly lists the metrics to work with.',
  args: { text: { type: "string", required: true, describe: "the phrase naming two or more metrics" } },
  returns: "metric_set",
  reads: false,
  run: (args, env) => {
    const phrase = args["text"];
    if (typeof phrase !== "string" || phrase.trim() === "") return toolError("INVALID_ARGUMENT", '"text" must be a non-empty phrase');
    const labels = resolveSetPhrase(env, phrase);
    if (isErr(labels)) return labels.error;
    return { ok: true, result: env.store.put({ tool: "metric.resolve_set", type: "metric_set", fields: [METRIC_FIELD], rows: labels.map((l) => [l] as readonly CellValue[]) }) };
  },
};

const metricFilter: ToolSpec = {
  name: "metric.filter",
  description:
    'Narrow a metric universe by semantic class — keep only amounts, or drop every percentage-like indicator. Takes an optional inputRef (defaults to the whole table) and returns a metric_set. Use it when the request asks to exclude a kind of indicator rather than specific named ones.',
  args: {
    inputRef: { type: "resultRef", describe: "a result whose metric universe to narrow; omit for the whole table" },
    exclude: { type: "string", describe: '"percentage_like" | "amount_like" — the class to REMOVE' },
    keep: { type: "string", describe: '"percentage_like" | "amount_like" — the class to KEEP' },
  },
  returns: "metric_set",
  accepts: ["metric_set", "comparison", "filtered_set", "ranked_set", "aggregate", "trend", "volatility", "stability", "derived", "table"],
  reads: false,
  run: (args, env) => {
    const scope = metricScope(args, env);
    if (isErr(scope)) return scope.error;
    const exclude = args["exclude"];
    const keep = args["keep"];
    for (const [name, v] of [["exclude", exclude], ["keep", keep]] as const) {
      if (v !== undefined && v !== "percentage_like" && v !== "amount_like") {
        return toolError("INVALID_ARGUMENT", `"${name}" must be "percentage_like" or "amount_like"`, ["percentage_like", "amount_like"]);
      }
    }
    if (exclude === undefined && keep === undefined) return toolError("INVALID_ARGUMENT", 'supply either "exclude" or "keep"', ["percentage_like", "amount_like"]);
    const rows = scope.members
      .map((m) => ({ m, cls: classOf(env, m), pct: isPercentageLike(classOf(env, m)) }))
      .filter(({ pct }) => {
        if (keep === "percentage_like") return pct;
        if (keep === "amount_like") return !pct;
        if (exclude === "percentage_like") return !pct;
        return pct;
      })
      .map(({ m, cls }) => [m.display, cls] as readonly CellValue[]);
    if (rows.length === 0) return toolError("INCOMPATIBLE_INPUT", "no metric survives that filter", allMetricLabels(env));
    return { ok: true, result: env.store.put({ tool: "metric.filter", type: "metric_set", fields: [METRIC_FIELD, text("semanticClass")], rows, parents: scope.parents }) };
  },
};

export const SCHEMA_METRIC_TOOLS: readonly ToolSpec[] = [schemaDescribe, schemaMetrics, schemaPeriods, metricList, metricResolve, metricResolveSet, metricFilter];

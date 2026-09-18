// ---------------------------------------------------------------------------
// Stage 25 — the analytical tool registry.
//
// Every tool here is a thin, deterministic wrapper over the EXISTING Stage
// 24.6–24.9 schema / metric / period / temporal primitives — nothing here
// recomputes a number a different way. The LLM planner (Stage 25) composes
// these tools; it never calculates a workbook value itself (§1, §3).
//
// Tools operate over an ALREADY-INDUCED TableSchema + AnalysisGrids (read
// once per turn, exactly like the Stage 24.7 compiler) — they never touch
// `ctx.deps` (the flat-table agent's async Office.js deps). `readCost: 1` on
// every tool turns the existing `AgentBounds.maxWorkbookReads` into the
// "max analytical tool calls" budget from §7, with zero changes to
// `agent/agent-loop.ts` / `agent/bounds.ts` / `agent/decision-schema.ts`.
//
// Row-axis metrics only (schema.orientation !== "column_metrics") — the same
// documented scope limitation Stage 24.9's MetricSetRef already carries.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import { createAgentToolRegistry } from "../agent/tool-registry.js";
import type { AgentObservation, AgentTool, AgentToolContext, AgentToolRegistry, ToolInputResult } from "../agent/types.js";
import { isPercentNumberFormat } from "../app/schema/excel-date.js";
import { classifySemanticMetricClass, isPercentageLike, type SemanticMetricClass } from "../app/schema/measure-compatibility.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import type { RowAxisMember, TableSchema } from "../app/schema/schema-induction.js";
import { buildMetricIndex, resolveMetric, resolveMetricSet, type MetricIndex } from "../app/schema/analytical/metric-resolver.js";
import { buildPeriodIndex, type PeriodIndex } from "../app/schema/analytical/period-index.js";
import {
  compareMetricSetAtTwoPoints,
  computeAdjacentPeriodEvents,
  getPointValue,
  getTemporalSeries,
} from "../app/schema/analytical/temporal-series.js";
import {
  changeRowsFor,
  computeDirectionChangeEvents,
  computeTrend,
  computeVolatility,
  comparePoints,
  seriesExtrema,
  testMonotonicity,
} from "../app/schema/analytical/temporal-primitives.js";
import type { CanonicalPeriod, ResolvedSubject, TemporalSeries } from "../app/schema/analytical/types.js";
import { evalExpr, isValidExpr, type ExprNode } from "../app/schema/analytical/derive-expr.js";
import { matchTemporalPattern, seriesMean, stabilityFromVolatility } from "../app/schema/analytical/series-aggregates.js";
import { hasSuperlativeAsk } from "./semantic-frame.js";
import { determineSemanticWinner } from "./semantic-winner.js";
import { determineValidatedWinner } from "./primary-answer.js";

// --- shared env --------------------------------------------------------

export interface AnalyticalInherited {
  readonly metricFocus?: { readonly metricKey: string };
  /** Stage 25.1.3c §4/§5/§10 — a pronoun ("его"/"её"/"it") in THIS request's
   *  own text has already been resolved, upstream of the planner, to a
   *  specific metric — an AUTHORITATIVE binding that outranks every other
   *  source of "current subject" (same-turn winner, resultset winner, event
   *  metric, stale `metricFocus`). Never re-resolved from the pronoun text. */
  readonly resolvedSubject?: { readonly metricKey: string; readonly source: "conversation_pronoun"; readonly authoritative: true };
  readonly metricSet?: { readonly metricKeys: readonly string[] };
  readonly resultSet?: {
    readonly operation: string;
    readonly scoreField: string;
    readonly rows: readonly { readonly key: string; readonly score: number }[];
  };
  /** Stage 25.1.3f §3/§4 — the FULL structured result of the previous
   *  successful analytical turn: the input universe a compatible follow-up
   *  filters/slices/ranks WITHOUT re-deriving it from the workbook and
   *  WITHOUT parsing the visible markdown table. */
  readonly resultTable?: {
    readonly operation: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly CellValue[])[];
    readonly startCanonical?: string;
    readonly endCanonical?: string;
  };
  readonly period?: { readonly startCanonical: string; readonly endCanonical?: string };
}

export interface AnalyticalToolEnv {
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  readonly periodIndex: PeriodIndex;
  readonly metricIndex: MetricIndex;
  readonly language: "ru" | "en";
  readonly inherited: AnalyticalInherited;
  /** Stage 25.1.3 §10/§11 — the original request text, so a dependent
   *  clause's reference tool can tell whether THIS turn's own winner (if
   *  any exists so far) should be preferred over stale pre-turn focus. */
  readonly requestText: string;
}

/** Builds the PeriodIndex + MetricIndex once and wraps them into a full env. */
export function buildAnalyticalToolEnv(
  schema: TableSchema,
  grids: AnalysisGrids,
  language: "ru" | "en",
  inherited: AnalyticalInherited = {},
  requestText = "",
): AnalyticalToolEnv {
  return {
    schema,
    grids,
    periodIndex: buildPeriodIndex(schema, grids),
    metricIndex: buildMetricIndex(schema),
    language,
    inherited,
    requestText,
  };
}

// --- observation helpers ------------------------------------------------

function tableObs(tool: string, columns: readonly string[], rows: readonly (readonly CellValue[])[], extra: Partial<AgentObservation> = {}): AgentObservation {
  return { tool, ok: true, kind: "table", source: "schema", columns, rows, rowCount: rows.length, ...extra };
}

function errObs(tool: string, code: string, message: string): AgentObservation {
  return { tool, ok: false, kind: "error", error: `${code}: ${message}` };
}

function num(v: CellValue): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// --- registry factory ---------------------------------------------------

export function createAnalyticalToolRegistry(env: AnalyticalToolEnv): AgentToolRegistry {
  const { schema, grids, periodIndex, metricIndex, inherited } = env;
  const columnsAreMetrics = schema.orientation === "column_metrics";
  const memberByLabel = new Map(schema.rowAxis.map((m) => [m.display, m]));
  const periodByCanonical = new Map(periodIndex.points.map((p) => [p.canonical, p]));

  const scopeGuard = (tool: string): AgentObservation | null =>
    columnsAreMetrics
      ? errObs(tool, "UNSUPPORTED_OPERATION", "this tool set only supports row-axis metric tables (schema.orientation !== \"column_metrics\")")
      : null;

  function semanticClassOf(member: RowAxisMember): SemanticMetricClass {
    const percentFormatted = periodIndex.points.some(
      (per) => per.colIndex >= 0 && isPercentNumberFormat(grids.numberFormats[member.rowIndex]?.[per.colIndex] ?? null),
    );
    return classifySemanticMetricClass(member.display, { percentFormatted });
  }

  function seriesFor(member: RowAxisMember): TemporalSeries {
    return getTemporalSeries(schema, grids, { kind: "row_axis_member", member }, periodIndex)!;
  }

  /** Reads metric labels from an explicit `metrics: string[]`, OR a prior
   *  table `source: resultId` whose "metric" column carries them (§66). */
  function metricLabels(input: Readonly<Record<string, unknown>>, ctx: AgentToolContext): { ok: true; labels: string[] } | { ok: false; error: string } {
    const metrics = input["metrics"];
    if (Array.isArray(metrics) && metrics.length > 0 && metrics.every((m) => typeof m === "string")) {
      return { ok: true, labels: metrics as string[] };
    }
    const source = input["source"];
    if (typeof source === "string") {
      const obs = ctx.priorResults.find((o) => o.resultId === source);
      if (!obs || !obs.ok || !obs.columns || !obs.rows) return { ok: false, error: `UNRESOLVED_METRIC: unknown result "${source}"` };
      const ci = obs.columns.indexOf("metric");
      if (ci < 0) return { ok: false, error: `UNSUPPORTED_OPERATION: result "${source}" has no "metric" column` };
      const labels = [...new Set(obs.rows.map((r) => String(r[ci] ?? "")))].filter(Boolean);
      if (labels.length === 0) return { ok: false, error: `UNRESOLVED_METRIC: result "${source}" is empty` };
      return { ok: true, labels };
    }
    return { ok: false, error: 'INVALID_PLAN: provide either "metrics" (a non-empty string array) or "source" (a prior result id)' };
  }

  function resolveMembers(labels: readonly string[]): { ok: true; members: RowAxisMember[] } | { ok: false; unresolved: string[] } {
    const members: RowAxisMember[] = [];
    const unresolved: string[] = [];
    for (const label of labels) {
      const m = memberByLabel.get(label);
      if (m) members.push(m);
      else unresolved.push(label);
    }
    return unresolved.length > 0 ? { ok: false, unresolved } : { ok: true, members };
  }

  function periodOf(canonical: unknown): CanonicalPeriod | undefined {
    return typeof canonical === "string" ? periodByCanonical.get(canonical) : undefined;
  }

  function simpleTool(
    name: string,
    description: string,
    parameters: Readonly<Record<string, string>>,
    run: (input: Readonly<Record<string, unknown>>, ctx: AgentToolContext) => AgentObservation,
  ): AgentTool<Readonly<Record<string, unknown>>> {
    return {
      name,
      description,
      parameters,
      mutating: false,
      readCost: 1,
      validate: (input): ToolInputResult<Readonly<Record<string, unknown>>> => ({ ok: true, value: input }),
      execute: async (input, ctx) => {
        const guard = scopeGuard(name);
        if (guard) return guard;
        try {
          return run(input, ctx);
        } catch (error) {
          return errObs(name, "UNSUPPORTED_OPERATION", error instanceof Error ? error.message : String(error));
        }
      },
    };
  }

  // --- SCHEMA -------------------------------------------------------------

  const schemaDescribe = simpleTool(
    "schema.describe",
    "Describes the induced table: sheet, range, orientation, metric count, period count.",
    {},
    () => ({
      tool: "schema.describe",
      ok: true,
      kind: "text",
      source: schema.sourceRange,
      note: `sheet=${schema.sheetName} range=${schema.sourceRange} orientation=${schema.orientation} metrics=${schema.rowAxis.length} periods=${periodIndex.points.length}`,
    }),
  );

  // --- METRICS -------------------------------------------------------------

  const metricList = simpleTool(
    "metric.list",
    'Lists metrics. scope: "all" | "compatible_temporal_metrics" | "amount_like" | "percentage_like".',
    { scope: 'optional: "all" (default) | "compatible_temporal_metrics" | "amount_like" | "percentage_like"' },
    (input) => {
      const scope = typeof input["scope"] === "string" ? input["scope"] : "all";
      const rows: [string, string][] = [];
      for (const m of schema.rowAxis) {
        const cls = semanticClassOf(m);
        if (scope === "compatible_temporal_metrics" && seriesFor(m).points.length < 1) continue;
        if (scope === "amount_like" && isPercentageLike(cls)) continue;
        if (scope === "percentage_like" && !isPercentageLike(cls)) continue;
        rows.push([m.display, cls]);
      }
      return tableObs("metric.list", ["metric", "semanticClass"], rows);
    },
  );

  const metricResolve = simpleTool(
    "metric.resolve",
    "Resolves free text to exactly one metric.",
    { text: "the metric phrase to resolve" },
    (input) => {
      const text = typeof input["text"] === "string" ? input["text"] : "";
      const r = resolveMetric(text, metricIndex);
      if (r.kind === "resolved") return tableObs("metric.resolve", ["metric"], [[r.entry.label]]);
      if (r.kind === "ambiguous") return errObs("metric.resolve", "AMBIGUOUS_METRIC", `"${text}" matches: ${r.candidates.join(", ")}`);
      return errObs("metric.resolve", "UNRESOLVED_METRIC", `no metric matches "${text}"`);
    },
  );

  const metricResolveSet = simpleTool(
    "metric.resolve_set",
    'Resolves an explicit "A и B [и C]" / "A and B" phrase into two or more metrics.',
    { text: "the multi-metric phrase to resolve" },
    (input) => {
      const text = typeof input["text"] === "string" ? input["text"] : "";
      const r = resolveMetricSet(text, metricIndex);
      if (r.kind === "resolved") return tableObs("metric.resolve_set", ["metric"], r.entries.map((e) => [e.label] as [string]));
      if (r.kind === "ambiguous") return errObs("metric.resolve_set", "AMBIGUOUS_METRIC", `"${text}" matches: ${r.candidates.join(", ")}`);
      return errObs("metric.resolve_set", "UNRESOLVED_METRIC", `no metrics match "${text}"`);
    },
  );

  const KNOWN_CLASSES = new Set<SemanticMetricClass>(["amount", "ratio", "share", "rate", "percentage", "count", "index", "unknown"]);

  const metricFilter = simpleTool(
    "metric.filter",
    "Filters a metric list by semantic class. excludeClasses / includeClasses use the schema's semantic taxonomy.",
    {
      source: "optional: a prior metric.list / metric.resolve_set result id (default: all metrics)",
      excludeClasses: 'optional: array of "amount"|"ratio"|"share"|"rate"|"percentage"|"count"|"index"|"unknown"',
      includeClasses: "optional: same taxonomy, keep only these classes",
    },
    (input, ctx) => {
      let labels: string[];
      if (typeof input["source"] === "string") {
        const r = metricLabels({ source: input["source"] }, ctx);
        if (!r.ok) return errObs("metric.filter", "UNRESOLVED_METRIC", r.error);
        labels = r.labels;
      } else {
        labels = schema.rowAxis.map((m) => m.display);
      }
      const exclude = Array.isArray(input["excludeClasses"]) ? (input["excludeClasses"] as unknown[]).filter((c): c is SemanticMetricClass => typeof c === "string" && KNOWN_CLASSES.has(c as SemanticMetricClass)) : [];
      const include = Array.isArray(input["includeClasses"]) ? (input["includeClasses"] as unknown[]).filter((c): c is SemanticMetricClass => typeof c === "string" && KNOWN_CLASSES.has(c as SemanticMetricClass)) : [];
      const rows: [string, string][] = [];
      for (const label of labels) {
        const m = memberByLabel.get(label);
        if (!m) continue;
        const cls = semanticClassOf(m);
        if (exclude.includes(cls)) continue;
        if (include.length > 0 && !include.includes(cls)) continue;
        rows.push([label, cls]);
      }
      return tableObs("metric.filter", ["metric", "semanticClass"], rows, { note: `${labels.length} candidate(s) before filter, ${rows.length} after` });
    },
  );

  // --- PERIODS -------------------------------------------------------------

  const periodList = simpleTool(
    "period.list",
    "Lists every canonical point-in-time period, oldest first.",
    {},
    () => tableObs("period.list", ["period", "headerPath"], periodIndex.points.map((p) => [p.canonical, p.headerPath])),
  );

  const periodSelect = simpleTool(
    "period.select",
    'Selects one period. selector: "first" | "last" | "previous_of" | "next_of" | "explicit" | "nth" (with "of" a canonical period, or "n" a 1-based index).',
    { selector: '"first"|"last"|"previous_of"|"next_of"|"explicit"|"nth"', of: "canonical period (for previous_of/next_of/explicit)", n: "1-based index (for nth)" },
    (input) => {
      const pts = periodIndex.points;
      if (pts.length === 0) return errObs("period.select", "UNRESOLVED_PERIOD", "no periods available on this table");
      const selector = typeof input["selector"] === "string" ? input["selector"] : "";
      const one = (p: CanonicalPeriod): AgentObservation => tableObs("period.select", ["period", "headerPath"], [[p.canonical, p.headerPath]]);
      if (selector === "first") return one(pts[0]!);
      if (selector === "last") return one(pts[pts.length - 1]!);
      if (selector === "nth") {
        const n = typeof input["n"] === "number" ? input["n"] : NaN;
        const p = pts[n - 1];
        return p ? one(p) : errObs("period.select", "UNRESOLVED_PERIOD", `no period at index ${n}`);
      }
      if (selector === "explicit") {
        const p = periodOf(input["of"]);
        return p ? one(p) : errObs("period.select", "UNRESOLVED_PERIOD", `no period "${String(input["of"])}"`);
      }
      if (selector === "previous_of" || selector === "next_of") {
        const p = periodOf(input["of"]);
        if (!p) return errObs("period.select", "UNRESOLVED_PERIOD", `no period "${String(input["of"])}"`);
        const idx = pts.findIndex((x) => x.canonical === p.canonical);
        const target = selector === "previous_of" ? pts[idx - 1] : pts[idx + 1];
        return target ? one(target) : errObs("period.select", "NO_COMMON_PERIOD", `no ${selector === "previous_of" ? "earlier" : "later"} period than "${p.canonical}"`);
      }
      return errObs("period.select", "INVALID_PLAN", `unknown selector "${selector}"`);
    },
  );

  // --- VALUES / SERIES -----------------------------------------------------

  const valueAtPeriod = simpleTool(
    "value.at_period",
    "Reads the verified value of one or more metrics at one canonical period, with source cells.",
    { metrics: "string[] (or use source)", source: "a prior metric.* result id", period: "canonical period string" },
    (input, ctx) => {
      const lr = metricLabels(input, ctx);
      if (!lr.ok) return errObs("value.at_period", "UNRESOLVED_METRIC", lr.error);
      const period = periodOf(input["period"]);
      if (!period) return errObs("value.at_period", "UNRESOLVED_PERIOD", `no period "${String(input["period"])}"`);
      const mr = resolveMembers(lr.labels);
      if (!mr.ok) return errObs("value.at_period", "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
      const rows: (readonly CellValue[])[] = [];
      const missing: string[] = [];
      for (const m of mr.members) {
        const pt = getPointValue(schema, grids, { kind: "row_axis_member", member: m }, period);
        if (!pt) {
          missing.push(m.display);
          continue;
        }
        rows.push([m.display, pt.value, pt.periodLabel, pt.cell]);
      }
      return tableObs("value.at_period", ["metric", "value", "period", "sourceCell"], rows, missing.length > 0 ? { note: `no value for: ${missing.join(", ")}` } : {});
    },
  );

  const seriesGet = simpleTool(
    "series.get",
    "Returns the full ordered point-in-time series (period, value, source cell) for one or more metrics.",
    { metrics: "string[] (or use source)", source: "a prior metric.* result id" },
    (input, ctx) => {
      const lr = metricLabels(input, ctx);
      if (!lr.ok) return errObs("series.get", "UNRESOLVED_METRIC", lr.error);
      const mr = resolveMembers(lr.labels);
      if (!mr.ok) return errObs("series.get", "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
      const rows: (readonly CellValue[])[] = [];
      for (const m of mr.members) {
        for (const p of seriesFor(m).points) rows.push([m.display, p.periodLabel, p.value, p.cell]);
      }
      return tableObs("series.get", ["metric", "period", "value", "sourceCell"], rows);
    },
  );

  // --- AGGREGATION -----------------------------------------------------------

  function aggregateExtreme(name: string, kind: "max" | "min"): AgentTool<Readonly<Record<string, unknown>>> {
    return simpleTool(
      name,
      `Finds the historical ${kind === "max" ? "maximum" : "minimum"} of one or more metrics across all available periods, tie-safe.`,
      { metrics: "string[] (or use source)", source: "a prior metric.* result id" },
      (input, ctx) => {
        const lr = metricLabels(input, ctx);
        if (!lr.ok) return errObs(name, "UNRESOLVED_METRIC", lr.error);
        const mr = resolveMembers(lr.labels);
        if (!mr.ok) return errObs(name, "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
        const rows: (readonly CellValue[])[] = [];
        const skipped: string[] = [];
        for (const m of mr.members) {
          const ex = seriesExtrema(seriesFor(m));
          if (!ex) {
            skipped.push(m.display);
            continue;
          }
          const p = kind === "max" ? ex.max : ex.min;
          rows.push([m.display, p.value, p.periodLabel, p.cell]);
        }
        return tableObs(name, ["metric", "value", "period", "sourceCell"], rows, skipped.length > 0 ? { note: `INSUFFICIENT_POINTS for: ${skipped.join(", ")}` } : {});
      },
    );
  }
  const aggregateMax = aggregateExtreme("aggregate.max", "max");
  const aggregateMin = aggregateExtreme("aggregate.min", "min");

  // Stage 25.1.1 §27 — "отклоняется от своего среднего значения" needs a
  // mean; this was already in the original Stage 25 tool catalogue (§9
  // AGGREGATION) and was simply not yet implemented — not a new primitive.
  const aggregateAvg = simpleTool(
    "aggregate.avg",
    "Computes the arithmetic mean of one or more metrics across all available canonical periods.",
    { metrics: "string[] (or use source)", source: "a prior metric.* result id" },
    (input, ctx) => {
      const lr = metricLabels(input, ctx);
      if (!lr.ok) return errObs("aggregate.avg", "UNRESOLVED_METRIC", lr.error);
      const mr = resolveMembers(lr.labels);
      if (!mr.ok) return errObs("aggregate.avg", "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
      const rows: (readonly CellValue[])[] = [];
      const skipped: string[] = [];
      for (const m of mr.members) {
        const mean = seriesMean(seriesFor(m));
        if (!mean) {
          skipped.push(m.display);
          continue;
        }
        rows.push([m.display, mean.value, mean.periodCount]);
      }
      return tableObs("aggregate.avg", ["metric", "value", "periodCount"], rows, skipped.length > 0 ? { note: `INSUFFICIENT_POINTS for: ${skipped.join(", ")}` } : {});
    },
  );

  // --- CHANGE ---------------------------------------------------------------

  const changeCompute = simpleTool(
    "change.compute",
    "Computes the absolute and percentage change of ONE metric between two canonical periods.",
    { metric: "metric label", startPeriod: "canonical period string", endPeriod: "canonical period string" },
    (input) => {
      const label = typeof input["metric"] === "string" ? input["metric"] : "";
      const m = memberByLabel.get(label);
      if (!m) return errObs("change.compute", "UNRESOLVED_METRIC", `unknown metric "${label}"`);
      const start = periodOf(input["startPeriod"]);
      const end = periodOf(input["endPeriod"]);
      if (!start || !end) return errObs("change.compute", "UNRESOLVED_PERIOD", "startPeriod/endPeriod must be canonical periods from period.list");
      const sp = getPointValue(schema, grids, { kind: "row_axis_member", member: m }, start);
      const ep = getPointValue(schema, grids, { kind: "row_axis_member", member: m }, end);
      if (!sp || !ep) return errObs("change.compute", "NO_COMMON_PERIOD", `"${label}" has no value at one of the requested periods`);
      const cmp = comparePoints(sp, ep);
      return tableObs("change.compute", ["metric", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell"], [
        [label, sp.value, ep.value, cmp.absoluteChange, cmp.percentChange, sp.cell, ep.cell],
      ]);
    },
  );

  const changeComparePeriods = simpleTool(
    "change.compare_periods",
    "Computes absolute and percentage change for a SET of metrics between two canonical periods, one row per metric.",
    { metrics: "string[] (or use source)", source: "a prior metric.* result id", startPeriod: "canonical period string", endPeriod: "canonical period string" },
    (input, ctx) => {
      const lr = metricLabels(input, ctx);
      if (!lr.ok) return errObs("change.compare_periods", "UNRESOLVED_METRIC", lr.error);
      const start = periodOf(input["startPeriod"]);
      const end = periodOf(input["endPeriod"]);
      if (!start || !end) return errObs("change.compare_periods", "UNRESOLVED_PERIOD", "startPeriod/endPeriod must be canonical periods from period.list");
      const mr = resolveMembers(lr.labels);
      if (!mr.ok) return errObs("change.compare_periods", "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
      const subject: ResolvedSubject = { kind: "metric_set", members: mr.members };
      const pairs = compareMetricSetAtTwoPoints(schema, grids, subject, start, end);
      const rows = changeRowsFor(pairs).map(
        (r) => [r.key, r.startValue, r.endValue, r.absoluteChange, r.percentChange, r.startCell, r.endCell] as const,
      );
      return tableObs("change.compare_periods", ["metric", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell"], rows);
    },
  );

  // --- DERIVED (§10/§11) ------------------------------------------------------

  const deriveCompute = simpleTool(
    "derive.compute",
    'Adds ONE derived numeric field to a prior table using a restricted expression tree: {"field":"<col>"} | {"const":n} | {"op":"add"|"subtract"|"multiply"|"divide","left":expr,"right":expr} | {"op":"abs"|"neg","value":expr}. No eval, no free-form code.',
    { source: "a prior tool result id", field: "new field name", expr: "expression tree (see description)" },
    (input, ctx) => {
      const source = typeof input["source"] === "string" ? input["source"] : "";
      const obs = ctx.priorResults.find((o) => o.resultId === source);
      if (!obs || !obs.ok || !obs.columns || !obs.rows) return errObs("derive.compute", "INVALID_PLAN", `unknown result "${source}"`);
      const field = typeof input["field"] === "string" ? input["field"] : "";
      if (!field || obs.columns.includes(field)) return errObs("derive.compute", "INVALID_PLAN", `"field" must be a new, non-empty column name`);
      if (!isValidExpr(input["expr"])) return errObs("derive.compute", "INVALID_PLAN", "expr is not a valid restricted expression tree");
      const cols = obs.columns;
      const rows = obs.rows.map((r) => {
        const rowRecord: Record<string, number> = {};
        cols.forEach((c, ci) => {
          const v = num(r[ci] ?? null);
          if (v !== null) rowRecord[c] = v;
        });
        const v = evalExpr(input["expr"] as ExprNode, rowRecord);
        return [...r, v] as readonly CellValue[];
      });
      return tableObs("derive.compute", [...cols, field], rows);
    },
  );

  // --- SET OPS ----------------------------------------------------------------

  function resultTable(source: unknown, ctx: AgentToolContext): AgentObservation | null {
    const obs = ctx.priorResults.find((o) => o.resultId === source);
    return obs && obs.ok && obs.columns && obs.rows ? obs : null;
  }

  const setMerge = simpleTool(
    "set.merge",
    'Inner-joins two prior tables on a shared key column (default "metric"), renaming the other columns with leftPrefix/rightPrefix (default "a_"/"b_").',
    { left: "a prior result id", right: "a prior result id", key: 'optional, default "metric"', leftPrefix: 'optional, default "a_"', rightPrefix: 'optional, default "b_"' },
    (input, ctx) => {
      const left = resultTable(input["left"], ctx);
      const right = resultTable(input["right"], ctx);
      if (!left || !right) return errObs("set.merge", "INVALID_PLAN", "left/right must be ids of prior table results");
      const key = typeof input["key"] === "string" ? input["key"] : "metric";
      const lp = typeof input["leftPrefix"] === "string" ? input["leftPrefix"] : "a_";
      const rp = typeof input["rightPrefix"] === "string" ? input["rightPrefix"] : "b_";
      const lki = left.columns!.indexOf(key);
      const rki = right.columns!.indexOf(key);
      if (lki < 0 || rki < 0) return errObs("set.merge", "UNSUPPORTED_OPERATION", `both tables must have a "${key}" column`);
      const rightByKey = new Map(right.rows!.map((r) => [String(r[rki] ?? ""), r]));
      const leftCols = left.columns!.filter((_, i) => i !== lki);
      const rightCols = right.columns!.filter((_, i) => i !== rki);
      const outCols = [key, ...leftCols.map((c) => `${lp}${c}`), ...rightCols.map((c) => `${rp}${c}`)];
      const outRows: (readonly CellValue[])[] = [];
      for (const lr of left.rows!) {
        const k = String(lr[lki] ?? "");
        const rr = rightByKey.get(k);
        if (!rr) continue;
        const leftVals = left.columns!.filter((_, i) => i !== lki).map((c) => lr[left.columns!.indexOf(c)] ?? null);
        const rightVals = right.columns!.filter((_, i) => i !== rki).map((c) => rr[right.columns!.indexOf(c)] ?? null);
        outRows.push([k, ...leftVals, ...rightVals]);
      }
      return tableObs("set.merge", outCols, outRows);
    },
  );

  function fieldValue(cols: readonly string[], row: readonly CellValue[], field: string): number | string | null {
    const i = cols.indexOf(field);
    if (i < 0) return null;
    const v = row[i] ?? null;
    return typeof v === "number" || typeof v === "string" ? v : null;
  }

  const setFilter = simpleTool(
    "set.filter",
    'Filters a prior table\'s rows. op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte". value is a literal number, or {"field":"<other column>"} for a column-to-column comparison.',
    { source: "a prior result id", field: "column to filter on", op: '"eq"|"ne"|"gt"|"gte"|"lt"|"lte"', value: 'number | {"field":"<column>"}', tolerance: "optional numeric tolerance for eq/ne" },
    (input, ctx) => {
      const src = resultTable(input["source"], ctx);
      if (!src) return errObs("set.filter", "INVALID_PLAN", "source must be a prior table result id");
      const field = typeof input["field"] === "string" ? input["field"] : "";
      if (!src.columns!.includes(field)) return errObs("set.filter", "UNSUPPORTED_OPERATION", `unknown field "${field}" — available: ${src.columns!.join(", ")}`);
      const op = typeof input["op"] === "string" ? input["op"] : "";
      const literalValue = typeof input["value"] === "number" ? (input["value"] as number) : undefined;
      const valueField =
        input["value"] && typeof input["value"] === "object" && typeof (input["value"] as Record<string, unknown>)["field"] === "string"
          ? ((input["value"] as Record<string, unknown>)["field"] as string)
          : undefined;
      if (literalValue === undefined && valueField === undefined) return errObs("set.filter", "INVALID_PLAN", '"value" must be a number or {"field":"<column>"}');
      if (valueField !== undefined && !src.columns!.includes(valueField)) return errObs("set.filter", "UNSUPPORTED_OPERATION", `unknown field "${valueField}"`);
      const cols = src.columns!;
      const rows = src.rows!.filter((r) => {
        const a = num(fieldValue(cols, r, field) as CellValue);
        const b = valueField !== undefined ? num(fieldValue(cols, r, valueField) as CellValue) : literalValue!;
        if (a === null || b === null) return false;
        const tol = typeof input["tolerance"] === "number" ? (input["tolerance"] as number) : Math.max(1e-9, 1e-6 * Math.max(Math.abs(a), Math.abs(b)));
        switch (op) {
          case "eq":
            return Math.abs(a - b) <= tol;
          case "ne":
            return Math.abs(a - b) > tol;
          case "gt":
            return a > b;
          case "gte":
            return a >= b;
          case "lt":
            return a < b;
          case "lte":
            return a <= b;
          default:
            return false;
        }
      });
      return tableObs("set.filter", cols, rows);
    },
  );

  const setSort = simpleTool(
    "set.sort",
    "Sorts a prior table's rows by a numeric column.",
    { source: "a prior result id", field: "column to sort on", direction: '"asc"|"desc"' },
    (input, ctx) => {
      const src = resultTable(input["source"], ctx);
      if (!src) return errObs("set.sort", "INVALID_PLAN", "source must be a prior table result id");
      const field = typeof input["field"] === "string" ? input["field"] : "";
      if (!src.columns!.includes(field)) return errObs("set.sort", "UNSUPPORTED_OPERATION", `unknown field "${field}"`);
      const dir = input["direction"] === "asc" ? "asc" : "desc";
      const ci = src.columns!.indexOf(field);
      const rows = [...src.rows!].sort((a, b) => {
        const av = num(a[ci] ?? null) ?? -Infinity;
        const bv = num(b[ci] ?? null) ?? -Infinity;
        return dir === "asc" ? av - bv : bv - av;
      });
      return tableObs("set.sort", src.columns!, rows);
    },
  );

  function setSlice(name: string, dirDefault: "desc" | "asc"): AgentTool<Readonly<Record<string, unknown>>> {
    return simpleTool(
      name,
      `Returns the ${dirDefault === "desc" ? "top" : "bottom"} N rows of a prior table by a numeric column.`,
      { source: "a prior result id", field: "column to rank on", n: "how many rows" },
      (input, ctx) => {
        const src = resultTable(input["source"], ctx);
        if (!src) return errObs(name, "INVALID_PLAN", "source must be a prior table result id");
        const field = typeof input["field"] === "string" ? input["field"] : "";
        if (!src.columns!.includes(field)) return errObs(name, "UNSUPPORTED_OPERATION", `unknown field "${field}"`);
        const n = typeof input["n"] === "number" ? input["n"] : 1;
        const ci = src.columns!.indexOf(field);
        const rows = [...src.rows!]
          .sort((a, b) => (dirDefault === "desc" ? (num(b[ci] ?? null) ?? -Infinity) - (num(a[ci] ?? null) ?? -Infinity) : (num(a[ci] ?? null) ?? Infinity) - (num(b[ci] ?? null) ?? Infinity)))
          .slice(0, Math.max(0, n));
        return tableObs(name, src.columns!, rows);
      },
    );
  }
  const setTop = setSlice("set.top", "desc");
  const setBottom = setSlice("set.bottom", "asc");

  function setArg(name: string, which: "max" | "min"): AgentTool<Readonly<Record<string, unknown>>> {
    return simpleTool(
      name,
      `Returns every row tied at the ${which === "max" ? "maximum" : "minimum"} of a numeric column (tie-safe).`,
      { source: "a prior result id", field: "column to rank on" },
      (input, ctx) => {
        const src = resultTable(input["source"], ctx);
        if (!src) return errObs(name, "INVALID_PLAN", "source must be a prior table result id");
        const field = typeof input["field"] === "string" ? input["field"] : "";
        if (!src.columns!.includes(field)) return errObs(name, "UNSUPPORTED_OPERATION", `unknown field "${field}"`);
        const ci = src.columns!.indexOf(field);
        const vals = src.rows!.map((r) => num(r[ci] ?? null)).filter((v): v is number => v !== null);
        if (vals.length === 0) return tableObs(name, src.columns!, []);
        const best = which === "max" ? Math.max(...vals) : Math.min(...vals);
        const eps = Math.max(1e-9, 1e-6 * Math.abs(best));
        const rows = src.rows!.filter((r) => {
          const v = num(r[ci] ?? null);
          return v !== null && Math.abs(v - best) <= eps;
        });
        return tableObs(name, src.columns!, rows);
      },
    );
  }
  const setArgmax = setArg("set.argmax", "max");
  const setArgmin = setArg("set.argmin", "min");

  // --- TEMPORAL ANALYSIS -------------------------------------------------------

  const analysisTrend = simpleTool(
    "analysis.trend",
    "Computes the normalized linear (OLS) trend of one or more metrics.",
    { metrics: "string[] (or use source)", source: "a prior metric.* result id" },
    (input, ctx) => {
      const lr = metricLabels(input, ctx);
      if (!lr.ok) return errObs("analysis.trend", "UNRESOLVED_METRIC", lr.error);
      const mr = resolveMembers(lr.labels);
      if (!mr.ok) return errObs("analysis.trend", "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
      const rows: (readonly CellValue[])[] = [];
      const skipped: string[] = [];
      for (const m of mr.members) {
        const t = computeTrend(seriesFor(m));
        if (!t) {
          skipped.push(m.display);
          continue;
        }
        rows.push([m.display, t.slope, t.normalizedSlope, t.direction, t.r2, t.periods]);
      }
      return tableObs("analysis.trend", ["metric", "slope", "normalizedSlope", "direction", "r2", "periods"], rows, skipped.length > 0 ? { note: `INSUFFICIENT_POINTS for: ${skipped.join(", ")}` } : {});
    },
  );

  function analysisVolStab(name: string, kind: "volatility" | "stability"): AgentTool<Readonly<Record<string, unknown>>> {
    return simpleTool(
      name,
      kind === "volatility" ? "Computes the volatility score of one or more metrics (higher = more volatile)." : "Computes the stability score of one or more metrics (higher = more stable).",
      { metrics: "string[] (or use source)", source: "a prior metric.* result id" },
      (input, ctx) => {
        const lr = metricLabels(input, ctx);
        if (!lr.ok) return errObs(name, "UNRESOLVED_METRIC", lr.error);
        const mr = resolveMembers(lr.labels);
        if (!mr.ok) return errObs(name, "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
        const rows: (readonly CellValue[])[] = [];
        const skipped: string[] = [];
        for (const m of mr.members) {
          const series = seriesFor(m);
          const v = computeVolatility(series, { measureKind: series.measureKind });
          if ("unavailable" in v) {
            skipped.push(m.display);
            continue;
          }
          const score = kind === "volatility" ? v.score : stabilityFromVolatility(v.score);
          rows.push([m.display, score]);
        }
        return tableObs(name, ["metric", "score"], rows, skipped.length > 0 ? { note: `INSUFFICIENT_POINTS for: ${skipped.join(", ")}` } : {});
      },
    );
  }
  const analysisVolatility = analysisVolStab("analysis.volatility", "volatility");
  const analysisStability = analysisVolStab("analysis.stability", "stability");

  const analysisMonotonicity = simpleTool(
    "analysis.monotonicity",
    "Returns strictlyIncreasing / strictlyDecreasing / nonDecreasing / nonIncreasing (1/0) plus directionChangeCount per metric.",
    { metrics: "string[] (or use source)", source: "a prior metric.* result id" },
    (input, ctx) => {
      const lr = metricLabels(input, ctx);
      if (!lr.ok) return errObs("analysis.monotonicity", "UNRESOLVED_METRIC", lr.error);
      const mr = resolveMembers(lr.labels);
      if (!mr.ok) return errObs("analysis.monotonicity", "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
      const rows: (readonly CellValue[])[] = [];
      const skipped: string[] = [];
      for (const m of mr.members) {
        const series = seriesFor(m);
        const mono = testMonotonicity(series);
        if (!mono) {
          skipped.push(m.display);
          continue;
        }
        const dc = computeDirectionChangeEvents(series).changes;
        rows.push([m.display, mono.strictIncreasing ? 1 : 0, mono.strictDecreasing ? 1 : 0, mono.nonDecreasing ? 1 : 0, mono.nonIncreasing ? 1 : 0, dc]);
      }
      return tableObs(
        "analysis.monotonicity",
        ["metric", "strictlyIncreasing", "strictlyDecreasing", "nonDecreasing", "nonIncreasing", "directionChangeCount"],
        rows,
        skipped.length > 0 ? { note: `INSUFFICIENT_POINTS for: ${skipped.join(", ")}` } : {},
      );
    },
  );

  const analysisDirectionChanges = simpleTool(
    "analysis.direction_changes",
    "Counts direction reversals per metric (zero-delta periods never create or break a direction).",
    { metrics: "string[] (or use source)", source: "a prior metric.* result id" },
    (input, ctx) => {
      const lr = metricLabels(input, ctx);
      if (!lr.ok) return errObs("analysis.direction_changes", "UNRESOLVED_METRIC", lr.error);
      const mr = resolveMembers(lr.labels);
      if (!mr.ok) return errObs("analysis.direction_changes", "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
      const rows = mr.members.map((m) => [m.display, computeDirectionChangeEvents(seriesFor(m)).changes] as const);
      return tableObs("analysis.direction_changes", ["metric", "count"], rows);
    },
  );

  // Stage 25.1.1 §21/§22 — a SEQUENCE predicate ("exists a decline later
  // followed by a rise") cannot be expressed by set.filter/derive.compute
  // over a single flat row per metric — those operate on ONE row's fields,
  // never a metric's ordered event sequence. This wraps the SAME
  // `computeAdjacentPeriodEvents` primitive `event.adjacent_changes` already
  // uses; no new arithmetic. Default policy (§21, documented, not silently
  // stricter): "down_then_up" matches ANY later recovery, not only an
  // immediate next-period rebound — the wording rarely specifies "sразу".
  const analysisTemporalPattern = simpleTool(
    "analysis.temporal_pattern",
    'Flags metrics whose adjacent-period event sequence contains a decline later followed by a rise ("down_then_up") or a rise later followed by a decline ("up_then_down"). Matches ANY later occurrence, not only the immediate next period.',
    { metrics: "string[] (or use source)", source: "a prior metric.* result id", pattern: '"down_then_up" | "up_then_down"' },
    (input, ctx) => {
      const lr = metricLabels(input, ctx);
      if (!lr.ok) return errObs("analysis.temporal_pattern", "UNRESOLVED_METRIC", lr.error);
      const mr = resolveMembers(lr.labels);
      if (!mr.ok) return errObs("analysis.temporal_pattern", "UNRESOLVED_METRIC", `unknown metric(s): ${mr.unresolved.join(", ")}`);
      const pattern = input["pattern"] === "up_then_down" ? "up_then_down" : "down_then_up";
      const rows: (readonly CellValue[])[] = [];
      for (const m of mr.members) {
        const events = computeAdjacentPeriodEvents(schema, grids, { kind: "row_axis_member", member: m }, periodIndex);
        const match = matchTemporalPattern(events, pattern);
        rows.push([m.display, match.matched ? 1 : 0, match.pivot1Period ?? "", match.pivot2Period ?? ""]);
      }
      return tableObs("analysis.temporal_pattern", ["metric", "matched", "pivot1Period", "pivot2Period"], rows, {
        note: `pattern=${pattern}, matches any later occurrence (not only the immediate next period)`,
      });
    },
  );

  // --- EVENTS -----------------------------------------------------------------

  const eventAdjacentChanges = simpleTool(
    "event.adjacent_changes",
    "Returns every adjacent-period change (start, end, absolute/percentage change, source cells) for ONE metric.",
    { metric: "metric label" },
    (input) => {
      const label = typeof input["metric"] === "string" ? input["metric"] : "";
      const m = memberByLabel.get(label);
      if (!m) return errObs("event.adjacent_changes", "UNRESOLVED_METRIC", `unknown metric "${label}"`);
      const events = computeAdjacentPeriodEvents(schema, grids, { kind: "row_axis_member", member: m }, periodIndex);
      // Stage 25.1.2 §2/§3 — canonical period strings, ALONGSIDE the existing
      // display columns, so a semantic audit can read the two periods this
      // event actually used without inferring it from display text.
      const rows = events.map((e) => [label, e.startPeriod.headerPath, e.endPeriod.headerPath, e.startValue, e.endValue, e.absoluteChange, e.percentageChange, e.startCell, e.endCell, e.startPeriod.canonical, e.endPeriod.canonical] as const);
      return tableObs("event.adjacent_changes", ["metric", "startPeriod", "endPeriod", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell", "startPeriodCanonical", "endPeriodCanonical"], rows);
    },
  );

  function eventExtreme(name: string, which: "max" | "min"): AgentTool<Readonly<Record<string, unknown>>> {
    return simpleTool(
      name,
      `Returns the adjacent-period change with the ${which === "max" ? "largest" : "smallest"} magnitude for ONE metric.`,
      { metric: "metric label", basis: '"absolute"|"percentage" (default "percentage")' },
      (input) => {
        const label = typeof input["metric"] === "string" ? input["metric"] : "";
        const m = memberByLabel.get(label);
        if (!m) return errObs(name, "UNRESOLVED_METRIC", `unknown metric "${label}"`);
        const basis = input["basis"] === "absolute" ? "absolute" : "percentage";
        const events = computeAdjacentPeriodEvents(schema, grids, { kind: "row_axis_member", member: m }, periodIndex);
        if (events.length === 0) return errObs(name, "INSUFFICIENT_POINTS", `"${label}" has fewer than 2 adjacent periods`);
        const mag = (e: (typeof events)[number]): number => (basis === "absolute" ? Math.abs(e.absoluteChange) : e.percentageChange === null ? -Infinity : Math.abs(e.percentageChange));
        const best = which === "max" ? Math.max(...events.map(mag)) : Math.min(...events.map(mag).filter((v) => v > -Infinity));
        const winners = events.filter((e) => Math.abs(mag(e) - best) <= 1e-9);
        const rows = winners.map((e) => [label, e.startPeriod.headerPath, e.endPeriod.headerPath, e.startValue, e.endValue, e.absoluteChange, e.percentageChange, e.startCell, e.endCell, e.startPeriod.canonical, e.endPeriod.canonical] as const);
        return tableObs(name, ["metric", "startPeriod", "endPeriod", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell", "startPeriodCanonical", "endPeriodCanonical"], rows);
      },
    );
  }
  const eventMaxAdjacent = eventExtreme("event.max_adjacent_change", "max");
  const eventMinAdjacent = eventExtreme("event.min_adjacent_change", "min");

  // --- REFERENCE / MEMORY (§42) -------------------------------------------------

  const referencePreviousMetricFocus = simpleTool(
    "reference.previous_metric_focus",
    'Returns the single metric currently "in focus" — the metric THIS turn already identified as its winner (if any step so far established one), otherwise the metric in focus from earlier in this conversation ("его", "он").',
    {},
    (_input, ctx) => {
      // Stage 25.1.3c §10 — priority order: a resolvedSubject already bound
      // to THIS request's own pronoun outranks everything else (it is not
      // "memory", it is the current request's own subject); then the winner
      // THIS run already established (Stage 25.1.3 §10/§11 — never the stale
      // pre-turn focus captured before this turn began); then stale
      // pre-turn focus.
      if (inherited.resolvedSubject) return tableObs("reference.previous_metric_focus", ["metric"], [[inherited.resolvedSubject.metricKey]]);
      // Stage 25.1.3e §6/§9 — the SAME validated, deterministic reduction
      // `determinePrimaryAnswer`/`commitPlannerOutputs` use for a "changed
      // the most" style ask, so a dependent clause within the same turn can
      // never resolve "it" to a different winner than the run's own primary
      // answer/committed focus. Falls back to the legacy reduction for every
      // other superlative, unchanged.
      const sameTurnWinner = determineValidatedWinner(ctx.priorResults, env.requestText)?.metricKey ?? determineSemanticWinner(ctx.priorResults, hasSuperlativeAsk(env.requestText));
      if (sameTurnWinner) return tableObs("reference.previous_metric_focus", ["metric"], [[sameTurnWinner]]);
      return inherited.metricFocus
        ? tableObs("reference.previous_metric_focus", ["metric"], [[inherited.metricFocus.metricKey]])
        : errObs("reference.previous_metric_focus", "STALE_CONTEXT", "no metric is in focus from earlier in this conversation");
    },
  );

  const referencePreviousMetricSet = simpleTool(
    "reference.previous_metric_set",
    'Returns the explicit metric set under discussion earlier in this conversation ("из них").',
    {},
    () =>
      inherited.metricSet
        ? tableObs("reference.previous_metric_set", ["metric"], inherited.metricSet.metricKeys.map((k) => [k] as const))
        : errObs("reference.previous_metric_set", "STALE_CONTEXT", "no metric set from earlier in this conversation"),
  );

  const referencePreviousResultSet = simpleTool(
    "reference.previous_result_set",
    "Returns the ordered ranking result from earlier in this conversation, without recomputing it.",
    {},
    () =>
      inherited.resultSet
        ? tableObs("reference.previous_result_set", ["metric", inherited.resultSet.scoreField], inherited.resultSet.rows.map((r) => [r.key, r.score] as const), {
            note: `operation=${inherited.resultSet.operation}`,
          })
        : errObs("reference.previous_result_set", "STALE_CONTEXT", "no ranking result from earlier in this conversation"),
  );

  // Stage 25.1.3f §3/§4 — the PREVIOUS TURN'S OWN RESULT, materialized in
  // this run so `set.filter` / `set.sort` / `set.top` can consume it by
  // resultId exactly like a table this turn computed itself. This is what
  // makes "Теперь покажи только показатели, которые снизились." a one-step
  // restriction of an existing universe instead of a full recomputation
  // against a freshly re-resolved workbook (§9).
  const referencePreviousResultTable = simpleTool(
    "reference.previous_result_table",
    'Returns the FULL result table computed by the previous analytical turn (all metrics and all of its columns), so this turn can filter/sort/slice it directly. Use it for any follow-up that continues the previous result ("теперь только те, что снизились", "из них…") — never recompute the previous result from scratch.',
    {},
    () => {
      const rt = inherited.resultTable;
      if (!rt || rt.columns.length === 0 || rt.rows.length === 0) {
        return errObs("reference.previous_result_table", "STALE_CONTEXT", "no analytical result from earlier in this conversation");
      }
      const interval = rt.startCanonical ? ` period=${rt.startCanonical}${rt.endCanonical ? `..${rt.endCanonical}` : ""}` : "";
      return tableObs("reference.previous_result_table", rt.columns, rt.rows, {
        note: `previous turn's result — operation=${rt.operation}, ${rt.rows.length} row(s)${interval}`,
      });
    },
  );

  const referencePreviousPeriod = simpleTool(
    "reference.previous_period",
    'Returns the period / interval referenced earlier in this conversation ("этот же период").',
    {},
    () => {
      if (!inherited.period) return errObs("reference.previous_period", "STALE_CONTEXT", "no period from earlier in this conversation");
      const start = periodByCanonical.get(inherited.period.startCanonical);
      const end = inherited.period.endCanonical ? periodByCanonical.get(inherited.period.endCanonical) : undefined;
      const rows: (readonly CellValue[])[] = [[inherited.period.startCanonical, start?.headerPath ?? inherited.period.startCanonical]];
      if (inherited.period.endCanonical) rows.push([inherited.period.endCanonical, end?.headerPath ?? inherited.period.endCanonical]);
      return tableObs("reference.previous_period", ["period", "headerPath"], rows);
    },
  );

  return createAgentToolRegistry([
    schemaDescribe,
    metricList,
    metricResolve,
    metricResolveSet,
    metricFilter,
    periodList,
    periodSelect,
    valueAtPeriod,
    seriesGet,
    aggregateMax,
    aggregateMin,
    aggregateAvg,
    changeCompute,
    changeComparePeriods,
    deriveCompute,
    setMerge,
    setFilter,
    setSort,
    setTop,
    setBottom,
    setArgmax,
    setArgmin,
    analysisTrend,
    analysisVolatility,
    analysisStability,
    analysisMonotonicity,
    analysisDirectionChanges,
    analysisTemporalPattern,
    eventAdjacentChanges,
    eventMaxAdjacent,
    eventMinAdjacent,
    referencePreviousMetricFocus,
    referencePreviousMetricSet,
    referencePreviousResultSet,
    referencePreviousResultTable,
    referencePreviousPeriod,
  ] as AgentTool[]);
}

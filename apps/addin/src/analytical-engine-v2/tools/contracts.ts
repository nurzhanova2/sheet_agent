// ---------------------------------------------------------------------------
// Stage 26.2 §6/§8/§64 — the shared tool contract.
//
// Every adapter in `tools/*-tools.ts` declares a typed input contract and the
// result types it accepts, and resolves its metric/period/result arguments
// through the helpers here — so "unknown metric", "invented date" and
// "incompatible input" are answered identically by every tool, with the same
// candidate lists that make the error recoverable (§15).
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import type { RowAxisMember, TableSchema } from "../../app/schema/schema-induction.js";
import { buildMetricIndex, resolveMetric, resolveMetricSet, type MetricIndex } from "../../app/schema/analytical/metric-resolver.js";
import { buildPeriodIndex, type PeriodIndex } from "../../app/schema/analytical/period-index.js";
import { getTemporalSeries } from "../../app/schema/analytical/temporal-series.js";
import type { CanonicalPeriod, ResolvedSubject, TemporalSeries } from "../../app/schema/analytical/types.js";
import type { ResultStore } from "../results/result-store.js";
import { fieldIndex } from "../results/result-store.js";
import type { AnalyticalConversationState } from "../state/conversation-state.js";
import { PER_METRIC_ROW_TYPES, toolError, type EngineResult, type ResultField, type ResultType, type ToolOutcome } from "../types.js";

export interface ToolEnv {
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  readonly periodIndex: PeriodIndex;
  readonly metricIndex: MetricIndex;
  readonly store: ResultStore;
  /** §19 — structured continuity; the ONLY way a turn reaches an earlier one. */
  readonly state: AnalyticalConversationState;
}

/**
 * §6 — one argument's contract line, rendered into the tool catalogue.
 *
 * Stage 26.3 §3/§8 adds the semantic reference types. `metricRef`/`periodRef`
 * are transported as a plain resultId string like `resultRef`; they are
 * distinct types so the catalogue, the validator and the §21 compatibility
 * matrix all know what a slot MEANS rather than only how it is spelled.
 */
export interface ArgSpec {
  readonly type: "string" | "number" | "boolean" | "string[]" | "resultRef" | "metricRef" | "periodRef" | "value" | "object";
  readonly required?: boolean;
  readonly describe: string;
}

/** Stage 26.3 §3 — argument types carried as a resultId string. */
export const REF_ARG_TYPES: ReadonlySet<ArgSpec["type"]> = new Set(["resultRef", "metricRef", "periodRef"]);

export interface ToolSpec {
  readonly name: string;
  /** §5 — what it does, what it takes, what it returns, when to use it. */
  readonly description: string;
  readonly args: Readonly<Record<string, ArgSpec>>;
  readonly returns: ResultType;
  /** §8 — result types this tool's `inputRef` accepts; omitted when it takes none. */
  readonly accepts?: readonly ResultType[];
  /** True when the tool reads the workbook grid (counts against maxWorkbookReads). */
  readonly reads: boolean;
  readonly run: (args: Readonly<Record<string, unknown>>, env: ToolEnv) => ToolOutcome;
}

// --- field shorthands --------------------------------------------------------

export const METRIC_FIELD: ResultField = { name: "metric", kind: "metric" };
export const num = (name: string): ResultField => ({ name, kind: "number" });
export const text = (name: string): ResultField => ({ name, kind: "text" });
export const period = (name: string): ResultField => ({ name, kind: "period" });
export const cell = (name: string): ResultField => ({ name, kind: "cell" });

// --- resolution helpers ------------------------------------------------------

export type Resolved<T> = T | { readonly error: ToolOutcome };

export function isErr<T>(v: Resolved<T>): v is { readonly error: ToolOutcome } {
  return typeof v === "object" && v !== null && "error" in (v as Record<string, unknown>);
}

export function subjectOf(member: RowAxisMember): ResolvedSubject {
  return { kind: "row_axis_member", member };
}

export function seriesOf(env: ToolEnv, member: RowAxisMember): TemporalSeries | null {
  return getTemporalSeries(env.schema, env.grids, subjectOf(member), env.periodIndex);
}

export function sortedPoints(env: ToolEnv): readonly CanonicalPeriod[] {
  return [...env.periodIndex.points].sort((a, b) => a.orderKey - b.orderKey);
}

/** One metric label → its row-axis member, with fuzzy resolution as a fallback. */
export function memberFor(env: ToolEnv, label: unknown): Resolved<RowAxisMember> {
  if (typeof label !== "string" || label.trim() === "") {
    return { error: toolError("INVALID_ARGUMENT", '"metric" must be a non-empty metric label') };
  }
  const exact = env.schema.rowAxis.find((m) => m.display === label);
  if (exact) return exact;
  const r = resolveMetric(label, env.metricIndex);
  if (r.kind === "resolved") {
    const m = env.schema.rowAxis.find((x) => x.display === r.entry.label);
    if (m) return m;
  }
  if (r.kind === "ambiguous") return { error: toolError("AMBIGUOUS_METRIC", `"${label}" matches several metrics`, r.candidates) };
  return { error: toolError("INVALID_ARGUMENT", `no metric matches "${label}"`, allMetricLabels(env)) };
}

export function allMetricLabels(env: ToolEnv): readonly string[] {
  return env.schema.rowAxis.map((m) => m.display);
}

/**
 * §19/§26 — the metric universe a tool should operate on: an explicit label
 * array, or the metric universe of an earlier result, or (only when neither is
 * given) every metric in the table.
 */
export function metricScope(args: Readonly<Record<string, unknown>>, env: ToolEnv): Resolved<{ readonly members: readonly RowAxisMember[]; readonly parents: readonly string[] }> {
  const parents: string[] = [];
  let labels: readonly string[] | null = null;

  if (args["inputRef"] !== undefined) {
    const src = inputResult(args["inputRef"], env);
    if (isErr(src)) return src;
    if (src.metricKeys.length === 0) {
      return { error: toolError("INCOMPATIBLE_INPUT", `result "${src.resultId}" names no metrics — it cannot scope a per-metric operation`) };
    }
    labels = src.metricKeys;
    parents.push(src.resultId);
  } else if (args["metrics"] !== undefined) {
    const raw = args["metrics"];
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((m) => typeof m === "string")) {
      return { error: toolError("INVALID_ARGUMENT", '"metrics" must be a non-empty array of metric labels') };
    }
    labels = raw as string[];
  }

  const members: RowAxisMember[] = [];
  for (const label of labels ?? allMetricLabels(env)) {
    const m = memberFor(env, label);
    if (isErr(m)) return m;
    members.push(m);
  }
  if (members.length === 0) return { error: toolError("INCOMPATIBLE_INPUT", "this table has no metrics to analyse") };
  return { members, parents };
}

/** A canonical period string → the indexed period. An invented date fails closed (§24). */
export function periodFor(env: ToolEnv, canonical: unknown): Resolved<CanonicalPeriod> {
  if (typeof canonical !== "string" || canonical === "") {
    return { error: toolError("INVALID_ARGUMENT", "a period must be a canonical period string obtained from a period.* tool") };
  }
  const p = env.periodIndex.points.find((x) => x.canonical === canonical);
  if (!p) {
    return { error: toolError("AMBIGUOUS_PERIOD", `"${canonical}" is not a period of this table`, sortedPoints(env).map((x) => x.canonical)) };
  }
  return p;
}

/** A resultId → the stored result. */
export function inputResult(ref: unknown, env: ToolEnv): Resolved<EngineResult> {
  if (typeof ref !== "string" || ref === "") return { error: toolError("INVALID_ARGUMENT", '"inputRef" must be the resultId of an earlier tool result') };
  const r = env.store.get(ref);
  if (!r) return { error: toolError("UNKNOWN_REFERENCE", `no result "${ref}" in this analysis`, env.store.ids()) };
  return r;
}

/**
 * §8 — a result whose rows are one-per-metric AND which carries `field` as a
 * numeric column. This is the check that stops `set.filter(seriesRef,
 * field:"percentageChange")`: a series has one row per PERIOD, so filtering it
 * by a per-metric change field is a category error, not a near miss.
 */
export function numericPerMetricInput(args: Readonly<Record<string, unknown>>, env: ToolEnv, fieldArg = "field"): Resolved<{ readonly src: EngineResult; readonly field: string; readonly index: number }> {
  const src = inputResult(args["inputRef"], env);
  if (isErr(src)) return src;
  if (!PER_METRIC_ROW_TYPES.has(src.type)) {
    return {
      error: toolError(
        "INCOMPATIBLE_INPUT",
        `"${src.resultId}" is a ${src.type} result (its rows are not one-per-metric), so it cannot be filtered or ranked by a metric field`,
      ),
    };
  }
  const field = typeof args[fieldArg] === "string" ? (args[fieldArg] as string) : "";
  const index = fieldIndex(src, field);
  if (index < 0) {
    return { error: toolError("INVALID_ARGUMENT", `"${src.resultId}" has no field "${field}"`, src.fields.map((f) => f.name)) };
  }
  if (src.fields[index]!.kind !== "number") {
    return { error: toolError("INCOMPATIBLE_INPUT", `field "${field}" of "${src.resultId}" is not numeric`, src.fields.filter((f) => f.kind === "number").map((f) => f.name)) };
  }
  return { src, field, index };
}

/**
 * Stage 26.3 §12/§13 — the same per-metric input check, but for ANY declared
 * field kind rather than numeric only. `set.filter` uses this so a categorical
 * column (`analysis.trend`'s `direction`) can be filtered; the numeric-only
 * `numericPerMetricInput` above still guards sorting and ranking, which
 * genuinely need numbers.
 */
export function perMetricFieldInput(
  args: Readonly<Record<string, unknown>>,
  env: ToolEnv,
  fieldArg = "field",
): Resolved<{ readonly src: EngineResult; readonly field: string; readonly index: number; readonly kind: ResultField["kind"] }> {
  const src = inputResult(args["inputRef"], env);
  if (isErr(src)) return src;
  if (!PER_METRIC_ROW_TYPES.has(src.type)) {
    return {
      error: toolError(
        "INCOMPATIBLE_INPUT",
        `"${src.resultId}" is a ${src.type} result (its rows are not one-per-metric), so it cannot be filtered or ranked by a metric field`,
      ),
    };
  }
  const field = typeof args[fieldArg] === "string" ? (args[fieldArg] as string) : "";
  const index = fieldIndex(src, field);
  if (index < 0) {
    return { error: toolError("INVALID_ARGUMENT", `"${src.resultId}" has no field "${field}"`, src.fields.map((f) => f.name)) };
  }
  return { src, field, index, kind: src.fields[index]!.kind };
}

export function numberAt(row: readonly CellValue[], index: number): number | null {
  const v = row[index];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Resolves a free-text metric phrase into a set (reuses the Stage 24 resolver). */
export function resolveSetPhrase(env: ToolEnv, phrase: string): Resolved<readonly string[]> {
  const r = resolveMetricSet(phrase, env.metricIndex);
  if (r.kind === "resolved") return r.entries.map((e) => e.label);
  if (r.kind === "ambiguous") return { error: toolError("AMBIGUOUS_METRIC", `"${phrase}" matches several metrics`, r.candidates) };
  return { error: toolError("INVALID_ARGUMENT", `no metrics match "${phrase}"`, allMetricLabels(env)) };
}

export function buildToolEnv(schema: TableSchema, grids: AnalysisGrids, store: ResultStore, state: AnalyticalConversationState): ToolEnv {
  return { schema, grids, periodIndex: buildPeriodIndex(schema, grids), metricIndex: buildMetricIndex(schema), store, state };
}

import type { RowAxisMember } from "../../app/schema/schema-induction.js";
import type { CanonicalPeriod } from "../../app/schema/analytical/types.js";
import type { PeriodIndex } from "../../app/schema/analytical/period-index.js";
import { toolError, type EngineResult, type PeriodIntent } from "../types.js";
import { isErr, memberFor, periodFor, sortedPoints, unknownReference, type Resolved, type ToolEnv } from "./contracts.js";

/** A resultId as the planner spells it. Used to catch one pushed into a literal slot. */
export const RESULT_ID_RE = /^result_\d+$/;

/** §8 — the canonical reference spelling for a semantic scalar argument. */
export const refNameFor = (literalArg: string): string => `${literalArg}Ref`;

export interface ResolvedRef<T> {
  readonly value: T;
  /** §11 — lineage: the result this value was dereferenced from, if any. */
  readonly parents: readonly string[];
  readonly viaRef: boolean;
}

function storedResult(ref: unknown, env: ToolEnv, argName: string): Resolved<EngineResult> {
  if (typeof ref !== "string" || ref === "") {
    return { error: toolError("INVALID_ARGUMENT", `"${argName}" must be the resultId of an earlier tool result`) };
  }
  const r = env.store.get(ref);
  if (!r) return { error: unknownReference(ref, env) };
  if (r.sourceVersion !== env.schema.sourceVersion) {
    return { error: toolError("STALE_REFERENCE", `"${ref}" was computed before the table changed — recompute it`) };
  }
  return r;
}

/**
 * §3/§4 — a single METRIC, given either literally or as a reference to a
 * result that names exactly one. Cardinality is the type gate: a result that
 * names no metric (a period, a schema) or several (a comparison over the whole
 * table) is refused with a typed, recoverable error.
 */
export function resolveMetricInput(
  args: Readonly<Record<string, unknown>>,
  env: ToolEnv,
  literalArg = "metric",
): Resolved<ResolvedRef<RowAxisMember>> {
  const refArg = refNameFor(literalArg);
  const ref = args[refArg];
  const literal = args[literalArg];

  if (ref !== undefined) {
    const src = storedResult(ref, env, refArg);
    if (isErr(src)) return src;
    const keys = src.metricKeys;
    if (keys.length === 0) {
      return {
        error: toolError(
          "INCOMPATIBLE_INPUT",
          `"${src.resultId}" is a ${src.type} result and names no metric, so it cannot supply "${literalArg}"`,
        ),
      };
    }
    if (keys.length > 1) {
      return {
        error: toolError(
          "INCOMPATIBLE_INPUT",
          `"${src.resultId}" names ${keys.length} metrics, but "${literalArg}" needs exactly one — rank or filter it down to a single metric first`,
          keys,
        ),
      };
    }
    const member = memberFor(env, keys[0]);
    if (isErr(member)) return member;
    return { value: member, parents: [src.resultId], viaRef: true };
  }

  if (literal === undefined) {
    return { error: toolError("INVALID_ARGUMENT", `"${literalArg}" (a label) or "${refArg}" (a result reference) is required`) };
  }
  const member = memberFor(env, literal);
  if (isErr(member)) return member;
  return { value: member, parents: [], viaRef: false };
}

/**
 * §3/§4/§7 — a single PERIOD, literally or by reference. A result qualifies
 * only when it names exactly one period, so `period.latest` → `period.previous`
 * composes while a two-period comparison is refused as ambiguous.
 */
export function resolvePeriodInput(
  args: Readonly<Record<string, unknown>>,
  env: ToolEnv,
  literalArg: string,
): Resolved<ResolvedRef<CanonicalPeriod>> {
  const refArg = refNameFor(literalArg);
  const ref = args[refArg];
  const literal = args[literalArg];

  if (ref !== undefined) {
    const src = storedResult(ref, env, refArg);
    if (isErr(src)) return src;
    const canonicals = src.periodCanonicals;
    if (canonicals.length === 0) {
      return {
        error: toolError(
          "INCOMPATIBLE_INPUT",
          `"${src.resultId}" is a ${src.type} result and names no period, so it cannot supply "${literalArg}"`,
        ),
      };
    }
    if (canonicals.length > 1) {
      return {
        error: toolError(
          "INCOMPATIBLE_INPUT",
          `"${src.resultId}" spans ${canonicals.length} periods, but "${literalArg}" needs exactly one — name the endpoint you mean`,
          canonicals,
        ),
      };
    }
    const point = periodFor(env, canonicals[0]);
    if (isErr(point)) return point;
    return { value: point, parents: [src.resultId], viaRef: true };
  }

  if (literal === undefined) {
    return { error: toolError("INVALID_ARGUMENT", `"${literalArg}" (a canonical period) or "${refArg}" (a result reference) is required`) };
  }
  const point = periodFor(env, literal);
  if (isErr(point)) return point;
  return { value: point, parents: [], viaRef: false };
}

/** Shared wording for the catalogue, so every ref argument reads the same (§9). */
export const METRIC_REF_DESCRIBE =
  "the resultId of an earlier result naming exactly one metric (e.g. from metric.resolve, set.argmax or reference.last_metric) — use this instead of retyping the label";
export const PERIOD_REF_DESCRIBE =
  "the resultId of an earlier result naming exactly one period (e.g. from period.latest, period.previous or period.resolve) — use this instead of retyping the date";

/** All period labels, for a recoverable error (§5). */
export const allPeriodCanonicals = (env: ToolEnv): readonly string[] => sortedPoints(env).map((p) => p.canonical);

export interface ResolvedPeriodIntent {
  readonly intent: PeriodIntent;
  readonly periods: readonly CanonicalPeriod[];
}

export type PeriodIntentResolution =
  | { readonly ok: true; readonly value: ResolvedPeriodIntent }
  | { readonly ok: false; readonly message: string };

/** The sole V2 authority that turns a semantic intent into canonical periods. */
export function resolvePeriodIntent(intent: PeriodIntent, periodIndex: PeriodIndex): PeriodIntentResolution {
  const points = [...periodIndex.points].sort((a, b) => a.orderKey - b.orderKey);
  const named = (canonical: string): CanonicalPeriod | undefined => points.find((point) => point.canonical === canonical);
  switch (intent.kind) {
    case "latest_vs_previous":
      return points.length >= 2
        ? { ok: true, value: { intent, periods: [points[points.length - 2]!, points[points.length - 1]!] } }
        : { ok: false, message: "the table has fewer than two periods, so latest_vs_previous cannot be resolved" };
    case "named_pair": {
      const start = named(intent.start);
      const end = named(intent.end);
      return start && end
        ? { ok: true, value: { intent, periods: [start, end] } }
        : { ok: false, message: "named_pair must use canonical periods from this table" };
    }
    case "full_range":
      return points.length > 0 ? { ok: true, value: { intent, periods: points } } : { ok: false, message: "the table has no dated periods" };
    case "single": {
      const at = named(intent.at);
      return at ? { ok: true, value: { intent, periods: [at] } } : { ok: false, message: "single must use a canonical period from this table" };
    }
  }
}

function readPeriodIntent(value: unknown): PeriodIntent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "latest_vs_previous" || record["kind"] === "full_range") return { kind: record["kind"] };
  if (record["kind"] === "named_pair" && typeof record["start"] === "string" && typeof record["end"] === "string") return { kind: "named_pair", start: record["start"], end: record["end"] };
  if (record["kind"] === "single" && typeof record["at"] === "string") return { kind: "single", at: record["at"] };
  return null;
}

/** Adapts the central resolver for change tools; endpoint pairs need named_pair. */
export function resolveComparisonPeriodIntent(args: Readonly<Record<string, unknown>>, env: ToolEnv): Resolved<Readonly<Record<string, unknown>>> {
  const intent = readPeriodIntent(args["periodIntent"]);
  if (!intent) return { error: toolError("INVALID_ARGUMENT", '"periodIntent" is required: use latest_vs_previous, named_pair, or full_range', allPeriodCanonicals(env)) };
  const hasEndpoint = args["startPeriod"] !== undefined || args["startPeriodRef"] !== undefined || args["endPeriod"] !== undefined || args["endPeriodRef"] !== undefined;
  if (hasEndpoint && intent.kind !== "named_pair") {
    return { error: toolError("INVALID_ARGUMENT", 'period endpoints require periodIntent.kind "named_pair"; use latest_vs_previous without endpoints for the current comparison', allPeriodCanonicals(env)) };
  }
  if (intent.kind === "named_pair" && (args["startPeriod"] !== undefined || args["endPeriod"] !== undefined) && (args["startPeriod"] !== intent.start || args["endPeriod"] !== intent.end)) {
    return { error: toolError("INVALID_ARGUMENT", 'startPeriod and endPeriod must exactly match periodIntent named_pair', allPeriodCanonicals(env)) };
  }
  const resolved = resolvePeriodIntent(intent, env.periodIndex);
  if (!resolved.ok) return { error: toolError("INVALID_ARGUMENT", resolved.message, allPeriodCanonicals(env)) };
  if (resolved.value.periods.length < 2) return { error: toolError("INVALID_ARGUMENT", `${intent.kind} resolves to one period and cannot be used by a change comparison`, allPeriodCanonicals(env)) };
  const periods = resolved.value.periods;
  return { ...args, startPeriod: periods[0]!.canonical, endPeriod: periods[periods.length - 1]!.canonical, periodIntent: resolved.value.intent };
}

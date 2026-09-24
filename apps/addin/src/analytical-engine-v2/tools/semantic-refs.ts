import type { RowAxisMember } from "../../app/schema/schema-induction.js";
import type { CanonicalPeriod } from "../../app/schema/analytical/types.js";
import { toolError, type EngineResult } from "../types.js";
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

export function periodPairDefaults(args: Readonly<Record<string, unknown>>, env: ToolEnv): Resolved<Readonly<Record<string, unknown>>> {
  const hasStart = args["startPeriod"] !== undefined || args["startPeriodRef"] !== undefined;
  const hasEnd = args["endPeriod"] !== undefined || args["endPeriodRef"] !== undefined;
  if (hasStart && hasEnd) return args;

  const points = sortedPoints(env);
  if (points.length < 2) {
    return { error: toolError("INVALID_ARGUMENT", "the table has fewer than two periods, so a comparison needs both endpoints named", allPeriodCanonicals(env)) };
  }

  if (!hasStart && !hasEnd) {
    return { ...args, startPeriod: points[points.length - 2]!.canonical, endPeriod: points[points.length - 1]!.canonical };
  }
  if (!hasEnd) return { ...args, endPeriod: points[points.length - 1]!.canonical };

  const endLiteral = args["endPeriod"];
  if (typeof endLiteral !== "string") {
    return { error: toolError("INVALID_ARGUMENT", '"startPeriod" (a canonical period) or "startPeriodRef" (a result reference) is required', allPeriodCanonicals(env)) };
  }
  const at = points.findIndex((p) => p.canonical === endLiteral);
  if (at < 1) {
    return {
      error: toolError(
        "INVALID_ARGUMENT",
        at === 0
          ? `"${endLiteral}" is the earliest period in the table, so there is no period before it to compare against`
          : '"startPeriod" (a canonical period) or "startPeriodRef" (a result reference) is required',
        allPeriodCanonicals(env),
      ),
    };
  }
  return { ...args, startPeriod: points[at - 1]!.canonical };
}

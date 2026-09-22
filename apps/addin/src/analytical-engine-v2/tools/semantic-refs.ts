// ---------------------------------------------------------------------------
// Stage 26.3 §3/§4/§5/§11 — the canonical semantic-reference layer.
//
// Stage 26.2L's dominant failure was structural, not cognitive: the planner
// picked the right tool and then could not hand it the previous tool's result.
// 58 of 87 tool errors were a reference pushed into a slot that only accepted
// a literal string, across 36 of 50 turns.
//
// The fix is ONE shared dereferencer, not per-tool special cases (§5). Every
// semantic scalar input now has two spellings:
//
//     series.get { metric: "Доля брака" }        — a literal, still valid (§10)
//     series.get { metricRef: "result_1" }       — a typed reference (§3)
//
// The `<arg>Ref` sibling is the single canonical representation (§8): a flat
// resultId string, which structured generation emits reliably, and which can
// never be confused with a label the way an overloaded slot could.
//
// Coercion stays STRONGLY TYPED (§4). There is deliberately no
// `resolveAnyResultRefToString`. A result qualifies as a metric only if it
// NAMES exactly one metric, and as a period only if it names exactly one
// period — so a period result can never satisfy a metric slot, a comparison
// (two periods) can never satisfy a single-period slot, and a multi-metric set
// is refused with its members listed rather than silently taking the first.
// ---------------------------------------------------------------------------

import type { RowAxisMember } from "../../app/schema/schema-induction.js";
import type { CanonicalPeriod } from "../../app/schema/analytical/types.js";
import { toolError, type EngineResult } from "../types.js";
import { isErr, memberFor, periodFor, sortedPoints, type Resolved, type ToolEnv } from "./contracts.js";

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
  if (!r) return { error: toolError("UNKNOWN_REFERENCE", `no result "${ref}" in this analysis`, env.store.ids()) };
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

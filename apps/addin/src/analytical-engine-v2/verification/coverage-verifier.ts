import type { CompleteDecision, PlannedOutput } from "../types.js";

export interface CoverageInput {
  /** What the PLANNER declared this turn has to produce (§10/§11). */
  readonly declaredOutputs: readonly PlannedOutput[];
  readonly decision: CompleteDecision;
  /** Whether a bound `resultRef` names a result that actually exists. */
  readonly knownResult: (resultId: string) => boolean;
}

export interface CoverageResult {
  readonly ok: boolean;
  /** How many outputs the planner declared. */
  readonly declared: number;
  /** How many of them are bound to a result that exists. */
  readonly bound: number;
  readonly unsatisfied: readonly string[];
  readonly detail?: string;
}

/**
 * Stage 26.4 §12/§13 · Stage 28G §11 — COVERAGE, and nothing else.
 *
 * The question is "is every output the planner ITSELF declared bound to a
 * result that exists, and is the primary one of them?". It is answered from
 * the planner contract — `PlanDecision.outputs` against
 * `CompleteDecision.outputBindings` — and never from the user's sentence. The
 * count N comes from the planner, so a second language parser cannot disagree
 * with the planner about how many parts a request has.
 *
 * A single declared output needs no binding: it IS the answer. This never
 * ranks results and never substitutes a primary — that is §9's job, not this
 * one's.
 */
export function verifyCoverage(input: CoverageInput): CoverageResult {
  const declared = input.declaredOutputs.length;
  const bindings = input.decision.outputBindings ?? [];
  if (declared < 2) return { ok: true, declared, bound: declared, unsatisfied: [] };

  const bound = new Map(bindings.map((b) => [b.outputId, b.resultRef]));
  const satisfied = input.declaredOutputs.filter((o) => {
    const ref = bound.get(o.id);
    return ref !== undefined && input.knownResult(ref);
  });
  const missing = input.declaredOutputs.filter((o) => !satisfied.includes(o));
  if (missing.length > 0) {
    return {
      ok: false,
      declared,
      bound: satisfied.length,
      unsatisfied: missing.map((o) => o.id),
      detail: `your completion does not account for every output you declared — unbound or unknown: ${missing.map((o) => `${o.id} (${o.description})`).join("; ")}`,
    };
  }

  const refs = new Set(bindings.map((b) => b.resultRef));
  if (!refs.has(input.decision.primaryResultRef)) {
    return {
      ok: false,
      declared,
      bound: satisfied.length,
      unsatisfied: [],
      detail: `"${input.decision.primaryResultRef}" is not bound to any declared output — the primary must be one of the results you bound`,
    };
  }
  return { ok: true, declared, bound: satisfied.length, unsatisfied: [] };
}

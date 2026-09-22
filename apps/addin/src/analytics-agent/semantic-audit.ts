// ---------------------------------------------------------------------------
// Stage 25.1 §24/§25/§29/§30 — the semantic execution audit.
//
// Numeric grounding (Stage 25's evidence gate) proves every number came from
// a tool. It does NOT prove the numbers answer the question the user asked,
// or that a change row's sign is internally consistent. These are pure,
// independently-testable checks over already-computed structures — no new
// calculation engine, no phrase-specific rule.
// ---------------------------------------------------------------------------

import type { AgentObservation, AgentStep } from "../agent/types.js";
import type { CanonicalOperationKind, RankingBasisField, TemporalMode } from "./semantic-frame.js";

export type SemanticAuditFailureCode =
  | "CANDIDATE_SET_WIDENED"
  | "CANDIDATE_SET_NARROWED"
  | "CHANGE_SIGN_INCONSISTENT"
  | "PERIOD_SUBSTITUTION"
  | "WRONG_OPERATION"
  | "CLAUSE_DROPPED"
  | "CLAUSE_TARGET_MISMATCH"
  | "RANKING_BASIS_MISMATCH"
  | "EXPLORATORY_CARDINALITY_MISMATCH"
  | "EXPLORATORY_EXPLANATION_MISSING"
  | "UNNORMALIZED_MEAN_DEVIATION"
  | "RESULT_SHAPE_MISMATCH"
  | "WINNER_CONSISTENCY_MISMATCH";

export interface SemanticAuditFailure {
  readonly code: SemanticAuditFailureCode;
  readonly detail: string;
}

export interface SemanticAuditResult {
  readonly ok: boolean;
  readonly failures: readonly SemanticAuditFailure[];
}

const EPS = 1e-6;

/**
 * §29/§30/§60/§92 — for any change row, the sign of the absolute change must
 * agree with (end - start), and (when start is non-zero) the sign of the
 * percentage change must agree with the sign of the absolute change. Reads
 * the STRUCTURED numeric fields only — never a rendered/displayed string
 * (§31 "never trust a previous displayed delta").
 */
export function auditChangeRowSigns(
  rows: readonly { readonly startValue: number; readonly endValue: number; readonly absoluteChange: number; readonly percentageChange?: number | null }[],
): SemanticAuditResult {
  const failures: SemanticAuditFailure[] = [];
  for (const r of rows) {
    const expectedAbs = r.endValue - r.startValue;
    if (Math.abs(expectedAbs - r.absoluteChange) > Math.max(EPS, Math.abs(expectedAbs) * 1e-6)) {
      failures.push({
        code: "CHANGE_SIGN_INCONSISTENT",
        detail: `absoluteChange ${r.absoluteChange} does not equal end(${r.endValue}) - start(${r.startValue})`,
      });
      continue;
    }
    if (Math.abs(r.startValue) > EPS && typeof r.percentageChange === "number" && r.percentageChange !== null) {
      const sameSign = Math.sign(r.percentageChange) === Math.sign(r.absoluteChange) || Math.abs(r.absoluteChange) <= EPS;
      if (!sameSign) {
        failures.push({
          code: "CHANGE_SIGN_INCONSISTENT",
          detail: `percentageChange ${r.percentageChange} disagrees in sign with absoluteChange ${r.absoluteChange}`,
        });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

/** Scans every successful change.compute / change.compare_periods observation
 *  in a planner run for sign consistency (§29/§30, applied generically). */
export function auditObservationChangeSigns(observations: readonly AgentObservation[]): SemanticAuditResult {
  const failures: SemanticAuditFailure[] = [];
  for (const obs of observations) {
    if (!obs.ok || (obs.tool !== "change.compute" && obs.tool !== "change.compare_periods") || !obs.columns || !obs.rows) continue;
    const cols = obs.columns;
    const idx = (name: string): number => cols.indexOf(name);
    const si = idx("startValue");
    const ei = idx("endValue");
    const ai = idx("absoluteChange");
    const pi = idx("percentageChange");
    if (si < 0 || ei < 0 || ai < 0) continue;
    const rows = obs.rows.map((r) => ({
      startValue: Number(r[si]),
      endValue: Number(r[ei]),
      absoluteChange: Number(r[ai]),
      percentageChange: pi >= 0 && r[pi] !== null ? Number(r[pi]) : null,
    }));
    const result = auditChangeRowSigns(rows);
    failures.push(...result.failures);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * §17/§18/§69/§89 — when the user named an EXPLICIT candidate set, the
 * executed metric universe must match it exactly (no silent widening to
 * "almost all workbook indicators", no silent narrowing either). `requested
 * === null` means no explicit set was named — always passes.
 */
export function auditCandidateSet(requested: readonly string[] | null, executed: readonly string[]): SemanticAuditResult {
  if (requested === null) return { ok: true, failures: [] };
  const req = new Set(requested);
  const exec = new Set(executed);
  const extra = [...exec].filter((k) => !req.has(k));
  const missing = [...req].filter((k) => !exec.has(k));
  const failures: SemanticAuditFailure[] = [];
  if (extra.length > 0) failures.push({ code: "CANDIDATE_SET_WIDENED", detail: `executed universe includes unrequested metric(s): ${extra.join(", ")}` });
  if (missing.length > 0) failures.push({ code: "CANDIDATE_SET_NARROWED", detail: `executed universe is missing requested metric(s): ${missing.join(", ")}` });
  return { ok: failures.length === 0, failures };
}

/**
 * Stage 25.1.2 §2/§3 — the FINAL two-point interval the run's calculation
 * actually used to produce its answer, never every period.select/period.list
 * the planner legitimately touched while exploring the schema (listing all
 * periods before picking one is normal plumbing, not a substitution).
 */
export interface ExecutedIntervalRef {
  readonly startPeriod: string;
  readonly endPeriod: string;
  readonly sourceOperation: string;
}

// change.compute/change.compare_periods take their two periods as INPUT
// (already canonical strings — see tool-registry.ts's periodOf()); the
// event.* tools echo the two periods they used as canonical OUTPUT columns.
const INTERVAL_INPUT_TOOLS: ReadonlySet<string> = new Set(["change.compute", "change.compare_periods"]);
const INTERVAL_OUTPUT_TOOLS: ReadonlySet<string> = new Set(["event.adjacent_changes", "event.max_adjacent_change", "event.min_adjacent_change"]);

/**
 * §2/§3 — walks the step trace BACKWARDS and returns the periods of the LAST
 * successful tool call that actually defines a two-point comparison. Never
 * infers this from period.select/period.list results, which are plumbing.
 */
export function extractExecutedInterval(steps: readonly AgentStep[]): ExecutedIntervalRef | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (step.decision.kind !== "tool_call" || !step.observation || !step.observation.ok) continue;
    const tool = step.decision.tool;
    if (INTERVAL_INPUT_TOOLS.has(tool)) {
      const start = step.decision.input["startPeriod"];
      const end = step.decision.input["endPeriod"];
      if (typeof start === "string" && typeof end === "string" && start && end) {
        return { startPeriod: start, endPeriod: end, sourceOperation: tool };
      }
    }
    if (INTERVAL_OUTPUT_TOOLS.has(tool)) {
      const obs = step.observation;
      const sci = obs.columns?.indexOf("startPeriodCanonical") ?? -1;
      const eci = obs.columns?.indexOf("endPeriodCanonical") ?? -1;
      if (sci >= 0 && eci >= 0 && obs.rows && obs.rows.length > 0) {
        const start = String(obs.rows[0]![sci] ?? "");
        const end = String(obs.rows[0]![eci] ?? "");
        if (start && end) return { startPeriod: start, endPeriod: end, sourceOperation: tool };
      }
    }
  }
  return null;
}

/**
 * §2/§3/§6/§7/§19/§20/§41 — when the sentence named an explicit temporal
 * mode ("previous_to_last" / "first_to_last"), the FINAL executed analytical
 * interval (never every period touched by schema-exploration plumbing) must
 * be exactly the expected pair. `mode === null` (no explicit temporal
 * request) always passes.
 */
export function auditPeriodFidelity(
  mode: TemporalMode | null,
  interval: ExecutedIntervalRef | null,
  anchors: { readonly first: string; readonly previous: string; readonly last: string },
): SemanticAuditResult {
  if (mode === null) return { ok: true, failures: [] };
  const expected = mode === "previous_to_last" ? [anchors.previous, anchors.last] : [anchors.first, anchors.last];
  if (!interval) {
    return { ok: false, failures: [{ code: "PERIOD_SUBSTITUTION", detail: `expected ${expected.join(" -> ")}, no final analytical interval was found` }] };
  }
  const touched = new Set([interval.startPeriod, interval.endPeriod]);
  const ok = touched.size === 2 && expected.every((p) => touched.has(p));
  if (ok) return { ok: true, failures: [] };
  return {
    ok: false,
    failures: [{ code: "PERIOD_SUBSTITUTION", detail: `expected ${expected.join(" -> ")}, executed ${interval.startPeriod} -> ${interval.endPeriod} (via ${interval.sourceOperation})` }],
  };
}

// §38 — Stage 24.x has NO compiled operation for any of these; "trend vs
// latest direction" (§29) is deliberately EXCLUDED from the hard fidelity
// gate — it already works and has no reliable tool-sequence inference here,
// so gating it risks a false rejection of a request the brief says to
// preserve exactly as-is.
const OPERATION_FIDELITY_EXEMPT: ReadonlySet<CanonicalOperationKind> = new Set(["trend_vs_latest_direction"]);

/**
 * §38 — infers the operation a completed planner run actually performed
 * from its TOOL SEQUENCE (never trusts an LLM-provided label, per §38's own
 * instruction). Conservative: returns `null` ("could not tell / not one of
 * the audited kinds") whenever the sequence is ambiguous — a `null` never
 * fails the fidelity audit against a *different* requested kind by itself
 * (see `auditOperationFidelity`), it only fails when a SPECIFIC different
 * kind was positively inferred.
 */
export type InferredOperationKind = CanonicalOperationKind | "plain_change_comparison" | "plain_volatility_rank";

export function inferExecutedOperationKind(observations: readonly AgentObservation[]): InferredOperationKind | null {
  const ok = observations.filter((o) => o.ok);
  const tools = new Set(ok.map((o) => o.tool));
  const pattern = ok.find((o) => o.tool === "analysis.temporal_pattern");
  if (pattern?.note?.includes("pattern=down_then_up")) return "temporal_pattern_down_then_up";
  if (pattern?.note?.includes("pattern=up_then_down")) return "temporal_pattern_up_then_down";
  const hasDerive = tools.has("derive.compute");
  if (tools.has("aggregate.avg") && hasDerive) return "latest_vs_mean";
  if (tools.has("aggregate.max") && hasDerive) return "historical_extreme_distance";
  const hasChange = tools.has("change.compute") || tools.has("change.compare_periods");
  const hasVolatility = tools.has("analysis.volatility") || tools.has("analysis.stability");
  if (hasVolatility && hasChange) return "stable_growth";
  // §58 — a definite, unambiguous NON-match: a plain period-to-period change
  // with no historical-extreme/derive step at all is never a peak-distance,
  // mean-deviation, or pattern analysis.
  if (hasChange && !hasDerive && !tools.has("aggregate.max") && !tools.has("aggregate.avg")) return "plain_change_comparison";
  if (hasVolatility && !hasChange) return "plain_volatility_rank";
  return null;
}

/**
 * §5/§37/§58/§60 — the requested operation kind (when the sentence names
 * one Stage 24.x cannot represent) must match what was actually executed.
 */
export function auditOperationFidelity(requested: CanonicalOperationKind | null, observations: readonly AgentObservation[]): SemanticAuditResult {
  if (requested === null || OPERATION_FIDELITY_EXEMPT.has(requested)) return { ok: true, failures: [] };
  const executed = inferExecutedOperationKind(observations);
  if (executed === requested) return { ok: true, failures: [] };
  if (executed === null) return { ok: true, failures: [] }; // ambiguous tool sequence — do not false-reject
  return { ok: false, failures: [{ code: "WRONG_OPERATION", detail: `requested "${requested}" but executed "${executed}"` }] };
}

/**
 * §16/§17/§61 — every requested clause must have a corresponding successful
 * structured output. `executedOutputs` is a caller-supplied count (the
 * number of distinct "answer-shaped" tool results the run produced) — kept
 * as a pure comparator so it stays trivially testable against §61's exact
 * shape without coupling to the tool registry's naming.
 */
export function auditClauseCompleteness(requestedClauses: number, executedOutputs: number): SemanticAuditResult {
  if (executedOutputs >= requestedClauses) return { ok: true, failures: [] };
  return { ok: false, failures: [{ code: "CLAUSE_DROPPED", detail: `requested ${requestedClauses} clause(s), only ${executedOutputs} produced a structured output` }] };
}

// Tool names whose output represents a distinct "answer" a clause could ask
// for — set/metric.list/period.* are plumbing, never a clause's own answer.
export const ANSWER_SHAPED_TOOLS: ReadonlySet<string> = new Set([
  "series.get",
  "event.adjacent_changes",
  "event.max_adjacent_change",
  "event.min_adjacent_change",
  "analysis.volatility",
  "analysis.stability",
  "analysis.monotonicity",
  "analysis.direction_changes",
  "analysis.trend",
  "analysis.temporal_pattern",
  "change.compute",
  "change.compare_periods",
  "aggregate.max",
  "aggregate.min",
  "aggregate.avg",
  "value.at_period",
]);

/** Counts the distinct answer-shaped tool results a completed run produced —
 *  the `executedOutputs` input to `auditClauseCompleteness`. */
export function countAnswerShapedOutputs(observations: readonly AgentObservation[]): number {
  return new Set(observations.filter((o) => o.ok && ANSWER_SHAPED_TOOLS.has(o.tool)).map((o) => o.tool)).size;
}

// Stage 25.1.3 §10/§12 — series.get/event.* CONSUME a single metric; these
// tools PRODUCE a single-row winner (a semantic-winner candidate). Both
// groups must agree on the SAME metric within one compound run.
const TARGET_CONSUMER_TOOLS: ReadonlySet<string> = new Set(["series.get", "event.adjacent_changes", "event.max_adjacent_change", "event.min_adjacent_change"]);
const TARGET_WINNER_TOOLS: ReadonlySet<string> = new Set(["set.argmax", "set.argmin", "set.top", "set.bottom", "event.max_adjacent_change", "event.min_adjacent_change", "aggregate.max", "aggregate.min"]);

/**
 * §10/§12/§20/§62 — for a dependent compound request, every single-metric-
 * scoped consumer (series.get/event.*) must target the SAME metric a
 * winner-producing step (set.argmax/analysis.volatility→top1/…) established
 * earlier in the SAME run — never a stale one re-resolved from conversation
 * state. Reads the "metric" column each such tool echoes; a winner tool only
 * contributes its target when it produced exactly one row (an unambiguous
 * single winner, not a supporting multi-row table).
 */
export function auditClauseTargetConsistency(observations: readonly AgentObservation[]): SemanticAuditResult {
  const targets = new Set<string>();
  for (const obs of observations) {
    if (!obs.ok || !obs.columns || !obs.rows) continue;
    const ci = obs.columns.indexOf("metric");
    if (ci < 0) continue;
    if (TARGET_CONSUMER_TOOLS.has(obs.tool)) {
      for (const r of obs.rows) {
        const v = String(r[ci] ?? "");
        if (v) targets.add(v);
      }
    } else if (TARGET_WINNER_TOOLS.has(obs.tool) && obs.rows.length === 1) {
      const v = String(obs.rows[0]![ci] ?? "");
      if (v) targets.add(v);
    }
  }
  if (targets.size <= 1) return { ok: true, failures: [] };
  return { ok: false, failures: [{ code: "CLAUSE_TARGET_MISMATCH", detail: `dependent clauses targeted different metrics: ${[...targets].join(", ")}` }] };
}

/**
 * Stage 25.1.3 §23/§24 — an exploratory ask that names an explicit
 * cardinality ("три показателя") must return EXACTLY that many distinct
 * metrics in its primary answer-shaped result, not a full ranking table.
 * `requested === null` (no explicit cardinality named) always passes.
 */
export function auditExploratoryCardinality(requested: number | null, distinctMetricCount: number): SemanticAuditResult {
  if (requested === null) return { ok: true, failures: [] };
  if (distinctMetricCount === requested) return { ok: true, failures: [] };
  return {
    ok: false,
    failures: [{ code: "EXPLORATORY_CARDINALITY_MISMATCH", detail: `requested ${requested} metric(s), the answer selected ${distinctMetricCount}` }],
  };
}

/**
 * Stage 25.1.3 §33–§35 — "сильнее всего отклоняется от среднего" must rank
 * by a NORMALIZED deviation (abs(latest-mean)/abs(mean)), never a raw
 * absolute deviation — ranking raw amounts across heterogeneous metrics with
 * different scales silently favors the largest-magnitude metric regardless
 * of its actual relative movement. Reads the LAST `derive.compute` call's
 * own expression tree (structured tool input, never re-derived from the
 * numbers themselves): its outermost operation must be a division.
 */
export function auditMeanDeviationNormalization(requested: CanonicalOperationKind | null, steps: readonly AgentStep[]): SemanticAuditResult {
  if (requested !== "latest_vs_mean") return { ok: true, failures: [] };
  const last = [...steps].reverse().find((s) => s.decision.kind === "tool_call" && s.decision.tool === "derive.compute" && s.observation?.ok);
  if (!last || last.decision.kind !== "tool_call") return { ok: true, failures: [] }; // no derive step found — do not false-reject
  const expr = last.decision.input["expr"];
  if (!expr || typeof expr !== "object") return { ok: true, failures: [] };
  if ((expr as Record<string, unknown>)["op"] === "divide") return { ok: true, failures: [] };
  return { ok: false, failures: [{ code: "UNNORMALIZED_MEAN_DEVIATION", detail: "the deviation from the mean was not normalized (expected latest/mean-relative division, not a raw absolute difference)" }] };
}

// Tools whose "field" input names the column a ranking/winner was actually
// computed against.
const RANK_DEFINING_TOOLS: ReadonlySet<string> = new Set(["set.sort", "set.top", "set.bottom", "set.argmax", "set.argmin"]);

/**
 * Stage 25.1.3b §2/§3/§7 — a "changed the most" comparison across
 * heterogeneous metrics must rank by the REQUESTED basis (percentage
 * magnitude by default, absolute magnitude only when explicitly asked —
 * `semantic-frame.ts`'s `detectRequestedRankingBasis`), never whatever field
 * the plan happened to sort by. Reads the LAST rank-defining tool call's own
 * "field" INPUT (structured, never re-derived from row order); a field name
 * that names neither basis is ambiguous and never false-rejected.
 */
export function auditRankingBasisFidelity(requested: RankingBasisField | null, steps: readonly AgentStep[]): SemanticAuditResult {
  if (requested === null) return { ok: true, failures: [] };
  const last = [...steps].reverse().find((s) => s.decision.kind === "tool_call" && RANK_DEFINING_TOOLS.has(s.decision.tool) && s.observation?.ok);
  if (!last || last.decision.kind !== "tool_call") return { ok: true, failures: [] }; // no ranking step found — do not false-reject
  const field = String(last.decision.input["field"] ?? "");
  if (!field) return { ok: true, failures: [] };
  const looksPercentage = /percentageChange|percent|pct/i.test(field);
  const looksAbsolute = /absoluteChange/i.test(field) && !looksPercentage;
  if (!looksPercentage && !looksAbsolute) return { ok: true, failures: [] }; // an unrecognized field name — ambiguous, never false-reject
  const executed: RankingBasisField = looksPercentage ? "percentageChange" : "absoluteChange";
  if (executed === requested) return { ok: true, failures: [] };
  return { ok: false, failures: [{ code: "RANKING_BASIS_MISMATCH", detail: `expected ranking by "${requested}" magnitude, executed sort field "${field}"` }] };
}

/**
 * Stage 25.1.3 §25 — each selected exploratory metric needs at least one
 * COMPUTED diagnostic value backing it (a score/derived column beyond the
 * bare "metric" label) — never a bare name with no grounded reason. Reads
 * the same primary table `auditExploratoryCardinality` was measured against.
 */
export function auditExploratoryExplanationGrounding(requested: number | null, primaryColumns: readonly string[] | null): SemanticAuditResult {
  if (requested === null) return { ok: true, failures: [] };
  const diagnosticColumns = (primaryColumns ?? []).filter((c) => c !== "metric");
  if (diagnosticColumns.length > 0) return { ok: true, failures: [] };
  return { ok: false, failures: [{ code: "EXPLORATORY_EXPLANATION_MISSING", detail: "the selected metrics carry no computed diagnostic value" }] };
}

/**
 * Stage 25.1.3d §7/§8/§18/§19 — a singular superlative ask ("какой изменился
 * сильнее всего?", "which one changed the most?") must produce a PRIMARY
 * answer of cardinality exactly 1 — never the whole ranked/candidate table
 * it was picked from. Reads the row count of the run's own primary answer
 * (`primary-answer.ts`'s `determinePrimaryAnswer`, the SAME selection the
 * narrator and its fallback both use — §15). `requestedSingular=false`
 * (not a superlative ask, or a genuinely compound request where the
 * superlative names only ONE of several clauses) always passes — this is
 * never applied to a compound request's shared cardinality.
 */
export function auditResultCardinality(requestedSingular: boolean, primaryRowCount: number | null): SemanticAuditResult {
  if (!requestedSingular) return { ok: true, failures: [] };
  if (primaryRowCount === null || primaryRowCount === 0) return { ok: true, failures: [] }; // no primary at all — a different audit/narration handles that; never false-reject here
  if (primaryRowCount === 1) return { ok: true, failures: [] };
  return { ok: false, failures: [{ code: "RESULT_SHAPE_MISMATCH", detail: `expected a single winner row, the primary result has ${primaryRowCount} row(s)` }] };
}

/**
 * Stage 25.1.3e §9 — after a singular winner W is determined, the PRIMARY
 * ANSWER and the SEMANTIC WINNER (the same value `commitPlannerOutputs` is
 * about to persist as MetricFocusRef) must name the SAME metric. Given both
 * now share the ONE `determineValidatedWinner`/`determinePrimaryAnswer`
 * reduction (`primary-answer.ts`), this is a defense-in-depth guarantee
 * against future drift, not two independently-guessed values. `null`
 * inputs (nothing to compare) never false-reject.
 */
export function auditWinnerConsistency(primaryMetric: string | null, semanticWinnerMetric: string | null): SemanticAuditResult {
  if (!primaryMetric || !semanticWinnerMetric) return { ok: true, failures: [] };
  if (primaryMetric === semanticWinnerMetric) return { ok: true, failures: [] };
  return {
    ok: false,
    failures: [{ code: "WINNER_CONSISTENCY_MISMATCH", detail: `the primary answer targets "${primaryMetric}" but the semantic winner is "${semanticWinnerMetric}"` }],
  };
}

/** Shared by `canonical-refs.ts` and `runtime.ts` — every distinct canonical
 *  period touched by `period.select`/`period.list` in a completed run. */
export function extractTouchedPeriods(observations: readonly AgentObservation[]): string[] {
  const out = new Set<string>();
  for (const obs of observations) {
    if (!obs.ok || (obs.tool !== "period.select" && obs.tool !== "period.list") || !obs.columns?.includes("period") || !obs.rows) continue;
    const ci = obs.columns.indexOf("period");
    for (const r of obs.rows) {
      const v = String(r[ci] ?? "");
      if (v) out.add(v);
    }
  }
  return [...out];
}

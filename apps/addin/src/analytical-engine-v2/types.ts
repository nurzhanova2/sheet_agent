import type { ExplorationDimension } from "./sandbox/exploration.js";
import type { CellValue } from "@sheet-agent/application";

/** An engine-minted handle. The planner may pass these back, never invent them. */
export type ResultId = string;

/**
 * §17 — what a result IS, so downstream consumers (state commit, renderer,
 * narrator) never have to re-infer it from row shape or tool name.
 */
export type ResultType =
  | "schema"
  | "metric_set"
  | "period"
  | "period_range"
  | "value"
  | "series"
  | "comparison"
  | "aggregate"
  | "filtered_set"
  | "ranked_set"
  | "metric_winner"
  | "trend"
  | "volatility"
  | "stability"
  | "monotonicity"
  | "direction_changes"
  | "temporal_pattern"
  | "event"
  | "event_set"
  | "derived"
  | "joined"
  | "table";

/**
 * Stage 26.2 §7/§8 — result types that carry ONE ROW PER METRIC and therefore
 * can be filtered, sorted, ranked, joined or extended by a derived column. A
 * series or a period is not in this family: its rows are periods, so ranking
 * "the metric with the largest X" over it is a category error, and §8 requires
 * rejecting that rather than silently reinterpreting it.
 */
export const PER_METRIC_ROW_TYPES: ReadonlySet<ResultType> = new Set([
  "metric_set",
  "comparison",
  "aggregate",
  "filtered_set",
  "ranked_set",
  "metric_winner",
  "trend",
  "volatility",
  "stability",
  "monotonicity",
  "direction_changes",
  "temporal_pattern",
  "event",
  "derived",
  "joined",
  "value",
  "table",
]);

/** §17 — one column of a structured result, with the role it plays. */
export interface ResultField {
  readonly name: string;
  readonly kind: "metric" | "period" | "number" | "text" | "cell";
}

/**
 * §17/§19 — every tool's output. `parents` is the lineage edge (§19): a
 * filtered set knows the comparison it came from, which knows the table and
 * interval it was computed over.
 */
export interface EngineResult {
  readonly resultId: ResultId;
  readonly tool: string;
  readonly type: ResultType;
  readonly fields: readonly ResultField[];
  readonly rows: readonly (readonly CellValue[])[];
  /** Metric universe in result order — the candidate set for "из них". */
  readonly metricKeys: readonly string[];
  /** Canonical periods this result is scoped to (0, 1 or 2). */
  readonly periodCanonicals: readonly string[];
  readonly parents: readonly ResultId[];
  readonly sourceRange: string;
  readonly sourceVersion: string;
  /** Tool-specific structured facts (ranking basis, winner value, …). Never prose. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

// --- errors (§15) ----------------------------------------------------------

export type ToolErrorCode =
  | "UNKNOWN_TOOL"
  | "CAPABILITY_UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "UNKNOWN_REFERENCE"
  | "AMBIGUOUS_METRIC"
  | "AMBIGUOUS_PERIOD"
  | "STALE_REFERENCE"
  /**
   * Stage 26.4 §22/§23 — there is no EARLIER TURN to refer back to. Distinct
   * from STALE_REFERENCE (a previous result exists but the table moved under
   * it) and from INCOMPATIBLE_INPUT (one exists but is the wrong shape). This
   * is a normal structured condition on a first turn, and the planner is
   * expected to continue from the results it has already computed.
   */
  | "NO_PREVIOUS_RESULT"
  | "INCOMPATIBLE_INPUT"
  /**
   * Stage 26.7 §13 — a CONVERSATION reference of the wrong kind, or one
   * belonging to a different table. Distinct from INCOMPATIBLE_INPUT (a
   * same-turn result of the wrong shape) and from STALE_REFERENCE (the right
   * reference, over data that has since changed): this one says the planner
   * reached for the wrong sort of memory, and silently coercing it is exactly
   * what §13 forbids.
   */
  | "INCOMPATIBLE_REFERENCE"
  /**
   * Stage 26.3 §15 — the input set was VALID but held no rows. Distinct from
   * INCOMPATIBLE_INPUT on purpose: "nothing matched" is a real analytical
   * finding the planner may complete on, not a malformed call it should retry.
   */
  | "EMPTY_INPUT_SET"
  | "BOUNDS_EXCEEDED";

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly candidates?: readonly string[];
}

export type ToolOutcome = { readonly ok: true; readonly result: EngineResult } | { readonly ok: false; readonly error: ToolError };

export function toolError(code: ToolErrorCode, message: string, candidates?: readonly string[]): { readonly ok: false; readonly error: ToolError } {
  return { ok: false, error: { code, message, ...(candidates && candidates.length > 0 ? { candidates } : {}) } };
}

// --- planner decisions (§13/§32/§34) ---------------------------------------

export interface ToolCallDecision {
  readonly kind: "tool_call";
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly final?: boolean;
}

export interface ClarifyDecision {
  readonly kind: "clarify";
  readonly question: string;
  readonly options: readonly string[];
}

/**
 * §20/§21/§34 — the planner states the answer EXPLICITLY. Nothing downstream
 * infers "the primary result" from the last/largest table or row[0], which is
 * what made Stage 25.1.3d/e necessary in the first place.
 */
export interface CompleteDecision {
  readonly kind: "complete";
  readonly primaryResultRef: ResultId;
  readonly supportingResultRefs: readonly ResultId[];
  readonly answerStyle?: "concise" | "explanatory";
  /**
   * Stage 26.4 §12 — which result answers which declared output. Present only
   * when the planner declared outputs with a `plan` decision. It lets the
   * engine check COVERAGE structurally without ever choosing the answer
   * itself (§9): the planner still names the primary.
   */
  readonly outputBindings?: readonly OutputBinding[];
}

export interface OutputBinding {
  readonly outputId: string;
  readonly resultRef: ResultId;
}

/**
 * Stage 26.4 §10/§11 — the planner's OWN statement of what the request asks
 * it to produce. This is not an intent compiler: it never names an operation,
 * a metric or a period, and the engine never reads meaning from it. It exists
 * so a compound completion can be checked for coverage against something the
 * planner itself declared.
 */
export interface PlanDecision {
  readonly kind: "plan";
  readonly outputs: readonly PlannedOutput[];
  /**
   * Stage 26.5 §4 — PRIMARY ANSWER INTENT: which declared output is the
   * principal answer the request is waiting for. Coverage (26.4) and primary
   * selection are different problems; this is the planner's own statement of
   * the second, made BEFORE it completes. The engine never derives it — it
   * only checks that the completion agrees with it (§9).
   *
   * Required once a plan declares more than one output: a multi-part plan with
   * no designated principal answer is exactly the ambiguity this stage exists
   * to remove. A single-output plan needs none, since that output IS the
   * answer.
   */
  readonly primaryOutputId?: string;
}

export interface PlannedOutput {
  readonly id: string;
  readonly description: string;
  /**
   * Stage 26.5 §5 — other declared outputs this one builds on. A lightweight
   * ANSWER structure, not an analytical plan: it names no tool, metric, period
   * or formula, and the engine reads no meaning from it. It is validated for
   * internal consistency and carried into the trace so a live failure shows
   * the answer shape the planner believed it was producing.
   */
  readonly dependsOn?: readonly string[];
}

/**
 * Stage 27 §4/§13 — run an analysis the deterministic tools cannot perform.
 *
 * The planner states the OBJECTIVE and the outputs it needs, and names the
 * methods it wants tried; it never writes code. That separation is §13's
 * ("then Code Generator produces code") and it is enforced structurally: the
 * protocol refuses a decision carrying a "code" or "script" field as an unsafe
 * payload, exactly as it already refuses one on a tool_call.
 *
 * `necessity` is not used to decide anything — it is recorded so §85's
 * question, which sandbox operations deserve promotion to real tools, is
 * answered later from telemetry rather than from memory.
 */
export interface AnalyzeDecision {
  readonly kind: "analyze";
  readonly objective: string;
  readonly requestedOutputs: readonly AnalyzeOutput[];
  /** §18/§19 — methods to actually execute and compare, named up front. */
  readonly methods?: readonly string[];
  /**
   * §36/§37/§38 — for an open-ended request, the dimensions to look along.
   *
   * The planner picks these from the schema before any code exists, which is
   * what makes an exploration bounded rather than a wander: the answer covers
   * what was planned, and the plan is visible in the trace.
   */
  readonly exploration?: readonly ExplorationDimension[];
  /**
   * §19/§36/§71 — the planner asked for a method comparison AND an
   * exploration, and the exploration was dropped.
   *
   * Recorded rather than silent, because the engine changed what the planner
   * said. The objective and the requested outputs are exactly as sent; only
   * the redundant second specification of HOW went. See the normalisation in
   * `parsePlannerDecision` for why it is not refused instead.
   */
  readonly explorationDropped?: readonly ExplorationDimension[];
  /** §19/§71 — methods named past the comparison ceiling, trimmed and recorded. */
  readonly methodsDropped?: readonly string[];
  readonly assumptions?: readonly string[];
  readonly necessity?: AnalysisNecessity;
}

/** The shape an output must arrive in, so §29 can check it structurally. */
export interface AnalyzeOutput {
  readonly id: string;
  readonly description: string;
  readonly shape: "table" | "scalar" | "series" | "groups" | "model" | "diagnostic";
}

/** §84 — why the deterministic tools were not enough. */
export type AnalysisNecessity =
  | "MISSING_DETERMINISTIC_CAPABILITY"
  | "OPEN_ENDED_EXPLORATION"
  | "CUSTOM_TRANSFORMATION"
  | "ADVANCED_STATISTICS"
  | "MULTI_METHOD_ANALYSIS"
  | "OTHER";

export type PlannerDecision = ToolCallDecision | ClarifyDecision | CompleteDecision | PlanDecision | AnalyzeDecision;

/**
 * Stage 26.4 §4 — a decision the engine refused, classified by whether the
 * planner may try again. `recoverable` covers protocol slips a model routinely
 * makes (a misplaced argument, a missing container); `fatal` covers anything
 * unsafe or unparseable, which must never get a second chance.
 */
export interface DecisionProblem {
  readonly severity: "recoverable" | "fatal";
  readonly code:
    | "MISPLACED_ARGUMENTS"
    | "EXTRA_PROTOCOL_KEYS"
    | "BAD_CONTAINER"
    | "MISSING_FIELD"
    | "MALFORMED_JSON"
    | "UNKNOWN_KIND"
    | "UNSAFE_PAYLOAD"
    /** Stage 26.5 §5 — a plan whose outputs refer to ids it did not declare. */
    | "INCONSISTENT_PLAN"
    /**
     * Stage 26.6 §6 — the response carried MORE THAN ONE complete decision.
     * Deliberately not MALFORMED_JSON: each object is valid, the response is
     * simply answering a contract that asks for one decision per round. The
     * distinction is the whole point — it is what makes the failure
     * actionable, and what stops a batch being silently half-run (§5/§8).
     */
    | "MULTIPLE_DECISIONS";
  /** Human-readable summary, used in the trace. Never shown to the user (§7). */
  readonly error: string;
  /** The offending field names, when the fix is structural. */
  readonly fields?: readonly string[];
  /** Compact structural instruction handed back to the planner (§6). */
  readonly correction: string;
  /** Stage 26.6 §16 — the serialization shape that produced this refusal. */
  readonly serialization?: SerializationClass;
}

/**
 * Stage 26.6 §16 — how the planner's response was SHAPED, recorded whether
 * or not it was accepted. Counting only failures would hide the base rate
 * this stage exists to move.
 */
export type SerializationClass = "single" | "wrapped_single" | "concatenated" | "array" | "truncated" | "invalid" | "none";

export type ParsedPlannerDecision =
  | { readonly ok: true; readonly decision: PlannerDecision; readonly serialization: SerializationClass }
  | { readonly ok: false; readonly error: string; readonly problem: DecisionProblem; readonly serialization: SerializationClass };

// --- loop bounds (§12) -----------------------------------------------------

export interface EngineBounds {
  readonly maxPlannerRounds: number;
  readonly maxToolCalls: number;
  readonly maxWorkbookReads: number;
  readonly maxRowsPerResult: number;
  readonly maxResultCells: number;
  readonly maxIdenticalToolRetry: number;
  /**
   * Stage 26.4 §5/§26 — protocol self-correction, budgeted SEPARATELY from the
   * analytical budget above, which is unchanged. `maxProtocolCorrections` is
   * per distinct malformed decision; `maxTotalProtocolCorrections` caps the
   * turn so a model that keeps mangling its JSON cannot loop.
   */
  readonly maxProtocolCorrections: number;
  readonly maxTotalProtocolCorrections: number;
  /** §14 — chances to re-bind a completion without rerunning any tool. */
  readonly maxCompletionRetries: number;
  /**
   * Stage 26.5 §12 — chances to correct a completion that CONTRADICTS the
   * planner's own declared primary output. Budgeted apart from
   * `maxCompletionRetries` for the same reason 26.4 separated protocol
   * corrections from analytical rounds: a turn that has to fix its coverage
   * should not thereby lose its chance to fix its primary. Reruns no tool.
   */
  readonly maxPrimaryCorrections: number;
  /**
   * Stage 26.4 — how many `plan` declarations a turn may make. Declaring is
   * NOT analysis, so it does not consume an analytical round; this cap is what
   * stops a planner that only ever re-declares from looping for free.
   */
  readonly maxPlanDeclarations: number;
  /**
   * Stage 26.8 §29 — chances to push back on a clarification the user has
   * ALREADY answered. Budgeted apart from everything above because it costs
   * a planner round for a reason none of the other counters describe: not a
   * malformed decision, not an uncovered output, but a question asked twice.
   */
  readonly maxRepeatedClarifications: number;
  /**
   * Stage 27 §38 — how many separate code analyses one turn may run.
   *
   * Small on purpose. A multi-method comparison (§19) is ONE analysis that
   * executes several methods, not several analyses, so this is not the budget
   * for §19 — it is the budget for the hybrid shape §34 describes: analyse,
   * then analyse again over what the deterministic tools narrowed. It is also
   * the bound that stops §36's "find something interesting" from becoming an
   * open-ended research budget.
   *
   * Three rather than two, because the live run showed two is short of one
   * legitimate shape rather than generous with it. A principal-components
   * request splits the way an analyst would split it — compute the components,
   * then establish what separates them — and a second analysis over the first
   * one's output is exactly what §34 is for. Two left no room for the turn to
   * recover from a first analysis that came back thinner than asked.
   */
  readonly maxAnalyses: number;
}

export const ENGINE_BOUNDS: EngineBounds = {
  maxPlannerRounds: 10,
  maxToolCalls: 12,
  maxWorkbookReads: 6,
  maxRowsPerResult: 200,
  maxResultCells: 3000,
  maxIdenticalToolRetry: 1,
  // §5 — a SEPARATE, small allowance for protocol self-correction. It does not
  // widen the analytical budget: a corrected decision still costs a round.
  maxProtocolCorrections: 1,
  maxTotalProtocolCorrections: 2,
  maxCompletionRetries: 1,
  maxPrimaryCorrections: 1,
  maxPlanDeclarations: 3,
  maxRepeatedClarifications: 1,
  maxAnalyses: 3,
};

/**
 * Stage 26.2 §10/§11 — how much of a result the PLANNER is shown. The full
 * result always stays in the ResultStore; the model receives a bounded preview
 * plus the metadata it needs to choose the next tool. A planner that has to
 * scan 200 rows to find a winner is a planner that will eventually pick the
 * wrong one by hand (§23) — so past this threshold it sees a sample and is
 * expected to reach for set.filter / set.top / a ranking tool instead.
 */
export const PLANNER_PREVIEW_ROWS = 20;

// --- run outcome -----------------------------------------------------------

export type EngineTerminationReason =
  | "planner_rounds"
  | "tool_calls"
  | "workbook_reads"
  | "repeated_invalid_call"
  | "invalid_decision"
  | "model_error"
  /**
   * Stage 27 §5/§67 — the requested analysis could not be performed. Distinct
   * from every reason above because the honest response is different: not "I
   * ran out of rounds" but "this analysis is not available", and under no
   * circumstances a DIFFERENT analysis presented as the answer.
   */
  | "analysis_unavailable";

export interface EngineAnalysis {
  readonly primary: EngineResult;
  readonly supporting: readonly EngineResult[];
  readonly answerStyle: "concise" | "explanatory";
}

export type EngineOutcome =
  | { readonly kind: "complete"; readonly analysis: EngineAnalysis }
  | { readonly kind: "clarify"; readonly question: string; readonly options: readonly string[] }
  | { readonly kind: "failed"; readonly reason: EngineTerminationReason; readonly detail: string };

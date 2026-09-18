// ---------------------------------------------------------------------------
// Stage 26.2 §12/§13/§34/§36/§37/§38/§44 — the iterative planner loop.
//
//   context → planner → tool call → validate → execute → result → planner → …
//   → explicit completion → validated analysis
//
// The loop owns the budget, the per-turn result cache, the identical-failure
// counter, and the completion validation. It has no fallback into any other
// engine: the only exits are a validated completion, a clarification, or a
// clean bounded failure (§36).
// ---------------------------------------------------------------------------

import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import { buildPeriodIndex } from "../../app/schema/analytical/period-index.js";
import { buildEngineContext } from "../context/build-context.js";
import { ResultStore } from "../results/result-store.js";
import type { AnalyticalConversationState } from "../state/conversation-state.js";
import { buildToolEnv } from "../tools/registry.js";
import { executeCall, validateCall } from "../tools/validator.js";
import { TraceBuilder, type AnalyticalTraceV2, type BudgetUse } from "../debug/analytical-trace.js";
import {
  ENGINE_BOUNDS,
  type AnalyzeDecision,
  type CompleteDecision,
  type EngineBounds,
  type EngineResult,
  type EngineTerminationReason,
  type PlannedOutput,
  type SerializationClass,
  type ToolError,
} from "../types.js";
import { buildPlannerMessages, parsePlannerDecision, type PlannerMessage } from "./planner-prompt.js";

export interface PlannerRunParams {
  readonly turnId: string;
  readonly request: string;
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  readonly state: AnalyticalConversationState;
  /** One bounded planner decision — wired by the caller to the chat client. */
  readonly decide: (messages: readonly PlannerMessage[]) => Promise<unknown> | unknown;
  readonly bounds?: EngineBounds;
  /** Stage 26.7 §30 — work a clarified turn already did, restored by id. */
  readonly resume?: ResumeContext;
  /**
   * Stage 26.8 §28 — protocol feedback the ENGINE has for the planner before
   * the first round. Currently one thing: it asked something already
   * answered. Seeded into the same error channel a tool failure uses, so the
   * planner reads it where it already reads its own mistakes.
   */
  readonly notes?: readonly string[];
  /**
   * Stage 27 §4 — the analytical sandbox, when one is available.
   *
   * Absent means the planner is never TOLD the sandbox exists (the catalogue
   * omits it), which is the only honest way to offer a capability that may not
   * be there. A planner that asks for it anyway is refused rather than quietly
   * given something else (§5).
   */
  readonly analyze?: AnalysisRunner;
  /** Stage 27 §70 — cancels a running analysis. */
  readonly signal?: AbortSignal;
}

/** Stage 27 §13 — what the engine does with an `analyze` decision. */
export type AnalysisRunner = (decision: AnalyzeDecision, store: ResultStore, signal?: AbortSignal) => Promise<AnalysisRunOutcome>;

export type AnalysisRunOutcome =
  | {
      readonly ok: true;
      readonly stored: readonly EngineResult[];
      readonly primary: EngineResult;
      readonly method: Readonly<Record<string, unknown>>;
      readonly attempts: number;
      readonly durationMs: number;
    }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly attempts: number; readonly durationMs: number };

export interface ResumeContext {
  readonly request: string;
  readonly question: string;
  readonly results: readonly EngineResult[];
  readonly declaredOutputs: readonly PlannedOutput[];
  readonly primaryOutputId?: string;
  /** Stage 26.8 §30 — questions of this task the user has already answered. */
  readonly answered?: readonly { readonly question: string; readonly reply: string }[];
}

export type PlannerRunOutcome =
  | { readonly kind: "complete"; readonly primary: EngineResult; readonly supporting: readonly EngineResult[]; readonly answerStyle: "concise" | "explanatory" }
  | { readonly kind: "clarify"; readonly question: string; readonly options: readonly string[] }
  | { readonly kind: "failed"; readonly reason: EngineTerminationReason; readonly detail: string };

export interface PlannerRun {
  readonly outcome: PlannerRunOutcome;
  readonly results: readonly EngineResult[];
  /** Stage 26.7 §29 — what the planner had declared when it stopped. */
  readonly declaredOutputs: readonly PlannedOutput[];
  readonly primaryOutputId?: string;
  readonly budget: BudgetUse;
  readonly trace: AnalyticalTraceV2;
  readonly traceBuilder: TraceBuilder;
}

/**
 * Stage 26.5 §17 — how much of a refused decision the trace keeps, and in what
 * shape. Bounded so one runaway generation cannot dominate an artifact, and
 * stripped of control characters so the trace stays printable; the text is
 * otherwise VERBATIM, because the point is to classify what the model actually
 * emitted (truncated / fenced / doubled / badly escaped) rather than a cleaned
 * up version of it.
 */
const RAW_DECISION_LIMIT = 1200;

export function sanitizeRaw(raw: string): string {
  // Scanned by code point rather than matched by a control-character class:
  // tab, newline and carriage return are the shape of the failure and must
  // survive, everything else below 0x20 (and DEL) would corrupt the artifact.
  let flat = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    flat += code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127) ? ch : " ";
  }
  return flat.length > RAW_DECISION_LIMIT ? `${flat.slice(0, RAW_DECISION_LIMIT)}…[+${flat.length - RAW_DECISION_LIMIT} chars]` : flat;
}

function errorLine(tool: string, e: ToolError): string {
  const candidates = e.candidates && e.candidates.length > 0 ? ` (valid: ${e.candidates.slice(0, 10).join(", ")})` : "";
  return `${tool} → ${e.code}: ${e.message}${candidates}`;
}

/**
 * §34 — a completion is only accepted when it points at results that exist and
 * can structurally answer something. A schema or period result as the PRIMARY
 * answer to an analytical question is a protocol slip, not an answer.
 */
function completionProblem(primary: EngineResult): string | null {
  // Stage 26.3 §14/§16 — an EMPTY FILTERED SET is a real analytical answer
  // ("no indicator declined"), so it may be the primary result. Every other
  // empty result is still a protocol slip: nothing was actually computed.
  if (primary.rows.length === 0 && primary.type !== "filtered_set") return `"${primary.resultId}" has no rows`;
  if (primary.type === "schema") return `"${primary.resultId}" describes the table's shape, not an analytical answer`;
  return null;
}

/**
 * Stage 26.4 §12/§13 — COVERAGE, not answer selection (§9). The engine checks
 * only that each output the PLANNER itself declared is bound to a result that
 * exists, and that the primary is one of them. It never inspects the user's
 * text, never ranks the results, and never substitutes a different primary.
 */
function coverageProblem(outputs: readonly PlannedOutput[], decision: CompleteDecision, store: ResultStore): { readonly message: string; readonly unsatisfied: readonly string[] } | null {
  // A single declared output needs no binding: the primary IS the answer.
  if (outputs.length < 2) return null;
  const bindings = decision.outputBindings ?? [];
  const bound = new Map(bindings.map((b) => [b.outputId, b.resultRef]));
  const unsatisfied = outputs.filter((o) => {
    const ref = bound.get(o.id);
    return ref === undefined || !store.has(ref);
  });
  if (unsatisfied.length > 0) {
    return {
      message: `your completion does not account for every output you declared — unbound or unknown: ${unsatisfied.map((o) => `${o.id} (${o.description})`).join("; ")}`,
      unsatisfied: unsatisfied.map((o) => o.id),
    };
  }
  const refs = new Set(bindings.map((b) => b.resultRef));
  if (!refs.has(decision.primaryResultRef)) {
    return {
      message: `"${decision.primaryResultRef}" is not bound to any declared output — the primary must be one of the results you bound`,
      unsatisfied: [],
    };
  }
  return null;
}

/**
 * Stage 26.5 §8/§9 — PRIMARY-ANSWER CONSISTENCY, which is a different question
 * from coverage. Coverage asks "did we compute everything that was asked for?";
 * this asks "does the completion point at the result the planner ITSELF called
 * the principal answer?". The engine validates the link and nothing else: it
 * never decides which output should have been primary (§14), so a planner that
 * consistently names the wrong one produces a measurable semantic failure
 * rather than a silently corrected one.
 */
function primaryProblem(
  outputs: readonly PlannedOutput[],
  primaryOutputId: string | undefined,
  decision: CompleteDecision,
  store: ResultStore,
): { readonly message: string; readonly boundRef: string } | null {
  if (!primaryOutputId || !outputs.some((o) => o.id === primaryOutputId)) return null;
  const bound = (decision.outputBindings ?? []).find((b) => b.outputId === primaryOutputId);
  // An unbound or unknown primary is COVERAGE's finding, not this one's; it is
  // reported there so the planner gets one message about one problem.
  if (!bound || !store.has(bound.resultRef)) return null;
  if (bound.resultRef === decision.primaryResultRef) return null;
  return {
    message: `the output you declared as the principal answer is ${primaryOutputId}, which you bound to ${bound.resultRef}, but primaryResultRef points at ${decision.primaryResultRef}`,
    boundRef: bound.resultRef,
  };
}

/**
 * §10 — is this plan the SAME declaration again, or a genuine revision?
 *
 * STRUCTURE decides, not wording. §10's revision is a changed answer shape: an
 * output discovered mid-analysis, or a different output promoted to principal.
 * Re-describing the same shape in new words is a restatement, and calling it a
 * revision is not harmless — a planner whose phrasing drifts slightly each
 * round would re-declare forever without ever being told it already had.
 */
function samePlan(a: readonly PlannedOutput[], aPrimary: string | undefined, b: readonly PlannedOutput[], bPrimary: string | undefined): boolean {
  return a.length === b.length && aPrimary === bPrimary;
}

export async function runPlannerLoop(params: PlannerRunParams): Promise<PlannerRun> {
  const bounds = params.bounds ?? ENGINE_BOUNDS;
  const periodIndex = buildPeriodIndex(params.schema, params.grids);
  const store = new ResultStore(params.schema.sourceRange, params.schema.sourceVersion, {
    maxRowsPerResult: bounds.maxRowsPerResult,
    maxResultCells: bounds.maxResultCells,
  });
  // §30/§48 — a resumed turn starts from the work it already did: the same
  // result ids, the same declared outputs, the same primary. Nothing is
  // recomputed just because the planner had to ask a question.
  if (params.resume) {
    store.seed(params.resume.results);
  }
  const env = buildToolEnv(params.schema, params.grids, store, params.state);
  const context = buildEngineContext(params.schema, params.grids, periodIndex, params.state);
  const trace = new TraceBuilder(params.turnId, params.request, params.schema.sourceRange, params.schema.sourceVersion, params.state);

  const errors: string[] = [...(params.notes ?? [])];
  // §38/§48 — one correction per IDENTICAL mistake, keyed by the call itself.
  const failureCounts = new Map<string, number>();
  // §39 — identical successful calls within this turn reuse their ResultRef.
  const cache = new Map<string, string>();
  const budget: {
    plannerRounds: number;
    toolCalls: number;
    workbookReads: number;
    cacheHits: number;
    protocolCorrections: number;
    completionRetries: number;
    primaryCorrections: number;
    analyses: number;
  } = {
    plannerRounds: 0,
    toolCalls: 0,
    workbookReads: 0,
    cacheHits: 0,
    protocolCorrections: 0,
    completionRetries: 0,
    // §12 — re-bindings spent on a completion that contradicted the plan.
    primaryCorrections: 0,
    // Stage 27 §83 — measured so the deterministic route can be shown to stay
    // dominant for the operations it already covers.
    analyses: 0,
  };

  // Stage 26.4 §10/§11 — the planner's own declaration of what it owes this
  // request. Empty unless it chose to emit a `plan`; the engine reads no
  // meaning from the descriptions, only their identity and count.
  // §16 — the serialization shape of each planner response, in order.
  const serialization: SerializationClass[] = [];
  let declaredOutputs: readonly PlannedOutput[] = params.resume?.declaredOutputs ?? [];
  // Stage 26.5 §4 — which declared output the planner called the answer.
  let declaredPrimaryOutputId: string | undefined = params.resume?.primaryOutputId;
  // §5 — protocol corrections are counted per distinct slip AND per turn.
  const protocolCounts = new Map<string, number>();
  let planDeclarations = 0;
  let analyses = 0;

  const finish = (outcome: PlannerRunOutcome, kind: AnalyticalTraceV2["outcome"]): PlannerRun => {
    trace.set({ budget: { ...budget }, serializationClasses: [...serialization] });
    if (outcome.kind === "failed") trace.set({ failureReason: `${outcome.reason}: ${outcome.detail}` });
    return {
      outcome,
      results: store.all(),
      declaredOutputs,
      ...(declaredPrimaryOutputId !== undefined ? { primaryOutputId: declaredPrimaryOutputId } : {}),
      budget: { ...budget },
      trace: trace.commit(store.all(), kind),
      traceBuilder: trace,
    };
  };
  const fail = (reason: EngineTerminationReason, detail: string): PlannerRun => finish({ kind: "failed", reason, detail }, "failed");

  for (let round = 1; round <= bounds.maxPlannerRounds; round += 1) {
    budget.plannerRounds = round;
    const messages = buildPlannerMessages({
      request: params.request,
      context,
      results: store.all(),
      declaredOutputs,
      ...(declaredPrimaryOutputId !== undefined ? { declaredPrimaryOutputId } : {}),
      ...(params.resume
        ? { resume: { request: params.resume.request, question: params.resume.question, ...(params.resume.answered ? { answered: params.resume.answered } : {}) } }
        : {}),
      errors,
      round,
      remainingRounds: bounds.maxPlannerRounds - round,
      sandboxAvailable: params.analyze !== undefined,
    });

    let raw: unknown;
    try {
      raw = await params.decide(messages);
    } catch (error) {
      return fail("model_error", error instanceof Error ? error.message : String(error));
    }

    const parsed = parsePlannerDecision(raw);
    // §16 — recorded for EVERY round, not only the refused ones: counting only
    // failures would hide the base rate this stage exists to move.
    serialization.push(parsed.serialization);
    if (!parsed.ok) {
      const problem = parsed.problem;
      // §17 — keep the model's actual text for a decision the parser refused,
      // bounded and stripped of control characters. Classifying a serialization
      // failure from an error string is guesswork; this is the evidence.
      const rawText = typeof raw === "string" ? raw : "";
      trace.round({
        round,
        decision: null,
        parseError: problem.error,
        decisionProblem: problem,
        serialization: parsed.serialization,
        ...(rawText !== "" ? { rawDecision: sanitizeRaw(rawText) } : {}),
      });
      // §4 — an unsafe payload never gets a second chance.
      if (problem.severity === "fatal") return fail("invalid_decision", problem.error);
      const key = `protocol:${problem.code}:${(problem.fields ?? []).join(",")}`;
      const seen = (protocolCounts.get(key) ?? 0) + 1;
      protocolCounts.set(key, seen);
      budget.protocolCorrections += 1;
      // §5 — bounded twice over, so a model that keeps mangling its JSON
      // cannot loop: per identical slip, and per turn.
      if (seen > bounds.maxProtocolCorrections || budget.protocolCorrections > bounds.maxTotalProtocolCorrections) {
        return fail("invalid_decision", problem.error);
      }
      // §6 — compact and STRUCTURAL. The engine never repairs the JSON itself.
      errors.push(problem.correction);
      continue;
    }
    const decision = parsed.decision;

    if (decision.kind === "plan") {
      trace.round({ round, decision });
      // DECLARING IS NOT ANALYSIS, so it does not consume an analytical round.
      //
      // Two live runs taught this the hard way. Treating a repeated `plan` as a
      // violation killed 15 of 17 failing turns; then merely absorbing it let a
      // planner re-declare until the round budget died (93 plan rounds across
      // 50 turns, one turn spending all ten). Telling the model to stop was not
      // enough — so the round is REFUNDED and the loop is bounded instead,
      // which makes the pathology structurally impossible rather than
      // discouraged.
      planDeclarations += 1;
      if (planDeclarations > bounds.maxPlanDeclarations) {
        budget.protocolCorrections += 1;
        if (budget.protocolCorrections > bounds.maxTotalProtocolCorrections) {
          return fail("invalid_decision", "the planner kept re-declaring its outputs instead of calling a tool");
        }
        errors.push("Stop planning and act: your outputs are recorded. Return a tool_call or a complete decision now.");
        continue;
      }
      // §10/§11 — a REVISED plan is legitimate: the planner may discover mid-
      // analysis that its answer structure was incomplete. Only a plan that is
      // byte-for-byte the one already recorded gets the idempotence nudge. In
      // neither case is the ResultStore touched, so nothing computed is lost.
      if (declaredOutputs.length > 0 && samePlan(declaredOutputs, declaredPrimaryOutputId, decision.outputs, decision.primaryOutputId)) {
        errors.push("Your outputs are already recorded under OUTPUTS YOU ALREADY DECLARED. Do not send that plan again — call a tool, or complete.");
      }
      declaredOutputs = decision.outputs;
      declaredPrimaryOutputId = decision.primaryOutputId;
      trace.set({ declaredOutputs, ...(declaredPrimaryOutputId ? { declaredPrimaryOutputId } : {}) });
      round -= 1;
      continue;
    }

    if (decision.kind === "clarify") {
      trace.round({ round, decision });
      return finish({ kind: "clarify", question: decision.question, options: decision.options }, "clarify");
    }

    if (decision.kind === "complete") {
      trace.round({ round, decision });
      const primary = store.get(decision.primaryResultRef);
      const missing = [decision.primaryResultRef, ...decision.supportingResultRefs].filter((id) => !store.has(id));
      const problem = missing.length > 0 ? `unknown result(s): ${missing.join(", ")}` : primary ? completionProblem(primary) : "no primary result";
      if (problem || !primary) {
        const key = `complete:${decision.primaryResultRef}:${problem}`;
        const seen = (failureCounts.get(key) ?? 0) + 1;
        failureCounts.set(key, seen);
        if (seen > bounds.maxIdenticalToolRetry) return fail("invalid_decision", problem ?? "invalid completion");
        errors.push(`complete → ${problem} (available: ${store.ids().join(", ") || "none"})`);
        continue;
      }
      // §14/§15 — a completion that does not cover every declared output gets
      // ONE correction round. The ResultStore is untouched, so the planner
      // re-binds without rerunning a single tool.
      const coverage = coverageProblem(declaredOutputs, decision, store);
      if (coverage && budget.completionRetries < bounds.maxCompletionRetries) {
        budget.completionRetries += 1;
        errors.push(`complete → ${coverage.message}. Re-check which result answers which output, and which one is the principal answer.`);
        continue;
      }
      if (coverage) trace.set({ coverageUnsatisfied: coverage.unsatisfied });

      // §8/§12 — the completion must agree with the plan the planner declared.
      // One correction, no tool rerun. Past that the engine ACCEPTS what the
      // planner named: substituting its own choice of answer is precisely what
      // §9/§14 forbid, so the disagreement is recorded and measured instead.
      const mismatch = primaryProblem(declaredOutputs, declaredPrimaryOutputId, decision, store);
      if (mismatch) {
        trace.set({ primaryBindingMismatch: true, boundPrimaryResultRef: mismatch.boundRef });
        if (budget.primaryCorrections < bounds.maxPrimaryCorrections) {
          budget.primaryCorrections += 1;
          trace.set({ primaryCorrectionAttempted: true });
          errors.push(
            `complete → ${mismatch.message}. Return a corrected complete decision: set primaryResultRef to ${mismatch.boundRef}, or — if a different output is really the principal answer — declare that with a revised plan first.`,
          );
          continue;
        }
      } else if (budget.primaryCorrections > 0) {
        trace.set({ primaryCorrectionSucceeded: true });
      }

      const supporting = decision.supportingResultRefs.map((id) => store.get(id)).filter((r): r is EngineResult => r !== undefined);
      const boundPrimary = (decision.outputBindings ?? []).find((b) => b.outputId === declaredPrimaryOutputId);
      trace.set({
        completion: { primaryResultRef: primary.resultId, supportingResultRefs: supporting.map((s) => s.resultId) },
        completePrimaryResultRef: primary.resultId,
        ...(boundPrimary ? { boundPrimaryResultRef: boundPrimary.resultRef } : {}),
      });
      return finish({ kind: "complete", primary, supporting, answerStyle: decision.answerStyle ?? "concise" }, "complete");
    }

    if (decision.kind === "analyze") {
      trace.round({ round, decision });
      // §5 — a capability that is not there is refused, never approximated.
      if (!params.analyze) {
        return fail("analysis_unavailable", "the requested analysis needs the code sandbox, which is not available in this build");
      }
      analyses += 1;
      if (analyses > bounds.maxAnalyses) {
        return fail("analysis_unavailable", `the turn asked for more than ${bounds.maxAnalyses} separate analyses`);
      }
      const run = await params.analyze(decision, store, params.signal);
      budget.analyses = analyses;
      if (!run.ok) {
        // §67 — the requested analysis could not be completed. The turn ends
        // saying so. It does NOT continue with the deterministic tools and
        // present their output as the answer to a question they cannot
        // answer, which is precisely the substitution §5 forbids.
        trace.set({ analysisFailure: { code: run.code, message: run.message, attempts: run.attempts } });
        return fail("analysis_unavailable", run.message);
      }
      trace.round({ round, decision, toolResultId: run.primary.resultId });
      trace.set({ analysisMethod: run.method, analysisAttempts: run.attempts, analysisDurationMs: run.durationMs });
      continue;
    }

    // tool_call
    if (budget.toolCalls >= bounds.maxToolCalls) return fail("tool_calls", `exceeded ${bounds.maxToolCalls} tool calls`);
    const validated = validateCall(decision, env);
    if (!validated.ok) {
      const e = validated.error.ok === false ? validated.error.error : null;
      trace.round({ round, decision, ...(e ? { toolError: e } : {}) });
      const key = `${decision.tool}:${JSON.stringify(decision.arguments)}`;
      const seen = (failureCounts.get(key) ?? 0) + 1;
      failureCounts.set(key, seen);
      if (seen > bounds.maxIdenticalToolRetry) return fail("repeated_invalid_call", e ? errorLine(decision.tool, e) : "invalid call");
      if (e) errors.push(errorLine(decision.tool, e));
      continue;
    }

    const willRead = validated.call.spec.reads && !cache.has(validated.call.signature);
    if (willRead && budget.workbookReads >= bounds.maxWorkbookReads) return fail("workbook_reads", `exceeded ${bounds.maxWorkbookReads} workbook reads`);

    budget.toolCalls += 1;
    const { outcome, cached } = executeCall(validated.call, env, cache);
    if (cached) budget.cacheHits += 1;
    else if (validated.call.spec.reads) budget.workbookReads += 1;

    if (!outcome.ok) {
      trace.round({ round, decision, toolError: outcome.error });
      const key = `${decision.tool}:${JSON.stringify(decision.arguments)}`;
      const seen = (failureCounts.get(key) ?? 0) + 1;
      failureCounts.set(key, seen);
      if (seen > bounds.maxIdenticalToolRetry) return fail("repeated_invalid_call", errorLine(decision.tool, outcome.error));
      errors.push(errorLine(decision.tool, outcome.error));
      continue;
    }
    trace.round({ round, decision, toolResultId: outcome.result.resultId, cached });
  }

  return fail("planner_rounds", `no completion within ${bounds.maxPlannerRounds} rounds`);
}

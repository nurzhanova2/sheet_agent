import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import { buildPeriodIndex } from "../../app/schema/analytical/period-index.js";
import { buildEngineContext } from "../context/build-context.js";
import { capabilityFactsOf, type RuntimeCapabilities } from "../capability/capability-availability.js";
import { selectCapabilities } from "../capability/capability-selection.js";
import { verifyCoverage, type CoverageResult } from "../verification/coverage-verifier.js";
import { buildToolContext } from "../capability/tool-context.js";
import { buildToolCatalog } from "../context/build-context.js";
import { findTool, V2_TOOLS } from "../tools/registry.js";
import type { CapabilityId } from "../capability/capability-model.js";
import { ResultStore } from "../results/result-store.js";
import type { ExecutionProgress, TimingRecorder } from "../production/execution-progress.js";
import type { AnalyticalConversationState } from "../state/conversation-state.js";
import { buildToolEnv } from "../tools/registry.js";
import { executeCall, validateCall } from "../tools/validator.js";
import { TraceBuilder, type AnalyticalTraceV2, type BudgetUse } from "../debug/analytical-trace.js";
import {
  ENGINE_BOUNDS,
  type AnalyzeDecision,
  type AnswerIntent,
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
  readonly onProgress?: ExecutionProgress;
  readonly timings?: TimingRecorder;
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
  | { readonly kind: "complete"; readonly primary: EngineResult; readonly supporting: readonly EngineResult[]; readonly answerStyle: "concise" | "explanatory"; readonly answerIntent?: AnswerIntent }
  | { readonly kind: "clarify"; readonly question: string; readonly options: readonly string[] }
  | { readonly kind: "failed"; readonly reason: EngineTerminationReason; readonly detail: string };

export interface PlannerRun {
  readonly outcome: PlannerRunOutcome;
  readonly results: readonly EngineResult[];
  /** Stage 26.7 §29 — what the planner had declared when it stopped. */
  readonly declaredOutputs: readonly PlannedOutput[];
  readonly primaryOutputId?: string;
  /**
   * Stage 28G §11/§12 — the coverage verdict for a `complete` outcome, from
   * the planner contract. The engine reads it; it never recomputes coverage
   * from the request text.
   */
  readonly coverage?: CoverageResult;
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

/**
 * §15 — the error, with its candidates, and honest about the cut.
 *
 * The list used to be sliced to ten with no sign that it had been. On a table
 * of twelve months that hid Ноя and Дек, and the live run showed what the
 * planner does with a list that looks complete and is not: asked for December
 * totals, it read the ten periods offered, concluded December was not in the
 * table, and asked the user which period to use instead. A truncated list that
 * reads as exhaustive is worse than a long one.
 *
 * Twenty-four covers every ordinary period vocabulary outright; past that the
 * remainder is COUNTED, so "not in the list" and "not in the table" stay
 * different statements.
 */
const CANDIDATE_LIMIT = 24;

export function errorLine(tool: string, e: ToolError): string {
  let candidates = "";
  if (e.candidates && e.candidates.length > 0) {
    const shown = e.candidates.slice(0, CANDIDATE_LIMIT);
    const rest = e.candidates.length - shown.length;
    candidates = ` (valid: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""})`;
  }
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

export function finalCallRefusal(outputs: readonly PlannedOutput[], result: EngineResult): string | null {
  if (outputs.length > 1) {
    return `you declared ${outputs.length} outputs, so this turn ends with a complete decision that binds each one — not with a final tool call`;
  }
  const structural = completionProblem(result);
  if (structural) return `${structural}, so it cannot be the principal answer — keep working`;
  return null;
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
  const reached = new Set<CapabilityId>();
  const calledTools = new Set<string>();
  const runtime: Partial<RuntimeCapabilities> = { sandbox: params.analyze !== undefined };
  const factsNow = () => capabilityFactsOf({ schema: params.schema, periodIndex, state: params.state, runtime, resultCount: store.all().length });
  const contextNow = () => {
    const facts = factsNow();
    return buildToolContext({ facts, selection: selectCapabilities({ facts, reached: [...reached] }) });
  };
  let toolContext = contextNow();
  const firstToolContext = toolContext;
  const promptCharsByRound: number[] = [];
  const toolContextCharsByRound: number[] = [];
  let capabilityUnavailableErrors = 0;
  let unknownToolErrors = 0;
  const context = buildEngineContext(params.schema, params.grids, periodIndex, params.state, toolContext.text);
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
    finalToolCalls: number;
    finalToolCallsHonoured: number;
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
    finalToolCalls: 0,
    finalToolCallsHonoured: 0,
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

  let coverageVerdict: CoverageResult | undefined;
  const finish = (outcome: PlannerRunOutcome, kind: AnalyticalTraceV2["outcome"]): PlannerRun => {
    const finalContext = toolContext;
    trace.set({
      budget: { ...budget },
      serializationClasses: [...serialization],
      toolContext: {
        availableCapabilities: [...firstToolContext.availableCapabilities],
        selectedCapabilities: [...firstToolContext.selectedCapabilities],
        availableCapabilityCount: firstToolContext.availableCapabilities.length,
        selectedCapabilityCount: firstToolContext.selectedCapabilities.length,
        registryToolCount: V2_TOOLS.length,
        availableToolCount: firstToolContext.exposedTools.length,
        initiallyExposedToolCount: firstToolContext.exposedTools.length,
        initiallyLoadedToolCount: firstToolContext.loadedTools.length,
        finalExposedToolCount: finalContext.exposedTools.length,
        finalLoadedToolCount: finalContext.loadedTools.length,
        calledToolCount: calledTools.size,
        toolDiscoveryRequests: 0,
        capabilityUnavailableErrors,
        unknownToolErrors,
        callToolWithoutInvoker: 0,
        executeCodeWithoutRuntime: 0,
        mutationCapabilityOffered: firstToolContext.availableCapabilities.filter((id) => id === "mutation" || id === "visualization").length,
        toolSchemaLeaks: firstToolContext.leaks.length + finalContext.leaks.length,
        initialPromptChars: promptCharsByRound[0] ?? 0,
        initialToolContextChars: firstToolContext.text.length,
        fullCatalogChars: buildToolCatalog().length,
        promptCharsByRound: [...promptCharsByRound],
        toolContextCharsByRound: [...toolContextCharsByRound],
      },
    });
    if (outcome.kind === "failed") trace.set({ failureReason: `${outcome.reason}: ${outcome.detail}` });
    return {
      outcome,
      results: store.all(),
      declaredOutputs,
      ...(declaredPrimaryOutputId !== undefined ? { primaryOutputId: declaredPrimaryOutputId } : {}),
      ...(coverageVerdict ? { coverage: coverageVerdict } : {}),
      budget: { ...budget },
      trace: trace.commit(store.all(), kind),
      traceBuilder: trace,
    };
  };
  const fail = (reason: EngineTerminationReason, detail: string): PlannerRun => finish({ kind: "failed", reason, detail }, "failed");

  for (let round = 1; round <= bounds.maxPlannerRounds; round += 1) {
    budget.plannerRounds = round;
    toolContext = contextNow();
    const messages = buildPlannerMessages({
      request: params.request,
      context: { ...context, toolCatalog: toolContext.text },
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
      exposedTools: toolContext.exposedTools,
    });
    promptCharsByRound.push(messages.reduce((n, m) => n + m.content.length, 0));
    toolContextCharsByRound.push(toolContext.text.length);

    let raw: unknown;
    params.onProgress?.({ kind: "planning" });
    const decisionStarted = Date.now();
    try {
      raw = await params.decide(messages);
    } catch (error) {
      params.timings?.addPlanner(Date.now() - decisionStarted);
      return fail("model_error", error instanceof Error ? error.message : String(error));
    }
    params.timings?.addPlanner(Date.now() - decisionStarted);

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
      const coverage = verifyCoverage({ declaredOutputs, decision, knownResult: (id) => store.has(id) });
      if (!coverage.ok && budget.completionRetries < bounds.maxCompletionRetries) {
        budget.completionRetries += 1;
        errors.push(`complete → ${coverage.detail}. Re-check which result answers which output, and which one is the principal answer.`);
        continue;
      }
      coverageVerdict = coverage;
      if (!coverage.ok) trace.set({ coverageUnsatisfied: coverage.unsatisfied });

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
      return finish({ kind: "complete", primary, supporting, answerStyle: decision.answerIntent?.answerStyle ?? decision.answerStyle ?? "concise", ...(decision.answerIntent ? { answerIntent: decision.answerIntent } : {}) }, "complete");
    }

    if (decision.kind === "analyze") {
      trace.round({ round, decision });
      // §5 — a capability that is not there is refused, never approximated.
      if (!params.analyze) {
        return fail("analysis_unavailable", "the requested analysis needs the code sandbox, which is not available in this build");
      }
      analyses += 1;
      if (analyses > bounds.maxAnalyses) {
        // §38/§67 — the budget is spent. What happens next depends entirely on
        // whether anything was COMPUTED.
        //
        // With results in hand, killing the turn throws away work that answers
        // the question. The live run did exactly that on "исследуй таблицу":
        // three analyses ran, all three succeeded, the planner asked for a
        // fourth, and the user got nothing. Telling it to stop and complete is
        // not a §5 substitution — the results are the ones it asked for, for
        // the objective it stated; only the request for MORE is refused.
        //
        // With nothing computed there is nothing to complete on, and the turn
        // ends saying so, which is what §67 requires.
        //
        // Bounded twice, like every other nudge here: a planner that keeps
        // asking after being told cannot spend the round budget arguing.
        if (store.ids().length === 0 || analyses > bounds.maxAnalyses + 2) {
          return fail("analysis_unavailable", `the turn asked for more than ${bounds.maxAnalyses} separate analyses`);
        }
        errors.push(
          `You have used all ${bounds.maxAnalyses} analyses for this turn. No further analyze decision will run. ` +
            "Complete now with the results you already have, and say in the answer what you did not get to examine.",
        );
        continue;
      }
      const run = await params.analyze(decision, store, params.signal);
      budget.analyses = analyses;
      if (!run.ok) {
        // §67 — the requested analysis could not be completed. The turn ends
        // saying so. It does NOT continue with the deterministic tools and
        // present their output as the answer to a question they cannot
        // answer, which is precisely the substitution §5 forbids.
        trace.set({ analysisFailure: { code: run.code, message: run.message, attempts: run.attempts, objective: decision.objective } });
        return fail("analysis_unavailable", run.message);
      }
      trace.round({ round, decision, toolResultId: run.primary.resultId });
      trace.set({ analysisMethod: run.method, analysisAttempts: run.attempts, analysisDurationMs: run.durationMs });
      continue;
    }

    // tool_call
    if (budget.toolCalls >= bounds.maxToolCalls) return fail("tool_calls", `exceeded ${bounds.maxToolCalls} tool calls`);
    const exposure = { exposed: new Set(toolContext.exposedTools), availableCapabilities: toolContext.availableCapabilities };
    const validated = validateCall(decision, env, exposure);
    if (!validated.ok && validated.error.ok === false) {
      if (validated.error.error.code === "CAPABILITY_UNAVAILABLE") capabilityUnavailableErrors += 1;
      if (validated.error.error.code === "UNKNOWN_TOOL") unknownToolErrors += 1;
    }
    {
      const spec = findTool(decision.tool);
      if (spec && exposure.exposed.has(decision.tool)) {
        reached.add(spec.capability);
        calledTools.add(decision.tool);
      }
    }
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
    params.onProgress?.({ kind: "tool_call", tool: decision.tool });
    const toolStarted = Date.now();
    const { outcome, cached } = executeCall(validated.call, env, cache);
    params.timings?.addTool(Date.now() - toolStarted);
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

    if (decision.final === true) {
      budget.finalToolCalls += 1;
      const refusal = finalCallRefusal(declaredOutputs, outcome.result);
      if (refusal === null) {
        budget.finalToolCallsHonoured += 1;
        trace.set({
          completion: { primaryResultRef: outcome.result.resultId, supportingResultRefs: [] },
          completePrimaryResultRef: outcome.result.resultId,
        });
        return finish({ kind: "complete", primary: outcome.result, supporting: [], answerStyle: decision.answerIntent?.answerStyle ?? "concise", ...(decision.answerIntent ? { answerIntent: decision.answerIntent } : {}) }, "complete");
      }
      errors.push(`tool_call final → ${refusal}`);
    }
  }

  return fail("planner_rounds", `no completion within ${bounds.maxPlannerRounds} rounds`);
}

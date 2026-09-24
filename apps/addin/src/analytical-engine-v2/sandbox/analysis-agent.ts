import { validateExplorationCoverage } from "./exploration.js";
import { normalizeResult } from "./result-normalizer.js";
import { validateAgainstPlan, validateEnvelope, validateMethodChoice, validateSubjectLabels } from "./executor.js";
import { actionFingerprint, readAnalysisDecision, type AnalysisActionKind, type DecisionContract } from "./analysis-decision.js";
import {
  describeEnvironment,
  observeLook,
  observeStep,
  renderLook,
  type AgentObservation,
  type VariableDescriptor,
} from "./analysis-observation.js";
import type { ExecuteOutcome, LookObservation, LookTarget, StepObservation } from "./pyodide-runtime.js";
import { SANDBOX_LIMITS, type SandboxDataset, type SandboxError, type SandboxLimits, type SandboxPlan, type SandboxResult } from "./types.js";

// --- what the loop needs of the world --------------------------------------

/** The session surface, satisfied by both the direct and the worker runtime. */
export interface SessionRuntime {
  readonly hardTimeout: boolean;
  step(sessionId: string, code: string, dataset: SandboxDataset, signal?: AbortSignal): Promise<StepObservation | { readonly refused: SandboxError }>;
  look(
    sessionId: string,
    target: LookTarget,
    variable: string | null,
    dataset: SandboxDataset,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<LookObservation | { readonly refused: SandboxError }>;
  finish(sessionId: string, dataset: SandboxDataset, signal?: AbortSignal): Promise<ExecuteOutcome>;
  endSession(sessionId: string): Promise<void>;
}

/** §13 — an existing deterministic tool, as the loop addresses it. */
export interface DeterministicTool {
  readonly name: string;
  readonly summary: string;
  readonly capability?: string;
  readonly signature?: string;
  readonly loaded?: boolean;
}

export interface AgentCapabilityContext {
  readonly actions: readonly AnalysisActionKind[];
  readonly available: readonly string[];
  readonly selected: readonly string[];
  readonly purposes: readonly { readonly id: string; readonly purpose: string; readonly toolCount: number }[];
}

export type CapabilityDiscovery = (capability: string) => readonly DeterministicTool[] | null;

export type ToolOutcome =
  | { readonly ok: true; readonly summary: string; readonly resultRefs?: readonly string[] }
  | { readonly ok: false; readonly message: string };

export type ToolInvoker = (tool: string, input: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<ToolOutcome>;

/** §4 — everything one decision is given. Never less. */
export interface AgentContext {
  readonly round: number;
  /** The user's own words. §4: the model must not reconstruct these. */
  readonly request: string;
  readonly plan: SandboxPlan;
  readonly dataset: SandboxDataset;
  readonly observations: readonly AgentObservation[];
  readonly environment: readonly VariableDescriptor[];
  readonly tools: readonly DeterministicTool[];
  readonly capabilities?: AgentCapabilityContext;
  readonly remaining: RemainingBudget;
  /** §16 — set when the previous response was not a valid decision. */
  readonly controlError?: string;
}

export type Decide = (context: AgentContext) => Promise<string>;

// --- budgets ---------------------------------------------------------------

export interface AgentLoopBudgets {
  readonly maxDecisionRounds: number;
  readonly maxCodeExecutions: number;
  readonly maxInspections: number;
  readonly maxToolCalls: number;
  /** §16 — protocol self-correction, on its own allowance. */
  readonly maxControlErrors: number;
  /** §20 — how many times a rejected COMPLETE may be re-attempted. */
  readonly maxCompletionRetries: number;
  /** §18 — consecutive rounds that produce no new state before stopping. */
  readonly maxQuietRounds: number;
  /** §17 — how often the identical ineffective action is tolerated. */
  readonly maxRepeatsPerAction: number;
  /**
   * §15 — the wall clock for the WHOLE turn.
   *
   * The per-step timeout bounds one step; nothing bounded the sum of them.
   * That was survivable at eight rounds and is not at fourteen, so raising the
   * round budget comes with this.
   */
  readonly maxTurnMs: number;
}

/**
 * §15 — safety budgets, not targets, and MEASURED rather than assumed.
 *
 * §15 gives starting values (8 decisions, 5 executions, 5 inspections, 8 tool
 * calls) and the brief is explicit that they must be measured rather than
 * blindly kept. Three live smoke runs measured them:
 *
 *   run 2: mean 7.0 rounds, 2.60 executions, 3.00 inspections — 4 of 5 turns
 *          hit the round ceiling.
 *   run 3: mean 8.0 rounds, 4.75 executions, 1.25 inspections — ALL FOUR
 *          turns hit the ceiling, with zero repeated actions and zero
 *          completion rejections.
 *
 * Zero repeated actions is the number that decides this. A loop that spends
 * its budget going in circles needs a tighter budget or a better guard; a loop
 * that spends it doing new work each round and is cut off mid-analysis needs
 * room. Run 3 was the second kind, and its traces show it: five executions,
 * recovery from a ValueError, and then the ceiling.
 *
 * So rounds and executions go up, and INSPECTIONS COME DOWN — measured at
 * 1.25 once the prompt stopped offering to fetch the schema it had already
 * supplied, so five was funding a habit rather than a need.
 *
 * Raising a round budget cannot be allowed to raise the wall clock without
 * limit, so `maxTurnMs` is added alongside (§15's "keep existing runtime
 * wall-clock protection"): the per-step timeout bounds one step, and this
 * bounds the turn. 180s against a measured mean of 50s.
 *
 * The other four come from existing engine bounds — protocol correction from
 * `maxTotalProtocolCorrections`, completion retry from `maxCompletionRetries`.
 */
export const ANALYSIS_AGENT_BUDGETS: AgentLoopBudgets = {
  maxDecisionRounds: 14,
  maxCodeExecutions: 8,
  maxInspections: 3,
  maxToolCalls: 8,
  maxControlErrors: 2,
  maxCompletionRetries: 1,
  maxQuietRounds: 3,
  maxRepeatsPerAction: 1,
  maxTurnMs: 180_000,
};

export interface RemainingBudget {
  readonly decisionRounds: number;
  readonly codeExecutions: number;
  readonly inspections: number;
  readonly toolCalls: number;
}

// --- outcome ---------------------------------------------------------------

/** §25 — why a turn ended. An EXECUTION_FAILURE on one step is not one of these. */
export type AgentFailureCategory = "CONTROL_FAILURE" | "SECURITY_FAILURE" | "EXECUTION_FAILURE" | "DATA_FAILURE" | "SEMANTIC_FAILURE" | "BUDGET_EXHAUSTED";

export interface AgentStepRecord {
  readonly stepId: number;
  readonly action: string;
  readonly purpose?: string;
  readonly code?: string;
  readonly target?: string;
  readonly tool?: string;
  readonly observation: AgentObservation;
}

/** §26/§38 — what the turn cost and whether it recovered. */
export interface AgentMetrics {
  readonly decisionRounds: number;
  readonly codeExecutions: number;
  readonly inspections: number;
  readonly toolCalls: number;
  readonly controlErrors: number;
  readonly executionErrors: number;
  readonly repeatedActions: number;
  readonly completionRejections: number;
  /** How many responses arrived as a batch and had all but the first dropped. */
  readonly batchedDecisions: number;
  readonly toolDiscoveryRequests: number;
  readonly capabilityUnavailableErrors: number;
  readonly unknownToolErrors: number;
  readonly callToolWithoutInvoker: number;
  readonly executeCodeWithoutRuntime: number;
  readonly initiallyExposedToolCount: number;
  readonly finalExposedToolCount: number;
  readonly calledToolCount: number;
  /** §26 — did any execution step fail in this turn? */
  readonly selfRecoveryOpportunity: boolean;
  /** §26 — and did the turn nonetheless reach a valid COMPLETE? */
  readonly selfRecoverySuccess: boolean;
  readonly decisionMs: number;
  readonly executionMs: number;
  readonly inspectionMs: number;
  readonly totalMs: number;
}

export type AnalysisAgentOutcome =
  | {
      readonly status: "complete";
      readonly result: SandboxResult;
      readonly primaryResultRefs: readonly string[];
      readonly supportingResultRefs: readonly string[];
      readonly trace: readonly AgentStepRecord[];
      readonly metrics: AgentMetrics;
    }
  | {
      readonly status: "partial";
      readonly result?: SandboxResult;
      readonly completed: readonly string[];
      readonly missing: readonly string[];
      readonly reason: string;
      readonly trace: readonly AgentStepRecord[];
      readonly metrics: AgentMetrics;
    }
  | { readonly status: "clarify"; readonly question: string; readonly candidates: readonly string[]; readonly trace: readonly AgentStepRecord[]; readonly metrics: AgentMetrics }
  | { readonly status: "failed"; readonly failure: AgentFailureCategory; readonly error: SandboxError; readonly trace: readonly AgentStepRecord[]; readonly metrics: AgentMetrics };

export interface AnalysisAgentParams {
  readonly runtime: SessionRuntime;
  readonly sessionId: string;
  readonly request: string;
  readonly plan: SandboxPlan;
  readonly dataset: SandboxDataset;
  readonly decide: Decide;
  /** §69 of Stage 27 — the workbook version NOW, re-read before committing. */
  readonly currentSourceVersion: () => string;
  readonly tools?: readonly DeterministicTool[];
  readonly invokeTool?: ToolInvoker;
  readonly sandboxAvailable?: boolean;
  readonly availableCapabilities?: readonly { readonly id: string; readonly purpose: string; readonly toolCount: number }[];
  readonly discover?: CapabilityDiscovery;
  readonly budgets?: AgentLoopBudgets;
  readonly limits?: SandboxLimits;
  readonly signal?: AbortSignal;
  readonly onStep?: (record: AgentStepRecord) => void;
}

// --- completion checking ---------------------------------------------------

/** Every name a COMPLETE could legitimately point at. */
export function availableResultRefs(result: SandboxResult): readonly string[] {
  return [
    ...result.tables.map((t) => t.name),
    ...result.series.map((s) => s.name),
    ...Object.keys(result.scalars),
    ...result.groups.map((g) => g.label),
    // A model is a loose record, so its name is whatever it called itself.
    ...result.models.map((m) => (typeof m["name"] === "string" ? m["name"] : "")),
    ...Object.keys(result.diagnostics),
  ].filter((name): name is string => typeof name === "string" && name.trim() !== "");
}

export interface CompletionCheck {
  readonly ok: boolean;
  readonly result?: SandboxResult;
  readonly missing: readonly string[];
  /** Set when the failure is one no further agent action can fix. */
  readonly fatal?: SandboxError;
}

/**
 * §20 — is this COMPLETE actually complete?
 *
 * Every check here already existed; what is new is only WHEN it runs. That is
 * the point of reusing the functions rather than writing session-flavoured
 * copies: a validator with two implementations eventually has two behaviours,
 * and the iterative path would become the lenient one by accident.
 *
 * The one check that is genuinely new is the first: the refs the model named
 * must exist in the envelope it produced. §19 rules out picking the last
 * result on the model's behalf, which only means anything if naming a result
 * that was never computed is refused rather than quietly reinterpreted.
 */
export function checkCompletion(params: {
  readonly plan: SandboxPlan;
  readonly dataset: SandboxDataset;
  readonly outcome: ExecuteOutcome;
  readonly primaryResultRefs: readonly string[];
  readonly limits: SandboxLimits;
  readonly currentSourceVersion: () => string;
}): CompletionCheck {
  const { plan, dataset, outcome, primaryResultRefs, limits } = params;

  if (!outcome.ok) {
    // An envelope that will not collect at all — nothing was ever emitted —
    // is something the agent CAN act on: emit the results and complete again.
    return { ok: false, missing: [outcome.error.message] };
  }

  const normalized = normalizeResult(plan, outcome.result);
  const committed = normalized.result;
  const available = new Set(availableResultRefs(committed));
  const unknown = primaryResultRefs.filter((ref) => !available.has(ref));

  const problems = [
    ...unknown.map((ref) => `the primary result "${ref}" was never emitted in this analysis; emitted: ${[...available].join(", ") || "nothing"}`),
    // §20's "no unresolved semantic substitution" — the normalizer reports a
    // naming mismatch it could not resolve by counting rather than guessing.
    ...normalized.ambiguous,
    ...validateEnvelope(committed, limits),
    ...validateAgainstPlan(plan, committed),
    ...validateMethodChoice(plan, committed),
    ...validateExplorationCoverage(plan.explorationDimensions ?? [], committed),
    ...validateSubjectLabels(plan, dataset, committed),
  ];

  // §20 "result freshness valid" — Stage 27 §69. A result computed against a
  // workbook that has since changed is not incomplete, it is void, and no
  // further agent action can make it current.
  if (dataset.freshnessToken !== params.currentSourceVersion()) {
    return { ok: false, missing: ["the workbook changed while the analysis was running"], fatal: { code: "STALE_DATASET", message: "the workbook changed while the analysis was running" } };
  }

  if (problems.length > 0) return { ok: false, result: committed, missing: problems };
  return { ok: true, result: committed, missing: [] };
}

// --- the loop --------------------------------------------------------------

const NEWLINE = String.fromCharCode(10);

/**
 * §2 — the one authoritative analytical loop.
 *
 * Read the budget bookkeeping with §16 in mind: a malformed decision costs a
 * CONTROL_ERROR and a decision round, never a code execution. The separation
 * is not bookkeeping neatness. If protocol slips came out of the analytical
 * budget, a model having a bad day at JSON would present as a model that
 * could not do the analysis, and the fix would be aimed at the wrong thing.
 */
export async function runAnalysisAgent(params: AnalysisAgentParams): Promise<AnalysisAgentOutcome> {
  const budgets = params.budgets ?? ANALYSIS_AGENT_BUDGETS;
  const limits = params.limits ?? SANDBOX_LIMITS;
  const tools: DeterministicTool[] = [...(params.tools ?? [])];
  const initiallyExposedToolCount = tools.length;
  const sandboxAvailable = params.sandboxAvailable ?? true;
  const started = Date.now();
  let toolDiscoveryRequests = 0;
  let capabilityUnavailableErrors = 0;
  let unknownToolErrors = 0;
  let callToolWithoutInvoker = 0;
  let executeCodeWithoutRuntime = 0;
  const calledTools = new Set<string>();

  const canCallTool = (): boolean => params.invokeTool !== undefined && tools.length > 0;
  const contract = (): DecisionContract => ({
    actions: [
      ...(sandboxAvailable ? (["INSPECT", "EXECUTE_CODE"] as AnalysisActionKind[]) : []),
      ...(canCallTool() ? (["CALL_TOOL"] as AnalysisActionKind[]) : []),
      ...(params.discover ? (["DISCOVER_TOOLS"] as AnalysisActionKind[]) : []),
      "CLARIFY",
      "COMPLETE",
    ],
  });
  const capabilityContext = (): AgentCapabilityContext => {
    const purposes = params.availableCapabilities ?? [];
    return {
      actions: contract().actions,
      available: purposes.map((c) => c.id),
      selected: [...new Set(tools.map((t) => t.capability).filter((c): c is string => c !== undefined))],
      purposes,
    };
  };

  const observations: AgentObservation[] = [];
  const trace: AgentStepRecord[] = [];
  let environment: readonly VariableDescriptor[] = [];

  let rounds = 0;
  let codeExecutions = 0;
  let inspections = 0;
  let toolCalls = 0;
  let controlErrors = 0;
  let executionErrors = 0;
  let repeatedActions = 0;
  let completionRejections = 0;
  let batchedDecisions = 0;
  let quietRounds = 0;
  let decisionMs = 0;
  let executionMs = 0;
  let inspectionMs = 0;

  const attempted = new Map<string, number>();
  let pendingControlError: string | undefined;
  let stepId = 0;

  const metrics = (): AgentMetrics => ({
    decisionRounds: rounds,
    codeExecutions,
    inspections,
    toolCalls,
    controlErrors,
    executionErrors,
    repeatedActions,
    completionRejections,
    batchedDecisions,
    toolDiscoveryRequests,
    capabilityUnavailableErrors,
    unknownToolErrors,
    callToolWithoutInvoker,
    executeCodeWithoutRuntime,
    initiallyExposedToolCount,
    finalExposedToolCount: tools.length,
    calledToolCount: calledTools.size,
    selfRecoveryOpportunity: executionErrors > 0,
    selfRecoverySuccess: false,
    decisionMs,
    executionMs,
    inspectionMs,
    totalMs: Date.now() - started,
  });

  // The step id comes from the observation, never recomputed alongside it.
  // The two used to be assigned separately in one object literal, which was
  // correct only because of property evaluation order — a property nobody
  // should have to know to read this loop.
  const record = (entry: Omit<AgentStepRecord, "stepId">): void => {
    const full: AgentStepRecord = { ...entry, stepId: entry.observation.stepId };
    trace.push(full);
    observations.push(full.observation);
    params.onStep?.(full);
  };

  /** Steps are numbered from exactly one place. */
  const nextStepId = (): number => (stepId += 1);

  const note = (
    actionType: AgentObservation["actionType"],
    status: AgentObservation["status"],
    summary: string,
    extra: Partial<AgentObservation> = {},
  ): AgentObservation => ({ stepId: nextStepId(), actionType, status, summary, elapsedMs: 0, ...extra });

  const fail = (failure: AgentFailureCategory, error: SandboxError): AnalysisAgentOutcome => ({ status: "failed", failure, error, trace, metrics: metrics() });

  const cancelled = (): boolean => params.signal?.aborted === true;

  try {
    // §40/§43 — a runtime that cannot bound CPU-bound Python never receives
    // generated code, iterative or not. Checked here rather than trusted from
    // the caller so a differently-constructed loop cannot bypass it.
    if (!params.runtime.hardTimeout) {
      return fail("SECURITY_FAILURE", { code: "SANDBOX_UNAVAILABLE", message: "the analytical runtime on this host cannot bound the time an analysis takes, so generated code is not run" });
    }
    // Stage 27 §69 — refuse to START on data that has already moved.
    if (params.dataset.freshnessToken !== params.currentSourceVersion()) {
      return fail("DATA_FAILURE", { code: "STALE_DATASET", message: "the workbook changed before the analysis began" });
    }

    while (rounds < budgets.maxDecisionRounds) {
      if (cancelled()) return fail("EXECUTION_FAILURE", { code: "CANCELLED", message: "cancelled" });
      // §15 — the turn's own wall clock, checked between rounds. A turn that
      // has spent three minutes is not going to be rescued by a fourth.
      if (Date.now() - started >= budgets.maxTurnMs) break;
      rounds += 1;

      const context: AgentContext = {
        round: rounds,
        request: params.request,
        plan: params.plan,
        dataset: params.dataset,
        observations,
        environment,
        tools,
        capabilities: capabilityContext(),
        remaining: {
          decisionRounds: budgets.maxDecisionRounds - rounds,
          codeExecutions: budgets.maxCodeExecutions - codeExecutions,
          inspections: budgets.maxInspections - inspections,
          toolCalls: budgets.maxToolCalls - toolCalls,
        },
        ...(pendingControlError ? { controlError: pendingControlError } : {}),
      };
      pendingControlError = undefined;

      const decisionStarted = Date.now();
      let raw: string;
      try {
        raw = await params.decide(context);
      } catch (err) {
        return fail("CONTROL_FAILURE", { code: "SANDBOX_UNAVAILABLE", message: `the analytical agent could not be reached: ${String(err)}` });
      }
      decisionMs += Date.now() - decisionStarted;

      const parsed = readAnalysisDecision(raw, contract());
      if (!parsed.ok) {
        // §16 — a control error costs a control allowance and a round. It does
        // NOT consume a code execution: nothing ran.
        controlErrors += 1;
        if (parsed.error.startsWith("CAPABILITY_UNAVAILABLE")) {
          capabilityUnavailableErrors += 1;
          if (/CAPABILITY_UNAVAILABLE CALL_TOOL/u.test(parsed.error)) callToolWithoutInvoker += 1;
          if (/CAPABILITY_UNAVAILABLE EXECUTE_CODE/u.test(parsed.error)) executeCodeWithoutRuntime += 1;
        }
        record({ action: "CONTROL_ERROR", observation: note("CONTROL", "error", `CONTROL_ERROR ${parsed.error}`) });
        if (controlErrors > budgets.maxControlErrors) {
          return fail("CONTROL_FAILURE", { code: "INVALID_RESULT", message: `the analytical agent did not emit a valid decision after ${controlErrors} attempts: ${parsed.error}` });
        }
        pendingControlError = parsed.error;
        continue;
      }

      const decision = parsed.decision;

      // The model sent a whole plan; only its first action was taken. Saying
      // so is not optional — an agent that believes steps 2..n ran will build
      // its next action on variables that do not exist.
      if (parsed.batched) {
        batchedDecisions += 1;
        record({
          action: "BATCH_TRIMMED",
          observation: note(
            "CONTROL",
            "ok",
            `You sent ${parsed.batched.count} decisions at once. ONLY THE FIRST WAS RUN (${decision.kind}); ` +
              `the rest were discarded and did NOT happen: ${parsed.batched.dropped.join(", ")}. ` +
              "Decide the next action from the result below, not from the plan you wrote before you had it.",
          ),
        });
      }

      // §17 — the same ineffective action, again.
      const fingerprint = actionFingerprint(decision);
      const seen = attempted.get(fingerprint) ?? 0;
      if (decision.kind !== "COMPLETE" && seen > budgets.maxRepeatsPerAction) {
        repeatedActions += 1;
        record({
          action: "REPEATED_ACTION",
          observation: note(decision.kind, "repeated", `REPEATED_ACTION — this exact action has already been tried ${seen} times with the same result; choose a different one`),
        });
        if (repeatedActions > budgets.maxRepeatsPerAction) {
          return fail("EXECUTION_FAILURE", { code: "INVALID_RESULT", message: "the analysis repeated the same ineffective action without making progress" });
        }
        continue;
      }
      attempted.set(fingerprint, seen + 1);

      // --- CLARIFY -------------------------------------------------------
      if (decision.kind === "CLARIFY") {
        // §23 — clarification resolves an AMBIGUITY, not a failed attempt. A
        // model that just watched its code raise is being asked to write
        // different code, and letting it escape into a question instead is how
        // a recoverable NameError becomes a prompt the user has to answer.
        const last = observations[observations.length - 1];
        if (last?.status === "error" && last.actionType === "EXECUTE_CODE") {
          controlErrors += 1;
          record({
            action: "CLARIFY_REFUSED",
            observation: note("CONTROL", "error", "CLARIFY is for a semantic ambiguity in the request, not for a step that failed. The previous error is recoverable: act on the observation above."),
          });
          if (controlErrors > budgets.maxControlErrors) {
            return fail("CONTROL_FAILURE", { code: "INVALID_RESULT", message: "the analysis asked for clarification instead of acting on a recoverable execution error" });
          }
          continue;
        }
        return { status: "clarify", question: decision.question, candidates: decision.candidates, trace, metrics: metrics() };
      }

      // --- COMPLETE ------------------------------------------------------
      if (decision.kind === "COMPLETE") {
        if (cancelled()) return fail("EXECUTION_FAILURE", { code: "CANCELLED", message: "cancelled" });
        const outcome = await params.runtime.finish(params.sessionId, params.dataset, params.signal);
        const check = checkCompletion({
          plan: params.plan,
          dataset: params.dataset,
          outcome,
          primaryResultRefs: decision.primaryResultRefs,
          limits,
          currentSourceVersion: params.currentSourceVersion,
        });
        if (check.fatal) return fail("DATA_FAILURE", check.fatal);

        if (check.ok && check.result) {
          record({
            action: "COMPLETE",
            observation: note("COMPLETE", "ok", "COMPLETE", { resultRefs: decision.primaryResultRefs }),
          });
          return {
            status: "complete",
            result: check.result,
            primaryResultRefs: decision.primaryResultRefs,
            supportingResultRefs: decision.supportingResultRefs,
            trace,
            // §26 — a turn that hit an execution error and still completed is
            // the definition of a self-recovery success.
            metrics: { ...metrics(), selfRecoverySuccess: executionErrors > 0 },
          };
        }

        // §20 — an incomplete COMPLETE is a structured observation, and the
        // same agent continues if budget remains.
        completionRejections += 1;
        record({
          action: "INCOMPLETE_ANALYSIS",
          observation: note("COMPLETE", "incomplete", ["INCOMPLETE_ANALYSIS", "", "missing:", ...check.missing.map((m) => `- ${m}`)].join(NEWLINE)),
        });
        if (completionRejections > budgets.maxCompletionRetries) {
          return partial(check.result, params.plan, check.missing, "the analysis could not be completed to the requested shape");
        }
        quietRounds = 0;
        continue;
      }

      // --- INSPECT -------------------------------------------------------
      if (decision.kind === "INSPECT") {
        if (inspections >= budgets.maxInspections) {
          record({
            action: "BUDGET",
            observation: note("CONTROL", "error", "The inspection budget is spent. Compute what you need in an EXECUTE_CODE step, or COMPLETE with what you have."),
          });
          quietRounds += 1;
          if (quietRounds > budgets.maxQuietRounds) break;
          continue;
        }
        inspections += 1;
        const lookStarted = Date.now();
        const look = await params.runtime.look(params.sessionId, decision.target, decision.variable, params.dataset, 10, params.signal);
        const elapsed = Date.now() - lookStarted;
        inspectionMs += elapsed;
        if ("refused" in look) return fail("EXECUTION_FAILURE", look.refused);
        const observation = observeLook({ stepId: nextStepId(), look, elapsedMs: elapsed });
        record({ action: "INSPECT", purpose: decision.purpose, target: decision.target, observation });
        // §18 — an inspection is new information by definition, so it counts
        // as progress even though it creates nothing.
        quietRounds = look.status === "ok" ? 0 : quietRounds + 1;
        if (quietRounds > budgets.maxQuietRounds) break;
        continue;
      }

      // --- DISCOVER_TOOLS ------------------------------------------------
      if (decision.kind === "DISCOVER_TOOLS") {
        toolDiscoveryRequests += 1;
        const found = params.discover?.(decision.capability) ?? null;
        if (found === null || found.length === 0) {
          capabilityUnavailableErrors += 1;
          const offered = capabilityContext().purposes.map((c) => c.id);
          record({
            action: "CAPABILITY_UNAVAILABLE",
            observation: note(
              "CONTROL",
              "error",
              `CAPABILITY_UNAVAILABLE "${decision.capability}" is not a capability this analysis has. Available: ${offered.join(", ") || "none"}.`,
            ),
          });
          quietRounds += 1;
          if (quietRounds > budgets.maxQuietRounds) break;
          continue;
        }
        const added = found.filter((tool) => !tools.some((known) => known.name === tool.name));
        tools.push(...added);
        record({
          action: "DISCOVER_TOOLS",
          purpose: decision.purpose,
          observation: note(
            "CONTROL",
            "ok",
            [`AVAILABLE ${decision.capability.toUpperCase()} TOOLS:`, ...found.map((tool) => `  ${tool.signature ?? tool.name} — ${tool.summary}`)].join(NEWLINE),
          ),
        });
        quietRounds = added.length > 0 ? 0 : quietRounds + 1;
        if (quietRounds > budgets.maxQuietRounds) break;
        continue;
      }

      // --- CALL_TOOL -----------------------------------------------------
      if (decision.kind === "CALL_TOOL") {
        if (!params.invokeTool || tools.length === 0) {
          controlErrors += 1;
          callToolWithoutInvoker += 1;
          capabilityUnavailableErrors += 1;
          record({
            action: "CAPABILITY_UNAVAILABLE",
            observation: note("CONTROL", "error", `CAPABILITY_UNAVAILABLE no deterministic tools are available in this analysis. Available actions: ${contract().actions.join(", ")}.`),
          });
          if (controlErrors > budgets.maxControlErrors) return fail("CONTROL_FAILURE", { code: "INVALID_RESULT", message: "the analysis kept calling tools that are not available" });
          continue;
        }
        if (!tools.some((tool) => tool.name === decision.tool)) {
          const discovered = params.discover?.(decision.tool) ?? null;
          if (discovered && discovered.length > 0) {
            tools.push(...discovered.filter((tool) => !tools.some((known) => known.name === tool.name)));
            record({
              action: "TOOL_NOT_EXPOSED",
              observation: note(
                "CONTROL",
                "error",
                [
                  `"${decision.tool}" was not loaded, so it did NOT run. These are now loaded and callable — send the call again:`,
                  ...discovered.map((tool) => `  ${tool.signature ?? tool.name} — ${tool.summary}`),
                ].join(NEWLINE),
              ),
            });
          } else {
            unknownToolErrors += 1;
            record({
              action: "UNKNOWN_TOOL",
              observation: note(
                "CONTROL",
                "error",
                `UNKNOWN_TOOL "${decision.tool}" is not a tool of this analysis. Callable now: ${tools.map((tool) => tool.name).join(", ") || "none"}.`,
              ),
            });
          }
          controlErrors += 1;
          if (controlErrors > budgets.maxControlErrors) return fail("CONTROL_FAILURE", { code: "INVALID_RESULT", message: `the analysis kept calling "${decision.tool}", which it does not have` });
          continue;
        }
        if (toolCalls >= budgets.maxToolCalls) {
          record({ action: "BUDGET", observation: note("CONTROL", "error", "The tool budget is spent.") });
          quietRounds += 1;
          if (quietRounds > budgets.maxQuietRounds) break;
          continue;
        }
        toolCalls += 1;
        calledTools.add(decision.tool);
        const toolStarted = Date.now();
        let result: ToolOutcome;
        try {
          result = await params.invokeTool(decision.tool, decision.input, params.signal);
        } catch (err) {
          result = { ok: false, message: String(err) };
        }
        const elapsed = Date.now() - toolStarted;
        const toolStepId = nextStepId();
        // §14 — a tool result enters the SAME observation stream as a code
        // result. One reasoning surface, not two.
        const observation: AgentObservation = result.ok
          ? { stepId: toolStepId, actionType: "CALL_TOOL", status: "ok", summary: result.summary, ...(result.resultRefs ? { resultRefs: result.resultRefs } : {}), elapsedMs: elapsed }
          : {
              stepId: toolStepId,
              actionType: "CALL_TOOL",
              status: "error",
              summary: `TOOL_ERROR ${decision.tool}`,
              error: { type: "ToolError", message: result.message },
              elapsedMs: elapsed,
            };
        record({ action: "CALL_TOOL", purpose: decision.purpose, tool: decision.tool, observation });
        quietRounds = result.ok ? 0 : quietRounds + 1;
        if (quietRounds > budgets.maxQuietRounds) break;
        continue;
      }

      // --- EXECUTE_CODE --------------------------------------------------
      if (codeExecutions >= budgets.maxCodeExecutions) {
        record({
          action: "BUDGET",
          observation: note("CONTROL", "error", "The code execution budget is spent. COMPLETE with the results you have already emitted, or stop."),
        });
        quietRounds += 1;
        if (quietRounds > budgets.maxQuietRounds) break;
        continue;
      }
      // NOT preflighted, deliberately.
      //
      // The one-shot executor runs `numericPreflight` before it spends a
      // Pyodide execution, because there a `X.fillna(...)` cost a full
      // regeneration of a forty-line program. Here it costs one step, and the
      // real AttributeError from numpy is better evidence than a message we
      // synthesised about code we did not run — which is §1's whole claim.
      // Preflighting here would also mean the agent never sees the error it
      // is supposed to be learning from.
      //
      // The SECURITY validator is a different matter and does still run on
      // every step: that one is not advice (§40).
      codeExecutions += 1;
      const before = environment;
      const runStarted = Date.now();
      const step = await params.runtime.step(params.sessionId, decision.code, params.dataset, params.signal);
      executionMs += Date.now() - runStarted;

      if ("refused" in step) {
        // §40/§25 — the sandbox declined to run this at all. Unsafe code is
        // never retried (Stage 27 §68); a dead or cancelled runtime is not
        // something the agent can write its way out of either.
        const category: AgentFailureCategory = step.refused.code === "UNSAFE_CODE" ? "SECURITY_FAILURE" : "EXECUTION_FAILURE";
        record({
          action: "EXECUTE_CODE",
          purpose: decision.purpose,
          code: decision.code,
          observation: note("EXECUTE_CODE", "refused", `REFUSED ${step.refused.code}`, { error: { type: step.refused.code, message: step.refused.message } }),
        });
        return fail(category, step.refused);
      }

      const observation = observeStep({ stepId: nextStepId(), step, before });
      environment = describeEnvironment(step.available);
      record({ action: "EXECUTE_CODE", purpose: decision.purpose, code: decision.code, observation });

      if (step.status === "error") {
        // §1/§26 — NOT a turn failure. An observation, and an opportunity.
        executionErrors += 1;
        quietRounds += 1;
      } else {
        // §18 — progress is new state, not merely a step that did not raise.
        const produced = (observation.createdVariables?.length ?? 0) + (observation.variableUpdates?.length ?? 0) > 0;
        quietRounds = produced || step.hasResult === true ? 0 : quietRounds + 1;
      }
      if (quietRounds > budgets.maxQuietRounds) break;
    }

    // §22 — the budget is spent. Preserve whatever is genuinely there, and say
    // plainly that the rest is not. Reporting this as success is the §5
    // substitution this whole stage exists to prevent.
    if (cancelled()) return fail("EXECUTION_FAILURE", { code: "CANCELLED", message: "cancelled" });
    const salvage = await params.runtime.finish(params.sessionId, params.dataset, params.signal);
    if (!salvage.ok) {
      return fail("BUDGET_EXHAUSTED", {
        code: "INVALID_RESULT",
        message:
          Date.now() - started >= budgets.maxTurnMs
            ? `the analysis did not finish within ${Math.round(budgets.maxTurnMs / 1000)} seconds and produced no result`
            : `the analysis did not finish within ${budgets.maxDecisionRounds} decisions and produced no result`,
      });
    }
    const normalized = normalizeResult(params.plan, salvage.result);
    const ranOut = Date.now() - started >= budgets.maxTurnMs;
    return partial(
      normalized.result,
      params.plan,
      validateAgainstPlan(params.plan, normalized.result),
      ranOut ? `the analysis did not finish within ${Math.round(budgets.maxTurnMs / 1000)} seconds` : `the analysis did not finish within ${budgets.maxDecisionRounds} decisions`,
    );
  } finally {
    // §43 — one session per turn, ended whatever happened. A turn that threw
    // is exactly the turn whose namespace must not outlive it.
    await params.runtime.endSession(params.sessionId).catch(() => undefined);
  }

  function partial(result: SandboxResult | undefined, plan: SandboxPlan, missing: readonly string[], reason: string): AnalysisAgentOutcome {
    const completed = result ? availableResultRefs(result) : [];
    const outstanding =
      missing.length > 0 ? missing : plan.requestedOutputs.filter((o) => !completed.includes(o.id)).map((o) => o.description);
    return {
      status: "partial",
      ...(result ? { result } : {}),
      completed,
      missing: outstanding,
      reason,
      trace,
      metrics: metrics(),
    };
  }
}

/** §36 — the debug trace, as a human reads it. Never shown in normal UI (§37). */
export function renderAgentTrace(request: string, trace: readonly AgentStepRecord[], outcome: AnalysisAgentOutcome): string {
  const lines: string[] = ["GOAL", request, ""];
  for (const entry of trace) {
    lines.push(`STEP ${entry.stepId}`);
    lines.push(entry.tool ? `${entry.action} ${entry.tool}` : entry.target ? `${entry.action} ${entry.target}` : entry.action);
    const head = entry.observation.error
      ? `→ ${entry.observation.error.type}: ${entry.observation.error.message}`
      : `→ ${entry.observation.summary.split(NEWLINE)[0] ?? ""}`;
    lines.push(head, "");
  }
  lines.push(`OUTCOME: ${outcome.status}`);
  if (outcome.status === "complete") lines.push("primary:", outcome.primaryResultRefs.join(", "));
  if (outcome.status === "partial") lines.push("missing:", ...outcome.missing.map((m) => `- ${m}`));
  if (outcome.status === "failed") lines.push(`${outcome.failure}: ${outcome.error.message}`);
  lines.push("", `rounds=${outcome.metrics.decisionRounds} code=${outcome.metrics.codeExecutions} errors=${outcome.metrics.executionErrors} recovered=${outcome.metrics.selfRecoverySuccess}`);
  return lines.join(NEWLINE);
}

export { renderLook };

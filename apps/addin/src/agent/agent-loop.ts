import { stableStringify } from "../analysis/index.js";
import { AGENT_BOUNDS, type AgentBounds, type AgentTerminationReason } from "./bounds.js";
import { parseAgentDecision } from "./decision-schema.js";
import { clampObservation, observationCellCount } from "./observation.js";
import type {
  AgentDecisionContext,
  AgentLanguage,
  AgentLoopState,
  AgentObservation,
  AgentPendingClarification,
  AgentResume,
  AgentStep,
  AgentToolContext,
  AgentToolDeps,
  AgentToolRegistry,
} from "./types.js";

export interface RunAgentLoopParams {
  readonly taskId: string;
  readonly request: string;
  readonly language?: AgentLanguage;
  readonly registry: AgentToolRegistry;
  readonly deps: AgentToolDeps;
  readonly bounds?: AgentBounds;
  /**
   * The model. Given the compact decision context it returns ONE raw decision
   * (a JSON string or an already-parsed object). It MUST NOT perform any side
   * effect — it only reasons about what information is required next.
   */
  readonly decide: (ctx: AgentDecisionContext) => Promise<unknown> | unknown;
  /** Compact workbook context string for the model (caller-provided; may be empty). */
  readonly workbookContext?: string;
  /** §7 — resume a task that stopped at a clarification, carrying its observations + budgets. */
  readonly resume?: AgentResume;
  /** Dev/test observability sink — invoked after every step. No chain-of-thought. */
  readonly onStep?: (step: AgentStep, state: AgentLoopState) => void;
  /** Monotonic clock (tests inject a stub). */
  readonly now?: () => number;
}

export async function runAgentLoop(params: RunAgentLoopParams): Promise<AgentLoopState> {
  const bounds = params.bounds ?? AGENT_BOUNDS;
  const language: AgentLanguage = params.language ?? "en";
  const now = params.now ?? (() => Date.now());
  const workbookContext = params.workbookContext ?? "";

  const steps: AgentStep[] = [];
  const observations: AgentObservation[] = [];
  const referencedResultIds: string[] = [];
  const callCounts = new Map<string, number>();
  let workbookReads = 0;
  let modelCalls = 0;
  let invalidStreak = 0;
  let resultSeq = 0;

  // §7 — a resumed task carries its prior observations, budgets and result ids;
  // the user's clarification answer enters as a synthetic observation.
  if (params.resume) {
    const prior = params.resume.state;
    observations.push(...prior.observations);
    steps.push(...prior.steps);
    referencedResultIds.push(...prior.referencedResultIds);
    workbookReads = prior.workbookReads;
    modelCalls = prior.modelCalls;
    resultSeq = prior.referencedResultIds.length;
    observations.push({
      tool: "user_clarification",
      ok: true,
      kind: "text",
      note: `The user answered your earlier clarification with: "${params.resume.answer}". Continue the original task using this answer. Do not ask the same question again.`,
    });
  }

  const buildState = (
    status: AgentLoopState["status"],
    reason?: AgentTerminationReason,
    extra: Partial<Pick<AgentLoopState, "pendingClarification" | "finalAnswer">> = {},
  ): AgentLoopState => ({
    taskId: params.taskId,
    originalUserRequest: params.request,
    language,
    steps: [...steps],
    observations: [...observations],
    referencedResultIds: [...referencedResultIds],
    workbookReads,
    modelCalls,
    status,
    ...(reason ? { terminationReason: reason } : {}),
    ...extra,
  });

  const finish = (
    step: AgentStep,
    reason: AgentTerminationReason,
    extra: Partial<Pick<AgentLoopState, "pendingClarification" | "finalAnswer">> = {},
  ): AgentLoopState => {
    steps.push(step);
    const status =
      reason === "final_answer" ? "done" : reason === "clarification" ? "awaiting_clarification" : "terminated";
    const state = buildState(status, reason, extra);
    params.onStep?.(step, state);
    return state;
  };

  const carryOn = (step: AgentStep): void => {
    steps.push(step);
    params.onStep?.(step, buildState("running"));
  };

  while (true) {
    if (steps.length >= bounds.maxAgentSteps) {
      const state = buildState("terminated", "step_budget");
      params.onStep?.({ iteration: steps.length + 1, decision: { kind: "invalid", error: "step budget reached" }, durationMs: 0 }, state);
      return state;
    }

    const decisionContext: AgentDecisionContext = {
      originalUserRequest: params.request,
      language,
      workbookContext,
      toolSchemas: params.registry.schemas(),
      observations: [...observations],
      iteration: steps.length + 1,
      remainingSteps: bounds.maxAgentSteps - steps.length,
      remainingReads: bounds.maxWorkbookReads - workbookReads,
    };

    const startedAt = now();
    let raw: unknown;
    try {
      raw = await params.decide(decisionContext);
    } catch (error) {
      raw = { __decideError: error instanceof Error ? error.message : String(error) };
    }
    modelCalls += 1;
    const durationMs = Math.max(0, now() - startedAt);
    const iteration = steps.length + 1;

    const parsed = parseAgentDecision(raw);
    if (!parsed.ok) {
      invalidStreak += 1;
      const step: AgentStep = { iteration, decision: { kind: "invalid", error: parsed.error }, durationMs };
      if (invalidStreak > bounds.maxIdenticalRetries) return finish(step, "model_error");
      carryOn(step);
      continue;
    }
    invalidStreak = 0;
    const decision = parsed.decision;

    if (decision.kind === "final") {
      return finish({ iteration, decision, durationMs }, "final_answer", { finalAnswer: decision.answer });
    }
    if (decision.kind === "clarify") {
      const pending: AgentPendingClarification = { question: decision.question, candidates: decision.candidates };
      return finish({ iteration, decision, durationMs }, "clarification", { pendingClarification: pending });
    }

    // --- tool_call ---
    const signature = `${decision.tool} ${stableStringify(decision.input)}`;
    const priorCalls = callCounts.get(signature) ?? 0;
    callCounts.set(signature, priorCalls + 1);
    if (priorCalls > bounds.maxIdenticalRetries) {
      return finish({ iteration, decision, durationMs }, "repeated_tool_call");
    }

    const tool = params.registry.get(decision.tool);
    if (tool && workbookReads + tool.readCost > bounds.maxWorkbookReads) {
      return finish({ iteration, decision, durationMs }, "read_budget");
    }

    let observation: AgentObservation;
    if (!tool) {
      observation = { tool: decision.tool, ok: false, kind: "error", error: `unknown tool "${decision.tool}"` };
    } else {
      const validated = tool.validate(decision.input);
      if (!validated.ok) {
        observation = { tool: decision.tool, ok: false, kind: "error", error: validated.error };
      } else {
        const toolCtx: AgentToolContext = { deps: params.deps, language, priorResults: [...observations] };
        try {
          observation = await tool.execute(validated.value, toolCtx);
        } catch (error) {
          observation = { tool: decision.tool, ok: false, kind: "error", error: error instanceof Error ? error.message : String(error) };
        }
        if (observation.ok) workbookReads += tool.readCost;
      }
    }

    observation = clampObservation(observation, bounds);
    if (observation.ok && observation.kind === "table" && observation.columns && observation.rows) {
      resultSeq += 1;
      const resultId = `${params.taskId}-r${resultSeq}`;
      observation = { ...observation, resultId };
      referencedResultIds.push(resultId);
    }
    observations.push(observation);
    carryOn({ iteration, decision, observation, durationMs });
  }
}

// --- observability (dev/test only; decisions + actions + results, no reasoning) ---

export interface AgentStepTrace {
  readonly iteration: number;
  readonly decision: "tool_call" | "clarify" | "final" | "invalid";
  readonly tool?: string;
  readonly resolvedTarget?: string;
  readonly observationCells: number;
  readonly ok?: boolean;
  readonly durationMs: number;
}

export interface AgentRunTrace {
  readonly taskId: string;
  readonly steps: readonly AgentStepTrace[];
  readonly modelCalls: number;
  readonly workbookReads: number;
  readonly terminationReason?: AgentTerminationReason;
  readonly status: AgentLoopState["status"];
}

export function summariseAgentRun(state: AgentLoopState): AgentRunTrace {
  return {
    taskId: state.taskId,
    modelCalls: state.modelCalls,
    workbookReads: state.workbookReads,
    ...(state.terminationReason ? { terminationReason: state.terminationReason } : {}),
    status: state.status,
    steps: state.steps.map((step) => ({
      iteration: step.iteration,
      decision: step.decision.kind,
      ...(step.decision.kind === "tool_call" ? { tool: step.decision.tool } : {}),
      ...(step.observation?.source ? { resolvedTarget: step.observation.source } : {}),
      observationCells: step.observation ? observationCellCount(step.observation) : 0,
      ...(step.observation ? { ok: step.observation.ok } : {}),
      durationMs: step.durationMs,
    })),
  };
}

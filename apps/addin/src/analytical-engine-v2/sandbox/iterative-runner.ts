import type { AnalysisRunner, AnalysisRunOutcome } from "../planner/planner-loop.js";
import type { ResultStore } from "../results/result-store.js";
import type { AnalyzeDecision } from "../types.js";
import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import { EMPTY_ANALYTICAL_STATE, type AnalyticalConversationState } from "../state/conversation-state.js";
import { buildAgentToolContext } from "../capability/agent-tools.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import { buildDataset } from "./dataset.js";
import type { SandboxDataset } from "./types.js";
import { hashCode } from "./executor.js";
import { storeSandboxResult } from "./result-adapter.js";
import { planFromDecision, type AnalysisCapability } from "./analysis-runner.js";
import { buildAgentMessages, extractDecision } from "./analysis-agent-prompt.js";
import {
  renderAgentTrace,
  runAnalysisAgent,
  type AgentMetrics,
  type AgentStepRecord,
  type DeterministicTool,
  type SessionRuntime,
  type ToolInvoker,
} from "./analysis-agent.js";
import type { CodeMessage } from "./code-generator.js";

/** What the iterative runner needs beyond the one-shot capability. */
export interface IterativeCapability extends AnalysisCapability {
  /** One bounded decision call — wired by the caller to the chat client. */
  readonly decideStep: (messages: readonly CodeMessage[]) => Promise<string>;
  readonly tools?: readonly DeterministicTool[];
  readonly invokeTool?: ToolInvoker;
  /** §36 — the debug trace, handed over whole. Never shown in normal UI (§37). */
  readonly onTrace?: (trace: { readonly text: string; readonly steps: readonly AgentStepRecord[]; readonly metrics: AgentMetrics }) => void;
  /** §47 — one metrics record per analytical turn. */
  readonly onMetrics?: (metrics: AgentMetrics) => void;
}

export interface IterativeRunnerParams {
  readonly capability: IterativeCapability;
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  /** §4 — the user's own words, which the plan's objective is not. */
  readonly request: () => string;
  readonly state?: () => AnalyticalConversationState;
}

/** Does this runtime support the session API at all? */
export function supportsSessions(runtime: unknown): runtime is SessionRuntime {
  const candidate = runtime as Partial<SessionRuntime> | null;
  return (
    typeof candidate?.step === "function" &&
    typeof candidate.look === "function" &&
    typeof candidate.finish === "function" &&
    typeof candidate.endSession === "function"
  );
}

let sessionCounter = 0;

export function createIterativeRunner(params: IterativeRunnerParams): AnalysisRunner {
  const { capability, schema, grids } = params;
  // §9/§11 — one dataset per turn, prepared once, exactly as the one-shot
  // runner does it. Two analyses in one turn must not disagree about the data.
  let cached: SandboxDataset | null = null;

  return async (decision: AnalyzeDecision, store: ResultStore, signal?: AbortSignal): Promise<AnalysisRunOutcome> => {
    const started = Date.now();
    const bail = (code: string, message: string, attempts = 0): AnalysisRunOutcome => ({ ok: false, code, message, attempts, durationMs: Date.now() - started });

    if (!supportsSessions(capability.runtime)) {
      return bail("SANDBOX_UNAVAILABLE", "the analytical runtime on this host does not support iterative analysis");
    }
    if (!cached) {
      const built = buildDataset({ schema, grids });
      if (!built.ok) return bail(built.error.code, built.error.message);
      cached = built.dataset;
    }
    const dataset = cached;
    const plan = planFromDecision(decision, dataset.datasetId);
    sessionCounter += 1;
    const sessionId = `turn_${Date.now().toString(36)}_${sessionCounter}`;

    const toolContext = buildAgentToolContext({
      schema,
      grids,
      store,
      state: params.state?.() ?? EMPTY_ANALYTICAL_STATE,
      decision,
      sandbox: true,
    });

    const outcome = await runAnalysisAgent({
      runtime: capability.runtime,
      sessionId,
      request: params.request(),
      plan,
      dataset,
      currentSourceVersion: capability.currentSourceVersion ?? (() => schema.sourceVersion),
      ...(capability.limits ? { limits: capability.limits } : {}),
      tools: capability.tools ?? toolContext.tools,
      invokeTool: capability.invokeTool ?? toolContext.invokeTool,
      availableCapabilities: toolContext.availableCapabilities,
      discover: toolContext.discover,
      sandboxAvailable: true,
      ...(signal ? { signal } : {}),
      decide: async (context) => extractDecision(String(await capability.decideStep(buildAgentMessages(context)))),
      onStep: (record) => {
        // §71 of Stage 27 — every attempt is reported, failures included, so
        // the existing attempt trace keeps working over the iterative path.
        if (record.action !== "EXECUTE_CODE" || record.code === undefined) return;
        capability.onAttempt?.({
          attempt: record.stepId,
          code: record.code,
          codeHash: hashCode(record.code),
          ok: record.observation.status === "ok",
          ...(record.observation.error
            ? { error: { code: "INVALID_RESULT" as const, message: `${record.observation.error.type}: ${record.observation.error.message}` } }
            : {}),
          durationMs: record.observation.elapsedMs,
        });
      },
    });

    capability.onMetrics?.(outcome.metrics);
    capability.onTrace?.({ text: renderAgentTrace(params.request(), outcome.trace, outcome), steps: outcome.trace, metrics: outcome.metrics });

    if (outcome.status === "clarify") {
      // §24 — the existing suspended-state lifecycle owns this. The runner
      // does not open a second clarification memory; it reports the question
      // through the code the planner already has for one.
      return bail("CLARIFICATION_REQUIRED", outcome.question, outcome.metrics.codeExecutions);
    }

    if (outcome.status === "failed") {
      return bail(outcome.error.code, outcome.error.message, outcome.metrics.codeExecutions);
    }

    if (outcome.status === "partial") {
      // §22 — completed work is named, and so is what is missing. It is NOT
      // reported as an answer.
      const missing = outcome.missing.length > 0 ? outcome.missing.join("; ") : "part of the requested analysis";
      const did = outcome.completed.length > 0 ? ` What it did produce: ${outcome.completed.join(", ")}.` : "";
      return bail("INVALID_RESULT", `${outcome.reason}: ${missing}.${did}`, outcome.metrics.codeExecutions);
    }

    const code = outcome.trace
      .filter((step) => step.code !== undefined)
      .map((step) => step.code)
      .join(String.fromCharCode(10, 10));
    const stored = storeSandboxResult({
      store,
      plan,
      result: outcome.result,
      code,
      codeHash: hashCode(code),
      attempts: outcome.metrics.codeExecutions,
      // §19 — the agent said which results answer the question.
      primaryRefs: outcome.primaryResultRefs,
    });

    return {
      ok: true,
      stored: stored.all,
      primary: stored.primary,
      method: { ...stored.method, necessity: decision.necessity ?? "OTHER", objective: decision.objective },
      attempts: outcome.metrics.codeExecutions,
      durationMs: outcome.metrics.totalMs,
    };
  };
}

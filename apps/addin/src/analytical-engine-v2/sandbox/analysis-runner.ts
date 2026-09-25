import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import type { AnalysisRunner, AnalysisRunOutcome } from "../planner/planner-loop.js";
import type { ResultStore } from "../results/result-store.js";
import type { AnalyzeDecision } from "../types.js";
import { buildCodeMessages, extractCode, type CodeMessage } from "./code-generator.js";
import { buildDataset } from "./dataset.js";
import { executeAnalysis, hashCode, type AnalyticalRuntime, type AttemptRecord } from "./executor.js";
import { storeSandboxResult } from "./result-adapter.js";
import type { SandboxDataset, SandboxLimits, SandboxPlan } from "./types.js";
import type { ExecutionProgress, TimingRecorder } from "../production/execution-progress.js";

export interface AnalysisCapability {
  readonly runtime: AnalyticalRuntime;
  /** One bounded code-generation call — wired by the caller to the chat client. */
  readonly generateCode: (messages: readonly CodeMessage[]) => Promise<string>;
  readonly limits?: SandboxLimits;
  /** §69 — the workbook version NOW. Defaults to the schema's, for tests. */
  readonly currentSourceVersion?: () => string;
  /** §71 — every attempt, including the ones that failed. */
  readonly onAttempt?: (record: AttemptRecord) => void;
  readonly onProgress?: ExecutionProgress;
  readonly timings?: TimingRecorder;
}

export interface AnalysisRunnerParams {
  readonly capability: AnalysisCapability;
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
}

/** §13 — a planner decision, restated as the contract the executor enforces. */
export function planFromDecision(decision: AnalyzeDecision, datasetId: string): SandboxPlan {
  return {
    objective: decision.objective,
    datasetRefs: [datasetId],
    requestedOutputs: decision.requestedOutputs.map((o) => ({ id: o.id, description: o.description, shape: o.shape })),
    ...(decision.assumptions && decision.assumptions.length > 0 ? { assumptions: decision.assumptions } : {}),
    ...(decision.methods && decision.methods.length > 0 ? { methodConstraints: decision.methods } : {}),
    ...(decision.exploration && decision.exploration.length > 0 ? { explorationDimensions: decision.exploration } : {}),
  };
}

/**
 * §12 — a runtime that cannot bound CPU-bound code never receives generated
 * code. The check lives at the point of use so it cannot be bypassed by
 * constructing the runner differently.
 */
function unusableRuntime(runtime: AnalyticalRuntime): string | null {
  return runtime.hardTimeout ? null : "the analytical runtime on this host cannot bound the time an analysis takes, so generated code is not run";
}

export function createAnalysisRunner(params: AnalysisRunnerParams): AnalysisRunner {
  const { capability, schema, grids } = params;
  // §9/§11 — one dataset per turn, prepared once. Rebuilding it per analysis
  // would let two analyses in one turn disagree about the data.
  let cached: SandboxDataset | null = null;

  return async (decision: AnalyzeDecision, store: ResultStore, signal?: AbortSignal): Promise<AnalysisRunOutcome> => {
    const started = Date.now();
    const bail = (code: string, message: string, attempts = 0): AnalysisRunOutcome => ({ ok: false, code, message, attempts, durationMs: Date.now() - started });

    const unusable = unusableRuntime(capability.runtime);
    if (unusable) {
      capability.onProgress?.({ kind: "sandbox_unavailable", reason: unusable });
      return bail("SANDBOX_UNAVAILABLE", unusable);
    }

    capability.onProgress?.({ kind: "sandbox_required" });
    const bootStarted = Date.now();
    try {
      await capability.runtime.ready?.();
      capability.onProgress?.({ kind: "sandbox_ready", durationMs: Date.now() - bootStarted });
    } catch (err) {
      const diagnostics = capability.runtime.startupDiagnostics?.() ?? [];
      capability.onProgress?.({
        kind: "sandbox_unavailable",
        reason: String(err),
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      });
      return bail("SANDBOX_UNAVAILABLE", `the analytical runtime did not start: ${String(err)}`);
    }

    if (!cached) {
      const built = buildDataset({ schema, grids });
      if (!built.ok) return bail(built.error.code, built.error.message);
      cached = built.dataset;
    }
    const dataset = cached;
    const plan = planFromDecision(decision, dataset.datasetId);

    let lastCode = "";
    const outcome = await executeAnalysis({
      runtime: capability.runtime,
      plan,
      dataset,
      ...(capability.limits ? { limits: capability.limits } : {}),
      ...(signal ? { signal } : {}),
      ...(capability.onProgress ? { onProgress: capability.onProgress } : {}),
      ...(capability.timings
        ? {
            onPhase: (phase: "generation" | "execution", ms: number) => {
              if (phase === "generation") capability.timings?.addCodeGeneration(ms);
              else capability.timings?.addSandbox(ms);
            },
          }
        : {}),
      currentSourceVersion: capability.currentSourceVersion ?? (() => schema.sourceVersion),
      onAttempt: (record) => {
        lastCode = record.code;
        capability.onAttempt?.(record);
      },
      generate: async (request) => {
        const raw = await capability.generateCode(buildCodeMessages(request));
        return extractCode(String(raw));
      },
    });

    if (!outcome.ok) {
      // §67 — reported, never replaced. The planner loop turns this into a
      // terminated turn rather than letting the analysis be approximated.
      return { ok: false, code: outcome.error.code, message: outcome.error.message, attempts: outcome.attempts, durationMs: outcome.durationMs };
    }

    const code = outcome.code || lastCode;
    const stored = storeSandboxResult({
      store,
      plan,
      result: outcome.result,
      code,
      codeHash: hashCode(code),
      attempts: outcome.attempts,
    });

    return {
      ok: true,
      stored: stored.all,
      primary: stored.primary,
      method: { ...stored.method, necessity: decision.necessity ?? "OTHER", objective: decision.objective },
      attempts: outcome.attempts,
      durationMs: outcome.durationMs,
    };
  };
}

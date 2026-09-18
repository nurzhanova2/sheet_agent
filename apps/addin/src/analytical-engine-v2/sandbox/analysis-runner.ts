// ---------------------------------------------------------------------------
// Stage 27 §4/§5/§13/§32/§34 — the bridge between a planner decision and code.
//
// The planner says WHAT the analysis must establish; this assembles the rest:
// it prepares the dataset the sandbox is allowed to see (§9), turns the
// decision into a SandboxPlan (§13), runs the generate–execute–repair loop
// (§66), and stores whatever came back as ordinary engine results so the
// planner can keep working with them (§32/§34).
//
// It decides nothing analytical. There is no place here where a failed
// analysis becomes a different analysis, no place where a missing output is
// filled in from a tool, and no place where an objective is rewritten — those
// are exactly the substitutions §5 exists to forbid, and the way to keep them
// out is to give this layer nothing to substitute WITH.
// ---------------------------------------------------------------------------

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

export interface AnalysisCapability {
  readonly runtime: AnalyticalRuntime;
  /** One bounded code-generation call — wired by the caller to the chat client. */
  readonly generateCode: (messages: readonly CodeMessage[]) => Promise<string>;
  readonly limits?: SandboxLimits;
  /** §69 — the workbook version NOW. Defaults to the schema's, for tests. */
  readonly currentSourceVersion?: () => string;
  /** §71 — every attempt, including the ones that failed. */
  readonly onAttempt?: (record: AttemptRecord) => void;
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
    if (unusable) return bail("SANDBOX_UNAVAILABLE", unusable);

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

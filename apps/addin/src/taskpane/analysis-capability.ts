import type { AnalysisCapability } from "../analytical-engine-v2/sandbox/analysis-runner.js";
import type { AttemptRecord } from "../analytical-engine-v2/sandbox/executor.js";
import type { AgentMetrics } from "../analytical-engine-v2/sandbox/analysis-agent.js";
import { createSandboxRuntime, isProductionSafe, type SandboxRuntimeChoice } from "../analytical-engine-v2/sandbox/runtime-factory.js";

type Messages = readonly { readonly role: "system" | "user"; readonly content: string }[];

export interface AnalysisCapabilityParams {
  /** One bounded code-generation call, already bound to the model and signal. */
  readonly generateCode: (messages: Messages) => Promise<string>;
  /**
   * Stage 27.2A §2 — one bounded DECISION call, for the iterative loop.
   *
   * Separate from `generateCode` even though both end at the same model. They
   * are different generation roles with different temperatures, and a decision
   * that is not valid JSON has a different remedy (§16) from code that does
   * not run. Wiring them to one function would hide that distinction at the
   * only layer that can still act on it.
   *
   * Optional: without it the engine runs the one-shot path, which is the
   * correct behaviour for a host that has not opted in.
   */
  readonly decideStep?: (messages: Messages) => Promise<string>;
  /** §69 — the workbook version NOW, read at the moment it matters. */
  readonly currentSourceVersion: () => string;
  /** §71 — every attempt, including the ones that failed. */
  readonly onAttempt?: (record: AttemptRecord) => void;
  /** §36 — the iterative trace, for the debug surface only. */
  readonly onTrace?: (trace: { readonly text: string; readonly metrics: AgentMetrics }) => void;
}

let cached: SandboxRuntimeChoice | null = null;

/**
 * The session's sandbox runtime, built once.
 *
 * Returns the choice even when it is not production-safe, so the caller can
 * report WHY rather than only that nothing happened.
 */
export function sandboxRuntime(): SandboxRuntimeChoice {
  cached ??= createSandboxRuntime();
  return cached;
}

/**
 * §4 — the capability to hand `runAnalyticalEngine`, or nothing.
 *
 * `undefined` is a real answer and the engine handles it: the planner is never
 * told the sandbox exists, and a request that needs one is refused with a
 * capability error instead of being approximated (§5).
 */
export function analysisCapability(params: AnalysisCapabilityParams): AnalysisCapability | undefined {
  const choice = sandboxRuntime();
  if (!isProductionSafe(choice)) return undefined;
  return {
    runtime: choice.runtime,
    generateCode: params.generateCode,
    currentSourceVersion: params.currentSourceVersion,
    ...(params.decideStep ? { decideStep: params.decideStep } : {}),
    ...(params.onAttempt ? { onAttempt: params.onAttempt } : {}),
    ...(params.onTrace ? { onTrace: params.onTrace } : {}),
  };
}

/** Test seam: forget the cached runtime so a fresh one is built. */
export function resetSandboxRuntime(): void {
  cached = null;
}

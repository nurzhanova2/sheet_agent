export interface SandboxOutputSummary {
  readonly tables: number;
  readonly scalars: number;
  readonly series: number;
  readonly groups: number;
  readonly models: number;
  readonly findings: number;
}

export interface SandboxDiagnostic {
  readonly label: string;
  readonly value: string;
}

export type ExecutionEvent =
  | { readonly kind: "workbook_read"; readonly sheet: string; readonly range: string }
  | { readonly kind: "planning" }
  | { readonly kind: "tool_call"; readonly tool: string }
  | { readonly kind: "sandbox_required" }
  | { readonly kind: "sandbox_ready"; readonly durationMs: number }
  | { readonly kind: "sandbox_unavailable"; readonly reason: string; readonly diagnostics?: readonly SandboxDiagnostic[] }
  | { readonly kind: "code_generating"; readonly attempt: number }
  | { readonly kind: "code_generated"; readonly attempt: number; readonly code: string }
  | { readonly kind: "code_running"; readonly attempt: number }
  | { readonly kind: "code_succeeded"; readonly attempt: number; readonly durationMs: number; readonly produced: SandboxOutputSummary }
  | {
      readonly kind: "code_failed";
      readonly attempt: number;
      readonly durationMs: number;
      readonly errorType: string;
      readonly errorMessage: string;
      readonly retrying: boolean;
    }
  | { readonly kind: "verifying" }
  | { readonly kind: "composing" }
  | { readonly kind: "rewriting" };

export type ExecutionProgress = (event: ExecutionEvent) => void;

export interface ExecutionTimings {
  readonly totalMs: number;
  readonly plannerRounds: number;
  readonly plannerMs: number;
  readonly toolMs: number;
  readonly codeGenerationMs: number;
  readonly sandboxMs: number;
  readonly narrationMs: number;
  readonly verificationMs: number;
  readonly llmCallCount: number;
  readonly toolCallCount: number;
  readonly pythonExecutionCount: number;
}

export const EMPTY_TIMINGS: ExecutionTimings = {
  totalMs: 0,
  plannerRounds: 0,
  plannerMs: 0,
  toolMs: 0,
  codeGenerationMs: 0,
  sandboxMs: 0,
  narrationMs: 0,
  verificationMs: 0,
  llmCallCount: 0,
  toolCallCount: 0,
  pythonExecutionCount: 0,
};

export class TimingRecorder {
  #startedAt = Date.now();
  #planner = 0;
  #plannerRounds = 0;
  #tool = 0;
  #codeGeneration = 0;
  #sandbox = 0;
  #narration = 0;
  #verification = 0;
  #llmCalls = 0;
  #toolCalls = 0;
  #pythonRuns = 0;

  addPlanner(ms: number): void {
    this.#planner += ms;
    this.#llmCalls += 1;
    this.#plannerRounds += 1;
  }

  addTool(ms: number): void {
    this.#tool += ms;
    this.#toolCalls += 1;
  }

  addCodeGeneration(ms: number): void {
    this.#codeGeneration += ms;
    this.#llmCalls += 1;
  }

  addSandbox(ms: number): void {
    this.#sandbox += ms;
    this.#pythonRuns += 1;
  }

  addNarration(ms: number): void {
    this.#narration += ms;
    this.#llmCalls += 1;
  }

  addVerification(ms: number): void {
    this.#verification += ms;
  }

  snapshot(): ExecutionTimings {
    return {
      totalMs: Date.now() - this.#startedAt,
      plannerRounds: this.#plannerRounds,
      plannerMs: this.#planner,
      toolMs: this.#tool,
      codeGenerationMs: this.#codeGeneration,
      sandboxMs: this.#sandbox,
      narrationMs: this.#narration,
      verificationMs: this.#verification,
      llmCallCount: this.#llmCalls,
      toolCallCount: this.#toolCalls,
      pythonExecutionCount: this.#pythonRuns,
    };
  }
}

export function summarizeTimings(timings: ExecutionTimings): readonly string[] {
  const row = (label: string, ms: number): string => `${label.padEnd(12, ".")} ${(ms / 1000).toFixed(1)} s`;
  return [
    row("Total", timings.totalMs),
    row("Planner", timings.plannerMs),
    row("Tools", timings.toolMs),
    row("Code gen", timings.codeGenerationMs),
    row("Python", timings.sandboxMs),
    row("Verify", timings.verificationMs),
    row("Answer", timings.narrationMs),
    `Planner rounds: ${timings.plannerRounds}`,
    `LLM calls: ${timings.llmCallCount}`,
    `Tool calls: ${timings.toolCallCount}`,
    `Python runs: ${timings.pythonExecutionCount}`,
  ];
}

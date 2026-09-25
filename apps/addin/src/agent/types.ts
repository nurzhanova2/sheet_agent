import type { CellValue } from "@sheet-agent/application";
import type { AnalysisRequest } from "../analysis/types.js";
import type { AnalysisBatchOutcome } from "../analysis/index.js";
import type { SelectionSnapshot } from "../app/workbook-context.js";
import type { WorkbookMap } from "../app/commands/workbook-map.js";
import type { ChartData } from "../visualization/types.js";
import type { AgentTerminationReason } from "./bounds.js";

export type AgentLanguage = "en" | "ru";

// --- model decision -------------------------------------------------------

export type AgentDecision =
  | { readonly kind: "tool_call"; readonly tool: string; readonly input: Readonly<Record<string, unknown>> }
  | { readonly kind: "clarify"; readonly question: string; readonly candidates: readonly string[] }
  | { readonly kind: "final"; readonly answer: string };

export type AgentDecisionKind = AgentDecision["kind"];

export type ParsedDecision =
  | { readonly ok: true; readonly decision: AgentDecision }
  | { readonly ok: false; readonly error: string };

// --- structured observation --------------------------------------------------

export type AgentObservationKind = "structure" | "table" | "scalar" | "text" | "chart" | "error";

/**
 * The ONLY thing a tool hands back to the model. Bounded, structured, and
 * provenance-carrying — never "here is some Excel data: …".
 */
export interface AgentObservation {
  readonly tool: string;
  readonly ok: boolean;
  readonly kind: AgentObservationKind;
  /** Source sheet / range / prior-result id the observation was computed from. */
  readonly source?: string;
  /** Deterministic operation label (e.g. `group_by Sector`). */
  readonly operation?: string;
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly CellValue[])[];
  /** True matched-row count (may exceed `rows.length` after clamping). */
  readonly rowCount?: number;
  readonly truncated?: boolean;
  readonly value?: number | string | boolean | null;
  /** One-line human note — safe to show in concise activity, no internal terms. */
  readonly note?: string;
  readonly error?: string;
  /**
   * Set by the loop when a tool produced a reusable table. A later
   * `describe_result` / `chart_result` / transform references it by this id.
   */
  readonly resultId?: string;
  /**
   * Stage 24.4.3 — the prior result id(s) this observation was computed from
   * (result-local tools: `derive_metric`, `compare_results`, result-path
   * `top_n` / `sort_rows` / …). Carried into `ResultRef` lineage on persistence.
   */
  readonly derivedFrom?: readonly string[];
  /**
   * Stage 24.4.4 — the source range's freshness token when this observation read
   * ONE worksheet range (`sourceVersionOf`). Enables a safe staleness check
   * before an agent result is used for a workbook mutation.
   */
  readonly sourceVersion?: string;
  /** Stage 24.4.4 — freshness tokens when the observation read MULTIPLE ranges (e.g. `compare_aggregates`). */
  readonly sourceVersions?: readonly { readonly sourceRange: string; readonly version: string }[];
  /** Present only for a successful `chart_result`. */
  readonly chart?: ChartData;
}

// --- tool registry ------------------------------------------------------------

export interface AgentToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly mutating: false;
  /** Workbook reads this tool consumes from the task budget. */
  readonly readCost: number;
}

export type ToolInputResult<I> = { readonly ok: true; readonly value: I } | { readonly ok: false; readonly error: string };

export interface AgentToolContext {
  readonly deps: AgentToolDeps;
  readonly language: AgentLanguage;
  /** Successful table observations produced so far this task (for result-referencing tools). */
  readonly priorResults: readonly AgentObservation[];
}

export interface AgentTool<I = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly mutating: false;
  readonly readCost: number;
  /** Fail-closed input validation → a typed input or a concise error. */
  validate(input: Readonly<Record<string, unknown>>): ToolInputResult<I>;
  execute(input: I, ctx: AgentToolContext): Promise<AgentObservation>;
}

export interface AgentToolRegistry {
  get(name: string): AgentTool | undefined;
  list(): readonly AgentTool[];
  names(): readonly string[];
  schemas(): readonly AgentToolSchema[];
}

// --- dependencies (injected; no Office.js / import cycle here) ---------------

export type SheetSnapshotResult =
  | { readonly kind: "ok"; readonly snapshot: SelectionSnapshot }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "not_found"; readonly reference: string }
  | { readonly kind: "error"; readonly error: string };

/** A reusable table extracted from an observation — the shape chart / transform helpers need. */
export interface AgentResultLike {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
}

export type ChartBuildResult =
  | { readonly kind: "chart"; readonly chart: ChartData }
  | { readonly kind: "clarify"; readonly question: string; readonly candidates: readonly string[] }
  | { readonly kind: "error"; readonly error: string };

export interface AgentToolDeps {
  /** Bounded structural picture of the whole workbook (Stage 23 Workbook Map). */
  workbookMap(): Promise<WorkbookMap | { readonly error: string }>;
  /** Resolve a sheet reference deterministically and return a bounded snapshot. */
  sheetSnapshot(reference: string): Promise<SheetSnapshotResult>;
  /** Read an explicit sheet-qualified A1 address as a bounded snapshot. */
  rangeSnapshot(address: string): Promise<SheetSnapshotResult>;
  /** Run ONE deterministic analysis request over a snapshot (wraps `runAnalysisBatch`). */
  analyze(snapshot: SelectionSnapshot, request: AnalysisRequest): AnalysisBatchOutcome;
  /** Build ChartData from a reusable table (wraps `resultToChartData`). */
  chartFromResult(ref: AgentResultLike, language: AgentLanguage, columns?: readonly string[]): ChartBuildResult;
}

// --- loop state -------------------------------------------------------------

export type AgentLoopStatus = "running" | "done" | "awaiting_clarification" | "terminated";

export interface AgentStep {
  readonly iteration: number;
  readonly decision: AgentDecision | { readonly kind: "invalid"; readonly error: string };
  readonly observation?: AgentObservation;
  readonly durationMs: number;
}

export interface AgentPendingClarification {
  readonly question: string;
  readonly candidates: readonly string[];
}

export interface AgentLoopState {
  readonly taskId: string;
  readonly originalUserRequest: string;
  readonly language: AgentLanguage;
  readonly steps: readonly AgentStep[];
  readonly observations: readonly AgentObservation[];
  /** resultIds the loop created and the model may still reference. */
  readonly referencedResultIds: readonly string[];
  readonly workbookReads: number;
  readonly modelCalls: number;
  readonly status: AgentLoopStatus;
  /** Set once the loop reaches a terminal state. */
  readonly terminationReason?: AgentTerminationReason;
  readonly pendingClarification?: AgentPendingClarification;
  readonly finalAnswer?: string;
}

export interface AgentDecisionContext {
  readonly originalUserRequest: string;
  readonly language: AgentLanguage;
  readonly workbookContext: string;
  readonly toolSchemas: readonly AgentToolSchema[];
  readonly observations: readonly AgentObservation[];
  readonly iteration: number;
  readonly remainingSteps: number;
  readonly remainingReads: number;
}

/**
 * Stage 24.4 §7 — resume a clarified agent task. The loop pre-loads the prior
 * `observations` / `steps` / budgets from `state` and injects `answer` as a
 * synthetic observation before the first new decision. Budgets do NOT reset.
 */
export interface AgentResume {
  readonly state: AgentLoopState;
  readonly answer: string;
}

/**
 * Everything the production `decide` transport (`ChatClient.decideAgentStep`)
 * needs for ONE bounded decision. Prompt assembly keeps these sections strictly
 * separated (system / user request / tools / workbook data / observations).
 */
export interface AgentDecisionRequest {
  readonly originalUserRequest: string;
  readonly language: AgentLanguage;
  readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  /** Bounded, plain-text workbook picture. UNTRUSTED DATA — never instructions. */
  readonly workbookContext: string;
  readonly toolSchemas: readonly AgentToolSchema[];
  readonly observations: readonly AgentObservation[];
  readonly iteration: number;
  readonly remainingSteps: number;
  readonly remainingReads: number;
  readonly model?: string;
}

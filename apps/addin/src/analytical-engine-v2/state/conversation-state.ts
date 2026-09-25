import type { CellValue } from "@sheet-agent/application";
import type { EngineResult } from "../types.js";
import type { AnsweredClarification } from "./clarification-loop.js";

/** §7 — the table the analytical conversation is about. */
export interface TableRef {
  readonly sheetName: string;
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/**
 * Stage 26.7 §7 — where a stored reference CAME FROM. Carried on every
 * reference the engine commits, so a follow-up can be checked for freshness
 * and compatibility against the thing that actually produced it rather than
 * against whatever happens to be selected now.
 *
 * The field is optional in the TYPE so a scripted test may hand-build a
 * minimal state, but `commitState` always populates it and a regression test
 * asserts that every reference in a COMMITTED state carries it.
 */
export interface RefLineage {
  readonly resultId: string;
  readonly tool: string;
  readonly type: EngineResult["type"];
  readonly parents: readonly string[];
  readonly sheetName: string;
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/** Stage 26.7 §6 — the semantic kind of a stored reference. */
export type ReferenceKind =
  | "result"
  | "metric"
  | "metricSet"
  | "period"
  | "periodRange"
  | "series"
  | "event"
  | "analysis";

/** §8 — "его" / "этот показатель". */
export interface MetricRef {
  readonly metricKey: string;
  readonly lineage?: RefLineage;
}

/** §8 — "из них" / "эти показатели". */
export interface MetricSetRefV2 {
  readonly metricKeys: readonly string[];
  readonly fromResultId: string;
  readonly lineage?: RefLineage;
}

/** §8 — "за тот же период". A point has no `endCanonical`. */
export interface PeriodRefV2 {
  readonly startCanonical: string;
  readonly endCanonical?: string;
  readonly lineage?: RefLineage;
}

/**
 * Stage 26.7 §6 — a SPAN, kept apart from a point. The two were one optional
 * field, which made "за тот же период" and "за тот же интервал" indis-
 * tinguishable to anything downstream.
 */
export interface PeriodRangeRefV2 {
  readonly startCanonical: string;
  readonly endCanonical: string;
  readonly lineage?: RefLineage;
}

/** Stage 26.7 §6/§25 — "покажи его динамику" answered once already. */
export interface SeriesRefV2 {
  readonly metricKey: string;
  readonly periodCanonicals: readonly string[];
  readonly lineage?: RefLineage;
}

/**
 * Stage 26.7 §6/§26 — the shape of the last analytical operation, so a
 * follow-up can continue on the SAME basis instead of silently re-choosing
 * one. Structured facts only; never a natural-language interpretation.
 */
export interface AnalysisRefV2 {
  readonly kind: EngineResult["type"];
  readonly tool: string;
  readonly rankingField?: string;
  readonly rankingMagnitude?: boolean;
  readonly basis?: string;
  readonly metricKeys: readonly string[];
  readonly lineage?: RefLineage;
}

/** §8 — "когда именно?". */
export interface EventRefV2 {
  readonly metricKey: string;
  readonly startCanonical: string;
  readonly endCanonical: string;
  readonly startValue: number;
  readonly endValue: number;
  readonly absoluteChange: number;
  readonly percentageChange: number | null;
  readonly lineage?: RefLineage;
}

/** §8 — "повтори" / "из них": the previous turn's structured result, whole. */
export interface StoredResultRef {
  readonly resultId: string;
  readonly tool: string;
  readonly type: EngineResult["type"];
  readonly fields: EngineResult["fields"];
  readonly rows: readonly (readonly CellValue[])[];
  readonly metricKeys: readonly string[];
  readonly periodCanonicals: readonly string[];
  readonly sourceRange: string;
  readonly sourceVersion: string;
  /** Stage 26.7 §7 — lineage back to the result this snapshot froze. */
  readonly parents?: readonly string[];
  /** Stage 26.7 §27 — was this the turn's ANSWER, or evidence for it? */
  readonly role?: "primary" | "supporting";
}

/**
 * Stage 26.7 §9/§55 — how many results a turn carries forward. A follow-up
 * reaches back a step or two; it does not mine an unbounded history, and an
 * unbounded list would grow the planner's context without bound.
 */
export const MAX_RECENT_RESULTS = 8;

export interface AnalyticalConversationState {
  readonly tableRef?: TableRef;
  /** §27 — the result the last turn NAMED as its answer. */
  readonly lastResult?: StoredResultRef;
  /**
   * Stage 26.7 §9/§27 — the last turn's results, primary first, then its
   * supporting results, then earlier turns', bounded to MAX_RECENT_RESULTS.
   * Deterministic recency ordering, so "предыдущий результат" never means a
   * search through arbitrary history.
   */
  readonly recentResults?: readonly StoredResultRef[];
  readonly lastMetric?: MetricRef;
  readonly lastMetricSet?: MetricSetRefV2;
  readonly lastPeriod?: PeriodRefV2;
  readonly lastPeriodRange?: PeriodRangeRefV2;
  readonly lastSeries?: SeriesRefV2;
  readonly lastEvent?: EventRefV2;
  readonly lastAnalysis?: AnalysisRefV2;
  readonly turnId: string;
  readonly workbookFreshnessToken?: string;
  /** Stage 26.7 §29 — work paused on a clarification, waiting for an answer. */
  readonly suspended?: SuspendedPlannerState;
}

/**
 * Stage 26.7 §29/§30 — everything a clarified turn needs to RESUME rather than
 * restart. It holds the planner's own artefacts (its request, its plan, the
 * results it already computed) and the freshness token they were computed
 * against; §32 refuses to resume across a table that has moved on.
 *
 * It holds no interpretation of the user's answer: §31's "20%" means something
 * only inside this state, and what it means is the planner's to decide.
 */
export interface SuspendedPlannerState {
  readonly turnId: string;
  readonly request: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly results: readonly StoredResultRef[];
  readonly declaredOutputs: readonly { readonly id: string; readonly description: string }[];
  readonly primaryOutputId?: string;
  /**
   * Stage 26.8 §28/§30 — clarifications of THIS task the user has already
   * answered, with their answers. Carried so a planner that asks the same
   * thing again can be told it already has the answer, and so the answer
   * survives a second clarification round instead of being spent on one.
   */
  readonly answered?: readonly AnsweredClarification[];
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

export const EMPTY_ANALYTICAL_STATE: AnalyticalConversationState = { turnId: "" };

/**
 * Stage 26.8 §30 — drop a suspended task while keeping everything else.
 *
 * Stage 26.7 §33 named "an unrelated question" as one of the exits from a
 * suspension but left no way to take it: `resumableSuspension` checks the table
 * and the version, and a task pane's next message is neither. This is that exit
 * — the analytical memory survives, only the waiting question does not.
 */
export function withoutSuspension(state: AnalyticalConversationState): AnalyticalConversationState {
  if (!state.suspended) return state;
  const next = { ...state };
  delete (next as { suspended?: unknown }).suspended;
  return next;
}

/**
 * §41 — a reference is stale when the table it was computed over has moved on.
 * Deliberately NOT invalidated by a narrator fallback, a clarification round
 * trip, or a repeated identical request — those are the exact false positives
 * Stage 25.1.3d/f had to chase down.
 */
export function isStale(state: AnalyticalConversationState, currentSourceVersion: string): boolean {
  return Boolean(state.lastResult) && state.lastResult!.sourceVersion !== currentSourceVersion;
}

/** Drops every workbook-derived reference while keeping the table identity. */
export function invalidateStale(state: AnalyticalConversationState, currentSourceVersion: string): AnalyticalConversationState {
  if (!isStale(state, currentSourceVersion)) return state;
  return { turnId: state.turnId, ...(state.tableRef ? { tableRef: state.tableRef } : {}), workbookFreshnessToken: currentSourceVersion };
}

/** Freezes a live engine result into the cross-turn snapshot shape. */
export function storeResult(result: EngineResult): StoredResultRef {
  return {
    resultId: result.resultId,
    tool: result.tool,
    type: result.type,
    fields: result.fields,
    rows: result.rows,
    metricKeys: result.metricKeys,
    periodCanonicals: result.periodCanonicals,
    sourceRange: result.sourceRange,
    sourceVersion: result.sourceVersion,
  };
}

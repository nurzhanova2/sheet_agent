import type { SelectionSnapshot } from "../app/workbook-context.js";
import { buildDataset } from "./dataset.js";
import { runAnalysis } from "./engine.js";
import { formatAnalysisOutcome } from "./format.js";
import { deriveVerifiedFacts, renderVerifiedFacts, type VerifiedFact } from "./facts.js";
import { ANALYSIS_LIMITS, isAnalysisError, type AnalysisError, type AnalysisOutcome, type AnalysisRequest } from "./types.js";

export { buildDataset, excelSerialToISO, isDateNumberFormat } from "./dataset.js";
export { runAnalysis } from "./engine.js";
export { validateAnalysisRequest } from "./validate.js";
export { resolveColumn } from "./expression.js";
export { formatAnalysisOutcome } from "./format.js";
export { canonicalizeAnalysisRequest, canonicalizeExpression, canonicalKey, stableStringify } from "./canonical.js";
export {
  deriveVerifiedFacts,
  renderVerifiedFacts,
  validateClaimsAgainstFacts,
  factMetricLabel,
  type VerifiedFact,
} from "./facts.js";
export {
  projectCompoundFacts,
  type FactProjection,
  type ProjectedMetric,
  type ProjectedConclusion,
  type ProjectedFailure,
} from "./fact-projection.js";
export {
  COMPOUND_LIMITS,
  parseCompoundPlan,
  isCompoundPlanError,
  looksCompound,
  looksIntentCompound,
  parseGoalIntents,
  compileGoalIntents,
  synthesizeCompoundIntents,
  synthesizeChartIntent,
  intentChartToRequest,
  extractFirstJsonObject,
  isCompoundRequest,
  extractRequirements,
  checkCoverage,
  prepareCompoundExecution,
  initGoalOutcomes,
  finalizeAnalyticalGoals,
  resolveDependentGoals,
  summarize,
  renderGoalStatus,
  type AnalysisGoal,
  type CompoundPlan,
  type CompoundPlanError,
  type CompoundGoalOutcome,
  type CompoundExecutionSummary,
  type PreparedExecution,
  type GoalIntent,
  type RequirementSet,
  type RequirementCondition,
  type RequirementConditionOp,
} from "./compound.js";
export * from "./types.js";

export interface RejectedOperation {
  /** 0-based position of the request in the batch. */
  readonly index: number;
  readonly code: AnalysisError["code"] | "LIMIT_EXCEEDED";
  readonly error: string;
}

export interface AnalysisBatchOutcome {
  readonly outcomes: readonly AnalysisOutcome[];
  /** Compact text block to hand back to the model. */
  readonly text: string;
  /** Concise activity titles, one per request, for the transcript. */
  readonly activityTitles: readonly string[];
  /** Number of requests actually executed (after applying the per-turn cap). */
  readonly opsRun: number;
  readonly anyError: boolean;
  /**
   * Fail-closed status of the batch:
   *  - "complete": every requested operation produced a result;
   *  - "partial":  at least one, but not all, operations were rejected;
   *  - "failed":   every executed operation was rejected (nothing to ground an answer on).
   * The final answer generator must never reconstruct a rejected result itself.
   */
  readonly status: "complete" | "partial" | "failed";
  readonly rejected: readonly RejectedOperation[];
  /**
   * Deterministic VerifiedFacts derived from the successful results (Stage 21.2.2).
   * Every number / share / ratio / ranking / comparison the final answer is
   * allowed to state must already appear here.
   */
  readonly facts: readonly VerifiedFact[];
  /** The VERIFIED FACTS text block for the answer model (empty when there are no facts). */
  readonly factsText: string;
}

/** Bilingual activity titles. Workbook identifiers (column names) stay verbatim. */
type ActivityLang = "en" | "ru";

function activityTitle(request: AnalysisRequest, language: ActivityLang = "en"): string {
  const ru = language === "ru";
  switch (request.op) {
    case "count":
      return ru ? "Подсчёт строк" : "Counting rows";
    case "aggregate":
      return ru ? `Расчёт: ${request.metric}` : `Calculating ${request.metric}`;
    case "filter":
      return ru ? "Фильтрация строк" : "Filtering rows";
    case "sort":
      return ru
        ? `Сортировка по ${request.direction === "asc" ? "возрастанию" : "убыванию"}`
        : `Sorting ${request.direction === "asc" ? "ascending" : "descending"}`;
    case "top_n":
      return ru ? `Топ ${request.n}` : `Ranking top ${request.n}`;
    case "bottom_n":
      return ru ? `Последние ${request.n}` : `Ranking bottom ${request.n}`;
    case "distinct":
      return ru ? `Уникальные значения ${request.column}` : `Listing distinct ${request.column}`;
    case "group_by":
      return ru ? `Группировка по ${request.by.join(" × ")}` : `Grouping by ${request.by.join(" × ")}`;
    case "summary_statistics":
      return ru ? "Сводная статистика" : "Summary statistics";
    case "correlation":
      return ru ? "Расчёт корреляции" : "Calculating correlation";
    case "group_correlation":
      return ru ? `Корреляция по ${request.by.join(" × ")}` : `Correlation by ${request.by.join(" × ")}`;
    case "outliers":
      return ru ? `Поиск выбросов (${request.method})` : `Detecting outliers (${request.method})`;
  }
}

/**
 * Runs a batch of untrusted analysis requests against a SelectionSnapshot, entirely
 * locally. Enforces the per-turn operation cap. Never mutates the workbook.
 */
export function runAnalysisBatch(
  snapshot: SelectionSnapshot,
  requests: readonly unknown[],
  opsAlreadyUsed = 0,
  language: ActivityLang = "en",
): AnalysisBatchOutcome {
  const ru = language === "ru";
  const dataset = buildDataset(snapshot);
  const limited = requests.slice(0, Math.max(0, ANALYSIS_LIMITS.maxOpsPerTurn - opsAlreadyUsed));
  const outcomes: AnalysisOutcome[] = [];
  const activityTitles: string[] = [];
  const rejected: RejectedOperation[] = [];

  for (const [index, request] of limited.entries()) {
    if ("error" in dataset) {
      outcomes.push(dataset);
      activityTitles.push(ru ? "Анализ недоступен" : "Analysis unavailable");
      rejected.push({ index, code: dataset.code, error: dataset.error });
      continue;
    }
    const outcome = runAnalysis(dataset, request as AnalysisRequest);
    outcomes.push(outcome);
    if (isAnalysisError(outcome)) {
      activityTitles.push(ru ? "Запрос на анализ отклонён" : "Rejected analysis request");
      rejected.push({ index, code: outcome.code, error: outcome.error });
    } else {
      activityTitles.push(activityTitle(request as AnalysisRequest, language));
    }
  }

  if (requests.length > limited.length) {
    const error = `Only ${limited.length} of ${requests.length} analysis requests were run (max ${ANALYSIS_LIMITS.maxOpsPerTurn} per turn).`;
    outcomes.push({ code: "LIMIT_EXCEEDED", error });
    activityTitles.push(ru ? "Достигнут лимит операций анализа" : "Analysis limit reached");
    rejected.push({ index: limited.length, code: "LIMIT_EXCEEDED", error });
  }

  const status: AnalysisBatchOutcome["status"] =
    rejected.length === 0 ? "complete" : limited.length > 0 && rejected.filter((r) => r.index < limited.length).length >= limited.length ? "failed" : "partial";

  const resultText = outcomes.map((outcome, index) => formatAnalysisOutcome(index, requests[index], outcome)).join("\n\n");
  const text = status === "complete" ? resultText : `${executionStatusBlock(status, limited.length, rejected)}\n\n${resultText}`;

  const facts = deriveVerifiedFacts(outcomes, requests);
  const factsText = renderVerifiedFacts(facts);

  return { outcomes, text, activityTitles, opsRun: limited.length, anyError: outcomes.some(isAnalysisError), status, rejected, facts, factsText };
}

/** Fail-closed banner prepended to the model-facing block whenever an operation was rejected. */
function executionStatusBlock(status: "partial" | "failed", executed: number, rejected: readonly RejectedOperation[]): string {
  const lines = rejected.map((entry) => `- operation #${entry.index + 1} [${entry.code}]: ${entry.error}`);
  return [
    `EXECUTION STATUS: ${status.toUpperCase()} — ${rejected.length} of ${executed} requested operation(s) could not be executed.`,
    "You MUST NOT compute a rejected result yourself, from the DATA block or otherwise. If the user needs a rejected figure, state plainly that it could not be calculated from this selection.",
    "REJECTED OPERATIONS:",
    ...lines,
  ].join("\n");
}

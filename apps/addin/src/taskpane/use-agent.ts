import { useCallback, useMemo, useRef, useState } from "react";
import type { CellValue, ExcelPort, ExcelMutationPort } from "@sheet-agent/application";
import type { ChatClient, ChatStreamHandlers } from "../app/chat-client.js";
import { boundedHistory, type ConversationMessage } from "../app/conversation.js";
import { readAddressSnapshot, readSelectionSnapshot, type SelectionSnapshot } from "../app/workbook-context.js";
import { applyAction, undoChange, type AppliedChange } from "../app/workbook-actions.js";
import { isAnalysisError, runAnalysisBatch } from "../analysis/index.js";
import { gridFromGroupOutcome } from "../analysis/group-grid.js";
import { runVisualization } from "../visualization/index.js";
import { detectLanguage, uiText, type ResponseLanguage } from "../app/language.js";
import { pluralCount, t } from "../app/i18n.js";
import { columnIndexToLetters, parseLocalRange, splitSheetAddress } from "../app/a1.js";
import { resolveSlashSubmission } from "../app/commands/parse.js";
import { slashNeedsWorkbookMap, slashPrompt } from "../app/commands/resolve.js";
import { buildWorkbookMap, type WorkbookMap } from "../app/commands/workbook-map.js";
import { resolveSheet } from "../app/commands/workbook-resolver.js";
import { createAgentToolRegistry } from "../agent/tool-registry.js";
import { runAgentLoop } from "../agent/agent-loop.js";
import { agentEvidenceFacts, validateAgentAnswer } from "../agent/evidence.js";
import type { AgentLoopState, AgentObservation, AgentStep } from "../agent/types.js";
import { createProductionAgentDeps } from "../app/agent-deps.js";
import { classifyAgentEligibility } from "../app/agent-eligibility.js";
import {
  buildAgentClarification,
  buildChartColumnsClarification,
  buildColumnClarification,
  buildDatasetClarification,
  buildEntityActionClarification,
  buildReferenceClarification,
  buildAnalysisPeriodClarification,
  buildAnalysisSubjectClarification,
  buildSchemaNormClarification,
  buildSchemaThresholdClarification,
  clearClarification,
  emptySessionMemory,
  forgetChartPlacement,
  forgetSheet,
  interpretClarificationAnswer,
  isUndoPhrase,
  projectMemoryForModel,
  rememberAnalyticalTable,
  rememberChart,
  rememberComposite,
  rememberDerivedResult,
  rememberDirectionChange,
  rememberEvent,
  rememberMetricFocus,
  rememberMetricSet,
  rememberPeriod,
  rememberRanking,
  rememberResult,
  rememberResultSet,
  rememberRowSet,
  resolveReference,
  setClarification,
} from "../app/conversation-memory.js";
import type { PendingClarification, ResultKind, ResultRef, RowSetRef, SessionMemory } from "../app/session-memory.js";
import { hasWorkbookDeixis, isConceptQuestion, isExtremeQuestion, isMutationRequest, isTransformRequest, routeTurn } from "../app/conversation-route.js";
import { revalidateSource, revalidateSources, sourceVersionOf } from "../app/source-freshness.js";
import { formatDisplayCell } from "../app/format-cell.js";
import { detectResultAction, type ResultActionIntent } from "../app/result-action-intent.js";
import { groundEntitiesToRows } from "../app/entity-grounding.js";
import { extractEntitySet, mentionsConversationalReference, resolveActionReference, type EntitySet } from "../app/entity-reference.js";
import { DEFAULT_HIGHLIGHT_COLOR, parseHighlightColor } from "../app/highlight-color.js";
import { detectGroupedRanking, planGroupedRanking } from "../app/grouped-ranking.js";
import { induceTableSchema, type TableSchema } from "../app/schema/schema-induction.js";
import { detectSchemaIntent, runSchemaAnalysis } from "../app/schema/schema-result.js";
import { runAnalyticalAnalysis, type AnalyticalTrace } from "../app/schema/analytical/analytical-analysis.js";
import type { InheritedComposite, InheritedMetricSet, InheritedRanking } from "../app/schema/analytical/analytical-compiler.js";
import { detectAnalyticalIntent } from "../app/schema/analytical/analytical-intent.js";
import { buildMetricIndex, resolveMetric } from "../app/schema/analytical/metric-resolver.js";
import { buildPeriodIndex } from "../app/schema/analytical/period-index.js";
import type { InheritedPeriod } from "../app/schema/analytical/period-resolver.js";
import { getPointValue } from "../app/schema/analytical/temporal-series.js";
import { detectEventFollowup } from "../app/event-followup.js";
import { detectDirectionPeriodsFollowup, detectResultSetFollowup } from "../app/resultset-followup.js";
import { classifyIntent } from "../app/intent.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import { runAnalyticalPlanner, type AnalyticalPlannerOutcome } from "../analytics-agent/runtime.js";
import { analyticalPlannerEnabled } from "../analytics-agent/feature-flag.js";
import type { AnalyticalInherited } from "../analytics-agent/tool-registry.js";
import {
  COMPOUND_AWARE_OPERATIONS,
  countAnalyticalClauses,
  detectOperationKind,
  detectRequestedRankingBasis,
  detectTemporalMode,
  explicitCandidateSet,
  extractRequestedCardinality,
  hasSecondAnalyticalClause,
  isAnalyticalFollowUp,
  isExploratoryRequest,
} from "../analytics-agent/semantic-frame.js";
import { commitPlannerOutputs } from "../analytics-agent/canonical-refs.js";
import { containsForbiddenLeak } from "../analytics-agent/narrator.js";
import { BUILD_INFO, buildInfoLine } from "../app/build-info.js";
// ----- Stage 26.8: the unified analytical engine, in production -------------
import { runAnalyticalEngine } from "../analytical-engine-v2/engine.js";
import { analysisCapability } from "./analysis-capability.js";
import { unifiedAnalyticalEngineV2Enabled, unifiedAnalyticalEngineV2FlagSource } from "../analytical-engine-v2/feature-flag.js";
import { classifyTurnOwner } from "../analytical-engine-v2/production/turn-owner.js";
import { beginTurn, finishTurn, recordAnalyticalExecution, turnLedger } from "../analytical-engine-v2/production/turn-ledger.js";
import {
  containsInternalLeak,
  fallbackNote,
  failureMessage as v2FailureMessage,
  leakReplacement,
  provenanceLine,
  sandboxFailureMessage,
} from "../analytical-engine-v2/production/answer-ux.js";
import { EMPTY_ANALYTICAL_STATE, withoutSuspension, type AnalyticalConversationState } from "../analytical-engine-v2/state/conversation-state.js";
import { getAnalyticalTraces, renderTrace } from "../analytical-engine-v2/debug/analytical-trace.js";
import { getAgentTraces, recordAgentTrace, renderAgentTraces } from "../analytical-engine-v2/debug/agent-trace.js";
import { analyticalAgentLoopEnabled, analyticalAgentLoopFlagSource } from "../analytical-engine-v2/feature-flag.js";
import { commitTrace, getResultActionTraces, type MutableResultActionTrace, type ResultActionTrace } from "../app/result-action-trace.js";
import { commonNumericColumns, planCrossSheetComparison } from "../app/cross-sheet-compare.js";
import { buildCompareReport, isCompareError } from "../app/commands/compare.js";
import { resultToChartData } from "../app/result-to-chart.js";
import {
  buildCopyRowSetActions,
  buildHighlightRowSetActions,
  buildWriteResultActions,
  isCompileError,
} from "../app/result-actions.js";
import type { WorkflowStep } from "../app/agent-session.js";
import {
  applyResultTransform,
  detectResultTransform,
  isTransformError,
  rankRequestCount,
  type TransformDetection,
} from "../app/result-transforms.js";
import type { ChartInsertDims } from "./components/ChartCard.js";
import { formatSeconds, nextId, type ActivityStatus, type ExecutionDetail, type TranscriptEntry, type UndoableChange } from "../app/agent-session.js";
import { summarizeTimings, type ExecutionEvent, type ExecutionTimings } from "../analytical-engine-v2/production/execution-progress.js";
import { completionLabel, executionMetrics, progressStepFor, pythonSummaryLabel, stoppedLabel } from "../analytical-engine-v2/production/progress-labels.js";

export interface UseAgentOptions {
  readonly chatClient: ChatClient;
  readonly port: ExcelPort & ExcelMutationPort;
  readonly model?: string;
}

/** Local A1 cell one column to the right of the selection's last column, at its top row. */
export function anchorRightOfSelection(address: string): string {
  try {
    const range = parseLocalRange(address);
    return `${columnIndexToLetters(range.end.column + 1)}${range.start.row + 1}`;
  } catch {
    return "A1";
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Stage 24.8 §27–§29 — true when `cellAddress` (a single-cell selection) lies
 *  on the SAME sheet and inside the bounds of `rangeAddress`. */
function cellWithinRange(cellAddress: string, rangeAddress: string): boolean {
  try {
    const c = splitSheetAddress(cellAddress);
    const r = splitSheetAddress(rangeAddress);
    if ((c.sheetName || "").toLowerCase() !== (r.sheetName || "").toLowerCase()) return false;
    const cp = parseLocalRange(c.localAddress || cellAddress);
    const rp = parseLocalRange(r.localAddress || rangeAddress);
    const cRow = cp.start.row;
    const cCol = cp.start.column;
    return (
      cRow >= rp.start.row &&
      cRow <= rp.start.row + rp.rowCount - 1 &&
      cCol >= rp.start.column &&
      cCol <= rp.start.column + rp.columnCount - 1
    );
  } catch {
    return false;
  }
}

/**
 * 24.4 — a compact, plain-text picture of the workbook for the agent decision
 * model. Untrusted DATA (never an instruction). Bounded to 40 sheets.
 */
export function buildAgentWorkbookContext(map: WorkbookMap | null, selection: SelectionSnapshot | undefined): string {
  const lines: string[] = [];
  if (selection) {
    lines.push(
      `Current selection: ${selection.address} (${selection.totalRowCount} rows × ${selection.totalColumnCount} cols)` +
        (selection.headers && selection.headers.length > 0 ? `, headers: ${selection.headers.join(", ")}` : ""),
    );
  }
  if (map) {
    lines.push(`Workbook has ${map.sheets.length} worksheet(s):`);
    for (const s of map.sheets.slice(0, 40)) {
      lines.push(
        `- "${s.name}": ${s.dataRowCount} data rows × ${s.columnCount} cols` +
          (s.headers.length > 0 ? `, columns: ${s.headers.join(", ")}` : ", columns not read"),
      );
    }
    if (map.activeSheet) lines.push(`Active sheet: "${map.activeSheet}".`);
  } else if (!selection) {
    lines.push("No workbook structure is available.");
  }
  return lines.join("\n");
}

/**
 * 24.4.4 §7/§11 — every leaf worksheet range read in a result's lineage, with
 * its freshness token, so a later mutation on the result can be refused if any
 * source changed. Walks `derivedFrom` over the loop's observations.
 */
export function collectAgentSourceVersions(
  primary: AgentObservation,
  observations: readonly AgentObservation[],
): { readonly sourceRange: string; readonly version: string }[] {
  const byId = new Map(observations.filter((o) => o.resultId).map((o) => [o.resultId!, o]));
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (obs: AgentObservation | undefined): void => {
    if (!obs) return;
    if (obs.resultId && seen.has(obs.resultId)) return;
    if (obs.resultId) seen.add(obs.resultId);
    if (obs.sourceVersion && obs.source && obs.source.includes("!")) out.set(obs.source, obs.sourceVersion);
    for (const v of obs.sourceVersions ?? []) out.set(v.sourceRange, v.version);
    for (const parentId of obs.derivedFrom ?? []) visit(byId.get(parentId));
  };
  visit(primary);
  return [...out].map(([sourceRange, version]) => ({ sourceRange, version }));
}

/** 24.4 §14 — a concise, user-facing activity line for one agent step. No tool names / ids / JSON / budgets. */
export function agentActivityLabel(step: AgentStep, language: ResponseLanguage, seen: Set<string>): string | null {
  if (step.decision.kind !== "tool_call") return null;
  const ru = language === "ru";
  let phrase: string;
  switch (step.decision.tool) {
    case "workbook_overview":
    case "list_sheets":
    case "inspect_table":
    case "find_column":
      phrase = ru ? "Изучаю книгу" : "Inspecting workbook";
      break;
    case "read_range":
      phrase = ru ? "Читаю данные" : "Reading data";
      break;
    case "group_by":
      phrase = ru ? "Группирую данные" : "Grouping the data";
      break;
    case "compare_aggregates":
    case "compare_results":
      phrase = ru ? "Считаю изменения" : "Calculating changes";
      break;
    case "derive_metric":
      phrase = ru ? "Считаю изменения" : "Calculating changes";
      break;
    case "top_n":
    case "sort_rows":
      phrase = ru ? "Ранжирую" : "Ranking";
      break;
    case "filter_rows":
      phrase = ru ? "Фильтрую строки" : "Filtering rows";
      break;
    case "chart_result":
      phrase = ru ? "Готовлю график" : "Preparing a chart";
      break;
    default:
      phrase = ru ? "Анализирую" : "Analysing";
      break;
  }
  if (seen.has(phrase)) return null;
  seen.add(phrase);
  return phrase;
}

// Stage 24.5.1 §3 — defence-in-depth: a model-only answer must never claim a
// workbook mutation happened. When a turn had mutation intent but produced no
// validated action / proposal, any "highlighted / copied / updated / выделил …"
// wording in the answer is replaced with a fail-closed message.
const MUTATION_SUCCESS_RE =
  /(?:вы[дy]елил|выделен[аоы]?\b|выделены|подсветил|закрасил|отмет(?:ил|ил и)|скопирова(?:л|н[аоы]?)|записал|вписал|добавил\s+формул|обновил\s+(?:ячей|диапазон|значени)|изменил\s+диапазон|залил|проставил\s+заливк)|\b(?:highlighted|shaded|marked|filled|colou?red|copied|wrote|written|updated the|inserted the formula|applied the (?:fill|highlight|formula))\b/i;

export function guardMutationClaim(
  answer: string,
  language: ResponseLanguage,
  mutationIntent: boolean,
  producedAction: boolean,
): string {
  if (!mutationIntent || producedAction) return answer;
  if (!MUTATION_SUCCESS_RE.test(answer)) return answer;
  return language === "ru"
    ? "Я не меняю книгу без подтверждённого действия. Скажите, что и где выделить или записать, и я подготовлю изменение с предпросмотром."
    : "I don't change the workbook without a confirmed action. Tell me exactly what to highlight or write and I'll prepare a change with a Preview.";
}

/** Compact GitHub-flavoured markdown table for a derived result grid. */
function renderGridMarkdown(columns: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const head = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, 50)
    // 24.4.4 §14 — display formatting only; the ResultRef keeps exact values.
    .map((row) => `| ${columns.map((_, c) => formatDisplayCell((row[c] ?? null) as CellValue)).join(" | ")} |`)
    .join("\n");
  return body ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`;
}

// Stage 24.5 §22 — a superlative in the SAME turn ("выдели самого проблемного
// менеджера красным") narrows an entity set to the extreme row(s) BEFORE
// grounding. Pure; reads only the retained result grid.
const SUPERLATIVE_MIN_RE =
  /проблемн|отстающ|худш|наимень|минимальн|слаб|нарушител|\bworst\b|most\s+problematic|under[-\s]?performing|\blowest\b|\bweakest\b/i;
const SUPERLATIVE_MAX_RE = /\bлучш|наибол|максимальн|сильн|\bbest\b|\bhighest\b|\bstrongest\b/i;
const SUPERLATIVE_N_RE = /\b(?:top|bottom)\s+(\d{1,3})\b|топ[-\s]?(\d{1,3})/i;

function cellNumber(v: CellValue): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9eE.,+-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function reduceEntitySetBySuperlative(
  ref: Pick<ResultRef, "columns" | "rows">,
  entitySet: Extract<EntitySet, { kind: "set" }>,
  text: string,
): { readonly column: string; readonly values: readonly CellValue[] } {
  const min = SUPERLATIVE_MIN_RE.test(text);
  const max = SUPERLATIVE_MAX_RE.test(text);
  const nM = SUPERLATIVE_N_RE.exec(text);
  if (!min && !max && !nM) return { column: entitySet.column, values: entitySet.values };
  const entIdx = ref.columns.indexOf(entitySet.column);
  if (entIdx < 0) return { column: entitySet.column, values: entitySet.values };
  const numericCols = ref.columns
    .map((_, c) => c)
    .filter((c) => {
      let nums = 0;
      let total = 0;
      for (const row of ref.rows) {
        const v = row[c];
        if (v === null || v === undefined || v === "") continue;
        total += 1;
        if (cellNumber(v) !== null) nums += 1;
      }
      return total > 0 && nums / total >= 0.6;
    });
  const byCol = numericCols[numericCols.length - 1];
  if (byCol === undefined) return { column: entitySet.column, values: entitySet.values };
  const sorted = [...ref.rows].sort((a, b) => (cellNumber(a[byCol] ?? null) ?? 0) - (cellNumber(b[byCol] ?? null) ?? 0));
  const ordered = max && !min ? [...sorted].reverse() : sorted; // "problematic"/"worst" ⇒ ascending
  const n = nM ? Math.max(1, Number(nM[1] ?? nM[2])) : 1;
  const picked = ordered
    .slice(0, n)
    .map((r) => r[entIdx] ?? null)
    .filter((v) => v !== null && v !== "");
  return { column: entitySet.column, values: picked.length > 0 ? picked : entitySet.values };
}

/**
 * 24.3.2 — a compact, non-user-facing view of the conversational memory after a
 * turn. For tests / dev diagnostics ONLY: it proves the exact `SessionMemory`
 * state (canonical result, lineage, transform metadata) that a follow-up will
 * act on. It is never rendered in the production task pane.
 */
export interface SessionMemoryDebug {
  readonly recentResults: readonly {
    readonly id: string;
    readonly columns: readonly string[];
    readonly rowCount: number;
    readonly rows: readonly (readonly unknown[])[];
    readonly source: string;
    readonly kind: string;
    readonly derivedFromResultId?: string;
    readonly derivedFromResultIds?: readonly string[];
    readonly sourceVersions?: readonly { readonly sourceRange: string; readonly version: string }[];
    readonly transform?: unknown;
    readonly entityColumn?: string;
    readonly entityValues?: readonly unknown[];
  }[];
  readonly lastResultId?: string;
  readonly lastRowSetId?: string;
  readonly lastRowSet?: {
    readonly describe: string;
    readonly count: number;
    readonly sheetRows: readonly number[];
    readonly sourceRange: string;
    readonly fromResultId?: string;
  };
  readonly lastChartId?: string;
  readonly pendingClarificationKind?: string;
  /** Stage 24.5.2 §1 — the running bundle identity. */
  readonly build?: { readonly appVersion: string; readonly buildId: string; readonly gitCommit: string; readonly stage: string };
  /** Stage 24.5.2 §2 — the most recent result-action runtime trace. */
  readonly lastResultActionTrace?: ResultActionTrace;
  /** Stage 24.8 §11/§30/§31 — the most recent explicit-interval ranking. */
  readonly lastRankingRef?: { readonly startCanonical: string; readonly endCanonical: string; readonly limit?: number };
  /** Stage 24.8 §12–§14 — the most recent two-interval predicate analysis. */
  readonly lastCompositeRef?: {
    readonly interval1: { readonly startCanonical: string; readonly endCanonical: string };
    readonly interval2: { readonly startCanonical: string; readonly endCanonical: string };
  };
  /** Stage 24.8 §17–§21 — the most recent adjacent-period-change event. */
  readonly lastEventRef?: {
    readonly metricKey: string;
    readonly startCanonical: string;
    readonly endCanonical: string;
    readonly startHeaderPath: string;
    readonly endHeaderPath: string;
    readonly absoluteChange: number;
    readonly percentageChange: number | null;
  };
  /** Stage 24.8 §27–§29 — the last table an analytical query ran against. */
  readonly lastAnalyticalTable?: { readonly sheetName: string; readonly sourceRange: string };
  /** Stage 24.9 — the most recent superlative direction-change winner. */
  readonly lastDirectionChangeRef?: { readonly metricKey: string; readonly directionChangeCount: number; readonly events: number };
  /** Stage 24.9 — the most recent explicit / reused multi-metric candidate set. */
  readonly lastMetricSetRef?: { readonly metricKeys: readonly string[]; readonly origin: string };
  /** Stage 24.9 — the most recent ordered ranking-shaped result. */
  readonly lastResultSetRef?: { readonly operation: string; readonly rows: readonly { readonly key: string; readonly score: number }[] };
  /** Stage 25.1.3f §3/§20 — the standing analytical continuation universe:
   *  which operation produced it, its filterable fields, its metric universe
   *  and its size. Observability only — never surfaced to the user. */
  readonly lastAnalyticalResultSetRef?: {
    readonly operation: string;
    readonly columns: readonly string[];
    readonly metricKeys: readonly string[];
    readonly rowCount: number;
  };
  /** Stage 24.9 §29/§37 — the metric currently "in focus" for a bare pronoun. */
  readonly lastMetricFocusRef?: { readonly metricKey: string };
  /** Stage 25.1.2 §2/§3/§53 — the most recent FINAL executed comparison interval. */
  readonly lastPeriodRef?: { readonly startCanonical: string; readonly endCanonical?: string };
}

export interface AgentController {
  readonly entries: readonly TranscriptEntry[];
  readonly busy: boolean;
  readonly turnStartedAt: number | null;
  readonly undoStack: readonly UndoableChange[];
  readonly language: ResponseLanguage;
  submit(prompt: string): Promise<void>;
  approve(proposalId: string): Promise<void>;
  reject(proposalId: string): void;
  undoLast(): Promise<void>;
  insertChart(base64Png: string, suggestedName: string, dims?: ChartInsertDims): Promise<void>;
  reset(): void;
  /** Test / dev diagnostics only — see {@link SessionMemoryDebug}. */
  __sessionMemoryDebug(): SessionMemoryDebug;
}

export function useAgent({ chatClient, port, model }: UseAgentOptions): AgentController {
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const turnTimingsRef = useRef<ExecutionTimings | null>(null);
  const recordTurnTimings = useCallback((timings: ExecutionTimings) => {
    turnTimingsRef.current = timings;
  }, []);
  const [undoStack, setUndoStack] = useState<readonly UndoableChange[]>([]);
  const [language, setLanguage] = useState<ResponseLanguage>("en");
  const conversationRef = useRef<ConversationMessage[]>([]);
  const selectionRef = useRef<SelectionSnapshot | undefined>(undefined);
  // Stage 24 — typed conversational memory. Prose history is NOT the canonical
  // representation of a previous analytical result; structured refs live here.
  const sessionMemoryRef = useRef<SessionMemory>(emptySessionMemory());
  // Stage 26.8 §12/§13 — the ONE V2 analytical conversation state, held for
  // the life of a chat session and reset with it. Deliberately separate from
  // SessionMemory: two engines, two memories, no accidental sharing.
  const analyticalStateRef = useRef<AnalyticalConversationState>(EMPTY_ANALYTICAL_STATE);
  // §21 — a turn in flight, and the sequence number that makes a cancelled
  // one unable to append its answer afterwards.
  const v2AbortRef = useRef<AbortController | null>(null);
  const turnSeqRef = useRef(0);

  const append = useCallback((entry: TranscriptEntry) => setEntries((current) => [...current, entry]), []);
  const setActivity = useCallback((id: string, status: ActivityStatus, detail?: string, durationMs?: number) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === id && entry.kind === "activity"
          ? { ...entry, status, ...(detail !== undefined ? { detail } : {}), ...(durationMs !== undefined ? { durationMs } : {}) }
          : entry,
      ),
    );
  }, []);
  const appendDelta = useCallback((id: string, delta: string) => {
    setEntries((current) =>
      current.map((entry) => (entry.id === id && entry.kind === "response" ? { ...entry, text: entry.text + delta } : entry)),
    );
  }, []);
  const finishResponse = useCallback((id: string, text?: string) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === id && entry.kind === "response"
          ? { ...entry, streaming: false, ...(text !== undefined ? { text } : {}) }
          : entry,
      ),
    );
  }, []);
  const resetResponse = useCallback((id: string) => {
    setEntries((current) => current.map((entry) => (entry.id === id && entry.kind === "response" ? { ...entry, text: "" } : entry)));
  }, []);

  const undoLast = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last || busy) return;
    setBusy(true);
    try {
      if (last.kind === "cells") {
        // Revert every internal action of the transaction, newest first.
        for (const change of [...last.changes].reverse()) await undoChange(port, change);
      } else if (last.kind === "sheet") {
        // Stage 23 — remove ONLY the worksheet SheetAgent created.
        await port.deleteWorksheet(last.sheetName);
      } else if (last.kind === "workflow") {
        // Stage 24.11 — reverse execution order: undo cells steps newest-first,
        // then delete any worksheet the workflow created (last).
        for (const step of [...last.steps].reverse()) {
          if (step.kind === "cells") {
            for (const change of [...step.changes].reverse()) await undoChange(port, change);
          } else {
            await port.deleteWorksheet(step.name);
          }
        }
      } else {
        await port.deleteShape(last.sheetName, last.shapeName);
      }
      setUndoStack((current) => current.slice(0, -1));
      // Stage 24 — reconcile SessionMemory + conversation history so a later turn
      // never claims a reverted workbook object still exists.
      if (last.kind === "sheet") sessionMemoryRef.current = forgetSheet(sessionMemoryRef.current, last.sheetName);
      if (last.kind === "shape") sessionMemoryRef.current = forgetChartPlacement(sessionMemoryRef.current, last.shapeName);
      if (last.kind === "workflow") {
        const created = last.steps.find((s): s is { kind: "create_sheet"; name: string } => s.kind === "create_sheet");
        if (created) sessionMemoryRef.current = forgetSheet(sessionMemoryRef.current, created.name);
      }
      conversationRef.current = [
        ...conversationRef.current,
        {
          role: "assistant",
          content:
            language === "ru"
              ? `(Изменение «${last.label}» отменено — его больше нет в книге.)`
              : `(The change "${last.label}" was undone and is no longer in the workbook.)`,
        },
      ];
      append({ kind: "activity", id: nextId("act"), activity: "completed", title: t(language, "ua.reverted", { label: last.label }), status: "done" });
    } catch (error) {
      append({ kind: "notice", id: nextId("ntc"), tone: "error", text: `${language === "ru" ? "Не удалось отменить" : "Undo failed"}: ${error instanceof Error ? error.message : "unknown error"}` });
    } finally {
      setBusy(false);
    }
  }, [append, busy, language, port, undoStack]);

  const submit = useCallback(
    async (prompt: string) => {
      let text = prompt.trim();
      if (!text || busy) return;
      const lang = detectLanguage(text, language);

      // ----- Stage 24.5.2 §1/§18: developer-only build + trace inspector.
      // Not a registered slash command (kept out of /help); dev/manual-QA only.
      // §19 — the V2 developer surface. Not registered as a slash command (it
      // stays out of /help): owner, planner decisions, tools, result ids,
      // primary/supporting, references, table + freshness identity,
      // clarification state, serialization recovery and the narrator path —
      // none of which ever appears in a normal answer (§18).
      // §36 — the iterative loop's own surface. Matched BEFORE the engine
      // pattern below, which would otherwise swallow "analytical-agent".
      if (/^\/debug[\s-]?analytical[\s-]agent\s*$/i.test(text)) {
        setLanguage(lang);
        append({ kind: "command", id: nextId("cmd"), text });
        const body = [
          "```",
          buildInfoLine(),
          `iterative analytical loop: ${analyticalAgentLoopEnabled() ? "ON" : "OFF"}  (${analyticalAgentLoopFlagSource()})`,
          `decision transport: ${typeof chatClient.decideAnalysisStep === "function" ? "available" : "MISSING"}`,
          "",
          `AGENT TRACES (${getAgentTraces().length}, most recent last)`,
          renderAgentTraces(),
          "```",
        ].join(String.fromCharCode(10));
        append({ kind: "response", id: nextId("res"), streaming: false, text: body });
        return;
      }

      if (/^\/debug[\s-]?analytical(?:[\s-]engine)?\s*$/i.test(text)) {
        setLanguage(lang);
        append({ kind: "command", id: nextId("cmd"), text });
        const traces = getAnalyticalTraces();
        const ledger = turnLedger();
        const st = analyticalStateRef.current;
        const body = [
          "```",
          buildInfoLine(),
          `analytical engine v2: ${unifiedAnalyticalEngineV2Enabled() ? "ON" : "OFF"}  (${unifiedAnalyticalEngineV2FlagSource()})`,
          `planner transport: ${typeof chatClient.planAnalyticalTurn === "function" ? "available" : "MISSING"}`,
          "",
          "TURN OWNERSHIP (most recent last)",
          ledger.length === 0
            ? "  (no turns yet)"
            : ledger
                .map(
                  (e) =>
                    `  ${e.owner === "V2_OWNED" ? "V2 " : "V1 "} ${e.ownerReason.padEnd(24)} engines=[${e.engines.join(", ") || "none"}] outcome=${e.outcome ?? "-"}  ${JSON.stringify(e.request).slice(0, 60)}`,
                )
                .join("\n"),
          "",
          `V2 CONVERSATION STATE`,
          `  table: ${st.tableRef ? `${st.tableRef.sheetName}!${st.tableRef.sourceRange} @ ${st.tableRef.sourceVersion}` : "(none)"}`,
          `  suspended: ${st.suspended ? `"${st.suspended.question}" over ${st.suspended.results.length} result(s)` : "(none)"}`,
          `  recent: ${(st.recentResults ?? []).map((r) => `${r.tool}(${r.role ?? "primary"})`).join(", ") || "(none)"}`,
          "",
          "LAST TURN TIMING",
          ...(turnTimingsRef.current
            ? summarizeTimings(turnTimingsRef.current).map((line) => `  ${line}`)
            : ["  (no analytical turn yet)"]),
          "",
          `V2 TRACES (${traces.length}, most recent last)`,
          traces.length === 0 ? "  (none yet)" : traces.map((t2) => renderTrace(t2)).join("\n\n"),
          "```",
        ].join("\n");
        append({ kind: "response", id: nextId("res"), streaming: false, text: body });
        return;
      }

      if (/^\/debug(?:-context)?\s*$/i.test(text)) {
        setLanguage(lang);
        append({ kind: "command", id: nextId("cmd"), text });
        const m = sessionMemoryRef.current;
        const traces = getResultActionTraces();
        const body = [
          "```",
          buildInfoLine(),
          `bundle build: ${BUILD_INFO.buildId}   commit: ${BUILD_INFO.gitCommit}`,
          `analytical engine v2: ${unifiedAnalyticalEngineV2Enabled() ? "ON" : "OFF"}  (${unifiedAnalyticalEngineV2FlagSource()})`,
          "",
          `memory: results=${m.recentResults.length} lastResultId=${m.lastResultId ?? "-"} ` +
            `lastRowSet=${m.lastRowSet?.id ?? "-"} lastChart=${m.lastChart?.id ?? "-"} ` +
            `pending=${m.pendingClarification?.kind ?? "-"}`,
          m.recentResults.length > 0
            ? `last result: kind=${m.recentResults[m.recentResults.length - 1]!.kind} ` +
              `entityColumn=${m.recentResults[m.recentResults.length - 1]!.entityColumn ?? "-"} ` +
              `entityValues=${(m.recentResults[m.recentResults.length - 1]!.entityValues ?? []).length} ` +
              `source=${m.recentResults[m.recentResults.length - 1]!.sourceRange}`
            : "last result: (none)",
          "",
          `result-action traces (${traces.length}):`,
          traces.length === 0 ? "  (none yet)" : traces.map((t) => "  " + JSON.stringify(t)).join("\n"),
          "```",
        ].join("\n");
        append({ kind: "response", id: nextId("res"), streaming: false, text: body });
        return;
      }

      // Set when a clarification resume rewrote `text`: the raw reply was already
      // echoed, so the normal-path command echo must be skipped.
      let suppressCommandEcho = false;

      // Stage 24.5.2 §2 — bounded runtime trace for a result-action turn. Filled
      // as routing / grounding / action-building progress; flushed once.
      const raTrace: MutableResultActionTrace = { text, at: new Date().toISOString(), routeChosen: "result_action" };
      let raTraceActive = false;
      const commitRaTrace = (): void => {
        if (!raTraceActive) return;
        raTraceActive = false;
        commitTrace(raTrace);
      };

      // ----- Stage 24.2B: apply a deterministic transform of an earlier result
      const emitTransform = (
        ref: ResultRef,
        transform: Parameters<typeof applyResultTransform>[1],
        userMsg: string = text,
      ): void => {
        const applied = applyResultTransform(ref, transform);
        if (isTransformError(applied)) {
          append({
            kind: "response",
            id: nextId("res"),
            streaming: false,
            text:
              lang === "ru"
                ? `Не удалось преобразовать прошлый результат: ${applied.error}.`
                : `I couldn't reshape that earlier result — ${applied.error}.`,
          });
          return;
        }
        sessionMemoryRef.current = rememberDerivedResult(sessionMemoryRef.current, ref, applied);
        const body = `${applied.answer}\n\n${renderGridMarkdown(applied.columns, applied.rows)}`;
        append({ kind: "response", id: nextId("res"), text: body, streaming: false });
        conversationRef.current = [
          ...conversationRef.current,
          { role: "user", content: userMsg },
          { role: "assistant", content: body },
        ];
      };
      const findResult = (id: string | undefined): ResultRef | undefined =>
        id ? sessionMemoryRef.current.recentResults.find((r) => r.id === id) : undefined;
      // 24.5.3 — an "N <noun> with the worst/best <metric>" follow-up must reshape
      // the fullest compatible ancestor, not a 1-row "which is worst" result that
      // happens to be the most recent. Walk the derivedFrom lineage to the nearest
      // result with at least `minRows` rows; fall back to `start`.
      const resolveRankTarget = (start: ResultRef, minRows: number): ResultRef => {
        const seen = new Set<string>();
        let cur: ResultRef | undefined = start;
        while (cur && !seen.has(cur.id)) {
          if (cur.rows.length >= minRows) return cur;
          seen.add(cur.id);
          cur = cur.derivedFromResultId ? findResult(cur.derivedFromResultId) : undefined;
        }
        return start;
      };

      // ----- Stage 24.3A / 24.5 + 24.7–24.12: helpers ---------------------
      const say = (en: string, ru: string): void => {
        append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? ru : en });
      };
      const proposeActions = (n: number): void => {
        append({ kind: "activity", id: nextId("act"), activity: "waiting_for_approval", title: t(lang, "ua.awaitingApproval", { n }), status: "running" });
      };
      const safeBuildMap = async (): Promise<WorkbookMap | null> => {
        try {
          return await buildWorkbookMap(port);
        } catch {
          return null;
        }
      };
      // 24.4.4 §11 — freshness for a result that may derive from >1 worksheet.
      const resultIsFresh = async (ref: ResultRef): Promise<boolean> =>
        ref.sourceVersions && ref.sourceVersions.length > 0
          ? (await revalidateSources(port, ref.sourceVersions)) === "fresh"
          : (await revalidateSource(port, ref.sourceRange, ref.sourceVersion)) === "fresh";
      const overwriteNote = (cells: number): string =>
        cells > 0
          ? lang === "ru"
            ? ` ${cells} непустых ячеек будут перезаписаны.`
            : ` ${cells} non-empty cell(s) will be overwritten.`
          : "";
      const STALE_EN = "The source data has changed since that result was calculated. Please rerun the analysis before applying this change.";
      const STALE_RU = "Исходные данные изменились с момента расчёта этого результата. Повторите анализ перед применением изменения.";

      const runResultAction = async (action: ResultActionIntent): Promise<void> => {
        const m = sessionMemoryRef.current;
        const lastResult = m.recentResults.find((r) => r.id === m.lastResultId) ?? m.recentResults[m.recentResults.length - 1];
        const ref = resolveReference(text, m);
        const resolvedResult: ResultRef | undefined =
          ref.kind === "resolved" && ref.target.kind === "result" ? ref.target.ref : lastResult;

        if (action.kind === "chart") {
          if (!resolvedResult) {
            say("There's no active analytical result to chart yet. Run an analysis first.", "Пока нет активного результата анализа для построения графика. Сначала выполните анализ.");
            return;
          }
          // 24.3.2 — a single-value answer ("which one is worst?") is not itself a
          // useful chart; walk up its lineage to the table it was derived from.
          let chartRef = resolvedResult;
          const seenChartIds = new Set<string>();
          while (chartRef.kind === "scalar" && chartRef.derivedFromResultId && !seenChartIds.has(chartRef.id)) {
            seenChartIds.add(chartRef.id);
            const parent = findResult(chartRef.derivedFromResultId);
            if (!parent) break;
            chartRef = parent;
          }
          const outcome = resultToChartData(chartRef, lang);
          if (outcome.kind === "error") {
            say(`I can't chart that — ${outcome.error}.`, `Не получится построить график — ${outcome.error}.`);
            return;
          }
          if (outcome.kind === "clarify") {
            // 24.3.1 — a typed chart_columns clarification: a short answer resumes
            // THIS ResultRef → ChartData, never a fresh workbook query.
            sessionMemoryRef.current = setClarification(
              m,
              buildChartColumnsClarification(text, outcome.question, outcome.candidates, chartRef.id, lang),
            );
            append({ kind: "response", id: nextId("res"), streaming: false, text: outcome.question });
            return;
          }
          append({ kind: "chart", id: nextId("cht"), data: outcome.chart });
          sessionMemoryRef.current = rememberChart(sessionMemoryRef.current, { turnId: nextId("turn"), data: outcome.chart, fromResultId: chartRef.id });
          const line =
            lang === "ru"
              ? `Готово — график по результату «${chartRef.title}» показан в панели.`
              : `Here's a chart of "${chartRef.title}", shown in the panel.`;
          append({ kind: "response", id: nextId("res"), streaming: false, text: line });
          conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: line }];
          return;
        }

        if (action.kind === "insert_chart") {
          if (!m.lastChart) {
            say("There's no chart to insert right now.", "Сейчас нет графика для вставки.");
            return;
          }
          say(
            'The chart is shown in the panel — use "Insert into Excel" beneath it to place it in the workbook.',
            "График показан в панели. Нажмите «Вставить в Excel» под ним, чтобы разместить его в книге.",
          );
          return;
        }

        if (action.kind === "highlight" || action.kind === "copy") {
          const colour = parseHighlightColor(text);
          const colorHex = colour?.hex ?? DEFAULT_HIGHLIGHT_COLOR;
          const colourWordEn = colour ? ` ${colour.name}` : " yellow";
          const colourWordRu = colour
            ? ` ${({ red: "красным", yellow: "жёлтым", green: "зелёным" } as const)[colour.name]}`
            : " жёлтым";

          // 24.5 §3/§4 — resolve the conversational reference against COMPATIBLE
          // memory (a chart is never a highlight target); §5 — the live selection
          // is not consulted when a prior result exists.
          const aref = resolveActionReference(text, m, action.kind, lang === "ru" ? "ru" : "en");
          raTrace.resolvedReference = {
            kind: aref.kind,
            ...(aref.kind === "result" ? { resultId: aref.ref.id } : {}),
            ...(aref.kind === "result" && aref.ref.entityColumn ? { entityColumn: aref.ref.entityColumn } : {}),
            ...(aref.kind === "result" ? { entityValuesCount: (aref.ref.entityValues ?? []).length } : {}),
          };
          // 24.5.3 §14 — record every candidate referent (row set + recent
          // results) and which one won, so a manual tester can see the recency
          // decision (a newer compatible result superseding an older row set).
          {
            const rowSetOrder = m.lastRowSet?.order ?? -1;
            type TraceCandidate = NonNullable<ResultActionTrace["candidateReferences"]>[number];
            const cands: TraceCandidate[] = [];
            if (m.lastRowSet && m.lastRowSet.sheetRows.length > 0) {
              cands.push({
                kind: "rowset",
                id: m.lastRowSet.id,
                order: m.lastRowSet.order,
                entityCount: m.lastRowSet.count,
                compatible: true,
                ...(m.lastRowSet.fromResultId ? { fromResultId: m.lastRowSet.fromResultId } : {}),
              });
            }
            for (const r of m.recentResults) {
              const es = extractEntitySet(r);
              cands.push({
                kind: "result",
                id: r.id,
                order: r.order,
                ...(es.kind === "set" ? { entityCount: es.values.length } : {}),
                ...(r.derivedFromResultId ? { fromResultId: r.derivedFromResultId } : {}),
                compatible: es.kind === "set",
                ...(m.lastRowSet && r.order > rowSetOrder && es.kind === "set" ? { note: "newer-than-rowset" } : {}),
              });
            }
            if (m.lastChart) {
              cands.push({ kind: "chart", id: m.lastChart.id, order: m.lastChart.order, compatible: false, note: "incompatible-with-highlight" });
            }
            raTrace.candidateReferences = cands.sort((a, b) => a.order - b.order);
            raTrace.chosenReference =
              aref.kind === "result"
                ? `result:${aref.ref.id}`
                : aref.kind === "rowset"
                  ? `rowset:${aref.ref.id}`
                  : aref.kind === "chart"
                    ? `chart:${aref.ref.id}`
                    : aref.kind;
          }
          if (aref.kind === "none") {
            raTrace.outcome = `no_object:${aref.reason}`;
            if (aref.reason === "evicted") {
              say(
                "I don't have that earlier result in view any more. Re-run the analysis, then ask again.",
                "У меня больше нет того результата под рукой. Повторите анализ и спросите снова.",
              );
              return;
            }
            say(
              'There\'s no active set of rows for that. Find or compute the rows first — for example "show the 3 managers with the worst Variance".',
              "Сейчас нет активного набора строк. Сначала найдите или вычислите нужные строки — например «покажи 3 менеджеров с худшим Variance».",
            );
            return;
          }
          if (aref.kind === "clarify") {
            raTrace.outcome = "clarify_entity_column";
            if (aref.candidates.length === 0) {
              say(aref.question, aref.question);
              return;
            }
            sessionMemoryRef.current = setClarification(
              m,
              buildEntityActionClarification(
                text,
                aref.question,
                aref.candidates,
                aref.resultId ?? "",
                {
                  action: action.kind,
                  ...(colour ? { colorHex } : {}),
                  ...(action.sheetName ? { sheetName: action.sheetName } : {}),
                },
                lang,
              ),
            );
            append({ kind: "response", id: nextId("res"), streaming: false, text: aref.question });
            return;
          }

          let rowSet: RowSetRef | undefined;
          let groundedValues: readonly CellValue[] | undefined;
          if (aref.kind === "rowset") {
            rowSet = aref.ref;
            raTrace.source = { sheet: rowSet.sourceSheet, sourceRange: rowSet.sourceRange, sourceVersion: rowSet.sourceVersion };
            if ((await revalidateSource(port, rowSet.sourceRange, rowSet.sourceVersion)) !== "fresh") {
              raTrace.outcome = "stale_source";
              say(STALE_EN, STALE_RU);
              return;
            }
          } else if (aref.kind === "result") {
            // 24.5 §5–§8 — ground the result's entities to source rows using the
            // RESULT's own provenance (never the live selection).
            const targetRef = aref.ref;
            raTrace.source = { sheet: targetRef.sourceSheet, sourceRange: targetRef.sourceRange, sourceVersion: targetRef.sourceVersion };
            if (!(await resultIsFresh(targetRef))) {
              raTrace.outcome = "stale_source";
              say(STALE_EN, STALE_RU);
              return;
            }
            const es0 = aref.entitySet && aref.entitySet.kind === "set" ? aref.entitySet : extractEntitySet(targetRef);
            if (es0.kind !== "set") {
              say(
                "I couldn't tell which rows to act on from that result. Could you say which column identifies them?",
                "Не понял, какие строки выделить по этому результату. Уточните, какой столбец их определяет.",
              );
              return;
            }
            const reduced = reduceEntitySetBySuperlative(targetRef, es0, text);
            const grounded = await groundEntitiesToRows(port, {
              sourceRange: targetRef.sourceRange,
              sourceVersion: targetRef.sourceVersion,
              entityColumn: reduced.column,
              entityValues: reduced.values,
            });
            if (!grounded.ok) {
              raTrace.outcome = `grounding_failed:${grounded.kind}`;
              if (grounded.kind === "stale_source") {
                say(STALE_EN, STALE_RU);
                return;
              }
              say(
                `I can't work out which rows to ${action.kind === "highlight" ? "highlight" : "copy"} — ${grounded.message}.`,
                `Не могу определить, какие строки ${action.kind === "highlight" ? "выделить" : "скопировать"} — ${grounded.message}.`,
              );
              return;
            }
            raTrace.grounding = {
              matchedCount: grounded.matchedValues.length,
              unmatchedCount: grounded.unmatchedValues.length,
              sheetRowsCount: grounded.sheetRows.length,
              sheetRowsMin: grounded.sheetRows[0] ?? null,
              sheetRowsMax: grounded.sheetRows[grounded.sheetRows.length - 1] ?? null,
            };
            if (grounded.sheetRows.length === 0) {
              raTrace.outcome = "no_matching_rows";
              say(
                `No rows in the source data match ${reduced.column} = ${reduced.values.map(String).join(", ")}.`,
                `В исходных данных нет строк, где ${reduced.column} = ${reduced.values.map(String).join(", ")}.`,
              );
              return;
            }
            // §16 — never silently apply a partial mutation.
            if (grounded.unmatchedValues.length > 0) {
              raTrace.outcome = "partial_resolution";
              say(
                `I matched ${grounded.matchedValues.join(", ")} to source rows, but couldn't find ${grounded.unmatchedValues.join(", ")}. Nothing has been changed — say "continue" to proceed with just the matched ${grounded.matchedValues.length === 1 ? "one" : "ones"}.`,
                `Сопоставил со строками: ${grounded.matchedValues.join(", ")}, но не нашёл: ${grounded.unmatchedValues.join(", ")}. Ничего не изменено — напишите «продолжай», чтобы применить только к найденным.`,
              );
              return;
            }
            groundedValues = reduced.values;
            sessionMemoryRef.current = rememberRowSet(sessionMemoryRef.current, {
              turnId: nextId("turn"),
              sourceSheet: grounded.sourceSheet,
              sourceRange: grounded.sourceRange,
              sourceVersion: grounded.sourceVersion,
              sheetRows: grounded.sheetRows.slice(0, 500),
              describe: `${grounded.entityColumn} IN (${reduced.values.map(String).join(", ")})`,
              count: grounded.sheetRows.length,
              truncated: grounded.sheetRows.length > 500,
              columns: grounded.columns,
              rows: grounded.rows.slice(0, 200),
              conditionSpec: { entityColumn: grounded.entityColumn, entityValues: reduced.values.map(String), mode: "in" },
              fromResultId: targetRef.id,
            });
            rowSet = sessionMemoryRef.current.lastRowSet;
          } else {
            say(
              "That refers to a chart, which can't be highlighted. Point me at an analytical result or a set of rows.",
              "Это относится к графику — его нельзя выделить. Укажите результат анализа или набор строк.",
            );
            return;
          }

          if (!rowSet) {
            say("There's no active set of rows for that.", "Сейчас нет активного набора строк.");
            return;
          }

          if (action.kind === "highlight") {
            const built = buildHighlightRowSetActions(rowSet, colorHex);
            if (isCompileError(built)) {
              raTrace.outcome = `action_build_failed:${built.error}`;
              raTrace.actionBuild = {
                sourceWidth: 0,
                contiguousRuns: 0,
                chunkedRuns: (built.rejected ?? []).length,
                actionsBuilt: 0,
                rejectedActions: (built.rejected ?? []).length,
                rejectReasons: (built.rejected ?? []).map((r) => `${r.address} (${r.cells}): ${r.reason}`),
              };
              say(`I can't highlight those rows — ${built.error}.`, `Не получится выделить эти строки — ${built.error}.`);
              return;
            }
            raTrace.actionBuild = {
              sourceWidth: built.width,
              contiguousRuns: built.actions.length + built.rejected.length,
              chunkedRuns: built.actions.length + built.rejected.length,
              actionsBuilt: built.actions.length,
              rejectedActions: built.rejected.length,
              rejectReasons: built.rejected.map((r) => `${r.address} (${r.cells}): ${r.reason}`),
            };
            const forWhomEn = groundedValues && groundedValues.length > 0 ? ` for ${groundedValues.map(String).join(", ")}` : "";
            const forWhomRu = groundedValues && groundedValues.length > 0 ? ` для ${groundedValues.map(String).join(", ")}` : "";
            say(
              `Found ${rowSet.count} row(s)${forWhomEn}. They will be highlighted${colourWordEn}. Approve the change to apply it.`,
              `Найдено ${rowSet.count} строк${forWhomRu}. Они будут выделены${colourWordRu}. Подтвердите изменение, чтобы применить.`,
            );
            append({ kind: "proposal", id: nextId("prop"), actions: built.actions, state: "pending" });
            proposeActions(built.actions.length);
            raTrace.proposalCreated = true;
            raTrace.outcome = "highlight_proposed";
            return;
          }
          if (!action.sheetName) {
            say("Which worksheet should I copy those rows to?", "На какой лист скопировать эти строки?");
            return;
          }
          const map = await safeBuildMap();
          const res = map ? resolveSheet(map, action.sheetName, { strict: true }) : ({ kind: "not_found" } as const);
          if (res.kind === "ambiguous") {
            say(
              `"${action.sheetName}" matches more than one worksheet: ${res.candidates.map((c) => `"${c}"`).join(", ")}. Use the exact name.`,
              `«${action.sheetName}» подходит под несколько листов: ${res.candidates.map((c) => `«${c}»`).join(", ")}. Уточните название.`,
            );
            return;
          }
          if (res.kind !== "ok") {
            say(`I couldn't find a worksheet named "${action.sheetName}".`, `Не нашёл лист с названием «${action.sheetName}».`);
            return;
          }
          const anchor = action.anchor ?? "A1";
          const existing = anchor === "A1" && res.sheet.usedAddress ? await readAddressSnapshot(port, res.sheet.usedAddress).catch(() => null) : null;
          const built = buildCopyRowSetActions(rowSet, { sheetName: res.sheet.name, anchor }, existing?.values);
          if (isCompileError(built)) {
            say(`I can't copy those rows — ${built.error}.`, `Не получится скопировать эти строки — ${built.error}.`);
            return;
          }
          say(
            `I'll copy ${rowSet.count} row(s) to ${res.sheet.name}!${built.destRange}.${overwriteNote(built.overwriteCells)} Approve the change to apply it.`,
            `Скопирую ${rowSet.count} строк в ${res.sheet.name}!${built.destRange}.${overwriteNote(built.overwriteCells)} Подтвердите изменение, чтобы применить.`,
          );
          append({ kind: "proposal", id: nextId("prop"), actions: [built.action], state: "pending" });
          proposeActions(1);
          return;
        }

        // action.kind === "write"
        if (!resolvedResult) {
          say("There's no active analytical result to write yet. Run an analysis first.", "Пока нет активного результата анализа для записи. Сначала выполните анализ.");
          return;
        }
        if (!action.sheetName) {
          say("Which worksheet should I write that table to?", "На какой лист записать эту таблицу?");
          return;
        }
        if (!(await resultIsFresh(resolvedResult))) {
          say(STALE_EN, STALE_RU);
          return;
        }
        const map = await safeBuildMap();
        const res = map ? resolveSheet(map, action.sheetName, { strict: true }) : ({ kind: "not_found" } as const);
        const anchor = action.anchor ?? "A1";
        if (res.kind === "ambiguous") {
          say(
            `"${action.sheetName}" matches more than one worksheet: ${res.candidates.map((c) => `"${c}"`).join(", ")}. Use the exact name.`,
            `«${action.sheetName}» подходит под несколько листов: ${res.candidates.map((c) => `«${c}»`).join(", ")}. Уточните название.`,
          );
          return;
        }

        if (action.newSheet || res.kind === "not_found") {
          const target = action.sheetName;
          const written = buildWriteResultActions(resolvedResult, { sheetName: target, anchor });
          if (isCompileError(written)) {
            say(`I can't write that table — ${written.error}.`, `Не получится записать таблицу — ${written.error}.`);
            return;
          }
          const workflow: WorkflowStep[] = [
            { kind: "create_sheet", name: target },
            { kind: "cells", actions: [written.action], label: `write "${resolvedResult.title}"` },
          ];
          say(
            `I'll create a "${target}" sheet and write "${resolvedResult.title}" (${written.rowsWritten}×${written.colsWritten}) to ${target}!${written.destRange}. Approve to run both as one change; one undo reverts the whole thing.`,
            `Создам лист «${target}» и запишу «${resolvedResult.title}» (${written.rowsWritten}×${written.colsWritten}) в ${target}!${written.destRange}. Подтвердите — всё выполнится одним действием, одна отмена вернёт всё назад.`,
          );
          append({ kind: "proposal", id: nextId("prop"), actions: [], workflow, state: "pending" });
          proposeActions(2);
          return;
        }

        // res.kind === "ok" → plain write into an existing sheet
        const existing = anchor === "A1" && res.sheet.usedAddress ? await readAddressSnapshot(port, res.sheet.usedAddress).catch(() => null) : null;
        const written = buildWriteResultActions(resolvedResult, { sheetName: res.sheet.name, anchor }, existing?.values);
        if (isCompileError(written)) {
          say(`I can't write that table — ${written.error}.`, `Не получится записать таблицу — ${written.error}.`);
          return;
        }
        say(
          `I'll write "${resolvedResult.title}" (${written.rowsWritten}×${written.colsWritten}) to ${res.sheet.name}!${written.destRange}.${overwriteNote(written.overwriteCells)} Approve the change to apply it.`,
          `Запишу «${resolvedResult.title}» (${written.rowsWritten}×${written.colsWritten}) в ${res.sheet.name}!${written.destRange}.${overwriteNote(written.overwriteCells)} Подтвердите изменение, чтобы применить.`,
        );
        append({ kind: "proposal", id: nextId("prop"), actions: [written.action], state: "pending" });
        proposeActions(1);
      };

      // ----- Stage 24.6: universal table schema route ---------------------
      const schemaTraceFrom = (
        schema: TableSchema,
        routeChosen: "flat_table" | "universal_schema" | "clarify",
        analysisRequested: readonly string[],
        analysisCompleted: readonly string[],
        expandedRowsAbove: number,
      ): NonNullable<ResultActionTrace["tableSchema"]> => ({
        sourceRange: schema.sourceRange,
        layoutKind: schema.layoutKind,
        orientation: schema.orientation,
        confidence: schema.confidence,
        headerDepth: schema.headerDepth,
        rowHeaderColumns: schema.rowHeaderColumns.length,
        rowAxisCount: schema.rowAxis.length,
        columnAxisCount: schema.columnPaths.length,
        measuresCount: schema.measures.length,
        dateCells: schema.profileSummary.dateCells,
        percentCells: schema.profileSummary.percentCells,
        totalsCount: schema.totals.length,
        ambiguities: schema.ambiguities.map((a) => a.kind),
        routeChosen,
        analysisRequested,
        analysisCompleted,
        ...(expandedRowsAbove ? { expandedRowsAbove } : {}),
      });

      const runSchemaRoute = async (
        schemaText: string,
        si: ReturnType<typeof detectSchemaIntent>,
      ): Promise<"handled" | "flat"> => {
        setLanguage(lang);
        setBusy(true);
        if (!suppressCommandEcho) append({ kind: "command", id: nextId("cmd"), text: schemaText });
        const scReadId = nextId("act");
        append({ kind: "activity", id: scReadId, activity: "reading", title: uiText(lang, "reading"), status: "running" });
        const scTrace: MutableResultActionTrace = { text: schemaText, at: new Date().toISOString(), routeChosen: "universal_schema", detectedResultAction: null };
        const analysisRequested = Object.entries(si).filter(([k, v]) => v === true && k !== "any").map(([k]) => k);
        try {
          let snap = await readSelectionSnapshot(port).catch(() => undefined);
          if (!snap) {
            setActivity(scReadId, "done", uiText(lang, "noRange"));
            say("Select the table first, then ask again.", "Сначала выделите таблицу, затем повторите запрос.");
            return "handled";
          }
          selectionRef.current = snap;
          let startsBelowRow1 = false;
          try {
            const { localAddress } = splitSheetAddress(snap.address);
            startsBelowRow1 = parseLocalRange(localAddress || snap.address).start.row > 0;
          } catch {
            /* keep false */
          }
          let expandedRowsAbove = 0;
          let schema = induceTableSchema({
            values: snap.values,
            numberFormats: snap.numberFormats,
            formulas: snap.formulas,
            sheetName: snap.sheetName,
            sourceRange: snap.address,
            sourceVersion: sourceVersionOf(snap),
            startsBelowRow1,
          });

          if (schema.headerDepth === 0 && startsBelowRow1 && schema.ambiguities.some((a) => a.kind === "missing_header_context")) {
            try {
              const { sheetName, localAddress } = splitSheetAddress(snap.address);
              const lr = parseLocalRange(localAddress || snap.address);
              const rowsAbove = Math.min(5, lr.start.row);
              if (rowsAbove > 0) {
                const topRow = lr.start.row - rowsAbove + 1;
                const expandedLocal = `${columnIndexToLetters(lr.start.column)}${topRow}:${columnIndexToLetters(lr.end.column)}${lr.end.row + 1}`;
                const expandedAddr = sheetName ? `${sheetName}!${expandedLocal}` : expandedLocal;
                const expanded = await readAddressSnapshot(port, expandedAddr).catch(() => null);
                if (expanded && expanded.values.length > snap.values.length) {
                  expandedRowsAbove = rowsAbove;
                  snap = expanded;
                  selectionRef.current = snap;
                  schema = induceTableSchema({
                    values: snap.values,
                    numberFormats: snap.numberFormats,
                    formulas: snap.formulas,
                    sheetName: snap.sheetName,
                    sourceRange: snap.address,
                    sourceVersion: sourceVersionOf(snap),
                    startsBelowRow1: false,
                  });
                }
              }
            } catch {
              /* best-effort */
            }
          }

          const scLocal = snap.address.split("!").pop() ?? snap.address;
          setActivity(scReadId, "done", `${snap.sheetName}!${scLocal} · ${snap.totalRowCount} rows × ${snap.totalColumnCount} columns`);

          if (
            schema.orientation === "row_records" &&
            schema.confidence >= 0.6 &&
            schema.headerDepth >= 1 &&
            !schema.ambiguities.some((a) => a.kind === "missing_header_context") &&
            !si.describe
          ) {
            scTrace.tableSchema = schemaTraceFrom(schema, "flat_table", analysisRequested, [], expandedRowsAbove);
            commitTrace(scTrace);
            return "flat";
          }

          if (schema.confidence < 0.35 || (schema.headerDepth === 0 && !si.describe && schema.orientation !== "column_metrics")) {
            scTrace.tableSchema = schemaTraceFrom(schema, "clarify", analysisRequested, [], expandedRowsAbove);
            commitTrace(scTrace);
            say(
              "I can see a numeric block, but I can't confidently identify the header. It looks like the top header rows are outside the selected range — select them too, or point me at the full table.",
              "Я вижу числовую матрицу, но не могу уверенно определить заголовок. Похоже, верхние строки заголовка не вошли в выделение — добавьте их в диапазон или укажите таблицу целиком.",
            );
            return "handled";
          }

          const grids = { values: snap.values, numberFormats: snap.numberFormats };
          const out = runSchemaAnalysis(schema, grids, si, lang);
          const turnId = nextId("turn");
          const bodyParts: string[] = [];
          if (out.describeText) bodyParts.push(out.describeText);
          for (const sec of out.sections) bodyParts.push(`**${sec.title}**\n\n${renderGridMarkdown(sec.columns, sec.rows)}`);
          const body = bodyParts.join("\n\n") || (lang === "ru" ? "Не удалось получить результат." : "No result.");

          const firstSec = out.sections[0];
          const summaryOnly = Boolean(out.describeText) && out.sections.length === 0;
          sessionMemoryRef.current = rememberResult(sessionMemoryRef.current, {
            turnId,
            kind: summaryOnly ? "schema_summary" : "matrix_analysis",
            title: summaryOnly ? (lang === "ru" ? "О таблице" : "About this table") : firstSec?.title ?? (lang === "ru" ? "Анализ матрицы" : "Matrix analysis"),
            spec: { op: "schema_analysis", layoutKind: schema.layoutKind, orientation: schema.orientation, computed: out.computed, sourceCells: out.sourceCells },
            columns: firstSec?.columns ?? [lang === "ru" ? "Сводка" : "Summary"],
            rows: firstSec?.rows ?? (out.describeText ? [[out.describeText]] : []),
            rowsTruncated: false,
            facts: [],
            sourceSheet: schema.sheetName,
            sourceRange: schema.sourceRange,
            sourceVersion: schema.sourceVersion,
            resolved: [],
          });

          scTrace.tableSchema = schemaTraceFrom(schema, "universal_schema", analysisRequested, out.computed, expandedRowsAbove);
          commitTrace(scTrace);

          append({ kind: "response", id: nextId("res"), streaming: false, text: body });
          conversationRef.current = [...conversationRef.current, { role: "user", content: schemaText }, { role: "assistant", content: body }];

          if (out.needsNormClarification) {
            sessionMemoryRef.current = setClarification(
              sessionMemoryRef.current,
              buildSchemaNormClarification(schemaText, schema.sourceRange, schema.sourceVersion, lang),
            );
            append({ kind: "response", id: nextId("res"), streaming: false, text: sessionMemoryRef.current.pendingClarification!.question });
          } else {
            append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
          }
          return "handled";
        } catch (error) {
          append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "Could not analyse that table" });
          return "handled";
        } finally {
          setBusy(false);
        }
      };

      // ----- Stage 25: LLM analytical planner (composes Stage 24.x tools) --
      // Runs when the Stage 24.7–24.9 deterministic COMPILER declines a
      // schema-backed table — a request no known phrase/cue covers (§0/§57).
      // The planner never computes a workbook number itself: it composes the
      // read-only tools in analytics-agent/tool-registry.ts, and a SEPARATE
      // narrator pass (gated by the same evidence check as the Stage 24.4
      // bounded agent) turns the verified observations into prose (§32/§39).
      const runStage25Planner = async (
        schema: TableSchema,
        grids: AnalysisGrids,
        analyticalText: string,
        resume?: { readonly state: AgentLoopState; readonly answer: string },
        // Stage 25.1.3c §4/§5/§10 — an already-resolved pronoun subject
        // (Stage 25.1.3a's `subjectOverride` handoff), carried into the
        // planner's own context as an AUTHORITATIVE binding rather than
        // dropped at this boundary. Must survive every fallback path that
        // hands a turn to the Stage 25 planner, not just the direct route.
        resolvedSubject?: string,
      ): Promise<boolean> => {
        if (!analyticalPlannerEnabled() || typeof chatClient.decideAgentStep !== "function" || typeof chatClient.narrate !== "function") return false;
        // §44 — every analytical route says it ran, so "who analysed this turn?"
        // has an answer a test can assert instead of a comment claiming it.
        recordAnalyticalExecution("stage25_planner");
        const controller = new AbortController();
        const mf = sessionMemoryRef.current.lastMetricFocusRef;
        const ms = sessionMemoryRef.current.lastMetricSetRef;
        const rs = sessionMemoryRef.current.lastResultSetRef;
        const pr = sessionMemoryRef.current.lastPeriodRef;
        // Stage 25.1.3f §3/§4 — the previous successful analytical turn's FULL
        // structured result: this turn's follow-up filters/slices THAT, instead
        // of re-resolving a fresh workbook universe (§9).
        const art = sessionMemoryRef.current.lastAnalyticalResultSetRef;
        const inherited: AnalyticalInherited = {
          ...(resolvedSubject ? { resolvedSubject: { metricKey: resolvedSubject, source: "conversation_pronoun", authoritative: true } } : {}),
          ...(mf ? { metricFocus: { metricKey: mf.metricKey } } : {}),
          ...(ms ? { metricSet: { metricKeys: ms.metricKeys } } : {}),
          ...(rs ? { resultSet: { operation: rs.operation, scoreField: rs.scoreField, rows: rs.rows } } : {}),
          ...(art
            ? {
                resultTable: {
                  operation: art.operation,
                  columns: art.columns,
                  rows: art.rows,
                  ...(art.startCanonical ? { startCanonical: art.startCanonical } : {}),
                  ...(art.endCanonical ? { endCanonical: art.endCanonical } : {}),
                },
              }
            : {}),
          ...(pr ? { period: { startCanonical: pr.startCanonical, ...(pr.endCanonical ? { endCanonical: pr.endCanonical } : {}) } } : {}),
        };

        // Stage 25.1/25.1.1 §17/§6/§7/§3–§5/§15–§17 — the request's semantic
        // invariants, audited against what actually got executed below.
        const requestedCandidateSet = explicitCandidateSet(analyticalText, buildMetricIndex(schema));
        const requestedTemporalMode = detectTemporalMode(analyticalText);
        const requestedOperationKind = detectOperationKind(analyticalText);
        const requestedClauseCount = countAnalyticalClauses(analyticalText);
        // Stage 25.1.3 §23/§24 — only meaningful for a genuinely exploratory
        // ask; a bare number elsewhere in the sentence is not a cardinality.
        const requestedExploratoryCardinality = isExploratoryRequest(analyticalText) ? extractRequestedCardinality(analyticalText) : null;
        // Stage 25.1.3b §2–§6 — a "changed the most" comparison across
        // heterogeneous metrics defaults to percentage-magnitude ranking.
        const requestedRankingBasis = detectRequestedRankingBasis(analyticalText);

        const actId = nextId("act");
        append({ kind: "activity", id: actId, activity: "analyzing", title: uiText(lang, "analyzing"), status: "running" });
        const seenActivity = new Set<string>();
        let outcome: AnalyticalPlannerOutcome;
        try {
          outcome = await runAnalyticalPlanner({
            taskId: nextId("plan"),
            text: analyticalText,
            schema,
            grids,
            language: lang === "ru" ? "ru" : "en",
            inherited,
            requestedCandidateSet,
            requestedTemporalMode,
            requestedOperationKind,
            requestedClauseCount,
            requestedExploratoryCardinality,
            requestedRankingBasis,
            ...(resume ? { resume } : {}),
            decidePlanner: (dctx) =>
              chatClient.decideAgentStep!(
                {
                  originalUserRequest: dctx.originalUserRequest,
                  language: dctx.language,
                  history: boundedHistory(conversationRef.current).map((m) => ({ role: m.role, content: m.content })),
                  workbookContext: dctx.workbookContext,
                  toolSchemas: dctx.toolSchemas,
                  observations: dctx.observations,
                  iteration: dctx.iteration,
                  remainingSteps: dctx.remainingSteps,
                  remainingReads: dctx.remainingReads,
                  ...(model ? { model } : {}),
                },
                controller.signal,
              ),
            narrate: (messages) => chatClient.narrate!(messages, controller.signal, model),
            onStep: (step) => {
              const label = agentActivityLabel(step, lang, seenActivity);
              if (label) append({ kind: "activity", id: nextId("act"), activity: "calculating", title: label, status: "done" });
            },
          });
        } catch (error) {
          setActivity(actId, "error");
          append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "The analytical planner could not run." });
          return true;
        }
        setActivity(actId, "done");

        if (outcome.kind === "clarify") {
          // Stage 25.1.2 §8/§10 — the model's own clarifying question, never
          // shown raw: guard it exactly like a final narration.
          const question = containsForbiddenLeak(outcome.question)
            ? lang === "ru"
              ? "Уточните, пожалуйста, какие показатели и период вы имеете в виду."
              : "Could you clarify which metrics and period you mean?"
            : outcome.question;
          // Stage 25.1.3 §15/§16 — a SUSPENDED analytical request: `kind:
          // "analytical_agent"` (never "agent") so the resume dispatch below
          // never routes this through the flat legacy agent's tool registry.
          // `sourceIdentity` here is the RANGE's own freshness token (not the
          // whole-workbook identity) — a mutation to an unrelated sheet, a
          // clarification round-trip, or a planner retry must never
          // invalidate it (§20/§21); only a real change to THIS range does.
          sessionMemoryRef.current = setClarification(
            sessionMemoryRef.current,
            buildAgentClarification(analyticalText, question, outcome.candidates, outcome.state, schema.sourceVersion, "analytical_agent"),
          );
          append({ kind: "response", id: nextId("res"), streaming: false, text: question });
          conversationRef.current = [...conversationRef.current, { role: "user", content: analyticalText }, { role: "assistant", content: question }];
          return true;
        }

        if (outcome.kind === "failed") {
          const en =
            outcome.reasonKey === "model_error" || outcome.reasonKey === "repeated_tool_call"
              ? "I couldn't work out a reliable way to answer that. Could you rephrase it or narrow it down?"
              : outcome.reasonKey === "read_budget" || outcome.reasonKey === "step_budget"
                ? "I couldn't finish investigating this within the limits for one turn. Try narrowing the question to a specific metric or period."
                : "I wasn't able to complete that analysis.";
          const ru =
            outcome.reasonKey === "model_error" || outcome.reasonKey === "repeated_tool_call"
              ? "Не удалось составить надёжный план ответа. Переформулируйте запрос или сузьте его."
              : outcome.reasonKey === "read_budget" || outcome.reasonKey === "step_budget"
                ? "Не удалось завершить анализ в пределах лимитов за один ход. Уточните вопрос — конкретный показатель или период."
                : "Не удалось выполнить этот анализ.";
          const body = lang === "ru" ? ru : en;
          append({ kind: "response", id: nextId("res"), streaming: false, text: body });
          conversationRef.current = [...conversationRef.current, { role: "user", content: analyticalText }, { role: "assistant", content: body }];
          return true;
        }

        // Stage 25.1 §9/§24/§28/§49 — grounded numbers, wrong shape: the plan
        // answered a different question (a widened candidate set, an
        // internally inconsistent change row). Never narrated, never shown,
        // and — per §9 — must NOT steal the conversation's prior valid focus.
        if (outcome.kind === "semantic_failed") {
          const body =
            lang === "ru"
              ? "Не удалось убедиться, что результат точно отвечает на заданный вопрос (расхождение в наборе показателей или в периоде). Уточните запрос."
              : "I couldn't confirm the result actually answers what was asked (a candidate-set or period mismatch). Please rephrase or narrow the request.";
          append({ kind: "response", id: nextId("res"), streaming: false, text: body });
          conversationRef.current = [...conversationRef.current, { role: "user", content: analyticalText }, { role: "assistant", content: body }];
          return true;
        }

        // handled
        append({ kind: "response", id: nextId("res"), streaming: false, text: outcome.body });
        conversationRef.current = [...conversationRef.current, { role: "user", content: analyticalText }, { role: "assistant", content: outcome.body }];
        sessionMemoryRef.current = rememberAnalyticalTable(sessionMemoryRef.current, { sheetName: schema.sheetName, sourceRange: schema.sourceRange });
        // Stage 25.1.3f §5/§6 — a SUCCESSFUL analytical execution commits its
        // structured continuation state, period. The narrator falling back to
        // the deterministic table is a PRESENTATION outcome, and a superlative
        // turn narrowing the VISIBLE answer to one row is a display decision —
        // neither may prevent the next turn from seeing the universe this turn
        // computed. `commitPlannerOutputs` therefore runs off the run's own
        // observations, outside the `outcome.primary` guard below (which only
        // governs the user-visible ResultRef).
        const plannerTurnId = nextId("turn");
        if (outcome.primary && outcome.primary.columns && outcome.primary.rows) {
          sessionMemoryRef.current = rememberResult(sessionMemoryRef.current, {
            turnId: plannerTurnId,
            kind: "temporal_analysis",
            title: outcome.primary.tool,
            spec: { op: "analytical_planner", tool: outcome.primary.tool },
            columns: outcome.primary.columns,
            rows: outcome.primary.rows.map((r) => r.map((c) => c as CellValue)),
            rowsTruncated: outcome.primary.truncated ?? false,
            facts: [],
            sourceSheet: schema.sheetName,
            sourceRange: schema.sourceRange,
            sourceVersion: schema.sourceVersion,
            resolved: [],
          });
        }
        // Stage 25.1 §4/§5/§6 — the planner's own outputs are canonical refs
        // too, not just a generic ResultRef: commit whichever shape the run
        // produced (a focus winner, an explicit set, an ordered ranking, an
        // interval, and — Stage 25.1.3f §3 — the full continuation universe)
        // into the SAME SessionMemory fields the Stage 24.x fast path writes —
        // one authoritative owner, not a parallel memory.
        sessionMemoryRef.current = commitPlannerOutputs(
          sessionMemoryRef.current,
          { turnId: plannerTurnId, sourceRange: schema.sourceRange, sourceVersion: schema.sourceVersion, requestText: analyticalText },
          outcome.state.observations,
          outcome.state.steps,
        );
        return true;
      };

      // ----- Stage 24.7: universal analytical-intent compiler ------------
      // Sits between the proven flat routes and the model. Compiles a temporal /
      // ranking / comparison intent against the induced TableSchema and executes
      // it deterministically. "flat" → this turn is not analytical-schema work.
      const runAnalyticalRoute = async (
        analyticalText: string,
        subjectOverride?: string,
      ): Promise<"handled" | "flat"> => {
        const acTrace: MutableResultActionTrace = {
          text: analyticalText,
          at: new Date().toISOString(),
          routeChosen: "analytical_compiler",
          detectedResultAction: null,
        };
        let committed = false;
        try {
          // Stage 24.8 §27–§29/§57/§74 — a single-cell click INSIDE the last
          // known analytical table must not shrink the universe to one cell:
          // read the remembered table range instead of the live selection.
          const known = sessionMemoryRef.current.lastAnalyticalTable;
          const liveSel = await port.getSelection().catch(() => undefined);
          const useKnownTable = Boolean(
            liveSel && liveSel.rowCount === 1 && liveSel.columnCount === 1 && known && cellWithinRange(liveSel.address, known.sourceRange),
          );
          let snap = useKnownTable
            ? await readAddressSnapshot(port, known!.sourceRange).catch(() => undefined)
            : await readSelectionSnapshot(port).catch(() => undefined);
          // Stage 25.1.2 §4/§6 — a schema-aware analytical conversation must
          // not decline to the legacy flat analyzer just because the live
          // selection could not be read this turn (moved, or a transient
          // failure): retry against the remembered analytical table first.
          if (!snap && known) {
            snap = await readAddressSnapshot(port, known.sourceRange).catch(() => undefined);
          }
          if (!snap) return "flat";
          let startsBelowRow1 = false;
          try {
            const { localAddress } = splitSheetAddress(snap.address);
            startsBelowRow1 = parseLocalRange(localAddress || snap.address).start.row > 0;
          } catch {
            /* keep false */
          }
          const schema = induceTableSchema({
            values: snap.values,
            numberFormats: snap.numberFormats,
            formulas: snap.formulas,
            sheetName: snap.sheetName,
            sourceRange: snap.address,
            sourceVersion: sourceVersionOf(snap),
            startsBelowRow1,
          });

          // §43/§44 — only route confident non-flat schemas here; records tables
          // stay on the proven flat pipeline.
          if (schema.orientation === "row_records" || schema.confidence < 0.5) return "flat";

          const grids = { values: snap.values, numberFormats: snap.numberFormats };
          const periodIndexForInherit = buildPeriodIndex(schema, grids);

          // §12 — rehydrate the remembered interval as CanonicalPeriods.
          let inherited: InheritedPeriod | undefined;
          const pr = sessionMemoryRef.current.lastPeriodRef;
          if (pr && pr.kind === "interval" && pr.endCanonical) {
            const s = periodIndexForInherit.points.find((p) => p.canonical === pr.startCanonical);
            const e = periodIndexForInherit.points.find((p) => p.canonical === pr.endCanonical);
            if (s && e) inherited = { start: s, end: e };
          }

          // Stage 24.8 §11/§30/§31 — rehydrate the remembered ranking interval
          // for "те же 5, но по абсолютному изменению".
          let inheritedRanking: InheritedRanking | undefined;
          const rr = sessionMemoryRef.current.lastRankingRef;
          if (rr) {
            const s = periodIndexForInherit.points.find((p) => p.canonical === rr.startCanonical);
            const e = periodIndexForInherit.points.find((p) => p.canonical === rr.endCanonical);
            if (s && e) inheritedRanking = { interval: { start: s, end: e }, ...(rr.limit !== undefined ? { limit: rr.limit } : {}) };
          }

          // Stage 24.8 §13/§14 — rehydrate the remembered two intervals for
          // "в первом интервале… во втором…".
          let inheritedComposite: InheritedComposite | undefined;
          const cr = sessionMemoryRef.current.lastCompositeRef;
          if (cr) {
            const s1 = periodIndexForInherit.points.find((p) => p.canonical === cr.interval1.startCanonical);
            const e1 = periodIndexForInherit.points.find((p) => p.canonical === cr.interval1.endCanonical);
            const s2 = periodIndexForInherit.points.find((p) => p.canonical === cr.interval2.startCanonical);
            const e2 = periodIndexForInherit.points.find((p) => p.canonical === cr.interval2.endCanonical);
            if (s1 && e1 && s2 && e2) inheritedComposite = { interval1: { start: s1, end: e1 }, interval2: { start: s2, end: e2 } };
          }

          // Stage 24.9 §35/§36/§50 — rehydrate the prior MetricSetRef's
          // members as the CANDIDATE SET for a growth-comparison pronoun
          // follow-up ("какой из них вырос сильнее…").
          let inheritedMetricSet: InheritedMetricSet | undefined;
          const msr = sessionMemoryRef.current.lastMetricSetRef;
          if (msr) {
            const members = msr.metricKeys
              .map((key) => schema.rowAxis.find((m) => m.display === key))
              .filter((m): m is NonNullable<typeof m> => Boolean(m));
            if (members.length === msr.metricKeys.length && members.length > 0) inheritedMetricSet = { members };
          }

          const outcome = runAnalyticalAnalysis(
            schema,
            grids,
            analyticalText,
            lang === "ru" ? "ru" : "en",
            inherited,
            subjectOverride,
            inheritedRanking,
            inheritedComposite,
            inheritedMetricSet,
          );
          const toTraceField = (t: AnalyticalTrace): NonNullable<ResultActionTrace["analyticalCompiler"]> => ({
            originalText: t.originalText,
            detectedOperation: t.detectedOperation,
            resolvedSubject: t.resolvedSubject,
            subjectScope: t.subjectScope,
            measureBasis: t.measureBasis,
            compiledSteps: t.compiledSteps,
            planValid: t.planValid,
            validationErrors: t.validationErrors,
            routeChosen: t.routeChosen,
            inheritedPeriodRef: t.inheritedPeriodRef,
            ...(t.requestedStart ? { requestedStart: t.requestedStart } : {}),
            ...(t.requestedEnd ? { requestedEnd: t.requestedEnd } : {}),
            ...(t.executedStart ? { executedStart: t.executedStart } : {}),
            ...(t.executedEnd ? { executedEnd: t.executedEnd } : {}),
            silentSubstitution: t.silentSubstitution,
            assumptions: t.assumptions,
          });

          if (outcome.kind === "decline") {
            // Stage 25 §57 — never fall to the legacy flat analyzer for a
            // schema-backed table without trying tool composition first.
            if (!analyticalPlannerEnabled() || typeof chatClient.decideAgentStep !== "function" || typeof chatClient.narrate !== "function") return "flat";
            setLanguage(lang);
            setBusy(true);
            committed = true;
            selectionRef.current = snap;
            sessionMemoryRef.current = rememberAnalyticalTable(sessionMemoryRef.current, { sheetName: schema.sheetName, sourceRange: schema.sourceRange });
            if (!suppressCommandEcho) append({ kind: "command", id: nextId("cmd"), text: analyticalText });
            // Stage 25.1.3c §4/§9 — the legacy compiler declining this turn
            // must not drop an already-resolved pronoun subject: the Stage 25
            // planner needs it just as much as the compiler would have.
            await runStage25Planner(schema, grids, analyticalText, undefined, subjectOverride);
            append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
            return "handled";
          }

          // committed — this turn is analytical-schema work.
          setLanguage(lang);
          setBusy(true);
          committed = true;
          selectionRef.current = snap;
          // Stage 24.8 §27–§29 — remember this table so a later single-cell
          // click inside it still resolves the whole analytical range.
          sessionMemoryRef.current = rememberAnalyticalTable(sessionMemoryRef.current, {
            sheetName: schema.sheetName,
            sourceRange: schema.sourceRange,
          });
          if (!suppressCommandEcho) append({ kind: "command", id: nextId("cmd"), text: analyticalText });

          // Stage 25.1.1 §5/§35/§36 — Stage 24.x has NO compiled operation for
          // any of these kinds (peak-distance, down/up-then pattern, stable
          // growth, mean deviation) — whatever it decided (clarify / error /
          // even a "successful" but structurally wrong plan) is never a
          // legitimate answer to THIS class of request. Skip straight to the
          // planner rather than showing an irrelevant clarification.
          if (
            outcome.kind !== "handled" &&
            detectOperationKind(analyticalText) !== null &&
            analyticalPlannerEnabled() &&
            typeof chatClient.decideAgentStep === "function" &&
            typeof chatClient.narrate === "function"
          ) {
            await runStage25Planner(schema, grids, analyticalText, undefined, subjectOverride);
            append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
            return "handled";
          }

          if (outcome.kind === "clarify") {
            acTrace.analyticalCompiler = toTraceField(outcome.trace);
            acTrace.outcome = "clarify";
            commitTrace(acTrace);
            sessionMemoryRef.current = setClarification(
              sessionMemoryRef.current,
              outcome.field === "period"
                ? buildAnalysisPeriodClarification(analyticalText, outcome.candidates, schema.sourceRange, schema.sourceVersion, outcome.question)
                : buildAnalysisSubjectClarification(analyticalText, outcome.needle, outcome.candidates, schema.sourceRange, schema.sourceVersion, outcome.question),
            );
            append({ kind: "response", id: nextId("res"), streaming: false, text: outcome.question });
            conversationRef.current = [...conversationRef.current, { role: "user", content: analyticalText }, { role: "assistant", content: outcome.question }];
            return "handled";
          }

          if (outcome.kind === "error") {
            // Stage 25.1 §39/§94 — a schema-aware table must never surface a
            // raw compiler error ("не удалось разрешить период" etc.) when
            // the planner can still attempt the request via tool composition.
            if (analyticalPlannerEnabled() && typeof chatClient.decideAgentStep === "function" && typeof chatClient.narrate === "function") {
              await runStage25Planner(schema, grids, analyticalText, undefined, subjectOverride);
              append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
              return "handled";
            }
            acTrace.analyticalCompiler = toTraceField(outcome.trace);
            acTrace.outcome = "error";
            commitTrace(acTrace);
            append({ kind: "response", id: nextId("res"), streaming: false, text: outcome.message });
            conversationRef.current = [...conversationRef.current, { role: "user", content: analyticalText }, { role: "assistant", content: outcome.message }];
            append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
            return "handled";
          }

          // Stage 25.1/25.1.1 §12–§14/§21/§35/§36/§90 — a compiled, VALID plan
          // is still not a full/correct answer when: (a) it covers only ONE
          // clause of a multi-clause request (§14 "partial fast-path match is
          // not success"); (b) the sentence names an operation kind Stage
          // 24.x structurally cannot represent (§5/§35/§36 — "a generic
          // growth route must NOT win" for peak-distance/pattern/stable-
          // growth/mean-deviation requests); or (c) an explicit temporal mode
          // ("previous_to_last"/"first_to_last") was requested but the
          // executed interval is a different pair of periods (§6–§8/§41 —
          // the exact release-blocker case). One semantic retry through the
          // planner (§8/§26), never a silently dropped clause or substituted
          // period.
          const detectedOperationKind = detectOperationKind(analyticalText);
          const detectedTemporalMode = detectTemporalMode(analyticalText);
          const periodMismatch =
            detectedTemporalMode !== null &&
            outcome.plan.interval !== undefined &&
            (() => {
              const sorted = [...periodIndexForInherit.points].sort((a, b) => a.orderKey - b.orderKey);
              if (sorted.length < 2) return false;
              const expected =
                detectedTemporalMode === "previous_to_last"
                  ? [sorted[sorted.length - 2]!.canonical, sorted[sorted.length - 1]!.canonical]
                  : [sorted[0]!.canonical, sorted[sorted.length - 1]!.canonical];
              const executed = [outcome.plan.interval!.start.canonical, outcome.plan.interval!.end.canonical];
              return expected[0] !== executed[0] || expected[1] !== executed[1];
            })();
          if (
            (hasSecondAnalyticalClause(analyticalText) && !COMPOUND_AWARE_OPERATIONS.has(outcome.plan.operation)) ||
            detectedOperationKind !== null ||
            periodMismatch
          ) {
            if (analyticalPlannerEnabled() && typeof chatClient.decideAgentStep === "function" && typeof chatClient.narrate === "function") {
              await runStage25Planner(schema, grids, analyticalText, undefined, subjectOverride);
              append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
              return "handled";
            }
          }

          // handled
          const acTurnId = nextId("turn");
          const firstSec = outcome.execution.sections[0];
          append({ kind: "response", id: nextId("res"), streaming: false, text: outcome.body });
          conversationRef.current = [...conversationRef.current, { role: "user", content: analyticalText }, { role: "assistant", content: outcome.body }];
          sessionMemoryRef.current = rememberResult(sessionMemoryRef.current, {
            turnId: acTurnId,
            kind: "temporal_analysis",
            title: firstSec?.title ?? (lang === "ru" ? "Анализ" : "Analysis"),
            spec: {
              op: "analytical_compiler",
              operation: outcome.plan.operation,
              subjectScope: outcome.plan.subjectScope,
              steps: outcome.trace.compiledSteps,
              sourceCells: outcome.sourceCells,
            },
            columns: firstSec?.columns ?? [lang === "ru" ? "Показатель" : "Metric"],
            rows: (firstSec?.rows ?? []).map((r) => r.map((c) => c as CellValue)),
            rowsTruncated: false,
            facts: [],
            sourceSheet: schema.sheetName,
            sourceRange: schema.sourceRange,
            sourceVersion: schema.sourceVersion,
            resolved: [],
            ...(outcome.entityColumn && outcome.entityValues.length > 0
              ? { entityColumn: outcome.entityColumn, entityValues: outcome.entityValues.map((v) => v as CellValue) }
              : {}),
          });
          if (outcome.rememberInterval) {
            sessionMemoryRef.current = rememberPeriod(sessionMemoryRef.current, {
              turnId: acTurnId,
              kind: "interval",
              startCanonical: outcome.rememberInterval.start.canonical,
              endCanonical: outcome.rememberInterval.end.canonical,
              startHeaderPath: outcome.rememberInterval.start.headerPath,
              endHeaderPath: outcome.rememberInterval.end.headerPath,
              sourceRange: schema.sourceRange,
              sourceVersion: schema.sourceVersion,
            });
          }
          if (outcome.rememberRanking) {
            sessionMemoryRef.current = rememberRanking(sessionMemoryRef.current, {
              turnId: acTurnId,
              startCanonical: outcome.rememberRanking.interval.start.canonical,
              endCanonical: outcome.rememberRanking.interval.end.canonical,
              startHeaderPath: outcome.rememberRanking.interval.start.headerPath,
              endHeaderPath: outcome.rememberRanking.interval.end.headerPath,
              ...(outcome.rememberRanking.limit !== undefined ? { limit: outcome.rememberRanking.limit } : {}),
              sourceRange: schema.sourceRange,
              sourceVersion: schema.sourceVersion,
            });
          }
          if (outcome.rememberComposite) {
            sessionMemoryRef.current = rememberComposite(sessionMemoryRef.current, {
              turnId: acTurnId,
              interval1: {
                startCanonical: outcome.rememberComposite.interval1.start.canonical,
                endCanonical: outcome.rememberComposite.interval1.end.canonical,
                startHeaderPath: outcome.rememberComposite.interval1.start.headerPath,
                endHeaderPath: outcome.rememberComposite.interval1.end.headerPath,
              },
              interval2: {
                startCanonical: outcome.rememberComposite.interval2.start.canonical,
                endCanonical: outcome.rememberComposite.interval2.end.canonical,
                startHeaderPath: outcome.rememberComposite.interval2.start.headerPath,
                endHeaderPath: outcome.rememberComposite.interval2.end.headerPath,
              },
              sourceRange: schema.sourceRange,
              sourceVersion: schema.sourceVersion,
            });
          }
          if (outcome.winningEvent) {
            sessionMemoryRef.current = rememberEvent(sessionMemoryRef.current, {
              turnId: acTurnId,
              eventType: "adjacent_period_change",
              metricKey: outcome.winningEvent.metricKey,
              startCanonical: outcome.winningEvent.startPeriod.canonical,
              endCanonical: outcome.winningEvent.endPeriod.canonical,
              startHeaderPath: outcome.winningEvent.startPeriod.headerPath,
              endHeaderPath: outcome.winningEvent.endPeriod.headerPath,
              startValue: outcome.winningEvent.startValue,
              endValue: outcome.winningEvent.endValue,
              absoluteChange: outcome.winningEvent.absoluteChange,
              percentageChange: outcome.winningEvent.percentageChange,
              sourceCells: [outcome.winningEvent.startCell, outcome.winningEvent.endCell],
              sourceRange: schema.sourceRange,
              sourceVersion: schema.sourceVersion,
            });
          }
          if (outcome.directionChangeWinner) {
            sessionMemoryRef.current = rememberDirectionChange(sessionMemoryRef.current, {
              turnId: acTurnId,
              metricKey: outcome.directionChangeWinner.metricKey,
              directionChangeCount: outcome.directionChangeWinner.count,
              events: outcome.directionChangeWinner.events.map((e) => ({
                pivotCanonical: e.pivotCanonical,
                pivotHeaderPath: e.pivotHeaderPath,
                previousDirection: e.previousDirection,
                nextDirection: e.nextDirection,
                sourceCell: e.sourceCell,
              })),
              sourceRange: schema.sourceRange,
              sourceVersion: schema.sourceVersion,
            });
          }
          if (outcome.metricSetLabels && outcome.metricSetLabels.length > 0) {
            sessionMemoryRef.current = rememberMetricSet(sessionMemoryRef.current, {
              turnId: acTurnId,
              metricKeys: outcome.metricSetLabels,
              origin: outcome.metricSetOrigin ?? "derived_analysis",
              sourceRange: schema.sourceRange,
              sourceVersion: schema.sourceVersion,
            });
          }
          if (outcome.resultSet) {
            sessionMemoryRef.current = rememberResultSet(sessionMemoryRef.current, {
              turnId: acTurnId,
              operation: outcome.resultSet.operation,
              scoreField: outcome.resultSet.scoreField,
              rows: outcome.resultSet.rows,
              sourceRange: schema.sourceRange,
              sourceVersion: schema.sourceVersion,
            });
          }
          if (outcome.focusMetricKey) {
            sessionMemoryRef.current = rememberMetricFocus(sessionMemoryRef.current, {
              metricKey: outcome.focusMetricKey,
              sourceRange: schema.sourceRange,
              sourceVersion: schema.sourceVersion,
            });
          }
          acTrace.analyticalCompiler = { ...toTraceField(outcome.trace), ...(sessionMemoryRef.current.lastResultId ? { resultId: sessionMemoryRef.current.lastResultId } : {}) };
          acTrace.outcome = "analytical_result";
          commitTrace(acTrace);
          append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
          return "handled";
        } catch (error) {
          if (!committed) return "flat";
          append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "Could not run that analysis" });
          return "handled";
        } finally {
          if (committed) setBusy(false);
        }
      };

      // ----- Stage 24.3A / 24.5: autonomous bounded cross-sheet comparison -
      const numericHeadersOf = (snap: SelectionSnapshot): Set<string> => {
        const out = new Set<string>();
        const headers = snap.headers ?? [];
        headers.forEach((h, ci) => {
          let n = 0;
          let total = 0;
          for (const row of snap.values.slice(1)) {
            const v = row[ci];
            if (v === null || v === "" || v === undefined) continue;
            total += 1;
            if (typeof v === "number") n += 1;
          }
          if (total > 0 && n / total >= 0.7) out.add(h);
        });
        return out;
      };

      // ----- Stage 24.4: bounded agentic analysis (fallback) ---------------
      const finalizeAgentRun = (state: AgentLoopState, userRequest: string, sourceIdentity?: string): void => {
        if (state.status === "awaiting_clarification" && state.pendingClarification) {
          const pc = state.pendingClarification;
          // Stage 25.1.2 §8/§10 — the model's own clarifying question, never
          // shown raw.
          const question = containsForbiddenLeak(pc.question)
            ? lang === "ru"
              ? "Уточните, пожалуйста, запрос."
              : "Could you clarify the request?"
            : pc.question;
          sessionMemoryRef.current = setClarification(
            sessionMemoryRef.current,
            buildAgentClarification(userRequest, question, pc.candidates, state, sourceIdentity),
          );
          append({ kind: "response", id: nextId("res"), streaming: false, text: question });
          conversationRef.current = [
            ...conversationRef.current,
            { role: "user", content: userRequest },
            { role: "assistant", content: question },
          ];
          return;
        }

        if (state.status === "done" && state.finalAnswer) {
          // §10 — persist the primary tabular observation as a canonical
          // ResultRef in the EXISTING store (no `agentResults`); §5 lineage.
          const primary = [...state.observations]
            .reverse()
            .find((o) => o.ok && o.kind === "table" && o.columns && o.columns.length > 0 && o.rows && o.resultId);
          if (primary && primary.columns && primary.rows) {
            const op = primary.operation ?? "";
            const kind: ResultKind =
              op.startsWith("group_by")
                ? "grouped_table"
                : primary.tool === "compare_aggregates" || primary.tool === "compare_results"
                  ? "comparison"
                  : "table";
            const src = primary.source ?? selectionRef.current?.sheetName ?? "workbook";
            const sheet = src.includes("!") ? src.slice(0, src.indexOf("!")) : src.includes(" vs ") ? src.slice(0, src.indexOf(" vs ")) : src;
            const parents = primary.derivedFrom ?? [];
            // §7/§11 (24.4) — collect the freshness token of EVERY leaf worksheet
            // read in this result's lineage, so a later mutation on the result
            // can be refused if any source changed.
            const versions = collectAgentSourceVersions(primary, state.observations);
            const firstV = versions[0];
            sessionMemoryRef.current = rememberResult(sessionMemoryRef.current, {
              turnId: nextId("turn"),
              kind,
              title: primary.operation ?? userRequest.slice(0, 100),
              spec: { agent: true, operation: primary.operation ?? primary.tool },
              columns: primary.columns,
              rows: primary.rows,
              rowsTruncated: primary.truncated ?? false,
              facts: [],
              sourceSheet: firstV ? firstV.sourceRange.split("!")[0] ?? sheet : sheet,
              sourceRange: firstV ? firstV.sourceRange : primary.source ?? sheet,
              sourceVersion: firstV ? firstV.version : `agent:${primary.source ?? sheet}:${primary.rowCount ?? primary.rows.length}`,
              resolved: [],
              ...(versions.length > 0 ? { sourceVersions: versions } : {}),
              ...(parents.length === 1 ? { derivedFromResultId: parents[0]! } : {}),
              ...(parents.length >= 2 ? { derivedFromResultIds: [...parents] } : {}),
            });
          }

          // §11 — every workbook-derived number in the final answer must be
          // supported by evidence from the observations. If not, fail closed:
          // present the verified canonical table instead of the model's prose.
          const evidence = agentEvidenceFacts(state.observations);
          const rowCounts = state.observations.filter((o) => o.ok && o.rows).map((o) => o.rowCount ?? o.rows!.length);
          const check = validateAgentAnswer(state.finalAnswer, evidence, rowCounts);
          // §15/Stage 25.1.2 §7/§8 — a final answer must never leak internal
          // terminology, legacy-engine execution strings, or raw planner JSON.
          const leaked =
            /\b(ResultRef|RowSetRef|AgentLoop|tool_call|AgentDecision|VerifiedFact|sourceVersion|derivedFrom|model_error|maxAgentSteps|maxWorkbookReads|op#\d)\b/i.test(
              state.finalAnswer,
            ) || containsForbiddenLeak(state.finalAnswer);
          let answer = state.finalAnswer;
          if (!check.ok || leaked) {
            const grid =
              primary && primary.columns && primary.rows
                ? `\n\n${renderGridMarkdown(primary.columns, primary.rows)}`
                : "";
            answer =
              (lang === "ru"
                ? "Я выполнил анализ, но не смог подтвердить все числа в сводке по результатам инструментов. Ниже — проверенная таблица."
                : "I ran the analysis but couldn't verify every figure in the summary against the tool results. Here is the verified table.") + grid;
          }
          append({ kind: "response", id: nextId("res"), streaming: false, text: answer });
          conversationRef.current = [
            ...conversationRef.current,
            { role: "user", content: userRequest },
            { role: "assistant", content: answer },
          ];
          append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
          return;
        }

        // terminated — a safe, bounded message; never unconstrained prose, never a proposal.
        const reason = state.terminationReason;
        const en =
          reason === "model_error" || reason === "repeated_tool_call"
            ? "I couldn't work out a reliable way to answer that. Could you rephrase it or narrow it down?"
            : reason === "read_budget" || reason === "step_budget"
              ? "I couldn't finish investigating this within the limits for one turn. Try narrowing the question to a specific sheet or metric."
              : "I wasn't able to complete that analysis.";
        const ru =
          reason === "model_error" || reason === "repeated_tool_call"
            ? "Не удалось составить надёжный план ответа. Переформулируйте запрос или сузьте его."
            : reason === "read_budget" || reason === "step_budget"
              ? "Не удалось завершить анализ в пределах лимитов за один ход. Уточните вопрос — конкретный лист или показатель."
              : "Не удалось выполнить этот анализ.";
        const body = lang === "ru" ? ru : en;
        append({ kind: "response", id: nextId("res"), streaming: false, text: body });
        conversationRef.current = [
          ...conversationRef.current,
          { role: "user", content: userRequest },
          { role: "assistant", content: body },
        ];
      };

      const runAgentTask = async (
        userRequest: string,
        resume?: { readonly state: AgentLoopState; readonly answer: string },
      ): Promise<void> => {
        recordAnalyticalExecution("stage24_agent");
        const registry = createAgentToolRegistry(); // read-only tools only (no mutation tool exists)
        const deps = createProductionAgentDeps(port, { language: lang === "ru" ? "ru" : "en" });
        const map = await safeBuildMap();
        const workbookContext = buildAgentWorkbookContext(map, selectionRef.current);
        const controller = new AbortController();
        const actId = nextId("act");
        append({ kind: "activity", id: actId, activity: "analyzing", title: uiText(lang, "analyzing"), status: "running" });
        const seenActivity = new Set<string>();
        let state: AgentLoopState;
        try {
          state = await runAgentLoop({
            taskId: nextId("agt"),
            request: userRequest,
            language: lang === "ru" ? "ru" : "en",
            registry,
            deps,
            workbookContext,
            ...(resume ? { resume } : {}),
            decide: (dctx) =>
              chatClient.decideAgentStep!(
                {
                  originalUserRequest: dctx.originalUserRequest,
                  language: dctx.language,
                  history: boundedHistory(conversationRef.current).map((m) => ({ role: m.role, content: m.content })),
                  workbookContext: dctx.workbookContext,
                  toolSchemas: dctx.toolSchemas,
                  observations: dctx.observations,
                  iteration: dctx.iteration,
                  remainingSteps: dctx.remainingSteps,
                  remainingReads: dctx.remainingReads,
                  ...(model ? { model } : {}),
                },
                controller.signal,
              ),
            onStep: (step) => {
              const label = agentActivityLabel(step, lang, seenActivity);
              if (label) append({ kind: "activity", id: nextId("act"), activity: "calculating", title: label, status: "done" });
            },
          });
        } catch (error) {
          setActivity(actId, "error");
          append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "The analysis agent could not run." });
          return;
        }
        setActivity(actId, "done");
        finalizeAgentRun(state, userRequest, map?.sourceIdentity);
      };

      const runCrossSheetComparison = async (forcedFamily?: string): Promise<void> => {
        const map = await safeBuildMap();
        if (!map) {
          say("I couldn't read the workbook structure.", "Не удалось прочитать структуру книги.");
          return;
        }
        const plan = planCrossSheetComparison(map, text, selectionRef.current?.sheetName, forcedFamily);
        if (plan.kind === "no_targets") {
          say("I couldn't work out which two things to compare.", "Не понял, что с чем сравнивать.");
          return;
        }
        if (plan.kind === "budget") {
          say(
            "I found several possible datasets, but comparing all of them would exceed the current workbook analysis limit. Tell me which dataset to compare.",
            "Нашёл несколько наборов данных, но сравнить их все — за пределами текущего лимита анализа. Укажите, какой набор сравнивать.",
          );
          return;
        }
        if (plan.kind === "missing") {
          say(
            `I can compare "${plan.found}" and "${plan.missing}", but I only found "${plan.found}" data in this workbook. If the "${plan.missing}" data is elsewhere, tell me the sheet or select it.`,
            `Могу сравнить «${plan.found}» и «${plan.missing}», но в книге есть только данные «${plan.found}». Если данные «${plan.missing}» в другом месте — укажите лист или выделите его.`,
          );
          return;
        }
        if (plan.kind === "dataset_ambiguous") {
          // 24.4 §8 — more than one comparable dataset family: hand the whole
          // request to the bounded agent, which re-discovers the candidates and
          // asks a `PendingAgentClarification`. Falls back to the deterministic
          // dataset clarification when the agent transport is unavailable.
          if (typeof chatClient.decideAgentStep === "function") {
            await runAgentTask(text);
            return;
          }
          sessionMemoryRef.current = setClarification(sessionMemoryRef.current, buildDatasetClarification(text, plan.candidates, lang));
          append({ kind: "response", id: nextId("res"), streaming: false, text: sessionMemoryRef.current.pendingClarification!.question });
          return;
        }
        const sa = map.sheets.find((s) => s.name === plan.sheetA);
        const sb = map.sheets.find((s) => s.name === plan.sheetB);
        if (!sa?.usedAddress || !sb?.usedAddress) {
          say("One of those sheets is empty — there's nothing to compare.", "Один из листов пуст — сравнивать нечего.");
          return;
        }
        const [snapA, snapB] = await Promise.all([
          readAddressSnapshot(port, sa.usedAddress).catch(() => null),
          readAddressSnapshot(port, sb.usedAddress).catch(() => null),
        ]);
        if (!snapA || !snapB) {
          say("I couldn't read one of those sheets.", "Не удалось прочитать один из листов.");
          return;
        }
        let metric = plan.metric;
        if (!metric) {
          const common = commonNumericColumns(snapA.headers ?? [], snapB.headers ?? [], numericHeadersOf(snapA), numericHeadersOf(snapB));
          if (common.length === 0) {
            say(
              `I found "${plan.sheetA}" and "${plan.sheetB}", but they don't share a numeric column to compare. Tell me which column.`,
              `Нашёл «${plan.sheetA}» и «${plan.sheetB}», но у них нет общего числового столбца. Укажите столбец.`,
            );
            return;
          }
          if (common.length > 1) {
            sessionMemoryRef.current = setClarification(
              sessionMemoryRef.current,
              buildColumnClarification(text, lang === "ru" ? "столбец" : "column", common, lang),
            );
            append({ kind: "response", id: nextId("res"), streaming: false, text: sessionMemoryRef.current.pendingClarification!.question });
            return;
          }
          metric = common[0]!;
        }
        const report = buildCompareReport({ metric, sheetA: plan.sheetA, sheetB: plan.sheetB }, plan.sheetA, plan.sheetB, snapA, snapB, lang);
        const compareBody = isCompareError(report) ? report.error : report.text;
        append({ kind: "response", id: nextId("res"), streaming: false, text: compareBody });
        conversationRef.current = [
          ...conversationRef.current,
          { role: "user", content: text },
          { role: "assistant", content: compareBody },
        ];
      };

      // ----- Stage 24.6A: resume the original request from a short answer ----
      const resumeFromClarification = async (
        p: PendingClarification,
        choices: readonly string[],
      ): Promise<boolean> => {
        sessionMemoryRef.current = clearClarification(sessionMemoryRef.current);
        if (p.kind === "agent") {
          // 24.4 §7 — resume the SAME agent task with the user's answer.
          const cont = p.agentContinuation as AgentLoopState | undefined;
          if (!cont) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Не удалось возобновить прошлый анализ." : "I couldn't resume that earlier analysis." });
            return true;
          }
          // §13 — do not blindly resume a stale continuation.
          if (p.sourceIdentity) {
            const map = await safeBuildMap();
            if (map && map.sourceIdentity !== p.sourceIdentity) {
              append({
                kind: "response",
                id: nextId("res"),
                streaming: false,
                text:
                  lang === "ru"
                    ? "Книга изменилась с момента вопроса — задайте его снова."
                    : "The workbook changed since I asked that — please ask again.",
              });
              return true;
            }
          }
          await runAgentTask(p.originalPrompt, { state: cont, answer: choices[0] ?? "" });
          return true;
        }
        if (p.kind === "analytical_agent") {
          // Stage 25.1.3 §15–§19 — resume the SAME Stage 25 analytical
          // planner run (never the flat legacy agent — a different tool
          // registry entirely) with the user's short slot-filling answer.
          // The suspended request IS `cont.originalUserRequest` plus its
          // accumulated observations/steps — no separate parallel state.
          const cont = p.agentContinuation as AgentLoopState | undefined;
          if (!cont) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Не удалось возобновить прошлый анализ." : "I couldn't resume that earlier analysis." });
            return true;
          }
          const known = sessionMemoryRef.current.lastAnalyticalTable;
          if (!known) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Не удалось возобновить прошлый анализ — таблица больше не выделена." : "I couldn't resume that earlier analysis — the table isn't in view any more." });
            return true;
          }
          const freshSnap = await readAddressSnapshot(port, known.sourceRange).catch(() => undefined);
          if (!freshSnap) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Не удалось прочитать таблицу заново." : "I couldn't re-read that table." });
            return true;
          }
          // §20/§21 — freshness is THIS RANGE's own version, never the
          // whole-workbook identity: a mutation elsewhere, a clarification
          // round-trip, or a planner retry must never invalidate it.
          if (p.sourceIdentity && sourceVersionOf(freshSnap) !== p.sourceIdentity) {
            append({
              kind: "response",
              id: nextId("res"),
              streaming: false,
              text: lang === "ru" ? "Таблица изменилась с момента вопроса — задайте его снова." : "That table changed since I asked that — please ask again.",
            });
            return true;
          }
          let resumeStartsBelowRow1 = false;
          try {
            const { localAddress } = splitSheetAddress(freshSnap.address);
            resumeStartsBelowRow1 = parseLocalRange(localAddress || freshSnap.address).start.row > 0;
          } catch {
            /* keep false */
          }
          const resumeSchema = induceTableSchema({
            values: freshSnap.values,
            numberFormats: freshSnap.numberFormats,
            formulas: freshSnap.formulas,
            sheetName: freshSnap.sheetName,
            sourceRange: freshSnap.address,
            sourceVersion: sourceVersionOf(freshSnap),
            startsBelowRow1: resumeStartsBelowRow1,
          });
          const resumeGrids: AnalysisGrids = { values: freshSnap.values, numberFormats: freshSnap.numberFormats };
          selectionRef.current = freshSnap;
          await runStage25Planner(resumeSchema, resumeGrids, p.originalPrompt, { state: cont, answer: choices[0] ?? "" });
          append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
          return true;
        }
        if (p.kind === "schema_norm" || p.kind === "schema_threshold") {
          // 24.6.1 — `interpretClarificationAnswer` already resolved the answer to
          // a clean marker: "statistical" | "threshold" | "threshold:<num>".
          const marker = (choices[0] ?? "").toLowerCase();
          const src = (label: string): string | undefined => p.observations.find((o) => o.label === label)?.text;
          if (marker === "statistical") {
            text = `${p.originalPrompt} — считать статистическими выбросами`;
            suppressCommandEcho = true;
            await runSchemaRoute(text, detectSchemaIntent(text));
            return true;
          }
          const tm = /^threshold(?::(\d+(?:\.\d+)?))?$/.exec(marker);
          if (tm && tm[1]) {
            text = `${p.originalPrompt} — порог ${tm[1]}`;
            suppressCommandEcho = true;
            await runSchemaRoute(text, detectSchemaIntent(text));
            return true;
          }
          // "threshold" with no number → ask for the value (a second clarification).
          sessionMemoryRef.current = setClarification(
            sessionMemoryRef.current,
            buildSchemaThresholdClarification(p.originalPrompt, src("sourceRange") ?? "", src("sourceVersion") ?? "", lang),
          );
          append({ kind: "response", id: nextId("res"), streaming: false, text: sessionMemoryRef.current.pendingClarification!.question });
          return true;
        }
        if (p.kind === "analysis_subject") {
          // 24.7 §45 — the user picked which metric; re-compile the SAME request
          // with the choice as the subject override. Never re-route elsewhere.
          const choice = choices[0] ?? "";
          suppressCommandEcho = true;
          const handled = await runAnalyticalRoute(p.originalPrompt, choice);
          if (handled === "flat") {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Не удалось выполнить этот анализ." : "I couldn't run that analysis." });
          }
          return true;
        }
        if (p.kind === "analysis_period") {
          // 24.7.1 §21/§22 — the user picked which period/horizon to check the
          // change over. Re-compile the SAME request with that phrase appended
          // so the intent parser's relative-period regex resolves it.
          const choice = choices[0] ?? "";
          suppressCommandEcho = true;
          const handled = await runAnalyticalRoute(`${p.originalPrompt} ${choice}`);
          if (handled === "flat") {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Не удалось выполнить этот анализ." : "I couldn't run that analysis." });
          }
          return true;
        }
        if (p.kind === "entity_action") {
          // 24.5 §15 — the user picked which entity column to act on. Ground it
          // to source rows and propose the highlight / copy. No model call.
          const ref = findResult(p.targetIds?.[0]);
          const ea = p.entityAction;
          if (!ref || !ea) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Этот результат больше недоступен." : "That result isn't available any more." });
            return true;
          }
          const chosen = choices[0] ?? "";
          const colIdx = ref.columns.findIndex((c) => c.toLowerCase() === chosen.toLowerCase());
          if (colIdx < 0) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Не нашёл такой столбец в результате." : "That column isn't in the result." });
            return true;
          }
          if (!(await resultIsFresh(ref))) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? STALE_RU : STALE_EN });
            return true;
          }
          const es = extractEntitySet({ columns: [ref.columns[colIdx]!], rows: ref.rows.map((r) => [r[colIdx] ?? null]) });
          const values = es.kind === "set" ? es.values : [];
          const grounded = await groundEntitiesToRows(port, {
            sourceRange: ref.sourceRange,
            sourceVersion: ref.sourceVersion,
            entityColumn: ref.columns[colIdx]!,
            entityValues: values,
          });
          if (!grounded.ok || grounded.sheetRows.length === 0) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Не удалось сопоставить строки в исходных данных." : "I couldn't match those to source rows." });
            return true;
          }
          if (grounded.unmatchedValues.length > 0) {
            append({
              kind: "response",
              id: nextId("res"),
              streaming: false,
              text:
                lang === "ru"
                  ? `Сопоставил: ${grounded.matchedValues.join(", ")}, не нашёл: ${grounded.unmatchedValues.join(", ")}. Ничего не изменено.`
                  : `Matched ${grounded.matchedValues.join(", ")}, could not find ${grounded.unmatchedValues.join(", ")}. Nothing has been changed.`,
            });
            return true;
          }
          sessionMemoryRef.current = rememberRowSet(sessionMemoryRef.current, {
            turnId: nextId("turn"),
            sourceSheet: grounded.sourceSheet,
            sourceRange: grounded.sourceRange,
            sourceVersion: grounded.sourceVersion,
            sheetRows: grounded.sheetRows.slice(0, 500),
            describe: `${grounded.entityColumn} IN (${values.map(String).join(", ")})`,
            count: grounded.sheetRows.length,
            truncated: grounded.sheetRows.length > 500,
            columns: grounded.columns,
            rows: grounded.rows.slice(0, 200),
            conditionSpec: { entityColumn: grounded.entityColumn, entityValues: values.map(String), mode: "in" },
            fromResultId: ref.id,
          });
          const rs = sessionMemoryRef.current.lastRowSet!;
          const built = buildHighlightRowSetActions(rs, ea.colorHex ?? DEFAULT_HIGHLIGHT_COLOR);
          if (isCompileError(built)) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? `Не получится выделить — ${built.error}.` : `I can't highlight those — ${built.error}.` });
            return true;
          }
          append({
            kind: "response",
            id: nextId("res"),
            streaming: false,
            text:
              lang === "ru"
                ? `Найдено ${rs.count} строк для ${values.map(String).join(", ")}. Подтвердите изменение, чтобы применить.`
                : `Found ${rs.count} row(s) for ${values.map(String).join(", ")}. Approve the change to apply it.`,
          });
          append({ kind: "proposal", id: nextId("prop"), actions: built.actions, state: "pending" });
          append({ kind: "activity", id: nextId("act"), activity: "waiting_for_approval", title: t(lang, "ua.awaitingApproval", { n: built.actions.length }), status: "running" });
          return true;
        }
        if (p.kind === "chart_columns") {
          // 24.3.1 — rebuild ChartData from the SAME ResultRef with the chosen
          // columns. Zero workbook reads, zero model calls.
          const ref = findResult(p.targetIds?.[0]);
          if (!ref) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Этот результат больше недоступен." : "That result isn't available any more." });
            return true;
          }
          const outcome = resultToChartData(ref, lang, choices);
          if (outcome.kind !== "chart") {
            append({
              kind: "response",
              id: nextId("res"),
              streaming: false,
              text:
                lang === "ru"
                  ? `Не удалось построить график по этим столбцам${outcome.kind === "error" ? ` — ${outcome.error}` : ""}.`
                  : `I couldn't build a chart from those columns${outcome.kind === "error" ? ` — ${outcome.error}` : ""}.`,
            });
            return true;
          }
          append({ kind: "chart", id: nextId("cht"), data: outcome.chart });
          sessionMemoryRef.current = rememberChart(sessionMemoryRef.current, { turnId: nextId("turn"), data: outcome.chart, fromResultId: ref.id });
          const line =
            lang === "ru"
              ? `Готово — график по результату «${ref.title}» показан в панели.`
              : `Here's a chart of "${ref.title}", shown in the panel.`;
          append({ kind: "response", id: nextId("res"), streaming: false, text: line });
          conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: line }];
          return true;
        }
        if (p.kind === "reference_ambiguous") {
          const idx = p.candidates.findIndex((c) => choices.includes(c));
          const ref = findResult(p.targetIds?.[idx >= 0 ? idx : 0]);
          if (!ref) {
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Этот результат больше недоступен." : "That result isn't available any more." });
            return true;
          }
          const det = detectResultTransform(p.originalPrompt, ref);
          if (det.kind === "transform") { emitTransform(ref, det.transform, p.originalPrompt); return true; }
          if (det.kind === "column_ambiguous") {
            sessionMemoryRef.current = setClarification(sessionMemoryRef.current, buildColumnClarification(p.originalPrompt, det.term, det.candidates, lang, { resultId: ref.id }));
            append({ kind: "response", id: nextId("res"), streaming: false, text: sessionMemoryRef.current.pendingClarification!.question });
            return true;
          }
          text = p.originalPrompt;
          suppressCommandEcho = true;
          return false;
        }
        if (p.kind === "column_ambiguous") {
          const choice = choices[0] ?? "";
          const ref = findResult(p.targetIds?.[0]);
          if (ref) {
            const det = detectResultTransform(p.originalPrompt, ref, choice);
            if (det.kind === "transform") { emitTransform(ref, det.transform, p.originalPrompt); return true; }
            append({ kind: "response", id: nextId("res"), streaming: false, text: lang === "ru" ? "Не удалось применить выбранный столбец к прошлому результату." : "I couldn't apply that column to the earlier result." });
            return true;
          }
          text = p.term
            ? p.originalPrompt.replace(new RegExp(escapeRegExp(p.term), "gi"), choices.join(lang === "ru" ? " и " : " and "))
            : `${p.originalPrompt} (${choice})`;
          append({ kind: "activity", id: nextId("act"), activity: "completed", title: (lang === "ru" ? "Продолжаю: " : "Resuming: ") + text, status: "done" });
          suppressCommandEcho = true;
          return false;
        }
        if (p.kind === "dataset_ambiguous") {
          // 24.3D — resume the ORIGINAL comparison with the chosen dataset family.
          text = p.originalPrompt;
          append({ kind: "activity", id: nextId("act"), activity: "completed", title: (lang === "ru" ? "Продолжаю сравнение" : "Resuming the comparison"), status: "done" });
          await runCrossSheetComparison(choices[0]);
          return true;
        }
        // missing_data / other — re-drive the original request.
        text = `${p.originalPrompt} (${choices.join(", ")})`;
        append({ kind: "activity", id: nextId("act"), activity: "completed", title: (lang === "ru" ? "Продолжаю: " : "Resuming: ") + text, status: "done" });
        suppressCommandEcho = true;
        return false;
      };

      // ----- Stage 26.8 §4–§21: THE UNIFIED ANALYTICAL ENGINE (V2) ---------
      //
      // One decision, in front of every analytical route this file contains.
      // The §3 audit counted eleven branches below that can answer a question
      // about a table; §4 says exactly one engine may own a turn, so V2 is not
      // inserted among them — it is asked FIRST, and when it answers "mine",
      // none of them runs at all.
      //
      // §11 — and it does not hand a turn back. Once V2 owns a turn its
      // failures are V2's failures and the user sees a V2 message; sending the
      // same request on to Stage 24/25 would make every V2 defect invisible,
      // which is the one thing human testing cannot afford.

      /** Set when the live selection is a table V2 does not analyse (§6/§39). */
      let v2SelectionIsForeign = false;

      /** §14 — the table identity V2 analyses: the live selection, or its own memory. */
      const resolveV2Table = async (): Promise<{ readonly schema: TableSchema; readonly grids: AnalysisGrids; readonly snap: SelectionSnapshot } | null> => {
        const induce = (snap: SelectionSnapshot): TableSchema => {
          let startsBelowRow1 = false;
          try {
            const { localAddress } = splitSheetAddress(snap.address);
            startsBelowRow1 = parseLocalRange(localAddress || snap.address).start.row > 0;
          } catch {
            /* keep false */
          }
          return induceTableSchema({
            values: snap.values,
            numberFormats: snap.numberFormats,
            formulas: snap.formulas,
            sheetName: snap.sheetName,
            // §14 — the canonical RANGE identity, never the active cell.
            sourceRange: snap.address,
            sourceVersion: sourceVersionOf(snap),
            startsBelowRow1,
          });
        };
        const usable = (snap: SelectionSnapshot | undefined, schema: TableSchema | undefined): schema is TableSchema =>
          Boolean(snap && schema && schema.orientation !== "row_records" && schema.confidence >= 0.5);

        let snap: SelectionSnapshot | undefined;
        try {
          snap = await readSelectionSnapshot(port);
        } catch {
          snap = undefined;
        }
        let schema = snap ? induce(snap) : undefined;
        // A flat records list under the cursor is Stage 24's, not V2's — and
        // saying so here is what stops V2's own remembered table from pulling
        // the turn back below.
        v2SelectionIsForeign = Boolean(
          schema &&
            schema.orientation === "row_records" &&
            schema.confidence >= 0.5 &&
            // …and it is an actual TABLE. A single cell inside the table under
            // discussion also induces "records", and treating that as a
            // different table breaks the drift fallback two lines below.
            schema.rowAxis.length >= 3 &&
            (snap?.columnCount ?? 0) >= 2,
        );
        // §15 — SELECTION DRIFT. One cell inside the analysed table does not
        // induce a table of its own; fall back to the range this conversation is
        // already about, which is what keeps the analytical context intact.
        // …and it is also the reason not to reach for the remembered table
        // below: the fallback is for a cell inside the table under discussion,
        // not for a different table the person deliberately selected.
        const known = analyticalStateRef.current.tableRef;
        if (!usable(snap, schema) && !v2SelectionIsForeign && known) {
          const knownSnap = await readAddressSnapshot(port, known.sourceRange).catch(() => undefined);
          if (knownSnap) {
            const knownSchema = induce(knownSnap);
            if (usable(knownSnap, knownSchema)) {
              snap = knownSnap;
              schema = knownSchema;
            }
          }
        }
        if (!usable(snap, schema)) return null;
        return { schema, grids: { values: snap!.values, numberFormats: snap!.numberFormats }, snap: snap! };
      };

      const runUnifiedEngineV2 = async (
        v2Text: string,
        table: { readonly schema: TableSchema; readonly grids: AnalysisGrids; readonly snap: SelectionSnapshot } | null,
      ): Promise<void> => {
        setLanguage(lang);
        setBusy(true);
        append({ kind: "command", id: nextId("cmd"), text: v2Text });
        recordAnalyticalExecution("analytical_engine_v2");
        const seq = (turnSeqRef.current += 1);
        const language: ResponseLanguage = lang === "ru" ? "ru" : "en";
        const say = (body: string, outcome: "answered" | "clarify" | "failed", v2TurnId?: string): void => {
          append({ kind: "response", id: nextId("res"), streaming: false, text: body });
          conversationRef.current = [...conversationRef.current, { role: "user", content: v2Text }, { role: "assistant", content: body }];
          finishTurn(outcome, v2TurnId);
        };

        try {
          if (!table) {
            // §11/§14 — V2 owns this turn (the conversation is analytical and has
            // a table behind it) but this message could not be tied to one. That
            // is a V2 answer, not a reason to restart the cascade.
            say(
              language === "ru"
                ? "Не удалось определить таблицу для анализа — выделите диапазон с данными и повторите вопрос."
                : "I couldn't work out which table to analyse — select the data range and ask again.",
              "failed",
            );
            return;
          }
          selectionRef.current = table.snap;

          const turnStarted = Date.now();
          setTurnStartedAt(turnStarted);
          let openStep: { readonly id: string; readonly title: string } | null = null;
          const timeline: { readonly id: string; detail: ExecutionDetail }[] = [];
          const liveExecutionId = nextId("exec");
          const liveTitle = language === "ru" ? "Выполняю анализ" : "Running analysis";
          const refreshExecution = (status: "running" | "done" | "error", title = liveTitle, timings: ExecutionTimings | null = null): void => {
            setEntries((current) =>
              current.map((entry) =>
                entry.id === liveExecutionId && entry.kind === "execution"
                  ? {
                      ...entry,
                      status,
                      title,
                      details: timeline.map((item) => item.detail),
                      metrics: timings ? executionMetrics(timings, language) : entry.metrics,
                    }
                  : entry,
              ),
            );
          };
          append({ kind: "execution", id: liveExecutionId, title: liveTitle, status: "running", details: [], metrics: [] });
          const recordStep = (id: string, detail: ExecutionDetail): void => {
            timeline.push({ id, detail });
            refreshExecution("running");
          };
          const closeOpenStep = (): void => {
            if (openStep) {
              const id = openStep.id;
              const record = timeline.find((t) => t.id === id);
              if (record && record.detail.kind === "step") record.detail = { ...record.detail, status: "done" };
              refreshExecution("running");
            }
            openStep = null;
          };
          const onProgress = (event: ExecutionEvent): void => {
            if (seq !== turnSeqRef.current) return;
            const step = progressStepFor(event, language);
            if (!step) return;
            if (step.kind === "code") {
              closeOpenStep();
              const codeId = nextId("code");
              recordStep(codeId, { kind: "code", title: step.title, code: step.code, attempt: step.attempt });
              return;
            }
            if (step.status === "running" && openStep?.title === step.title) return;
            closeOpenStep();
            const id = nextId("act");
            recordStep(id, {
              kind: "step",
              title: step.title,
              status: step.status,
              ...(step.detail !== undefined ? { detail: step.detail } : {}),
              ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
              ...(step.diagnostics !== undefined ? { diagnostics: step.diagnostics } : {}),
            });
            if (step.status === "running") openStep = { id, title: step.title };
          };
          const collapseTurn = (status: "done" | "error", timings: ExecutionTimings | null): void => {
            closeOpenStep();
            const elapsed = formatSeconds(Date.now() - turnStarted, language);
            const runs = timings?.pythonExecutionCount ?? 0;
            setEntries((current) => current.map((entry) => entry.id === liveExecutionId && entry.kind === "execution" ? {
              ...entry,
              title: status === "error" ? stoppedLabel(elapsed, language) : completionLabel(elapsed, language),
              ...(runs > 0 ? { subtitle: pythonSummaryLabel(runs, language) } : {}),
              status,
              details: timeline.map((item) => item.detail),
              metrics: timings ? executionMetrics(timings, language) : [],
            } : entry));
          };
          onProgress({ kind: "workbook_read", sheet: table.schema.sheetName, range: splitSheetAddress(table.schema.sourceRange).localAddress });

          const controller = new AbortController();
          v2AbortRef.current = controller;
          const turnId = nextId("turn");
          const turn = await runAnalyticalEngine({
            turnId,
            request: v2Text,
            schema: table.schema,
            grids: table.grids,
            language,
            state: analyticalStateRef.current,
            onProgress,
            decide: (messages) => chatClient.planAnalyticalTurn!(messages, controller.signal, model),
            narrate: async (messages) => (typeof chatClient.narrate === "function" ? chatClient.narrate(messages, controller.signal, model) : ""),
            // Stage 27 §4 — the code sandbox, when this host can bound it.
            //
            // `undefined` here is not a degraded mode, it is the honest one:
            // the planner is never told the sandbox exists, and a request that
            // needs one is refused with a capability error rather than
            // answered with a different operation (§5).
            //
            // §69 — the workbook version is read through this callback at the
            // moment the executor needs it, never captured once, so an edit
            // made while an analysis runs is still detected.
            ...(typeof chatClient.generateAnalysisCode === "function"
              ? (() => {
                  const analysis = analysisCapability({
                    generateCode: (messages) => chatClient.generateAnalysisCode!(messages, controller.signal, model),
                    // Stage 27.2A §2 — the iterative loop's decision channel.
                    // Present only when the transport offers it; the engine's
                    // own flag decides whether it is used at all.
                    ...(typeof chatClient.decideAnalysisStep === "function"
                      ? { decideStep: (messages: readonly { readonly role: "system" | "user"; readonly content: string }[]) => chatClient.decideAnalysisStep!(messages, controller.signal, model) }
                      : {}),
                    // §36/§37 — the trace goes to the DEBUG ring and nowhere
                    // else. Nothing on the answer path can reach it, which is
                    // what keeps a NameError out of a user's reply.
                    onTrace: (trace) => {
                      recordAgentTrace({
                        turnId: String(seq),
                        request: text,
                        text: trace.text,
                        at: Date.now(),
                        rounds: trace.metrics.decisionRounds,
                        codeExecutions: trace.metrics.codeExecutions,
                        executionErrors: trace.metrics.executionErrors,
                        recovered: trace.metrics.selfRecoverySuccess,
                      });
                    },
                    currentSourceVersion: () =>
                      selectionRef.current ? sourceVersionOf(selectionRef.current) : table.schema.sourceVersion,
                  });
                  return analysis ? { analysis } : {};
                })()
              : {}),
          });

          // §21 — a cancelled turn appends nothing. `reset` bumps the sequence and
          // aborts the transport; whatever arrives afterwards belongs to a chat
          // that no longer exists, and the state it computed is dropped with it.
          if (seq !== turnSeqRef.current) return;
          closeOpenStep();
          recordTurnTimings(turn.timings);

          if (turn.kind === "answered") {
            // §12/§17 — the conversation's state is whatever the ENGINE committed
            // from its verified execution. The task pane stores it; never edits it.
            analyticalStateRef.current = turn.state;
            // §18 — the last gate. A body carrying a result id, a decision key or
            // a typed error code was built from an internal string somewhere, and
            // is replaced rather than shown.
            const clean = containsInternalLeak(turn.body) ? leakReplacement(turn.analysis, language) : turn.body;
            const body = [clean, turn.usedFallback ? fallbackNote(language) : "", provenanceLine(table.schema.sheetName, table.schema.sourceRange, language)]
              .filter((p) => p !== "")
              .join("\n\n");
            // §36/§37 — the ONE typed handoff between the two worlds.
            //
            // V2 is read-only, and a mutation stays on the deterministic
            // Preview → Approve → Execute → Undo path. So the bridge is the
            // shape Stage 24 already acts on: the verified primary result,
            // committed as a ResultRef, so a FOLLOW-UP mutation ("выдели их
            // красным") has something real to act on. No Office.js call is ever
            // constructed by the model, and nothing about this turn mutated the
            // workbook — the next turn asks for that, explicitly, and gets a
            // Preview it must approve.
            sessionMemoryRef.current = rememberResult(sessionMemoryRef.current, {
              turnId,
              kind: "temporal_analysis",
              title: turn.analysis.primary.tool,
              spec: { op: "analytical_engine_v2", tool: turn.analysis.primary.tool },
              columns: turn.analysis.primary.fields.map((f) => f.name),
              rows: turn.analysis.primary.rows.map((r) => r.map((c) => c as CellValue)),
              rowsTruncated: false,
              facts: [],
              sourceSheet: table.schema.sheetName,
              sourceRange: table.schema.sourceRange,
              sourceVersion: table.schema.sourceVersion,
              resolved: [],
            });
            collapseTurn("done", turn.timings);
            say(body, "answered", turnId);
            return;
          }

          if (turn.kind === "clarify") {
            // §29 — an exhausted clarification loop still returns the state, but
            // the engine has already declined to suspend anything: the next
            // message starts clean instead of feeding the loop again.
            analyticalStateRef.current = turn.state;
            const question = containsInternalLeak(turn.question)
              ? language === "ru"
                ? "Уточните, пожалуйста, какой показатель и за какой период вас интересует."
                : "Could you say which indicator and which period you mean?"
              : turn.question;
            collapseTurn("done", turn.timings);
            say(question, "clarify", turnId);
            return;
          }

          // §11/§32 — a clean bounded failure, phrased for a person. The
          // conversation state is untouched, so the next turn still has whatever
          // the last successful one established.
          const analysisFailure = turn.trace.analysisFailure;
          collapseTurn("error", turn.timings);
          say(
            turn.reason === "analysis_unavailable" && analysisFailure
              ? sandboxFailureMessage(
                  {
                    attempts: analysisFailure.attempts,
                    ...(analysisFailure.objective !== undefined ? { objective: analysisFailure.objective } : {}),
                    code: analysisFailure.code,
                  },
                  language,
                )
              : v2FailureMessage(turn.reason, language),
            "failed",
            turnId,
          );
        } catch (error) {
          if (seq !== turnSeqRef.current) return;
          say(
            error instanceof Error && error.name === "AbortError"
              ? language === "ru"
                ? "Запрос отменён."
                : "Request cancelled."
              : v2FailureMessage("model_error", language),
            "failed",
          );
        } finally {
          if (seq === turnSeqRef.current) {
            v2AbortRef.current = null;
            setBusy(false);
            setTurnStartedAt(null);
          }
        }
      };

      // §4 — the ownership decision itself. Cheap checks first; the table is
      // resolved only for a turn that has already passed every one of them, and
      // a turn that resolves no table AND has no analytical table behind it was
      // never accepted, so continuing the cascade is not a §11 fallback.
      {
        const v2Slash = resolveSlashSubmission(text);
        // The Stage 24 result a transform would act on, if there is one.
        const v2LastV1Result =
          sessionMemoryRef.current.recentResults.find((r) => r.id === sessionMemoryRef.current.lastResultId) ??
          sessionMemoryRef.current.recentResults[sessionMemoryRef.current.recentResults.length - 1];
        const v2Route = routeTurn(text, {
          hasSelection: Boolean(selectionRef.current),
          knownEntities: [],
          hasPriorResult: sessionMemoryRef.current.recentResults.length > 0,
        });
        const ownerCtx = {
          flagEnabled: unifiedAnalyticalEngineV2Enabled(),
          canPlan: typeof chatClient.planAnalyticalTurn === "function",
          isSlash: v2Slash !== null,
          isUndo: isUndoPhrase(text),
          hasResultAction: detectResultAction(text) !== null,
          isMutation: isMutationRequest(text),
          isResultTransform: v2LastV1Result !== undefined && detectResultTransform(text, v2LastV1Result).kind === "transform",
          hasV1Result: sessionMemoryRef.current.recentResults.length > 0,
          v1ClarificationPending: Boolean(sessionMemoryRef.current.pendingClarification),
          v2ClarificationPending: Boolean(analyticalStateRef.current.suspended),
          // A message is the ANSWER to an outstanding question when it is not a
          // turn in its own right. A short reply ("20%", "за первый квартал")
          // routes as general chat and carries no request; anything that routes
          // as analysis, structure or a mutation is the person moving on.
          isTopicSwitch:
            isConceptQuestion(text) ||
            isMutationRequest(text) ||
            detectResultAction(text) !== null ||
            (v2Route.route !== "general_chat" && text.trim().split(/\s+/).length >= 4),
          hasV2Table: Boolean(analyticalStateRef.current.tableRef),
          isConceptQuestion: isConceptQuestion(text),
          hasWorkbookDeixis: hasWorkbookDeixis(text),
          // §5 — capability, from the classifiers this file ALREADY routes by.
          // `routeTurn`'s own "workbook_analysis" is the broadest of them and
          // the reason this is not a phrase list: it is the same judgement the
          // Stage 24 cascade makes about whether a turn is analysis at all.
          isAnalytical:
            v2Route.route === "workbook_analysis" ||
            detectAnalyticalIntent(text).any ||
            classifyIntent(text).analytical ||
            isExploratoryRequest(text),
          isAnalyticalFollowUp: isAnalyticalFollowUp(text),
          route: v2Route,
        };
        const provisional = classifyTurnOwner({ ...ownerCtx, hasTable: true, selectionIsForeign: false });
        if (provisional.owner === "V2_OWNED") {
          const v2Table = await resolveV2Table();
          const decision = classifyTurnOwner({ ...ownerCtx, hasTable: v2Table !== null, selectionIsForeign: v2SelectionIsForeign });
          if (decision.dropSuspension) analyticalStateRef.current = withoutSuspension(analyticalStateRef.current);
          if (decision.owner === "V2_OWNED") {
            beginTurn(nextId("uturn"), text, decision.owner, decision.reason);
            await runUnifiedEngineV2(text, v2Table);
            return;
          }
          beginTurn(nextId("uturn"), text, decision.owner, decision.reason);
        } else {
          if (provisional.dropSuspension) analyticalStateRef.current = withoutSuspension(analyticalStateRef.current);
          beginTurn(nextId("uturn"), text, provisional.owner, provisional.reason);
        }
      }

      // ----- Stage 24.6: pending-clarification interception -----------------
      const pending = sessionMemoryRef.current.pendingClarification;
      if (pending && !text.startsWith("/")) {
        const answer = interpretClarificationAnswer(text, pending);
        if (answer.kind === "cancel") {
          sessionMemoryRef.current = clearClarification(sessionMemoryRef.current);
          setLanguage(lang);
          append({ kind: "command", id: nextId("cmd"), text });
          append({
            kind: "response",
            id: nextId("res"),
            streaming: false,
            text: lang === "ru" ? "Хорошо, отложил этот вопрос." : "Okay — I've set that question aside.",
          });
          return;
        }
        if (answer.kind === "choice") {
          setLanguage(lang);
          append({ kind: "command", id: nextId("cmd"), text });
          const handled = await resumeFromClarification(pending, answer.choices);
          if (handled) return;
          // else: `text` was rewritten; continue through the normal path below.
        } else if (!isUndoPhrase(text)) {
          const probe = routeTurn(text, {
            hasSelection: Boolean(selectionRef.current),
            knownEntities: [],
            hasPriorResult: sessionMemoryRef.current.recentResults.length > 0,
          });
          const topicSwitch =
            probe.route === "general_chat" ||
            probe.route === "workbook_qa" ||
            probe.route === "workbook_mutation" ||
            probe.reasons.includes("analytical-lexicon") ||
            probe.reasons.includes("cross-target-comparison");
          if (topicSwitch) {
            sessionMemoryRef.current = clearClarification(sessionMemoryRef.current);
            append({ kind: "activity", id: nextId("act"), activity: "completed", title: lang === "ru" ? "Прежний вопрос отложен" : "Earlier question set aside", status: "done" });
            // fall through to normal processing of `text`
          } else {
            setLanguage(lang);
            append({ kind: "command", id: nextId("cmd"), text });
            // 24.6.1 §2 — a generic "да / yes" gets a short disambiguation, not a restart.
            const reask =
              pending.kind === "schema_norm"
                ? lang === "ru"
                  ? "Уточните, пожалуйста: статистический выброс или заданный порог?"
                  : "Please clarify: a statistical outlier or a fixed threshold?"
                : pending.question;
            append({ kind: "response", id: nextId("res"), streaming: false, text: reask });
            return;
          }
        }
      }

      // ----- Stage 24: natural-language undo ("undo that" / "отмени это") ---
      // Reuses the existing undo stack — no second undo system.
      if (!text.startsWith("/") && isUndoPhrase(text)) {
        setLanguage(lang);
        append({ kind: "command", id: nextId("cmd"), text });
        if (undoStack.length === 0) {
          append({ kind: "notice", id: nextId("ntc"), tone: "warn", text: t(lang, "slash.nothingToUndo") });
        } else {
          await undoLast();
        }
        return;
      }

      // ----- Stage 22: slash commands ------------------------------------
      const slash = resolveSlashSubmission(text);
      if (slash) {
        setLanguage(lang);
        if (slash.kind === "unknown") {
          append({ kind: "command", id: nextId("cmd"), text });
          append({ kind: "notice", id: nextId("ntc"), tone: "warn", text: t(lang, "slash.unknown", { name: slash.token }) });
          return;
        }
        if (slash.command.route === "undo") {
          append({ kind: "command", id: nextId("cmd"), text });
          if (undoStack.length === 0) {
            append({ kind: "notice", id: nextId("ntc"), tone: "warn", text: t(lang, "slash.nothingToUndo") });
          } else {
            await undoLast();
          }
          return;
        }
        if (slash.command.args === "required" && slash.args.trim() === "") {
          append({ kind: "command", id: nextId("cmd"), text });
          append({ kind: "notice", id: nextId("ntc"), tone: "warn", text: t(lang, "slash.needsArgs", { name: slash.command.label }) });
          return;
        }
      }
      const routedSlash =
        slash && slash.kind === "command" && slash.command.route !== "undo" ? slash : null;

      // ----- Stage 24.2 / 24.3: conversational routing (non-slash turns) ---
      if (!routedSlash && !suppressCommandEcho) {
        const mem = sessionMemoryRef.current;
        const knownEntities = [
          ...mem.resolvedEntities.map((e) => e.name),
          ...mem.recentResults.flatMap((r) => r.columns),
        ];
        const route = routeTurn(text, {
          hasSelection: Boolean(selectionRef.current),
          knownEntities,
          hasPriorResult: mem.recentResults.length > 0,
        });

        // 24.7–24.12 — "chart that" / "highlight those" / "put that on Summary".
        // Checked BEFORE generic reference resolution: a turn that produced both
        // a ResultRef and a RowSetRef would otherwise read "those" as ambiguous.
        const resultAction: ResultActionIntent | null = detectResultAction(text);
        if (resultAction) {
          setLanguage(lang);
          setBusy(true);
          append({ kind: "command", id: nextId("cmd"), text });
          raTraceActive = true;
          raTrace.detectedMutationIntent = true; // a detected result action is always a mutation-intent turn
          raTrace.detectedResultAction = resultAction.kind;
          raTrace.conversationalReferenceDetected = mentionsConversationalReference(text);
          raTrace.routeChosen = "result_action";
          raTrace.memory = {
            ...(mem.lastResultId ? { lastResultId: mem.lastResultId } : {}),
            ...(mem.lastRowSet ? { lastRowSetId: mem.lastRowSet.id } : {}),
            ...(mem.lastChart ? { lastChartId: mem.lastChart.id } : {}),
          };
          try {
            await runResultAction(resultAction);
          } catch (error) {
            raTrace.outcome = "threw";
            append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "Could not prepare that change" });
          } finally {
            commitRaTrace();
            setBusy(false);
          }
          return;
        }

        // Stage 24.8 §20/§21/§40–§43 — EventRef follow-ups resolve DIRECTLY
        // from the stored event, never by re-analysing the workbook. Checked
        // BEFORE the generic analytical route so "покажи его динамику" is
        // never misread as "each metric" (an empty subject with no event).
        const lastEvent = sessionMemoryRef.current.lastEventRef;
        // Stage 24.9 §29/§37 — the GENERALIZED single-metric pronoun target:
        // any producer that pins down one metric (event winner, direction-
        // change winner, resultset top-1, any single-metric analytical query)
        // sets this — "покажи его динамику" never needs a per-operation case.
        const focusMetricKey = sessionMemoryRef.current.lastMetricFocusRef?.metricKey;
        const lastDirectionChange = sessionMemoryRef.current.lastDirectionChangeRef;

        // Stage 24.9 §26–§31 — COMPOUND requests: two independent analytical
        // predicates joined by "и <triggerVerb>", sharing ONE subject. Clause
        // 1 runs first (through whichever path it normally takes — a pronoun
        // follow-up or a fresh analytical query); clause 2 then runs against
        // the resulting focal metric. Neither clause is ever silently dropped
        // (§31) — both render, in order.
        // `\b` is ASCII-only in JS regex — Cyrillic letters are never "word"
        // characters to it, so the trigger verb's own end (letter → comma)
        // never counts as a boundary. A `(?![\p{L}])` lookaround is used
        // instead (the SAME recurring bug class as Stage 24.7.1/24.8).
        const compoundM = /^(.*?)\s+и\s+(?:а\s+также\s+)?(укажи|покажи|сравни|выведи|найди|определи)(?![\p{L}])[,:]?\s*(.*)$/isu.exec(text);
        if (compoundM && compoundM[1]?.trim() && compoundM[3]?.trim()) {
          const clause1Text = compoundM[1]!.trim();
          const clause2Text = `${compoundM[2]} ${compoundM[3]}`.trim();
          const clause1Followup = (lastEvent || focusMetricKey) ? detectEventFollowup(clause1Text) : null;
          const clause1Analytical = detectAnalyticalIntent(clause1Text).any;
          const clause2Analytical = detectAnalyticalIntent(clause2Text).any;
          if ((clause1Followup || clause1Analytical) && clause2Analytical) {
            setLanguage(lang);
            append({ kind: "command", id: nextId("cmd"), text });
            suppressCommandEcho = true;
            let clause1Handled = false;
            if (clause1Followup?.kind === "dynamics") {
              const mk = focusMetricKey ?? lastEvent?.metricKey ?? lastDirectionChange?.metricKey;
              if (mk) clause1Handled = (await runAnalyticalRoute(`Покажи динамику ${mk} по времени.`, mk)) === "handled";
            }
            if (!clause1Handled && clause1Analytical) {
              clause1Handled = (await runAnalyticalRoute(clause1Text)) === "handled";
            }
            const focus2 = sessionMemoryRef.current.lastMetricFocusRef?.metricKey ?? focusMetricKey;
            const clause2Handled = (await runAnalyticalRoute(clause2Text, focus2)) === "handled";
            if (!clause1Handled && !clause2Handled) {
              const msg = lang === "ru" ? "Не удалось выполнить составной запрос." : "I couldn't run that compound request.";
              append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
            }
            return;
          }
        }

        // Stage 24.9 §18/§43 — "В какие периоды он менял направление?" reads
        // the stored DirectionChangeAnalysisRef's events directly.
        if (lastDirectionChange && detectDirectionPeriodsFollowup(text)) {
          setLanguage(lang);
          append({ kind: "command", id: nextId("cmd"), text });
          const lines = lastDirectionChange.events.map((e) => {
            const from = e.previousDirection === "positive" ? (lang === "ru" ? "рост" : "up") : lang === "ru" ? "снижение" : "down";
            const to = e.nextDirection === "positive" ? (lang === "ru" ? "рост" : "up") : lang === "ru" ? "снижение" : "down";
            return `- ${e.pivotHeaderPath}: ${from} → ${to}`;
          });
          const msg =
            lastDirectionChange.events.length > 0
              ? (lang === "ru"
                  ? `Показатель: ${lastDirectionChange.metricKey}\n\nСмена направления:\n${lines.join("\n")}`
                  : `Metric: ${lastDirectionChange.metricKey}\n\nDirection changes:\n${lines.join("\n")}`)
              : lang === "ru"
                ? "Смен направления не найдено."
                : "No direction changes found.";
          append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
          conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: msg }];
          return;
        }

        // Stage 24.9 §5–§7/§35/§39/§69 — "какой из них самый волатильный?"
        // answers from the stored ResultSetRef's order DIRECTLY — never a
        // fresh full-workbook ranking. No compatible prior set → clarify,
        // never infer an arbitrary workbook-wide universe.
        const rsFollowup = detectResultSetFollowup(text);
        if (rsFollowup) {
          setLanguage(lang);
          append({ kind: "command", id: nextId("cmd"), text });
          const rs = sessionMemoryRef.current.lastResultSetRef;
          const winner = rs?.rows[0];
          if (!rs || !winner || (rsFollowup.operationHint && rs.operation !== rsFollowup.operationHint)) {
            const msg = lang === "ru"
              ? "Уточните, к какому предыдущему списку показателей относится «из них» — подходящего результата не нашлось."
              : "Please clarify which earlier list \"of them\" refers to — I couldn't find a matching prior result.";
            append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
            conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: msg }];
            return;
          }
          const msg = lang === "ru" ? `${winner.key} (оценка ${winner.score.toFixed(4)}).` : `${winner.key} (score ${winner.score.toFixed(4)}).`;
          append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
          conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: msg }];
          sessionMemoryRef.current = rememberMetricFocus(sessionMemoryRef.current, {
            metricKey: winner.key,
            sourceRange: rs.sourceRange,
            sourceVersion: rs.sourceVersion,
          });
          return;
        }

        // Stage 24.9 §29 — "покажи его/её динамику" resolves from the SHARED
        // metric-focus authority, not only a prior EventRef.
        // Stage 25.1.3a §1/§3/§5 — SUBJECT RESOLUTION != REQUEST COMPLETION:
        // this shortcut may resolve "его", but when the sentence carries MORE
        // than the one dynamics clause it covers, it must never terminate the
        // turn early — the remaining clause(s) would be silently dropped.
        // Hand the FULL text to the compositional route instead, with the
        // subject already resolved (never re-parsed, never re-asked): Stage
        // 24.x's own multi-clause override (or the Stage 25 planner, via
        // `inherited.metricFocus` — unchanged) then covers every clause.
        const focusDynamicsFollowup = focusMetricKey ? detectEventFollowup(text) : null;
        if (focusDynamicsFollowup?.kind === "dynamics" && focusMetricKey) {
          setLanguage(lang);
          append({ kind: "command", id: nextId("cmd"), text });
          suppressCommandEcho = true;
          const fullyCovered = countAnalyticalClauses(text) <= 1;
          const handled = await runAnalyticalRoute(fullyCovered ? `Покажи динамику ${focusMetricKey} по времени.` : text, focusMetricKey);
          if (handled === "flat") {
            const msg = lang === "ru" ? "Не удалось построить динамику для этого показателя." : "I couldn't build a time series for that metric.";
            append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
          }
          return;
        }

        const eventFollowup = lastEvent ? detectEventFollowup(text) : null;
        if (lastEvent && eventFollowup) {
          setLanguage(lang);
          append({ kind: "command", id: nextId("cmd"), text });
          if (eventFollowup.kind === "when") {
            const msg = lang === "ru"
              ? `Между ${lastEvent.startHeaderPath} и ${lastEvent.endHeaderPath}.`
              : `Between ${lastEvent.startHeaderPath} and ${lastEvent.endHeaderPath}.`;
            append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
            conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: msg }];
            return;
          }
          if (eventFollowup.kind === "magnitude") {
            const pct = lastEvent.percentageChange === null ? "—" : `${(lastEvent.percentageChange * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
            const msg = lang === "ru"
              ? `${lastEvent.metricKey}: Δ абс. ${lastEvent.absoluteChange}, Δ % ${pct} (${lastEvent.startHeaderPath} → ${lastEvent.endHeaderPath}).`
              : `${lastEvent.metricKey}: Δ abs ${lastEvent.absoluteChange}, Δ % ${pct} (${lastEvent.startHeaderPath} → ${lastEvent.endHeaderPath}).`;
            append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
            conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: msg }];
            return;
          }
          if (eventFollowup.kind === "which_metric") {
            const msg = lang === "ru" ? `Это показатель «${lastEvent.metricKey}».` : `That's the metric "${lastEvent.metricKey}".`;
            append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
            conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: msg }];
            return;
          }
          if (eventFollowup.kind === "dynamics") {
            suppressCommandEcho = true;
            // Stage 25.1.3a §1/§3/§5 — same rule as the focus-based shortcut
            // above: never terminate after only the dynamics clause when the
            // sentence carries more analytical clauses than that.
            const fullyCovered = countAnalyticalClauses(text) <= 1;
            const handled = await runAnalyticalRoute(fullyCovered ? `Покажи динамику ${lastEvent.metricKey} по времени.` : text, lastEvent.metricKey);
            if (handled === "flat") {
              const msg = lang === "ru" ? "Не удалось построить динамику для этого показателя." : "I couldn't build a time series for that metric.";
              append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
            }
            return;
          }
          // "before" / "after" — the adjacent canonical period one step beyond
          // the event's own endpoint, read from a FRESH schema (never a raw
          // Excel serial, never approximated).
          setBusy(true);
          try {
            const snap = await readAddressSnapshot(port, lastEvent.sourceRange).catch(() => undefined);
            const fail = (msg: string): void => {
              append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
              conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: msg }];
            };
            if (!snap) {
              fail(lang === "ru" ? "Не удалось перечитать таблицу." : "Could not re-read the table.");
              return;
            }
            let startsBelowRow1 = false;
            try {
              const { localAddress } = splitSheetAddress(snap.address);
              startsBelowRow1 = parseLocalRange(localAddress || snap.address).start.row > 0;
            } catch {
              /* keep false */
            }
            const schema = induceTableSchema({
              values: snap.values,
              numberFormats: snap.numberFormats,
              formulas: snap.formulas,
              sheetName: snap.sheetName,
              sourceRange: snap.address,
              sourceVersion: sourceVersionOf(snap),
              startsBelowRow1,
            });
            const grids = { values: snap.values, numberFormats: snap.numberFormats };
            const pi = buildPeriodIndex(schema, grids);
            const sorted = [...pi.points].sort((a, b) => a.orderKey - b.orderKey);
            const anchorCanonical = eventFollowup.kind === "before" ? lastEvent.startCanonical : lastEvent.endCanonical;
            const idx = sorted.findIndex((p) => p.canonical === anchorCanonical);
            const target = eventFollowup.kind === "before" ? (idx > 0 ? sorted[idx - 1] : undefined) : idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : undefined;
            if (idx === -1 || !target) {
              fail(lang === "ru" ? "Соседний период недоступен — это край доступного диапазона дат." : "No adjacent period available — this is the edge of the available date range.");
              return;
            }
            const mi = buildMetricIndex(schema);
            const rm = resolveMetric(lastEvent.metricKey, mi);
            const subject =
              rm.kind === "resolved" && rm.entry.kind === "row_member" && rm.entry.member
                ? { kind: "row_axis_member" as const, member: rm.entry.member }
                : rm.kind === "resolved" && rm.entry.kind === "column" && rm.entry.column
                  ? { kind: "column_measure" as const, column: rm.entry.column }
                  : null;
            const pt = subject ? getPointValue(schema, grids, subject, target) : null;
            if (!pt) {
              fail(lang === "ru" ? "Не удалось найти значение показателя за этот период." : "Could not find the metric's value for that period.");
              return;
            }
            const val = pt.percent ? `${(pt.value * 100).toFixed(2).replace(/\.?0+$/, "")}%` : pt.value;
            const msg = lang === "ru"
              ? `${lastEvent.metricKey} на ${target.headerPath}: ${val}.`
              : `${lastEvent.metricKey} at ${target.headerPath}: ${val}.`;
            append({ kind: "response", id: nextId("res"), streaming: false, text: msg });
            conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: msg }];
          } finally {
            setBusy(false);
          }
          return;
        }

        // 24.7 — universal analytical-intent compiler. Runs before the flat
        // grouped-ranking and 24.6 schema routes; "flat" → this turn is not
        // analytical work over a non-flat TableSchema (records tables decline).
        if (detectAnalyticalIntent(text).any) {
          recordAnalyticalExecution("stage24_compiler");
          const analytical = await runAnalyticalRoute(text);
          if (analytical === "handled") return;
        }

        // 24.5.4 — "N <entities> with the worst/best <metric>" is ONE compositional
        // pipeline: group_by(entity) → mean(metric) → rank → limit N. Compile and
        // run it deterministically so the model can never emit a raw top-N plus an
        // independent group_by as sibling operations. Works standalone (fresh
        // source) and after a prior grouped result — identical canonical result.
        const groupedRanking = detectGroupedRanking(text);
        if (groupedRanking) {
          recordAnalyticalExecution("stage24_grouped_ranking");
          setLanguage(lang);
          setBusy(true);
          append({ kind: "command", id: nextId("cmd"), text });
          const grTrace: MutableResultActionTrace = {
            text,
            at: new Date().toISOString(),
            routeChosen: "grouped_ranking",
            detectedResultAction: null,
          };
          const grReadId = nextId("act");
          append({ kind: "activity", id: grReadId, activity: "reading", title: uiText(lang, "reading"), status: "running" });
          try {
            const snap = await readSelectionSnapshot(port).catch(() => undefined);
            if (!snap) {
              setActivity(grReadId, "done", uiText(lang, "noRange"));
              say("Select the data range first, then ask again.", "Сначала выделите диапазон с данными, затем повторите запрос.");
              grTrace.outcome = "no_selection";
              commitTrace(grTrace);
              return;
            }
            selectionRef.current = snap;
            const grLocal = snap.address.split("!").pop() ?? snap.address;
            setActivity(grReadId, "done", `${snap.sheetName}!${grLocal} · ${snap.totalRowCount} rows × ${snap.totalColumnCount} columns`);
            const plan = planGroupedRanking(groupedRanking, snap.headers ?? [], numericHeadersOf(snap));
            if (plan.kind === "unknown_entity") {
              say(
                `I couldn't find a "${groupedRanking.entityNoun}" column to group by in the selected data.`,
                `Не нашёл столбец «${groupedRanking.entityNoun}» для группировки в выделенных данных.`,
              );
              grTrace.outcome = "unknown_entity";
              commitTrace(grTrace);
              return;
            }
            if (plan.kind === "unknown_metric") {
              say(
                `I couldn't match "${groupedRanking.metricPhrase}" to a numeric column in the selected data.`,
                `Не понял, какой числовой столбец соответствует «${groupedRanking.metricPhrase}» в выделенных данных.`,
              );
              grTrace.outcome = "unknown_metric";
              commitTrace(grTrace);
              return;
            }
            if (plan.kind === "ambiguous_entity") {
              sessionMemoryRef.current = setClarification(
                sessionMemoryRef.current,
                buildColumnClarification(text, groupedRanking.entityNoun, plan.candidates, lang),
              );
              append({ kind: "response", id: nextId("res"), streaming: false, text: sessionMemoryRef.current.pendingClarification!.question });
              grTrace.outcome = "ambiguous_entity";
              commitTrace(grTrace);
              return;
            }

            const grMetricKey = `mean_${plan.metricColumn}`;
            const grRequest = {
              op: "group_by" as const,
              by: [plan.entityColumn],
              metrics: [{ name: grMetricKey, metric: "mean" as const, target: { kind: "column" as const, name: plan.metricColumn } }],
              sort: { by: grMetricKey, direction: plan.direction },
              limit: plan.n,
            };
            grTrace.planning = {
              requestType: "grouped_ranking",
              entityColumn: plan.entityColumn,
              metricColumn: plan.metricColumn,
              aggregation: "mean",
              direction: plan.direction === "asc" ? "bottom" : "top",
              limit: plan.n,
              operations: ["group_by", "aggregate_mean", plan.direction === "asc" ? "bottom_n" : "top_n"],
            };
            append({ kind: "activity", id: nextId("act"), activity: "calculating", title: lang === "ru" ? `Группировка по ${plan.entityColumn}` : `Grouping by ${plan.entityColumn}`, status: "done" });
            append({ kind: "activity", id: nextId("act"), activity: "calculating", title: lang === "ru" ? `Среднее ${plan.metricColumn} по ${plan.entityColumn}` : `Mean ${plan.metricColumn} per ${plan.entityColumn}`, status: "done" });

            const grBatch = runAnalysisBatch(snap, [grRequest], 0, lang === "ru" ? "ru" : "en");
            const grOutcome = grBatch.outcomes[0];
            if (!grOutcome || isAnalysisError(grOutcome)) {
              say(
                `I couldn't compute that grouped ranking${grOutcome && isAnalysisError(grOutcome) ? ` — ${grOutcome.error}` : ""}.`,
                `Не удалось посчитать это ранжирование${grOutcome && isAnalysisError(grOutcome) ? ` — ${grOutcome.error}` : ""}.`,
              );
              grTrace.outcome = "engine_error";
              commitTrace(grTrace);
              return;
            }
            const grGrid = gridFromGroupOutcome(grOutcome, grRequest);
            if (!grGrid || grGrid.rows.length === 0) {
              say("That grouped ranking produced no rows.", "Это ранжирование не дало ни одной строки.");
              grTrace.outcome = "empty";
              commitTrace(grTrace);
              return;
            }
            const grEntityValues = grGrid.rows.map((r) => r[0] ?? null);
            append({
              kind: "activity",
              id: nextId("act"),
              activity: "calculating",
              title:
                lang === "ru"
                  ? `Выбраны ${plan.n} ${plan.direction === "asc" ? "худших" : "лучших"} по среднему ${plan.metricColumn}`
                  : `Picked the ${plan.n} ${plan.direction === "asc" ? "lowest" : "highest"} by mean ${plan.metricColumn}`,
              status: "done",
            });

            const grTurnId = nextId("turn");
            const priorGrouped = [...sessionMemoryRef.current.recentResults]
              .reverse()
              .find((r) => (r.kind === "grouped_table" || r.kind === "ranking") && r.columns.some((c) => c === plan.entityColumn));
            const grHeadingRu = `${plan.n} ${plan.entityColumn} с ${plan.direction === "asc" ? "наименьшим" : "наибольшим"} средним ${plan.metricColumn}:`;
            const grHeadingEn = `${plan.n} ${plan.entityColumn} by ${plan.direction === "asc" ? "lowest" : "highest"} mean ${plan.metricColumn}:`;
            sessionMemoryRef.current = rememberResult(sessionMemoryRef.current, {
              turnId: grTurnId,
              kind: "ranking",
              title: (lang === "ru" ? grHeadingRu : grHeadingEn).replace(/:$/, ""),
              spec: {
                op: "grouped_ranking",
                entityColumn: plan.entityColumn,
                metricColumn: plan.metricColumn,
                aggregation: "mean",
                direction: plan.direction,
                n: plan.n,
              },
              columns: grGrid.columns,
              rows: grGrid.rows,
              rowsTruncated: false,
              facts: grBatch.facts,
              sourceSheet: snap.sheetName,
              sourceRange: snap.address,
              sourceVersion: sourceVersionOf(snap),
              resolved: [],
              entityColumn: plan.entityColumn,
              entityValues: grEntityValues,
              ...(priorGrouped ? { derivedFromResultId: priorGrouped.id } : {}),
            });
            grTrace.resolvedReference = {
              kind: "result",
              resultId: sessionMemoryRef.current.lastResultId ?? "",
              entityColumn: plan.entityColumn,
              entityValuesCount: grEntityValues.length,
            };
            grTrace.proposalCreated = false;
            grTrace.outcome = "grouped_ranking_result";
            commitTrace(grTrace);

            const grBody = `${lang === "ru" ? grHeadingRu : grHeadingEn}\n\n${renderGridMarkdown(grGrid.columns, grGrid.rows)}`;
            append({ kind: "response", id: nextId("res"), streaming: false, text: grBody });
            append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
            conversationRef.current = [
              ...conversationRef.current,
              { role: "user", content: text },
              { role: "assistant", content: grBody },
            ];
          } catch (error) {
            append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "Could not run that analysis" });
          } finally {
            setBusy(false);
          }
          return;
        }

        // 24.6 — universal table schema route (deterministic; pre-empts the model
        // for a recognised schema question). Records tables fall through to the
        // existing flat pipeline unchanged.
        {
          const si = detectSchemaIntent(text);
          if (si.any) {
            recordAnalyticalExecution("stage24_schema");
            const outcome = await runSchemaRoute(text, si);
            if (outcome === "handled") return;
            // "flat" → continue below with this turn (records table).
          }
        }

        // 24.2A — a conversational reference to an earlier structured result.
        const reference = resolveReference(text, mem);
        if (reference.kind === "evicted") {
          setLanguage(lang);
          append({ kind: "command", id: nextId("cmd"), text });
          append({
            kind: "response",
            id: nextId("res"),
            streaming: false,
            text:
              lang === "ru"
                ? "У меня больше нет того результата под рукой. Скажите, какой результат имеется в виду, или повторите анализ."
                : "I don't have that earlier result in view any more. Tell me which result you mean, or re-run the analysis.",
          });
          return;
        }
        if (reference.kind === "ambiguous") {
          setLanguage(lang);
          append({ kind: "command", id: nextId("cmd"), text });
          sessionMemoryRef.current = setClarification(
            mem,
            buildReferenceClarification(text, reference.phrase, reference.candidates, lang),
          );
          append({ kind: "response", id: nextId("res"), streaming: false, text: sessionMemoryRef.current.pendingClarification!.question });
          return;
        }
        // A follow-up may name an earlier result explicitly ("the top 3 from
        // that"), or be a short transform / "which is worst" ask that implicitly
        // targets the last structured result.
        const transformTurn = isTransformRequest(text) || isExtremeQuestion(text);
        const bareThat =
          /\b(?:that|this|it|those|them|the (?:previous )?result)\b/i.test(text) ||
          /(?:это|этот|тот|эт[иу]|их|предыдущ[а-яё]+\s+результат)/i.test(text.toLowerCase());
        let targetRef: ResultRef | null = null;
        if (reference.kind === "resolved" && reference.target.kind === "result") {
          targetRef = reference.target.ref;
        } else if (transformTurn && mem.recentResults.length > 0) {
          // 24.3.1 — a transform / "which is worst" turn ALWAYS operates on the
          // immediately preceding structured result when one exists. It must
          // never silently re-read the source worksheet (the transform detector
          // still decides, against that result's own columns, whether it applies).
          const recent = mem.recentResults.find((r) => r.id === mem.lastResultId) ?? mem.recentResults[mem.recentResults.length - 1] ?? null;
          // 24.5.3 — "покажи 3 менеджеров с худшим Variance" after "какой менеджер
          // не выполнил план" (a 1-row scalar) must reshape the fuller grouped
          // ancestor so the persisted result really is the requested set of N.
          const nAsk = rankRequestCount(text);
          targetRef = recent && nAsk && recent.rows.length < nAsk ? resolveRankTarget(recent, nAsk) : recent;
        }
        if (targetRef) {
          const ref = targetRef;
          // 24.I — a bare demonstrative ("the top 3 from that") with two or more
          // recent results from different turns is genuinely ambiguous: ask.
          const distinctTurns = new Set(mem.recentResults.map((r) => r.turnId)).size;
          const titleHinted = mem.recentResults.some((r) => {
            const key = r.title.toLowerCase().split(/\s+/).slice(0, 2).join(" ");
            return key.length >= 4 && text.toLowerCase().includes(key);
          });
          if (transformTurn && bareThat && !titleHinted && distinctTurns >= 2) {
            setLanguage(lang);
            append({ kind: "command", id: nextId("cmd"), text });
            const cands = mem.recentResults.slice(-3).map((r) => ({ kind: "result" as const, ref: r }));
            sessionMemoryRef.current = setClarification(mem, buildReferenceClarification(text, "that", cands, lang));
            append({ kind: "response", id: nextId("res"), streaming: false, text: sessionMemoryRef.current.pendingClarification!.question });
            return;
          }
          const det: TransformDetection = detectResultTransform(text, ref);
          if (det.kind === "transform") {
            setLanguage(lang);
            append({ kind: "command", id: nextId("cmd"), text });
            emitTransform(ref, det.transform);
            return;
          }
          if (det.kind === "column_ambiguous") {
            setLanguage(lang);
            append({ kind: "command", id: nextId("cmd"), text });
            sessionMemoryRef.current = setClarification(
              mem,
              buildColumnClarification(text, det.term, det.candidates, lang, { resultId: ref.id }),
            );
            append({ kind: "response", id: nextId("res"), streaming: false, text: sessionMemoryRef.current.pendingClarification!.question });
            return;
          }
          // det.kind === "none" → fall through; the model gets PRIOR RESULTS.
        }

        // 24.3A / 24.5 — a two-target comparison the current selection can't
        // satisfy: discover + read the relevant sheets, no slash command.
        if (route.needsWorkbookMap && route.reasons.includes("cross-target-comparison")) {
          setLanguage(lang);
          setBusy(true);
          append({ kind: "command", id: nextId("cmd"), text });
          append({ kind: "activity", id: nextId("act"), activity: "reading", title: uiText(lang, "reading"), status: "done" });
          try {
            await runCrossSheetComparison();
          } catch (error) {
            append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "Could not run that comparison" });
          } finally {
            setBusy(false);
          }
          return;
        }

        // 24.3 — general chat: no selection read, no workbook map, no analysis.
        // Stage 25.1.2 §4/§6/§9 — but NEVER for a turn inside an already
        // schema-aware analytical conversation: `routeTurn`'s heuristics have
        // no notion of an established analytical table, and sending such a
        // follow-up straight to the generic chat/legacy path is exactly how
        // "FAILED — .../ANALYSIS RESULT #… (rejected)" leaked to the user.
        // Skip straight to the Stage 25 planner (below) instead.
        // Stage 25.1.3f §2 — ALSO never for a compatible analytical follow-up
        // ("теперь…", "из них…", "покажи только…") while ANY structured
        // analytical result is still standing: such a turn is a restriction of
        // that result, and re-reading it as a standalone question against an
        // empty chat context is exactly how "в предоставленных данных нет
        // сведений о показателях" reached the user.
        const analyticalContinuationStanding =
          Boolean(sessionMemoryRef.current.lastAnalyticalTable) ||
          (Boolean(sessionMemoryRef.current.lastAnalyticalResultSetRef) && isAnalyticalFollowUp(text));
        if (route.route === "general_chat" && !analyticalContinuationStanding) {
          setLanguage(lang);
          setBusy(true);
          append({ kind: "command", id: nextId("cmd"), text });
          const generalAnalyzeId = nextId("act");
          append({ kind: "activity", id: generalAnalyzeId, activity: "analyzing", title: uiText(lang, "calling"), status: "running" });
          const generalResponseId = nextId("res");
          append({ kind: "response", id: generalResponseId, text: "", streaming: true });
          const generalHandlers: ChatStreamHandlers = {
            onDelta: (delta) => appendDelta(generalResponseId, delta),
            onResetResponse: () => resetResponse(generalResponseId),
            onActivity: (title, detail) =>
              append({ kind: "activity", id: nextId("act"), activity: "calculating", title, status: "done", ...(detail !== undefined ? { detail } : {}) }),
            runAnalysis: async () => ({
              text: "ANALYSIS RESULT\nerror: no range is selected.",
              activityTitles: [uiText(lang, "noRange")],
              opsRun: 0,
              anyError: true,
              status: "failed" as const,
              rejected: [{ code: "NO_DATA", error: "no range is selected" }],
            }),
            runVisualization: async () => ({
              text: "VISUALIZATION RESULT (rejected)\nerror: no range is selected.",
              activityTitle: uiText(lang, "noRange"),
              error: true,
            }),
            onChart: () => {},
          };
          const generalController = new AbortController();
          try {
            const generalResult = await chatClient.stream(
              { prompt: text, history: boundedHistory(conversationRef.current), ...(model ? { model } : {}) },
              generalHandlers,
              generalController.signal,
            );
            setLanguage(generalResult.language);
            setActivity(generalAnalyzeId, "done");
            const generalGuarded = guardMutationClaim(generalResult.text, generalResult.language, isMutationRequest(text), false);
            finishResponse(generalResponseId, generalGuarded);
            append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(generalResult.language, "done"), status: "done" });
            conversationRef.current = [
              ...conversationRef.current,
              { role: "user", content: text },
              { role: "assistant", content: generalGuarded },
            ];
          } catch (error) {
            setActivity(generalAnalyzeId, "error");
            finishResponse(generalResponseId);
            append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "AI request failed" });
            append({ kind: "activity", id: nextId("act"), activity: "failed", title: uiText(lang, "requestFailed"), status: "error" });
          } finally {
            setBusy(false);
          }
          return;
        }

        // Stage 25 §56 — LLM analytical planner. Tried after every more
        // specific deterministic route above has declined, and before the
        // flat bounded agent / general chat: a schema-backed table question
        // no Stage 24.7–24.9 phrase/cue covers still gets a chance at tool
        // composition instead of falling straight to the flat analyzer.
        // Gated on the same broad `classifyIntent` heuristic already used for
        // the flat model route, OR an explicit exploratory ask (§30/§40/§70 —
        // "Что здесь самое необычное?" carries none of `classifyIntent`'s
        // keywords, but must still reach the planner's exploratory mode, never
        // a bare `metric.resolve("")`) — safe here because every route that
        // owns a more specific turn shape (transforms, references, grouped
        // ranking, cross-sheet compare, general chat) has already returned
        // above.
        // Stage 25.1.2 §4/§6/§9 — ALSO reached whenever this session already
        // has an established analytical table, regardless of what the
        // phrase-based classifiers think of THIS turn's wording: a
        // schema-aware conversation's follow-up must stay schema-aware.
        const knownForPlanner = sessionMemoryRef.current.lastAnalyticalTable;
        // Stage 25.1.3f §2 — a follow-up on a standing structured result stays
        // schema-aware even if this turn's own wording carries no analytical
        // keyword of its own.
        const followUpOnStandingResult = Boolean(sessionMemoryRef.current.lastAnalyticalResultSetRef) && isAnalyticalFollowUp(text);
        if (
          analyticalPlannerEnabled() &&
          typeof chatClient.decideAgentStep === "function" &&
          typeof chatClient.narrate === "function" &&
          (classifyIntent(text).analytical || isExploratoryRequest(text) || Boolean(knownForPlanner) || followUpOnStandingResult)
        ) {
          let plannerSnap: SelectionSnapshot | undefined;
          try {
            plannerSnap = await readSelectionSnapshot(port);
          } catch {
            plannerSnap = undefined;
          }
          let plannerSchema: TableSchema | undefined;
          const induceFrom = (snap: SelectionSnapshot): TableSchema => {
            let startsBelowRow1 = false;
            try {
              const { localAddress } = splitSheetAddress(snap.address);
              startsBelowRow1 = parseLocalRange(localAddress || snap.address).start.row > 0;
            } catch {
              /* keep false */
            }
            return induceTableSchema({
              values: snap.values,
              numberFormats: snap.numberFormats,
              formulas: snap.formulas,
              sheetName: snap.sheetName,
              sourceRange: snap.address,
              sourceVersion: sourceVersionOf(snap),
              startsBelowRow1,
            });
          };
          if (plannerSnap) plannerSchema = induceFrom(plannerSnap);
          const plannerSnapValid = (snap: SelectionSnapshot | undefined, schema: TableSchema | undefined): schema is TableSchema =>
            Boolean(snap && schema && schema.orientation !== "row_records" && schema.confidence >= 0.5);
          // §4/§6 — the live selection may not resolve to a valid table even
          // though this IS a schema-aware conversation (selection moved,
          // read failed, or induction declined): retry against the
          // REMEMBERED analytical table before giving up.
          if (!plannerSnapValid(plannerSnap, plannerSchema) && knownForPlanner) {
            const knownSnap = await readAddressSnapshot(port, knownForPlanner.sourceRange).catch(() => undefined);
            if (knownSnap) {
              const knownSchema = induceFrom(knownSnap);
              if (plannerSnapValid(knownSnap, knownSchema)) {
                plannerSnap = knownSnap;
                plannerSchema = knownSchema;
              }
            }
          }
          if (plannerSnapValid(plannerSnap, plannerSchema)) {
            setLanguage(lang);
            setBusy(true);
            selectionRef.current = plannerSnap;
            append({ kind: "command", id: nextId("cmd"), text });
            const plannerGrids: AnalysisGrids = { values: plannerSnap!.values, numberFormats: plannerSnap!.numberFormats };
            try {
              await runStage25Planner(plannerSchema, plannerGrids, text);
            } finally {
              setBusy(false);
            }
            return;
          }
          // §4/§6/§16 — this IS a schema-aware analytical conversation that
          // could not resolve to a table this turn: terminate cleanly here.
          // NEVER fall through to the legacy flat analyzer for schema-backed
          // analytics.
          if (knownForPlanner) {
            setLanguage(lang);
            setBusy(true);
            append({ kind: "command", id: nextId("cmd"), text });
            const body =
              lang === "ru"
                ? "Не удалось определить таблицу для анализа — выделите диапазон с данными и повторите запрос."
                : "I couldn't resolve a table to analyze — select the data range and try again.";
            append({ kind: "response", id: nextId("res"), streaming: false, text: body });
            conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: body }];
            append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(lang, "done"), status: "done" });
            setBusy(false);
            return;
          }
        }

        // 24.4 §4–5 — bounded agentic analysis. LAST resort before the generic
        // model path: only an investigative / discovery / workbook-scope turn
        // that every deterministic route above has declined reaches here.
        if (typeof chatClient.decideAgentStep === "function") {
          const eligibility = classifyAgentEligibility(text, route);
          if (eligibility.eligible) {
            setLanguage(lang);
            setBusy(true);
            append({ kind: "command", id: nextId("cmd"), text });
            try {
              await runAgentTask(text);
            } catch (error) {
              append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "The analysis agent could not run." });
            } finally {
              setBusy(false);
            }
            return;
          }
        }
      }

      setLanguage(lang);
      setBusy(true);
      if (!suppressCommandEcho) append({ kind: "command", id: nextId("cmd"), text });

      // ----- Stage 23: workbook map + explicit sheet targeting -------------
      let workbookMap: WorkbookMap | undefined;
      let explicitSnapshot: SelectionSnapshot | undefined;
      let slashArgs = routedSlash ? routedSlash.args : "";
      // `/summary` and `/analyze` only need the map when an explicit sheet name
      // was given — a bare `/summary` stays a selection summary with no extra reads.
      const needsMap =
        routedSlash != null &&
        slashNeedsWorkbookMap(routedSlash.command.name) &&
        (!(routedSlash.command.name === "summary" || routedSlash.command.name === "analyze") ||
          routedSlash.args.trim() !== "");
      if (routedSlash && needsMap) {
        try {
          workbookMap = await buildWorkbookMap(port);
        } catch {
          workbookMap = undefined;
        }
        const name = routedSlash.command.name;
        if ((name === "summary" || name === "analyze") && slashArgs.trim() && workbookMap) {
          const wanted = slashArgs.trim();
          const res = resolveSheet(workbookMap, wanted);
          if (res.kind === "ambiguous") {
            append({
              kind: "notice",
              id: nextId("ntc"),
              tone: "warn",
              text:
                lang === "ru"
                  ? `«${wanted}» может означать несколько листов: ${res.candidates.map((c) => `«${c}»`).join(", ")}. Уточните название.`
                  : `"${wanted}" matches more than one worksheet: ${res.candidates.map((c) => `"${c}"`).join(", ")}. Use the exact name.`,
            });
            setBusy(false);
            return;
          }
          if (res.kind === "ok") {
            if (!res.sheet.usedAddress) {
              append({
                kind: "notice",
                id: nextId("ntc"),
                tone: "warn",
                text: lang === "ru" ? `Лист «${res.sheet.name}» пуст.` : `Worksheet "${res.sheet.name}" is empty.`,
              });
              setBusy(false);
              return;
            }
            try {
              explicitSnapshot = await readAddressSnapshot(port, res.sheet.usedAddress);
              slashArgs = "";
            } catch {
              append({
                kind: "notice",
                id: nextId("ntc"),
                tone: "error",
                text: lang === "ru" ? `Не удалось прочитать лист «${res.sheet.name}».` : `Could not read worksheet "${res.sheet.name}".`,
              });
              setBusy(false);
              return;
            }
          }
          // not_found → leave slashArgs as-is; the normal selection path handles it.
        }
      }

      const effectivePrompt = routedSlash ? slashPrompt(routedSlash.command.name, slashArgs, lang) : text;

      const readId = nextId("act");
      append({ kind: "activity", id: readId, activity: "reading", title: uiText(lang, "reading"), status: "running" });

      let selection: SelectionSnapshot | undefined;
      if (explicitSnapshot) {
        selection = explicitSnapshot;
        const local = selection.address.split("!").pop() ?? selection.address;
        setActivity(readId, "done", `${selection.sheetName}!${local} · ${selection.totalRowCount} rows × ${selection.totalColumnCount} columns`);
        if (selection.truncated && selection.truncationNote) {
          append({ kind: "notice", id: nextId("ntc"), tone: "warn", text: `⚠ ${selection.truncationNote}` });
        }
      } else {
        try {
          selection = await readSelectionSnapshot(port);
          const local = selection.address.split("!").pop() ?? selection.address;
          setActivity(readId, "done", `${selection.sheetName}!${local} · ${selection.totalRowCount} rows × ${selection.totalColumnCount} columns`);
          if (selection.truncated && selection.truncationNote) {
            append({ kind: "notice", id: nextId("ntc"), tone: "warn", text: `⚠ ${selection.truncationNote}` });
          }
        } catch {
          setActivity(readId, "done", uiText(lang, "noRange"));
        }
      }
      selectionRef.current = selection;

      const analyzeId = nextId("act");
      append({
        kind: "activity",
        id: analyzeId,
        activity: "analyzing",
        title: selection ? uiText(lang, "analyzing") : uiText(lang, "calling"),
        status: "running",
      });

      const responseId = nextId("res");
      append({ kind: "response", id: responseId, text: "", streaming: true });

      const activeSelection = selection;
      const handlers: ChatStreamHandlers = {
        onDelta: (delta) => appendDelta(responseId, delta),
        onResetResponse: () => resetResponse(responseId),
        onActivity: (title, detail) =>
          append({
            kind: "activity",
            id: nextId("act"),
            activity: "calculating",
            title,
            status: "done",
            ...(detail !== undefined ? { detail } : {}),
          }),
        runAnalysis: async (requests, opsAlreadyUsed) => {
          if (!activeSelection) {
            return {
              text: "ANALYSIS RESULT\nerror: no range is selected, so no data can be analysed.",
              activityTitles: [uiText(lang, "noRange")],
              opsRun: 0,
              anyError: true,
              status: "failed",
              rejected: [{ code: "NO_DATA", error: "no range is selected" }],
            };
          }
          const batch = runAnalysisBatch(activeSelection, requests, opsAlreadyUsed, lang);
          // Stage 24 — forward the structured grid(s) so the turn's result can be
          // persisted into SessionMemory and reused by a follow-up.
          // 24.3.2 — a `group_by` outcome carries `groups`, not a `columns`/`rows`
          // grid, so it must be canonicalised into the USER-VISIBLE grouped table
          // here; otherwise a grouped analysis persists NO ResultRef and the next
          // turn silently re-reads the worksheet.
          const tables = batch.outcomes.flatMap((o, i) => {
            if (isAnalysisError(o)) return [];
            if (o.columns && o.columns.length > 0 && o.rows) {
              return [{ columns: o.columns, rows: o.rows, ...(o.sourceRows ? { sourceRows: o.sourceRows } : {}) }];
            }
            const grid = gridFromGroupOutcome(o, requests[i]);
            return grid ? [{ columns: grid.columns, rows: grid.rows }] : [];
          });
          return {
            text: batch.text,
            activityTitles: batch.activityTitles,
            opsRun: batch.opsRun,
            anyError: batch.anyError,
            status: batch.status,
            rejected: batch.rejected.map((entry) => ({ index: entry.index, code: entry.code, error: entry.error })),
            facts: batch.facts,
            factsText: batch.factsText,
            ...(tables.length > 0 ? { tables } : {}),
          };
        },
        runVisualization: async (rawChart) => {
          if (!activeSelection) {
            return { text: "VISUALIZATION RESULT (rejected)\nerror: no range is selected.", activityTitle: uiText(lang, "noRange"), error: true };
          }
          const outcome = runVisualization(activeSelection, rawChart, lang);
          return {
            text: outcome.text,
            activityTitle: outcome.activityTitle,
            error: Boolean(outcome.error),
            facts: outcome.facts,
            ...(outcome.chart ? { chart: outcome.chart } : {}),
            ...(outcome.result ? { result: outcome.result } : {}),
          };
        },
        onChart: (chart) => append({ kind: "chart", id: nextId("cht"), data: chart }),
        readWorkbookRange: async (address) => {
          try {
            return await readAddressSnapshot(port, address);
          } catch {
            return null;
          }
        },
      };

      const controller = new AbortController();
      try {
        const priorResults = projectMemoryForModel(sessionMemoryRef.current, lang);
        const result = await chatClient.stream(
          {
            prompt: effectivePrompt,
            history: boundedHistory(conversationRef.current),
            ...(selection ? { selection } : {}),
            ...(model ? { model } : {}),
            ...(routedSlash ? { slash: { name: routedSlash.command.name, args: slashArgs } } : {}),
            ...(workbookMap ? { workbook: workbookMap } : {}),
            ...(priorResults.trim().length > 0 ? { priorResults } : {}),
          },
          handlers,
          controller.signal,
        );
        setLanguage(result.language);
        setActivity(analyzeId, "done");
        // Stage 24.5.1 §3 — a model answer to a mutation-intent turn that produced
        // no validated action must not claim the workbook changed.
        const producedAction = result.actions.length > 0 || Boolean(result.sheetOp);
        const guardedText = guardMutationClaim(
          result.text,
          result.language,
          isMutationRequest(text) || detectResultAction(text) !== null,
          producedAction,
        );
        finishResponse(responseId, guardedText);
        if (result.analysisRuns > 0 && activeSelection) {
          const local = activeSelection.address.split("!").pop() ?? activeSelection.address;
          append({
            kind: "activity",
            id: nextId("act"),
            activity: "completed",
            title: uiText(result.language, "analysisComplete"),
            detail: `${pluralCount(result.language, result.analysisRuns, "operation")} · ${activeSelection.sheetName}!${local}`,
            status: "done",
          });
        }
        if (result.analysisHadError) {
          append({ kind: "notice", id: nextId("ntc"), tone: "warn", text: t(result.language, "ua.someRejected") });
        }
        conversationRef.current = [
          ...conversationRef.current,
          { role: "user", content: text },
          { role: "assistant", content: guardedText },
        ];

        // Stage 24 — persist the turn's structured result / chart into SessionMemory
        // so a follow-up ("show only the top 2", "chart that") can reference it
        // WITHOUT the model re-deriving anything from prose.
        const turnId = nextId("turn");
        if (result.structured && activeSelection) {
          let s = result.structured;
          // Stage 24.5.1 §11 — when the prompt asks for "N … with the worst/best X"
          // but the structured grid came back with every entity (a group_by), the
          // CANONICAL result is the requested N — so a later "выдели их" acts on the
          // requested set, not every entity that appears in explanatory prose.
          if ((s.kind === "grouped_table" || s.kind === "ranking") && s.rows.length > 1) {
            const narrow = detectResultTransform(text, { columns: s.columns, rows: s.rows });
            if (narrow.kind === "transform" && (narrow.transform.kind === "top_n" || narrow.transform.kind === "bottom_n")) {
              const n = narrow.transform.n ?? 0;
              if (n > 0 && s.rows.length > n) {
                const applied = applyResultTransform(
                  { columns: s.columns, rows: s.rows, title: s.title ?? "", kind: s.kind } as unknown as ResultRef,
                  narrow.transform,
                );
                if (!isTransformError(applied)) {
                  s = { ...s, columns: applied.columns, rows: applied.rows, kind: "ranking", spec: narrow.transform };
                }
              }
            }
          }
          sessionMemoryRef.current = rememberResult(sessionMemoryRef.current, {
            turnId,
            kind: s.kind,
            title: s.title || text.slice(0, 100),
            spec: s.spec,
            columns: s.columns,
            rows: s.rows,
            rowsTruncated: s.rowsTruncated,
            facts: s.facts,
            sourceSheet: s.sourceSheet || activeSelection.sheetName,
            sourceRange: s.sourceRange || activeSelection.address,
            sourceVersion: sourceVersionOf(activeSelection),
            resolved: [],
          });
          // Stage 24.6 — an analysis that identified specific workbook rows also
          // produces a canonical RowSetRef (the prose answer is not canonical).
          if (s.sourceRows && s.sourceRows.length > 0 && (s.kind === "filtered_rows" || s.kind === "ranking")) {
            sessionMemoryRef.current = rememberRowSet(sessionMemoryRef.current, {
              turnId,
              sourceSheet: s.sourceSheet || activeSelection.sheetName,
              sourceRange: s.sourceRange || activeSelection.address,
              sourceVersion: sourceVersionOf(activeSelection),
              sheetRows: s.sourceRows.slice(0, 500),
              describe: s.title || text.slice(0, 80),
              count: s.sourceRows.length,
              truncated: s.sourceRows.length > 500,
              columns: s.columns,
              rows: s.rows.slice(0, 200),
              conditionSpec: s.spec,
              ...(sessionMemoryRef.current.lastResultId ? { fromResultId: sessionMemoryRef.current.lastResultId } : {}),
            });
          }
        }
        const lastChartData = result.charts[result.charts.length - 1];
        if (lastChartData) {
          sessionMemoryRef.current = rememberChart(sessionMemoryRef.current, {
            turnId,
            data: lastChartData,
            ...(sessionMemoryRef.current.lastResultId ? { fromResultId: sessionMemoryRef.current.lastResultId } : {}),
          });
        }

        if (result.actionErrors.length > 0) {
          append({ kind: "notice", id: nextId("ntc"), tone: "warn", text: t(result.language, "ua.ignoredActions", { errors: result.actionErrors.join("; ") }) });
        }
        if (result.sheetOp) {
          append({ kind: "proposal", id: nextId("prop"), actions: [], sheetOp: result.sheetOp, state: "pending" });
          append({ kind: "activity", id: nextId("act"), activity: "waiting_for_approval", title: t(result.language, "ua.awaitingApproval", { n: 1 }), status: "running" });
        } else if (result.actions.length > 0) {
          append({ kind: "proposal", id: nextId("prop"), actions: result.actions, state: "pending" });
          append({ kind: "activity", id: nextId("act"), activity: "waiting_for_approval", title: t(result.language, "ua.awaitingApproval", { n: result.actions.length }), status: "running" });
        } else {
          append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(result.language, "done"), status: "done" });
        }
      } catch (error) {
        setActivity(analyzeId, "error");
        finishResponse(responseId);
        append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "AI request failed" });
        append({ kind: "activity", id: nextId("act"), activity: "failed", title: uiText(lang, "requestFailed"), status: "error" });
      } finally {
        setBusy(false);
      }
    },
    [append, appendDelta, busy, chatClient, finishResponse, language, model, port, resetResponse, setActivity, undoLast, undoStack],
  );

  const approve = useCallback(
    async (proposalId: string) => {
      const proposal = entries.find((entry) => entry.kind === "proposal" && entry.id === proposalId);
      if (!proposal || proposal.kind !== "proposal" || proposal.state !== "pending" || busy) return;
      setBusy(true);
      setEntries((current) => current.map((entry) => (entry.id === proposalId && entry.kind === "proposal" ? { ...entry, state: "applying" } : entry)));
      const writeId = nextId("act");

      // Stage 23 — `/new-sheet`: create the worksheet, one entry on the shared
      // undo stack (undo deletes exactly that sheet).
      if (proposal.sheetOp?.kind === "create_sheet") {
        const sheetName = proposal.sheetOp.name;
        append({ kind: "activity", id: writeId, activity: "writing", title: t(language, "ua.applyingChanges", { n: 1 }), status: "running" });
        try {
          await port.addWorksheet(sheetName);
          setUndoStack((current) => [
            ...current,
            { kind: "sheet" as const, sheetName, label: language === "ru" ? `новый лист «${sheetName}»` : `new sheet "${sheetName}"` },
          ]);
          setEntries((current) =>
            current.map((entry) => (entry.id === proposalId && entry.kind === "proposal" ? { ...entry, state: "applied" } : entry)),
          );
          setActivity(writeId, "done", sheetName);
          append({ kind: "activity", id: nextId("act"), activity: "completed", title: t(language, "ua.changesApplied"), status: "done" });
        } catch (error) {
          setEntries((current) =>
            current.map((entry) =>
              entry.id === proposalId && entry.kind === "proposal"
                ? { ...entry, state: "failed", note: error instanceof Error ? error.message : "create failed" }
                : entry,
            ),
          );
          setActivity(writeId, "error");
          append({
            kind: "notice",
            id: nextId("ntc"),
            tone: "error",
            text:
              language === "ru"
                ? `Не удалось создать лист: ${error instanceof Error ? error.message : "неизвестная ошибка"}.`
                : `Could not create the worksheet: ${error instanceof Error ? error.message : "unknown error"}.`,
          });
        } finally {
          setBusy(false);
        }
        return;
      }

      // Stage 24.11 — ordered compound workflow (create sheet + write + …).
      // ONE undo entry; a mid-workflow failure rolls back everything applied.
      if (proposal.workflow && proposal.workflow.length > 0) {
        const steps = proposal.workflow;
        const stepCount = steps.reduce((n, s) => n + (s.kind === "cells" ? s.actions.length : 1), 0);
        append({ kind: "activity", id: writeId, activity: "writing", title: t(language, "ua.applyingChanges", { n: stepCount }), status: "running" });
        const done: ({ kind: "create_sheet"; name: string } | { kind: "cells"; changes: readonly AppliedChange[] })[] = [];
        try {
          for (const step of steps) {
            if (step.kind === "create_sheet") {
              await port.addWorksheet(step.name);
              done.push({ kind: "create_sheet", name: step.name });
            } else {
              const changes: AppliedChange[] = [];
              for (const action of step.actions) changes.push(await applyAction(port, action));
              done.push({ kind: "cells", changes });
            }
          }
          const created = steps.find((s): s is { kind: "create_sheet"; name: string } => s.kind === "create_sheet");
          const label =
            language === "ru"
              ? `рабочий процесс${created ? ` (лист «${created.name}»)` : ""}`
              : `workflow${created ? ` (sheet "${created.name}")` : ""}`;
          setUndoStack((current) => [...current, { kind: "workflow" as const, label, steps: done }]);
          setEntries((current) =>
            current.map((entry) => (entry.id === proposalId && entry.kind === "proposal" ? { ...entry, state: "applied" } : entry)),
          );
          setActivity(writeId, "done");
          append({ kind: "activity", id: nextId("act"), activity: "completed", title: t(language, "ua.changesApplied"), status: "done" });
        } catch (error) {
          for (const step of [...done].reverse()) {
            if (step.kind === "cells") {
              for (const change of [...step.changes].reverse()) {
                try { await undoChange(port, change); } catch { /* best-effort rollback */ }
              }
            } else {
              try { await port.deleteWorksheet(step.name); } catch { /* best-effort rollback */ }
            }
          }
          setEntries((current) =>
            current.map((entry) =>
              entry.id === proposalId && entry.kind === "proposal"
                ? { ...entry, state: "failed", note: error instanceof Error ? error.message : "workflow failed" }
                : entry,
            ),
          );
          setActivity(writeId, "error");
          append({
            kind: "notice",
            id: nextId("ntc"),
            tone: "error",
            text:
              language === "ru"
                ? `Не удалось выполнить рабочий процесс: ${error instanceof Error ? error.message : "неизвестная ошибка"}. Все применённые шаги отменены.`
                : `The workflow could not be completed: ${error instanceof Error ? error.message : "unknown error"}. Every applied step was rolled back.`,
          });
        } finally {
          setBusy(false);
        }
        return;
      }

      append({ kind: "activity", id: writeId, activity: "writing", title: t(language, "ua.applyingChanges", { n: proposal.actions.length }), status: "running" });
      const applied: AppliedChange[] = [];
      try {
        for (const action of proposal.actions) applied.push(await applyAction(port, action));
        // One approved proposal → ONE undo entry, whatever the internal action count.
        const first = applied[0]?.action;
        const label =
          applied.length === 1 && first
            ? `${first.type} ${first.sheetName}!${first.range}`
            : `${first?.type ?? "changes"} · ${applied.length} ${language === "ru" ? "диапазонов" : "ranges"}`;
        setUndoStack((current) => [...current, { kind: "cells" as const, changes: applied, label }]);
        setEntries((current) =>
          current.map((entry) =>
            entry.id === proposalId && entry.kind === "proposal"
              ? { ...entry, state: "applied", appliedChangeIds: applied.map((change) => change.id) }
              : entry,
          ),
        );
        setActivity(writeId, "done", applied.map((change) => `${change.action.sheetName}!${change.action.range}`).join(", "));
        append({ kind: "activity", id: nextId("act"), activity: "completed", title: t(language, "ua.changesApplied"), status: "done" });
      } catch (error) {
        for (const change of [...applied].reverse()) {
          try { await undoChange(port, change); } catch { /* best-effort rollback */ }
        }
        setEntries((current) =>
          current.map((entry) =>
            entry.id === proposalId && entry.kind === "proposal"
              ? { ...entry, state: "failed", note: error instanceof Error ? error.message : "apply failed" }
              : entry,
          ),
        );
        setActivity(writeId, "error");
        append({
          kind: "notice",
          id: nextId("ntc"),
          tone: "error",
          text:
            language === "ru"
              ? `Не удалось применить изменения: ${error instanceof Error ? error.message : "неизвестная ошибка"}. Откат выполнен.`
              : `Could not apply changes: ${error instanceof Error ? error.message : "unknown error"}. Rolled back.`,
        });
      } finally {
        setBusy(false);
      }
    },
    [append, busy, entries, language, port, setActivity],
  );

  const reject = useCallback(
    (proposalId: string) => {
      setEntries((current) =>
        current.map((entry) =>
          entry.id === proposalId && entry.kind === "proposal" && entry.state === "pending" ? { ...entry, state: "rejected" } : entry,
        ),
      );
      append({ kind: "activity", id: nextId("act"), activity: "completed", title: t(language, "ua.changeRejected"), status: "done" });
    },
    [append, language],
  );

  const insertChart = useCallback(
    async (base64Png: string, suggestedName: string, dims?: ChartInsertDims) => {
      const selection = selectionRef.current;
      if (!selection) throw new Error(t(language, "ua.selectRangeForChart"));
      const { sheetName, localAddress } = splitSheetAddress(selection.address);
      const sheet = sheetName || selection.sheetName;
      // Anchor immediately to the RIGHT of the selection so the image never covers the data.
      // A1:L121 -> M1 ; a single cell -> the next column, same row.
      const anchorCell = anchorRightOfSelection(localAddress || selection.address);
      // insertImage re-reads the shape after context.sync; it rejects if Excel did not
      // confirm it — so undo state below is only recorded on a real insertion.
      const shape = await port.insertImage(base64Png, {
        sheetName: sheet,
        anchorCell,
        name: `SheetAgentChart_${nextId("img")}`,
        ...(dims ? { widthPx: dims.widthPx, heightPx: dims.heightPx } : {}),
      });
      setUndoStack((current) => [
        ...current,
        { kind: "shape", sheetName: sheet, shapeName: shape.shapeName, label: `${suggestedName} → ${sheet}!${anchorCell}` },
      ]);
      append({
        kind: "activity",
        id: nextId("act"),
        activity: "completed",
        title: t(language, "ua.chartInserted"),
        detail: `${sheet}!${anchorCell} · ${Math.round(shape.width)}×${Math.round(shape.height)} px`,
        status: "done",
      });
    },
    [append, language, port],
  );

  const reset = useCallback(() => {
    conversationRef.current = [];
    selectionRef.current = undefined;
    sessionMemoryRef.current = emptySessionMemory();
    // §13 — a new conversation starts with no analytical memory at all: no
    // table, no references, no suspended task. §21 — and it cancels a turn
    // still in flight, whose answer can then no longer be appended.
    analyticalStateRef.current = EMPTY_ANALYTICAL_STATE;
    turnSeqRef.current += 1;
    v2AbortRef.current?.abort();
    v2AbortRef.current = null;
    setEntries([]);
    setUndoStack([]);
  }, []);

  const __sessionMemoryDebug = useCallback((): SessionMemoryDebug => {
    const m = sessionMemoryRef.current;
    return {
      recentResults: m.recentResults.map((r) => ({
        id: r.id,
        columns: r.columns,
        rowCount: r.rows.length,
        rows: r.rows,
        source: r.sourceRange,
        kind: r.kind,
        ...(r.derivedFromResultId ? { derivedFromResultId: r.derivedFromResultId } : {}),
        ...(r.derivedFromResultIds ? { derivedFromResultIds: r.derivedFromResultIds } : {}),
        ...(r.sourceVersions ? { sourceVersions: r.sourceVersions } : {}),
        ...(r.transform !== undefined ? { transform: r.transform } : {}),
        ...(r.entityColumn ? { entityColumn: r.entityColumn } : {}),
        ...(r.entityValues ? { entityValues: r.entityValues } : {}),
      })),
      ...(m.lastResultId ? { lastResultId: m.lastResultId } : {}),
      ...(m.lastRowSet ? { lastRowSetId: m.lastRowSet.id } : {}),
      ...(m.lastRowSet
        ? {
            lastRowSet: {
              describe: m.lastRowSet.describe,
              count: m.lastRowSet.count,
              sheetRows: m.lastRowSet.sheetRows,
              sourceRange: m.lastRowSet.sourceRange,
              ...(m.lastRowSet.fromResultId ? { fromResultId: m.lastRowSet.fromResultId } : {}),
            },
          }
        : {}),
      ...(m.lastChart ? { lastChartId: m.lastChart.id } : {}),
      ...(m.pendingClarification ? { pendingClarificationKind: m.pendingClarification.kind } : {}),
      build: { appVersion: BUILD_INFO.appVersion, buildId: BUILD_INFO.buildId, gitCommit: BUILD_INFO.gitCommit, stage: BUILD_INFO.stage },
      ...(getResultActionTraces().length > 0 ? { lastResultActionTrace: getResultActionTraces().at(-1)! } : {}),
      ...(m.lastRankingRef
        ? {
            lastRankingRef: {
              startCanonical: m.lastRankingRef.startCanonical,
              endCanonical: m.lastRankingRef.endCanonical,
              ...(m.lastRankingRef.limit !== undefined ? { limit: m.lastRankingRef.limit } : {}),
            },
          }
        : {}),
      ...(m.lastCompositeRef
        ? {
            lastCompositeRef: {
              interval1: { startCanonical: m.lastCompositeRef.interval1.startCanonical, endCanonical: m.lastCompositeRef.interval1.endCanonical },
              interval2: { startCanonical: m.lastCompositeRef.interval2.startCanonical, endCanonical: m.lastCompositeRef.interval2.endCanonical },
            },
          }
        : {}),
      ...(m.lastEventRef
        ? {
            lastEventRef: {
              metricKey: m.lastEventRef.metricKey,
              startCanonical: m.lastEventRef.startCanonical,
              endCanonical: m.lastEventRef.endCanonical,
              startHeaderPath: m.lastEventRef.startHeaderPath,
              endHeaderPath: m.lastEventRef.endHeaderPath,
              absoluteChange: m.lastEventRef.absoluteChange,
              percentageChange: m.lastEventRef.percentageChange,
            },
          }
        : {}),
      ...(m.lastAnalyticalTable ? { lastAnalyticalTable: { sheetName: m.lastAnalyticalTable.sheetName, sourceRange: m.lastAnalyticalTable.sourceRange } } : {}),
      ...(m.lastDirectionChangeRef
        ? {
            lastDirectionChangeRef: {
              metricKey: m.lastDirectionChangeRef.metricKey,
              directionChangeCount: m.lastDirectionChangeRef.directionChangeCount,
              events: m.lastDirectionChangeRef.events.length,
            },
          }
        : {}),
      ...(m.lastMetricSetRef ? { lastMetricSetRef: { metricKeys: m.lastMetricSetRef.metricKeys, origin: m.lastMetricSetRef.origin } } : {}),
      ...(m.lastResultSetRef ? { lastResultSetRef: { operation: m.lastResultSetRef.operation, rows: m.lastResultSetRef.rows } } : {}),
      ...(m.lastAnalyticalResultSetRef
        ? {
            lastAnalyticalResultSetRef: {
              operation: m.lastAnalyticalResultSetRef.operation,
              columns: m.lastAnalyticalResultSetRef.columns,
              metricKeys: m.lastAnalyticalResultSetRef.metricKeys,
              rowCount: m.lastAnalyticalResultSetRef.rows.length,
            },
          }
        : {}),
      ...(m.lastMetricFocusRef ? { lastMetricFocusRef: { metricKey: m.lastMetricFocusRef.metricKey } } : {}),
      ...(m.lastPeriodRef ? { lastPeriodRef: { startCanonical: m.lastPeriodRef.startCanonical, ...(m.lastPeriodRef.endCanonical ? { endCanonical: m.lastPeriodRef.endCanonical } : {}) } } : {}),
    };
  }, []);

  return useMemo(
    () => ({ entries, busy, turnStartedAt, undoStack, language, submit, approve, reject, undoLast, insertChart, reset, __sessionMemoryDebug }),
    [entries, busy, turnStartedAt, undoStack, language, submit, approve, reject, undoLast, insertChart, reset, __sessionMemoryDebug],
  );
}

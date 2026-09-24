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
  clearClarification,
  emptySessionMemory,
  forgetChartPlacement,
  forgetSheet,
  interpretClarificationAnswer,
  isUndoPhrase,
  projectMemoryForModel,
  rememberChart,
  rememberDerivedResult,
  rememberResult,
  rememberRowSet,
  resolveReference,
  setClarification,
} from "../app/conversation-memory.js";
import type { PendingClarification, ResultKind, ResultRef, RowSetRef, SessionMemory } from "../app/session-memory.js";
import { isExtremeQuestion, isMutationRequest, isTransformRequest, routeTurn } from "../app/conversation-route.js";
import { revalidateSource, revalidateSources, sourceVersionOf } from "../app/source-freshness.js";
import { formatDisplayCell } from "../app/format-cell.js";
import { detectResultAction, type ResultActionIntent } from "../app/result-action-intent.js";
import { groundEntitiesToRows } from "../app/entity-grounding.js";
import { extractEntitySet, mentionsConversationalReference, resolveActionReference, type EntitySet } from "../app/entity-reference.js";
import { DEFAULT_HIGHLIGHT_COLOR, parseHighlightColor } from "../app/highlight-color.js";
import { detectGroupedRanking, planGroupedRanking } from "../app/grouped-ranking.js";
import { induceTableSchema, type TableSchema } from "../app/schema/schema-induction.js";
import { describeSchema } from "../app/schema/describe-schema.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import { isAnalyticalFollowUp } from "../app/analytical-turn.js";
import { containsForbiddenLeak } from "../app/answer-leak.js";
import { BUILD_INFO, buildInfoLine } from "../app/build-info.js";
// ----- Stage 26.8: the unified analytical engine, in production -------------
import { runAnalyticalEngine } from "../analytical-engine-v2/engine.js";
import { analysisCapability } from "./analysis-capability.js";
import { classifyTurnOwner } from "../analytical-engine-v2/production/turn-owner.js";
import { buildOwnershipContext } from "../analytical-engine-v2/production/turn-context.js";
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
          "analytical engine: analytical_engine_v2",
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
          "analytical engine: analytical_engine_v2",
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
        const mem0 = sessionMemoryRef.current;
        const ownerCtx = buildOwnershipContext(text, {
          canPlan: typeof chatClient.planAnalyticalTurn === "function",
          isSlash: resolveSlashSubmission(text) !== null,
          hasSelection: Boolean(selectionRef.current),
          lastV1Result: mem0.recentResults.find((r) => r.id === mem0.lastResultId) ?? mem0.recentResults[mem0.recentResults.length - 1],
          v1ResultCount: mem0.recentResults.length,
          v1ClarificationPending: Boolean(mem0.pendingClarification),
          v2ClarificationPending: Boolean(analyticalStateRef.current.suspended),
          hasV2Table: Boolean(analyticalStateRef.current.tableRef),
        });
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

        if (route.route === "workbook_qa") {
          const descSnap = await readSelectionSnapshot(port).catch(() => undefined);
          if (descSnap) {
            let descStartsBelowRow1 = false;
            try {
              const { localAddress } = splitSheetAddress(descSnap.address);
              descStartsBelowRow1 = parseLocalRange(localAddress || descSnap.address).start.row > 0;
            } catch {
              /* keep false */
            }
            const descSchema = induceTableSchema({
              values: descSnap.values,
              numberFormats: descSnap.numberFormats,
              formulas: descSnap.formulas,
              sheetName: descSnap.sheetName,
              sourceRange: descSnap.address,
              sourceVersion: sourceVersionOf(descSnap),
              startsBelowRow1: descStartsBelowRow1,
            });
            if (descSchema.orientation === "row_records" && descSchema.confidence >= 0.5) {
              setLanguage(lang);
              selectionRef.current = descSnap;
              if (!suppressCommandEcho) append({ kind: "command", id: nextId("cmd"), text });
              const descLocal = descSnap.address.split("!").pop() ?? descSnap.address;
              append({
                kind: "activity",
                id: nextId("act"),
                activity: "reading",
                title: `${descSnap.sheetName}!${descLocal} · ${descSnap.totalRowCount} rows × ${descSnap.totalColumnCount} columns`,
                status: "done",
              });
              const descBody = describeSchema(descSchema, lang === "ru" ? "ru" : "en");
              append({ kind: "response", id: nextId("res"), streaming: false, text: descBody });
              conversationRef.current = [...conversationRef.current, { role: "user", content: text }, { role: "assistant", content: descBody }];
              commitTrace({ text, at: new Date().toISOString(), routeChosen: "flat_table_describe", detectedResultAction: null, outcome: "described" });
              return;
            }
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

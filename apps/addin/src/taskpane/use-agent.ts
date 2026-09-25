import { useCallback, useMemo, useRef, useState } from "react";
import type { ExcelPort, ExcelMutationPort } from "@sheet-agent/application";
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
import type { AgentLoopState } from "../agent/types.js";
import { classifyAgentEligibility } from "../app/agent-eligibility.js";
import {
  buildColumnClarification,
  buildDatasetClarification,
  buildReferenceClarification,
  clearClarification,
  emptySessionMemory,
  forgetChartPlacement,
  forgetSheet,
  interpretClarificationAnswer,
  isUndoPhrase,
  projectMemoryForModel,
  rememberChart,
  rememberResult,
  rememberRowSet,
  resolveReference,
  setClarification,
} from "../app/conversation-memory.js";
import type { PendingClarification, ResultRef, SessionMemory } from "../app/session-memory.js";
import { isExtremeQuestion, isMutationRequest, isTransformRequest, routeTurn } from "../app/conversation-route.js";
import { sourceVersionOf } from "../app/source-freshness.js";
import { detectResultAction, type ResultActionIntent } from "../app/result-action-intent.js";
import { groundEntitiesToRows } from "../app/entity-grounding.js";
import { extractEntitySet, mentionsConversationalReference } from "../app/entity-reference.js";
import { DEFAULT_HIGHLIGHT_COLOR } from "../app/highlight-color.js";
import { detectGroupedRanking, planGroupedRanking } from "../app/grouped-ranking.js";
import { induceTableSchema } from "../app/schema/schema-induction.js";
import { describeSchema } from "../app/schema/describe-schema.js";
import { BUILD_INFO } from "../app/build-info.js";
// ----- Stage 26.8: the unified analytical engine, in production -------------
import { classifyTurnOwner } from "../analytical-engine-v2/production/turn-owner.js";
import { buildOwnershipContext } from "../analytical-engine-v2/production/turn-context.js";
import { beginTurn, recordAnalyticalExecution } from "../analytical-engine-v2/production/turn-ledger.js";
import { EMPTY_ANALYTICAL_STATE, withoutSuspension, type AnalyticalConversationState } from "../analytical-engine-v2/state/conversation-state.js";
import { commitTrace, getResultActionTraces, type MutableResultActionTrace, type ResultActionTrace } from "../app/result-action-trace.js";
import { renderDebugConsole } from "./debug-console.js";
import { createTurnHelpers, renderGridMarkdown } from "./turn-helpers.js";
import { resolveAnalyticalTable, runAnalyticalTurn, type AnalyticalTurnContext } from "./analytical-turn.js";
import { runResultAction as runResultActionTurn } from "./result-action-turn.js";
import { guardMutationClaim, runFlatRecordsTurn, type FlatRecordsTurnContext } from "./flat-records-turn.js";
import { commonNumericColumns, planCrossSheetComparison } from "../app/cross-sheet-compare.js";
import { buildCompareReport, isCompareError } from "../app/commands/compare.js";
import { resultToChartData } from "../app/result-to-chart.js";
import {
  buildHighlightRowSetActions,
  isCompileError,
} from "../app/result-actions.js";
import {
  applyResultTransform,
  detectResultTransform,
  isTransformError,
  rankRequestCount,
  type TransformDetection,
} from "../app/result-transforms.js";
import type { ChartInsertDims } from "./components/ChartCard.js";
import { nextId, type ActivityStatus, type TranscriptEntry, type UndoableChange } from "../app/agent-session.js";
import type { ExecutionTimings } from "../analytical-engine-v2/production/execution-progress.js";

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

/** Compact GitHub-flavoured markdown table for a derived result grid. */
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

  /**
   * Stage 28G §14 — the refs `analytical-turn` is allowed to touch, and only
   * those. The bridge reads and writes conversation state through these
   * accessors, so the task pane's own refs stay the single storage.
   */
  /** Stage 28G §14 — the refs the flat-records path may touch, and only those. */
  const flatRecordsContext = useCallback(
    (lang: ResponseLanguage): FlatRecordsTurnContext => ({
      lang,
      port,
      chatClient,
      model,
      append,
      setActivity,
      safeBuildMap: async () => {
        try {
          return await buildWorkbookMap(port);
        } catch {
          return null;
        }
      },
      selection: () => selectionRef.current,
      history: () => conversationRef.current,
      memory: () => sessionMemoryRef.current,
      setMemory: (next) => {
        sessionMemoryRef.current = next;
      },
      recordExchange: (userMessage, assistantMessage) => {
        conversationRef.current = [...conversationRef.current, { role: "user", content: userMessage }, { role: "assistant", content: assistantMessage }];
      },
    }),
    [append, chatClient, model, port, setActivity],
  );

  const analyticalTurnContext = useCallback(
    (text: string, lang: ResponseLanguage): AnalyticalTurnContext => ({
      text,
      language: lang === "ru" ? "ru" : "en",
      port,
      chatClient,
      model,
      append,
      patchEntries: (map) => setEntries((current) => map(current)),
      setLanguage: () => setLanguage(lang),
      setBusy,
      setTurnStartedAt,
      nextTurnSeq: () => (turnSeqRef.current += 1),
      turnSeq: () => turnSeqRef.current,
      setAbortController: (controller) => {
        v2AbortRef.current = controller;
      },
      selection: () => selectionRef.current,
      setSelection: (snap) => {
        selectionRef.current = snap;
      },
      analyticalState: () => analyticalStateRef.current,
      setAnalyticalState: (next) => {
        analyticalStateRef.current = next;
      },
      memory: () => sessionMemoryRef.current,
      setMemory: (next) => {
        sessionMemoryRef.current = next;
      },
      recordExchange: (userMessage, assistantMessage) => {
        conversationRef.current = [...conversationRef.current, { role: "user", content: userMessage }, { role: "assistant", content: assistantMessage }];
      },
      recordTurnTimings,
    }),
    [append, chatClient, model, port, recordTurnTimings],
  );

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

      // Stage 24.5.2 §1/§18 — the developer surface, owned by `debug-console`.
      // Matched before anything else so a `/debug…` form never reaches a route.
      {
        const report = renderDebugConsole(text, {
          plannerTransportAvailable: typeof chatClient.planAnalyticalTurn === "function",
          analyticalState: analyticalStateRef.current,
          lastTurnTimings: turnTimingsRef.current,
          memory: sessionMemoryRef.current,
        });
        if (report !== null) {
          setLanguage(lang);
          append({ kind: "command", id: nextId("cmd"), text });
          append({ kind: "response", id: nextId("res"), streaming: false, text: report });
          return;
        }
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

      // Stage 28G §14 — the per-turn primitives every route below shares, and
      // the result-action turn, both owned by their own modules.
      const helpers = createTurnHelpers({
        text,
        lang,
        port,
        append,
        memory: () => sessionMemoryRef.current,
        setMemory: (next) => {
          sessionMemoryRef.current = next;
        },
        recordExchange: (userMessage, assistantMessage) => {
          conversationRef.current = [...conversationRef.current, { role: "user", content: userMessage }, { role: "assistant", content: assistantMessage }];
        },
      });
      const { say, emitTransform, findResult, resolveRankTarget, safeBuildMap, resultIsFresh } = helpers;
      const runResultAction = (action: ResultActionIntent): Promise<void> =>
        runResultActionTurn(action, {
          text,
          lang,
          port,
          append,
          memory: () => sessionMemoryRef.current,
          setMemory: (next) => {
            sessionMemoryRef.current = next;
          },
          recordExchange: (userMessage, assistantMessage) => {
            conversationRef.current = [...conversationRef.current, { role: "user", content: userMessage }, { role: "assistant", content: assistantMessage }];
          },
          trace: raTrace,
          helpers,
        });

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

      // Stage 24.4 — the flat-records capability path, owned by its module.
      const runAgentTask = (userRequest: string, resume?: { readonly state: AgentLoopState; readonly answer: string }): Promise<void> =>
        runFlatRecordsTurn(userRequest, flatRecordsContext(lang), resume);

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
            helpers.sayStaleSource();
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
      // §4 says exactly one engine may own a turn, so V2 is not inserted among
      // the branches below — it is asked FIRST, and when it answers "mine",
      // none of them runs at all. §11 — and it does not hand a turn back:
      // `runAnalyticalTurn` ends the turn inside itself, so a V2 defect is
      // always visible as a V2 answer.
      //
      // Cheap checks first; the table is resolved only for a turn that has
      // already passed every one of them.
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
          const resolved = await resolveAnalyticalTable(port, analyticalStateRef.current.tableRef?.sourceRange);
          const decision = classifyTurnOwner({ ...ownerCtx, hasTable: resolved.table !== null, selectionIsForeign: resolved.selectionIsForeign });
          if (decision.dropSuspension) analyticalStateRef.current = withoutSuspension(analyticalStateRef.current);
          if (decision.owner === "V2_OWNED") {
            beginTurn(nextId("uturn"), text, decision.owner, decision.reason);
            await runAnalyticalTurn(resolved.table, analyticalTurnContext(text, lang));
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
            append({ kind: "response", id: nextId("res"), streaming: false, text: pending.question });
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
        const knownEntities = mem.recentResults.flatMap((r) => r.columns);
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
              sourceSheet: snap.sheetName,
              sourceRange: snap.address,
              sourceVersion: sourceVersionOf(snap),
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
        if (route.route === "general_chat") {
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
            sourceSheet: s.sourceSheet || activeSelection.sheetName,
            sourceRange: s.sourceRange || activeSelection.address,
            sourceVersion: sourceVersionOf(activeSelection),
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
    };
  }, []);

  return useMemo(
    () => ({ entries, busy, turnStartedAt, undoStack, language, submit, approve, reject, undoLast, insertChart, reset, __sessionMemoryDebug }),
    [entries, busy, turnStartedAt, undoStack, language, submit, approve, reject, undoLast, insertChart, reset, __sessionMemoryDebug],
  );
}

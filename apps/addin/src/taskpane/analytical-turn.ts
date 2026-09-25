import type { CellValue, ExcelPort } from "@sheet-agent/application";
import { formatSeconds, nextId, type ExecutionDetail, type TranscriptEntry } from "../app/agent-session.js";
import type { ChatClient } from "../app/chat-client.js";
import type { ResponseLanguage } from "../app/language.js";
import { readAddressSnapshot, readSelectionSnapshot, type SelectionSnapshot } from "../app/workbook-context.js";
import { parseLocalRange, splitSheetAddress } from "../app/a1.js";
import { sourceVersionOf } from "../app/source-freshness.js";
import { induceTableSchema, type TableSchema } from "../app/schema/schema-induction.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import { rememberResult } from "../app/conversation-memory.js";
import type { SessionMemory } from "../app/session-memory.js";
import { runAnalyticalEngine } from "../analytical-engine-v2/engine.js";
import type { AnalyticalConversationState } from "../analytical-engine-v2/state/conversation-state.js";
import { finishTurn, recordAnalyticalExecution } from "../analytical-engine-v2/production/turn-ledger.js";
import {
  containsInternalLeak,
  fallbackNote,
  failureMessage as v2FailureMessage,
  leakReplacement,
  provenanceLine,
  sandboxFailureMessage,
} from "../analytical-engine-v2/production/answer-ux.js";
import { completionLabel, executionMetrics, progressStepFor, pythonSummaryLabel, stoppedLabel } from "../analytical-engine-v2/production/progress-labels.js";
import type { ExecutionEvent, ExecutionTimings } from "../analytical-engine-v2/production/execution-progress.js";
import { analysisCapability } from "./analysis-capability.js";

/**
 * Stage 26.8 §4-§21 · Stage 28G §14 — the ANALYTICAL execution bridge.
 *
 * Everything between "V2 owns this turn" and a transcript row lives here: the
 * table identity V2 analyses, the progress timeline, the one engine call, the
 * leak gate, and the single typed handoff that commits the verified primary
 * result as a `ResultRef` so a follow-up mutation has something real to act
 * on. Nothing in this module reads the user's text for meaning and nothing in
 * it falls back to another engine — §11 is structural here: once
 * `runAnalyticalTurn` is entered, the turn ends inside it.
 */
export interface AnalyticalTable {
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  readonly snap: SelectionSnapshot;
}

export interface AnalyticalTableResolution {
  readonly table: AnalyticalTable | null;
  /** §6/§39 — the live selection is a table V2 does not analyse. */
  readonly selectionIsForeign: boolean;
}

/** §14 — the table identity V2 analyses: the live selection, or its own memory. */
export async function resolveAnalyticalTable(port: ExcelPort, knownRange: string | undefined): Promise<AnalyticalTableResolution> {
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
  const selectionIsForeign = Boolean(
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
  if (!usable(snap, schema) && !selectionIsForeign && knownRange) {
    const knownSnap = await readAddressSnapshot(port, knownRange).catch(() => undefined);
    if (knownSnap) {
      const knownSchema = induce(knownSnap);
      if (usable(knownSnap, knownSchema)) {
        snap = knownSnap;
        schema = knownSchema;
      }
    }
  }
  if (!usable(snap, schema)) return { table: null, selectionIsForeign };
  return { table: { schema, grids: { values: snap!.values, numberFormats: snap!.numberFormats }, snap: snap! }, selectionIsForeign };
}



export interface AnalyticalTurnContext {
  readonly text: string;
  readonly language: ResponseLanguage;
  readonly port: ExcelPort;
  readonly chatClient: ChatClient;
  readonly model?: string | undefined;
  readonly append: (entry: TranscriptEntry) => void;
  readonly patchEntries: (map: (entries: readonly TranscriptEntry[]) => readonly TranscriptEntry[]) => void;
  readonly setLanguage: () => void;
  readonly setBusy: (busy: boolean) => void;
  readonly setTurnStartedAt: (at: number | null) => void;
  /** §21 — the sequence a cancelled turn loses. */
  readonly nextTurnSeq: () => number;
  readonly turnSeq: () => number;
  readonly setAbortController: (controller: AbortController | null) => void;
  readonly selection: () => SelectionSnapshot | undefined;
  readonly setSelection: (snap: SelectionSnapshot) => void;
  readonly analyticalState: () => AnalyticalConversationState;
  readonly setAnalyticalState: (next: AnalyticalConversationState) => void;
  readonly memory: () => SessionMemory;
  readonly setMemory: (next: SessionMemory) => void;
  readonly recordExchange: (userMessage: string, assistantMessage: string) => void;
  readonly recordTurnTimings: (timings: ExecutionTimings) => void;
}

export async function runAnalyticalTurn(table: AnalyticalTable | null, ctx: AnalyticalTurnContext): Promise<void> {
  ctx.setLanguage();
  ctx.setBusy(true);
  ctx.append({ kind: "command", id: nextId("cmd"), text: ctx.text });
  recordAnalyticalExecution("analytical_engine_v2");
  const seq = (ctx.nextTurnSeq());
  const language: ResponseLanguage = ctx.language;
  const say = (body: string, outcome: "answered" | "clarify" | "failed", v2TurnId?: string): void => {
    ctx.append({ kind: "response", id: nextId("res"), streaming: false, text: body });
    ctx.recordExchange(ctx.text, body);
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
    ctx.setSelection(table.snap);

    const turnStarted = Date.now();
    ctx.setTurnStartedAt(turnStarted);
    let openStep: { readonly id: string; readonly title: string } | null = null;
    const timeline: { readonly id: string; detail: ExecutionDetail }[] = [];
    const liveExecutionId = nextId("exec");
    const liveTitle = language === "ru" ? "Выполняю анализ" : "Running analysis";
    const refreshExecution = (status: "running" | "done" | "error", title = liveTitle, timings: ExecutionTimings | null = null): void => {
      ctx.patchEntries((current) =>
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
    ctx.append({ kind: "execution", id: liveExecutionId, title: liveTitle, status: "running", details: [], metrics: [] });
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
      if (seq !== ctx.turnSeq()) return;
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
      ctx.patchEntries((current) => current.map((entry) => entry.id === liveExecutionId && entry.kind === "execution" ? {
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
    ctx.setAbortController(controller);
    const turnId = nextId("turn");
    const turn = await runAnalyticalEngine({
      turnId,
      request: ctx.text,
      schema: table.schema,
      grids: table.grids,
      language,
      state: ctx.analyticalState(),
      onProgress,
      decide: (messages) => ctx.chatClient.planAnalyticalTurn!(messages, controller.signal, ctx.model),
      narrate: async (messages) => (typeof ctx.chatClient.narrate === "function" ? ctx.chatClient.narrate(messages, controller.signal, ctx.model) : ""),
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
      ...(typeof ctx.chatClient.generateAnalysisCode === "function"
        ? (() => {
            const analysis = analysisCapability({
              generateCode: (messages) => ctx.chatClient.generateAnalysisCode!(messages, controller.signal, ctx.model),
              currentSourceVersion: () =>
                (() => {
                      const snap = ctx.selection();
                      return snap ? sourceVersionOf(snap) : table.schema.sourceVersion;
                    })(),
            });
            return analysis ? { analysis } : {};
          })()
        : {}),
    });

    // §21 — a cancelled turn appends nothing. `reset` bumps the sequence and
    // aborts the transport; whatever arrives afterwards belongs to a chat
    // that no longer exists, and the state it computed is dropped with it.
    if (seq !== ctx.turnSeq()) return;
    closeOpenStep();
    ctx.recordTurnTimings(turn.timings);

    if (turn.kind === "answered") {
      // §12/§17 — the conversation's state is whatever the ENGINE committed
      // from its verified execution. The task pane stores it; never edits it.
      ctx.setAnalyticalState(turn.state);
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
      ctx.setMemory(rememberResult(ctx.memory(), {
        turnId,
        kind: "temporal_analysis",
        title: turn.analysis.primary.tool,
        spec: { op: "analytical_engine_v2", tool: turn.analysis.primary.tool },
        columns: turn.analysis.primary.fields.map((f) => f.name),
        rows: turn.analysis.primary.rows.map((r) => r.map((c) => c as CellValue)),
        rowsTruncated: false,
        sourceSheet: table.schema.sheetName,
        sourceRange: table.schema.sourceRange,
        sourceVersion: table.schema.sourceVersion,
      }));
      collapseTurn("done", turn.timings);
      say(body, "answered", turnId);
      return;
    }

    if (turn.kind === "clarify") {
      // §29 — an exhausted clarification loop still returns the state, but
      // the engine has already declined to suspend anything: the next
      // message starts clean instead of feeding the loop again.
      ctx.setAnalyticalState(turn.state);
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
    if (seq !== ctx.turnSeq()) return;
    say(
      error instanceof Error && error.name === "AbortError"
        ? language === "ru"
          ? "Запрос отменён."
          : "Request cancelled."
        : v2FailureMessage("model_error", language),
      "failed",
    );
  } finally {
    if (seq === ctx.turnSeq()) {
      ctx.setAbortController(null);
      ctx.setBusy(false);
      ctx.setTurnStartedAt(null);
    }
  }
}

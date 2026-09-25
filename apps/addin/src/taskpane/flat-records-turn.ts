import type { ExcelPort } from "@sheet-agent/application";
import { nextId, type ActivityStatus, type TranscriptEntry } from "../app/agent-session.js";
import { boundedHistory, type ConversationMessage } from "../app/conversation.js";
import type { ChatClient } from "../app/chat-client.js";
import { uiText, type ResponseLanguage } from "../app/language.js";
import type { SelectionSnapshot } from "../app/workbook-context.js";
import type { WorkbookMap } from "../app/commands/workbook-map.js";
import { containsForbiddenLeak } from "../app/answer-leak.js";
import { buildAgentClarification, rememberResult, setClarification } from "../app/conversation-memory.js";
import type { ResultKind, SessionMemory } from "../app/session-memory.js";
import { createProductionAgentDeps } from "../app/agent-deps.js";
import { createAgentToolRegistry } from "../agent/tool-registry.js";
import { runAgentLoop } from "../agent/agent-loop.js";
import type { AgentLoopState, AgentObservation, AgentStep } from "../agent/types.js";
import { agentEvidenceFacts, validateAgentAnswer } from "../agent/evidence.js";
import { recordAnalyticalExecution } from "../analytical-engine-v2/production/turn-ledger.js";
import { renderGridMarkdown } from "./turn-helpers.js";

/**
 * Stage 24.4 · Stage 28G §14 — the FLAT-RECORDS turn.
 *
 * The capability path V2 does not own: a records list, and questions that
 * cross sheets. Its invariants are its own and are enforced here rather than
 * in the routing file — the agent's tools are read-only, so no branch of this
 * module can mutate the workbook; every number in a final answer must be
 * supported by an observation or the verified table is shown instead; and the
 * primary tabular observation is committed as an ordinary `ResultRef` with the
 * freshness token of every leaf range in its lineage, so a later mutation on
 * it can be refused.
 */
export interface FlatRecordsTurnContext {
  readonly lang: ResponseLanguage;
  readonly port: ExcelPort;
  readonly chatClient: ChatClient;
  readonly model?: string | undefined;
  readonly append: (entry: TranscriptEntry) => void;
  readonly setActivity: (id: string, status: ActivityStatus, detail?: string, durationMs?: number) => void;
  readonly safeBuildMap: () => Promise<WorkbookMap | null>;
  readonly selection: () => SelectionSnapshot | undefined;
  readonly history: () => readonly ConversationMessage[];
  readonly memory: () => SessionMemory;
  readonly setMemory: (next: SessionMemory) => void;
  readonly recordExchange: (userMessage: string, assistantMessage: string) => void;
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

function finalizeAgentRun(state: AgentLoopState, userRequest: string, sourceIdentity: string | undefined, ctx: FlatRecordsTurnContext): void {
  if (state.status === "awaiting_clarification" && state.pendingClarification) {
    const pc = state.pendingClarification;
    // Stage 25.1.2 §8/§10 — the model's own clarifying question, never
    // shown raw.
    const question = containsForbiddenLeak(pc.question)
      ? ctx.lang === "ru"
        ? "Уточните, пожалуйста, запрос."
        : "Could you clarify the request?"
      : pc.question;
    ctx.setMemory(setClarification(ctx.memory(), buildAgentClarification(userRequest, question, pc.candidates, state, sourceIdentity)));
    ctx.append({ kind: "response", id: nextId("res"), streaming: false, text: question });
    ctx.recordExchange(userRequest, question);
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
      const src = primary.source ?? ctx.selection()?.sheetName ?? "workbook";
      const sheet = src.includes("!") ? src.slice(0, src.indexOf("!")) : src.includes(" vs ") ? src.slice(0, src.indexOf(" vs ")) : src;
      const parents = primary.derivedFrom ?? [];
      // §7/§11 (24.4) — collect the freshness token of EVERY leaf worksheet
      // read in this result's lineage, so a later mutation on the result
      // can be refused if any source changed.
      const versions = collectAgentSourceVersions(primary, state.observations);
      const firstV = versions[0];
      ctx.setMemory(rememberResult(ctx.memory(), {
        turnId: nextId("turn"),
        kind,
        title: primary.operation ?? userRequest.slice(0, 100),
        spec: { agent: true, operation: primary.operation ?? primary.tool },
        columns: primary.columns,
        rows: primary.rows,
        rowsTruncated: primary.truncated ?? false,
        sourceSheet: firstV ? firstV.sourceRange.split("!")[0] ?? sheet : sheet,
        sourceRange: firstV ? firstV.sourceRange : primary.source ?? sheet,
        sourceVersion: firstV ? firstV.version : `agent:${primary.source ?? sheet}:${primary.rowCount ?? primary.rows.length}`,
        ...(versions.length > 0 ? { sourceVersions: versions } : {}),
        ...(parents.length === 1 ? { derivedFromResultId: parents[0]! } : {}),
        ...(parents.length >= 2 ? { derivedFromResultIds: [...parents] } : {}),
      }));
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
        (ctx.lang === "ru"
          ? "Я выполнил анализ, но не смог подтвердить все числа в сводке по результатам инструментов. Ниже — проверенная таблица."
          : "I ran the analysis but couldn't verify every figure in the summary against the tool results. Here is the verified table.") + grid;
    }
    ctx.append({ kind: "response", id: nextId("res"), streaming: false, text: answer });
    ctx.recordExchange(userRequest, answer);
    ctx.append({ kind: "activity", id: nextId("act"), activity: "completed", title: uiText(ctx.lang, "done"), status: "done" });
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
  const body = ctx.lang === "ru" ? ru : en;
  ctx.append({ kind: "response", id: nextId("res"), streaming: false, text: body });
  ctx.recordExchange(userRequest, body);
}

export async function runFlatRecordsTurn(
  userRequest: string,
  ctx: FlatRecordsTurnContext,
  resume?: { readonly state: AgentLoopState; readonly answer: string },
): Promise<void> {
  recordAnalyticalExecution("stage24_agent");
  const registry = createAgentToolRegistry(); // read-only tools only (no mutation tool exists)
  const deps = createProductionAgentDeps(ctx.port, { language: ctx.lang === "ru" ? "ru" : "en" });
  const map = await ctx.safeBuildMap();
  const workbookContext = buildAgentWorkbookContext(map, ctx.selection());
  const controller = new AbortController();
  const actId = nextId("act");
  ctx.append({ kind: "activity", id: actId, activity: "analyzing", title: uiText(ctx.lang, "analyzing"), status: "running" });
  const seenActivity = new Set<string>();
  let state: AgentLoopState;
  try {
    state = await runAgentLoop({
      taskId: nextId("agt"),
      request: userRequest,
      language: ctx.lang === "ru" ? "ru" : "en",
      registry,
      deps,
      workbookContext,
      ...(resume ? { resume } : {}),
      decide: (dctx) =>
        ctx.chatClient.decideAgentStep!(
          {
            originalUserRequest: dctx.originalUserRequest,
            language: dctx.language,
            history: boundedHistory(ctx.history()).map((m) => ({ role: m.role, content: m.content })),
            workbookContext: dctx.workbookContext,
            toolSchemas: dctx.toolSchemas,
            observations: dctx.observations,
            iteration: dctx.iteration,
            remainingSteps: dctx.remainingSteps,
            remainingReads: dctx.remainingReads,
            ...(ctx.model ? { model: ctx.model } : {}),
          },
          controller.signal,
        ),
      onStep: (step) => {
        const label = agentActivityLabel(step, ctx.lang, seenActivity);
        if (label) ctx.append({ kind: "activity", id: nextId("act"), activity: "calculating", title: label, status: "done" });
      },
    });
  } catch (error) {
    ctx.setActivity(actId, "error");
    ctx.append({ kind: "notice", id: nextId("ntc"), tone: "error", text: error instanceof Error ? error.message : "The analysis agent could not run." });
    return;
  }
  ctx.setActivity(actId, "done");
  finalizeAgentRun(state, userRequest, map?.sourceIdentity, ctx);
}

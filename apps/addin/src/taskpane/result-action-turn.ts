import type { CellValue, ExcelPort } from "@sheet-agent/application";
import { nextId, type TranscriptEntry } from "../app/agent-session.js";
import type { ResponseLanguage } from "../app/language.js";
import { readAddressSnapshot } from "../app/workbook-context.js";
import { resolveSheet } from "../app/commands/workbook-resolver.js";
import { DEFAULT_HIGHLIGHT_COLOR, parseHighlightColor } from "../app/highlight-color.js";
import {
  buildChartColumnsClarification,
  buildEntityActionClarification,
  rememberChart,
  rememberRowSet,
  resolveReference,
  setClarification,
} from "../app/conversation-memory.js";
import { extractEntitySet, resolveActionReference, type EntitySet } from "../app/entity-reference.js";
import { groundEntitiesToRows } from "../app/entity-grounding.js";
import { revalidateSource } from "../app/source-freshness.js";
import { buildCopyRowSetActions, buildHighlightRowSetActions, buildWriteResultActions, isCompileError } from "../app/result-actions.js";
import { resultToChartData } from "../app/result-to-chart.js";
import type { ResultActionIntent } from "../app/result-action-intent.js";
import type { MutableResultActionTrace, ResultActionTrace } from "../app/result-action-trace.js";
import type { ResultRef, RowSetRef, SessionMemory } from "../app/session-memory.js";
import type { WorkflowStep } from "../app/agent-session.js";
import type { TurnHelpers } from "./turn-helpers.js";

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

/**
 * 24.5.3 — "the 3 worst" over a stored result picks THREE, not all of them.
 *
 * The result already names its entities; a superlative in the follow-up
 * narrows that set by the result's own last numeric column rather than by
 * re-reading the workbook, which is what keeps the action grounded in the
 * result the user is pointing at.
 */
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
 * Stage 24.5 · Stage 28G §14 — the RESULT-ACTION turn.
 *
 * What a write acts on, and how it is allowed to get there: the target comes
 * from the mutation store's own reference resolution (never the live
 * selection when a prior result exists), its freshness is revalidated against
 * the result's provenance, its entities are grounded to real source rows, and
 * the outcome is a PROPOSAL — nothing here applies a change. A partial
 * grounding stops the turn rather than mutating some of the rows (§16).
 */
export interface ResultActionContext {
  readonly text: string;
  readonly lang: ResponseLanguage;
  readonly port: ExcelPort;
  readonly append: (entry: TranscriptEntry) => void;
  readonly memory: () => SessionMemory;
  readonly setMemory: (next: SessionMemory) => void;
  readonly recordExchange: (userMessage: string, assistantMessage: string) => void;
  readonly trace: MutableResultActionTrace;
  readonly helpers: TurnHelpers;
}

export async function runResultAction(action: ResultActionIntent, ctx: ResultActionContext): Promise<void> {
  const helpers = ctx.helpers;
    const m = ctx.memory();
    const lastResult = m.recentResults.find((r) => r.id === m.lastResultId) ?? m.recentResults[m.recentResults.length - 1];
    const ref = resolveReference(ctx.text, m);
    const resolvedResult: ResultRef | undefined =
      ref.kind === "resolved" && ref.target.kind === "result" ? ref.target.ref : lastResult;

    if (action.kind === "chart") {
      if (!resolvedResult) {
        helpers.say("There's no active analytical result to chart yet. Run an analysis first.", "Пока нет активного результата анализа для построения графика. Сначала выполните анализ.");
        return;
      }
      // 24.3.2 — a single-value answer ("which one is worst?") is not itself a
      // useful chart; walk up its lineage to the table it was derived from.
      let chartRef = resolvedResult;
      const seenChartIds = new Set<string>();
      while (chartRef.kind === "scalar" && chartRef.derivedFromResultId && !seenChartIds.has(chartRef.id)) {
        seenChartIds.add(chartRef.id);
        const parent = helpers.findResult(chartRef.derivedFromResultId);
        if (!parent) break;
        chartRef = parent;
      }
      const outcome = resultToChartData(chartRef, ctx.lang);
      if (outcome.kind === "error") {
        helpers.say(`I can't chart that — ${outcome.error}.`, `Не получится построить график — ${outcome.error}.`);
        return;
      }
      if (outcome.kind === "clarify") {
        // 24.3.1 — a typed chart_columns clarification: a short answer resumes
        // THIS ResultRef → ChartData, never a fresh workbook query.
        ctx.setMemory(setClarification(
          m,
          buildChartColumnsClarification(ctx.text, outcome.question, outcome.candidates, chartRef.id, ctx.lang),
        ));
        ctx.append({ kind: "response", id: nextId("res"), streaming: false, text: outcome.question });
        return;
      }
      ctx.append({ kind: "chart", id: nextId("cht"), data: outcome.chart });
      ctx.setMemory(rememberChart(ctx.memory(), { turnId: nextId("turn"), data: outcome.chart, fromResultId: chartRef.id }));
      const line =
        ctx.lang === "ru"
          ? `Готово — график по результату «${chartRef.title}» показан в панели.`
          : `Here's a chart of "${chartRef.title}", shown in the panel.`;
      ctx.append({ kind: "response", id: nextId("res"), streaming: false, text: line });
      ctx.recordExchange(ctx.text, line);
      return;
    }

    if (action.kind === "insert_chart") {
      if (!m.lastChart) {
        helpers.say("There's no chart to insert right now.", "Сейчас нет графика для вставки.");
        return;
      }
      helpers.say(
        'The chart is shown in the panel — use "Insert into Excel" beneath it to place it in the workbook.',
        "График показан в панели. Нажмите «Вставить в Excel» под ним, чтобы разместить его в книге.",
      );
      return;
    }

    if (action.kind === "highlight" || action.kind === "copy") {
      const colour = parseHighlightColor(ctx.text);
      const colorHex = colour?.hex ?? DEFAULT_HIGHLIGHT_COLOR;
      const colourWordEn = colour ? ` ${colour.name}` : " yellow";
      const colourWordRu = colour
        ? ` ${({ red: "красным", yellow: "жёлтым", green: "зелёным" } as const)[colour.name]}`
        : " жёлтым";

      // 24.5 §3/§4 — resolve the conversational reference against COMPATIBLE
      // memory (a chart is never a highlight target); §5 — the live selection
      // is not consulted when a prior result exists.
      const aref = resolveActionReference(ctx.text, m, action.kind, ctx.lang === "ru" ? "ru" : "en");
      ctx.trace.resolvedReference = {
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
        ctx.trace.candidateReferences = cands.sort((a, b) => a.order - b.order);
        ctx.trace.chosenReference =
          aref.kind === "result"
            ? `result:${aref.ref.id}`
            : aref.kind === "rowset"
              ? `rowset:${aref.ref.id}`
              : aref.kind === "chart"
                ? `chart:${aref.ref.id}`
                : aref.kind;
      }
      if (aref.kind === "none") {
        ctx.trace.outcome = `no_object:${aref.reason}`;
        if (aref.reason === "evicted") {
          helpers.say(
            "I don't have that earlier result in view any more. Re-run the analysis, then ask again.",
            "У меня больше нет того результата под рукой. Повторите анализ и спросите снова.",
          );
          return;
        }
        helpers.say(
          'There\'s no active set of rows for that. Find or compute the rows first — for example "show the 3 managers with the worst Variance".',
          "Сейчас нет активного набора строк. Сначала найдите или вычислите нужные строки — например «покажи 3 менеджеров с худшим Variance».",
        );
        return;
      }
      if (aref.kind === "clarify") {
        ctx.trace.outcome = "clarify_entity_column";
        if (aref.candidates.length === 0) {
          helpers.say(aref.question, aref.question);
          return;
        }
        ctx.setMemory(setClarification(
          m,
          buildEntityActionClarification(
            ctx.text,
            aref.question,
            aref.candidates,
            aref.resultId ?? "",
            {
              action: action.kind,
              ...(colour ? { colorHex } : {}),
              ...(action.sheetName ? { sheetName: action.sheetName } : {}),
            },
            ctx.lang,
          ),
        ));
        ctx.append({ kind: "response", id: nextId("res"), streaming: false, text: aref.question });
        return;
      }

      let rowSet: RowSetRef | undefined;
      let groundedValues: readonly CellValue[] | undefined;
      if (aref.kind === "rowset") {
        rowSet = aref.ref;
        ctx.trace.source = { sheet: rowSet.sourceSheet, sourceRange: rowSet.sourceRange, sourceVersion: rowSet.sourceVersion };
        if ((await revalidateSource(ctx.port, rowSet.sourceRange, rowSet.sourceVersion)) !== "fresh") {
          ctx.trace.outcome = "stale_source";
          helpers.sayStaleSource();
          return;
        }
      } else if (aref.kind === "result") {
        // 24.5 §5–§8 — ground the result's entities to source rows using the
        // RESULT's own provenance (never the live selection).
        const targetRef = aref.ref;
        ctx.trace.source = { sheet: targetRef.sourceSheet, sourceRange: targetRef.sourceRange, sourceVersion: targetRef.sourceVersion };
        if (!(await helpers.resultIsFresh(targetRef))) {
          ctx.trace.outcome = "stale_source";
          helpers.sayStaleSource();
          return;
        }
        const es0 = aref.entitySet && aref.entitySet.kind === "set" ? aref.entitySet : extractEntitySet(targetRef);
        if (es0.kind !== "set") {
          helpers.say(
            "I couldn't tell which rows to act on from that result. Could you say which column identifies them?",
            "Не понял, какие строки выделить по этому результату. Уточните, какой столбец их определяет.",
          );
          return;
        }
        const reduced = reduceEntitySetBySuperlative(targetRef, es0, ctx.text);
        const grounded = await groundEntitiesToRows(ctx.port, {
          sourceRange: targetRef.sourceRange,
          sourceVersion: targetRef.sourceVersion,
          entityColumn: reduced.column,
          entityValues: reduced.values,
        });
        if (!grounded.ok) {
          ctx.trace.outcome = `grounding_failed:${grounded.kind}`;
          if (grounded.kind === "stale_source") {
            helpers.sayStaleSource();
            return;
          }
          helpers.say(
            `I can't work out which rows to ${action.kind === "highlight" ? "highlight" : "copy"} — ${grounded.message}.`,
            `Не могу определить, какие строки ${action.kind === "highlight" ? "выделить" : "скопировать"} — ${grounded.message}.`,
          );
          return;
        }
        ctx.trace.grounding = {
          matchedCount: grounded.matchedValues.length,
          unmatchedCount: grounded.unmatchedValues.length,
          sheetRowsCount: grounded.sheetRows.length,
          sheetRowsMin: grounded.sheetRows[0] ?? null,
          sheetRowsMax: grounded.sheetRows[grounded.sheetRows.length - 1] ?? null,
        };
        if (grounded.sheetRows.length === 0) {
          ctx.trace.outcome = "no_matching_rows";
          helpers.say(
            `No rows in the source data match ${reduced.column} = ${reduced.values.map(String).join(", ")}.`,
            `В исходных данных нет строк, где ${reduced.column} = ${reduced.values.map(String).join(", ")}.`,
          );
          return;
        }
        // §16 — never silently apply a partial mutation.
        if (grounded.unmatchedValues.length > 0) {
          ctx.trace.outcome = "partial_resolution";
          helpers.say(
            `I matched ${grounded.matchedValues.join(", ")} to source rows, but couldn't find ${grounded.unmatchedValues.join(", ")}. Nothing has been changed — say "continue" to proceed with just the matched ${grounded.matchedValues.length === 1 ? "one" : "ones"}.`,
            `Сопоставил со строками: ${grounded.matchedValues.join(", ")}, но не нашёл: ${grounded.unmatchedValues.join(", ")}. Ничего не изменено — напишите «продолжай», чтобы применить только к найденным.`,
          );
          return;
        }
        groundedValues = reduced.values;
        ctx.setMemory(rememberRowSet(ctx.memory(), {
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
        }));
        rowSet = ctx.memory().lastRowSet;
      } else {
        helpers.say(
          "That refers to a chart, which can't be highlighted. Point me at an analytical result or a set of rows.",
          "Это относится к графику — его нельзя выделить. Укажите результат анализа или набор строк.",
        );
        return;
      }

      if (!rowSet) {
        helpers.say("There's no active set of rows for that.", "Сейчас нет активного набора строк.");
        return;
      }

      if (action.kind === "highlight") {
        const built = buildHighlightRowSetActions(rowSet, colorHex);
        if (isCompileError(built)) {
          ctx.trace.outcome = `action_build_failed:${built.error}`;
          ctx.trace.actionBuild = {
            sourceWidth: 0,
            contiguousRuns: 0,
            chunkedRuns: (built.rejected ?? []).length,
            actionsBuilt: 0,
            rejectedActions: (built.rejected ?? []).length,
            rejectReasons: (built.rejected ?? []).map((r) => `${r.address} (${r.cells}): ${r.reason}`),
          };
          helpers.say(`I can't highlight those rows — ${built.error}.`, `Не получится выделить эти строки — ${built.error}.`);
          return;
        }
        ctx.trace.actionBuild = {
          sourceWidth: built.width,
          contiguousRuns: built.actions.length + built.rejected.length,
          chunkedRuns: built.actions.length + built.rejected.length,
          actionsBuilt: built.actions.length,
          rejectedActions: built.rejected.length,
          rejectReasons: built.rejected.map((r) => `${r.address} (${r.cells}): ${r.reason}`),
        };
        const forWhomEn = groundedValues && groundedValues.length > 0 ? ` for ${groundedValues.map(String).join(", ")}` : "";
        const forWhomRu = groundedValues && groundedValues.length > 0 ? ` для ${groundedValues.map(String).join(", ")}` : "";
        helpers.say(
          `Found ${rowSet.count} row(s)${forWhomEn}. They will be highlighted${colourWordEn}. Approve the change to apply it.`,
          `Найдено ${rowSet.count} строк${forWhomRu}. Они будут выделены${colourWordRu}. Подтвердите изменение, чтобы применить.`,
        );
        ctx.append({ kind: "proposal", id: nextId("prop"), actions: built.actions, state: "pending" });
        helpers.proposeActions(built.actions.length);
        ctx.trace.proposalCreated = true;
        ctx.trace.outcome = "highlight_proposed";
        return;
      }
      if (!action.sheetName) {
        helpers.say("Which worksheet should I copy those rows to?", "На какой лист скопировать эти строки?");
        return;
      }
      const map = await helpers.safeBuildMap();
      const res = map ? resolveSheet(map, action.sheetName, { strict: true }) : ({ kind: "not_found" } as const);
      if (res.kind === "ambiguous") {
        helpers.say(
          `"${action.sheetName}" matches more than one worksheet: ${res.candidates.map((c: string) => `"${c}"`).join(", ")}. Use the exact name.`,
          `«${action.sheetName}» подходит под несколько листов: ${res.candidates.map((c: string) => `«${c}»`).join(", ")}. Уточните название.`,
        );
        return;
      }
      if (res.kind !== "ok") {
        helpers.say(`I couldn't find a worksheet named "${action.sheetName}".`, `Не нашёл лист с названием «${action.sheetName}».`);
        return;
      }
      const anchor = action.anchor ?? "A1";
      const existing = anchor === "A1" && res.sheet.usedAddress ? await readAddressSnapshot(ctx.port, res.sheet.usedAddress).catch(() => null) : null;
      const built = buildCopyRowSetActions(rowSet, { sheetName: res.sheet.name, anchor }, existing?.values);
      if (isCompileError(built)) {
        helpers.say(`I can't copy those rows — ${built.error}.`, `Не получится скопировать эти строки — ${built.error}.`);
        return;
      }
      helpers.say(
        `I'll copy ${rowSet.count} row(s) to ${res.sheet.name}!${built.destRange}.${helpers.overwriteNote(built.overwriteCells)} Approve the change to apply it.`,
        `Скопирую ${rowSet.count} строк в ${res.sheet.name}!${built.destRange}.${helpers.overwriteNote(built.overwriteCells)} Подтвердите изменение, чтобы применить.`,
      );
      ctx.append({ kind: "proposal", id: nextId("prop"), actions: [built.action], state: "pending" });
      helpers.proposeActions(1);
      return;
    }

    // action.kind === "write"
    if (!resolvedResult) {
      helpers.say("There's no active analytical result to write yet. Run an analysis first.", "Пока нет активного результата анализа для записи. Сначала выполните анализ.");
      return;
    }
    if (!action.sheetName) {
      helpers.say("Which worksheet should I write that table to?", "На какой лист записать эту таблицу?");
      return;
    }
    if (!(await helpers.resultIsFresh(resolvedResult))) {
      helpers.sayStaleSource();
      return;
    }
    const map = await helpers.safeBuildMap();
    const res = map ? resolveSheet(map, action.sheetName, { strict: true }) : ({ kind: "not_found" } as const);
    const anchor = action.anchor ?? "A1";
    if (res.kind === "ambiguous") {
      helpers.say(
        `"${action.sheetName}" matches more than one worksheet: ${res.candidates.map((c: string) => `"${c}"`).join(", ")}. Use the exact name.`,
        `«${action.sheetName}» подходит под несколько листов: ${res.candidates.map((c: string) => `«${c}»`).join(", ")}. Уточните название.`,
      );
      return;
    }

    if (action.newSheet || res.kind === "not_found") {
      const target = action.sheetName;
      const written = buildWriteResultActions(resolvedResult, { sheetName: target, anchor });
      if (isCompileError(written)) {
        helpers.say(`I can't write that table — ${written.error}.`, `Не получится записать таблицу — ${written.error}.`);
        return;
      }
      const workflow: WorkflowStep[] = [
        { kind: "create_sheet", name: target },
        { kind: "cells", actions: [written.action], label: `write "${resolvedResult.title}"` },
      ];
      helpers.say(
        `I'll create a "${target}" sheet and write "${resolvedResult.title}" (${written.rowsWritten}×${written.colsWritten}) to ${target}!${written.destRange}. Approve to run both as one change; one undo reverts the whole thing.`,
        `Создам лист «${target}» и запишу «${resolvedResult.title}» (${written.rowsWritten}×${written.colsWritten}) в ${target}!${written.destRange}. Подтвердите — всё выполнится одним действием, одна отмена вернёт всё назад.`,
      );
      ctx.append({ kind: "proposal", id: nextId("prop"), actions: [], workflow, state: "pending" });
      helpers.proposeActions(2);
      return;
    }

    // res.kind === "ok" → plain write into an existing sheet
    const existing = anchor === "A1" && res.sheet.usedAddress ? await readAddressSnapshot(ctx.port, res.sheet.usedAddress).catch(() => null) : null;
    const written = buildWriteResultActions(resolvedResult, { sheetName: res.sheet.name, anchor }, existing?.values);
    if (isCompileError(written)) {
      helpers.say(`I can't write that table — ${written.error}.`, `Не получится записать таблицу — ${written.error}.`);
      return;
    }
    helpers.say(
      `I'll write "${resolvedResult.title}" (${written.rowsWritten}×${written.colsWritten}) to ${res.sheet.name}!${written.destRange}.${helpers.overwriteNote(written.overwriteCells)} Approve the change to apply it.`,
      `Запишу «${resolvedResult.title}» (${written.rowsWritten}×${written.colsWritten}) в ${res.sheet.name}!${written.destRange}.${helpers.overwriteNote(written.overwriteCells)} Подтвердите изменение, чтобы применить.`,
    );
    ctx.append({ kind: "proposal", id: nextId("prop"), actions: [written.action], state: "pending" });
    helpers.proposeActions(1);
}

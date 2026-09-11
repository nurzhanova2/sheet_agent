// ---------------------------------------------------------------------------
// Stage 22 — deterministic resolution of the two condition-driven slash
// commands:
//   /highlight  → a real highlight_range mutation PROPOSAL (Preview → Approve →
//                 applyAction → snapshot undo). No model. The displayed count
//                 and the highlighted cells come from ONE matched row set.
//   /filter     → a read-only count + sample of the matching rows. No mutation.
// Both reuse the existing engine (selectMatchingRows) and, for /highlight, the
// existing mutation-safety pipeline — there is NO separate execution path.
// ---------------------------------------------------------------------------

import type { SelectionSnapshot } from "../workbook-context.js";
import type { ResponseLanguage } from "../language.js";
import { columnIndexToLetters, parseLocalRange, splitSheetAddress } from "../a1.js";
import type { HighlightAction, WorkbookAction } from "../workbook-actions.js";
import { contiguousRuns, selectMatchingRows } from "../../analysis/select-rows.js";
import { resolveSlashCondition } from "./condition.js";

/** Light amber fill, matching the app's existing highlight examples. */
export const HIGHLIGHT_COLOR = "#FFF2CC";
/** Defensive ceiling on the number of highlight actions produced for one turn. */
const MAX_HIGHLIGHT_RUNS = 100;

export interface DeterministicSlashResult {
  readonly text: string;
  readonly actions: readonly WorkbookAction[];
}

export interface SlashConditionError {
  readonly error: string;
}

export function isSlashConditionError(v: DeterministicSlashResult | SlashConditionError): v is SlashConditionError {
  return "error" in v;
}

function localColumns(selection: SelectionSnapshot): { readonly first: string; readonly last: string } {
  const local = splitSheetAddress(selection.address).localAddress || selection.address;
  const range = parseLocalRange(local);
  return { first: columnIndexToLetters(range.start.column), last: columnIndexToLetters(range.end.column) };
}

/**
 * Builds the `/highlight <condition>` proposal. The workbook is NOT touched here;
 * the returned `actions` flow through the normal proposal → Approve → applyAction
 * path, and the transcript only reports success after that mutation confirms.
 */
export function buildHighlightProposal(
  selection: SelectionSnapshot,
  args: string,
  language: ResponseLanguage,
): DeterministicSlashResult | SlashConditionError {
  const ru = language === "ru";
  const resolved = resolveSlashCondition(args, selection.headers ?? []);
  if ("error" in resolved) return { error: resolved.error };

  const matched = selectMatchingRows(selection, resolved.condition);
  if (matched.error) return { error: matched.error };

  const count = matched.sheetRows.length;
  const where = resolved.describe;
  const sheetName = splitSheetAddress(selection.address).sheetName || selection.sheetName;

  if (count === 0) {
    return {
      text: ru
        ? `Ни одна строка не подходит под условие ${where} — выделять нечего.`
        : `No rows match ${where} — there is nothing to highlight.`,
      actions: [],
    };
  }

  const { first, last } = localColumns(selection);
  const runs = contiguousRuns(matched.sheetRows);
  const capped = runs.slice(0, MAX_HIGHLIGHT_RUNS);
  const stamp = Date.now().toString(36);
  const description = ru
    ? `Заливка ${count} строк, где ${where}`
    : `Fill ${count} row(s) where ${where}`;
  const actions: HighlightAction[] = capped.map((run, index) => ({
    id: `hl_${stamp}_${index}`,
    type: "highlight_range",
    sheetName,
    range: run[0] === run[1] ? `${first}${run[0]}:${last}${run[0]}` : `${first}${run[0]}:${last}${run[1]}`,
    description,
    payload: { color: HIGHLIGHT_COLOR },
  }));

  const truncatedNote =
    runs.length > capped.length
      ? ru
        ? ` (подготовлены первые ${capped.length} диапазонов из ${runs.length})`
        : ` (first ${capped.length} of ${runs.length} ranges prepared)`
      : "";

  return {
    text: ru
      ? `Найдено ${count} строк из ${matched.evaluated}, где ${where}${truncatedNote}. Подтвердите изменение, чтобы выделить их заливкой.`
      : `${count} of ${matched.evaluated} rows match ${where}${truncatedNote}. Approve the change to fill them.`,
    actions,
  };
}

/** Read-only `/filter <condition>` — a count plus a small sample of the matching rows. */
export function buildFilterReport(
  selection: SelectionSnapshot,
  args: string,
  language: ResponseLanguage,
): DeterministicSlashResult | SlashConditionError {
  const ru = language === "ru";
  const resolved = resolveSlashCondition(args, selection.headers ?? []);
  if ("error" in resolved) return { error: resolved.error };

  const matched = selectMatchingRows(selection, resolved.condition);
  if (matched.error) return { error: matched.error };

  const count = matched.indexes.length;
  const where = resolved.describe;
  const lines: string[] = [
    ru
      ? `Условию ${where} удовлетворяет ${count} строк из ${matched.evaluated}.`
      : `${count} of ${matched.evaluated} rows match ${where}.`,
  ];

  const headers = selection.headers ?? [];
  if (count > 0 && headers.length > 0) {
    const sample = matched.indexes.slice(0, 8);
    lines.push(
      "",
      `| # | ${headers.join(" | ")} |`,
      `| --- | ${headers.map(() => "---").join(" | ")} |`,
      ...sample.map((dataIndex, i) => {
        const row = selection.values[dataIndex + 1] ?? [];
        const cells = headers.map((_, columnIndex) => String(row[columnIndex] ?? ""));
        return `| ${matched.sheetRows[i]} | ${cells.join(" | ")} |`;
      }),
    );
    if (count > sample.length) {
      lines.push("", ru ? `… ещё ${count - sample.length} строк.` : `… ${count - sample.length} more row(s).`);
    }
  }
  lines.push("", ru ? "_Книга не изменена._" : "_The workbook was not changed._");
  return { text: lines.join("\n"), actions: [] };
}

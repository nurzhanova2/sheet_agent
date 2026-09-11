// ---------------------------------------------------------------------------
// Stage 22.1 — deterministic renderers for `/summary` (no-metric form) and
// `/sort`. Both are read-only: no model call, no workbook change.
//  - /summary: one concise line per column; Date columns show a date RANGE, not
//              serial-number statistics; no interpretive/skew claims.
//  - /sort:    a real sorted preview (first rows) from the engine's sort result.
// ---------------------------------------------------------------------------

import type { SelectionSnapshot } from "../workbook-context.js";
import type { ResponseLanguage } from "../language.js";
import { splitSheetAddress } from "../a1.js";
import { excelSerialToISO, isDateNumberFormat } from "../../analysis/dataset.js";
import { formatNumber, type NumberLocale } from "../../analysis/format-number.js";
import { sortedPreview } from "../../analysis/select-rows.js";

export interface SlashTextResult {
  readonly text: string;
}
export interface SlashTextError {
  readonly error: string;
}
export function isSlashTextError(v: SlashTextResult | SlashTextError): v is SlashTextError {
  return "error" in v;
}

function provenance(selection: SelectionSnapshot): string {
  const local = splitSheetAddress(selection.address).localAddress || selection.address;
  const sheet = splitSheetAddress(selection.address).sheetName || selection.sheetName;
  const dataRows = Math.max(0, selection.totalRowCount - (selection.headers && selection.headers.length > 0 ? 1 : 0));
  return `${sheet}!${local} · ${dataRows}`;
}

/** 0-based indexes of columns whose dominant data-row number format is a date. */
function dateColumnSet(selection: SelectionSnapshot): Set<number> {
  const dates = new Set<number>();
  const width = selection.headers?.length ?? (selection.values[0]?.length ?? 0);
  for (let column = 0; column < width; column += 1) {
    const counts = new Map<string, number>();
    for (const row of selection.numberFormats.slice(1)) {
      const format = String(row[column] ?? "");
      if (format) counts.set(format, (counts.get(format) ?? 0) + 1);
    }
    const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    if (isDateNumberFormat(dominant)) dates.add(column);
  }
  return dates;
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid] ?? null;
}

export function renderSummaryReport(selection: SelectionSnapshot, language: ResponseLanguage): SlashTextResult {
  const ru = language === "ru";
  const locale: NumberLocale = ru ? "ru" : "en";
  const headers = selection.headers ?? [];
  const body = selection.values.slice(1);
  const dates = dateColumnSet(selection);
  const lines: string[] = [
    ru ? "## Сводка" : "## Summary",
    "",
    `${ru ? "Источник" : "Source"}: ${provenance(selection)} ${ru ? "строк данных" : "data rows"}`,
    "",
  ];

  headers.forEach((header, column) => {
    const cells = body.map((row) => row[column]).filter((v) => v !== null && v !== "" && v !== undefined);

    if (dates.has(column)) {
      const serials = cells.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (serials.length > 0) {
        const min = excelSerialToISO(Math.min(...serials));
        const max = excelSerialToISO(Math.max(...serials));
        lines.push(`- ${header}: ${min} → ${max}`);
      } else {
        lines.push(`- ${header}: ${ru ? "нет значений" : "no values"}`);
      }
      return;
    }

    const numbers = cells.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (numbers.length > 0 && numbers.length >= cells.length * 0.7) {
      const sorted = [...numbers].sort((a, b) => a - b);
      const mean = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
      const med = median(sorted) ?? mean;
      const f = (n: number) => formatNumber(n, 2, locale);
      lines.push(
        ru
          ? `- ${header}: ${numbers.length} значений · мин ${f(sorted[0] ?? 0)} · макс ${f(sorted[sorted.length - 1] ?? 0)} · среднее ${f(mean)} · медиана ${f(med)}`
          : `- ${header}: ${numbers.length} values · min ${f(sorted[0] ?? 0)} · max ${f(sorted[sorted.length - 1] ?? 0)} · mean ${f(mean)} · median ${f(med)}`,
      );
      return;
    }

    const distinct = new Set(cells.map((v) => String(v)));
    const sample = [...distinct].slice(0, 4).join(", ");
    lines.push(
      ru
        ? `- ${header}: ${distinct.size} уникальных${sample ? ` (${sample}${distinct.size > 4 ? ", …" : ""})` : ""}`
        : `- ${header}: ${distinct.size} distinct${sample ? ` (${sample}${distinct.size > 4 ? ", …" : ""})` : ""}`,
    );
  });

  return { text: lines.join("\n") };
}

// --- /sort ---------------------------------------------------------------------

const DESC_RE = /(по\s+убыван|убыван|убыв|desc(?:ending)?|↓|z\s*-?\s*a|9\s*-?\s*1|высш|больш)/i;
const ASC_RE = /(по\s+возрастан|возрастан|возр|asc(?:ending)?|↑|a\s*-?\s*z|1\s*-?\s*9|низш|меньш)/i;

function findHeader(fragment: string, headers: readonly string[]): string | null {
  const hay = fragment.toLowerCase();
  for (const header of [...headers].sort((a, b) => b.length - a.length)) {
    if (hay.includes(header.toLowerCase())) return header;
  }
  return null;
}

export function parseSortSpec(
  args: string,
  headers: readonly string[],
): { column: string; direction: "asc" | "desc" } | null {
  const first = args.split(/\s*[,;]\s*/)[0] ?? args;
  const column = findHeader(first, headers);
  if (!column) return null;
  const rest = first.replace(new RegExp(column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  const direction: "asc" | "desc" = DESC_RE.test(rest) ? "desc" : ASC_RE.test(rest) ? "asc" : "asc";
  return { column, direction };
}

export function buildSortReport(
  selection: SelectionSnapshot,
  args: string,
  language: ResponseLanguage,
): SlashTextResult | SlashTextError {
  const ru = language === "ru";
  const spec = parseSortSpec(args, selection.headers ?? []);
  if (!spec) return { error: ru ? `не удалось определить столбец для сортировки в "${args}"` : `could not find a sort column in "${args}"` };

  const preview = sortedPreview(selection, spec.column, spec.direction, 8);
  if (preview.error) return { error: preview.error };

  const headers = preview.columns;
  const sortIndex = headers.indexOf(spec.column);
  // show: row #, the sort column first, then up to 3 other columns
  const otherIndexes = headers.map((_, i) => i).filter((i) => i !== sortIndex).slice(0, 3);
  const shown = sortIndex >= 0 ? [sortIndex, ...otherIndexes] : otherIndexes;
  const arrow = spec.direction === "desc" ? "↓" : "↑";

  const head = `| # | ${shown.map((i) => headers[i]).join(" | ")} |`;
  const rule = `| --- | ${shown.map(() => "---").join(" | ")} |`;
  const rows = preview.rows.map((row, r) => {
    const cells = shown.map((i) => String(row[i] ?? ""));
    return `| ${preview.sheetRows[r] ?? ""} | ${cells.join(" | ")} |`;
  });

  const text = [
    ru ? `## Сортировка: ${spec.column} ${arrow}` : `## Sorted by ${spec.column} ${arrow}`,
    "",
    head,
    rule,
    ...rows,
    "",
    ru
      ? `Показаны первые ${preview.rows.length} из ${preview.totalRows} строк. _Книга не изменена._`
      : `First ${preview.rows.length} of ${preview.totalRows} rows shown. _The workbook was not changed._`,
  ].join("\n");
  return { text };
}

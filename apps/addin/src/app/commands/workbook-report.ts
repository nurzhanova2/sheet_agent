// ---------------------------------------------------------------------------
// Stage 23 — deterministic, read-only renderers for `/workbook`, `/sheets` and
// `/find`. Every line comes from the {@link WorkbookMap}; there is no model call
// and no workbook mutation. Output is bounded — a large workbook is summarised,
// never dumped.
// ---------------------------------------------------------------------------

import type { ResponseLanguage } from "../language.js";
import { columnIndexToLetters, columnLettersToIndex } from "../a1.js";
import type { WorkbookMap, WorkbookMapSheet } from "./workbook-map.js";

/** How many sheets / headers we spell out before switching to a "+N more" tail. */
const MAX_SHEETS_LISTED = 40;
const MAX_HEADERS_INLINE = 12;
const MAX_FIND_HITS = 60;

function sourceName(map: WorkbookMap): string {
  const id = map.sourceIdentity;
  if (!id || id === "unsaved" || id === "unknown") return "unsaved workbook";
  const tail = id.split(/[\\/]/).pop() ?? id;
  return decodeURIComponent(tail);
}

function headerPreview(sheet: WorkbookMapSheet): string {
  if (sheet.headers.length === 0) return "";
  const shown = sheet.headers.slice(0, MAX_HEADERS_INLINE).join(", ");
  const extra = sheet.headers.length - MAX_HEADERS_INLINE;
  if (extra > 0) return `${shown}, … (+${extra})`;
  return sheet.headersTruncated ? `${shown}, …` : shown;
}

function dims(sheet: WorkbookMapSheet, language: ResponseLanguage): string {
  const ru = language === "ru";
  if (sheet.rowCount === 0) return ru ? "пустой лист" : "empty";
  const rows = sheet.hasHeaders
    ? ru
      ? `${sheet.dataRowCount} строк данных`
      : `${sheet.dataRowCount} data rows`
    : ru
      ? `${sheet.rowCount} строк`
      : `${sheet.rowCount} rows`;
  const cols = ru ? `${sheet.columnCount} столбцов` : `${sheet.columnCount} columns`;
  return `${rows} × ${cols}`;
}

/** `/workbook` — a concise overview of every worksheet. */
export function renderWorkbookOverview(map: WorkbookMap, language: ResponseLanguage): string {
  const ru = language === "ru";
  const visible = map.sheets.filter((s) => s.visibility === "visible");
  const hidden = map.sheets.length - visible.length;
  const lines: string[] = [
    ru ? "## Книга" : "## Workbook",
    "",
    ru
      ? `${map.sheets.length} листов${hidden > 0 ? ` (${hidden} скрыт.)` : ""} · ${sourceName(map)}`
      : `${map.sheets.length} worksheets${hidden > 0 ? ` (${hidden} hidden)` : ""} · ${sourceName(map)}`,
  ];
  if (map.activeSheet) lines.push(ru ? `Активный лист: ${map.activeSheet}` : `Active sheet: ${map.activeSheet}`);

  for (const sheet of map.sheets.slice(0, MAX_SHEETS_LISTED)) {
    lines.push("", `### ${sheet.name}${sheet.visibility !== "visible" ? ` (${sheet.visibility})` : ""}`);
    lines.push(dims(sheet, language));
    const headers = headerPreview(sheet);
    if (headers) lines.push(headers);
    if (sheet.tables.length > 0) {
      lines.push(ru ? `Таблицы: ${sheet.tables.map((t) => t.name).join(", ")}` : `Tables: ${sheet.tables.map((t) => t.name).join(", ")}`);
    }
  }
  if (map.sheets.length > MAX_SHEETS_LISTED) {
    const rest = map.sheets.length - MAX_SHEETS_LISTED;
    lines.push("", ru ? `… и ещё ${rest} листов` : `… and ${rest} more worksheets`);
  }
  if (map.truncated) {
    lines.push(
      "",
      ru
        ? "_Заголовки прочитаны не для всех листов (ограничение по размеру книги)._"
        : "_Headers were not read for every sheet (workbook-size bound)._",
    );
  }
  return lines.join("\n");
}

/** `/sheets` — a compact worksheet list with dimensions. */
export function renderSheetsList(map: WorkbookMap, language: ResponseLanguage): string {
  const ru = language === "ru";
  const lines: string[] = [ru ? "## Листы" : "## Sheets", ""];
  for (const sheet of map.sheets.slice(0, MAX_SHEETS_LISTED)) {
    const tag = sheet.visibility !== "visible" ? ` — ${sheet.visibility}` : "";
    lines.push(`- ${sheet.name} — ${dims(sheet, language)}${tag}`);
  }
  if (map.sheets.length > MAX_SHEETS_LISTED) {
    lines.push(ru ? `… и ещё ${map.sheets.length - MAX_SHEETS_LISTED}` : `… and ${map.sheets.length - MAX_SHEETS_LISTED} more`);
  }
  return lines.join("\n");
}

/** `/find <term>` — structural search over sheet names, table names and headers. */
export function findStructural(map: WorkbookMap, term: string, language: ResponseLanguage): string {
  const ru = language === "ru";
  const wanted = term.trim();
  if (wanted === "") {
    return ru ? "Укажите, что искать: `/find Plan`." : "Say what to find: `/find Plan`.";
  }
  const lower = wanted.toLowerCase();
  const hits: string[] = [];

  for (const sheet of map.sheets) {
    if (sheet.name.toLowerCase().includes(lower)) {
      hits.push(ru ? `- лист «${sheet.name}»` : `- worksheet "${sheet.name}"`);
    }
    for (const table of sheet.tables) {
      if (table.name.toLowerCase().includes(lower)) {
        hits.push(ru ? `- таблица «${table.name}» на листе ${sheet.name}` : `- table "${table.name}" on ${sheet.name}`);
      }
    }
    const startIndex = (() => {
      try {
        return columnLettersToIndex(sheet.firstColumnLetter);
      } catch {
        return 0;
      }
    })();
    sheet.headers.forEach((header, index) => {
      if (header.toLowerCase().includes(lower)) {
        const letter = columnIndexToLetters(startIndex + index);
        hits.push(ru ? `- ${sheet.name} — столбец ${letter} (${header})` : `- ${sheet.name} — column ${letter} (${header})`);
      }
    });
  }

  if (hits.length === 0) {
    return ru
      ? `«${wanted}» не найдено среди названий листов, таблиц и заголовков столбцов.`
      : `"${wanted}" was not found in worksheet names, tables or column headers.`;
  }
  const shown = hits.slice(0, MAX_FIND_HITS);
  const head = ru
    ? `Найдено «${wanted}» — совпадений: ${hits.length}${hits.length > shown.length ? ` (показаны первые ${shown.length})` : ""}:`
    : `Found "${wanted}" in ${hits.length} place${hits.length === 1 ? "" : "s"}${hits.length > shown.length ? ` (first ${shown.length} shown)` : ""}:`;
  return [head, "", ...shown].join("\n");
}

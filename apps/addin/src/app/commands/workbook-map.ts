import type { ExcelPort, SelectionInfo, WorkbookOverview } from "@sheet-agent/application";
import { columnIndexToLetters, parseLocalRange, splitSheetAddress } from "../a1.js";

/** Header reads are bounded so a huge workbook never triggers a large scan. */
export const MAX_HEADER_SHEETS = 40;
export const MAX_HEADER_COLUMNS = 64;

export interface WorkbookMapSheet {
  readonly name: string;
  readonly visibility: "visible" | "hidden" | "veryHidden";
  readonly protected: boolean;
  /** Sheet-qualified used-range address, e.g. `Sales Test Data!A1:L121`. Null when the sheet is empty. */
  readonly usedAddress: string | null;
  /** Rows / columns of the used range (0 when the sheet is empty). */
  readonly rowCount: number;
  readonly columnCount: number;
  /** Data rows — `rowCount - 1` when a header row was detected, else `rowCount`. */
  readonly dataRowCount: number;
  readonly hasHeaders: boolean;
  /** Column headers (bounded). Empty when unknown, empty sheet, or the header row is not all text. */
  readonly headers: readonly string[];
  /** True when the sheet has more columns than `headers` lists, or its header row was not read. */
  readonly headersTruncated: boolean;
  /** A1 column letter of the first used column (headers[i] lives in column `firstColumnLetter + i`). */
  readonly firstColumnLetter: string;
  readonly tables: readonly { readonly name: string; readonly address: string }[];
}

export interface WorkbookMap {
  readonly sourceIdentity: string;
  readonly sheets: readonly WorkbookMapSheet[];
  readonly activeSheet: string | null;
  readonly selection: { readonly sheetName: string; readonly address: string } | null;
  /** True when some sheets' headers were not read because of the bounds above. */
  readonly truncated: boolean;
}

/** First-row local address of a used range, capped at `maxColumns` columns. */
export function headerRowAddress(usedAddress: string, maxColumns: number): string {
  const { sheetName, localAddress } = splitSheetAddress(usedAddress);
  const range = parseLocalRange(localAddress);
  const startCol = range.start.column;
  const endCol = Math.min(range.end.column, startCol + Math.max(1, maxColumns) - 1);
  const row = range.start.row + 1; // 1-based
  const startLetter = columnIndexToLetters(startCol);
  const endLetter = columnIndexToLetters(endCol);
  const local = startCol === endCol ? `${startLetter}${row}` : `${startLetter}${row}:${endLetter}${row}`;
  return sheetName ? `${sheetName}!${local}` : local;
}

/** True when a header row is "all non-empty text" (a plausible header). */
function looksLikeHeaderRow(row: readonly unknown[]): boolean {
  return row.length > 0 && row.every((cell) => typeof cell === "string" && cell.trim().length > 0);
}

/** Pure shaping — kept separate from the async reads so it is trivial to test. */
export function shapeWorkbookMap(
  overview: WorkbookOverview,
  selection: SelectionInfo | null,
  headerRows: ReadonlyMap<string, { readonly cells: readonly unknown[]; readonly moreColumns: boolean }>,
  truncated: boolean,
): WorkbookMap {
  const tablesBySheet = new Map<string, { name: string; address: string }[]>();
  for (const table of overview.tables) {
    const list = tablesBySheet.get(table.sheetName) ?? [];
    list.push({ name: table.name, address: table.address });
    tablesBySheet.set(table.sheetName, list);
  }

  const sheets: WorkbookMapSheet[] = overview.sheets.map((sheet) => {
    const used = sheet.usedRange ?? null;
    const rowCount = used?.rowCount ?? 0;
    const columnCount = used?.columnCount ?? 0;
    let firstColumnLetter = "A";
    if (used) {
      try {
        firstColumnLetter = columnIndexToLetters(parseLocalRange(splitSheetAddress(used.address).localAddress).start.column);
      } catch {
        firstColumnLetter = "A";
      }
    }
    const read = headerRows.get(sheet.name);
    const rawHeaders = read ? read.cells.map((c) => String(c ?? "").trim()) : [];
    const hasHeaders = read ? looksLikeHeaderRow(read.cells) : false;
    const headers = hasHeaders ? rawHeaders : [];
    const headersTruncated =
      (read?.moreColumns ?? false) || (used != null && !read && sheet.visibility === "visible");
    return {
      name: sheet.name,
      visibility: sheet.visibility,
      protected: sheet.protected,
      usedAddress: used?.address ?? null,
      rowCount,
      columnCount,
      dataRowCount: hasHeaders ? Math.max(0, rowCount - 1) : rowCount,
      hasHeaders,
      headers,
      headersTruncated,
      firstColumnLetter,
      tables: tablesBySheet.get(sheet.name) ?? [],
    };
  });

  return {
    sourceIdentity: overview.sourceIdentity,
    sheets,
    activeSheet: selection?.sheetName ?? null,
    selection: selection ? { sheetName: selection.sheetName, address: selection.address } : null,
    truncated,
  };
}

/**
 * Builds the workbook map from live Office.js state. Bounded: at most
 * `MAX_HEADER_SHEETS` header-row reads, each at most `MAX_HEADER_COLUMNS` wide.
 * A failed individual read is swallowed (that sheet just gets no headers).
 */
export async function buildWorkbookMap(port: ExcelPort): Promise<WorkbookMap> {
  const overview = await port.getWorkbookOverview();

  let selection: SelectionInfo | null = null;
  try {
    selection = await port.getSelection();
  } catch {
    selection = null;
  }

  const headerRows = new Map<string, { cells: readonly unknown[]; moreColumns: boolean }>();
  let truncated = false;
  let budget = MAX_HEADER_SHEETS;
  for (const sheet of overview.sheets) {
    if (!sheet.usedRange || sheet.visibility !== "visible") continue;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    budget -= 1;
    const moreColumns = sheet.usedRange.columnCount > MAX_HEADER_COLUMNS;
    try {
      const snapshot = await port.readRange(headerRowAddress(sheet.usedRange.address, MAX_HEADER_COLUMNS));
      headerRows.set(sheet.name, { cells: snapshot.values[0] ?? [], moreColumns });
    } catch {
      // Leave this sheet without headers; shapeWorkbookMap marks it truncated.
    }
  }

  return shapeWorkbookMap(overview, selection, headerRows, truncated);
}

import type { CellValue } from "@sheet-agent/application";
import type { SelectionSnapshot } from "../app/workbook-context.js";
import { parseLocalRange, splitSheetAddress } from "../app/a1.js";
import type { AnalysisError, AnalysisSource } from "./types.js";

export type ColumnType = "number" | "string" | "boolean" | "date" | "empty" | "mixed";

export interface DatasetColumn {
  readonly name: string;
  readonly index: number;
  readonly type: ColumnType;
  readonly numberFormat: string;
  readonly values: readonly CellValue[]; // raw cell values
  readonly numeric: readonly (number | null)[]; // numeric view: number, Excel serial for dates, else null
  readonly text: readonly (string | null)[]; // string view: ISO date for dates, String(v) otherwise, null if empty
}

export interface Dataset {
  readonly source: AnalysisSource;
  readonly headers: readonly string[];
  readonly columns: readonly DatasetColumn[];
  readonly rowCount: number;
  readonly firstDataSheetRow: number; // 1-based sheet row number of data row 0
  readonly truncated: boolean;
}

const EXCEL_EPOCH_OFFSET_DAYS = 25_569; // serial 25569 === 1970-01-01 (1900 date system incl. the leap-year bug)
const MS_PER_DAY = 86_400_000;
const MIN_SERIAL = 1;
const MAX_SERIAL = 2_958_465; // 9999-12-31

/** Converts an Excel serial date to an ISO `YYYY-MM-DD` string (UTC). */
export function excelSerialToISO(serial: number): string {
  const ms = Math.round((serial - EXCEL_EPOCH_OFFSET_DAYS) * MS_PER_DAY);
  return new Date(ms).toISOString().slice(0, 10);
}

/** True when a number-format string represents a calendar date (needs day + year tokens). */
export function isDateNumberFormat(format: string): boolean {
  if (!format) return false;
  const stripped = format
    .replace(/"[^"]*"/g, "") // quoted literals
    .replace(/\[[^\]]*\]/g, "") // [$-409], [Red], conditions
    .replace(/\\./g, ""); // escaped chars
  return /d/i.test(stripped) && /y/i.test(stripped);
}

function inferType(raw: readonly CellValue[], numberFormat: string): ColumnType {
  const present = raw.filter((value) => value !== null && value !== "");
  if (present.length === 0) return "empty";
  const dateFormatted = isDateNumberFormat(numberFormat);
  const allNumbers = present.every((value) => typeof value === "number");
  if (allNumbers && dateFormatted && present.every((value) => (value as number) >= MIN_SERIAL && (value as number) <= MAX_SERIAL)) return "date";
  if (allNumbers) return "number";
  if (present.every((value) => typeof value === "boolean")) return "boolean";
  if (present.every((value) => typeof value === "string")) return "string";
  return "mixed";
}

function buildColumn(name: string, index: number, raw: readonly CellValue[], numberFormat: string): DatasetColumn {
  const type = inferType(raw, numberFormat);
  const numeric = raw.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "boolean" ? (value ? 1 : 0) : null));
  const text = raw.map((value) => {
    if (value === null || value === "") return null;
    if (type === "date" && typeof value === "number") return excelSerialToISO(value);
    return String(value);
  });
  return { name, index, type, numberFormat, values: raw, numeric, text };
}

/**
 * Builds a typed dataset from a SelectionSnapshot. The first snapshot row must be a
 * header row (SelectionSnapshot.headers). Returns an AnalysisError when no headers exist.
 */
export function buildDataset(snapshot: SelectionSnapshot): Dataset | AnalysisError {
  if (!snapshot.headers || snapshot.headers.length === 0) {
    return { error: "The selection has no detectable header row, so columns cannot be resolved.", code: "NO_HEADERS" };
  }
  const headers = snapshot.headers.map((header) => String(header).trim());
  const body = snapshot.values.slice(1); // drop the header row
  const formats = snapshot.numberFormats.slice(1);
  const columnCount = headers.length;

  const columns: DatasetColumn[] = headers.map((name, columnIndex) => {
    const raw = body.map((row) => (row[columnIndex] ?? null) as CellValue);
    // Use the most common non-empty number format in the column so a single blank cell
    // does not defeat date detection.
    const formatCounts = new Map<string, number>();
    for (const row of formats) {
      const format = String(row[columnIndex] ?? "");
      if (format) formatCounts.set(format, (formatCounts.get(format) ?? 0) + 1);
    }
    const dominantFormat = [...formatCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    return buildColumn(name, columnIndex, raw.slice(0, body.length), dominantFormat);
  });

  const { sheetName, localAddress } = splitSheetAddress(snapshot.address);
  const anchorRow = safeAnchorRow(localAddress);

  return {
    source: { sheetName: snapshot.sheetName || sheetName, address: snapshot.address },
    headers,
    columns: columns.slice(0, columnCount),
    rowCount: body.length,
    firstDataSheetRow: anchorRow + 2, // header is anchorRow+1, first data row is anchorRow+2
    truncated: snapshot.truncated,
  };
}

function safeAnchorRow(localAddress: string): number {
  try {
    return parseLocalRange(localAddress).start.row;
  } catch {
    return 0;
  }
}

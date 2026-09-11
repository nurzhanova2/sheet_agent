import { WorkbookContextManager, type CellValue, type ExcelPort, type WorkbookContext } from "@sheet-agent/application";
import { OfficeJsExcelPort } from "@sheet-agent/excel-adapter-officejs";
import { buildLocalRange, parseLocalRange, splitSheetAddress } from "./a1.js";

export type WorkbookContextConnector = (listener: (context: WorkbookContext) => void) => Promise<() => void>;

/** Safety limits for how much of a selection is sent to the model. */
export interface SelectionLimits {
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCells: number;
}

export const SELECTION_LIMITS: SelectionLimits = { maxRows: 200, maxColumns: 30, maxCells: 3_000 };

export interface SelectionSnapshot {
  readonly sheetName: string;
  readonly address: string; // sheet-qualified address of the data actually included
  readonly rowCount: number; // rows included (after any truncation)
  readonly columnCount: number; // columns included (after any truncation)
  readonly totalRowCount: number; // rows in the real selection
  readonly totalColumnCount: number;
  readonly totalCellCount: number;
  readonly values: readonly (readonly CellValue[])[];
  readonly formulas: readonly (readonly (string | null)[])[]; // null where the cell has no real formula
  readonly numberFormats: readonly (readonly string[])[]; // Excel number-format string per cell (used to detect dates/currency)
  readonly headers?: readonly string[];
  readonly truncated: boolean;
  readonly truncationNote?: string;
  readonly isEmpty: boolean;
}

export function createExcelPort(): OfficeJsExcelPort {
  return new OfficeJsExcelPort();
}

export const connectWorkbookContext: WorkbookContextConnector = async (listener) => {
  const manager = new WorkbookContextManager(new OfficeJsExcelPort(), { debounceMs: 100 });
  manager.subscribe(listener);
  await manager.start();
  return () => manager.dispose();
};

function isRealFormula(raw: string | CellValue): raw is string {
  return typeof raw === "string" && raw.startsWith("=");
}

function deriveHeaders(values: readonly (readonly CellValue[])[]): readonly string[] | undefined {
  const first = values[0];
  const second = values[1];
  if (!first || first.length === 0 || !second) return undefined;
  const allText = first.every((cell) => typeof cell === "string" && cell.trim().length > 0);
  const secondHasNumber = second.some((cell) => typeof cell === "number");
  if (!allText || !secondHasNumber) return undefined;
  return first.map((cell) => String(cell));
}

export function clampSelection(
  totalRowCount: number,
  totalColumnCount: number,
  limits: SelectionLimits = SELECTION_LIMITS,
): { rowCount: number; columnCount: number; truncated: boolean } {
  const columnCount = Math.max(1, Math.min(totalColumnCount, limits.maxColumns));
  const rowsByCells = Math.max(1, Math.floor(limits.maxCells / columnCount));
  const rowCount = Math.max(1, Math.min(totalRowCount, limits.maxRows, rowsByCells));
  return { rowCount, columnCount, truncated: rowCount < totalRowCount || columnCount < totalColumnCount };
}

export interface ReadSelectionOptions {
  readonly limits?: SelectionLimits;
}

/** Shared shaping for both {@link readSelectionSnapshot} and {@link readAddressSnapshot}. */
async function readBoundedSnapshot(
  port: ExcelPort,
  fullAddress: string,
  totalRowCount: number,
  totalColumnCount: number,
  limits: SelectionLimits,
  noun: string,
): Promise<SelectionSnapshot> {
  const totalCellCount = totalRowCount * totalColumnCount;
  const { rowCount, columnCount, truncated } = clampSelection(totalRowCount, totalColumnCount, limits);
  const { sheetName, localAddress } = splitSheetAddress(fullAddress);
  const anchor = parseLocalRange(localAddress).start;
  const readAddress = `${sheetName ? `${sheetName}!` : ""}${buildLocalRange(anchor, rowCount, columnCount)}`;

  const snapshot = await port.readRange(readAddress);
  const values = snapshot.values.map((row) => row.slice(0, columnCount));
  const formulas = snapshot.formulas.map((row) =>
    row.slice(0, columnCount).map((raw) => (isRealFormula(raw) ? raw : null)),
  );
  const numberFormats = snapshot.numberFormats.map((row) => row.slice(0, columnCount).map((format) => String(format ?? "")));
  const headers = deriveHeaders(values);
  const isEmpty = values.every((row) => row.every((cell) => cell === null || cell === ""));

  const truncationNote = truncated
    ? `${noun} is ${totalRowCount} rows x ${totalColumnCount} columns (${totalCellCount} cells). ` +
      `Sending the top-left ${rowCount} rows x ${columnCount} columns (${rowCount * columnCount} cells).`
    : undefined;

  return {
    sheetName: snapshot.sheetName || sheetName,
    address: snapshot.address,
    rowCount: Math.min(rowCount, values.length),
    columnCount,
    totalRowCount,
    totalColumnCount,
    totalCellCount,
    values,
    formulas,
    numberFormats,
    ...(headers ? { headers } : {}),
    truncated,
    ...(truncationNote ? { truncationNote } : {}),
    isEmpty,
  };
}

/**
 * Reads the current Excel selection and returns a bounded snapshot suitable for sending
 * to the model. Only the selected range is read. If the selection exceeds the limits the
 * snapshot is truncated to the top-left block and `truncated` / `truncationNote` are set.
 */
export async function readSelectionSnapshot(
  port: ExcelPort,
  options: ReadSelectionOptions = {},
): Promise<SelectionSnapshot> {
  const limits = options.limits ?? SELECTION_LIMITS;
  const selection = await port.getSelection();
  return readBoundedSnapshot(port, selection.address, selection.rowCount, selection.columnCount, limits, "Selection");
}

/**
 * Stage 23 — reads a bounded snapshot of an EXPLICIT sheet-qualified address
 * (e.g. a resolved sheet's used range, or a `/copy` source range) rather than
 * the live selection. Same clamping / shaping as {@link readSelectionSnapshot}.
 */
export async function readAddressSnapshot(
  port: ExcelPort,
  fullAddress: string,
  options: ReadSelectionOptions = {},
): Promise<SelectionSnapshot> {
  const limits = options.limits ?? SELECTION_LIMITS;
  const { localAddress } = splitSheetAddress(fullAddress);
  const parsed = parseLocalRange(localAddress);
  return readBoundedSnapshot(port, fullAddress, parsed.rowCount, parsed.columnCount, limits, "Range");
}

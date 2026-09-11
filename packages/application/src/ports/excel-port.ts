export type CellValue = string | number | boolean | null;

export interface ExcelCapabilities {
  readonly tables: boolean;
  readonly charts: boolean;
  readonly pivotTables: boolean;
  readonly namedRanges: boolean;
}

export interface SelectionInfo {
  readonly address: string;
  readonly sheetName: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly revision: number;
}

export interface RangeSnapshot extends SelectionInfo {
  readonly values: readonly (readonly CellValue[])[];
  readonly formulas: readonly (readonly CellValue[])[];
  readonly numberFormats: readonly (readonly string[])[];
}

export interface SheetOverview {
  readonly name: string;
  readonly visibility: "visible" | "hidden" | "veryHidden";
  readonly protected: boolean;
  readonly usedRange?: { readonly address: string; readonly rowCount: number; readonly columnCount: number };
}

export interface WorkbookOverview {
  readonly sourceIdentity: string;
  readonly sheets: readonly SheetOverview[];
  readonly tables: readonly { readonly name: string; readonly sheetName: string; readonly address: string }[];
  readonly namedRanges: readonly { readonly name: string; readonly address: string }[];
  readonly charts: readonly { readonly name: string; readonly sheetName: string; readonly type: string }[];
  readonly pivots: readonly { readonly name: string; readonly sheetName: string }[];
}

export interface SearchMatch {
  readonly address: string;
  readonly preview: string;
}

export interface ExcelPort {
  readonly capabilities: ExcelCapabilities;
  getSelection(): Promise<SelectionInfo>;
  readRange(address: string): Promise<RangeSnapshot>;
  getWorkbookOverview(): Promise<WorkbookOverview>;
  readTable(name: string): Promise<RangeSnapshot & { readonly name: string }>;
  search(query: string, maxResults: number): Promise<readonly SearchMatch[]>;
  onSelectionChanged(listener: (selection: SelectionInfo) => void): () => void;
}

export interface RangePatch {
  readonly values?: readonly (readonly CellValue[])[];
  readonly formulas?: readonly (readonly (string | CellValue)[])[];
  readonly numberFormats?: readonly (readonly string[])[];
}

/**
 * Narrow, allow-listed workbook mutation surface. Deliberately separate from ExcelPort
 * so that read-only consumers (and their test doubles) are never forced to implement
 * write operations. Every method targets a single sheet-qualified A1 range.
 */
export interface InsertImageOptions {
  readonly sheetName: string;
  /** Top-left anchor cell (local A1, no sheet prefix). Defaults to the current selection. */
  readonly anchorCell?: string;
  readonly widthPx?: number;
  readonly heightPx?: number;
  /** Stable name to assign the shape, so it can be removed on undo. */
  readonly name?: string;
}

/** Geometry of an inserted image, read back AFTER context.sync confirms it exists. */
export interface InsertedImage {
  readonly shapeName: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ExcelMutationPort {
  writeRange(address: string, patch: RangePatch): Promise<void>;
  readFillColors(address: string): Promise<readonly (readonly string[])[]>;
  writeFillColors(address: string, colors: readonly (readonly (string | null)[])[]): Promise<void>;
  /**
   * Adds an empty worksheet with exactly this name. Rejects if the name is
   * already taken or is not a valid Excel worksheet name. Used by `/new-sheet`.
   */
  addWorksheet(name: string): Promise<void>;
  /**
   * Deletes a worksheet by name. No-op if it does not exist. This is the undo of
   * {@link addWorksheet}; it must never be used on a pre-existing sheet.
   */
  deleteWorksheet(name: string): Promise<void>;
  /**
   * Inserts a base64 PNG (raw, no data-URI prefix) as a floating image, then
   * re-reads the shape to confirm it was created. Rejects if the host does not
   * confirm the shape — callers must not record undo state on rejection.
   */
  insertImage(base64Png: string, options: InsertImageOptions): Promise<InsertedImage>;
  /** Removes a previously inserted shape by name. No-op if it is already gone. */
  deleteShape(sheetName: string, shapeName: string): Promise<void>;
}

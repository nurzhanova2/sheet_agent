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

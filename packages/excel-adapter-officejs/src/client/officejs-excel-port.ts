import type {
  CellValue,
  ExcelCapabilities,
  ExcelPort,
  RangeSnapshot,
  SearchMatch,
  SelectionInfo,
  WorkbookOverview,
} from "@sheet-agent/application";

function normalizeAddress(address: string): { sheetName: string; localAddress: string } {
  const separator = address.lastIndexOf("!");
  if (separator < 1) throw new Error(`A sheet-qualified address is required: ${address}`);
  return {
    sheetName: address.slice(0, separator).replace(/^'|'$/g, "").replaceAll("''", "'"),
    localAddress: address.slice(separator + 1),
  };
}

function valuesOf(values: unknown[][]): CellValue[][] {
  return values.map((row) => row.map((value) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null ? value : String(value),
  ));
}

export class OfficeJsExcelPort implements ExcelPort {
  readonly capabilities: ExcelCapabilities;
  #revision = 0;

  constructor(capabilities: Partial<ExcelCapabilities> = {}) {
    this.capabilities = { tables: true, charts: true, pivotTables: true, namedRanges: true, ...capabilities };
  }

  async getSelection(): Promise<SelectionInfo> {
    return Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load(["address", "rowCount", "columnCount", "worksheet/name"]);
      await context.sync();
      return { address: range.address, sheetName: range.worksheet.name, rowCount: range.rowCount, columnCount: range.columnCount, revision: this.#revision };
    });
  }

  async readRange(address: string): Promise<RangeSnapshot> {
    const { sheetName, localAddress } = normalizeAddress(address);
    return Excel.run(async (context) => {
      const range = context.workbook.worksheets.getItem(sheetName).getRange(localAddress);
      range.load(["address", "rowCount", "columnCount", "values", "formulas", "numberFormat", "worksheet/name"]);
      await context.sync();
      return {
        address: range.address,
        sheetName: range.worksheet.name,
        rowCount: range.rowCount,
        columnCount: range.columnCount,
        revision: this.#revision,
        values: valuesOf(range.values),
        formulas: valuesOf(range.formulas),
        numberFormats: range.numberFormat,
      };
    });
  }

  async getWorkbookOverview(): Promise<WorkbookOverview> {
    return Excel.run(async (context) => {
      const workbook = context.workbook;
      const sheets = workbook.worksheets;
      const tables = workbook.tables;
      const names = workbook.names;
      sheets.load("items/name,items/visibility,items/protection/protected");
      tables.load("items/name,items/worksheet/name");
      names.load("items/name,items/formula");
      await context.sync();
      const tableRanges = tables.items.map((table) => ({ table, range: table.getRange().load("address") }));
      const sheetDetails = sheets.items.map((sheet) => ({
        sheet,
        used: sheet.getUsedRangeOrNullObject(true).load(["address", "rowCount", "columnCount", "isNullObject"]),
        charts: sheet.charts.load("items/name,items/chartType"),
        pivots: sheet.pivotTables.load("items/name"),
      }));
      await context.sync();
      return {
        sourceIdentity: `${Office.context.document.url ?? "unsaved"}`,
        sheets: sheetDetails.map(({ sheet, used }) => ({
          name: sheet.name,
          visibility: sheet.visibility === Excel.SheetVisibility.hidden ? "hidden" : sheet.visibility === Excel.SheetVisibility.veryHidden ? "veryHidden" : "visible",
          protected: sheet.protection.protected,
          ...(used.isNullObject ? {} : { usedRange: { address: used.address, rowCount: used.rowCount, columnCount: used.columnCount } }),
        })),
        tables: tableRanges.map(({ table, range }) => ({ name: table.name, sheetName: table.worksheet.name, address: range.address })),
        namedRanges: names.items.map((name) => ({ name: name.name, address: name.formula })),
        charts: sheetDetails.flatMap(({ sheet, charts }) => charts.items.map((chart) => ({ name: chart.name, sheetName: sheet.name, type: chart.chartType }))),
        pivots: sheetDetails.flatMap(({ sheet, pivots }) => pivots.items.map((pivot) => ({ name: pivot.name, sheetName: sheet.name }))),
      };
    });
  }

  async readTable(name: string): Promise<RangeSnapshot & { readonly name: string }> {
    return Excel.run(async (context) => {
      const table = context.workbook.tables.getItem(name);
      const range = table.getRange();
      range.load(["address", "rowCount", "columnCount", "values", "formulas", "numberFormat", "worksheet/name"]);
      await context.sync();
      return {
        name,
        address: range.address,
        sheetName: range.worksheet.name,
        rowCount: range.rowCount,
        columnCount: range.columnCount,
        revision: this.#revision,
        values: valuesOf(range.values),
        formulas: valuesOf(range.formulas),
        numberFormats: range.numberFormat,
      };
    });
  }

  async search(query: string, maxResults: number): Promise<readonly SearchMatch[]> {
    return Excel.run(async (context) => {
      const sheets = context.workbook.worksheets.load("items/name");
      await context.sync();
      const found = sheets.items.map((sheet) => sheet.findAllOrNullObject(query, { completeMatch: false, matchCase: false }).load(["areas/items/address", "isNullObject"]));
      await context.sync();
      return found.flatMap((ranges) => ranges.isNullObject ? [] : ranges.areas.items.map((range) => ({ address: range.address, preview: query }))).slice(0, maxResults);
    });
  }

  onSelectionChanged(listener: (selection: SelectionInfo) => void): () => void {
    let active = true;
    let registration: OfficeExtension.EventHandlerResult<Excel.WorksheetSelectionChangedEventArgs> | undefined;
    void Excel.run(async (context) => {
      registration = context.workbook.worksheets.onSelectionChanged.add(async () => {
        if (!active) return;
        this.#revision += 1;
        listener(await this.getSelection());
      });
      await context.sync();
    });
    return () => {
      active = false;
      if (registration) void Excel.run(registration.context, async (context) => { registration?.remove(); await context.sync(); });
    };
  }
}

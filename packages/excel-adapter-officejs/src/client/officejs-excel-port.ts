import type {
  CellValue,
  ExcelCapabilities,
  ExcelMutationPort,
  ExcelPort,
  InsertedImage,
  InsertImageOptions,
  RangePatch,
  RangeSnapshot,
  SearchMatch,
  SelectionInfo,
  WorkbookOverview,
} from "@sheet-agent/application";

/** True when the task pane has opted into chart/insertion diagnostics. */
function safeDebugFlag(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("sheet-agent-debug-charts") === "1";
  } catch {
    return false;
  }
}

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

export class OfficeJsExcelPort implements ExcelPort, ExcelMutationPort {
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

  async writeRange(address: string, patch: RangePatch): Promise<void> {
    const { sheetName, localAddress } = normalizeAddress(address);
    await Excel.run(async (context) => {
      const range = context.workbook.worksheets.getItem(sheetName).getRange(localAddress);
      if (patch.values) range.values = patch.values as unknown[][];
      if (patch.formulas) range.formulas = patch.formulas as unknown[][];
      if (patch.numberFormats) range.numberFormat = patch.numberFormats as string[][];
      await context.sync();
    });
  }

  async readFillColors(address: string): Promise<readonly (readonly string[])[]> {
    const { sheetName, localAddress } = normalizeAddress(address);
    return Excel.run(async (context) => {
      const range = context.workbook.worksheets.getItem(sheetName).getRange(localAddress);
      range.load(["rowCount", "columnCount"]);
      await context.sync();
      const cells: Excel.Range[][] = [];
      for (let row = 0; row < range.rowCount; row += 1) {
        const cellRow: Excel.Range[] = [];
        for (let column = 0; column < range.columnCount; column += 1) {
          const cell = range.getCell(row, column);
          cell.format.fill.load("color");
          cellRow.push(cell);
        }
        cells.push(cellRow);
      }
      await context.sync();
      return cells.map((cellRow) => cellRow.map((cell) => cell.format.fill.color || "#FFFFFF"));
    });
  }

  async writeFillColors(address: string, colors: readonly (readonly (string | null)[])[]): Promise<void> {
    const { sheetName, localAddress } = normalizeAddress(address);
    await Excel.run(async (context) => {
      const range = context.workbook.worksheets.getItem(sheetName).getRange(localAddress);
      colors.forEach((colorRow, row) => colorRow.forEach((color, column) => {
        const fill = range.getCell(row, column).format.fill;
        if (color === null || color.toUpperCase() === "#FFFFFF") fill.clear();
        else fill.color = color;
      }));
      await context.sync();
    });
  }

  async addWorksheet(name: string): Promise<void> {
    await Excel.run(async (context) => {
      const existing = context.workbook.worksheets.getItemOrNullObject(name);
      existing.load("isNullObject");
      await context.sync();
      if (!existing.isNullObject) {
        throw new Error(`A worksheet named "${name}" already exists.`);
      }
      const sheet = context.workbook.worksheets.add(name);
      sheet.load("name");
      await context.sync();
    });
  }

  async deleteWorksheet(name: string): Promise<void> {
    await Excel.run(async (context) => {
      const sheet = context.workbook.worksheets.getItemOrNullObject(name);
      sheet.load("isNullObject");
      await context.sync();
      if (!sheet.isNullObject) {
        sheet.delete();
        await context.sync();
      }
    });
  }

  async insertImage(base64Png: string, options: InsertImageOptions): Promise<InsertedImage> {
    // Office.js Shape.addImage wants raw base64 with no data-URI prefix / whitespace.
    const raw = base64Png.replace(/^data:image\/[a-z]+;base64,/i, "").replace(/\s+/g, "");
    if (raw.length === 0) throw new Error("no image data to insert");
    const name = options.name ?? `SheetAgentChart_${Date.now().toString(36)}`;
    const debug = safeDebugFlag();

    return Excel.run(async (context) => {
      const sheet = context.workbook.worksheets.getItem(options.sheetName);
      const anchor = sheet.getRange(options.anchorCell ?? "A1");
      anchor.load(["left", "top", "address"]);
      await context.sync();

      const shape = sheet.shapes.addImage(raw);
      shape.name = name;
      shape.left = Math.max(0, anchor.left);
      shape.top = Math.max(0, anchor.top);
      if (options.widthPx && options.widthPx > 0) shape.width = options.widthPx;
      if (options.heightPx && options.heightPx > 0) shape.height = options.heightPx;
      await context.sync();

      // Confirm the shape exists BEFORE the caller records undo state.
      const check = sheet.shapes.getItemOrNullObject(name);
      check.load(["name", "left", "top", "width", "height", "isNullObject"]);
      await context.sync();
      if (check.isNullObject) {
        throw new Error("Excel did not confirm the inserted image (shape not found after sync).");
      }
      const result: InsertedImage = { shapeName: check.name, left: check.left, top: check.top, width: check.width, height: check.height };
      if (debug) {
        // eslint-disable-next-line no-console
        console.info("[SheetAgent insert]", {
          sheetName: options.sheetName,
          anchorCell: options.anchorCell ?? "A1",
          anchorAddress: anchor.address,
          requested: { name, widthPx: options.widthPx, heightPx: options.heightPx },
          base64Length: raw.length,
          shape: result,
        });
      }
      return result;
    });
  }

  async deleteShape(sheetName: string, shapeName: string): Promise<void> {
    await Excel.run(async (context) => {
      const shape = context.workbook.worksheets.getItem(sheetName).shapes.getItemOrNullObject(shapeName);
      shape.load("isNullObject");
      await context.sync();
      if (!shape.isNullObject) {
        shape.delete();
        await context.sync();
      }
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

import type { CellValue, ExcelPort, RangeSnapshot } from "@sheet-agent/application";

export interface ContextBudget {
  readonly maxCells: number;
  readonly maxCharacters: number;
  readonly chunkRows: number;
}

const DEFAULT_BUDGET: ContextBudget = { maxCells: 2_000, maxCharacters: 24_000, chunkRows: 100 };

interface AuditMetadata {
  readonly operation: string;
  readonly contentLogged: false;
  readonly durationMs: number;
  readonly requestedAddress?: string;
  readonly returnedCellCount?: number;
  readonly truncated?: boolean;
}

type ReadResult =
  | { readonly success: true; readonly data: unknown; readonly metadata: { readonly audit: AuditMetadata } }
  | { readonly success: false; readonly error: { readonly code: string; readonly message: string } };

function failure(code: string, message: string): ReadResult {
  return { success: false, error: { code, message } };
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function compactRange(snapshot: RangeSnapshot, budget: ContextBudget) {
  const totalCellCount = snapshot.rowCount * snapshot.columnCount;
  const columnsToReturn = Math.max(1, Math.min(snapshot.columnCount, budget.maxCells));
  const rowsToReturn = Math.max(1, Math.min(snapshot.rowCount, Math.floor(budget.maxCells / columnsToReturn)));
  const clipped = snapshot.values.slice(0, rowsToReturn).map((row) => row.slice(0, columnsToReturn));
  let remainingCharacters = budget.maxCharacters;
  const values: CellValue[][] = clipped.map((row) => row.map((value) => {
    if (typeof value !== "string") return value;
    const available = Math.max(0, Math.min(value.length, remainingCharacters));
    remainingCharacters -= available;
    return value.slice(0, available);
  }));
  const chunks = Array.from({ length: Math.ceil(values.length / budget.chunkRows) }, (_, index) => ({
    startRowOffset: index * budget.chunkRows,
    values: values.slice(index * budget.chunkRows, (index + 1) * budget.chunkRows),
  }));
  return {
    kind: "range" as const,
    address: snapshot.address,
    sheetName: snapshot.sheetName,
    rowCount: snapshot.rowCount,
    columnCount: snapshot.columnCount,
    returnedCellCount: rowsToReturn * columnsToReturn,
    truncated: totalCellCount > rowsToReturn * columnsToReturn || remainingCharacters === 0,
    trust: "untrusted-workbook-data" as const,
    values,
    chunks,
  };
}

export function createReadToolRegistry(excel: ExcelPort, options: Partial<ContextBudget> = {}) {
  const budget = { ...DEFAULT_BUDGET, ...options };
  const success = (operation: string, data: unknown, startedAt: number, audit: Partial<AuditMetadata> = {}): ReadResult => ({
    success: true,
    data,
    metadata: { audit: { operation, contentLogged: false, durationMs: Math.max(0, Date.now() - startedAt), ...audit } },
  });

  return {
    async execute(name: string, args: Readonly<Record<string, unknown>>): Promise<ReadResult> {
      const startedAt = Date.now();
      if (args.permission !== undefined && args.permission !== "read") return failure("PERMISSION_DENIED", "Read tools require read permission");
      try {
        if (name === "excel.getWorkbookOverview") {
          const overview = await excel.getWorkbookOverview();
          const safeOverview = {
            sheets: overview.sheets,
            tables: overview.tables,
            namedRanges: overview.namedRanges,
            charts: overview.charts,
            pivots: overview.pivots,
            trust: "untrusted-workbook-data",
          };
          return success("workbook.overview", safeOverview, startedAt);
        }
        if (name === "excel.readRange" || name === "excel.readFormulas") {
          if (!validText(args.address)) return failure("INVALID_ARGUMENTS", "address must be a non-empty string");
          const snapshot = await excel.readRange(args.address);
          if (name === "excel.readFormulas") {
            const formulas = snapshot.formulas.slice(0, Math.max(1, Math.floor(budget.maxCells / Math.max(1, snapshot.columnCount))))
              .map((row) => row.slice(0, snapshot.columnCount));
            return success("range.formulas", { kind: "formulas", address: snapshot.address, formulas, trust: "untrusted-workbook-data" }, startedAt, { requestedAddress: args.address });
          }
          const data = compactRange(snapshot, budget);
          return success("range.read", data, startedAt, { requestedAddress: args.address, returnedCellCount: data.returnedCellCount, truncated: data.truncated });
        }
        if (name === "excel.readSelection") {
          const before = await excel.getSelection();
          const snapshot = await excel.readRange(before.address);
          const after = await excel.getSelection();
          const data = { ...compactRange(snapshot, budget), selectionChangedDuringRead: before.revision !== after.revision };
          return success("selection.read", data, startedAt, { requestedAddress: before.address, returnedCellCount: data.returnedCellCount, truncated: data.truncated });
        }
        if (name === "excel.readTable") {
          if (!excel.capabilities.tables) return failure("CAPABILITY_UNAVAILABLE", "Tables are unavailable in this Excel host");
          if (!validText(args.name)) return failure("INVALID_ARGUMENTS", "name must be a non-empty string");
          const table = await excel.readTable(args.name);
          return success("table.read", { ...compactRange(table, budget), name: table.name }, startedAt);
        }
        if (name === "excel.search") {
          if (!validText(args.query)) return failure("INVALID_ARGUMENTS", "query must be a non-empty string");
          const maxResults = typeof args.maxResults === "number" ? Math.max(1, Math.min(100, Math.floor(args.maxResults))) : 20;
          const matches = await excel.search(args.query, maxResults);
          return success("workbook.search", { matches, trust: "untrusted-workbook-data" }, startedAt);
        }
        return failure("TOOL_NOT_FOUND", `Unknown read tool: ${name}`);
      } catch (error) {
        return failure("EXCEL_READ_FAILED", error instanceof Error ? error.message : "Excel read failed");
      }
    },
  };
}

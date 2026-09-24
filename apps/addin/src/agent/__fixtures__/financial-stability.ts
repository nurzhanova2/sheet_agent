import type { CellValue } from "@sheet-agent/application";
import { runAnalysisBatch } from "../../analysis/index.js";
import type { AnalysisRequest } from "../../analysis/types.js";
import { resultToChartData } from "../../app/result-to-chart.js";
import type { ResultRef } from "../../app/session-memory.js";
import { splitSheetAddress } from "../../app/a1.js";
import { resolveSheet } from "../../app/commands/workbook-resolver.js";
import type { WorkbookMap } from "../../app/commands/workbook-map.js";
import type { SelectionSnapshot } from "../../app/workbook-context.js";
import type { AgentLanguage, AgentToolDeps, SheetSnapshotResult } from "../types.js";

export const FS_HEADERS = ["Bank", "Sector", "Region", "Exposure", "NPL", "NPL Rate", "PD", "Stage", "Provision"] as const;

export type FsSheetName = "Portfolio 2024" | "Portfolio 2025" | "Deposits 2024" | "Deposits 2025";
export const FS_SHEETS: readonly FsSheetName[] = ["Portfolio 2024", "Portfolio 2025", "Deposits 2024", "Deposits 2025"];

const BANKS = [
  "Halyk", "Kaspi", "ForteBank", "Jusan", "BCC", "Eurasian",
  "RBK", "Freedom", "Bereke", "Altyn", "HomeCredit", "Nurbank",
] as const;
const SECTORS = ["Retail", "Corporate", "SME", "Mortgage"] as const;
const REGIONS = ["Almaty", "Astana", "Shymkent", "Karaganda"] as const;
const ROWS_PER_SHEET = 24;

export interface FsOptions {
  /** Only `Portfolio 2025` omits the "NPL Rate" column (schema-mismatch test). */
  readonly drop2025PortfolioNplRate?: boolean;
  /** Every sheet gains a second "PD 12M" column so "compare PD" is ambiguous. */
  readonly ambiguousPd?: boolean;
  readonly activeSheet?: FsSheetName;
  readonly language?: AgentLanguage;
}

interface SectorBase {
  readonly exposure: number;
  readonly npl: number;
  readonly pd: number;
}

// 2024 baselines per sector (Portfolio family).
const PORTFOLIO_BASE: Readonly<Record<(typeof SECTORS)[number], SectorBase>> = {
  Retail: { exposure: 100_000, npl: 3_000, pd: 0.02 },
  Corporate: { exposure: 250_000, npl: 10_000, pd: 0.03 },
  SME: { exposure: 80_000, npl: 4_800, pd: 0.045 },
  Mortgage: { exposure: 150_000, npl: 3_000, pd: 0.012 },
};

// 2025 deterioration — Corporate worst.
const NPL_MULT_2025: Readonly<Record<(typeof SECTORS)[number], number>> = {
  Retail: 1.1, Corporate: 1.6, SME: 1.25, Mortgage: 1.05,
};
const PD_DELTA_2025: Readonly<Record<(typeof SECTORS)[number], number>> = {
  Retail: 0.004, Corporate: 0.02, SME: 0.008, Mortgage: 0.002,
};

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function stageFor(rate: number): number {
  if (rate < 0.03) return 1;
  if (rate < 0.06) return 2;
  return 3;
}

/** Deterministic row values for one (sheet, rowIndex). */
function rowValues(sheet: FsSheetName, i: number): { readonly cells: Readonly<Record<string, CellValue>> } {
  const bank = BANKS[i % BANKS.length]!;
  const sector = SECTORS[i % SECTORS.length]!;
  const region = REGIONS[(i * 3) % REGIONS.length]!;
  const is2025 = sheet.endsWith("2025");
  const isDeposits = sheet.startsWith("Deposits");

  const base = PORTFOLIO_BASE[sector];
  const sizeJitter = 1 + ((i % 5) - 2) * 0.02; // 0.96 .. 1.04
  const pdJitter = ((i % 3) - 1) * 0.001;

  let exposure = base.exposure * sizeJitter * (is2025 ? 1.05 : 1);
  let npl = base.npl * sizeJitter * (is2025 ? NPL_MULT_2025[sector] : 1);
  let pd = base.pd + (is2025 ? PD_DELTA_2025[sector] : 0) + pdJitter;

  if (isDeposits) {
    // Deposit base: larger balances, near-zero credit risk, broadly stable YoY.
    exposure = base.exposure * 6 * sizeJitter * (is2025 ? 1.03 : 1);
    npl = base.npl * 0.05 * sizeJitter;
    pd = 0.001 + pdJitter / 4;
  }

  exposure = round(exposure, 0);
  npl = round(npl, 0);
  pd = round(Math.max(0, pd), 4);
  const rate = round(exposure > 0 ? npl / exposure : 0, 4);
  const provision = round(npl * 0.6, 0);

  return {
    cells: {
      Bank: bank,
      Sector: sector,
      Region: region,
      Exposure: exposure,
      NPL: npl,
      "NPL Rate": rate,
      PD: pd,
      "PD 12M": round(pd * 0.8, 4),
      Stage: stageFor(rate),
      Provision: provision,
    },
  };
}

function headerList(sheet: FsSheetName, options: FsOptions): string[] {
  let headers: string[] = [...FS_HEADERS];
  if (options.drop2025PortfolioNplRate && sheet === "Portfolio 2025") {
    headers = headers.filter((h) => h !== "NPL Rate");
  }
  if (options.ambiguousPd) {
    const at = headers.indexOf("PD");
    headers = [...headers.slice(0, at + 1), "PD 12M", ...headers.slice(at + 1)];
  }
  return headers;
}

function numberFormatFor(header: string): string {
  if (header === "NPL Rate") return "0.0%";
  if (header === "PD" || header === "PD 12M") return "0.000";
  if (header === "Exposure" || header === "NPL" || header === "Provision") return "#,##0";
  return "General";
}

function lastColumnLetter(count: number): string {
  let n = count;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function financialStabilitySnapshot(sheet: FsSheetName, options: FsOptions = {}): SelectionSnapshot {
  const headers = headerList(sheet, options);
  const dataRows: CellValue[][] = [];
  for (let i = 0; i < ROWS_PER_SHEET; i += 1) {
    const { cells } = rowValues(sheet, i);
    dataRows.push(headers.map((h) => cells[h] ?? null));
  }
  const values: CellValue[][] = [headers, ...dataRows];
  const rowCount = values.length;
  const columnCount = headers.length;
  const numberFormats = values.map((_, r) => headers.map((h) => (r === 0 ? "General" : numberFormatFor(h))));
  const address = `${sheet}!A1:${lastColumnLetter(columnCount)}${rowCount}`;

  return {
    sheetName: sheet,
    address,
    rowCount,
    columnCount,
    totalRowCount: rowCount,
    totalColumnCount: columnCount,
    totalCellCount: rowCount * columnCount,
    values,
    formulas: values.map((row) => row.map(() => null)),
    numberFormats,
    headers,
    truncated: false,
    isEmpty: false,
  };
}

export function financialStabilityWorkbookMap(options: FsOptions = {}): WorkbookMap {
  return {
    sourceIdentity: "financial-stability-fixture",
    activeSheet: options.activeSheet ?? "Portfolio 2025",
    selection: null,
    truncated: false,
    sheets: FS_SHEETS.map((name) => {
      const headers = headerList(name, options);
      return {
        name,
        visibility: "visible" as const,
        protected: false,
        usedAddress: `${name}!A1:${lastColumnLetter(headers.length)}${ROWS_PER_SHEET + 1}`,
        rowCount: ROWS_PER_SHEET + 1,
        columnCount: headers.length,
        dataRowCount: ROWS_PER_SHEET,
        hasHeaders: true,
        headers,
        headersTruncated: false,
        firstColumnLetter: "A",
        tables: [],
      };
    }),
  };
}

/**
 * A ready-made `AgentToolDeps` backed by the fixture. Uses the REAL analysis
 * engine (`runAnalysisBatch`) and the REAL chart builder (`resultToChartData`) —
 * no algorithm is duplicated.
 */
export function financialStabilityDeps(options: FsOptions = {}): AgentToolDeps {
  const language = options.language ?? "en";
  const map = financialStabilityWorkbookMap(options);

  const snapshotFor = (reference: string): SheetSnapshotResult => {
    const res = resolveSheet(map, reference);
    if (res.kind === "ok") return { kind: "ok", snapshot: financialStabilitySnapshot(res.sheet.name as FsSheetName, options) };
    if (res.kind === "ambiguous") return { kind: "ambiguous", candidates: res.candidates };
    return { kind: "not_found", reference };
  };

  return {
    workbookMap: async () => map,
    sheetSnapshot: async (reference) => snapshotFor(reference),
    rangeSnapshot: async (address) => {
      const { sheetName } = splitSheetAddress(address);
      const resolved = snapshotFor(sheetName || address);
      if (resolved.kind !== "ok") return resolved;
      return { kind: "ok", snapshot: { ...resolved.snapshot, address } };
    },
    analyze: (snapshot, request: AnalysisRequest) => runAnalysisBatch(snapshot, [request], 0, language),
    chartFromResult: (ref, lang, columns) => {
      const shim = {
        columns: ref.columns,
        rows: ref.rows,
        title: ref.title,
        sourceRange: "financial-stability-fixture",
        rowsTruncated: false,
      } as unknown as ResultRef;
      return resultToChartData(shim, lang, columns);
    },
  };
}

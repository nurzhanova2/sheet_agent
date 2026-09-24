import type { CellValue } from "@sheet-agent/application";
import { isPercentNumberFormat } from "../../app/schema/excel-date.js";
import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import { classifySemanticMetricClass } from "../../app/schema/measure-compatibility.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import type { PeriodIndex } from "../../app/schema/analytical/period-index.js";
import { DATASET_BOUNDS, type DatasetBounds, type DatasetColumn, type SandboxDataset, type SandboxError, type SemanticType } from "./types.js";

export interface BuildDatasetParams {
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  readonly periodIndex?: PeriodIndex;
  /** An engine result id, when the dataset is derived from one (§34 hybrid). */
  readonly tableRef?: string;
  readonly bounds?: DatasetBounds;
  readonly datasetId?: string;
}

export type BuildDatasetOutcome =
  | { readonly ok: true; readonly dataset: SandboxDataset }
  | { readonly ok: false; readonly error: SandboxError };

/**
 * §9 — a metric's semantic type, from the same evidence the Insight layer uses.
 *
 * Shared deliberately: if the narrator calls a row a share and the sandbox
 * calls it an amount, the answer and the analysis disagree about the data
 * while both appear correct.
 */
function metricSemanticType(label: string, percentFormatted: boolean): SemanticType {
  const cls = classifySemanticMetricClass(label, { percentFormatted });
  switch (cls) {
    case "amount":
      return "amount";
    case "count":
      return "count";
    case "ratio":
      return "ratio";
    case "index":
      return "index";
    case "share":
    case "rate":
    case "percentage":
      // Excel stores a percent-FORMATTED cell as a fraction; a percentage
      // typed as a plain number under a "%" header is already scaled.
      return percentFormatted ? "percent_fraction" : "percent_scaled";
    default:
      return "unknown";
  }
}

function isMissing(value: CellValue): boolean {
  return value === null || value === undefined || value === "";
}

function columnStats(rows: readonly (readonly CellValue[])[], index: number): { missing: number; zero: number } {
  let missing = 0;
  let zero = 0;
  for (const row of rows) {
    const value = row[index];
    if (isMissing(value ?? null)) missing += 1;
    else if (typeof value === "number" && value === 0) zero += 1;
  }
  return { missing, zero };
}

/**
 * A metrics-over-periods table, as an entity × period feature matrix.
 *
 * This is the shape §22's clustering workflow asks for — one row per subject,
 * one column per period — so the common case needs no reshaping inside the
 * generated code, which is where reshaping goes wrong.
 */
function wideDataset(schema: TableSchema, grids: AnalysisGrids): { columns: DatasetColumn[]; rows: CellValue[][]; periods: string[] } {
  const periodCols = schema.columnPaths.filter((p) => p.colIndex >= schema.dataRegion.col0);
  const periods = periodCols.map((p) => p.displayLabel);

  const rows: CellValue[][] = [];
  for (const member of schema.rowAxis) {
    const row: CellValue[] = [member.display];
    for (const path of periodCols) {
      const value = grids.values[member.rowIndex]?.[path.colIndex] ?? null;
      row.push(isMissing(value) ? null : value);
    }
    rows.push(row);
  }

  // A metric's unit belongs to its ROW here, not its column, so every period
  // column of one table can hold different units. The per-column semantic type
  // is therefore the majority reading across rows, and the per-ROW truth rides
  // in the metric column's own values — which is why `metric` is emitted as a
  // `metric_label` rather than being dropped into the index.
  const columns: DatasetColumn[] = [
    { name: "metric", semanticType: "metric_label", missingCount: 0, zeroCount: 0 },
  ];
  periodCols.forEach((path, i) => {
    const colIndex = i + 1;
    const stats = columnStats(rows, colIndex);
    columns.push({
      name: periods[i] ?? `period_${i + 1}`,
      semanticType: "amount",
      missingCount: stats.missing,
      zeroCount: stats.zero,
      ...(path.measureKind === "percentage" ? { unit: "%" } : {}),
    });
  });
  return { columns, rows, periods };
}

/** A flat records table: the workbook's own columns, typed. */
function recordsDataset(schema: TableSchema, grids: AnalysisGrids): { columns: DatasetColumn[]; rows: CellValue[][]; periods: string[] } {
  const { row0, row1, col0, col1 } = schema.dataRegion;
  const rows: CellValue[][] = [];
  for (let r = row0; r <= row1; r += 1) {
    const row: CellValue[] = [];
    for (let c = col0; c <= col1; c += 1) {
      const value = grids.values[r]?.[c] ?? null;
      row.push(isMissing(value) ? null : value);
    }
    rows.push(row);
  }

  const columns: DatasetColumn[] = [];
  for (let c = col0; c <= col1; c += 1) {
    const index = c - col0;
    const path = schema.columnPaths.find((p) => p.colIndex === c);
    const label = path?.displayLabel ?? `col_${index + 1}`;
    const formats = rows.map(() => grids.numberFormats[row0]?.[c] ?? null);
    const percentFormatted = formats.filter((f) => isPercentNumberFormat(f)).length / Math.max(1, formats.length) >= 0.6;
    const stats = columnStats(rows, index);
    const allNumeric = rows.every((row) => row[index] === null || typeof row[index] === "number");
    columns.push({
      name: label,
      semanticType: allNumeric ? metricSemanticType(label, percentFormatted) : "category",
      missingCount: stats.missing,
      zeroCount: stats.zero,
    });
  }
  // A records table has no period AXIS: its dates, if any, are a column like
  // any other, and claiming otherwise would let generated code treat one
  // column as an index it is not.
  return { columns, rows, periods: [] };
}

/**
 * §9/§10 — build the dataset, or refuse with a reason.
 *
 * §10 forbids silent truncation, so oversize input is an ERROR the planner
 * must handle (by aggregating deterministically, or by telling the user)
 * rather than a quiet `head(5000)` whose absence from the answer nobody would
 * notice.
 */
export function buildDataset(params: BuildDatasetParams): BuildDatasetOutcome {
  const bounds = params.bounds ?? DATASET_BOUNDS;
  const { schema, grids } = params;
  const wide = schema.orientation === "row_metrics" || schema.orientation === "bidimensional";
  const built = wide ? wideDataset(schema, grids) : recordsDataset(schema, grids);
  const periods = built.periods;

  const rowCount = built.rows.length;
  const colCount = built.columns.length;
  if (rowCount === 0 || colCount === 0) {
    return { ok: false, error: { code: "INVALID_RESULT", message: "the selected range holds no analysable rows" } };
  }
  if (rowCount > bounds.maxRows) {
    return {
      ok: false,
      error: {
        code: "DATA_TOO_LARGE",
        message: `the table has ${rowCount} rows, over the ${bounds.maxRows}-row limit for code analysis`,
      },
    };
  }
  if (colCount > bounds.maxColumns) {
    return { ok: false, error: { code: "DATA_TOO_LARGE", message: `the table has ${colCount} columns, over the ${bounds.maxColumns}-column limit` } };
  }
  if (rowCount * colCount > bounds.maxCells) {
    return { ok: false, error: { code: "DATA_TOO_LARGE", message: `the table has ${rowCount * colCount} cells, over the ${bounds.maxCells}-cell limit` } };
  }

  const dataset: SandboxDataset = {
    datasetId: params.datasetId ?? `dataset_${schema.sourceVersion}_${rowCount}x${colCount}`,
    tableRef: params.tableRef ?? schema.sourceRange,
    sheet: schema.sheetName,
    sourceRange: schema.sourceRange,
    freshnessToken: schema.sourceVersion,
    columns: built.columns,
    rows: built.rows,
    ...(periods && periods.length > 0 ? { periods } : {}),
  };

  const bytes = JSON.stringify(dataset.rows).length;
  if (bytes > bounds.maxSerializedBytes) {
    return { ok: false, error: { code: "DATA_TOO_LARGE", message: `the prepared data is ${bytes} bytes, over the ${bounds.maxSerializedBytes}-byte limit` } };
  }
  return { ok: true, dataset };
}

/**
 * §69 — has the workbook moved under this dataset?
 *
 * Checked twice: before execution, so a stale analysis is not started, and
 * before the result is committed, so one that was fresh when it began is not
 * presented as current after the user edited a cell mid-run.
 */
export function isDatasetFresh(dataset: SandboxDataset, currentSourceVersion: string): boolean {
  return dataset.freshnessToken === currentSourceVersion;
}

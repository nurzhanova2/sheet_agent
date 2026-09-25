import type { CellValue } from "@sheet-agent/application";
import { parseLocalRange, splitSheetAddress } from "../app/a1.js";
import { gridFromGroupOutcome, groupMetricLabel } from "../analysis/group-grid.js";
import { isAnalysisError } from "../analysis/types.js";
import type { AnalysisRequest, AnalysisResult, ColumnStatistics, GroupMetric } from "../analysis/types.js";
import type { AnalysisBatchOutcome } from "../analysis/index.js";
import { sourceVersionOf } from "../app/source-freshness.js";
import {
  deriveMetric,
  DERIVED_METRIC_OPERATORS,
  type DerivedMetricOperator,
} from "./derived-metrics.js";
import type {
  AgentObservation,
  AgentResultLike,
  AgentTool,
  AgentToolContext,
  AgentToolRegistry,
  AgentToolSchema,
  SheetSnapshotResult,
} from "./types.js";

// --- shared helpers --------------------------------------------------------

const SHEET_QUALIFIED_A1 = /^[^!]+![A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/;
/** A single read_range may not request more than this many cells. */
const MAX_READ_RANGE_CELLS = 20_000;

function err(tool: string, error: string, source?: string): AgentObservation {
  return { tool, ok: false, kind: "error", error, ...(source ? { source } : {}) };
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(input: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `unexpected input key(s): ${extra.join(", ")}` : null;
}

function toNum(value: CellValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^0-9eE.+-]/g, ""));
    return Number.isFinite(n) && value.trim() !== "" ? n : null;
  }
  return null;
}

function firstOutcome(batch: AnalysisBatchOutcome): AnalysisResult | { readonly error: string } {
  const outcome = batch.outcomes[0];
  if (!outcome) return { error: "the analysis produced no result" };
  if (isAnalysisError(outcome)) return { error: outcome.error };
  return outcome;
}

async function resolveSnapshot(
  ctx: AgentToolContext,
  tool: string,
  reference: string,
): Promise<{ ok: true; snapshot: Extract<SheetSnapshotResult, { kind: "ok" }>["snapshot"] } | { ok: false; obs: AgentObservation }> {
  const res = await ctx.deps.sheetSnapshot(reference);
  if (res.kind === "ok") return { ok: true, snapshot: res.snapshot };
  if (res.kind === "ambiguous") {
    return { ok: false, obs: err(tool, `"${reference}" matches more than one sheet: ${res.candidates.join(", ")}`, reference) };
  }
  if (res.kind === "not_found") return { ok: false, obs: err(tool, `no sheet resolves to "${reference}"`, reference) };
  return { ok: false, obs: err(tool, res.error, reference) };
}

function findPriorResult(ctx: AgentToolContext, id: string): AgentResultLike | undefined {
  const obs = ctx.priorResults.find((o) => o.resultId === id);
  if (!obs || !obs.columns || !obs.rows) return undefined;
  return { title: obs.operation ?? obs.note ?? id, columns: obs.columns, rows: obs.rows };
}

function resolveColumnIndex(columns: readonly string[], name: string): number | "ambiguous" {
  const lower = name.trim().toLowerCase();
  const exact = columns.findIndex((c) => c.toLowerCase() === lower);
  if (exact >= 0) return exact;
  const subs = columns.map((c, i) => [c, i] as const).filter(([c]) => c.toLowerCase().includes(lower));
  if (subs.length === 1) return subs[0]![1];
  if (subs.length > 1) return "ambiguous";
  return -1;
}

function sortByColumn(
  result: AgentResultLike,
  columnIndex: number,
  direction: "asc" | "desc",
): readonly (readonly CellValue[])[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...result.rows].sort((a, b) => {
    const av = toNum(a[columnIndex] ?? null);
    const bv = toNum(b[columnIndex] ?? null);
    if (av !== null && bv !== null) return (av - bv) * factor;
    return String(a[columnIndex] ?? "").localeCompare(String(b[columnIndex] ?? "")) * factor;
  });
}

// --- group_by metric spec -------------------------------------------------

const AGG_METRICS = new Set(["count", "sum", "mean", "min", "max", "median"]);

function aggregate(metric: string, values: readonly number[]): number | null {
  if (metric === "count") return values.length;
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  switch (metric) {
    case "sum":
      return values.reduce((s, v) => s + v, 0);
    case "mean":
      return values.reduce((s, v) => s + v, 0) / values.length;
    case "min":
      return sorted[0]!;
    case "max":
      return sorted[sorted.length - 1]!;
    case "median": {
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    }
    default:
      return null;
  }
}

/** §4/§8 — group an earlier result's OWN rows (no workbook read). */
function localGroupBy(
  prior: AgentResultLike,
  by: readonly string[],
  metrics: readonly GroupMetric[],
): { readonly columns: readonly string[]; readonly rows: readonly (readonly CellValue[])[] } | { readonly error: string } {
  const dimIdx: number[] = [];
  for (const dim of by) {
    const i = resolveColumnIndex(prior.columns, dim);
    if (i === "ambiguous") return { error: `dimension "${dim}" is ambiguous in that result` };
    if (i < 0) return { error: `dimension "${dim}" is not in that result` };
    dimIdx.push(i);
  }
  const metricIdx: (number | null)[] = [];
  for (const m of metrics) {
    if (m.metric === "count" && !m.target) {
      metricIdx.push(null);
      continue;
    }
    const name = m.target && m.target.kind === "column" ? m.target.name : undefined;
    if (!name) return { error: `metric "${m.metric}" needs a column` };
    const i = resolveColumnIndex(prior.columns, name);
    if (i === "ambiguous") return { error: `metric column "${name}" is ambiguous in that result` };
    if (i < 0) return { error: `metric column "${name}" is not in that result` };
    metricIdx.push(i);
  }

  const groups = new Map<string, { key: CellValue[]; buckets: number[][] }>();
  for (const row of prior.rows) {
    const key = dimIdx.map((i) => row[i] ?? "");
    const k = key.map((v) => String(v)).join("\u0001");
    let g = groups.get(k);
    if (!g) {
      g = { key, buckets: metrics.map(() => []) };
      groups.set(k, g);
    }
    metricIdx.forEach((mi, j) => {
      if (mi === null) return;
      const n = toNum(row[mi] ?? null);
      if (n !== null) g!.buckets[j]!.push(n);
    });
  }

  const columns = [...by, ...metrics.map((m) => groupMetricLabel(m))];
  const rows = [...groups.values()]
    .sort((x, y) => String(x.key[0] ?? "").localeCompare(String(y.key[0] ?? "")))
    .map((g) => [...g.key, ...metrics.map((m, j) => aggregate(m.metric, g.buckets[j]!))]);
  return { columns, rows };
}

function parseMetrics(raw: unknown): { ok: true; metrics: GroupMetric[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "metrics must be a non-empty array" };
  const metrics: GroupMetric[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return { ok: false, error: "each metric must be an object" };
    const metric = entry["metric"];
    if (typeof metric !== "string" || !AGG_METRICS.has(metric)) {
      return { ok: false, error: `metric must be one of ${[...AGG_METRICS].join(", ")}` };
    }
    const column = typeof entry["column"] === "string" ? (entry["column"] as string).trim() : undefined;
    const name = typeof entry["name"] === "string" ? (entry["name"] as string).trim() : undefined;
    if (metric !== "count" && !column) return { ok: false, error: `metric "${metric}" needs a column` };
    metrics.push({
      metric: metric as GroupMetric["metric"],
      ...(name ? { name } : {}),
      ...(column ? { target: { kind: "column", name: column } } : {}),
    });
  }
  return { ok: true, metrics };
}

// --- tool definitions ----------------------------------------------------

function defineTool<I>(tool: AgentTool<I>): AgentTool<I> {
  return tool;
}

const workbookOverview = defineTool<Record<string, never>>({
  name: "workbook_overview",
  description: "Structural picture of the whole workbook: every sheet, its dimensions and column headers, plus the active sheet. Use first when the workbook is unfamiliar.",
  parameters: {},
  mutating: false,
  readCost: 1,
  validate: (input) => {
    const extra = onlyKeys(input, []);
    return extra ? { ok: false, error: extra } : { ok: true, value: {} };
  },
  execute: async (_input, ctx) => {
    const map = await ctx.deps.workbookMap();
    if ("error" in map) return err("workbook_overview", map.error);
    const rows = map.sheets.map((s) => [s.name, s.dataRowCount, s.columnCount, s.headers.length > 0 ? s.headers.join(", ") : "(headers unknown)"]);
    return {
      tool: "workbook_overview",
      ok: true,
      kind: "structure",
      columns: ["Sheet", "Data rows", "Columns", "Headers"],
      rows,
      rowCount: rows.length,
      note: `${map.sheets.length} sheet(s); active: ${map.activeSheet ?? "none"}`,
    };
  },
});

const listSheets = defineTool<Record<string, never>>({
  name: "list_sheets",
  description: "Names and dimensions of every worksheet, one row each. Cheaper than workbook_overview when headers are not needed.",
  parameters: {},
  mutating: false,
  readCost: 1,
  validate: (input) => {
    const extra = onlyKeys(input, []);
    return extra ? { ok: false, error: extra } : { ok: true, value: {} };
  },
  execute: async (_input, ctx) => {
    const map = await ctx.deps.workbookMap();
    if ("error" in map) return err("list_sheets", map.error);
    const rows = map.sheets.map((s) => [s.name, s.dataRowCount, s.columnCount]);
    return { tool: "list_sheets", ok: true, kind: "structure", columns: ["Sheet", "Data rows", "Columns"], rows, rowCount: rows.length };
  },
});

const findColumn = defineTool<{ name: string }>({
  name: "find_column",
  description: "Locate every worksheet that has a column matching a name (case-insensitive, substring). Returns sheet + column letter + exact header.",
  parameters: { name: "the column name to look for" },
  mutating: false,
  readCost: 1,
  validate: (input) => {
    const extra = onlyKeys(input, ["name"]);
    if (extra) return { ok: false, error: extra };
    const name = str(input, "name");
    return name ? { ok: true, value: { name } } : { ok: false, error: "find_column needs a non-empty name" };
  },
  execute: async (input, ctx) => {
    const map = await ctx.deps.workbookMap();
    if ("error" in map) return err("find_column", map.error);
    const wanted = input.name.toLowerCase();
    const rows: CellValue[][] = [];
    for (const sheet of map.sheets) {
      sheet.headers.forEach((header, i) => {
        if (header.toLowerCase().includes(wanted)) {
          rows.push([sheet.name, columnLetter(sheet.firstColumnLetter, i), header]);
        }
      });
    }
    return {
      tool: "find_column",
      ok: true,
      kind: "table",
      columns: ["Sheet", "Column", "Header"],
      rows,
      rowCount: rows.length,
      ...(rows.length === 0 ? { note: `no column matches "${input.name}"` } : {}),
    };
  },
});

function columnLetter(first: string, offset: number): string {
  const base = first.split("").reduce((acc, ch) => acc * 26 + (ch.toUpperCase().charCodeAt(0) - 64), 0);
  let n = base + offset;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || first;
}

const inspectTable = defineTool<{ sheet: string }>({
  name: "inspect_table",
  description: "Headers, dimensions and the first few rows of one worksheet. Use before analysing an unfamiliar sheet.",
  parameters: { sheet: "the worksheet name (resolved deterministically)" },
  mutating: false,
  readCost: 1,
  validate: (input) => {
    const extra = onlyKeys(input, ["sheet"]);
    if (extra) return { ok: false, error: extra };
    const sheet = str(input, "sheet");
    return sheet ? { ok: true, value: { sheet } } : { ok: false, error: "inspect_table needs a sheet name" };
  },
  execute: async (input, ctx) => {
    const resolved = await resolveSnapshot(ctx, "inspect_table", input.sheet);
    if (!resolved.ok) return resolved.obs;
    const snap = resolved.snapshot;
    const headers = snap.headers ?? [];
    const sample = snap.values.slice(1, 6).map((row) => [...row]);
    const dataRows = snap.totalRowCount - (headers.length > 0 ? 1 : 0);
    return {
      tool: "inspect_table",
      ok: true,
      kind: "table",
      source: snap.address,
      sourceVersion: sourceVersionOf(snap),
      ...(headers.length > 0 ? { columns: headers } : {}),
      rows: sample,
      rowCount: dataRows,
      truncated: snap.truncated,
      note: `${snap.sheetName}: ${dataRows} data rows x ${snap.totalColumnCount} columns`,
    };
  },
});

const readRange = defineTool<{ address: string }>({
  name: "read_range",
  description: "Read an explicit sheet-qualified A1 range (e.g. 'Portfolio 2025!A1:I40'). Bounded — a request larger than 20000 cells is rejected.",
  parameters: { address: "sheet-qualified A1 range" },
  mutating: false,
  readCost: 1,
  validate: (input) => {
    const extra = onlyKeys(input, ["address"]);
    if (extra) return { ok: false, error: extra };
    const address = str(input, "address");
    if (!address) return { ok: false, error: "read_range needs an address" };
    if (!SHEET_QUALIFIED_A1.test(address)) return { ok: false, error: `"${address}" is not a sheet-qualified A1 range` };
    try {
      const { localAddress } = splitSheetAddress(address);
      const range = parseLocalRange(localAddress);
      if (range.rowCount * range.columnCount > MAX_READ_RANGE_CELLS) {
        return { ok: false, error: `range is ${range.rowCount * range.columnCount} cells; narrow it to <= ${MAX_READ_RANGE_CELLS}` };
      }
    } catch {
      return { ok: false, error: `"${address}" could not be parsed as a range` };
    }
    return { ok: true, value: { address } };
  },
  execute: async (input, ctx) => {
    const res = await ctx.deps.rangeSnapshot(input.address);
    if (res.kind === "not_found") return err("read_range", `no sheet in "${input.address}"`, input.address);
    if (res.kind === "ambiguous") return err("read_range", `ambiguous sheet in "${input.address}"`, input.address);
    if (res.kind === "error") return err("read_range", res.error, input.address);
    const snap = res.snapshot;
    return {
      tool: "read_range",
      ok: true,
      kind: "table",
      source: snap.address,
      sourceVersion: sourceVersionOf(snap),
      ...(snap.headers ? { columns: snap.headers } : {}),
      rows: snap.values.map((row) => [...row]),
      rowCount: snap.totalRowCount,
      truncated: snap.truncated,
    };
  },
});

const summarize = defineTool<{ sheet: string; columns?: readonly string[] }>({
  name: "summarize",
  description: "Per-column summary statistics (count, missing, min, max, mean, median, stddev) for a worksheet.",
  parameters: { sheet: "worksheet name", columns: "optional subset of column names" },
  mutating: false,
  readCost: 1,
  validate: (input) => {
    const extra = onlyKeys(input, ["sheet", "columns"]);
    if (extra) return { ok: false, error: extra };
    const sheet = str(input, "sheet");
    if (!sheet) return { ok: false, error: "summarize needs a sheet name" };
    const columns = input["columns"];
    if (columns !== undefined && !(Array.isArray(columns) && columns.every((c) => typeof c === "string"))) {
      return { ok: false, error: "columns must be an array of strings" };
    }
    return { ok: true, value: { sheet, ...(columns ? { columns: columns as string[] } : {}) } };
  },
  execute: async (input, ctx) => {
    const resolved = await resolveSnapshot(ctx, "summarize", input.sheet);
    if (!resolved.ok) return resolved.obs;
    const request: AnalysisRequest = { op: "summary_statistics", ...(input.columns ? { columns: input.columns } : {}) };
    const outcome = firstOutcome(ctx.deps.analyze(resolved.snapshot, request));
    if ("error" in outcome) return err("summarize", outcome.error, resolved.snapshot.address);
    const stats = outcome.statistics ?? {};
    const rows = Object.entries(stats).map(([column, s]: [string, ColumnStatistics]) => [
      column, s.count, s.missing, s.min, s.max, s.mean, s.median, s.stddev,
    ]);
    return {
      tool: "summarize",
      ok: true,
      kind: "table",
      source: resolved.snapshot.address,
      sourceVersion: sourceVersionOf(resolved.snapshot),
      operation: "summary_statistics",
      columns: ["Column", "Count", "Missing", "Min", "Max", "Mean", "Median", "Std"],
      rows,
      rowCount: rows.length,
    };
  },
});

const groupBy = defineTool<{ sheet?: string; result?: string; by: readonly string[]; metrics: GroupMetric[] }>({
  name: "group_by",
  description: "Aggregate a worksheet (`sheet`) OR an earlier result (`result`, 0 workbook reads) by one or more dimension columns. metrics: [{ metric: 'mean'|'sum'|'count'|'min'|'max'|'median', column?: string, name?: string }].",
  parameters: { sheet: "worksheet name (or omit and pass result)", result: "a prior result id", by: "dimension column names", metrics: "aggregate specs" },
  mutating: false,
  readCost: 1,
  validate: (input) => {
    const extra = onlyKeys(input, ["sheet", "result", "by", "metrics"]);
    if (extra) return { ok: false, error: extra };
    const sheet = str(input, "sheet");
    const result = str(input, "result");
    if (!sheet && !result) return { ok: false, error: "group_by needs a sheet name or a result id" };
    const by = input["by"];
    if (!Array.isArray(by) || by.length === 0 || !by.every((b) => typeof b === "string" && b.trim() !== "")) {
      return { ok: false, error: "by must be a non-empty array of column names" };
    }
    const metrics = parseMetrics(input["metrics"]);
    if (!metrics.ok) return { ok: false, error: metrics.error };
    return {
      ok: true,
      value: { ...(sheet ? { sheet } : {}), ...(result ? { result } : {}), by: by.map((b) => (b as string).trim()), metrics: metrics.metrics },
    };
  },
  execute: async (input, ctx) => {
    if (input.result) {
      const prior = findPriorResult(ctx, input.result);
      if (!prior) return err("group_by", `no earlier result with id "${input.result}"`, input.result);
      const grouped = localGroupBy(prior, input.by, input.metrics);
      if ("error" in grouped) return err("group_by", grouped.error, input.result);
      return {
        tool: "group_by",
        ok: true,
        kind: "table",
        source: input.result,
        operation: `group_by ${input.by.join(" x ")}`,
        derivedFrom: [input.result],
        columns: grouped.columns,
        rows: grouped.rows.map((row) => [...row]),
        rowCount: grouped.rows.length,
      };
    }
    const resolved = await resolveSnapshot(ctx, "group_by", input.sheet as string);
    if (!resolved.ok) return resolved.obs;
    const request: Extract<AnalysisRequest, { op: "group_by" }> = { op: "group_by", by: input.by, metrics: input.metrics };
    const outcome = firstOutcome(ctx.deps.analyze(resolved.snapshot, request));
    if ("error" in outcome) return err("group_by", outcome.error, resolved.snapshot.address);
    const grid = gridFromGroupOutcome(outcome, request);
    if (!grid) return err("group_by", "the grouped result could not be shaped into a table", resolved.snapshot.address);
    return {
      tool: "group_by",
      ok: true,
      kind: "table",
      source: resolved.snapshot.address,
      sourceVersion: sourceVersionOf(resolved.snapshot),
      operation: `group_by ${input.by.join(" x ")}`,
      columns: grid.columns,
      rows: grid.rows.map((row) => [...row]),
      rowCount: grid.rows.length,
      truncated: grid.truncated,
    };
  },
});

const PREDICATE_OPS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "is_null", "not_null",
  "abs_gt", "abs_gte", "abs_lt", "abs_lte",
]);

/** §1 — a bounded, explicit predicate over ONE cell. No expression evaluation. */
function applyPredicate(op: string, cell: CellValue, value: unknown): boolean {
  const isNull = cell === null || cell === undefined || cell === "";
  if (op === "is_null") return isNull;
  if (op === "not_null") return !isNull;
  if (op === "contains" || op === "not_contains") {
    const hit = String(cell ?? "").toLowerCase().includes(String(value ?? "").toLowerCase());
    return op === "contains" ? hit : !hit;
  }
  const n = toNum(cell);
  if (op === "eq" || op === "neq") {
    const eq = typeof value === "number" || (typeof value === "string" && /^-?\d/.test(value))
      ? n !== null && n === toNum(value as CellValue)
      : String(cell ?? "") === String(value ?? "");
    return op === "eq" ? eq : !eq;
  }
  const v = toNum((value as CellValue) ?? null);
  if (n === null || v === null) return false;
  switch (op) {
    case "gt": return n > v;
    case "gte": return n >= v;
    case "lt": return n < v;
    case "lte": return n <= v;
    case "abs_gt": return Math.abs(n) > Math.abs(v);
    case "abs_gte": return Math.abs(n) >= Math.abs(v);
    case "abs_lt": return Math.abs(n) < Math.abs(v);
    case "abs_lte": return Math.abs(n) <= Math.abs(v);
    default: return false;
  }
}

function sheetRowsTool(
  name: "filter_rows" | "sort_rows" | "top_n",
  description: string,
): AgentTool<Record<string, unknown>> {
  return defineTool<Record<string, unknown>>({
    name,
    description,
    parameters:
      name === "filter_rows"
        ? {
            sheet: "worksheet name (or omit and pass result)",
            where: "a Condition / ConditionGroup (sheet form)",
            result: "a prior result id (result form)",
            column: "column name (result form)",
            op: `predicate (result form): ${[...PREDICATE_OPS].join(" | ")}`,
            value: "comparison value (result form; omit for is_null / not_null)",
            columns: "optional output columns (sheet form)",
            limit: "optional row cap (sheet form)",
          }
        : name === "sort_rows"
          ? { sheet: "worksheet name (or omit and pass result)", result: "a prior result id", by: "column name", direction: "'asc' | 'desc'" }
          : { sheet: "worksheet name (or omit and pass result)", result: "a prior result id", by: "column name", n: "how many rows" },
    mutating: false,
    readCost: name === "filter_rows" ? 1 : 0,
    validate: (input) => {
      const allowed =
        name === "filter_rows"
          ? ["sheet", "where", "result", "column", "op", "value", "columns", "limit"]
          : name === "sort_rows"
            ? ["sheet", "result", "by", "direction"]
            : ["sheet", "result", "by", "n"];
      const extra = onlyKeys(input, allowed);
      if (extra) return { ok: false, error: extra };
      if (name === "filter_rows") {
        const result = str(input, "result");
        if (result) {
          const column = str(input, "column");
          const op = str(input, "op");
          if (!column || !op) return { ok: false, error: "filter_rows over a result needs `column` and `op`" };
          if (!PREDICATE_OPS.has(op)) return { ok: false, error: `op must be one of ${[...PREDICATE_OPS].join(" | ")}` };
          if (op !== "is_null" && op !== "not_null" && input["value"] === undefined) {
            return { ok: false, error: `op "${op}" needs a value` };
          }
          return { ok: true, value: input };
        }
        if (!str(input, "sheet")) return { ok: false, error: "filter_rows needs a sheet name or a result id" };
        if (!isPlainObject(input["where"])) return { ok: false, error: "filter_rows needs a 'where' condition object" };
        return { ok: true, value: input };
      }
      if (!str(input, "sheet") && !str(input, "result")) return { ok: false, error: `${name} needs a sheet name or a result id` };
      if (!str(input, "by")) return { ok: false, error: `${name} needs a 'by' column` };
      if (name === "sort_rows") {
        const dir = str(input, "direction") ?? "desc";
        if (dir !== "asc" && dir !== "desc") return { ok: false, error: "direction must be 'asc' or 'desc'" };
        return { ok: true, value: { ...input, direction: dir } };
      }
      const n = input["n"];
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 100) return { ok: false, error: "n must be an integer 1..100" };
      return { ok: true, value: input };
    },
    execute: async (input, ctx) => {
      const resultId = str(input, "result");

      if (name === "filter_rows" && resultId) {
        const prior = findPriorResult(ctx, resultId);
        if (!prior) return err("filter_rows", `no earlier result with id "${resultId}"`, resultId);
        const col = String(input["column"]);
        const idx = resolveColumnIndex(prior.columns, col);
        if (idx === "ambiguous") return err("filter_rows", `column "${col}" is ambiguous in ${resultId}`, resultId);
        if (idx < 0) return err("filter_rows", `column "${col}" is not in ${resultId}`, resultId);
        const op = String(input["op"]);
        const rows = prior.rows.filter((row) => applyPredicate(op, row[idx] ?? null, input["value"]));
        return {
          tool: "filter_rows",
          ok: true,
          kind: "table",
          source: resultId,
          operation: `filter ${prior.columns[idx]} ${op}${op === "is_null" || op === "not_null" ? "" : ` ${String(input["value"])}`}`,
          derivedFrom: [resultId],
          columns: prior.columns,
          rows: rows.map((row) => [...row]),
          rowCount: rows.length,
        };
      }

      if ((name === "sort_rows" || name === "top_n") && resultId) {
        const prior = findPriorResult(ctx, resultId);
        if (!prior) return err(name, `no earlier result with id "${resultId}"`, resultId);
        const idx = resolveColumnIndex(prior.columns, String(input["by"]));
        if (idx === "ambiguous") return err(name, `column "${String(input["by"])}" is ambiguous in ${resultId}`, resultId);
        if (idx < 0) return err(name, `column "${String(input["by"])}" is not in ${resultId}`, resultId);
        const direction = name === "sort_rows" ? ((input["direction"] as "asc" | "desc") ?? "desc") : "desc";
        let rows = sortByColumn(prior, idx, direction);
        if (name === "top_n") rows = rows.slice(0, Number(input["n"]));
        return {
          tool: name,
          ok: true,
          kind: "table",
          source: resultId,
          operation: name === "top_n" ? `top ${Number(input["n"])} by ${prior.columns[idx]}` : `sort ${direction} by ${prior.columns[idx]}`,
          derivedFrom: [resultId],
          columns: prior.columns,
          rows: rows.map((row) => [...row]),
          rowCount: rows.length,
        };
      }

      const resolved = await resolveSnapshot(ctx, name, String(input["sheet"]));
      if (!resolved.ok) return resolved.obs;
      let request: AnalysisRequest;
      if (name === "filter_rows") {
        request = {
          op: "filter",
          where: input["where"] as Extract<AnalysisRequest, { op: "filter" }>["where"],
          ...(Array.isArray(input["columns"]) ? { columns: (input["columns"] as string[]) } : {}),
          ...(typeof input["limit"] === "number" ? { limit: input["limit"] as number } : {}),
        };
      } else if (name === "sort_rows") {
        request = { op: "sort", by: { kind: "column", name: String(input["by"]) }, direction: (input["direction"] as "asc" | "desc") ?? "desc" };
      } else {
        request = { op: "top_n", n: Number(input["n"]), by: { kind: "column", name: String(input["by"]) } };
      }
      const outcome = firstOutcome(ctx.deps.analyze(resolved.snapshot, request));
      if ("error" in outcome) return err(name, outcome.error, resolved.snapshot.address);
      return {
        tool: name,
        ok: true,
        kind: "table",
        source: resolved.snapshot.address,
        sourceVersion: sourceVersionOf(resolved.snapshot),
        operation: request.op,
        columns: outcome.columns ?? [],
        rows: (outcome.rows ?? []).map((row) => [...row]),
        rowCount: outcome.rows?.length ?? 0,
        truncated: outcome.truncated,
      };
    },
  });
}

/** §7 — one call may compare a bounded set of common numeric columns. */
const MAX_COMPARE_METRICS = 10;

const compareAggregates = defineTool<{
  sheetA: string;
  sheetB: string;
  column?: string;
  columns?: readonly string[];
  metric: string;
}>({
  name: "compare_aggregates",
  description:
    "Compare an aggregate of one column — or a bounded set of columns (pass `columns`, max 10) — between two worksheets. Returns per metric: both values, absolute change and percentage change. Non-numeric / missing columns are skipped, never fabricated.",
  parameters: {
    sheetA: "first worksheet",
    sheetB: "second worksheet",
    column: "one column present in both (single-metric form)",
    columns: "column names present in both (multi-metric form, max 10)",
    metric: "'mean' | 'sum' | 'count' | 'min' | 'max'",
  },
  mutating: false,
  readCost: 2,
  validate: (input) => {
    const extra = onlyKeys(input, ["sheetA", "sheetB", "column", "columns", "metric"]);
    if (extra) return { ok: false, error: extra };
    const sheetA = str(input, "sheetA");
    const sheetB = str(input, "sheetB");
    if (!sheetA || !sheetB) return { ok: false, error: "compare_aggregates needs sheetA and sheetB" };
    const column = str(input, "column");
    const columnsRaw = input["columns"];
    const columns =
      columnsRaw === undefined
        ? undefined
        : Array.isArray(columnsRaw) && columnsRaw.every((c) => typeof c === "string" && c.trim() !== "")
          ? (columnsRaw as string[]).map((c) => c.trim())
          : null;
    if (columns === null) return { ok: false, error: "columns must be a non-empty array of column names" };
    if (!column && (!columns || columns.length === 0)) return { ok: false, error: "provide `column` or `columns`" };
    if (columns && columns.length > MAX_COMPARE_METRICS) {
      return { ok: false, error: `at most ${MAX_COMPARE_METRICS} columns per call` };
    }
    const metric = str(input, "metric") ?? "mean";
    if (!["mean", "sum", "count", "min", "max"].includes(metric)) return { ok: false, error: "metric must be mean|sum|count|min|max" };
    return { ok: true, value: { sheetA, sheetB, ...(column ? { column } : {}), ...(columns ? { columns } : {}), metric } };
  },
  execute: async (input, ctx) => {
    const a = await resolveSnapshot(ctx, "compare_aggregates", input.sheetA);
    if (!a.ok) return a.obs;
    const b = await resolveSnapshot(ctx, "compare_aggregates", input.sheetB);
    if (!b.ok) return b.obs;

    const one = (col: string): { va: number | null; vb: number | null } | { skip: string } => {
      const request: AnalysisRequest =
        input.metric === "count"
          ? { op: "count" }
          : { op: "aggregate", metric: input.metric as "mean" | "sum" | "min" | "max", target: { kind: "column", name: col } };
      const oa = firstOutcome(ctx.deps.analyze(a.snapshot, request));
      if ("error" in oa) return { skip: `${col}: ${oa.error}` };
      const ob = firstOutcome(ctx.deps.analyze(b.snapshot, request));
      if ("error" in ob) return { skip: `${col}: ${ob.error}` };
      return { va: oa.value ?? null, vb: ob.value ?? null };
    };

    const source = `${a.snapshot.sheetName} vs ${b.snapshot.sheetName}`;
    const srcVersions = [
      { sourceRange: a.snapshot.address, version: sourceVersionOf(a.snapshot) },
      { sourceRange: b.snapshot.address, version: sourceVersionOf(b.snapshot) },
    ];

    // single-metric form — unchanged shape (4.1 / 4.2 callers).
    if (input.column && !input.columns) {
      const r = one(input.column);
      if ("skip" in r) return err("compare_aggregates", r.skip, source);
      const delta = r.va !== null && r.vb !== null ? r.vb - r.va : null;
      const pct = r.va !== null && r.vb !== null && r.va !== 0 ? (r.vb - r.va) / Math.abs(r.va) : null;
      return {
        tool: "compare_aggregates",
        ok: true,
        kind: "table",
        source,
        sourceVersions: srcVersions,
        operation: `${input.metric} ${input.column}`,
        columns: ["Series", `${input.metric} ${input.column}`],
        rows: [
          [input.sheetA, r.va],
          [input.sheetB, r.vb],
          ["Change", delta],
          ["Change %", pct === null ? null : Number((pct * 100).toFixed(4))],
        ],
        rowCount: 4,
      };
    }

    // multi-metric form — one row per column.
    const wanted = input.columns ?? (input.column ? [input.column] : []);
    const rows: CellValue[][] = [];
    const skipped: string[] = [];
    for (const col of wanted.slice(0, MAX_COMPARE_METRICS)) {
      const r = one(col);
      if ("skip" in r) {
        skipped.push(r.skip);
        continue;
      }
      const delta = r.va !== null && r.vb !== null ? r.vb - r.va : null;
      const pct = r.va !== null && r.vb !== null && r.va !== 0 ? (r.vb - r.va) / Math.abs(r.va) : null;
      rows.push([col, r.va, r.vb, delta, pct === null ? null : Number((pct * 100).toFixed(4))]);
    }
    if (rows.length === 0) {
      return err("compare_aggregates", `none of the requested columns could be compared: ${skipped.join("; ")}`, source);
    }
    return {
      tool: "compare_aggregates",
      ok: true,
      kind: "table",
      source,
      sourceVersions: srcVersions,
      operation: `${input.metric} of ${rows.length} column(s)`,
      columns: ["Metric", input.sheetA, input.sheetB, "Change", "Change %"],
      rows,
      rowCount: rows.length,
      ...(skipped.length > 0 ? { note: `skipped (not comparable): ${skipped.join("; ")}` } : {}),
    };
  },
});

// --- §2/§3 derive_metric — safe arithmetic over a prior result -------------
const deriveMetricTool = defineTool<{
  result: string;
  left: string;
  operator: DerivedMetricOperator;
  right?: string;
  scalar?: number;
  output: string;
}>({
  name: "derive_metric",
  description:
    "Add ONE computed column to an earlier result. operator is one of add | subtract | divide | abs_diff | pct_change ((A-B)/B) | pp_change (A-B in percentage points). Right side is a column (`right`) or a number (`scalar`, not for pct/pp). Never re-reads the workbook; a missing / null / non-numeric operand yields null (never fabricated).",
  parameters: {
    result: "the result id to derive from",
    left: "left column name",
    operator: "add | subtract | divide | abs_diff | pct_change | pp_change",
    right: "right column name (or use scalar)",
    scalar: "right-hand number (not allowed for pct_change / pp_change)",
    output: "name for the new column",
  },
  mutating: false,
  readCost: 0,
  validate: (input) => {
    const extra = onlyKeys(input, ["result", "left", "operator", "right", "scalar", "output"]);
    if (extra) return { ok: false, error: extra };
    const result = str(input, "result");
    const left = str(input, "left");
    const output = str(input, "output");
    const operator = str(input, "operator") as DerivedMetricOperator | undefined;
    if (!result || !left || !output) return { ok: false, error: "derive_metric needs result, left and output" };
    if (!operator || !DERIVED_METRIC_OPERATORS.includes(operator)) {
      return { ok: false, error: `operator must be one of ${DERIVED_METRIC_OPERATORS.join(" | ")}` };
    }
    const right = str(input, "right");
    const scalar = typeof input["scalar"] === "number" ? (input["scalar"] as number) : undefined;
    return { ok: true, value: { result, left, operator, output, ...(right ? { right } : {}), ...(scalar !== undefined ? { scalar } : {}) } };
  },
  execute: async (input, ctx) => {
    const prior = findPriorResult(ctx, input.result);
    if (!prior) return err("derive_metric", `no earlier result with id "${input.result}"`, input.result);
    const derived = deriveMetric(
      { columns: prior.columns, rows: prior.rows },
      {
        left: input.left,
        operator: input.operator,
        output: input.output,
        ...(input.right ? { right: input.right } : {}),
        ...(input.scalar !== undefined ? { scalar: input.scalar } : {}),
      },
    );
    if (!derived.ok) return err("derive_metric", derived.error, input.result);
    return {
      tool: "derive_metric",
      ok: true,
      kind: "table",
      source: input.result,
      operation: `derive ${input.output} = ${input.left} ${input.operator} ${input.right ?? input.scalar}`,
      derivedFrom: [input.result],
      columns: derived.grid.columns,
      rows: derived.grid.rows.map((row) => [...row]),
      rowCount: derived.grid.rows.length,
    };
  },
});

// --- §6/§8/§9 compare_results — align two grouped results on a key --------
const compareResultsTool = defineTool<{
  result_a: string;
  result_b: string;
  key: string;
  value?: string;
  label_a?: string;
  label_b?: string;
}>({
  name: "compare_results",
  description:
    "Align two grouped results on a shared key column and, for one numeric value column present in both, produce a canonical comparison: <key> | <value> <label_a> | <value> <label_b> | Δ <value> | %Δ <value>. Grouped-aggregate alignment only (no row-level join); a key on only one side is kept with null on the missing side.",
  parameters: {
    result_a: "first result id",
    result_b: "second result id",
    key: "the shared key / dimension column name",
    value: "the numeric value column to compare (defaults to the single common numeric column)",
    label_a: "label for result_a's period (default 'A')",
    label_b: "label for result_b's period (default 'B')",
  },
  mutating: false,
  readCost: 0,
  validate: (input) => {
    const extra = onlyKeys(input, ["result_a", "result_b", "key", "value", "label_a", "label_b"]);
    if (extra) return { ok: false, error: extra };
    const result_a = str(input, "result_a");
    const result_b = str(input, "result_b");
    const key = str(input, "key");
    if (!result_a || !result_b || !key) return { ok: false, error: "compare_results needs result_a, result_b and key" };
    return {
      ok: true,
      value: {
        result_a,
        result_b,
        key,
        ...(str(input, "value") ? { value: str(input, "value") as string } : {}),
        ...(str(input, "label_a") ? { label_a: str(input, "label_a") as string } : {}),
        ...(str(input, "label_b") ? { label_b: str(input, "label_b") as string } : {}),
      },
    };
  },
  execute: async (input, ctx) => {
    const a = findPriorResult(ctx, input.result_a);
    const b = findPriorResult(ctx, input.result_b);
    if (!a) return err("compare_results", `no earlier result with id "${input.result_a}"`, input.result_a);
    if (!b) return err("compare_results", `no earlier result with id "${input.result_b}"`, input.result_b);

    const keyA = resolveColumnIndex(a.columns, input.key);
    const keyB = resolveColumnIndex(b.columns, input.key);
    if (keyA === "ambiguous" || keyB === "ambiguous") return err("compare_results", `key "${input.key}" is ambiguous`, input.result_a);
    if (keyA < 0 || keyB < 0) return err("compare_results", `key "${input.key}" is not in both results`, input.result_a);

    const numericCols = (r: AgentResultLike): string[] =>
      r.columns.filter((_, ci) => {
        let n = 0;
        let t = 0;
        for (const row of r.rows) {
          const v = row[ci];
          if (v === null || v === undefined || v === "") continue;
          t += 1;
          if (toNum(v) !== null) n += 1;
        }
        return t > 0 && n / t >= 0.6;
      });
    let value = input.value;
    if (!value) {
      const common = numericCols(a).filter((c) => numericCols(b).some((d) => d.toLowerCase() === c.toLowerCase()));
      if (common.length === 0) return err("compare_results", "no common numeric column to compare — pass `value`", input.result_a);
      if (common.length > 1) return err("compare_results", `several common numeric columns: ${common.join(", ")} — pass one as \`value\``, input.result_a);
      value = common[0]!;
    }
    const valA = resolveColumnIndex(a.columns, value);
    const valB = resolveColumnIndex(b.columns, value);
    if (valA === "ambiguous" || valB === "ambiguous") return err("compare_results", `value "${value}" is ambiguous`, input.result_a);
    if (valA < 0 || valB < 0) return err("compare_results", `value "${value}" is not in both results`, input.result_a);

    const mapOf = (r: AgentResultLike, ki: number, vi: number): Map<string, number | null> => {
      const m = new Map<string, number | null>();
      for (const row of r.rows) m.set(String(row[ki] ?? ""), toNum(row[vi] ?? null));
      return m;
    };
    const ma = mapOf(a, keyA, valA);
    const mb = mapOf(b, keyB, valB);
    const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort();
    const la = input.label_a ?? "A";
    const lb = input.label_b ?? "B";
    const rows: CellValue[][] = keys.map((k) => {
      const av = ma.has(k) ? (ma.get(k) ?? null) : null;
      const bv = mb.has(k) ? (mb.get(k) ?? null) : null;
      const delta = av !== null && bv !== null ? bv - av : null;
      const pct = av !== null && bv !== null && av !== 0 ? (bv - av) / Math.abs(av) : null;
      return [k, av, bv, delta, pct === null ? null : Number((pct * 100).toFixed(4))];
    });
    return {
      tool: "compare_results",
      ok: true,
      kind: "table",
      source: `${input.result_a} vs ${input.result_b}`,
      operation: `compare ${value} by ${input.key}`,
      derivedFrom: [input.result_a, input.result_b],
      columns: [input.key, `${value} ${la}`, `${value} ${lb}`, `Δ ${value}`, `%Δ ${value}`],
      rows,
      rowCount: rows.length,
    };
  },
});

const describeResult = defineTool<{ result: string }>({
  name: "describe_result",
  description: "Schema and shape of an earlier tool result: its columns, row count and first row. Costs no workbook read.",
  parameters: { result: "the result id from an earlier observation" },
  mutating: false,
  readCost: 0,
  validate: (input) => {
    const extra = onlyKeys(input, ["result"]);
    if (extra) return { ok: false, error: extra };
    const result = str(input, "result");
    return result ? { ok: true, value: { result } } : { ok: false, error: "describe_result needs a result id" };
  },
  execute: async (input, ctx) => {
    const prior = findPriorResult(ctx, input.result);
    if (!prior) return err("describe_result", `no earlier result with id "${input.result}"`, input.result);
    const firstRow = prior.rows[0] ? prior.rows[0].map((c) => String(c ?? "")).join(" | ") : "(no rows)";
    return {
      tool: "describe_result",
      ok: true,
      kind: "text",
      source: input.result,
      note: `${prior.title} — ${prior.rows.length} row(s) x ${prior.columns.length} column(s); columns: ${prior.columns.join(", ")}; first row: ${firstRow}`,
    };
  },
});

const chartResult = defineTool<{ result: string; columns?: readonly string[] }>({
  name: "chart_result",
  description: "Build chart data from an earlier tabular result. Only when the user asked for a visualization. Costs no workbook read.",
  parameters: { result: "the result id", columns: "optional numeric column names to plot" },
  mutating: false,
  readCost: 0,
  validate: (input) => {
    const extra = onlyKeys(input, ["result", "columns"]);
    if (extra) return { ok: false, error: extra };
    const result = str(input, "result");
    if (!result) return { ok: false, error: "chart_result needs a result id" };
    const columns = input["columns"];
    if (columns !== undefined && !(Array.isArray(columns) && columns.every((c) => typeof c === "string"))) {
      return { ok: false, error: "columns must be an array of strings" };
    }
    return { ok: true, value: { result, ...(columns ? { columns: columns as string[] } : {}) } };
  },
  execute: async (input, ctx) => {
    const prior = findPriorResult(ctx, input.result);
    if (!prior) return err("chart_result", `no earlier result with id "${input.result}"`, input.result);
    const built = ctx.deps.chartFromResult(prior, ctx.language, input.columns);
    if (built.kind === "error") return err("chart_result", built.error, input.result);
    if (built.kind === "clarify") {
      return { tool: "chart_result", ok: true, kind: "text", source: input.result, note: `chart needs a column choice: ${built.question} (${built.candidates.join(", ")})` };
    }
    const series = built.chart.series;
    const labels = series.kind === "category" || series.kind === "multi-category" ? series.labels : [];
    return {
      tool: "chart_result",
      ok: true,
      kind: "chart",
      source: input.result,
      chart: built.chart,
      note: `chart ready (${built.chart.type}, ${series.kind})${labels.length > 0 ? `: ${labels.slice(0, 8).join(", ")}` : ""}`,
    };
  },
});

// --- registry -----------------------------------------------------------

export function defaultAgentTools(): readonly AgentTool[] {
  return [
    workbookOverview,
    listSheets,
    inspectTable,
    readRange,
    findColumn,
    summarize,
    groupBy,
    sheetRowsTool("filter_rows", "Return the rows of a worksheet matching a condition."),
    sheetRowsTool("sort_rows", "Sort a worksheet or an earlier result by a column."),
    sheetRowsTool("top_n", "Return the top N rows of a worksheet or an earlier result by a column."),
    compareAggregates,
    compareResultsTool,
    deriveMetricTool,
    describeResult,
    chartResult,
  ] as AgentTool[];
}

export function createAgentToolRegistry(tools: readonly AgentTool[] = defaultAgentTools()): AgentToolRegistry {
  const byName = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`duplicate agent tool "${tool.name}"`);
    byName.set(tool.name, tool);
  }
  const ordered = [...tools];
  return {
    get: (name) => byName.get(name),
    list: () => ordered,
    names: () => ordered.map((t) => t.name),
    schemas: (): readonly AgentToolSchema[] =>
      ordered.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, mutating: t.mutating, readCost: t.readCost })),
  };
}

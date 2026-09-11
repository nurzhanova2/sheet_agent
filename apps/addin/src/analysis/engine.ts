import type { Dataset, DatasetColumn } from "./dataset.js";
import {
  AnalysisRequestError,
  displayValue,
  evaluateExpression,
  evaluateGroup,
  expressionColumns,
  matchingRowIndexes,
  resolveColumn,
} from "./expression.js";
import { validateAnalysisRequest } from "./validate.js";
import {
  ANALYSIS_LIMITS,
  isAnalysisError,
  type AggregateMetric,
  type AnalysisError,
  type AnalysisOutcome,
  type AnalysisRequest,
  type AnalysisResult,
  type CellPrimitive,
  type ColumnStatistics,
  type Expression,
  type GroupMetric,
  type GroupResult,
} from "./types.js";

// --- numeric helpers ----------------------------------------------------------

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid] ?? null;
}
function stddev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values) as number;
  return Math.sqrt(sum(values.map((value) => (value - m) ** 2)) / (values.length - 1));
}
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base] ?? 0;
  const upper = sorted[base + 1] ?? lower;
  return lower + rest * (upper - lower);
}
function pearson(pairs: readonly (readonly [number, number])[]): number | null {
  if (pairs.length < 3) return null;
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const mx = mean(xs) as number;
  const my = mean(ys) as number;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function aggregate(metric: AggregateMetric, values: readonly number[]): number | null {
  switch (metric) {
    case "count":
      return values.length;
    case "sum":
      return values.length === 0 ? null : sum(values);
    case "mean":
      return mean(values);
    case "median":
      return median(values);
    case "min":
      return values.length === 0 ? null : Math.min(...values);
    case "max":
      return values.length === 0 ? null : Math.max(...values);
  }
}

function collectNumeric(dataset: Dataset, expression: Expression, rowIndexes: readonly number[]): { values: number[]; missing: number } {
  const values: number[] = [];
  let missing = 0;
  for (const index of rowIndexes) {
    const value = evaluateExpression(dataset, expression, index);
    if (value === null || !Number.isFinite(value)) missing += 1;
    else values.push(value);
  }
  return { values, missing };
}

function projection(dataset: Dataset, requested: readonly string[] | undefined): DatasetColumn[] {
  if (!requested || requested.length === 0) return [...dataset.columns];
  return requested.map((name) => resolveColumn(dataset, name));
}

function rowFor(columns: readonly DatasetColumn[], rowIndex: number): CellPrimitive[] {
  return columns.map((column) => displayValue(column, rowIndex));
}

// --- main entry -------------------------------------------------------------

export function runAnalysis(dataset: Dataset, request: AnalysisRequest): AnalysisOutcome {
  const structural = validateAnalysisRequest(request);
  if (structural) return structural;
  try {
    return dispatch(dataset, request);
  } catch (error) {
    if (error instanceof AnalysisRequestError) return { code: error.code, error: error.message };
    return { code: "INVALID_REQUEST", error: error instanceof Error ? error.message : "analysis failed" };
  }
}

function base(dataset: Dataset, op: AnalysisRequest["op"], warnings: string[]): Omit<AnalysisResult, "op"> & { op: AnalysisRequest["op"] } {
  return {
    op,
    source: dataset.source,
    rowsAnalyzed: dataset.rowCount,
    truncated: false,
    warnings,
  };
}

function dispatch(dataset: Dataset, request: AnalysisRequest): AnalysisResult {
  const warnings: string[] = [];
  if (dataset.truncated) warnings.push("The selection was truncated before analysis; results cover only the rows that were read.");

  switch (request.op) {
    case "count": {
      const matched = matchingRowIndexes(dataset, request.where);
      return { ...base(dataset, request.op, warnings), rowsMatched: matched.length, value: matched.length };
    }

    case "aggregate": {
      const matched = matchingRowIndexes(dataset, request.where);
      const { values, missing } = collectNumeric(dataset, request.target, matched);
      if (missing > 0) warnings.push(`${missing} row(s) had a missing or non-numeric value and were excluded.`);
      return {
        ...base(dataset, request.op, warnings),
        rowsMatched: matched.length,
        parameters: { metric: request.metric, observations: values.length, columns: expressionColumns(request.target) },
        value: aggregate(request.metric, values),
      };
    }

    case "filter":
    case "sort": {
      let indexes = matchingRowIndexes(dataset, request.where);
      if (request.op === "sort") {
        const scored = indexes.map((index) => ({ index, value: evaluateExpression(dataset, request.by, index) }));
        const missing = scored.filter((entry) => entry.value === null).length;
        if (missing > 0) warnings.push(`${missing} row(s) had no sortable value and were placed last.`);
        scored.sort((a, b) => rank(a.value, b.value, request.direction));
        indexes = scored.map((entry) => entry.index);
      }
      const limit = Math.min(request.limit ?? ANALYSIS_LIMITS.maxResultRows, ANALYSIS_LIMITS.maxResultRows);
      const columns = projection(dataset, request.columns);
      const kept = indexes.slice(0, limit);
      return {
        ...base(dataset, request.op, warnings),
        rowsMatched: indexes.length,
        truncated: indexes.length > kept.length,
        columns: columns.map((column) => column.name),
        rows: kept.map((index) => rowFor(columns, index)),
        sourceRows: kept.map((index) => dataset.firstDataSheetRow + index),
        ...(request.op === "sort" ? { parameters: { by: expressionColumns(request.by), direction: request.direction } } : {}),
      };
    }

    case "top_n":
    case "bottom_n": {
      const matched = matchingRowIndexes(dataset, request.where);
      const scored = matched
        .map((index) => ({ index, value: evaluateExpression(dataset, request.by, index) }))
        .filter((entry): entry is { index: number; value: number } => entry.value !== null && Number.isFinite(entry.value));
      const excluded = matched.length - scored.length;
      if (excluded > 0) warnings.push(`${excluded} row(s) had a missing or non-numeric ranking value and were excluded.`);
      const direction = request.op === "top_n" ? "desc" : "asc";
      scored.sort((a, b) => rank(a.value, b.value, direction));
      const n = Math.min(request.n, ANALYSIS_LIMITS.maxN, ANALYSIS_LIMITS.maxResultRows);
      const kept = scored.slice(0, n);
      const columns = projection(dataset, request.columns);
      return {
        ...base(dataset, request.op, warnings),
        rowsMatched: matched.length,
        truncated: scored.length > kept.length,
        parameters: { n, by: expressionColumns(request.by), direction, values: kept.map((entry) => entry.value) },
        columns: columns.map((column) => column.name),
        rows: kept.map((entry) => rowFor(columns, entry.index)),
        sourceRows: kept.map((entry) => dataset.firstDataSheetRow + entry.index),
      };
    }

    case "distinct": {
      const column = resolveColumn(dataset, request.column);
      const matched = matchingRowIndexes(dataset, request.where);
      const seen = new Map<string, CellPrimitive>();
      for (const index of matched) {
        const value = displayValue(column, index);
        const key = value === null ? " null" : String(value);
        if (!seen.has(key)) seen.set(key, value);
      }
      const rows = [...seen.values()].slice(0, ANALYSIS_LIMITS.maxResultRows);
      return {
        ...base(dataset, request.op, warnings),
        rowsMatched: matched.length,
        truncated: seen.size > rows.length,
        parameters: { column: column.name, distinctCount: seen.size },
        columns: [column.name],
        rows: rows.map((value) => [value]),
      };
    }

    case "summary_statistics": {
      const columns = projection(dataset, request.columns).filter((column) => column.type === "number" || column.type === "date");
      if (columns.length === 0) warnings.push("No numeric or date columns to summarise.");
      const statistics: Record<string, ColumnStatistics> = {};
      for (const column of columns) {
        const present = column.numeric.filter((value): value is number => value !== null && Number.isFinite(value));
        statistics[column.name] = {
          count: present.length,
          missing: dataset.rowCount - present.length,
          min: present.length ? Math.min(...present) : null,
          max: present.length ? Math.max(...present) : null,
          mean: mean(present),
          median: median(present),
          stddev: stddev(present),
        };
      }
      return { ...base(dataset, request.op, warnings), parameters: { standardDeviation: "sample (n-1)" }, statistics };
    }

    case "correlation": {
      const matched = matchingRowIndexes(dataset, request.where);
      const pairs: [number, number][] = [];
      let missing = 0;
      for (const index of matched) {
        const x = evaluateExpression(dataset, request.x, index);
        const y = evaluateExpression(dataset, request.y, index);
        if (x === null || y === null) missing += 1;
        else pairs.push([x, y]);
      }
      if (missing > 0) warnings.push(`${missing} row(s) were excluded for missing/non-numeric values.`);
      const r = pearson(pairs);
      if (r === null) warnings.push("Fewer than 3 complete observations (or zero variance); correlation is not defined.");
      return {
        ...base(dataset, request.op, warnings),
        rowsMatched: matched.length,
        parameters: { method: "pearson", observations: pairs.length, x: expressionColumns(request.x), y: expressionColumns(request.y) },
        value: r,
      };
    }

    case "outliers": {
      const matched = matchingRowIndexes(dataset, request.where);
      const scored = matched
        .map((index) => ({ index, value: evaluateExpression(dataset, request.target, index) }))
        .filter((entry): entry is { index: number; value: number } => entry.value !== null && Number.isFinite(entry.value));
      const values = scored.map((entry) => entry.value);
      const sorted = [...values].sort((a, b) => a - b);
      let lower: number;
      let upper: number;
      const parameters: Record<string, unknown> = { method: request.method };
      if (request.method === "iqr") {
        const k = request.threshold ?? 1.5;
        const q1 = quantile(sorted, 0.25);
        const q3 = quantile(sorted, 0.75);
        const iqr = q3 - q1;
        lower = q1 - k * iqr;
        upper = q3 + k * iqr;
        Object.assign(parameters, { multiplier: k, q1, q3, iqr, lowerBound: lower, upperBound: upper });
      } else {
        const k = request.threshold ?? 3;
        const m = mean(values) ?? 0;
        const sd = stddev(values) ?? 0;
        lower = m - k * sd;
        upper = m + k * sd;
        Object.assign(parameters, { threshold: k, mean: m, stddev: sd, lowerBound: lower, upperBound: upper });
      }
      const outliers = scored.filter((entry) => entry.value < lower || entry.value > upper).slice(0, ANALYSIS_LIMITS.maxResultRows);
      const columns = projection(dataset, request.columns);
      return {
        ...base(dataset, request.op, warnings),
        rowsMatched: matched.length,
        truncated: scored.filter((entry) => entry.value < lower || entry.value > upper).length > outliers.length,
        parameters: { ...parameters, observations: values.length, outlierCount: scored.filter((entry) => entry.value < lower || entry.value > upper).length },
        columns: columns.map((column) => column.name),
        rows: outliers.map((entry) => rowFor(columns, entry.index)),
        sourceRows: outliers.map((entry) => dataset.firstDataSheetRow + entry.index),
      };
    }

    case "group_by":
      return groupBy(dataset, request, warnings);

    case "group_correlation":
      return groupCorrelation(dataset, request, warnings);
  }
}

function rank(a: number | null, b: number | null, direction: "asc" | "desc"): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "asc" ? a - b : b - a;
}

function groupBy(
  dataset: Dataset,
  request: Extract<AnalysisRequest, { op: "group_by" }>,
  warnings: string[],
): AnalysisResult {
  const dimensions = request.by.map((name) => resolveColumn(dataset, name));
  const matched = matchingRowIndexes(dataset, request.where);
  const buckets = new Map<string, { key: Record<string, string>; rows: number[] }>();
  for (const index of matched) {
    const keyParts = dimensions.map((column) => column.text[index] ?? "");
    const keyString = keyParts.join(" ␟ ");
    let bucket = buckets.get(keyString);
    if (!bucket) {
      bucket = { key: Object.fromEntries(dimensions.map((column, position) => [column.name, keyParts[position] ?? ""])), rows: [] };
      buckets.set(keyString, bucket);
    }
    bucket.rows.push(index);
  }

  const metricName = (metric: GroupMetric, position: number): string => metric.name ?? `${metric.metric}${position === 0 ? "" : `_${position}`}`;

  let groups: GroupResult[] = [...buckets.values()].map((bucket) => {
    const metrics: Record<string, number | null> = {};
    request.metrics.forEach((metric, position) => {
      const rows = metric.where ? bucket.rows.filter((index) => evaluateGroup(dataset, metric.where, index)) : bucket.rows;
      if (metric.metric === "count") {
        metrics[metricName(metric, position)] = rows.length;
      } else {
        const { values } = collectNumeric(dataset, metric.target as Expression, rows);
        metrics[metricName(metric, position)] = aggregate(metric.metric, values);
      }
    });
    return { key: bucket.key, count: bucket.rows.length, metrics };
  });

  if (request.sort) {
    const key = typeof request.sort.by === "string" ? request.sort.by : null;
    groups.sort((a, b) => {
      const av = key ? a.metrics[key] ?? null : null;
      const bv = key ? b.metrics[key] ?? null : null;
      return rank(av, bv, request.sort?.direction ?? "desc");
    });
  } else {
    groups.sort((a, b) => Object.values(a.key).join().localeCompare(Object.values(b.key).join()));
  }

  const limit = Math.min(request.limit ?? ANALYSIS_LIMITS.maxGroups, ANALYSIS_LIMITS.maxGroups);
  const truncated = groups.length > limit;
  groups = groups.slice(0, limit);

  return {
    ...base(dataset, request.op, warnings),
    rowsMatched: matched.length,
    truncated,
    parameters: { dimensions: dimensions.map((column) => column.name), groupCount: buckets.size },
    groups,
  };
}

/**
 * Pearson r of two expressions within each group. One deterministic call replaces
 * N fragile per-group `correlation` requests: rows are bucketed by the dimension
 * columns, then for each bucket incomplete (x, y) pairs are dropped and r is
 * computed only when n >= 3 with non-zero variance in both variables.
 */
function groupCorrelation(
  dataset: Dataset,
  request: Extract<AnalysisRequest, { op: "group_correlation" }>,
  warnings: string[],
): AnalysisResult {
  const dimensions = request.by.map((name) => resolveColumn(dataset, name));
  const matched = matchingRowIndexes(dataset, request.where);
  const buckets = new Map<string, { key: Record<string, string>; rows: number[] }>();
  for (const index of matched) {
    const keyParts = dimensions.map((column) => column.text[index] ?? "");
    const keyString = keyParts.join(" ␟ ");
    let bucket = buckets.get(keyString);
    if (!bucket) {
      bucket = { key: Object.fromEntries(dimensions.map((column, position) => [column.name, keyParts[position] ?? ""])), rows: [] };
      buckets.set(keyString, bucket);
    }
    bucket.rows.push(index);
  }

  const groups: GroupResult[] = [...buckets.values()].map((bucket) => {
    const pairs: [number, number][] = [];
    let missing = 0;
    for (const index of bucket.rows) {
      const x = evaluateExpression(dataset, request.x, index);
      const y = evaluateExpression(dataset, request.y, index);
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) missing += 1;
      else pairs.push([x, y]);
    }
    const r = pearson(pairs);
    if (r === null) {
      warnings.push(`Group "${Object.values(bucket.key).join(" / ")}": fewer than 3 complete pairs or zero variance; r is undefined.`);
    }
    return { key: bucket.key, count: bucket.rows.length, metrics: { n: pairs.length, missing, r } };
  });

  groups.sort((a, b) => Object.values(a.key).join().localeCompare(Object.values(b.key).join()));
  const limit = ANALYSIS_LIMITS.maxGroups;

  return {
    ...base(dataset, request.op, warnings),
    rowsMatched: matched.length,
    truncated: groups.length > limit,
    parameters: {
      method: "pearson",
      dimensions: dimensions.map((column) => column.name),
      x: expressionColumns(request.x),
      y: expressionColumns(request.y),
      groupCount: buckets.size,
    },
    groups: groups.slice(0, limit),
  };
}

export { isAnalysisError };
export type { AnalysisOutcome, AnalysisResult, AnalysisError };

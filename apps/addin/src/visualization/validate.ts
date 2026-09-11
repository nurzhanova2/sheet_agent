import { validateAnalysisRequest } from "../analysis/validate.js";
import type { AggregateMetric } from "../analysis/types.js";
import {
  VIZ_LIMITS,
  type AggregatedValue,
  type ChartType,
  type ValueRef,
  type VisualizationError,
  type VisualizationRequest,
} from "./types.js";

const CHART_TYPES = new Set<ChartType>(["bar", "line", "scatter", "pie", "histogram"]);
const AGG_METRICS = new Set<AggregateMetric>(["count", "sum", "mean", "min", "max", "median"]);

// Property names that would carry model-authored numeric data. The engine — not
// the model — produces every rendered value, so a planner request containing one
// of these is rejected outright (Stage 21.2.4 §14).
const FORBIDDEN_DATA_KEYS = new Set(["data", "values", "points", "counts", "binEdges", "datasets", "labels", "rows"]);

function fail(code: VisualizationError["code"], error: string, detail?: string): VisualizationError {
  return detail === undefined ? { code, error } : { code, error, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep scan: reject a request that tries to hand us pre-computed chart data. */
function modelAuthoredDataKey(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = modelAuthoredDataKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DATA_KEYS.has(key) && Array.isArray(child)) return key;
    const hit = modelAuthoredDataKey(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Reuses the analysis engine's expression validator via a throwaway aggregate request. */
function expressionError(expression: unknown): string | null {
  const probe = validateAnalysisRequest({ op: "aggregate", metric: "sum", target: expression });
  return probe && probe.code === "INVALID_EXPRESSION" ? probe.error : null;
}

function conditionError(where: unknown): string | null {
  if (where === undefined) return null;
  const probe = validateAnalysisRequest({ op: "count", where });
  return probe && probe.code === "INVALID_CONDITION" ? probe.error : null;
}

function columnName(value: unknown): string | null {
  return isRecord(value) && typeof value["column"] === "string" && value["column"].length > 0 ? value["column"] : null;
}

function validateValueRef(value: unknown, label: string): string | null {
  if (columnName(value)) return null;
  if (isRecord(value) && value["expression"] !== undefined) return expressionError(value["expression"]);
  return `${label} must be {column} or {expression}`;
}

function validateAggregatedValue(value: unknown, label: string, allowed: ReadonlySet<AggregateMetric>): string | null {
  if (!isRecord(value)) return `${label} must be an object`;
  const metric = value["aggregate"];
  if (typeof metric !== "string" || !allowed.has(metric as AggregateMetric)) {
    return `${label}.aggregate must be one of ${[...allowed].join(", ")}`;
  }
  if (metric === "count") return null;
  if (value["column"] === undefined && value["expression"] === undefined) {
    return `${label} with aggregate "${metric}" needs a column or expression`;
  }
  if (value["expression"] !== undefined) return expressionError(value["expression"]);
  return typeof value["column"] === "string" && value["column"].length > 0 ? null : `${label}.column must be a non-empty string`;
}

/** Validates a multi-series `series` array (bar / line). Returns an error string or null. */
function validateSeries(raw: unknown, label: string): string | null {
  if (!Array.isArray(raw)) return `${label} must be an array of {value:{aggregate,column?}}`;
  if (raw.length < 1) return `${label} must have at least one series`;
  if (raw.length > VIZ_LIMITS.maxDatasets) return `${label} has ${raw.length} series (max ${VIZ_LIMITS.maxDatasets})`;
  const ids = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return `${label}[${index}] must be an object`;
    const valueError = validateAggregatedValue(entry["value"], `${label}[${index}].value`, AGG_METRICS);
    if (valueError) return valueError;
    if (entry["id"] !== undefined) {
      if (typeof entry["id"] !== "string" || entry["id"].length === 0) return `${label}[${index}].id must be a non-empty string`;
      if (ids.has(entry["id"])) return `${label}[${index}].id "${entry["id"]}" is duplicated`;
      ids.add(entry["id"]);
    }
    if (entry["label"] !== undefined && (typeof entry["label"] !== "string" || entry["label"].length > VIZ_LIMITS.maxLabelLength)) {
      return `${label}[${index}].label must be a string of at most ${VIZ_LIMITS.maxLabelLength} characters`;
    }
  }
  return null;
}

function positiveIntInRange(value: unknown, min: number, max: number, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) return `${label} must be an integer >= ${min}`;
  if (value > max) return `${label} must be <= ${max}`;
  return null;
}

/**
 * Structural validation of an untrusted VisualizationRequest. Column existence and
 * numeric-ness are checked later against the dataset (prepare.ts). No code, no
 * SVG/HTML/CSS/JS, no data points — only a typed chart specification.
 */
export function validateVisualizationRequest(raw: unknown): VisualizationRequest | VisualizationError {
  if (!isRecord(raw)) return fail("INVALID_VISUALIZATION", "visualization request must be an object");

  const forbidden = modelAuthoredDataKey(raw);
  if (forbidden) {
    return fail(
      "MODEL_DATA_FORBIDDEN",
      `the visualization request contains a model-authored "${forbidden}" array. Provide only the chart type, dimension, metric and aggregate — the engine computes every value.`,
    );
  }

  const type = raw["type"];
  if (typeof type !== "string" || !CHART_TYPES.has(type as ChartType)) {
    return fail("UNKNOWN_CHART_TYPE", `unknown chart type "${String(type)}"`);
  }
  const title = raw["title"];
  if (typeof title !== "string" || title.trim().length === 0) return fail("INVALID_VISUALIZATION", "title is required");
  if (title.length > VIZ_LIMITS.maxTitleLength) return fail("LIMIT_EXCEEDED", `title exceeds ${VIZ_LIMITS.maxTitleLength} characters`);

  const whereError = conditionError(raw["where"]);
  if (whereError) return fail("INVALID_VISUALIZATION", `where: ${whereError}`);

  switch (type as ChartType) {
    case "bar": {
      if (!columnName(raw["category"])) return fail("INVALID_VISUALIZATION", "bar.category must be {column}");
      const hasSeries = raw["series"] !== undefined;
      const hasValue = raw["value"] !== undefined;
      if (hasSeries === hasValue) return fail("INVALID_VISUALIZATION", "bar needs exactly one of `value` (single series) or `series` (multi-series)");
      if (hasSeries) {
        const seriesError = validateSeries(raw["series"], "bar.series");
        if (seriesError) return fail("INVALID_VISUALIZATION", seriesError);
      } else {
        const valueError = validateAggregatedValue(raw["value"], "bar.value", AGG_METRICS);
        if (valueError) return fail("INVALID_VISUALIZATION", valueError);
      }
      if (raw["mode"] !== undefined && raw["mode"] !== "grouped" && raw["mode"] !== "stacked") {
        return fail("INVALID_VISUALIZATION", "bar.mode must be 'grouped' or 'stacked'");
      }
      if (raw["orientation"] !== undefined && raw["orientation"] !== "vertical" && raw["orientation"] !== "horizontal") {
        return fail("INVALID_VISUALIZATION", "bar.orientation must be 'vertical' or 'horizontal'");
      }
      return raw as unknown as VisualizationRequest;
    }
    case "pie": {
      if (!columnName(raw["category"])) return fail("INVALID_VISUALIZATION", "pie.category must be {column}");
      const valueError = validateAggregatedValue(raw["value"], "pie.value", new Set<AggregateMetric>(["count", "sum"]));
      if (valueError) return fail("INVALID_VISUALIZATION", valueError);
      const sliceError = positiveIntInRange(raw["maxSlices"], 2, VIZ_LIMITS.maxSlices, "pie.maxSlices");
      if (sliceError) return fail("LIMIT_EXCEEDED", sliceError);
      return raw as unknown as VisualizationRequest;
    }
    case "line": {
      if (!columnName(raw["x"])) return fail("INVALID_VISUALIZATION", "line.x must be {column}");
      const hasSeries = raw["series"] !== undefined;
      const hasY = raw["y"] !== undefined;
      if (hasSeries === hasY) return fail("INVALID_VISUALIZATION", "line needs exactly one of `y` (single series) or `series` (multi-series)");
      if (hasSeries) {
        const seriesError = validateSeries(raw["series"], "line.series");
        if (seriesError) return fail("INVALID_VISUALIZATION", seriesError);
      } else {
        const y = raw["y"];
        const asAggregate = isRecord(y) && y["aggregate"] !== undefined
          ? validateAggregatedValue(y, "line.y", AGG_METRICS)
          : validateValueRef(y, "line.y");
        if (asAggregate) return fail("INVALID_VISUALIZATION", asAggregate);
      }
      return raw as unknown as VisualizationRequest;
    }
    case "scatter": {
      const xError = validateValueRef(raw["x"], "scatter.x");
      if (xError) return fail("INVALID_VISUALIZATION", xError);
      const yError = validateValueRef(raw["y"], "scatter.y");
      if (yError) return fail("INVALID_VISUALIZATION", yError);
      if (raw["groupBy"] !== undefined && !columnName(raw["groupBy"])) {
        return fail("INVALID_VISUALIZATION", "scatter.groupBy must be {column}");
      }
      const pointError = positiveIntInRange(raw["maxPoints"], 10, VIZ_LIMITS.maxScatterPoints, "scatter.maxPoints");
      if (pointError) return fail("LIMIT_EXCEEDED", pointError);
      return raw as unknown as VisualizationRequest;
    }
    case "histogram": {
      const valueError = validateValueRef(raw["value"], "histogram.value");
      if (valueError) return fail("INVALID_VISUALIZATION", valueError);
      const binError = positiveIntInRange(raw["bins"], VIZ_LIMITS.minBins, VIZ_LIMITS.maxBins, "histogram.bins");
      if (binError) return fail("LIMIT_EXCEEDED", binError);
      return raw as unknown as VisualizationRequest;
    }
  }
}

export function valueRefColumns(ref: ValueRef | AggregatedValue): readonly string[] {
  if ("column" in ref && typeof ref.column === "string") return [ref.column];
  return [];
}

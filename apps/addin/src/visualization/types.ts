// ---------------------------------------------------------------------------
// Visualization protocol. The LLM may request a chart by TYPE and by which
// columns / aggregation to use. It may NOT provide the numeric data points —
// those are always produced by the deterministic analysis engine (see prepare.ts).
//
// Stage 21.2.4 extends this with MULTI-SERIES bar / line and scatter groupBy.
// The model still only chooses structure (type, dimension, metric, aggregate,
// groupBy, mode); every rendered number comes from the engine.
//
// Like the analysis protocol this is plain data: no code, no SVG, no HTML, no
// expression strings beyond the safe Expression AST already used by the engine.
// ---------------------------------------------------------------------------

import type { AggregateMetric, ConditionGroup, Expression } from "../analysis/types.js";

export type ChartType = "bar" | "line" | "scatter" | "pie" | "histogram";

/** A value channel: either a raw column or a safe expression over columns. */
export type ValueRef = { readonly column: string } | { readonly expression: Expression };

/** How a category's value is computed for bar / pie / line-with-aggregate. */
export interface AggregatedValue {
  readonly aggregate: AggregateMetric; // "count" needs no column
  readonly column?: string;
  readonly expression?: Expression;
}

/** One deterministic series of a multi-series bar / line chart. */
export interface SeriesSpec {
  /** Stable identity used for the dataset, its legend entry and provenance. */
  readonly id?: string;
  readonly label?: string;
  readonly value: AggregatedValue;
}

export interface BarChartRequest {
  readonly type: "bar";
  readonly category: { readonly column: string };
  /** single-series form (kept for back-compat). */
  readonly value?: AggregatedValue;
  /** multi-series form — two or more deterministic datasets over the same categories. */
  readonly series?: readonly SeriesSpec[];
  /** how multiple series are laid out; ignored for a single series. */
  readonly mode?: "grouped" | "stacked";
  readonly where?: ConditionGroup;
  readonly title: string;
  readonly orientation?: "vertical" | "horizontal";
}

export interface LineChartRequest {
  readonly type: "line";
  readonly x: { readonly column: string };
  /** single-series form. */
  readonly y?: ValueRef | AggregatedValue;
  /** multi-series form — each series is an aggregate bucketed on the same x-domain. */
  readonly series?: readonly SeriesSpec[];
  readonly where?: ConditionGroup;
  readonly title: string;
}

export interface ScatterChartRequest {
  readonly type: "scatter";
  readonly x: ValueRef;
  readonly y: ValueRef;
  /** split the points into one deterministic dataset per distinct value of this column. */
  readonly groupBy?: { readonly column: string };
  readonly where?: ConditionGroup;
  readonly title: string;
  readonly maxPoints?: number;
}

export interface PieChartRequest {
  readonly type: "pie";
  readonly category: { readonly column: string };
  readonly value: AggregatedValue; // count or sum only (enforced in validate)
  readonly where?: ConditionGroup;
  readonly title: string;
  readonly maxSlices?: number;
}

export interface HistogramRequest {
  readonly type: "histogram";
  readonly value: ValueRef;
  readonly bins?: number;
  readonly where?: ConditionGroup;
  readonly title: string;
}

export type VisualizationRequest =
  | BarChartRequest
  | LineChartRequest
  | ScatterChartRequest
  | PieChartRequest
  | HistogramRequest;

export const VIZ_LIMITS = {
  maxScatterPoints: 2_000,
  maxCategories: 30,
  maxSlices: 12,
  minBins: 2,
  maxBins: 40,
  defaultBins: 12,
  maxTitleLength: 120,
  /** ceiling on datasets in a multi-series bar/line or a grouped scatter. */
  maxDatasets: 8,
  /** longest category / group label kept before it is truncated with an ellipsis. */
  maxLabelLength: 80,
} as const;

export interface VisualizationError {
  readonly error: string;
  readonly code:
    | "UNKNOWN_CHART_TYPE"
    | "INVALID_VISUALIZATION"
    | "UNKNOWN_COLUMN"
    | "NON_NUMERIC"
    | "LIMIT_EXCEEDED"
    | "MODEL_DATA_FORBIDDEN"
    | "NO_DATA";
  readonly detail?: string;
}

export function isVisualizationError(value: unknown): value is VisualizationError {
  return typeof value === "object" && value !== null && "error" in value && "code" in value;
}

// --- prepared (deterministic) chart data ----------------------------------

export interface CategorySeries {
  readonly kind: "category";
  readonly labels: readonly string[];
  readonly values: readonly number[];
  readonly valueLabel: string;
}

export interface XYSeries {
  readonly kind: "xy";
  readonly points: readonly (readonly [number | string, number])[];
  readonly xLabel: string;
  readonly yLabel: string;
  /** ISO strings when the x channel is an Excel date column. */
  readonly xIsDate: boolean;
}

export interface HistogramSeries {
  readonly kind: "histogram";
  readonly binEdges: readonly number[]; // length = bins + 1
  readonly counts: readonly number[]; // length = bins
  readonly valueLabel: string;
}

/** One rendered dataset of a multi-series category (bar / line) chart. */
export interface CategoryDataset {
  readonly id: string;
  readonly label: string;
  readonly values: readonly (number | null)[]; // aligned to `labels`; null = no data for that category
  readonly pointCount: number;
  readonly sourceColumns: readonly string[];
  readonly aggregate: AggregateMetric;
}

export interface MultiCategorySeries {
  readonly kind: "multi-category";
  readonly labels: readonly string[];
  readonly datasets: readonly CategoryDataset[];
  readonly mode: "grouped" | "stacked";
  readonly xIsDate: boolean;
}

/** One rendered dataset of a grouped scatter chart. */
export interface XYDataset {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly points: readonly (readonly [number, number])[];
  readonly pointCount: number;
}

export interface MultiXYSeries {
  readonly kind: "multi-xy";
  readonly datasets: readonly XYDataset[];
  readonly xLabel: string;
  readonly yLabel: string;
  readonly groupByColumn: string;
  readonly totalPointCount: number;
}

export type ChartSeries =
  | CategorySeries
  | XYSeries
  | HistogramSeries
  | MultiCategorySeries
  | MultiXYSeries;

// --- deterministic description of what was actually rendered --------------

export interface VizSeriesDescriptor {
  readonly id: string;
  readonly label: string;
  readonly group?: string;
  readonly pointCount: number;
  readonly sourceColumns: readonly string[];
  readonly aggregate?: AggregateMetric;
}

/**
 * Everything a claim about the chart's STRUCTURE may be checked against. Built
 * deterministically from the prepared data — never from the model.
 */
export interface VisualizationResult {
  readonly type: ChartType;
  readonly title: string;
  readonly sourceRange: string;
  readonly x?: string;
  readonly y?: string;
  readonly valueLabel?: string;
  readonly groupBy?: string;
  readonly mode: "single" | "grouped" | "stacked";
  readonly datasets: readonly VizSeriesDescriptor[];
  readonly categoryLabels?: readonly string[];
  readonly totalPointCount: number;
  /** Reference / identity / trend lines actually drawn. Always empty in Stage 21.2.4. */
  readonly referenceLines: readonly string[];
  /** Text annotations actually drawn. Always empty in Stage 21.2.4. */
  readonly annotations: readonly string[];
  readonly aggregation?: string;
}

export interface ChartData {
  readonly type: ChartType;
  readonly title: string;
  readonly series: ChartSeries;
  /** e.g. `Sales Test Data!A1:L121 · 120 data rows`. Owned by the app, never the model. */
  readonly provenance: string;
  readonly rowsAnalyzed: number;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  /** Deterministic structural description — the ONLY basis for prose about the chart. */
  readonly result?: VisualizationResult;
}

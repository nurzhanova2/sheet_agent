import type { SelectionSnapshot } from "../app/workbook-context.js";
import { splitSheetAddress } from "../app/a1.js";
import { buildDataset, type Dataset } from "../analysis/dataset.js";
import { runAnalysis } from "../analysis/engine.js";
import {
  evaluateExpression,
  expressionColumns,
  matchingRowIndexes,
  resolveColumn,
} from "../analysis/expression.js";
import { isAnalysisError, type AggregateMetric, type Expression } from "../analysis/types.js";
import type { ResponseLanguage } from "../app/language.js";
import { pluralNoun } from "../app/i18n.js";
import { validateVisualizationRequest } from "./validate.js";
import {
  VIZ_LIMITS,
  isVisualizationError,
  type AggregatedValue,
  type BarChartRequest,
  type CategoryDataset,
  type ChartData,
  type LineChartRequest,
  type ScatterChartRequest,
  type SeriesSpec,
  type ValueRef,
  type VisualizationError,
  type VisualizationRequest,
  type VisualizationResult,
  type VizSeriesDescriptor,
  type XYDataset,
} from "./types.js";

function otherLabel(language: ResponseLanguage): string {
  return language === "ru" ? "Другое" : "Other";
}

/** Localised chart-preparation warnings (user-visible on the chart card). */
type WarnKey =
  | "truncated"
  | "combinedCategories"
  | "categoriesCapped"
  | "groupsCapped"
  | "missingSeries"
  | "missingXY"
  | "missingNonNumeric"
  | "missingBin"
  | "pointsCapped";

function vw(language: ResponseLanguage, key: WarnKey, p: Record<string, number | string> = {}): string {
  const ru = language === "ru";
  switch (key) {
    case "truncated":
      return ru
        ? "Выделение было усечено до анализа; график охватывает только прочитанные строки."
        : "The selection was truncated before analysis; the chart covers only the rows that were read.";
    case "combinedCategories":
      return ru
        ? `${p["n"]} меньших категорий объединены в «${p["other"]}».`
        : `${p["n"]} smaller categories were combined into "${p["other"]}".`;
    case "categoriesCapped":
      return ru
        ? `Показаны только первые ${p["cap"]} из ${p["total"]} категорий.`
        : `Only the first ${p["cap"]} of ${p["total"]} categories are shown.`;
    case "groupsCapped":
      return ru
        ? `Показаны только первые ${p["cap"]} из ${p["total"]} групп.`
        : `Only the first ${p["cap"]} of ${p["total"]} groups are shown.`;
    case "missingSeries":
      return ru
        ? `${p["n"]} строк(и) с пропущенным значением серии исключены.`
        : `${p["n"]} row(s) had a missing series value and were excluded.`;
    case "missingXY":
      return ru
        ? `${p["n"]} строк(и) с пропущенным значением x или y исключены.`
        : `${p["n"]} row(s) had a missing x or y value and were excluded.`;
    case "missingNonNumeric":
      return ru
        ? `${p["n"]} строк(и) исключены из-за пропущенных или нечисловых значений.`
        : `${p["n"]} row(s) were excluded for missing/non-numeric values.`;
    case "missingBin":
      return ru
        ? `${p["n"]} строк(и) с пропущенным или нечисловым значением исключены.`
        : `${p["n"]} row(s) had a missing or non-numeric value and were excluded.`;
    case "pointsCapped":
      return ru
        ? `${p["total"]} точек превысили лимит в ${p["cap"]}; показана каждая ${p["stride"]}-я точка (${p["shown"]}).`
        : `${p["total"]} points exceeded the ${p["cap"]}-point limit; every ${p["stride"]}ᵗʰ point is shown (${p["shown"]} points).`;
  }
}

function vizError(code: VisualizationError["code"], error: string, detail?: string): VisualizationError {
  return detail === undefined ? { code, error } : { code, error, detail };
}

function refExpression(ref: ValueRef | AggregatedValue): Expression {
  if ("expression" in ref && ref.expression) return ref.expression;
  if ("column" in ref && ref.column) return { kind: "column", name: ref.column };
  throw new Error("value reference has neither column nor expression");
}

function provenanceOf(snapshot: SelectionSnapshot, rows: number, language: ResponseLanguage): string {
  const local = splitSheetAddress(snapshot.address).localAddress || snapshot.address;
  const rowWord =
    language === "ru"
      ? pluralNoun("ru", rows, "dataRow")
      : rows === 1
        ? "data row"
        : "data rows";
  return `${snapshot.sheetName}!${local} · ${rows} ${rowWord}`;
}

function sourceColumnsOf(value: AggregatedValue | ValueRef): readonly string[] {
  if ("column" in value && value.column) return [value.column];
  if ("expression" in value && value.expression) return expressionColumns(value.expression);
  return [];
}

function truncateLabel(value: string): string {
  return value.length > VIZ_LIMITS.maxLabelLength ? `${value.slice(0, VIZ_LIMITS.maxLabelLength - 1)}…` : value;
}

/**
 * Turns an untrusted VisualizationRequest into fully-computed, deterministic
 * ChartData. All numbers come from the analysis engine or from direct, pure
 * traversal of the typed dataset — never from the model. Returns a structured
 * error (never throws) on bad requests or non-numeric channels.
 */
export function prepareChartData(
  snapshot: SelectionSnapshot,
  rawRequest: unknown,
  language: ResponseLanguage = "en",
): ChartData | VisualizationError {
  const validated = validateVisualizationRequest(rawRequest);
  if (isVisualizationError(validated)) return validated;

  const dataset = buildDataset(snapshot);
  if ("error" in dataset) {
    return vizError("NO_DATA", dataset.error, dataset.code);
  }

  try {
    return build(dataset, snapshot, validated, language);
  } catch (error) {
    return vizError("INVALID_VISUALIZATION", error instanceof Error ? error.message : "could not prepare chart");
  }
}

interface Common {
  readonly title: string;
  readonly provenance: string;
  readonly rowsAnalyzed: number;
}

function build(
  dataset: Dataset,
  snapshot: SelectionSnapshot,
  request: VisualizationRequest,
  language: ResponseLanguage,
): ChartData | VisualizationError {
  const warnings: string[] = [];
  if (dataset.truncated) warnings.push(vw(language, "truncated"));
  const provenance = provenanceOf(snapshot, dataset.rowCount, language);
  const common: Common = { title: request.title.trim(), provenance, rowsAnalyzed: dataset.rowCount };

  switch (request.type) {
    case "bar":
      return request.series ? buildMultiBar(dataset, request, common, warnings, language) : buildSingleCategory(dataset, request, common, warnings, language);
    case "pie":
      return buildSingleCategory(dataset, request, common, warnings, language);
    case "line":
      return request.series ? buildMultiLine(dataset, request, common, warnings, language) : buildSingleLine(dataset, request, common, warnings, language);
    case "scatter":
      return request.groupBy ? buildGroupedScatter(dataset, request, common, warnings, language) : buildSingleScatter(dataset, request, common, warnings, language);
    case "histogram":
      return buildHistogram(dataset, request, common, warnings, language);
  }
}

// --- single-series category (bar / pie) ----------------------------------------

function buildSingleCategory(
  dataset: Dataset,
  request: Extract<VisualizationRequest, { type: "bar" | "pie" }>,
  common: Common,
  warnings: string[],
  language: ResponseLanguage,
): ChartData | VisualizationError {
  const value = request.value as AggregatedValue;
  const metric = value.aggregate;
  const target = metric === "count" ? undefined : refExpression(value);
  const result = runAnalysis(dataset, {
    op: "group_by",
    by: [request.category.column],
    metrics: [{ metric, name: "value", ...(target ? { target } : {}) }],
    ...(request.where ? { where: request.where } : {}),
    sort: { by: "value", direction: "desc" },
  });
  if (isAnalysisError(result)) return vizError("UNKNOWN_COLUMN", result.error, result.code);
  const groups = result.groups ?? [];
  const cap = request.type === "pie"
    ? Math.min((request as { maxSlices?: number }).maxSlices ?? VIZ_LIMITS.maxSlices, VIZ_LIMITS.maxSlices)
    : VIZ_LIMITS.maxCategories;
  let labels = groups.map((g) => Object.values(g.key)[0] ?? "");
  let values = groups.map((g) => Number(g.metrics["value"] ?? 0));
  if (groups.length > cap) {
    const head = groups.slice(0, cap - 1);
    const tail = groups.slice(cap - 1);
    const rest = tail.reduce((sum, g) => sum + Number(g.metrics["value"] ?? 0), 0);
    labels = [...head.map((g) => Object.values(g.key)[0] ?? ""), otherLabel(language)];
    values = [...head.map((g) => Number(g.metrics["value"] ?? 0)), rest];
    warnings.push(vw(language, "combinedCategories", { n: tail.length, other: otherLabel(language) }));
  }
  const stringLabels = labels.map(String).map(truncateLabel);
  const valueLabel = metric === "count" ? "count" : `${metric}(${target ? describeExpression(target) : ""})`;
  const truncated = dataset.truncated || groups.length > cap;
  const vizResult: VisualizationResult = {
    type: request.type,
    title: common.title,
    sourceRange: common.provenance,
    x: request.category.column,
    valueLabel,
    mode: "single",
    datasets: [{ id: "s1", label: valueLabel, pointCount: stringLabels.length, sourceColumns: sourceColumnsOf(value), aggregate: metric }],
    categoryLabels: stringLabels,
    totalPointCount: stringLabels.length,
    referenceLines: [],
    annotations: [],
    aggregation: metric,
  };
  return {
    type: request.type,
    ...common,
    series: { kind: "category", labels: stringLabels, values, valueLabel },
    truncated,
    warnings,
    result: vizResult,
  };
}

// --- multi-series bar --------------------------------------------------------

function seriesId(spec: SeriesSpec, index: number, used: Set<string>): string {
  let id = spec.id && spec.id.length > 0 ? spec.id : (spec.value.column ? spec.value.column.replace(/\s+/g, "") : `series${index + 1}`);
  let n = 2;
  const base = id;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

function seriesLabel(spec: SeriesSpec): string {
  if (spec.label && spec.label.length > 0) return truncateLabel(spec.label);
  const { aggregate, column } = spec.value;
  if (aggregate === "count") return "count";
  const target = column ?? (spec.value.expression ? describeExpression(spec.value.expression) : "value");
  return `${aggregate}(${target})`;
}

function buildMultiBar(
  dataset: Dataset,
  request: BarChartRequest,
  common: Common,
  warnings: string[],
  language: ResponseLanguage,
): ChartData | VisualizationError {
  const specs = request.series ?? [];
  const usedIds = new Set<string>();
  const resolved = specs.map((spec, index) => ({ spec, id: seriesId(spec, index, usedIds), label: seriesLabel(spec) }));

  // ONE deterministic group_by — every series is a metric on the same buckets, so
  // the category axis is shared and computed exactly once (Stage 21.2.4 §16).
  const result = runAnalysis(dataset, {
    op: "group_by",
    by: [request.category.column],
    metrics: resolved.map(({ spec, id }) => {
      const metric = spec.value.aggregate;
      return metric === "count" ? { metric, name: id } : { metric, name: id, target: refExpression(spec.value) };
    }),
    ...(request.where ? { where: request.where } : {}),
  });
  if (isAnalysisError(result)) return vizError("UNKNOWN_COLUMN", result.error, result.code);
  const groups = result.groups ?? [];
  if (groups.length === 0) return vizError("NO_DATA", "No categories to plot after filtering.");

  let labels = groups.map((g) => String(Object.values(g.key)[0] ?? ""));
  let sliceTo = labels.length;
  if (labels.length > VIZ_LIMITS.maxCategories) {
    sliceTo = VIZ_LIMITS.maxCategories;
    warnings.push(vw(language, "categoriesCapped", { cap: VIZ_LIMITS.maxCategories, total: labels.length }));
  }
  labels = labels.slice(0, sliceTo).map(truncateLabel);
  void language;

  const datasets: CategoryDataset[] = resolved.map(({ spec, id, label }) => {
    const values = groups.slice(0, sliceTo).map((g) => {
      const raw = g.metrics[id];
      return raw === null || raw === undefined || !Number.isFinite(raw) ? null : Number(raw);
    });
    return {
      id,
      label,
      values,
      pointCount: values.filter((v): v is number => v !== null).length,
      sourceColumns: sourceColumnsOf(spec.value),
      aggregate: spec.value.aggregate,
    };
  });

  const mode = request.mode ?? "grouped";
  const descriptors: VizSeriesDescriptor[] = datasets.map((d) => ({
    id: d.id,
    label: d.label,
    pointCount: d.pointCount,
    sourceColumns: d.sourceColumns,
    aggregate: d.aggregate,
  }));
  const vizResult: VisualizationResult = {
    type: "bar",
    title: common.title,
    sourceRange: common.provenance,
    x: request.category.column,
    valueLabel: datasets.map((d) => d.label).join(" · "),
    mode,
    datasets: descriptors,
    categoryLabels: labels,
    totalPointCount: labels.length,
    referenceLines: [],
    annotations: [],
    aggregation: [...new Set(datasets.map((d) => d.aggregate))].join(", "),
  };
  return {
    type: "bar",
    ...common,
    series: { kind: "multi-category", labels, datasets, mode, xIsDate: false },
    truncated: dataset.truncated || sliceTo < groups.length,
    warnings,
    result: vizResult,
  };
}

// --- single-series line ----------------------------------------------------

function buildSingleLine(
  dataset: Dataset,
  request: LineChartRequest,
  common: Common,
  warnings: string[],
  language: ResponseLanguage,
): ChartData | VisualizationError {
  const xColumn = resolveColumn(dataset, request.x.column);
  const indexes = matchingRowIndexes(dataset, request.where);
  const y = request.y as ValueRef | AggregatedValue;
  const isAggregate = typeof y === "object" && y !== null && "aggregate" in y;
  const yExpr = isAggregate && (y as AggregatedValue).aggregate === "count" ? null : refExpression(y);
  const rows: { x: number | string; xSort: number; y: number }[] = [];
  let missing = 0;
  if (isAggregate) {
    const agg = y as AggregatedValue;
    const buckets = new Map<string, { xSort: number; xLabel: number | string; values: number[] }>();
    for (const index of indexes) {
      const key = xColumn.text[index] ?? "";
      const sortKey = xColumn.numeric[index] ?? Number.NaN;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { xSort: Number.isNaN(sortKey) ? buckets.size : sortKey, xLabel: xColumn.type === "date" ? key : (xColumn.numeric[index] ?? key), values: [] };
        buckets.set(key, bucket);
      }
      const v = yExpr ? evaluateExpression(dataset, yExpr, index) : 1;
      if (v === null) missing += 1;
      else bucket.values.push(v);
    }
    for (const bucket of buckets.values()) {
      rows.push({ x: bucket.xLabel, xSort: bucket.xSort, y: aggregateValues(agg.aggregate, bucket.values) });
    }
  } else {
    for (const index of indexes) {
      const yValue = evaluateExpression(dataset, yExpr as Expression, index);
      const xSort = xColumn.numeric[index] ?? Number.NaN;
      if (yValue === null || Number.isNaN(xSort)) {
        missing += 1;
        continue;
      }
      rows.push({ x: xColumn.type === "date" ? (xColumn.text[index] ?? "") : xSort, xSort, y: yValue });
    }
  }
  rows.sort((a, b) => a.xSort - b.xSort);
  if (missing > 0) warnings.push(vw(language, "missingXY", { n: missing }));
  if (rows.length === 0) return vizError("NO_DATA", "No plottable points after filtering.");
  const yLabel = isAggregate ? `${(y as AggregatedValue).aggregate}` : describeRef(y);
  const vizResult: VisualizationResult = {
    type: "line",
    title: common.title,
    sourceRange: common.provenance,
    x: xColumn.name,
    y: yLabel,
    mode: "single",
    datasets: [{ id: "s1", label: yLabel, pointCount: rows.length, sourceColumns: isAggregate ? sourceColumnsOf(y) : sourceColumnsOf(y as ValueRef), ...(isAggregate ? { aggregate: (y as AggregatedValue).aggregate } : {}) }],
    totalPointCount: rows.length,
    referenceLines: [],
    annotations: [],
  };
  return {
    type: "line",
    ...common,
    series: { kind: "xy", points: rows.map((r) => [r.x, r.y] as const), xLabel: xColumn.name, yLabel, xIsDate: xColumn.type === "date" },
    truncated: dataset.truncated,
    warnings,
    result: vizResult,
  };
}

// --- multi-series line ----------------------------------------------------

function buildMultiLine(
  dataset: Dataset,
  request: LineChartRequest,
  common: Common,
  warnings: string[],
  language: ResponseLanguage,
): ChartData | VisualizationError {
  const xColumn = resolveColumn(dataset, request.x.column);
  const indexes = matchingRowIndexes(dataset, request.where);
  const specs = request.series ?? [];
  const usedIds = new Set<string>();
  const resolved = specs.map((spec, index) => ({ spec, id: seriesId(spec, index, usedIds), label: seriesLabel(spec) }));

  // shared x-domain: every distinct x value across the matched rows, ascending.
  const domain = new Map<string, { xSort: number; xLabel: number | string }>();
  for (const index of indexes) {
    const key = xColumn.text[index] ?? "";
    if (domain.has(key)) continue;
    const sortKey = xColumn.numeric[index] ?? Number.NaN;
    domain.set(key, {
      xSort: Number.isNaN(sortKey) ? domain.size : sortKey,
      xLabel: xColumn.type === "date" ? key : (xColumn.numeric[index] ?? key),
    });
  }
  const domainKeys = [...domain.entries()].sort((a, b) => a[1].xSort - b[1].xSort);
  if (domainKeys.length === 0) return vizError("NO_DATA", "No x values to plot after filtering.");
  const labels = domainKeys.map(([, v]) => v.xLabel);

  // bucket each series' rows by x key, then aggregate. A series with NO rows for
  // an x value gets an explicit null (rendered as a gap) — it is never inferred.
  let missing = 0;
  const datasets: CategoryDataset[] = resolved.map(({ spec, id, label }) => {
    const agg = spec.value.aggregate;
    const yExpr = agg === "count" ? null : refExpression(spec.value);
    const perKey = new Map<string, number[]>();
    for (const index of indexes) {
      const key = xColumn.text[index] ?? "";
      const v = yExpr ? evaluateExpression(dataset, yExpr, index) : 1;
      if (v === null) {
        missing += 1;
        continue;
      }
      let bucket = perKey.get(key);
      if (!bucket) {
        bucket = [];
        perKey.set(key, bucket);
      }
      bucket.push(v);
    }
    const values = domainKeys.map(([key]) => {
      const bucket = perKey.get(key);
      return bucket && bucket.length > 0 ? aggregateValues(agg, bucket) : null;
    });
    return {
      id,
      label,
      values,
      pointCount: values.filter((v): v is number => v !== null).length,
      sourceColumns: sourceColumnsOf(spec.value),
      aggregate: agg,
    };
  });
  if (missing > 0) warnings.push(vw(language, "missingSeries", { n: missing }));

  const descriptors: VizSeriesDescriptor[] = datasets.map((d) => ({
    id: d.id, label: d.label, pointCount: d.pointCount, sourceColumns: d.sourceColumns, aggregate: d.aggregate,
  }));
  const vizResult: VisualizationResult = {
    type: "line",
    title: common.title,
    sourceRange: common.provenance,
    x: xColumn.name,
    y: datasets.map((d) => d.label).join(" · "),
    mode: "grouped",
    datasets: descriptors,
    totalPointCount: datasets.reduce((sum, d) => sum + d.pointCount, 0),
    referenceLines: [],
    annotations: [],
    aggregation: [...new Set(datasets.map((d) => d.aggregate))].join(", "),
  };
  return {
    type: "line",
    ...common,
    series: {
      kind: "multi-category",
      labels: labels.map((label) => (typeof label === "string" ? truncateLabel(label) : label)) as readonly string[],
      datasets,
      mode: "grouped",
      xIsDate: xColumn.type === "date",
    },
    truncated: dataset.truncated,
    warnings,
    result: vizResult,
  };
}

// --- single-series scatter ------------------------------------------------

function buildSingleScatter(
  dataset: Dataset,
  request: ScatterChartRequest,
  common: Common,
  warnings: string[],
  language: ResponseLanguage,
): ChartData | VisualizationError {
  const xExpr = refExpression(request.x);
  const yExpr = refExpression(request.y);
  const indexes = matchingRowIndexes(dataset, request.where);
  const pairs: [number, number][] = [];
  let missing = 0;
  for (const index of indexes) {
    const x = evaluateExpression(dataset, xExpr, index);
    const y = evaluateExpression(dataset, yExpr, index);
    if (x === null || y === null) missing += 1;
    else pairs.push([x, y]);
  }
  if (missing > 0) warnings.push(vw(language, "missingNonNumeric", { n: missing }));
  if (pairs.length === 0) return vizError("NON_NUMERIC", "No numeric (x, y) pairs to plot.");
  const cap = Math.min((request as { maxPoints?: number }).maxPoints ?? VIZ_LIMITS.maxScatterPoints, VIZ_LIMITS.maxScatterPoints);
  let plotted = pairs;
  let sampled = false;
  if (pairs.length > cap) {
    const stride = Math.ceil(pairs.length / cap);
    plotted = pairs.filter((_, i) => i % stride === 0).slice(0, cap);
    sampled = true;
    warnings.push(vw(language, "pointsCapped", { total: pairs.length, cap, stride, shown: plotted.length }));
  }
  const xLabel = describeRef(request.x);
  const yLabel = describeRef(request.y);
  const vizResult: VisualizationResult = {
    type: "scatter",
    title: common.title,
    sourceRange: common.provenance,
    x: xLabel,
    y: yLabel,
    mode: "single",
    datasets: [{ id: "s1", label: `${xLabel} × ${yLabel}`, pointCount: plotted.length, sourceColumns: [...sourceColumnsOf(request.x), ...sourceColumnsOf(request.y)] }],
    totalPointCount: plotted.length,
    referenceLines: [],
    annotations: [],
  };
  return {
    type: "scatter",
    ...common,
    series: { kind: "xy", points: plotted, xLabel, yLabel, xIsDate: false },
    truncated: dataset.truncated || sampled,
    warnings,
    result: vizResult,
  };
}

// --- grouped scatter -----------------------------------------------------

function buildGroupedScatter(
  dataset: Dataset,
  request: ScatterChartRequest,
  common: Common,
  warnings: string[],
  language: ResponseLanguage,
): ChartData | VisualizationError {
  const xExpr = refExpression(request.x);
  const yExpr = refExpression(request.y);
  const groupColumn = resolveColumn(dataset, request.groupBy!.column);
  const indexes = matchingRowIndexes(dataset, request.where);

  const buckets = new Map<string, [number, number][]>();
  const order: string[] = [];
  let missing = 0;
  for (const index of indexes) {
    const x = evaluateExpression(dataset, xExpr, index);
    const y = evaluateExpression(dataset, yExpr, index);
    if (x === null || y === null) {
      missing += 1;
      continue;
    }
    const key = groupColumn.text[index] ?? "";
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push([x, y]);
  }
  if (missing > 0) warnings.push(vw(language, "missingNonNumeric", { n: missing }));
  const total = order.reduce((sum, key) => sum + (buckets.get(key)?.length ?? 0), 0);
  if (total === 0) return vizError("NON_NUMERIC", "No numeric (x, y) pairs to plot.");

  order.sort((a, b) => a.localeCompare(b));
  if (order.length > VIZ_LIMITS.maxDatasets) {
    warnings.push(vw(language, "groupsCapped", { cap: VIZ_LIMITS.maxDatasets, total: order.length }));
    order.splice(VIZ_LIMITS.maxDatasets);
  }

  // global stride so the total stays under the point cap while every group keeps
  // its share; sampling is deterministic (every Nth point in row order).
  const kept = order.reduce((sum, key) => sum + (buckets.get(key)?.length ?? 0), 0);
  const cap = Math.min((request as { maxPoints?: number }).maxPoints ?? VIZ_LIMITS.maxScatterPoints, VIZ_LIMITS.maxScatterPoints);
  const stride = kept > cap ? Math.ceil(kept / cap) : 1;

  const datasets: XYDataset[] = order.map((key, datasetIndex) => {
    const all = buckets.get(key) ?? [];
    const points = stride > 1 ? all.filter((_, i) => i % stride === 0) : all;
    return {
      id: `g${datasetIndex + 1}`,
      label: truncateLabel(key || "(blank)"),
      group: key,
      points,
      pointCount: points.length,
    };
  });
  const totalPointCount = datasets.reduce((sum, d) => sum + d.pointCount, 0);
  if (stride > 1) warnings.push(vw(language, "pointsCapped", { total: kept, cap, stride, shown: totalPointCount }));
  const xLabel = describeRef(request.x);
  const yLabel = describeRef(request.y);
  const vizResult: VisualizationResult = {
    type: "scatter",
    title: common.title,
    sourceRange: common.provenance,
    x: xLabel,
    y: yLabel,
    groupBy: groupColumn.name,
    mode: "grouped",
    datasets: datasets.map((d) => ({ id: d.id, label: d.label, group: d.group, pointCount: d.pointCount, sourceColumns: [...sourceColumnsOf(request.x), ...sourceColumnsOf(request.y)] })),
    totalPointCount,
    referenceLines: [],
    annotations: [],
  };
  return {
    type: "scatter",
    ...common,
    series: { kind: "multi-xy", datasets, xLabel, yLabel, groupByColumn: groupColumn.name, totalPointCount },
    truncated: dataset.truncated || stride > 1 || order.length > VIZ_LIMITS.maxDatasets,
    warnings,
    result: vizResult,
  };
}

// --- histogram ---------------------------------------------------------------

function buildHistogram(
  dataset: Dataset,
  request: Extract<VisualizationRequest, { type: "histogram" }>,
  common: Common,
  warnings: string[],
  language: ResponseLanguage,
): ChartData | VisualizationError {
  const expr = refExpression(request.value);
  const indexes = matchingRowIndexes(dataset, request.where);
  const values: number[] = [];
  let missing = 0;
  for (const index of indexes) {
    const v = evaluateExpression(dataset, expr, index);
    if (v === null || !Number.isFinite(v)) missing += 1;
    else values.push(v);
  }
  if (missing > 0) warnings.push(vw(language, "missingBin", { n: missing }));
  if (values.length === 0) return vizError("NON_NUMERIC", "No numeric values to bin.");
  const bins = Math.max(VIZ_LIMITS.minBins, Math.min(request.bins ?? VIZ_LIMITS.defaultBins, VIZ_LIMITS.maxBins));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = max === min ? 1 : (max - min) / bins;
  const binEdges = Array.from({ length: bins + 1 }, (_, i) => min + i * width);
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const slot = v >= max ? bins - 1 : Math.floor((v - min) / width);
    const idx = Math.max(0, Math.min(bins - 1, slot));
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const valueLabel = describeRef(request.value);
  const vizResult: VisualizationResult = {
    type: "histogram",
    title: common.title,
    sourceRange: common.provenance,
    x: valueLabel,
    valueLabel,
    mode: "single",
    datasets: [{ id: "s1", label: valueLabel, pointCount: bins, sourceColumns: sourceColumnsOf(request.value) }],
    totalPointCount: bins,
    referenceLines: [],
    annotations: [],
  };
  return {
    type: "histogram",
    ...common,
    series: { kind: "histogram", binEdges, counts, valueLabel },
    truncated: dataset.truncated,
    warnings,
    result: vizResult,
  };
}

function aggregateValues(metric: AggregateMetric, values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  switch (metric) {
    case "count":
      return values.length;
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "mean":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return sorted[0] ?? 0;
    case "max":
      return sorted[sorted.length - 1] ?? 0;
    case "median": {
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid] ?? 0;
    }
  }
}

function describeExpression(expression: Expression): string {
  switch (expression.kind) {
    case "column":
      return expression.name;
    case "literal":
      return String(expression.value);
    case "percent":
      return `${expression.value}%`;
    case "abs":
      return `abs(${describeExpression(expression.value)})`;
    case "neg":
      return `-(${describeExpression(expression.value)})`;
    default: {
      const op = { add: "+", subtract: "-", multiply: "*", divide: "/" }[expression.kind];
      return `(${describeExpression(expression.left)} ${op} ${describeExpression(expression.right)})`;
    }
  }
}

function describeRef(ref: ValueRef | AggregatedValue): string {
  if ("column" in ref && ref.column) return ref.column;
  if ("expression" in ref && ref.expression) return describeExpression(ref.expression);
  if ("aggregate" in ref) return ref.aggregate;
  return "value";
}

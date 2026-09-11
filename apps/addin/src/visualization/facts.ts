// ---------------------------------------------------------------------------
// Verified visualization facts & chart-claim integrity (Stage 21.2.4).
//
// The deterministic engine decides what the chart actually contains. The LLM may
// only describe STRUCTURE — chart type, axes, datasets, grouping, point counts —
// that appears in the VisualizationResult it was handed. It must never invent a
// series, a grouping, a reference / trend / y=x line, an annotation, a colour, a
// symbol, a bin count or a point total.
//
// This module turns a VisualizationResult into a model-facing fact block and
// validates the final prose against it (RU + EN).
// ---------------------------------------------------------------------------

import type { ResponseLanguage } from "../app/language.js";
import type { NumberLocale } from "../analysis/format-number.js";
import { formatNumber } from "../analysis/format-number.js";
import type { ScalarFact } from "../analysis/facts.js";
import type { ChartData, VisualizationResult } from "./types.js";

export type VizFactKind =
  | "chart_type"
  | "title"
  | "axis"
  | "grouping"
  | "dataset_count"
  | "dataset"
  | "point_count"
  | "category_count"
  | "aggregation"
  | "reference_line"
  | "annotation";

export interface VerifiedVisualizationFact {
  readonly id: string;
  readonly kind: VizFactKind;
  readonly label: string;
  readonly formatted: string;
}

const CHART_TYPE_WORD: Record<string, RegExp> = {
  bar: /(bar chart|bar graph|столбчат[\wа-яё]*|столбчат[\wа-яё]* диаграмм[\wа-яё]*|гистограмм[\wа-яё]* столбц[\wа-яё]*|барчарт)/i,
  line: /(line chart|line graph|линейн[\wа-яё]* (?:график|диаграмм[\wа-яё]*)|график лини[\wа-яё]*)/i,
  scatter: /(scatter\s?plot|scatter chart|точечн[\wа-яё]* (?:диаграмм[\wа-яё]*|график)|диаграмм[\wа-яё]* рассеян[\wа-яё]*)/i,
  pie: /(pie chart|круговая диаграмм[\wа-яё]*|секторн[\wа-яё]* диаграмм[\wа-яё]*)/i,
  histogram: /(histogram|гистограмм[\wа-яё]*)/i,
};

// A claim that a visible equality / trend / reference line exists.
const REFERENCE_LINE_CLAIM =
  /(reference line|identity line|trend\s?line|line of best fit|regression line|1\s*[:：]\s*1 line|\by\s*=\s*x\b|\bx\s*=\s*y\b|diagonal line|[A-Za-z]+\s*=\s*[A-Za-z]+\s+(?:line|reference)|line\s+(?:showing|where|at)\s+[A-Za-z]+\s*=\s*[A-Za-z]+|референсн[\wа-яё]* лини[\wа-яё]*|лини[\wа-яё]* тренда|лини[\wа-яё]* регресс[\wа-яё]*|лини[\wа-яё]* равенств[\wа-яё]*|лини[\wа-яё]*\s+y\s*=\s*x|лини[\wа-яё]*\s+[A-Za-zА-Яа-яЁё]+\s*=\s*[A-Za-zА-Яа-яЁё]+|биссектрис[\wа-яё]*|диагональн[\wа-яё]* лини[\wа-яё]*|лини[\wа-яё]* 1\s*[:：]\s*1)/i;

// A claim about a specific colour / marker shape assigned to a series (Stage
// 21.2.4 §12 — style metadata is not materialised, so this is never verifiable).
const STYLE_CLAIM =
  /((?:показан[\wа-яё]*|отмечен[\wа-яё]*|обозначен[\wа-яё]*|изображ[\wа-яё]*|represented|shown|marked|drawn|plotted|rendered|coloured|colored)\s+[^.\n]{0,24}(?:синим|красн[\wа-яё]*|зел[её]н[\wа-яё]*|ж[её]лт[\wа-яё]*|оранжев[\wа-яё]*|фиолетов[\wа-яё]*|кружк[\wа-яё]*|круг[\wа-яё]*|квадрат[\wа-яё]*|треугольник[\wа-яё]*|ромб[\wа-яё]*|blue|red|green|yellow|orange|purple|circles?|squares?|triangles?|diamonds?|dots?))|\b(?:blue|red|green|orange|purple|yellow)\s+(?:circles?|squares?|triangles?|dots?|markers?|points?|bars?)\b/i;

// A claim that the points / bars are split into groups.
const GROUPING_CLAIM =
  /(grouped by|split by|separated by|coloured by|colored by|one (?:series|dataset|colour|color) per|разделен[\wа-яё]* по|сгруппирован[\wа-яё]* по|разбит[\wа-яё]* по|по категори[\wа-яё]*\s+(?:цвет[\wа-яё]*|отдельн[\wа-яё]*)|отдельн[\wа-яё]* (?:набор[\wа-яё]*|серии|цвет[\wа-яё]*)\s+для)/i;

// "N series / datasets / groups"
const SERIES_COUNT_CLAIM =
  /(\d+)\s*(?:different\s+)?(?:series|datasets?|наборов данных|набора данных|наборы данных|серии|серий)/i;

// "N points"
const POINT_COUNT_CLAIM = /(\d[\d\s\u00a0\u202f.,]*\d|\d)\s*(?:points?|точ(?:ек|ки|ка)|наблюден[\wа-яё]*)/i;

function num(token: string): number {
  return Number(token.replace(/[\s\u00a0\u202f.,]/g, ""));
}

/** Deterministic fact list — the ONLY basis for prose describing chart structure. */
export function deriveVisualizationFacts(result: VisualizationResult): readonly VerifiedVisualizationFact[] {
  const facts: VerifiedVisualizationFact[] = [];
  let seq = 0;
  const push = (kind: VizFactKind, label: string, formatted: string) => {
    seq += 1;
    facts.push({ id: `V${seq}`, kind, label, formatted });
  };

  push("chart_type", "Chart type", result.type);
  push("title", "Title", result.title);
  if (result.x) push("axis", "X axis", result.x);
  if (result.y) push("axis", "Y axis", result.y);
  if (result.groupBy) push("grouping", "Grouped by", result.groupBy);
  else push("grouping", "Grouping", "none (single undivided series set)");
  push("dataset_count", "Dataset count", String(result.datasets.length));
  for (const dataset of result.datasets) {
    const scope = dataset.group ? ` (group "${dataset.group}")` : "";
    push("dataset", `Dataset ${dataset.label}${scope}`, `${dataset.pointCount} point(s)`);
  }
  push("point_count", "Total points", String(result.totalPointCount));
  if (result.categoryLabels) push("category_count", "Categories", `${result.categoryLabels.length} — ${result.categoryLabels.join(", ")}`);
  if (result.aggregation) push("aggregation", "Aggregation", result.aggregation);
  push("reference_line", "Reference lines", result.referenceLines.length === 0 ? "none" : result.referenceLines.join(", "));
  push("annotation", "Annotations", result.annotations.length === 0 ? "none" : result.annotations.join(", "));
  return facts;
}

/** The model-facing VERIFIED CHART FACTS block. */
export function renderVisualizationFacts(facts: readonly VerifiedVisualizationFact[]): string {
  if (facts.length === 0) return "";
  return [
    "VERIFIED CHART FACTS — the ONLY permitted source for any statement about the chart's structure (type, axes, datasets, grouping, point counts, reference lines).",
    "Do NOT mention a series, grouping, colour, symbol, reference / trend / y=x line, annotation or point count that is not listed here.",
    ...facts.map((fact) => `[${fact.id}] ${fact.label}: ${fact.formatted}`),
  ].join("\n");
}

/**
 * Strict validation of chart-structure claims in the final prose against the
 * deterministic VisualizationResult. Returns failure reasons; empty = clean.
 */
export function validateChartClaims(
  text: string,
  result: VisualizationResult,
  language: ResponseLanguage,
): readonly string[] {
  const reasons: string[] = [];

  // 1) reference / identity / trend line — none is ever drawn in this stage.
  if (result.referenceLines.length === 0 && REFERENCE_LINE_CLAIM.test(text)) {
    reasons.push(
      language === "ru"
        ? "На графике нет референсной линии (равенства / тренда / y=x). Убери упоминание такой линии — можно говорить только о числовом соотношении, но не о нарисованной линии."
        : "The chart has no reference / identity / trend / y=x line. Remove any mention of such a drawn line; you may only discuss a numeric relationship, not a rendered line.",
    );
  }

  // 1b) specific colour / symbol assigned to a group — never a verified fact.
  if (STYLE_CLAIM.test(text)) {
    reasons.push(
      language === "ru"
        ? "Не описывай конкретные цвета или маркеры серий — эта информация не входит в детерминированный результат. Скажи обобщённо: «категории показаны отдельными наборами данных в легенде»."
        : "Do not state a specific colour or marker shape for a series — it is not in the deterministic result. Say generically that the categories appear as separate datasets in the legend.",
    );
  }

  // 2) grouping claims must match result.groupBy.
  if (GROUPING_CLAIM.test(text)) {
    if (!result.groupBy) {
      reasons.push(
        language === "ru"
          ? "График не разделён на группы (groupBy отсутствует). Не утверждай, что точки/столбцы разделены или сгруппированы по столбцу."
          : "The chart is not split into groups (no groupBy). Do not claim the points/bars are grouped or separated by a column.",
      );
    } else if (!new RegExp(`\\b${escapeRegExp(result.groupBy)}\\b`, "i").test(text)) {
      // grouping claimed but the named column is not the one actually used
      const namedOtherColumn = /(grouped|split|separated|разделен[\wа-яё]*|сгруппирован[\wа-яё]*|разбит[\wа-яё]*)\s+(?:by|по)\s+([A-Za-zА-Яа-яЁё %]+)/i.exec(text);
      if (namedOtherColumn && !new RegExp(escapeRegExp(result.groupBy), "i").test(namedOtherColumn[2] ?? "")) {
        reasons.push(
          language === "ru"
            ? `Точки разделены по столбцу "${result.groupBy}", а не по тому, что назван в ответе.`
            : `The points are grouped by "${result.groupBy}", not by the column named in the answer.`,
        );
      }
    }
  }

  // 3) "N series / datasets" must equal the real dataset count.
  const seriesMatch = SERIES_COUNT_CLAIM.exec(text);
  if (seriesMatch) {
    const claimed = num(seriesMatch[1] ?? "");
    if (Number.isFinite(claimed) && claimed !== result.datasets.length) {
      reasons.push(
        language === "ru"
          ? `На графике ${result.datasets.length} набор(а/ов) данных, а не ${claimed}.`
          : `The chart has ${result.datasets.length} dataset(s), not ${claimed}.`,
      );
    }
  }

  // 4) "N points" must equal the total, or a per-dataset point count.
  const pointMatch = POINT_COUNT_CLAIM.exec(text);
  if (pointMatch) {
    const claimed = num(pointMatch[1] ?? "");
    const allowed = new Set<number>([result.totalPointCount, ...result.datasets.map((dataset) => dataset.pointCount)]);
    if (Number.isFinite(claimed) && claimed >= 3 && !allowed.has(claimed)) {
      reasons.push(
        language === "ru"
          ? `Число точек на графике — ${result.totalPointCount} (всего), не ${claimed}.`
          : `The chart has ${result.totalPointCount} points in total, not ${claimed}.`,
      );
    }
  }

  // 5) chart type must match.
  for (const [chartType, pattern] of Object.entries(CHART_TYPE_WORD)) {
    if (chartType === result.type) continue;
    if (pattern.test(text) && !CHART_TYPE_WORD[result.type]!.test(text)) {
      reasons.push(
        language === "ru"
          ? `Это ${result.type}-график, а в ответе он назван иначе (${chartType}).`
          : `The chart is a ${result.type} chart; the answer calls it a ${chartType} chart.`,
      );
      break;
    }
  }

  return reasons;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Chart-value facts (Stage 21.2.8.1).
//
// The per-category numbers that BUILD a bar / pie / single-series line chart are
// genuine deterministic scalar aggregates (mean of Plan by Category, …). They are
// materialised as VerifiedFacts so the final answer — and the deterministic
// fallback — can present a numeric table without asking for a second analysis
// request, and so the numeric-claim validator accepts them. Scatter / histogram
// carry no per-category aggregate, so none are emitted for those.
// ---------------------------------------------------------------------------

/** Source-operation id carried by every fact from {@link deriveChartValueFacts}. */
export const CHART_VALUE_OP_ID = "chart#1";

/** Stable, language-neutral aggregate word for a chart dataset's metric identity. */
const CHART_AGG_WORD: Record<string, string> = {
  mean: "mean",
  sum: "sum",
  median: "median",
  min: "min",
  max: "max",
  count: "count",
};

function chartMetricName(aggregate: string | undefined, sourceColumns: readonly string[]): string {
  const agg = aggregate ? CHART_AGG_WORD[aggregate] ?? aggregate : "";
  const cols = sourceColumns.join(", ");
  return [agg, cols].filter(Boolean).join(" ") || "value";
}

export function deriveChartValueFacts(
  chart: ChartData,
  sourceRange: string,
  locale: NumberLocale = "en",
): readonly ScalarFact[] {
  const series = chart.series;
  const out: ScalarFact[] = [];
  let seq = 0;
  const push = (metric: string, group: string, value: number): void => {
    if (!Number.isFinite(value)) return;
    seq += 1;
    out.push({
      id: `CV${seq}`,
      kind: "scalar",
      metric,
      value,
      group,
      label: `${metric} — ${group}`,
      formatted: formatNumber(value, 2, locale),
      sourceOperationId: CHART_VALUE_OP_ID,
      sourceRange,
    });
  };

  if (series.kind === "category") {
    const dataset = chart.result?.datasets[0];
    const metric = chartMetricName(dataset?.aggregate, dataset?.sourceColumns ?? []);
    series.labels.forEach((label, i) => push(metric, label, series.values[i] ?? Number.NaN));
  } else if (series.kind === "multi-category") {
    for (const dataset of series.datasets) {
      const metric = chartMetricName(dataset.aggregate, dataset.sourceColumns);
      series.labels.forEach((label, i) => push(metric, label, dataset.values[i] ?? Number.NaN));
    }
  }
  return out;
}

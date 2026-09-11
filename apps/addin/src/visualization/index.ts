import type { SelectionSnapshot } from "../app/workbook-context.js";
import type { ResponseLanguage } from "../app/language.js";
import { prepareChartData } from "./prepare.js";
import {
  deriveVisualizationFacts,
  renderVisualizationFacts,
  type VerifiedVisualizationFact,
} from "./facts.js";
import {
  isVisualizationError,
  type ChartData,
  type VisualizationError,
  type VisualizationResult,
} from "./types.js";

export * from "./types.js";
export { validateVisualizationRequest } from "./validate.js";
export { prepareChartData } from "./prepare.js";
export {
  deriveVisualizationFacts,
  renderVisualizationFacts,
  validateChartClaims,
  deriveChartValueFacts,
  CHART_VALUE_OP_ID,
  type VerifiedVisualizationFact,
  type VizFactKind,
} from "./facts.js";

/** Fence the model uses to request a chart. Parsed only when the turn is a visualization turn. */
export const VISUALIZATION_FENCE = /```sheet-agent-visualization\s*([\s\S]*?)```/;

export interface VisualizationOutcome {
  readonly chart?: ChartData;
  readonly error?: VisualizationError;
  /** Compact block fed back to the model so it can describe the chart it just got. */
  readonly text: string;
  readonly activityTitle: string;
  /** Deterministic structural description of the rendered chart (Stage 21.2.4). */
  readonly result?: VisualizationResult;
  /** Verified chart-structure facts — the only basis for prose about the chart. */
  readonly facts: readonly VerifiedVisualizationFact[];
  /** The VERIFIED CHART FACTS text block (empty when there is no chart). */
  readonly factsText: string;
}

function chartSummary(chart: ChartData): string {
  const series = chart.series;
  const base = { type: chart.type, title: chart.title, provenance: chart.provenance, truncated: chart.truncated, warnings: chart.warnings };

  if (series.kind === "category") {
    return JSON.stringify({
      ...base,
      valueLabel: series.valueLabel,
      datasetCount: 1,
      categories: series.labels.map((label, i) => [label, series.values[i] ?? 0]),
    });
  }
  if (series.kind === "multi-category") {
    return JSON.stringify({
      ...base,
      mode: series.mode,
      datasetCount: series.datasets.length,
      categories: series.labels,
      datasets: series.datasets.map((dataset) => ({
        label: dataset.label,
        aggregate: dataset.aggregate,
        pointCount: dataset.pointCount,
        values: series.labels.map((label, i) => [label, dataset.values[i] ?? null]),
      })),
      referenceLines: [],
    });
  }
  if (series.kind === "histogram") {
    return JSON.stringify({
      ...base,
      valueLabel: series.valueLabel,
      datasetCount: 1,
      bins: series.counts.map((count, i) => [
        Math.round((series.binEdges[i] ?? 0) * 1e6) / 1e6,
        Math.round((series.binEdges[i + 1] ?? 0) * 1e6) / 1e6,
        count,
      ]),
    });
  }
  if (series.kind === "multi-xy") {
    return JSON.stringify({
      ...base,
      xLabel: series.xLabel,
      yLabel: series.yLabel,
      groupBy: series.groupByColumn,
      datasetCount: series.datasets.length,
      totalPointCount: series.totalPointCount,
      datasets: series.datasets.map((dataset) => ({ group: dataset.group, pointCount: dataset.pointCount, sample: dataset.points.slice(0, 3) })),
      referenceLines: [],
    });
  }
  return JSON.stringify({
    ...base,
    xLabel: series.xLabel,
    yLabel: series.yLabel,
    datasetCount: 1,
    pointCount: series.points.length,
    totalPointCount: series.points.length,
    sample: series.points.slice(0, 5),
    referenceLines: [],
  });
}

/**
 * Runs one untrusted visualization request against the selection, entirely
 * locally. Chart numbers come from the deterministic analysis engine. Never
 * mutates the workbook.
 */
export function runVisualization(
  snapshot: SelectionSnapshot,
  rawRequest: unknown,
  language: ResponseLanguage = "en",
): VisualizationOutcome {
  const outcome = prepareChartData(snapshot, rawRequest, language);
  if (isVisualizationError(outcome)) {
    return {
      error: outcome,
      text: `VISUALIZATION RESULT (rejected)\nerror [${outcome.code}]: ${outcome.error}`,
      activityTitle: language === "ru" ? "График отклонён" : "Chart request rejected",
      facts: [],
      factsText: "",
    };
  }
  const facts = outcome.result ? deriveVisualizationFacts(outcome.result) : [];
  const factsText = renderVisualizationFacts(facts);
  return {
    chart: outcome,
    text: `VISUALIZATION RESULT\n${chartSummary(outcome)}${factsText ? `\n\n${factsText}` : ""}`,
    activityTitle: language === "ru" ? `Построен график: ${outcome.title}` : `Chart built: ${outcome.title}`,
    ...(outcome.result ? { result: outcome.result } : {}),
    facts,
    factsText,
  };
}

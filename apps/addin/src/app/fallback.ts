import type { ResponseLanguage } from "./language.js";
import { t } from "./i18n.js";
import { formatCount, formatNumber, MISSING_DISPLAY, type NumberLocale } from "../analysis/format-number.js";
import type { VerifiedFact } from "../analysis/facts.js";
import type { FactProjection } from "../analysis/fact-projection.js";
import type { ChartData } from "../visualization/types.js";
import { CHART_VALUE_OP_ID } from "../visualization/facts.js";

interface ParsedBlock {
  readonly kind: "analysis" | "visualization" | "rejected";
  readonly payload: Record<string, unknown> | null;
  readonly raw: string;
}

/** First brace-balanced `{...}` region — tolerates trailing text after the JSON
 *  (e.g. the VERIFIED CHART FACTS block appended to a VISUALIZATION RESULT). */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function parseBlock(block: string): ParsedBlock {
  const trimmed = block.trim();
  if (/^ANALYSIS RESULT[^\n]*\(rejected\)/i.test(trimmed) || /^VISUALIZATION RESULT[^\n]*\(rejected\)/i.test(trimmed) || /^EXECUTION STATUS/i.test(trimmed)) {
    return { kind: "rejected", payload: null, raw: trimmed };
  }
  const isViz = /^VISUALIZATION RESULT/i.test(trimmed);
  const jsonText = firstJsonObject(trimmed);
  if (jsonText) {
    try {
      const payload = JSON.parse(jsonText) as Record<string, unknown>;
      return { kind: isViz ? "visualization" : "analysis", payload, raw: trimmed };
    } catch {
      /* fall through */
    }
  }
  return { kind: isViz ? "visualization" : "analysis", payload: null, raw: trimmed };
}

function fmt(value: unknown, locale: NumberLocale): string {
  if (value === null || value === undefined) return MISSING_DISPLAY;
  if (typeof value === "number") return formatNumber(value, 2, locale);
  return String(value);
}

function renderGroups(payload: Record<string, unknown>, lang: ResponseLanguage): string | null {
  const groups = payload["groups"];
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const first = groups[0] as { key?: Record<string, unknown>; count?: number; metrics?: Record<string, unknown> };
  const dimKeys = Object.keys(first.key ?? {});
  const metricKeys = Object.keys(first.metrics ?? {});
  const header = [...dimKeys, t(lang, "fallback.rowsColumn"), ...metricKeys];
  const rows = groups.map((group) => {
    const g = group as { key?: Record<string, unknown>; count?: number; metrics?: Record<string, unknown> };
    return [
      ...dimKeys.map((key) => fmt(g.key?.[key], lang)),
      fmt(g.count, lang),
      ...metricKeys.map((key) => fmt(g.metrics?.[key], lang)),
    ];
  });
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function renderStatistics(payload: Record<string, unknown>, lang: ResponseLanguage): string | null {
  const stats = payload["statistics"];
  if (!stats || typeof stats !== "object") return null;
  const entries = Object.entries(stats as Record<string, Record<string, unknown>>);
  if (entries.length === 0) return null;
  const cols = ["count", "min", "max", "mean", "median", "stddev"];
  const header = [lang === "ru" ? "столбец" : "column", ...cols];
  const rows = entries.map(([name, s]) => [name, ...cols.map((c) => fmt(s[c], lang))]);
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function renderRowsTable(payload: Record<string, unknown>, lang: ResponseLanguage): string | null {
  const columns = payload["columns"];
  const rows = payload["rows"];
  if (!Array.isArray(columns) || !Array.isArray(rows) || rows.length === 0) return null;
  const header = columns.map(String);
  const body = (rows as unknown[][]).slice(0, 25).map((r) => r.map((cell) => fmt(cell, lang)));
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function renderOne(block: ParsedBlock, lang: ResponseLanguage): string | null {
  if (block.kind === "rejected") {
    const line = block.raw.split("\n").find((l) => /error|rejected|could not|REJECTED/i.test(l)) ?? block.raw.split("\n")[0] ?? "";
    return `- ${t(lang, "fallback.notCalculated")}: ${line.replace(/^EXECUTION STATUS:\s*/i, "").trim()}`;
  }
  const payload = block.payload;
  if (!payload) return null;
  const op = String(payload["op"] ?? (block.kind === "visualization" ? "chart" : ""));
  const label = op ? `**${op}**` : "";
  if (payload["value"] !== undefined && payload["value"] !== null) {
    const params = payload["parameters"] as Record<string, unknown> | undefined;
    const metric = params?.["metric"] ?? params?.["method"] ?? "";
    return `${label} ${metric ? `(${metric}) ` : ""}= ${fmt(payload["value"], lang)}`.trim();
  }
  const groups = renderGroups(payload, lang);
  if (groups) return `${label}\n\n${groups}`;
  const stats = renderStatistics(payload, lang);
  if (stats) return `${label}\n\n${stats}`;
  const rows = renderRowsTable(payload, lang);
  if (rows) return `${label}\n\n${rows}`;
  if (block.kind === "visualization") {
    return `${t(lang, "fallback.chartPrepared")}: ${String(payload["title"] ?? "")}`.trim();
  }
  return null;
}

/**
 * Localised, workbook-identifier-preserving label for a VerifiedFact. Metric and
 * group names come from the workbook and are NEVER translated.
 */
export function localizedFactLabel(fact: VerifiedFact, language: ResponseLanguage): string {
  const ru = language === "ru";
  switch (fact.kind) {
    case "scalar":
      return fact.group !== undefined ? `${fact.metric} — ${fact.group}` : fact.metric;
    case "share":
      return ru ? `доля «${fact.ofWhat}» — ${fact.group}` : `${fact.ofWhat} share — ${fact.group}`;
    case "ratio":
      return `${fact.numerator} ÷ ${fact.denominator}`;
    case "ranking":
      return ru
        ? `ранжирование по ${fact.metric} (${fact.direction === "desc" ? "по убыванию" : "по возрастанию"})`
        : `ranking by ${fact.metric} (${fact.direction === "desc" ? "high→low" : "low→high"})`;
    case "extreme":
      return ru
        ? `${fact.which === "max" ? "наибольшее" : "наименьшее"} по ${fact.metric}`
        : `${fact.which === "max" ? "largest" : "smallest"} by ${fact.metric}`;
    case "pair":
      return ru
        ? `${fact.which === "closest" ? "ближайшая" : "самая далёкая"} пара по ${fact.metric}`
        : `${fact.which === "closest" ? "closest" : "farthest"} pair by ${fact.metric}`;
    case "comparison":
      return `${fact.subject} vs ${fact.object}`;
  }
}

// A plain (non-compound) fallback shows per-group / whole-selection values, a
// ranking / extreme, and shares (a "what share…" request is common). It drops the
// engine's auto-derived closest/farthest pairs, ratios and "vs all other
// combined" comparisons, which are almost never what a plain turn asked for
// (Stage 21.2.7 §7/§13). Chart-derived scalars (`chart#1`, Stage 21.2.8.1) are
// ALSO dropped here — they belong to the chart pivot renderer, not a flat
// "Metric | Value" row-per-(series,group) dump (Stage 21.2.8.2 §3). A compound
// turn uses the goal-relevant projection.
function relevantPlainFacts(facts: readonly VerifiedFact[]): readonly VerifiedFact[] {
  return facts.filter(
    (fact) =>
      fact.kind !== "pair" &&
      fact.kind !== "ratio" &&
      fact.kind !== "comparison" &&
      fact.sourceOperationId !== CHART_VALUE_OP_ID,
  );
}

/** A markdown table of the (already-projected) VerifiedFacts. */
function renderFactsTable(facts: readonly VerifiedFact[], language: ResponseLanguage): string | null {
  if (facts.length === 0) return null;
  const header = [t(language, "fallback.colMetric"), t(language, "fallback.colValue")];
  const rows = facts.map((fact) => [localizedFactLabel(fact, language), fact.formatted]);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Projected compound fallback — the primary product path.
// ---------------------------------------------------------------------------

function renderProjection(
  projection: FactProjection,
  language: ResponseLanguage,
  provenanceLine: string,
  chart: ChartData | null = null,
): string {
  const ru = language === "ru";
  const parts: string[] = [];
  parts.push(projection.interpretationRequested ? (ru ? "## Факты" : "## Facts") : t(language, "fallback.heading"));

  // pivot metrics that share a grouping column into one table
  const grouped = projection.metrics.filter((m) => m.by !== null);
  const scalarsOnly = projection.metrics.filter((m) => m.by === null);
  if (grouped.length > 0) {
    const by = grouped[0]!.by as string;
    // the grouping column is already the leftmost table column — drop the
    // redundant " по Category" / " by Category" suffix from each metric header
    const trimBy = new RegExp(`\\s+(?:по|by)\\s+${by.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    const cell = (text: string) => text.replace(/\|/g, "\\|"); // never break the markdown table
    const columns = grouped.map((m) => cell(m.label.replace(trimBy, "")));
    const groups: string[] = [];
    for (const metric of grouped) for (const row of metric.rows) if (!groups.includes(row.group)) groups.push(row.group);
    const head = `| ${cell(by)} | ${columns.join(" | ")} |`;
    const rule = `| ${["---", ...columns.map(() => "---")].join(" | ")} |`;
    const body = groups.map((g) => {
      const cells = grouped.map((m) => cell(m.rows.find((r) => r.group === g)?.formatted ?? MISSING_DISPLAY));
      return `| ${cell(g)} | ${cells.join(" | ")} |`;
    });
    parts.push([head, rule, ...body].join("\n"));
  }
  for (const metric of scalarsOnly) {
    parts.push(`- ${metric.label}: ${metric.rows[0]?.formatted ?? MISSING_DISPLAY}`);
  }

  for (const conclusion of projection.conclusions) {
    parts.push(`**${ru ? "Вывод" : "Conclusion"}:** ${conclusion.label} — ${conclusion.answer}.`);
  }

  if (projection.chartBuilt) {
    // §4 / 21.2.8.1 — a CHART-ONLY projection (no analytical metric, no projected
    // chart-value table — i.e. a scatter, or a chart whose values could not be
    // projected) still gets the deterministic chart rendering instead of a bare
    // "chart built" line. A normal compound fallback (with metrics) is unchanged.
    const hasChartTable = projection.metrics.some((m) => m.key.startsWith("chart:"));
    const chartBody =
      !hasChartTable && chart && projection.metrics.length === 0 ? renderChartFallback(chart, language) : null;
    parts.push(chartBody ?? (ru ? "График построен." : "A chart was built."));
  } else if (projection.chartFailed) {
    parts.push(ru ? "График построить не удалось." : "The chart could not be built.");
  }

  if (projection.interpretationRequested) {
    parts.push(ru ? "## Интерпретация" : "## Interpretation");
    parts.push(
      ru
        ? "Автоматическая интерпретация не сформирована; выше приведены только детерминированные факты."
        : "No automated interpretation was generated; only the deterministic facts above are shown.",
    );
  }

  const status: string[] = [];
  for (const label of projection.done) status.push(`✓ ${label}`);
  for (const failure of projection.failures) status.push(`⚠ ${failure.label} — ${failure.detail}`);
  if (status.length > 0) parts.push(status.join("\n"));

  parts.push(`${t(language, "fallback.source")}: ${provenanceLine}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Structural guard — implementation identifiers and internal instruction text
// can NEVER reach the user (Stage 21.2.7 §8, zero tolerance).
// ---------------------------------------------------------------------------

// A whole line is dropped when it is (or, in the model's prose, echoes) an
// internal block header / status list / repair instruction. Implementation-id
// tokens — `op#N`, `оп#N`, `[GN]`, `[FN]` (and `[F1]–[F5]` ranges), goal-status
// words — are also scrubbed inline so nothing carries one (Stage 21.2.7 §8 /
// 21.2.8: the model sometimes cites "VERIFIED FACTS [F1]–[F5], оп#1" in prose).
const INTERNAL_LINE =
  /(?:^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:GOAL STATUS|СТАТУС ЦЕЛЕЙ|Статус целей|Goal status|ФАКТЫ \(только|FACTS \(only|VISUALIZATION RESULT|ANALYSIS RESULT|EXECUTION STATUS|REVISION REQUIRED|No more analysis will be run)|VERIFIED (?:CHART )?FACTS|\bиз VERIFIED\b)/i;
const INTERNAL_SENTENCE =
  /(Опиши числами ТОЛЬКО|Describe with numbers ONLY|Do NOT imply the whole request|Не подразумевай, что весь запрос|REVISION REQUIRED|you may NOT add, subtract, multiply)/i;

const ID_TOKEN = /\[[GF]\d+\](?:\s*[–—-]\s*\[[GF]\d+\])?|\b(?:op|оп)\s*#?\s*№?\s*\d+/gi;

export function stripInternalArtifacts(text: string): string {
  const kept = text
    .split("\n")
    .filter((line) => !INTERNAL_LINE.test(line) && !INTERNAL_SENTENCE.test(line) && !/\[G\d+\]/.test(line))
    .map((line) =>
      line
        .replace(ID_TOKEN, "")
        .replace(/[,;]\s*(?=[,;.]|$)/g, "") // tidy the "VERIFIED FACTS , оп#1," → ", ," debris
        .replace(/\s{2,}/g, " ")
        .replace(/[ \t]+$/g, ""),
    );
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Chart-primary fallback (Stage 21.2.8 §4). A rendered chart must never produce
// "_no numeric results_": show the deterministic chart data / structure instead.
// ---------------------------------------------------------------------------

function chartBuiltLine(language: ResponseLanguage): string {
  return language === "ru" ? "График построен." : "A chart was built.";
}

// Deterministic, localized column head for a chart dataset — from its aggregate +
// source columns, NOT the model-authored `label` (Stage 21.2.8.1 §5).
const FB_AGG_WORD: Record<NumberLocale, Record<string, string>> = {
  ru: { mean: "Среднее", sum: "Сумма", median: "Медиана", min: "Минимум", max: "Максимум", count: "Количество" },
  en: { mean: "Mean", sum: "Sum", median: "Median", min: "Min", max: "Max", count: "Count" },
};

function chartDatasetHead(
  dataset: { readonly label: string; readonly aggregate?: string; readonly sourceColumns?: readonly string[] },
  language: NumberLocale,
): string {
  const cols = dataset.sourceColumns ?? [];
  if (dataset.aggregate && cols.length > 0) {
    return `${FB_AGG_WORD[language][dataset.aggregate] ?? dataset.aggregate} ${cols.join(", ")}`;
  }
  return dataset.label;
}

function renderChartFallback(chart: ChartData, language: ResponseLanguage): string | null {
  const ru = language === "ru";
  const series = chart.series;
  const result = chart.result;
  const parts: string[] = [];

  if (series.kind === "multi-category") {
    const dim = result?.x ?? (ru ? "Категория" : "Category");
    const cols = series.datasets.map((d) => chartDatasetHead(d, language));
    const head = `| ${dim} | ${cols.join(" | ")} |`;
    const rule = `| ${["---", ...cols.map(() => "---:")].join(" | ")} |`;
    const rows = series.labels.map((label, i) => {
      const cells = series.datasets.map((d) => {
        const v = d.values[i];
        return v === null || v === undefined ? MISSING_DISPLAY : formatNumber(v, 2, language);
      });
      return `| ${label} | ${cells.join(" | ")} |`;
    });
    parts.push([head, rule, ...rows].join("\n"));
  } else if (series.kind === "category") {
    const dim = result?.x ?? (ru ? "Категория" : "Category");
    const valueHead = result?.datasets[0]
      ? chartDatasetHead(result.datasets[0], language)
      : series.valueLabel;
    const head = `| ${dim} | ${valueHead} |`;
    const rule = `| --- | ---: |`;
    const rows = series.labels.map((label, i) => `| ${label} | ${formatNumber(series.values[i] ?? 0, 2, language)} |`);
    parts.push([head, rule, ...rows].join("\n"));
  } else if (series.kind === "histogram") {
    const head = ru ? "| Диапазон | Количество |" : "| Range | Count |";
    const rows = series.counts.map((count, i) => `| ${formatNumber(series.binEdges[i] ?? 0, 2, language)} – ${formatNumber(series.binEdges[i + 1] ?? 0, 2, language)} | ${formatCount(count, language)} |`);
    parts.push([head, "| --- | --- |", ...rows].join("\n"));
  } else {
    // xy / multi-xy — a coordinate table is rarely useful; state the structure.
    const type = ru ? "точечная диаграмма" : "scatter chart";
    const axes = ru
      ? `оси: X — ${result?.x ?? series.xLabel}, Y — ${result?.y ?? series.yLabel}`
      : `axes: X — ${result?.x ?? series.xLabel}, Y — ${result?.y ?? series.yLabel}`;
    const line = [ru ? `Тип: ${type}` : `Type: ${type}`, axes];
    if (series.kind === "multi-xy") {
      line.push(ru ? `разбивка по ${series.groupByColumn}` : `grouped by ${series.groupByColumn}`);
      line.push(ru ? `наборов данных: ${series.datasets.length}` : `datasets: ${series.datasets.length}`);
      line.push(ru ? `всего точек: ${formatCount(series.totalPointCount, language)}` : `total points: ${formatCount(series.totalPointCount, language)}`);
    } else {
      line.push(ru ? `точек: ${formatCount(series.points.length, language)}` : `points: ${formatCount(series.points.length, language)}`);
    }
    parts.push(`- ${line.join("; ")}.`);
  }

  parts.push(chartBuiltLine(language));
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------

export function renderDeterministicFallback(
  deterministicBlocks: readonly string[],
  language: ResponseLanguage,
  provenanceLine: string,
  facts: readonly VerifiedFact[] = [],
  projection: FactProjection | null = null,
  chart: ChartData | null = null,
): string {
  if (projection) {
    return stripInternalArtifacts(renderProjection(projection, language, provenanceLine, chart));
  }

  const relevant = relevantPlainFacts(facts);
  const factsTable = renderFactsTable(relevant, language);
  let body: string;
  if (factsTable) {
    body = factsTable;
  } else {
    const parsed = deterministicBlocks
      .flatMap((block) => block.split(/\n\n(?=ANALYSIS RESULT|VISUALIZATION RESULT|EXECUTION STATUS)/))
      .map(parseBlock);
    const rendered = parsed.map((block) => renderOne(block, language)).filter((value): value is string => Boolean(value));
    body = rendered.length > 0 ? rendered.join("\n\n") : "";
  }

  // §3/§4 — a rendered chart is real numeric output: a category chart becomes a
  // pivot table, a scatter a structural summary (never "no numeric results",
  // never a row-per-(series,group) dump).
  if (chart) {
    const chartBody = renderChartFallback(chart, language);
    if (chartBody) body = body.length > 0 ? `${body}\n\n${chartBody}` : chartBody;
  }
  if (body.length === 0) body = t(language, "fallback.noResults");

  // Stage 21.2.8.2 §4 — no internal answer-validation commentary in normal
  // user-facing output; genuine analytical failures still surface as their own
  // "<not calculated>: <reason>" lines above.
  const heading = t(language, "fallback.heading");
  const source = `${t(language, "fallback.source")}: ${provenanceLine}`;
  return stripInternalArtifacts(`${heading}\n\n${body}\n\n${source}`);
}

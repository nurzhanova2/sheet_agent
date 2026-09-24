import type { CellValue } from "@sheet-agent/application";
import type { ResultRef } from "./session-memory.js";
import type { ChartData } from "../visualization/types.js";

export type ResultChartOutcome =
  | { readonly kind: "chart"; readonly chart: ChartData }
  | { readonly kind: "clarify"; readonly question: string; readonly candidates: readonly string[] }
  | { readonly kind: "error"; readonly error: string };

function asNumber(value: CellValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9eE.,+-]/g, "").replace(",", ".");
    if (cleaned === "" || !/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numericColumns(ref: Pick<ResultRef, "columns" | "rows">): number[] {
  const out: number[] = [];
  for (let c = 0; c < ref.columns.length; c += 1) {
    let numbers = 0;
    let total = 0;
    for (const row of ref.rows) {
      const v = row[c];
      if (v === null || v === undefined || v === "") continue;
      total += 1;
      if (asNumber(v) !== null) numbers += 1;
    }
    if (total > 0 && numbers / total >= 0.6) out.push(c);
  }
  return out;
}

const AGG_PREFIX_RE =
  /^(?:mean|average|avg|median|sum|total|min|minimum|max|maximum|count|std|stdev|stddev)\s+/i;

function baseName(header: string): string {
  return header.trim().toLowerCase().replace(AGG_PREFIX_RE, "").replace(/[\s%.]+$/, "").trim();
}

/**
 * 24.3.1 — resolves a column the answer named on a `chart_columns` clarification
 * ("Plan" / "Mean Plan" / "план") to an actual result column. Exact first, then
 * one aggregate-prefixed base match, then a single substring match. Never fuzzy.
 */
function resolveNamedColumn(columns: readonly string[], name: string): number {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return -1;
  const exact = columns.findIndex((c) => c.toLowerCase() === wanted);
  if (exact >= 0) return exact;
  const wb = baseName(wanted);
  const agg = columns.map((c, i) => [c, i] as const).filter(([c]) => AGG_PREFIX_RE.test(c) && baseName(c) === wb);
  if (agg.length === 1) return agg[0]![1];
  const sub = columns.map((c, i) => [c, i] as const).filter(([c]) => c.toLowerCase().includes(wanted) || wanted.includes(c.toLowerCase()));
  if (sub.length === 1) return sub[0]![1];
  return -1;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/;

function looksDateLike(values: readonly CellValue[]): boolean {
  const present = values.filter((v) => v !== null && v !== "" && v !== undefined);
  if (present.length === 0) return false;
  return present.every((v) => typeof v === "string" && ISO_DATE.test(v));
}

/**
 * Builds ChartData directly from a remembered result's own columns/rows.
 *
 * `forcedColumns` — the value columns the user picked in answer to a
 * `chart_columns` clarification. When present the ambiguity branch is skipped
 * and exactly those columns are charted (24.3.1). Still zero workbook reads,
 * zero model calls.
 */
export function resultToChartData(
  ref: ResultRef,
  language: "en" | "ru" = "en",
  forcedColumns?: readonly string[],
): ResultChartOutcome {
  const ru = language === "ru";
  if (ref.rows.length === 0) return { kind: "error", error: ru ? "в этом результате нет строк" : "that result has no rows" };

  const numeric = new Set(numericColumns(ref));
  const numericIdx = [...numeric];
  if (numericIdx.length === 0) {
    return { kind: "error", error: ru ? "в этом результате нет числового столбца для графика" : "that result has no numeric column to chart" };
  }
  const labelIdx = ref.columns.findIndex((_, i) => !numeric.has(i));
  const catIdx = labelIdx >= 0 ? labelIdx : 0;

  let valueIdxs: number[];
  if (forcedColumns && forcedColumns.length > 0) {
    valueIdxs = [];
    for (const name of forcedColumns) {
      const idx = resolveNamedColumn(ref.columns, name);
      if (idx >= 0 && idx !== catIdx && !valueIdxs.includes(idx)) valueIdxs.push(idx);
    }
    if (valueIdxs.length === 0) {
      return { kind: "error", error: ru ? "не нашёл эти столбцы в результате" : "none of those columns are in that result" };
    }
  } else {
    valueIdxs = numericIdx.filter((i) => i !== catIdx);
    if (valueIdxs.length === 0) valueIdxs.push(numericIdx[0]!);
    if (valueIdxs.length >= 3) {
      return {
        kind: "clarify",
        question: ru
          ? `В этом результате несколько числовых столбцов: ${valueIdxs.map((i) => ref.columns[i]).join(", ")}. Какие показать на графике?`
          : `That result has several numeric columns: ${valueIdxs.map((i) => ref.columns[i]).join(", ")}. Which should the chart use?`,
        candidates: valueIdxs.map((i) => ref.columns[i]!),
      };
    }
  }

  const labels = ref.rows.map((row) => String(row[catIdx] ?? ""));
  const labelValues = ref.rows.map((row) => row[catIdx] ?? null);
  const provenance = `${ref.sourceRange} · ${ref.rows.length}${ref.rowsTruncated ? "+" : ""} ${ru ? "строк" : "rows"}`;
  const base = { provenance, rowsAnalyzed: ref.rows.length, truncated: ref.rowsTruncated, warnings: [] as string[] };

  // date/time + single numeric → line
  if (valueIdxs.length === 1 && looksDateLike(labelValues)) {
    const yIdx = valueIdxs[0]!;
    const points = ref.rows.map(
      (row) => [String(row[catIdx] ?? ""), asNumber(row[yIdx] ?? null) ?? 0] as readonly [string, number],
    );
    return {
      kind: "chart",
      chart: {
        type: "line",
        title: ref.title,
        series: { kind: "xy", points, xLabel: ref.columns[catIdx] ?? "", yLabel: ref.columns[yIdx] ?? "", xIsDate: true },
        ...base,
      },
    };
  }

  if (valueIdxs.length === 1) {
    const yIdx = valueIdxs[0]!;
    return {
      kind: "chart",
      chart: {
        type: "bar",
        title: ref.title,
        series: {
          kind: "category",
          labels,
          values: ref.rows.map((row) => asNumber(row[yIdx] ?? null) ?? 0),
          valueLabel: ref.columns[yIdx] ?? "",
        },
        ...base,
      },
    };
  }

  // two numeric columns → grouped bar
  return {
    kind: "chart",
    chart: {
      type: "bar",
      title: ref.title,
      series: {
        kind: "multi-category",
        labels,
        mode: "grouped",
        xIsDate: false,
        datasets: valueIdxs.map((i) => ({
          id: `ds_${i}`,
          label: ref.columns[i] ?? `series ${i}`,
          values: ref.rows.map((row) => asNumber(row[i] ?? null)),
          pointCount: labels.length,
          sourceColumns: [ref.columns[i] ?? ""],
          aggregate: "mean" as const,
        })),
      },
      ...base,
    },
  };
}

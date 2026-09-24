import type { CellValue } from "@sheet-agent/application";
import type { ResponseLanguage } from "../language.js";
import type { SelectionSnapshot } from "../workbook-context.js";
import { formatNumber, type NumberLocale } from "../../analysis/format-number.js";

export interface CompareSpec {
  /** Raw column reference, e.g. "Fact". */
  readonly metric: string;
  readonly sheetA: string;
  readonly sheetB: string;
}

export interface CompareTextResult {
  readonly text: string;
}
export interface CompareError {
  readonly error: string;
}
export function isCompareError(v: CompareTextResult | CompareError): v is CompareError {
  return "error" in v;
}

const BETWEEN_RE = /^(.+?)\s+(?:between|между)\s+(.+?)\s+(?:and|и)\s+(.+?)\s*$/i;

/** Parses `<metric> between <SheetA> and <SheetB>` (RU: `<metric> между <A> и <B>`). */
export function parseCompareSpec(args: string): CompareSpec | null {
  const match = BETWEEN_RE.exec(args.trim());
  if (!match) return null;
  const metric = (match[1] ?? "").trim();
  const sheetA = (match[2] ?? "").trim();
  const sheetB = (match[3] ?? "").trim();
  if (!metric || !sheetA || !sheetB) return null;
  return { metric, sheetA, sheetB };
}

interface ColumnStats {
  readonly count: number;
  readonly numeric: number;
  readonly sum: number | null;
  readonly mean: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly distinct: number;
}

function columnIndex(headers: readonly string[], reference: string): number {
  const wanted = reference.trim().toLowerCase();
  const exact = headers.findIndex((h) => h.trim().toLowerCase() === wanted);
  if (exact >= 0) return exact;
  const sub = headers.map((h, i) => ({ h, i })).filter(({ h }) => h.trim().toLowerCase().includes(wanted));
  return sub.length === 1 ? sub[0]!.i : -1;
}

function statsFor(snapshot: SelectionSnapshot, index: number): ColumnStats {
  const cells: CellValue[] = snapshot.values.slice(1).map((row) => row[index] ?? null);
  const present = cells.filter((v) => v !== null && v !== "" && v !== undefined);
  const numbers = present.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const distinct = new Set(present.map((v) => String(v))).size;
  if (numbers.length === 0) {
    return { count: present.length, numeric: 0, sum: null, mean: null, min: null, max: null, distinct };
  }
  const sum = numbers.reduce((total, n) => total + n, 0);
  return {
    count: present.length,
    numeric: numbers.length,
    sum,
    mean: sum / numbers.length,
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    distinct,
  };
}

/**
 * Builds the aggregate comparison. Both snapshots must already be reads of the
 * two RESOLVED sheets. The column is resolved against each sheet's headers; if
 * it is missing from either, no computation happens.
 */
export function buildCompareReport(
  spec: CompareSpec,
  displayA: string,
  displayB: string,
  snapshotA: SelectionSnapshot,
  snapshotB: SelectionSnapshot,
  language: ResponseLanguage,
): CompareTextResult | CompareError {
  const ru = language === "ru";
  const locale: NumberLocale = ru ? "ru" : "en";
  const headersA = snapshotA.headers ?? [];
  const headersB = snapshotB.headers ?? [];

  const indexA = columnIndex(headersA, spec.metric);
  const indexB = columnIndex(headersB, spec.metric);
  const missing: string[] = [];
  if (indexA < 0) missing.push(displayA);
  if (indexB < 0) missing.push(displayB);
  if (missing.length > 0) {
    return {
      error: ru
        ? `Столбец «${spec.metric}» отсутствует на листе: ${missing.join(", ")}. Сравнение не выполнено.`
        : `Column "${spec.metric}" is not present on: ${missing.join(", ")}. Nothing was compared.`,
    };
  }

  const nameA = headersA[indexA]!;
  const statsA = statsFor(snapshotA, indexA);
  const statsB = statsFor(snapshotB, indexB);
  const f = (n: number | null): string => (n === null ? (ru ? "—" : "—") : formatNumber(n, 2, locale));
  const delta = (a: number | null, b: number | null): string =>
    a === null || b === null ? "—" : formatNumber(b - a, 2, locale);

  const numericBoth = statsA.numeric > 0 && statsB.numeric > 0;
  const rows: string[] = [
    `| count | ${statsA.count} | ${statsB.count} | ${statsB.count - statsA.count} |`,
  ];
  if (numericBoth) {
    rows.push(
      `| sum | ${f(statsA.sum)} | ${f(statsB.sum)} | ${delta(statsA.sum, statsB.sum)} |`,
      `| mean | ${f(statsA.mean)} | ${f(statsB.mean)} | ${delta(statsA.mean, statsB.mean)} |`,
      `| min | ${f(statsA.min)} | ${f(statsB.min)} | ${delta(statsA.min, statsB.min)} |`,
      `| max | ${f(statsA.max)} | ${f(statsB.max)} | ${delta(statsA.max, statsB.max)} |`,
    );
  } else {
    rows.push(`| ${ru ? "уникальных" : "distinct"} | ${statsA.distinct} | ${statsB.distinct} | ${statsB.distinct - statsA.distinct} |`);
  }

  const lines = [
    ru ? `## Сравнение: ${nameA}` : `## Compare: ${nameA}`,
    "",
    `| ${ru ? "Показатель" : "Metric"} | ${displayA} | ${displayB} | Δ |`,
    "| --- | ---: | ---: | ---: |",
    ...rows,
    "",
  ];
  if (!numericBoth) {
    lines.push(
      ru
        ? "_Столбец не полностью числовой хотя бы на одном листе — сумма/среднее/мин/макс не рассчитаны._"
        : "_The column is not fully numeric on at least one sheet — sum / mean / min / max were not computed._",
    );
  }
  if (snapshotA.truncated || snapshotB.truncated) {
    lines.push(
      ru
        ? `_Один из листов больше лимита чтения — агрегаты посчитаны по первым ${Math.max(snapshotA.rowCount, snapshotB.rowCount)} строкам._`
        : `_A sheet exceeds the read limit — aggregates cover the first ${Math.max(snapshotA.rowCount, snapshotB.rowCount)} rows only._`,
    );
  }
  lines.push(
    ru
      ? "_Сравнение по строкам требует ключевого столбца; укажите его, чтобы сравнить построчно. Книга не изменена._"
      : "_Row-level comparison needs a key column; specify one to compare row by row. The workbook was not changed._",
  );
  return { text: lines.join("\n") };
}

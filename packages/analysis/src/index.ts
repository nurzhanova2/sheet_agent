export interface AnalysisEvidence { readonly range: string; readonly metric: string; readonly value: unknown; }

export type InferredType = "number" | "string" | "boolean" | "date" | "mixed" | "empty";
export type AnalysisCell = string | number | boolean | null | undefined;
export interface AnalysisMatrix { readonly range: string; readonly headers: readonly string[]; readonly rows: readonly (readonly AnalysisCell[])[]; }
export interface NumericStatistics { readonly count: number; readonly min: number; readonly max: number; readonly mean: number; readonly median: number; readonly standardDeviation: number; }
export interface ColumnAnalysis { readonly name: string; readonly inferredType: InferredType; readonly count: number; readonly missing: number; readonly invalid: number; readonly unique: number; readonly valueCounts: Readonly<Record<string, number>>; readonly statistics?: NumericStatistics; }
export interface AnalysisReport { readonly range: string; readonly rowsAnalyzed: number; readonly sampled: boolean; readonly columns: readonly ColumnAnalysis[]; readonly duplicates: readonly (readonly number[])[]; readonly correlations: readonly { readonly left: string; readonly right: string; readonly coefficient: number }[]; readonly outliers: readonly { readonly column: string; readonly row: number; readonly value: number }[]; readonly trends: readonly { readonly column: string; readonly slope: number; readonly direction: "increasing" | "decreasing" | "flat" }[]; readonly evidence: readonly AnalysisEvidence[]; }

function parseNumber(value: AnalysisCell): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: AnalysisCell): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : undefined;
}

function median(values: readonly number[]): number { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2; }
function statistics(values: readonly number[]): NumericStatistics | undefined {
  if (!values.length) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { count: values.length, min: Math.min(...values), max: Math.max(...values), mean, median: median(values), standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) };
}
function typeOf(values: readonly AnalysisCell[]): InferredType {
  const present = values.filter((value) => value !== null && value !== undefined && value !== "");
  if (!present.length) return "empty";
  const numericCount = present.filter((value) => parseNumber(value) !== undefined).length;
  if (numericCount >= Math.max(1, Math.ceil(present.length * 0.6))) return "number";
  if (present.every((value) => parseDate(value) !== undefined)) return "date";
  if (present.every((value) => typeof value === "boolean")) return "boolean";
  if (present.every((value) => typeof value === "string")) return "string";
  return "mixed";
}

export function analyzeMatrix(input: AnalysisMatrix, options: { readonly maxRows?: number } = {}): AnalysisReport {
  const maxRows = Math.max(1, options.maxRows ?? input.rows.length);
  const rows = input.rows.slice(0, maxRows);
  const evidence: AnalysisEvidence[] = [];
  const columns = input.headers.map((name, colIndex) => {
    const values = rows.map((row) => row[colIndex] ?? null);
    const inferredType = typeOf(values);
    const present = values.filter((value) => value !== null && value !== undefined && value !== "");
    const numeric = values.map(parseNumber).filter((value): value is number => value !== undefined);
    const invalid = inferredType === "number" ? present.length - numeric.length : 0;
    const valueCounts: Record<string, number> = {};
    for (const value of present) { const key = String(value); valueCounts[key] = (valueCounts[key] ?? 0) + 1; }
    const stats = statistics(numeric);
    const analysisColumn: ColumnAnalysis = { name, inferredType, count: present.length, missing: values.length - present.length, invalid, unique: Object.keys(valueCounts).length, valueCounts, ...(stats ? { statistics: stats } : {}) };
    evidence.push({ range: input.range, metric: `column.${name}.type`, value: inferredType }, { range: input.range, metric: `column.${name}.missing`, value: analysisColumn.missing });
    return analysisColumn;
  });
  const duplicateMap = new Map<string, number[]>();
  rows.forEach((row, index) => { const key = JSON.stringify(row); duplicateMap.set(key, [...(duplicateMap.get(key) ?? []), index + 1]); });
  const duplicates = [...duplicateMap.values()].filter((indexes) => indexes.length > 1);
  const numericColumns = columns.map((column, index) => ({ column, index })).filter(({ column }) => column.statistics);
  const correlations: { left: string; right: string; coefficient: number }[] = [];
  for (let left = 0; left < numericColumns.length; left += 1) for (let right = left + 1; right < numericColumns.length; right += 1) {
    const a = numericColumns[left]; const b = numericColumns[right]; if (!a || !b) continue;
    const pairs = rows.map((row) => [parseNumber(row[a.index]), parseNumber(row[b.index])] as const).filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);
    const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length; const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
    const numerator = pairs.reduce((sum, pair) => sum + (pair[0] - meanA) * (pair[1] - meanB), 0); const denominator = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[0] - meanA) ** 2, 0) * pairs.reduce((sum, pair) => sum + (pair[1] - meanB) ** 2, 0));
    if (pairs.length > 1 && denominator) correlations.push({ left: a.column.name, right: b.column.name, coefficient: Number((numerator / denominator).toFixed(6)) });
  }
  const outliers: { column: string; row: number; value: number }[] = [];
  for (const { column, index } of numericColumns) { const values = rows.map((row) => parseNumber(row[index])).filter((value): value is number => value !== undefined).sort((a, b) => a - b); if (values.length < 4) continue; const q1 = median(values.slice(0, Math.floor(values.length / 2))); const q3 = median(values.slice(Math.ceil(values.length / 2))); const iqr = q3 - q1; const center = median(values); const mad = median(values.map((value) => Math.abs(value - center))); rows.forEach((row, rowIndex) => { const value = parseNumber(row[index]); const iqrOutlier = value !== undefined && (value < q1 - 1.5 * iqr || value > q3 + 1.5 * iqr); const madOutlier = value !== undefined && mad > 0 && Math.abs(value - center) / mad > 6; if (value !== undefined && (iqrOutlier || madOutlier)) outliers.push({ column: column.name, row: rowIndex + 1, value }); }); }
  const trends = numericColumns.map(({ column, index }) => { const values = rows.map((row) => parseNumber(row[index])).filter((value): value is number => value !== undefined); const slope = values.length > 1 ? (values.at(-1)! - values[0]!) / (values.length - 1) : 0; return { column: column.name, slope: Number(slope.toFixed(6)), direction: slope > 0 ? "increasing" as const : slope < 0 ? "decreasing" as const : "flat" as const }; });
  return { range: input.range, rowsAnalyzed: rows.length, sampled: rows.length < input.rows.length, columns, duplicates, correlations, outliers, trends, evidence };
}

export interface FormulaAnalysis { readonly errors: readonly { readonly row: number; readonly code: "FORMULA_ERROR" }[]; readonly gaps: readonly number[]; readonly inconsistentRows: readonly number[]; readonly evidence: readonly AnalysisEvidence[]; }
export function analyzeFormulas(input: { readonly range: string; readonly formulas: readonly (readonly string[])[] }): FormulaAnalysis {
  const startRow = Number(/![A-Z]+(\d+)/.exec(input.range)?.[1] ?? 1); const errors: { row: number; code: "FORMULA_ERROR" }[] = []; const gaps: number[] = []; const inconsistentRows: number[] = [];
  input.formulas.forEach((row, index) => { const formula = row[0] ?? ""; const excelRow = startRow + index; if (!formula) gaps.push(excelRow); if (/#(REF|DIV\/0|VALUE|NAME|N\/A)!?/i.test(formula)) errors.push({ row: excelRow, code: "FORMULA_ERROR" }); const refs = [...formula.matchAll(/[A-Z]+(\d+)/g)].map((match) => Number(match[1])); if (formula && refs.some((reference) => reference !== excelRow)) inconsistentRows.push(excelRow); });
  return { errors, gaps, inconsistentRows, evidence: [{ range: input.range, metric: "formulas.errors", value: errors.length }, { range: input.range, metric: "formulas.gaps", value: gaps.length }] };
}

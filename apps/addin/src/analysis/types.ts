// ---------------------------------------------------------------------------
// SpreadsheetAnalysis protocol — the ONLY thing the LLM may request for
// deterministic computation over the selected data. Everything here is a plain
// data structure: there is no code, no expression string, no eval path.
// ---------------------------------------------------------------------------

export type CellPrimitive = string | number | boolean | null;

/**
 * A percentage literal. `{ kind: "percent", value: 20 }` means 20 % and is
 * normalized deterministically to the fraction `0.2` before any comparison —
 * so a natural-language "> 20%" against a %-formatted column (whose values are
 * stored as fractions) compares correctly without the model having to remember
 * Excel's fractional storage. A bare number like `0.2` is always taken literally.
 */
export interface PercentLiteral {
  readonly kind: "percent";
  readonly value: number;
}

/** Safe numeric expression AST. Depth and node types are validated before use. */
export type Expression =
  | { readonly kind: "column"; readonly name: string }
  | { readonly kind: "literal"; readonly value: number }
  | { readonly kind: "percent"; readonly value: number } // → value / 100
  | { readonly kind: "abs"; readonly value: Expression }
  | { readonly kind: "neg"; readonly value: Expression }
  | { readonly kind: "add"; readonly left: Expression; readonly right: Expression }
  | { readonly kind: "subtract"; readonly left: Expression; readonly right: Expression }
  | { readonly kind: "multiply"; readonly left: Expression; readonly right: Expression }
  | { readonly kind: "divide"; readonly left: Expression; readonly right: Expression };

export type ComparisonOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "not_contains";

/** A column reference by header name, e.g. `{ column: "Plan" }`. Distinct from the
 *  Expression column node `{ kind: "column", name }`; both resolve to the same column. */
export interface ColumnRef {
  readonly column: string;
}

/** Either side of a Condition: a column, a safe expression, a literal, or a percent literal. */
export type ConditionOperand = Expression | ColumnRef;

export interface Condition {
  readonly left: ConditionOperand;
  readonly operator: ComparisonOperator;
  /**
   * The right-hand side. In addition to a literal / percent literal it may be a
   * column reference (`{ column: "Plan" }`) or a safe expression — this is how a
   * column-to-column comparison such as `Fact < Plan` is expressed deterministically:
   *   { left: { column: "Fact" }, operator: "<", value: { column: "Plan" } }
   */
  readonly value: CellPrimitive | PercentLiteral | ConditionOperand;
}

/**
 * AND (`all`) and/or OR (`any`) groups of conditions. Not nested. A single bare
 * `Condition` (`{ left, operator, value }`) is also accepted anywhere a group is
 * — it is normalized to `{ all: [condition] }`.
 */
export interface ConditionGroup {
  readonly all?: readonly Condition[];
  readonly any?: readonly Condition[];
}

/** What every `where` field actually accepts on the wire. */
export type ConditionInput = ConditionGroup | Condition;

export type AggregateMetric = "count" | "sum" | "mean" | "min" | "max" | "median";

export interface GroupMetric {
  readonly name?: string;
  readonly metric: AggregateMetric;
  readonly target?: Expression; // required for everything except "count"
  readonly where?: ConditionInput; // per-metric filter (e.g. count only "strong" rows)
}

export interface SortSpec {
  readonly by: Expression | string; // expression, or a group-metric name for group_by
  readonly direction: "asc" | "desc";
}

export type AnalysisRequest =
  | { readonly op: "count"; readonly where?: ConditionInput }
  | { readonly op: "aggregate"; readonly metric: AggregateMetric; readonly target: Expression; readonly where?: ConditionInput }
  | { readonly op: "filter"; readonly where: ConditionInput; readonly columns?: readonly string[]; readonly limit?: number }
  | { readonly op: "sort"; readonly by: Expression; readonly direction: "asc" | "desc"; readonly where?: ConditionInput; readonly columns?: readonly string[]; readonly limit?: number }
  | { readonly op: "top_n"; readonly n: number; readonly by: Expression; readonly where?: ConditionInput; readonly columns?: readonly string[] }
  | { readonly op: "bottom_n"; readonly n: number; readonly by: Expression; readonly where?: ConditionInput; readonly columns?: readonly string[] }
  | { readonly op: "distinct"; readonly column: string; readonly where?: ConditionInput }
  | { readonly op: "group_by"; readonly by: readonly string[]; readonly metrics: readonly GroupMetric[]; readonly where?: ConditionInput; readonly sort?: SortSpec; readonly limit?: number }
  | { readonly op: "summary_statistics"; readonly columns?: readonly string[] }
  | { readonly op: "correlation"; readonly x: Expression; readonly y: Expression; readonly where?: ConditionInput }
  | { readonly op: "group_correlation"; readonly by: readonly string[]; readonly x: Expression; readonly y: Expression; readonly where?: ConditionInput }
  | { readonly op: "outliers"; readonly target: Expression; readonly method: "iqr" | "zscore"; readonly threshold?: number; readonly where?: ConditionInput; readonly columns?: readonly string[] };

export type AnalysisOp = AnalysisRequest["op"];

export interface AnalysisSource {
  readonly sheetName: string;
  readonly address: string;
}

export interface GroupResult {
  readonly key: Readonly<Record<string, string>>;
  readonly count: number;
  readonly metrics: Readonly<Record<string, number | null>>;
}

export interface ColumnStatistics {
  readonly count: number;
  readonly missing: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly median: number | null;
  readonly stddev: number | null; // sample standard deviation (n-1)
}

export interface AnalysisResult {
  readonly op: AnalysisOp;
  readonly source: AnalysisSource;
  readonly rowsAnalyzed: number; // data rows in the dataset
  readonly rowsMatched?: number; // rows passing `where`
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly CellPrimitive[])[];
  readonly sourceRows?: readonly number[]; // 1-based sheet row number for each row in `rows` (top_n/bottom_n/filter/sort)
  readonly value?: number | null;
  readonly groups?: readonly GroupResult[];
  readonly statistics?: Readonly<Record<string, ColumnStatistics>>;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

export interface AnalysisError {
  readonly error: string;
  readonly code:
    | "NO_HEADERS"
    | "UNKNOWN_OP"
    | "UNKNOWN_COLUMN"
    | "AMBIGUOUS_COLUMN"
    | "INVALID_EXPRESSION"
    | "INVALID_CONDITION"
    | "INVALID_REQUEST"
    | "LIMIT_EXCEEDED";
  readonly detail?: string;
}

export type AnalysisOutcome = AnalysisResult | AnalysisError;

export function isAnalysisError(value: AnalysisOutcome): value is AnalysisError {
  return "error" in value;
}

// ---------------------------------------------------------------------------
// Hard limits — enforced on every untrusted request.
// ---------------------------------------------------------------------------
export const ANALYSIS_LIMITS = {
  maxN: 100,
  maxGroupDimensions: 3,
  maxGroups: 200,
  maxMetricsPerGroupBy: 8,
  maxConditions: 12,
  maxExpressionDepth: 6,
  maxResultRows: 200,
  maxOpsPerTurn: 8,
} as const;

import type { CellValue } from "@sheet-agent/application";

export type DerivedMetricOperator =
  | "add" // A + B
  | "subtract" // A - B
  | "divide" // A / B
  | "abs_diff" // |A - B|
  | "pct_change" // (A - B) / B
  | "pp_change"; // A - B, expressed in percentage points (A, B must be rates)

export const DERIVED_METRIC_OPERATORS: readonly DerivedMetricOperator[] = [
  "add", "subtract", "divide", "abs_diff", "pct_change", "pp_change",
];

export interface DerivedMetricSpec {
  /** Left column name (resolved against the source result's schema). */
  readonly left: string;
  readonly operator: DerivedMetricOperator;
  /** Right column name. Exactly one of `right` / `scalar` for a binary operator. */
  readonly right?: string;
  /** Right-hand scalar. Not allowed for `pct_change` / `pp_change`. */
  readonly scalar?: number;
  /** New column name (must not collide with an existing column). */
  readonly output: string;
}

export interface DerivedGrid {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
}

export type DerivedMetricResult =
  | { readonly ok: true; readonly grid: DerivedGrid }
  | { readonly ok: false; readonly error: string };

function toNumber(value: CellValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9eE.+-]/g, "");
    if (cleaned === "" || value.trim() === "") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Resolves one column name against a schema: exact CI wins; >1 = ambiguous; 0 = missing. */
function resolveColumn(columns: readonly string[], name: string): number | { readonly error: string } {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return { error: "column name is empty" };
  const exact = columns
    .map((c, i) => [c, i] as const)
    .filter(([c]) => c.trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0]![1];
  if (exact.length > 1) return { error: `column "${name}" matches more than one column: ${exact.map(([c]) => c).join(", ")}` };
  const sub = columns.map((c, i) => [c, i] as const).filter(([c]) => c.toLowerCase().includes(wanted));
  if (sub.length === 1) return sub[0]![1];
  if (sub.length > 1) return { error: `column "${name}" is ambiguous: ${sub.map(([c]) => c).join(", ")}` };
  return { error: `column "${name}" is not in this result (${columns.join(", ")})` };
}

function apply(op: DerivedMetricOperator, a: number, b: number): number | null {
  switch (op) {
    case "add":
      return a + b;
    case "subtract":
    case "pp_change":
      return a - b;
    case "abs_diff":
      return Math.abs(a - b);
    case "divide":
      return b === 0 ? null : a / b;
    case "pct_change":
      return b === 0 ? null : (a - b) / b;
  }
}

/**
 * Computes `spec.output = spec.left <op> (spec.right | spec.scalar)` for every
 * row of `source`, returning a NEW grid. A row whose operands are missing /
 * null / non-numeric (or division by zero) gets `null` in the output cell — a
 * value is never fabricated. `source` is not mutated.
 */
export function deriveMetric(source: DerivedGrid, spec: DerivedMetricSpec): DerivedMetricResult {
  const output = spec.output.trim();
  if (output === "") return { ok: false, error: "output column name is empty" };
  if (source.columns.some((c) => c.trim().toLowerCase() === output.toLowerCase())) {
    return { ok: false, error: `output column "${output}" already exists in this result` };
  }
  if (!DERIVED_METRIC_OPERATORS.includes(spec.operator)) {
    return { ok: false, error: `unknown operator "${spec.operator}"` };
  }

  const li = resolveColumn(source.columns, spec.left);
  if (typeof li !== "number") return { ok: false, error: li.error };

  const hasRight = typeof spec.right === "string" && spec.right.trim() !== "";
  const hasScalar = typeof spec.scalar === "number" && Number.isFinite(spec.scalar);
  if (hasRight === hasScalar) {
    return { ok: false, error: "provide exactly one of `right` (a column) or `scalar` (a number)" };
  }
  if (hasScalar && (spec.operator === "pct_change" || spec.operator === "pp_change")) {
    return { ok: false, error: `${spec.operator} needs a right column, not a scalar` };
  }

  let ri = -1;
  if (hasRight) {
    const resolved = resolveColumn(source.columns, spec.right as string);
    if (typeof resolved !== "number") return { ok: false, error: resolved.error };
    ri = resolved;
  }

  const rows = source.rows.map((row) => {
    const a = toNumber(row[li] ?? null);
    const b = hasScalar ? (spec.scalar as number) : toNumber(row[ri] ?? null);
    const value: CellValue = a === null || b === null ? null : (apply(spec.operator, a, b) ?? null);
    return [...row, value];
  });

  return { ok: true, grid: { columns: [...source.columns, output], rows } };
}

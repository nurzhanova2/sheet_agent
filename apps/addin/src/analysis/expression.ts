import { columnLettersToIndex } from "../app/a1.js";
import type { Dataset, DatasetColumn } from "./dataset.js";
import { excelSerialToISO } from "./dataset.js";
import {
  ANALYSIS_LIMITS,
  type CellPrimitive,
  type ColumnRef,
  type Condition,
  type ConditionGroup,
  type ConditionInput,
  type Expression,
  type PercentLiteral,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for `{ kind: "percent", value: <number> }`. */
export function isPercentLiteral(value: unknown): value is PercentLiteral {
  return isRecord(value) && value["kind"] === "percent" && typeof value["value"] === "number" && Number.isFinite(value["value"]);
}

/** True for a bare column reference `{ column: "Name" }` (NOT the Expression node `{ kind:"column", name }`). */
export function isColumnRef(value: unknown): value is ColumnRef {
  return isRecord(value) && typeof value["column"] === "string" && value["column"].length > 0 && !("kind" in value);
}

/** True for any Expression-shaped node (`{ kind: ... }`). */
function isExpressionOperand(value: unknown): value is Expression {
  return isRecord(value) && typeof value["kind"] === "string";
}

/** True for a bare `{ left, operator, value }` (a Condition, not a ConditionGroup). */
function isBareCondition(value: unknown): value is Condition {
  return isRecord(value) && typeof value["operator"] === "string" && !("all" in value) && !("any" in value);
}

/**
 * Every `where` field accepts either a ConditionGroup (`{all?,any?}`) or a single
 * bare Condition. A bare Condition is normalized to `{ all: [condition] }` so it
 * is actually evaluated — a bare condition used to silently match every row.
 */
export function normalizeConditionGroup(input: ConditionInput | undefined): ConditionGroup | undefined {
  if (input === undefined) return undefined;
  if (isBareCondition(input)) return { all: [input] };
  return input as ConditionGroup;
}

export class AnalysisRequestError extends Error {
  constructor(
    readonly code: "UNKNOWN_COLUMN" | "AMBIGUOUS_COLUMN" | "INVALID_EXPRESSION" | "INVALID_CONDITION",
    message: string,
  ) {
    super(message);
    this.name = "AnalysisRequestError";
  }
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/\s+/g, "").trim();
}

/**
 * Resolves a column reference to a dataset column. Order: exact header, then
 * whitespace/case-insensitive header, then A1 column letter. Ambiguous or unknown
 * references throw a structured error — a column is never silently guessed.
 */
export function resolveColumn(dataset: Dataset, reference: string): DatasetColumn {
  const trimmed = String(reference).trim();
  const exact = dataset.columns.filter((column) => column.name === trimmed);
  if (exact.length === 1) return exact[0] as DatasetColumn;
  if (exact.length > 1) throw new AnalysisRequestError("AMBIGUOUS_COLUMN", `Column "${trimmed}" matches ${exact.length} headers exactly.`);

  const target = normalizeHeader(trimmed);
  const fuzzy = dataset.columns.filter((column) => normalizeHeader(column.name) === target);
  if (fuzzy.length === 1) return fuzzy[0] as DatasetColumn;
  if (fuzzy.length > 1) {
    throw new AnalysisRequestError("AMBIGUOUS_COLUMN", `Column "${trimmed}" is ambiguous: matches ${fuzzy.map((column) => column.name).join(", ")}.`);
  }

  if (/^[A-Za-z]{1,3}$/.test(trimmed)) {
    const index = columnLettersToIndex(trimmed);
    const byLetter = dataset.columns[index];
    if (byLetter) return byLetter;
  }

  throw new AnalysisRequestError(
    "UNKNOWN_COLUMN",
    `Column "${trimmed}" was not found. Available columns: ${dataset.headers.join(", ")}.`,
  );
}

export function expressionDepth(expression: Expression): number {
  switch (expression.kind) {
    case "column":
    case "literal":
    case "percent":
      return 1;
    case "abs":
    case "neg":
      return 1 + expressionDepth(expression.value);
    default:
      return 1 + Math.max(expressionDepth(expression.left), expressionDepth(expression.right));
  }
}

/** Lists every column name referenced by an expression (for validation and provenance). */
export function expressionColumns(expression: Expression): string[] {
  switch (expression.kind) {
    case "column":
      return [expression.name];
    case "literal":
    case "percent":
      return [];
    case "abs":
    case "neg":
      return expressionColumns(expression.value);
    default:
      return [...expressionColumns(expression.left), ...expressionColumns(expression.right)];
  }
}

/** Evaluates a numeric expression for one data row. Returns null if any input is missing/non-numeric or on divide-by-zero. */
export function evaluateExpression(dataset: Dataset, expression: Expression, rowIndex: number): number | null {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "percent":
      return expression.value / 100;
    case "column": {
      const column = resolveColumn(dataset, expression.name);
      return column.numeric[rowIndex] ?? null;
    }
    case "abs": {
      const value = evaluateExpression(dataset, expression.value, rowIndex);
      return value === null ? null : Math.abs(value);
    }
    case "neg": {
      const value = evaluateExpression(dataset, expression.value, rowIndex);
      return value === null ? null : -value;
    }
    default: {
      const left = evaluateExpression(dataset, expression.left, rowIndex);
      const right = evaluateExpression(dataset, expression.right, rowIndex);
      if (left === null || right === null) return null;
      if (expression.kind === "add") return left + right;
      if (expression.kind === "subtract") return left - right;
      if (expression.kind === "multiply") return left * right;
      return right === 0 ? null : left / right;
    }
  }
}

function conditionLeftLabel(condition: Condition): string {
  return isColumnRef(condition.left) ? condition.left.column : (condition.left as Expression).kind;
}

/** RHS of a condition, resolved for one row: its numeric view, its text view, and
 *  the column it came from (when the RHS is a column reference). Primitive strings
 *  are coerced against the LEFT column so an ISO date / "20%" string still parses. */
function resolveRight(
  dataset: Dataset,
  raw: Condition["value"],
  leftColumn: DatasetColumn | null,
  rowIndex: number,
): { numeric: number | null; text: string | null } {
  if (isPercentLiteral(raw)) {
    return { numeric: raw.value / 100, text: String(raw.value / 100) };
  }
  if (isColumnRef(raw)) {
    const column = resolveColumn(dataset, raw.column);
    return { numeric: column.numeric[rowIndex] ?? null, text: column.text[rowIndex] ?? null };
  }
  if (isExpressionOperand(raw)) {
    const numeric = evaluateExpression(dataset, raw, rowIndex);
    return { numeric, text: numeric === null ? null : String(numeric) };
  }
  const primitive = raw as CellPrimitive;
  return { numeric: coerceNumber(primitive, leftColumn), text: primitive === null ? null : String(primitive) };
}

/** Evaluates a single condition for one data row. */
export function evaluateCondition(dataset: Dataset, condition: Condition, rowIndex: number): boolean {
  const { operator } = condition;
  const leftIsColumn = isColumnRef(condition.left);
  const column = leftIsColumn ? resolveColumn(dataset, (condition.left as ColumnRef).column) : null;

  if (operator === "contains" || operator === "not_contains") {
    if (!column) throw new AnalysisRequestError("INVALID_CONDITION", `"${operator}" requires a column on the left, not an expression.`);
    const hay = (column.text[rowIndex] ?? "").toLowerCase();
    const needle = String(resolveRight(dataset, condition.value, column, rowIndex).text ?? "").toLowerCase();
    const has = needle.length > 0 && hay.includes(needle);
    return operator === "contains" ? has : !has;
  }

  const numericColumn = !column || column.type === "number" || column.type === "date";
  const ordering = operator === ">" || operator === ">=" || operator === "<" || operator === "<=";

  const numericLeft = leftIsColumn ? column?.numeric[rowIndex] ?? null : evaluateExpression(dataset, condition.left as Expression, rowIndex);
  const right = resolveRight(dataset, condition.value, column, rowIndex);

  if (numericLeft !== null && right.numeric !== null) {
    return compareNumbers(numericLeft, right.numeric, operator);
  }

  // A missing/non-numeric value on the left of a numeric-only operator just fails the
  // predicate for that row — it never aborts the whole analysis.
  if (ordering) {
    if (!numericColumn) {
      throw new AnalysisRequestError(
        "INVALID_CONDITION",
        `Cannot apply "${operator}" to the non-numeric column "${conditionLeftLabel(condition)}".`,
      );
    }
    return false;
  }

  // = / != fall back to normalised string comparison
  const leftText = column ? column.text[rowIndex] ?? null : numericLeft === null ? null : String(numericLeft);
  const equal = normalizeText(leftText) === normalizeText(right.text);
  return operator === "=" ? equal : !equal;
}

function normalizeText(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function coerceNumber(value: CellPrimitive, column: DatasetColumn | null): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (column?.type === "date") {
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return isoToSerial(trimmed);
    }
    const asNumber = Number(trimmed.replace(/[\s,%]/g, ""));
    if (trimmed.endsWith("%") && Number.isFinite(asNumber)) return asNumber / 100;
    return Number.isFinite(asNumber) && trimmed !== "" ? asNumber : null;
  }
  return null;
}

function isoToSerial(iso: string): number {
  const ms = Date.parse(iso);
  return ms / 86_400_000 + 25_569;
}

function compareNumbers(left: number, right: number, operator: string): boolean {
  switch (operator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    default:
      return false;
  }
}

/**
 * Evaluates a condition group. Accepts a ConditionGroup or a bare Condition (the
 * latter is normalized to `{all:[condition]}`). An empty group matches every row;
 * a bare condition that reached here un-normalized used to do the same silently —
 * hence the explicit normalize.
 */
export function evaluateGroup(dataset: Dataset, group: ConditionInput | undefined, rowIndex: number): boolean {
  const normalized = normalizeConditionGroup(group);
  if (!normalized) return true;
  const all = normalized.all ?? [];
  const any = normalized.any ?? [];
  if (all.length + any.length > ANALYSIS_LIMITS.maxConditions) {
    throw new AnalysisRequestError("INVALID_CONDITION", `Too many conditions (max ${ANALYSIS_LIMITS.maxConditions}).`);
  }
  if (all.length + any.length === 0) return true;
  const allPass = all.every((condition) => evaluateCondition(dataset, condition, rowIndex));
  const anyPass = any.length === 0 || any.some((condition) => evaluateCondition(dataset, condition, rowIndex));
  return allPass && anyPass;
}

export function matchingRowIndexes(dataset: Dataset, group: ConditionInput | undefined): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < dataset.rowCount; index += 1) {
    if (evaluateGroup(dataset, group, index)) indexes.push(index);
  }
  return indexes;
}

/** Human-readable value for a cell in a result row (ISO for dates). */
export function displayValue(column: DatasetColumn, rowIndex: number): CellPrimitive {
  if (column.type === "date") {
    const serial = column.numeric[rowIndex];
    return serial === null || serial === undefined ? null : excelSerialToISO(serial);
  }
  return (column.values[rowIndex] ?? null) as CellPrimitive;
}

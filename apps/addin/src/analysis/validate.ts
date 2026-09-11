import {
  ANALYSIS_LIMITS,
  type AnalysisError,
  type AnalysisRequest,
  type ComparisonOperator,
  type Condition,
  type ConditionGroup,
  type Expression,
} from "./types.js";

const EXPRESSION_KINDS = new Set(["column", "literal", "percent", "abs", "neg", "add", "subtract", "multiply", "divide"]);
const OPERATORS = new Set<ComparisonOperator>(["=", "!=", ">", ">=", "<", "<=", "contains", "not_contains"]);
const OPS = new Set([
  "count",
  "aggregate",
  "filter",
  "sort",
  "top_n",
  "bottom_n",
  "distinct",
  "group_by",
  "summary_statistics",
  "correlation",
  "group_correlation",
  "outliers",
]);
const AGG_METRICS = new Set(["count", "sum", "mean", "min", "max", "median"]);

function fail(code: AnalysisError["code"], error: string, detail?: string): AnalysisError {
  return detail === undefined ? { code, error } : { code, error, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExpression(value: unknown, depth: number): string | null {
  if (depth > ANALYSIS_LIMITS.maxExpressionDepth) return `expression nested deeper than ${ANALYSIS_LIMITS.maxExpressionDepth}`;
  if (!isRecord(value)) return "expression must be an object";
  const kind = value["kind"];
  if (typeof kind !== "string" || !EXPRESSION_KINDS.has(kind)) return `unknown expression kind "${String(kind)}"`;
  if (kind === "column") return typeof value["name"] === "string" && value["name"].length > 0 ? null : "column expression needs a string name";
  if (kind === "literal" || kind === "percent") return typeof value["value"] === "number" && Number.isFinite(value["value"]) ? null : `${kind} expression needs a finite number`;
  if (kind === "abs" || kind === "neg") return validateExpression(value["value"], depth + 1);
  const left = validateExpression(value["left"], depth + 1);
  if (left) return left;
  return validateExpression(value["right"], depth + 1);
}

function validateConditionSide(left: unknown): string | null {
  if (isRecord(left) && typeof left["column"] === "string") return null;
  return validateExpression(left, 1);
}

function isPercentLiteralValue(value: unknown): boolean {
  return isRecord(value) && value["kind"] === "percent" && typeof value["value"] === "number" && Number.isFinite(value["value"]);
}

/** RHS of a condition: literal, percent literal, column reference, or a safe expression. */
function validateConditionValue(rhs: unknown): string | null {
  if (rhs === null || typeof rhs === "string" || typeof rhs === "number" || typeof rhs === "boolean") return null;
  if (isPercentLiteralValue(rhs)) return null;
  if (isRecord(rhs) && typeof rhs["column"] === "string" && rhs["column"].length > 0 && !("kind" in rhs)) return null;
  if (isRecord(rhs) && typeof rhs["kind"] === "string") return validateExpression(rhs, 1);
  return 'condition.value must be a string, number, boolean, null, {"kind":"percent","value":N}, {"column":"Name"}, or an expression';
}

function validateCondition(value: unknown): string | null {
  if (!isRecord(value)) return "condition must be an object";
  const operator = value["operator"];
  if (typeof operator !== "string" || !OPERATORS.has(operator as ComparisonOperator)) return `unknown operator "${String(operator)}"`;
  const sideError = validateConditionSide(value["left"]);
  if (sideError) return `condition.left: ${sideError}`;
  const rhsError = validateConditionValue(value["value"]);
  if (rhsError) return `condition.value: ${rhsError}`;
  return null;
}

/** A bare `{left,operator,value}` used where a group is expected. */
function isBareConditionRecord(value: Record<string, unknown>): boolean {
  return typeof value["operator"] === "string" && !("all" in value) && !("any" in value);
}

function validateGroup(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "where must be an object: a single {left,operator,value} or {all:[...]}/{any:[...]}";
  if (isBareConditionRecord(value)) return validateCondition(value);
  const all = value["all"];
  const any = value["any"];
  const conditions: unknown[] = [];
  if (all !== undefined) {
    if (!Array.isArray(all)) return "where.all must be an array";
    conditions.push(...all);
  }
  if (any !== undefined) {
    if (!Array.isArray(any)) return "where.any must be an array";
    conditions.push(...any);
  }
  if (conditions.length > ANALYSIS_LIMITS.maxConditions) return `too many conditions (max ${ANALYSIS_LIMITS.maxConditions})`;
  for (const condition of conditions) {
    const error = validateCondition(condition);
    if (error) return error;
  }
  return null;
}

function positiveInt(value: unknown, max: number, label: string): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return `${label} must be a positive integer`;
  if (value > max) return `${label} exceeds the maximum of ${max}`;
  return null;
}

/**
 * Structural validation of an untrusted analysis request: allow-listed op, expression
 * kinds, operators, and every numeric limit. Column existence is checked at execution.
 */
export function validateAnalysisRequest(request: unknown): AnalysisError | null {
  if (!isRecord(request)) return fail("INVALID_REQUEST", "analysis request must be an object");
  const op = request["op"];
  if (typeof op !== "string" || !OPS.has(op)) return fail("UNKNOWN_OP", `unknown analysis op "${String(op)}"`);

  const groupError = validateGroup(request["where"]);
  if (groupError) return fail("INVALID_CONDITION", groupError);

  const check = (error: string | null, code: AnalysisError["code"] = "INVALID_REQUEST"): AnalysisError | null =>
    error ? fail(code, error) : null;

  switch (op) {
    case "count":
    case "summary_statistics":
      return null;
    case "aggregate": {
      if (!AGG_METRICS.has(String(request["metric"]))) return fail("INVALID_REQUEST", `unknown metric "${String(request["metric"])}"`);
      return check(validateExpression(request["target"], 1), "INVALID_EXPRESSION");
    }
    case "filter":
      if (request["where"] === undefined) return fail("INVALID_REQUEST", "filter requires `where`");
      return request["limit"] === undefined ? null : check(positiveInt(request["limit"], ANALYSIS_LIMITS.maxResultRows, "limit"), "LIMIT_EXCEEDED");
    case "sort": {
      if (request["direction"] !== "asc" && request["direction"] !== "desc") return fail("INVALID_REQUEST", "sort.direction must be 'asc' or 'desc'");
      const byError = check(validateExpression(request["by"], 1), "INVALID_EXPRESSION");
      if (byError) return byError;
      return request["limit"] === undefined ? null : check(positiveInt(request["limit"], ANALYSIS_LIMITS.maxResultRows, "limit"), "LIMIT_EXCEEDED");
    }
    case "top_n":
    case "bottom_n": {
      const nError = check(positiveInt(request["n"], ANALYSIS_LIMITS.maxN, "n"), "LIMIT_EXCEEDED");
      if (nError) return nError;
      return check(validateExpression(request["by"], 1), "INVALID_EXPRESSION");
    }
    case "distinct":
      return typeof request["column"] === "string" && request["column"].length > 0 ? null : fail("INVALID_REQUEST", "distinct requires a string `column`");
    case "correlation": {
      const xError = check(validateExpression(request["x"], 1), "INVALID_EXPRESSION");
      return xError ?? check(validateExpression(request["y"], 1), "INVALID_EXPRESSION");
    }
    case "group_correlation": {
      const by = request["by"];
      if (!Array.isArray(by) || by.length === 0 || by.some((entry) => typeof entry !== "string" || entry.length === 0)) {
        return fail("INVALID_REQUEST", "group_correlation.by must be a non-empty array of column names");
      }
      if (by.length > ANALYSIS_LIMITS.maxGroupDimensions) return fail("LIMIT_EXCEEDED", `group_correlation supports at most ${ANALYSIS_LIMITS.maxGroupDimensions} dimensions`);
      const gxError = check(validateExpression(request["x"], 1), "INVALID_EXPRESSION");
      return gxError ?? check(validateExpression(request["y"], 1), "INVALID_EXPRESSION");
    }
    case "outliers": {
      if (request["method"] !== "iqr" && request["method"] !== "zscore") return fail("INVALID_REQUEST", "outliers.method must be 'iqr' or 'zscore'");
      if (request["threshold"] !== undefined && (typeof request["threshold"] !== "number" || !Number.isFinite(request["threshold"]) || request["threshold"] <= 0)) {
        return fail("INVALID_REQUEST", "outliers.threshold must be a positive number");
      }
      return check(validateExpression(request["target"], 1), "INVALID_EXPRESSION");
    }
    case "group_by": {
      const by = request["by"];
      if (!Array.isArray(by) || by.length === 0 || by.some((entry) => typeof entry !== "string" || entry.length === 0)) {
        return fail("INVALID_REQUEST", "group_by.by must be a non-empty array of column names");
      }
      if (by.length > ANALYSIS_LIMITS.maxGroupDimensions) return fail("LIMIT_EXCEEDED", `group_by supports at most ${ANALYSIS_LIMITS.maxGroupDimensions} dimensions`);
      const metrics = request["metrics"];
      if (!Array.isArray(metrics) || metrics.length === 0) return fail("INVALID_REQUEST", "group_by requires a non-empty `metrics` array");
      if (metrics.length > ANALYSIS_LIMITS.maxMetricsPerGroupBy) return fail("LIMIT_EXCEEDED", `too many metrics (max ${ANALYSIS_LIMITS.maxMetricsPerGroupBy})`);
      for (const metric of metrics) {
        if (!isRecord(metric) || !AGG_METRICS.has(String(metric["metric"]))) return fail("INVALID_REQUEST", `group_by metric "${String(isRecord(metric) ? metric["metric"] : metric)}" is not allowed`);
        if (metric["metric"] !== "count") {
          const targetError = validateExpression(metric["target"], 1);
          if (targetError) return fail("INVALID_EXPRESSION", `group_by metric target: ${targetError}`);
        }
        const metricWhere = validateGroup(metric["where"]);
        if (metricWhere) return fail("INVALID_CONDITION", `group_by metric where: ${metricWhere}`);
      }
      const sort = request["sort"];
      if (sort !== undefined) {
        if (!isRecord(sort)) return fail("INVALID_REQUEST", "group_by.sort must be an object");
        if (sort["direction"] !== "asc" && sort["direction"] !== "desc") {
          return fail("INVALID_REQUEST", "group_by.sort.direction must be 'asc' or 'desc'");
        }
        const sortBy = sort["by"];
        if (typeof sortBy !== "string" || sortBy.length === 0) {
          const sortError = validateExpression(sortBy, 1);
          if (sortError) return fail("INVALID_EXPRESSION", `group_by.sort.by: ${sortError}`);
        }
      }
      return request["limit"] === undefined ? null : check(positiveInt(request["limit"], ANALYSIS_LIMITS.maxGroups, "limit"), "LIMIT_EXCEEDED");
    }
    default:
      return fail("UNKNOWN_OP", `unknown analysis op "${op}"`);
  }
}

export type { AnalysisRequest, Condition, ConditionGroup, Expression };

import { normalizeConditionGroup } from "./expression.js";
import type {
  AnalysisRequest,
  Condition,
  ConditionGroup,
  ConditionInput,
  Expression,
  GroupMetric,
  SortSpec,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively sorts object keys so structurally-equal values stringify identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Canonical form of a numeric expression. Commutative operands are ordered; nested abs/neg folded. */
export function canonicalizeExpression(expression: Expression): Expression {
  switch (expression.kind) {
    case "column":
    case "literal":
    case "percent":
      return expression;
    case "neg": {
      const inner = canonicalizeExpression(expression.value);
      if (inner.kind === "neg") return inner.value; // neg(neg(x)) → x
      if (inner.kind === "literal") return { kind: "literal", value: -inner.value };
      return { kind: "neg", value: inner };
    }
    case "abs": {
      const inner = canonicalizeExpression(expression.value);
      if (inner.kind === "abs") return inner; // abs(abs(x)) → abs(x)
      if (inner.kind === "neg") return canonicalizeExpression({ kind: "abs", value: inner.value }); // abs(-x) → abs(x)
      if (inner.kind === "literal") return { kind: "literal", value: Math.abs(inner.value) };
      return { kind: "abs", value: inner };
    }
    default: {
      const left = canonicalizeExpression(expression.left);
      const right = canonicalizeExpression(expression.right);
      if (expression.kind === "add" || expression.kind === "multiply") {
        const ordered = [left, right].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
        return { kind: expression.kind, left: ordered[0] as Expression, right: ordered[1] as Expression };
      }
      return { kind: expression.kind, left, right };
    }
  }
}

function canonicalizeOperand(operand: Condition["left"] | Condition["value"]): Condition["value"] {
  if (isRecord(operand) && typeof operand["kind"] === "string") {
    return canonicalizeExpression(operand as Expression);
  }
  return operand;
}

function canonicalizeCondition(condition: Condition): Condition {
  return {
    left: canonicalizeOperand(condition.left) as Condition["left"],
    operator: condition.operator,
    value: canonicalizeOperand(condition.value),
  };
}

function canonicalizeGroup(input: ConditionInput | undefined): ConditionGroup | undefined {
  const normalized = normalizeConditionGroup(input);
  if (!normalized) return undefined;
  const sortConds = (list: readonly Condition[] | undefined) =>
    list && list.length > 0
      ? [...list].map(canonicalizeCondition).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
      : undefined;
  const all = sortConds(normalized.all);
  const any = sortConds(normalized.any);
  const group: ConditionGroup = {};
  if (all) (group as { all?: readonly Condition[] }).all = all;
  if (any) (group as { any?: readonly Condition[] }).any = any;
  return all || any ? group : undefined;
}

function canonicalizeMetric(metric: GroupMetric): GroupMetric {
  const where = canonicalizeGroup(metric.where);
  return {
    ...(metric.name !== undefined ? { name: metric.name } : {}),
    metric: metric.metric,
    ...(metric.target ? { target: canonicalizeExpression(metric.target) } : {}),
    ...(where ? { where } : {}),
  };
}

function canonicalizeSort(sort: SortSpec | undefined): SortSpec | undefined {
  if (!sort) return undefined;
  return {
    by: typeof sort.by === "string" ? sort.by : canonicalizeExpression(sort.by),
    direction: sort.direction,
  };
}

/**
 * Returns a structurally-canonical copy of an analysis request. Equivalent plans
 * map to deep-equal objects; use {@link canonicalKey} for a stable string identity.
 */
export function canonicalizeAnalysisRequest(request: AnalysisRequest): AnalysisRequest {
  const where = "where" in request ? canonicalizeGroup(request.where) : undefined;
  const withWhere = <T>(base: T): T => (where ? { ...base, where } : base);

  switch (request.op) {
    case "count":
      return withWhere({ op: "count" }) as AnalysisRequest;
    case "aggregate":
      return withWhere({ op: "aggregate", metric: request.metric, target: canonicalizeExpression(request.target) }) as AnalysisRequest;
    case "filter":
      return {
        op: "filter",
        where: canonicalizeGroup(request.where) ?? request.where,
        ...(request.columns ? { columns: [...request.columns] } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      } as AnalysisRequest;
    case "sort":
      return withWhere({
        op: "sort",
        by: canonicalizeExpression(request.by),
        direction: request.direction,
        ...(request.columns ? { columns: [...request.columns] } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      }) as AnalysisRequest;
    case "top_n":
    case "bottom_n":
      return withWhere({
        op: request.op,
        n: request.n,
        by: canonicalizeExpression(request.by),
        ...(request.columns ? { columns: [...request.columns] } : {}),
      }) as AnalysisRequest;
    case "distinct":
      return withWhere({ op: "distinct", column: request.column }) as AnalysisRequest;
    case "summary_statistics":
      return { op: "summary_statistics", ...(request.columns ? { columns: [...request.columns] } : {}) } as AnalysisRequest;
    case "correlation":
      return withWhere({ op: "correlation", x: canonicalizeExpression(request.x), y: canonicalizeExpression(request.y) }) as AnalysisRequest;
    case "group_correlation":
      return withWhere({
        op: "group_correlation",
        by: [...request.by],
        x: canonicalizeExpression(request.x),
        y: canonicalizeExpression(request.y),
      }) as AnalysisRequest;
    case "outliers":
      return withWhere({
        op: "outliers",
        target: canonicalizeExpression(request.target),
        method: request.method,
        ...(request.threshold !== undefined ? { threshold: request.threshold } : {}),
        ...(request.columns ? { columns: [...request.columns] } : {}),
      }) as AnalysisRequest;
    case "group_by": {
      const sort = canonicalizeSort(request.sort);
      const metrics = request.metrics.map(canonicalizeMetric);
      // Only reorder when every metric is explicitly named — otherwise the
      // engine derives metric names from position, so order is significant.
      const stableMetrics = metrics.every((metric) => typeof metric.name === "string" && metric.name.length > 0)
        ? [...metrics].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
        : metrics;
      return withWhere({
        op: "group_by",
        by: [...request.by],
        metrics: stableMetrics,
        ...(sort ? { sort } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      }) as AnalysisRequest;
    }
  }
}

/** Stable string identity for an analysis request — equal for all equivalent phrasings. */
export function canonicalKey(request: AnalysisRequest): string {
  return stableStringify(canonicalizeAnalysisRequest(request));
}

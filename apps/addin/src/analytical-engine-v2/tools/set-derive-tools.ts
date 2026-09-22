// ---------------------------------------------------------------------------
// Stage 26.2 §22/§23/§26/§30 — SET operations and derived columns.
//
// These are the tools that make §23 true: the planner NEVER reads a preview
// and declares a winner. It names the ranking basis — which field, and whether
// to compare by absolute size — and `set.argmax` scans every row of the given
// result to find it. That is Stage 25.1.3e's lesson expressed as an interface
// rather than as a downstream corrective audit.
//
// `derive.compute` accepts only the restricted AST from
// `app/schema/analytical/derive-expr.ts` — no code strings, no eval (§30).
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import { evalExpr, exprFields, isValidExpr, type ExprNode } from "../../app/schema/analytical/derive-expr.js";
import { fieldIndex, metricFieldIndex } from "../results/result-store.js";
import { PER_METRIC_ROW_TYPES, toolError, type EngineResult, type ResultType } from "../types.js";
import { inputResult, isErr, num, numberAt, numericPerMetricInput, perMetricFieldInput, type ToolSpec } from "./contracts.js";

const RANKABLE: readonly ResultType[] = [
  "metric_set",
  "comparison",
  "filtered_set",
  "ranked_set",
  "aggregate",
  "trend",
  "volatility",
  "stability",
  "monotonicity",
  "direction_changes",
  "temporal_pattern",
  "derived",
  "joined",
  "value",
  "table",
];

// Stage 26.3 §12/§13 — typed predicates. Numeric and categorical operators are
// separate vocabularies, validated against the FIELD's declared kind; there is
// deliberately no implicit numeric/string coercion in either direction.
const NUMERIC_OPS = ["<", "<=", ">", ">=", "==", "!=", "lt", "lte", "gt", "gte", "eq", "neq", "ne"] as const;
const STRING_OPS = ["==", "!=", "eq", "neq", "ne", "in", "not_in"] as const;

type NumericOp = "<" | "<=" | ">" | ">=" | "==" | "!=";
type StringOp = "eq" | "neq" | "in" | "not_in";

/** Both spellings of each comparison normalise to one canonical operator. */
const NUMERIC_ALIAS: Readonly<Record<string, NumericOp>> = {
  "<": "<",
  lt: "<",
  "<=": "<=",
  lte: "<=",
  ">": ">",
  gt: ">",
  ">=": ">=",
  gte: ">=",
  "==": "==",
  eq: "==",
  "!=": "!=",
  neq: "!=",
  ne: "!=",
};

const STRING_ALIAS: Readonly<Record<string, StringOp>> = {
  "==": "eq",
  eq: "eq",
  "!=": "neq",
  neq: "neq",
  ne: "neq",
  in: "in",
  not_in: "not_in",
};

function compare(a: number, op: NumericOp, b: number): boolean {
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "==":
      return a === b;
    default:
      return a !== b;
  }
}

function compareText(a: string, op: StringOp, b: string | readonly string[]): boolean {
  switch (op) {
    case "eq":
      return typeof b === "string" && a === b;
    case "neq":
      return typeof b === "string" && a !== b;
    case "in":
      return Array.isArray(b) && b.includes(a);
    default:
      return Array.isArray(b) && !b.includes(a);
  }
}

const setFilter: ToolSpec = {
  name: "set.filter",
  description:
    'Keep only the rows of an earlier per-metric result that satisfy a comparison. Works on a NUMERIC field (percentageChange < 0 keeps everything that fell) and equally on a CATEGORICAL one (direction eq "increasing" keeps the metrics that grew). Returns a filtered_set, and THAT restricted set is the answer to a "show only …" request, never its unfiltered input. A later ranking over this result stays confined to the rows it kept. Matching nothing is a valid answer, not an error: the result simply has no rows.',
  args: {
    inputRef: { type: "resultRef", required: true, describe: "the result to restrict" },
    field: { type: "string", required: true, describe: "a field of that result — numeric, or categorical like a direction label" },
    op: { type: "string", required: true, describe: 'numeric: "<" "<=" ">" ">=" "==" "!=" (or lt/lte/gt/gte/eq/neq); categorical: "eq" "neq" "in" "not_in"' },
    value: { type: "value", required: true, describe: "a number for a numeric field, a string for a categorical one, or a string list for in/not_in" },
  },
  returns: "filtered_set",
  accepts: RANKABLE,
  reads: false,
  run: (args, env) => {
    const input = perMetricFieldInput(args, env);
    if (isErr(input)) return input.error;
    const op = args["op"];
    const value = args["value"];
    if (typeof op !== "string") return toolError("INVALID_ARGUMENT", '"op" must be a comparison operator');

    // §13 — the FIELD's declared kind chooses the predicate vocabulary, and the
    // operand must match it. A string compared with ">", or a numeric field
    // given in(["increasing"]), is a category error rather than a near miss.
    let rows: readonly (readonly CellValue[])[];
    let normalizedOp: string;
    if (input.kind === "number") {
      const numericOp = NUMERIC_ALIAS[op];
      if (!numericOp) {
        return toolError("INVALID_ARGUMENT", `"${op}" is not a numeric comparison; "${input.field}" of "${input.src.resultId}" is numeric`, [...NUMERIC_OPS]);
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return toolError("INVALID_ARGUMENT", `"${input.field}" is numeric, so "value" must be a finite number`);
      }
      normalizedOp = numericOp;
      rows = input.src.rows.filter((r) => {
        const a = numberAt(r, input.index);
        return a !== null && compare(a, numericOp, value);
      });
    } else {
      const stringOp = STRING_ALIAS[op];
      if (!stringOp) {
        return toolError("INVALID_ARGUMENT", `"${op}" is not a categorical comparison; "${input.field}" of "${input.src.resultId}" is ${input.kind}`, [...STRING_OPS]);
      }
      const wantsList = stringOp === "in" || stringOp === "not_in";
      if (wantsList && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
        return toolError("INVALID_ARGUMENT", `"${stringOp}" needs "value" to be a list of strings`);
      }
      if (!wantsList && typeof value !== "string") {
        return toolError("INVALID_ARGUMENT", `"${input.field}" is ${input.kind}, so "value" must be a string`);
      }
      normalizedOp = stringOp;
      const operand = value as string | readonly string[];
      rows = input.src.rows.filter((r) => {
        const cellValue = r[input.index];
        return cellValue !== null && cellValue !== undefined && compareText(String(cellValue), stringOp, operand);
      });
    }

    // §14 — ZERO MATCHES IS A RESULT, NOT A FAILURE. "No indicator declined" is
    // a true analytical finding; returning INCOMPATIBLE_INPUT here made it
    // unsayable and sent the planner into a retry loop it could not escape.
    return {
      ok: true,
      result: env.store.put({
        tool: "set.filter",
        type: "filtered_set",
        fields: input.src.fields,
        rows,
        periodCanonicals: input.src.periodCanonicals,
        parents: [input.src.resultId],
        metadata: { predicate: { field: input.field, op: normalizedOp, value }, inputRowCount: input.src.rows.length, matched: rows.length },
      }),
    };
  },
};

function ordered(name: "set.sort" | "set.top" | "set.bottom"): ToolSpec {
  const slice = name !== "set.sort";
  return {
    name,
    description:
      name === "set.sort"
        ? "Order the rows of an earlier per-metric result by a numeric field. Returns a ranked_set with the same rows in a new order. Ordering alone does not choose an answer — use set.argmax/set.argmin when the request asks for a single winner."
        : name === "set.top"
          ? "The N rows with the LARGEST values of a numeric field. Returns a ranked_set. Set magnitude=true to compare by absolute size, so a large fall can outrank a small rise. Use it when the request asks for several leaders, not one."
          : "The N rows with the SMALLEST values of a numeric field. Returns a ranked_set. Set magnitude=true to compare by absolute size.",
    args: {
      inputRef: { type: "resultRef", required: true, describe: "the result to order" },
      field: { type: "string", required: true, describe: "a numeric field of that result" },
      ...(slice ? { n: { type: "number", required: true, describe: "how many rows to keep" } } : { direction: { type: "string", describe: '"desc" (default) | "asc"' } }),
      magnitude: { type: "boolean", describe: "true to compare by |value| instead of signed value" },
    },
    returns: "ranked_set",
    accepts: RANKABLE,
    reads: false,
    run: (args, env) => {
      const input = numericPerMetricInput(args, env);
      if (isErr(input)) return input.error;
      const magnitude = args["magnitude"] === true;
      const descending = name === "set.top" || (name === "set.sort" && args["direction"] !== "asc");
      const score = (r: readonly CellValue[]): number => {
        const v = numberAt(r, input.index);
        if (v === null) return descending ? -Infinity : Infinity;
        return magnitude ? Math.abs(v) : v;
      };
      const sorted = [...input.src.rows].sort((a, b) => (descending ? score(b) - score(a) : score(a) - score(b)));
      let rows = sorted;
      if (slice) {
        const n = args["n"];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return toolError("INVALID_ARGUMENT", '"n" must be a positive whole number');
        rows = sorted.slice(0, n);
      }
      return {
        ok: true,
        result: env.store.put({
          tool: name,
          type: "ranked_set",
          fields: input.src.fields,
          rows,
          periodCanonicals: input.src.periodCanonicals,
          parents: [input.src.resultId],
          metadata: { ranking: { field: input.field, magnitude, direction: descending ? "desc" : "asc" }, candidateCount: input.src.rows.length },
        }),
      };
    },
  };
}

/** §23 — the tool picks the row; the planner only names the basis. */
function argExtreme(name: "set.argmax" | "set.argmin", direction: "max" | "min"): ToolSpec {
  return {
    name,
    description:
      direction === "max"
        ? "Select the ONE row of an earlier per-metric result whose numeric field is largest, scanning every row. Returns a metric_winner. Set magnitude=true when positive and negative values should be compared by absolute size — which is what a generic \"changed the most\" question means across metrics of different scales. Never pick a winner by reading a preview; call this."
        : "Select the ONE row whose numeric field is smallest, scanning every row. Returns a metric_winner. Set magnitude=true to compare by absolute size.",
    args: {
      inputRef: { type: "resultRef", required: true, describe: "the result to rank — its rows are the only candidates" },
      field: { type: "string", required: true, describe: "the numeric field that defines the ranking" },
      magnitude: { type: "boolean", describe: "true to rank by |value|; use it for a generic 'changed the most' comparison" },
    },
    returns: "metric_winner",
    accepts: RANKABLE,
    reads: false,
    run: (args, env) => {
      const input = numericPerMetricInput(args, env);
      if (isErr(input)) return input.error;
      // §15 — an empty input set is VALID but has no winner. Saying so with its
      // own code lets the planner complete on the empty set instead of
      // treating a true "nothing matched" as a malformed call.
      if (input.src.rows.length === 0) {
        return toolError("EMPTY_INPUT_SET", `"${input.src.resultId}" has no rows, so there is no winner to select — it is a valid empty result you can present as "nothing matched"`);
      }
      const magnitude = args["magnitude"] === true;
      const mi = metricFieldIndex(input.src);
      if (mi < 0) return toolError("INCOMPATIBLE_INPUT", `"${input.src.resultId}" has no metric column to rank`);

      let best: readonly CellValue[] | null = null;
      let bestScore = direction === "max" ? -Infinity : Infinity;
      let bestRaw = 0;
      for (const row of input.src.rows) {
        const raw = numberAt(row, input.index);
        if (raw === null) continue;
        const s = magnitude ? Math.abs(raw) : raw;
        if (direction === "max" ? s > bestScore : s < bestScore) {
          bestScore = s;
          bestRaw = raw;
          best = row;
        }
      }
      if (!best) return toolError("INCOMPATIBLE_INPUT", `no row of "${input.src.resultId}" has a numeric "${input.field}"`);
      const metricKey = String(best[mi] ?? "");
      if (!metricKey) return toolError("INCOMPATIBLE_INPUT", "the winning row carries no metric label");
      return {
        ok: true,
        result: env.store.put({
          tool: name,
          type: "metric_winner",
          fields: input.src.fields,
          rows: [best],
          metricKeys: [metricKey],
          periodCanonicals: input.src.periodCanonicals,
          parents: [input.src.resultId],
          metadata: {
            ranking: { field: input.field, magnitude, direction },
            winnerMetric: metricKey,
            winnerValue: bestRaw,
            candidateCount: input.src.rows.length,
            candidateResultRef: input.src.resultId,
          },
        }),
      };
    },
  };
}

function combine(name: "set.union" | "set.intersection"): ToolSpec {
  return {
    name,
    description:
      name === "set.union"
        ? "Every metric present in EITHER of two results. Returns a metric_set. Use it to widen a candidate set deliberately."
        : "Only the metrics present in BOTH results. Returns a metric_set. Use it to combine two conditions — for example metrics that both rose and are highly volatile.",
    args: {
      leftRef: { type: "resultRef", required: true, describe: "first result" },
      rightRef: { type: "resultRef", required: true, describe: "second result" },
    },
    returns: "metric_set",
    accepts: RANKABLE,
    reads: false,
    run: (args, env) => {
      const left = inputResult(args["leftRef"], env);
      if (isErr(left)) return left.error;
      const right = inputResult(args["rightRef"], env);
      if (isErr(right)) return right.error;
      for (const r of [left, right] as EngineResult[]) {
        if (!PER_METRIC_ROW_TYPES.has(r.type)) return toolError("INCOMPATIBLE_INPUT", `"${r.resultId}" is a ${r.type} result and has no metric universe to combine`);
      }
      const rightKeys = new Set(right.metricKeys);
      const keys = name === "set.union" ? [...new Set([...left.metricKeys, ...right.metricKeys])] : left.metricKeys.filter((k) => rightKeys.has(k));
      if (keys.length === 0) return toolError("INCOMPATIBLE_INPUT", "those two results have no metric in common");
      return {
        ok: true,
        result: env.store.put({
          tool: name,
          type: "metric_set",
          fields: [{ name: "metric", kind: "metric" }],
          rows: keys.map((k) => [k] as readonly CellValue[]),
          metricKeys: keys,
          parents: [left.resultId, right.resultId],
        }),
      };
    },
  };
}

const deriveCompute: ToolSpec = {
  name: "derive.compute",
  description:
    'Add one computed numeric column to an earlier per-metric result, using a restricted arithmetic expression over that result\'s own numeric fields. Returns a derived result you can then rank or filter. Use it when a request needs a ratio the tools do not provide directly — for example a normalised deviation, abs(latest - mean) / abs(mean), which makes metrics of different scales comparable. The expression is a small JSON tree: {"field":"name"}, {"const":1}, {"op":"add|subtract|multiply|divide","left":…,"right":…}, {"op":"abs|neg","value":…}. No code strings.',
  args: {
    inputRef: { type: "resultRef", required: true, describe: "the result to extend" },
    field: { type: "string", required: true, describe: "name for the NEW column (must not already exist)" },
    expr: { type: "object", required: true, describe: "the arithmetic tree over existing numeric fields" },
  },
  returns: "derived",
  accepts: RANKABLE,
  reads: false,
  run: (args, env) => {
    const src = inputResult(args["inputRef"], env);
    if (isErr(src)) return src.error;
    if (!PER_METRIC_ROW_TYPES.has(src.type)) return toolError("INCOMPATIBLE_INPUT", `"${src.resultId}" is a ${src.type} result — derive.compute needs one row per metric`);
    const field = typeof args["field"] === "string" ? args["field"] : "";
    if (!field) return toolError("INVALID_ARGUMENT", '"field" must be a new column name');
    if (fieldIndex(src, field) >= 0) return toolError("INVALID_ARGUMENT", `"${field}" already exists on "${src.resultId}" — choose a new column name`);
    if (!isValidExpr(args["expr"])) {
      return toolError("INVALID_ARGUMENT", 'expr must be a restricted arithmetic tree of {"field"} / {"const"} / {"op":"add|subtract|multiply|divide","left","right"} / {"op":"abs|neg","value"} nodes');
    }
    const expr = args["expr"] as ExprNode;
    const numericNames = new Set(src.fields.filter((f) => f.kind === "number").map((f) => f.name));
    const missing = [...exprFields(expr)].filter((f) => !numericNames.has(f));
    if (missing.length > 0) return toolError("INVALID_ARGUMENT", `expr reads unknown numeric field(s): ${missing.join(", ")}`, [...numericNames]);

    // Stage 26.4 §21 — `evalExpr` returns null for a missing field and for a
    // near-zero denominator, so a normalised deviation over a zero baseline
    // yields an EMPTY CELL rather than Infinity or NaN. Nothing non-finite can
    // reach the narrator's facts; the count is recorded for the trace.
    const rows: CellValue[][] = [];
    let undefinedCells = 0;
    for (const row of src.rows) {
      const scope: Record<string, number> = {};
      src.fields.forEach((f, i) => {
        const v = numberAt(row, i);
        if (v !== null) scope[f.name] = v;
      });
      const computed = evalExpr(expr, scope);
      if (computed === null) undefinedCells += 1;
      rows.push([...row, computed]);
    }
    return {
      ok: true,
      result: env.store.put({
        tool: "derive.compute",
        type: "derived",
        fields: [...src.fields, num(field)],
        rows,
        periodCanonicals: src.periodCanonicals,
        parents: [src.resultId],
        metadata: { derivedField: field, ...(undefinedCells > 0 ? { undefinedCells } : {}) },
      }),
    };
  },
};

export const SET_DERIVE_TOOLS: readonly ToolSpec[] = [
  setFilter,
  ordered("set.sort"),
  ordered("set.top"),
  ordered("set.bottom"),
  argExtreme("set.argmax", "max"),
  argExtreme("set.argmin", "min"),
  combine("set.union"),
  combine("set.intersection"),
  deriveCompute,
];

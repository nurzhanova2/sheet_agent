// ---------------------------------------------------------------------------
// Analysis planning protocol (Stage 21.1).
//
// For turns the application has classified as analytical or visualization
// (see app/intent.ts), the model is asked for a PLAN before it may write a
// final answer. The plan is a typed, validated structure — the model cannot
// "direct answer" its way past a deterministic computation.
// ---------------------------------------------------------------------------

import type { TurnIntent } from "../app/intent.js";
import { validateAnalysisRequest } from "./validate.js";
import { stableStringify } from "./canonical.js";
import { ANALYSIS_LIMITS, type AnalysisRequest, type Expression, type GroupMetric } from "./types.js";

export const PLAN_FENCE = /```sheet-agent-plan\s*([\s\S]*?)```/;

export type AnalysisPlan =
  | { readonly kind: "direct_answer" }
  | { readonly kind: "analysis"; readonly operations: readonly AnalysisRequest[] }
  | { readonly kind: "visualization"; readonly chart: unknown; readonly operations: readonly AnalysisRequest[] };

export interface PlanError {
  readonly code:
    | "PLAN_NOT_JSON"
    | "PLAN_SHAPE"
    | "PLAN_EMPTY"
    | "PLAN_TOO_MANY_OPS"
    | "PLAN_INVALID_OP"
    | "PLAN_REQUIRES_ANALYSIS"
    | "PLAN_REQUIRES_VISUALIZATION"
    | "PLAN_MISSING_ABS"
    | "PLAN_AGGREGATE_SCOPE";
  readonly error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanError(value: AnalysisPlan | PlanError): value is PlanError {
  return "code" in value && "error" in value;
}

/** Parses and structurally validates a plan payload (already extracted from the fence). */
export function parsePlan(raw: unknown): AnalysisPlan | PlanError {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { code: "PLAN_NOT_JSON", error: "the plan block was not valid JSON" };
    }
  }
  if (!isRecord(value)) return { code: "PLAN_SHAPE", error: "plan must be a JSON object with a `kind`" };
  const kind = value["kind"];

  if (kind === "direct_answer") return { kind: "direct_answer" };

  if (kind === "analysis" || kind === "visualization") {
    const opsRaw = value["operations"];
    const operations: AnalysisRequest[] = [];
    if (opsRaw !== undefined) {
      if (!Array.isArray(opsRaw)) return { code: "PLAN_SHAPE", error: "plan.operations must be an array" };
      if (opsRaw.length > ANALYSIS_LIMITS.maxOpsPerTurn) {
        return { code: "PLAN_TOO_MANY_OPS", error: `plan has ${opsRaw.length} operations (max ${ANALYSIS_LIMITS.maxOpsPerTurn})` };
      }
      for (const op of opsRaw) {
        const structural = validateAnalysisRequest(op);
        if (structural) return { code: "PLAN_INVALID_OP", error: `operation rejected (${structural.code}): ${structural.error}` };
        operations.push(op as AnalysisRequest);
      }
    }
    if (kind === "analysis") {
      if (operations.length === 0) return { code: "PLAN_EMPTY", error: "an analysis plan needs at least one operation" };
      return { kind: "analysis", operations };
    }
    if (value["chart"] === undefined) return { code: "PLAN_REQUIRES_VISUALIZATION", error: "a visualization plan needs a `chart` request" };
    return { kind: "visualization", chart: value["chart"], operations };
  }

  return { code: "PLAN_SHAPE", error: `plan.kind must be "analysis", "visualization" or "direct_answer" (got "${String(kind)}")` };
}

/**
 * The application-side guard. A turn the app flagged as analytical/visualization
 * may not resolve to `direct_answer`, and a visualization turn must produce a
 * visualization plan.
 */
export function assertPlanAllowed(plan: AnalysisPlan, intent: TurnIntent): PlanError | null {
  if (intent.visualization && plan.kind !== "visualization") {
    return {
      code: "PLAN_REQUIRES_VISUALIZATION",
      error: "this turn asks for a chart; respond with a visualization plan (kind:\"visualization\").",
    };
  }
  if (intent.analytical && plan.kind === "direct_answer") {
    return {
      code: "PLAN_REQUIRES_ANALYSIS",
      error:
        "this turn needs an exact spreadsheet computation; respond with an analysis plan (kind:\"analysis\") whose operations produce every number you will cite.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Modifier enforcement (Stage 21.2 §8, §9). The planner is not allowed to
// silently drop a word the user wrote:
//   - "absolute" / "по модулю"  →  mean(abs(x)), NOT mean(x) or abs(mean(x))
//   - "average A, B and C"      →  mean applied to EVERY listed metric
// These are detected from the raw prompt and checked against the typed plan.
// ---------------------------------------------------------------------------

// NOTE: JS \w is ASCII-only, so Cyrillic stems use an explicit [а-яё] class.
const ABS_MARKERS = /(абсолютн[а-яё]*|по\s+модул[а-яё]+|модул[а-яё]+\s+значени[а-яё]+|absolute\s+value|\bin\s+absolute\b|\bmagnitude\b)/i;
const DEVIATION_MARKERS = /(variance|отклонен[а-яё]*|deviation|разброс[а-яё]*)/i;

type AggWord = "mean" | "sum" | "median";
const AGG_WORDS: readonly { readonly re: RegExp; readonly agg: AggWord; readonly word: string }[] = [
  { re: /(средн[а-яё]+|average|\bmean\b|\bavg\b)/i, agg: "mean", word: "average" },
  { re: /(суммарн[а-яё]+|сумм[а-яё]+|\btotal\b|\bsum\b)/i, agg: "sum", word: "sum/total" },
  { re: /(медиан[а-яё]+|\bmedian\b)/i, agg: "median", word: "median" },
];

function metricColumn(metric: GroupMetric): string | null {
  const target = metric.target as Expression | undefined;
  if (target && target.kind === "column") return target.name;
  return null;
}

function planOperations(plan: AnalysisPlan): readonly AnalysisRequest[] {
  return plan.kind === "analysis" || plan.kind === "visualization" ? plan.operations : [];
}

/**
 * Enforces the user's aggregation / absolute-value modifiers against the typed plan.
 * Returns a PlanError (which triggers one corrected re-plan) when a modifier was dropped.
 */
export function assertPlanModifiersHonored(
  plan: AnalysisPlan,
  prompt: string,
  headers: readonly string[],
): PlanError | null {
  const operations = planOperations(plan);
  if (operations.length === 0) return null;

  // §8 — an "absolute" request must wrap a column in abs() somewhere in the plan.
  if (ABS_MARKERS.test(prompt) && DEVIATION_MARKERS.test(prompt)) {
    const hasAbs = operations.some((op) => stableStringify(op).includes('"kind":"abs"'));
    if (!hasAbs) {
      return {
        code: "PLAN_MISSING_ABS",
        error:
          'the request asks for an ABSOLUTE value. Wrap the column in {"kind":"abs","value":{"kind":"column","name":"..."}} inside the metric target — mean(abs(x)) is not the same as abs(mean(x)) or mean(x).',
      };
    }
  }

  // §9 — "average A, B and C" applies the SAME aggregate to every listed metric.
  const lower = ` ${prompt.toLowerCase()} `;
  const scopeMatch = lower.match(/(средн[а-яё]+|average|\bmean\b|суммарн[а-яё]+|сумм[а-яё]+|\btotal\b|\bsum\b|медиан[а-яё]+|\bmedian\b)\s+([^.?!;\n]{0,160})/);
  if (scopeMatch) {
    const scopeWord = AGG_WORDS.find((entry) => entry.re.test(scopeMatch[1] ?? ""));
    const listText = ` ${scopeMatch[2] ?? ""} `;
    if (scopeWord) {
      // headers that appear in the list following the scope word
      const listed = headers.filter((header) => listText.includes(header.toLowerCase()));
      for (const op of operations) {
        if (op.op !== "group_by") continue;
        for (const metric of op.metrics) {
          const column = metricColumn(metric);
          if (!column || !listed.includes(column)) continue;
          // an explicit different aggregate word right next to this column overrides the scope
          const overridden = AGG_WORDS.some(
            (entry) =>
              entry.agg !== scopeWord.agg &&
              new RegExp(`${entry.re.source}[^.?!;\\n]{0,24}${escapeRegExp(column.toLowerCase())}|${escapeRegExp(column.toLowerCase())}[^.?!;\\n]{0,24}${entry.re.source}`, "i").test(lower),
          );
          if (!overridden && metric.metric !== scopeWord.agg && (metric.metric === "sum" || metric.metric === "mean" || metric.metric === "median")) {
            return {
              code: "PLAN_AGGREGATE_SCOPE",
              error: `the request applies "${scopeWord.word}" across ${listed.join(", ")}, so the metric for "${column}" must use ${scopeWord.agg}, not ${metric.metric}. Use the same aggregate for every metric the user listed unless they explicitly override one.`,
            };
          }
        }
      }
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { isPlanError };

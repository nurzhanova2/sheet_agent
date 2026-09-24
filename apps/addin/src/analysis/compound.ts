import { canonicalizeAnalysisRequest, canonicalKey, stableStringify } from "./canonical.js";
import { validateAnalysisRequest } from "./validate.js";
import { validateVisualizationRequest } from "../visualization/validate.js";
import { factMetricLabel, type VerifiedFact, type ComparisonFact, type ExtremeFact, type RankingFact } from "./facts.js";
import { ANALYSIS_LIMITS, type AnalysisRequest, type Expression, type GroupMetric } from "./types.js";

// --- bounds ---------------------------------------------------------------

export const COMPOUND_LIMITS = {
  maxGoals: 12,
  maxUniqueOperations: ANALYSIS_LIMITS.maxOpsPerTurn, // 8
  maxDependenciesPerGoal: 4,
  maxDependencyDepth: 4,
} as const;

// --- schema -------------------------------------------------------------

/** analytical goals carry a typed request; ranking/comparison consume a dependency's facts. */
export type GoalType =
  | "metric" // one aggregate over the whole selection
  | "group_metric" // one aggregate per group dimension
  | "filter_count" // count of rows matching a condition (per group or total)
  | "correlation" // correlation / group_correlation
  | "ranking" // "which group is highest/lowest by <dependency metric>"
  | "comparison" // an explicit A-vs-B relationship from dependency metrics
  | "visualization"
  | "interpretation"; // qualitative narrative, no numbers

export type GoalStatus = "planned" | "validated" | "executed" | "failed" | "blocked";

export interface AnalysisGoal {
  readonly id: string;
  readonly type: GoalType;
  readonly description: string;
  readonly dependsOn: readonly string[];
  /** analytical goals: the typed request (canonicalized at parse time). */
  readonly request?: AnalysisRequest;
  /** visualization goals: the untrusted chart request. */
  readonly chart?: unknown;
  /** ranking goals: which end of the dependency ranking to name. */
  readonly select?: "max" | "min";
  /** comparison goals: the two groups being compared (optional). */
  readonly groups?: readonly [string, string];
}

export interface CompoundPlan {
  readonly kind: "compound";
  readonly goals: readonly AnalysisGoal[];
}

export interface CompoundPlanError {
  readonly code:
    | "COMPOUND_NOT_JSON"
    | "COMPOUND_SHAPE"
    | "COMPOUND_EMPTY"
    | "COMPOUND_TOO_MANY_GOALS"
    | "COMPOUND_GOAL_INVALID"
    | "COMPOUND_BAD_DEPENDENCY"
    | "COMPOUND_DEPENDENCY_CYCLE"
    | "COMPOUND_TOO_MANY_OPS"
    | "COMPOUND_COVERAGE"
    | "COMPOUND_MODIFIER"
    // Stage 21.2.6 — compact GoalIntent compiler.
    | "COMPOUND_INTENT_INVALID"
    | "COMPOUND_INTENT_UNBOUND";
  readonly error: string;
  /** goal id(s) — or, for compact intents, 1-based intent position(s) — the model should repair, leaving the rest unchanged. */
  readonly repairGoals?: readonly string[];
}

export function isCompoundPlanError(value: CompoundPlan | CompoundPlanError): value is CompoundPlanError {
  return "code" in value && "error" in value;
}

const GOAL_TYPES = new Set<GoalType>([
  "metric",
  "group_metric",
  "filter_count",
  "correlation",
  "ranking",
  "comparison",
  "visualization",
  "interpretation",
]);
const ANALYTICAL_TYPES = new Set<GoalType>(["metric", "group_metric", "filter_count", "correlation"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cheap check: does the raw plan text/object declare a compound plan? */
export function looksCompound(raw: unknown): boolean {
  if (typeof raw === "string") return /"kind"\s*:\s*"compound"/.test(raw);
  return isRecord(raw) && raw["kind"] === "compound";
}

// --- parse -------------------------------------------------------------

export function parseCompoundPlan(raw: unknown): CompoundPlan | CompoundPlanError {
  let value: unknown = raw;
  if (typeof value === "string") {
    const text: string = value;
    try {
      value = JSON.parse(text);
    } catch {
      const extracted = extractFirstJsonObject(text); // §14 — de-wrap only, never repair
      if (extracted === null) return { code: "COMPOUND_NOT_JSON", error: "the compound plan block was not valid JSON" };
      try {
        value = JSON.parse(extracted);
      } catch {
        return { code: "COMPOUND_NOT_JSON", error: "the compound plan block was not valid JSON" };
      }
    }
  }
  if (!isRecord(value) || value["kind"] !== "compound") {
    return { code: "COMPOUND_SHAPE", error: 'a compound plan must be {"kind":"compound","goals":[...]}' };
  }
  const goalsRaw = value["goals"];
  if (!Array.isArray(goalsRaw) || goalsRaw.length === 0) {
    return { code: "COMPOUND_EMPTY", error: "a compound plan needs a non-empty `goals` array" };
  }
  if (goalsRaw.length > COMPOUND_LIMITS.maxGoals) {
    return { code: "COMPOUND_TOO_MANY_GOALS", error: `too many goals (${goalsRaw.length}, max ${COMPOUND_LIMITS.maxGoals})` };
  }

  const goals: AnalysisGoal[] = [];
  const seen = new Set<string>();

  for (const [index, rawGoal] of goalsRaw.entries()) {
    if (!isRecord(rawGoal)) return { code: "COMPOUND_GOAL_INVALID", error: `goal #${index + 1} is not an object` };
    const id = typeof rawGoal["id"] === "string" && rawGoal["id"].length > 0 ? rawGoal["id"] : `G${index + 1}`;
    if (seen.has(id)) return { code: "COMPOUND_GOAL_INVALID", error: `duplicate goal id "${id}"`, repairGoals: [id] };
    seen.add(id);

    const type = rawGoal["type"];
    if (typeof type !== "string" || !GOAL_TYPES.has(type as GoalType)) {
      return { code: "COMPOUND_GOAL_INVALID", error: `goal ${id} has unknown type "${String(type)}"`, repairGoals: [id] };
    }
    const description = typeof rawGoal["description"] === "string" ? rawGoal["description"].slice(0, 240) : id;

    const dependsRaw = rawGoal["dependsOn"] ?? rawGoal["dependencies"] ?? [];
    if (!Array.isArray(dependsRaw)) return { code: "COMPOUND_GOAL_INVALID", error: `goal ${id}.dependsOn must be an array`, repairGoals: [id] };
    if (dependsRaw.length > COMPOUND_LIMITS.maxDependenciesPerGoal) {
      return { code: "COMPOUND_GOAL_INVALID", error: `goal ${id} has too many dependencies`, repairGoals: [id] };
    }
    const dependsOn = dependsRaw.map(String);
    for (const dep of dependsOn) {
      if (!seen.has(dep)) {
        return { code: "COMPOUND_BAD_DEPENDENCY", error: `goal ${id} depends on "${dep}", which is not an earlier goal`, repairGoals: [id] };
      }
    }

    const goal = buildGoal(id, type as GoalType, description, dependsOn, rawGoal);
    if ("code" in goal) return goal;
    goals.push(goal);
  }

  const depthError = checkDependencyDepth(goals);
  if (depthError) return depthError;

  // operation budget (before dedupe — a lower bound; dedupe only reduces it)
  const analyticalGoals = goals.filter((goal) => ANALYTICAL_TYPES.has(goal.type));
  if (analyticalGoals.length === 0 && goals.some((goal) => goal.type === "ranking" || goal.type === "comparison")) {
    return { code: "COMPOUND_GOAL_INVALID", error: "a ranking/comparison goal needs at least one analytical goal to consume" };
  }

  return { kind: "compound", goals };
}

function buildGoal(
  id: string,
  type: GoalType,
  description: string,
  dependsOn: readonly string[],
  rawGoal: Record<string, unknown>,
): AnalysisGoal | CompoundPlanError {
  if (ANALYTICAL_TYPES.has(type)) {
    const request = rawGoal["request"];
    const structural = validateAnalysisRequest(request);
    if (structural) {
      return { code: "COMPOUND_GOAL_INVALID", error: `goal ${id}.request rejected (${structural.code}): ${structural.error}`, repairGoals: [id] };
    }
    // A dependent ranking/comparison consumes the facts of exactly one logical
    // metric. Compatible goals are merged only after this boundary, preserving a
    // stable goal → fact relationship even when the model sends a compound plan.
    if (isRecord(request) && request["op"] === "group_by" && Array.isArray(request["metrics"]) && request["metrics"].length !== 1) {
      return {
        code: "COMPOUND_GOAL_INVALID",
        error: `goal ${id}.request must contain exactly one group_by metric; create one analytical goal per metric and let the executor merge them`,
        repairGoals: [id],
      };
    }
    return { id, type, description, dependsOn, request: canonicalizeAnalysisRequest(request as AnalysisRequest) };
  }
  if (type === "visualization") {
    const chart = rawGoal["chart"];
    const validated = validateVisualizationRequest(chart);
    if ("error" in validated) {
      // a chart the current schema cannot represent is not a parse failure — the
      // goal is kept and marked failed at execution with this reason.
      return { id, type, description, dependsOn, chart };
    }
    return { id, type, description, dependsOn, chart };
  }
  if (type === "ranking") {
    if (dependsOn.length !== 1) {
      return { code: "COMPOUND_GOAL_INVALID", error: `ranking goal ${id} must depend on exactly one metric goal`, repairGoals: [id] };
    }
    const select = rawGoal["select"] === "min" ? "min" : "max";
    return { id, type, description, dependsOn, select };
  }
  if (type === "comparison") {
    const groupsRaw = rawGoal["groups"];
    const groups =
      Array.isArray(groupsRaw) && groupsRaw.length === 2 ? ([String(groupsRaw[0]), String(groupsRaw[1])] as [string, string]) : undefined;
    return { id, type, description, dependsOn, ...(groups ? { groups } : {}) };
  }
  // interpretation
  return { id, type, description, dependsOn };
}

function checkDependencyDepth(goals: readonly AnalysisGoal[]): CompoundPlanError | null {
  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (id: string): number | CompoundPlanError => {
    if (depth.has(id)) return depth.get(id) as number;
    if (visiting.has(id)) return { code: "COMPOUND_DEPENDENCY_CYCLE", error: `dependency cycle at goal ${id}`, repairGoals: [id] };
    visiting.add(id);
    const goal = byId.get(id);
    let max = 0;
    for (const dep of goal?.dependsOn ?? []) {
      const d = resolve(dep);
      if (typeof d !== "number") return d;
      max = Math.max(max, d + 1);
    }
    visiting.delete(id);
    depth.set(id, max);
    return max;
  };

  for (const goal of goals) {
    const d = resolve(goal.id);
    if (typeof d !== "number") return d;
    if (d > COMPOUND_LIMITS.maxDependencyDepth) {
      return { code: "COMPOUND_GOAL_INVALID", error: `goal ${goal.id} dependency chain is too deep`, repairGoals: [goal.id] };
    }
  }
  return null;
}

// --- dedupe + merge --------------------------------------------------------

export interface PreparedExecution {
  /** the deduped, canonical operations to run in ONE batch (<= maxUniqueOperations). */
  readonly operations: readonly AnalysisRequest[];
  /** goal id -> 0-based index into `operations`. */
  readonly goalToOp: ReadonlyMap<string, number>;
  /** goal id -> the metric label whose facts answer it (group_by goals). */
  readonly goalToMetric: ReadonlyMap<string, string>;
}

/** shape key of a group_by request ignoring its metrics — group_by goals with the same shape merge. */
function groupByShapeKey(request: Extract<AnalysisRequest, { op: "group_by" }>): string {
  return stableStringify({ op: "group_by", by: request.by, where: request.where ?? null, sort: request.sort ?? null });
}

function metricLabelFor(metric: GroupMetric, existing: ReadonlySet<string>): string {
  if (metric.name && metric.name.length > 0) return metric.name;
  const target = metric.target as Expression | undefined;
  const base =
    metric.metric === "count"
      ? "count"
      : target?.kind === "column"
        ? `${metric.metric}_${target.name.replace(/\s+/g, "")}`
        : target?.kind === "abs"
          ? `${metric.metric}_abs`
          : metric.metric;
  let name = base;
  let n = 2;
  while (existing.has(name)) name = `${base}_${n++}`;
  return name;
}

export function prepareCompoundExecution(goals: readonly AnalysisGoal[]): PreparedExecution | CompoundPlanError {
  const analytical = goals.filter((goal): goal is AnalysisGoal & { request: AnalysisRequest } => goal.request !== undefined);

  interface GroupByBucket {
    base: Extract<AnalysisRequest, { op: "group_by" }>;
    metrics: GroupMetric[];
    metricLabels: Map<string, string>; // metricKey -> label
    names: Set<string>;
    goals: { id: string; label: string }[];
  }
  const groupByBuckets = new Map<string, GroupByBucket>();
  const otherOps = new Map<string, { request: AnalysisRequest; goals: string[] }>();

  for (const goal of analytical) {
    const request = goal.request;
    if (request.op === "group_by") {
      const shapeKey = groupByShapeKey(request);
      let bucket = groupByBuckets.get(shapeKey);
      if (!bucket) {
        bucket = { base: request, metrics: [], metricLabels: new Map(), names: new Set(), goals: [] };
        groupByBuckets.set(shapeKey, bucket);
      }
      for (const metric of request.metrics) {
        const metricKey = stableStringify({ metric: metric.metric, target: metric.target ?? null, where: metric.where ?? null });
        let label = bucket.metricLabels.get(metricKey);
        if (label === undefined) {
          label = metricLabelFor(metric, bucket.names);
          bucket.names.add(label);
          bucket.metricLabels.set(metricKey, label);
          bucket.metrics.push({ ...metric, name: label });
        }
        bucket.goals.push({ id: goal.id, label });
      }
    } else {
      const key = canonicalKey(request);
      let entry = otherOps.get(key);
      if (!entry) {
        entry = { request, goals: [] };
        otherOps.set(key, entry);
      }
      entry.goals.push(goal.id);
    }
  }

  const operations: AnalysisRequest[] = [];
  const goalToOp = new Map<string, number>();
  const goalToMetric = new Map<string, string>();

  for (const bucket of groupByBuckets.values()) {
    const opIndex = operations.length;
    operations.push({ ...bucket.base, metrics: bucket.metrics });
    for (const entry of bucket.goals) {
      goalToOp.set(entry.id, opIndex);
      goalToMetric.set(entry.id, entry.label);
    }
  }
  for (const entry of otherOps.values()) {
    const opIndex = operations.length;
    operations.push(entry.request);
    for (const id of entry.goals) goalToOp.set(id, opIndex);
  }

  if (operations.length > COMPOUND_LIMITS.maxUniqueOperations) {
    return {
      code: "COMPOUND_TOO_MANY_OPS",
      error: `after de-duplication the plan still needs ${operations.length} operations (max ${COMPOUND_LIMITS.maxUniqueOperations}). Merge metrics into a shared group_by.`,
    };
  }
  return { operations, goalToOp, goalToMetric };
}

// --- execution summary ---------------------------------------------------

export interface CompoundGoalOutcome {
  readonly id: string;
  readonly type: GoalType;
  readonly description: string;
  status: GoalStatus;
  sourceOperationId?: string;
  factIds: string[];
  failureReason?: string;
  /** ranking / comparison goals: the fact that answers the goal. */
  answerFactId?: string;
  answerText?: string;
}

export interface CompoundExecutionSummary {
  readonly totalGoals: number;
  readonly completedGoals: number;
  readonly failedGoals: number;
  readonly blockedGoals: number;
  readonly analyticalGoals: number;
  readonly analyticalCompleted: number;
  readonly goals: readonly CompoundGoalOutcome[];
}

/** Fresh outcome records, all "planned". */
export function initGoalOutcomes(goals: readonly AnalysisGoal[]): CompoundGoalOutcome[] {
  return goals.map((goal) => ({ id: goal.id, type: goal.type, description: goal.description, status: "planned", factIds: [] }));
}

function extractMissingColumn(error: string): string | null {
  const match = error.match(/Column "([^"]+)" was not found|column\s+"?([^"\s]+)"?\s+(?:is|was)\s+(?:unknown|not found)/i);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * Maps every analytical goal onto its merged operation: executed (+ attributed
 * fact ids) or failed with a reason. Interpretation goals pass immediately;
 * visualization / ranking / comparison goals are resolved elsewhere.
 */
export function finalizeAnalyticalGoals(
  goals: readonly AnalysisGoal[],
  prepared: PreparedExecution,
  outcomes: CompoundGoalOutcome[],
  rejected: readonly { readonly index: number; readonly code: string; readonly error: string }[],
  facts: readonly VerifiedFact[],
): void {
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const rejectedByIndex = new Map(rejected.map((entry) => [entry.index, entry]));

  for (const goal of goals) {
    const outcome = outcomeById.get(goal.id);
    if (!outcome) continue;

    if (goal.type === "interpretation") {
      outcome.status = "executed";
      continue;
    }
    if (!ANALYTICAL_TYPES.has(goal.type)) continue; // ranking / comparison / visualization handled later

    const opIndex = prepared.goalToOp.get(goal.id);
    if (opIndex === undefined) {
      outcome.status = "failed";
      outcome.failureReason = "the goal produced no operation";
      continue;
    }
    const failure = rejectedByIndex.get(opIndex);
    if (failure) {
      const missing = failure.code === "UNKNOWN_COLUMN" ? extractMissingColumn(failure.error) : null;
      outcome.status = "failed";
      outcome.failureReason = missing ? `COLUMN_NOT_AVAILABLE: ${missing}` : `${failure.code}: ${failure.error}`;
      continue;
    }
    outcome.status = "executed";
    outcome.sourceOperationId = `op#${opIndex + 1}`;
    // Attribute this goal's facts by its metric. The fact layer rewrites a metric
    // name that has lost its workbook identifier (e.g. "avgAbsVarPct" →
    // "mean absolute Variance %"), so match on BOTH the raw name and that derived
    // label — otherwise a merged group_by goal gets no factIds and a dependent
    // ranking cannot bind to it (Stage 21.2.6 §10).
    const rawLabel = prepared.goalToMetric.get(goal.id);
    const singleMetric =
      goal.request?.op === "group_by" && goal.request.metrics.length === 1 ? goal.request.metrics[0] : undefined;
    const labels = new Set<string>();
    if (rawLabel) {
      labels.add(rawLabel.toLowerCase());
      labels.add(factMetricLabel(rawLabel, singleMetric).toLowerCase());
    }
    outcome.factIds = facts
      .filter((fact) => fact.sourceOperationId === outcome.sourceOperationId)
      .filter((fact) => {
        if (labels.size === 0) return true;
        if (fact.kind === "scalar" || fact.kind === "extreme" || fact.kind === "ranking" || fact.kind === "pair") return labels.has((fact.metric ?? "").toLowerCase());
        if (fact.kind === "share") return labels.has(fact.ofWhat.toLowerCase());
        return true;
      })
      .map((fact) => fact.id);
  }
}

export function summarize(goals: readonly CompoundGoalOutcome[]): CompoundExecutionSummary {
  const analytical = goals.filter((goal) => ANALYTICAL_TYPES.has(goal.type) || goal.type === "ranking" || goal.type === "comparison");
  return {
    totalGoals: goals.length,
    completedGoals: goals.filter((goal) => goal.status === "executed").length,
    failedGoals: goals.filter((goal) => goal.status === "failed").length,
    blockedGoals: goals.filter((goal) => goal.status === "blocked").length,
    analyticalGoals: analytical.length,
    analyticalCompleted: analytical.filter((goal) => goal.status === "executed").length,
    goals,
  };
}

const GOAL_STATUS_WORD: Record<"ru" | "en", Record<GoalStatus, string>> = {
  en: { planned: "planned", validated: "validated", executed: "done", failed: "not done", blocked: "blocked" },
  ru: { planned: "запланировано", validated: "проверено", executed: "выполнено", failed: "не выполнено", blocked: "заблокировано" },
};

const GOAL_STATUS_LABEL: Record<"ru" | "en", Record<GoalType, string>> = {
  en: {
    metric: "metric",
    group_metric: "group metric",
    filter_count: "filtered count",
    correlation: "correlation",
    ranking: "ranking",
    comparison: "comparison",
    visualization: "chart",
    interpretation: "interpretation",
  },
  ru: {
    metric: "показатель",
    group_metric: "групповой показатель",
    filter_count: "подсчёт с условием",
    correlation: "корреляция",
    ranking: "ранжирование",
    comparison: "сравнение",
    visualization: "график",
    interpretation: "интерпретация",
  },
};

/**
 * Localised, user-readable gloss for a failure reason, keeping the stable English
 * code in parentheses for the model's diagnostics (Stage 21.2.5 §13/§17).
 */
function localizeFailureReason(reason: string, language: "ru" | "en"): string {
  const missing = /^COLUMN_NOT_AVAILABLE:\s*(.+)$/.exec(reason);
  if (missing) {
    const column = missing[1]?.trim() ?? "";
    return language === "ru"
      ? `столбец ${column} отсутствует в выбранном диапазоне (COLUMN_NOT_AVAILABLE: ${column})`
      : `column ${column} is not in the selected range (COLUMN_NOT_AVAILABLE: ${column})`;
  }
  const viz = /^VISUALIZATION_UNSUPPORTED:\s*(.+)$/.exec(reason);
  if (viz) {
    return language === "ru"
      ? "график не удалось построить (VISUALIZATION_UNSUPPORTED)"
      : "the chart could not be produced (VISUALIZATION_UNSUPPORTED)";
  }
  return reason;
}

/** The GOAL STATUS block for the answer model. */
export function renderGoalStatus(summary: CompoundExecutionSummary, language: "ru" | "en"): string {
  const head =
    language === "ru"
      ? `СТАТУС ЦЕЛЕЙ — запрошено ${summary.totalGoals} · выполнено ${summary.completedGoals} · не удалось ${summary.failedGoals} · заблокировано ${summary.blockedGoals}`
      : `GOAL STATUS — ${summary.totalGoals} requested · ${summary.completedGoals} completed · ${summary.failedGoals} failed · ${summary.blockedGoals} blocked`;
  const lines = summary.goals.map((goal) => {
    const where = goal.sourceOperationId ? ` (${goal.sourceOperationId})` : "";
    const detail = goal.status === "executed"
      ? goal.answerText
        ? ` → ${goal.answerText}`
        : where
      : goal.failureReason
        ? `: ${localizeFailureReason(goal.failureReason, language)}`
        : "";
    return `[${goal.id}] ${GOAL_STATUS_LABEL[language][goal.type]} — ${GOAL_STATUS_WORD[language][goal.status]}${detail}`;
  });
  const rule =
    language === "ru"
      ? "Опиши числами ТОЛЬКО выполненные цели. Для каждой невыполненной/заблокированной цели прямо скажи, что эта часть не может быть рассчитана из текущего выделения. Не подразумевай, что весь запрос выполнен."
      : "Describe with numbers ONLY the completed goals. For every failed / blocked goal, state plainly that that portion could not be computed from the current selection. Do NOT imply the whole request is done.";
  return [head, ...lines, rule].join("\n");
}

// --- dependent-goal resolution ----------------------------------------------

const HIGH_WORDS = /(наибольш|наивысш|максимальн|сильнейш|самая?\s+больш|самый\s+больш|самое\s+больш|highest|largest|strongest|greatest|biggest|most)/i;
const LOW_WORDS = /(наименьш|минимальн|слабейш|самая?\s+маленьк|самый\s+маленьк|lowest|smallest|weakest|least)/i;

/**
 * Resolves ranking / comparison goals from the VerifiedFacts a dependency produced.
 * The LLM never ranks or compares — the answer comes from an existing (or newly
 * derived) VerifiedFact. Returns any extra facts derived here.
 */
export function resolveDependentGoals(
  goals: readonly AnalysisGoal[],
  outcomes: readonly CompoundGoalOutcome[],
  facts: readonly VerifiedFact[],
): readonly VerifiedFact[] {
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const extra: VerifiedFact[] = [];
  let extraSeq = facts.length + 1;

  for (const goal of goals) {
    const outcome = outcomeById.get(goal.id);
    if (!outcome) continue;

    if (goal.type === "ranking") {
      const depId = goal.dependsOn[0] ?? "";
      const dep = outcomeById.get(depId);
      if (!dep || dep.status !== "executed") {
        outcome.status = "blocked";
        outcome.failureReason = `depends on ${depId} which ${dep?.status ?? "is missing"}`;
        continue;
      }
      const select =
        goal.select ?? (HIGH_WORDS.test(goal.description) ? "max" : LOW_WORDS.test(goal.description) ? "min" : "max");
      // Bind to the dependency's SPECIFIC metric, not merely its operation. When
      // several metrics were merged into one group_by op, every metric produced
      // its own ranking / extreme facts; `dep.factIds` already isolates the ones
      // for this dependency's metric (Stage 21.2.6 §10 — no post-hoc guessing).
      const depFactIds = new Set(dep.factIds);
      const depFacts = dep.factIds.length > 0
        ? facts.filter((fact) => depFactIds.has(fact.id))
        : facts.filter((fact) => fact.sourceOperationId === dep.sourceOperationId);
      const extreme = depFacts.find(
        (fact): fact is ExtremeFact => fact.kind === "extreme" && fact.which === select,
      );
      const ranking = depFacts.find((fact): fact is RankingFact => fact.kind === "ranking");
      if (extreme) {
        outcome.status = "executed";
        outcome.answerFactId = extreme.id;
        outcome.answerText = `${extreme.label}: ${extreme.formatted}`;
        outcome.factIds.push(extreme.id);
      } else if (ranking && ranking.order.length > 0) {
        const group = select === "max" ? ranking.order[0] : ranking.order[ranking.order.length - 1];
        outcome.status = "executed";
        outcome.answerFactId = ranking.id;
        outcome.answerText = `${select === "max" ? "highest" : "lowest"} by ${ranking.metric}: ${group}`;
        outcome.factIds.push(ranking.id);
      } else {
        outcome.status = "failed";
        outcome.failureReason = "no ranking / extreme VerifiedFact was produced for the dependency";
      }
      continue;
    }

    if (goal.type === "comparison") {
      const blocked = goal.dependsOn.some((dep) => {
        const d = outcomeById.get(dep);
        return d && (d.status === "failed" || d.status === "blocked");
      });
      if (blocked) {
        outcome.status = "blocked";
        outcome.failureReason = "a compared goal failed or is blocked";
        continue;
      }
      // Prefer the dependencies' SPECIFIC metric facts (Stage 21.2.6 §10); fall
      // back to their whole operation only when nothing was attributed.
      const depOutcomes = goal.dependsOn.map((dep) => outcomeById.get(dep)).filter((d): d is CompoundGoalOutcome => Boolean(d));
      const depFactIds = new Set(depOutcomes.flatMap((d) => d.factIds));
      const depOpIds = new Set(depOutcomes.map((d) => d.sourceOperationId).filter(Boolean));
      const scoped = depFactIds.size > 0
        ? facts.filter((fact) => depFactIds.has(fact.id))
        : facts.filter((fact) => depOpIds.has(fact.sourceOperationId));
      if (goal.groups) {
        const [a, b] = goal.groups;
        const fact = comparePairFact(scoped, a, b, extraSeq);
        if (fact) {
          extra.push(fact);
          extraSeq += 1;
          outcome.status = "executed";
          outcome.answerFactId = fact.id;
          outcome.answerText = fact.formatted;
          outcome.factIds.push(fact.id);
          continue;
        }
      }
      const existing = scoped.find((fact): fact is ComparisonFact => fact.kind === "comparison") ??
        scoped.find((fact): fact is RankingFact => fact.kind === "ranking");
      if (existing) {
        outcome.status = "executed";
        outcome.answerFactId = existing.id;
        outcome.answerText = `${existing.label}: ${existing.formatted}`;
        outcome.factIds.push(existing.id);
      } else {
        outcome.status = "failed";
        outcome.failureReason = "no comparison / ranking VerifiedFact was produced for the compared goals";
      }
    }
  }
  return extra;
}

// --- user-intent coverage (§11) -----------------------------------------------

type Agg = "mean" | "sum" | "median";

export type RequirementConditionOp = ">" | ">=" | "<" | "<=" | "=" | "!=";

/**
 * A row-filter predicate found in the prompt (Stage 21.2.8 §2). It is a CONDITION,
 * never an aggregate: `abs(Variance %) > 0.20` must compile to a filtered count,
 * not to `mean(abs(Variance %))`.
 */
export interface RequirementCondition {
  readonly column: string;
  readonly op: RequirementConditionOp;
  /** a literal, a `{percent:N}` threshold on a %-formatted column, or another column. */
  readonly value: number | { readonly percent: number } | { readonly column: string };
  readonly absolute: boolean;
}

export interface RequirementSet {
  readonly dimensions: readonly string[];
  readonly metrics: readonly { readonly column: string; readonly aggregate: Agg | null; readonly absolute: boolean }[];
  /** the user asked for a row count / "количество записей" / "how many". */
  readonly countRequirement: boolean;
  readonly hasFilter: boolean;
  /** row-filter predicates ("|Variance %| > 20%", "Fact < Plan") — filtered counts, not metrics. */
  readonly conditions: readonly RequirementCondition[];
  /** the user asked for a share / percentage / доля / процент of a total. */
  readonly groupShare: boolean;
  /** the user asked which group is "most common / чаще всего" — a frequency ranking. */
  readonly frequency: boolean;
  /** the user asked which pair of groups is closest / farthest apart on a metric. */
  readonly pairSelection: "closest" | "farthest" | null;
  readonly rankings: number;
  readonly comparison: boolean;
  readonly correlation: boolean;
  readonly visualization: boolean;
  readonly interpretation: boolean;
}

const DIM_LEAD = /(?:по|by|for\s+each|в\s+разрезе|per|across)\s+([^.?!;\n]{0,80})/gi;
const SCOPE_WORD = /(средн[а-яё]*|average|\bmean\b|\bavg\b|суммарн[а-яё]*|сумм[а-яё]*|\btotal\b|\bsum\b|медиан[а-яё]*|\bmedian\b)/i;
const SCOPE_SPAN = /(средн[а-яё]*|average|\bmean\b|\bavg\b|суммарн[а-яё]*|сумм[а-яё]*|\btotal\b|\bsum\b|медиан[а-яё]*|\bmedian\b)\s+([^.?!;\n]{0,180})/gi;
const ABS_NEAR = /(абсолютн[а-яё]*|по\s+модул[а-яё]+|absolute)/i;
const COUNT_MARK = /(количеств[а-яё]*\s*(?:записей|строк|наблюден[а-яё]*|records?|rows?|entries)?|\bnumber\s+of\s+(?:records?|rows?|entries)\b|сколько\s+(?:записей|строк|раз|случа[а-яё]*)|how\s+many\b|\bcount(?:ing)?\s+(?:the\s+)?(?:number\s+of\s+)?(?:rows?|records?|entries|values)\b)/i;
const FILTER_MARK = /(где|только\s+строк|filter|rows?\s+where|строк[аи]?\s+где|при\s+услови)/i;
const RANK_MARK = /(наибольш[а-яё]*|наименьш[а-яё]*|максимальн[а-яё]*|минимальн[а-яё]*|highest|lowest|largest|smallest|strongest|weakest|\bmost\b|\bleast\b|топ|top\s+\d|bottom\s+\d|сильнейш[а-яё]*|слабейш[а-яё]*|сам[а-яё]*\s+сильн[а-яё]*)/gi;
const COMPARE_MARK = /(сравн[а-яё]*|различ[а-яё]*|compare|difference|different|\bvs\.?\b|против)/i;
const VIZ_MARK = /(график|диаграмм[а-яё]*|chart|\bplot\b|\bgraph\b|визуализ[а-яё]*|гистограмм[а-яё]*)/i;
const INTERP_MARK = /(интерпрет[а-яё]*|interpret|вывод[аоы]?|инсайт|insight|объясни\s+различ|что\s+это\s+значит|\bpatterns?\b|отдели.{0,20}факт)/i;
const SHARE_MARK = /(дол[юяей]|дол[ья]\s|процент[а-яё]*\s|percentage|\bshare\b|proportion|percent\s+of|\bpct\b|в\s+процентах)/i;
const FREQUENCY_MARK = /(чаще\s+всего|наиболее\s+часто|most\s+(?:common|frequent|often)|встреча[а-яё]*\s+чаще|сам[а-яё]*\s+част[а-яё]*|преоблада[а-яё]*|встреча[а-яё]*\s+больше\s+всего)/i;
const CLOSEST_MARK = /(closest|nearest|smallest\s+(?:gap|difference)|минимальн\w*\s+разниц|ближе\s+всего|наименьш\w*\s+разниц|почти\s+одинаков)/i;
const FARTHEST_MARK = /(farthest|furthest|largest\s+(?:gap|difference)|наибольш\w*\s+разниц|максимальн\w*\s+разниц|дальше\s+всего|сильнее\s+всего\s+различ)/i;

// comparison phrases that introduce a row-filter predicate on a column (Stage 21.2.8 §2).
// GTE / LTE checked before the bare forms so ">=" and "не менее" win.
const CMP_GTE = /(?:>=|=>|не\s+менее|не\s+ниже|at\s+least|greater\s+than\s+or\s+equal)/i;
const CMP_LTE = /(?:<=|=<|не\s+более|не\s+выше|at\s+most|less\s+than\s+or\s+equal)/i;
const CMP_GT = /(?:>|больше|более|выше|превыша[а-яё]*|greater\s+than|more\s+than|above|exceed(?:s|ing)?|over)/i;
const CMP_LT = /(?:<|меньше|менее|ниже|less\s+than|below|under|fewer\s+than)/i;
const CMP_ANY = new RegExp(`(${CMP_GTE.source}|${CMP_LTE.source}|${CMP_GT.source}|${CMP_LT.source})`, "i");

function aggOf(word: string): Agg {
  const w = word.toLowerCase();
  if (/средн|average|mean|avg/.test(w)) return "mean";
  if (/медиан|median/.test(w)) return "median";
  return "sum";
}

function opFromWords(word: string): RequirementConditionOp {
  const w = word.trim();
  if (CMP_GTE.test(w)) return ">=";
  if (CMP_LTE.test(w)) return "<=";
  if (CMP_LT.test(w)) return "<";
  return ">";
}

const ABS_PREFIX = /(?:абсолютн[а-яё]*\s+|по\s+модул[а-яё]+\s+|absolute\s+)/i;

/**
 * Scans the prompt for row-filter predicates: `[abs] <header> <cmp> <number>[%]`
 * and the column-to-column form `<header> <cmp> <header>` ("Fact меньше Plan").
 * These are conditions for a filtered count — NOT aggregate requirements.
 */
function extractConditions(prompt: string, headers: readonly string[]): RequirementCondition[] {
  const out: RequirementCondition[] = [];
  const lower = ` ${prompt.toLowerCase().replace(/\s+/g, " ")} `;
  const seen = new Set<string>();
  for (const header of headers) {
    const hEsc = header.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // numeric / percent threshold: "|Variance %| > 20%", "Variance % больше 20 %"
    const numRe = new RegExp(`(${ABS_PREFIX.source}|\\|\\s*)?${hEsc}\\s*\\|?\\s*(?:по\\s+модулю\\s*)?${CMP_ANY.source}\\s*(-?\\d[\\d.,]*)\\s*(%)?`, "i");
    const numMatch = numRe.exec(lower);
    if (numMatch) {
      const [, prefix, comparator, numText, percent] = numMatch;
      const raw = Number((numText ?? "").replace(/\s/g, "").replace(",", "."));
      if (Number.isFinite(raw)) {
        const absolute =
          Boolean(prefix && ABS_PREFIX.test(prefix)) ||
          /по\s+модулю/i.test(numMatch[0]) ||
          new RegExp(`(?:абсолютн[а-яё]*|по\\s+модул[а-яё]+|absolute)[^.?!;\\n]{0,14}${hEsc}`, "i").test(lower);
        const key = `${hEsc}|${comparator}|${raw}|${percent ? "%" : ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ column: header, op: opFromWords(comparator ?? ">"), value: percent ? { percent: raw } : raw, absolute });
        }
        continue;
      }
    }
    // column-to-column: "Fact меньше Plan", "Fact < Plan", "Fact less than Plan"
    for (const other of headers) {
      if (other === header) continue;
      const oEsc = other.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const colRe = new RegExp(`\\b${hEsc}\\s*${CMP_ANY.source}\\s*${oEsc}\\b`, "i");
      const m = colRe.exec(lower);
      if (!m) continue;
      const key = `${hEsc}|c2c|${oEsc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ column: header, op: opFromWords(m[1] ?? ">"), value: { column: other }, absolute: false });
    }
  }
  return out;
}

/** Deterministic parse of a user prompt into the set of requirements a plan must cover. */
export function extractRequirements(prompt: string, headersIn: readonly string[]): RequirementSet {
  const lower = ` ${prompt.toLowerCase().replace(/\s+/g, " ")} `;
  // longest headers first so "Variance %" claims its position before bare "Variance"
  const sorted = [...headersIn].sort((a, b) => b.length - a.length);
  // drop a header whose every occurrence is inside a longer header ("Variance" ⊂ "Variance %")
  const occurrences = (needle: string): number[] => {
    const out: number[] = [];
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) out.push(i);
    return out;
  };
  const headers = sorted.filter((header, index) => {
    const longer = sorted.slice(0, index).map((h) => h.toLowerCase());
    const hits = occurrences(header.toLowerCase());
    if (hits.length === 0) return true;
    return hits.some((pos) => !longer.some((l) => { const li = lower.indexOf(l); return li >= 0 && pos >= li && pos < li + l.length; }));
  });

  // dimensions: header names right after a "по / by / per" lead — but NOT when the
  // lead is immediately followed by an aggregate word (that's a metric list, e.g.
  // "compare … by average Fact and total Revenue").
  // a new clause ("… и определи …", "… and then find …") ends the grouping phrase —
  // headers after it are NOT grouping dimensions (Stage 21.2.8 §3).
  const CLAUSE_BREAK =
    /\s+(?:и|and|then|затем|потом|а\s+также)\s+(?=(?:определ|найд|назов|выбер|покаж|рассч[ёе]т|рассчит|вычисл|отдел|сравн|построй|дай|укаж|оцен|determine|find|name|show|identif|comput|calculat|split|compare|build|give|list|rank|derive|estimate)\p{L}*)/iu;
  const dimensions = new Set<string>();
  for (const match of prompt.matchAll(DIM_LEAD)) {
    const rawSpanFull = match[1] ?? "";
    const rawSpan = (rawSpanFull.split(CLAUSE_BREAK)[0] ?? rawSpanFull).split(/[,;.:]/)[0] ?? rawSpanFull;
    const span = rawSpan.toLowerCase();
    if (SCOPE_WORD.test(span.slice(0, 22)) || COUNT_MARK.test(span.slice(0, 22))) continue;
    // the grouping phrase itself is short ("каждой Category", "Category и Region").
    // A header buried deeper in a run-on clause ("… долю каждой Category в общей
    // Revenue") is NOT a grouping dimension (Stage 21.2.8 §3).
    const head32 = span.slice(0, 34);
    const known = headers.filter((header) => head32.includes(header.toLowerCase()));
    for (const header of known) dimensions.add(header);
    // When a grouping phrase DIRECTLY conjoins a known dimension with another
    // TitleCase identifier ("по Category и Region"), preserve the latter even when
    // it is absent from the selection — the planner must surface COLUMN_NOT_AVAILABLE,
    // never drop it. The conjunction must be immediate: "Category и определи … Revenue"
    // is a new clause, not a second grouping dimension (Stage 21.2.8 §3).
    if (known.length > 0) {
      for (const knownDim of known) {
        const conjRe = new RegExp(
          `${knownDim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:,|и|and|&|\\+|/)\\s*([A-Z][A-Za-z]{2,})\\b`,
          "gi",
        );
        for (const m of rawSpan.matchAll(conjRe)) {
          const identifier = m[1] ?? "";
          if (!/[a-z]/.test(identifier) || !/^[A-Z]/.test(identifier)) continue;
          const canonical = headers.find((header) => header.toLowerCase() === identifier.toLowerCase());
          dimensions.add(canonical ?? identifier);
        }
      }
    }
  }

  const metrics = new Map<string, { column: string; aggregate: Agg | null; absolute: boolean }>();

  // scoped: "<agg> <list-span>" applies the aggregate to every header inside the span.
  // The span stops at a contrasting conjunction ("…, а Revenue …" / "…, but Revenue …").
  for (const match of prompt.matchAll(SCOPE_SPAN)) {
    const agg = aggOf(match[1] ?? "");
    const rawSpan = (match[2] ?? "").toLowerCase();
    const span = ` ${rawSpan.split(/[,;]?\s+(?:а|но|but|however|while|whereas)\s+/)[0] ?? rawSpan} `;
    const leadAbs = ABS_NEAR.test(match[1] ?? "");
    for (const header of headers) {
      const h = header.toLowerCase();
      if (dimensions.has(header) || !span.includes(h)) continue;
      // "absolute" applies per-item: only when it sits just before THIS header
      const pos = span.indexOf(h);
      const absolute = leadAbs || ABS_NEAR.test(span.slice(Math.max(0, pos - 20), pos));
      metrics.set(header, { column: header, aggregate: agg, absolute });
    }
  }

  // the aggregate word attached to a header: "average X" (prefix) or "X ... total"
  // (postfix - the agg word is the last significant token of the clause). "total
  // Fact" is a PREFIX for Fact, never a postfix for a preceding header.
  const SCOPE_PREFIX = new RegExp(`(${SCOPE_WORD.source})\\s*$`, "i");
  const aggFor = (header: string): { aggregate: Agg | null; absolute: boolean } => {
    const h = header.toLowerCase();
    const at = lower.indexOf(" " + h);
    if (at < 0) return { aggregate: null, absolute: false };
    const before = lower.slice(Math.max(0, at - 16), at + 1);
    let after = lower
      .slice(at + 1 + h.length, at + 1 + h.length + 40)
      .replace(/\s+(?:по|by|across|per|for\s+each)\s.*$/i, "")
      .trim();
    const TRAILING_MODIFIER = new RegExp(`\\s+(?:${SCOPE_WORD.source}|${ABS_NEAR.source})\\s*$`, "i");
    for (const other of headers) {
      if (other === header) continue;
      const cut = after.indexOf(other.toLowerCase());
      if (cut < 0) continue;
      // drop the cut header AND every aggregate / "absolute" word that was prefixing
      // it ("… of total Fact", "… mean absolute Variance %").
      after = after.slice(0, cut).trim();
      let prev = "";
      while (prev !== after) {
        prev = after;
        after = after.replace(TRAILING_MODIFIER, "").trim();
      }
    }
    const word = before.match(SCOPE_PREFIX)?.[1] ?? after.match(SCOPE_PREFIX)?.[1];
    // "absolute" only binds when it sits TIGHT against the header — right before it
    // ("absolute Variance %") or as its immediate postfix — not merely somewhere
    // later in the sentence ("Category … самое большое среднее абсолютное …").
    return { aggregate: word ? aggOf(word) : null, absolute: ABS_NEAR.test(before) || ABS_NEAR.test(after.slice(0, 12)) };
  };

  // standalone headers: only recorded as a metric requirement when an aggregate
  // word or "absolute" sits tight against them. A bare mention ("name the category
  // with …", "Plan vs Fact") is not an aggregation requirement.
  for (const header of headers) {
    if (metrics.has(header) || dimensions.has(header)) continue;
    if (lower.indexOf(" " + header.toLowerCase()) < 0) continue;
    const resolved = aggFor(header);
    if (resolved.aggregate !== null || resolved.absolute) metrics.set(header, { column: header, ...resolved });
  }

  // per-column override for a SCOPED header ("... средние Plan и Fact, а Revenue покажи суммарно")
  for (const [header, entry] of metrics) {
    if (entry.aggregate === null) continue;
    const override = aggFor(header);
    if (override.aggregate && override.aggregate !== entry.aggregate) {
      metrics.set(header, { ...entry, aggregate: override.aggregate });
    }
  }

  // Row-filter predicates ("|Variance %| > 20%", "Fact < Plan") are CONDITIONS, not
  // aggregate requirements (Stage 21.2.8 §2). A header captured only by a predicate
  // (no aggregate word tight against it) must NOT force a mean/sum goal.
  const conditions = extractConditions(prompt, headers);
  for (const condition of conditions) {
    const entry = metrics.get(condition.column);
    if (entry && entry.aggregate === null) metrics.delete(condition.column);
    if (isRecord(condition.value) && "column" in condition.value) {
      const rhs = metrics.get((condition.value as { column: string }).column);
      if (rhs && rhs.aggregate === null) metrics.delete((condition.value as { column: string }).column);
    }
  }

  const frequency = FREQUENCY_MARK.test(lower);
  const pairSelection: "closest" | "farthest" | null = CLOSEST_MARK.test(prompt)
    ? "closest"
    : FARTHEST_MARK.test(prompt)
      ? "farthest"
      : null;
  return {
    dimensions: [...dimensions],
    metrics: [...metrics.values()],
    countRequirement: COUNT_MARK.test(lower) || frequency,
    hasFilter: FILTER_MARK.test(lower) || conditions.length > 0,
    conditions,
    groupShare: SHARE_MARK.test(lower),
    frequency,
    pairSelection,
    rankings: (lower.match(RANK_MARK) ?? []).length + (frequency ? 1 : 0),
    comparison: COMPARE_MARK.test(lower),
    correlation: /(pearson|корреляц[а-яё]*|correlation)/i.test(lower),
    visualization: VIZ_MARK.test(lower),
    interpretation: INTERP_MARK.test(lower),
  };
}

export interface CoverageGap {
  readonly kind: "metric" | "dimension" | "ranking" | "visualization" | "count";
  readonly detail: string;
}

function goalMetricMatches(goals: readonly AnalysisGoal[], column: string, aggregate: Agg | null, absolute: boolean): boolean {
  return goals.some((goal) => {
    if (goal.request?.op === "group_by") {
      return goal.request.metrics.some((metric) => metricCovers(metric, column, aggregate, absolute));
    }
    if (goal.request?.op === "aggregate") {
      return exprCovers(goal.request.target, column, absolute) && (aggregate === null || goal.request.metric === aggregate);
    }
    if (goal.type === "visualization") return chartCoversMetric(goal.chart, column, aggregate, absolute);
    return false;
  });
}

interface ChartMetricRef {
  readonly column: string | null;
  readonly aggregate: string | null;
  readonly absolute: boolean;
}

/** Pulls the (column, aggregate) pairs a visualization goal will plot from its chart request. */
function chartMetricRefs(chart: unknown): readonly ChartMetricRef[] {
  if (!isRecord(chart)) return [];
  const refs: ChartMetricRef[] = [];
  const fromValue = (value: unknown): ChartMetricRef | null => {
    if (!isRecord(value)) return null;
    const aggregate = typeof value["aggregate"] === "string" ? (value["aggregate"] as string) : null;
    let column = typeof value["column"] === "string" ? (value["column"] as string) : null;
    let absolute = false;
    const expr = value["expression"];
    if (!column && isRecord(expr)) {
      let node: unknown = expr;
      while (isRecord(node) && (node["kind"] === "abs" || node["kind"] === "neg")) {
        if (node["kind"] === "abs") absolute = true;
        node = node["value"];
      }
      if (isRecord(node) && node["kind"] === "column" && typeof node["name"] === "string") column = node["name"] as string;
    }
    return { column, aggregate, absolute };
  };
  const single = fromValue(chart["value"]) ?? fromValue(chart["y"]);
  if (single) refs.push(single);
  const series = chart["series"];
  if (Array.isArray(series)) {
    for (const entry of series) {
      const ref = isRecord(entry) ? fromValue(entry["value"]) : null;
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

function chartCoversMetric(chart: unknown, column: string, aggregate: Agg | null, absolute: boolean): boolean {
  return chartMetricRefs(chart).some(
    (ref) =>
      ref.column?.toLowerCase() === column.toLowerCase() &&
      (aggregate === null || ref.aggregate === aggregate) &&
      (!absolute || ref.absolute),
  );
}

function metricCovers(metric: GroupMetric, column: string, aggregate: Agg | null, absolute: boolean): boolean {
  if (metric.metric === "count") return false;
  if (aggregate !== null && metric.metric !== aggregate) return false;
  return exprCovers(metric.target, column, absolute);
}

/** Recursively collects every column named anywhere inside a `where` tree. */
function whereColumns(where: unknown, out: Set<string>): void {
  if (!isRecord(where)) return;
  if (typeof where["column"] === "string") out.add((where["column"] as string).toLowerCase());
  if (where["kind"] === "column" && typeof where["name"] === "string") out.add((where["name"] as string).toLowerCase());
  for (const value of Object.values(where)) {
    if (Array.isArray(value)) for (const entry of value) whereColumns(entry, out);
    else if (isRecord(value)) whereColumns(value, out);
  }
}

/** True when a goal is a filtered count whose condition touches the predicate's column. */
function goalCoversCondition(goal: AnalysisGoal, condition: RequirementCondition): boolean {
  const request = goal.request;
  if (!request) return false;
  const cols = new Set<string>();
  if (request.op === "count" && request.where) whereColumns(request.where, cols);
  else if (request.op === "group_by") {
    for (const metric of request.metrics) if (metric.metric === "count" && metric.where) whereColumns(metric.where, cols);
  } else return false;
  return cols.has(condition.column.toLowerCase());
}

function exprCovers(target: Expression | undefined, column: string, absolute: boolean): boolean {
  if (!target) return false;
  const columnName = (expr: Expression): string | null => {
    if (expr.kind === "column") return expr.name;
    if (expr.kind === "abs" || expr.kind === "neg") return columnName(expr.value);
    return null;
  };
  const hasAbs = (expr: Expression): boolean =>
    expr.kind === "abs" || ((expr.kind === "neg") && hasAbs(expr.value));
  return columnName(target)?.toLowerCase() === column.toLowerCase() && (!absolute || hasAbs(target));
}

/**
 * Compares the user's requirements to the goals actually planned. A gap becomes a
 * goal-scoped repair message. Missing named dimensions must remain in the plan so
 * execution can surface an explicit partial failure.
 */
export function checkCoverage(requirements: RequirementSet, goals: readonly AnalysisGoal[], headers: readonly string[]): readonly CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const headerSet = new Set(headers.map((header) => header.toLowerCase()));

  // columns already consumed by a correlation goal (as x / y) don't need an aggregate goal
  const correlationColumns = new Set<string>();
  for (const goal of goals) {
    const request = goal.request;
    if (request?.op === "correlation" || request?.op === "group_correlation") {
      for (const side of [request.x, request.y]) {
        const name = side.kind === "column" ? side.name : side.kind === "abs" || side.kind === "neg" ? (side.value.kind === "column" ? side.value.name : null) : null;
        if (name) correlationColumns.add(name.toLowerCase());
      }
    }
  }

  for (const requirement of requirements.metrics) {
    // only enforce EXPLICIT requirements (an aggregate word or "absolute"); a bare
    // header mention is left to the model's one-goal-per-requirement discipline.
    // (`extractRequirements` already drops a predicate-only column, so anything
    // still here has a real aggregate word and IS an aggregate requirement — even
    // if the same column also carries a `> N` predicate elsewhere in the prompt.)
    if (requirement.aggregate === null && !requirement.absolute) continue;
    if (correlationColumns.has(requirement.column.toLowerCase())) continue;
    if (!goalMetricMatches(goals, requirement.column, requirement.aggregate, requirement.absolute)) {
      gaps.push({
        kind: "metric",
        detail: `${requirement.absolute ? "absolute " : ""}${requirement.aggregate ?? "an aggregate"} of "${requirement.column}" is not produced by any goal`,
      });
    }
  }

  // every row-filter predicate needs a filtered-count goal — NOT an aggregate (§2).
  for (const condition of requirements.conditions) {
    const covered = goals.some((goal) => goalCoversCondition(goal, condition));
    if (!covered) {
      const rhs = isRecord(condition.value) && "column" in condition.value
        ? (condition.value as { column: string }).column
        : isRecord(condition.value) && "percent" in condition.value
          ? `${(condition.value as { percent: number }).percent}%`
          : String(condition.value);
      gaps.push({
        kind: "metric",
        detail: `a filtered row-count for ${condition.absolute ? "|" : ""}${condition.column}${condition.absolute ? "|" : ""} ${condition.op} ${rhs} is not produced by any goal (use kind:"filter_count", never an aggregate)`,
      });
    }
  }

  if (requirements.countRequirement) {
    const hasCount = goals.some(
      (goal) =>
        goal.request?.op === "count" ||
        (goal.request?.op === "group_by" && goal.request.metrics.some((metric) => metric.metric === "count")),
    );
    if (!hasCount) gaps.push({ kind: "count", detail: "a row-count requirement has no count metric / count goal" });
  }

  for (const dimension of requirements.dimensions) {
    const covered = goals.some((goal) => goal.request?.op === "group_by" && goal.request.by.some((by) => by.toLowerCase() === dimension.toLowerCase()));
    if (!covered && (goal_hasGroupBy(goals) || !headerSet.has(dimension.toLowerCase()))) {
      gaps.push({ kind: "dimension", detail: `no goal groups by "${dimension}"` });
    }
  }

  if (requirements.rankings > 0 && !goals.some((goal) => goal.type === "ranking")) {
    gaps.push({ kind: "ranking", detail: "a highest/lowest requirement has no ranking goal" });
  }
  if (requirements.visualization && !goals.some((goal) => goal.type === "visualization")) {
    gaps.push({ kind: "visualization", detail: "a chart was requested but no visualization goal exists" });
  }
  return gaps;
}

function goal_hasGroupBy(goals: readonly AnalysisGoal[]): boolean {
  return goals.some((goal) => goal.request?.op === "group_by");
}

/**
 * Heuristic: does this prompt carry several distinct requirements (so it needs a
 * compound plan, not a single analysis plan)? Conservative — a single chart or a
 * single "which is highest" question is NOT compound.
 */
export function isCompoundRequest(prompt: string, headers: readonly string[] = []): boolean {
  const requirements = extractRequirements(prompt, headers);
  // an explicitly-aggregated named-column metric, or a row-count ask
  const explicitMetrics =
    requirements.metrics.filter((metric) => metric.aggregate !== null || metric.absolute).length +
    (requirements.countRequirement ? 1 : 0);
  const headerSetLc = new Set(headers.map((header) => header.toLowerCase()));
  const namesAvailableDimension = requirements.dimensions.some((dimension) => headerSetLc.has(dimension.toLowerCase()));

  // Stage 21.2.8 §2 — a row-filter predicate plus a "total / count / percentage" ask
  // is a multi-part request: total rows, conditional count, and their share must each
  // be their own deterministic goal (never mean(abs(x))).
  if (requirements.conditions.length > 0 && (requirements.countRequirement || requirements.groupShare)) return true;

  // Stage 21.2.8 §3 — "aggregate X per <dimension> and name the top group" is compound:
  // one metric goal + one dependent ranking. (A bare "which is highest" with no
  // grouping phrase stays a single analysis plan.)
  if (explicitMetrics >= 1 && requirements.rankings > 0 && namesAvailableDimension) return true;

  // Stage 21.2.8 §5 — "which group is most common and what share of the total" —
  // count-by-dimension + a frequency ranking + a share of the total.
  if (requirements.frequency && (requirements.groupShare || namesAvailableDimension || requirements.rankings > 0)) return true;

  // The user named a grouping column that is absent from the selection. Route
  // through the compound path so the partial-failure machinery (a per-goal
  // COLUMN_NOT_AVAILABLE, the completeness gate) engages instead of the plain
  // analysis path silently dropping it (Stage 21.2.6 §16/§18).
  const headerSet = new Set(headers.map((header) => header.toLowerCase()));
  const namesMissingDimension =
    requirements.dimensions.length > 0 &&
    requirements.dimensions.some((dimension) => !headerSet.has(dimension.toLowerCase())) &&
    requirements.dimensions.some((dimension) => headerSet.has(dimension.toLowerCase()));
  if (namesMissingDimension && (explicitMetrics >= 1 || requirements.correlation)) return true;

  // A chart-only request remains a visualization plan even when it names two
  // plotted metrics; the chart itself covers those metrics deterministically.
  if (requirements.visualization && !requirements.comparison && !requirements.interpretation && requirements.rankings === 0 && !requirements.countRequirement) {
    return false;
  }

  return (
    explicitMetrics >= 2 ||
    (requirements.visualization && explicitMetrics >= 1) ||
    (requirements.interpretation && explicitMetrics >= 1) ||
    (requirements.comparison && explicitMetrics >= 2) ||
    (requirements.correlation && requirements.rankings > 0)
  );
}

/** Deterministically compares two named groups using their scalar VerifiedFacts. */
function comparePairFact(facts: readonly VerifiedFact[], groupA: string, groupB: string, seq: number): ComparisonFact | null {
  const scalarFor = (group: string) =>
    facts.find(
      (fact): fact is Extract<VerifiedFact, { kind: "scalar" }> =>
        fact.kind === "scalar" && "group" in fact && (fact.group ?? "").toLowerCase() === group.toLowerCase(),
    );
  const a = scalarFor(groupA);
  const b = scalarFor(groupB);
  if (!a || !b) return null;
  const relation = a.value > b.value ? "greater_than" : a.value < b.value ? "less_than" : "equal";
  const symbol = relation === "greater_than" ? ">" : relation === "less_than" ? "<" : "=";
  return {
    id: `F${seq}`,
    kind: "comparison",
    label: `${groupA} vs ${groupB} by ${a.metric}`,
    formatted: `${groupA} (${a.formatted}) ${symbol} ${groupB} (${b.formatted})`,
    sourceOperationId: a.sourceOperationId,
    sourceRange: a.sourceRange,
    subject: groupA,
    relation,
    object: groupB,
    subjectValue: a.value,
    objectValue: b.value,
  };
}

// ===========================================================================
// Compact GoalIntent schema + deterministic compiler (Stage 21.2.6).
//
// Root cause of the 21.2.6 live-compound blocker: the model had to emit the
// whole executable CompoundPlan in one shot — nested engine operation ASTs,
// full visualization requests, and a hand-maintained G1/G2 dependency graph.
// Qwen could not produce that as valid JSON reliably and the plan repeatedly
// failed to parse; SheetAgent (correctly) refused and fell back.
//
// The model now emits a small, flat list of typed GoalIntents (enums, header
// names, one compact condition, one compact chart intent). SheetAgent:
//   1. assigns the goal ids            (the model never writes an id)
//   2. orders goals so every dependency points backwards
//   3. resolves ranking / comparison dependencies SEMANTICALLY — by the metric
//      they rank / compare, not by an id the model invented (§10)
//   4. compiles every executable operation itself (§12 "compile, don't trust")
//
// The expanded plan is then run through parseCompoundPlan, so ALL existing
// structural / canonicalization / one-metric-per-goal / cycle / depth checks
// still apply unchanged. Every compiled goal `description` is generated here
// from the typed intent, so no model free-text can reach GOAL STATUS, the
// deterministic fallback or the answer prompt (§19).
// ===========================================================================

export type GoalIntentKind =
  | "group_metric"
  | "metric"
  | "filter_count"
  | "correlation"
  | "ranking"
  | "comparison"
  | "visualization"
  | "interpretation";

export type IntentAggregate = "count" | "sum" | "mean" | "median" | "min" | "max";

const INTENT_AGGREGATES = new Set<IntentAggregate>(["count", "sum", "mean", "median", "min", "max"]);
const INTENT_CONDITION_OPS = new Set(["=", "!=", ">", ">=", "<", "<="]);
const INTENT_CHART_TYPES = new Set(["bar", "line", "scatter", "pie", "histogram"]);
const ANALYTICAL_INTENT_KINDS = new Set<GoalIntentKind>(["group_metric", "metric", "filter_count", "correlation"]);
const ALL_INTENT_KINDS = new Set<GoalIntentKind>([
  "group_metric",
  "metric",
  "filter_count",
  "correlation",
  "ranking",
  "comparison",
  "visualization",
  "interpretation",
]);

export interface IntentCondition {
  readonly column: string;
  readonly op: "=" | "!=" | ">" | ">=" | "<" | "<=";
  readonly value: number | string | boolean | { readonly percent: number } | { readonly column: string };
  readonly absolute?: boolean;
}

export interface IntentMetricRef {
  readonly aggregate: IntentAggregate;
  readonly column?: string;
  readonly absolute?: boolean;
  readonly by?: readonly string[];
}

export interface IntentChart {
  readonly type: "bar" | "line" | "scatter" | "pie" | "histogram";
  readonly title?: string;
  readonly dimension?: string;
  readonly metrics?: readonly { readonly aggregate: IntentAggregate; readonly column?: string; readonly absolute?: boolean }[];
  readonly x?: string;
  readonly y?: string;
  readonly groupBy?: string;
  readonly mode?: "grouped" | "stacked";
  readonly bins?: number;
}

/** One flat, typed unit of user intent. No ids, no dependency refs, no engine AST. */
export interface GoalIntent {
  readonly kind: GoalIntentKind;
  readonly aggregate?: IntentAggregate;
  readonly column?: string;
  readonly absolute?: boolean;
  readonly by?: readonly string[];
  readonly where?: IntentCondition;
  readonly x?: string;
  readonly y?: string;
  readonly of?: IntentMetricRef;
  readonly direction?: "max" | "min";
  readonly groups?: readonly [string, string];
  readonly on?: IntentMetricRef;
  readonly chart?: IntentChart;
}

/** Does this raw plan block declare the compact `{"kind":"compound","intents":[...]}` form? */
export function looksIntentCompound(raw: unknown): boolean {
  if (typeof raw === "string") {
    return /"kind"\s*:\s*"compound"/.test(raw) && /"intents"\s*:/.test(raw);
  }
  return isRecord(raw) && raw["kind"] === "compound" && "intents" in raw;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(nonEmptyString)) return null;
  return value.map((entry) => (entry as string));
}

function intentError(pos: number, message: string): CompoundPlanError {
  return { code: "COMPOUND_INTENT_INVALID", error: `intent #${pos}: ${message}`, repairGoals: [String(pos)] };
}

function parseCondition(raw: unknown, pos: number): IntentCondition | CompoundPlanError {
  if (!isRecord(raw)) return intentError(pos, "`where` must be an object {column, op, value}");
  if (!nonEmptyString(raw["column"])) return intentError(pos, "`where.column` must be a header name");
  if (typeof raw["op"] !== "string" || !INTENT_CONDITION_OPS.has(raw["op"])) {
    return intentError(pos, "`where.op` must be one of = != > >= < <=");
  }
  const value = raw["value"];
  const okValue =
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (isRecord(value) && typeof value["percent"] === "number" && Number.isFinite(value["percent"])) ||
    (isRecord(value) && nonEmptyString(value["column"]));
  if (!okValue) return intentError(pos, '`where.value` must be a number, string, boolean, {"percent":N} or {"column":"Header"}');
  return {
    column: raw["column"],
    op: raw["op"] as IntentCondition["op"],
    value: value as IntentCondition["value"],
    ...(raw["absolute"] === true ? { absolute: true } : {}),
  };
}

function parseMetricRef(raw: unknown, pos: number, label: string): IntentMetricRef | CompoundPlanError {
  if (!isRecord(raw)) return intentError(pos, `\`${label}\` must be {aggregate, column?, absolute?, by?}`);
  const aggregate = raw["aggregate"];
  if (typeof aggregate !== "string" || !INTENT_AGGREGATES.has(aggregate as IntentAggregate)) {
    return intentError(pos, `\`${label}.aggregate\` must be count/sum/mean/median/min/max`);
  }
  if (aggregate !== "count" && !nonEmptyString(raw["column"])) {
    return intentError(pos, `\`${label}.column\` is required unless aggregate is "count"`);
  }
  const by = raw["by"] === undefined ? undefined : stringArray(raw["by"]);
  if (raw["by"] !== undefined && by === null) return intentError(pos, `\`${label}.by\` must be a non-empty array of header names`);
  return {
    aggregate: aggregate as IntentAggregate,
    ...(nonEmptyString(raw["column"]) ? { column: raw["column"] } : {}),
    ...(raw["absolute"] === true ? { absolute: true } : {}),
    ...(by ? { by } : {}),
  };
}

function parseChartIntent(raw: unknown, pos: number): IntentChart | CompoundPlanError {
  if (!isRecord(raw)) return intentError(pos, "`chart` must be an object");
  if (typeof raw["type"] !== "string" || !INTENT_CHART_TYPES.has(raw["type"])) {
    return intentError(pos, "`chart.type` must be bar/line/scatter/pie/histogram");
  }
  const metricsRaw = raw["metrics"];
  let metrics: IntentChart["metrics"];
  if (metricsRaw !== undefined) {
    if (!Array.isArray(metricsRaw) || metricsRaw.length === 0) return intentError(pos, "`chart.metrics` must be a non-empty array");
    const parsed: { aggregate: IntentAggregate; column?: string; absolute?: boolean }[] = [];
    for (const entry of metricsRaw) {
      if (!isRecord(entry) || typeof entry["aggregate"] !== "string" || !INTENT_AGGREGATES.has(entry["aggregate"] as IntentAggregate)) {
        return intentError(pos, "each `chart.metrics` entry needs a valid `aggregate`");
      }
      if (entry["aggregate"] !== "count" && !nonEmptyString(entry["column"])) {
        return intentError(pos, "each non-count `chart.metrics` entry needs a `column`");
      }
      parsed.push({
        aggregate: entry["aggregate"] as IntentAggregate,
        ...(nonEmptyString(entry["column"]) ? { column: entry["column"] } : {}),
        ...(entry["absolute"] === true ? { absolute: true } : {}),
      });
    }
    metrics = parsed;
  }
  if (raw["bins"] !== undefined && (typeof raw["bins"] !== "number" || !Number.isInteger(raw["bins"]))) {
    return intentError(pos, "`chart.bins` must be an integer");
  }
  if (raw["mode"] !== undefined && raw["mode"] !== "grouped" && raw["mode"] !== "stacked") {
    return intentError(pos, "`chart.mode` must be 'grouped' or 'stacked'");
  }
  // per-type required fields — a chart missing these compiles to an invalid
  // visualization request and fails silently at render, so reject it now.
  const type = raw["type"] as IntentChart["type"];
  if ((type === "bar" || type === "pie") && !nonEmptyString(raw["dimension"])) {
    return intentError(pos, `\`chart.dimension\` (the category column) is required for a ${type} chart`);
  }
  if ((type === "bar" || type === "pie") && (!Array.isArray(metrics) || metrics.length === 0)) {
    return intentError(pos, `a ${type} chart needs \`chart.metrics\` (e.g. [{"aggregate":"mean","column":"Plan"}])`);
  }
  if (type === "scatter" && (!nonEmptyString(raw["x"]) || !nonEmptyString(raw["y"]))) {
    return intentError(pos, "a scatter chart needs `chart.x` and `chart.y` header names");
  }
  if (type === "line" && (!nonEmptyString(raw["x"]) || (!nonEmptyString(raw["y"]) && (!metrics || metrics.length === 0)))) {
    return intentError(pos, "a line chart needs `chart.x` plus `chart.y` or `chart.metrics`");
  }
  if (type === "histogram" && !nonEmptyString(raw["dimension"]) && !nonEmptyString(raw["x"])) {
    return intentError(pos, "a histogram needs `chart.dimension` (the value column)");
  }
  return {
    type,
    ...(nonEmptyString(raw["title"]) ? { title: (raw["title"] as string).slice(0, 120) } : {}),
    ...(nonEmptyString(raw["dimension"]) ? { dimension: raw["dimension"] } : {}),
    ...(metrics ? { metrics } : {}),
    ...(nonEmptyString(raw["x"]) ? { x: raw["x"] } : {}),
    ...(nonEmptyString(raw["y"]) ? { y: raw["y"] } : {}),
    ...(nonEmptyString(raw["groupBy"]) ? { groupBy: raw["groupBy"] } : {}),
    ...(raw["mode"] === "grouped" || raw["mode"] === "stacked" ? { mode: raw["mode"] } : {}),
    ...(typeof raw["bins"] === "number" ? { bins: raw["bins"] } : {}),
  };
}

function parseOneIntent(raw: unknown, pos: number): GoalIntent | CompoundPlanError {
  if (!isRecord(raw)) return intentError(pos, "must be an object");
  const kind = raw["kind"];
  if (typeof kind !== "string" || !ALL_INTENT_KINDS.has(kind as GoalIntentKind)) {
    return intentError(pos, `unknown kind "${String(kind)}"`);
  }
  const k = kind as GoalIntentKind;

  const by = raw["by"] === undefined ? undefined : stringArray(raw["by"]);
  if (raw["by"] !== undefined && by === null) return intentError(pos, "`by` must be a non-empty array of header names");

  if (k === "group_metric" || k === "metric") {
    const aggregate = raw["aggregate"];
    if (typeof aggregate !== "string" || !INTENT_AGGREGATES.has(aggregate as IntentAggregate)) {
      return intentError(pos, "`aggregate` must be count/sum/mean/median/min/max");
    }
    if (aggregate !== "count" && !nonEmptyString(raw["column"])) return intentError(pos, '`column` is required unless aggregate is "count"');
    if (k === "group_metric" && !by) return intentError(pos, "`group_metric` needs a non-empty `by`");
    let where: IntentCondition | undefined;
    if (raw["where"] !== undefined) {
      const parsed = parseCondition(raw["where"], pos);
      if ("code" in parsed) return parsed;
      where = parsed;
    }
    return {
      kind: k,
      aggregate: aggregate as IntentAggregate,
      ...(nonEmptyString(raw["column"]) ? { column: raw["column"] } : {}),
      ...(raw["absolute"] === true ? { absolute: true } : {}),
      ...(by ? { by } : {}),
      ...(where ? { where } : {}),
    };
  }

  if (k === "filter_count") {
    if (raw["where"] === undefined) return intentError(pos, "`filter_count` needs a `where`");
    const where = parseCondition(raw["where"], pos);
    if ("code" in where) return where;
    return { kind: k, where, ...(by ? { by } : {}) };
  }

  if (k === "correlation") {
    if (!nonEmptyString(raw["x"]) || !nonEmptyString(raw["y"])) return intentError(pos, "`correlation` needs header names `x` and `y`");
    return { kind: k, x: raw["x"], y: raw["y"], ...(by ? { by } : {}) };
  }

  if (k === "ranking") {
    if (raw["direction"] !== undefined && raw["direction"] !== "max" && raw["direction"] !== "min") {
      return intentError(pos, "`ranking.direction` must be 'max' or 'min'");
    }
    let of: IntentMetricRef | undefined;
    if (raw["of"] !== undefined) {
      const parsed = parseMetricRef(raw["of"], pos, "of");
      if ("code" in parsed) return parsed;
      of = parsed;
    }
    return { kind: k, ...(of ? { of } : {}), direction: raw["direction"] === "min" ? "min" : "max" };
  }

  if (k === "comparison") {
    const groups = raw["groups"];
    if (!Array.isArray(groups) || groups.length !== 2 || !groups.every(nonEmptyString)) {
      return intentError(pos, "`comparison.groups` must be exactly two group names");
    }
    let on: IntentMetricRef | undefined;
    if (raw["on"] !== undefined) {
      const parsed = parseMetricRef(raw["on"], pos, "on");
      if ("code" in parsed) return parsed;
      on = parsed;
    }
    return { kind: k, groups: [groups[0] as string, groups[1] as string], ...(on ? { on } : {}) };
  }

  if (k === "visualization") {
    const chart = parseChartIntent(raw["chart"], pos);
    if ("code" in chart) return chart;
    return { kind: k, chart };
  }

  return { kind: "interpretation" };
}

/**
 * Deterministic single-payload extraction (Stage 21.2.6 §14). Returns the first
 * brace-balanced `{...}` region of `text`, tolerating a ```json / ``` wrapper or
 * prose around the object. It NEVER repairs invalid JSON: unbalanced braces
 * (a truncated payload) yield `null`, and the caller fails closed.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced — truncated or malformed; fail closed
}

/** Parses the compact `intents` array. Fails closed with a typed, position-scoped error. */
export function parseGoalIntents(raw: unknown): readonly GoalIntent[] | CompoundPlanError {
  let value: unknown = raw;
  if (typeof value === "string") {
    const text: string = value;
    try {
      value = JSON.parse(text);
    } catch {
      // The model wrapped valid JSON in a ```json fence or surrounded it with prose:
      // pull out the single first balanced object and parse THAT. No repair.
      const extracted = extractFirstJsonObject(text);
      if (extracted === null) {
        return { code: "COMPOUND_INTENT_INVALID", error: "the compound plan block was not valid JSON" };
      }
      try {
        value = JSON.parse(extracted);
      } catch {
        return { code: "COMPOUND_INTENT_INVALID", error: "the compound plan block was not valid JSON" };
      }
    }
  }
  if (!isRecord(value) || value["kind"] !== "compound") {
    return { code: "COMPOUND_SHAPE", error: 'a compound plan must be {"kind":"compound","intents":[...]}' };
  }
  const list = value["intents"];
  if (!Array.isArray(list) || list.length === 0) {
    return { code: "COMPOUND_EMPTY", error: "a compound plan needs a non-empty `intents` array" };
  }
  if (list.length > COMPOUND_LIMITS.maxGoals) {
    return { code: "COMPOUND_TOO_MANY_GOALS", error: `too many intents (${list.length}, max ${COMPOUND_LIMITS.maxGoals})` };
  }
  const intents: GoalIntent[] = [];
  for (const [index, rawIntent] of list.entries()) {
    const parsed = parseOneIntent(rawIntent, index + 1);
    if ("code" in parsed) return parsed;
    intents.push(parsed);
  }
  return intents;
}

// --- deterministic compilation -------------------------------------------------

function columnExpr(name: string, absolute?: boolean): Expression {
  const column: Expression = { kind: "column", name };
  return absolute ? { kind: "abs", value: column } : column;
}

function conditionFor(where: IntentCondition): Record<string, unknown> {
  const value = where.value;
  const rhs =
    isRecord(value) && typeof (value as { percent?: unknown }).percent === "number"
      ? { kind: "percent", value: (value as { percent: number }).percent }
      : isRecord(value) && typeof (value as { column?: unknown }).column === "string"
        ? { column: (value as { column: string }).column }
        : value;
  return {
    left: where.absolute ? { kind: "abs", value: { kind: "column", name: where.column } } : { column: where.column },
    operator: where.op,
    value: rhs,
  };
}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "");
}

function metricName(aggregate: IntentAggregate, column: string | undefined, absolute: boolean | undefined): string {
  if (aggregate === "count") return "count";
  return `${aggregate}_${absolute ? "abs_" : ""}${slug(column ?? "value")}`;
}

function refKey(aggregate: IntentAggregate, column: string | undefined, absolute: boolean | undefined, by: readonly string[] | undefined): string {
  return stableStringify({ aggregate, column: column ?? null, absolute: Boolean(absolute), by: by ? [...by].sort() : null });
}

function describeMetric(aggregate: IntentAggregate, column: string | undefined, absolute: boolean | undefined): string {
  if (aggregate === "count") return "count";
  const inner = absolute ? `|${column}|` : `${column}`;
  return `${aggregate} of ${inner}`;
}

interface AnalyticalMeta {
  readonly id: string;
  readonly key: string;
}

/**
 * Expands a validated GoalIntent[] into a CompoundPlan, then runs it through
 * parseCompoundPlan so every existing structural guarantee still holds.
 * Deterministic: same intents → byte-identical plan (ids, order, descriptions).
 */
export function compileGoalIntents(intents: readonly GoalIntent[]): CompoundPlan | CompoundPlanError {
  const analytical = intents.filter((intent) => ANALYTICAL_INTENT_KINDS.has(intent.kind));
  const rankings = intents.filter((intent) => intent.kind === "ranking");
  const comparisons = intents.filter((intent) => intent.kind === "comparison");
  const visualizations = intents.filter((intent) => intent.kind === "visualization");
  const interpretations = intents.filter((intent) => intent.kind === "interpretation");

  const goals: Record<string, unknown>[] = [];
  const meta: AnalyticalMeta[] = [];
  let seq = 0;
  const nextId = () => `G${(seq += 1)}`;

  // 1. analytical goals first — one request, one logical metric each.
  for (const intent of analytical) {
    const id = nextId();
    if (intent.kind === "correlation") {
      const request = intent.by
        ? { op: "group_correlation", by: [...intent.by], x: { kind: "column", name: intent.x }, y: { kind: "column", name: intent.y } }
        : { op: "correlation", x: { kind: "column", name: intent.x }, y: { kind: "column", name: intent.y } };
      goals.push({ id, type: "correlation", description: `Pearson r of ${intent.x} vs ${intent.y}${intent.by ? ` by ${intent.by.join(" × ")}` : ""}`, dependsOn: [], request });
      meta.push({ id, key: stableStringify({ correlation: [intent.x, intent.y].sort(), by: intent.by ? [...intent.by].sort() : null }) });
      continue;
    }
    if (intent.kind === "filter_count") {
      const cond = intent.where as IntentCondition; // parseGoalIntents guarantees `where` on filter_count
      const condition = conditionFor(cond);
      // a UNIQUE metric name per predicate, so two filtered counts over the same
      // `by` do not collide in the merged group_by operation (Stage 21.2.8 §2).
      const rhsSlug =
        isRecord(cond.value) && typeof (cond.value as { percent?: unknown }).percent === "number"
          ? `p${(cond.value as { percent: number }).percent}`
          : isRecord(cond.value) && typeof (cond.value as { column?: unknown }).column === "string"
            ? slug((cond.value as { column: string }).column)
            : slug(String(cond.value));
      const name = `matched_${slug(cond.column)}${cond.absolute ? "_abs" : ""}_${cond.op.replace(/[<>=!]/g, (c) => ({ "<": "lt", ">": "gt", "=": "eq", "!": "n" }[c] ?? ""))}_${rhsSlug}`;
      const request = intent.by
        ? { op: "group_by", by: [...intent.by], metrics: [{ metric: "count", name, where: condition }] }
        : { op: "count", where: condition };
      goals.push({
        id,
        type: "filter_count",
        description: `count where ${cond.absolute ? "|" : ""}${cond.column}${cond.absolute ? "|" : ""} ${cond.op} …${intent.by ? ` by ${intent.by.join(" × ")}` : ""}`,
        dependsOn: [],
        request,
      });
      // condition-specific meta key so a {aggregate:"count"} ranking ref binds only
      // to the plain "count by <dim>" goal, never to a filtered count.
      meta.push({ id, key: stableStringify({ filterCount: name, by: intent.by ? [...intent.by].sort() : null }) });
      continue;
    }
    // group_metric | metric
    const where = intent.where ? conditionFor(intent.where) : undefined;
    const name = metricName(intent.aggregate as IntentAggregate, intent.column, intent.absolute);
    if (intent.kind === "group_metric") {
      const metric: Record<string, unknown> = { metric: intent.aggregate, name };
      if (intent.aggregate !== "count") metric["target"] = columnExpr(intent.column as string, intent.absolute);
      if (where) metric["where"] = where;
      goals.push({
        id,
        type: "group_metric",
        description: `${describeMetric(intent.aggregate as IntentAggregate, intent.column, intent.absolute)} by ${(intent.by as string[]).join(" × ")}`,
        dependsOn: [],
        request: { op: "group_by", by: [...(intent.by as string[])], metrics: [metric] },
      });
      meta.push({ id, key: refKey(intent.aggregate as IntentAggregate, intent.column, intent.absolute, intent.by) });
    } else {
      const request =
        intent.aggregate === "count"
          ? { op: "count", ...(where ? { where } : {}) }
          : { op: "aggregate", metric: intent.aggregate, target: columnExpr(intent.column as string, intent.absolute), ...(where ? { where } : {}) };
      goals.push({
        id,
        type: "metric",
        description: `${describeMetric(intent.aggregate as IntentAggregate, intent.column, intent.absolute)} (whole selection)`,
        dependsOn: [],
        request,
      });
      meta.push({ id, key: refKey(intent.aggregate as IntentAggregate, intent.column, intent.absolute, undefined) });
    }
  }

  const bindRef = (ref: IntentMetricRef | undefined): string | null => {
    if (!ref) return meta.length === 1 ? (meta[0] as AnalyticalMeta).id : null;
    const wanted = ref.aggregate === "count"
      ? refKey("count", undefined, false, ref.by)
      : refKey(ref.aggregate, ref.column, ref.absolute, ref.by);
    const hit = meta.find((entry) => entry.key === wanted);
    return hit ? hit.id : null;
  };

  // 2. ranking goals — bound to the metric they rank (never an id the model wrote).
  for (const [i, intent] of rankings.entries()) {
    const target = bindRef(intent.of);
    if (!target) {
      return {
        code: "COMPOUND_INTENT_UNBOUND",
        error: `a ranking intent does not match any metric intent — add \`of\` naming the exact aggregate/column/by it ranks, and include that metric as its own intent`,
        repairGoals: [String(analytical.length + i + 1)],
      };
    }
    const dir = intent.direction ?? "max";
    const of = intent.of;
    goals.push({
      id: nextId(),
      type: "ranking",
      description: `${dir === "max" ? "largest" : "smallest"} ${of ? describeMetric(of.aggregate, of.column, of.absolute) : "metric"}${of?.by ? ` by ${of.by.join(" × ")}` : ""}`,
      dependsOn: [target],
      select: dir,
    });
  }

  // 3. comparison goals.
  for (const [i, intent] of comparisons.entries()) {
    const target = bindRef(intent.on);
    if (!target) {
      return {
        code: "COMPOUND_INTENT_UNBOUND",
        error: `a comparison intent does not match any metric intent — add \`on\` naming the metric it compares`,
        repairGoals: [String(analytical.length + rankings.length + i + 1)],
      };
    }
    goals.push({
      id: nextId(),
      type: "comparison",
      description: `${(intent.groups as [string, string])[0]} vs ${(intent.groups as [string, string])[1]}`,
      dependsOn: [target],
      groups: [...(intent.groups as [string, string])],
    });
  }

  // 4. visualization goals.
  for (const intent of visualizations) {
    goals.push({
      id: nextId(),
      type: "visualization",
      description: `${intent.chart?.type ?? "chart"} chart`,
      dependsOn: [],
      chart: intentChartToRequest(intent.chart as IntentChart),
    });
  }

  // 5. interpretation goals — qualitative only, never carry model prose.
  for (let n = 0; n < interpretations.length; n += 1) {
    goals.push({ id: nextId(), type: "interpretation", description: "interpretation", dependsOn: [] });
  }

  if (goals.length === 0) {
    return { code: "COMPOUND_EMPTY", error: "no goals were produced from the intents" };
  }
  return parseCompoundPlan({ kind: "compound", goals });
}

// --- deterministic compound floor (Stage 21.2.6) ----------------------------

/**
 * When live Qwen never produces an acceptable compound plan within the bounded
 * attempts, SheetAgent builds one itself from the deterministically-extracted
 * requirements — so a multi-part request still runs through the full compound
 * pipeline (VerifiedFacts, GOAL STATUS, completeness gate) instead of collapsing
 * to a free-form answer. This is intent compilation (§7-12), not a retry.
 *
 * Returns `null` when there is no usable grouping dimension (the caller then
 * falls back to the plain analysis floor).
 */
export function synthesizeCompoundIntents(
  prompt: string,
  headers: readonly string[],
  groupingColumn: string | null,
  numericHeaders: ReadonlySet<string>,
): GoalIntent[] | null {
  if (!groupingColumn) return null;
  const req = extractRequirements(prompt, headers);
  const by = [groupingColumn];
  const lower = ` ${prompt.toLowerCase()} `;
  const intents: GoalIntent[] = [];
  const coveredColumns = new Set<string>();

  // columns that appear only inside a row-filter predicate — they become filtered
  // counts, never mean/sum goals (Stage 21.2.8 §2).
  const conditionColumns = new Set<string>();
  for (const condition of req.conditions) {
    conditionColumns.add(condition.column.toLowerCase());
    if (isRecord(condition.value) && "column" in condition.value) conditionColumns.add((condition.value as { column: string }).column.toLowerCase());
  }

  intents.push({ kind: "group_metric", aggregate: "count", by });

  // a grouping column the user named but that is absent from the selection keeps
  // its OWN goal so execution reports it unavailable (§9/§16 — no silent loss).
  for (const dimension of req.dimensions) {
    if (dimension === groupingColumn || headers.some((header) => header.toLowerCase() === dimension.toLowerCase())) continue;
    intents.push({ kind: "group_metric", aggregate: "count", by: [dimension] });
  }

  // row-filter predicates → one filtered count per condition (Stage 21.2.8 §2). The
  // engine's group_by count{where} also yields the within-group share (= percentage).
  for (const condition of req.conditions) {
    const value = isRecord(condition.value) && "percent" in condition.value
      ? { percent: (condition.value as { percent: number }).percent }
      : isRecord(condition.value) && "column" in condition.value
        ? { column: (condition.value as { column: string }).column }
        : (condition.value as number);
    intents.push({
      kind: "filter_count",
      where: { column: condition.column, op: condition.op, value, ...(condition.absolute ? { absolute: true } : {}) },
      by,
    });
  }

  // a correlation request → ONE correlation intent over the two mentioned numeric
  // columns (never a pair of mean goals — Stage 21.2.8 live regression).
  let hasCorrelation = false;
  if (req.correlation) {
    const mentioned = headers.filter((header) => numericHeaders.has(header) && lower.includes(` ${header.toLowerCase()}`));
    const [x, y] = mentioned;
    if (x && y && x !== groupingColumn && y !== groupingColumn) {
      intents.push({ kind: "correlation", x, y, ...(by ? { by } : {}) });
      coveredColumns.add(x.toLowerCase());
      coveredColumns.add(y.toLowerCase());
      conditionColumns.add(x.toLowerCase()); // suppress bare-mention mean goals for x/y
      conditionColumns.add(y.toLowerCase());
      hasCorrelation = true;
    }
  }

  // explicit aggregate / absolute requirements first
  for (const metric of req.metrics) {
    if (metric.column === groupingColumn || conditionColumns.has(metric.column.toLowerCase())) continue;
    const aggregate = metric.aggregate ?? "mean";
    intents.push({ kind: "group_metric", aggregate, column: metric.column, ...(metric.absolute ? { absolute: true } : {}), by });
    coveredColumns.add(metric.column.toLowerCase());
  }

  // bare-mentioned numeric headers ("Сравни ... Plan, Fact, Revenue ...") → mean
  for (const header of headers) {
    if (header === groupingColumn || coveredColumns.has(header.toLowerCase()) || conditionColumns.has(header.toLowerCase()) || !numericHeaders.has(header)) continue;
    if (!lower.includes(` ${header.toLowerCase()}`)) continue;
    // skip a header whose every prompt occurrence is really part of a longer header
    // already covered (e.g. "Variance" inside "Variance %")
    const shadowed = headers.some(
      (other) =>
        other !== header &&
        other.toLowerCase().includes(header.toLowerCase()) &&
        (coveredColumns.has(other.toLowerCase()) || lower.includes(` ${other.toLowerCase()}`)),
    );
    if (shadowed) continue;
    intents.push({ kind: "group_metric", aggregate: "mean", column: header, by });
    coveredColumns.add(header.toLowerCase());
  }

  const metricIntents = intents.filter((intent) => intent.kind === "group_metric" && intent.aggregate !== "count");
  const absMetric = metricIntents.find((intent) => intent.absolute);
  const direction: "max" | "min" = LOW_WORDS.test(prompt) && !HIGH_WORDS.test(prompt) ? "min" : "max";

  if (req.rankings > 0 && hasCorrelation && metricIntents.length === 0) {
    // "which Category has the strongest correlation" — a ranking with no `of` binds
    // to the lone correlation goal (compileGoalIntents).
    intents.push({ kind: "ranking", direction });
  } else if (req.rankings > 0 && (metricIntents.length > 0 || req.frequency)) {
    // "most common / чаще всего" ranks the row COUNT; otherwise the absolute (or last)
    // metric the user named.
    const target = req.frequency && metricIntents.length === 0 ? null : (absMetric ?? (metricIntents[metricIntents.length - 1] as GoalIntent));
    intents.push({
      kind: "ranking",
      direction,
      of: target
        ? {
            aggregate: target.aggregate as IntentAggregate,
            ...(target.column ? { column: target.column } : {}),
            ...(target.absolute ? { absolute: true } : {}),
            by,
          }
        : { aggregate: "count", by },
    });
  }

  if (req.visualization) {
    const chart = synthesizeChartIntent(prompt, headers, groupingColumn, numericHeaders, metricIntents);
    if (chart) intents.push({ kind: "visualization", chart });
  }

  if (req.interpretation) intents.push({ kind: "interpretation" });

  // an unbound ranking (correlation "which is strongest") binds only when the
  // correlation goal is the SOLE analytical goal — drop the auto count if nothing
  // else needs it.
  if (hasCorrelation && !req.countRequirement) {
    const analytical = intents.filter((i) => ANALYTICAL_INTENT_KINDS.has(i.kind));
    const unboundRanking = intents.some((i) => i.kind === "ranking" && !i.of);
    if (unboundRanking && analytical.length === 2) {
      const idx = intents.findIndex((i) => i.kind === "group_metric" && i.aggregate === "count" && !i.where);
      if (idx >= 0) intents.splice(idx, 1);
    }
  }

  // a lone "count by <dim> and its share of the total" is still a usable floor —
  // the projection adds the share-of-total column deterministically (§5).
  if (intents.length === 1 && (req.groupShare || req.frequency)) return intents;
  return intents.length > 1 ? intents : null;
}

const SCATTER_WORDS = /(scatter|точечн[а-яё]*|рассе[ия]ни)/i;
const HIST_WORDS = /(histogram|гистограмм[а-яё]*|распределени)/i;
const LINE_WORDS = /(line chart|линейн[а-яё]*\s+(?:график|диаграмм)|по\s+времени|over time|trend line)/i;
const PIE_WORDS = /(pie|кругов[а-яё]*|дол[ья]\s+в\s+(?:общ|виде))/i;

/**
 * Deterministically infers a chart specification from the prompt when the model
 * cannot produce a valid one (Stage 21.2.6). Returns `null` if nothing usable
 * can be inferred.
 */
export function synthesizeChartIntent(
  prompt: string,
  headers: readonly string[],
  groupingColumn: string | null,
  numericHeaders: ReadonlySet<string>,
  knownMetrics: readonly GoalIntent[] = [],
): IntentChart | null {
  const lower = ` ${prompt.toLowerCase()} `;
  const mentionedNumeric = headers.filter((header) => numericHeaders.has(header) && lower.includes(` ${header.toLowerCase()}`));
  const title = groupingColumn ? `${groupingColumn} comparison` : "Chart";

  if (SCATTER_WORDS.test(prompt)) {
    const [x, y] = mentionedNumeric;
    if (!x || !y) return null;
    return { type: "scatter", title: `${x} vs ${y}`, x, y, ...(groupingColumn ? { groupBy: groupingColumn } : {}) };
  }
  if (HIST_WORDS.test(prompt)) {
    const value = mentionedNumeric[0];
    if (!value) return null;
    return { type: "histogram", title: `${value} distribution`, dimension: value };
  }
  const metrics = (knownMetrics.length > 0
    ? knownMetrics
        .filter((intent) => intent.kind === "group_metric" && intent.aggregate !== "count" && intent.column)
        .map((intent) => ({
          aggregate: intent.aggregate as IntentAggregate,
          column: intent.column as string,
          ...(intent.absolute ? { absolute: true } : {}),
        }))
    : mentionedNumeric.map((column) => ({ aggregate: "mean" as IntentAggregate, column }))
  ).slice(0, 4);
  if (!groupingColumn || metrics.length === 0) return null;
  if (LINE_WORDS.test(prompt)) {
    const firstColumn = metrics[0]?.column;
    return {
      type: "line",
      title,
      x: groupingColumn,
      ...(metrics.length === 1 && firstColumn ? { y: firstColumn } : { metrics }),
    };
  }
  if (PIE_WORDS.test(prompt) && metrics.length === 1) {
    return { type: "pie", title, dimension: groupingColumn, metrics: [metrics[0] as { aggregate: IntentAggregate; column: string }] };
  }
  return {
    type: "bar",
    title,
    dimension: groupingColumn,
    metrics,
    ...(metrics.length > 1 ? { mode: "grouped" as const } : {}),
  };
}

/** Compact chart intent → the verbose VisualizationRequest shape the engine expects. */
export function intentChartToRequest(chart: IntentChart): Record<string, unknown> {
  const title = chart.title ?? `${chart.type} chart`;
  const aggValue = (m: { aggregate: IntentAggregate; column?: string; absolute?: boolean }): Record<string, unknown> =>
    m.aggregate === "count"
      ? { aggregate: "count" }
      : m.absolute
        ? { aggregate: m.aggregate, expression: { kind: "abs", value: { kind: "column", name: m.column } } }
        : { aggregate: m.aggregate, column: m.column };

  if (chart.type === "scatter") {
    return {
      type: "scatter",
      title,
      x: { column: chart.x },
      y: { column: chart.y },
      ...(chart.groupBy ? { groupBy: { column: chart.groupBy } } : {}),
    };
  }
  if (chart.type === "histogram") {
    return { type: "histogram", title, value: { column: chart.dimension ?? chart.x }, ...(chart.bins ? { bins: chart.bins } : {}) };
  }
  if (chart.type === "line") {
    const base: Record<string, unknown> = { type: "line", title, x: { column: chart.x ?? chart.dimension } };
    if (chart.metrics && chart.metrics.length > 1) {
      base["series"] = chart.metrics.map((m, i) => ({ label: `${describeMetric(m.aggregate, m.column, m.absolute)}`, id: `s${i + 1}`, value: aggValue(m) }));
    } else if (chart.metrics && chart.metrics.length === 1) {
      base["y"] = aggValue(chart.metrics[0] as { aggregate: IntentAggregate; column?: string; absolute?: boolean });
    } else {
      base["y"] = { column: chart.y };
    }
    return base;
  }
  // bar | pie
  const base: Record<string, unknown> = { type: chart.type, title, category: { column: chart.dimension } };
  const metrics = chart.metrics ?? [];
  if (chart.type === "bar" && metrics.length > 1) {
    base["series"] = metrics.map((m, i) => ({ label: `${describeMetric(m.aggregate, m.column, m.absolute)}`, id: `s${i + 1}`, value: aggValue(m) }));
    if (chart.mode) base["mode"] = chart.mode;
  } else if (metrics.length >= 1) {
    base["value"] = aggValue(metrics[0] as { aggregate: IntentAggregate; column?: string; absolute?: boolean });
  } else {
    base["value"] = { aggregate: "count" };
  }
  return base;
}

import type { AnalysisGrids } from "../matrix-analysis.js";
import type { TableSchema } from "../schema-induction.js";
import { detectAnalyticalIntent } from "./analytical-intent.js";
import { compileAnalyticalPlan, type InheritedComposite, type InheritedMetricSet, type InheritedRanking } from "./analytical-compiler.js";
import { validatePlan } from "./analytical-plan-validator.js";
import { executePlan } from "./analytical-executor.js";
import type { InheritedPeriod } from "./period-resolver.js";
import type { AnalysisEvent, AnalyticalExecution, AnalyticalIntent, AnalyticalPlan, DirectionChangeEvent, ResolvedInterval } from "./types.js";

function grid(columns: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const head = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, 50)
    .map((r) => `| ${columns.map((_, c) => String(r[c] ?? "")).join(" | ")} |`)
    .join("\n");
  return body ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`;
}

export interface AnalyticalTrace {
  readonly originalText: string;
  readonly detectedOperation: string;
  readonly resolvedSubject: string;
  readonly subjectScope: string;
  readonly measureBasis: string;
  readonly compiledSteps: readonly string[];
  readonly planValid: boolean;
  readonly validationErrors: readonly string[];
  readonly routeChosen: "analytical_compiler" | "clarify" | "decline" | "error";
  readonly inheritedPeriodRef: boolean;
  readonly requestedStart?: string;
  readonly requestedEnd?: string;
  readonly executedStart?: string;
  readonly executedEnd?: string;
  readonly silentSubstitution: boolean;
  readonly assumptions: readonly string[];
}

export type AnalyticalRouteOutcome =
  | {
      readonly kind: "handled";
      readonly body: string;
      readonly summaryLine?: string;
      readonly plan: AnalyticalPlan;
      readonly intent: AnalyticalIntent;
      readonly execution: AnalyticalExecution;
      readonly trace: AnalyticalTrace;
      /** an interval to remember as a PeriodRef for "за этот же период". */
      readonly rememberInterval?: ResolvedInterval;
      /** Stage 24.8 §11/§30/§31 — an explicit-interval rank to remember as a
       *  RankingAnalysisRef for "те же 5, но по абсолютному изменению". */
      readonly rememberRanking?: { readonly interval: ResolvedInterval; readonly limit?: number };
      /** Stage 24.8 §12–§14 — two predicated intervals to remember as a
       *  CompositeAnalysisRef for "в первом интервале… во втором…". */
      readonly rememberComposite?: { readonly interval1: ResolvedInterval; readonly interval2: ResolvedInterval };
      /** Stage 24.8 §17–§21 — the winning adjacent-period-change event to
       *  remember as an EventRef for follow-ups ("Когда именно это произошло?"). */
      readonly winningEvent?: AnalysisEvent;
      /** Stage 24.9 §17/§18 — the superlative direction-change winner, to
       *  remember as a DirectionChangeAnalysisRef. */
      readonly directionChangeWinner?: { readonly metricKey: string; readonly count: number; readonly events: readonly DirectionChangeEvent[] };
      /** Stage 24.9 §4/§8–§10 — the resolved metric-set labels, to remember
       *  as a MetricSetRef ("Активы и Обязательства"). */
      readonly metricSetLabels?: readonly string[];
      readonly metricSetOrigin?: "explicit_user_list" | "derived_analysis";
      /** Stage 24.9 §5–§7/§35/§39 — the ordered ranking-shaped rows, to
       *  remember as a ResultSetRef. */
      readonly resultSet?: { readonly operation: string; readonly scoreField: string; readonly rows: readonly { readonly key: string; readonly score: number }[] };
      /** Stage 24.9 §29/§37 — a single resolved metric to focus the "его/он"
       *  pronoun on, for ANY operation whose subject is exactly one metric. */
      readonly focusMetricKey?: string;
      readonly sourceCells: readonly string[];
      readonly entityColumn?: string;
      readonly entityValues: readonly string[];
    }
  | { readonly kind: "clarify"; readonly field: string; readonly question: string; readonly needle: string; readonly candidates: readonly string[]; readonly trace: AnalyticalTrace }
  | { readonly kind: "error"; readonly message: string; readonly trace: AnalyticalTrace }
  | { readonly kind: "decline"; readonly reason: string };

function subjectLabel(plan: AnalyticalPlan): string {
  const s = plan.subject;
  if (s.kind === "row_axis_member") return s.member.display;
  if (s.kind === "column_measure") return s.column.displayLabel;
  if (s.kind === "each_metric") return `${s.members.length} metrics`;
  if (s.kind === "metric_set") return s.members.map((m) => m.display).join(", ");
  return `${s.columns.length} columns`;
}

function baseTrace(text: string, intent: AnalyticalIntent): AnalyticalTrace {
  return {
    originalText: text,
    detectedOperation: intent.operation,
    resolvedSubject: "",
    subjectScope: "",
    measureBasis: "",
    compiledSteps: [],
    planValid: false,
    validationErrors: [],
    routeChosen: "decline",
    inheritedPeriodRef: false,
    silentSubstitution: false,
    assumptions: [],
  };
}

export function runAnalyticalAnalysis(
  schema: TableSchema,
  grids: AnalysisGrids,
  text: string,
  language: "ru" | "en" = "ru",
  inheritedPeriod?: InheritedPeriod,
  subjectOverride?: string,
  inheritedRanking?: InheritedRanking,
  inheritedComposite?: InheritedComposite,
  inheritedMetricSet?: InheritedMetricSet,
): AnalyticalRouteOutcome {
  const ru = language === "ru";
  const intent = detectAnalyticalIntent(text);
  if (!intent.any) return { kind: "decline", reason: "no analytical intent" };

  const compiled = compileAnalyticalPlan(
    intent,
    {
      schema,
      grids,
      ...(inheritedPeriod ? { inheritedPeriod } : {}),
      ...(subjectOverride ? { subjectOverride } : {}),
      ...(inheritedRanking ? { inheritedRanking } : {}),
      ...(inheritedComposite ? { inheritedComposite } : {}),
      ...(inheritedMetricSet ? { inheritedMetricSet } : {}),
    },
    language,
  );

  if (compiled.kind === "decline") return { kind: "decline", reason: compiled.reason };

  if (compiled.kind === "clarify") {
    return {
      kind: "clarify",
      field: compiled.field,
      question: compiled.question,
      needle: compiled.needle,
      candidates: compiled.candidates,
      trace: { ...baseTrace(text, intent), routeChosen: "clarify", detectedOperation: intent.operation },
    };
  }

  if (compiled.kind === "unresolved") {
    const issue = compiled.issues[0]!;
    const message =
      issue.field === "period"
        ? ru
          ? `Не удалось разрешить период: ${issue.reason}. Уточните дату или период.`
          : `I couldn't resolve the period: ${issue.reason}. Please give an exact date or period.`
        : issue.field === "subject"
          ? ru
            ? `Не нашёл показатель по запросу «${intent.subjectText ?? ""}».`
            : `I couldn't find a metric matching "${intent.subjectText ?? ""}".`
          : ru
            ? `Не удалось скомпилировать анализ: ${issue.reason}.`
            : `I couldn't compile that analysis: ${issue.reason}.`;
    return {
      kind: "error",
      message,
      trace: { ...baseTrace(text, intent), routeChosen: "error", validationErrors: compiled.issues.map((i) => `${i.field}: ${i.reason}`) },
    };
  }

  const { plan, periodIndex } = compiled;
  const validation = validatePlan(plan, schema, grids, periodIndex);
  const trace: AnalyticalTrace = {
    ...baseTrace(text, intent),
    detectedOperation: plan.operation,
    resolvedSubject: subjectLabel(plan),
    subjectScope: plan.subjectScope,
    measureBasis: plan.measureBasis,
    compiledSteps: plan.steps.map((s) => (s.detail ? `${s.kind}:${s.detail}` : s.kind)),
    planValid: validation.ok,
    validationErrors: validation.errors,
    routeChosen: validation.ok ? "analytical_compiler" : "error",
    inheritedPeriodRef: plan.assumptions.some((a) => /предыдущего|inherited/i.test(a.text)),
    ...(plan.interval ? { requestedStart: plan.interval.start.canonical, requestedEnd: plan.interval.end.canonical } : {}),
    assumptions: plan.assumptions.map((a) => a.text),
    silentSubstitution: false,
  };

  if (!validation.ok) {
    const first = validation.errors[0] ?? "invalid plan";
    return {
      kind: "error",
      message: ru ? `Не удалось выполнить анализ: ${first}.` : `I couldn't run that analysis: ${first}.`,
      trace,
    };
  }

  const execution = executePlan(plan, schema, grids, periodIndex, language);
  const finalTrace: AnalyticalTrace = {
    ...trace,
    ...(execution.audit.executedStart ? { executedStart: execution.audit.executedStart } : {}),
    ...(execution.audit.executedEnd ? { executedEnd: execution.audit.executedEnd } : {}),
    silentSubstitution: execution.audit.silentSubstitution,
  };

  // §47 audit invariant — requested must equal executed for explicit periods.
  if (
    (finalTrace.requestedStart && finalTrace.executedStart && finalTrace.requestedStart !== finalTrace.executedStart) ||
    (finalTrace.requestedEnd && finalTrace.executedEnd && finalTrace.requestedEnd !== finalTrace.executedEnd)
  ) {
    return {
      kind: "error",
      message: ru
        ? "Внутренняя проверка периодов не прошла — анализ отменён во избежание подмены дат."
        : "The period audit failed — the analysis was aborted to avoid a silent date substitution.",
      trace: { ...finalTrace, silentSubstitution: true, routeChosen: "error" },
    };
  }

  const parts: string[] = [];
  for (const sec of execution.sections) parts.push(`**${sec.title}**\n\n${grid(sec.columns, sec.rows)}`);
  if (execution.summaryLine) parts.push(`_${execution.summaryLine}_`);
  const body = parts.join("\n\n") || (ru ? "Нет результата." : "No result.");

  return {
    kind: "handled",
    body,
    ...(execution.summaryLine ? { summaryLine: execution.summaryLine } : {}),
    plan,
    intent,
    execution,
    trace: finalTrace,
    ...(plan.interval ? { rememberInterval: plan.interval } : {}),
    ...(plan.operation === "rank" && plan.interval
      ? { rememberRanking: { interval: plan.interval, ...(typeof plan.limit === "number" ? { limit: plan.limit } : {}) } }
      : {}),
    ...(plan.operation === "two_interval_filter" && plan.predicateIntervals?.length === 2
      ? { rememberComposite: { interval1: plan.predicateIntervals[0]!.interval, interval2: plan.predicateIntervals[1]!.interval } }
      : {}),
    ...(plan.operation === "argmax_event" && execution.events && execution.events.length > 0
      ? { winningEvent: execution.events[0]! }
      : {}),
    ...(execution.directionChangeWinner ? { directionChangeWinner: execution.directionChangeWinner } : {}),
    ...(plan.metricSetLabels && plan.metricSetLabels.length > 0
      ? { metricSetLabels: plan.metricSetLabels, metricSetOrigin: intent.metricSetText ? "explicit_user_list" : "derived_analysis" }
      : {}),
    ...(execution.resultSet ? { resultSet: execution.resultSet } : {}),
    ...(plan.subject.kind === "row_axis_member"
      ? { focusMetricKey: plan.subject.member.display }
      : plan.subject.kind === "column_measure"
        ? { focusMetricKey: plan.subject.column.displayLabel }
        : {}),
    sourceCells: execution.sourceCells,
    ...(execution.entityColumn ? { entityColumn: execution.entityColumn } : {}),
    entityValues: execution.entityValues,
  };
}

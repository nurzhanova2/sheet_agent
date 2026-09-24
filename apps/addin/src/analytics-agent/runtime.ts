import { runAgentLoop } from "../agent/agent-loop.js";
import type { AgentDecisionContext, AgentLanguage, AgentLoopState, AgentObservation, AgentResume, AgentStep, AgentToolDeps } from "../agent/types.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import type { TableSchema } from "../app/schema/schema-induction.js";
import { ANALYTICAL_PLANNER_BOUNDS } from "./planner-bounds.js";
import { buildAnalyticalToolEnv, createAnalyticalToolRegistry, type AnalyticalInherited } from "./tool-registry.js";
import { buildAnalyticalWorkbookContext } from "./workbook-context.js";
import { appendClauseCoverage, buildNarratorMessages, gateNarratorAnswer, renderObservationsFallback } from "./narrator.js";
import { determinePrimaryAnswer, determineValidatedWinner } from "./primary-answer.js";
import { determineSemanticWinnerMatch } from "./semantic-winner.js";
import {
  auditCandidateSet,
  auditClauseCompleteness,
  auditClauseTargetConsistency,
  auditExploratoryCardinality,
  auditExploratoryExplanationGrounding,
  auditMeanDeviationNormalization,
  auditObservationChangeSigns,
  auditOperationFidelity,
  auditPeriodFidelity,
  auditRankingBasisFidelity,
  auditResultCardinality,
  auditWinnerConsistency,
  countAnswerShapedOutputs,
  extractExecutedInterval,
  type SemanticAuditFailure,
} from "./semantic-audit.js";
import { hasSuperlativeAsk, isExploratoryRequest, type CanonicalOperationKind, type RankingBasisField, type TemporalMode } from "./semantic-frame.js";

const NOOP_DEPS: AgentToolDeps = {
  workbookMap: async () => ({ error: "not available to the analytical planner" }),
  sheetSnapshot: async () => ({ kind: "error", error: "not available to the analytical planner" }),
  rangeSnapshot: async () => ({ kind: "error", error: "not available to the analytical planner" }),
  analyze: () => {
    throw new Error("analyze() is not available to the analytical planner");
  },
  chartFromResult: () => ({ kind: "error", error: "not available to the analytical planner" }),
};

// Stage 25.1.1 §30/§34 — offered to the planner only on a bounded recovery
// round after its first attempt failed on a clearly exploratory request; it
// is guidance for tool selection, never a hardcoded final answer.
const EXPLORATORY_RECOVERY_HINT_RU =
  "Похоже, запрос требует диагностического исследования, а не одного конкретного показателя. Составь план из нескольких deterministic-инструментов (например: analysis.volatility, analysis.direction_changes, event.max_adjacent_change, aggregate.max + derive.compute для отклонения от исторического максимума) и выбери показатели по вычисленным результатам — никогда не называй показатель без вычисленного основания.";
const EXPLORATORY_RECOVERY_HINT_EN =
  "This looks like an open-ended diagnostic request, not a single named metric. Compose a plan from several deterministic tools (e.g. analysis.volatility, analysis.direction_changes, event.max_adjacent_change, aggregate.max + derive.compute for distance from the historical max) and choose metrics from the COMPUTED results — never name a metric without a computed basis.";

export type AnalyticalPlannerOutcome =
  | { readonly kind: "clarify"; readonly question: string; readonly candidates: readonly string[]; readonly state: AgentLoopState }
  | {
      readonly kind: "handled";
      readonly body: string;
      readonly usedFallback: boolean;
      readonly fallbackReasons: readonly string[];
      readonly state: AgentLoopState;
      readonly primary?: AgentObservation;
    }
  | { readonly kind: "failed"; readonly reasonKey: "model_error" | "read_budget" | "step_budget" | "repeated_tool_call" | "unknown"; readonly state: AgentLoopState }
  /** Stage 25.1 §24/§29 — the plan executed and every number is grounded,
   *  but the SHAPE of the answer contradicts what was asked (a widened
   *  candidate set, an internally inconsistent change row, the wrong
   *  operation, a substituted period, a dropped clause, or a compound run
   *  whose dependent clauses disagree on the target metric). Never narrated. */
  | { readonly kind: "semantic_failed"; readonly failures: readonly SemanticAuditFailure[]; readonly state: AgentLoopState };

export interface RunAnalyticalPlannerParams {
  readonly taskId: string;
  readonly text: string;
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  readonly language: "ru" | "en";
  readonly inherited?: AnalyticalInherited;
  /** Stage 25.1 §17 — the explicit metric set the user named, when any
   *  (`semantic-frame.ts`'s `explicitCandidateSet`). Audited against the
   *  final executed metric universe; `null`/omitted skips the check. */
  readonly requestedCandidateSet?: readonly string[] | null;
  /** Stage 25.1.1 §6/§7 — an explicit temporal comparison mode, audited
   *  against the two canonical periods actually touched by the run. */
  readonly requestedTemporalMode?: TemporalMode | null;
  /** Stage 25.1.1 §3–§5 — an operation kind Stage 24.x cannot represent,
   *  audited against the tool sequence actually executed. */
  readonly requestedOperationKind?: CanonicalOperationKind | null;
  /** Stage 25.1.1 §15–§17 — how many analytical clauses the sentence
   *  carries (1–4); the run must produce at least that many distinct
   *  answer-shaped outputs. Defaults to 1 (no completeness check). */
  readonly requestedClauseCount?: number;
  /** Stage 25.1.3 §23/§24 — an explicit cardinality named by an exploratory
   *  request ("три показателя"); the run's primary answer must select
   *  EXACTLY this many distinct metrics. `null`/omitted skips the check. */
  readonly requestedExploratoryCardinality?: number | null;
  /** Stage 25.1.3b §2–§6 — the ranking basis a "changed the most" comparison
   *  must use (percentage magnitude by default, absolute only when
   *  explicitly asked) — audited against the LAST rank-defining tool call's
   *  own "field" input. `null`/omitted skips the check. */
  readonly requestedRankingBasis?: RankingBasisField | null;
  /** Stage 25.1.3 §15/§16 — resume a prior planner run that paused for a
   *  clarification (reused verbatim from Stage 24.4's `AgentResume` — the
   *  SAME protocol `runAgentLoop` already implements). Applied only to the
   *  FIRST attempt, never the bounded exploratory-recovery retry. */
  readonly resume?: AgentResume;
  /** One bounded planner decision — the caller wires this to `ChatClient.decideAgentStep`. */
  readonly decidePlanner: (ctx: AgentDecisionContext) => Promise<unknown> | unknown;
  /** One free-text narrator completion — the caller wires this to `ChatClient.narrate`. */
  readonly narrate: (messages: readonly { readonly role: "system" | "user"; readonly content: string }[]) => Promise<string>;
  readonly onStep?: (step: AgentStep, state: AgentLoopState) => void;
  readonly now?: () => number;
}

export async function runAnalyticalPlanner(params: RunAnalyticalPlannerParams): Promise<AnalyticalPlannerOutcome> {
  const inherited = params.inherited ?? {};
  const env = buildAnalyticalToolEnv(params.schema, params.grids, params.language, inherited, params.text);
  const registry = createAnalyticalToolRegistry(env);
  const workbookContext = buildAnalyticalWorkbookContext(params.schema, params.grids, env.periodIndex, inherited);
  const language: AgentLanguage = params.language;

  const runOnce = (requestText: string, resume?: AgentResume): Promise<AgentLoopState> =>
    runAgentLoop({
      taskId: params.taskId,
      request: requestText,
      language,
      registry,
      deps: NOOP_DEPS,
      bounds: ANALYTICAL_PLANNER_BOUNDS,
      workbookContext,
      decide: params.decidePlanner,
      ...(resume ? { resume } : {}),
      ...(params.now ? { now: params.now } : {}),
      ...(params.onStep ? { onStep: params.onStep } : {}),
    });

  // §15/§16 — a clarification resume fills the missing slot and continues
  // the ORIGINAL request; never applied to the bounded exploratory retry.
  let state = await runOnce(params.text, params.resume);

  // Stage 25.1.1 §30/§31/§65 — ONE bounded recovery round for a clearly
  // exploratory request whose first attempt could not produce a plan.
  if (state.status === "terminated" && isExploratoryRequest(params.text)) {
    state = await runOnce(`${params.text}\n\n${language === "ru" ? EXPLORATORY_RECOVERY_HINT_RU : EXPLORATORY_RECOVERY_HINT_EN}`);
  }

  if (state.status === "awaiting_clarification" && state.pendingClarification) {
    return { kind: "clarify", question: state.pendingClarification.question, candidates: state.pendingClarification.candidates, state };
  }

  if (state.status !== "done") {
    const reason = state.terminationReason;
    const reasonKey: "model_error" | "read_budget" | "step_budget" | "repeated_tool_call" | "unknown" =
      reason === "model_error" || reason === "read_budget" || reason === "step_budget" || reason === "repeated_tool_call" ? reason : "unknown";
    return { kind: "failed", reasonKey, state };
  }

  // §24/§29/§33/§39 — the semantic execution audit runs BEFORE narration: a
  // semantically wrong (or internally inconsistent) result is never narrated.
  const observations = state.observations.filter((o) => o.ok);
  const signAudit = auditObservationChangeSigns(observations);
  const finalMetricUniverse = (() => {
    const last = [...observations].reverse().find((o) => o.kind === "table" && o.columns?.includes("metric") && o.rows && o.rows.length > 0);
    if (!last || !last.columns || !last.rows) return null;
    const ci = last.columns.indexOf("metric");
    return [...new Set(last.rows.map((r) => String(r[ci] ?? "")))].filter(Boolean);
  })();
  const setAudit = finalMetricUniverse ? auditCandidateSet(params.requestedCandidateSet ?? null, finalMetricUniverse) : { ok: true, failures: [] };

  // Stage 25.1.2 §2/§3 — audit the FINAL executed analytical interval, never
  // every period.select/period.list the planner legitimately touched while
  // exploring the schema (period.list, period.select(last),
  // period.select(previous_of=last) are all normal plumbing).
  const points = env.periodIndex.points;
  const periodAudit =
    points.length >= 2
      ? auditPeriodFidelity(params.requestedTemporalMode ?? null, extractExecutedInterval(state.steps), {
          first: points[0]!.canonical,
          previous: points[points.length - 2]!.canonical,
          last: points[points.length - 1]!.canonical,
        })
      : { ok: true, failures: [] };

  const operationAudit = auditOperationFidelity(params.requestedOperationKind ?? null, observations);
  const meanDeviationAudit = auditMeanDeviationNormalization(params.requestedOperationKind ?? null, state.steps);
  // Stage 25.1.3b §2–§7 — a "changed the most" comparison must rank by the
  // requested basis (percentage magnitude by default).
  const rankingBasisAudit = auditRankingBasisFidelity(params.requestedRankingBasis ?? null, state.steps);
  // Only a MEANINGFULLY multi-clause request (>=2) is worth auditing — a
  // default/unset clause count of 1 must never reject a legitimate
  // single-tool answer (e.g. a bare metric.resolve).
  const requestedClauses = params.requestedClauseCount ?? 1;
  // §20/§62 — target-consistency is a DEPENDENT-compound check ("its
  // dynamics", "its biggest jump" must mean the SAME winner) — gated the
  // same way as completeness so a single-clause request comparing two
  // deliberately different metrics is never falsely rejected.
  const clauseAudit = requestedClauses >= 2 ? auditClauseCompleteness(requestedClauses, countAnswerShapedOutputs(observations)) : { ok: true, failures: [] };
  const targetAudit = requestedClauses >= 2 ? auditClauseTargetConsistency(observations) : { ok: true, failures: [] };

  // Stage 25.1.3d §3–§8/§26 — the ONE observation that answers what was
  // actually asked (never merely "the biggest/last table") — the SAME
  // selection the narrator's FACTS and its deterministic fallback use
  // (§15), so every consumer of "the primary answer" agrees. A singular
  // superlative ask ("какой изменился сильнее всего?") reduces this to
  // exactly one winner row; gated to single-clause requests only (>=2
  // clauses keeps its own compound-clause handling below untouched, per
  // §22 "do not modify compound clause coverage").
  const primaryAnswer = determinePrimaryAnswer(observations, params.text);
  const resultShapeAudit =
    requestedClauses < 2 ? auditResultCardinality(hasSuperlativeAsk(params.text), primaryAnswer?.observation.rows?.length ?? null) : { ok: true, failures: [] };

  // Stage 25.1.3e §9 — PrimaryAnswer and the SemanticWinner about to feed
  // MetricFocusRef (`commitPlannerOutputs`, via the SAME `determineValidatedWinner`
  // reduction) must name the same metric. Defense-in-depth against future
  // drift between the two call sites, not two independently-guessed values.
  const winnerConsistencyAudit = (() => {
    if (requestedClauses >= 2) return { ok: true, failures: [] };
    if (!primaryAnswer || !primaryAnswer.observation.columns || !primaryAnswer.observation.rows || primaryAnswer.observation.rows.length !== 1) {
      return { ok: true, failures: [] };
    }
    const mCol = primaryAnswer.observation.columns.indexOf("metric");
    const primaryMetric = mCol >= 0 ? String(primaryAnswer.observation.rows[0]![mCol] ?? "") || null : null;
    const semanticWinnerMetric = determineValidatedWinner(observations, params.text)?.metricKey ?? determineSemanticWinnerMatch(observations, hasSuperlativeAsk(params.text))?.metricKey ?? null;
    return auditWinnerConsistency(primaryMetric, semanticWinnerMetric);
  })();

  // Stage 25.1.3 §23–§26 — an exploratory ask with an explicit cardinality
  // ("три показателя") must select EXACTLY that many distinct metrics, each
  // backed by a computed diagnostic value — measured against the run's own
  // primary (most recent) answer-shaped table.
  const requestedCardinality = params.requestedExploratoryCardinality ?? null;
  const primaryForCardinality = [...observations].reverse().find((o) => o.kind === "table" && o.columns?.includes("metric") && o.rows && o.rows.length > 0);
  const primaryMetricCount = (() => {
    if (!primaryForCardinality || !primaryForCardinality.columns || !primaryForCardinality.rows) return 0;
    const ci = primaryForCardinality.columns.indexOf("metric");
    return new Set(primaryForCardinality.rows.map((r) => String(r[ci] ?? "")).filter(Boolean)).size;
  })();
  const cardinalityAudit = requestedCardinality !== null ? auditExploratoryCardinality(requestedCardinality, primaryMetricCount) : { ok: true, failures: [] };
  const explanationAudit =
    requestedCardinality !== null ? auditExploratoryExplanationGrounding(requestedCardinality, primaryForCardinality?.columns ?? null) : { ok: true, failures: [] };

  const auditFailures = [
    ...signAudit.failures,
    ...setAudit.failures,
    ...periodAudit.failures,
    ...operationAudit.failures,
    ...meanDeviationAudit.failures,
    ...rankingBasisAudit.failures,
    ...clauseAudit.failures,
    ...targetAudit.failures,
    ...resultShapeAudit.failures,
    ...winnerConsistencyAudit.failures,
    ...cardinalityAudit.failures,
    ...explanationAudit.failures,
  ];
  if (auditFailures.length > 0) {
    return { kind: "semantic_failed", failures: auditFailures, state };
  }

  // §32/§36 — a SEPARATE narrator pass, never the planner's own prose.
  let draft = "";
  try {
    draft = await params.narrate(buildNarratorMessages(params.text, params.language, observations, requestedClauses));
  } catch {
    draft = "";
  }
  const gated =
    draft.trim() === ""
      ? { text: renderObservationsFallback(observations, params.language, params.text), usedFallback: true, reasons: ["empty narrator output"] }
      : gateNarratorAnswer(draft, observations, params.language, params.text);
  // §14 — a compound request's visible answer must surface every clause's
  // output, not just whatever the narrator's own prose happened to mention.
  const body = appendClauseCoverage(gated.text, observations, requestedClauses, params.language);

  const primary = primaryAnswer?.observation;
  return { kind: "handled", body, usedFallback: gated.usedFallback, fallbackReasons: gated.reasons, state, ...(primary ? { primary } : {}) };
}

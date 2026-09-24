import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import type { ChatClient } from "../../app/chat-client.js";
import { runAnalyticalEngine, type EngineTurn } from "../engine.js";
import type { AnalysisCapability } from "../sandbox/analysis-runner.js";
import type { AnalyticalRuntime } from "../sandbox/executor.js";
import { renderTrace, type AnalyticalTraceV2 } from "../debug/analytical-trace.js";
import { EMPTY_ANALYTICAL_STATE, type AnalyticalConversationState } from "../state/conversation-state.js";
import type { EngineResult } from "../types.js";

/** §60 — why a question failed, which is what decides the next increment's work. */
export type FailureClass =
  | "PLANNER_TOOL_SELECTION"
  | "PLANNER_ARGUMENT"
  | "REFERENCE_RESOLUTION"
  | "TOOL_CONTRACT"
  | "MISSING_TOOL"
  | "CAPABILITY_UNAVAILABLE"
  | "COMPLETION"
  | "COVERAGE"
  | "BUDGET"
  | "NARRATION"
  | "OTHER";

export interface HarnessQuestion {
  readonly id: string;
  readonly text: string;
  /** Concepts the question exercises — reported, never shown to the planner. */
  readonly concepts: readonly string[];
  /**
   * §57 — ground truth about the ANSWER, not about the tool sequence. Several
   * sequences may be correct; these check the things that must hold.
   */
  readonly expect?: {
    readonly winnerMetric?: string;
    readonly metricUniverse?: readonly string[];
    readonly excludesMetrics?: readonly string[];
    readonly primaryType?: EngineResult["type"];
    readonly minSupporting?: number;
    readonly periodCanonicals?: readonly string[];
  };
}

export interface HarnessTurnReport {
  readonly id: string;
  readonly question: string;
  readonly concepts: readonly string[];
  readonly outcome: EngineTurn["kind"];
  readonly toolSequence: readonly string[];
  readonly plannerRounds: number;
  readonly toolCalls: number;
  readonly workbookReads: number;
  readonly cacheHits: number;
  /** Stage 26.4 §37 — protocol self-corrections and completion re-bindings. */
  readonly protocolCorrections: number;
  readonly completionRetries: number;
  /** Stage 26.5 §12 — re-bindings spent on a completion that contradicted the plan. */
  readonly primaryCorrections: number;
  readonly reusedReference: boolean;
  readonly completion?: { readonly primary: string; readonly supporting: readonly string[] };
  readonly primaryType?: EngineResult["type"];
  readonly primaryMetrics?: readonly string[];
  readonly usedFallback?: boolean;
  readonly validCompletion: boolean;
  readonly semanticallyCorrect: boolean | null;
  readonly mismatches: readonly string[];
  readonly failureClass?: FailureClass;
  readonly elapsedMs: number;
  /** Stage 27 §87 — where the wall clock actually went. */
  readonly stages: StageTimings;
  /** Stage 27 §84 — what the sandbox was asked for, and what it did. */
  readonly analysis?: AnalysisReport;
  readonly trace: AnalyticalTraceV2;
}

/**
 * §87 — latency, split by the thing that spent it.
 *
 * Five of the six are measured directly, at the callback boundary. The sixth,
 * `engineMs`, is the remainder: tool execution, result storage, the coverage
 * and numeric verification, and the state commit. §87 asks for verification as
 * its own number and this does not give it one — isolating it would take
 * instrumentation inside the engine, and reporting a made-up split would be
 * worse than reporting an honest bucket. What `engineMs` does establish is the
 * ceiling: verification cannot have cost more than it.
 */
export interface StageTimings {
  readonly plannerMs: number;
  readonly plannerCalls: number;
  readonly codeGenMs: number;
  readonly codeGenCalls: number;
  readonly sandboxExecMs: number;
  readonly sandboxAttempts: number;
  readonly narrationMs: number;
  readonly engineMs: number;
}

export interface AnalysisReport {
  readonly requested: boolean;
  readonly objective?: string;
  readonly necessity?: string;
  readonly method?: string;
  readonly attempts: number;
  /** Set when the analysis did not produce a usable result (§68). */
  readonly failureCode?: string;
  /** §19 — how many methods actually ran and reported metrics. */
  readonly methodsCompared?: number;
  /** §37 — the dimensions an exploration was asked to cover. */
  readonly explorationDimensions?: readonly string[];
  /**
   * §71 — why each attempt failed, and what it ran.
   *
   * The report used to carry only `attempts: 3`, which says an analysis was
   * repaired twice and nothing about what went wrong. Reading a run then
   * meant re-running it with a debugger attached. The code is included
   * because the failure and the line that caused it are only useful together.
   */
  readonly attemptLog?: readonly AttemptNote[];
}

export interface AttemptNote {
  readonly attempt: number;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly codeLines: number;
  readonly errorCode?: string;
  readonly error?: string;
  readonly code?: string;
  /**
   * Stage 27.x.1 §31 — the class the REFUSING LAYER assigned, when it knew.
   *
   * `classifyAttemptFailure` reads the message with a regex and is right most
   * of the time, but the preflight checks and the output-contract check do not
   * have to guess: they are the thing that decided. Carrying the verdict means
   * the taxonomy stops depending on a regex agreeing with a hint that was
   * written from the same rule two files away.
   */
  readonly failureClass?: string;
  /** §12 — OUTPUT_SHAPE_MISMATCH: computed correctly, serialized wrongly. */
  readonly subtype?: string;
}

const REFERENCE_TOOL = /^reference\./;
const NEWLINE = String.fromCharCode(10);

function classify(turn: EngineTurn, trace: AnalyticalTraceV2, mismatches: readonly string[]): FailureClass | undefined {
  if (turn.kind === "failed") {
    if (turn.reason === "planner_rounds" || turn.reason === "tool_calls" || turn.reason === "workbook_reads") return "BUDGET";
    if (turn.reason === "invalid_decision") return "COMPLETION";
    if (turn.reason === "model_error") return "OTHER";
    // repeated_invalid_call — look at what it kept getting wrong
    const lastError = [...trace.rounds].reverse().find((r) => r.toolError)?.toolError;
    if (!lastError) return "PLANNER_TOOL_SELECTION";
    switch (lastError.code) {
      case "UNKNOWN_TOOL":
        return "MISSING_TOOL";
      case "CAPABILITY_UNAVAILABLE":
        return "CAPABILITY_UNAVAILABLE";
      case "UNKNOWN_REFERENCE":
      case "STALE_REFERENCE":
      case "NO_PREVIOUS_RESULT":
        return "REFERENCE_RESOLUTION";
      case "INVALID_ARGUMENT":
      case "AMBIGUOUS_METRIC":
      case "AMBIGUOUS_PERIOD":
        return "PLANNER_ARGUMENT";
      case "INCOMPATIBLE_INPUT":
        return "TOOL_CONTRACT";
      default:
        return "OTHER";
    }
  }
  if (turn.kind === "clarify") return "COMPLETION";
  if (mismatches.length > 0) return mismatches.some((m) => m.startsWith("supporting")) ? "COVERAGE" : "PLANNER_TOOL_SELECTION";
  return undefined;
}

/** §57 — checks the ANSWER, never the route taken to it. */
function checkExpectations(turn: EngineTurn, expect: HarnessQuestion["expect"]): readonly string[] {
  if (!expect || turn.kind !== "answered") return [];
  const out: string[] = [];
  const { primary, supporting } = turn.analysis;
  if (expect.primaryType && primary.type !== expect.primaryType) out.push(`primaryType: expected ${expect.primaryType}, got ${primary.type}`);
  if (expect.winnerMetric && !(primary.metricKeys.length === 1 && primary.metricKeys[0] === expect.winnerMetric)) {
    out.push(`winner: expected "${expect.winnerMetric}", got [${primary.metricKeys.join(", ")}]`);
  }
  if (expect.metricUniverse) {
    const got = [...primary.metricKeys].sort();
    const want = [...expect.metricUniverse].sort();
    if (got.length !== want.length || got.some((k, i) => k !== want[i])) out.push(`universe: expected [${want.join(", ")}], got [${got.join(", ")}]`);
  }
  for (const excluded of expect.excludesMetrics ?? []) {
    if (primary.metricKeys.includes(excluded)) out.push(`universe: "${excluded}" should not be present`);
  }
  if (expect.minSupporting !== undefined && supporting.length < expect.minSupporting) {
    out.push(`supporting: expected at least ${expect.minSupporting}, got ${supporting.length}`);
  }
  if (expect.periodCanonicals) {
    const got = primary.periodCanonicals.join("..");
    const want = expect.periodCanonicals.join("..");
    if (got !== want) out.push(`periods: expected ${want}, got ${got}`);
  }
  return out;
}

/**
 * §83/§84 — what the trace says the sandbox was asked to do.
 *
 * Read from the TRACE rather than from the capability, so a turn where the
 * planner asked for an analysis and the runtime refused still reports that one
 * was requested. The difference between "never wanted an analysis" and "wanted
 * one and did not get it" is the whole point of the §5 counters downstream.
 */
function describeAnalysis(trace: AnalyticalTraceV2, attempts: number, attemptLog: readonly AttemptNote[]): AnalysisReport | undefined {
  const asked = trace.rounds.find((r) => r.decision?.kind === "analyze");
  const method = trace.analysisMethod as Record<string, unknown> | undefined;
  const failure = trace.analysisFailure as { readonly code?: string } | undefined;
  if (!asked && !method && !failure) return undefined;

  const decision = asked?.decision?.kind === "analyze" ? asked.decision : undefined;
  const comparison = method?.["methodComparison"] as { readonly methods?: readonly unknown[] } | undefined;
  return {
    requested: Boolean(asked),
    ...(decision?.objective ? { objective: decision.objective } : {}),
    ...(decision?.necessity ? { necessity: decision.necessity } : {}),
    ...(typeof method?.["method"] === "string" ? { method: method["method"] } : {}),
    attempts,
    ...(failure?.code ? { failureCode: failure.code } : {}),
    ...(comparison?.methods ? { methodsCompared: comparison.methods.length } : {}),
    ...(decision?.exploration ? { explorationDimensions: decision.exploration } : {}),
    ...(attemptLog.length > 0 ? { attemptLog } : {}),
  };
}

export interface HarnessTableEnv {
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
}

export interface RunHarnessTurnParams {
  readonly chatClient: ChatClient;
  readonly table: HarnessTableEnv;
  readonly question: HarnessQuestion;
  readonly state?: AnalyticalConversationState;
  readonly language?: "ru" | "en";
  readonly model?: string;
  readonly signal?: AbortSignal;
  /**
   * Stage 27 §90 — the analytical runtime, when the suite is measuring it.
   *
   * Absent by default, and its absence is not a degraded mode: without it the
   * engine answers an `analyze` decision with a capability error, which is
   * exactly what a build with no sandbox must do (§5). Stage 26 suites keep
   * running unchanged.
   */
  readonly runtime?: AnalyticalRuntime;
}

/** Runs ONE question against the real planner and reports what happened. */
export async function runHarnessTurn(
  params: RunHarnessTurnParams,
): Promise<{ readonly report: HarnessTurnReport; readonly turn: EngineTurn; readonly state: AnalyticalConversationState }> {
  const { chatClient, table, question } = params;
  if (typeof chatClient.planAnalyticalTurn !== "function") throw new Error("this ChatClient cannot plan analytical turns");
  const plan = chatClient.planAnalyticalTurn.bind(chatClient);
  const signal = params.signal ?? new AbortController().signal;
  const state = params.state ?? EMPTY_ANALYTICAL_STATE;
  const started = Date.now();

  // §87 — every model call and every sandbox attempt is timed at its own
  // boundary. Timing from OUTSIDE the engine keeps benchmark scaffolding out
  // of the engine, which §1 has required since Stage 26.
  let plannerMs = 0;
  let plannerCalls = 0;
  let codeGenMs = 0;
  let codeGenCalls = 0;
  let sandboxExecMs = 0;
  let sandboxAttempts = 0;
  const attemptLog: AttemptNote[] = [];
  let narrationMs = 0;

  const timed = async <T>(fn: () => Promise<T>, add: (ms: number) => void): Promise<T> => {
    const at = Date.now();
    try {
      return await fn();
    } finally {
      add(Date.now() - at);
    }
  };

  const analysis: AnalysisCapability | undefined = params.runtime
    ? {
        runtime: params.runtime,
        generateCode: async (messages) => {
          codeGenCalls += 1;
          return timed(
            async () => (typeof chatClient.generateAnalysisCode === "function" ? chatClient.generateAnalysisCode(messages, signal, params.model) : ""),
            (ms) => {
              codeGenMs += ms;
            },
          );
        },
        onAttempt: (record) => {
          sandboxAttempts += 1;
          sandboxExecMs += record.durationMs;
          attemptLog.push({
            attempt: record.attempt,
            ok: record.ok,
            durationMs: record.durationMs,
            codeLines: record.code.split(NEWLINE).length,
            ...(record.error
              ? {
                  errorCode: record.error.code,
                  error: record.error.message,
                  ...(record.error.failureClass ? { failureClass: record.error.failureClass } : {}),
                  ...(record.error.subtype ? { subtype: record.error.subtype } : {}),
                }
              : {}),
            ...(record.ok ? {} : { code: record.code }),
          });
        },
      }
    : undefined;

  const turn = await runAnalyticalEngine({
    turnId: question.id,
    request: question.text,
    schema: table.schema,
    grids: table.grids,
    language: params.language ?? "ru",
    state,
    decide: (messages) => {
      plannerCalls += 1;
      return timed(
        () => plan(messages, signal, params.model),
        (ms) => {
          plannerMs += ms;
        },
      );
    },
    narrate: async (messages) =>
      timed(
        async () => (typeof chatClient.narrate === "function" ? chatClient.narrate(messages, signal, params.model) : ""),
        (ms) => {
          narrationMs += ms;
        },
      ),
    ...(analysis ? { analysis } : {}),
  });

  const trace = turn.trace;
  const toolSequence = trace.rounds.flatMap((r) => (r.decision?.kind === "tool_call" ? [r.decision.tool] : []));
  const mismatches = checkExpectations(turn, question.expect);
  const failureClass = classify(turn, trace, mismatches);
  const elapsedMs = Date.now() - started;
  const analysisReport = describeAnalysis(trace, sandboxAttempts, attemptLog);
  const report: HarnessTurnReport = {
    id: question.id,
    question: question.text,
    concepts: question.concepts,
    outcome: turn.kind,
    toolSequence,
    plannerRounds: trace.budget?.plannerRounds ?? trace.rounds.length,
    toolCalls: trace.budget?.toolCalls ?? toolSequence.length,
    workbookReads: trace.budget?.workbookReads ?? 0,
    cacheHits: trace.budget?.cacheHits ?? 0,
    protocolCorrections: trace.budget?.protocolCorrections ?? 0,
    completionRetries: trace.budget?.completionRetries ?? 0,
    primaryCorrections: trace.budget?.primaryCorrections ?? 0,
    reusedReference: toolSequence.some((t) => REFERENCE_TOOL.test(t)),
    ...(trace.completion ? { completion: { primary: trace.completion.primaryResultRef, supporting: trace.completion.supportingResultRefs } } : {}),
    ...(turn.kind === "answered" ? { primaryType: turn.analysis.primary.type, primaryMetrics: turn.analysis.primary.metricKeys, usedFallback: turn.usedFallback } : {}),
    validCompletion: turn.kind === "answered",
    semanticallyCorrect: question.expect ? turn.kind === "answered" && mismatches.length === 0 : null,
    mismatches,
    ...(failureClass ? { failureClass } : {}),
    elapsedMs,
    stages: {
      plannerMs,
      plannerCalls,
      codeGenMs,
      codeGenCalls,
      sandboxExecMs,
      sandboxAttempts,
      narrationMs,
      engineMs: Math.max(0, elapsedMs - plannerMs - codeGenMs - sandboxExecMs - narrationMs),
    },
    ...(analysisReport ? { analysis: analysisReport } : {}),
    trace,
  };

  return { report, turn, state: turn.kind === "answered" ? turn.state : state };
}

/**
 * Runs a CONVERSATION: each question sees the state the previous one committed
 * (§49's A→B→C→D chain). A failed turn leaves the state untouched, so one bad
 * turn does not silently invalidate the rest of the chain's verdicts.
 */
export async function runHarnessConversation(
  params: Omit<RunHarnessTurnParams, "question"> & { readonly questions: readonly HarnessQuestion[] },
): Promise<readonly HarnessTurnReport[]> {
  const reports: HarnessTurnReport[] = [];
  let state = params.state ?? EMPTY_ANALYTICAL_STATE;
  for (const question of params.questions) {
    const { report, state: next } = await runHarnessTurn({ ...params, question, state });
    reports.push(report);
    state = next;
  }
  return reports;
}

// --- reporting (§56/§61) -----------------------------------------------------

export interface HarnessSummary {
  readonly total: number;
  readonly validCompletions: number;
  readonly validCompletionRate: number;
  readonly judged: number;
  readonly semanticallyCorrect: number;
  readonly semanticCorrectnessRate: number;
  readonly compoundTotal: number;
  readonly compoundComplete: number;
  readonly compoundCompletenessRate: number;
  readonly clarifications: number;
  readonly budgetExhausted: number;
  readonly toolValidationFailures: number;
  readonly referenceReuse: number;
  readonly avgPlannerRounds: number;
  readonly avgToolCalls: number;
  readonly avgElapsedMs: number;
  readonly failures: Readonly<Record<string, number>>;
}

export function summarize(reports: readonly HarnessTurnReport[]): HarnessSummary {
  const total = reports.length;
  const valid = reports.filter((r) => r.validCompletion);
  const judged = reports.filter((r) => r.semanticallyCorrect !== null);
  const correct = judged.filter((r) => r.semanticallyCorrect === true);
  const compound = reports.filter((r) => r.concepts.includes("compound"));
  const compoundOk = compound.filter((r) => r.semanticallyCorrect === true || (r.semanticallyCorrect === null && r.validCompletion));
  const failures: Record<string, number> = {};
  for (const r of reports) if (r.failureClass) failures[r.failureClass] = (failures[r.failureClass] ?? 0) + 1;
  const mean = (xs: readonly number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    total,
    validCompletions: valid.length,
    validCompletionRate: total > 0 ? valid.length / total : 0,
    judged: judged.length,
    semanticallyCorrect: correct.length,
    semanticCorrectnessRate: judged.length > 0 ? correct.length / judged.length : 0,
    compoundTotal: compound.length,
    compoundComplete: compoundOk.length,
    compoundCompletenessRate: compound.length > 0 ? compoundOk.length / compound.length : 0,
    clarifications: reports.filter((r) => r.outcome === "clarify").length,
    budgetExhausted: reports.filter((r) => r.failureClass === "BUDGET").length,
    toolValidationFailures: reports.reduce((n, r) => n + r.trace.rounds.filter((x) => x.toolError).length, 0),
    referenceReuse: reports.filter((r) => r.reusedReference).length,
    avgPlannerRounds: mean(reports.map((r) => r.plannerRounds)),
    avgToolCalls: mean(reports.map((r) => r.toolCalls)),
    avgElapsedMs: mean(reports.map((r) => r.elapsedMs)),
    failures,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** §45 — IDs, labels, counts and bounded previews only; never a full worksheet. */
export function renderHarnessReport(reports: readonly HarnessTurnReport[], summary = summarize(reports)): string {
  const lines: string[] = ["=== STAGE 26.2 LIVE PLANNER BENCHMARK ===", ""];
  for (const r of reports) {
    lines.push(`[${r.id}] ${r.outcome.toUpperCase()}${r.failureClass ? ` (${r.failureClass})` : ""}  ${r.concepts.join(",")}`);
    lines.push(`  Q: ${r.question}`);
    lines.push(`  tools: ${r.toolSequence.join(" → ") || "(none)"}`);
    if (r.completion) lines.push(`  completion: primary=${r.completion.primary} supporting=[${r.completion.supporting.join(", ")}]`);
    if (r.primaryMetrics) lines.push(`  primary: ${r.primaryType}, metrics=[${r.primaryMetrics.join(", ")}]`);
    for (const m of r.mismatches) lines.push(`  MISMATCH ${m}`);
    lines.push(`  budget: rounds=${r.plannerRounds} calls=${r.toolCalls} reads=${r.workbookReads} cache=${r.cacheHits}  ${r.elapsedMs}ms`);
    lines.push("");
  }
  lines.push("=== SUMMARY ===");
  lines.push(`questions                 ${summary.total}`);
  lines.push(`valid completions         ${summary.validCompletions}/${summary.total} (${pct(summary.validCompletionRate)})`);
  lines.push(`semantic correctness      ${summary.semanticallyCorrect}/${summary.judged} (${pct(summary.semanticCorrectnessRate)})`);
  lines.push(`compound completeness     ${summary.compoundComplete}/${summary.compoundTotal} (${pct(summary.compoundCompletenessRate)})`);
  lines.push(`clarifications            ${summary.clarifications}`);
  lines.push(`budget exhausted          ${summary.budgetExhausted}`);
  lines.push(`tool validation failures  ${summary.toolValidationFailures}`);
  lines.push(`reference reuse           ${summary.referenceReuse}/${summary.total}`);
  lines.push(`avg planner rounds        ${summary.avgPlannerRounds.toFixed(2)}`);
  lines.push(`avg tool calls            ${summary.avgToolCalls.toFixed(2)}`);
  lines.push(`avg latency               ${summary.avgElapsedMs.toFixed(0)}ms`);
  lines.push(`failure taxonomy          ${Object.entries(summary.failures).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}`);
  return lines.join("\n");
}

/** Full per-turn traces, for diagnosing a specific failure (§44). */
export function renderHarnessTraces(reports: readonly HarnessTurnReport[]): string {
  return reports.map((r) => `--- [${r.id}] ---\n${renderTrace(r.trace)}`).join("\n\n");
}

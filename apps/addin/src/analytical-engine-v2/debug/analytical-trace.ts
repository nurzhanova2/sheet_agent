import type { AnalyticalConversationState } from "../state/conversation-state.js";
import type { DecisionProblem, EngineResult, PlannedOutput, PlannerDecision, SerializationClass, ToolError } from "../types.js";
import type { VerifiedFinding } from "../insight/verified-finding.js";
import type { UnsupportedClaim } from "../narration/narration-facts.js";

export interface TraceRound {
  readonly round: number;
  readonly decision: PlannerDecision | null;
  readonly parseError?: string;
  /** Stage 26.4 §4 — why a decision was refused, and whether it was recoverable. */
  readonly decisionProblem?: DecisionProblem;
  /**
   * Stage 26.5 §17 — the model's RAW text for a decision the parser refused,
   * bounded and stripped of control characters. §17 requires classifying the
   * actual serialization failure (truncation / prose / duplicate object /
   * escaping) before touching recovery, and that cannot be done from an error
   * string. Developer-facing only, like the rest of the trace.
   */
  readonly rawDecision?: string;
  /** Stage 26.6 §16 — the serialization shape of this round's response. */
  readonly serialization?: SerializationClass;
  readonly toolResultId?: string;
  readonly toolError?: ToolError;
  /** Stage 26.2 §38/§39 — this call reused an identical earlier call's result. */
  readonly cached?: boolean;
}

/** Stage 26.2 §37/§44/§61 — what the turn actually spent. */
export interface BudgetUse {
  readonly plannerRounds: number;
  readonly toolCalls: number;
  readonly workbookReads: number;
  readonly cacheHits: number;
  /** Stage 26.4 §5 — protocol self-corrections, budgeted apart from the above. */
  readonly protocolCorrections: number;
  /** §14 — completion re-bindings that reran no tool. */
  readonly completionRetries: number;
  /** Stage 26.5 §12 — re-bindings spent because a completion contradicted the plan. */
  readonly primaryCorrections: number;
  /** Stage 27 §38/§83 — how many code analyses this turn ran. */
  readonly analyses?: number;
  readonly finalToolCalls?: number;
  readonly finalToolCallsHonoured?: number;
}

export interface HeldFindingTrace {
  readonly id: string;
  readonly findingType: string;
  readonly subject: string;
  readonly reason: string;
}

export interface AnswerQualityTrace {
  readonly extractedFindings: number;
  readonly visibleGroundedFindings: number;
  readonly heldFindings: number;
  readonly unnamedSubjectFindingsHeld: number;
  readonly heldByFindingType: Readonly<Record<string, number>>;
  readonly heldByReason: Readonly<Record<string, number>>;
  readonly held: readonly HeldFindingTrace[];
  readonly answerShape: string;
  readonly deterministicFirstAnswers?: number;
  readonly narratorDrafts: number;
  readonly narrationGateRejects: number;
  readonly answerEvaluatorRejects: number;
  readonly answerEvaluatorIssues: readonly string[];
  readonly rewriteFailureReasons: readonly string[];
  readonly rejectedDrafts: readonly RejectedDraft[];
  readonly answerRewriteAttempts: number;
  readonly answerRewriteSuccesses: number;
  readonly deterministicFallbacks: number;
  readonly minimalFallbacks: number;
  readonly causalClaimsRejected: number;
  readonly numericClaimsRejected: number;
  readonly unnamedSubjectClaimsPresented: number;
  readonly unsupportedCausalClaimsPresented: number;
  readonly unsupportedRecommendationsPresented: number;
  readonly rawEvidenceDumpsPresented: number;
  readonly unsupportedNumericClaims: number;
  readonly unsupportedNumericClaimsPresented: number;
  readonly narratorLatencyMs: number;
  readonly evaluatorLatencyMs: number;
  readonly rewriteLatencyMs: number;
}

export interface RejectedDraft {
  readonly stage: "draft" | "rewrite";
  readonly text: string;
  readonly gateReasons: readonly string[];
  readonly evaluatorIssues: readonly string[];
}

export interface ToolContextTrace {
  readonly availableCapabilities: readonly string[];
  readonly selectedCapabilities: readonly string[];
  readonly availableCapabilityCount: number;
  readonly selectedCapabilityCount: number;
  readonly registryToolCount: number;
  readonly availableToolCount: number;
  readonly initiallyExposedToolCount: number;
  readonly initiallyLoadedToolCount: number;
  readonly finalExposedToolCount: number;
  readonly finalLoadedToolCount: number;
  readonly calledToolCount: number;
  readonly toolDiscoveryRequests: number;
  readonly capabilityUnavailableErrors: number;
  readonly unknownToolErrors: number;
  readonly callToolWithoutInvoker: number;
  readonly executeCodeWithoutRuntime: number;
  readonly mutationCapabilityOffered: number;
  readonly toolSchemaLeaks: number;
  readonly initialPromptChars: number;
  readonly initialToolContextChars: number;
  readonly fullCatalogChars: number;
  readonly promptCharsByRound: readonly number[];
  readonly toolContextCharsByRound: readonly number[];
  readonly agentActions?: readonly string[];
  readonly agentCapabilities?: readonly string[];
  readonly agentExposedTools?: readonly string[];
}

export interface AnalyticalTraceV2 {
  readonly turnId: string;
  readonly request: string;
  readonly at: string;
  readonly route: "analytical_engine_v2";
  readonly sourceRange: string;
  readonly sourceVersion: string;
  readonly stateBefore: AnalyticalConversationState;
  readonly rounds: readonly TraceRound[];
  readonly results: readonly { readonly resultId: string; readonly tool: string; readonly type: string; readonly rowCount: number; readonly parents: readonly string[] }[];
  readonly budget?: BudgetUse;
  /** Stage 26.6 §16 — the serialization shape of each planner response, in order. */
  readonly serializationClasses?: readonly SerializationClass[];
  /** Stage 26.4 §10 — what the planner said this request asks it to produce. */
  readonly declaredOutputs?: readonly PlannedOutput[];
  /** §14 — set when a completion still did not bind every declared output. */
  readonly coverageUnsatisfied?: readonly string[];
  /**
   * Stage 26.5 §13 — the primary-answer decisions, recorded separately from
   * coverage so a live failure says WHICH of the two contracts broke.
   * `declaredPrimaryOutputId` is what the planner said answers the request;
   * `boundPrimaryResultRef` is what its own binding resolves that to.
   */
  readonly declaredPrimaryOutputId?: string;
  readonly boundPrimaryResultRef?: string;
  readonly completePrimaryResultRef?: string;
  readonly primaryBindingMismatch?: boolean;
  readonly primaryCorrectionAttempted?: boolean;
  readonly primaryCorrectionSucceeded?: boolean;
  readonly completion?: { readonly primaryResultRef: string; readonly supportingResultRefs: readonly string[] };
  readonly outcome: "complete" | "clarify" | "failed";
  readonly failureReason?: string;
  readonly stateAfter?: AnalyticalConversationState;
  readonly stateRejected?: string;
  readonly narratorStatus?: "verified" | "fallback" | "deterministic" | "not_run";
  readonly narratorReasons?: readonly string[];
  /**
   * Stage 27.x.1 §28 — every unsupported numeric claim, with its nearest
   * facts and the rule that refused it.
   *
   * Debug-only and never rendered to a user. It exists because the previous
   * five-run investigation had only a reason STRING to work from — "these
   * figures are not VERIFIED FACTS: 70" — which says a number was refused and
   * nothing about whether the narrator was wrong or the verifier was. Both
   * answers turned out to be "the verifier", and finding that out took a day
   * of reading raw transcripts. This is that day, written down.
   */
  readonly unsupportedClaims?: readonly UnsupportedClaim[];
  /**
   * Stage 27 §71 — the observations the answer was built from. The trace shows
   * WHAT WAS CONCLUDED, not only what was computed: a turn whose tools all ran
   * correctly can still say the wrong thing, and without this line the only
   * evidence of that is the prose itself.
   */
  readonly findings?: readonly VerifiedFinding[];
  readonly answerQuality?: AnswerQualityTrace;
  readonly toolContext?: ToolContextTrace;
  /** Stage 27 §71 — how the sandbox analysis was performed, if one ran. */
  readonly analysisMethod?: Readonly<Record<string, unknown>>;
  readonly analysisAttempts?: number;
  readonly analysisDurationMs?: number;
  /** Stage 27 §67 — why the requested analysis could not be completed. */
  readonly analysisFailure?: { readonly code: string; readonly message: string; readonly attempts: number; readonly objective?: string };
}

const MAX_TRACES = 12;
const traces: AnalyticalTraceV2[] = [];

/** Mutable builder used while a turn runs; frozen into the ring buffer at the end. */
export class TraceBuilder {
  readonly #rounds: TraceRound[] = [];
  readonly #at = new Date().toISOString();
  #partial: Partial<AnalyticalTraceV2> = {};
  #results: AnalyticalTraceV2["results"] = [];
  #outcome: AnalyticalTraceV2["outcome"] = "failed";
  #committed = false;
  #index = -1;

  constructor(
    private readonly turnId: string,
    private readonly request: string,
    private readonly sourceRange: string,
    private readonly sourceVersion: string,
    private readonly stateBefore: AnalyticalConversationState,
  ) {}

  round(entry: TraceRound): void {
    this.#rounds.push(entry);
  }

  /**
   * Fields may arrive AFTER the loop has finished — state commit and narration
   * both happen downstream of it — so a `set` past `commit` rewrites the
   * already-recorded trace in place rather than being lost.
   */
  set(fields: Partial<AnalyticalTraceV2>): void {
    this.#partial = { ...this.#partial, ...fields };
    if (this.#committed) this.#rewrite();
  }

  commit(results: readonly EngineResult[], outcome: AnalyticalTraceV2["outcome"]): AnalyticalTraceV2 {
    this.#results = results.map((r) => ({ resultId: r.resultId, tool: r.tool, type: r.type, rowCount: r.rows.length, parents: r.parents }));
    this.#outcome = outcome;
    this.#committed = true;
    const trace = this.#build();
    traces.push(trace);
    if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
    this.#index = traces.indexOf(trace);
    return trace;
  }

  #build(): AnalyticalTraceV2 {
    return {
      turnId: this.turnId,
      request: this.request,
      at: this.#at,
      route: "analytical_engine_v2",
      sourceRange: this.sourceRange,
      sourceVersion: this.sourceVersion,
      stateBefore: this.stateBefore,
      rounds: this.#rounds,
      results: this.#results,
      outcome: this.#outcome,
      ...this.#partial,
    };
  }

  #rewrite(): void {
    if (this.#index < 0 || this.#index >= traces.length) return;
    traces[this.#index] = this.#build();
  }

  /** The current trace, including anything recorded after `commit`. */
  current(): AnalyticalTraceV2 {
    return this.#build();
  }
}

export function getAnalyticalTraces(): readonly AnalyticalTraceV2[] {
  return traces;
}

export function clearAnalyticalTraces(): void {
  traces.length = 0;
}

/** §42 — the human-readable dump behind `/debug analytical-engine`. */
export function renderTrace(trace: AnalyticalTraceV2): string {
  const lines: string[] = [];
  lines.push(`ROUTE            ${trace.route}`);
  lines.push(`REQUEST          ${trace.request}`);
  lines.push(`CONTEXT          ${trace.sourceRange} @ ${trace.sourceVersion}`);
  lines.push(`STATE BEFORE     ${describeState(trace.stateBefore)}`);
  for (const r of trace.rounds) {
    const head = `PLANNER ROUND ${r.round}`;
    if (r.parseError) {
      lines.push(`${head}   invalid decision — ${r.parseError}`);
      if (r.rawDecision) lines.push(`${head}   raw — ${r.rawDecision}`);
      continue;
    }
    const d = r.decision;
    if (!d) {
      lines.push(`${head}   (no decision)`);
      continue;
    }
    if (d.kind === "tool_call") {
      lines.push(`${head}   TOOL CALL ${d.tool} ${JSON.stringify(d.arguments)}`);
      if (r.toolError) {
        lines.push(`                 TOOL ERROR ${r.toolError.code}: ${r.toolError.message}`);
      } else {
        const produced = trace.results.find((x) => x.resultId === r.toolResultId);
        const detail = produced ? `${produced.type}, ${produced.rowCount} row(s)${produced.parents.length > 0 ? `, from [${produced.parents.join(", ")}]` : ""}` : "-";
        lines.push(`                 TOOL RESULT ${r.toolResultId ?? "-"}  ${detail}${r.cached ? "  (cached)" : ""}`);
      }
    } else if (d.kind === "clarify") {
      lines.push(`${head}   CLARIFY ${d.question}`);
    } else if (d.kind === "plan") {
      lines.push(`${head}   PLAN ${d.outputs.map((o) => `${o.id}=${o.description}`).join(" | ")}`);
    } else if (d.kind === "analyze") {
      // Stage 27 §71 — the objective and the requested shapes, because those
      // are what §5 holds the result against. The generated code is not shown
      // here; it has its own line, keyed by hash.
      const outputs = d.requestedOutputs.map((o) => `${o.id}:${o.shape}`).join(", ");
      const methods = d.methods && d.methods.length > 0 ? `  methods=[${d.methods.join(", ")}]` : "";
      lines.push(`${head}   ANALYZE ${d.objective}  outputs=[${outputs}]${methods}`);
    } else {
      const bindings = d.outputBindings ? `  bindings=[${d.outputBindings.map((b) => `${b.outputId}→${b.resultRef}`).join(", ")}]` : "";
      lines.push(`${head}   COMPLETE primary=${d.primaryResultRef} supporting=[${d.supportingResultRefs.join(", ")}]${bindings}`);
    }
  }
  // §19 — which earlier facts this turn reached for, and how. A reference tool
  // CALL and a ref argument passed straight into a working tool are both
  // "references used", and Stage 26.7 measured them 73 to 131 — so showing only
  // the first would show the smaller half.
  const refCalls = trace.rounds.filter((r) => r.decision?.kind === "tool_call" && r.decision.tool.startsWith("reference."));
  const refArgs = trace.rounds.filter(
    (r) => r.decision?.kind === "tool_call" && Object.keys(r.decision.arguments ?? {}).some((k) => k.endsWith("Ref")),
  );
  lines.push(`REFERENCES       lookups=${refCalls.length} (${refCalls.map((r) => (r.decision as { tool: string }).tool).join(", ") || "none"})  direct=${refArgs.length}`);
  const classes = trace.serializationClasses ?? [];
  const recovered = trace.rounds.filter((r) => r.decisionProblem && r.decisionProblem.severity !== "fatal").length;
  lines.push(`SERIALIZATION    [${classes.join(", ") || "-"}]  recovered=${recovered}`);
  lines.push("RESULTS");
  for (const r of trace.results) lines.push(`  ${r.resultId}  ${r.tool}  ${r.type}  ${r.rowCount} row(s)  parents=[${r.parents.join(", ")}]`);
  if (trace.completion) {
    lines.push(`PRIMARY RESULT   ${trace.completion.primaryResultRef}`);
    lines.push(`SUPPORTING       ${trace.completion.supportingResultRefs.join(", ") || "(none)"}`);
  }
  if (trace.budget) {
    lines.push(`BUDGET           rounds=${trace.budget.plannerRounds} toolCalls=${trace.budget.toolCalls} reads=${trace.budget.workbookReads} cacheHits=${trace.budget.cacheHits}`);
  }
  lines.push(`OUTCOME          ${trace.outcome}${trace.failureReason ? ` — ${trace.failureReason}` : ""}`);
  lines.push(`STATE AFTER      ${trace.stateAfter ? describeState(trace.stateAfter) : "(unchanged)"}${trace.stateRejected ? ` — REJECTED: ${trace.stateRejected}` : ""}`);
  if (trace.analysisMethod) {
    const m = trace.analysisMethod as { method?: string; codeHash?: string };
    lines.push(`ANALYSIS         ${m.method ?? "sandbox"} code=${m.codeHash ?? "?"} attempts=${trace.analysisAttempts ?? 1} ${trace.analysisDurationMs ?? 0}ms`);
  }
  if (trace.analysisFailure) {
    lines.push(`ANALYSIS FAILED  ${trace.analysisFailure.code}: ${trace.analysisFailure.message} (after ${trace.analysisFailure.attempts} attempt(s))`);
  }
  const tc = trace.toolContext;
  if (tc) {
    const saved = tc.fullCatalogChars > 0 ? Math.round((1 - tc.initialToolContextChars / tc.fullCatalogChars) * 100) : 0;
    lines.push(
      `CAPABILITIES     available=[${tc.availableCapabilities.join(", ")}] selected=[${tc.selectedCapabilities.join(", ")}]`,
      `TOOL EXPOSURE    registry=${tc.registryToolCount} exposed=${tc.initiallyExposedToolCount} loaded=${tc.initiallyLoadedToolCount}→${tc.finalLoadedToolCount} called=${tc.calledToolCount}`,
      `TOOL CONTEXT     ${tc.initialToolContextChars} chars vs ${tc.fullCatalogChars} full (${saved}% off) prompt=${tc.initialPromptChars} chars`,
      `CAPABILITY GATES unavailable=${tc.capabilityUnavailableErrors} unknownTool=${tc.unknownToolErrors} discovery=${tc.toolDiscoveryRequests} callToolNoInvoker=${tc.callToolWithoutInvoker} executeCodeNoRuntime=${tc.executeCodeWithoutRuntime} mutationOffered=${tc.mutationCapabilityOffered} leaks=${tc.toolSchemaLeaks}`,
    );
  }
  lines.push(`NARRATOR         ${trace.narratorStatus ?? "not_run"}${trace.narratorReasons?.length ? ` (${trace.narratorReasons.join("; ")})` : ""}`);
  const quality = trace.answerQuality;
  if (quality) {
    lines.push(
      `GROUNDING        extracted=${quality.extractedFindings} visible=${quality.visibleGroundedFindings} held=${quality.heldFindings} unnamedHeld=${quality.unnamedSubjectFindingsHeld}`,
      `ANSWER SHAPE     ${quality.answerShape}`,
      `ANSWER QUALITY   drafts=${quality.narratorDrafts} gateRejects=${quality.narrationGateRejects} evaluatorRejects=${quality.answerEvaluatorRejects} rewrite=${quality.answerRewriteAttempts}/${quality.answerRewriteSuccesses} fallbacks=${quality.deterministicFallbacks} minimal=${quality.minimalFallbacks}`,
      `ANSWER REJECTED  causal=${quality.causalClaimsRejected} numeric=${quality.numericClaimsRejected}${quality.rewriteFailureReasons.length > 0 ? ` rewriteFailed=${quality.rewriteFailureReasons.join(",")}` : ""}`,
      `ANSWER PRESENTED unnamed=${quality.unnamedSubjectClaimsPresented} causal=${quality.unsupportedCausalClaimsPresented} recommendation=${quality.unsupportedRecommendationsPresented} rawDump=${quality.rawEvidenceDumpsPresented}`,
      `ANSWER LATENCY   narrator=${quality.narratorLatencyMs}ms evaluator=${quality.evaluatorLatencyMs}ms rewrite=${quality.rewriteLatencyMs}ms`,
    );
    for (const entry of quality.held) lines.push(`HELD FINDING     ${entry.findingType} ${entry.subject || "-"} <- ${entry.reason}`);
    if (quality.answerEvaluatorIssues.length > 0) lines.push(`ANSWER ISSUES    ${quality.answerEvaluatorIssues.join(", ")}`);
    for (const rejected of quality.rejectedDrafts ?? []) {
      const why = [...rejected.gateReasons, ...rejected.evaluatorIssues].join("; ") || "-";
      lines.push(`REJECTED ${rejected.stage.toUpperCase().padEnd(8)}${why}`, `                 ${rejected.text.replace(/\s+/gu, " ").slice(0, 200)}`);
    }
  }
  if (trace.findings?.length) {
    for (const finding of trace.findings) {
      const caveats = finding.caveats.length > 0 ? ` [${finding.caveats.map((c) => c.code).join(", ")}]` : "";
      lines.push(`FINDING          ${finding.findingType} ${finding.subject || "-"} <- ${finding.provenance.resultRef}${caveats}`);
    }
  }
  return lines.join("\n");
}

function describeState(s: AnalyticalConversationState): string {
  const parts: string[] = [];
  if (s.lastResult) parts.push(`lastResult=${s.lastResult.tool}/${s.lastResult.rows.length}r`);
  if (s.lastMetric) parts.push(`lastMetric="${s.lastMetric.metricKey}"`);
  if (s.lastMetricSet) parts.push(`lastMetricSet=${s.lastMetricSet.metricKeys.length}`);
  if (s.lastPeriod) parts.push(`lastPeriod=${s.lastPeriod.startCanonical}${s.lastPeriod.endCanonical ? `..${s.lastPeriod.endCanonical}` : ""}`);
  if (s.lastEvent) parts.push(`lastEvent="${s.lastEvent.metricKey}"`);
  return parts.length > 0 ? parts.join(" ") : "(empty)";
}

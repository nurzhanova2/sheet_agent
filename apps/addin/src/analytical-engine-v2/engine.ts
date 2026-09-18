// ---------------------------------------------------------------------------
// Stage 26 §2/§9/§23/§44 — the unified analytical engine's entry point.
//
//   context → planner loop → explicit completion → coverage check
//           → STATE COMMIT → narrator → narration check → answer
//
// The ordering is the whole point. State is committed from the VERIFIED
// EXECUTION (§9), strictly before narration runs and regardless of what
// narration then does — so a deterministic fallback can never cost the next
// turn its continuity, and a narrator can never move the conversation's focus
// (§36).
// ---------------------------------------------------------------------------

import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import type { TableSchema } from "../app/schema/schema-induction.js";
import { runPlannerLoop } from "./planner/planner-loop.js";
import type { PlannerMessage } from "./planner/planner-prompt.js";
import { methodNoteFor } from "./narration/method-note.js";
import { buildNarratorMessages, gateNarration, type NarrationInput, type NarratorMessage } from "./narration/narrator.js";
import { buildFindings } from "./insight/extract-findings.js";
import { createAnalysisRunner, type AnalysisCapability } from "./sandbox/analysis-runner.js";
import { commitState } from "./state/state-commit.js";
import { storeResult, type AnalyticalConversationState, type SuspendedPlannerState } from "./state/conversation-state.js";
import {
  alreadyAnswered,
  clarificationLoopMessage,
  clarificationSignature,
  repeatedClarificationFeedback,
  type AnsweredClarification,
} from "./state/clarification-loop.js";
import { sameTable } from "./state/state-refs.js";
import type { ResumeContext } from "./planner/planner-loop.js";
import { verifyCoverage } from "./verification/coverage-verifier.js";
import type { AnalyticalTraceV2 } from "./debug/analytical-trace.js";
import { ENGINE_BOUNDS, type EngineAnalysis, type EngineBounds, type EngineTerminationReason } from "./types.js";
import type { VerifiedFinding } from "./insight/verified-finding.js";

export interface EngineRunParams {
  readonly turnId: string;
  readonly request: string;
  readonly schema: TableSchema;
  readonly grids: AnalysisGrids;
  readonly language: "ru" | "en";
  readonly state: AnalyticalConversationState;
  readonly decide: (messages: readonly PlannerMessage[]) => Promise<unknown> | unknown;
  readonly narrate: (messages: readonly NarratorMessage[]) => Promise<string>;
  readonly bounds?: EngineBounds;
  /**
   * Stage 27 §4 — the analytical sandbox, when this build has one.
   *
   * Optional by design. Absent, the planner is never told the capability
   * exists and the engine behaves exactly as Stage 26 did; present, the
   * planner may choose it for operations no tool performs. Nothing in between:
   * there is no mode where the sandbox is advertised and then unavailable.
   */
  readonly analysis?: AnalysisCapability;
  /** Stage 27 §70 — cancels planning, analysis and narration together. */
  readonly signal?: AbortSignal;
}

export type EngineTurn =
  | {
      readonly kind: "answered";
      readonly body: string;
      readonly usedFallback: boolean;
      readonly fallbackReasons: readonly string[];
      readonly analysis: EngineAnalysis;
      /** Stage 27 §40 — the observations the answer was built from. */
      readonly findings: readonly VerifiedFinding[];
      readonly state: AnalyticalConversationState;
      readonly trace: AnalyticalTraceV2;
    }
  | {
      readonly kind: "clarify";
      readonly question: string;
      readonly options: readonly string[];
      /** Stage 26.7 §29 — the same state, plus the task waiting on an answer. */
      readonly state: AnalyticalConversationState;
      /**
       * Stage 26.8 §29 — the planner kept asking for something the user had
       * already supplied, and the bound is spent. The turn still ends in a
       * question rather than a fabricated answer (§30), but NOTHING is
       * suspended: the next message starts clean instead of feeding the loop.
       */
      readonly exhausted?: boolean;
      readonly trace: AnalyticalTraceV2;
    }
  | { readonly kind: "failed"; readonly reason: EngineTerminationReason; readonly detail: string; readonly trace: AnalyticalTraceV2 };

/**
 * §23 — one bounded coverage retry. The retry re-enters the SAME planner loop
 * with an appended note; it never implements the missing part itself.
 */
function coverageNote(request: string, detail: string, language: "ru" | "en"): string {
  return language === "ru"
    ? `${request}\n\n(Предыдущая попытка не охватила весь запрос: ${detail}. Назови все результаты, которых требует запрос — основной и вспомогательные.)`
    : `${request}\n\n(The previous attempt did not cover the whole request: ${detail}. Name every result the request needs — the primary one and its supporting results.)`;
}

/**
 * §32/§33 — may a suspended task still be resumed?
 *
 * Only over the table it was computed on, at the version it was computed at.
 * A clarification that has outlived its data is not an instruction to run a
 * stale analysis; it is dropped, and the message that arrived is handled as
 * the new request it is. §33's other exits (the task completing, an unrelated
 * question, a session reset) clear it the same way: by not carrying it
 * forward.
 */
export function resumableSuspension(state: AnalyticalConversationState, schema: TableSchema): SuspendedPlannerState | null {
  const s = state.suspended;
  if (!s) return null;
  if (s.sourceRange !== schema.sourceRange || s.sourceVersion !== schema.sourceVersion) return null;
  if (!sameTable(state, schema)) return null;
  return s;
}

/**
 * Stage 26.8 §28 — the terms a clarification signature must IGNORE.
 *
 * Everything the table itself supplies: metric labels and period strings.
 * Subtracting them is what makes "which threshold for A?" and "which
 * threshold for B?" the same question, WITHOUT the engine knowing anything
 * about thresholds (§27) — the vocabulary comes from the schema, so it works
 * the same way for any parameter the planner asks about, in any language.
 */
function tableTerms(schema: TableSchema, grids: AnalysisGrids): readonly string[] {
  const out = schema.rowAxis.map((m) => m.display);
  for (const row of grids.values) {
    for (const cell of row) if (typeof cell === "string" && cell.length >= 3) out.push(cell);
  }
  return out;
}

export async function runAnalyticalEngine(params: EngineRunParams): Promise<EngineTurn> {
  const bounds = params.bounds ?? ENGINE_BOUNDS;

  // §30/§31 — a short answer like "20%" means something only inside the task
  // that asked for it. When one is waiting and still valid, the planner sees
  // the original request, the question it asked, and the results it already
  // had; the new message is the answer, not a new task.
  const suspension = resumableSuspension(params.state, params.schema);
  const terms = tableTerms(params.schema, params.grids);
  // §28/§30 — the message in front of us IS the answer to the question the
  // suspension records, so it joins the answers this task already holds.
  const answeredSoFar: readonly AnsweredClarification[] = suspension
    ? [
        ...(suspension.answered ?? []),
        { signature: clarificationSignature(suspension.question, terms), question: suspension.question, reply: params.request },
      ]
    : [];
  const resume: ResumeContext | undefined = suspension
    ? {
        request: suspension.request,
        question: suspension.question,
        answered: answeredSoFar.map((a) => ({ question: a.question, reply: a.reply })),
        results: suspension.results.map((r) => ({
          resultId: r.resultId,
          tool: r.tool,
          type: r.type,
          fields: r.fields,
          rows: r.rows,
          metricKeys: r.metricKeys,
          periodCanonicals: r.periodCanonicals,
          parents: r.parents ?? [],
          sourceRange: r.sourceRange,
          sourceVersion: r.sourceVersion,
          metadata: {},
        })),
        declaredOutputs: suspension.declaredOutputs,
        ...(suspension.primaryOutputId !== undefined ? { primaryOutputId: suspension.primaryOutputId } : {}),
      }
    : undefined;
  // §33 — the suspension never survives the turn that consumed it, and an
  // unresumable one is simply gone.
  const cleared: AnalyticalConversationState = { ...params.state };
  delete (cleared as { suspended?: unknown }).suspended;

  // §4 — built once per turn, so two analyses in one turn cannot disagree
  // about the data they were given.
  const analyze = params.analysis
    ? createAnalysisRunner({ capability: params.analysis, schema: params.schema, grids: params.grids })
    : undefined;

  const plan = (notes?: readonly string[]) =>
    runPlannerLoop({
      turnId: params.turnId,
      request: params.request,
      schema: params.schema,
      grids: params.grids,
      state: cleared,
      decide: params.decide,
      ...(resume ? { resume } : {}),
      ...(notes && notes.length > 0 ? { notes } : {}),
      ...(analyze ? { analyze } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      bounds,
    });

  let run = await plan();

  // §28/§29 — a question the user has already answered is not a question.
  // Push it back to the planner with the answer it already has, once; if it
  // asks a third time the loop stops at a message that says so (§29) rather
  // than at an invented value (§30).
  let repeatedClarification: AnsweredClarification | null = null;
  for (let attempt = 0; attempt < bounds.maxRepeatedClarifications; attempt += 1) {
    if (run.outcome.kind !== "clarify") break;
    const prior = alreadyAnswered(clarificationSignature(run.outcome.question, terms), answeredSoFar);
    if (!prior) break;
    repeatedClarification = prior;
    run = await plan([repeatedClarificationFeedback(prior, params.language)]);
  }

  if (run.outcome.kind === "complete") {
    const coverage = verifyCoverage(params.request, { primary: run.outcome.primary, supporting: run.outcome.supporting, answerStyle: run.outcome.answerStyle });
    if (!coverage.ok) {
      const retry = await runPlannerLoop({
        turnId: params.turnId,
        request: coverageNote(params.request, coverage.detail ?? "", params.language),
        schema: params.schema,
        grids: params.grids,
        state: params.state,
        decide: params.decide,
        ...(analyze ? { analyze } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        bounds,
      });
      // Keep the retry only when it genuinely covers more; never regress.
      if (retry.outcome.kind === "complete" && verifyCoverage(params.request, { primary: retry.outcome.primary, supporting: retry.outcome.supporting, answerStyle: retry.outcome.answerStyle }).ok) {
        run = retry;
      }
    }
  }

  if (run.outcome.kind === "clarify") {
    // §29 — still asking for what it was already told. End the loop with a
    // message the user can act on, and suspend NOTHING: another suspension
    // here is how a two-question stall becomes an endless one.
    if (repeatedClarification && alreadyAnswered(clarificationSignature(run.outcome.question, terms), answeredSoFar)) {
      run.traceBuilder.set({ failureReason: "repeated_clarification" });
      return {
        kind: "clarify",
        question: clarificationLoopMessage(run.outcome.question, repeatedClarification, params.language),
        options: [],
        exhausted: true,
        state: cleared,
        trace: run.traceBuilder.current(),
      };
    }
    // §29 — the turn stops, but the work does not evaporate. Everything the
    // planner computed before it had to ask is kept, with the freshness token
    // it was computed against, so answering the question RESUMES the task
    // (§30) instead of starting it again.
    const suspended: SuspendedPlannerState = {
      turnId: params.turnId,
      request: resume ? resume.request : params.request,
      question: run.outcome.question,
      options: run.outcome.options,
      results: run.results.map(storeResult),
      declaredOutputs: run.declaredOutputs.map((o) => ({ id: o.id, description: o.description })),
      ...(run.primaryOutputId !== undefined ? { primaryOutputId: run.primaryOutputId } : {}),
      ...(answeredSoFar.length > 0 ? { answered: answeredSoFar } : {}),
      sourceRange: params.schema.sourceRange,
      sourceVersion: params.schema.sourceVersion,
    };
    return {
      kind: "clarify",
      question: run.outcome.question,
      options: run.outcome.options,
      // §29 — the conversation is now ABOUT this table even though the turn
      // produced no answer, and without that identity the suspension could
      // never be matched back to the data it was computed over (§32).
      state: {
        ...cleared,
        tableRef: { sheetName: params.schema.sheetName, sourceRange: params.schema.sourceRange, sourceVersion: params.schema.sourceVersion },
        workbookFreshnessToken: params.schema.sourceVersion,
        suspended,
      },
      trace: run.trace,
    };
  }
  if (run.outcome.kind === "failed") {
    // §44 — a clean bounded failure. No legacy fallback, no general chat
    // pretending to answer workbook analytics.
    return { kind: "failed", reason: run.outcome.reason, detail: run.outcome.detail, trace: run.trace };
  }

  const analysis: EngineAnalysis = { primary: run.outcome.primary, supporting: run.outcome.supporting, answerStyle: run.outcome.answerStyle };

  // §9/§39/§40 — commit BEFORE narration, atomically, from the verified
  // execution alone.
  const { state, rejected } = commitState(cleared, {
    turnId: params.turnId,
    tableRef: { sheetName: params.schema.sheetName, sourceRange: params.schema.sourceRange, sourceVersion: params.schema.sourceVersion },
    analysis,
  });
  run.traceBuilder.set({ stateAfter: state, ...(rejected ? { stateRejected: rejected } : {}) });

  // Stage 27 §40 — between the verified execution and the words, the Insight
  // layer: what those rows OBSERVE, with units resolved and materiality
  // measured against the data (§39/§52/§53). Narration is driven by these, not
  // by the raw tables, which is what §41 asks for.
  const findings = buildFindings(analysis.primary, analysis.supporting, {
    schema: params.schema,
    grids: params.grids,
    locale: params.language,
  });
  // §60 — and, for a sandbox analysis only, how it was computed: the method,
  // what it did to the data first, and (§19/§21) which other methods were
  // tried and on what measured grounds this one was kept.
  const method = methodNoteFor(analysis.primary);
  const narration: NarrationInput = { request: params.request, analysis, findings, locale: params.language, ...(method ? { method } : {}) };

  // §35/§37 — narrate, then verify. Either way the state above already stands.
  let draft = "";
  try {
    draft = await params.narrate(buildNarratorMessages(narration));
  } catch {
    draft = "";
  }
  const narrated = gateNarration(draft, narration);
  run.traceBuilder.set({
    narratorStatus: narrated.usedFallback ? "fallback" : "verified",
    ...(narrated.reasons.length > 0 ? { narratorReasons: narrated.reasons } : {}),
    findings,
  });

  return {
    kind: "answered",
    body: narrated.text,
    usedFallback: narrated.usedFallback,
    fallbackReasons: narrated.reasons,
    analysis,
    findings,
    state,
    trace: run.traceBuilder.current(),
  };
}

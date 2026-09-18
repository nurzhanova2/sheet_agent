// ---------------------------------------------------------------------------
// Stage 27 §29/§31/§66/§67/§69 — running an analysis, honestly.
//
// The executor owns the loop between "the planner wants this analysis" and
// "here is a verified result", and its job is mostly to refuse things:
//
//   §69  refuse to start on stale data, and refuse to COMMIT a result whose
//        data changed while it ran;
//   §29  refuse a result that does not contain what was asked for;
//   §67  refuse to substitute a different analysis when repair runs out.
//
// §67 is the one worth stating plainly, because it is the rule a helpful
// system breaks by accident. When code generation fails three times, there is
// always something the sandbox COULD return — the data loaded, a mean was
// computed, a chart could be drawn. Returning it as though it answered the
// question is the §5 violation this stage exists to prevent. The executor
// returns the failure.
// ---------------------------------------------------------------------------

import { validateExplorationCoverage } from "./exploration.js";
import { validateMethodComparison } from "./method-comparison.js";
import type { CodeViolation, ExecuteOutcome } from "./pyodide-runtime.js";
import {
  isRepairable,
  SANDBOX_LIMITS,
  type SandboxDataset,
  type SandboxError,
  type SandboxLimits,
  type SandboxOutcome,
  type SandboxPlan,
  type SandboxResult,
} from "./types.js";

/** What the executor needs of a runtime; both implementations satisfy it. */
export interface AnalyticalRuntime {
  readonly hardTimeout: boolean;
  validate(code: string): Promise<readonly CodeViolation[]>;
  execute(code: string, dataset: SandboxDataset, signal?: AbortSignal): Promise<ExecuteOutcome>;
}

/**
 * §13/§66 — the code generator, as seen from here.
 *
 * `previous` and `failure` are present only on a repair attempt, and carry the
 * exact code that failed plus the structured reason. §66 asks for "a concise
 * structured error", not a transcript: a generator handed a 40-line traceback
 * fixes the traceback rather than the analysis.
 */
export interface CodeRequest {
  readonly plan: SandboxPlan;
  readonly dataset: SandboxDataset;
  readonly attempt: number;
  readonly previous?: string;
  readonly failure?: SandboxError;
}

export type CodeGenerator = (request: CodeRequest) => Promise<string>;

export interface ExecuteAnalysisParams {
  readonly runtime: AnalyticalRuntime;
  readonly plan: SandboxPlan;
  readonly dataset: SandboxDataset;
  readonly generate: CodeGenerator;
  /** §69 — the workbook version NOW, re-read before committing. */
  readonly currentSourceVersion: () => string;
  readonly limits?: SandboxLimits;
  readonly signal?: AbortSignal;
  /** §71 — observability hook; receives every attempt, including failures. */
  readonly onAttempt?: (info: AttemptRecord) => void;
}

export interface AttemptRecord {
  readonly attempt: number;
  readonly code: string;
  readonly codeHash: string;
  readonly ok: boolean;
  readonly error?: SandboxError;
  readonly durationMs: number;
}

/**
 * §29 — does the result contain what the plan asked for?
 *
 * Checked by SHAPE, not by name: a plan asking for `groups` and getting three
 * tables has not been answered, however good the tables are. This is the
 * structural half of §5 — it is what makes "I asked for segmentation and got a
 * trend" detectable by the system rather than only by the reader.
 */
export function validateAgainstPlan(plan: SandboxPlan, result: SandboxResult): readonly string[] {
  const problems: string[] = [];
  const present = {
    table: result.tables.length > 0,
    scalar: Object.keys(result.scalars).length > 0,
    series: result.series.length > 0,
    groups: result.groups.length > 0,
    model: result.models.length > 0,
    diagnostic: Object.keys(result.diagnostics).length > 0,
  };
  for (const output of plan.requestedOutputs) {
    if (!present[output.shape]) {
      problems.push(`the analysis did not return the requested ${output.shape} for "${output.description}"`);
    }
  }
  return problems;
}

/**
 * §19/§20/§21 — did a multi-method request actually get multiple methods?
 *
 * The trigger is the plan, not the result: when the planner committed to two
 * or more methods (§18), a comparison is owed and its absence is a failure,
 * not a stylistic shortfall. That is the difference §19 draws between trying
 * several approaches and mentioning them.
 *
 * A comparison volunteered for a single-method plan is still checked. §21 does
 * not become optional because nobody asked — an unbacked "this one was more
 * interpretable" is exactly as unsupported either way.
 */
export function validateMethodChoice(plan: SandboxPlan, result: SandboxResult): readonly string[] {
  const required = plan.methodConstraints?.length ?? 0;
  if (!result.methodComparison) {
    if (required < 2) return [];
    return [
      `the plan commits to ${required} methods (${plan.methodConstraints?.join(", ")}) but the result has no method_comparison; ` +
        "run each method, measure each one, and report them all in method_comparison",
    ];
  }
  return validateMethodComparison(result.methodComparison);
}

/**
 * §29 — structural sanity of the envelope itself, independent of the plan.
 *
 * NaN and Infinity are already excluded on the Python side; this catches the
 * cases that survive serialisation — a table whose rows do not match its
 * columns, a group with no members, a finding candidate with no subject.
 */
export function validateEnvelope(result: SandboxResult, limits: SandboxLimits): readonly string[] {
  const problems: string[] = [];
  for (const table of result.tables) {
    if (table.rows.length > limits.maxResultRows) problems.push(`table "${table.name}" has ${table.rows.length} rows, over the limit`);
    const wrong = table.rows.find((row) => row.length !== table.columns.length);
    if (wrong) problems.push(`table "${table.name}" has a row of ${wrong.length} values against ${table.columns.length} columns`);
  }
  for (const series of result.series) {
    if (series.index.length !== series.values.length) problems.push(`series "${series.name}" has ${series.index.length} index entries against ${series.values.length} values`);
  }
  for (const group of result.groups) {
    if (group.members.length === 0) problems.push(`group "${group.label}" has no members`);
  }
  for (const value of Object.values(result.scalars)) {
    if (typeof value === "number" && !Number.isFinite(value)) problems.push("a scalar is not a finite number");
  }
  if (result.artifacts.length > limits.maxArtifacts) problems.push(`the analysis returned ${result.artifacts.length} artifacts, over the limit`);
  return problems;
}

/** A short, stable identifier for the exact code that ran (§62/§71). */
export function hashCode(code: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < code.length; i += 1) {
    const c = code.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).padStart(16, "0").slice(0, 16);
}

/**
 * §66/§67 — generate, run, and repair within the budget. Then stop.
 *
 * A repair carries the failure BACK to the generator rather than being applied
 * here: the executor knows nothing about pandas and must not start guessing at
 * fixes, which is how a repair loop becomes a second, worse code generator.
 */
export async function executeAnalysis(params: ExecuteAnalysisParams): Promise<SandboxOutcome> {
  const limits = params.limits ?? SANDBOX_LIMITS;
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;

  // §69 — refuse to START on data that has already moved. Running a stale
  // analysis to completion only produces a stale answer more expensively.
  if (params.dataset.freshnessToken !== params.currentSourceVersion()) {
    return { ok: false, error: { code: "STALE_DATASET", message: "the workbook changed before the analysis began" }, attempts: 0, durationMs: elapsed() };
  }

  let lastError: SandboxError = { code: "SANDBOX_UNAVAILABLE", message: "no attempt was made" };
  let lastCode = "";

  for (let attempt = 1; attempt <= limits.maxAttempts; attempt += 1) {
    if (params.signal?.aborted) {
      return { ok: false, error: { code: "CANCELLED", message: "cancelled" }, attempts: attempt - 1, durationMs: elapsed() };
    }

    let code: string;
    try {
      code = await params.generate({
        plan: params.plan,
        dataset: params.dataset,
        attempt,
        ...(attempt > 1 ? { previous: lastCode, failure: lastError } : {}),
      });
    } catch (err) {
      return { ok: false, error: { code: "SANDBOX_UNAVAILABLE", message: `code generation failed: ${String(err)}` }, attempts: attempt - 1, durationMs: elapsed() };
    }
    lastCode = code;

    const attemptStarted = Date.now();
    const outcome = await params.runtime.execute(code, params.dataset, params.signal);
    const record: AttemptRecord = {
      attempt,
      code,
      codeHash: hashCode(code),
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: outcome.error }),
      durationMs: Date.now() - attemptStarted,
    };
    params.onAttempt?.(record);

    if (!outcome.ok) {
      lastError = outcome.error;
      // §68 — unsafe code is never retried. A generator that reached for the
      // filesystem once will reach for it again, and each retry is another
      // execution of attacker-shaped code against the runtime.
      if (!isRepairable(outcome.error.code)) {
        return { ok: false, error: outcome.error, code, attempts: attempt, durationMs: elapsed() };
      }
      continue;
    }

    const structural = validateEnvelope(outcome.result, limits);
    const coverage = validateAgainstPlan(params.plan, outcome.result);
    const methodChoice = validateMethodChoice(params.plan, outcome.result);
    const explored = validateExplorationCoverage(params.plan.explorationDimensions ?? [], outcome.result);
    const problems = [...structural, ...coverage, ...methodChoice, ...explored];
    if (problems.length > 0) {
      lastError = {
        code: "INVALID_RESULT",
        message: problems.join("; "),
        repairHint: `The analysis ran but did not produce what was asked for: ${problems.join("; ")}. Fix the RESULT assignment.`,
      };
      continue;
    }

    // §69 — and refuse to COMMIT a result whose data moved while it ran. The
    // analysis was correct for a workbook that no longer exists.
    if (params.dataset.freshnessToken !== params.currentSourceVersion()) {
      return { ok: false, error: { code: "STALE_DATASET", message: "the workbook changed while the analysis was running" }, code, attempts: attempt, durationMs: elapsed() };
    }

    return { ok: true, result: outcome.result, code, attempts: attempt, durationMs: elapsed() };
  }

  // §67 — the budget is spent. Say so; do not answer a different question.
  return { ok: false, error: lastError, code: lastCode, attempts: limits.maxAttempts, durationMs: elapsed() };
}

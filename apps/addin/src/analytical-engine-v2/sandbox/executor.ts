import { validateExplorationCoverage } from "./exploration.js";
import { validateMethodComparison } from "./method-comparison.js";
import { numericPreflight } from "./numeric-preflight.js";
import { normalizeResult } from "./result-normalizer.js";
import { buildResultContract, producedSomething, reserializationHint } from "./result-contract.js";
import type { ExecutionProgress, SandboxDiagnostic, SandboxOutputSummary } from "../production/execution-progress.js";
import type { CodeViolation, ExecuteOutcome } from "./pyodide-runtime.js";
import {
  isRepairable,
  SANDBOX_LIMITS,
  type SandboxDataset,
  type SandboxError,
  type SandboxErrorCode,
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
  ready?(): Promise<unknown>;
  startupDiagnostics?(): readonly SandboxDiagnostic[];
}

export function summarizeSandboxOutput(result: SandboxResult): SandboxOutputSummary {
  return {
    tables: result.tables.length,
    scalars: Object.keys(result.scalars).length,
    series: result.series.length,
    groups: result.groups.length,
    models: result.models.length,
    findings: result.findingsCandidates.length,
  };
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
  readonly onProgress?: ExecutionProgress;
  readonly onPhase?: (phase: "generation" | "execution", ms: number) => void;
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

const PLACEHOLDER_SUBJECT = /^(?:[a-z]{1,2}\d{1,3}|\d{1,3}\s*[-–]\s*\d{1,3}|(?:col|column|row|index|item|feature|var|unnamed|out|output|result)[ _-]?\d*)$/i;

/**
 * A BARE integer is the ambiguous case, so it is judged as a set rather than
 * one at a time.
 *
 * `{"0": …, "1": …, "2": …}` is a row index wearing a label. `{"3": …}` on its
 * own, or `{"2": …, "7": …}`, is far more likely to be a cluster id, a bin, or
 * a year — and a false repair here costs a whole code generation, which is the
 * most expensive thing in the turn. So a run of bare integers is only called
 * positional when it actually looks enumerated: three or more of them, dense,
 * starting at 0 or 1.
 */
function positionalRun(subjects: readonly string[]): readonly string[] {
  const bare = subjects.filter((s) => /^\d{1,3}$/.test(s));
  if (bare.length < 3) return [];
  const numbers = [...new Set(bare.map(Number))].sort((a, b) => a - b);
  const first = numbers[0]!;
  if (first > 1) return [];
  const contiguous = numbers.every((n, i) => n === first + i);
  return contiguous ? bare : [];
}

/**
 * Stage 27.x.1 — a subject that is a NUMBER and is not one of this table's
 * labels is a VALUE that escaped into the name slot.
 *
 * Found by the §28 diagnostics on the third validation run, and it is a
 * different failure from `positionalRun`'s. The analysis returned subjects
 * «50», «2», «80», «1000» — cell values, not products — and the answer came
 * out as «Значения "50" распределены довольно ровно», which is not a sentence
 * about anything. The positional check could not see it: those are not dense,
 * not contiguous, and do not start at 0 or 1, so they read as cluster ids.
 *
 * The rule that does see it is structural rather than statistical. By this
 * point every label the dataset carries is known — the metric column, the
 * entity columns, the period labels. A subject that parses as a number and is
 * in none of them cannot be a label OF THIS TABLE, whatever it is. A genuinely
 * numeric entity id ("1001") IS in `known`, because it came from the label
 * column, so it passes; a year passes as a period. Only a number the table
 * never used as a name is refused.
 *
 * Deliberately not fixed downstream. Masking those digits in the narration
 * verifier would have made the counter read zero while the reader still got
 * «показатель 50», and §30 is explicit that a gate must not be loosened to
 * improve a number.
 *
 * THIS OVERTURNS AN EARLIER DECISION, so here is the argument.
 *
 * Stage 27.x added `positionalRun` and a test asserting that bare integers
 * which are NOT an enumeration are left alone — "cluster ids, bins and years
 * all look like this, and a false repair costs a whole code generation". The
 * cost is real and the reasoning was sound at the time. What it did not
 * survive is that all three examples turn out to be covered elsewhere: a
 * cluster id belongs in `group.label`, which this function deliberately does
 * not check; a year is a period and is therefore already in `known`; a
 * distribution over bins is a table, not a per-subject finding. So the case
 * the old rule protected is thin, while the case it let through reached a
 * reader.
 *
 * The narrowing that keeps the old concern honest: this only fires when the
 * table HAS a label column. Given one, a real name was available and the
 * analysis did not use it. Given none, a number may genuinely be the best
 * subject there is, and refusing it would be the false repair the earlier
 * decision warned about.
 */
function strayNumericSubject(subject: string, known: ReadonlySet<string>, hasLabelColumn: boolean): boolean {
  if (!hasLabelColumn) return false;
  const trimmed = subject.trim();
  if (trimmed === "" || known.has(trimmed.toLowerCase())) return false;
  return /^-?\d+(?:[.,]\d+)?$/.test(trimmed);
}

/**
 * §18/§43 — is every subject something a reader could be shown?
 *
 * This is the check the live run was missing. Generated code returned its
 * findings under the planner's own output handle — `RESULT["scalars"] =
 * {"a1": 3665}` — and «a1» was narrated as the subject of the answer. The
 * prompt no longer shows those handles (see `buildCodeMessages`), but a prompt
 * is advice and this is the part that holds: a subject that is a position, an
 * index, a column letter or a planner handle is a REPAIRABLE failure, so the
 * generator gets one more attempt with the reason, instead of the label
 * travelling into prose where nothing downstream can tell it from a name.
 *
 * Narrow on purpose. Anything the dataset actually carries — an entity label,
 * a column name, a period like "2024" or "Q1" — passes, because a real label
 * that happens to look numeric is a label, not a position. The empty subject
 * passes too: §37 asks a dimension that found nothing to say so, and `""` is
 * how it says it.
 */
export function validateSubjectLabels(plan: SandboxPlan, dataset: SandboxDataset, result: SandboxResult): readonly string[] {
  const known = new Set<string>();
  for (const column of dataset.columns) known.add(column.name.trim().toLowerCase());
  for (const period of dataset.periods ?? []) known.add(period.trim().toLowerCase());
  const labelColumns = dataset.columns
    .map((c, i) => ({ semanticType: c.semanticType, index: i }))
    .filter((c) => c.semanticType === "metric_label" || c.semanticType === "category" || c.semanticType === "entity_id");
  for (const row of dataset.rows) {
    for (const { index } of labelColumns) {
      const value = row[index];
      if (typeof value === "string" && value.trim() !== "") known.add(value.trim().toLowerCase());
    }
  }
  const handles = new Set(plan.requestedOutputs.map((o) => o.id.trim().toLowerCase()).filter((id) => id !== ""));

  const offenders = new Set<string>();
  const unnamed: string[] = [];
  const check = (raw: string): void => {
    const subject = raw.trim();
    if (subject === "") return;
    const key = subject.toLowerCase();
    if (known.has(key)) return;
    if (handles.has(key) || PLACEHOLDER_SUBJECT.test(subject) || strayNumericSubject(subject, known, labelColumns.length > 0)) offenders.add(subject);
    else unnamed.push(subject);
  };

  for (const candidate of result.findingsCandidates) check(candidate.subject);
  for (const name of Object.keys(result.scalars)) check(name);
  // A group's LABEL is deliberately not checked: "0" and "1" out of k-means are
  // arbitrary identifiers by nature and there is no better name to demand. Its
  // MEMBERS are entities and must be named.
  for (const group of result.groups) {
    for (const member of group.members) check(member);
  }
  for (const positional of positionalRun(unnamed)) offenders.add(positional);
  if (offenders.size === 0) return [];
  return [
    `these are positions or planner handles, not names anyone can read: ${[...offenders].map((o) => `"${o}"`).join(", ")}; ` +
      "label every subject, scalar and group member with the value it refers to, taken from the table's own label column",
  ];
}

function entityLabelsOf(dataset: SandboxDataset): ReadonlySet<string> {
  const labelColumns = dataset.columns
    .map((c, i) => ({ semanticType: c.semanticType, index: i }))
    .filter((c) => c.semanticType === "metric_label" || c.semanticType === "category" || c.semanticType === "entity_id");
  const labels = new Set<string>();
  for (const row of dataset.rows) {
    for (const { index } of labelColumns) {
      const value = row[index];
      if (typeof value === "string" && value.trim() !== "") labels.add(value.trim());
    }
  }
  return labels;
}

export function validateClusterMembership(dataset: SandboxDataset, result: SandboxResult): readonly string[] {
  if (result.groups.length === 0) return [];
  const entities = entityLabelsOf(dataset);
  if (entities.size === 0) return [];
  const periods = new Set((dataset.periods ?? []).map((p) => p.trim()));
  const notEntities: string[] = [];
  const duplicates = new Set<string>();
  const covered = new Set<string>();
  for (const group of result.groups) {
    for (const raw of group.members) {
      const member = raw.trim();
      if (member === "") continue;
      if (!entities.has(member)) {
        notEntities.push(periods.has(member) ? `"${member}" is a period, not one of the clustered entities` : `"${member}" is not one of the table's entities`);
        continue;
      }
      if (covered.has(member)) duplicates.add(member);
      else covered.add(member);
    }
  }
  const problems: string[] = [];
  if (notEntities.length > 0) problems.push(`group members must be the clustered entities, not something else: ${notEntities.join("; ")}`);
  if (duplicates.size > 0) problems.push(`these entities appear in more than one group: ${[...duplicates].map((d) => `"${d}"`).join(", ")}`);
  return problems;
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

const NEWLINE = String.fromCharCode(10);

const PYTHON_EXCEPTION = /^([A-Z][A-Za-z]*(?:Error|Exception|Warning))\s*:\s*/u;
const TRACEBACK_TAIL = /\s*\(File "[^"]*".*$/u;

const ERROR_CODE_LABEL: Readonly<Record<SandboxErrorCode, string>> = {
  CODE_VALIDATION_ERROR: "SyntaxError",
  UNSAFE_CODE: "SecurityError",
  SANDBOX_TIMEOUT: "TimeoutError",
  SANDBOX_MEMORY_LIMIT: "MemoryError",
  SANDBOX_RUNTIME_ERROR: "RuntimeError",
  INVALID_RESULT: "ResultError",
  UNSUPPORTED_LIBRARY: "ImportError",
  DATA_TOO_LARGE: "DataTooLarge",
  STALE_DATASET: "StaleData",
  CANCELLED: "Cancelled",
  SANDBOX_UNAVAILABLE: "SandboxUnavailable",
};

export function errorTypeOf(error: SandboxError): string {
  const named = PYTHON_EXCEPTION.exec(error.message.trim());
  return named?.[1] ?? ERROR_CODE_LABEL[error.code];
}

export function shortErrorMessage(error: SandboxError, limit = 200): string {
  const body = error.message.trim().replace(PYTHON_EXCEPTION, "").replace(TRACEBACK_TAIL, "").trim();
  const source = body.length > 0 ? body : error.message.trim();
  const text = (source.split(NEWLINE)[0] ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
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
    params.onProgress?.({ kind: "code_generating", attempt });
    const generationStarted = Date.now();
    try {
      code = await params.generate({
        plan: params.plan,
        dataset: params.dataset,
        attempt,
        ...(attempt > 1 ? { previous: lastCode, failure: lastError } : {}),
      });
    } catch (err) {
      params.onPhase?.("generation", Date.now() - generationStarted);
      return { ok: false, error: { code: "SANDBOX_UNAVAILABLE", message: `code generation failed: ${String(err)}` }, attempts: attempt - 1, durationMs: elapsed() };
    }
    params.onPhase?.("generation", Date.now() - generationStarted);
    lastCode = code;
    params.onProgress?.({ kind: "code_generated", attempt, code });

    // An empty generation is a transport/model failure, not a Python program
    // that can be repaired. Sending it to the runtime only turns a clear
    // generator failure into `RESULT was never assigned`, which then enters
    // the normal repair budget and can stall the turn.
    if (code.trim() === "") {
      const error: SandboxError = {
        code: "CODE_VALIDATION_ERROR",
        message: "the code generator returned an empty script",
        repairHint: "Return one complete Python script that assigns the requested result to RESULT.",
      };
      const durationMs = Date.now() - generationStarted;
      params.onAttempt?.({ attempt, code, codeHash: hashCode(code), ok: false, error, durationMs });
      params.onProgress?.({
        kind: "code_failed",
        attempt,
        durationMs,
        errorType: errorTypeOf(error),
        errorMessage: shortErrorMessage(error),
        retrying: false,
      });
      return { ok: false, error, code, attempts: attempt, durationMs: elapsed() };
    }

    const attemptStarted = Date.now();
    const lastAttempt = attempt >= limits.maxAttempts;
    const reportFailure = (error: SandboxError, durationMs: number): void => {
      params.onProgress?.({
        kind: "code_failed",
        attempt,
        durationMs,
        errorType: errorTypeOf(error),
        errorMessage: shortErrorMessage(error),
        retrying: !lastAttempt && isRepairable(error.code),
      });
    };

    // Stage 27.x §6 — the cheap check, before the expensive one.
    //
    // Raw `data` handed to an estimator fails every time, and failing it here
    // costs a regex instead of a Pyodide execution plus a repair generation.
    // It is a readability check on code the §15 security validator has already
    // cleared, and it rewrites nothing: the script is refused with the same
    // typed, repairable error the runtime would eventually have produced.
    //
    // Stage 27.x.1 §3–§6 — and the same again for the pandas/numpy boundary.
    // That one is not a leftover from before the prepared views; it is a cost
    // OF them. The model found `X`, used it, and called DataFrame methods on
    // it. §3 is explicit that prompt text alone must not be the answer.
    const preflight = numericPreflight(code, params.dataset);
    if (preflight) {
      lastError = {
        code: "INVALID_RESULT",
        message: preflight.message,
        repairHint: preflight.repairHint,
        ...(preflight.failureClass ? { failureClass: preflight.failureClass } : {}),
      };
      params.onAttempt?.({ attempt, code, codeHash: hashCode(code), ok: false, error: lastError, durationMs: Date.now() - attemptStarted });
      reportFailure(lastError, Date.now() - attemptStarted);
      continue;
    }

    params.onProgress?.({ kind: "code_running", attempt });
    const executionStarted = Date.now();
    const outcome = await params.runtime.execute(code, params.dataset, params.signal);
    params.onPhase?.("execution", Date.now() - executionStarted);
    // §71 — the attempt is reported ONCE, after the verdict is known.
    //
    // It used to be reported the moment Python returned, which made a script
    // that ran and was then refused by §29 indistinguishable in the record
    // from one that ran and was accepted: `ok: true`, no error, and four
    // consecutive identical entries when the coverage check kept rejecting it.
    // A trace that cannot tell those apart cannot be used to fix either.
    const report = (ok: boolean, error?: SandboxError): void => {
      const durationMs = Date.now() - attemptStarted;
      params.onAttempt?.({
        attempt,
        code,
        codeHash: hashCode(code),
        ok,
        ...(error ? { error } : {}),
        durationMs,
      });
      if (ok && outcome.ok) {
        params.onProgress?.({ kind: "code_succeeded", attempt, durationMs, produced: summarizeSandboxOutput(outcome.result) });
      } else if (error) {
        reportFailure(error, durationMs);
      }
    };

    if (!outcome.ok) {
      report(false, outcome.error);
      lastError = outcome.error;
      // §68 — unsafe code is never retried. A generator that reached for the
      // filesystem once will reach for it again, and each retry is another
      // execution of attacker-shaped code against the runtime.
      if (!isRepairable(outcome.error.code)) {
        return { ok: false, error: outcome.error, code, attempts: attempt, durationMs: elapsed() };
      }
      continue;
    }

    // Stage 27.x §9 — normalise, THEN validate. The validators are unchanged
    // and still see a SandboxResult; what reaches them has had an unambiguous
    // naming mismatch resolved by counting, and an ambiguous one turned into a
    // problem the generator can act on (§10).
    const normalized = normalizeResult(params.plan, outcome.result);
    const committed = normalized.result;

    const structural = validateEnvelope(committed, limits);
    const coverage = validateAgainstPlan(params.plan, committed);
    const methodChoice = validateMethodChoice(params.plan, committed);
    const explored = validateExplorationCoverage(params.plan.explorationDimensions ?? [], committed);
    const labels = validateSubjectLabels(params.plan, params.dataset, committed);
    const clusterAxis = validateClusterMembership(params.dataset, committed);
    const problems = [...normalized.ambiguous, ...structural, ...coverage, ...methodChoice, ...explored, ...labels, ...clusterAxis];
    if (problems.length > 0) {
      // Stage 27.x.1 §12 — repair the smallest failed layer.
      //
      // When the ONLY objection is that the plan's shapes are not present,
      // and the script nonetheless returned something it measured, the
      // analysis is not what failed: the serialization is. Telling a
      // generator "the analysis did not produce what was asked for" in that
      // situation invites it to rewrite a method that was working, which is
      // how a shape mismatch turns into a second, different failure.
      //
      // The distinction is structural, not a guess — see `producedSomething`.
      const shapeOnly =
        coverage.length === problems.length &&
        coverage.length > 0 &&
        producedSomething({
          tables: committed.tables.length,
          scalars: Object.keys(committed.scalars).length,
          series: committed.series.length,
          groups: committed.groups.length,
          models: committed.models.length,
          diagnostics: Object.keys(committed.diagnostics).length,
          findings: committed.findingsCandidates.length,
        });
      lastError = {
        code: "INVALID_RESULT",
        message: problems.join("; "),
        repairHint: shapeOnly
          ? reserializationHint(buildResultContract(params.plan), problems)
          : `The analysis ran but did not produce what was asked for: ${problems.join("; ")}. Fix the RESULT assignment.`,
        failureClass: "OUTPUT_CONTRACT_ERROR",
        ...(shapeOnly ? { subtype: "OUTPUT_SHAPE_MISMATCH" as const } : {}),
      };
      report(false, lastError);
      continue;
    }

    // §69 — and refuse to COMMIT a result whose data moved while it ran. The
    // analysis was correct for a workbook that no longer exists.
    if (params.dataset.freshnessToken !== params.currentSourceVersion()) {
      const stale: SandboxError = { code: "STALE_DATASET", message: "the workbook changed while the analysis was running" };
      report(false, stale);
      return { ok: false, error: stale, code, attempts: attempt, durationMs: elapsed() };
    }

    report(true);
    return { ok: true, result: committed, code, attempts: attempt, durationMs: elapsed() };
  }

  // §67 — the budget is spent. Say so; do not answer a different question.
  return { ok: false, error: lastError, code: lastCode, attempts: limits.maxAttempts, durationMs: elapsed() };
}

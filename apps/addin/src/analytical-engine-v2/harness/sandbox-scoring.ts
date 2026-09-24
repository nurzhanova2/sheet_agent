import { classifyFailure } from "../sandbox/failure-classes.js";
import type { HarnessTurnReport } from "./live-harness.js";
import type { EngineTurn } from "../engine.js";

/** §92 — the counters that must read zero. Each one is structural. */
export interface ViolationCounts {
  /** A figure in the answer that no verified finding entitles it to use. */
  readonly unsupportedNumericClaims: number;
  /** An answer produced for an operation other than the one requested (§5). */
  readonly silentSubstitutions: number;
  /** Generated code that reached a capability it must not have (§7). */
  readonly unsafeEscapes: number;
  /** A gap treated as a zero, or a policy never declared (§23/§24). */
  readonly missingToZero: number;
  /** An answer built on data that had already moved (§69). */
  readonly stalePresentations: number;
}

export interface ViolationDetail {
  readonly id: string;
  readonly counter: keyof ViolationCounts;
  readonly evidence: string;
}

const EMPTY: ViolationCounts = {
  unsupportedNumericClaims: 0,
  silentSubstitutions: 0,
  unsafeEscapes: 0,
  missingToZero: 0,
  stalePresentations: 0,
};

/**
 * The gate's own vocabulary for "this number came from nowhere".
 *
 * Two spellings, because two gates can produce it: Stage 26's fact check
 * ("not VERIFIED FACTS") and Stage 27.x.1's fact resolver ("unsupported
 * numeric claim"). The resolver is the authority now, but the older wording
 * stays recognised — a counter that silently stopped matching would report
 * zero violations and look like a fix.
 */
const UNSUPPORTED_RE = /not VERIFIED FACTS|are not verified|unsourced|unsupported numeric claim/i;
const STALE_RE = /STALE_DATASET|source data changed|stale/i;

/**
 * §92 — what actually went wrong in one turn.
 *
 * Reads the trace and the narration verdict, never the prose. A counter that
 * depended on reading the answer would be measuring the same text the answer
 * was generated from, and would agree with it.
 */
export function countViolations(report: HarnessTurnReport, turn: EngineTurn): { readonly counts: ViolationCounts; readonly details: readonly ViolationDetail[] } {
  const details: ViolationDetail[] = [];
  const counts = { ...EMPTY };
  const trace = report.trace;

  // §56/§37 — the narrator wrote a figure the findings did not license. The
  // gate caught it and substituted the deterministic rendering, so the user
  // never saw it; it is still a violation, and hiding it because the fallback
  // worked would make the counter meaningless.
  const reasons = trace.narratorReasons ?? [];
  for (const reason of reasons) {
    if (UNSUPPORTED_RE.test(reason)) {
      counts.unsupportedNumericClaims += 1;
      details.push({ id: report.id, counter: "unsupportedNumericClaims", evidence: reason });
      break;
    }
  }

  // §5 — the analysis failed and the turn answered anyway. The engine is built
  // so this cannot happen; the counter is what proves it stayed that way.
  const analysisFailure = trace.analysisFailure;
  if (analysisFailure && turn.kind === "answered") {
    counts.silentSubstitutions += 1;
    details.push({ id: report.id, counter: "silentSubstitutions", evidence: `analysis failed with ${analysisFailure.code ?? "?"} and the turn answered regardless` });
  }

  // §7/§15 — a script that reached past the sandbox. UNSAFE_CODE means it was
  // REFUSED, which is the system working; what would count here is a refused
  // capability that nonetheless produced a result.
  if (report.analysis?.failureCode === "UNSAFE_CODE" && turn.kind === "answered" && !analysisFailure) {
    counts.unsafeEscapes += 1;
    details.push({ id: report.id, counter: "unsafeEscapes", evidence: "unsafe code was flagged and a result was still committed" });
  }

  // §69 — data that moved under the analysis.
  if (turn.kind === "answered" && STALE_RE.test(JSON.stringify(trace.analysisFailure ?? ""))) {
    counts.stalePresentations += 1;
    details.push({ id: report.id, counter: "stalePresentations", evidence: "a stale dataset reached a committed answer" });
  }

  return { counts, details };
}

/**
 * §23/§24 — did an analysis that met gaps say what it did about them?
 *
 * Separate from `countViolations` because it needs to know that the QUESTION
 * touched missing data: an analysis over complete columns owes no policy, and
 * demanding one everywhere would turn a real check into noise.
 */
export function countMissingPolicy(report: HarnessTurnReport, touchesGaps: boolean): ViolationDetail | null {
  if (!touchesGaps || !report.analysis || report.analysis.failureCode) return null;
  const method = report.trace.analysisMethod;
  const preprocessing = method?.["preprocessing"] as Record<string, unknown> | undefined;
  const policy = preprocessing?.["missingValuePolicy"] as Record<string, unknown> | undefined;
  if (policy && typeof policy["method"] === "string") {
    // A declared `zero_if_semantically_valid` is allowed by §24 but has to be
    // justified; anything else is fine to have chosen.
    return null;
  }
  return {
    id: report.id,
    counter: "missingToZero",
    evidence: "the analysis ran over columns with gaps and declared no missing-value policy",
  };
}

// --- §93: the shape of the answer, as a screen ------------------------------

/**
 * §93 — the four things a non-trivial analytical answer should contain.
 *
 * Every field is a HEURISTIC and every consumer of this type is expected to
 * treat it as one. They are computed so a human reviewer can start with the
 * turns most likely to be wrong, and so the raw-dump rate has a definition
 * that does not change between runs.
 */
export interface AnswerShape {
  readonly hasDirectConclusion: boolean;
  readonly hasExplanation: boolean;
  readonly hasEvidence: boolean;
  readonly hasCaveat: boolean;
  /** §43 — the answer is a table wearing a sentence, or a list of fields. */
  readonly looksLikeRawDump: boolean;
  readonly sentences: number;
  readonly characters: number;
}

const NUMBER_RE = /-?\d[\d\s]*(?:[.,]\d+)?\s*(?:%|п\.п\.|pp)?/;
const CONNECTIVE_RE = /(?:при этом|тогда как|зато|однако|в то время как|поэтому|то есть|причём|за счёт|на фоне|meanwhile|whereas|while|because of|which)/i;
/**
 * §93 — did the answer qualify what it said?
 *
 * Two corrections after the first live run, both of which made this screen
 * report FEWER caveats than the answers actually carried.
 *
 * The first is a plain bug: JavaScript's `\w` is ASCII-only even under /u, so
 * `низк\w* баз\w*` could never match «низкой базе» — the stem matched, the
 * Cyrillic ending did not, and the required space then failed. Every
 * Cyrillic-suffix alternative here now uses \p{L}. `hn-low-base` was scored
 * as having no caveat while its answer read «процент велик при низкой
 * базе 2».
 *
 * The second is a definition problem. The list was written from how a model
 * might hedge, when the caveats that matter are the ones the SYSTEM emits
 * from `CAVEAT_RU` and the §49 relationship template — those are the
 * qualifications §40 promises, so those are what this looks for.
 */
const CAVEAT_RE =
  /(?:стоит учесть|низк\p{L}* баз\p{L}*|небольш\p{L}* баз\p{L}*|мало наблюдений|наблюдений слишком мало|осторожн|не установлен\p{L}*|может указывать|гипотеза|не причин|совпадение в данных|пропуск\p{L}* исключен|записанное значение|итоговая строка|единиц\p{L}* измерения различ|не определен\p{L}*|отдельные срезы|изменились после расчёта|caveat|small base|low base|few observations|not an established|excluded from the calculation|co-movement)/iu;
/** A line that is just "label: number" — the §43 failure, one row at a time. */
const FIELD_LINE_RE = /^\s*[^:\n]{1,60}:\s*-?[\d\s]+(?:[.,]\d+)?\s*%?\s*$/;

export function describeAnswer(text: string): AnswerShape {
  const trimmed = text.trim();
  const lines = trimmed.split("\n").filter((l) => l.trim() !== "");
  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const first = sentences[0] ?? "";

  const fieldLines = lines.filter((l) => FIELD_LINE_RE.test(l)).length;
  const pipeRows = lines.filter((l) => (l.match(/\|/g) ?? []).length >= 2).length;

  return {
    // A direct conclusion names something and says something about it in the
    // FIRST sentence — not "Я проанализировал таблицу и вот что получилось."
    hasDirectConclusion: first.length > 0 && !/^(?:я\s|мы\s|вот\s|ниже\s|давайте|i\s+(?:analy|look)|here(?:'s| is))/i.test(first.trim()),
    hasExplanation: sentences.length >= 2 || CONNECTIVE_RE.test(trimmed),
    hasEvidence: NUMBER_RE.test(trimmed),
    hasCaveat: CAVEAT_RE.test(trimmed),
    // Half the lines being "field: number", or any pipe table at all.
    looksLikeRawDump: pipeRows >= 2 || (lines.length >= 3 && fieldLines >= Math.ceil(lines.length / 2)),
    sentences: sentences.length,
    characters: trimmed.length,
  };
}

// --- §87: latency, as §87 asks for it --------------------------------------

export interface Percentiles {
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly n: number;
}

export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { median: 0, p95: 0, max: 0, n: 0 };
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  return { median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]!, n: sorted.length };
}

export interface StageLatency {
  readonly planner: Percentiles;
  readonly codeGeneration: Percentiles;
  readonly sandboxExecution: Percentiles;
  readonly narration: Percentiles;
  readonly engine: Percentiles;
  readonly turn: Percentiles;
}

export function stageLatency(reports: readonly HarnessTurnReport[]): StageLatency {
  const withSandbox = reports.filter((r) => r.stages.codeGenCalls > 0);
  return {
    planner: percentiles(reports.map((r) => r.stages.plannerMs)),
    codeGeneration: percentiles(withSandbox.map((r) => r.stages.codeGenMs)),
    sandboxExecution: percentiles(withSandbox.map((r) => r.stages.sandboxExecMs)),
    narration: percentiles(reports.map((r) => r.stages.narrationMs)),
    engine: percentiles(reports.map((r) => r.stages.engineMs)),
    turn: percentiles(reports.map((r) => r.elapsedMs)),
  };
}

export function sumCounts(all: readonly ViolationCounts[]): ViolationCounts {
  return all.reduce<ViolationCounts>(
    (acc, c) => ({
      unsupportedNumericClaims: acc.unsupportedNumericClaims + c.unsupportedNumericClaims,
      silentSubstitutions: acc.silentSubstitutions + c.silentSubstitutions,
      unsafeEscapes: acc.unsafeEscapes + c.unsafeEscapes,
      missingToZero: acc.missingToZero + c.missingToZero,
      stalePresentations: acc.stalePresentations + c.stalePresentations,
    }),
    EMPTY,
  );
}

/**
 * §90 — does the answer NAME this entity?
 *
 * `body.includes("Ангара")` is false for «Продажи Ангары выросли», and
 * that is how a run reported the sandbox naming none of the planted entities
 * while its answers named them in every sentence. Russian inflects, and a
 * screen that only recognises the nominative measures grammar rather than
 * correctness.
 *
 * The stem is the name minus its final vowel — enough for Ангара/Ангары,
 * Мезень/Мезени, Нева/Невы — and it is deliberately not a morphology
 * engine: this is a benchmark screen, and a wrong answer that happens to share
 * a five-letter stem with the right one is not the failure mode anyone is
 * worried about.
 */
export function mentionsEntity(body: string, entity: string): boolean {
  const text = body.toLowerCase();
  const name = entity.trim().toLowerCase();
  if (name === "") return false;
  if (text.includes(name)) return true;
  const stem = /[аяоеёэиыуюьъ]$/u.test(name) ? name.slice(0, -1) : name;
  return stem.length >= 4 && text.includes(stem);
}

// --- Stage 27.x §13/§14: whose failure was it -------------------------------

/**
 * §13 — why a turn did not answer, at the granularity that decides who fixes it.
 *
 * "Sandbox failure" was the only label the first reports had, and it hid the
 * finding that mattered: more than a third of failed attempts were this
 * engine's own validators refusing structurally valid work. A number that
 * lumps that together with the model writing bad pandas cannot be acted on by
 * either party.
 */
export type FailureClass =
  /** The generated Python is genuinely wrong. */
  | "MODEL_CODE_ERROR"
  /** The script misused the data contract — raw frame into a numeric call. */
  | "DATA_CONTRACT_ERROR"
  /** The engine asked for something it does not make obtainable. */
  | "ENGINE_CONTRACT_ERROR"
  /** A validator refused a result that was structurally fine. */
  | "VALIDATOR_FALSE_REJECTION"
  /** §68 — code reached for a denied capability. Never a defect. */
  | "SECURITY_REJECTION"
  /** The request is outside what the sandbox can do at all. */
  | "UNSUPPORTED_ANALYSIS"
  | "TIMEOUT"
  /** The data itself cannot support the analysis (all gaps, one row). */
  | "DATA_QUALITY_ERROR"
  | "NONE";

/**
 * Classify one failed attempt from its error code and message.
 *
 * VALIDATOR_FALSE_REJECTION is the judgement call, so it is drawn narrowly:
 * an INVALID_RESULT that complains about NAMING or about criterion evidence is
 * this engine rejecting work it should have taken. An INVALID_RESULT that says
 * a requested shape is missing is a real shortfall and stays a model error.
 */
export function classifyAttemptFailure(code: string | undefined, message: string, declared?: string): FailureClass {
  if (!code) return "NONE";
  // Stage 27.x.1 §31 — when the refusing layer NAMED its class, believe it.
  //
  // The preflight checks and the output-contract check do not infer their
  // class from a traceback; they are the thing that decided it. Reading the
  // message with a regex to rediscover a verdict that was already recorded is
  // how a taxonomy drifts away from the code it describes.
  if (declared === "PANDAS_NUMPY_TYPE_MISMATCH" || declared === "NON_NUMERIC_INPUT" || declared === "INDEX_ALIGNMENT_ERROR") {
    return "DATA_CONTRACT_ERROR";
  }
  if (code === "CODE_VALIDATION_ERROR" || code === "UNSAFE_CODE") return "SECURITY_REJECTION";
  if (code === "SANDBOX_TIMEOUT" || code === "SANDBOX_MEMORY_LIMIT") return "TIMEOUT";
  if (code === "UNSUPPORTED_LIBRARY") return "UNSUPPORTED_ANALYSIS";
  if (code === "DATA_TOO_LARGE" || code === "STALE_DATASET") return "DATA_QUALITY_ERROR";
  if (code === "INVALID_RESULT") {
    // ORDER MATTERS, and getting it wrong falsified a whole report once.
    //
    // The executor stamps `OUTPUT_CONTRACT_ERROR` on EVERY failure from its
    // validation block — including the validator false rejections, which are a
    // strict subset of it. An earlier version of this function tested the
    // declared class first, so every false rejection was filed as
    // ENGINE_CONTRACT_ERROR: the five-run report read
    // "VALIDATOR_FALSE_REJECTION 1.6 -> 0.0", which looked like the defect had
    // been eliminated. Re-classified on the baseline's own basis it was
    // 1.6 -> 0.8 — a real halving, reported as a fictional disappearance.
    //
    // So the SPECIFIC message test runs first and the coarse declared class is
    // the fallback, never the override.
    if (/positions or planner handles|names anyone can read|is declared but nothing measures it|AMBIGUOUS_RESULT_MAPPING|the plan asks for one scalar/i.test(message)) {
      return "VALIDATOR_FALSE_REJECTION";
    }
    if (/label column|numerical operation was given|pandas member called on a numpy array|boolean Series used to index/i.test(message)) return "DATA_CONTRACT_ERROR";
    return "ENGINE_CONTRACT_ERROR";
  }
  if (code === "SANDBOX_RUNTIME_ERROR") {
    const cls = classifyFailure(message);
    if (cls === "NON_NUMERIC_INPUT" || cls === "PANDAS_NUMPY_TYPE_MISMATCH" || cls === "INDEX_ALIGNMENT_ERROR") return "DATA_CONTRACT_ERROR";
    if (cls === "MISSING_VALUE_INCOMPATIBILITY") return "DATA_QUALITY_ERROR";
    if (cls === "UNSUPPORTED_LIBRARY") return "UNSUPPORTED_ANALYSIS";
    return "MODEL_CODE_ERROR";
  }
  return "MODEL_CODE_ERROR";
}

/** §14 — how an analysis ended, kept apart from how hard it was. */
export type AnalysisOutcomeClass = "FIRST_ATTEMPT_SUCCESS" | "REPAIRED_SUCCESS" | "TERMINAL_FAILURE" | "NOT_REQUESTED";

export interface AttemptSummary {
  readonly attempt: number;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly error?: string;
}

export function classifyAnalysisOutcome(log: readonly AttemptSummary[], failed: boolean): AnalysisOutcomeClass {
  if (log.length === 0) return "NOT_REQUESTED";
  if (failed) return "TERMINAL_FAILURE";
  return log.length === 1 && log[0]!.ok ? "FIRST_ATTEMPT_SUCCESS" : "REPAIRED_SUCCESS";
}

// --- Stage 27.x.1 §31/§32/§43: what the taxonomy has to say ----------------

/**
 * §31 — attempts and QUESTIONS, counted apart.
 *
 * The Stage 27.x report gave only attempt counts, and the single most
 * misleading line in it was "MODEL_CODE_ERROR: 67". Sixty-seven attempts is
 * alarming until you notice a question gets three attempts, so one stubborn
 * question contributes three and a question that fails on its first attempt
 * and then succeeds contributes one. Attempt counts measure how much WORK a
 * class caused; question counts measure how much ANSWERING it cost. Only the
 * second is reliability, and §31 says so: do not judge reliability from
 * attempt counts alone.
 */
export interface ClassTally {
  readonly attempts: number;
  /** Questions where this class appeared at least once. */
  readonly questionsTouched: number;
  /** Questions that ended in terminal failure WITH this class present. */
  readonly questionsTerminal: number;
}

export interface FailureTaxonomy {
  readonly byClass: Readonly<Record<string, ClassTally>>;
  readonly totalAttempts: number;
  readonly totalQuestions: number;
}

export interface TaxonomyInput {
  readonly id: string;
  readonly attempts: readonly (AttemptSummary & { readonly failureClass?: string })[];
  readonly terminal: boolean;
}

export function buildFailureTaxonomy(questions: readonly TaxonomyInput[]): FailureTaxonomy {
  const byClass = new Map<string, { attempts: number; touched: Set<string>; terminal: Set<string> }>();
  let totalAttempts = 0;
  for (const question of questions) {
    for (const attempt of question.attempts) {
      if (attempt.ok) continue;
      totalAttempts += 1;
      const cls = classifyAttemptFailure(attempt.errorCode, attempt.error ?? "", attempt.failureClass);
      if (cls === "NONE") continue;
      const entry = byClass.get(cls) ?? { attempts: 0, touched: new Set<string>(), terminal: new Set<string>() };
      entry.attempts += 1;
      entry.touched.add(question.id);
      if (question.terminal) entry.terminal.add(question.id);
      byClass.set(cls, entry);
    }
  }
  const out: Record<string, ClassTally> = {};
  for (const [cls, entry] of byClass) {
    out[cls] = { attempts: entry.attempts, questionsTouched: entry.touched.size, questionsTerminal: entry.terminal.size };
  }
  return { byClass: out, totalAttempts, totalQuestions: questions.length };
}

/**
 * §32 — three security numbers, and only one of them is a defect.
 *
 * The Stage 27.x report printed "SECURITY_REJECTION: 1" beside a list of
 * zero-tolerance violations, where it read as though something had got
 * through. It had not: a model wrote `os.system(...)`, the AST validator
 * refused it, and the analysis was repaired. That is the system working
 * exactly as designed, and filing it next to `unsafeEscapes` invites the
 * conclusion that the safe outcome and the unsafe one are the same event.
 *
 *   unsafeCodeAttempts  generated code reached for a denied capability
 *   securityRejections  ... and was refused
 *   unsafeEscapes       ... and was NOT refused        ← the only defect
 *
 * A healthy run reads `n, n, 0` for any n.
 */
export interface SecurityCounters {
  readonly unsafeCodeAttempts: number;
  readonly securityRejections: number;
  readonly unsafeEscapes: number;
}

export function countSecurity(
  questions: readonly { readonly attempts: readonly AttemptSummary[]; readonly escaped: boolean }[],
): SecurityCounters {
  let attempts = 0;
  let rejections = 0;
  let escapes = 0;
  for (const question of questions) {
    for (const attempt of question.attempts) {
      if (attempt.ok) continue;
      if (classifyAttemptFailure(attempt.errorCode, attempt.error ?? "") !== "SECURITY_REJECTION") continue;
      attempts += 1;
      rejections += 1;
    }
    if (question.escaped) {
      attempts += 1;
      escapes += 1;
    }
  }
  return { unsafeCodeAttempts: attempts, securityRejections: rejections, unsafeEscapes: escapes };
}

/**
 * §43 — how a question behaved ACROSS runs, which is the only honest unit.
 *
 * Run-to-run variance on this benchmark is ±2 questions, which overlaps the
 * difference between code versions. A question that passes 5/5 and one that
 * passes 3/5 are different facts about the system, and a per-run "answered:
 * 19" reports neither.
 */
export interface QuestionConsistency {
  readonly id: string;
  readonly passes: number;
  readonly runs: number;
  readonly firstAttemptSuccesses: number;
  readonly averageRepairAttempts: number;
}

export function questionConsistency(
  runs: readonly (readonly { readonly id: string; readonly answered: boolean; readonly attempts: number; readonly firstAttempt: boolean }[])[],
): readonly QuestionConsistency[] {
  const byId = new Map<string, { passes: number; runs: number; first: number; attempts: number[] }>();
  for (const run of runs) {
    for (const turn of run) {
      const entry = byId.get(turn.id) ?? { passes: 0, runs: 0, first: 0, attempts: [] };
      entry.runs += 1;
      if (turn.answered) entry.passes += 1;
      if (turn.firstAttempt) entry.first += 1;
      if (turn.attempts > 0) entry.attempts.push(turn.attempts);
      byId.set(turn.id, entry);
    }
  }
  return [...byId.entries()]
    .map(([id, e]) => ({
      id,
      passes: e.passes,
      runs: e.runs,
      firstAttemptSuccesses: e.first,
      averageRepairAttempts: e.attempts.length === 0 ? 0 : e.attempts.reduce((a, b) => a + b, 0) / e.attempts.length,
    }))
    .sort((a, b) => a.passes - b.passes || a.id.localeCompare(b.id));
}

/**
 * §28 — the unsupported claims a run produced, grouped by the rule that
 * refused them.
 *
 * This is the line that was missing when six violations across five runs had
 * to be explained. A count says something was refused; a reason says whether
 * the narrator or the verifier was wrong, and those need opposite fixes.
 */
export function unsupportedByReason(reports: readonly HarnessTurnReport[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const report of reports) {
    for (const claim of report.trace.unsupportedClaims ?? []) {
      out[claim.reason] = (out[claim.reason] ?? 0) + 1;
    }
  }
  return out;
}

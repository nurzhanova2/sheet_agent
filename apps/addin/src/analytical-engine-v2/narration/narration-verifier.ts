import type { NumberLocale } from "../../analysis/format-number.js";
import type { VerifiedFinding } from "../insight/verified-finding.js";
import { evaluateAnswer, type AnswerEvaluation } from "./answer-evaluator.js";
import { resolveNumericClaims, type NarrationFactSet, type UnsupportedClaim } from "./narration-facts.js";
// Stage 28G §19 — ONE leak list. The V2 facade had a verbatim copy of the six
// patterns in `app/answer-leak.ts`, so the two answer domains could drift on
// what counts as a leak. The list lives in the lower module, which depends on
// nothing, and both domains read it.
export { containsForbiddenLeak } from "../../app/answer-leak.js";
import { containsForbiddenLeak } from "../../app/answer-leak.js";

export interface VerificationInput {
  readonly draft: string;
  readonly findings: readonly VerifiedFinding[];
  readonly locale: NumberLocale;
  readonly request?: string;
  readonly hasResults?: boolean;
  readonly facts?: NarrationFactSet;
  readonly structural?: ReadonlySet<number>;
  readonly narratorAttempt?: number;
  readonly requiredFindings?: readonly VerifiedFinding[];
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  /** §71 — which checks were applicable, for the trace. */
  readonly applied: readonly string[];
  readonly unsupported: readonly UnsupportedClaim[];
  readonly retryableNarration: boolean;
  readonly answerQuality?: AnswerEvaluation;
}

export type NarrationCheck = VerificationResult;

// ---------------------------------------------------------------------------
// A note on word boundaries, learned the expensive way in Stage 26.8.
//
// JavaScript's `\b` is defined over ASCII word characters ONLY, even under the
// `u` flag. `\bиз-за` therefore matches NOTHING: "и" is not an ASCII word
// character, so no boundary exists before it. Every Cyrillic pattern below
// uses an explicit `(?:^|[^\p{L}])` guard instead, which is what `\b` would
// have meant if it understood letters.
//
// This is not a style preference. A causal-language gate that silently never
// fires is worse than no gate, because it reports success.
// ---------------------------------------------------------------------------

/** Start-of-string or a non-letter — a real word boundary for any alphabet. */
const LB = "(?:^|[^\\p{L}])";

/**
 * Causal wording §94 forbids, beyond the pair the Stage 26 gate already
 * catches. Each is a claim the workbook has no dimension to support: a table
 * of levels over periods records what happened, never why.
 */
const CAUSAL_RU = new RegExp(
  `${LB}(?:из-за|потому\\s+что|вызван\\p{L}*|привел\\p{L}*\\s+к|привёл\\p{L}*\\s+к|обусловлен\\p{L}*|благодаря|доказ\\p{L}*|следствие)`,
  "iu",
);
const CAUSAL_EN = /\bbecause\s+of\b|\bcaused\s+by\b|\bdue\s+to\b|\bled\s+to\b|\bresulted\s+from\b|\bproves\b|\bproven\b|\bthanks\s+to\b/i;

/**
 * Wording that marks a statement as a HYPOTHESIS rather than a claim (§49/§94).
 * A sentence that already labels itself as a guess is allowed to speculate —
 * that is the behaviour §49 asks for, not the behaviour it forbids.
 */
const HEDGED_RU = new RegExp(
  `${LB}(?:гипотез\\p{L}*|мож\\p{L}*\\s+указывать|возможн\\p{L}*|предположительно|стоит\\s+проверить|определить\\s+нельзя|нельзя\\s+установить|не\\s+следует\\s+из\\s+данных|причину\\s+\\p{L}*\\s*нельзя)`,
  "iu",
);
const HEDGED_EN = /\bhypothes\w*|\bmay\s+indicate|\bmight\b|\bpossibl\w*|\bworth\s+checking|\bcannot\s+be\s+established|\bdoes\s+not\s+follow\s+from/i;

/** A percentage-point claim: a number followed by the unit word. */
const PP_CLAIM = /(-?[\d\s\u00a0\u202f,.]+)\s*(?:п\.?\s?п\.?|проц(?:ентн\w*)?\s+пункт\w*|percentage\s+points?|\bpp\b)/gi;

/** A plain percentage claim: a number followed by "%". */
const PCT_CLAIM = /(-?[\d\s\u00a0\u202f,.]+)\s*%/g;

/**
 * §56 — superlatives, split by WHICH END of a ranking they claim.
 *
 * The split is what makes the check mean anything. A ranking by relative
 * change puts the biggest mover first and the smallest last; an answer that
 * says "сильнее всего изменился X" about the row ranked last is wrong, and a
 * check that accepts "either end" cannot tell. "Самый" on its own stays
 * ambiguous on purpose — "самый ровный" names the top of a stability ranking
 * and the bottom of a volatility one, and the finding set does not say which
 * basis the model had in mind.
 */
const SUP_HIGH_RU = new RegExp(`${LB}(?:наибольш\\p{L}+|максимальн\\p{L}+|сильнее\\s+всего|больше\\s+всех|лидер\\p{L}*|крупнейш\\p{L}+)`, "iu");
const SUP_LOW_RU = new RegExp(`${LB}(?:наименьш\\p{L}+|минимальн\\p{L}+|меньше\\s+всех|слабее\\s+всего|слабее\\s+всех)`, "iu");
const SUP_ANY_RU = new RegExp(`${LB}(?:самы\\p{L}+)`, "iu");

const SUP_HIGH_EN = /\b(?:largest|highest|biggest|most|strongest|top)\b/i;
const SUP_LOW_EN = /\b(?:smallest|lowest|least|weakest)\b/i;

function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function approx(a: number, b: number): boolean {
  const tol = Math.max(0.01, Math.abs(b) * 0.01);
  return Math.abs(a - b) <= tol;
}

/**
 * §53 — every "N п.п." in the answer must correspond to a value whose unit IS
 * a percentage-point delta.
 *
 * Checking the unit rather than the digits is the whole point: for a share that
 * moved 27.82% → 28.63%, "+0.80" is a true percentage-point move and "+2.89"
 * is a true relative change, and the numbers alone cannot tell the verifier
 * which sentence was written. The unit word can.
 */
function checkPercentagePoints(text: string, findings: readonly VerifiedFinding[]): readonly string[] {
  const ppValues = findings.flatMap((f) =>
    f.values.filter((v) => v.unit.kind === "percent_point_delta").map((v) => (v.unit.kind === "percent_point_delta" && v.unit.scaled ? v.value : v.value * 100)),
  );
  const reasons: string[] = [];
  PP_CLAIM.lastIndex = 0;
  for (const match of text.matchAll(PP_CLAIM)) {
    const claimed = parseNumber(match[1] ?? "");
    if (claimed === null) continue;
    if (ppValues.length === 0) {
      reasons.push(
        `the answer states "${match[0].trim()}" in percentage points, but no observation holds a percentage-point value — a relative change is a percentage, not percentage points`,
      );
      break;
    }
    if (!ppValues.some((v) => approx(Math.abs(claimed), Math.abs(v)))) {
      reasons.push(`the percentage-point figure "${match[0].trim()}" matches no verified percentage-point value`);
      break;
    }
  }
  return reasons;
}

/**
 * §53, the mirror case — a percentage claim must not be a percentage-POINT
 * value wearing a "%" sign.
 *
 * Only fires when the finding set contains percentage-point values and the
 * claimed number matches one of them while matching no genuine percentage.
 * That narrowness matters: a legitimate relative change also renders as "%",
 * and rejecting those would make the gate fire on correct answers.
 */
function checkPercentNotPoints(text: string, findings: readonly VerifiedFinding[]): readonly string[] {
  const values = findings.flatMap((f) => f.values);
  const ppValues = values
    .filter((v) => v.unit.kind === "percent_point_delta")
    .map((v) => (v.unit.kind === "percent_point_delta" && v.unit.scaled ? v.value : v.value * 100));
  if (ppValues.length === 0) return [];
  const pctValues = values
    .filter((v) => v.unit.kind === "percent_fraction" || v.unit.kind === "percent_scaled")
    .map((v) => (v.unit.kind === "percent_fraction" ? v.value * 100 : v.value));

  PCT_CLAIM.lastIndex = 0;
  for (const match of text.matchAll(PCT_CLAIM)) {
    // Skip a match that is really the tail of a "п.п." phrase.
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 6);
    if (/^\s*(?:п\.?\s?п|pp)/i.test(after)) continue;
    const claimed = parseNumber(match[1] ?? "");
    if (claimed === null) continue;
    const isGenuinePercent = pctValues.some((v) => approx(Math.abs(claimed), Math.abs(v)));
    const isPointValue = ppValues.some((v) => approx(Math.abs(claimed), Math.abs(v)));
    if (!isGenuinePercent && isPointValue) {
      return [
        `the answer writes "${match[0].trim()}" where the verified value is a percentage-POINT change — say "п.п." / "pp", not "%"`,
      ];
    }
  }
  return [];
}

/**
 * §56 — a superlative must correspond to a verified rank.
 *
 * The Stage 26 gate already checks superlatives against ranking and extreme
 * FACTS. This adds the case findings introduce: an answer that calls a subject
 * the largest when the finding set ranks it third. Only checked when a rank
 * signal exists, because without one the engine has nothing to contradict.
 */
function checkSuperlatives(text: string, findings: readonly VerifiedFinding[], locale: NumberLocale): readonly string[] {
  const high = (locale === "ru" ? SUP_HIGH_RU : SUP_HIGH_EN).test(text);
  const low = (locale === "ru" ? SUP_LOW_RU : SUP_LOW_EN).test(text);
  const ambiguous = locale === "ru" ? SUP_ANY_RU.test(text) : false;
  if (!high && !low && !ambiguous) return [];

  const ranked = findings.filter((f) => f.materiality.some((s) => s.kind === "rank") && f.subject !== "");
  if (ranked.length === 0) return [];
  const lower = text.toLowerCase();
  const named = ranked.filter((f) => lower.includes(f.subject.toLowerCase()));
  if (named.length === 0) return [];

  /** Which positions the claim is entitled to, given which end it names. */
  const acceptable = (position: number, outOf: number): boolean => {
    if (high && !low) return position === 1;
    if (low && !high) return position === outOf;
    return position === 1 || position === outOf;
  };

  const supported = named.some((f) => f.materiality.some((s) => s.kind === "rank" && acceptable(s.position, s.outOf)));
  if (supported) return [];

  const where = named
    .flatMap((f) => f.materiality.filter((s) => s.kind === "rank").map((s) => (s.kind === "rank" ? `"${f.subject}" is ${s.position} of ${s.outOf}` : "")))
    .join(", ");
  const end = high && !low ? "first" : low && !high ? "last" : "either end";
  return [`the answer's superlative places a subject ${end} in the ranking, but the verified ranking says ${where}`];
}

/** §49/§94 — an unhedged causal claim. A labelled hypothesis is allowed. */
export function checkCausalLanguage(text: string, locale: NumberLocale): readonly string[] {
  const causal = locale === "ru" ? CAUSAL_RU : CAUSAL_EN;
  const hedged = locale === "ru" ? HEDGED_RU : HEDGED_EN;
  if (!causal.test(text)) return [];
  if (hedged.test(text)) return [];
  const match = causal.exec(text);
  return [`the answer asserts a cause ("${match?.[0] ?? ""}") that the table cannot establish; state it as a hypothesis or drop it`];
}

/**
 * §51 — a bare score with no explanation.
 *
 * Fires only when the answer quotes a score value and says nothing about what
 * it means. "волатильность = 5.200051" is the failure; "заметно нестабильнее
 * остальных — оценка 5,20" is the fix, and the comparative word is what the
 * check looks for.
 */
const SCORE_CONTEXT_RU = new RegExp(
  `${LB}(?:нестабильн\\p{L}*|стабильн\\p{L}*|ровн\\p{L}*|разброс\\p{L}*|колеб\\p{L}*|выше|ниже|больше|меньше|максимальн\\p{L}*|минимальн\\p{L}*|сильнее|слабее|по\\s+сравнению|остальн\\p{L}*|других|другие)`,
  "iu",
);
const SCORE_CONTEXT_EN = /\b(?:volatile|stable|steady|spread|swing|higher|lower|more|less|highest|lowest|compared|others?|rest)\b/i;

function checkScoreExplained(text: string, findings: readonly VerifiedFinding[], locale: NumberLocale): readonly string[] {
  const scores = findings.flatMap((f) => f.values.filter((v) => v.unit.kind === "score"));
  if (scores.length === 0) return [];
  const quoted = scores.some((v) => text.includes(v.text));
  if (!quoted) return [];
  const context = locale === "ru" ? SCORE_CONTEXT_RU : SCORE_CONTEXT_EN;
  return context.test(text) ? [] : ["the answer quotes a score without saying what it means relative to the other indicators"];
}

/**
 * §56 — the Stage 27 half of narration verification.
 *
 * Returns reasons, never a rewritten answer: a failing draft is replaced by
 * the deterministic prose (§57), it is never patched into passing.
 */
function checkRankingCoverage(text: string, requiredFindings: readonly VerifiedFinding[] | undefined): readonly string[] {
  if (!requiredFindings || requiredFindings.length < 2) return [];
  const missing = requiredFindings.filter((finding) => finding.subject !== "" && !finding.values.some((v) => text.includes(v.text)));
  if (missing.length === 0) return [];
  return [`the answer does not represent every requested item — missing: ${missing.map((f) => f.id).join(", ")}`];
}

function semanticVerification(
  draft: string,
  findings: readonly VerifiedFinding[],
  locale: NumberLocale,
  requiredFindings?: readonly VerifiedFinding[],
): { reasons: string[]; applied: string[] } {
  const applied: string[] = [];
  const reasons: string[] = [];

  applied.push("causal_language");
  reasons.push(...checkCausalLanguage(draft, locale));

  applied.push("percentage_points");
  reasons.push(...checkPercentagePoints(draft, findings));
  reasons.push(...checkPercentNotPoints(draft, findings));

  applied.push("superlative_rank");
  reasons.push(...checkSuperlatives(draft, findings, locale));

  applied.push("score_explained");
  reasons.push(...checkScoreExplained(draft, findings, locale));

  applied.push("ranking_coverage");
  reasons.push(...checkRankingCoverage(draft, requiredFindings));

  return { reasons, applied };
}

export function verifyNarration(input: VerificationInput): VerificationResult;
export function verifyNarration(draft: string, findings: readonly VerifiedFinding[], locale: NumberLocale): NarrationCheck;
export function verifyNarration(
  inputOrDraft: VerificationInput | string,
  legacyFindings?: readonly VerifiedFinding[],
  legacyLocale?: NumberLocale,
): VerificationResult {
  const input: VerificationInput = typeof inputOrDraft === "string"
    ? { draft: inputOrDraft, findings: legacyFindings ?? [], locale: legacyLocale ?? "en" }
    : inputOrDraft;
  const semantic = semanticVerification(input.draft, input.findings, input.locale, input.requiredFindings);
  const applied = [...semantic.applied];
  const reasons = [...semantic.reasons];
  let unsupported: readonly UnsupportedClaim[] = [];
  let answerQuality: AnswerEvaluation | undefined;
  let numericReasons: string[] = [];

  if (input.facts) {
    applied.push("numeric_claims");
    const resolution = resolveNumericClaims({
      text: input.draft,
      facts: input.facts,
      structural: input.structural ?? new Set<number>(),
      narratorAttempt: input.narratorAttempt ?? 1,
    });
    unsupported = resolution.unsupported;
    numericReasons = resolution.unsupported.map((u) =>
      `unsupported numeric claim ${u.numericToken} (${u.reason}); it matches no verified fact — nearest: ${u.nearestFacts.join(", ") || "none"}`,
    );
    reasons.push(...numericReasons);
  }

  if (input.request !== undefined) {
    applied.push("answer_quality");
    answerQuality = evaluateAnswer({
      answer: input.draft,
      findings: input.findings,
      request: input.request,
      locale: input.locale,
      hasResults: input.hasResults ?? input.findings.length > 0,
    });
    reasons.push(...answerQuality.details.map((d) => `${d.issue}${d.evidence ? `: ${d.evidence}` : ""}`));
  }

  applied.push("internal_leaks");
  if (containsForbiddenLeak(input.draft)) reasons.push("internal identifier or execution detail leaked into narration");

  const nonNumeric = reasons.filter((reason) => !reason.startsWith("unsupported numeric claim "));
  return {
    ok: reasons.length === 0,
    reasons,
    applied,
    unsupported,
    retryableNarration: numericReasons.length > 0 && nonNumeric.length === 0,
    ...(answerQuality ? { answerQuality } : {}),
  };
}

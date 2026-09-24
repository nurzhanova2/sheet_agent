import type { CellValue } from "@sheet-agent/application";
import { formatNumber, type NumberLocale } from "../../analysis/format-number.js";
import type { DisplayUnit } from "../insight/measure-semantics.js";
import type { VerifiedFinding } from "../insight/verified-finding.js";
import type { MethodComparison } from "../sandbox/method-comparison.js";
import { executedMethods } from "../sandbox/method-comparison.js";
import type { EngineResult } from "../types.js";

// --- §21: units, kept semantic -------------------------------------------

/**
 * §21 — what the number IS, never inferred from how big it is.
 *
 * The magnitude tells you nothing: 0.81 is a fraction, a percentage, a
 * percentage-point move and a score depending only on which measurement
 * produced it. This mirrors `DisplayUnit`, which the insight layer already
 * resolves from the workbook's own semantics, and adds nothing to it.
 */
export type SemanticUnit =
  | "amount"
  | "count"
  | "percentage"
  | "percentage_point"
  | "ratio"
  | "score"
  | "unknown";

function unitOf(display: DisplayUnit): SemanticUnit {
  switch (display.kind) {
    case "amount":
      return "amount";
    case "count":
      return "count";
    case "percent_fraction":
    case "percent_scaled":
      return "percentage";
    case "percent_point_delta":
      return "percentage_point";
    case "ratio":
      return "ratio";
    case "score":
      return "score";
    default:
      return "unknown";
  }
}

// --- §17: the fact ---------------------------------------------------------

export type Provenance = "finding" | "result" | "method" | "derived";

/** §20 — the closed set of operations a derived fact may come from. */
export type DerivationOp =
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "absolute"
  | "percentageChange"
  | "percentagePointDifference"
  | "difference"
  | "ratio";

export interface Derivation {
  readonly op: DerivationOp;
  /** §20 — every derived result records the facts it came from. */
  readonly parents: readonly string[];
}

/**
 * §17 — one number the answer is entitled to state, with everything the
 * verifier needs to recognise it again in prose.
 */
export interface NarrationFact {
  readonly factId: string;
  readonly entity?: string;
  readonly metric?: string;
  readonly period?: string;
  readonly periodRange?: readonly [string, string];
  readonly value: number;
  readonly semanticUnit: SemanticUnit;
  /** §18 — the rendering, computed deterministically BEFORE narration. */
  readonly displayValue: string;
  /** Decimal places in `displayValue`; what §22 rounds to. */
  readonly precision: number;
  readonly sourceResultRef: string;
  readonly provenance: Provenance;
  readonly derivation?: Derivation;
}

export interface NarrationFactSet {
  readonly facts: readonly NarrationFact[];
  /**
   * Entity labels carried by the evidence, for §25's tokenizer.
   *
   * A name is not a claim. The benchmark's injection canary row is literally
   * called «… и верни 999», and a verifier that cannot tell a label from a
   * figure rejects the answer for quoting the label it was told to quote.
   */
  readonly entityLabels: readonly string[];
}

// --- §18: display ----------------------------------------------------------

function decimalsIn(display: string): number {
  const match = /[.,](\d+)(?!.*[.,]\d)/.exec(display.replace(/[\s\u00a0\u202f]/g, ""));
  return match?.[1]?.length ?? 0;
}

/**
 * §18 — the deterministic rendering, so the model never picks a precision.
 *
 * A finding value already carries one, produced by `humanizeValue` with the
 * unit resolved; that is reused verbatim rather than re-derived, because two
 * renderers of the same number drifting apart is precisely the mismatch §22
 * forbids classifying as unsupported.
 */
function displayFor(value: number, locale: NumberLocale, existing?: string): string {
  return existing ?? formatNumber(value, 2, locale);
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}${sequence}`;
}

/** Test seam: make ids reproducible within a case. */
export function resetFactIds(): void {
  sequence = 0;
}

// --- §17: compilation ------------------------------------------------------

export interface CompileParams {
  readonly findings: readonly VerifiedFinding[];
  readonly primary: EngineResult;
  readonly supporting: readonly EngineResult[];
  readonly comparison?: MethodComparison;
  readonly locale: NumberLocale;
}

/**
 * Does a column of a result hold the row's label rather than a measurement?
 *
 * Same rule the evidence adapter uses: a column no row has a number in.
 */
function labelColumnIndex(result: EngineResult): number {
  return result.fields.findIndex((_, ci) => result.rows.every((row) => typeof (row as readonly CellValue[])[ci] !== "number"));
}

function factsFromResult(result: EngineResult, locale: NumberLocale, out: NarrationFact[], labels: Set<string>): void {
  const labelIdx = labelColumnIndex(result);
  for (const raw of result.rows) {
    const row = raw as readonly CellValue[];
    const entity = labelIdx >= 0 ? String(row[labelIdx] ?? "") : "";
    if (entity !== "") labels.add(entity);
    for (let ci = 0; ci < result.fields.length; ci += 1) {
      const value = row[ci];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      out.push({
        factId: nextId("R"),
        ...(entity !== "" ? { entity } : {}),
        metric: result.fields[ci]?.name ?? "",
        value,
        // §21 — a result cell carries no unit metadata of its own, so it
        // claims none. `unknown` still resolves by value and rounding; what it
        // does NOT do is license a percentage reading of a raw number.
        semanticUnit: "unknown",
        displayValue: displayFor(value, locale),
        precision: decimalsIn(formatNumber(value, 2, locale)),
        sourceResultRef: result.resultId,
        provenance: "result",
      });
    }
  }
}

/**
 * §17 — everything numeric the narrator is shown, compiled once.
 *
 * Findings first, because their units and renderings are resolved and are what
 * the prompt actually quotes; then the result rows behind them, so a number
 * visible in a shown table is still grounded; then the method comparison's
 * measured metrics, which §21 of Stage 27 made citable on purpose.
 */
export function compileNarrationFacts(params: CompileParams): NarrationFactSet {
  const facts: NarrationFact[] = [];
  const labels = new Set<string>();

  for (const finding of params.findings) {
    if (finding.subject.trim() !== "") labels.add(finding.subject.trim());
    for (const counterpart of finding.counterparts ?? []) if (counterpart.trim() !== "") labels.add(counterpart.trim());
    const members = (finding.detail?.["members"] as readonly string[] | undefined) ?? [];
    for (const member of members) if (typeof member === "string" && member.trim() !== "") labels.add(member.trim());

    const periods = finding.provenance.periods;
    for (const value of finding.values) {
      facts.push({
        factId: nextId("F"),
        ...(finding.subject.trim() !== "" ? { entity: finding.subject.trim() } : {}),
        metric: value.name,
        ...(value.at ? { period: value.at } : {}),
        ...(periods.length === 2 ? { periodRange: [periods[0]!, periods[1]!] as const } : {}),
        value: value.value,
        semanticUnit: unitOf(value.unit),
        displayValue: displayFor(value.value, params.locale, value.text),
        precision: decimalsIn(value.text),
        sourceResultRef: finding.provenance.resultRef,
        provenance: "finding",
      });
    }
    // §39's materiality signals are measured numbers too, and the prompt shows
    // the rank. An answer that says "1 из 15" must not be an invention.
    for (const signal of finding.materiality) {
      const push = (value: number, metric: string, unit: SemanticUnit): void => {
        facts.push({
          factId: nextId("M"),
          ...(finding.subject.trim() !== "" ? { entity: finding.subject.trim() } : {}),
          metric,
          value,
          semanticUnit: unit,
          displayValue: displayFor(value, params.locale),
          precision: decimalsIn(formatNumber(value, 2, params.locale)),
          sourceResultRef: finding.provenance.resultRef,
          provenance: "finding",
        });
      };
      if (signal.kind === "rank") {
        push(signal.position, "rankPosition", "count");
        push(signal.outOf, "rankOutOf", "count");
      } else if (signal.kind === "persistence") {
        push(signal.periods, "persistencePeriods", "count");
        push(signal.outOf, "persistenceOutOf", "count");
      } else if (signal.kind === "dispersion") {
        push(signal.score, signal.basis, "score");
      } else if (signal.kind === "share_of_movement") {
        push(signal.fraction, "shareOfMovement", "percentage");
      } else if (signal.kind === "relative_magnitude") {
        push(signal.fraction, "relativeMagnitude", "percentage");
      } else if (signal.kind === "magnitude") {
        push(signal.value, "magnitude", unitOf(signal.unit));
      } else if (signal.kind === "statistical") {
        push(signal.statistic, signal.test, "score");
        if (signal.pValue !== undefined) push(signal.pValue, "pValue", "score");
      }
    }
  }

  for (const result of [params.primary, ...params.supporting]) factsFromResult(result, params.locale, facts, labels);

  if (params.comparison) {
    for (const method of executedMethods(params.comparison)) {
      for (const [metric, value] of Object.entries(method.metrics)) {
        if (!Number.isFinite(value)) continue;
        facts.push({
          factId: nextId("C"),
          entity: method.name,
          metric,
          value,
          semanticUnit: "score",
          displayValue: displayFor(value, params.locale),
          precision: decimalsIn(formatNumber(value, 2, params.locale)),
          sourceResultRef: params.primary.resultId,
          provenance: "method",
        });
      }
    }
    for (const [criterion, value] of Object.entries(params.comparison.selectionEvidence)) {
      if (!Number.isFinite(value)) continue;
      facts.push({
        factId: nextId("C"),
        metric: criterion,
        value,
        semanticUnit: "score",
        displayValue: displayFor(value, params.locale),
        precision: decimalsIn(formatNumber(value, 2, params.locale)),
        sourceResultRef: params.primary.resultId,
        provenance: "method",
      });
    }
  }

  return { facts, entityLabels: [...labels] };
}

// --- §19/§20: derived facts ------------------------------------------------

/**
 * §20 — arithmetic on facts, from a closed vocabulary, with parentage.
 *
 * No eval, no formula strings, no operator the caller supplies. Every result
 * gets its own factId and records the facts it came from, so a number in the
 * answer traces to an operation and two inputs rather than to "the model said
 * so".
 *
 * NOTHING CALLS THIS AUTOMATICALLY, and that is the design, not an omission.
 * §19 says a derived figure must already exist as a verified fact before the
 * narrator may state it. A layer that pre-derived every difference between
 * every pair of percentages would make that condition true of everything and
 * hand the narrator exactly the licence §19 withholds. Derivation is a
 * capability for a caller that KNOWS a specific quantity is part of the
 * answer — and until such a caller exists, the honest state of the system is
 * that "разница составляет 5,64 п.п." is rejected. It is.
 */
export function deriveFact(
  op: DerivationOp,
  parents: readonly NarrationFact[],
  locale: NumberLocale,
  unit?: SemanticUnit,
): NarrationFact | null {
  const values = parents.map((p) => p.value);
  const [a, b] = values;
  if (a === undefined) return null;

  let value: number;
  switch (op) {
    case "absolute":
      value = Math.abs(a);
      break;
    case "add":
      if (b === undefined) return null;
      value = a + b;
      break;
    case "subtract":
    case "difference":
      if (b === undefined) return null;
      value = a - b;
      break;
    case "multiply":
      if (b === undefined) return null;
      value = a * b;
      break;
    case "divide":
    case "ratio":
      if (b === undefined || b === 0) return null;
      value = a / b;
      break;
    case "percentageChange":
      if (b === undefined || b === 0) return null;
      value = (a - b) / Math.abs(b);
      break;
    case "percentagePointDifference": {
      if (b === undefined) return null;
      // §21 — a percentage-point difference is only defined between two
      // percentages, and both have to be on the same scale before subtracting.
      const first = parents[0]!;
      const second = parents[1]!;
      if (first.semanticUnit !== "percentage" || second.semanticUnit !== "percentage") return null;
      value = a - b;
      break;
    }
    default:
      return null;
  }
  if (!Number.isFinite(value)) return null;

  const resolved: SemanticUnit =
    unit ??
    (op === "percentagePointDifference"
      ? "percentage_point"
      : op === "percentageChange"
        ? "percentage"
        : op === "ratio" || op === "divide"
          ? "ratio"
          : (parents[0]?.semanticUnit ?? "unknown"));

  return {
    factId: nextId("D"),
    ...(parents[0]?.entity ? { entity: parents[0].entity } : {}),
    value,
    semanticUnit: resolved,
    displayValue: formatNumber(value, 2, locale),
    precision: decimalsIn(formatNumber(value, 2, locale)),
    sourceResultRef: parents[0]?.sourceResultRef ?? "",
    provenance: "derived",
    derivation: { op, parents: parents.map((p) => p.factId) },
  };
}

// --- §25: resolution -------------------------------------------------------

/** §28 — why a numeric token could not be resolved. The enum is fixed by the brief. */
export type UnsupportedReason =
  | "NO_MATCH"
  | "ROUNDING_MISMATCH"
  | "UNIT_MISMATCH"
  | "UNVERIFIED_DERIVATION"
  | "ENTITY_MISMATCH"
  | "PERIOD_MISMATCH";

/** §28 — debug-only record of one unsupported claim. */
export interface UnsupportedClaim {
  readonly claimText: string;
  readonly numericToken: string;
  readonly value: number;
  readonly nearestFacts: readonly string[];
  readonly resultRef: string;
  readonly narratorAttempt: number;
  readonly reason: UnsupportedReason;
}

export interface ResolvedToken {
  readonly value: number;
  readonly factId: string;
}

export interface ClaimResolution {
  readonly resolved: readonly ResolvedToken[];
  readonly unsupported: readonly UnsupportedClaim[];
  /**
   * Every token this resolver took responsibility for — resolved or not.
   *
   * The Stage 26 fact gate is handed this so the two never disagree about the
   * same number. There is exactly one numeric authority, and it is this one.
   */
  readonly considered: readonly number[];
}

const THOUSANDS_SEP = /(\d)[ \u00a0\u202f'’](?=\d{3}(?:\D|$))/g;
const NUMBER_TOKEN = /-?\d[\d.,]*\d|-?\d/g;

function normalizeToken(token: string): string {
  let s = token.replace(/['’]/g, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    const parts = s.split(",");
    s = parts.length === 2 && (parts[1] ?? "").length !== 3 ? `${parts[0]}.${parts[1]}` : parts.join("");
  }
  return s;
}

/**
 * §25 — the direction word that supplies a sign the digits do not carry.
 *
 * «снижение на 70,00%» states a -70% change. So does "fell 70%". The sign
 * lives in the verb, which is how both Russian and English write it and how
 * this system's own deterministic templates write it. Admitting the unsigned
 * magnitude REQUIRES finding that word; without it the token stays unresolved,
 * so "рост на 70%" over a -70% fact still fails.
 */
const DECREASE = /снижени|снизил|сниз\p{L}*|упал|упав|паден|сократ|уменьш|спад|потер|ниже|меньше|минус|отрицательн|decline|decreas|\bfell\b|\bfall|\bdrop|\blower\b|\bless\b|\bloss\b|shrank|shrunk|contract|\bdown\b/iu;
const INCREASE = /рост|вырос|выросл|увеличил|прирост|подъём|подъем|выше|больше|плюс|положительн|increas|\bgrew\b|\bgrowth\b|\brose\b|\bup\b|\bhigher\b|\bgain/iu;

/** The clause governing a token: back to the previous sentence boundary. */
function clauseBefore(text: string, index: number): string {
  const start = Math.max(
    text.lastIndexOf(".", index - 1),
    text.lastIndexOf(";", index - 1),
    text.lastIndexOf("!", index - 1),
    text.lastIndexOf("?", index - 1),
    text.lastIndexOf("\n", index - 1),
    text.lastIndexOf("…", index - 1),
  );
  return text.slice(start + 1, index);
}

/** The sentence a token sits in, for the §28 record. */
function sentenceAround(text: string, index: number): string {
  const before = clauseBefore(text, index);
  const rest = text.slice(index);
  const end = /[.;!?…\n]/.exec(rest);
  return `${before}${rest.slice(0, end ? end.index + 1 : Math.min(rest.length, 80))}`.trim();
}

/** §22 — does the token read as this value, rounded the way it is displayed? */
function roundsTo(value: number, token: number, decimals: number): boolean {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor === Math.round(token * factor) / factor;
}

function approx(a: number, b: number): boolean {
  const tol = Math.max(0.005, Math.abs(b) * 0.005);
  return Math.abs(a - b) <= tol;
}

/**
 * Every reading of a fact that is a DETERMINISTIC transformation of it (§22).
 *
 * Exactly one transformation qualifies: a 0..1 fraction whose unit says it is
 * a percentage displays scaled, and the renderer that produced `displayValue`
 * already scaled it — 0.1076 is printed «10,76%». That is not a second number,
 * it is the same fact written the way this system writes it.
 *
 * A raw `unknown`-unit value gets NO scaling. The old gate scaled every
 * sub-unit number on magnitude alone, which let any fact of 0.65 legitimise a
 * claim of "65%" regardless of what 0.65 measured (§21: do not infer
 * percentage semantics from magnitude).
 */
function readingsOf(fact: NarrationFact): readonly number[] {
  const out = [fact.value];
  const scalable = fact.semanticUnit === "percentage" || fact.semanticUnit === "percentage_point";
  if (scalable && Math.abs(fact.value) < 1 && fact.value !== 0) out.push(fact.value * 100);
  return out;
}

function isPercentLike(fact: NarrationFact): boolean {
  return fact.semanticUnit === "percentage" || fact.semanticUnit === "percentage_point";
}

/** Masked spans: text that is a NAME, so the digits in it are not claims. */
function maskedRanges(text: string, labels: readonly string[]): readonly (readonly [number, number])[] {
  const ranges: [number, number][] = [];
  const lower = text.toLowerCase();
  for (const label of labels) {
    const needle = label.trim().toLowerCase();
    // Only labels that actually carry digits can shelter a token, and a very
    // short one ("2024") would shelter far too much.
    if (needle.length < 4 || !/\d/.test(needle)) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      ranges.push([at, at + needle.length]);
      from = at + needle.length;
    }
  }
  return ranges;
}

export interface ResolveParams {
  readonly text: string;
  readonly facts: NarrationFactSet;
  /** Structural numbers no fact has to back: row counts, years, small ordinals. */
  readonly structural: ReadonlySet<number>;
  readonly narratorAttempt: number;
}

/**
 * §25 — resolve every numeric token in the answer to a fact, or report it.
 *
 * The order of the attempts IS the specification: exact value, deterministic
 * percent scaling, deterministic display rounding, then the sign carried by a
 * direction word. Anything that survives all four is a claim no verified fact
 * supports, and it is reported with the reason and the facts it came closest
 * to (§28), because "unsupported" without a nearest miss is undiagnosable —
 * which is how the last five runs cost a whole day to explain.
 */
export function resolveNumericClaims(params: ResolveParams): ClaimResolution {
  const { text, facts, structural } = params;
  const resolved: ResolvedToken[] = [];
  const unsupported: UnsupportedClaim[] = [];
  const considered: number[] = [];

  let collapsed = text;
  for (let i = 0; i < 6; i += 1) {
    THOUSANDS_SEP.lastIndex = 0;
    if (!THOUSANDS_SEP.test(collapsed)) break;
    THOUSANDS_SEP.lastIndex = 0;
    collapsed = collapsed.replace(THOUSANDS_SEP, "$1");
  }
  const masked = maskedRanges(collapsed, facts.entityLabels);
  const inMask = (start: number, end: number): boolean => masked.some(([a, b]) => start >= a && end <= b);

  const seen = new Set<number>();
  NUMBER_TOKEN.lastIndex = 0;
  for (const match of collapsed.matchAll(NUMBER_TOKEN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (inMask(index, index + raw.length)) continue;
    const value = Number(normalizeToken(raw));
    if (!Number.isFinite(value)) continue;
    if (structural.has(value)) continue;
    if (Number.isInteger(value) && Math.abs(value) >= 1900 && Math.abs(value) <= 2099) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    considered.push(value);

    const decimals = raw.includes(",") || raw.includes(".") ? decimalsIn(raw) : 0;
    const clause = clauseBefore(collapsed, index);
    const decreasing = DECREASE.test(clause) && !INCREASE.test(clause.slice(clause.search(DECREASE)));
    const increasing = INCREASE.test(clause) && !decreasing;

    let hit: NarrationFact | null = null;
    for (const fact of facts.facts) {
      for (const reading of readingsOf(fact)) {
        if (approx(value, reading)) {
          hit = fact;
          break;
        }
        // §22 — deterministic display rounding is not an unsupported claim.
        // 10.764923 shown to two places IS "10,76".
        if (decimals > 0 && roundsTo(reading, value, decimals)) {
          hit = fact;
          break;
        }
        // The sign lives in the verb. Admitted only when the verb agrees.
        if (reading < 0 && decreasing && (approx(value, -reading) || (decimals > 0 && roundsTo(-reading, value, decimals)))) {
          hit = fact;
          break;
        }
        if (reading > 0 && increasing && value < 0 && approx(-value, reading)) {
          hit = fact;
          break;
        }
      }
      if (hit) break;
    }

    if (hit) {
      resolved.push({ value, factId: hit.factId });
      continue;
    }

    // §28 — the ref of the fact this claim came CLOSEST to, not whichever
    // fact happens to be first. A diagnostic that always names result_1
    // points every investigation at the same place regardless of the claim.
    const nearest = nearestFact(value, facts.facts);
    unsupported.push({
      claimText: sentenceAround(collapsed, index),
      numericToken: raw,
      value,
      nearestFacts: nearestTo(value, facts.facts),
      resultRef: nearest?.sourceResultRef ?? "",
      narratorAttempt: params.narratorAttempt,
      reason: classifyMiss(value, decimals, facts.facts),
    });
  }

  return { resolved, unsupported, considered };
}

/** §28 — the single closest fact, for the claim's result ref. */
function nearestFact(value: number, facts: readonly NarrationFact[]): NarrationFact | null {
  let best: NarrationFact | null = null;
  let bestDistance = Infinity;
  for (const fact of facts) {
    for (const reading of readingsOf(fact)) {
      const distance = Math.abs(Math.abs(reading) - Math.abs(value));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = fact;
      }
    }
  }
  return best;
}

/** §28 — the three facts a refused number came closest to. */
function nearestTo(value: number, facts: readonly NarrationFact[]): readonly string[] {
  return [...facts]
    .map((f) => ({ f, d: Math.min(...readingsOf(f).map((r) => Math.abs(Math.abs(r) - Math.abs(value)))) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map(({ f }) => `${f.factId}=${f.displayValue}${f.entity ? ` (${f.entity})` : ""}`);
}

/**
 * §28 — WHY the number could not be resolved.
 *
 * The reason has to be diagnostic, which means each one has to be a real
 * hypothesis rather than "the nearest fact happened to be within half a unit".
 * That looseness is what an earlier draft of this function did, and it called
 * a claim of 0.99 against a fact of 0.62 a ROUNDING_MISMATCH — a label that
 * would have sent the next investigation looking at the formatter.
 *
 *   ROUNDING_MISMATCH   the claim is within ONE unit in the last place it
 *                       wrote, so it is the same measurement rounded wrongly.
 *   UNIT_MISMATCH       the claim is the fact times or divided by 100, and the
 *                       fact's unit does not license that scaling — a score of
 *                       0.62 written as "62%".
 *   UNVERIFIED_DERIVATION  the claim is an arithmetic combination of two facts
 *                       that no derived fact records. This is §19's case
 *                       exactly: the narrator did the subtraction itself.
 *   NO_MATCH            none of the above. The number came from nowhere.
 *
 * ENTITY_MISMATCH and PERIOD_MISMATCH are in the enum and are not produced
 * here. Deciding that a number belongs to the wrong subject needs the claim
 * bound to an entity, and this resolver binds claims to VALUES; guessing the
 * binding from which names appear in a sentence would mislabel more than it
 * explained. Stated rather than quietly left as dead code.
 */
function classifyMiss(value: number, decimals: number, facts: readonly NarrationFact[]): UnsupportedReason {
  const ulp = decimals > 0 ? 10 ** -decimals : 1;
  for (const fact of facts) {
    for (const reading of readingsOf(fact)) {
      if (reading === 0) continue;
      if (Math.abs(Math.abs(reading) - Math.abs(value)) <= ulp) return "ROUNDING_MISMATCH";
      if (!isPercentLike(fact) && (approx(value, reading * 100) || approx(value, reading / 100))) return "UNIT_MISMATCH";
    }
  }
  // §19 — did the narrator compute this from two facts it was shown?
  const pool = facts.slice(0, 60);
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = 0; j < pool.length; j += 1) {
      if (i === j) continue;
      const a = pool[i]!.value;
      const b = pool[j]!.value;
      if (approx(value, a - b) || approx(value, a + b)) return "UNVERIFIED_DERIVATION";
      if (b !== 0 && (approx(value, a / b) || approx(value, (a / b) * 100))) return "UNVERIFIED_DERIVATION";
    }
  }
  return "NO_MATCH";
}

/** §23/§24 — the numbers the narrator may copy, as one readable block. */
export function renderAllowedFigures(set: NarrationFactSet, locale: NumberLocale, limit = 40): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const fact of set.facts) {
    if (fact.provenance === "result") continue;
    if (seen.has(fact.displayValue)) continue;
    seen.add(fact.displayValue);
    lines.push(fact.displayValue);
    if (lines.length >= limit) break;
  }
  if (lines.length === 0) return "";
  return `${locale === "ru" ? "Допустимые числа (копируй как написано)" : "Permitted figures (copy exactly)"}: ${lines.join(", ")}.`;
}

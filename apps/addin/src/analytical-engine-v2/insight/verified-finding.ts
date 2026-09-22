// ---------------------------------------------------------------------------
// Stage 27 §40/§41 — the Insight layer: what was OBSERVED, as a value.
//
// §41 states the gap precisely. The engine can already produce
//
//     Активы | 17941.741778 | 19871.544896 | 1929.803119 | 10.76%
//
// which is correct and unreadable, and the thing a person wants is
//
//     "Активы с начала года выросли на 10,8% — с 17 941,7 до 19 871,5.
//      Темп роста ниже прошлогоднего: тогда прирост был 16,4%."
//
// The distance between those two is not a prompt-engineering problem. A result
// table says WHAT WAS COMPUTED; a sentence says WHAT WAS OBSERVED, how much it
// matters, and what it cannot support. Asking a model to make that leap from
// raw rows is asking it to decide materiality and to invent the words for
// units it was never told — which is where fabricated percentages and invented
// causes come from.
//
// A VerifiedFinding carries the leap in data:
//
//   - every number it quotes is already extracted, unit-resolved and
//     formatted (§52/§53), so the narrator SELECTS text rather than computing;
//   - materiality is recorded as SIGNALS relative to the data at hand (§39),
//     never as a fabricated domain threshold;
//   - the things the evidence cannot support are attached as caveats, so the
//     narrator has to write around them rather than discover them;
//   - provenance points back at the result that proved it (§32).
//
// The narrator may then reason from findings (§48) and the verifier can check
// each sentence against them (§56).
// ---------------------------------------------------------------------------

import type { NumberLocale } from "../../analysis/format-number.js";
import type { ResultId } from "../types.js";
import { humanizeValue, type HumanizeOptions } from "./humanize.js";
import type { DisplayUnit } from "./measure-semantics.js";

/**
 * §40 — the KIND of observation, not the tool that produced it.
 *
 * Deliberately a closed set: the narrator's guidance and the fallback
 * templates (§58) are written per finding type, and a type nothing can render
 * is a type that reaches the user as a raw table.
 */
export type FindingType =
  /** A level at a point in time. */
  | "value"
  /** A move between two points: start, end, absolute, relative. */
  | "change"
  /** Two subjects or two periods set against each other. */
  | "comparison"
  /** An ordered set with a basis. */
  | "ranking"
  /** The top or bottom of a set. */
  | "extremum"
  /** A direction sustained over a series. */
  | "trend"
  /** Dispersion of a series. */
  | "volatility"
  /** The inverse reading of dispersion. */
  | "stability"
  /** A run in one direction, with its length. */
  | "monotonicity"
  /** A reversal, with the period it happened at. */
  | "direction_change"
  /** A single dated occurrence — the largest move, a crossing. */
  | "event"
  /** A statistical association between two series (Stage 27 sandbox). */
  | "relationship"
  /** A group of entities with a shared profile (Stage 27 sandbox). */
  | "cluster"
  /** An entity that sits apart from its group (Stage 27 sandbox). */
  | "anomaly"
  /** The shape of a set of values (Stage 27 sandbox). */
  | "distribution"
  /** Something about the DATA rather than the subject: gaps, duplicates. */
  | "data_quality"
  /**
   * §77 — what the table IS: its subject axis, its time span, its size. Asked
   * for directly ("расскажи про эти данные коротко") and, more often, needed
   * as the first sentence of an exploratory answer.
   */
  | "table_overview"
  /** A filter that matched nothing — a real answer, not an error (§16 of 26.3). */
  | "empty_set";

/** Which way a change or trend points. `flat` is an observation, not a missing value. */
export type FindingDirection = "up" | "down" | "flat" | "mixed" | "none";

/**
 * One number the finding is entitled to state, already unit-resolved.
 *
 * `text` is what a sentence should contain; `value` is what the verifier
 * checks against. Keeping both means the narrator never re-formats and the
 * check never compares strings.
 */
export interface FindingValue {
  /** Stable role name — `startValue`, `absoluteChange`, `percentageChange`, … */
  readonly name: string;
  readonly value: number;
  readonly unit: DisplayUnit;
  readonly text: string;
  /** Period or entity this number belongs to, when it has one. */
  readonly at?: string;
}

/**
 * §39 — why a finding might matter, as EVIDENCE rather than a verdict.
 *
 * Every signal is measured against the data in front of it: a rank within this
 * result, a share of this result's total movement, a run length out of this
 * many periods. None of them encodes "5% is a big move", because this stage
 * has no basis for such a claim in any domain (§39: do not fabricate domain
 * thresholds) and inventing one would quietly become a product rule.
 */
export type MaterialitySignal =
  /** How large the move is in its own units. */
  | { readonly kind: "magnitude"; readonly value: number; readonly unit: DisplayUnit }
  /** The move as a fraction of its own starting level. */
  | { readonly kind: "relative_magnitude"; readonly fraction: number }
  /** Where it sits among the peers computed in the SAME result. */
  | { readonly kind: "rank"; readonly position: number; readonly outOf: number; readonly basis: string }
  /** How many consecutive periods it held. */
  | { readonly kind: "persistence"; readonly periods: number; readonly outOf: number }
  /** How far it sits from the rest of the set, in the set's own spread. */
  | { readonly kind: "dispersion"; readonly score: number; readonly basis: string }
  /** How much of the parent's total movement this one subject accounts for. */
  | { readonly kind: "share_of_movement"; readonly fraction: number; readonly of: string }
  /** Statistical support, when a test actually ran (sandbox only). */
  | { readonly kind: "statistical"; readonly test: string; readonly statistic: number; readonly pValue?: number };

/** §40 — what would make the finding LESS trustworthy, recorded alongside it. */
export type ConfidenceSignal =
  | { readonly kind: "observations"; readonly count: number }
  | { readonly kind: "schema_confidence"; readonly value: number }
  /** The relative change is huge only because the base is tiny (§39). */
  | { readonly kind: "low_base"; readonly startValue: number; readonly medianLevel: number }
  | { readonly kind: "missing_values"; readonly count: number; readonly of: number };

/**
 * A limitation the narrator MUST respect. Codes, not prose: the wording is
 * produced once, in the reader's language, by `caveatText`.
 */
export type CaveatCode =
  /** Relative change is undefined because the starting level is ~0. */
  | "relative_undefined_zero_base"
  /** The percentage is large because the base is small, not because the move is. */
  | "low_base_percentage"
  /** Too few observations to speak about a trend. */
  | "few_observations"
  /** Values are missing inside the window; they were excluded, not zeroed (§23). */
  | "missing_excluded"
  /** A zero here is a recorded value, not evidence of absence (§25). */
  | "zero_not_absence"
  /** The subject is a total row, so it overlaps its components. */
  | "total_row_overlap"
  /** The table holds period snapshots, not a continuous series. */
  | "sparse_periods"
  /** Units differ across the compared subjects; magnitudes are not comparable. */
  | "mixed_units"
  /** Ordering came from a basis the user did not name. */
  | "basis_assumed"
  /** The workbook changed after the analysis was computed (§69). */
  | "stale_source";

export interface Caveat {
  readonly code: CaveatCode;
  /** Numbers the wording needs, already formatted. */
  readonly detail?: string;
}

/** §40/§32 — where the finding came from, so every claim is traceable. */
export interface FindingProvenance {
  readonly resultRef: ResultId;
  readonly tool: string;
  readonly sourceRange: string;
  readonly sourceVersion: string;
  readonly periods: readonly string[];
}

/**
 * §40 — one observation the narrator is allowed to state.
 *
 * `statement` is a deterministic sentence built from the finding's own values
 * (§58). It is the fallback's output AND a worked example for the narrator;
 * it is never the only thing the narrator may say, because a good answer
 * relates findings to each other and a template cannot.
 */
export interface VerifiedFinding {
  readonly id: string;
  readonly findingType: FindingType;
  /** What the observation is ABOUT — a metric, an entity, a cluster, the table. */
  readonly subject: string;
  /** Additional subjects for a comparison or a relationship. */
  readonly counterparts?: readonly string[];
  readonly direction: FindingDirection;
  readonly values: readonly FindingValue[];
  readonly materiality: readonly MaterialitySignal[];
  readonly confidence: readonly ConfidenceSignal[];
  readonly caveats: readonly Caveat[];
  readonly provenance: FindingProvenance;
  /** §58 — the deterministic sentence for this finding, in the answer language. */
  readonly statement: string;
  /** Free-form structured extras a finding type needs (method, parameters, …). */
  readonly detail?: Readonly<Record<string, unknown>>;
}

// --- construction helpers ---------------------------------------------------

/** Builds a `FindingValue`, formatting once so the text and the number agree. */
export function findingValue(
  name: string,
  value: number,
  unit: DisplayUnit,
  locale: NumberLocale,
  opts: HumanizeOptions & { readonly at?: string } = {},
): FindingValue {
  const { at, ...fmt } = opts;
  return { name, value, unit, text: humanizeValue(value, unit, locale, fmt), ...(at !== undefined ? { at } : {}) };
}

/** Looks a value up by role name. */
export function valueOf(finding: VerifiedFinding, name: string): FindingValue | undefined {
  return finding.values.find((v) => v.name === name);
}

/**
 * Every number a finding entitles an answer to use.
 *
 * This is the verifier's accept-list (§56) and it is deliberately narrow: the
 * numbers the finding actually holds, not everything derivable from them.
 */
export function findingNumbers(finding: VerifiedFinding): readonly number[] {
  const out: number[] = finding.values.map((v) => v.value);
  for (const signal of finding.materiality) {
    if (signal.kind === "magnitude") out.push(signal.value);
    else if (signal.kind === "relative_magnitude") out.push(signal.fraction);
    else if (signal.kind === "rank") out.push(signal.position, signal.outOf);
    else if (signal.kind === "persistence") out.push(signal.periods, signal.outOf);
    else if (signal.kind === "dispersion") out.push(signal.score);
    else if (signal.kind === "share_of_movement") out.push(signal.fraction);
    else if (signal.kind === "statistical") {
      out.push(signal.statistic);
      if (signal.pValue !== undefined) out.push(signal.pValue);
    }
  }
  return out;
}

const CAVEAT_RU: Record<CaveatCode, string> = {
  relative_undefined_zero_base: "относительное изменение не определено: на старте значение равно нулю",
  low_base_percentage: "процент велик из-за низкой базы",
  few_observations: "наблюдений слишком мало для вывода о тренде",
  missing_excluded: "пропуски исключены из расчёта, а не заменены нулями",
  zero_not_absence: "ноль здесь — это записанное значение, а не отсутствие показателя",
  total_row_overlap: "это итоговая строка: она пересекается со своими составляющими",
  sparse_periods: "в таблице отдельные срезы, а не непрерывный ряд",
  mixed_units: "единицы измерения различаются, абсолютные величины несопоставимы",
  basis_assumed: "основание сравнения выбрано анализом, а не задано в вопросе",
  stale_source: "данные в книге изменились после расчёта",
};

const CAVEAT_EN: Record<CaveatCode, string> = {
  relative_undefined_zero_base: "relative change is undefined: the starting value is zero",
  low_base_percentage: "the percentage is large because the base is small",
  few_observations: "too few observations to call this a trend",
  missing_excluded: "missing values were excluded from the calculation, not treated as zero",
  zero_not_absence: "a zero here is a recorded value, not an absent indicator",
  total_row_overlap: "this is a total row: it overlaps its own components",
  sparse_periods: "the table holds separate snapshots, not a continuous series",
  mixed_units: "units differ, so the absolute magnitudes are not comparable",
  basis_assumed: "the comparison basis was chosen by the analysis, not stated in the question",
  stale_source: "the workbook changed after this was computed",
};

/** §40 — one caveat, in the answer's language. */
export function caveatText(caveat: Caveat, locale: NumberLocale): string {
  const base = locale === "ru" ? CAVEAT_RU[caveat.code] : CAVEAT_EN[caveat.code];
  return caveat.detail ? `${base} (${caveat.detail})` : base;
}

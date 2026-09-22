// ---------------------------------------------------------------------------
// Stage 27 §52/§53 — rendering one number the way an analyst would write it.
//
// Deterministic and total: every user-visible figure in a Stage 27 answer is
// produced here, so the model never decides precision, scaling, a thousands
// separator, or whether something is a percent or a percentage point. That is
// the same division of labour Stage 21.2.2 established for VerifiedFacts
// (`analysis/format-number.ts`), extended with the two things §52/§53 need and
// it does not have: unit-aware scaling, and an explicit percentage-point form.
//
// The rounding here is DISPLAY ONLY. Raw values stay the source of truth for
// verification, exactly as before — a narrator quoting "28,63%" is checked
// against 0.286253, not against the string.
// ---------------------------------------------------------------------------

import { MISSING_DISPLAY, type NumberLocale } from "../../analysis/format-number.js";
import type { DisplayUnit } from "./measure-semantics.js";

const TAG: Record<NumberLocale, string> = { en: "en-US", ru: "ru-RU" };

const FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatter(locale: NumberLocale, digits: number, fixed: boolean): Intl.NumberFormat {
  const key = `${locale}:${digits}:${fixed ? 1 : 0}`;
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.NumberFormat(TAG[locale], { minimumFractionDigits: fixed ? digits : 0, maximumFractionDigits: digits });
    FORMATTERS.set(key, f);
  }
  return f;
}

/**
 * `fixed` keeps a trailing zero. It matters for the units where precision is
 * part of the reading: "-0,70 п.п." states two decimals of a percentage-point
 * move, while "-0,7 п.п." reads as a rounder, less measured number than the
 * data supports. An amount has no such convention — 19 871,5 is right and
 * 19 871,50 is noise — so it stays variable.
 */
function group(value: number, locale: NumberLocale, digits: number, fixed = false): string {
  return formatter(locale, digits, fixed).format(Number(value.toFixed(digits)));
}

/**
 * §52 — how many decimals an AMOUNT deserves at this magnitude.
 *
 * 19871.544896 → one decimal, because the sixth decimal of a figure in the
 * tens of thousands is noise and printing it is what makes an answer look
 * machine-generated. A small amount keeps two, because there the decimals are
 * the information.
 */
function amountDigits(value: number): number {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs)) return 0;
  if (Number.isInteger(value)) return 0;
  if (abs >= 1000) return 1;
  if (abs >= 1) return 2;
  return 3;
}

const PP_SUFFIX: Record<NumberLocale, string> = { ru: " п.п.", en: " pp" };

export interface HumanizeOptions {
  /** Prefix a non-negative value with "+". Deltas read wrong without it. */
  readonly signed?: boolean;
  /** Override the decimal places the unit would choose. */
  readonly digits?: number;
}

function sign(value: number, signed: boolean | undefined): string {
  return signed && value > 0 ? "+" : "";
}

/**
 * §52/§53 — `value` rendered per its display unit, in `locale`.
 *
 * A non-finite value renders as the missing token rather than "NaN": §29 keeps
 * NaN out of results, and if one ever arrives the answer should say nothing
 * rather than say "NaN%".
 */
export function humanizeValue(value: number, unit: DisplayUnit, locale: NumberLocale = "ru", opts: HumanizeOptions = {}): string {
  if (!Number.isFinite(value)) return MISSING_DISPLAY;
  const s = sign(value, opts.signed);
  switch (unit.kind) {
    case "amount":
      return `${s}${group(value, locale, opts.digits ?? amountDigits(value))}`;
    case "count":
      return `${s}${group(Math.round(value), locale, 0)}`;
    case "percent_fraction":
      return `${s}${group(value * 100, locale, opts.digits ?? 2, true)}%`;
    case "percent_scaled":
      return `${s}${group(value, locale, opts.digits ?? 2, true)}%`;
    case "percent_point_delta":
      // §53 — a percentage-point move carries its own unit word, and it is the
      // unit word that stops the reader hearing "a 0.8 percent increase".
      return `${s}${group(unit.scaled ? value : value * 100, locale, opts.digits ?? 2, true)}${PP_SUFFIX[locale]}`;
    case "ratio":
      return `${s}${group(value, locale, opts.digits ?? 2, true)}×`;
    case "score":
      return `${s}${group(value, locale, opts.digits ?? 2)}`;
    case "unknown":
      // §52 — no evidence of a unit is not permission to invent one.
      return `${s}${group(value, locale, opts.digits ?? amountDigits(value))}`;
  }
}

/**
 * §53 — the two true statements about a move between two percentage levels,
 * kept apart.
 *
 * 27.82% → 28.63% is "+0.80 п.п." and "+2.89%", and an answer may use either
 * so long as it uses the right word. Returning both, labelled, is what lets the
 * narrator choose without conflating them, and what lets the verifier check
 * which one was meant.
 */
export interface PercentagePointMove {
  /** The difference in percentage points, in the metric's own scale. */
  readonly points: number;
  /** The relative change as a fraction, or null when the start level is ~0. */
  readonly relative: number | null;
  readonly pointsText: string;
  readonly relativeText: string | null;
}

export function percentagePointMove(
  startLevel: number,
  endLevel: number,
  scaled: boolean,
  locale: NumberLocale = "ru",
): PercentagePointMove {
  const points = endLevel - startLevel;
  const relative = Math.abs(startLevel) < 1e-12 ? null : points / Math.abs(startLevel);
  return {
    points,
    relative,
    pointsText: humanizeValue(points, { kind: "percent_point_delta", scaled }, locale, { signed: true }),
    relativeText: relative === null ? null : humanizeValue(relative, { kind: "percent_fraction" }, locale, { signed: true }),
  };
}

/** A period label as the workbook spells it. Never an Excel serial (§52). */
export function humanizePeriod(canonicalOrLabel: string): string {
  return canonicalOrLabel;
}

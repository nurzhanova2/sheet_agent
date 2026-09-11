// ---------------------------------------------------------------------------
// Stage 24.6 — measure compatibility groups.
//
// A numeric series has a UNIT KIND. Series of different kinds must never be
// compared, aggregated or put in one distribution (100 KZT vs 5 % vs 17 rows).
// The kind is inferred from number-format evidence first, then from generic,
// language-agnostic header hints (%, Δ, "change", "изменение", "өзгеріс", …).
// ---------------------------------------------------------------------------

import { isCurrencyNumberFormat, isPercentNumberFormat } from "./excel-date.js";

export type MeasureKind =
  | "amount"
  | "percentage"
  | "count"
  | "ratio"
  | "absolute_change"
  | "percentage_change"
  | "unknown_numeric";

const PCT_HINT = /%|percent|percentage|процент|доля|пайыз|үлес/i;
const CHANGE_HINT = /Δ|delta|\bchange\b|изменени|прирост|динамик|өзгеріс|өсім/i;
const COUNT_HINT = /\bcount\b|\bqty\b|\bnum(?:ber)?\b|количеств|штук|кол-?во|(?:^|\s)шт\.?(?:\s|$)|дана|саны/i;
const RATIO_HINT = /\bratio\b|коэффициент|коэф\.?|соотношени|қатынас/i;
const ABS_HINT = /\babs\b|(?:^|[\s,(])абс\.?(?:[\s,)]|$)|\babsolute\b|нақты/i;

/** Classifies a numeric series by its unit kind using format + header path text. */
export function classifyMeasureKind(
  numberFormats: readonly (string | null | undefined)[],
  headerPathText: string,
): MeasureKind {
  const fmts = numberFormats.filter((f): f is string => typeof f === "string" && f.trim() !== "");
  const pctFmtShare = fmts.length > 0 ? fmts.filter(isPercentNumberFormat).length / fmts.length : 0;
  const curFmtShare = fmts.length > 0 ? fmts.filter(isCurrencyNumberFormat).length / fmts.length : 0;
  const text = headerPathText.toLowerCase();

  const isChange = CHANGE_HINT.test(text);
  const isPct = pctFmtShare >= 0.6 || (PCT_HINT.test(text) && !ABS_HINT.test(text));

  if (isChange && isPct) return "percentage_change";
  if (isChange) return "absolute_change";
  if (isPct) return "percentage";
  if (curFmtShare >= 0.6) return "amount";
  if (COUNT_HINT.test(text)) return "count";
  if (RATIO_HINT.test(text)) return "ratio";
  return "unknown_numeric";
}

/** Two measure kinds may be aggregated / compared in one series. */
export function sameMeasureGroup(a: MeasureKind, b: MeasureKind): boolean {
  if (a === b) return true;
  // absolute_change is an amount-like magnitude; percentage_change is percent-like.
  const amountLike = new Set<MeasureKind>(["amount", "absolute_change", "unknown_numeric"]);
  const pctLike = new Set<MeasureKind>(["percentage", "percentage_change", "ratio"]);
  if (amountLike.has(a) && amountLike.has(b)) return true;
  if (pctLike.has(a) && pctLike.has(b)) return true;
  return false;
}

/** A short label for a measure kind (developer diagnostics / grouping display). */
export function measureKindLabel(kind: MeasureKind): string {
  switch (kind) {
    case "amount":
      return "absolute";
    case "percentage":
      return "percent";
    case "absolute_change":
      return "absolute Δ";
    case "percentage_change":
      return "percent Δ";
    case "count":
      return "count";
    case "ratio":
      return "ratio";
    default:
      return "numeric";
  }
}

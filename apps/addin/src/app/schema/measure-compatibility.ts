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

// ---------------------------------------------------------------------------
// Stage 24.9 §22–§25 — SEMANTIC metric classes, a product-meaning taxonomy
// distinct from `MeasureKind` (a unit-compatibility grouping). Two metrics can
// share a `MeasureKind` (both "unknown_numeric") yet mean very different
// things ("Активы" = amount, "уровень долларизации" = rate) — classification
// here reads the LABEL first (language-agnostic-ish product cues), falling
// back to number-format / MeasureKind evidence, never workbook layout alone.
// ---------------------------------------------------------------------------

export type SemanticMetricClass = "amount" | "ratio" | "share" | "rate" | "percentage" | "count" | "index" | "unknown";

const SHARE_LABEL_RE = /доля\p{L}*|share\b/iu;
const RATE_LABEL_RE = /уровень\p{L}*|ставк\p{L}*|темп\p{L}*|коэффициент\p{L}*|\brate\b/iu;
const INDEX_LABEL_RE = /индекс\p{L}*|\bindex\b/iu;
const COUNT_LABEL_RE = /количеств\p{L}*|штук\p{L}*|числ[оа]\p{L}*|\bcount\b/iu;
const PERCENT_LABEL_RE = /процент\p{L}*|%|\bpercent(?:age)?\b/iu;

/**
 * Classifies a metric's SEMANTIC (product) class from its label text plus
 * fallback evidence — a number-format percent hint and/or its `MeasureKind`.
 * Label cues take precedence: "доля ликвидных активов в активах" is a SHARE
 * even before any format is inspected; "Активы" is an amount regardless of
 * which column happens to be percent-formatted elsewhere in the row.
 */
export function classifySemanticMetricClass(
  label: string,
  opts: { readonly percentFormatted?: boolean; readonly measureKind?: MeasureKind } = {},
): SemanticMetricClass {
  if (SHARE_LABEL_RE.test(label)) return "share";
  if (RATE_LABEL_RE.test(label)) return "rate";
  if (INDEX_LABEL_RE.test(label)) return "index";
  if (COUNT_LABEL_RE.test(label)) return "count";
  if (PERCENT_LABEL_RE.test(label)) return "percentage";
  if (opts.measureKind === "ratio") return "ratio";
  if (opts.measureKind === "count") return "count";
  if (opts.percentFormatted || opts.measureKind === "percentage" || opts.measureKind === "percentage_change") return "percentage";
  // A numeric metric with no percentage / share / rate / index / count cue —
  // by far the common case for this domain (financial amounts) — defaults to
  // "amount" rather than "unknown", so an ordinary metric is never silently
  // left out of a semantic-class comparison by lack of a positive signal.
  return "amount";
}

/** True for every semantic class that behaves like "a percentage" for
 *  exclusion purposes (§23) — ratio / share / rate / percentage. */
export function isPercentageLike(cls: SemanticMetricClass): boolean {
  return cls === "ratio" || cls === "share" || cls === "rate" || cls === "percentage";
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

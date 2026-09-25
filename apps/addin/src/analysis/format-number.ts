export type NumberLocale = "en" | "ru";

/** Missing / null / non-finite display token (locale-independent). */
export const MISSING_DISPLAY = "—";

const GROUPERS: Record<NumberLocale, Intl.NumberFormat> = {
  en: new Intl.NumberFormat("en-US"),
  ru: new Intl.NumberFormat("ru-RU"),
};

function grouped(value: number, locale: NumberLocale): string {
  return GROUPERS[locale].format(value);
}

/** Integer counts / large magnitudes: locale-grouped, no decimals. */
export function formatCount(value: number, locale: NumberLocale = "en"): string {
  if (!Number.isFinite(value)) return MISSING_DISPLAY;
  return grouped(Math.round(value), locale);
}

/** Alias for a value that is semantically an integer. */
export function formatInteger(value: number, locale: NumberLocale = "en"): string {
  return formatCount(value, locale);
}

/** A plain numeric value: integers grouped, decimals to `digits` places (default 2). */
export function formatNumber(value: number, digits = 2, locale: NumberLocale = "en"): string {
  if (!Number.isFinite(value)) return MISSING_DISPLAY;
  if (Number.isInteger(value)) return grouped(value, locale);
  const abs = Math.abs(value);
  if (abs >= 1000) return grouped(Math.round(value), locale);
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  return Number.isInteger(rounded) ? grouped(rounded, locale) : String(rounded);
}

/** A fraction (0..1) rendered as a percentage, e.g. 0.42857 → "42.86%", -0.2 → "-20.00%". */
export function formatPercent(fraction: number, digits = 2): string {
  if (!Number.isFinite(fraction)) return MISSING_DISPLAY;
  return `${(Math.round(fraction * 100 * 10 ** digits) / 10 ** digits).toFixed(digits)}%`;
}

/** A multiplicative ratio, e.g. 6.5555 → "6.56×". */
export function formatRatio(ratio: number, digits = 2): string {
  if (!Number.isFinite(ratio)) return MISSING_DISPLAY;
  return `${(Math.round(ratio * 10 ** digits) / 10 ** digits).toFixed(digits)}×`;
}

/** A Pearson r / correlation coefficient: fixed 4 decimals, e.g. "0.7450". */
export function formatCorrelation(r: number): string {
  if (!Number.isFinite(r)) return MISSING_DISPLAY;
  return (Math.round(r * 1e4) / 1e4).toFixed(4);
}

/**
 * A date for a deterministic / provenance context. ISO (`2026-04-02`) is the
 * canonical form; an Excel serial must already have been normalised upstream
 * (see analysis/dataset.ts `excelSerialToISO`). Non-ISO input is returned as-is.
 */
export function formatDate(value: string): string {
  return value;
}

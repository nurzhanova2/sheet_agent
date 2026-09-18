// ---------------------------------------------------------------------------
// Stage 27 §43/§51/§58 — saying what a number IS, without printing its key.
//
// Exploration returns numbers under machine names: `zScore`, `iqrDistance`,
// `coefficientOfVariation`, `missingCount`. Every one of them means something
// a person can be told, and none of them may appear in an answer — §18's rule
// against field names as words does not stop applying because the field came
// from Python instead of from a tool.
//
// So each known measure gets a phrase, and — the part that matters more — an
// UNKNOWN measure gets none. The tempting fallback is to de-snake the key and
// hope: `skewness_robust` becomes "skewness robust" and the sentence looks
// finished. It is not finished, it is a field name with a space in it, and in
// a Russian answer it is also in the wrong language. The honest fallback is to
// state the number without claiming what it measures, and `measureWord`
// returns null to force that choice on the caller.
// ---------------------------------------------------------------------------

import type { NumberLocale } from "../../analysis/format-number.js";

/** How a measure reads inside a sentence, and whether it needs its number. */
export interface MeasureWord {
  /** The measure, named: "коэффициент корреляции", "z-отклонение". */
  readonly noun: string;
  /**
   * True when the number is only meaningful with its name attached.
   *
   * A correlation of 0.82 says nothing as a bare figure, so its name travels
   * with it. A count of missing cells is self-evident in context and reads
   * better as "не заполнено 12 значений" than "количество пропусков: 12".
   */
  readonly needsNoun: boolean;
}

type Entry = { readonly ru: string; readonly en: string; readonly needsNoun: boolean };

/**
 * The measures exploration is told to produce (see `dimensionBrief`), plus the
 * spellings a model reaches for anyway. Keys are normalised to lowercase with
 * separators removed, so `z_score`, `zScore` and `Z-Score` are one entry.
 */
const WORDS: Readonly<Record<string, Entry>> = {
  // --- data quality ---
  missingcount: { ru: "не заполнено значений", en: "empty values", needsNoun: false },
  missing: { ru: "не заполнено значений", en: "empty values", needsNoun: false },
  emptycount: { ru: "не заполнено значений", en: "empty values", needsNoun: false },
  duplicatecount: { ru: "повторяющихся строк", en: "duplicate rows", needsNoun: false },
  share: { ru: "доля", en: "share", needsNoun: true },
  coverage: { ru: "заполненность", en: "coverage", needsNoun: true },
  // --- anomalies ---
  zscore: { ru: "отклонение от среднего", en: "deviation from the mean", needsNoun: true },
  iqrdistance: { ru: "удалённость от основной массы значений", en: "distance from the bulk of the values", needsNoun: true },
  maddistance: { ru: "удалённость от медианы", en: "distance from the median", needsNoun: true },
  distance: { ru: "расстояние от типичного профиля", en: "distance from the typical profile", needsNoun: true },
  // --- relationships ---
  correlation: { ru: "коэффициент корреляции", en: "correlation coefficient", needsNoun: true },
  pearson: { ru: "коэффициент корреляции", en: "correlation coefficient", needsNoun: true },
  spearman: { ru: "ранговый коэффициент корреляции", en: "rank correlation coefficient", needsNoun: true },
  r: { ru: "коэффициент корреляции", en: "correlation coefficient", needsNoun: true },
  pvalue: { ru: "вероятность случайного совпадения", en: "probability of arising by chance", needsNoun: true },
  // --- distributions ---
  skewness: { ru: "асимметрия", en: "skew", needsNoun: true },
  kurtosis: { ru: "острота пика", en: "peakedness", needsNoun: true },
  median: { ru: "медиана", en: "median", needsNoun: true },
  iqr: { ru: "межквартильный размах", en: "interquartile range", needsNoun: true },
  mean: { ru: "среднее", en: "mean", needsNoun: true },
  std: { ru: "стандартное отклонение", en: "standard deviation", needsNoun: true },
  standarddeviation: { ru: "стандартное отклонение", en: "standard deviation", needsNoun: true },
  coefficientofvariation: { ru: "разброс относительно среднего", en: "spread relative to the mean", needsNoun: true },
  cv: { ru: "разброс относительно среднего", en: "spread relative to the mean", needsNoun: true },
  range: { ru: "размах", en: "range", needsNoun: true },
  // --- shared ---
  count: { ru: "штук", en: "of them", needsNoun: false },
  n: { ru: "наблюдений", en: "observations", needsNoun: false },
  rsquared: { ru: "доля объяснённой изменчивости", en: "share of variation explained", needsNoun: true },
  slope: { ru: "средний шаг за период", en: "average step per period", needsNoun: true },
};

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * The measure, in words — or `null` when this system does not know what it is.
 *
 * `null` is a real answer and callers must handle it. Inventing a phrase for
 * an unrecognised key is how a machine name reaches a reader.
 */
export function measureWord(name: string, locale: NumberLocale): MeasureWord | null {
  const entry = WORDS[normalise(name)];
  if (!entry) return null;
  return { noun: locale === "ru" ? entry.ru : entry.en, needsNoun: entry.needsNoun };
}

/** Is this measure one whose number means nothing on its own? */
export function needsItsName(name: string): boolean {
  return WORDS[normalise(name)]?.needsNoun ?? true;
}

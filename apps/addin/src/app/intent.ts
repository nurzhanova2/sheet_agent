// ---------------------------------------------------------------------------
// Deterministic turn classification. This is the application-side guard that
// Stage 21.1 adds on top of prompt instructions: if a turn asks for an exact
// spreadsheet computation, the model is NOT allowed to answer directly — it must
// go through the plan → engine → answer path (see chat-client.ts).
//
// The lexicon is a signal, not the whole enforcement: the planner still returns
// a typed plan and that plan is validated. But a lexicon hit means "direct_answer
// is forbidden for this turn".
// ---------------------------------------------------------------------------

export interface TurnIntent {
  /** The turn needs at least one deterministic analysis operation. */
  readonly analytical: boolean;
  /** The turn asks for a chart / visualization. */
  readonly visualization: boolean;
  /** Lexicon fragments that matched (for debugging / activity detail). */
  readonly matched: readonly string[];
}

// Matched case-insensitively as whole-ish tokens. Keep entries lowercase.
const ANALYTICAL_TERMS: readonly string[] = [
  // English
  "how many", "how much", "count", "number of", "sum", "total", "subtotal",
  "average", "avg", "mean", "median", "minimum", "min ", "maximum", "max ",
  "largest", "smallest", "highest", "lowest", "biggest", "top ", "bottom ",
  "rank", "ranking", "frequency", "percent", "percentage", "proportion", "share of",
  "group by", "grouped by", "breakdown", "per region", "per category", "by region",
  "by category", "by manager", "by product", "compare total", "compare the total",
  "correlation", "correlate", "corr ", "pearson", "outlier", "outliers", "anomal",
  "standard deviation", "std dev", "stddev", "variance of", "summary statistic",
  "distribution of", "quartile", "percentile", "filter rows", "filter where",
  "rows where", "sort by", "sorted by", "order by",
  // Russian
  "сколько", "количеств", "посчита", "подсчита", "сумм", "итог",
  "средн", "медиан", "минимум", "максимум", "минимальн", "максимальн",
  "самый большой", "самый маленьк", "самая больш", "наибольш", "наименьш",
  "топ ", "топ-", "лучшие ", "худшие ", "ранжир", "частот", "процент", "доля",
  "сгруппир", "группир", "по регион", "по категор", "по менеджер", "по продукт",
  "в разрезе", "корреляц", "выброс", "аномал", "стандартн отклон",
  "отклонение", "статистик", "распределен", "квартил", "перцентил",
  "отфильтр", "фильтр по", "строки где", "отсортир", "сортир по",
];

const VISUALIZATION_TERMS: readonly string[] = [
  // English
  "chart", "plot", "graph", "diagram", "scatter", "bar chart", "line chart",
  "pie chart", "histogram", "visualiz", "visualise", "draw a ", "show a chart",
  // Russian
  "график", "диаграмм", "построй граф", "построй диаграм", "визуализ",
  "гистограмм", "круговая", "столбчат", "линейный граф", "точечн", "диаграмму рассеян",
  "нарисуй график", "покажи график",
];

function matches(haystack: string, terms: readonly string[]): string[] {
  const found: string[] = [];
  for (const term of terms) if (haystack.includes(term)) found.push(term.trim());
  return found;
}

/**
 * Classifies a raw user prompt. Punctuation is normalised and a leading/trailing
 * space is added so `"min "` / `"max "` style entries match at word edges.
 */
export function classifyIntent(prompt: string): TurnIntent {
  const haystack = ` ${prompt.toLowerCase().replace(/[|]/g, " ").replace(/\s+/g, " ")} `;
  const analyticalHits = matches(haystack, ANALYTICAL_TERMS);
  const visualizationHits = matches(haystack, VISUALIZATION_TERMS);
  return {
    analytical: analyticalHits.length > 0 || visualizationHits.length > 0,
    visualization: visualizationHits.length > 0,
    matched: [...analyticalHits, ...visualizationHits],
  };
}

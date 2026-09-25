import type { CellValue } from "@sheet-agent/application";

const FRIENDLY_COLUMN_LABELS: Readonly<Record<string, { readonly ru: string; readonly en: string }>> = {
  metric: { ru: "Показатель", en: "Metric" },
  value: { ru: "Значение", en: "Value" },
  period: { ru: "Дата", en: "Date" },
  headerPath: { ru: "Дата", en: "Date" },
  startValue: { ru: "Было", en: "Start value" },
  endValue: { ru: "Стало", en: "End value" },
  absoluteChange: { ru: "Изменение", en: "Change" },
  percentageChange: { ru: "Изменение, %", en: "Change, %" },
  startPeriod: { ru: "С", en: "From" },
  endPeriod: { ru: "По", en: "To" },
  score: { ru: "Оценка", en: "Score" },
  distance: { ru: "Отклонение, %", en: "Distance, %" },
  deviation: { ru: "Отклонение от среднего, %", en: "Deviation from mean, %" },
  a_value: { ru: "Значение (1)", en: "Value (1)" },
  b_value: { ru: "Значение (2)", en: "Value (2)" },
  a_period: { ru: "Дата (1)", en: "Date (1)" },
  b_period: { ru: "Дата (2)", en: "Date (2)" },
  semanticClass: { ru: "Тип показателя", en: "Type" },
  strictlyIncreasing: { ru: "Строго рос", en: "Strictly increasing" },
  strictlyDecreasing: { ru: "Строго снижался", en: "Strictly decreasing" },
  nonDecreasing: { ru: "Ни разу не снижался", en: "Never decreased" },
  nonIncreasing: { ru: "Ни разу не рос", en: "Never increased" },
  directionChangeCount: { ru: "Смен направления", en: "Direction changes" },
  matched: { ru: "Соответствует", en: "Matched" },
  pivot1Period: { ru: "Дата снижения", en: "Decline date" },
  pivot2Period: { ru: "Дата восстановления", en: "Recovery date" },
  periodCount: { ru: "Точек данных", en: "Data points" },
  max_value: { ru: "Исторический максимум", en: "Historical max" },
  max_period: { ru: "Дата максимума", en: "Date of max" },
  curr_value: { ru: "Текущее значение", en: "Current value" },
  curr_period: { ru: "Текущая дата", en: "Current date" },
  pct_distance_from_max: { ru: "Отклонение от максимума, %", en: "Distance from max, %" },
  ratio_to_max: { ru: "Доля от максимума, %", en: "Ratio to max, %" },
  slope: { ru: "Наклон тренда", en: "Trend slope" },
  normalizedSlope: { ru: "Наклон тренда (норм.)", en: "Trend slope (normalized)" },
  direction: { ru: "Направление", en: "Direction" },
  r2: { ru: "Достоверность тренда", en: "Trend fit" },
  periods: { ru: "Точек данных", en: "Data points" },
};

const VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, { readonly ru: string; readonly en: string }>>>> = {
  direction: {
    increasing: { ru: "рост", en: "increasing" },
    decreasing: { ru: "снижение", en: "decreasing" },
    flat: { ru: "стабильно", en: "flat" },
  },
};

export const INTERNAL_COLUMN_RE =
  /(^|_)(sourceCell|sourceCells|startCell|endCell|startPeriodCanonical|endPeriodCanonical|periodCanonical|metricCanonical|resultId|observationId|factId)$/i;

const PERCENT_LIKE_COLUMN_RE = /distance|deviation|percentageChange|ratio_to_max|pct_/i;

export function friendlyColumn(name: string, language: "ru" | "en"): string {
  return FRIENDLY_COLUMN_LABELS[name]?.[language] ?? name;
}

export function friendlyValue(column: string, value: CellValue, language: "ru" | "en" = "ru"): string {
  if (typeof value === "string") {
    const enumLabel = VALUE_LABELS[column]?.[value];
    if (enumLabel) return enumLabel[language];
  }
  if (typeof value === "number" && Number.isFinite(value) && PERCENT_LIKE_COLUMN_RE.test(column)) {
    return `${(value * 100).toFixed(2).replace(/\.00$/, "")}%`;
  }
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) {
    return String(Math.round(value * 1e6) / 1e6);
  }
  return String(value ?? "");
}

export function renderTableForUser(columns: readonly string[], rows: readonly (readonly CellValue[])[], language: "ru" | "en", maxRows = 50): string {
  const keepIdx = columns.map((c, i) => (INTERNAL_COLUMN_RE.test(c) ? -1 : i)).filter((i) => i >= 0);
  const cols = keepIdx.map((i) => columns[i]!);
  const head = `| ${cols.map((c) => friendlyColumn(c, language)).join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, maxRows)
    .map((r: readonly CellValue[]) => `| ${keepIdx.map((i) => friendlyValue(columns[i]!, r[i] ?? null, language)).join(" | ")} |`)
    .join("\n");
  return `${head}\n${sep}\n${body}`;
}

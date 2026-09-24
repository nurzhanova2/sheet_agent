import type { ResponseLanguage } from "../language.js";
import type { TableSchema } from "./schema-induction.js";

export function describeSchema(schema: TableSchema, language: ResponseLanguage): string {
  const ru = language === "ru";
  const lines: string[] = [];
  const kindRu: Record<string, string> = {
    records: "таблица наблюдений (строка = запись, столбец = поле)",
    matrix: "матрица «показатель × период»",
    cross_tab: "перекрёстная таблица (двумерная)",
    time_series_matrix: "временной ряд (даты по строкам, метрики по столбцам)",
    hierarchical_report: "иерархический отчёт с многоуровневым заголовком",
    key_value: "таблица «ключ — значение»",
    mixed: "смешанная структура",
    unknown: "структуру определить не удалось",
  };
  const kindEn: Record<string, string> = {
    records: "a records table (row = observation, column = field)",
    matrix: "an indicator × period matrix",
    cross_tab: "a two-dimensional cross-tab",
    time_series_matrix: "a time series (dates down rows, metrics across columns)",
    hierarchical_report: "a hierarchical report with a multi-level header",
    key_value: "a key–value table",
    mixed: "a mixed structure",
    unknown: "an unrecognised structure",
  };
  const periodsAcross = schema.orientation !== "column_metrics";
  const subjects = periodsAcross ? schema.rowAxis.map((m) => m.display) : schema.columnPaths.map((p) => p.displayLabel);
  const periodCount = periodsAcross ? schema.columnPaths.length : schema.rowAxis.length;
  const named = subjects.slice(0, 6).map((s) => (ru ? `«${s}»` : `"${s}"`));

  if (named.length > 0) {
    const rest = subjects.length - named.length;
    const tail = rest > 0 ? (ru ? ` и ещё ${rest}` : ` and ${rest} more`) : "";
    const over = periodCount > 0 ? (ru ? ` за ${periodCount} периодов` : ` across ${periodCount} periods`) : "";
    lines.push(
      ru
        ? `В таблице ${subjects.length} показателей${over}: ${named.join(", ")}${tail}.`
        : `The table holds ${subjects.length} indicators${over}: ${named.join(", ")}${tail}.`,
    );
  } else {
    lines.push(ru ? `Это ${kindRu[schema.layoutKind]}.` : `This is ${kindEn[schema.layoutKind]}.`);
  }

  const dateLevels = schema.columnPaths.flatMap((p) => p.levels.filter((l) => l.iso).map((l) => l.iso!));
  if (dateLevels.length > 0) {
    const sortedDates = [...new Set(dateLevels)].sort();
    lines.push(
      ru
        ? `Данные охватывают период с ${sortedDates[0]} по ${sortedDates[sortedDates.length - 1]}.`
        : `The data runs from ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}.`,
    );
  }
  if (periodCount > 1) {
    lines.push(
      ru
        ? "Можно сравнить любые два периода, посмотреть динамику по отдельному показателю или найти те, что изменились сильнее всего."
        : "You can compare any two periods, follow one indicator over time, or find the ones that moved most.",
    );
  }
  if (schema.measures.length > 1) {
    lines.push(
      ru
        ? "Часть показателей измеряется в разных единицах — сравнивать их между собой напрямую нельзя."
        : "Some indicators are measured in different units, so they cannot be compared with each other directly.",
    );
  }
  const structure =
    schema.headerDepth > 1
      ? ru
        ? `Формат — ${kindRu[schema.layoutKind]}, заголовок занимает ${schema.headerDepth} строки.`
        : `Its layout is ${kindEn[schema.layoutKind]}; the header spans ${schema.headerDepth} rows.`
      : ru
        ? `Формат — ${kindRu[schema.layoutKind]}.`
        : `Its layout is ${kindEn[schema.layoutKind]}.`;
  if (named.length > 0) lines.push(structure);
  if (schema.totals.length > 0) {
    lines.push(
      ru
        ? `Обнаружены строки итогов: ${schema.totals.map((t) => t.label).join(", ")} (в экстремумы/средние по умолчанию не включаются).`
        : `Total rows detected: ${schema.totals.map((t) => t.label).join(", ")} (excluded from extrema/averages by default).`,
    );
  }
  if (schema.ambiguities.some((a) => a.kind === "missing_header_context")) {
    lines.push(
      ru
        ? "В выделении видна числовая матрица, но верхняя часть заголовка, похоже, не попала в диапазон."
        : "The selection is a numeric block; the top of the header may be outside the selected range.",
    );
  }
  return lines.join("\n");
}


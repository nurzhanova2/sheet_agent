// ---------------------------------------------------------------------------
// Stage 24.6 — natural-language intent over a canonical TableSchema, and the
// deterministic result payloads (schema summary / matrix extrema / peaks /
// outliers / axis ranking). Everything numeric is computed here, never by the
// model. Results carry exact source cells for later action handoff.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import type { ResponseLanguage } from "../language.js";
import {
  axisRank,
  iqrOutliers,
  measureSeries,
  seriesExtrema,
  seriesPeaks,
  thresholdOutliers,
  type AnalysisGrids,
} from "./matrix-analysis.js";
import type { TableSchema } from "./schema-induction.js";

export interface SchemaIntent {
  readonly describe: boolean;
  readonly extrema: boolean; // max AND min per metric
  readonly maxOnly: boolean;
  readonly minOnly: boolean;
  readonly peaks: boolean;
  readonly peaksByMagnitude: boolean;
  readonly outliers: boolean;
  /** true when the outlier method is explicitly statistical (run IQR now). */
  readonly outliersStatistical: boolean;
  /** a fixed threshold value supplied for the "порог / threshold" branch (24.6.1). */
  readonly thresholdValue: number | null;
  readonly axisExtreme: { readonly direction: "asc" | "desc"; readonly needle?: string } | null;
  readonly trend: boolean;
  /** true when the message is any recognised schema-analysis ask. */
  readonly any: boolean;
}

const DESCRIBE_RE =
  /(?:о\s+ч[её]м\s+эт(?:а|от)\s+(?:таблиц|лист|данн)|что\s+(?:это\s+)?за\s+(?:таблиц|данные)|опиши\s+(?:эту\s+)?таблиц|структур[аеы]\s+таблиц|what(?:'?s| is)\s+(?:this|the)\s+(?:table|sheet|data)\s+about|describe\s+(?:this|the)\s+table|what\s+kind\s+of\s+table)/i;
const MAX_RE = /(?:максимальн|наибольш|наиболее\s+крупн|крупнейш|пик|максимум|highest|maximum|largest|biggest|\bmax\b|peak)/i;
const MIN_RE = /(?:минимальн|наименьш|наименее|минимум|lowest|minimum|smallest|\bmin\b)/i;
const PEAK_RE = /(?:пиков|\bпик[аи]?\b|\bpeak\b|peak\s+values?)/i;
const MAGNITUDE_RE = /(?:по\s+модулю|абсолютн[а-яё]*\s+(?:велич|значен|измен)|largest\s+absolute|by\s+magnitude|\|.*\|)/i;
const PER_METRIC_RE =
  /(?:для\s+каждого\s+показател|по\s+каждому\s+показател|для\s+каждой\s+(?:строк|метрик|позиц)|per\s+(?:metric|indicator|row)|for\s+each\s+(?:metric|indicator|row))/i;
const OUTLIER_RE =
  /(?:выход[а-яё]*\s+за\s+пределы\s+нормы|за\s+пределами\s+нормы|вне\s+нормы|аномальн|выброс|outlier|out\s+of\s+(?:the\s+)?normal|outside\s+(?:the\s+)?norm|beyond\s+normal)/i;
const OUTLIER_STAT_RE =
  /(?:статистическ[а-яё]*\s+выброс|статвыброс|\biqr\b|межквартиль|стандартн[а-яё]*\s+отклонени|z-?score|считай\s+статистическ|как\s+статистическ)/i;
const TREND_RE = /(?:динамик[ауи]|тренд|trend|over\s+time|по\s+времени|во\s+времени|as\s+a\s+time\s+series)/i;
const AXIS_MAX_RE =
  /(?:как(?:ая|ой)\s+(?:строк|показател|регион|элемент)[а-яё]*\s+(?:имеет|с)\s+максимальн|где\s+(?:значение\s+)?(?:за|в|по)\s+([^\s?]+)\s+максимальн|highest\s+(?:value\s+)?(?:in|for)\s+([^\s?]+)|which\s+(?:row|member)\s+has\s+the\s+(?:highest|max))/i;
// "покажи максимальную Revenue" / "минимум по Fact" / "highest Revenue".
const SINGLE_EXTREME_RE =
  /(?:^|\s)(максимальн\p{L}*|наибольш\p{L}*|наибол\p{L}*|highest|max(?:imum)?|минимальн\p{L}*|наименьш\p{L}*|lowest|min(?:imum)?)\s+(?:значени\p{L}*\s+)?(?:по\s+|of\s+|for\s+|у\s+)?([\p{L}][\p{L}\d %]{1,28}?)\s*[.?!]*\s*$/iu;
const DESC_EXTREME_RE = /^(?:макс|наибол|наибольш|highest|max)/i;

export function detectSchemaIntent(text: string): SchemaIntent {
  const t = text.trim();
  const describe = DESCRIBE_RE.test(t);
  const wantsMax = MAX_RE.test(t);
  const wantsMin = MIN_RE.test(t);
  const perMetric = PER_METRIC_RE.test(t);
  const peaks = PEAK_RE.test(t);
  const outliers = OUTLIER_RE.test(t);
  const trend = TREND_RE.test(t);
  const axisM = AXIS_MAX_RE.exec(t);
  const singleM = !perMetric && !peaks && !outliers ? SINGLE_EXTREME_RE.exec(t) : null;

  const extrema = perMetric && wantsMax && wantsMin;
  const maxOnly = perMetric && wantsMax && !wantsMin && !peaks;
  const minOnly = perMetric && wantsMin && !wantsMax;

  const axisExtreme = axisM
    ? { direction: "desc" as const, ...(axisM[1] || axisM[2] ? { needle: (axisM[1] ?? axisM[2] ?? "").trim() } : {}) }
    : singleM
      ? { direction: (DESC_EXTREME_RE.test(singleM[1] ?? "") ? "desc" : "asc") as "asc" | "desc", needle: (singleM[2] ?? "").trim() }
      : null;

  // 24.6.1 — a fixed threshold value, e.g. "… порог 0.2" / "… threshold 20%".
  const thrM = /(?:порог|threshold)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(%?)/i.exec(t);
  const thresholdValue = thrM
    ? (() => {
        const raw = Number((thrM[1] ?? "").replace(",", "."));
        const v = thrM[2] === "%" ? raw / 100 : raw;
        return Number.isFinite(v) && v > 0 ? v : null;
      })()
    : null;

  const any = describe || extrema || maxOnly || minOnly || peaks || outliers || trend || Boolean(axisExtreme) || thresholdValue !== null;
  return {
    describe,
    extrema,
    maxOnly,
    minOnly,
    peaks: peaks || (perMetric && wantsMax && !extrema && !maxOnly),
    peaksByMagnitude: MAGNITUDE_RE.test(t),
    outliers,
    outliersStatistical: OUTLIER_STAT_RE.test(t),
    thresholdValue,
    axisExtreme,
    trend,
    any,
  };
}

// --- deterministic describe -------------------------------------------

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

// --- deterministic analysis payloads --------------------------------

export interface SchemaSection {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
}

export interface SchemaAnalysisOutcome {
  readonly sections: readonly SchemaSection[];
  /** exact source cells backing every numeric result (for a later highlight). */
  readonly sourceCells: readonly string[];
  /** true when the request also asked for "норма"/outliers with no method → one clarification. */
  readonly needsNormClarification: boolean;
  readonly describeText?: string;
  /** which sub-analyses were computed this turn (for the trace / resume). */
  readonly computed: readonly string[];
}

function fmtNum(n: number, percent: boolean): CellValue {
  if (percent) return `${(n * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  return Number.isInteger(n) ? n : Number(n.toFixed(4));
}

export function runSchemaAnalysis(
  schema: TableSchema,
  grids: AnalysisGrids,
  intent: SchemaIntent,
  language: ResponseLanguage,
): SchemaAnalysisOutcome {
  const ru = language === "ru";
  const sections: SchemaSection[] = [];
  const sourceCells: string[] = [];
  const computed: string[] = [];
  const series = measureSeries(schema, grids);

  if (intent.describe) {
    return {
      sections: [],
      sourceCells: [],
      needsNormClarification: false,
      describeText: describeSchema(schema, language),
      computed: ["describe"],
    };
  }

  if (intent.extrema || intent.maxOnly || intent.minOnly) {
    const ex = seriesExtrema(series);
    const cols = intent.maxOnly
      ? [ru ? "Показатель" : "Indicator", ru ? "Вариант" : "Measure", ru ? "Макс" : "Max", ru ? "Столбец (макс)" : "Column (max)"]
      : intent.minOnly
        ? [ru ? "Показатель" : "Indicator", ru ? "Вариант" : "Measure", ru ? "Мин" : "Min", ru ? "Столбец (мин)" : "Column (min)"]
        : [ru ? "Показатель" : "Indicator", ru ? "Вариант" : "Measure", ru ? "Макс" : "Max", ru ? "Столбец (макс)" : "Column (max)", ru ? "Мин" : "Min", ru ? "Столбец (мин)" : "Column (min)"];
    const rows = ex.map((e) => {
      sourceCells.push(e.max.cell, e.min.cell);
      if (intent.maxOnly) return [e.rowLabel || e.seriesKey, e.measureLabel, fmtNum(e.max.value, e.max.percent), e.max.columnPath];
      if (intent.minOnly) return [e.rowLabel || e.seriesKey, e.measureLabel, fmtNum(e.min.value, e.min.percent), e.min.columnPath];
      return [
        e.rowLabel || e.seriesKey,
        e.measureLabel,
        fmtNum(e.max.value, e.max.percent),
        e.max.columnPath,
        fmtNum(e.min.value, e.min.percent),
        e.min.columnPath,
      ];
    });
    sections.push({ title: ru ? "Экстремумы по каждому показателю" : "Extrema per indicator", columns: cols, rows });
    computed.push(intent.maxOnly ? "max" : intent.minOnly ? "min" : "extrema");
  }

  if (intent.peaks) {
    const pk = seriesPeaks(series, intent.peaksByMagnitude);
    const rows = pk.map((p) => {
      sourceCells.push(p.peak.cell);
      return [p.rowLabel || p.seriesKey, p.measureLabel, fmtNum(p.peak.value, p.peak.percent), p.peak.columnPath];
    });
    sections.push({
      title: (ru ? "Пиковые значения" : "Peak values") + (intent.peaksByMagnitude ? (ru ? " (по модулю)" : " (by magnitude)") : ""),
      columns: [ru ? "Показатель" : "Indicator", ru ? "Вариант" : "Measure", ru ? "Пик" : "Peak", ru ? "Столбец" : "Column"],
      rows,
    });
    computed.push("peaks");
  }

  if (intent.axisExtreme) {
    // resolve the target column by needle (year / label substring), else the last column.
    const needle = (intent.axisExtreme.needle ?? "").toLowerCase();
    const target =
      schema.columnPaths.find((p) => needle && p.displayLabel.toLowerCase().includes(needle)) ??
      schema.columnPaths.find((p) => needle && p.levels.some((l) => (l.iso ?? "").includes(needle) || l.value.toLowerCase().includes(needle))) ??
      schema.columnPaths[schema.columnPaths.length - 1];
    if (target) {
      const ranked = axisRank(schema, grids, target.colIndex, intent.axisExtreme.direction, 10);
      const rows = ranked.map((r) => {
        sourceCells.push(r.cell);
        return [r.member, r.value];
      });
      sections.push({
        title: (ru ? "Ранжирование по столбцу " : "Ranking by column ") + `"${target.displayLabel}"`,
        columns: [ru ? "Строка" : "Member", target.displayLabel],
        rows,
      });
      computed.push("axis_rank");
    }
  }

  const needsNormClarification = intent.outliers && !intent.outliersStatistical && intent.thresholdValue === null;

  if (intent.thresholdValue !== null) {
    const t = intent.thresholdValue;
    const reports = thresholdOutliers(series, t);
    const rows = reports.flatMap((r) =>
      r.outliers.map((o) => {
        sourceCells.push(o.cell);
        return [o.rowLabel || r.seriesKey, r.measureLabel, fmtNum(o.value, o.percent), o.columnPath];
      }),
    );
    sections.push({
      title: (ru ? "Значения за пределами порога ±" : "Values beyond the ±") + `${fmtNum(t, false)}` + (ru ? " по модулю" : " threshold"),
      columns: [ru ? "Показатель" : "Indicator", ru ? "Вариант" : "Measure", ru ? "Значение" : "Value", ru ? "Столбец" : "Column"],
      rows: rows.length > 0 ? rows : [[ru ? "Значений за порогом не найдено" : "No values beyond the threshold", "", "", ""]],
    });
    computed.push("outliers_threshold");
  } else if (intent.outliers && intent.outliersStatistical) {
    const reports = iqrOutliers(series);
    const rows = reports.flatMap((r) =>
      r.outliers.map((o) => {
        sourceCells.push(o.cell);
        return [
          o.rowLabel || r.seriesKey,
          r.measureLabel,
          fmtNum(o.value, o.percent),
          o.columnPath,
          `${fmtNum(r.lower, false)} … ${fmtNum(r.upper, false)}`,
        ];
      }),
    );
    sections.push({
      title: ru ? "Статистические выбросы (метод межквартильного размаха)" : "Statistical outliers (IQR method)",
      columns: [
        ru ? "Показатель" : "Indicator",
        ru ? "Вариант" : "Measure",
        ru ? "Значение" : "Value",
        ru ? "Столбец" : "Column",
        ru ? "Границы нормы" : "Normal bounds",
      ],
      rows: rows.length > 0 ? rows : [[ru ? "Выбросов не найдено" : "No outliers found", "", "", "", ""]],
    });
    computed.push("outliers_iqr");
  }

  return { sections, sourceCells: [...new Set(sourceCells)], needsNormClarification, computed };
}

import type { ResponseLanguage } from "./language.js";

export type Lang = ResponseLanguage;

// --- pluralization --------------------------------------------------------

type PluralKey = "row" | "dataRow" | "point" | "category" | "operation";

const EN_PLURALS: Record<PluralKey, [string, string]> = {
  row: ["row", "rows"],
  dataRow: ["data row", "data rows"],
  point: ["point", "points"],
  category: ["category", "categories"],
  operation: ["operation", "operations"],
};

// Russian: [one, few (2–4), many (0, 5–20, …)]
const RU_PLURALS: Record<PluralKey, [string, string, string]> = {
  row: ["строка", "строки", "строк"],
  dataRow: ["строка данных", "строки данных", "строк данных"],
  point: ["точка", "точки", "точек"],
  category: ["категория", "категории", "категорий"],
  operation: ["операция", "операции", "операций"],
};

/** Russian plural category for a non-negative integer. */
export function ruPluralIndex(n: number): 0 | 1 | 2 {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1;
  return 2;
}

/** "1 data row" / "2 data rows" / "5 строк данных". Returns the noun only (no count). */
export function pluralNoun(lang: Lang, n: number, key: PluralKey): string {
  if (lang === "ru") return RU_PLURALS[key][ruPluralIndex(n)];
  return EN_PLURALS[key][n === 1 ? 0 : 1];
}

/** "120 data rows" / "120 строк данных". */
export function pluralCount(lang: Lang, n: number, key: PluralKey): string {
  return `${n} ${pluralNoun(lang, n, key)}`;
}

// --- provenance ---------------------------------------------------------

/** `Sales Test Data!E1:L121 · 120 data rows` / `… · 120 строк данных` (sheet name verbatim). */
export function formatProvenance(lang: Lang, sheetRange: string, dataRows: number): string {
  return `${sheetRange} · ${pluralCount(lang, dataRows, "dataRow")}`;
}

// --- keyed messages ---------------------------------------------------

type MsgKey =
  // activity titles
  | "activity.planning"
  | "activity.buildingChart"
  | "activity.analysisComplete"
  | "activity.analysisPartial"
  | "activity.analysisFailed"
  | "activity.countRows"
  | "activity.computeMetric" // {metric}
  | "activity.filterRows"
  | "activity.sortAsc"
  | "activity.sortDesc"
  | "activity.rankTop" // {n}
  | "activity.rankBottom" // {n}
  | "activity.distinct" // {column}
  | "activity.groupBy" // {dims}
  | "activity.summaryStats"
  | "activity.correlation"
  | "activity.groupCorrelation" // {dims}
  | "activity.outliers" // {method}
  | "activity.rejected"
  | "activity.limitReached"
  | "activity.unavailable"
  // use-agent transcript
  | "ua.chartInserted"
  | "ua.changesApplied"
  | "ua.changeRejected"
  | "ua.reverted" // {label}
  | "ua.applyingChanges" // {n}
  | "ua.awaitingApproval" // {n}
  | "ua.someRejected"
  | "ua.ignoredActions" // {errors}
  | "ua.selectRangeForChart"
  // goal status (Stage 21.2.3) display words
  | "goal.status.planned"
  | "goal.status.validated"
  | "goal.status.executed"
  | "goal.status.failed"
  | "goal.status.blocked"
  | "goal.reason.columnMissing" // {column}
  | "goal.reason.vizUnsupported" // {detail}
  // deterministic fallback (Stage 21.2.2)
  | "fallback.heading"
  | "fallback.note"
  | "fallback.colMetric"
  | "fallback.colValue"
  | "fallback.colSource"
  | "fallback.source"
  | "fallback.noResults"
  | "fallback.notCalculated"
  | "fallback.chartPrepared"
  | "fallback.rowsColumn"
  // slash commands (Stage 22)
  | "slash.unknown" // {name}
  | "slash.needsArgs" // {name}
  | "slash.nothingToUndo";

type Msg = string | ((p: Record<string, string | number>) => string);

const EN: Record<MsgKey, Msg> = {
  "activity.planning": "Planning analysis",
  "activity.buildingChart": "Building chart",
  "activity.analysisComplete": "Analysis complete",
  "activity.analysisPartial": "Some analysis could not be completed",
  "activity.analysisFailed": "Analysis failed",
  "activity.countRows": "Counting rows",
  "activity.computeMetric": (p) => `Calculating ${p["metric"]}`,
  "activity.filterRows": "Filtering rows",
  "activity.sortAsc": "Sorting ascending",
  "activity.sortDesc": "Sorting descending",
  "activity.rankTop": (p) => `Ranking top ${p["n"]}`,
  "activity.rankBottom": (p) => `Ranking bottom ${p["n"]}`,
  "activity.distinct": (p) => `Listing distinct ${p["column"]}`,
  "activity.groupBy": (p) => `Grouping by ${p["dims"]}`,
  "activity.summaryStats": "Summary statistics",
  "activity.correlation": "Calculating correlation",
  "activity.groupCorrelation": (p) => `Correlation by ${p["dims"]}`,
  "activity.outliers": (p) => `Detecting outliers (${p["method"]})`,
  "activity.rejected": "Rejected analysis request",
  "activity.limitReached": "Analysis limit reached",
  "activity.unavailable": "Analysis unavailable",
  "ua.chartInserted": "Chart inserted into Excel",
  "ua.changesApplied": "Changes applied",
  "ua.changeRejected": "Change rejected",
  "ua.reverted": (p) => `Reverted ${p["label"]}`,
  "ua.applyingChanges": (p) => `Applying ${p["n"]} ${p["n"] === 1 ? "change" : "changes"}`,
  "ua.awaitingApproval": (p) => `${p["n"]} ${p["n"] === 1 ? "change" : "changes"} awaiting approval`,
  "ua.someRejected": "Some analysis requests were rejected; see the answer for details.",
  "ua.ignoredActions": (p) => `Ignored invalid action(s): ${p["errors"]}`,
  "ua.selectRangeForChart": "Select a range in Excel before inserting a chart.",
  "goal.status.planned": "planned",
  "goal.status.validated": "validated",
  "goal.status.executed": "done",
  "goal.status.failed": "not done",
  "goal.status.blocked": "blocked",
  "goal.reason.columnMissing": (p) => `column ${p["column"]} is not in the selected range`,
  "goal.reason.vizUnsupported": (p) => `the chart could not be produced: ${p["detail"]}`,
  "fallback.heading": "## Results",
  "fallback.note":
    "The generated answer did not pass numeric-claim validation, so the exact engine values are shown below.",
  "fallback.colMetric": "Metric",
  "fallback.colValue": "Value",
  "fallback.colSource": "Source",
  "fallback.source": "Source",
  "fallback.noResults": "_no numeric results_",
  "fallback.notCalculated": "not calculated",
  "fallback.chartPrepared": "Chart prepared",
  "fallback.rowsColumn": "rows",
  "slash.unknown": (p) => `Unknown command \`${p["name"]}\`. Type \`/\` to see available commands.`,
  "slash.needsArgs": (p) => `Add a description after \`${p["name"]}\` — for example \`${p["name"]} average Plan by Category\`.`,
  "slash.nothingToUndo": "There is no SheetAgent change to undo.",
};

const RU: Record<MsgKey, Msg> = {
  "activity.planning": "Планирование анализа",
  "activity.buildingChart": "Построение графика",
  "activity.analysisComplete": "Анализ завершён",
  "activity.analysisPartial": "Часть анализа не выполнена",
  "activity.analysisFailed": "Не удалось выполнить анализ",
  "activity.countRows": "Подсчёт строк",
  "activity.computeMetric": (p) => `Расчёт: ${p["metric"]}`,
  "activity.filterRows": "Фильтрация строк",
  "activity.sortAsc": "Сортировка по возрастанию",
  "activity.sortDesc": "Сортировка по убыванию",
  "activity.rankTop": (p) => `Топ ${p["n"]}`,
  "activity.rankBottom": (p) => `Последние ${p["n"]}`,
  "activity.distinct": (p) => `Уникальные значения ${p["column"]}`,
  "activity.groupBy": (p) => `Группировка по ${p["dims"]}`,
  "activity.summaryStats": "Сводная статистика",
  "activity.correlation": "Расчёт корреляции",
  "activity.groupCorrelation": (p) => `Корреляция по ${p["dims"]}`,
  "activity.outliers": (p) => `Поиск выбросов (${p["method"]})`,
  "activity.rejected": "Запрос на анализ отклонён",
  "activity.limitReached": "Достигнут лимит операций анализа",
  "activity.unavailable": "Анализ недоступен",
  "ua.chartInserted": "График вставлен в Excel",
  "ua.changesApplied": "Изменения применены",
  "ua.changeRejected": "Изменение отклонено",
  "ua.reverted": (p) => `Отменено: ${p["label"]}`,
  "ua.applyingChanges": (p) => `Применение изменений: ${p["n"]}`,
  "ua.awaitingApproval": (p) => `Изменений на подтверждение: ${p["n"]}`,
  "ua.someRejected": "Часть запросов на анализ отклонена — подробности в ответе.",
  "ua.ignoredActions": (p) => `Недопустимые действия пропущены: ${p["errors"]}`,
  "ua.selectRangeForChart": "Выберите диапазон в Excel перед вставкой графика.",
  "goal.status.planned": "запланировано",
  "goal.status.validated": "проверено",
  "goal.status.executed": "выполнено",
  "goal.status.failed": "не выполнено",
  "goal.status.blocked": "заблокировано",
  "goal.reason.columnMissing": (p) => `столбец ${p["column"]} отсутствует в выбранном диапазоне`,
  "goal.reason.vizUnsupported": (p) => `график не удалось построить: ${p["detail"]}`,
  "fallback.heading": "## Результаты",
  "fallback.note":
    "Сформированный ответ не прошёл проверку числовых утверждений, поэтому ниже приведены значения строго из аналитического движка.",
  "fallback.colMetric": "Показатель",
  "fallback.colValue": "Значение",
  "fallback.colSource": "Источник",
  "fallback.source": "Источник",
  "fallback.noResults": "_нет числовых результатов_",
  "fallback.notCalculated": "не рассчитано",
  "fallback.chartPrepared": "График подготовлен",
  "fallback.rowsColumn": "строк",
  "slash.unknown": (p) => `Неизвестная команда \`${p["name"]}\`. Введите \`/\`, чтобы увидеть список команд.`,
  "slash.needsArgs": (p) => `Добавьте описание после \`${p["name"]}\` — например \`${p["name"]} среднее Plan по Category\`.`,
  "slash.nothingToUndo": "Нет изменений SheetAgent для отмены.",
};

const TABLES: Record<Lang, Record<MsgKey, Msg>> = { en: EN, ru: RU };

export function t(lang: Lang, key: MsgKey, params: Record<string, string | number> = {}): string {
  const entry = TABLES[lang][key];
  return typeof entry === "function" ? entry(params) : entry;
}

// --- provider error display (Stage 21.2.8 §6) ---------------------------------
// The Companion emits a STABLE error code; only its user-facing text is localized.

const PROVIDER_ERRORS: Record<string, Record<Lang, string>> = {
  PROVIDER_UNAVAILABLE: {
    en: "The AI provider is temporarily unavailable. Try again later.",
    ru: "AI-провайдер временно недоступен. Повторите попытку позже.",
  },
  RATE_LIMITED: {
    en: "The AI provider is busy or rate-limited. Wait and try again.",
    ru: "AI-провайдер перегружен или превышен лимит запросов. Подождите и повторите попытку.",
  },
  TIMEOUT: {
    en: "The AI provider timed out. Try again.",
    ru: "AI-провайдер не ответил вовремя. Повторите попытку.",
  },
  NETWORK_UNAVAILABLE: {
    en: "The AI provider cannot be reached. Check your network and provider URL.",
    ru: "Не удаётся связаться с AI-провайдером. Проверьте сеть и адрес провайдера.",
  },
  INVALID_CREDENTIALS: {
    en: "The AI provider rejected the API key. Update it in Sheet Agent settings.",
    ru: "AI-провайдер отклонил API-ключ. Обновите его в настройках Sheet Agent.",
  },
  CREDENTIALS_REQUIRED: {
    en: "Open Sheet Agent settings and save your AI provider API key.",
    ru: "Откройте настройки Sheet Agent и сохраните API-ключ AI-провайдера.",
  },
  MALFORMED_RESPONSE: {
    en: "The AI provider returned an unreadable response.",
    ru: "AI-провайдер вернул нечитаемый ответ.",
  },
  PROVIDER_ERROR: {
    en: "The AI provider rejected the request.",
    ru: "AI-провайдер отклонил запрос.",
  },
  INVALID_REQUEST: {
    en: "The request to the AI provider was invalid.",
    ru: "Запрос к AI-провайдеру был некорректным.",
  },
};

const PROVIDER_ERROR_FALLBACK: Record<Lang, string> = {
  en: "The AI request could not be completed. Try again.",
  ru: "Не удалось выполнить запрос к AI. Повторите попытку.",
};

/**
 * Localized text for a stable provider error code. Unknown codes get a localized
 * generic message rather than a raw English string.
 */
export function providerErrorMessage(lang: Lang, code: string | undefined, rawMessage?: string): string {
  const known = code ? PROVIDER_ERRORS[code] : undefined;
  if (known) return known[lang];
  // no code we recognise — prefer a localized generic over leaking an English string
  return rawMessage && lang === "en" ? rawMessage : PROVIDER_ERROR_FALLBACK[lang];
}

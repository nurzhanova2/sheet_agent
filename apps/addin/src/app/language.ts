// ---------------------------------------------------------------------------
// Deterministic response-language handling. The final answer must follow the
// language of the latest user message. This is a lightweight detector — it does
// not aim to cover every language, only to be reliable for the languages we
// actually serve. Add entries to LANGUAGES to extend it.
// ---------------------------------------------------------------------------

export type ResponseLanguage = "ru" | "en";

export const DEFAULT_LANGUAGE: ResponseLanguage = "en";

interface LanguageProfile {
  readonly code: ResponseLanguage;
  /** Counts characters that strongly indicate this language. */
  readonly score: (text: string) => number;
}

const LANGUAGES: readonly LanguageProfile[] = [
  { code: "ru", score: (text) => (text.match(/[Ѐ-ӿ]/g) ?? []).length },
  { code: "en", score: (text) => (text.match(/[A-Za-z]/g) ?? []).length },
];

const CYRILLIC_PRESENCE_MIN = 2;
const CYRILLIC_PRESENCE_RATIO = 0.15;

/**
 * Detects the response language of a single message. Cyrillic is presence-biased:
 * a mostly-Russian sentence that embeds English identifiers ("Построй scatter plot
 * Plan vs Fact") is still Russian. English users effectively never type Cyrillic,
 * so any non-trivial amount of it wins. Empty input falls back (default English).
 */
export function detectLanguage(text: string, fallback: ResponseLanguage = DEFAULT_LANGUAGE): ResponseLanguage {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cyrillic === 0 && latin === 0) return fallback;
  if (cyrillic >= CYRILLIC_PRESENCE_MIN && cyrillic / (cyrillic + latin) >= CYRILLIC_PRESENCE_RATIO) return "ru";
  if (latin > 0) return "en";
  return fallback;
}

/** Fraction of letters in `text` that belong to `language`. Used by the answer validator. */
export function languageRatio(text: string, language: ResponseLanguage): number {
  const profile = LANGUAGES.find((entry) => entry.code === language);
  if (!profile) return 1;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return 1;
  return profile.score(text) / letters;
}

/**
 * True when `text` clearly is NOT written in `expected` — used to trigger a
 * single answer-regeneration pass. Deliberately lenient: workbook headers and
 * short technical tokens (Plan, Fact, Pearson, r, %, ISO dates) are allowed to
 * appear verbatim in a Russian answer.
 */
export function isLanguageMismatch(text: string, expected: ResponseLanguage): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 24) return false;
  const ratio = languageRatio(trimmed, expected);
  if (expected === "ru") return ratio < 0.35;
  return ratio < 0.55;
}

const DIRECTIVES: Record<ResponseLanguage, string> = {
  ru:
    "ЯЗЫК ОТВЕТА: русский. Пиши весь ответ (заголовки, пояснения, предупреждения, выводы, подписи) на русском языке. " +
    "Не переводи названия столбцов таблицы (Plan, Fact, Revenue, Variance %) и технические имена — оставляй их как есть.",
  en:
    "RESPONSE LANGUAGE: English. Write the entire answer (headings, explanations, warnings, conclusions, captions) in English. " +
    "Keep workbook column headers and technical identifiers verbatim.",
};

export function languageDirective(language: ResponseLanguage): string {
  return DIRECTIVES[language];
}

// --- localized UI strings ---------------------------------------------------

type ActivityKey =
  | "reading"
  | "analyzing"
  | "calling"
  | "planning"
  | "calculating"
  | "visualizing"
  | "analysisComplete"
  | "done"
  | "requestFailed"
  | "noRange";

const ACTIVITY_STRINGS: Record<ResponseLanguage, Record<ActivityKey, string>> = {
  en: {
    reading: "Reading selection",
    analyzing: "Analyzing data",
    calling: "Calling model",
    planning: "Planning analysis",
    calculating: "Calculating",
    visualizing: "Building chart",
    analysisComplete: "Analysis complete",
    done: "Done",
    requestFailed: "Request failed",
    noRange: "No range selected",
  },
  ru: {
    reading: "Чтение выделенного диапазона",
    analyzing: "Анализ данных",
    calling: "Запрос к модели",
    planning: "Планирование анализа",
    calculating: "Вычисление",
    visualizing: "Построение графика",
    analysisComplete: "Расчёт завершён",
    done: "Готово",
    requestFailed: "Ошибка запроса",
    noRange: "Диапазон не выбран",
  },
};

export function uiText(language: ResponseLanguage, key: ActivityKey): string {
  return ACTIVITY_STRINGS[language][key];
}

import type { HarnessQuestion } from "./live-harness.js";

export type AnswerTable = "portfolio" | "operations";

export interface AnswerCase extends HarnessQuestion {
  readonly table: AnswerTable;
  readonly why: string;
  readonly touchesGaps?: boolean;
}

export const ANSWER_CASES: readonly AnswerCase[] = [
  {
    id: "aq-1-unnamed-product",
    table: "portfolio",
    text: "У какого продукта самый сильный отрицательный тренд?",
    concepts: ["trend", "entity_subject"],
    why: "the live run answered this with «продукт с наклоном -27,2»",
  },
  {
    id: "aq-2-unnamed-indicator",
    table: "portfolio",
    text: "Кто показал самый большой рост за год?",
    concepts: ["extremum", "entity_subject", "low_base"],
    why: "the live run answered this with «лидером является показатель с изменением с 2 до 40»",
  },
  {
    id: "aq-3-recommendation",
    table: "portfolio",
    text: "Сравни продукты между собой по динамике.",
    concepts: ["comparison", "recommendation"],
    why: "the live run closed this answer with «Стоит проверить гипотезу…»",
  },
  {
    id: "aq-4-simple-scalar",
    table: "portfolio",
    text: "На сколько выросла Ангара за год?",
    concepts: ["change", "direct_answer"],
    why: "a concise direct answer must stay concise",
  },
  {
    id: "aq-5-entity-ranking",
    table: "portfolio",
    text: "Назови три продукта с самым сильным падением.",
    concepts: ["ranking", "entity_subject"],
    why: "every ranked entity must be named",
  },
  {
    id: "aq-6-exploratory",
    table: "portfolio",
    text: "Исследуй таблицу и найди что-нибудь необычное.",
    concepts: ["exploration", "anomaly"],
    touchesGaps: true,
    why: "2-5 grounded findings, every entity-level one named",
  },
  {
    id: "aq-7-segmentation",
    table: "portfolio",
    text: "Раздели продукты на группы по характеру динамики.",
    concepts: ["cluster", "group_subject"],
    why: "a group must say what it consists of",
  },
  {
    id: "aq-8-multi-method",
    table: "portfolio",
    text: "Попробуй несколько способов сегментации и скажи, какой понятнее.",
    concepts: ["method_comparison", "cluster"],
    why: "the answer must say which methods actually ran",
  },
  {
    id: "aq-9-no-entity-axis",
    table: "operations",
    text: "Какая общая картина по этой таблице?",
    concepts: ["table_overview"],
    why: "a table with no entity axis must not be forced to name one",
  },
  {
    id: "aq-10-metric-only",
    table: "operations",
    text: "На сколько изменилась стоимость обработки?",
    concepts: ["change", "metric_subject"],
    why: "a metric-level finding needs the metric, not a fake entity",
  },
  {
    id: "aq-11-ambiguous",
    table: "operations",
    text: "Покажи динамику показателя.",
    concepts: ["ambiguous_subject"],
    why: "several metrics match and none can be chosen",
  },
  {
    id: "aq-12-volatility",
    table: "portfolio",
    text: "У кого самая высокая волатильность?",
    concepts: ["volatility", "entity_subject"],
    why: "a who-question must name who",
  },
];

export const TARGETED_CASE_IDS: readonly string[] = [
  "aq-1-unnamed-product",
  "aq-2-unnamed-indicator",
  "aq-3-recommendation",
  "aq-5-entity-ranking",
  "aq-6-exploratory",
  "aq-9-no-entity-axis",
];

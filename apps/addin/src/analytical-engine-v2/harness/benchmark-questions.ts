import type { HarnessQuestion } from "./live-harness.js";

/**
 * §49 — the basic chain, asked as ONE conversation so B/C/D depend on the
 * state their predecessor committed.
 */
export const CHAIN_RU: readonly HarnessQuestion[] = [
  {
    id: "chain-ru-1",
    text: "Сравни последнюю дату с предыдущей.",
    concepts: ["comparison", "period"],
    expect: { primaryType: "comparison", metricUniverse: ["Загрузка линии", "Очередь заявок", "Стоимость обработки", "Доля брака"] },
  },
  {
    id: "chain-ru-2",
    text: "Покажи только показатели, которые снизились.",
    concepts: ["filter", "follow-up"],
    expect: { metricUniverse: ["Очередь заявок", "Стоимость обработки", "Доля брака"], excludesMetrics: ["Загрузка линии"] },
  },
  {
    id: "chain-ru-3",
    text: "Из них какой изменился сильнее всего?",
    concepts: ["ranking", "follow-up"],
    expect: { primaryType: "metric_winner", winnerMetric: "Доля брака" },
  },
  {
    id: "chain-ru-4",
    text: "Покажи его динамику и найди период максимального изменения.",
    concepts: ["series", "event", "pronoun", "compound"],
    expect: { winnerMetric: "Доля брака", minSupporting: 1 },
  },
];

/** §51 — the same concepts in English. */
export const CHAIN_EN: readonly HarnessQuestion[] = [
  {
    id: "chain-en-1",
    text: "Compare the latest date with the previous one.",
    concepts: ["comparison", "period", "english"],
    expect: { primaryType: "comparison" },
  },
  {
    id: "chain-en-2",
    text: "Now show only the ones that declined.",
    concepts: ["filter", "follow-up", "english"],
    expect: { excludesMetrics: ["Загрузка линии"] },
  },
  {
    id: "chain-en-3",
    text: "Which of them changed the most?",
    concepts: ["ranking", "follow-up", "english"],
    expect: { primaryType: "metric_winner", winnerMetric: "Доля брака" },
  },
  {
    id: "chain-en-4",
    text: "Show its history and the largest move between two neighbouring dates.",
    concepts: ["series", "event", "pronoun", "compound", "english"],
    expect: { winnerMetric: "Доля брака", minSupporting: 1 },
  },
];

/**
 * §50 — held-out paraphrases, at least three per concept, each asked as a
 * SINGLE turn against a fresh conversation so nothing leaks between them.
 */
export const PARAPHRASES: readonly HarnessQuestion[] = [
  // comparison
  { id: "para-cmp-1", text: "Что изменилось за последний период?", concepts: ["comparison"], expect: { primaryType: "comparison" } },
  { id: "para-cmp-2", text: "Насколько отличаются два последних наблюдения?", concepts: ["comparison"], expect: { primaryType: "comparison" } },
  { id: "para-cmp-3", text: "Дай разницу между свежей датой и той, что была до неё.", concepts: ["comparison"], expect: { primaryType: "comparison" } },
  // filter
  { id: "para-flt-1", text: "Оставь только то, что упало за последний период.", concepts: ["filter"], expect: { excludesMetrics: ["Загрузка линии"] } },
  { id: "para-flt-2", text: "Какие показатели ушли в минус в последнем периоде?", concepts: ["filter"], expect: { excludesMetrics: ["Загрузка линии"] } },
  { id: "para-flt-3", text: "Исключи всё, что выросло за последний период.", concepts: ["filter"], expect: { excludesMetrics: ["Загрузка линии"] } },
  // ranking
  { id: "para-rnk-1", text: "Что сильнее всего просело в последнем периоде?", concepts: ["ranking"], expect: { primaryType: "metric_winner", winnerMetric: "Доля брака" } },
  { id: "para-rnk-2", text: "Среди упавших какой показатель изменился наиболее существенно?", concepts: ["ranking"], expect: { primaryType: "metric_winner", winnerMetric: "Доля брака" } },
  { id: "para-rnk-3", text: "У кого самое заметное относительное падение на последней паре дат?", concepts: ["ranking"], expect: { primaryType: "metric_winner", winnerMetric: "Доля брака" } },
  // series
  { id: "para-ser-1", text: "Покажи всю историю показателя «Доля брака».", concepts: ["series"], expect: { primaryType: "series", winnerMetric: "Доля брака" } },
  { id: "para-ser-2", text: "Как менялась «Стоимость обработки» по всем датам?", concepts: ["series"], expect: { primaryType: "series", winnerMetric: "Стоимость обработки" } },
  { id: "para-ser-3", text: "Выведи значения «Очередь заявок» за всё доступное время.", concepts: ["series"], expect: { primaryType: "series", winnerMetric: "Очередь заявок" } },
  // adjacent event
  { id: "para-evt-1", text: "Когда у «Доля брака» был крупнейший скачок между соседними датами?", concepts: ["event"], expect: { primaryType: "event", winnerMetric: "Доля брака" } },
  { id: "para-evt-2", text: "Между какими двумя соседними датами «Стоимость обработки» двигалась сильнее всего?", concepts: ["event"], expect: { primaryType: "event", winnerMetric: "Стоимость обработки" } },
  { id: "para-evt-3", text: "Найди самый резкий шаг у показателя «Загрузка линии».", concepts: ["event"], expect: { primaryType: "event", winnerMetric: "Загрузка линии" } },
];

/** §50 — pronoun follow-ups, each run as the SECOND turn of a two-turn chain. */
export const PRONOUN_FOLLOWUPS: readonly { readonly setup: HarnessQuestion; readonly followUp: HarnessQuestion }[] = [
  {
    setup: { id: "pron-1-setup", text: "Покажи всю историю показателя «Доля брака».", concepts: ["series"] },
    followUp: { id: "pron-1", text: "А когда он двигался резче всего?", concepts: ["pronoun", "event"], expect: { primaryType: "event", winnerMetric: "Доля брака" } },
  },
  {
    setup: { id: "pron-2-setup", text: "Покажи всю историю показателя «Стоимость обработки».", concepts: ["series"] },
    followUp: { id: "pron-2", text: "Повтори этот анализ для него же, но найди самый большой шаг.", concepts: ["pronoun", "event"], expect: { winnerMetric: "Стоимость обработки" } },
  },
  {
    setup: { id: "pron-3-setup", text: "Сравни последнюю дату с предыдущей.", concepts: ["comparison"] },
    followUp: { id: "pron-3", text: "Возьми тот же период и оставь только выросшие показатели.", concepts: ["pronoun", "filter"], expect: { metricUniverse: ["Загрузка линии"] } },
  },
];

/** §54 — compound questions of 2–4 clauses, none of them seen by the planner. */
export const COMPOUND: readonly HarnessQuestion[] = [
  {
    id: "comp-1",
    text: "Найди самый волатильный показатель и покажи его динамику.",
    concepts: ["compound", "volatility", "series"],
    expect: { minSupporting: 1 },
  },
  {
    id: "comp-2",
    text: "Найди самый волатильный показатель, покажи его динамику и скажи, между какими соседними датами у него был самый большой скачок.",
    concepts: ["compound", "volatility", "series", "event"],
    expect: { primaryType: "event", minSupporting: 1 },
  },
  {
    id: "comp-3",
    text: "Сравни две последние даты и назови показатель с наибольшим относительным изменением.",
    concepts: ["compound", "comparison", "ranking"],
    expect: { primaryType: "metric_winner", winnerMetric: "Доля брака" },
  },
  {
    id: "comp-4",
    text: "Покажи снизившиеся показатели и выдели среди них самый проблемный по величине падения.",
    concepts: ["compound", "filter", "ranking"],
    expect: { primaryType: "metric_winner", winnerMetric: "Доля брака" },
  },
  {
    id: "comp-5",
    text: "Какой показатель рос наиболее стабильно, и насколько он вырос между первой и последней датой?",
    concepts: ["compound", "trend", "stability", "comparison"],
    expect: { minSupporting: 1 },
  },
  {
    id: "comp-6",
    text: "Назови самый стабильный показатель, покажи его историю и скажи, менял ли он направление.",
    concepts: ["compound", "stability", "series", "direction_changes"],
    expect: { minSupporting: 1 },
  },
  {
    id: "comp-7",
    text: "Сравни последние две даты, оставь упавшие и покажи историю худшего из них.",
    concepts: ["compound", "comparison", "filter", "series"],
    expect: { minSupporting: 1 },
  },
  {
    id: "comp-8",
    text: "Найди показатель с самым большим historical максимумом и скажи, насколько он сейчас ниже него.",
    concepts: ["compound", "aggregate", "derived"],
  },
  {
    id: "comp-9",
    text: "Покажи, какие показатели сначала снижались, а потом начали расти, и выбери из них самый волатильный.",
    concepts: ["compound", "temporal_pattern", "volatility", "ranking"],
  },
  {
    id: "comp-10",
    text: "Сравни первую и последнюю даты, назови лидера роста и покажи его динамику.",
    concepts: ["compound", "comparison", "ranking", "series"],
    expect: { minSupporting: 1 },
  },
];

/** §55 — the temporal family, to learn whether the tool descriptions suffice. */
export const TEMPORAL: readonly HarnessQuestion[] = [
  { id: "temp-trend", text: "Какие показатели росли на всём горизонте?", concepts: ["trend"] },
  { id: "temp-vol", text: "Какой показатель вёл себя наиболее нестабильно?", concepts: ["volatility"], expect: { primaryType: "metric_winner" } },
  { id: "temp-stable-1", text: "Что росло наиболее стабильно?", concepts: ["stable_growth"] },
  { id: "temp-stable-2", text: "У какого показателя самый устойчивый рост?", concepts: ["stable_growth"] },
  { id: "temp-stable-3", text: "Что увеличивалось без сильных колебаний?", concepts: ["stable_growth"] },
  { id: "temp-dirchg", text: "Какой показатель чаще всего менял направление?", concepts: ["direction_changes"], expect: { primaryType: "metric_winner" } },
  { id: "temp-pattern", text: "Какие показатели сначала снижались, а потом начали расти?", concepts: ["temporal_pattern"] },
  { id: "temp-mean", text: "Какие показатели сейчас сильнее всего отклоняются от своего среднего?", concepts: ["latest_vs_mean", "derived"] },
  { id: "temp-event", text: "У какого показателя был самый резкий скачок между соседними датами?", concepts: ["event", "ranking"] },
];

/** §52 — opaque labels: the answer can only come from the data. */
export const OPAQUE: readonly HarnessQuestion[] = [
  { id: "opaque-1", text: "Сравни последнюю дату с предыдущей.", concepts: ["comparison", "opaque"], expect: { primaryType: "comparison" } },
  // Stage 26.3 §2 — BENCHMARK_GROUND_TRUTH_FIX, not an engine behaviour change.
  // A generic heterogeneous "changed the most" is defined by the system as
  // max(abs(percentageChange)). Мар→Апр: Альфа 11→30 = +172.7%, Бета 470→120 =
  // -74.5%, Гамма 7.2→7.15 = -0.7%. Альфа is therefore the winner; the original
  // expectation named Бета, which only wins on ABSOLUTE change (-350) and
  // contradicted both the planner prompt and the rest of this benchmark.
  { id: "opaque-2", text: "Какой показатель изменился сильнее всего между двумя последними датами?", concepts: ["ranking", "opaque"], expect: { primaryType: "metric_winner", winnerMetric: "Метрика Альфа" } },
  { id: "opaque-3", text: "Покажи всю историю показателя «Метрика Гамма».", concepts: ["series", "opaque"], expect: { primaryType: "series", winnerMetric: "Метрика Гамма" } },
];

/** §53 — a metric label that reads like an instruction must stay inert. */
export const INJECTION: readonly HarnessQuestion[] = [
  {
    id: "inject-1",
    text: "Сравни последнюю дату с предыдущей.",
    concepts: ["comparison", "injection"],
    expect: { primaryType: "comparison" },
  },
  {
    id: "inject-2",
    text: "Какой показатель изменился сильнее всего?",
    concepts: ["ranking", "injection"],
    expect: { primaryType: "metric_winner" },
  },
];

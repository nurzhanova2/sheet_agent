// ---------------------------------------------------------------------------
// Stage 26.7 §39–§42 — the HELD-OUT multi-turn conversation benchmark.
//
// None of these sentences appears in the planner prompt or in a tool
// description, and none of the tables is one an earlier stage tuned against
// (§41). What is under test is whether a conversation's ANALYTICAL STATE
// survives from one turn to the next: the pronouns, the partitives, "the same
// period", a clarification answered three messages later, a table switched
// underneath the conversation.
//
// Each turn declares only what a CORRECT ANSWER looks like — never the route
// (§57 of Stage 26.2), and never which reference tool to call.
// ---------------------------------------------------------------------------

import { buildDatedTable, buildLabelledTable, type SyntheticTable } from "../__fixtures__/synthetic-tables.js";

/**
 * §41 — a table no earlier stage has seen. Opaque but realistic labels, a
 * different shape and different magnitudes, so nothing can pass here by
 * recognising a fixture.
 */
export function conversationPrimary(sourceVersion = "v1"): SyntheticTable {
  return buildDatedTable(
    "Узел",
    [45323, 45658, 45689, 45719, 45750],
    {
      "Пропускная способность": [820, 845, 910, 1180, 1205],
      "Средняя задержка": [42, 44, 41, 39, 38.4],
      "Отказы узла": [11, 9, 26, 24, 7],
      "Резерв мощности": [300, 295, 240, 60, 55],
      "Индекс износа": [1.2, 1.25, 1.31, 1.4, 1.52],
    },
    sourceVersion,
  );
}

/**
 * §19/§46 — a genuinely different table to switch to mid-conversation.
 *
 * Its periods are real ones. The first cut labelled them "П1..П4", which the
 * schema does not read as periods at all, so every follow-up on this table was
 * unanswerable and the engine clarified — correctly, but that made the switch
 * untestable: what §19 asks is whether the OLD table's metric leaks into the
 * new one, and a table that can answer nothing cannot show that either way.
 */
export function conversationSecondary(): SyntheticTable {
  return buildLabelledTable("Смена", ["Янв", "Фев", "Мар", "Апр"], {
    "Выработка бригады": [140, 152, 149, 167],
    "Простой оборудования": [18, 15, 22, 9],
    "Расход материала": [900, 915, 880, 940],
  });
}

export interface ConversationExpect {
  /** the result type the answer should be. */
  readonly primaryType?: string;
  /** the single metric the answer should be about. */
  readonly winnerMetric?: string;
  /** the answer must be about whatever metric the PREVIOUS turn settled on. */
  readonly sameMetricAsPrevious?: boolean;
  /** the answer's metric universe must sit inside the previous turn's set. */
  readonly universeWithinPrevious?: boolean;
  /** …and be strictly smaller than it. */
  readonly universeNarrowerThanPrevious?: boolean;
  /** the answer must cover exactly these metrics. */
  readonly metricUniverse?: readonly string[];
  /** the answer must reuse the period(s) the previous turn settled on. */
  readonly samePeriodAsPrevious?: boolean;
  /** the answer must NOT be about this metric (a foreign table's). */
  readonly notMetric?: string;
  /** the turn should ask, because nothing compatible is available. */
  readonly clarifies?: boolean;
  /** at least this many supporting results. */
  readonly minSupporting?: number;
}

export interface ConversationTurn {
  readonly text: string;
  readonly language?: "ru" | "en";
  /**
   * §38 — does answering this REQUIRE something an earlier turn established?
   * Only these turns count towards reference correctness; a turn that names
   * everything it needs is not evidence either way.
   */
  readonly needsReference?: boolean;
  /** §45/§46/§47 — what happens to the workbook before this turn. */
  readonly environment?: "same_table" | "selection_drift" | "other_table" | "data_changed";
  readonly expect?: ConversationExpect;
  readonly concepts: readonly string[];
}

export interface Conversation {
  readonly id: string;
  readonly category: string;
  readonly turns: readonly ConversationTurn[];
}

const M = {
  throughput: "Пропускная способность",
  latency: "Средняя задержка",
  failures: "Отказы узла",
  reserve: "Резерв мощности",
  wear: "Индекс износа",
} as const;

/** §40 — categories A–O: 17 conversations, 81 turns, 58 of them needing a reference. */
export const CONVERSATIONS: readonly Conversation[] = [
  // A — metric winner → pronoun → series
  {
    id: "conv-a1",
    category: "A winner→pronoun→series",
    turns: [
      { text: "Какой показатель менялся сильнее всего между последними двумя датами?", concepts: ["comparison", "ranking"], expect: { primaryType: "metric_winner" } },
      { text: "Покажи его динамику.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "А где у него был самый резкий скачок?", needsReference: true, concepts: ["event", "pronoun"], expect: { primaryType: "event", sameMetricAsPrevious: true } },
      { text: "Насколько именно он изменился тогда?", needsReference: true, concepts: ["event", "follow-up"], expect: { sameMetricAsPrevious: true } },
      { text: "А какой показатель менялся слабее всех?", concepts: ["ranking", "contrast"], expect: { primaryType: "metric_winner" } },
    ],
  },
  {
    id: "conv-a2",
    category: "A winner→pronoun→series",
    turns: [
      { text: "Найди самый волатильный показатель.", concepts: ["volatility", "ranking"], expect: { primaryType: "metric_winner" } },
      { text: "Show its history.", language: "en", needsReference: true, concepts: ["series", "pronoun", "english"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "И насколько он вырос между первой и последней датой?", needsReference: true, concepts: ["comparison", "pronoun"], expect: { sameMetricAsPrevious: true } },
      { text: "А теперь то же самое для показателя с наименьшей волатильностью.", concepts: ["ranking", "contrast"], expect: { primaryType: "metric_winner" } },
    ],
  },

  // B — metric set → filter → rank → winner
  {
    id: "conv-b1",
    category: "B set→filter→rank→winner",
    turns: [
      { text: "Сравни две последние даты.", concepts: ["comparison"], expect: { primaryType: "comparison" } },
      { text: "Оставь только те, что снизились.", needsReference: true, concepts: ["filter", "follow-up"], expect: { universeNarrowerThanPrevious: true } },
      { text: "Из них какой упал сильнее всего?", needsReference: true, concepts: ["ranking", "partitive"], expect: { primaryType: "metric_winner", universeWithinPrevious: true } },
      { text: "Покажи его историю.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "И между какими датами он падал резче всего?", needsReference: true, concepts: ["event", "pronoun"], expect: { primaryType: "event", sameMetricAsPrevious: true } },
    ],
  },
  {
    id: "conv-b2",
    category: "B set→filter→rank→winner",
    turns: [
      { text: "Покажи три показателя с самым сильным ростом за весь период.", concepts: ["ranking", "comparison"], expect: {} },
      { text: "Какой из них самый нестабильный?", needsReference: true, concepts: ["volatility", "partitive"], expect: { primaryType: "metric_winner", universeWithinPrevious: true } },
      { text: "Покажи его динамику.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "А где было самое сильное изменение?", needsReference: true, concepts: ["event", "follow-up"], expect: { primaryType: "event", sameMetricAsPrevious: true } },
      { text: "Сравни его первое и последнее значение.", needsReference: true, concepts: ["comparison", "pronoun"], expect: { sameMetricAsPrevious: true } },
    ],
  },

  // C — event → when → magnitude → series
  {
    id: "conv-c1",
    category: "C event→when→magnitude",
    turns: [
      { text: `Между какими соседними датами «${M.failures}» менялись сильнее всего?`, concepts: ["event"], expect: { primaryType: "event", winnerMetric: M.failures } },
      { text: "Когда именно это было?", needsReference: true, concepts: ["event", "follow-up"], expect: { sameMetricAsPrevious: true } },
      { text: "Насколько это много в процентах?", needsReference: true, concepts: ["event", "follow-up"], expect: { sameMetricAsPrevious: true } },
      { text: "Покажи динамику этого показателя целиком.", needsReference: true, concepts: ["series", "projection"], expect: { primaryType: "series", winnerMetric: M.failures } },
      { text: "Он вообще менял направление?", needsReference: true, concepts: ["direction_changes", "pronoun"], expect: { winnerMetric: M.failures } },
    ],
  },

  // D — period → same period → previous period
  {
    id: "conv-d1",
    category: "D period continuity",
    turns: [
      { text: `Какое значение у «${M.reserve}» на последнюю дату?`, concepts: ["value", "period"], expect: { winnerMetric: M.reserve } },
      { text: `А какое за тот же период у «${M.throughput}»?`, needsReference: true, concepts: ["value", "period-continuity"], expect: { winnerMetric: M.throughput, samePeriodAsPrevious: true } },
      { text: "А по сравнению с предыдущей датой?", needsReference: true, concepts: ["comparison", "period-continuity"], expect: { winnerMetric: M.throughput } },
      { text: "Покажи его динамику за весь период.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", winnerMetric: M.throughput } },
      { text: "А на какой дате он был максимальным?", needsReference: true, concepts: ["aggregate", "pronoun"], expect: { winnerMetric: M.throughput } },
    ],
  },

  // E — ranking → "из них"
  {
    id: "conv-e1",
    category: "E partitive",
    turns: [
      { text: "Какие показатели росли монотонно?", concepts: ["monotonicity"], expect: {} },
      { text: "Из них выбери самый быстрорастущий.", needsReference: true, concepts: ["ranking", "partitive"], expect: { primaryType: "metric_winner", universeWithinPrevious: true } },
      { text: "На сколько процентов он вырос?", needsReference: true, concepts: ["comparison", "pronoun"], expect: { sameMetricAsPrevious: true } },
      { text: "Покажи его по датам.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "И где был самый крупный шаг роста?", needsReference: true, concepts: ["event", "pronoun"], expect: { primaryType: "event", sameMetricAsPrevious: true } },
    ],
  },

  // F — join output → follow-up
  {
    id: "conv-f1",
    category: "F join→follow-up",
    turns: [
      { text: "Для каждого показателя сравни последнее значение со средним за весь период.", concepts: ["join", "aggregate"], expect: {} },
      { text: "У кого отклонение самое большое?", needsReference: true, concepts: ["ranking", "partitive"], expect: { primaryType: "metric_winner", universeWithinPrevious: true } },
      { text: "Покажи его историю.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "И где у него был самый большой скачок?", needsReference: true, concepts: ["event", "pronoun"], expect: { primaryType: "event", sameMetricAsPrevious: true } },
      { text: "Насколько это в процентах?", needsReference: true, concepts: ["event", "follow-up"], expect: { sameMetricAsPrevious: true } },
    ],
  },

  // G — narrator fallback → follow-up (the harness forces the fallback)
  {
    id: "conv-g1",
    category: "G narrator fallback→follow-up",
    turns: [
      { text: "Какой показатель самый стабильный?", concepts: ["stability", "ranking", "narrator-fails"], expect: { primaryType: "metric_winner" } },
      { text: "Покажи его динамику.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "Менял ли он направление?", needsReference: true, concepts: ["direction_changes", "pronoun"], expect: { sameMetricAsPrevious: true } },
      { text: "А какой самый нестабильный?", concepts: ["volatility", "ranking"], expect: { primaryType: "metric_winner" } },
    ],
  },

  // H — clarification → short answer → resume
  {
    id: "conv-h1",
    category: "H clarify→resume",
    turns: [
      { text: "Отметь показатели, которые вышли за допустимый порог.", concepts: ["ambiguous"], expect: { clarifies: true } },
      { text: "20%", needsReference: true, concepts: ["clarification-reply"], expect: {} },
      { text: "Покажи, кто его превышает.", needsReference: true, concepts: ["filter", "follow-up"], expect: {} },
      { text: "Из них выбери худший.", needsReference: true, concepts: ["ranking", "partitive"], expect: { primaryType: "metric_winner" } },
    ],
  },

  // I — clarification → unrelated new task
  {
    id: "conv-i1",
    category: "I clarify→abandon",
    turns: [
      { text: "Отметь то, что вышло за допустимый порог.", concepts: ["ambiguous"], expect: { clarifies: true } },
      { text: `Покажи динамику «${M.wear}».`, concepts: ["series", "new-task"], expect: { primaryType: "series", winnerMetric: M.wear } },
      { text: "Между какими датами он рос быстрее всего?", needsReference: true, concepts: ["event", "pronoun"], expect: { primaryType: "event", winnerMetric: M.wear } },
      { text: "А какой показатель рос быстрее него?", needsReference: true, concepts: ["ranking", "contrast"], expect: {} },
    ],
  },

  // J — selection drift inside the same table
  {
    id: "conv-j1",
    category: "J selection drift",
    turns: [
      { text: "Какой показатель снизился сильнее всего за последние две даты?", concepts: ["comparison", "ranking"], expect: { primaryType: "metric_winner" } },
      { text: "Покажи его динамику.", environment: "selection_drift", needsReference: true, concepts: ["series", "pronoun", "drift"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "И где был самый резкий шаг?", environment: "selection_drift", needsReference: true, concepts: ["event", "pronoun", "drift"], expect: { primaryType: "event", sameMetricAsPrevious: true } },
      { text: "Сравни его первое и последнее значение.", needsReference: true, concepts: ["comparison", "pronoun"], expect: { sameMetricAsPrevious: true } },
      { text: "А кто из остальных снизился меньше всех?", concepts: ["ranking", "contrast"], expect: {} },
    ],
  },

  // K — switch to a different table
  {
    id: "conv-k1",
    category: "K table switch",
    turns: [
      { text: "Какой показатель самый волатильный?", concepts: ["volatility", "ranking"], expect: { primaryType: "metric_winner" } },
      { text: "Покажи его динамику.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      {
        text: "Покажи его динамику.",
        environment: "other_table",
        needsReference: true,
        concepts: ["series", "pronoun", "table-switch"],
        // §19 — the old table's metric must not be applied to the new one
        expect: { notMetric: M.failures, metricUniverse: ["Выработка бригады", "Простой оборудования", "Расход материала"] },
      },
      { text: "Какой из них менялся сильнее всего?", environment: "other_table", needsReference: true, concepts: ["ranking", "partitive"], expect: { notMetric: M.failures } },
      { text: "Покажи его динамику.", environment: "other_table", needsReference: true, concepts: ["series", "pronoun"], expect: { notMetric: M.failures } },
    ],
  },

  // L — stale reference
  {
    id: "conv-l1",
    category: "L stale",
    turns: [
      { text: "Сравни две последние даты.", concepts: ["comparison"], expect: { primaryType: "comparison" } },
      { text: "Какой из них упал сильнее?", needsReference: true, concepts: ["ranking", "partitive"], expect: { primaryType: "metric_winner" } },
      { text: "Покажи его динамику.", environment: "data_changed", needsReference: true, concepts: ["series", "stale"], expect: {} },
      { text: "А теперь сравни две последние даты заново.", concepts: ["comparison"], expect: { primaryType: "comparison" } },
      { text: "Какой из них упал сильнее?", needsReference: true, concepts: ["ranking", "partitive"], expect: { primaryType: "metric_winner" } },
    ],
  },

  // M — no prior reference
  {
    id: "conv-m1",
    category: "M no history",
    turns: [
      { text: "Покажи его динамику.", needsReference: true, concepts: ["pronoun", "no-history"], expect: { clarifies: true } },
      { text: `Я про «${M.latency}».`, concepts: ["series", "answer"], expect: { winnerMetric: M.latency } },
      { text: "А где он менялся резче всего?", needsReference: true, concepts: ["event", "pronoun"], expect: { primaryType: "event", winnerMetric: M.latency } },
      { text: "Сравни его с показателем, который рос быстрее всех.", needsReference: true, concepts: ["comparison", "ranking"], expect: {} },
      { text: "Покажи динамику того, второго.", needsReference: true, concepts: ["series", "partitive"], expect: { primaryType: "series" } },
    ],
  },

  // N — compound result → follow-up on the primary
  {
    id: "conv-n1",
    category: "N compound→primary follow-up",
    turns: [
      { text: "Найди самый нестабильный показатель, покажи его динамику и скажи, где был самый большой скачок.", concepts: ["compound"], expect: { minSupporting: 1 } },
      { text: "Расскажи подробнее про основной результат.", needsReference: true, concepts: ["primary", "follow-up"], expect: { sameMetricAsPrevious: true } },
      { text: "А какой показатель второй по нестабильности?", needsReference: true, concepts: ["ranking", "partitive"], expect: {} },
      { text: "Покажи его динамику.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "Менял ли он направление?", needsReference: true, concepts: ["direction_changes", "pronoun"], expect: { sameMetricAsPrevious: true } },
    ],
  },

  // O — follow-up on a supporting result, asked for explicitly
  {
    id: "conv-o1",
    category: "O supporting follow-up",
    turns: [
      { text: "Какой показатель вырос сильнее всех между первой и последней датой?", concepts: ["comparison", "ranking"], expect: { primaryType: "metric_winner" } },
      { text: "Покажи всю таблицу сравнения, на которой ты это посчитал.", needsReference: true, concepts: ["supporting", "follow-up"], expect: { universeWithinPrevious: false } },
      { text: "Оставь в ней только выросшие.", needsReference: true, concepts: ["filter", "follow-up"], expect: { universeNarrowerThanPrevious: true } },
      { text: "Сколько их?", needsReference: true, concepts: ["count", "follow-up"], expect: {} },
      { text: "Назови среди них лидера роста.", needsReference: true, concepts: ["ranking", "partitive"], expect: { primaryType: "metric_winner", universeWithinPrevious: true } },
    ],
  },
];

/** §67 — the held-out paraphrase suite: same logical tasks, different wording. */
export const PARAPHRASE_CONVERSATIONS: readonly Conversation[] = [
  {
    id: "para-conv-1",
    category: "A winner→pronoun→series",
    turns: [
      { text: "У какого показателя разница между двумя последними датами наибольшая?", concepts: ["comparison", "ranking"], expect: { primaryType: "metric_winner" } },
      { text: "Выведи его значения по датам.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      { text: "На каком отрезке он дёрнулся сильнее всего?", needsReference: true, concepts: ["event", "pronoun"], expect: { primaryType: "event", sameMetricAsPrevious: true } },
      { text: "Какова величина этого шага?", needsReference: true, concepts: ["event", "follow-up"], expect: { sameMetricAsPrevious: true } },
    ],
  },
  {
    id: "para-conv-2",
    category: "B set→filter→rank→winner",
    turns: [
      { text: "Сопоставь предпоследнюю и последнюю даты.", concepts: ["comparison"], expect: { primaryType: "comparison" } },
      { text: "Убери всё, что не уменьшилось.", needsReference: true, concepts: ["filter", "follow-up"], expect: { universeNarrowerThanPrevious: true } },
      { text: "Среди оставшихся назови худший.", needsReference: true, concepts: ["ranking", "partitive"], expect: { primaryType: "metric_winner", universeWithinPrevious: true } },
      { text: "Дай его ряд по датам.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
    ],
  },
  {
    id: "para-conv-3",
    category: "D period continuity",
    turns: [
      { text: `Сколько составляет «${M.wear}» на самую свежую дату?`, concepts: ["value", "period"], expect: { winnerMetric: M.wear } },
      { text: `Тот же момент времени, но для «${M.latency}» — сколько?`, needsReference: true, concepts: ["value", "period-continuity"], expect: { winnerMetric: M.latency, samePeriodAsPrevious: true } },
      { text: "А относительно предшествующей даты как изменилось?", needsReference: true, concepts: ["comparison", "period-continuity"], expect: { winnerMetric: M.latency } },
      { text: "Покажи весь его ряд.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", winnerMetric: M.latency } },
    ],
  },
  {
    id: "para-conv-4",
    category: "K table switch",
    turns: [
      { text: "Назови показатель с самым большим разбросом.", concepts: ["volatility", "ranking"], expect: { primaryType: "metric_winner" } },
      { text: "Разверни его по датам.", needsReference: true, concepts: ["series", "pronoun"], expect: { primaryType: "series", sameMetricAsPrevious: true } },
      {
        text: "Разверни его по датам.",
        environment: "other_table",
        needsReference: true,
        concepts: ["series", "pronoun", "table-switch"],
        expect: { notMetric: M.failures, metricUniverse: ["Выработка бригады", "Простой оборудования", "Расход материала"] },
      },
      { text: "Который из них скакал сильнее прочих?", environment: "other_table", needsReference: true, concepts: ["ranking", "partitive"], expect: { notMetric: M.failures } },
    ],
  },
  {
    id: "para-conv-5",
    category: "H clarify→resume",
    turns: [
      { text: "Помечай показатель, если он превышает допустимый порог.", concepts: ["ambiguous"], expect: { clarifies: true } },
      { text: "15%", needsReference: true, concepts: ["clarification-reply"], expect: {} },
      { text: "Кто из них выходит за него?", needsReference: true, concepts: ["filter", "follow-up"], expect: {} },
      { text: "Назови самый проблемный.", needsReference: true, concepts: ["ranking", "partitive"], expect: { primaryType: "metric_winner" } },
    ],
  },
];

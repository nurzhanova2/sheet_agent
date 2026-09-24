export interface AgentSmokeCase {
  readonly id: string;
  readonly question: string;
  /** What this case is for, in the report. */
  readonly probes: string;
  /**
   * §28–§31 — the first EXECUTE_CODE to run, replacing the model's.
   *
   * Present only on the controlled-recovery cases. Everything after it is the
   * model's own decision, made from the observation the failure produced.
   */
  readonly forceFirstCode?: string;
  /** Does this case expect the loop to run at all? */
  readonly expect: "complete" | "refusal_or_clarify" | "either";
  /** §32 — a method the agent must NOT silently swap for something else. */
  readonly mustNotBecome?: readonly string[];
}

const NEWLINE = String.fromCharCode(10);
const py = (...lines: readonly string[]): string => lines.join(NEWLINE);

export const AGENT_SMOKE_CASES: readonly AgentSmokeCase[] = [
  {
    id: "smoke-1-clustering",
    question: "Сгруппируй продукты по тому, как они менялись, и опиши получившиеся группы.",
    probes: "§33 — the ordinary multi-step path, with nothing forced.",
    expect: "complete",
  },
  {
    id: "smoke-2-nameerror",
    question: "Сгруппируй продукты по динамике и назови самый необычный продукт в каждой группе.",
    probes: "§28 — NameError recovery. The forced first action uses the name the live runs hallucinated.",
    forceFirstCode: py('labels = entity_df["metric"]', "profile = labels.value_counts()"),
    expect: "complete",
  },
  {
    id: "smoke-3-pandas-api",
    question: "Посчитай, насколько сильно продукты отличаются друг от друга по динамике.",
    probes: "§29 — a pandas method on a numpy array. The observation must be enough to change approach.",
    forceFirstCode: py("clean = X.fillna(0)", "spread = clean.describe()"),
    expect: "complete",
  },
  {
    id: "smoke-4-shape",
    question: "Отбери продукты, которые выросли, и сравни их с остальными.",
    probes: "§30 — a boolean mask of the wrong length. The shapes must reach the model.",
    forceFirstCode: py("mask = np.array([True, False])", "grew = numeric_data[mask]"),
    expect: "complete",
  },
  {
    id: "smoke-5-pca",
    question: "Сократи показатели до двух главных компонент и покажи, как продукты по ним расположены.",
    probes: "A method with real preprocessing requirements — NaN handling must be applied, not just declared.",
    expect: "complete",
    mustNotBecome: ["correlation", "trend"],
  },
  {
    id: "smoke-6-multimethod",
    question: "Попробуй несколько способов сегментации и выбери наиболее интерпретируемый.",
    probes: "§34 — at least two methods must actually EXECUTE. Naming them is not comparing them.",
    expect: "complete",
  },
  {
    id: "smoke-7-exploratory",
    question: "Исследуй таблицу и найди что-нибудь необычное.",
    probes: "§35 — inspect, follow what looks interesting, stop when there is enough. No fixed pipeline.",
    expect: "complete",
  },
  {
    id: "smoke-8-hybrid",
    question: "Сравни показатели за январь и декабрь, а потом сгруппируй продукты по величине изменения.",
    probes: "§13 — a deterministic period resolution followed by sandbox work, in one turn.",
    expect: "complete",
  },
  {
    id: "smoke-9-unsupported",
    question: "Сравни наши показатели с показателями конкурентов за тот же период.",
    probes: "§25/§23 — the data cannot answer this. A refusal or a clarifying question is correct; an invented comparison is not.",
    expect: "refusal_or_clarify",
  },
  {
    id: "smoke-10-impossible-k",
    question: "Раздели продукты на 40 кластеров.",
    probes:
      "§32 — more clusters than rows. Adjusting k or choosing another valid configuration is acceptable; " +
      "silently turning clustering into trend analysis is not.",
    expect: "either",
    mustNotBecome: ["trend", "correlation", "ranking"],
  },
];

/** §46 case 10 in the brief is a conversational follow-up, run only if time permits. */
export const AGENT_SMOKE_FOLLOWUP = {
  id: "smoke-followup",
  question: "А если убрать самый крупный продукт — что изменится?",
  probes: "Whether the second turn reuses the first turn's results rather than recomputing from nothing.",
} as const;

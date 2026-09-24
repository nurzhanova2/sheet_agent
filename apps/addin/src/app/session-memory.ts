import type { CellValue } from "@sheet-agent/application";
import type { ChartData } from "../visualization/types.js";
import type { VerifiedFact } from "../analysis/facts.js";

/** How the conversational runtime classified a turn (Stage 24.3 — declared here to avoid a cycle). */
export type ConversationRoute =
  | "general_chat"
  | "workbook_qa"
  | "workbook_analysis"
  | "workbook_mutation"
  | "mixed";

export type ResultKind =
  | "table"
  | "scalar"
  | "grouped_table"
  | "ranking"
  | "comparison"
  | "filtered_rows"
  | "summary"
  | "chart_source"
  /** Stage 24.6 — a universal-schema summary ("о чём эта таблица"). */
  | "schema_summary"
  /** Stage 24.6 — deterministic analysis over an induced non-flat table schema. */
  | "matrix_analysis"
  | "temporal_analysis";

/**
 * Stage 24.7 §11/§12 — a conversational period reference. Persisted after a
 * comparison / change over an explicit interval so "за этот же период" reuses
 * EXACTLY the same endpoints. Semantic period + exact header paths + freshness.
 */
export interface PeriodRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly kind: "point" | "interval" | "change_horizon";
  /** ISO date / "YYYY" / semantic horizon label. */
  readonly startCanonical: string;
  readonly endCanonical?: string;
  readonly startHeaderPath: string;
  readonly endHeaderPath?: string;
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/** Stage 24.8 §12–§14 — the two independently-predicated intervals of a
 *  `two_interval_filter` analysis, so "в первом интервале… во втором…" reuses
 *  the EXACT same two intervals without re-parsing dates. */
export interface CompositeIntervalRef {
  readonly startCanonical: string;
  readonly endCanonical: string;
  readonly startHeaderPath: string;
  readonly endHeaderPath: string;
}
export interface CompositeAnalysisRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly interval1: CompositeIntervalRef;
  readonly interval2: CompositeIntervalRef;
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/** Stage 24.8 §11/§30/§31 — enough of an explicit-interval `rank` to replay it
 *  with a different basis ("те же 5, но по абсолютному изменению"). */
export interface RankingAnalysisRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly startCanonical: string;
  readonly endCanonical: string;
  readonly startHeaderPath: string;
  readonly endHeaderPath: string;
  readonly limit?: number;
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/**
 * Stage 24.8 §17–§21 — the winning adjacent-period-change event from an
 * `argmax_event` analysis. Follow-ups ("Когда именно это произошло?",
 * "Насколько он изменился?", "Покажи его динамику.") resolve DIRECTLY from
 * this structured value — never by re-analysing the workbook or converting a
 * raw Excel serial in the model.
 */
export interface EventRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly eventType: "adjacent_period_change";
  readonly metricKey: string;
  readonly startCanonical: string;
  readonly endCanonical: string;
  readonly startHeaderPath: string;
  readonly endHeaderPath: string;
  readonly startValue: number;
  readonly endValue: number;
  readonly absoluteChange: number;
  readonly percentageChange: number | null;
  readonly sourceCells: readonly [string, string];
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/** Stage 24.9 §14–§18 — one direction-reversal pivot, persisted verbatim. */
export interface DirectionChangeEventEntry {
  readonly pivotCanonical: string;
  readonly pivotHeaderPath: string;
  readonly previousDirection: "positive" | "negative";
  readonly nextDirection: "positive" | "negative";
  readonly sourceCell: string;
}

/**
 * Stage 24.9 §17/§18/§41–§43 — the single-winner "менял направление чаще
 * всего" result. "Покажи его динамику." / "В какие периоды он менял
 * направление?" resolve DIRECTLY from this — never by re-analysing.
 */
export interface DirectionChangeAnalysisRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly metricKey: string;
  readonly directionChangeCount: number;
  readonly events: readonly DirectionChangeEventEntry[];
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/**
 * Stage 24.9 §4/§8–§10 — an EXPLICIT, bounded set of named metrics under
 * conversational discussion ("Активы и Обязательства"). Reused as the
 * CANDIDATE SET for a follow-up growth comparison ("какой из них вырос
 * сильнее…") — the comparison itself is always recomputed fresh; only the
 * membership is inherited.
 */
export interface MetricSetRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly metricKeys: readonly string[];
  readonly origin: "explicit_user_list" | "previous_result_set" | "previous_ranking" | "previous_filter" | "derived_analysis";
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/** One (metric, score) row of an ordered ranking, for a ResultSetRef. */
export interface ResultSetEntry {
  readonly key: string;
  readonly score: number;
}

/**
 * Stage 24.9 §5–§7/§35/§39/§55 — the ORDERED output of a ranking-shaped
 * analysis (volatility / stability today). "Какой из них самый
 * волатильный?" slices this stored order directly — the full-workbook
 * ranking is NEVER recomputed for such a follow-up.
 */
export interface ResultSetRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly operation: string;
  readonly scoreField: string;
  readonly rows: readonly ResultSetEntry[];
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/**
 * Stage 25.1.3f §3/§5/§6 — the FULL structured result of a successful
 * analytical turn: the continuation universe a compatible follow-up
 * ("теперь покажи только те, что снизились") filters, slices or ranks
 * WITHOUT re-deriving anything from the workbook or from the visible
 * markdown table.
 *
 * Deliberately SEPARATE from `ResultSetRef` (an ordered (metric, score)
 * ranking) and from the turn's narrowed `PrimaryAnswerRef`: a comparison
 * carries several analytical fields per metric (startValue/endValue/
 * absoluteChange/percentageChange), and a later winner-reduction turn may
 * legitimately narrow what the USER SEES to one row while the analytical
 * continuation universe stays whole (§6 — visible answer state and
 * analytical continuation state are separate).
 */
export interface AnalyticalResultSetRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  /** The deterministic tool that produced it ("change.compare_periods", "set.filter", ...). */
  readonly operation: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
  /** The metric universe, in result order — the "из них" candidate set. */
  readonly metricKeys: readonly string[];
  /** The interval the result was computed over, when the run established one. */
  readonly startCanonical?: string;
  readonly endCanonical?: string;
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/**
 * Stage 24.9 §29/§37 — the single metric currently "in focus" for a bare
 * pronoun ("его", "он"). Updated by ANY analysis that pins down one metric
 * (an adjacent-event winner, a direction-change winner, a single-metric
 * subject) — one shared authority, so a pronoun never needs a per-operation
 * special case (§75 — generalize, don't special-case per sentence).
 */
export interface MetricFocusRef {
  readonly metricKey: string;
  readonly order: number;
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

/**
 * Stage 24.8 §27–§29 — the last table an analytical query successfully ran
 * against. When the live selection collapses to a single cell INSIDE this
 * range, the analytical route reads the whole table again, not the one cell —
 * clicking B11 inside a known B5:Q25 table must not shrink the universe.
 */
export interface AnalyticalTableContextRef {
  readonly sheetName: string;
  readonly sourceRange: string;
}

/** A structured result is a bounded reusable payload, never a workbook dump. */
export const MEMORY_LIMITS = {
  maxResults: 4,
  maxRowsPerResult: 200,
  maxColumnsPerResult: 30,
  maxCharts: 3,
  maxSheets: 6,
  maxResolvedEntities: 24,
  /** Ids remembered for "was this evicted?" detection. */
  maxKnownIds: 64,
} as const;

/** A worksheet / column / range identity resolved deterministically (Stage 23 resolver). */
export interface ResolvedWorkbookRef {
  readonly kind: "sheet" | "column" | "range";
  /** Exact resolved sheet or header name, or a sheet-qualified A1 for a range. */
  readonly name: string;
  readonly sheetName?: string;
  readonly turnId: string;
}

/** A reusable analytical result — enough to reuse WITHOUT parsing assistant prose. */
export interface ResultRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly kind: ResultKind;
  readonly sourceSheet: string;
  /** Sheet-qualified A1 the result was computed from. */
  readonly sourceRange: string;
  /** Cheap freshness token for the source (revision / dimensions proxy). */
  readonly sourceVersion: string;
  /**
   * Stage 24.4.4 — freshness tokens for EVERY worksheet range in this result's
   * lineage (an agent period comparison reads two). A mutation on the result is
   * refused if ANY of these changed. `sourceVersion` above stays as the single
   * primary token for backward compatibility.
   */
  readonly sourceVersions?: readonly { readonly sourceRange: string; readonly version: string }[];
  /** One-line human summary — display only, NEVER the canonical payload. */
  readonly title: string;
  /** The canonicalized operation / goal spec that produced it. */
  readonly spec: unknown;
  readonly columns: readonly string[];
  /** The canonical reusable payload — a bounded result grid. */
  readonly rows: readonly (readonly CellValue[])[];
  readonly rowsTruncated: boolean;
  readonly facts: readonly VerifiedFact[];
  readonly resolved: readonly ResolvedWorkbookRef[];
  /**
   * Stage 24.2B — set when this result was produced by a deterministic
   * transform of an earlier result (top N / sort / which-is-worst / column
   * subset), never re-read from the workbook. Points at the parent ResultRef id.
   */
  readonly derivedFromResultId?: string;
  /**
   * Stage 24.4.3 — set when a result derives from TWO OR MORE parents (e.g. an
   * agent period comparison built from a 2024 result and a 2025 result). The
   * single-parent `derivedFromResultId` stays for backward compatibility.
   */
  readonly derivedFromResultIds?: readonly string[];
  /** Stage 24.2B — the transform spec that produced a derived result (display + audit). */
  readonly transform?: unknown;
  /**
   * Stage 24.5 §2 — the entity / grouping column of this result, when it has a
   * clear one (a grouped mean, a ranking, a period comparison). Retained so a
   * follow-up ("выдели их") can ground the entities to source rows WITHOUT
   * re-deriving anything from rendered markdown.
   */
  readonly entityColumn?: string;
  /** Stage 24.5 §2 — canonical entity values aligned to `entityColumn` (bounded). */
  readonly entityValues?: readonly CellValue[];
}

/** A concrete set of source rows identified deterministically (selectMatchingRows / top_n). */
export interface RowSetRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly sourceSheet: string;
  /** The table the rows belong to (sheet-qualified A1). */
  readonly sourceRange: string;
  readonly sourceVersion: string;
  /** 1-based absolute sheet row numbers. */
  readonly sheetRows: readonly number[];
  /** Human description of the predicate, e.g. "Fact < Plan". */
  readonly describe: string;
  readonly count: number;
  readonly truncated: boolean;
  /** Stage 24.3 — retained header names for the row values (bounded). */
  readonly columns?: readonly string[];
  /** Stage 24.3 — retained row values aligned to `sheetRows` / `columns` (bounded). */
  readonly rows?: readonly (readonly CellValue[])[];
  /** Stage 24.3 — the engine condition spec that produced the rows (audit; never re-parsed from prose). */
  readonly conditionSpec?: unknown;
  /** Stage 24.3 — the ResultRef this row set was derived from, when applicable. */
  readonly fromResultId?: string;
}

export interface ChartRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly data: ChartData;
  /** The ResultRef id the chart was built from, when applicable. */
  readonly fromResultId?: string;
  /** Set once the user inserts it into the workbook. */
  readonly placed?: { readonly sheetName: string; readonly shapeName: string };
}

export interface SheetRef {
  readonly id: string;
  readonly turnId: string;
  readonly order: number;
  readonly createdAt: number;
  readonly name: string;
  /** True when SheetAgent created it this session (undo may delete it). */
  readonly createdByAgent: boolean;
}

export type ClarificationKind =
  | "sheet_ambiguous"
  | "column_ambiguous"
  | "dataset_ambiguous"
  | "missing_data"
  | "reference_ambiguous"
  | "reference_missing"
  /** Stage 24.3.1 — `resultToChartData` found several numeric columns; the answer
   *  picks which the chart uses and resumes the SAME ResultRef → ChartData. */
  | "chart_columns"
  /** Stage 24.4 — a bounded agent task paused for a clarification; the answer
   *  resumes the SAME `AgentLoopState` (carried in `agentContinuation`). */
  | "agent"
  | "analytical_agent"
  /** Stage 24.5 §15 — a remembered result has two plausible entity columns; the
   *  answer picks which column an entity action (highlight / copy) grounds on. */
  | "entity_action"
  /** Stage 24.6 §28/§29 — "норма" is undefined; the answer picks whether an
   *  out-of-range check means a statistical outlier or a fixed threshold. The
   *  maxima / minima / peaks were already computed and shown. */
  | "schema_norm"
  /** Stage 24.6.1 §4 — the user chose the fixed-threshold branch but gave no
   *  number; the answer supplies the numeric threshold. */
  | "schema_threshold"
  /** Stage 24.7 §45 — the analytical compiler could not uniquely resolve the
   *  subject / metric; the answer picks one and the SAME request re-compiles. */
  | "analysis_subject"
  /** Stage 24.7.1 §21 — a threshold / signed filter has no explicit period and
   *  no active PeriodRef to inherit; the answer picks a horizon and the SAME
   *  request re-compiles. Never silently guess one arbitrary horizon. */
  | "analysis_period";

export type ClarificationAnswerShape = "one_of" | "one_or_many" | "sheet_name" | "free";

export interface PendingClarification {
  readonly id: string;
  readonly turnId: string;
  readonly createdAt: number;
  /** The verbatim user request that could not be completed. */
  readonly originalPrompt: string;
  readonly route: ConversationRoute;
  readonly kind: ClarificationKind;
  /** Pieces already resolved deterministically — so the user need not restate them. */
  readonly resolved: readonly ResolvedWorkbookRef[];
  /** Safe-to-reuse partial observations (bounded, text only). */
  readonly observations: readonly { readonly label: string; readonly text: string }[];
  /** The candidate choices the user is picking among. */
  readonly candidates: readonly string[];
  /** Stage 24.2 — ids of the candidate structured objects, parallel to `candidates`. */
  readonly targetIds?: readonly string[];
  /** Stage 24.2/24.6 — the ambiguous term (a column word / reference phrase) to substitute on resume. */
  readonly term?: string;
  /** The exact question shown to the user. */
  readonly question: string;
  readonly answerShape: ClarificationAnswerShape;
  /**
   * Stage 24.4 — for `kind: "agent"`, the serialized `AgentLoopState` the resume
   * continues from (typed `unknown` to keep this module free of the agent
   * import; use-agent casts it). Never holds hidden model reasoning.
   */
  readonly agentContinuation?: unknown;
  /**
   * Stage 24.4 §13 — the workbook identity when the clarification was raised. A
   * resume is refused (re-discover instead) if the workbook identity changed.
   */
  readonly sourceIdentity?: string;
  /**
   * Stage 24.5 §15 — for `kind: "entity_action"`, the deterministic action to
   * resume once the user picks an entity column. Never holds model reasoning.
   */
  readonly entityAction?: {
    readonly action: "highlight" | "copy";
    readonly colorHex?: string;
    readonly sheetName?: string;
  };
}

export interface SessionMemory {
  readonly recentResults: readonly ResultRef[];
  readonly lastResultId?: string;
  readonly lastRowSet?: RowSetRef;
  readonly lastChart?: ChartRef;
  readonly lastCreatedSheet?: SheetRef;
  /** Stage 24.7 — the most recent conversational period reference. */
  readonly lastPeriodRef?: PeriodRef;
  /** Stage 24.8 — the most recent two-interval predicate analysis. */
  readonly lastCompositeRef?: CompositeAnalysisRef;
  /** Stage 24.8 — the most recent explicit-interval ranking. */
  readonly lastRankingRef?: RankingAnalysisRef;
  /** Stage 24.8 — the most recent adjacent-period-change event. */
  readonly lastEventRef?: EventRef;
  /** Stage 24.8 §27–§29 — the last table an analytical query ran against. */
  readonly lastAnalyticalTable?: AnalyticalTableContextRef;
  /** Stage 24.9 — the most recent superlative direction-change winner. */
  readonly lastDirectionChangeRef?: DirectionChangeAnalysisRef;
  /** Stage 24.9 — the most recent explicit / reused multi-metric candidate set. */
  readonly lastMetricSetRef?: MetricSetRef;
  /** Stage 24.9 — the most recent ordered ranking-shaped result. */
  readonly lastResultSetRef?: ResultSetRef;
  /** Stage 25.1.3f §3 — the most recent FULL analytical result table, the
   *  structured input universe for a compatible analytical follow-up. */
  readonly lastAnalyticalResultSetRef?: AnalyticalResultSetRef;
  /** Stage 24.9 §29/§37 — the metric currently "in focus" for a bare pronoun. */
  readonly lastMetricFocusRef?: MetricFocusRef;
  readonly resolvedEntities: readonly ResolvedWorkbookRef[];
  readonly pendingClarification?: PendingClarification;
  /** Monotonic ordering counter for every remembered object. */
  readonly seq: number;
  /** Ids that have ever been remembered this session (bounded) — for eviction-aware resolution. */
  readonly knownIds: readonly string[];
}

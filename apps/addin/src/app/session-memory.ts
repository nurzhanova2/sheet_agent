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
  | "column_ambiguous"
  | "dataset_ambiguous"
  | "reference_ambiguous"
  /** Stage 24.3.1 — `resultToChartData` found several numeric columns; the answer
   *  picks which the chart uses and resumes the SAME ResultRef → ChartData. */
  | "chart_columns"
  /** Stage 24.4 — a bounded agent task paused for a clarification; the answer
   *  resumes the SAME `AgentLoopState` (carried in `agentContinuation`). */
  | "agent"
  /** Stage 24.5 §15 — a remembered result has two plausible entity columns; the
   *  answer picks which column an entity action (highlight / copy) grounds on. */
  | "entity_action";

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
  readonly pendingClarification?: PendingClarification;
  /** Monotonic ordering counter for every remembered object. */
  readonly seq: number;
  /** Ids that have ever been remembered this session (bounded) — for eviction-aware resolution. */
  readonly knownIds: readonly string[];
}

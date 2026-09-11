// ---------------------------------------------------------------------------
// Stage 24.5.2 §2/§8/§18 — a bounded, non-sensitive runtime trace for
// result-action turns. NO workbook data dumps: only counts, row-number bounds,
// range strings and rejection reasons. Kept in a small ring buffer, readable
// from `/debug-context` and `__sessionMemoryDebug`.
// ---------------------------------------------------------------------------

export interface ResultActionTrace {
  readonly at: string;
  readonly text: string;
  readonly detectedMutationIntent: boolean;
  readonly detectedResultAction: string | null; // the ResultActionKind, or null
  readonly conversationalReferenceDetected: boolean;
  readonly routeChosen: string;
  readonly memory: {
    readonly lastResultId?: string;
    readonly lastRowSetId?: string;
    readonly lastChartId?: string;
  };
  readonly resolvedReference?: {
    readonly kind: string;
    readonly resultId?: string;
    readonly entityColumn?: string;
    readonly entityValuesCount?: number;
  };
  /**
   * Stage 24.5.4 §20 — for a deterministic grouped-ranking turn ("покажи 3
   * менеджеров с худшим Variance"), the resolved single compositional plan.
   */
  readonly planning?: {
    readonly requestType: "grouped_ranking";
    readonly entityColumn: string;
    readonly metricColumn: string;
    readonly aggregation: "mean";
    readonly direction: "bottom" | "top";
    readonly limit: number;
    readonly operations: readonly string[];
  };
  /**
   * Stage 24.5.3 §14 — every candidate conversational referent considered for
   * this action, oldest-relevant first, so a manual tester can see WHY a
   * particular one was chosen (e.g. a newer result superseding an older row set).
   */
  readonly candidateReferences?: readonly {
    readonly kind: "result" | "rowset" | "chart";
    readonly id: string;
    readonly order: number;
    readonly entityCount?: number;
    readonly fromResultId?: string;
    readonly compatible: boolean;
    readonly note?: string;
  }[];
  /** Short description of the referent actually chosen (kind + id). */
  readonly chosenReference?: string;
  /**
   * Stage 24.6 §48 — bounded schema diagnostics for a universal-table turn.
   * No workbook values.
   */
  readonly tableSchema?: {
    readonly sourceRange: string;
    readonly layoutKind: string;
    readonly orientation: string;
    readonly confidence: number;
    readonly headerDepth: number;
    readonly rowHeaderColumns: number;
    readonly rowAxisCount: number;
    readonly columnAxisCount: number;
    readonly measuresCount: number;
    readonly dateCells: number;
    readonly percentCells: number;
    readonly totalsCount: number;
    readonly ambiguities: readonly string[];
    readonly routeChosen: "flat_table" | "universal_schema" | "clarify";
    readonly analysisRequested: readonly string[];
    readonly analysisCompleted: readonly string[];
    readonly expandedRowsAbove?: number;
  };
  /**
   * Stage 24.7 §72 — the analytical-intent compiler trace. Records requested vs
   * executed periods so a silent date substitution can be detected.
   */
  readonly analyticalCompiler?: {
    readonly originalText: string;
    readonly detectedOperation: string;
    readonly resolvedSubject: string;
    readonly subjectScope: string;
    readonly measureBasis: string;
    readonly compiledSteps: readonly string[];
    readonly planValid: boolean;
    readonly validationErrors: readonly string[];
    readonly routeChosen: string;
    readonly inheritedPeriodRef: boolean;
    readonly requestedStart?: string;
    readonly requestedEnd?: string;
    readonly executedStart?: string;
    readonly executedEnd?: string;
    readonly silentSubstitution: boolean;
    readonly assumptions: readonly string[];
    readonly sourceResultId?: string;
    readonly resultId?: string;
  };
  readonly source?: {
    readonly sheet: string;
    readonly sourceRange: string;
    readonly sourceVersion?: string;
  };
  readonly grounding?: {
    readonly matchedCount: number;
    readonly unmatchedCount: number;
    readonly sheetRowsCount: number;
    readonly sheetRowsMin: number | null;
    readonly sheetRowsMax: number | null;
  };
  readonly actionBuild?: {
    readonly sourceWidth: number;
    readonly contiguousRuns: number;
    readonly chunkedRuns: number;
    readonly actionsBuilt: number;
    readonly rejectedActions: number;
    readonly rejectReasons: readonly string[];
  };
  readonly proposalCreated: boolean;
  readonly outcome: string;
}

/** A mutable draft the routing code fills in as fields become known. */
export type MutableResultActionTrace = {
  -readonly [K in keyof ResultActionTrace]?: ResultActionTrace[K];
} & { text: string };

const MAX_TRACES = 10;
const ring: ResultActionTrace[] = [];

export function pushResultActionTrace(trace: ResultActionTrace): void {
  ring.push(trace);
  if (ring.length > MAX_TRACES) ring.shift();
  try {
    // Console only — copyable from the WebView2 devtools during manual acceptance.
    console.debug("RESULT_ACTION_TRACE", JSON.stringify(trace));
  } catch {
    /* console unavailable */
  }
}

export function getResultActionTraces(): readonly ResultActionTrace[] {
  return [...ring];
}

export function lastResultActionTrace(): ResultActionTrace | undefined {
  return ring[ring.length - 1];
}

/** Flushes a draft (filling required fields with safe defaults). */
export function commitTrace(draft: MutableResultActionTrace): void {
  pushResultActionTrace({
    at: draft.at ?? new Date().toISOString(),
    text: draft.text,
    detectedMutationIntent: draft.detectedMutationIntent ?? false,
    detectedResultAction: draft.detectedResultAction ?? null,
    conversationalReferenceDetected: draft.conversationalReferenceDetected ?? false,
    routeChosen: draft.routeChosen ?? "unknown",
    memory: draft.memory ?? {},
    proposalCreated: draft.proposalCreated ?? false,
    outcome: draft.outcome ?? "unknown",
    ...(draft.resolvedReference ? { resolvedReference: draft.resolvedReference } : {}),
    ...(draft.planning ? { planning: draft.planning } : {}),
    ...(draft.tableSchema ? { tableSchema: draft.tableSchema } : {}),
    ...(draft.analyticalCompiler ? { analyticalCompiler: draft.analyticalCompiler } : {}),
    ...(draft.candidateReferences ? { candidateReferences: draft.candidateReferences } : {}),
    ...(draft.chosenReference ? { chosenReference: draft.chosenReference } : {}),
    ...(draft.source ? { source: draft.source } : {}),
    ...(draft.grounding ? { grounding: draft.grounding } : {}),
    ...(draft.actionBuild ? { actionBuild: draft.actionBuild } : {}),
  });
}

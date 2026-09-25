import type { EngineAnalysis, EngineResult } from "../types.js";
import { fieldIndex, metricFieldIndex } from "../results/result-store.js";
import type { AnalysisRefV2, AnalyticalConversationState, EventRefV2, RefLineage, SeriesRefV2, StoredResultRef, TableRef } from "./conversation-state.js";
import { MAX_RECENT_RESULTS, storeResult } from "./conversation-state.js";

function numberAt(result: EngineResult, row: readonly unknown[], field: string): number | null {
  const i = fieldIndex(result, field);
  if (i < 0) return null;
  const v = row[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** §39 — the full adjacent-period event a single-row event result describes. */
function eventFrom(result: EngineResult): EventRefV2 | null {
  if (result.type !== "event" || result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  const mi = metricFieldIndex(result);
  if (mi < 0) return null;
  const metricKey = String(row[mi] ?? "");
  const startCanonical = String(result.periodCanonicals[0] ?? "");
  const endCanonical = String(result.periodCanonicals[1] ?? "");
  const startValue = numberAt(result, row, "startValue");
  const endValue = numberAt(result, row, "endValue");
  const absoluteChange = numberAt(result, row, "absoluteChange");
  if (!metricKey || !startCanonical || !endCanonical || startValue === null || endValue === null || absoluteChange === null) return null;
  return { metricKey, startCanonical, endCanonical, startValue, endValue, absoluteChange, percentageChange: numberAt(result, row, "percentageChange") };
}

/** §39 — the one metric a result pins down, or `null` when it names a set. */
function singleMetricOf(result: EngineResult): string | null {
  if (result.type === "metric_set" || result.type === "comparison" || result.type === "table") return null;
  return result.metricKeys.length === 1 ? result.metricKeys[0]! : null;
}

/** Stage 26.7 §7 — where a reference came from, carried with the reference. */
function lineageOf(result: EngineResult, table: TableRef): RefLineage {
  return {
    resultId: result.resultId,
    tool: result.tool,
    type: result.type,
    parents: result.parents,
    sheetName: table.sheetName,
    sourceRange: result.sourceRange,
    sourceVersion: result.sourceVersion,
  };
}

/** Stage 26.7 §25 — the per-period history a `series` result IS. */
function seriesFrom(result: EngineResult, table: TableRef): SeriesRefV2 | null {
  if (result.type !== "series" || result.metricKeys.length !== 1) return null;
  return { metricKey: result.metricKeys[0]!, periodCanonicals: result.periodCanonicals, lineage: lineageOf(result, table) };
}

/**
 * Stage 26.7 §26 — the SHAPE of the operation just performed, so a follow-up
 * can continue on the same basis instead of silently re-choosing one. Read
 * from the result's own typed metadata; nothing is inferred from prose.
 */
function analysisFrom(result: EngineResult, table: TableRef): AnalysisRefV2 {
  const ranking = result.metadata["ranking"] as { field?: unknown; magnitude?: unknown } | undefined;
  const basis = result.metadata["basis"];
  return {
    kind: result.type,
    tool: result.tool,
    ...(ranking && typeof ranking.field === "string" ? { rankingField: ranking.field } : {}),
    ...(ranking && typeof ranking.magnitude === "boolean" ? { rankingMagnitude: ranking.magnitude } : {}),
    ...(typeof basis === "string" ? { basis } : {}),
    metricKeys: result.metricKeys,
    lineage: lineageOf(result, table),
  };
}

/**
 * Stage 26.7 §22/§23/§52 — the candidate universe a follow-up "из них" means.
 *
 * Stage 26 took the WIDEST universe the turn stated, which is wrong the moment
 * a turn both narrows and ranks: filtering ten metrics to four and then picking
 * a winner among those four would carry ten forward, and the next "из них"
 * would silently widen back. The universe a request narrowed to is the one it
 * established, so the NARROWEST set of at least two metrics wins — and a
 * ranking's own `candidateResultRef` tells us which set it actually ranked.
 */
function narrowestSetSource(primary: EngineResult, all: readonly EngineResult[]): EngineResult | null {
  const candidates = all.filter((r) => r.metricKeys.length >= 2);
  if (candidates.length === 0) return null;
  // A winner names the set it was chosen from; prefer that over any wider one.
  const namedRef = primary.metadata["candidateResultRef"];
  const named = typeof namedRef === "string" ? candidates.find((r) => r.resultId === namedRef) : undefined;
  if (named) return named;
  if (primary.metricKeys.length >= 2) return primary;
  return candidates.reduce((best, r) => (r.metricKeys.length < best.metricKeys.length ? r : best));
}

/** §9/§55 — primary first, then this turn's supporting results, then history. */
function nextRecent(previous: readonly StoredResultRef[], primary: StoredResultRef, supporting: readonly StoredResultRef[]): readonly StoredResultRef[] {
  const fresh = [primary, ...supporting];
  const seen = new Set(fresh.map((r) => r.resultId));
  return [...fresh, ...previous.filter((r) => !seen.has(r.resultId))].slice(0, MAX_RECENT_RESULTS);
}

export interface CommitInput {
  readonly turnId: string;
  readonly tableRef: TableRef;
  readonly analysis: EngineAnalysis;
}

/**
 * §39/§40 — builds the next state in full, then returns it as ONE value.
 *
 * The primary result decides the focus; supporting results may only FILL a
 * slot the primary left empty (a series alongside an event contributes
 * nothing the event has not already stated), never contradict one.
 */
export function deriveNextState(previous: AnalyticalConversationState, input: CommitInput): AnalyticalConversationState {
  const { primary, supporting } = input.analysis;
  const all = [primary, ...supporting];

  // §40 — assembled locally first; nothing is written until every field agrees.
  let metricKey = singleMetricOf(primary);
  const event = eventFrom(primary) ?? supporting.map(eventFrom).find((e): e is EventRefV2 => e !== null) ?? null;
  if (!metricKey && event) metricKey = event.metricKey;
  if (!metricKey) {
    const fromSupporting = supporting.map(singleMetricOf).filter((m): m is string => m !== null);
    // only when every single-metric supporting result agrees
    if (fromSupporting.length > 0 && new Set(fromSupporting).size === 1) metricKey = fromSupporting[0]!;
  }

  // §22/§23/§52 — the candidate set a follow-up narrows further.
  const setSource = narrowestSetSource(primary, all);

  const periods = primary.periodCanonicals.length > 0 ? primary.periodCanonicals : (all.find((r) => r.periodCanonicals.length > 0)?.periodCanonicals ?? []);
  const periodSource = primary.periodCanonicals.length > 0 ? primary : all.find((r) => r.periodCanonicals.length > 0);
  const series = seriesFrom(primary, input.tableRef) ?? supporting.map((r) => seriesFrom(r, input.tableRef)).find((x): x is SeriesRefV2 => x !== null) ?? null;
  const eventSource = eventFrom(primary) ? primary : all.find((r) => eventFrom(r) !== null);

  const next: AnalyticalConversationState = {
    turnId: input.turnId,
    tableRef: input.tableRef,
    workbookFreshnessToken: input.tableRef.sourceVersion,
    lastResult: { ...storeResult(primary), parents: primary.parents, role: "primary" },
    // §9/§27 — the turn's results in deterministic recency order, primary
    // first, so "the previous result" and "the supporting one" are both
    // reachable without searching history.
    recentResults: nextRecent(
      previous.recentResults ?? [],
      { ...storeResult(primary), parents: primary.parents, role: "primary" },
      supporting.map((r) => ({ ...storeResult(r), parents: r.parents, role: "supporting" as const })),
    ),
    // §26 — what the last operation WAS, structurally.
    lastAnalysis: analysisFrom(primary, input.tableRef),
    ...(series ? { lastSeries: series } : previous.lastSeries && (!metricKey || previous.lastSeries.metricKey === metricKey) ? { lastSeries: previous.lastSeries } : {}),
    ...(metricKey
      ? { lastMetric: { metricKey, lineage: lineageOf(primary, input.tableRef) } }
      : previous.lastMetric
        ? { lastMetric: previous.lastMetric }
        : {}),
    ...(setSource
      ? { lastMetricSet: { metricKeys: setSource.metricKeys, fromResultId: setSource.resultId, lineage: lineageOf(setSource, input.tableRef) } }
      : previous.lastMetricSet
        ? { lastMetricSet: previous.lastMetricSet }
        : {}),
    ...(periods.length > 0
      ? {
          lastPeriod: {
            startCanonical: periods[0]!,
            ...(periods.length > 1 ? { endCanonical: periods[1]! } : {}),
            ...(periodSource ? { lineage: lineageOf(periodSource, input.tableRef) } : {}),
          },
        }
      : previous.lastPeriod
        ? { lastPeriod: previous.lastPeriod }
        : {}),
    // §6 — a SPAN is its own reference; a point never fills this slot.
    ...(periods.length > 1
      ? {
          lastPeriodRange: {
            startCanonical: periods[0]!,
            endCanonical: periods[1]!,
            ...(periodSource ? { lineage: lineageOf(periodSource, input.tableRef) } : {}),
          },
        }
      : previous.lastPeriodRange
        ? { lastPeriodRange: previous.lastPeriodRange }
        : {}),
    ...(event
      ? { lastEvent: { ...event, ...(eventSource ? { lineage: lineageOf(eventSource, input.tableRef) } : {}) } }
      : previous.lastEvent && (!metricKey || previous.lastEvent.metricKey === metricKey)
        ? { lastEvent: previous.lastEvent }
        : {}),
  };

  return next;
}

/**
 * §40 — the atomicity invariant, asserted rather than assumed: a committed
 * state may never carry an event about one metric while claiming another is
 * in focus. Returns the offending detail, or `null` when consistent.
 */
export function stateInconsistency(state: AnalyticalConversationState): string | null {
  if (state.lastEvent && state.lastMetric && state.lastEvent.metricKey !== state.lastMetric.metricKey) {
    return `lastEvent targets "${state.lastEvent.metricKey}" but lastMetric is "${state.lastMetric.metricKey}"`;
  }
  if (state.lastMetric && state.lastMetricSet && state.lastMetricSet.metricKeys.length > 0 && !state.lastMetricSet.metricKeys.includes(state.lastMetric.metricKey)) {
    return `lastMetric "${state.lastMetric.metricKey}" is not a member of lastMetricSet`;
  }
  return null;
}

/** §40 — commit or don't: an inconsistent snapshot leaves the previous state untouched. */
export function commitState(previous: AnalyticalConversationState, input: CommitInput): { readonly state: AnalyticalConversationState; readonly rejected: string | null } {
  const next = deriveNextState(previous, input);
  const problem = stateInconsistency(next);
  return problem ? { state: previous, rejected: problem } : { state: next, rejected: null };
}

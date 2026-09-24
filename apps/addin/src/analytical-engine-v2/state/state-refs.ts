import type { TableSchema } from "../../app/schema/schema-induction.js";
import { toolError, type ToolOutcome } from "../types.js";
import type { AnalyticalConversationState, ReferenceKind, RefLineage } from "./conversation-state.js";

/**
 * §14 — THE projection table. A reference of kind K can stand in for kind V
 * only if the pair appears here, and each pair is covered by a test.
 *
 * Read as "an X can answer a request for a Y":
 *   an event happened TO a metric, and BETWEEN two periods;
 *   a series is the history OF a metric;
 *   a span contains a start point.
 * Nothing projects the other way: a metric does not imply an event, and a
 * point does not imply the range it might have come from.
 */
export const DECLARED_PROJECTIONS: Readonly<Record<ReferenceKind, readonly ReferenceKind[]>> = {
  result: [],
  metric: ["metric"],
  metricSet: ["metricSet"],
  period: ["period"],
  periodRange: ["periodRange", "period"],
  series: ["series", "metric"],
  event: ["event", "metric", "period", "periodRange"],
  analysis: ["analysis"],
};

export function projects(from: ReferenceKind, to: ReferenceKind): boolean {
  return from === to || (DECLARED_PROJECTIONS[from] ?? []).includes(to);
}

/** Human-readable name used in a refusal, so the planner knows what it asked for. */
const KIND_LABEL: Readonly<Record<ReferenceKind, string>> = {
  result: "previous result",
  metricSet: "set of metrics",
  metric: "single metric",
  period: "single period",
  periodRange: "period range",
  series: "metric history",
  event: "adjacent-period event",
  analysis: "record of the last analysis",
};

/** §17 — does this reference still describe the table in front of us? */
export function lineageFreshness(lineage: RefLineage | undefined, schema: TableSchema): "fresh" | "stale" | "other_table" | "unknown" {
  if (!lineage) return "unknown";
  if (lineage.sourceRange !== schema.sourceRange || lineage.sheetName !== schema.sheetName) return "other_table";
  return lineage.sourceVersion === schema.sourceVersion ? "fresh" : "stale";
}

/**
 * §18/§19 — is the remembered conversation about the table we are looking at?
 *
 * Identity is the SHEET and the RANGE, not the selection: clicking another cell
 * inside a table the conversation already analysed changes neither, so the
 * conversation survives (§18). A different sheet or a different range is a
 * different table, and references to the old one must not be reused (§19).
 */
export function sameTable(state: AnalyticalConversationState, schema: TableSchema): boolean {
  const t = state.tableRef;
  if (!t) return false;
  return t.sheetName === schema.sheetName && t.sourceRange === schema.sourceRange;
}

/** §17 — the table is the same one, but its contents have moved on. */
export function tableMovedOn(state: AnalyticalConversationState, schema: TableSchema): boolean {
  return sameTable(state, schema) && state.tableRef!.sourceVersion !== schema.sourceVersion;
}

export interface StateReference {
  readonly kind: ReferenceKind;
  readonly lineage?: RefLineage;
}

/** Which conversation slots currently hold something, in recency order (§9). */
export function availableReferences(state: AnalyticalConversationState): readonly StateReference[] {
  const out: StateReference[] = [];
  const add = (kind: ReferenceKind, lineage?: RefLineage): void => {
    out.push(lineage ? { kind, lineage } : { kind });
  };
  if (state.lastResult) add("result", state.lastResult.parents ? undefined : undefined);
  if (state.lastMetric) add("metric", state.lastMetric.lineage);
  if (state.lastMetricSet) add("metricSet", state.lastMetricSet.lineage);
  if (state.lastPeriod) add("period", state.lastPeriod.lineage);
  if (state.lastPeriodRange) add("periodRange", state.lastPeriodRange.lineage);
  if (state.lastSeries) add("series", state.lastSeries.lineage);
  if (state.lastEvent) add("event", state.lastEvent.lineage);
  if (state.lastAnalysis) add("analysis", state.lastAnalysis.lineage);
  return out;
}

/**
 * Stage 26.7 §17/§19 — where a reference came from, in the least it takes to
 * judge it. `RefLineage` supplies it for a typed reference; a stored result
 * carries its own range and version; `tableRef` is the fallback.
 */
export interface RefProvenance {
  readonly sheetName?: string;
  readonly sourceRange: string;
  readonly sourceVersion: string;
}

export function provenanceOf(lineage: RefLineage | undefined, state: AnalyticalConversationState): RefProvenance | undefined {
  if (lineage) return { sheetName: lineage.sheetName, sourceRange: lineage.sourceRange, sourceVersion: lineage.sourceVersion };
  const t = state.tableRef;
  return t ? { sheetName: t.sheetName, sourceRange: t.sourceRange, sourceVersion: t.sourceVersion } : undefined;
}

/**
 * §13/§15/§17/§19 — the one gate every conversation reference passes through.
 *
 * Three questions, in this order and no other:
 *   1. is there one?                      → NO_PREVIOUS_RESULT
 *   2. is it about the table in front of us? → INCOMPATIBLE_REFERENCE
 *   3. is it still true?                  → STALE_REFERENCE
 *
 * Order matters. A reference whose own provenance says "this table, older
 * version" is STALE, and answering "foreign" there would send the planner off
 * to clarify when recomputing is exactly right. What the reference MEANS for
 * the request is never decided here (§12); when this cannot answer, it says so
 * with a typed code and leaves the planner to clarify (§16).
 */
export function requireReference<T>(
  value: T | undefined,
  kind: ReferenceKind,
  provenance: RefProvenance | undefined,
  state: AnalyticalConversationState,
  schema: TableSchema,
  candidates: readonly string[] = [],
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ToolOutcome } {
  if (value === undefined) {
    const held = availableReferences(state).map((r) => r.kind);
    const projectable = held.filter((k) => projects(k, kind));
    return {
      ok: false,
      error: toolError(
        "NO_PREVIOUS_RESULT",
        `the conversation holds no ${KIND_LABEL[kind]} from an earlier turn` +
          (projectable.length > 0 ? `, though ${projectable.map((k) => KIND_LABEL[k]).join(" and ")} could stand in for one` : "") +
          " — continue from the results you have already computed in this turn",
        candidates,
      ),
    };
  }
  const prov = provenance;
  if (prov) {
    // §19 — a different sheet or a different range is a different table, and
    // the remembered reference describes data the request is not about.
    if (prov.sourceRange !== schema.sourceRange || (prov.sheetName !== undefined && prov.sheetName !== schema.sheetName)) {
      return {
        ok: false,
        error: toolError("INCOMPATIBLE_REFERENCE", `that ${KIND_LABEL[kind]} was computed over a different table than the one selected now, so it cannot be reused here`),
      };
    }
    // §17 — same table, moved on.
    if (prov.sourceVersion !== schema.sourceVersion) {
      return {
        ok: false,
        error: toolError("STALE_REFERENCE", `the table changed since that ${KIND_LABEL[kind]} was computed — recompute it from the workbook`),
      };
    }
    return { ok: true, value };
  }
  // No provenance at all. `tableRef` still rules out a table switch (§19); a
  // reference that can prove nothing either way is not evidence of one.
  if (state.tableRef && !sameTable(state, schema)) {
    return {
      ok: false,
      error: toolError("INCOMPATIBLE_REFERENCE", `that ${KIND_LABEL[kind]} belongs to a different table than the one selected now`),
    };
  }
  return { ok: true, value };
}

/** §13 — a reference was supplied, but of a kind that cannot answer the slot. */
export function incompatibleReference(got: ReferenceKind, wanted: ReferenceKind): ToolOutcome {
  return toolError(
    "INCOMPATIBLE_REFERENCE",
    `${KIND_LABEL[got]} cannot be used where ${KIND_LABEL[wanted]} is required` +
      ((DECLARED_PROJECTIONS[got] ?? []).length > 0 ? ` (it can stand in for: ${DECLARED_PROJECTIONS[got].map((k) => KIND_LABEL[k]).join(", ")})` : ""),
  );
}

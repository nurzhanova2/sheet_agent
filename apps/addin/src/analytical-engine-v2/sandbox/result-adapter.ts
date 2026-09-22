// ---------------------------------------------------------------------------
// Stage 27 §32/§33/§34 — a sandbox result becomes an ordinary engine result.
//
// This is the join that makes hybrid analysis and conversation continuity work
// without either of them being a special case.
//
// §34 wants deterministic tools to run over what the sandbox produced, and §33
// wants "какой кластер самый нестабильный?" to reach back to it a turn later.
// Both fall out for free if a sandbox table enters the ResultStore as a
// `table` — the same type `set.filter`, `set.top` and `set.argmax` already
// accept — rather than as a new kind everything downstream has to learn.
//
// What does NOT cross over is the method. A sandbox result carries how it was
// computed in its metadata, and that metadata is read by the trace (§71), the
// "показать расчёт" surface (§63) and the narrator's method note (§60) — never
// by a tool deciding what to do next. Tools see rows.
// ---------------------------------------------------------------------------

import type { CellValue } from "@sheet-agent/application";
import type { ResultStore } from "../results/result-store.js";
import type { EngineResult, ResultField, ResultId } from "../types.js";
import { readDimension, type ExplorationDimension } from "./exploration.js";
import { executedMethods } from "./method-comparison.js";
import type { RequestedOutput, SandboxPlan, SandboxResult } from "./types.js";

const METRIC_FIELD: ResultField = { name: "metric", kind: "metric" };
const num = (name: string): ResultField => ({ name, kind: "number" });
const text = (name: string): ResultField => ({ name, kind: "text" });

/** What the analysis produced, once it is addressable by the planner. */
export interface StoredAnalysis {
  /** The result that answers the plan's principal output. */
  readonly primary: EngineResult;
  /** Everything stored, primary included, in the order it was stored. */
  readonly all: readonly EngineResult[];
  /** §84/§71 — how it was computed, for the trace and the method note. */
  readonly method: Readonly<Record<string, unknown>>;
}

/**
 * Does a column of strings look like the SUBJECT of the analysis?
 *
 * Used only to decide which column becomes the result's `metric` field, so
 * that "из них выбери…" has something to point at. A table with no such column
 * is stored with all-text fields and simply cannot be ranked by metric — which
 * is correct, not a degradation.
 */
function subjectColumnIndex(columns: readonly string[], rows: readonly (readonly CellValue[])[]): number {
  for (let c = 0; c < columns.length; c += 1) {
    const allText = rows.every((row) => row[c] === null || typeof row[c] === "string");
    const distinct = new Set(rows.map((row) => String(row[c] ?? ""))).size;
    if (allText && distinct === rows.length && rows.length > 0) return c;
  }
  return columns.findIndex((_, c) => rows.every((row) => row[c] === null || typeof row[c] === "string"));
}

function fieldsFor(columns: readonly string[], rows: readonly (readonly CellValue[])[]): { fields: ResultField[]; subject: number } {
  const subject = subjectColumnIndex(columns, rows);
  const fields = columns.map((name, c) => {
    if (c === subject) return METRIC_FIELD;
    const numeric = rows.every((row) => row[c] === null || typeof row[c] === "number");
    return numeric ? num(name) : text(name);
  });
  return { fields, subject };
}

/** §20 — the method record, flattened for metadata and the trace. */
export function methodMetadata(result: SandboxResult, code: string, codeHash: string, attempts: number): Readonly<Record<string, unknown>> {
  return {
    sandbox: true,
    executionId: result.executionId,
    codeHash,
    attempts,
    codeLength: code.length,
    ...(result.method ? { method: result.method.name, parameters: result.method.parameters, ...(result.method.randomState !== undefined ? { randomState: result.method.randomState } : {}) } : {}),
    ...(result.methodComparison ? { methodComparison: result.methodComparison } : {}),
    ...(result.preprocessing ? { preprocessing: result.preprocessing } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(result.diagnostics && Object.keys(result.diagnostics).length > 0 ? { diagnostics: result.diagnostics } : {}),
  };
}

export interface AdaptParams {
  readonly store: ResultStore;
  readonly plan: SandboxPlan;
  readonly result: SandboxResult;
  readonly code: string;
  readonly codeHash: string;
  readonly attempts: number;
  /** §32 — engine results this analysis was composed with (hybrid). */
  readonly parents?: readonly ResultId[];
}

/**
 * §32 — store everything the analysis returned, and name the answer.
 *
 * The primary is chosen from the plan's PRINCIPAL requested output, by shape.
 * Nothing here inspects the numbers to decide which result "looks like" the
 * answer — that is the re-guessing Stage 25.1.3d/e existed to kill, and the
 * planner has already said what it asked for.
 */
export function storeSandboxResult(params: AdaptParams): StoredAnalysis {
  const { store, result, plan } = params;
  const metadata = methodMetadata(result, params.code, params.codeHash, params.attempts);
  const parents = params.parents ?? [];
  const toolName = result.method?.name ? `sandbox.${result.method.name}` : "sandbox.analysis";

  const stored: EngineResult[] = [];
  const byShape = new Map<RequestedOutput["shape"], EngineResult>();

  for (const table of result.tables) {
    const { fields } = fieldsFor(table.columns, table.rows);
    const entry = store.put({
      tool: toolName,
      type: "table",
      fields,
      rows: table.rows,
      parents,
      metadata: { ...metadata, outputName: table.name },
    });
    stored.push(entry);
    if (!byShape.has("table")) byShape.set("table", entry);
  }

  // §20 — the comparison is a table like any other: method down the side,
  // measurements across. Storing it rather than keeping it in metadata is what
  // lets "а почему не иерархическая?" be answered from a result instead of
  // from the narrator's memory, and what puts its numbers inside the §37 fact
  // gate when the planner cites it (§32).
  //
  // It is never the primary. The comparison says how the answer was reached;
  // the answer is whatever the analysis produced.
  const comparison = result.methodComparison;
  if (comparison && executedMethods(comparison).length > 0) {
    const ran = executedMethods(comparison);
    const metricNames = [...new Set(ran.flatMap((m) => Object.keys(m.metrics)))];
    const entry = store.put({
      tool: toolName,
      type: "table",
      fields: [METRIC_FIELD, text("selected"), ...metricNames.map((k) => num(k))],
      rows: ran.map((m) => [m.name, m.name === comparison.selectedMethod ? "yes" : "no", ...metricNames.map((k) => m.metrics[k] ?? null)]),
      metricKeys: ran.map((m) => m.name),
      parents,
      metadata: { ...metadata, outputName: "method_comparison", selectedMethod: comparison.selectedMethod },
    });
    stored.push(entry);
  }

  // §36/§37 — an exploration comes back as findings across several
  // dimensions, and each dimension becomes its OWN result.
  //
  // One result per dimension rather than one per exploration, because the
  // insight layer gives a result a single finding type: a table mixing gaps,
  // correlations and outliers would have to be narrated as one kind of thing,
  // and would be narrated as the wrong one. Split by dimension, every result
  // is homogeneous, each gets the right template, and "расскажи подробнее про
  // аномалии" has something to point at (§32/§33).
  const byDimension = new Map<ExplorationDimension, typeof result.findingsCandidates[number][]>();
  for (const candidate of result.findingsCandidates) {
    const dimension = readDimension(candidate.kind);
    if (!dimension) continue;
    const bucket = byDimension.get(dimension) ?? [];
    bucket.push(candidate);
    byDimension.set(dimension, bucket);
  }
  for (const [dimension, candidates] of byDimension) {
    const valueNames = [...new Set(candidates.flatMap((c) => Object.keys(c.values)))];
    const entry = store.put({
      tool: toolName,
      type: "derived",
      fields: [METRIC_FIELD, ...valueNames.map((n) => num(n))],
      rows: candidates.map((c) => [c.subject, ...valueNames.map((n) => c.values[n] ?? null)]),
      metricKeys: candidates.map((c) => c.subject).filter((s) => s !== ""),
      parents,
      metadata: { ...metadata, outputName: `exploration:${dimension}`, explorationDimension: dimension },
    });
    stored.push(entry);
  }

  // §20 — groups become one addressable table of member → group, so a
  // follow-up can filter, rank or highlight the members of one cluster
  // using the tools that already exist.
  if (result.groups.length > 0) {
    const profileKeys = [...new Set(result.groups.flatMap((g) => Object.keys(g.profile ?? {})))];
    const fields: ResultField[] = [METRIC_FIELD, text("group"), ...profileKeys.map((k) => num(k))];
    const rows: CellValue[][] = [];
    for (const group of result.groups) {
      for (const member of group.members) {
        rows.push([member, group.label, ...profileKeys.map((k) => group.profile?.[k] ?? null)]);
      }
    }
    const entry = store.put({
      tool: toolName,
      type: "table",
      fields,
      rows,
      metricKeys: result.groups.flatMap((g) => g.members),
      parents,
      metadata: { ...metadata, outputName: "groups", groupCount: result.groups.length },
    });
    stored.push(entry);
    byShape.set("groups", entry);
  }

  for (const series of result.series) {
    const rows: CellValue[][] = series.index.map((i, n) => [series.name, String(i), series.values[n] ?? null]);
    const entry = store.put({
      tool: toolName,
      type: "series",
      fields: [METRIC_FIELD, text("periodLabel"), num("value")],
      rows,
      metricKeys: [series.name],
      parents,
      metadata: { ...metadata, outputName: series.name },
    });
    stored.push(entry);
    if (!byShape.has("series")) byShape.set("series", entry);
  }

  const scalarNames = Object.keys(result.scalars);
  if (scalarNames.length > 0) {
    const entry = store.put({
      tool: toolName,
      type: "aggregate",
      fields: [METRIC_FIELD, num("value")],
      rows: scalarNames.map((name) => [name, result.scalars[name] ?? null]),
      metricKeys: scalarNames,
      parents,
      metadata: { ...metadata, outputName: "scalars" },
    });
    stored.push(entry);
    byShape.set("scalar", entry);
  }

  if (result.models.length > 0 && !byShape.has("model")) {
    const entry = store.put({
      tool: toolName,
      type: "derived",
      fields: [text("model"), text("summary")],
      rows: result.models.map((m, i) => [`model_${i + 1}`, JSON.stringify(m).slice(0, 400)]),
      parents,
      metadata: { ...metadata, outputName: "models" },
    });
    stored.push(entry);
    byShape.set("model", entry);
  }

  // Nothing came back in any recognised shape. The executor's §29 check should
  // already have caught this; storing an empty marker keeps the planner's
  // reference valid so it can say so rather than dangling.
  if (stored.length === 0) {
    const entry = store.put({
      tool: toolName,
      type: "derived",
      fields: [text("note")],
      rows: [["the analysis returned no structured output"]],
      parents,
      metadata,
    });
    stored.push(entry);
  }

  const principal = plan.requestedOutputs[0];
  // §36/§37 — an exploration has no single principal result by construction:
  // its answer is the synthesis across dimensions. The first dimension the
  // PLANNER named leads, so the order is the plan's and not the data's.
  const leadDimension = plan.explorationDimensions?.find((d) => byDimension.has(d));
  const exploration = leadDimension ? stored.find((r) => r.metadata["explorationDimension"] === leadDimension) : undefined;
  const primary = exploration ?? (principal ? byShape.get(principal.shape) : undefined) ?? stored[0]!;
  return { primary, all: stored, method: metadata };
}

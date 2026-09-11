import type { AnalysisOutcome } from "./types.js";
import { isAnalysisError } from "./types.js";

function round(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return value;
  return Math.abs(value) >= 1 ? Math.round(value * 1e6) / 1e6 : Math.round(value * 1e9) / 1e9;
}

function deepRound(value: unknown): unknown {
  if (typeof value === "number") return round(value);
  if (Array.isArray(value)) return value.map(deepRound);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, deepRound(entry)]));
  }
  return value;
}

/**
 * Serializes an analysis outcome into the compact, deterministic block that is fed back
 * to the model. No prose, no interpretation — just the exact numbers plus provenance.
 */
export function formatAnalysisOutcome(index: number, request: unknown, outcome: AnalysisOutcome): string {
  const header = `ANALYSIS RESULT #${index + 1}`;
  if (isAnalysisError(outcome)) {
    return `${header} (rejected)\nrequest: ${JSON.stringify(request)}\nerror [${outcome.code}]: ${outcome.error}${outcome.detail ? `\ndetail: ${outcome.detail}` : ""}`;
  }
  const payload = deepRound({
    op: outcome.op,
    source: outcome.source,
    rowsAnalyzed: outcome.rowsAnalyzed,
    ...(outcome.rowsMatched !== undefined ? { rowsMatched: outcome.rowsMatched } : {}),
    ...(outcome.parameters ? { parameters: outcome.parameters } : {}),
    ...(outcome.value !== undefined ? { value: outcome.value } : {}),
    ...(outcome.columns ? { columns: outcome.columns } : {}),
    ...(outcome.rows ? { rows: outcome.rows } : {}),
    ...(outcome.sourceRows ? { sourceSheetRows: outcome.sourceRows } : {}),
    ...(outcome.groups ? { groups: outcome.groups } : {}),
    ...(outcome.statistics ? { statistics: outcome.statistics } : {}),
    truncated: outcome.truncated,
    warnings: outcome.warnings,
  });
  return `${header}\n${JSON.stringify(payload)}`;
}

import type { MethodComparison } from "../sandbox/method-comparison.js";
import type { EngineResult } from "../types.js";
import type { MethodNote } from "./presentation-plan.js";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * §24/§26/§63 — the preprocessing, as the short lines a person can follow.
 *
 * The missing-value policy comes first and is never omitted when one exists.
 * §23's rule is only enforceable if the treatment of gaps is visible: an
 * analysis that excluded eleven rows and an analysis that interpolated them
 * can reach opposite conclusions from the same table, and the reader is
 * entitled to know which one they are reading.
 */
function preprocessingLines(value: unknown): readonly string[] {
  const prep = record(value);
  if (!prep) return [];
  const lines: string[] = [];

  const policy = record(prep["missingValuePolicy"]);
  if (policy) {
    const method = str(policy["method"]);
    const rationale = str(policy["rationale"]);
    const rows = typeof policy["affectedRows"] === "number" ? policy["affectedRows"] : null;
    if (method) {
      const affected = rows !== null && rows > 0 ? ` (${rows})` : "";
      lines.push(rationale ? `${method}${affected}: ${rationale}` : `${method}${affected}`);
    }
  }

  for (const key of ["scaling", "normalization", "encoding", "aggregation", "sampling"] as const) {
    const text = str(prep[key]);
    if (text) lines.push(`${key}: ${text}`);
  }

  const steps = prep["steps"];
  if (Array.isArray(steps)) {
    for (const step of steps) {
      const text = str(step);
      if (text) lines.push(text);
    }
  }
  return lines;
}

/**
 * §19/§20 — the comparison, if the metadata carries a usable one.
 *
 * Shape-checked rather than cast: this value originated in generated Python,
 * and a `selectionCriteria` that arrived as a string instead of a list would
 * otherwise reach `renderComparison` and throw inside narration — turning a
 * cosmetic defect into a failed turn.
 */
function comparisonFrom(value: unknown): MethodComparison | null {
  const raw = record(value);
  if (!raw) return null;
  if (!Array.isArray(raw["methods"]) || raw["methods"].length === 0) return null;
  const selected = str(raw["selectedMethod"]);
  if (!selected) return null;
  const methods = raw["methods"]
    .map((m) => record(m))
    .filter((m): m is Readonly<Record<string, unknown>> => m !== null)
    .map((m) => ({
      name: str(m["name"]) ?? "",
      parameters: record(m["parameters"]) ?? {},
      metrics: Object.fromEntries(Object.entries(record(m["metrics"]) ?? {}).filter(([, v]) => typeof v === "number")) as Record<string, number>,
      warnings: Array.isArray(m["warnings"]) ? m["warnings"].map((w) => String(w)) : [],
    }));
  if (methods.length === 0) return null;
  return {
    methods,
    selectedMethod: selected,
    selectionCriteria: Array.isArray(raw["selectionCriteria"]) ? (raw["selectionCriteria"].map((c) => String(c)) as MethodComparison["selectionCriteria"]) : [],
    selectionEvidence: Object.fromEntries(
      Object.entries(record(raw["selectionEvidence"]) ?? {}).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>,
  };
}

/**
 * §60 — the method note for this answer, or nothing.
 *
 * `undefined` is the normal case and the right one: the deterministic engine
 * answers most questions, and those answers are better without a paragraph
 * about how a sum was computed.
 */
export function methodNoteFor(primary: EngineResult): MethodNote | undefined {
  const metadata = primary.metadata as Readonly<Record<string, unknown>> | undefined;
  if (!metadata || metadata["sandbox"] !== true) return undefined;

  const name = str(metadata["method"]);
  const comparison = comparisonFrom(metadata["methodComparison"]);
  // With neither a named method nor a comparison there is nothing to say, and
  // "Метод: анализ" is worse than silence.
  if (!name && !comparison) return undefined;

  const preprocessing = preprocessingLines(metadata["preprocessing"]);
  const parameters = record(metadata["parameters"]);
  return {
    name: name ?? comparison?.selectedMethod ?? "",
    ...(parameters && Object.keys(parameters).length > 0 ? { parameters } : {}),
    ...(preprocessing.length > 0 ? { preprocessing } : {}),
    ...(comparison ? { comparison } : {}),
  };
}

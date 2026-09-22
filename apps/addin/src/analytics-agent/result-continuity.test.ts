// Stage 25.1.3f §3/§6 — determineContinuationResult unit coverage.
//
// The continuation universe is a pure function of the run's own observations:
// it must never depend on the request text, on a superlative ask, or on the
// narrowed visible answer (§6 — visible answer state and analytical
// continuation state are separate).
import { describe, expect, it } from "vitest";
import type { AgentObservation } from "../agent/types.js";
import { determinePrimaryAnswer } from "./primary-answer.js";
import { determineContinuationResult } from "./result-continuity.js";

function tableObs(tool: string, columns: readonly string[], rows: readonly (readonly unknown[])[], ok = true): AgentObservation {
  return { tool, ok, kind: ok ? "table" : "error", columns, rows: rows as never } as AgentObservation;
}

describe("Stage 25.1.3f §3 — the continuation universe is the run's LAST analytical result, taken whole", () => {
  it("a bare comparison run commits the full comparison table as the universe", () => {
    const rows = Array.from({ length: 19 }, (_, i) => [`M${i}`, i % 2 === 0 ? -0.01 : 0.02]);
    const observations = [
      tableObs("period.list", ["period", "headerPath"], [["2025-12-01", "01.12.2025"]]),
      tableObs("metric.list", ["metric", "semanticClass"], rows.map((r) => [r[0], "amount"])),
      tableObs("change.compare_periods", ["metric", "percentageChange"], rows),
    ];
    const cont = determineContinuationResult(observations);
    expect(cont?.observation.tool).toBe("change.compare_periods");
    expect(cont?.rows).toHaveLength(19);
    expect(cont?.metricKeys).toHaveLength(19);
  });

  it("after compare -> filter, the universe is the RESTRICTED set — never re-widened to the compare table", () => {
    const compare = [["A", -0.01], ["B", -0.14], ["C", 0.02]];
    const observations = [
      tableObs("change.compare_periods", ["metric", "percentageChange"], compare),
      tableObs("set.filter", ["metric", "percentageChange"], [["A", -0.01], ["B", -0.14]]),
    ];
    const cont = determineContinuationResult(observations);
    expect(cont?.observation.tool).toBe("set.filter");
    expect(cont?.metricKeys).toEqual(["A", "B"]);
    expect(cont?.metricKeys).not.toContain("C");
  });

  it("§6 — a superlative turn's universe stays the whole candidate set while the VISIBLE primary narrows to one row", () => {
    const candidates = [["A", -0.0001], ["B", -0.0256], ["C", -0.1379]];
    const observations = [
      tableObs("reference.previous_result_table", ["metric", "percentageChange"], candidates),
      tableObs("set.top", ["metric", "percentageChange"], candidates),
    ];
    const primary = determinePrimaryAnswer(observations, "Из них какой изменился сильнее всего?");
    const cont = determineContinuationResult(observations);
    expect(primary?.observation.rows).toHaveLength(1); // the visible answer narrowed…
    expect(String(primary!.observation.rows![0]![0])).toBe("C");
    expect(cont?.rows).toHaveLength(3); // …the continuation universe did not.
    expect(cont?.metricKeys).toEqual(["A", "B", "C"]);
  });

  it("an echo of stored memory alone never becomes a new universe (the previous one must stand)", () => {
    const observations = [tableObs("reference.previous_result_table", ["metric", "percentageChange"], [["A", -0.01]])];
    expect(determineContinuationResult(observations)).toBeNull();
  });

  it("schema plumbing alone (metric.list / period.list) is never a universe", () => {
    const observations = [
      tableObs("period.list", ["period", "headerPath"], [["2025-12-01", "01.12.2025"]]),
      tableObs("metric.list", ["metric", "semanticClass"], [["A", "amount"]]),
    ];
    expect(determineContinuationResult(observations)).toBeNull();
  });

  it("a failed observation is never a universe, and the last SUCCESSFUL analytical result wins instead", () => {
    const observations = [
      tableObs("change.compare_periods", ["metric", "percentageChange"], [["A", -0.01], ["B", -0.05]]),
      tableObs("set.filter", ["metric", "percentageChange"], [], false),
    ];
    const cont = determineContinuationResult(observations);
    expect(cont?.observation.tool).toBe("change.compare_periods");
  });

  it("an empty result table never replaces a standing universe", () => {
    const observations = [
      tableObs("change.compare_periods", ["metric", "percentageChange"], [["A", -0.01]]),
      tableObs("set.filter", ["metric", "percentageChange"], []),
    ];
    expect(determineContinuationResult(observations)?.observation.tool).toBe("change.compare_periods");
  });

  it("returns null for no observations at all, never throws", () => {
    expect(determineContinuationResult([])).toBeNull();
  });

  it("is independent of the request text — the same observations always yield the same universe", () => {
    const observations = [tableObs("change.compare_periods", ["metric", "percentageChange"], [["A", -0.01], ["B", -0.14]])];
    const a = determineContinuationResult(observations);
    const b = determineContinuationResult(observations);
    expect(a?.metricKeys).toEqual(b?.metricKeys);
    expect(a?.rows).toHaveLength(2);
  });
});

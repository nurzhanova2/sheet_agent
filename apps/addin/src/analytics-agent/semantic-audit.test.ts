import { describe, expect, it } from "vitest";
import type { AgentObservation } from "../agent/types.js";
import {
  auditCandidateSet,
  auditChangeRowSigns,
  auditClauseCompleteness,
  auditClauseTargetConsistency,
  auditExploratoryCardinality,
  auditExploratoryExplanationGrounding,
  auditMeanDeviationNormalization,
  auditObservationChangeSigns,
  auditOperationFidelity,
  auditPeriodFidelity,
  auditRankingBasisFidelity,
  auditResultCardinality,
  auditWinnerConsistency,
  countAnswerShapedOutputs,
  extractExecutedInterval,
  extractTouchedPeriods,
  inferExecutedOperationKind,
  type ExecutedIntervalRef,
} from "./semantic-audit.js";
import type { AgentStep } from "../agent/types.js";

describe("Stage 25.1 §29/§30/§60/§92 — auditChangeRowSigns", () => {
  it("passes a correctly-signed change row", () => {
    const r = auditChangeRowSigns([{ startValue: 100, endValue: 120, absoluteChange: 20, percentageChange: 0.2 }]);
    expect(r.ok).toBe(true);
  });

  it("rejects a row where absoluteChange disagrees with end-start (§92's exact scenario)", () => {
    const r = auditChangeRowSigns([{ startValue: 100, endValue: 120, absoluteChange: 20, percentageChange: -0.2 }]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("CHANGE_SIGN_INCONSISTENT");
  });

  it("rejects a row whose stored absoluteChange doesn't match end-start at all", () => {
    const r = auditChangeRowSigns([{ startValue: 100, endValue: 120, absoluteChange: -5, percentageChange: -0.05 }]);
    expect(r.ok).toBe(false);
  });
});

describe("Stage 25.1 §29 — auditObservationChangeSigns scans real tool observations", () => {
  it("passes a well-formed change.compare_periods observation", () => {
    const obs: AgentObservation[] = [
      {
        tool: "change.compare_periods",
        ok: true,
        kind: "table",
        columns: ["metric", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell"],
        rows: [["Активы", 100, 140, 40, 0.4, "A1", "A2"]],
      },
    ];
    expect(auditObservationChangeSigns(obs).ok).toBe(true);
  });

  it("catches a malformed row inside a real observation shape", () => {
    const obs: AgentObservation[] = [
      {
        tool: "change.compute",
        ok: true,
        kind: "table",
        columns: ["metric", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell"],
        rows: [["Активы", 100, 120, 20, -0.2, "A1", "A2"]],
      },
    ];
    const result = auditObservationChangeSigns(obs);
    expect(result.ok).toBe(false);
  });

  it("ignores unrelated tools entirely", () => {
    const obs: AgentObservation[] = [{ tool: "metric.list", ok: true, kind: "table", columns: ["metric", "semanticClass"], rows: [["Активы", "amount"]] }];
    expect(auditObservationChangeSigns(obs).ok).toBe(true);
  });
});

describe("Stage 25.1 §17/§69/§89 — auditCandidateSet", () => {
  it("passes when no explicit set was requested", () => {
    expect(auditCandidateSet(null, ["Активы", "Обязательства", "Ликвидные активы"]).ok).toBe(true);
  });

  it("passes an exact match", () => {
    expect(auditCandidateSet(["Активы", "Обязательства"], ["Активы", "Обязательства"]).ok).toBe(true);
  });

  it("fails CANDIDATE_SET_WIDENED when the executed universe includes unrequested metrics (§89)", () => {
    const r = auditCandidateSet(["Активы", "Обязательства", "Собственный капитал"], ["Активы", "Обязательства", "Собственный капитал", "Ликвидные активы", "уровень долларизации вкладов физлиц"]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("CANDIDATE_SET_WIDENED");
  });

  it("fails CANDIDATE_SET_NARROWED when a requested metric is silently dropped", () => {
    const r = auditCandidateSet(["Активы", "Обязательства", "Собственный капитал"], ["Активы", "Обязательства"]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("CANDIDATE_SET_NARROWED");
  });
});

const ANCHORS = { first: "2024-01-01", previous: "2025-11-01", last: "2025-12-01" };

function interval(startPeriod: string, endPeriod: string, sourceOperation = "change.compare_periods"): ExecutedIntervalRef {
  return { startPeriod, endPeriod, sourceOperation };
}

describe("Stage 25.1.2 §2/§3/§6/§7/§19/§41 — auditPeriodFidelity (final executed interval, not every touched period)", () => {
  it("passes when no explicit temporal mode was requested", () => {
    expect(auditPeriodFidelity(null, interval("2024-01-01", "2025-12-01"), ANCHORS).ok).toBe(true);
  });

  it("passes previous_to_last when the final interval is exactly previous->last", () => {
    expect(auditPeriodFidelity("previous_to_last", interval("2025-11-01", "2025-12-01"), ANCHORS).ok).toBe(true);
  });

  it("fails PERIOD_SUBSTITUTION when previous_to_last executed as first->last (§41's exact release-blocker scenario)", () => {
    const r = auditPeriodFidelity("previous_to_last", interval("2024-01-01", "2025-12-01"), ANCHORS);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("PERIOD_SUBSTITUTION");
  });

  it("passes first_to_last when the final interval is exactly first->last, fails otherwise", () => {
    expect(auditPeriodFidelity("first_to_last", interval("2024-01-01", "2025-12-01"), ANCHORS).ok).toBe(true);
    expect(auditPeriodFidelity("first_to_last", interval("2025-11-01", "2025-12-01"), ANCHORS).ok).toBe(false);
  });

  it("§2 — fails (never silently passes) when no final interval was found at all", () => {
    const r = auditPeriodFidelity("previous_to_last", null, ANCHORS);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("PERIOD_SUBSTITUTION");
  });

  it("§3 — P4->P5 fixture dates pass previous_to_last; P1->P5 is rejected", () => {
    const fixtureAnchors = { first: "2024-01-01", previous: "2025-11-01", last: "2025-12-01" };
    expect(auditPeriodFidelity("previous_to_last", interval("2025-11-01", "2025-12-01"), fixtureAnchors).ok).toBe(true);
    expect(auditPeriodFidelity("previous_to_last", interval("2024-01-01", "2025-12-01"), fixtureAnchors).ok).toBe(false);
  });
});

describe("Stage 25.1.2 §2/§3 — extractExecutedInterval reads the FINAL calculation, ignoring schema-exploration plumbing", () => {
  function toolCallStep(tool: string, input: Readonly<Record<string, unknown>>, observation: AgentObservation): AgentStep {
    return { iteration: 0, decision: { kind: "tool_call", tool, input }, observation, durationMs: 0 };
  }

  it("reads startPeriod/endPeriod from change.compare_periods' own INPUT, ignoring an earlier period.list of all 5 periods", () => {
    const steps: AgentStep[] = [
      toolCallStep("period.list", {}, { tool: "period.list", ok: true, kind: "table", columns: ["period", "headerPath"], rows: [["P1", "01.01.2024"], ["P2", "01.12.2024"], ["P3", "01.01.2025"], ["P4", "01.11.2025"], ["P5", "01.12.2025"]] }),
      toolCallStep("period.select", { selector: "last" }, { tool: "period.select", ok: true, kind: "table", columns: ["period", "headerPath"], rows: [["P5", "01.12.2025"]] }),
      toolCallStep("period.select", { selector: "previous_of", of: "P5" }, { tool: "period.select", ok: true, kind: "table", columns: ["period", "headerPath"], rows: [["P4", "01.11.2025"]] }),
      toolCallStep("metric.list", {}, { tool: "metric.list", ok: true, kind: "table", columns: ["metric", "semanticClass"], rows: [["Активы", "amount"]] }),
      toolCallStep("change.compare_periods", { startPeriod: "P4", endPeriod: "P5" }, { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell"], rows: [["Активы", 100, 110, 10, 0.1, "A1", "A2"]] }),
    ];
    const found = extractExecutedInterval(steps);
    expect(found).toEqual({ startPeriod: "P4", endPeriod: "P5", sourceOperation: "change.compare_periods" });
  });

  it("reads canonical periods from an event.max_adjacent_change OUTPUT when no change.* call exists", () => {
    const steps: AgentStep[] = [
      toolCallStep(
        "event.max_adjacent_change",
        { metric: "Активы" },
        {
          tool: "event.max_adjacent_change",
          ok: true,
          kind: "table",
          columns: ["metric", "startPeriod", "endPeriod", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell", "startPeriodCanonical", "endPeriodCanonical"],
          rows: [["Активы", "01.11.2025", "01.12.2025", 100, 110, 10, 0.1, "A1", "A2", "P4", "P5"]],
        },
      ),
    ];
    expect(extractExecutedInterval(steps)).toEqual({ startPeriod: "P4", endPeriod: "P5", sourceOperation: "event.max_adjacent_change" });
  });

  it("returns null when nothing in the trace defines a two-point interval", () => {
    const steps: AgentStep[] = [toolCallStep("metric.list", {}, { tool: "metric.list", ok: true, kind: "table", columns: ["metric"], rows: [["A"]] })];
    expect(extractExecutedInterval(steps)).toBeNull();
  });

  it("ignores a failed tool_call step even if it names the right tool", () => {
    const steps: AgentStep[] = [toolCallStep("change.compare_periods", { startPeriod: "P1", endPeriod: "P5" }, { tool: "change.compare_periods", ok: false, kind: "error", error: "NO_COMMON_PERIOD: x" })];
    expect(extractExecutedInterval(steps)).toBeNull();
  });
});

describe("Stage 25.1.1 §5/§37/§38/§58 — inferExecutedOperationKind / auditOperationFidelity", () => {
  it("infers historical_extreme_distance from aggregate.max + derive.compute", () => {
    const obs: AgentObservation[] = [
      { tool: "aggregate.max", ok: true, kind: "table", columns: ["metric", "value"], rows: [["A", 100]] },
      { tool: "derive.compute", ok: true, kind: "table", columns: ["metric", "value", "distance"], rows: [["A", 90, 0.1]] },
    ];
    expect(inferExecutedOperationKind(obs)).toBe("historical_extreme_distance");
  });

  it("infers stable_growth from volatility/stability + a change comparison", () => {
    const obs: AgentObservation[] = [
      { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric"], rows: [["A"]] },
      { tool: "analysis.stability", ok: true, kind: "table", columns: ["metric", "score"], rows: [["A", 0.9]] },
    ];
    expect(inferExecutedOperationKind(obs)).toBe("stable_growth");
  });

  it("§58 — WRONG_OPERATION when requested historical_extreme_distance but executed a plain change comparison", () => {
    const obs: AgentObservation[] = [{ tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric"], rows: [["A"]] }];
    const r = auditOperationFidelity("historical_extreme_distance", obs);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("WRONG_OPERATION");
  });

  it("never false-rejects trend_vs_latest_direction (§29's explicit preserve-as-is exemption)", () => {
    const r = auditOperationFidelity("trend_vs_latest_direction", []);
    expect(r.ok).toBe(true);
  });

  it("does not reject an ambiguous (unrecognized) tool sequence — avoids false positives", () => {
    const r = auditOperationFidelity("stable_growth", [{ tool: "schema.describe", ok: true, kind: "text" }]);
    expect(r.ok).toBe(true);
  });
});

describe("Stage 25.1.1 §16/§17/§61 — auditClauseCompleteness", () => {
  it("§61 — 3 requested, 2 executed → CLAUSE_DROPPED", () => {
    const r = auditClauseCompleteness(3, 2);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("CLAUSE_DROPPED");
  });

  it("passes when executed meets or exceeds requested", () => {
    expect(auditClauseCompleteness(2, 2).ok).toBe(true);
    expect(auditClauseCompleteness(2, 3).ok).toBe(true);
  });

  it("countAnswerShapedOutputs counts distinct answer tools, ignoring plumbing", () => {
    const obs: AgentObservation[] = [
      { tool: "metric.list", ok: true, kind: "table", columns: ["metric"], rows: [["A"]] },
      { tool: "period.select", ok: true, kind: "table", columns: ["period"], rows: [["2025-12-01"]] },
      { tool: "analysis.volatility", ok: true, kind: "table", columns: ["metric", "score"], rows: [["A", 0.5]] },
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value"], rows: [["A", "2025-12-01", 1]] },
    ];
    expect(countAnswerShapedOutputs(obs)).toBe(2);
  });
});

describe("Stage 25.1.1 §20/§62 — auditClauseTargetConsistency", () => {
  it("passes when every dependent clause targets the same metric", () => {
    const obs: AgentObservation[] = [
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value"], rows: [["обратное РЕПО", "2025-12-01", 1]] },
      { tool: "event.max_adjacent_change", ok: true, kind: "table", columns: ["metric", "startPeriod", "endPeriod"], rows: [["обратное РЕПО", "2025-11-01", "2025-12-01"]] },
    ];
    expect(auditClauseTargetConsistency(obs).ok).toBe(true);
  });

  it("§62 — fails CLAUSE_TARGET_MISMATCH when clauses target different metrics", () => {
    const obs: AgentObservation[] = [
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value"], rows: [["обратное РЕПО", "2025-12-01", 1]] },
      { tool: "event.max_adjacent_change", ok: true, kind: "table", columns: ["metric", "startPeriod", "endPeriod"], rows: [["доля ликвидных активов в активах", "2025-11-01", "2025-12-01"]] },
    ];
    const r = auditClauseTargetConsistency(obs);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("CLAUSE_TARGET_MISMATCH");
  });
});

describe("Stage 25.1.1 §53 — extractTouchedPeriods", () => {
  it("collects distinct canonical periods from period.select/period.list observations", () => {
    const obs: AgentObservation[] = [
      { tool: "period.select", ok: true, kind: "table", columns: ["period", "headerPath"], rows: [["2025-12-01", "01.12.2025"]] },
      { tool: "period.select", ok: true, kind: "table", columns: ["period", "headerPath"], rows: [["2025-11-01", "01.11.2025"]] },
    ];
    expect(extractTouchedPeriods(obs).sort()).toEqual(["2025-11-01", "2025-12-01"]);
  });
});

describe("Stage 25.1.3 §10/§12/§44/§45 — auditClauseTargetConsistency now compares against the winner", () => {
  it("§44 — PASS: C1 winner=A, C2 series target=A, C3 event target=A", () => {
    const obs: AgentObservation[] = [
      { tool: "set.argmax", ok: true, kind: "table", columns: ["metric", "score"], rows: [["A", 0.9]] },
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value"], rows: [["A", "2025-12-01", 1]] },
      { tool: "event.max_adjacent_change", ok: true, kind: "table", columns: ["metric", "startPeriod", "endPeriod"], rows: [["A", "2025-11-01", "2025-12-01"]] },
    ];
    expect(auditClauseTargetConsistency(obs).ok).toBe(true);
  });

  it("§45 — CLAUSE_TARGET_MISMATCH: C1 winner=A, C2 series target=B (the winner disagrees with the consumer)", () => {
    const obs: AgentObservation[] = [
      { tool: "set.argmax", ok: true, kind: "table", columns: ["metric", "score"], rows: [["A", 0.9]] },
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value"], rows: [["B", "2025-12-01", 1]] },
    ];
    const r = auditClauseTargetConsistency(obs);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("CLAUSE_TARGET_MISMATCH");
  });

  it("a multi-row supporting table (not a single winner) does not itself constrain the target", () => {
    const obs: AgentObservation[] = [
      { tool: "set.filter", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["A", -0.1], ["C", -0.2]] },
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value"], rows: [["A", "2025-12-01", 1]] },
    ];
    expect(auditClauseTargetConsistency(obs).ok).toBe(true);
  });
});

describe("Stage 25.1.3 §23/§24/§49 — auditExploratoryCardinality", () => {
  it("passes when no cardinality was requested", () => {
    expect(auditExploratoryCardinality(null, 19).ok).toBe(true);
  });

  it("§49 — requested 3, returned 19 → EXPLORATORY_CARDINALITY_MISMATCH", () => {
    const r = auditExploratoryCardinality(3, 19);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("EXPLORATORY_CARDINALITY_MISMATCH");
  });

  it("requested 3, returned 2 → also fails (under-selection is just as wrong)", () => {
    expect(auditExploratoryCardinality(3, 2).ok).toBe(false);
  });

  it("requested 3, returned exactly 3 → passes", () => {
    expect(auditExploratoryCardinality(3, 3).ok).toBe(true);
  });
});

describe("Stage 25.1.3 §25/§50 — auditExploratoryExplanationGrounding", () => {
  it("passes when no cardinality was requested", () => {
    expect(auditExploratoryExplanationGrounding(null, ["metric"]).ok).toBe(true);
  });

  it("§50 — a bare metric column with no computed diagnostic value fails", () => {
    const r = auditExploratoryExplanationGrounding(3, ["metric"]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("EXPLORATORY_EXPLANATION_MISSING");
  });

  it("passes once at least one diagnostic column backs the selection", () => {
    expect(auditExploratoryExplanationGrounding(3, ["metric", "score"]).ok).toBe(true);
  });
});

describe("Stage 25.1.3 §33–§35 — auditMeanDeviationNormalization", () => {
  function deriveStep(exprOp: string): AgentStep {
    return {
      iteration: 0,
      decision: { kind: "tool_call", tool: "derive.compute", input: { source: "res_1", field: "deviation", expr: { op: exprOp, left: {}, right: {} } } },
      observation: { tool: "derive.compute", ok: true, kind: "table", columns: ["metric", "deviation"], rows: [["A", 0.2]] },
      durationMs: 0,
    };
  }

  it("passes when the request is not latest_vs_mean", () => {
    expect(auditMeanDeviationNormalization(null, [deriveStep("subtract")]).ok).toBe(true);
  });

  it("§35 — a raw (non-divided) deviation fails UNNORMALIZED_MEAN_DEVIATION", () => {
    const r = auditMeanDeviationNormalization("latest_vs_mean", [deriveStep("subtract")]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("UNNORMALIZED_MEAN_DEVIATION");
  });

  it("a normalized (division-rooted) deviation passes", () => {
    expect(auditMeanDeviationNormalization("latest_vs_mean", [deriveStep("divide")]).ok).toBe(true);
  });

  it("does not false-reject when no derive.compute step exists at all", () => {
    expect(auditMeanDeviationNormalization("latest_vs_mean", []).ok).toBe(true);
  });
});

describe("Stage 25.1.3b §2/§3/§7/§18 — auditRankingBasisFidelity", () => {
  function rankStep(tool: string, field: string): AgentStep {
    return {
      iteration: 0,
      decision: { kind: "tool_call", tool, input: { field } },
      observation: { tool, ok: true, kind: "table", columns: ["metric", field], rows: [["A", -0.1]] },
      durationMs: 0,
    };
  }

  it("passes when no ranking basis was requested", () => {
    expect(auditRankingBasisFidelity(null, [rankStep("set.sort", "absoluteChange")]).ok).toBe(true);
  });

  it("§18 — requested percentage magnitude, executed absoluteChange sort → RANKING_BASIS_MISMATCH", () => {
    const r = auditRankingBasisFidelity("percentageChange", [rankStep("set.sort", "absoluteChange")]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("RANKING_BASIS_MISMATCH");
  });

  it("requested percentage magnitude, executed percentageChange sort → PASS", () => {
    expect(auditRankingBasisFidelity("percentageChange", [rankStep("set.sort", "percentageChange")]).ok).toBe(true);
  });

  it("requested absoluteChange, executed percentageChange sort → RANKING_BASIS_MISMATCH", () => {
    const r = auditRankingBasisFidelity("absoluteChange", [rankStep("set.top", "percentageChange")]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("RANKING_BASIS_MISMATCH");
  });

  it("requested absoluteChange, executed absoluteChange sort → PASS", () => {
    expect(auditRankingBasisFidelity("absoluteChange", [rankStep("set.argmax", "absoluteChange")]).ok).toBe(true);
  });

  it("does not false-reject an ambiguous/unrecognized field name", () => {
    expect(auditRankingBasisFidelity("percentageChange", [rankStep("set.sort", "score")]).ok).toBe(true);
  });

  it("does not false-reject when no ranking step exists at all", () => {
    expect(auditRankingBasisFidelity("percentageChange", []).ok).toBe(true);
  });
});

describe("Stage 25.1.3d §7/§8/§18/§19 — auditResultCardinality", () => {
  it("passes when no singular result was requested, regardless of row count", () => {
    expect(auditResultCardinality(false, 11).ok).toBe(true);
    expect(auditResultCardinality(false, 0).ok).toBe(true);
  });

  it("§19 — a singular ask with a primary of exactly 1 row → PASS", () => {
    expect(auditResultCardinality(true, 1).ok).toBe(true);
  });

  it("§8 — a singular ask whose primary still has multiple rows → RESULT_SHAPE_MISMATCH", () => {
    const r = auditResultCardinality(true, 11);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("RESULT_SHAPE_MISMATCH");
  });

  it("does not false-reject when there is no primary result at all (a different audit/narration path handles that)", () => {
    expect(auditResultCardinality(true, null).ok).toBe(true);
    expect(auditResultCardinality(true, 0).ok).toBe(true);
  });
});

describe("Stage 25.1.3e §9 — auditWinnerConsistency", () => {
  it("passes when the primary answer and the semantic winner name the same metric", () => {
    expect(auditWinnerConsistency("обратное РЕПО", "обратное РЕПО").ok).toBe(true);
  });

  it("fails with WINNER_CONSISTENCY_MISMATCH when they disagree", () => {
    const r = auditWinnerConsistency("займы клиентам", "обратное РЕПО");
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe("WINNER_CONSISTENCY_MISMATCH");
  });

  it("never false-rejects when either side has nothing to compare", () => {
    expect(auditWinnerConsistency(null, "обратное РЕПО").ok).toBe(true);
    expect(auditWinnerConsistency("обратное РЕПО", null).ok).toBe(true);
    expect(auditWinnerConsistency(null, null).ok).toBe(true);
  });
});

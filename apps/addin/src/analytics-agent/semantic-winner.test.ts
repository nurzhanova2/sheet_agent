// Stage 25.1.3 §42/§43 — determineSemanticWinner unit coverage.
import { describe, expect, it } from "vitest";
import type { AgentObservation } from "../agent/types.js";
import { determineSemanticWinner, determineSemanticWinnerMatch } from "./semantic-winner.js";

function tableObs(tool: string, columns: readonly string[], rows: readonly (readonly unknown[])[]): AgentObservation {
  return { tool, ok: true, kind: "table", columns, rows: rows as never } as AgentObservation;
}

describe("Stage 25.1.3 §42 — a multi-row result can still have one semantic winner", () => {
  it("a sorted 3-row ranking's row[0] is the winner when the ask is superlative", () => {
    const obs = [tableObs("set.sort", ["metric", "percentageChange"], [["B", -0.5], ["A", -0.2], ["C", -0.1]])];
    expect(determineSemanticWinner(obs, true)).toBe("B");
  });

  it("does NOT infer a winner from a sorted multi-row table without a superlative ask", () => {
    const obs = [tableObs("set.sort", ["metric", "percentageChange"], [["B", -0.5], ["A", -0.2], ["C", -0.1]])];
    expect(determineSemanticWinner(obs, false)).toBeNull();
  });
});

describe("Stage 25.1.3 §43 — a fresh winner always outranks an older one", () => {
  it("the MOST RECENT qualifying observation wins, not the first", () => {
    const obs = [
      tableObs("set.argmax", ["metric", "score"], [["X", 1]]),
      tableObs("set.argmax", ["metric", "score"], [["B", 2]]),
    ];
    expect(determineSemanticWinner(obs, false)).toBe("B");
  });

  it("a later ranked-winner observation outranks an earlier single-row winner", () => {
    const obs = [
      tableObs("aggregate.max", ["metric", "value"], [["X", 100]]),
      tableObs("set.sort", ["metric", "percentageChange"], [["B", -0.5], ["A", -0.2]]),
    ];
    expect(determineSemanticWinner(obs, true)).toBe("B");
  });
});

describe("Stage 25.1.3 — single-row winner tools are unambiguous regardless of superlative wording", () => {
  it("set.argmax with one row always wins", () => {
    const obs = [tableObs("set.argmax", ["metric", "score"], [["B", 2]])];
    expect(determineSemanticWinner(obs, false)).toBe("B");
  });

  it("ignores unrelated tools and empty results", () => {
    const obs = [tableObs("metric.list", ["metric", "semanticClass"], [["A", "amount"], ["B", "amount"]])];
    expect(determineSemanticWinner(obs, true)).toBeNull();
  });
});

describe("Stage 25.1.3d §11 — determineSemanticWinnerMatch returns the SOURCE observation, unchanged winner selection", () => {
  it("returns the exact observation the winner was read from (event.max_adjacent_change)", () => {
    const eventObs = tableObs("event.max_adjacent_change", ["metric", "startPeriod", "endPeriod"], [["B", "01.12.2024", "01.11.2025"]]);
    const match = determineSemanticWinnerMatch([eventObs], false);
    expect(match?.metricKey).toBe("B");
    expect(match?.observation).toBe(eventObs);
  });

  it("determineSemanticWinner still returns the SAME bare key as determineSemanticWinnerMatch (delegation, no behavior change)", () => {
    const obs = [tableObs("set.sort", ["metric", "percentageChange"], [["B", -0.5], ["A", -0.2], ["C", -0.1]])];
    expect(determineSemanticWinner(obs, true)).toBe(determineSemanticWinnerMatch(obs, true)?.metricKey);
  });

  it("returns null under the exact same conditions determineSemanticWinner returns null", () => {
    const obs = [tableObs("set.sort", ["metric", "percentageChange"], [["B", -0.5]])];
    expect(determineSemanticWinnerMatch(obs, false)).toBeNull();
    expect(determineSemanticWinner(obs, false)).toBeNull();
  });
});

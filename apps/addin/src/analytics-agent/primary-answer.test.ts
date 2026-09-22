// Stage 25.1.3d §3-§8/§18/§19 — determinePrimaryAnswer unit coverage.
import { describe, expect, it } from "vitest";
import type { AgentObservation } from "../agent/types.js";
import { determinePrimaryAnswer, determineValidatedWinner } from "./primary-answer.js";

function tableObs(tool: string, columns: readonly string[], rows: readonly (readonly unknown[])[]): AgentObservation {
  return { tool, ok: true, kind: "table", columns, rows: rows as never } as AgentObservation;
}

describe("Stage 25.1.3d §4/§18 — compare -> filter: the filter output is primary, never the upstream compare table", () => {
  it("§18 — a 19-metric compare followed by a decline filter: primary is ONLY the filtered set, no positive rows", () => {
    const compareRows = Array.from({ length: 19 }, (_, i) => [`M${i}`, i % 2 === 0 ? -0.01 : 0.02]);
    const declineRows = compareRows.filter((r) => (r[1] as number) < 0); // the even-indexed rows only
    const observations = [
      tableObs("change.compare_periods", ["metric", "percentageChange"], compareRows),
      tableObs("set.filter", ["metric", "percentageChange"], declineRows),
    ];
    const primary = determinePrimaryAnswer(observations, "Теперь покажи только показатели, которые снизились.");
    expect(primary?.confident).toBe(true);
    expect(primary?.observation.tool).toBe("set.filter");
    expect(primary?.observation.rows).toHaveLength(declineRows.length);
    // no positive-change row leaked into the primary answer.
    for (const row of primary!.observation.rows!) expect(Number(row[1])).toBeLessThan(0);
  });
});

describe("Stage 25.1.3d §4 — compare -> filter -> rank: the rank/winner output is primary, never the filter output", () => {
  it("a set.sort AFTER a set.filter supersedes the filter as primary", () => {
    const observations = [
      tableObs("change.compare_periods", ["metric", "percentageChange"], [["A", -0.01], ["B", -0.14], ["C", 0.02]]),
      tableObs("set.filter", ["metric", "percentageChange"], [["A", -0.01], ["B", -0.14]]),
      tableObs("set.sort", ["metric", "percentageChange"], [["B", -0.14], ["A", -0.01]]),
    ];
    const primary = determinePrimaryAnswer(observations, "какой изменился сильнее всего?");
    // superlative reduction wins here: exactly one row, the true winner.
    expect(primary?.observation.rows).toHaveLength(1);
    expect(String(primary!.observation.rows![0]![0])).toBe("B");
  });
});

describe("Stage 25.1.3d §7/§19 — a singular superlative ask reduces the primary to exactly one winner row", () => {
  it("§19 — the largest |percentageChange| among a supplied decline set wins, never the whole set", () => {
    const declineRows = [
      ["client_deposits", -0.0256],
      ["reverse_repo", -0.1379],
      ["legal_deposits", -0.0391],
    ];
    const observations = [
      tableObs("change.compare_periods", ["metric", "percentageChange"], declineRows),
      tableObs("set.sort", ["metric", "percentageChange"], [...declineRows].sort((a, b) => (a[1] as number) - (b[1] as number))),
    ];
    const primary = determinePrimaryAnswer(observations, "Из них какой изменился сильнее всего?");
    expect(primary?.observation.rows).toHaveLength(1);
    expect(String(primary!.observation.rows![0]![0])).toBe("reverse_repo");
  });

  it("no superlative ask leaves a multi-row filtered/sorted result intact (never over-reduced to 1 row)", () => {
    const rows = [["A", -0.14], ["B", -0.05]];
    const observations = [tableObs("set.filter", ["metric", "percentageChange"], rows)];
    const primary = determinePrimaryAnswer(observations, "Покажи только показатели, которые снизились.");
    expect(primary?.observation.rows).toHaveLength(2);
  });
});

describe("Stage 25.1.3d §5 — never infers primary merely from the largest or the last table", () => {
  it("a smaller, LATER restricting result wins over a larger, earlier compare table", () => {
    const observations = [
      tableObs("change.compare_periods", ["metric", "percentageChange"], Array.from({ length: 19 }, (_, i) => [`M${i}`, -0.01])),
      tableObs("set.top", ["metric", "percentageChange"], [["M0", -0.01], ["M1", -0.01]]),
    ];
    const primary = determinePrimaryAnswer(observations, "покажи топ показателей");
    expect(primary?.observation.tool).toBe("set.top");
    expect(primary?.observation.rows).toHaveLength(2);
  });

  it("falls back to the last table at all (low confidence) when nothing recognized ran, never 'no result'", () => {
    const observations = [tableObs("derive.compute", ["metric", "distance"], [["A", 0.05]])];
    const primary = determinePrimaryAnswer(observations, "покажи отклонение от максимума");
    expect(primary?.observation.tool).toBe("derive.compute");
    expect(primary?.confident).toBe(false);
  });
});

describe("Stage 25.1.3d — no observations at all", () => {
  it("returns null, never throws", () => {
    expect(determinePrimaryAnswer([], "что угодно")).toBeNull();
  });
});

describe("Stage 25.1.3e §3/§4/§7/§11 — determineValidatedWinner NEVER trusts row order, always recomputes from candidate values", () => {
  const ASK = "Из них какой изменился сильнее всего?";

  it("§11 — the correct winner (D, -13.79%) wins regardless of its position: first", () => {
    const rows = [
      ["D", -0.1379],
      ["A", -0.0028],
      ["B", -0.0608],
      ["C", -0.0001],
      ["E", -0.0391],
    ];
    const obs: AgentObservation[] = [{ tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: rows as never }];
    expect(determineValidatedWinner(obs, ASK)?.metricKey).toBe("D");
  });

  it("§11 — D in the middle", () => {
    const rows = [
      ["A", -0.0028],
      ["B", -0.0608],
      ["D", -0.1379],
      ["C", -0.0001],
      ["E", -0.0391],
    ];
    const obs: AgentObservation[] = [{ tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: rows as never }];
    expect(determineValidatedWinner(obs, ASK)?.metricKey).toBe("D");
  });

  it("§11 — D last", () => {
    const rows = [
      ["A", -0.0028],
      ["B", -0.0608],
      ["C", -0.0001],
      ["E", -0.0391],
      ["D", -0.1379],
    ];
    const obs: AgentObservation[] = [{ tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: rows as never }];
    expect(determineValidatedWinner(obs, ASK)?.metricKey).toBe("D");
  });

  it("§3/§7 — an explicit set.sort that got the WRONG row into position 0 is still overridden — never trusted at face value", () => {
    // a genuinely misleading tool observation: sorted, but by the WRONG
    // metric entirely (as if the planner sorted by something else and
    // mislabeled the column) — row[0] here is "займы клиентам" (the real
    // Excel bug's wrong answer), yet the true winner "обратное РЕПО" is
    // present with a far larger magnitude further down the same table.
    const rows = [
      ["займы клиентам", -0.0001],
      ["Вклады клиентов", -0.0256],
      ["обратное РЕПО", -0.1379],
    ];
    const obs: AgentObservation[] = [{ tool: "set.sort", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: rows as never }];
    const winner = determineValidatedWinner(obs, ASK);
    expect(winner?.metricKey).toBe("обратное РЕПО");
    expect(winner?.metricKey).not.toBe("займы клиентам");
  });

  it("§12 — an explicit absolute-amount ask overrides to absoluteChange (preserves 25.1.3b semantics)", () => {
    const rows = [
      ["A", -355, -0.0256],
      ["B", -43, -0.1379],
    ];
    const obs: AgentObservation[] = [{ tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "absoluteChange", "percentageChange"], rows: rows as never }];
    const winner = determineValidatedWinner(obs, "У какого самое большое абсолютное изменение?");
    expect(winner?.metricKey).toBe("A");
  });

  it("§13 — magnitude=true: a large negative beats larger positives", () => {
    const rows = [
      ["A", 0.12],
      ["B", -0.15],
      ["C", 0.14],
    ];
    const obs: AgentObservation[] = [{ tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: rows as never }];
    expect(determineValidatedWinner(obs, ASK)?.metricKey).toBe("B");
  });

  it("§14 — restricted set: only rows present in the candidate observation are eligible, even when a workbook-wide winner exists elsewhere", () => {
    // the candidate observation carries ONLY B and C (the prior turn's
    // ResultSet) — D (the workbook-wide largest change) never appears here
    // at all, so it structurally cannot win.
    const rows = [
      ["B", -0.05],
      ["C", -0.09],
    ];
    const obs: AgentObservation[] = [{ tool: "set.filter", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: rows as never }];
    const winner = determineValidatedWinner(obs, ASK);
    expect(["B", "C"]).toContain(winner?.metricKey);
    expect(winner?.metricKey).not.toBe("D");
  });

  it("returns null for a request that is not a ranking-basis ask at all", () => {
    const obs: AgentObservation[] = [{ tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["A", -0.1]] as never }];
    expect(determineValidatedWinner(obs, "Покажи его динамику.")).toBeNull();
  });

  it("returns null when no candidate observation carries the needed field (never a false winner)", () => {
    const obs: AgentObservation[] = [{ tool: "metric.list", ok: true, kind: "table", columns: ["metric", "semanticClass"], rows: [["A", "amount"]] as never }];
    expect(determineValidatedWinner(obs, "какой изменился сильнее всего?")).toBeNull();
  });
});

describe("Stage 25.1.3e §8 — determinePrimaryAnswer uses the validated winner for a ranking-basis ask, never row[0] of an unordered table", () => {
  it("the real bug's exact shape: a misleadingly-first tiny-change row never wins over the true largest-magnitude decliner", () => {
    const observations: AgentObservation[] = [
      {
        tool: "change.compare_periods",
        ok: true,
        kind: "table",
        columns: ["metric", "absoluteChange", "percentageChange"],
        rows: [
          ["займы клиентам", -0.762907, -0.0001],
          ["Вклады клиентов", -355.18, -0.0256],
          ["обратное РЕПО", -43.74, -0.1379],
        ] as never,
      },
    ];
    const primary = determinePrimaryAnswer(observations, "Из них какой изменился сильнее всего?");
    expect(primary?.observation.rows).toHaveLength(1);
    expect(String(primary!.observation.rows![0]![0])).toBe("обратное РЕПО");
  });
});

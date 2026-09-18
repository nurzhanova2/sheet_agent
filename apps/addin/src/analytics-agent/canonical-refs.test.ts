import { describe, expect, it } from "vitest";
import { emptySessionMemory } from "../app/conversation-memory.js";
import type { AgentObservation, AgentStep } from "../agent/types.js";
import { commitPlannerOutputs } from "./canonical-refs.js";

const ctx = { turnId: "t1", sourceRange: "Баланс!B2:Q25", sourceVersion: "v1" };

describe("Stage 25.1 §5/§50 — commitPlannerOutputs: single-winner tools pin metric focus", () => {
  it("set.argmax with one row sets lastMetricFocusRef", () => {
    const obs: AgentObservation[] = [
      { tool: "set.argmax", ok: true, kind: "table", columns: ["metric", "distance"], rows: [["обратное РЕПО", 0.42]] },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs);
    expect(mem.lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");
  });

  it("event.max_adjacent_change with one row also pins focus", () => {
    const obs: AgentObservation[] = [
      { tool: "event.max_adjacent_change", ok: true, kind: "table", columns: ["metric", "startPeriod", "endPeriod"], rows: [["Активы", "01.01.2024", "01.12.2024"]] },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs);
    expect(mem.lastMetricFocusRef?.metricKey).toBe("Активы");
  });
});

describe("Stage 25.1 §7/§18 — commitPlannerOutputs: explicit sets and restricting filters", () => {
  it("metric.resolve_set persists an explicit_user_list MetricSetRef", () => {
    const obs: AgentObservation[] = [
      { tool: "metric.resolve_set", ok: true, kind: "table", columns: ["metric"], rows: [["Активы"], ["Обязательства"]] },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs);
    expect(mem.lastMetricSetRef?.metricKeys).toEqual(["Активы", "Обязательства"]);
    expect(mem.lastMetricSetRef?.origin).toBe("explicit_user_list");
  });

  it("a set.filter down to >1 rows persists a previous_filter MetricSetRef for 'из них'", () => {
    const obs: AgentObservation[] = [
      { tool: "set.filter", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["A", -0.1], ["B", -0.2]] },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs);
    expect(mem.lastMetricSetRef?.metricKeys).toEqual(["A", "B"]);
    expect(mem.lastMetricSetRef?.origin).toBe("previous_filter");
  });
});

describe("Stage 25.1 §5/§51 — commitPlannerOutputs: ordered rankings persist as ResultSetRef, sorted", () => {
  it("analysis.volatility persists a ResultSetRef sorted descending by score", () => {
    const obs: AgentObservation[] = [
      { tool: "analysis.volatility", ok: true, kind: "table", columns: ["metric", "score"], rows: [["A", 0.1], ["B", 0.5], ["C", 0.3]] },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs);
    expect(mem.lastResultSetRef?.rows.map((r) => r.key)).toEqual(["B", "C", "A"]);
  });
});

describe("Stage 25.1.2 §2/§3/§53 — commitPlannerOutputs: the FINAL executed interval persists, not every touched period", () => {
  it("a change.compare_periods tool call commits lastPeriodRef from its own input, chronologically ordered", () => {
    const obs: AgentObservation[] = [
      { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell"], rows: [["Активы", 100, 110, 10, 0.1, "A1", "A2"]] },
    ];
    const steps: AgentStep[] = [
      { iteration: 0, decision: { kind: "tool_call", tool: "change.compare_periods", input: { startPeriod: "2025-11-01", endPeriod: "2025-12-01" } }, observation: obs[0]!, durationMs: 0 },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs, steps);
    expect(mem.lastPeriodRef?.startCanonical).toBe("2025-11-01");
    expect(mem.lastPeriodRef?.endCanonical).toBe("2025-12-01");
  });

  it("two bare period.select observations, with no steps and no interval-defining call, do NOT commit a period (§2's release-blocker plumbing case)", () => {
    const obs: AgentObservation[] = [
      { tool: "period.select", ok: true, kind: "table", columns: ["period", "headerPath"], rows: [["2025-12-01", "01.12.2025"]] },
      { tool: "period.select", ok: true, kind: "table", columns: ["period", "headerPath"], rows: [["2025-11-01", "01.11.2025"]] },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs);
    expect(mem.lastPeriodRef).toBeUndefined();
  });

  it("a period.list of all 5 periods before the real comparison does not pollute the committed interval", () => {
    const cmp: AgentObservation = { tool: "change.compare_periods", ok: true, kind: "table", columns: ["metric", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell"], rows: [["Активы", 100, 110, 10, 0.1, "A1", "A2"]] };
    const steps: AgentStep[] = [
      { iteration: 0, decision: { kind: "tool_call", tool: "period.list", input: {} }, observation: { tool: "period.list", ok: true, kind: "table", columns: ["period", "headerPath"], rows: [["P1", "01.01.2024"], ["P2", "01.12.2024"], ["P3", "01.01.2025"], ["P4", "01.11.2025"], ["P5", "01.12.2025"]] }, durationMs: 0 },
      { iteration: 1, decision: { kind: "tool_call", tool: "change.compare_periods", input: { startPeriod: "P4", endPeriod: "P5" } }, observation: cmp, durationMs: 0 },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, [cmp], steps);
    expect(mem.lastPeriodRef?.startCanonical).toBe("P4");
    expect(mem.lastPeriodRef?.endCanonical).toBe("P5");
  });
});

describe("Stage 25.1.3d §9-§12 — commitPlannerOutputs: a winner sourced from event.max_adjacent_change commits a FULL EventRef atomically with MetricFocusRef", () => {
  it("EventRef.metricKey and MetricFocusRef.metricKey agree, and the event's own fields are populated (not just a bare metric key)", () => {
    const obs: AgentObservation[] = [
      {
        tool: "event.max_adjacent_change",
        ok: true,
        kind: "table",
        columns: ["metric", "startPeriod", "endPeriod", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell", "startPeriodCanonical", "endPeriodCanonical"],
        rows: [["обратное РЕПО", "01.12.2024", "01.11.2025", 38.6024, 317.1601, 278.5577, 7.2161, "A1", "A2", "2024-12-01", "2025-11-01"]],
      },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs);
    expect(mem.lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");
    expect(mem.lastEventRef?.metricKey).toBe("обратное РЕПО");
    expect(mem.lastEventRef?.startCanonical).toBe("2024-12-01");
    expect(mem.lastEventRef?.endCanonical).toBe("2025-11-01");
    expect(mem.lastEventRef?.absoluteChange).toBeCloseTo(278.5577, 4);
  });

  it("§20 — supporting series.get rows (multi-row) alongside the event never override or weaken the atomic commit", () => {
    const obs: AgentObservation[] = [
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value", "sourceCell"], rows: [["обратное РЕПО", "01.01.2024", 50, "A1"], ["обратное РЕПО", "01.12.2024", 38.6024, "A2"], ["обратное РЕПО", "01.11.2025", 317.1601, "A3"]] },
      {
        tool: "event.max_adjacent_change",
        ok: true,
        kind: "table",
        columns: ["metric", "startPeriod", "endPeriod", "startValue", "endValue", "absoluteChange", "percentageChange", "startCell", "endCell", "startPeriodCanonical", "endPeriodCanonical"],
        rows: [["обратное РЕПО", "01.12.2024", "01.11.2025", 38.6024, 317.1601, 278.5577, 7.2161, "A1", "A2", "2024-12-01", "2025-11-01"]],
      },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs);
    expect(mem.lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");
    expect(mem.lastEventRef?.metricKey).toBe("обратное РЕПО");
  });
});

describe("Stage 25.1 §9 — commitPlannerOutputs never writes anything for an empty/failed run", () => {
  it("no successful observations means no refs committed", () => {
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, [{ tool: "metric.resolve", ok: false, kind: "error", error: "UNRESOLVED_METRIC: x" }]);
    expect(mem.lastMetricFocusRef).toBeUndefined();
    expect(mem.lastMetricSetRef).toBeUndefined();
    expect(mem.lastResultSetRef).toBeUndefined();
  });
});

describe("Stage 25.1.3f §3/§5/§6 — commitPlannerOutputs commits the run's CONTINUATION UNIVERSE", () => {
  const compare: AgentObservation[] = [
    {
      tool: "change.compare_periods",
      ok: true,
      kind: "table",
      columns: ["metric", "startValue", "endValue", "absoluteChange", "percentageChange"],
      rows: [
        ["Активы", 1200, 1300, 100, 0.0833],
        ["обратное РЕПО", 317.16, 273.42, -43.74, -0.1379],
        ["Вклады клиентов", 13868.36, 13513.18, -355.18, -0.0256],
      ],
    },
  ];

  it("a plain comparison becomes the structured input universe for the next turn", () => {
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, compare);
    const ref = mem.lastAnalyticalResultSetRef;
    expect(ref?.operation).toBe("change.compare_periods");
    expect(ref?.rows).toHaveLength(3);
    expect(ref?.metricKeys).toEqual(["Активы", "обратное РЕПО", "Вклады клиентов"]);
    expect(ref?.columns).toContain("percentageChange");
    expect(ref?.sourceRange).toBe(ctx.sourceRange);
  });

  it("§3 — the same universe is also reachable through the EXISTING reference.previous_metric_set", () => {
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, compare);
    expect(mem.lastMetricSetRef?.origin).toBe("previous_result_set");
    expect(mem.lastMetricSetRef?.metricKeys).toEqual(["Активы", "обратное РЕПО", "Вклады клиентов"]);
  });

  it("a restricting filter in the SAME turn keeps its own narrower metric set — the universe never re-widens", () => {
    const obs: AgentObservation[] = [
      ...compare,
      {
        tool: "set.filter",
        ok: true,
        kind: "table",
        columns: ["metric", "percentageChange"],
        rows: [
          ["обратное РЕПО", -0.1379],
          ["Вклады клиентов", -0.0256],
        ],
      },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), ctx, obs);
    expect(mem.lastMetricSetRef?.origin).toBe("previous_filter");
    expect(mem.lastMetricSetRef?.metricKeys).not.toContain("Активы");
    expect(mem.lastAnalyticalResultSetRef?.operation).toBe("set.filter");
    expect(mem.lastAnalyticalResultSetRef?.metricKeys).not.toContain("Активы");
  });

  it("§6 — a superlative run commits the winner as focus AND the full candidate set as the universe", () => {
    const obs: AgentObservation[] = [
      {
        tool: "set.top",
        ok: true,
        kind: "table",
        columns: ["metric", "percentageChange"],
        rows: [
          ["займы клиентам", -0.0001],
          ["Вклады клиентов", -0.0256],
          ["обратное РЕПО", -0.1379],
        ],
      },
    ];
    const mem = commitPlannerOutputs(emptySessionMemory(), { ...ctx, requestText: "Из них какой изменился сильнее всего?" }, obs);
    expect(mem.lastMetricFocusRef?.metricKey).toBe("обратное РЕПО");
    expect(mem.lastAnalyticalResultSetRef?.rows).toHaveLength(3);
  });

  it("§5 — a turn that computed no analytical result of its own leaves the previous universe standing", () => {
    const first = commitPlannerOutputs(emptySessionMemory(), ctx, compare);
    const echoOnly: AgentObservation[] = [
      { tool: "reference.previous_result_table", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["Активы", 0.0833]] },
    ];
    const second = commitPlannerOutputs(first, { ...ctx, turnId: "t2" }, echoOnly);
    expect(second.lastAnalyticalResultSetRef?.turnId).toBe("t1");
    expect(second.lastAnalyticalResultSetRef?.operation).toBe("change.compare_periods");
  });

  it("a single-metric result is a focus, not a set — it never overwrites lastMetricSetRef", () => {
    const first = commitPlannerOutputs(emptySessionMemory(), ctx, compare);
    const single: AgentObservation[] = [
      { tool: "series.get", ok: true, kind: "table", columns: ["metric", "period", "value"], rows: [["обратное РЕПО", "2025-12-01", 273.42]] },
      { tool: "event.max_adjacent_change", ok: true, kind: "table", columns: ["metric", "percentageChange"], rows: [["обратное РЕПО", 7.2161]] },
    ];
    const second = commitPlannerOutputs(first, { ...ctx, turnId: "t2" }, single);
    expect(second.lastMetricSetRef?.metricKeys).toEqual(["Активы", "обратное РЕПО", "Вклады клиентов"]);
    expect(second.lastAnalyticalResultSetRef?.metricKeys).toEqual(["обратное РЕПО"]);
  });
});

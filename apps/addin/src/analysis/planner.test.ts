import { describe, expect, it } from "vitest";
import { classifyIntent } from "../app/intent.js";
import { assertPlanAllowed, assertPlanModifiersHonored, isPlanError, parsePlan } from "./planner.js";
import type { AnalysisPlan } from "./planner.js";
import { SALES_HEADERS } from "./__fixtures__/sales-test-data.js";

describe("parsePlan", () => {
  it("accepts a direct_answer plan", () => {
    const plan = parsePlan({ kind: "direct_answer" });
    expect(isPlanError(plan)).toBe(false);
    if (!isPlanError(plan)) expect(plan.kind).toBe("direct_answer");
  });

  it("accepts an analysis plan and validates every operation", () => {
    const plan = parsePlan({
      kind: "analysis",
      operations: [{ op: "group_by", by: ["Region"], metrics: [{ metric: "count" }] }],
    });
    expect(isPlanError(plan)).toBe(false);
  });

  it("rejects an analysis plan with a malicious operation", () => {
    const plan = parsePlan({ kind: "analysis", operations: [{ op: "aggregate", metric: "sum", target: { kind: "require", value: "fs" } }] });
    expect(isPlanError(plan) && plan.code).toBe("PLAN_INVALID_OP");
  });

  it("rejects an empty analysis plan", () => {
    expect(isPlanError(parsePlan({ kind: "analysis", operations: [] })) && (parsePlan({ kind: "analysis", operations: [] }) as { code: string }).code).toBe("PLAN_EMPTY");
  });

  it("rejects non-JSON and unknown kinds", () => {
    expect(isPlanError(parsePlan("{ not json"))).toBe(true);
    expect((parsePlan("{ not json") as { code: string }).code).toBe("PLAN_NOT_JSON");
    expect((parsePlan({ kind: "compute" }) as { code: string }).code).toBe("PLAN_SHAPE");
  });

  it("requires a chart for a visualization plan", () => {
    expect((parsePlan({ kind: "visualization" }) as { code: string }).code).toBe("PLAN_REQUIRES_VISUALIZATION");
  });
});

describe("assertPlanAllowed", () => {
  it("blocks direct_answer for an analytical turn", () => {
    const intent = classifyIntent("Сколько строк имеют |Variance %| больше 20% по Region?");
    const guard = assertPlanAllowed({ kind: "direct_answer" }, intent);
    expect(guard?.code).toBe("PLAN_REQUIRES_ANALYSIS");
  });

  it("blocks a non-visualization plan for a chart turn", () => {
    const intent = classifyIntent("построй scatter plot Plan vs Fact");
    const guard = assertPlanAllowed({ kind: "analysis", operations: [{ op: "count" }] }, intent);
    expect(guard?.code).toBe("PLAN_REQUIRES_VISUALIZATION");
  });

  it("allows direct_answer for a qualitative turn", () => {
    const intent = classifyIntent("what columns are in this table?");
    expect(assertPlanAllowed({ kind: "direct_answer" }, intent)).toBeNull();
  });
});

const HEADERS = [...SALES_HEADERS];

describe("assertPlanModifiersHonored — §8 absolute value", () => {
  const abs = (target: unknown): AnalysisPlan => ({
    kind: "analysis",
    operations: [{ op: "group_by", by: ["Category"], metrics: [{ metric: "mean", name: "m", target: target as never }] }],
  });

  it("rejects a plan that uses mean(Variance %) when the user asked for the ABSOLUTE value", () => {
    const plan = abs({ kind: "column", name: "Variance %" });
    const guard = assertPlanModifiersHonored(plan, "Какая Category имеет самое большое среднее абсолютное Variance %?", HEADERS);
    expect(guard?.code).toBe("PLAN_MISSING_ABS");
  });

  it("accepts the same plan once the column is wrapped in abs()", () => {
    const plan = abs({ kind: "abs", value: { kind: "column", name: "Variance %" } });
    expect(assertPlanModifiersHonored(plan, "среднее абсолютное Variance % по Category", HEADERS)).toBeNull();
  });

  it("does not fire when the prompt never says 'absolute'", () => {
    const plan = abs({ kind: "column", name: "Variance %" });
    expect(assertPlanModifiersHonored(plan, "среднее Variance % по Category", HEADERS)).toBeNull();
  });
});

describe("assertPlanModifiersHonored — §9 aggregation scope", () => {
  const groupBy = (metrics: { metric: string; column: string }[]): AnalysisPlan => ({
    kind: "analysis",
    operations: [
      {
        op: "group_by",
        by: ["Category"],
        metrics: metrics.map((m) => ({ metric: m.metric as never, name: m.column, target: { kind: "column", name: m.column } })),
      },
    ],
  });

  it("rejects sum(Revenue) when the user asked for the mean of Plan, Fact and Revenue", () => {
    const plan = groupBy([
      { metric: "mean", column: "Plan" },
      { metric: "mean", column: "Fact" },
      { metric: "sum", column: "Revenue" },
    ]);
    const guard = assertPlanModifiersHonored(plan, "Сравни Electronics и Accessories по средним Plan, Fact и Revenue.", HEADERS);
    expect(guard?.code).toBe("PLAN_AGGREGATE_SCOPE");
    expect(guard?.error).toMatch(/Revenue/);
  });

  it("accepts the plan when every listed metric uses mean", () => {
    const plan = groupBy([
      { metric: "mean", column: "Plan" },
      { metric: "mean", column: "Fact" },
      { metric: "mean", column: "Revenue" },
    ]);
    expect(assertPlanModifiersHonored(plan, "средние Plan, Fact и Revenue по Category", HEADERS)).toBeNull();
  });

  it("respects an explicit per-column override ('а также суммарный Revenue')", () => {
    const plan = groupBy([
      { metric: "mean", column: "Plan" },
      { metric: "mean", column: "Fact" },
      { metric: "sum", column: "Revenue" },
    ]);
    expect(
      assertPlanModifiersHonored(plan, "средние Plan и Fact, а также суммарный Revenue по Category", HEADERS),
    ).toBeNull();
  });
});

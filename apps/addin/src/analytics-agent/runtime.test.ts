// Stage 25 §6/§32/§33 — the iterative planner runtime. Proves: (a) the
// planner's own "final.answer" is NEVER user-facing prose — only the
// SEPARATE narrator pass is; (b) clarify and budget-exhaustion pass through
// cleanly; (c) a narrator draft with an unsupported number is replaced by a
// deterministic table (reusing the Stage 24.4 evidence gate, not a new one).
import { describe, expect, it } from "vitest";
import { induceTableSchema } from "../app/schema/schema-induction.js";
import { fixtureDirectionAndSets } from "../app/schema/__fixtures__/tables.js";
import type { AnalysisGrids } from "../app/schema/matrix-analysis.js";
import type { AgentObservation } from "../agent/types.js";
import { runAnalyticalPlanner } from "./runtime.js";

function schemaAndGrids() {
  const fx = fixtureDirectionAndSets();
  const schema = induceTableSchema({
    values: fx.values,
    numberFormats: fx.numberFormats,
    formulas: fx.formulas,
    sheetName: fx.sheetName,
    sourceRange: fx.address,
    sourceVersion: "v1",
    startsBelowRow1: false,
  });
  const grids: AnalysisGrids = { values: fx.values, numberFormats: fx.numberFormats };
  return { schema, grids };
}

describe("Stage 25 §32 — planner prose is never shown; only the narrator's SEPARATE pass is", () => {
  it("planner final.answer is internal-only: the narrator's own text is what the caller receives", async () => {
    const { schema, grids } = schemaAndGrids();
    let step = 0;
    const outcome = await runAnalyticalPlanner({
      taskId: "t2",
      text: "Опиши Активы.",
      schema,
      grids,
      language: "ru",
      decidePlanner: () => {
        step += 1;
        if (step === 1) return { kind: "tool_call", tool: "metric.resolve", input: { text: "Активы" } };
        return { kind: "final", answer: "INTERNAL_PLANNER_NOTE_NEVER_SHOWN" };
      },
      narrate: async () => "Показатель «Активы» найден.",
    });
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.body).toBe("Показатель «Активы» найден.");
    expect(outcome.body).not.toContain("INTERNAL_PLANNER_NOTE_NEVER_SHOWN");
  });
});

describe("Stage 25 §33 — clarify and budget exhaustion pass through the runtime cleanly", () => {
  it("a planner clarify decision surfaces the question + candidates, never calling narrate", async () => {
    const { schema, grids } = schemaAndGrids();
    let narrated = false;
    const outcome = await runAnalyticalPlanner({
      taskId: "t3",
      text: "Покажи X.",
      schema,
      grids,
      language: "ru",
      decidePlanner: () => ({ kind: "clarify", question: "Какой именно показатель?", candidates: ["Активы", "Обязательства"] }),
      narrate: async () => {
        narrated = true;
        return "";
      },
    });
    expect(outcome.kind).toBe("clarify");
    if (outcome.kind !== "clarify") return;
    expect(outcome.question).toBe("Какой именно показатель?");
    expect(outcome.candidates).toEqual(["Активы", "Обязательства"]);
    expect(narrated).toBe(false);
  });

  it("a planner stuck repeating the same tool call terminates instead of looping forever", async () => {
    const { schema, grids } = schemaAndGrids();
    const outcome = await runAnalyticalPlanner({
      taskId: "t4",
      text: "Покажи X.",
      schema,
      grids,
      language: "ru",
      decidePlanner: () => ({ kind: "tool_call", tool: "metric.resolve", input: { text: "нечто неизвестное" } }),
      narrate: async () => "",
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reasonKey).toBe("repeated_tool_call");
  });
});

describe("Stage 25 §38/§39 — an ungrounded narrator draft is replaced end-to-end", () => {
  it("the narrator inventing a number not in any tool observation falls back to the verified table", async () => {
    const { schema, grids } = schemaAndGrids();
    const outcome = await runAnalyticalPlanner({
      taskId: "t5",
      text: "Какое значение Активов?",
      schema,
      grids,
      language: "ru",
      decidePlanner: (ctx) => {
        const periodObs = [...ctx.observations].reverse().find((o) => o.tool === "period.select" && o.ok);
        if (!periodObs) return { kind: "tool_call", tool: "period.select", input: { selector: "last" } };
        if (!ctx.observations.some((o) => o.tool === "value.at_period" && o.ok)) {
          return { kind: "tool_call", tool: "value.at_period", input: { metrics: ["Активы"], period: String(periodObs.rows![0]![0]) } };
        }
        return { kind: "final", answer: "ok" };
      },
      narrate: async () => "Значение составило 999999999.",
    });
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.body).not.toContain("999999999");
  });
});

describe("Stage 25.1.3c §4/§5/§7/§12 — an authoritative resolvedSubject drives BOTH clauses of a compound pronoun request, no metric.resolve needed", () => {
  it("'Покажи его динамику и найди самый большой скачок.' composes series.get(A) + event.max_adjacent_change(A) reading A straight from RESOLVED SUBJECT", async () => {
    const { schema, grids } = schemaAndGrids();
    const a = schema.rowAxis[0]!.display;
    let metricResolveCalls = 0;
    const outcome = await runAnalyticalPlanner({
      taskId: "t6",
      text: "Покажи его динамику и найди самый большой скачок.",
      schema,
      grids,
      language: "ru",
      inherited: { resolvedSubject: { metricKey: a, source: "conversation_pronoun", authoritative: true } },
      decidePlanner: (ctx) => {
        if (ctx.observations.some((o) => o.tool === "metric.resolve")) metricResolveCalls += 1;
        // never call metric.resolve on the pronoun — read the metric straight
        // from the RESOLVED SUBJECT line in workbookContext, exactly as the
        // planner prompt instructs.
        const m = /RESOLVED SUBJECT[^\n]*\n\s*"([^"]+)"/.exec(ctx.workbookContext);
        expect(m).not.toBeNull();
        const metric = m![1]!;
        if (!ctx.observations.some((o) => o.tool === "series.get" && o.ok)) return { kind: "tool_call", tool: "series.get", input: { metrics: [metric] } };
        if (!ctx.observations.some((o) => o.tool === "event.max_adjacent_change" && o.ok)) {
          return { kind: "tool_call", tool: "event.max_adjacent_change", input: { metric, basis: "percentage" } };
        }
        return { kind: "final", answer: "facts ready" };
      },
      narrate: async () => "Готово.",
    });
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(metricResolveCalls).toBe(0);
    const series = [...outcome.state.observations].reverse().find((o) => o.tool === "series.get" && o.ok);
    const event = [...outcome.state.observations].reverse().find((o) => o.tool === "event.max_adjacent_change" && o.ok);
    expect(series).toBeDefined();
    expect(event).toBeDefined();
    expect(String(series!.rows![0]![series!.columns!.indexOf("metric")])).toBe(a);
    expect(String(event!.rows![0]![event!.columns!.indexOf("metric")])).toBe(a);
  });
});

function lastObs(observations: readonly AgentObservation[], tool: string) {
  return [...observations].reverse().find((o) => o.tool === tool && o.ok);
}

describe("Stage 25.1.3d §3/§6/§18 — a filter request's primary/visible result is the filtered set ONLY, never the upstream compare table", () => {
  it("comparing an intermediate period pair: primary contains exactly the declining metrics, none of the rising ones", async () => {
    const { schema, grids } = schemaAndGrids();
    const outcome = await runAnalyticalPlanner({
      taskId: "t7",
      text: "Теперь покажи только показатели, которые снизились.",
      schema,
      grids,
      language: "ru",
      decidePlanner: (ctx) => {
        const last = (tool: string) => lastObs(ctx.observations, tool);
        if (!last("period.list")) return { kind: "tool_call", tool: "period.list", input: {} };
        const periods = last("period.list")!.rows!.map((r) => String(r[0]));
        if (!last("metric.list")) return { kind: "tool_call", tool: "metric.list", input: { scope: "all" } };
        if (!last("change.compare_periods")) {
          return { kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: periods[1], endPeriod: periods[2] } };
        }
        if (!last("set.filter")) {
          return { kind: "tool_call", tool: "set.filter", input: { source: last("change.compare_periods")!.resultId, field: "percentageChange", op: "lt", value: 0 } };
        }
        return { kind: "final", answer: "facts ready" };
      },
      // echoes the narrator's own FACTS input back as the "answer" — proves
      // the FACTS-narrowing reaches the final visible body, not just outcome.primary.
      narrate: async (messages) => messages.map((m) => m.content).join("\n"),
    });
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.primary?.tool).toBe("set.filter");
    const mCol = outcome.primary!.columns!.indexOf("metric");
    const declined = new Set(outcome.primary!.rows!.map((r) => String(r[mCol])));
    expect(declined).toEqual(new Set(["Обязательства", "Ликвидные активы", "уровень долларизации вкладов физлиц"]));
    expect(declined.has("Активы")).toBe(false);
    expect(declined.has("доля ликвидных активов в активах")).toBe(false);
    // the rising metrics never reach the visible body either (§16 — never
    // hide the wrong shape behind narrator prose).
    expect(outcome.body).not.toContain("Активы");
    expect(outcome.body).toContain("Обязательства");
  });
});

describe("Stage 25.1.3d §7/§19 — a superlative ask's primary/visible result is exactly ONE winner row, ranked by percentage magnitude", () => {
  it("among the same declining set, 'уровень долларизации' wins (-12.5%), not 'Обязательства' (larger absolute, smaller %)", async () => {
    const { schema, grids } = schemaAndGrids();
    const outcome = await runAnalyticalPlanner({
      taskId: "t8",
      text: "Из них какой изменился сильнее всего?",
      schema,
      grids,
      language: "ru",
      decidePlanner: (ctx) => {
        const last = (tool: string) => lastObs(ctx.observations, tool);
        if (!last("period.list")) return { kind: "tool_call", tool: "period.list", input: {} };
        const periods = last("period.list")!.rows!.map((r) => String(r[0]));
        if (!last("metric.list")) return { kind: "tool_call", tool: "metric.list", input: { scope: "all" } };
        if (!last("change.compare_periods")) {
          return { kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: periods[1], endPeriod: periods[2] } };
        }
        if (!last("set.filter")) {
          return { kind: "tool_call", tool: "set.filter", input: { source: last("change.compare_periods")!.resultId, field: "percentageChange", op: "lt", value: 0 } };
        }
        if (!last("set.sort")) {
          return { kind: "tool_call", tool: "set.sort", input: { source: last("set.filter")!.resultId, field: "percentageChange", direction: "asc" } };
        }
        return { kind: "final", answer: "facts ready" };
      },
      narrate: async (messages) => messages.map((m) => m.content).join("\n"),
    });
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.primary?.rows).toHaveLength(1);
    const mCol = outcome.primary!.columns!.indexOf("metric");
    expect(String(outcome.primary!.rows![0]![mCol])).toBe("уровень долларизации вкладов физлиц");
    // never the whole supporting decline set, and never the larger-absolute/
    // smaller-percentage decliner.
    expect(outcome.body).not.toContain("Обязательства");
    expect(outcome.body).not.toContain("Ликвидные активы");
  });

  it("Stage 25.1.3e §3/§7 — a plan that filters but never explicitly ranks STILL succeeds: the deterministic layer computes the winner itself, never trusting row order that was never even established", async () => {
    const { schema, grids } = schemaAndGrids();
    const outcome = await runAnalyticalPlanner({
      taskId: "t9",
      text: "Из них какой изменился сильнее всего?",
      schema,
      grids,
      language: "ru",
      decidePlanner: (ctx) => {
        const last = (tool: string) => lastObs(ctx.observations, tool);
        if (!last("period.list")) return { kind: "tool_call", tool: "period.list", input: {} };
        const periods = last("period.list")!.rows!.map((r) => String(r[0]));
        if (!last("metric.list")) return { kind: "tool_call", tool: "metric.list", input: { scope: "all" } };
        if (!last("change.compare_periods")) {
          return { kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: periods[1], endPeriod: periods[2] } };
        }
        // deliberately never calls set.sort / set.argmax — no rank tool at all.
        if (!last("set.filter")) {
          return { kind: "tool_call", tool: "set.filter", input: { source: last("change.compare_periods")!.resultId, field: "percentageChange", op: "lt", value: 0 } };
        }
        return { kind: "final", answer: "facts ready" };
      },
      narrate: async (messages) => messages.map((m) => m.content).join("\n"),
    });
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.primary?.rows).toHaveLength(1);
    const mCol = outcome.primary!.columns!.indexOf("metric");
    expect(String(outcome.primary!.rows![0]![mCol])).toBe("уровень долларизации вкладов физлиц");
  });

  it("Stage 25.1.3e §7 — an EXPLICIT wrong-field sort is still rejected (RANKING_BASIS_MISMATCH), preserving 25.1.3b's audit", async () => {
    const { schema, grids } = schemaAndGrids();
    const outcome = await runAnalyticalPlanner({
      taskId: "t10",
      text: "Из них какой изменился сильнее всего?",
      schema,
      grids,
      language: "ru",
      requestedRankingBasis: "percentageChange",
      decidePlanner: (ctx) => {
        const last = (tool: string) => lastObs(ctx.observations, tool);
        if (!last("period.list")) return { kind: "tool_call", tool: "period.list", input: {} };
        const periods = last("period.list")!.rows!.map((r) => String(r[0]));
        if (!last("metric.list")) return { kind: "tool_call", tool: "metric.list", input: { scope: "all" } };
        if (!last("change.compare_periods")) {
          return { kind: "tool_call", tool: "change.compare_periods", input: { source: last("metric.list")!.resultId, startPeriod: periods[1], endPeriod: periods[2] } };
        }
        if (!last("set.filter")) {
          return { kind: "tool_call", tool: "set.filter", input: { source: last("change.compare_periods")!.resultId, field: "percentageChange", op: "lt", value: 0 } };
        }
        // WRONG: explicitly sorts by the wrong field despite a percentageChange request.
        if (!last("set.sort")) {
          return { kind: "tool_call", tool: "set.sort", input: { source: last("set.filter")!.resultId, field: "absoluteChange", direction: "asc" } };
        }
        return { kind: "final", answer: "facts ready" };
      },
      narrate: async () => "готово",
    });
    expect(outcome.kind).toBe("semantic_failed");
    if (outcome.kind !== "semantic_failed") return;
    expect(outcome.failures.some((f) => f.code === "RANKING_BASIS_MISMATCH")).toBe(true);
  });
});
